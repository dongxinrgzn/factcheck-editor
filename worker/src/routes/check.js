// POST /api/check - 事实核查主端点（A+B：事实提取 + 检索 + 真实度评级）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey, callLLMJson } from '../utils/llmProxy.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { cacheGet, cacheSet, searchCacheKey, clearKBCache, SEARCH_TTL, ratingCacheKey, claimsCacheKey, RATING_TTL, CLAIMS_TTL } from '../utils/cache.js';
import { annotateResults } from '../utils/officialScore.js';
import { braveSearch, braveSearchForce, tavilySearch, filterRelevant, entityTermOf } from '../sources/brave.js';
import { searchGovDirect } from '../sources/govDirect.js';
import { buildExtractFactsMessages } from '../prompts/extractFacts.js';
import { buildRateTruthMessages } from '../prompts/rateTruth.js';
import { autoAudit, approveEntry, mergeEntry, slugify, queryEntry } from '../utils/kbStore.js';
import { buildDraftCard } from '../utils/draftBuilder.js';

const MODEL = 'Qwen/Qwen2.5-72B-Instruct';

// 单次核查最多处理的断言条数
// 权衡：条数越多覆盖越全，但检索+评级耗时线性增长（实测约 4s/条）。
// 10 条 ≈ 40s，是"逐点覆盖"与"可用等待时长"的平衡点；超出部分由前端提示分段提交。
const MAX_CLAIMS = 10;

