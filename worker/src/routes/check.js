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
import { submitDraft, queryEntry } from '../utils/kbStore.js';
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
// 评级归一化为中文（兼容 LLM 偶尔输出英文/旧卡片英文值）
function normRating(rating) {
  const s = String(rating || '').trim().toLowerCase();
  if (['高', 'high', '属实', 'true'].includes(s)) return '高';
  if (['低', 'low', '不实', 'false'].includes(s)) return '低';
  if (['中', 'medium', '部分', 'partial'].includes(s)) return '中';
  return '中';
}

/**
 * 从知识库卡片中挑出与断言相关的事实：
 * 断言含属性词（体重/身高/出生…）时只保留同属性事实，避免无关事实（如幼崽体重）干扰评级；
 * 挑不到则回退全量。
 */
function relatedKbFacts(facts, text) {
  if (!Array.isArray(facts) || facts.length === 0) return facts || [];
  const m = String(text || '').match(ATTR_RE);
  const attr = m ? m[1] : '';
  if (!attr) return facts;
  const related = facts.filter(f =>
    (f.label || '').includes(attr) || (f.value || '').includes(attr)
  );
  return related.length > 0 ? related : facts;
}

// 外国中文国名 → 英文（用于英文 Tavily 检索：外国宏观数据总量在 BEA/IMF/世行等英文源最全）
const FOREIGN_GDP_EN = {
  '美国': 'United States', '日本': 'Japan', '德国': 'Germany', '英国': 'United Kingdom',
  '法国': 'France', '印度': 'India', '韩国': 'South Korea', '加拿大': 'Canada',
  '巴西': 'Brazil', '俄罗斯': 'Russia', '澳大利亚': 'Australia', '意大利': 'Italy',
  '西班牙': 'Spain', '墨西哥': 'Mexico', '印度尼西亚': 'Indonesia', '印尼': 'Indonesia',
  '荷兰': 'Netherlands', '瑞士': 'Switzerland', '沙特': 'Saudi Arabia', '土耳其': 'Turkey',
  '波兰': 'Poland', '瑞典': 'Sweden', '比利时': 'Belgium', '爱尔兰': 'Ireland',
  '以色列': 'Israel', '阿根廷': 'Argentina', '泰国': 'Thailand', '越南': 'Vietnam',
  '新加坡': 'Singapore', '马来西亚': 'Malaysia', '菲律宾': 'Philippines', '南非': 'South Africa',
  '阿联酋': 'United Arab Emirates', '埃及': 'Egypt', '乌克兰': 'Ukraine', '欧盟': 'European Union',
  '新西兰': 'New Zealand', '挪威': 'Norway', '丹麦': 'Denmark', '芬兰': 'Finland',
  '奥地利': 'Austria', '希腊': 'Greece', '葡萄牙': 'Portugal', '捷克': 'Czech Republic',
  '智利': 'Chile', '哥伦比亚': 'Colombia', '巴基斯坦': 'Pakistan', '孟加拉国': 'Bangladesh',
};
const CHINA_WORDS = ['中国', '国内', '我国', '全国', '中方'];
// 识别"外国+GDP总量"问题并构造英文检索词；问中国的返回 null
function foreignGdpEnQuery(text) {
  // "国内生产总值"是 GDP 固定术语（美国国内生产总值=美国GDP），先剔除再判断中国词
  const t = String(text || '').replace(/国内生[产產][总總]值/g, '');
  if (CHINA_WORDS.some(w => t.includes(w))) return null;
  const yearM = t.match(/(?:19|20)\d{2}/);
  for (const [zh, en] of Object.entries(FOREIGN_GDP_EN)) {
    if (t.includes(zh)) {
      const year = yearM ? yearM[0] : '';
      return {
        zh,
        en,
        year,
        // 全网检索用长词；官方域名定向用短词（长词在官方站内召回率低）
        query: `${en} nominal GDP ${year} gross domestic product total trillion dollars`.replace(/\s+/g, ' ').trim(),
        shortQuery: `${en} GDP ${year} current-dollar trillion`.replace(/\s+/g, ' ').trim(),
      };
    }
  }
  return null;
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

function classifyProp(sentence, forQuery = false) {
  const s = String(sentence || '');
  // 增长率强信号优先：含增长语义 + 百分比（中英文）。
  // 必须放在"国内生产总值/GDP"之前，否则"GDP年化增长率为3.9%"会被误标成"国内生产总值"总量指标。
  // 查询问题本身不含数据，forQuery 时跳过此类数据句判断。
  if (!forQuery
      && /(增长|增速|增幅|涨幅|同比|环比|grew|growth|annual(?:ized)?\s*rate|increased?|expanded|rose|raised?|surge|climb)/i.test(s)
      && /(%|％|percent|百分点)/i.test(s)) {
    return '增长率';
  }
  for (const [kw, prop] of INDICATORS) {
    if (s.includes(kw)) {
      // GDP/生产总值 总量句二次校验：必须是"总量"而非人均/占比/财政碎片，且含货币/总量单位词；
      // 仅顺带提到"GDP"字样的百分比句（如"供应商交付指数50.6%…GDP[…]”）不是总量数据，降级。
      // 注意：查询问题本身（如"生产总值是多少"）不含数值，forQuery 时不能做此校验。
      if (!forQuery && prop === '国内生产总值') {
        if (/人均|per\s*capita/i.test(s)) return '相关数据';            // 人均GDP不是总量
        if (/(占|占比|比重|比值|相当于).{0,12}(GDP|生产总值)|(GDP|生产总值).{0,12}(占比|比重|比值)|(?:%|percent)\s*of\s+GDP/i.test(s)) return '相关数据'; // "X% of GDP/占GDP比重"是占比句
        const hasMoney = /(万亿|千亿|百亿|十亿|亿|万|trillion|billion|million|dollars?|USD|RMB|yuan|欧元|日元|港元|元)/i.test(s);
        if (!hasMoney) return '相关数据';
      }
      return prop;
    }
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
  // 查询问的指标（如问"生产总值"→总量句优先于增长率句，避免中文增长率官方句把英文总量句挤出）
  const queryProp = classifyProp(String(queryText || ''), true) || '';

  for (const r of sorted) {
    // 语种判断必须在清洗前、基于原始摘要：含拉丁字母且无 CJK 汉字即按英文处理。
    // （不能用纯 ASCII 判断——€£等符号、表格|替换成的中文逗号都会误判；tradingeconomics 表格、countryeconomy 含€都靠此放行）
    const rawHead = String(r.snippet || '').slice(0, 60);
    const isEn = /[a-zA-Z]/.test(rawHead) && !/[\u4e00-\u9fff]/.test(rawHead);
    const snip = (r.snippet || '')
      .replace(/【[^】]*】/g, ' ')
      .replace(/```[\s\S]*?```/g, ' ')       // 代码块
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1') // **加粗**
      .replace(/\*{1,3}/g, '')
      .replace(/#{1,6}\s*/g, '')              // markdown 标题符
      .replace(/`+/g, '')
      .replace(/\|+/g, isEn ? ', ' : '，')    // 表格分隔（英文页用英文逗号，避免全角字符污染英文切句）
      .replace(/^[\s>·•\-–—*]+/gm, '');       // 行首符号
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
      if (s.length < 8 || s.length > (isEn ? 260 : 160)) continue;
      // 跳过网页页脚/备案/导航噪音，以及纯标题（无句读且过短的导航词）
      if (/版权所有|ICP备|公网安备|网站标识码|中文域名|京公网|备案|Copyright|cookie|隐私权|网站地图|首页|上一篇|下一篇|点击下载|字体大小|分享到/.test(s)) continue;
      const hasData = isEn ? /\d[\d.,\-–—~]*[\s，,|]*(?:trillion|billion|million|thousand|yuan|dollars?|USD|RMB|kg|kgs|kilograms?|lbs?|pounds?|cm|mm|km|meters?|metres?|tons?|tonnes?|km\/h|mph|years?|yrs?|hectares?|percent|%)/i.test(s)
        : new RegExp('\\d[\\d.,，\\-－—~～至到]*\\s*' + CN_UNIT).test(s);
      if (!hasData) continue;
      const prop = classifyProp(s) || '相关数据';
      // 含目标年份的句子加权排前
      const yearHit = wantYear && s.includes(wantYear);
      // 与查询所问指标一致（问总量时总量句排前）
      const propMatch = queryProp && prop === queryProp;
      facts.push({ property: prop, value: s, source, yearHit, propMatch, official: source.official });
    }
  }

  // 排序：与查询指标一致 → 官方优先 → 含目标年份优先
  // （指标匹配必须排在官方性之前：问总量时，非官方的总量句也比官方的增长率句更相关）
  facts.sort((a, b) =>
    (b.propMatch ? 1 : 0) - (a.propMatch ? 1 : 0) ||
    (b.official ? 1 : 0) - (a.official ? 1 : 0) ||
    (b.yearHit ? 1 : 0) - (a.yearHit ? 1 : 0));

  // 去重：同属性+相似开头只留一条（优先官方/含年份）
  const seen = new Set();
  const out = [];
  for (const f of facts) {
    const key = f.property + '|' + f.value.replace(/\s/g, '').slice(0, 24);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
    if (out.length >= 18) break;
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
  // 总量型问题（"X生产总值是多少"）补充检索词：默认检索词容易只召回"增长率/增速"文章，
  // 追加"总量 万亿美元"以召回 GDP 规模数据
  const isAmountQuestion = /多少|总量|规模|有多大/.test(text) && /生产总值|GDP|经济总量/i.test(text);
  const searchQueryExtra = isAmountQuestion ? `${searchQuery} 总量 万亿美元` : null;
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

  // 总量型问题：用补充检索词再搜一次（总量/万亿美元），按 URL 去重合并
  if (searchQueryExtra) {
    try {
      const cacheK2 = searchCacheKey(searchQueryExtra + '|card');
      let extra = await cacheGet(env.FACT_CACHE, cacheK2);
      if (!extra) {
        const raw2 = await braveSearch({ query: searchQueryExtra, preferOfficial: true, topK: 5, whitelist, hint });
        extra = annotateResults(raw2, env);
        await cacheSet(env.FACT_CACHE, cacheK2, extra);
      }
      const seen = new Set((searchResults || []).map(r => r.url));
      for (const r of extra || []) {
        if (r.url && !seen.has(r.url)) { searchResults.push(r); seen.add(r.url); }
      }
    } catch { /* 补充检索失败忽略 */ }
  }

  // 外国 GDP 总量问题：英文 Tavily 检索（BEA/IMF/世界银行的总量数据英文源最全）
  const enGdp = isAmountQuestion && /生产总值|GDP|gdp|国内生产/i.test(text) ? foreignGdpEnQuery(text) : null;
  if (enGdp) {
    try {
      const cacheK3 = searchCacheKey('en|' + enGdp.query);
      let enRes = await cacheGet(env.FACT_CACHE, cacheK3);
      if (!enRes) {
        // 轮1：全网英文（长词）；轮2：官方/权威数据站定向（短词，官方站内召回率更高）
        const econDomains = ['bea.gov', 'imf.org', 'worldbank.org', 'oecd.org',
          'tradingeconomics.com', 'statista.com', 'ceicdata.com', 'countryeconomy.com'];
        const [tv, tvOff] = await Promise.all([
          tavilySearch(enGdp.query, { apiKey: env.TAVILY_KEY, topK: 6, searchDepth: 'advanced' }),
          tavilySearch(enGdp.shortQuery, {
            apiKey: env.TAVILY_KEY, topK: 8, searchDepth: 'advanced',
            includeDomains: econDomains,
          }),
        ]);
        const merged = [...(tvOff.results || []), ...(tv.results || [])];
        // Tavily 综合答案（通常直接含"GDP was $xx trillion in 2025"总量句）作为高优先级来源
        const tavilyAnswer = tvOff.answer || tv.answer;
        if (tavilyAnswer) {
          merged.unshift({
            title: `${enGdp.en} GDP ${enGdp.year}（检索引擎综合答案）`,
            url: 'https://app.tavily.com/',
            snippet: tavilyAnswer,
            source: 'tavily',
          });
        }
        enRes = annotateResults(merged, env);
        await cacheSet(env.FACT_CACHE, cacheK3, enRes);
      }
      const seen3 = new Set((searchResults || []).map(r => r.url));
      for (const r of enRes || []) {
        if (r.url && !seen3.has(r.url)) { searchResults.push(r); seen3.add(r.url); }
      }
    } catch { /* 英文检索失败忽略 */ }
  }

  // 查询模式额外实时检索官方站（GDP/政策等权威数据在官方公报，维基常无；不缓存以免限流空结果固化）
  if (intent === 'query') {
    try {
      // 总量问题并发检索官方站的原始词与补充词
      const govQueries = [searchQuery, searchQueryExtra].filter(Boolean);
      const govSettled = await Promise.all(
        govQueries.map(q => searchGovDirect(q, { apiKey: env.TAVILY_KEY }).catch(() => []))
      );
      const govAnnotated = govSettled.flatMap(g => annotateResults(g, env));
      // 官方结果排前合并
      searchResults = [...govAnnotated, ...(Array.isArray(searchResults) ? searchResults : [])];
      // 相关性过滤：剔除只在正文顺带提及实体的无关词条（如查"大熊猫"却召回"犬/郊狼/柳江人"）
      // 用纯实体词（去掉体重/身高等属性词），避免"大熊猫 身高"这类不连续串误杀
      const relEntity = entityTermOf(entity && entity.length >= 2 ? entity : text.trim());
      searchResults = filterRelevant(searchResults, relEntity);
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
              content: [
                '你是资料核查助手。根据检索到的权威数据，直接回答用户的问题，并评估数据可信度。',
                '回答规则：',
                '1. 先判断用户问的核心指标：总量/规模（如"生产总值是多少"）、增长率/增速、人均值、排名等；',
                '2. 只能用与问题"同一指标"的数据作答。严禁用增长率、年化增长率、预估值冒充总量——例如问"生产总值是多少"时，不能回答"增长率为3.9%"；',
                '3. 若检索数据中没有该指标的直接数据：answer 必须先明确说明"未检索到〈指标〉的权威总量数据"，再附上检索到的相关指标（注明那是什么指标），不得让用户误以为它就是答案；',
                '4. 数值必须忠实于检索数据，年份、地区必须与问题一致，禁止用相邻年份（如用2024年数据回答2025年问题）而不标注年份；',
                '5. 有直接数据时 answer 含具体数值和单位；没有时如实说明，不要编造或凑数。',
                '6. 单位必须与证据严格一致，英文单位换算：1 trillion = 万亿，1 billion = 十亿（10亿），1 million = 百万。例如"30,769.70 billion US dollars"="约30.77万亿美元"，"30.8 trillion dollars"="30.8万亿美元"；严禁把"30769.70 billion美元"误写成"30769.70亿美元"（那会错10倍）。拿不准换算时直接保留原单位表述。',
                '可信度判定：多个独立权威来源的同一指标数据一致→"高"；仅单一来源、约数/范围、或只有相关指标而无直接答案→"中"；数据缺失或相互矛盾→"低"。',
                '只输出 JSON：{"answer":"一句话直接解答","confidence":"高或中或低","reason":"说明依据（来源数量、是否同一指标、是否预测值）"}，不要解释。',
              ].join('\n'),
            },
            {
              role: 'user',
              content: `用户查询：${text}\n\n检索到的权威数据（方括号内为指标名）：\n${dataText}\n\n请输出 JSON。`,
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

    // 查询模式也生成 draftCard（供入库用）
    let queryDraftCard = null;
    if (factCard.facts.length > 0) {
      queryDraftCard = {
        title: entity || text.trim(),
        aliases: [],
        category: 'auto',
        facts: factCard.facts.map(f => ({
          label: f.property || text.trim(),
          value: f.value || '',
          rating: 'high',
          source: f.source || {},
          verified_at: new Date().toISOString().slice(0, 10),
        })),
        references: (searchResults || []).slice(0, 5).map(r => ({
          name: r.title || r.site_name || '',
          url: r.url || '',
          official_tag: r.official_tag || false,
        })),
      };
      if (autoDraft) {
        try { await submitDraft(env.FACT_KB, queryDraftCard); } catch {}
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
    };
  }

  // ---------- 分支 B：断言模式 → 事实核查 ----------
  // 0. 快路径：先用原文直接查知识库（仅标题/别名实体匹配，避免句中数字误命中）。
  //    命中则只调用一次 LLM 同时完成"提取断言 + 对照知识库评级"，不联网、不提待审。
  if (intent === 'assertion') {
    try {
      const kbPre = await queryEntry(env.FACT_KB, text, env.FACT_CACHE, { entityOnly: true });
      if (kbPre?.hit && Array.isArray(kbPre.card?.facts) && kbPre.card.facts.length > 0) {
        const kbCard = kbPre.card;
        const kbRelated = relatedKbFacts(kbCard.facts.filter(f => f && (f.label || f.value)), text);
        const kbFactsText = kbRelated
          .map(f => `- ${f.label ? f.label + '：' : ''}${f.value || ''}`)
          .join('\n');

        const fastMsgs = [
          { role: 'system', content: [
            '你是严谨的事实核查助手。用户给出一段需要验证的断言，并附带知识库中已核实的事实。',
            '请完成：',
            '1. 提取断言中的每个事实点；',
            '2. 逐条对照知识库事实评级：高=与知识库事实一致；低=与知识库事实矛盾；中=知识库没有覆盖该事实点、无法判定。',
            '   数值判定规则：成年/一般主体的指标常因野生/人工饲养等情形存在多个范围，只要断言数值落入任一权威来源所述的正常范围/区间内，即判"高"；仅当数值明确超出所有相关范围时才判"低"（注意区分幼崽/幼仔等特殊生长阶段的数据，不要拿来否定成年个体的断言）；知识库完全没有对应属性的数据时才判"中"。',
            '3. 与知识库矛盾时，在 correction 中用知识库事实给出正确说法；一致或无法判定时 correction 留空字符串。',
            '仅输出 JSON 数组，元素格式：{"claim":"事实点","entity":"主体","rating":"高|中|低","evidence":"对照的知识库事实","correction":"纠错或空字符串"}。不要输出任何其他内容。',
          ].join('\n') },
          { role: 'user', content: `待验证断言：${text}\n\n知识库已核实事实（词条：${kbCard.title}）：\n${kbFactsText}` },
        ];
        const fastRaw = await callLLMJson({ messages: fastMsgs, apiKey, temperature: 0.1, maxTokens: 1024 });
        if (Array.isArray(fastRaw) && fastRaw.length > 0) {
          const fastRatings = fastRaw
            .filter(r => r && r.claim)
            .map(r => ({
              claim: r.claim,
              entity: r.entity || kbCard.title || '',
              rating: normRating(r.rating),
              evidence: r.evidence || '',
              correction: r.correction || '',
            }));
          // 所有事实点都能被知识库判定（高=一致 / 低=矛盾）才走快路径；
          // 只要有"中"（知识库覆盖不了）就降级到完整联网核查流程
          if (fastRatings.length > 0 && fastRatings.every(r => r.rating === '高' || r.rating === '低')) {
            const kbResults = kbRelated
              .map(f => ({
                title: `【知识库已核实】${f.source?.name || kbCard.title || ''}`,
                url: f.source?.url || '',
                snippet: `${f.label ? f.label + '：' : ''}${f.value || ''}`.slice(0, 300),
                official_tag: !!(f.source?.official_tag || f.source?.official),
                official_score: (f.source?.official_tag || f.source?.official) ? 0.9 : (f.source?.official_score || 0.6),
                site_name: f.source?.name || '知识库',
                from_kb: true,
              }));
            for (const ref of (kbCard.references || []).slice(0, 3)) {
              if (ref.url && !kbResults.some(r => r.url === ref.url)) {
                kbResults.push({
                  title: ref.name || '参考来源',
                  url: ref.url,
                  snippet: '',
                  official_tag: !!ref.official_tag,
                  official_score: ref.official_tag ? 0.9 : 0.5,
                  from_kb: true,
                });
              }
            }
            const claimsOut = fastRatings.map(r => ({ claim: r.claim, entity: r.entity }));
            const ratingsOut = fastRatings.map(r => ({
              claim: { claim: r.claim, entity: r.entity },
              rating: r.rating,
              evidence: r.evidence,
              correction: r.correction,
              sources: kbResults,
            }));
            const overall = ratingsOut.every(r => r.rating === '高')
              ? '高'
              : ratingsOut.some(r => r.rating === '低') ? '低' : '中';
            return {
              intent: 'verify',
              claims: claimsOut,
              searches: [{ claim: { claim: text, entity: kbCard.title }, results: kbResults, cached: true, fromKb: true }],
              rating: overall,
              kb_hit: true,
              corrections: ratingsOut.filter(r => r.correction).map(r => ({
                claim: r.claim?.claim || '', correction: r.correction, evidence: r.evidence,
              })),
              ratings: ratingsOut,
              draftCard: null,
            };
          }
        }
      }
    } catch { /* 快路径异常或知识库覆盖不足 → 降级到完整核查流程 */ }
  }

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

  // 2. 对每条断言检索证据：先查知识库（已核实事实直接用），未命中再联网
  const checkSearches = await Promise.all(
    claims.slice(0, 5).map(async (c) => {
      const attrM2 = (c.claim || '').match(ATTR_RE);
      const hint2 = attrM2 ? attrM2[1] : '';
      const entity2 = (c.entity && c.entity.trim()) ? c.entity.trim() : '';

      // 2a. 知识库快路径：实体已入库 → 直接用已核实事实作为证据，不再联网
      if (entity2) {
        try {
          const kb = await queryEntry(env.FACT_KB, entity2, env.FACT_CACHE);
          if (kb?.hit && Array.isArray(kb.card?.facts) && kb.card.facts.length > 0) {
            const kbRelated = relatedKbFacts(
              kb.card.facts.filter(f => f && (f.label || f.value)),
              c.claim || ''
            );
            const kbResults = kbRelated
              .map(f => ({
                title: `【知识库已核实】${f.source?.name || kb.card.title || entity2}`,
                url: f.source?.url || '',
                snippet: `${f.label ? f.label + '：' : ''}${f.value || ''}`.slice(0, 300),
                official_tag: !!(f.source?.official_tag || f.source?.official),
                official_score: (f.source?.official_tag || f.source?.official) ? 0.9 : (f.source?.official_score || 0.6),
                site_name: f.source?.name || '知识库',
                from_kb: true,
              }));
            // 补充卡片参考来源链接
            for (const ref of (kb.card.references || []).slice(0, 3)) {
              if (ref.url && !kbResults.some(r => r.url === ref.url)) {
                kbResults.push({
                  title: ref.name || '参考来源',
                  url: ref.url,
                  snippet: '',
                  official_tag: !!ref.official_tag,
                  official_score: ref.official_tag ? 0.9 : 0.5,
                  from_kb: true,
                });
              }
            }
            if (kbResults.length > 0) {
              return { claim: c, results: kbResults, cached: true, fromKb: true };
            }
          }
        } catch { /* 知识库查询失败则走联网 */ }
      }

      // 2b. 联网检索（知识库未命中）
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
        return { claim: sr.claim, rating: '低', evidence: '未找到相关证据', correction: '建议人工核实' };
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
        return { claim: sr.claim, ...r, rating: normRating(r.rating), sources: sr.results };
      } catch (e) {
        return { claim: sr.claim, rating: '中', evidence: '评级失败', correction: e.message };
      }
    })
  );

  // 4. 知识库草稿（全部证据都来自知识库时不再重复提交待审）
  const draftCard = buildDraftCard(claims, ratings, checkSearches);
  const allFromKb = checkSearches.every(s => s.fromKb);
  if (autoDraft && draftCard && draftCard.facts.length > 0 && !allFromKb) {
    try { await submitDraft(env.FACT_KB, draftCard); } catch {}
  }

  const overall = ratings.every(r => r.rating === '高')
    ? '高'
    : ratings.some(r => r.rating === '低')
    ? '低'
    : '中';

  return {
    intent: 'verify',
    claims,
    searches: checkSearches,
    rating: overall,
    kb_hit: checkSearches.some(s => s.fromKb),
    corrections: ratings.filter(r => r.correction).map(r => ({
      claim: r.claim?.claim || '', correction: r.correction, evidence: r.evidence,
    })),
    ratings,
    // 全部证据都来自知识库时不返回入库卡片（前端不再提示自动入库）
    draftCard: allFromKb ? null : draftCard,
  };
}
