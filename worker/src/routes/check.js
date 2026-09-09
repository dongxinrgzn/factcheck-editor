// POST /api/check - 事实核查主端点（A+B：事实提取 + 检索 + 真实度评级）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey, callLLMJson } from '../utils/llmProxy.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { cacheGet, cacheSet, searchCacheKey } from '../utils/cache.js';
import { annotateResults } from '../utils/officialScore.js';
import { braveSearch } from '../sources/brave.js';
import { searchGovDirect } from '../sources/govDirect.js';
import { buildExtractFactsMessages } from '../prompts/extractFacts.js';
import { buildRateTruthMessages } from '../prompts/rateTruth.js';
import { submitDraft } from '../utils/kbStore.js';
import { buildDraftCard } from '../utils/draftBuilder.js';

const MODEL = 'Qwen/Qwen2.5-72B-Instruct';

// 属性维度词：断言中出现这些词时，检索词带上维度（如"大熊猫 体重"），
// 并作为 hint 传给维基深度抽取，定向定位正文数据句
const ATTR_RE = /(体重|體重|身高|体长|體長|身长|身長|寿命|壽命|年龄|年齡|速度|面积|面積|人口|产量|產量|距离|距離|海拔|重量|翼展|跨度|直径|直徑|厚度|深度|宽度|寬度|长度|長度|出生|生於|生于|卒於|卒于|逝世|去世)/;

export async function handleCheck(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('请求体格式错误', 400, 'BAD_REQUEST', request);
  }

  const { text, context, mode = 'single' } = body;
  if (!text || typeof text !== 'string') {
    return errorJson('text 字段必填', 400, 'BAD_REQUEST', request);
  }

  // 权限
  const userKey = request.headers.get('X-Worker-Key') || '';
  const clientIp = getClientIp(request);
  const { apiKey, role, unlimited } = resolveApiKey(userKey, env);

  if (!unlimited) {
    const limit = parseInt(env.FALLBACK_PER_IP_DAILY_LIMIT || '3', 10);
    const { allowed } = await checkRateLimit(env.RATE_LIMIT, clientIp, limit);
    if (!allowed) {
      return errorJson('今日兜底额度已用完，请配置自己的 API Key', 403, 'NEED_API_KEY', request);
    }
  }

  try {
    const data = await runCheck(text, context, env, apiKey, { autoDraft: true });
    return jsonResponse({ ok: true, data }, 200, request);
  } catch (e) {
    return errorJson(e.message, 502, 'CHECK_ERROR', request);
  }
}

/**
 * 判断输入是"查询"（用户要百科数据）还是"断言"（用户说的一句话要判真伪）
 * 查询：短文本、无句号、有问号/疑问词、只有名词短语
 * 断言：完整句子（有主谓宾+标点）、有明确的陈述语气
 */
function detectIntent(text) {
  const t = text.trim();
  const hasPunct = /[。.!?！？]/.test(t);
  const hasQuestion = /[？?多少几什么怎样如何是否是不是]/.test(t);
  const isShort = t.length <= 20;
  // 有问号必然是查询
  if (hasQuestion) return 'query';
  // 没有句号且很短 → 查询（如 "大熊猫 体重"、"鲁迅出生"）
  if (!hasPunct && isShort && !/是|为|有|称|叫做|生于|卒于|在/.test(t)) return 'query';
  return 'assertion';
}

// 数据句单位：货币/百分比（经济）+ 度量衡（自然）
const CN_UNIT = '(?:万亿元|亿万元|亿元|万元|亿美元|万美元|亿港元|万港元|万亿美元|千亿元|百亿元|亿元|万亿|千亿|百亿|亿元|美元|港元|欧元|日元|人民币|元|%|％|个百分点|百分点|公斤|千克|吨|克|厘米|千米|公里|毫米|公尺|米|平方公里|平方米|公顷|公頃|升|毫升|摄氏度|攝氏度|万人|亿人|萬人|萬隻|万只|万头|牛顿|歲|岁)';
const EN_UNIT = '(?:trillion|billion|million|thousand|yuan|dollars?|USD|RMB|kg|kgs|kilograms?|lbs?|pounds?|cm|mm|km|meters?|metres?|tons?|tonnes?|km/h|mph|years?|yrs?|hectares?|percent|%)';
const DATA_CN_RE = new RegExp('[^。；;\\n]*\\d[\\d.,，\\-－—~～]*\\s*' + CN_UNIT + '[^。；;\\n]*[。；;\\n]', 'g');
const DATA_EN_RE = new RegExp('[^.\\n]*\\d[\\d.,\\-–—~]*\\s*(?:' + EN_UNIT + ')\\b[^.\\n]*[.\\n]', 'gi');