/** 限并发 map：避免一次性打爆上游（LLM / 检索源）触发限流 */
async function mapLimit(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const out = new Array(list.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= list.length) break;
      try {
        out[idx] = await fn(list[idx], idx);
      } catch (e) {
        out[idx] = { error: e.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 为单条断言查知识库
 *
 * 命中判据：KB 词条的 title/alias 与该断言的实体相关，或词条内有 fact
 * 的 label 与该断言文本显著重合。
 * 命中时把词条事实包装成"检索结果"形状（source: 'kb'），
 * 复用下游评级与展示链路，并在 rating 上打 fromKB 标记。
 *
 * @returns {Promise<{results:Array, info:Object}|null>}
 */
export async function lookupKBForClaim(env, claim, entity, hint, opts = {}) {
  if (!env.FACT_KB) return null;
  const probes = [];
  if (entity) probes.push(entity);
  const sq = buildSearchQuery(claim);
  if (sq && sq !== entity) probes.push(sq);
  const claimText = (claim.claim || '').trim();
  if (claimText) probes.push(claimText);

  // 属性词：查询模式来自 LLM 解析的 hint，逐点核查来自断言的 metric。
  // 有属性词时必须匹配到对应事实才算命中——否则词条存在但答非所问
  //（反例：查"大熊猫 身高"，词条里只有体重/脑容量，facts[0] 兜底会把
  //  脑容量数据当身高答案返回）。
  const metric = String(hint || claim.metric || '').trim();
  // 宽松兜底（取词条第一条事实）必须同时满足：
  //   调用方显式允许（仅查询整段路径）且本次查询无属性词（纯实体查询）。
  // 逐点核查路径永不宽松——断言必须由对应事实支撑。
  const allowLoose = !!opts.loose && !metric;

  for (const probe of probes) {
    if (!probe || probe.length < 2) continue;
    let hit = null;
    try {
      hit = await queryEntry(env.FACT_KB, probe);
    } catch { hit = null; }
    if (!hit || !hit.hit || !hit.card) continue;

    const card = hit.card;
    const facts = Array.isArray(card.facts) ? card.facts : [];
    if (facts.length === 0) continue;

    // 从词条事实中挑与属性相关的**全部**事实：
    // ① label 与任一属性词互相包含（hint 可能是"身高 体重"多属性）→ ② label 与断言文本互相包含
    // → ③ value 含断言数值 → ④（仅纯实体查询）取第一条。全部不中 → 视为未命中（走全网检索），
    //    宁可多花一次检索，也不能拿无关事实冒充答案。
    const nums = (claimText.match(/\d+(?:\.\d+)?/g) || []);
    const attrWords = metric
      ? metric.split(/[\s、,，+/和与及]+/).map(w => w.trim()).filter(w => w.length >= 2)
      : [];
    const labelHit = (f, word) => {
      const lbl = (f.label || '').trim();
      return lbl && word.length >= 2 && (lbl.includes(word) || word.includes(lbl));
    };
    let matched = [];
    if (attrWords.length > 0) {
      matched = facts.filter(f => attrWords.some(w => labelHit(f, w)));
    }
    if (matched.length === 0 && claimText) {
      matched = facts.filter(f => {
        const lbl = (f.label || '').trim();
        return lbl && (claimText.includes(lbl) || lbl.includes(claimText));
      });
    }
    if (matched.length === 0 && nums.length > 0) {
      matched = facts.filter(f => nums.some(n => (f.value || '').includes(n)));
    }
    if (matched.length === 0) {
      if (!allowLoose) continue;
      matched = [facts[0]];
    }

    const isManual = card.status === 'verified';
    // 每条匹配事实生成一条 KB 检索结果（多属性查询如"身高 体重"全部返回）
    const kbSources = matched.map(f => ({
      title: `${card.title || '知识库'}（知识库${isManual ? '·人工审核' : '·自动审核'}）`,
      url: f.source?.url || '',
      snippet: `【知识库】${f.label || ''}：${f.value || ''}`,
      source: 'kb',
      official_score: 0.9,
      official_tag: true,
    }));
    const refs = Array.isArray(card.references) ? card.references : [];
    const extra = refs.slice(0, 3).map(r => ({
      title: `${card.title || ''}（知识库来源）`,
      url: r.url || '',
      snippet: r.name || '',
      source: 'kb',
      official_score: 0.85,
      official_tag: true,
    })).filter(r => r.url);

    const best = matched[0];
    // 部分命中提示：问了"身高 体重"但库里只有体重 → 明确告知身高缺失，
    // 避免用户疑惑"为什么答案里没有身高"
    const missingAttrs = attrWords.filter(w => !matched.some(f => labelHit(f, w)));
    return {
      results: [...kbSources, ...extra],
      info: {
        title: card.title || '',
        status: card.status || '',
        auditLabel: isManual ? '人工审核' : '自动审核',
        factLabel: best.label || '',
        factValue: best.value || '',
        facts: matched.map(f => ({
          label: f.label || '',
          value: f.value || '',
          url: f.source?.url || '',
        })),
        missingAttrs,
        updatedAt: card.updated_at || '',
        factCount: facts.length,
      },
    };
  }
  return null;
}

/**
 * 构造检索词（断言模式）
 *
 * 关键：不要把含数字的 metric 直接拼进检索词。
 * 反例："金" + "1064℃" → 维基全文检索把 "1064" 当关键词 →
 *       召回 宋朝(1064年) / 析津府(1064年) / 名偵探柯南(金曜日) / 通寧水(金雞納霜) 等噪音，
 *       真正的"金"词条证据被稀释 → LLM 拿不到熔点数据 → 判"低"且 evidence 为空。
 *
 * 策略：
 * - metric 是"属性名"（熔点/作者/地壳含量/熔点…）→ 拼上，有助定向
 * - metric 是"数值"（含数字/单位）→ 只保留其中的属性词部分，数值丢弃
 *   （数值应交给评级环节比对，不该作为检索词）
 * - metric 为空 → 用 claim 去掉数值后作为检索词
 */
function buildSearchQuery(claim) {
  const entity = (claim.entity || '').trim();
  const metric = (claim.metric || '').trim();

  // claim 去数值版本："金的熔点约为1064℃" → "金的熔点约为" 意义不大，
  // 故优先用 entity；无 entity 时才退回 claim 去数值。
  const stripNumbers = (s) => s
    .replace(/\d+(?:[.,]\d+)*\s*(?:℃|°C|%|％|公斤|千克|吨|克|厘米|千米|公里|毫米|米|平方公里|平方米|公顷|升|毫升|万人|亿人|万|亿|年|月|日|岁|個|个|美元|元|港元|欧元|日元)?/g, '')
    .replace(/[，,。.、：:；;（）()【】\[\]"'"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (entity) {
    // metric 无数字 → 是属性名，拼上；有数字 → 去掉数字后若还剩属性词则拼上
    if (metric && !/\d/.test(metric)) return `${entity} ${metric}`;
    const metricWord = stripNumbers(metric);
    if (metricWord && metricWord.length >= 2 && metricWord !== entity) {
      return `${entity} ${metricWord}`;
    }
    return entity;
  }
  const fromClaim = stripNumbers(claim.claim || '');
  return fromClaim || (claim.claim || '');
}

// 属性维度词：断言中出现这些词时，检索词带上维度（如"大熊猫 体重"），
// 并作为 hint 传给维基深度抽取，定向定位正文数据句
const ATTR_RE = /(体重|體重|身高|体长|體長|身长|身長|寿命|壽命|年龄|年齡|速度|面积|面積|人口|产量|產量|距离|距離|海拔|重量|翼展|跨度|直径|直徑|厚度|深度|宽度|寬度|长度|長度|生日|诞辰|出生|生於|生于|出生日期|出生年月|逝世|去世|卒於|卒于|国籍|籍贯|学历|职业|职务|职位|身高|体重)/;

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

/**
 * 评级归一化：LLM 被要求用中文输出（高/中/低），但内部逻辑一律按英文
 * （high/medium/low）比较。此函数必须在 LLM 返回的第一时间调用，
 * 否则下游所有 `=== 'high'` 判断都会静默失配——
 * 表现为：可信度为"高"却永不自动入库、facts 的 value 落不到"属实"分支。
 */
const RATING_EN = { 高: 'high', 中: 'medium', 低: 'low', high: 'high', medium: 'medium', low: 'low' };
function ratingEn(r) {
  if (r == null) return 'medium';
  const k = String(r).trim();
  return RATING_EN[k] || 'medium';
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
export async function runCheck(text, context, env, apiKey, { autoDraft = false, mode = 'query', maxClaims = MAX_CLAIMS, skipSearchFallback = false } = {}) {
  const intent = mode === 'verify' ? 'assertion' : 'query';

  // 0. 两种模式共享的：检索
  // 用 LLM 理解用户输入，提取实体和属性维度词，不再依赖正则
  const llmParse = await callLLMJson({
    messages: [
      {
        role: 'system',
        content: '从用户输入中提取搜索实体和属性维度词，用于搜索引擎检索。输出 JSON：{"entity":"主体名词（去掉属性词和助词）","hint":"属性维度词（如体重/身高/生日/出生/GDP/人口等，没有则为空）","searchQuery":"实体+属性词，空格分隔，适合搜索引擎"}。只输出 JSON。',
      },
      { role: 'user', content: `用户输入：${text}` },
    ],
    apiKey,
    temperature: 0.1,
    maxTokens: 200,
  }).catch(() => null);

  let entity = (llmParse && llmParse.entity) || text.replace(/[的了是在有？?多少几什么]/g, '').trim();
  let hint = (llmParse && llmParse.hint) || '';
  const searchQuery = (llmParse && llmParse.searchQuery) || (entity ? (hint ? `${entity} ${hint}` : entity) : text.trim());

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

  // ---------- 知识库优先（两种模式共用）----------
  // 查询/查证都先查 KB：命中则直接把 KB 词条当作"检索结果"，
  // 跳过全网检索，并在返回里标记 kbHit，供前端显示"来自知识库"。
  // 注意：整段文本先查一次；逐点断言级的 KB 查询在下方 checkSearches 里做。
  if (intent === 'query') {
    let wholeKbHit = null;
    try {
      // loose 仅在无属性词（纯实体查询）时生效：词条存在即可取首条事实展示；
      // 带属性词的查询（如"大熊猫 身高"）必须匹配到对应事实，否则走全网检索。
      wholeKbHit = await lookupKBForClaim(env, { claim: text, entity: entity || text }, entity, hint, { loose: true });
    } catch { wholeKbHit = null; }

    // KB 命中：直接以知识库内容作答——在此提前返回，
    // 跳过下方全部检索（维基/govDirect/Tavily），延迟从 10s+ 降到一次 LLM 解析。
    if (wholeKbHit) {
      const info = wholeKbHit.info || {};
      // 多属性查询（"大熊猫 身高 体重"）→ 全部匹配事实都进卡片与解答
      const kbFacts = (Array.isArray(info.facts) && info.facts.length > 0)
        ? info.facts
        : [{ label: info.factLabel || entity || '', value: info.factValue || '', url: wholeKbHit.results[0]?.url || '' }];
      const kbCard = {
        title: info.title || entity || '',
        facts: kbFacts.map((f, i) => ({
          key: `fact_${i}`,
          label: f.label || entity || '',
          value: f.value || '',
          rating: 'high',
          source: { name: `${info.title}（知识库）`, url: f.url || '', official_tag: true, official_score: 0.9 },
          verified_at: info.updatedAt || '',
          confidence: 'high',
        })),
        references: wholeKbHit.results.filter(r => r.source !== 'kb').map(r => ({ name: r.title, url: r.url, official_score: r.official_score || 0.85 })),
      };
      return {
        intent: 'query',
        factCard: kbCard,
        answer: kbFacts.map(f => `${f.label || ''}：${f.value || ''}`).filter(s => s.trim() !== '：').join('；') +
          ((info.missingAttrs && info.missingAttrs.length > 0)
            ? `（${info.missingAttrs.join('、')}：知识库暂无相关事实，可单独查询触发全网检索补充）`
            : ''),
        confidence: '高',
        confidenceReason: `来自知识库（${info.auditLabel || '已审核'}，命中 ${kbFacts.length} 条相关事实，词条共 ${info.factCount || 0} 条）`,
        ratings: [],
        searches: [{ claim: { claim: text, entity: entity || '' }, query: entity || text, results: wholeKbHit.results, kb: info, fromKB: true }],
        kbHit: true,
        kbInfo: info,
        kbCount: kbFacts.length,
        draftCard: null,
        autoStored: false,
      };
    }
  }

  let searchResults = null;
  try {
    const cacheK = searchCacheKey(searchQuery + '|card');
    const cached = await cacheGet(env.FACT_CACHE, cacheK);
    if (cached) {
      searchResults = cached;
    } else {
      const raw = await braveSearch({ query: searchQuery, preferOfficial: true, topK: 5, whitelist, hint, tavilyApiKey: env.TAVILY_KEY });
      searchResults = annotateResults(raw, env);
      // 如果 Wikipedia/DDG/SearXNG 返回的结果全被过滤或为空，用 Tavily 兜底
      if (!searchResults || searchResults.length === 0) {
        try {
          // Tavily 中文支持差，自动转英文查询
          const tavilyQuery = /[\u4e00-\u9fa5]/.test(entity || searchQuery)
            ? `${entity || searchQuery} site:wikipedia.org OR site:baike.baidu.com`
            : (entity || searchQuery);
          const tavily = await tavilySearch(tavilyQuery, { apiKey: env.TAVILY_KEY, topK: 5, searchDepth: 'advanced' });
          if (tavily.results && tavily.results.length > 0) {
            searchResults = annotateResults(tavily.results, env);
          }
        } catch {}
      }
      await cacheSet(env.FACT_CACHE, cacheK, searchResults, SEARCH_TTL);
    }
  } catch {
    searchResults = [];
  }

  // 查询模式额外实时检索官方站（GDP/政策等权威数据在官方公报，维基常无；不缓存以免限流空结果固化）
  if (intent === 'query') {
    try {
      const govRaw = await searchGovDirect(entity || searchQuery, { apiKey: env.TAVILY_KEY });
      const govAnnotated = annotateResults(govRaw, env);
      // 官方真实结果优先排前（最多 3 条）——govDirect 走 Tavily site:gov.cn，
      // 召回噪音多（"机器人大会"正文提一嘴大熊猫也会进），全部置顶会把
      // 维基等更相关的来源挤到列表尾部看不见（"只剩林业局"的成因之一）
      searchResults = [...govAnnotated.slice(0, 3), ...(Array.isArray(searchResults) ? searchResults : [])];
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
    // （KB 命中已在上方提前返回，此处为未命中走全网检索的路径）

    const factCard = buildFactCard(searchResults, entity || text.trim(), text);

    // 带属性词的查询：把数据卡过滤到只留与属性相关的数据句。
    // 否则问"大熊猫 身高"，卡片里塞满脑容量/排便等无关句——观感即"答非所问"，
    // 且用户点手动入库会把无关句存进词条。近义词表从严维护，
    // 防假阳性（如"粪便重量约100克"混进体重查询）。
    if (hint) {
      const ATTR_SYNONYMS = {
        '身高': ['体长', '身长', '肩高', '体高', '头躯长'],
        '体长': ['身高', '身长', '肩高'],
        '人口': ['总人口', '人口数'],
        '面积': ['占地', '总面积', '幅员'],
      };
      const keys = [hint, ...(ATTR_SYNONYMS[hint] || [])];
      const rel = (s) => keys.some(k => String(s || '').includes(k));
      factCard.facts = factCard.facts.filter(f => rel(f.property) || rel(f.value));
    }

    // 基于原始检索结果，让 LLM 直接提取数据并生成解答。
    // 把所有检索结果的原始摘要喂给 LLM，不做任何关键词/正则过滤——LLM 自行理解、提取、分类。
    // 这样无论用户问什么（GDP、人口、体重、面积…），都不需要写专用适配逻辑。
    let answer = '';
    let confidence = 'low';
    let confidenceReason = '';
    if (searchResults && searchResults.length > 0) {
      try {
        const cleanSnippet = (s) => String(s || '')
          .replace(/```[\s\S]*?```/g, ' ')
          .replace(/\*{1,3}/g, '')
          .replace(/#{1,6}\s*/g, '')
          .replace(/`+/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        // 全量喂给 LLM，不截断——Qwen2.5-72B 上下文 32K tokens，
        // 13 条摘要约 6500 tokens，远在限制内。
        const rawDataText = searchResults
          .map((r, i) => {
            const tag = r.official_tag ? ' [官方]' : '';
            return `[${i + 1}] ${r.title || ''}${tag}\n${cleanSnippet(r.snippet)}`;
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
                '5. 数值忠实于来源，不要编造；',
                '6. 理解近义表述：身高≈体长/头躯长/肩高/臀高（动物"身高"即肩高），体重=重量，面积=占地，人口=人口数/总人口。摘要用近义词描述同一指标时视为有直接数据。',
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

    // 兜底：带属性词的查询，LLM 说"未检索到"（confidence 低）但数据卡里
    // 实际有属性相关的数据句（LLM 偶尔漏认近义指标，如把"肩高"不当"身高"）
    // → 直接用数据句作答，降为中可信度。真没有相关数据句时不触发（保持如实告知）。
    if (hint && confidence === '低' && factCard.facts.length > 0) {
      const f = factCard.facts[0];
      answer = f.value || answer;
      confidence = '中';
      confidenceReason = `已检索到与「${hint}」相关的数据（${(f.source && f.source.name) || '检索来源'}），供参考`;
    }

    // 查询模式：可信度高 + autoAudit 通过 → 直接入库（auto_verified）；其余可选入不入
    let queryDraftCard = null;
    let queryAutoStored = false;
    // draftCard 事实来源：优先用 factCard 正则提取的 facts；若为空但 LLM 有高可信度答案，用 LLM 答案构建
    // label 优先用属性词（hint）：入库后 KB 事实的 label 与属性词对应，
    // 下次带属性查询（"大熊猫 身高"）才能被 lookupKBForClaim 精确匹配。
    const draftLabel = () => hint || '';
    const draftFacts = factCard.facts.length > 0
      ? factCard.facts.map(f => ({
          label: draftLabel() || f.property || text.trim(),
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
        }))
      : (answer && confidence === '高' && searchResults && searchResults.length > 0
        ? [{
            label: draftLabel() || entity || text.trim(),
            value: answer,
            rating: 'high',
            source: {
              name: searchResults[0]?.title || searchResults[0]?.site_name || '',
              url: searchResults[0]?.url || '',
              official_tag: searchResults[0]?.official_tag || false,
              official_score: searchResults[0]?.official_tag ? 0.9 : 0.5,
            },
            verified_at: new Date().toISOString().slice(0, 10),
            confidence: confidence,
          }]
        : []);

    if (draftFacts.length > 0) {
      queryDraftCard = {
        title: entity || text.trim(),
        aliases: [],
        category: 'auto',
        facts: draftFacts,
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
            const existing = await env.FACT_KB.get(entryKeyOf(slug));
            if (existing) {
              // 已存在同名词条 → 合并追加新事实点（去重），避免整卡覆盖
              const mr = await mergeEntry(env.FACT_KB, slug, { ...queryDraftCard, status: 'auto_verified' }, 'auto_audit');
              if (mr.ok && mr.added > 0) { await clearKBCache(env.FACT_KB); queryAutoStored = true; }
            } else {
              await approveEntry(env.FACT_KB, slug, { ...queryDraftCard, status: 'auto_verified', category: '自动' }, 'auto_audit');
              await clearKBCache(env.FACT_KB);
              queryAutoStored = true;
            }
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
  // 提取结果缓存 1 天：同一段文本重复查证时跳过这次 LLM 调用（省 2-4s）。
  // 提取是确定性计算（同输入同输出），缓存不影响结果。
  let claims = null;
  const claimsK = claimsCacheKey(text, context);
  try {
    const cachedClaims = await cacheGet(env.FACT_CACHE, claimsK);
    if (Array.isArray(cachedClaims) && cachedClaims.length > 0) claims = cachedClaims;
  } catch {}
  if (!claims) {
    const extractMsgs = buildExtractFactsMessages(text, context);
    claims = await callLLMJson({
      messages: extractMsgs,
      apiKey,
      temperature: 0.1,
      maxTokens: 3000,
    });
    if (Array.isArray(claims) && claims.length > 0) {
      await cacheSet(env.FACT_CACHE, claimsK, claims, CLAIMS_TTL);
    }
  }

  if (!Array.isArray(claims) || claims.length === 0) {
    return { claims: [], searches: [], ratings: [], rating: 'unknown', corrections: [], draftCard: null };
  }

  // 2. 对每条断言检索证据（逐点覆盖：不再截断到 5 条；限并发避免打爆检索源）
  //    知识库优先：先按断言（及其实体）查 KB，命中则直接采用，不再走全网检索。
  const checkSearches = await mapLimit(
    claims.slice(0, maxClaims), 4, async (c) => {
      const entity2 = (c.entity && c.entity.trim()) ? c.entity.trim() : '';
      const metricRaw = (c.metric && c.metric.trim()) ? c.metric.trim() : '';
      // hint 仅传属性名（维基深度抽取用），数值不当 hint
      const hint2 = metricRaw && !/\d/.test(metricRaw) ? metricRaw : '';
      const sq = buildSearchQuery(c);

      // ---- 知识库优先 ----
      const kb = await lookupKBForClaim(env, c, entity2);
      if (kb) {
        return { claim: c, query: sq, results: kb.results, kb: kb.info, fromKB: true };
      }

      const cacheK = searchCacheKey(sq);
      const cached = await cacheGet(env.FACT_CACHE, cacheK);
      // 注意：只复用"有结果"的缓存。空结果不入缓存，
      // 否则一次检索失败会被缓存 30 天，后续请求永远拿不到兜底机会。
      if (cached && Array.isArray(cached) && cached.length > 0) {
        return { claim: c, query: sq, results: cached, cached: true, fromKB: false };
      }

      try {
        // 必须传 tavilyApiKey：braveSearch 在维基命中时会短路，结果常清一色
        // zh.wikipedia.org。diversifyDomains 需要 Tavily 才能补出第二个域名，
        // 否则自动入库门槛②（≥2 域名）永远过不了。
        let raw = await braveSearch({ query: sq, preferOfficial: true, topK: 6, whitelist, hint: hint2, tavilyApiKey: env.TAVILY_KEY, diversify: !skipSearchFallback });
        // 以下兜底会额外消耗子请求额度（Cloudflare 单次调用上限 50）。
        // 古文查证等复合流程调用时置 skipSearchFallback，避免超限整体失败。
        if (!skipSearchFallback) {
          // 检索结果与实体完全不相关 → 强制全网兜底一次
          if (entity2 && raw.length > 0) {
            const relevant = filterRelevant(raw, entity2);
            if (relevant.length === 0) {
              const forced = await braveSearchForce(sq, 5, env.TAVILY_KEY);
              if (forced.length > 0) raw = forced;
            }
          }
          // 0 结果（多见于诗词/典故/习语类断言，维基不收录）→ 全网兜底
          if (raw.length === 0 && env.TAVILY_KEY) {
            try {
              const tv = await tavilySearch(sq, { apiKey: env.TAVILY_KEY, topK: 5, searchDepth: 'basic' });
              if (tv && tv.results && tv.results.length > 0) raw = tv.results;
            } catch { /* 兜底失败保持空 */ }
          }
        }
        const annotated = annotateResults(raw, env);
        if (annotated.length > 0) await cacheSet(env.FACT_CACHE, cacheK, annotated, SEARCH_TTL);
        return { claim: c, query: sq, results: annotated, cached: false, fromKB: false };
      } catch (e) {
        return { claim: c, query: sq, results: [], cached: false, error: e.message };
      }
    }
  );

  // 3. 评级
  // 注意：切不可用无上限 Promise.all —— 十几条断言同时打 LLM 会触发上游限流，
  // 表现为部分条目 callLLMJson 抛错 → 只能落到 catch（rating:'medium'、evidence:'评级失败'），
  // 报告里就会出现莫名其妙的"评级失败"且 sources 为空。改为限并发 + 失败重试。
  const ratings = await mapLimit(checkSearches, 4, async (sr) => {
    // 知识库命中的断言：直接用 KB 已审核的事实作答，不再打 LLM 评级
    // （KB 里的内容已经过自动/人工审核，且能省下一次 LLM 调用）
    if (sr.fromKB && sr.kb) {
      // KB 可能命中多条相关事实（如体重有野生/饲养两条），全部列入依据
      const kbEvi = (Array.isArray(sr.kb.facts) && sr.kb.facts.length > 0)
        ? sr.kb.facts.map(f => `${f.label}：${f.value}`).join('；')
        : `${sr.kb.factLabel}：${sr.kb.factValue}`;
      return {
        claim: sr.claim,
        rating: 'high',
        evidence: kbEvi,
        correction: '',
        sources: sr.results,
        fromKB: true,
        kbInfo: sr.kb,
      };
    }
    if (!sr.results || sr.results.length === 0) {
      return { claim: sr.claim, rating: 'low', evidence: '未找到相关证据', correction: '建议人工核实', sources: [], fromKB: false };
    }
    // 证据原文完整传给 LLM（用户要求不截取内容）。
    // 提速靠评级缓存：同断言+同证据 → 复用上次评级（确定性计算，结果一致）。
    // 证据缓存 1 天，所以同一查询在证据刷新前评级输入不变，命中率高。
    const evidence = sr.results.map(r => ({
      name: r.title,
      snippet: r.snippet,
      url: r.url,
    }));
    // 评级缓存：同断言+同证据 → 复用上次评级（确定性计算，结果一致）。
    // 证据缓存 1 天，所以同一查询在证据刷新前评级输入不变，命中率高。
    const rateK = ratingCacheKey(sr.claim.claim, evidence);
    try {
      const cachedRate = await cacheGet(env.FACT_CACHE, rateK);
      if (cachedRate && typeof cachedRate === 'object' && cachedRate.rating) {
        return {
          claim: sr.claim,
          rating: cachedRate.rating,
          evidence: cachedRate.evidence,
          correction: cachedRate.correction || '',
          sources: sr.results,
          fromKB: false,
          fromCache: true,
        };
      }
    } catch {}
    const msgs = buildRateTruthMessages(sr.claim.claim, evidence);
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await callLLMJson({
          messages: msgs,
          apiKey,
          temperature: 0.1,
          maxTokens: 1024,
        });
        if (r && typeof r === 'object') {
          // LLM 用中文输出（高/中/低），此处立即归一化为英文，
          // 保证下游所有 === 'high' 判断与入库门槛能正常生效。
          const norm = { rating: ratingEn(r.rating), evidence: r.evidence, correction: r.correction || '' };
          await cacheSet(env.FACT_CACHE, rateK, norm, RATING_TTL);
          return { claim: sr.claim, ...r, rating: norm.rating, sources: sr.results, fromKB: false };
        }
        lastErr = 'LLM 返回空';
      } catch (e) {
        lastErr = e.message;
      }
    }
    // 两次都失败：仍保留检索来源，明确标注为"评级未完成"而非静默丢弃证据
    return {
      claim: sr.claim,
      rating: 'medium',
      evidence: `自动评级未完成（${lastErr}），请人工核实。检索到 ${sr.results.length} 条相关资料。`,
      correction: '',
      sources: sr.results,
      fromKB: false,
    };
  });

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
          const existing = await env.FACT_KB.get(entryKeyOf(slug));
          if (existing) {
            // 已存在同名词条 → 合并追加（避免整卡覆盖旧事实）
            const mr = await mergeEntry(env.FACT_KB, slug, { ...draftCard, status: 'auto_verified' }, 'auto_audit');
            if (mr.ok && mr.added > 0) { await clearKBCache(env.FACT_KB); autoStored = true; }
          } else {
            await approveEntry(env.FACT_KB, slug, { ...draftCard, status: 'auto_verified' }, 'auto_audit');
            await clearKBCache(env.FACT_KB);
            autoStored = true;
          }
        } catch {}
      }
    }
  }

  // 4b. 部分入库：并非所有事实点都能达到整体"高"的门槛（长文本里常有 1-2 条存疑），
  //     但其中"高"的那些事实点本身是达标的，应当自动入库——否则用户会遇到
  //     "明明大部分都判高，却一条都没入库、只弹了个可入库提示"的情况。
  //     这里为每条达标事实单独建词条（title = 实体），命中已存在词条则合并追加。
  const partialStored = [];
  const partialSkipped = [];
  let partialDebug = null;
  if (!autoStored && draftCard) {
    // 注意：draftCard.facts 经过 buildDraftCard 的过滤（丢弃无 value/无 source 的条目），
    // 其下标已与 ratings / checkSearches 不再对齐。
    // 因此这里以 ratings（与 checkSearches 严格同序）为准重建事实，不要用 draftCard.facts[i]。
    const byEntity = new Map();
    let considered = 0;
    ratings.forEach((rt, i) => {
      if (rt.rating !== 'high') return;
      const sr = checkSearches[i];
      const results = (sr?.results || []).filter(r => r && r.url);
      const top = results.slice().sort((a, b) => (b.official_score || 0) - (a.official_score || 0))[0];
      if (!top) return;
      const ent = (rt.claim?.entity || draftCard.title || '').trim();
      if (!ent) return;
      considered++;
      if (!byEntity.has(ent)) byEntity.set(ent, { facts: [], refs: [] });
      const bucket = byEntity.get(ent);
      const evidence = String(rt.evidence || '').slice(0, 100);
      bucket.facts.push({
        key: `fact_${bucket.facts.length}`,
        label: rt.claim?.claim || ent,
        value: evidence ? `属实：${evidence}` : '属实',
        metric: rt.claim?.metric || '',
        time: rt.claim?.time || '',
        rating: 'high',
        source: {
          name: top.title,
          url: top.url,
          official_score: top.official_score || 0,
          official_tag: !!top.official_tag,
        },
        verified_at: new Date().toISOString().slice(0, 10),
        confidence: 'high',
      });
      for (const r of results) {
        bucket.refs.push({ name: r.title, url: r.url, official_score: r.official_score || 0 });
      }
    });
    partialDebug = { considered, entities: [...byEntity.keys()] };

    for (const [ent, bucket] of byEntity) {
      const { facts, refs } = bucket;
      // references 去重（按 url），最多 5 条
      const seenRef = new Set();
      const uniqRefs = [];
      for (const r of refs) {
        if (seenRef.has(r.url)) continue;
        seenRef.add(r.url);
        uniqRefs.push(r);
        if (uniqRefs.length >= 5) break;
      }
      for (const f of facts) {
        if (f.source?.url && !seenRef.has(f.source.url)) {
          seenRef.add(f.source.url);
          uniqRefs.push({ name: f.source.name, url: f.source.url, official_score: f.source.official_score || 0 });
        }
      }
      const card = { title: ent, aliases: [], category: 'auto', facts, references: uniqRefs };
      const audit = autoAudit(card);
      if (!audit.pass) {
        partialSkipped.push({
          title: ent,
          reason: (audit.reasons || []).join('；') || '未通过自动审核',
          count: facts.length,
          refs: uniqRefs.map(r => r.url).slice(0, 6),
        });
        continue;
      }
      try {
        const slug = slugify(ent);
        const existing = await env.FACT_KB.get(entryKeyOf(slug));
        if (existing) {
          // 同名词条：把新通过审核的高可信事实点合并追加进去（去重），
          // 让知识库随查询逐步养全，而不是直接跳过。
          const mr = await mergeEntry(env.FACT_KB, slug, { ...card, status: 'auto_verified' }, 'auto_audit');
          if (mr.ok && mr.added > 0) {
            partialStored.push({ title: ent, count: mr.added, merged: true, total: facts.length });
          } else {
            partialSkipped.push({
              title: ent,
              reason: mr.reason || '词条已存在且无新增事实点',
              count: facts.length,
              existing: true,
            });
          }
          continue;
        }
        await approveEntry(env.FACT_KB, slug, { ...card, status: 'auto_verified' }, 'auto_audit');
        partialStored.push({ title: ent, count: facts.length });
      } catch (e) {
        partialSkipped.push({ title: ent, reason: e.message, count: facts.length });
      }
    }
    if (partialStored.length > 0) {
      await clearKBCache(env.FACT_KB);
      autoStored = true;
    }
  }

  const overallFinal = ratings.every(r => r.rating === 'high')
    ? '高'
    : ratings.some(r => r.rating === 'low')
    ? '低'
    : '中';

  // 评级转中文（注意：必须放在统计之前/独立统计，勿用转中文字段做英文比较）
  const ratingsCn = ratings.map(r => ({ ...r, rating: ratingCn(r.rating) }));

  // 可信度（供前端提示栏使用，与查询模式保持一致的语义）
  const confidence = overallFinal;
  const nHigh = ratings.filter(r => r.rating === 'high').length;
  const nLow = ratings.filter(r => r.rating === 'low').length;
  const nMid = ratings.length - nHigh - nLow;
  const confidenceReason = ratings.length > 0
    ? `共核查 ${ratings.length} 个事实点：${nHigh} 条属实、${nMid} 条存疑、${nLow} 条查无实据/有误`
    : '未能提取到可核查的事实点';
  const kbCount = checkSearches.filter(s => s.fromKB).length;

  return {
    intent: 'verify',
    claims,
    searches: checkSearches,
    rating: overallFinal,
    confidence,
    confidenceReason,
    truncated: claims.length > maxClaims,
    totalClaims: claims.length,
    kbCount,
    corrections: ratings.filter(r => r.correction).map(r => ({
      claim: r.claim?.claim || '', correction: r.correction, evidence: r.evidence,
    })),
    ratings: ratingsCn,
    draftCard,
    autoStored,
    partialStored,
    partialSkipped,
  };
}

/** 词条主键（与 kbStore 内部保持一致，仅用于存在性检查） */
function entryKeyOf(slug) { return `kb:${slug}`; }
