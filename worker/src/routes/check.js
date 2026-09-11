// POST /api/check - 事实核查主端点（A+B：事实提取 + 检索 + 真实度评级）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey, callLLMJson } from '../utils/llmProxy.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { cacheGet, cacheSet, searchCacheKey } from '../utils/cache.js';
import { annotateResults } from '../utils/officialScore.js';
import { braveSearch, tavilySearch, filterRelevant, entityTermOf } from '../sources/brave.js';
import { searchGovDirect } from '../sources/govDirect.js';
import { buildExtractFactsMessages } from '../prompts/extractFacts.js';
import { buildRateTruthMessages } from '../prompts/rateTruth.js';
import { autoAudit, approveEntry, slugify } from '../utils/kbStore.js';
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

  const { text, context, mode = 'query' } = body;
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
    const data = await runCheck(text, context, env, apiKey, { autoDraft: true, mode });
    return jsonResponse({ ok: true, data }, 200, request);
  } catch (e) {
    return errorJson(e.message, 502, 'CHECK_ERROR', request);
  }
}

/**
 * 评级中文映射
 */
const RATING_CN = { high: '高', medium: '中', low: '低', info: '查询结果', unknown: '未知' };
function ratingCn(r) { return RATING_CN[r] || r; }

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
    const snip = (r.snippet || '')
      .replace(/【[^】]*】/g, ' ')
      .replace(/```[\s\S]*?```/g, ' ')       // 代码块
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // **加粗**
      .replace(/\*{1,3}/g, '')
      .replace(/#{1,6}\s*/g, '')              // markdown 标题符
      .replace(/`+/g, '')
      .replace(/\|+/g, '，')                  // 表格分隔
      .replace(/^[\s>·•\-–—*]+/gm, '');       // 行首符号
    const isEn = /^[\x00-\x7F\s.,;:%()\-–—+]*$/.test(snip.slice(0, 60)) && /[a-zA-Z]/.test(snip.slice(0, 60));
    const srcName = r.site_name || r.title || '来源';
    const source = { name: srcName, url: r.url, official: r.source === 'gov-direct' || !!r.official_tag };

    // 切句并提取数据句（中文按句号/分号/换行切分，换行也算边界，避免标题与正文连成一句）
    let sentences = [];
    if (isEn) {
      for (const para of snip.split(/\n+/)) {
        for (const s of para.split(/(?<=\.)\s+(?=[A-Z(])/)) sentences.push(s.trim());
      }
    } else {
      sentences = snip.split(/[。；;\n]+/g).map(s => s.trim()).filter(Boolean);
    }

    for (let s0 of sentences) {
      const s = s0.replace(/\s+/g, ' ').trim();
      if (s.length < 8 || s.length > 160) continue;
      // 跳过网页页脚/备案/导航噪音，以及纯标题（无句读且过短的导航词）
      if (/版权所有|ICP备|公网安备|网站标识码|中文域名|京公网|备案|Copyright|cookie|隐私权|网站地图|首页|上一篇|下一篇|点击下载|字体大小|分享到/.test(s)) continue;
      const hasData = isEn ? /\d[\d.,\-–—~]*\s*(?:trillion|billion|million|thousand|yuan|dollars?|USD|RMB|kg|kgs|kilograms?|lbs?|pounds?|cm|mm|km|meters?|metres?|tons?|tonnes?|km\/h|mph|years?|yrs?|hectares?|percent|%)/i.test(s)
        : new RegExp('\\d[\\d.,，\\-－—~～至到]*\\s*' + CN_UNIT).test(s);
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
export async function runCheck(text, context, env, apiKey, { autoDraft = false, mode = 'query' } = {}) {
  const intent = mode === 'verify' ? 'assertion' : 'query';

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

  // 外国实体检测：查询含外国国名时追加英文 Tavily 检索（外国数据在英文权威源最全）
  // 这是通用逻辑，不限于 GDP——任何含外国国名的查询都走英文增强
  const FOREIGN_EN = {
    '美国': 'United States', '日本': 'Japan', '德国': 'Germany', '英国': 'United Kingdom',
    '法国': 'France', '印度': 'India', '韩国': 'South Korea', '加拿大': 'Canada',
    '巴西': 'Brazil', '俄罗斯': 'Russia', '澳大利亚': 'Australia', '意大利': 'Italy',
    '西班牙': 'Spain', '墨西哥': 'Mexico', '印尼': 'Indonesia', '荷兰': 'Netherlands',
    '瑞士': 'Switzerland', '沙特': 'Saudi Arabia', '土耳其': 'Turkey', '瑞典': 'Sweden',
    '阿根廷': 'Argentina', '泰国': 'Thailand', '越南': 'Vietnam', '新加坡': 'Singapore',
    '马来西亚': 'Malaysia', '南非': 'South Africa', '埃及': 'Egypt', '乌克兰': 'Ukraine',
    '欧盟': 'European Union', '新西兰': 'New Zealand', '挪威': 'Norway', '丹麦': 'Denmark',
    '芬兰': 'Finland', '希腊': 'Greece', '葡萄牙': 'Portugal', '捷克': 'Czech Republic',
    '智利': 'Chile', '巴基斯坦': 'Pakistan', '波兰': 'Poland', '比利时': 'Belgium',
  };
  const CHINA_WORDS = ['中国', '国内', '我国', '全国', '中方'];
  const foreignEn = (() => {
    const t = String(text || '').replace(/国内生[产產][总總]值/g, ''); // "国内生产总值"是GDP术语，剔除后再判中国词
    if (CHINA_WORDS.some(w => t.includes(w))) return null;
    for (const [zh, en] of Object.entries(FOREIGN_EN)) {
      if (t.includes(zh)) {
        const yearM = t.match(/(?:19|20)\d{2}/);
        return { en, year: yearM ? yearM[0] : '', hint: hint || '' };
      }
    }
    return null;
  })();

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
      const govRaw = await searchGovDirect(searchQuery, { apiKey: env.TAVILY_KEY });
      const govAnnotated = annotateResults(govRaw, env);
      // 官方结果排前合并
      searchResults = [...govAnnotated, ...(Array.isArray(searchResults) ? searchResults : [])];
      // 相关性过滤：剔除只在正文顺带提及实体的无关词条（如查"大熊猫"却召回"犬/郊狼/柳江人"）
      // 用纯实体词（去掉体重/身高等属性词），避免"大熊猫 身高"这类不连续串误杀
      const relEntity = entityTermOf(entity && entity.length >= 2 ? entity : text.trim());
      searchResults = filterRelevant(searchResults, relEntity);
    } catch { /* 官方检索失败不影响维基结果 */ }
  }

  // 外国实体英文 Tavily 检索：外国数据在英文权威站（BEA/IMF/世行/statista/tradingeconomics等）最全
  // 检测到外国国名就做一轮英文 Tavily 搜索，结果合并到 searchResults
  if (foreignEn && intent === 'query') {
    try {
      const enQuery = `${foreignEn.en} ${text}`.replace(/\s+/g, ' ').trim();
      const enShort = `${foreignEn.en} ${foreignEn.hint || ''} ${foreignEn.year}`.replace(/\s+/g, ' ').trim();
      const econDomains = ['bea.gov', 'imf.org', 'worldbank.org', 'oecd.org',
        'tradingeconomics.com', 'statista.com', 'ceicdata.com', 'countryeconomy.com',
        'wikipedia.org'];
      const [tv1, tv2] = await Promise.all([
        tavilySearch(enQuery, { apiKey: env.TAVILY_KEY, topK: 6, searchDepth: 'advanced' }),
        tavilySearch(enShort, { apiKey: env.TAVILY_KEY, topK: 8, searchDepth: 'advanced', includeDomains: econDomains }),
      ]);
      const merged = [...(tv2.results || []), ...(tv1.results || [])];
      const tavilyAnswer = tv2.answer || tv1.answer;
      if (tavilyAnswer) {
        merged.unshift({
          title: `${foreignEn.en}（检索引擎综合答案）`,
          url: 'https://app.tavily.com/',
          snippet: tavilyAnswer,
          source: 'tavily',
        });
      }
      const enAnnotated = annotateResults(merged, env);
      // 英文结果合并到前面
      const seenEn = new Set((searchResults || []).map(r => r.url));
      const enFiltered = enAnnotated.filter(r => r.url && !seenEn.has(r.url));
      searchResults = [...enFiltered, ...(Array.isArray(searchResults) ? searchResults : [])];
    } catch { /* 英文检索失败忽略 */ }
  }

  // ---------- 分支 A：查询模式 → 百科卡片 + 直接解答 + 可信度 ----------
  if (intent === 'query') {
    const factCard = buildFactCard(searchResults, entity || text.trim(), text);

    // 基于原始检索结果，让 LLM 直接提取数据并生成解答。
    // 把所有检索结果的原始摘要喂给 LLM，不做任何关键词/正则过滤——LLM 自行理解、提取、分类。
    // 这样无论用户问什么（GDP、人口、体重、面积…），都不需要写专用适配逻辑。
    let answer = '';
    let confidence = 'low';
    let confidenceReason = '';
    if (searchResults && searchResults.length > 0) {
      try {
        const rawDataText = searchResults
          .map((r, i) => {
            const snip = String(r.snippet || '')
              .replace(/```[\s\S]*?```/g, ' ')
              .replace(/\*{1,3}/g, '')
              .replace(/#{1,6}\s*/g, '')
              .replace(/`+/g, '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 400);
            const tag = r.official_tag ? ' [官方]' : '';
            return `[${i + 1}] ${r.title || ''}${tag}\n${snip}`;
          })
          .join('\n\n');
        const llmResp = await callLLMJson({
          messages: [
            {
              role: 'system',
              content: [
                '你是资料核查助手。下面是检索引擎返回的多条网页摘要（标记[官方]的为官方来源）。',
                '请从中提取与用户问题直接相关的数据，生成一句话解答，并评估可信度。',
                '规则：',
                '1. 只能用与问题"同一指标"的数据作答——问总量不能用增长率代替，反之亦然；',
                '2. 若摘要中没有该指标的直接数据：如实说明"未检索到相关权威数据"，不得用其他指标冒充；',
                '3. 年份、地区必须与问题一致；',
                '4. 英文单位换算要准确：trillion=万亿，billion=十亿，million=百万；',
                '5. 数值忠实于来源，不要编造。',
                '可信度判定：多个独立来源同一指标数据一致→"高"；仅单一来源或约数→"中"；数据缺失或矛盾→"低"。',
                '只输出 JSON：{"answer":"一句话直接解答","confidence":"高或中或低","reason":"说明依据"}',
              ].join('\n'),
            },
            {
              role: 'user',
              content: `用户查询：${text}\n\n检索结果：\n${rawDataText}`,
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

    // 查询模式：可信度高 + autoAudit 通过 → 直接入库（auto_verified）；其余可选入不入
    let queryDraftCard = null;
    let queryAutoStored = false;
    if (factCard.facts.length > 0) {
      queryDraftCard = {
        title: entity || text.trim(),
        aliases: [],
        category: 'auto',
        facts: factCard.facts.map(f => ({
          label: f.property || text.trim(),
          value: f.value || '',
          rating: 'high',
          source: {
            name: f.source?.name || '',
            url: f.source?.url || '',
            official_tag: f.source?.official || false,
            official_score: f.source?.official ? 0.9 : 0.5,
          },
          verified_at: new Date().toISOString().slice(0, 10),
          confidence: confidence,
        })),
        references: (searchResults || []).slice(0, 5).map(r => ({
          name: r.title || r.site_name || '',
          url: r.url || '',
          official_tag: r.official_tag || false,
          official_score: r.official_tag ? 0.9 : 0.5,
        })),
        confidence_tier: confidence,
      };
      if (confidence === '高') {
        // 高可信度：尝试自动审核入库
        const audit = autoAudit(queryDraftCard);
        if (audit.pass) {
          try {
            const slug = slugify(queryDraftCard.title);
            await approveEntry(env.FACT_KB, slug, { ...queryDraftCard, status: 'auto_verified', category: '自动' }, 'auto_audit');
            queryAutoStored = true;
          } catch {}
        }
      }
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
      draftCard: queryDraftCard,
      autoStored: queryAutoStored,
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

  // 4. 知识库入库：可信度高 + autoAudit 通过 → 直接入库（auto_verified）；其余可选入不入
  const draftCard = buildDraftCard(claims, ratings, checkSearches);
  let autoStored = false;
  if (draftCard && draftCard.facts.length > 0) {
    const overall = ratings.every(r => r.rating === 'high') ? '高'
      : ratings.some(r => r.rating === 'low') ? '低' : '中';
    if (overall === '高') {
      const audit = autoAudit(draftCard);
      if (audit.pass) {
        try {
          const slug = slugify(draftCard.title);
          await approveEntry(env.FACT_KB, slug, { ...draftCard, status: 'auto_verified' }, 'auto_audit');
          autoStored = true;
        } catch {}
      }
    }
  }

  const overallFinal = ratings.every(r => r.rating === 'high')
    ? '高'
    : ratings.some(r => r.rating === 'low')
    ? '低'
    : '中';

  // 评级转中文
  const ratingsCn = ratings.map(r => ({ ...r, rating: ratingCn(r.rating) }));

  return {
    intent: 'verify',
    claims,
    searches: checkSearches,
    rating: overallFinal,
    corrections: ratings.filter(r => r.correction).map(r => ({
      claim: r.claim?.claim || '', correction: r.correction, evidence: r.evidence,
    })),
    ratings: ratingsCn,
    draftCard,
    autoStored,
  };
}