// 指标关键词 → 属性名（经济类在前，命中即归类）
const INDICATORS = [
  ['国内生产总值', '国内生产总值'], ['生产总值', '国内生产总值'], ['GDP', '国内生产总值'], ['gdp', '国内生产总值'],
  ['居民消费价格', '居民消费价格指数(CPI)'], ['CPI', '居民消费价格指数(CPI)'], ['cpi', '居民消费价格指数(CPI)'],
  ['人均可支配收入', '人均可支配收入'], ['财政收入', '财政收入'], ['税收收入', '税收收入'],
  ['粮食产量', '粮食产量'], ['总产量', '产量'], ['产量', '产量'],
  ['城镇化率', '城镇化率'], ['失业率', '失业率'], ['出生率', '出生率'], ['人口', '人口'],
  ['同比增长', '增长率'], ['比上年增长', '增长率'], ['增长', '增长率'], ['增速', '增长率'], ['增长率', '增长率'],
  ['人均', '人均值'], ['收入', '收入'],
  ['体重', '体重'], ['體重', '体重'], ['体长', '体长'], ['體長', '体长'], ['身高', '身高'],
  ['寿命', '寿命'], ['壽命', '寿命'], ['海拔', '海拔'], ['面积', '面积'], ['面積', '面积'],
  ['速度', '速度'], ['咬合力', '咬合力'], ['翼展', '翼展'], ['重量', '重量'],
  // 英文指标词
  ['weigh', '体重'], ['weight', '体重'], ['body mass', '体重'],
  ['body length', '体长'], ['length', '体长'], ['long', '体长'],
  ['lifespan', '寿命'], ['life span', '寿命'], ['years old', '寿命'], ['old', '寿命'],
  ['speed', '速度'], ['km/h', '速度'],
  ['elevation', '海拔'], ['altitude', '海拔'], ['above sea', '海拔'],
  ['bite force', '咬合力'], ['wingspan', '翼展'],
  ['population', '种群数量'], ['inhabitants', '种群数量'],
];

function classifyProp(sentence) {
  for (const [kw, prop] of INDICATORS) {
    if (sentence.includes(kw)) return prop;
  }
  return null;
}

/**
 * 把检索结果（维基 + 官方站）中的数据句解析成百科卡片（属性→数值→来源）
 * 官方来源（gov-direct / ★官方）优先
 */
function buildFactCard(results, entity, queryText = '') {
  const facts = [];
  const list = Array.isArray(results) ? results : [];

  // 官方结果排前
  const sorted = [...list].sort((a, b) => {
    const oa = a.source === 'gov-direct' || a.official_tag ? 0 : 1;
    const ob = b.source === 'gov-direct' || b.official_tag ? 0 : 1;
    return oa - ob;
  });

  // 查询中的年份（如 2025），优先保留含该年份的数据句
  const yearM = String(queryText || '').match(/(19|20)\d{2}/);
  const wantYear = yearM ? yearM[0] : '';

  for (const r of sorted) {
    const snip = (r.snippet || '').replace(/【[^】]*】/g, ' ');
    const isEn = /^[\x00-\x7F\s.,;:%()\-–—+]*$/.test(snip.slice(0, 60)) && /[a-zA-Z]/.test(snip.slice(0, 60));
    const srcName = r.site_name || r.title || '来源';
    const source = { name: srcName, url: r.url, official: r.source === 'gov-direct' || !!r.official_tag };

    // 切句并提取数据句
    let sentences = [];
    if (isEn) {
      for (const para of snip.split(/\n+/)) {
        for (const s of para.split(/(?<=\.)\s+(?=[A-Z(])/)) sentences.push(s.trim());
      }
    } else {
      sentences = snip.split(/(?<=[。；;])/g).map(s => s.trim()).filter(Boolean);
    }

    for (let s0 of sentences) {
      const s = s0.replace(/\s+/g, ' ').trim();
      if (s.length < 8 || s.length > 160) continue;
      // 跳过网页页脚/备案/导航噪音
      if (/版权所有|ICP备|公网安备|网站标识码|中文域名|京公网|备案|Copyright|cookie|隐私权|网站地图/.test(s)) continue;
      const hasData = isEn ? DATA_EN_RE.test(s) : DATA_CN_RE.test(s);
      if (isEn) DATA_EN_RE.lastIndex = 0; else DATA_CN_RE.lastIndex = 0;
      if (!hasData) continue;
      const prop = classifyProp(s) || '相关数据';
      // 含目标年份的句子加权排前
      const yearHit = wantYear && s.includes(wantYear);
      facts.push({ property: prop, value: s, source, yearHit, official: source.official });
    }
  }

  // 排序：官方优先 → 含目标年份优先
  facts.sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0) || (b.yearHit ? 1 : 0) - (a.yearHit ? 1 : 0));

  // 去重：同属性+相似开头只留一条（优先官方/含年份）
  const seen = new Set();
  const out = [];
  for (const f of facts) {
    const key = f.property + '|' + f.value.replace(/\s/g, '').slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    if (out.length >= 12) break;
  }

  return { title: entity || queryText || '', facts: out };
}

/**
 * 核查核心流程（供 /api/check 与 /api/kb/submit 复用）
 * @returns {Object} { claims, searches, ratings, rating, corrections, draftCard, factCard? }
 */
export async function runCheck(text, context, env, apiKey, { autoDraft = false } = {}) {
  const intent = detectIntent(text.trim());

  // 0. 两种模式共享的：检索（带属性维度 hint）
  // 先抽属性维度词和实体（如果有的话）
  const attrM = text.match(ATTR_RE);
  const hint = attrM ? attrM[1] : '';
  // 粗略实体提取："大熊猫 体重" → entity="大熊猫"；"鲁迅出生年" → entity="鲁迅"
  let entity = text.replace(ATTR_RE, '').replace(/[的了是在有？?多少几什么]/g, '').trim();
  if (hint && !entity) {
    // 没有实体但有属性词，用户直接问"体重"——需要实体来检索
    entity = text.replace(hint, '').trim();
  }
  const searchQuery = entity ? (hint ? `${entity} ${hint}` : entity) : text.trim();
  const whitelist = env.OFFICIAL_WHITELIST
    ? (typeof env.OFFICIAL_WHITELIST === 'string' ? JSON.parse(env.OFFICIAL_WHITELIST) : env.OFFICIAL_WHITELIST)
    : ['gov.cn', 'org.cn'];

  let searchResults = null;
  try {
    const cacheK = searchCacheKey(searchQuery + '|card');
    const cached = await cacheGet(env.FACT_CACHE, cacheK);
    if (cached) {
      searchResults = cached;
    } else {
      const raw = await braveSearch({ query: searchQuery, preferOfficial: true, topK: 5, whitelist, hint });
      searchResults = annotateResults(raw, env);
      await cacheSet(env.FACT_CACHE, cacheK, searchResults);
    }
  } catch {
    searchResults = [];
  }

  // 查询模式额外实时检索官方站（GDP/政策等权威数据在官方公报，维基常无；不缓存以免限流空结果固化）
  if (intent === 'query') {
    try {
      const govRaw = await searchGovDirect(searchQuery);
      const govAnnotated = annotateResults(govRaw, env);
      // 官方结果排前合并
      searchResults = [...govAnnotated, ...(Array.isArray(searchResults) ? searchResults : [])];
    } catch { /* 官方检索失败不影响维基结果 */ }
  }

  // ---------- 分支 A：查询模式 → 百科卡片 + 直接解答 + 可信度 ----------
  if (intent === 'query') {
    const factCard = buildFactCard(searchResults, entity || text.trim(), text);

    // 基于检索到的权威数据，让 LLM 生成一句话直接解答并评估可信度
    let answer = '';
    let confidence = 'low';
    let confidenceReason = '';
    if (factCard.facts.length > 0) {
      try {
        const dataText = factCard.facts
          .map(f => `[${f.property}] ${f.value}（来源：${f.source.name}）`)
          .join('\n');
        const llmResp = await callLLMJson({
          messages: [
            {
              role: 'system',
              content: '你是资料核查助手。根据检索到的权威数据，直接回答用户的问题，并评估数据可信度。' +
                '可信度判定：多个独立权威来源数据一致、或有明确数值出处→"高"；仅单一来源或数据为约数/范围→"中"；数据缺失或相互矛盾→"低"。' +
                '只输出 JSON：{"answer":"针对用户问题的一句话直接解答，必须含具体数值和单位","confidence":"高或中或低","reason":"一句话说明可信度依据（来源数量、是否一致）"}，不要解释。',
            },
            {
              role: 'user',
              content: `用户查询：${text}\n\n检索到的权威数据：\n${dataText}\n\n请输出 JSON。`,
            },
          ],
          apiKey,
          temperature: 0.2,
          maxTokens: 600,
        });
        if (llmResp && !Array.isArray(llmResp) && llmResp.answer) {
          answer = String(llmResp.answer);
          confidence = ['高', '中', '低'].includes(llmResp.confidence) ? llmResp.confidence : '中';
          confidenceReason = String(llmResp.reason || '');
        }
      } catch { /* LLM 失败则只展示数据卡片 */ }
    }

    return {
      intent: 'query',
      factCard,
      answer,
      confidence,
      confidenceReason,
      searches: [{ query: searchQuery, results: searchResults }],
      rating: 'info',
      claims: [],
      corrections: [],
      ratings: [],
      draftCard: null,
    };
  }

  // ---------- 分支 B：断言模式 → 事实核查 ----------
  // 1. LLM 提取事实断言
  const extractMsgs = buildExtractFactsMessages(text, context);
  const claims = await callLLMJson({
    messages: extractMsgs,
    apiKey,
    temperature: 0.1,
    maxTokens: 1024,
  });

  if (!Array.isArray(claims) || claims.length === 0) {
    return { claims: [], searches: [], ratings: [], rating: 'unknown', corrections: [], draftCard: null };
  }

  // 2. 对每条断言检索证据
  const checkSearches = await Promise.all(
    claims.slice(0, 5).map(async (c) => {
      const attrM2 = (c.claim || '').match(ATTR_RE);
      const hint2 = attrM2 ? attrM2[1] : '';
      const entity2 = (c.entity && c.entity.trim()) ? c.entity.trim() : '';
      const sq = entity2 ? (hint2 ? `${entity2} ${hint2}` : entity2) : c.claim;
      const cacheK = searchCacheKey(sq);
      const cached = await cacheGet(env.FACT_CACHE, cacheK);
      if (cached) return { claim: c, results: cached, cached: true };

      try {
        const raw = await braveSearch({ query: sq, preferOfficial: true, topK: 5, whitelist, hint: hint2 });
        const annotated = annotateResults(raw, env);
        await cacheSet(env.FACT_CACHE, cacheK, annotated);
        return { claim: c, results: annotated, cached: false };
      } catch (e) {
        return { claim: c, results: [], cached: false, error: e.message };
      }
    })
  );

  // 3. 评级
  const ratings = await Promise.all(
    checkSearches.map(async (sr) => {
      if (!sr.results || sr.results.length === 0) {
        return { claim: sr.claim, rating: 'low', evidence: '未找到相关证据', correction: '建议人工核实' };
      }
      try {
        const evidence = sr.results.map(r => ({ name: r.title, snippet: r.snippet, url: r.url }));
        const msgs = buildRateTruthMessages(sr.claim.claim, evidence);
        const r = await callLLMJson({
          messages: msgs,
          apiKey,
          temperature: 0.1,
          maxTokens: 1024,
        });
        return { claim: sr.claim, ...r, sources: sr.results };
      } catch (e) {
        return { claim: sr.claim, rating: 'medium', evidence: '评级失败', correction: e.message };
      }
    })
  );

  // 4. 知识库草稿
  const draftCard = buildDraftCard(claims, ratings, checkSearches);
  if (autoDraft && draftCard && draftCard.facts.length > 0) {
    try { await submitDraft(env.FACT_KB, draftCard); } catch {}
  }

  const overall = ratings.every(r => r.rating === 'high')
    ? 'high'
    : ratings.some(r => r.rating === 'low')
    ? 'low'
    : 'medium';

  return {
    intent: 'assertion',
    claims,
    searches: checkSearches,
    rating: overall,
    corrections: ratings.filter(r => r.correction).map(r => ({
      claim: r.claim?.claim || '', correction: r.correction, evidence: r.evidence,
    })),
    ratings,
    draftCard,
  };
}
