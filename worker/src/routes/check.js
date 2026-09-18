// POST /api/check - 事实核查主端点（A+B：事实提取 + 检索 + 真实度评级）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey, callLLMJson } from '../utils/llmProxy.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { cacheGet, cacheSet, cacheDelete, searchCacheKey, SEARCH_TTL, ratingCacheKey, claimsCacheKey, RATING_TTL, CLAIMS_TTL, kbSelectCacheKey, KB_SEL_TTL } from '../utils/cache.js';
import { annotateResults, sourceTier, isAuthoritativeTextSource, isPoetryCorpusSite } from '../utils/officialScore.js';
import { braveSearch, braveSearchForce, tavilySearch, filterRelevant, entityTermOf } from '../sources/brave.js';
import { searchGovDirect } from '../sources/govDirect.js';
import { buildExtractFactsMessages } from '../prompts/extractFacts.js';
import { buildRateTruthMessages } from '../prompts/rateTruth.js';
import { queryEntry, autoStoreCard } from '../utils/kbStore.js';
import { buildDraftCard, buildStoreCardsByEntity } from '../utils/draftBuilder.js';
import { CN_UNIT, EN_UNIT, makeDataRe, classifyProp, splitMultiAttrClauses, isCitableSource, INDICATORS, isAttrNoun, storeFactsOf, bestCitableSource, quoteCoverage, pickFactSentence, bigramOverlap, normZh } from '../utils/attrClassify.js';

const MODEL = 'Qwen/Qwen2.5-72B-Instruct';

// 单次核查最多处理的断言条数
// 权衡：条数越多覆盖越全，但检索+评级耗时与**子请求数**线性增长。
// Cloudflare 免费版单次调用子请求上限 50：主流程（解析+主检索+整段核查+抽取+入库）
// 实测 ~18-22，剩余 ~30 养 6 条断言刚好（每条成本见下）。超出 MAX_CLAIMS 的部分
// 由前端提示分段提交；超出**子请求预算**的断言不再独立检索，复用主检索结果评级。
const MAX_CLAIMS = 6;
// 断言总预算与单项成本（按实测消耗估）：每条断言 = KB 查（2~4 个 KV get）
// + 独立检索 1~2 + 评级 LLM 1 ≈ 7；诗句原文比对额外 2（检索+可能兜底）。
// ⚠️ KV 读写也占子请求额度，此前漏算 KB 查导致第 5、6 条断言评级爆 1102。
const CLAIM_SEARCH_BUDGET = 28;
const CLAIM_BUDGET_COST = 7;

// 整段原文直配门槛（见 runCheck 的"整段原文核查"）：
// 被核查的整段文字有 ≥70% 的内容二元组出现在同一个可引用页面的标题/摘要里、
// 且重合二元组 ≥10 个 → 认定"这段文字有可引用出处"，整段按"高"采信。
// 阈值依据：整段被收录时实测覆盖率 >0.9；只有**前半段**被收录（后半段是改写过的）
// 实测约 0.6 —— 取 0.7 可以把"只收录了一部分"的句子挡在整段采信之外
// （那半句该走逐点核查，不能搭整段的车）。另有"反算"通道（摘要有多少出自整段），
// 用于摘要被截断、只收录了其中一段的情形。
const QUOTE_MATCH_MIN = 0.7;
const QUOTE_MATCH_MIN_OVERLAP = 10;

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
/**
 * 让大模型从词条**已有事实**里挑出能回答问题的条目。
 *
 * ⚠️ 硬规则（用户明确要求：知识库里没有的数据绝对不能编造）：
 *   大模型**只输出事实序号**，答案文本一律由调用方用词条存着的原文拼装。
 *   它没有"写答案"的通道，想编也无从编起。挑不出任何一条就返回 []，
 *   上层如实告知"知识库暂无此数据"并转全网检索，绝不拿模型生成的内容充数。
 *
 * 为什么要有这一层：标签匹配是确定性的，但标签一旦不准就会漏——多指标长句只按
 * 第一个指标归类、近义属性词覆盖不全等。用户实测：词条里明明有"体长"数据，
 * 查"大熊猫 体长"却命中不了，于是又跑一遍全网检索、把同一批数据重复入库。
 *
 * @returns {Promise<Array>} 挑中的事实对象数组（引用原数组元素），挑不中返回 []
 */
async function selectKBFactsByLLM(env, apiKey, question, facts) {
  if (!apiKey || !Array.isArray(facts) || facts.length === 0) return [];
  const list = facts.slice(0, 30); // 事实都很短，限 30 条防 prompt 膨胀
  const factsSig = list.map(f => `${f.label || ''}:${f.value || ''}`).join('|');

  // 缓存：同问题 + 同事实指纹 → 同结果（词条一变指纹就变）。
  // 存成对象 {picks} 而非裸数组：cacheSet 会拒绝空数组，而这里"挑不中"也是
  // 确定性结论（输入完全给定、无上游抖动），必须缓存，否则同一问题每次都白跑一次 LLM。
  const ck = kbSelectCacheKey(question, factsSig);
  try {
    const cached = await cacheGet(env.FACT_CACHE, ck);
    if (cached && Array.isArray(cached.picks)) return cached.picks.map(i => list[i - 1]).filter(Boolean);
  } catch {}

  let picks = [];
  try {
    const resp = await callLLMJson({
      messages: [
        {
          role: 'system',
          content: [
            '你在做"从已有资料中检索"，不是问答，也不是写作。',
            '下面给出某个词条的若干条事实，编号从 1 开始。',
            '请挑出**能直接回答用户问题**的事实编号。',
            '铁律：',
            '1. 只能从给定编号里挑，不得改写、补充、推断、换算、合并任何内容；',
            '2. 事实里没有用户问的那个指标（例如问"身高"而资料里只有"体重"）→ 返回空数组，',
            '   不得用相近指标凑数（动物身高≈肩高/体长 这类近义**可以**算同一指标）；',
            '3. 年份、地区必须与问题一致；',
            '4. 只输出 JSON：{"picks":[1,3]}；一个都不合适就 {"picks":[]}',
          ].join('\n'),
        },
        {
          role: 'user',
          content: `用户问题：${question}\n\n事实列表：\n` +
            list.map((f, i) => `${i + 1}. [${f.label || '未标注'}] ${f.value || ''}`).join('\n'),
        },
      ],
      apiKey,
      temperature: 0,
      maxTokens: 120,
    });
    const raw = Array.isArray(resp?.picks) ? resp.picks : [];
    // 严格校验：必须是 1..list.length 的整数，去重、保序、限 6 条
    const seen = new Set();
    for (const n of raw) {
      const i = Number(n);
      if (!Number.isInteger(i) || i < 1 || i > list.length || seen.has(i)) continue;
      seen.add(i);
      picks.push(i);
      if (picks.length >= 6) break;
    }
  } catch { picks = []; }

  try { await cacheSet(env.FACT_CACHE, ck, { picks }, KB_SEL_TTL); } catch {}
  return picks.map(i => list[i - 1]).filter(Boolean);
}

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
    if (!probe) continue;
    // 单字 probe（"金""水""银"这类实体）不做模糊匹配——模糊匹配在单字上等于
    // "命中任何含该字的词条"，是噪声来源；但**精确命中**（别名索引 / 标题一致）
    // 必须放行，否则库里明明有"金"这个词条，用户查"金"却永远查不到。
    // 命中后仍要走下面的属性匹配，不会把无关事实当成答案。
    const exactOnly = probe.length < 2;
    let hit = null;
    try {
      hit = await queryEntry(env.FACT_KB, probe, { exactOnly });
    } catch { hit = null; }
    if (!hit || !hit.hit || !hit.card) continue;

    const card = hit.card;
    const facts = Array.isArray(card.facts) ? card.facts : [];
    if (facts.length === 0) continue;

    // ⚠️ 词条主体必须与断言主体一致，否则放弃这次命中（继续试下一个 probe；
    // 全都对不上 → 视为未命中，走全网检索）。
    // 反例（实测）：断言"普里斯特利用锌加入稀硫酸中制得可燃空气"的实体是"普里斯特利"，
    // 但断言文本里含"可燃空气" → 模糊匹配命中了《可燃空气》词条；这个命中又**挡住了
    // 全网检索**（KB 优先），而词条证据在按实体过相关性闸门时被剔除 → 该条只能判
    // "查无实据"，其实网上有充分证据。判据：词条名/别名与实体互含，或二元组重合 ≥2
    //（"约瑟夫·普里斯特利" ↔ "普里斯特利" 覆盖 4 个二元组）。
    // 诗句原文断言：跳过 entity 闸门——它的命中依据是**value 文本本身**（诗句唯一性强），
    // entity 探测失手（LLM 给了作者名/变体名）不应挡住"库里已有这句诗"的命中，
    // 否则已入库诗句再查会显示"可手动入库"，用户看到重复的入库提示。
    const isQuoteClaim = String(claim.metric || '') === '原文' || !!claim.quoteClaim;
    if (entity && !isQuoteClaim) {
      const names = [card.title, ...(Array.isArray(card.aliases) ? card.aliases : [])]
        .map(x => String(x || '').trim()).filter(Boolean);
      const sameEntity = names.some(n => n === entity || n.includes(entity) || entity.includes(n))
        || names.some(n => bigramOverlap(entity, n) >= 2);
      if (!sameEntity) continue;
    }

    // 从词条事实中挑与属性相关的**全部**事实：
    // ① label 与任一属性词互相包含（hint 可能是"身高 体重"多属性）→ ② label 与断言文本互相包含
    // → ③ value 含断言数值 → ④（仅纯实体查询）取第一条。全部不中 → 视为未命中（走全网检索），
    //    宁可多花一次检索，也不能拿无关事实冒充答案。
    const nums = (claimText.match(/\d+(?:\.\d+)?/g) || []);
    const attrWords = metric
      ? metric.split(/[\s、,，+/和与及]+/).map(w => w.trim()).filter(w => w.length >= 2)
      : [];
    // 属性近义匹配（口径与检索扩展/数据卡过滤一致，见 ATTR_SYNONYMS）：
    //  - 标签匹配：问"身高"时库里的"体长/肩高"类标签也算命中（动物身高≈肩高/体长）
    //  - 值匹配：仅对**通用标签**（相关数据/其他…）的事实生效，防止"粪便重量"被当体重
    const labelHit = (f, word) => {
      const lbl = (f.label || '').trim();
      return lbl && word.length >= 2 && (lbl.includes(word) || word.includes(lbl));
    };
    let matched = [];
    if (isQuoteClaim && claimText) {
      // 诗句原文断言：value 与断言句归一后互含即命中（问"日照澄洲江雾开"，
      // 库里有同句/含此句的诗文事实）
      const stripPunc = (x) => String(x || '').replace(/[\s，。；、·,.;:!?！"“”'’‘()（）【】\[\]]/g, '');
      const sc = stripPunc(claimText);
      matched = facts.filter(f => {
        const fv = stripPunc(f.value || '');
        return fv.length >= 4 && sc.length >= 4 && (fv === sc || fv.includes(sc) || sc.includes(fv));
      });
    } else if (attrWords.length > 0) {
      const labelWords = [];
      for (const w of attrWords) {
        labelWords.push(w);
        (ATTR_SYNONYMS[w] || []).forEach(s => labelWords.push(s));
      }
      matched = facts.filter(f => labelWords.some(w => labelHit(f, w)));
      const valMatched = facts.filter(f => {
        const lbl = (f.label || '').trim();
        if (!GENERIC_LABEL_RE.test(lbl)) return false;
        const val = f.value || '';
        return attrWords.some(w => val.includes(w) || (ATTR_SYNONYMS[w] || []).some(s => val.includes(s)));
      });
      for (const f of valMatched) if (!matched.includes(f)) matched.push(f);
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
    // 阶段 2（大模型挑选）：标签/数值都没匹配上，但**词条确实存在** → 让模型从
    // 词条已有事实里挑序号（见 selectKBFactsByLLM 的硬规则）。仅在有属性词时启用：
    // 纯实体查询走 allowLoose 取首条即可，不必为此多付一次 LLM。
    let matchedViaLLM = false;
    if (matched.length === 0 && metric) {
      try {
        const picked = await selectKBFactsByLLM(env, opts.apiKey, claimText || `${entity} ${metric}`.trim(), facts);
        if (picked.length > 0) { matched = picked; matchedViaLLM = true; }
      } catch { /* 挑选失败按未命中处理 */ }
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
    // 避免用户疑惑"为什么答案里没有身高"。
    // 判定与上面的匹配口径一致（含近义词），否则"身高"已由肩高事实命中却仍被报缺失。
    const attrSatisfied = (w) => matched.some(f => {
      const lbl = (f.label || '').trim();
      const val = f.value || '';
      if (labelHit(f, w)) return true;
      if ((ATTR_SYNONYMS[w] || []).some(s => labelHit(f, s))) return true;
      if (GENERIC_LABEL_RE.test(lbl) &&
          (val.includes(w) || (ATTR_SYNONYMS[w] || []).some(s => val.includes(s)))) return true;
      return false;
    });
    // 大模型挑选出来的事实，就是"能回答该属性"的结论，不再按标签口径重判缺失
    // （否则"体长"数据因标签是"体重"会被误报为缺失）。
    const missingAttrs = matchedViaLLM ? [] : attrWords.filter(w => !attrSatisfied(w));
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
        // 诊断用：命中是靠标签匹配还是大模型挑选
        matchedVia: matchedViaLLM ? 'llm' : 'label',
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
export function buildSearchQuery(claim) {
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
    // metric 只有是"可检索的属性名词"时才拼进检索词。
    // 形容词/状态词型 metric 拼进去会污染召回——实测 "金 金黄" 召回的是
    // "胡杨林一片金黄""金黄色葡萄球菌""Bao Zheng"，而只查 "金" 直接命中
    // 维基《金》词条（正文含"黄中带红、柔软"），断言反而能被证实。
    const metricWord = /\d/.test(metric) ? stripNumbers(metric) : metric;
    if (metricWord && metricWord !== entity && isSearchableAttr(metricWord)) {
      return expandQueryWithAttrSynonyms(`${entity} ${metricWord}`, metricWord);
    }
    // metric 不是属性名词（整句谓语/事件描述）→ 检索词会退化成**纯实体**。
    //   ① 叙事型断言（描述事件/过程/因果）：用**整句断言**做检索词，信息量最大。
    //      实测"可燃空气 铁制容器 点燃 爆鸣声"只召回《五羰基铁》《烟花爆竹》这类噪音，
    //      而整句"可燃空气与空气通入铁制容器中混合点燃 能产生剧烈的爆鸣声"能直接召回
    //      《ICSC 0001 - 氢》《氫氣-維基百科》——Tavily 对自然语言长句理解很好。
    //   ② 短断言（如"金是金黄色的"）：整句没有额外信息，加关键词反而稀释召回 → 退回实体。
    const claimText = String(claim.claim || '').replace(/[“”"']/g, ' ').replace(/\s+/g, ' ').trim();
    if (claimText.length >= 12 && claimText !== entity) return claimText;

    // 短断言的实体若为人名/事件名，只拿实体去搜必然召回归名噪音
    // （"普里斯特" → 普里斯特菲尔德球场/小说家约翰·博因顿·普里斯特利），
    // 用抽取出的 keywords 补语境关键词（术语/别称/年代/事件名），把检索定向到正确主题。
    const kws = String(claim.keywords || '').trim();
    if (kws) {
      const extra = kws
        .split(/[\s、,，+/／]+/)
        .map(s => s.trim())
        .filter(s => s && s !== entity && !entity.includes(s) && !/\d/.test(s))
        .slice(0, 3);
      if (extra.length) return `${entity} ${extra.join(' ')}`;
    }
    return entity;
  }
  const fromClaim = stripNumbers(claim.claim || '');
  return fromClaim || (claim.claim || '');
}

// 属性维度词：断言中出现这些词时，检索词带上维度（如"大熊猫 体重"），
// 并作为 hint 传给维基深度抽取，定向定位正文数据句
const ATTR_RE = /(体重|體重|身高|体长|體長|身长|身長|寿命|壽命|年龄|年齡|速度|面积|面積|人口|产量|產量|距离|距離|海拔|重量|翼展|跨度|直径|直徑|厚度|深度|宽度|寬度|长度|長度|生日|诞辰|出生|生於|生于|出生日期|出生年月|逝世|去世|卒於|卒于|国籍|籍贯|学历|职业|职务|职位|身高|体重)/;

// 属性近义表（三处口径统一：检索词扩展 / KB 事实匹配 / 数据卡过滤）
// 为什么需要它：搜索引擎不懂"身高"对动物等于"肩高/体长"。实测"大熊猫 身高"只会召回
// 泛泛的科普页，而"大熊猫 身高 肩高"能直接召回《大熊猫的外形特征》（含"肩高650—750毫米"）。
// 从严维护，只收**语义上确实同一属性**的词——宁可让大模型挑选那一层去兜底，
// 也不要让"查体长却返回肩高"这种答非所问：
//   · 体重不认"重量"（库里存在"粪便重量"这类脏标签，宽松近义会假阳性）
//   · 体长不认"肩高/身高"（体长≠肩高，是两种量度）
const ATTR_SYNONYMS = {
  '身高': ['肩高', '臀高', '体高'],   // 动物的"身高"即肩高/臀高
  '体长': ['身长', '头躯长'],
  '体重': [],
  '重量': ['体重'],
  '面积': ['占地', '总面积', '幅员'],
  '人口': ['总人口', '人口数'],
  '寿命': ['平均寿命', '最长寿命'],
  '速度': ['时速'],
  '海拔': [],
  '翼展': ['展翅长'],
};

// 通用标签：标签不成词（如"相关数据"）的事实，允许按"值"匹配属性词
const GENERIC_LABEL_RE = /^(相关数据|其他|数据|详情|信息|备注)?$/;

/** 把属性近义词追加进检索词（最多 2 个，避免过长影响召回）。
 *  metric 可能含多个属性词（如"体重 身高"），但**只扩展第一个**：
 *  主检索词本身已是多属性，再逐个堆叠近义词会让维基全文检索（词项交集）
 *  直接零召回——实测"大熊猫 体重 身高 肩高 臀高 体高"召回 0 条。 */
function expandQueryWithAttrSynonyms(query, metric) {
  const q = String(query || '').trim();
  if (!q) return q;
  const first = String(metric || '').split(/[\s、，,\/]+/).map(s => s.trim()).filter(Boolean)[0] || '';
  if (!first) return q;
  const syn = (ATTR_SYNONYMS[first] || []).filter(s => !q.includes(s)).slice(0, 2);
  return syn.length ? `${q} ${syn.join(' ')}` : q;
}

/**
 * 收集查询里出现的**全部**属性词（含 hint 与原文各自出现、且可能不止一个）。
 * 多属性查询（"大熊猫 体重 身高"）时 factCard 过滤、检索扩展都必须用并集，
 * 否则只认第一个属性词，其它属性的数据句会被相关性过滤全部剔除——
 * 表现为"直接解答有数据，但结构化数据卡为空"。
 */
function attrWordsOf(text, hint) {
  const words = new Set();
  const globalAttrRe = new RegExp(ATTR_RE.source, 'g');
  for (const m of (String(text || '').match(globalAttrRe) || [])) words.add(m);
  for (const part of String(hint || '').split(/[\s、，,\/]+/)) {
    const w = part.trim();
    if (w) words.add(w);
  }
  return [...words];
}

// 属性名词白名单与判据统一放在 utils/attrClassify.js（isAttrNoun / SEARCHABLE_ATTRS），
// 因为"能不能拼进检索词"和"能不能当知识库事实标签"必须是同一份口径——
// 此前这里一份、入库侧一份，迟早漂移。
//
// 为什么要白名单：大模型给的 metric 混杂了属性名词（体重/熔点/作者）与形容词性
// 表述（金黄/柔软/不易被氧化/最古老的采金方法）。后者拼进检索词只会稀释召回——
// 实测 "金 熔点" 能得到官方标准 PDF 与维基《灰吹法》（含"金熔点1064.1"），
// 而 "金 金黄" 召回的是"胡杨林一片金黄""金黄色葡萄球菌"。
const isSearchableAttr = isAttrNoun;

export async function handleCheck(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('请求体格式错误', 400, 'BAD_REQUEST', request);
  }

  const { text, context, mode = 'query', claimOffset = 0 } = body;
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
    const data = await runCheck(text, context, env, apiKey, { autoDraft: true, mode, claimOffset });
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

/**
 * 纠错文本净化（prompt 之外的第二道闸门）。
 * 实测模型仍会把「证据没有具体提到 X」写成 correction —— 那不是断言有误，
 * 只是**没有证据**。留着它等于向用户暗示断言有问题，必须丢弃。
 * 只保留能说出**具体冲突点**的纠错（时间/数值/归属/因果对不上）。
 */
const NO_MENTION_RE = /但(?:是)?(?:也|并)?(?:没有|未|不曾)(?:具体)?(?:提到|提及|说明|给出|记载|涉及)|证据(?:中|里)?(?:并|也)?(?:没有|未)(?:具体)?(?:提到|提及|说明|涉及)|未能?(?:明确)?找到(?:相关)?(?:证据|资料)|(?:断言|证据)(?:中|里)?(?:未|没有)(?:明确)?(?:说明|提及)/;
export function sanitizeCorrection(c) {
  const s = String(c || '').trim();
  if (!s) return '';
  if (NO_MENTION_RE.test(s)) return '';
  return s;
}

// 数据句单位：货币/百分比（经济）+ 度量衡（自然）
// 属性识别/拆句/测量值指纹统一走 attrClassify（检索侧与入库侧共用同一份口径）
const DATA_CN_RE = new RegExp('[^。；;\\n]*\\d[\\d.,，\\-－—~～]*\\s*' + CN_UNIT + '[^。；;\\n]*[。；;\\n]', 'g');
const DATA_EN_RE = new RegExp('[^.\\n]*\\d[\\d.,\\-–—~]*\\s*(?:' + EN_UNIT + ')\\b[^.\\n]*[.\\n]', 'gi');

/**
 * 把检索结果（维基 + 官方站）中的数据句解析成百科卡片（属性→数值→来源）
 * 官方来源（gov-direct / ★官方）优先
 */
/**
 * 诗句/引文断言确定性补抽（verify 模式）。
 * LLM 抽取对引文原句不稳（时抽时不抽），没有诗句断言逐句核对就没有对象。
 * 规则：引号内 ≥12 字的文本视为引文 → 按 [。！？；] 切联（逗号连接的分句算同一联，
 * 与逐句验票的粒度一致）→ 每联去空白后 ≥6 字 → LLM 已覆盖（claim 互相包含）则跳过。
 * entity 取引文前的《作品名》，keywords 取 (作者)，searchHint 用"作品名+联原文"
 * ——原句检索对诗词收录页召回最好（整段核查同款思路）。
 */
function appendQuoteClaims(text, claims) {
  const s = String(text || '');
  const out = Array.isArray(claims) ? [...claims] : [];
  const norm = (x) => String(x || '').replace(/[\s，。；、·,.;:"'"“”()（）]/g, '');
  try {
    const titleM = s.match(/《([^》]{2,20})》/);
    const authorM = s.match(/[(（]([^）)]{2,8})[）)]/);
    const title = titleM ? titleM[1] : '';
    const author = authorM ? authorM[1] : '';
    const qRe = /["“][^"”]{12,}["”]/g;
    let qm;
    while ((qm = qRe.exec(s)) !== null) {
      const quote = qm[0].slice(1, -1);
      for (const clauseRaw of quote.split(/[。！？；]/)) {
        const clause = clauseRaw.replace(/\s+/g, '').replace(/^[，,、]+|[，,、]+$/g, '');
        if (clause.length < 6) continue;
        const covered = out.some(c => {
          const cc = norm(c.claim);
          const nn = norm(clause);
          return !cc || !nn || cc.includes(nn) || nn.includes(cc);
        });
        if (covered) continue;
        out.push({
          claim: clause,
          entity: title || clause.slice(0, 6),
          metric: '原文',
          keywords: author,
          searchHint: title ? `${title} ${clause.slice(0, 10)}` : clause.slice(0, 14),
          time: '',
          quoteClaim: true,
        });
      }
    }
  } catch { /* 补抽失败保持原 claims */ }
  return out;
}

function buildFactCard(results, entity, queryText = '', hint = '') {
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
    // 摘要先做繁→简归一：维基正文是繁体，"釐米/公噸"不归一，
    // 下面的简体单位正则永远匹配不到 → 肩高等数据句整句漏抽。
    const snip = normZh(r.snippet || '')
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

    // 数据判据（数字+单位）：中文按 CN_UNIT，英文按计量单位词
    const dataRe = makeDataRe(isEn);
    for (let s0 of sentences) {
      const s = s0.replace(/\s+/g, ' ').trim();
      if (s.length < 8 || s.length > 160) continue;
      // 跳过网页页脚/备案/导航噪音，以及纯标题（无句读且过短的导航词）
      if (/版权所有|ICP备|公网安备|网站标识码|中文域名|京公网|备案|Copyright|cookie|隐私权|网站地图|首页|上一篇|下一篇|点击下载|字体大小|分享到/.test(s)) continue;
      if (!dataRe.test(s)) continue;
      // 多指标长句 → 拆成单指标子句，避免其它指标的数据被整句的归类埋掉（详见 splitMultiAttrClauses）
      for (const clause of splitMultiAttrClauses(s, dataRe)) {
        const prop = classifyProp(clause) || '相关数据';
        // 含目标年份的句子加权排前
        const yearHit = wantYear && clause.includes(wantYear);
        facts.push({ property: prop, value: clause, source, yearHit, official: source.official });
      }
    }
  }

  // 排序：官方优先 → hint 属性命中优先 → 含目标年份优先。
  // hint 加权必须在 12 条截断**之前**：带属性查询时（"大熊猫 身高"）无关的
  // "相关数据"句（栖息地/游客量…）会把肩高句挤出前 12，随后 hint 过滤
  // 就只剩空卡（实测 12 条无一含身高/肩高）。外层的 hint 过滤保留作双保险。
  const hintKeys = hint
    ? attrWordsOf(queryText, hint).flatMap(w => [w, ...(ATTR_SYNONYMS[w] || [])])
    : [];
  const hintHit = (f) => hintKeys.some(k => String(f.property || '').includes(k) || String(f.value || '').includes(k));
  facts.sort((a, b) => (b.official ? 1 : 0) - (a.official ? 1 : 0)
    || (hintHit(b) ? 1 : 0) - (hintHit(a) ? 1 : 0)
    || (b.yearHit ? 1 : 0) - (a.yearHit ? 1 : 0));

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
// 给"来源列表"逐项打上来源档位（textbook/tutoring/ugc/other）。
// 前端据此把教辅/题库/文库站标注为"参考"——用户口径：教辅材料不是教育局发布的课本，
// 它可以出现在结果里，但不能让人误以为那是权威依据。
function sourcesWithTier(arr) {
  return (arr || []).map(r => (r && r.url ? { ...r, tier: sourceTier(r.url) } : r));
}

export async function runCheck(text, context, env, apiKey, { autoDraft = false, mode = 'query', maxClaims = MAX_CLAIMS, skipSearchFallback = false, claimOffset = 0 } = {}) {
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
  // 检索词扩展：属性词带上近义词，否则搜索引擎召回不到真正的数据页
  //（实测"大熊猫 身高"召回不到《大熊猫的外形特征》，"大熊猫 身高 肩高 体长"则第一页就有）
  let searchQuery = (llmParse && llmParse.searchQuery) || (entity ? (hint ? `${entity} ${hint}` : entity) : text.trim());
  if (hint) searchQuery = expandQueryWithAttrSynonyms(searchQuery, hint);

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
      // apiKey 透传下去：标签没匹配上时让大模型从词条事实里挑（只挑序号，不生成内容）。
      wholeKbHit = await lookupKBForClaim(env, { claim: text, entity: entity || text }, entity, hint, { loose: true, apiKey });
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

  const tStart = Date.now();
  let tSearchDone = 0;
  let tLlmDone = 0;
  let searchResults = null;
  // 记录本次实际使用的检索缓存键：查询若最终"无结果"，用它删掉那份坏缓存（见下方自愈）
  let usedSearchCacheKey = null;
  // 官方站检索（Tavily site:gov.cn）与主检索**并行**发起：两者互不依赖，
  // 串行会让总耗时叠加 ~5s（实测冷查询 16-18s → 并行后明显下降）。
  // 官方结果照旧不缓存（避免限流空结果被固化），在主检索之后再合并。
  const govPromise = (intent === 'query')
    ? searchGovDirect(entity || searchQuery, { apiKey: env.TAVILY_KEY }).catch(() => [])
    : Promise.resolve([]);
  try {
    const cacheK = searchCacheKey(searchQuery + '|card');
    usedSearchCacheKey = cacheK;
    const cached = await cacheGet(env.FACT_CACHE, cacheK);
    if (cached) {
      searchResults = cached;
    } else {
      // 属性查询：与主检索**并行**发起一轮 Tavily 补齐检索（basic 深度，快）。
      // 搜索引擎摘要常缺属性数据（实测"金丝猴 体重"7 条结果无一含体重），
      // 这轮负责把真正的数据段落捞回来；并行发起避免把耗时叠加成串行。
      const attrQuery = hint ? expandQueryWithAttrSynonyms(`${entity || ''} ${hint}`.trim(), hint) : '';
      const [raw, attrExtra] = await Promise.all([
        braveSearch({ query: searchQuery, preferOfficial: true, topK: 8, whitelist, hint, tavilyApiKey: env.TAVILY_KEY, serperApiKey: env.SERPER_KEY }),
        (attrQuery && env.TAVILY_KEY)
          ? tavilySearch(attrQuery, { apiKey: env.TAVILY_KEY, topK: 6, searchDepth: 'basic' })
              .catch(() => ({ results: [], answer: '' }))
          : Promise.resolve(null),
      ]);
      searchResults = annotateResults(raw, env);
      if (attrExtra) {
        const seen = new Set((searchResults || []).map(r => r.url));
        const fresh = (attrExtra.results || []).filter(r => r.url && !seen.has(r.url));
        if (fresh.length) {
          searchResults = [...searchResults, ...annotateResults(fresh, env)];
          searchQuery = attrQuery; // 诚实记录实际使用了扩展检索词
        }
        // Tavily 综合答案：多来源结论压缩成一段，作为首条证据
        if (attrExtra.answer) {
          searchResults = [{
            title: '检索引擎综合答案',
            url: 'https://app.tavily.com/',
            snippet: attrExtra.answer,
            source: 'tavily',
            official_tag: false,
            official_score: 0.5,
          }, ...searchResults];
        }
      }
      // 如果 Wikipedia/Bing/Tavily 返回的结果全被过滤或为空，用 Tavily 兜底
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

  // 查询模式合并官方站结果（与主检索并行取回，这里只等结果）
  if (intent === 'query') {
    try {
      const govRaw = await govPromise;
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
    tSearchDone = Date.now();
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

    const factCard = buildFactCard(searchResults, entity || text.trim(), text, hint);

    // 带属性词的查询：把数据卡过滤到只留与属性相关的数据句。
    // 否则问"大熊猫 身高"，卡片里塞满脑容量/排便等无关句——观感即"答非所问"，
    // 且用户点手动入库会把无关句存进词条。
    // 近义表统一用模块级 ATTR_SYNONYMS（与检索扩展、KB 匹配同一份，避免三处口径漂移）。
    // 多属性查询（"体重 身高"）用**全部属性词的并集**过滤——只认第一个属性词会把
    // 其它属性的数据句全部滤掉，表现为"直接解答有数据、结构化数据卡为空"。
    if (hint) {
      const attrWords = attrWordsOf(text, hint);
      const keys = attrWords.flatMap(w => [w, ...(ATTR_SYNONYMS[w] || [])]);
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
        tLlmDone = Date.now();
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
    // 事实构造**统一走 attrClassify.storeFactOf**（与查证链路同一构造器，用户要求两条
    // 链路的入库标准完全一致）：
    //   label = 事实**自身**的属性名（classifyProp 规范名，如 体长/肩高/体重），
    //   value = 数据**原文句**（factCard 正则抽出来的那句，不是模型生成的结论），
    //   source = 可引用的真实页面。
    // 不再一律贴查询属性词 hint——后者会把"体长"数据贴上"体重"标签，
    // 之后查"体长"就命中不了知识库，只能重新检索再把同一批数据入库（用户实测：
    // 大熊猫词条出现两条体长事实）。问"身高"时命中"肩高"事实由 ATTR_SYNONYMS 在查询侧兜住。
    // 入库前剔除"无真实出处"的事实：检索引擎综合答案（url 指向聚合器而非原页面）
    // 只能当证据看，不能当知识库事实的来源——否则等于把一段模型生成的文字
    // 当成"有出处的事实"存进库里。
    // 每条事实的 rating 取自本次答案的可信度（高→high/中→medium/低→low），
    // 这样"是否自动入库"完全由共用的 autoAudit 第③关（每条必须 high）决定，
    // 与查证链路同一口径，不再有"查询靠 confidence、查证靠 overall"两套判据。
    const factRating = confidence === '高' ? 'high' : (confidence === '低' ? 'low' : 'medium');
    // 统一补 key/time 两个字段，使查询链路与查证链路产出的事实**逐字段同形**
    // （否则"两条链路标准一致"只在核心字段上成立，辅助字段仍有差异）。
    // 一条数据句含多个属性子句时 storeFactsOf 会拆成多条，各自贴自身属性标签。
    const draftFacts = [];
    let fIdx = 0;
    const pushFacts = (o) => {
      for (const f of storeFactsOf(o)) draftFacts.push({ key: `fact_${fIdx++}`, ...f, time: '' });
    };
    if (factCard.facts.length > 0) {
      for (const f of factCard.facts) {
        if (!isCitableSource(f.source)) continue;
        pushFacts({
          property: f.property,
          metric: hint,
          entity: entity || text.trim(),
          value: f.value || '',           // 正则抽出的数据原文句，直接用
          source: {
            name: f.source?.name || '',
            url: f.source?.url || '',
            official_tag: f.source?.official || false,
            official_score: f.source?.official ? 0.9 : 0.5,
          },
          rating: factRating,
        });
      }
    } else if (answer && confidence === '高' && Array.isArray(searchResults) && searchResults.length > 0) {
      // 正则没抽出数据句、但 LLM 高可信：**不把 LLM 的答案文本当事实存**
      // （那是模型生成的表述，可能夹带推断）。改为从最优可引用来源的原文摘要里
      // 挑一句数据原文——与查证链路完全同一条路径。
      // strict：摘要里若根本没有与属性相关的数据句，就**放弃入库**，不要退回首句——
      // 实测"大熊猫 体长 体重"会把"概括起来，孑遗生物一定是「活化石」…"当体重事实存进去。
      const src = bestCitableSource(searchResults);
      const hit = src ? (searchResults.find(r => r && r.url === src.url) || {}) : null;
      const evi = hit ? String(hit.snippet || hit.summary || '').trim() : '';
      if (src && evi) {
        pushFacts({ metric: hint, entity: entity || text.trim(), evidence: evi, source: src, rating: 'high', strict: true });
      }
    }

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
      // 与查证链路同一个入库函数、同一套门槛（autoAudit 四关，含"每条 rating 必须 high"）
      const sr = await autoStoreCard(env, queryDraftCard);
      queryAutoStored = sr.stored;
    }

    // 自愈：拿到证据却得出"没结果"（低置信 + 零事实点）→ 删掉这次的检索缓存。
    // 检索源时好时坏，某次抖动返回的无关结果集若被缓存，同一次提问在 TTL 内
    // 会一直得到"未检索到"（实测"雪豹 体长"缓存里就是一份坏结果，而"雪豹 身长"
    // 走新检索立刻出正确数据）。删掉后用户再问一次即可重新检索。
    if (usedSearchCacheKey && confidence === '低' && factCard.facts.length === 0) {
      try { await cacheDelete(env.FACT_CACHE, usedSearchCacheKey); } catch {}
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
      // 耗时拆解（诊断用）：检索 vs LLM 各占多少，避免再靠猜
      timing: {
        search_ms: tSearchDone ? (tSearchDone - tStart) : null,
        llm_ms: tLlmDone ? (tLlmDone - tSearchDone) : null,
        total_ms: Date.now() - tStart,
      },
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

  // 诗句/引文断言**确定性补抽**：LLM 抽取对引文原句不稳（实测《浪淘沙·其六》
  // 混合文本只抽出"作者"元信息，诗句一句不抽）——没有诗句断言，逐句核对
  // 就没有对象，诗词语料站的"原文一致"采信通道永远不触发。
  // 程序化从原文引号内识别引文、按句读切联，LLM 已覆盖的（claim 文本重叠）跳过。
  if (mode === 'verify' && Array.isArray(claims)) {
    const before = claims.length;
    claims = appendQuoteClaims(text, claims);
    if (claims.length > before) {
      try { await cacheSet(env.FACT_CACHE, claimsK, claims, CLAIMS_TTL); } catch {}
    }
  }

  if (!Array.isArray(claims) || claims.length === 0) {
    return { claims: [], searches: [], ratings: [], rating: 'unknown', corrections: [], draftCard: null };
  }

  // 1.5 整段原文核查（整段优先；用户要求："既然整段是教材原文，就先整段查——查到就
  //     整段按'高'采信直接入库，查不到再逐点查"）。
  //
  // 为什么整段优先是对的：被核查的往往是**教材原文/成段引文**，这类文字通常被
  // "答案站/教育站"整段收录。整段检索一次即可拿到权威出处（探针实测：整段原句
  // 能召到原文页面，而拆成"实体+关键词"的短词反而召回一堆同话题噪音论文）。
  // 命中即整段采信：省掉逐点评级那一轮 LLM（主要耗时），也避免"证据与断言各说各话"
  // 造成的误判。整段召不回（改写过的段落、太长、冷门）→ 照旧逐点检索+评级。
  let wholeMatch = null;   // 权威来源命中 {url,title,snippet,coverage,overlap,domain}
  let referenceMatch = null; // 非权威（教辅/题库/文库）命中：**只作参考出处展示**，不判高、不入库
  let wholeResults = [];   // 含命中页的整段检索结果（命中页打 quote_match 标记）
  // 注意：不再要求 env.TAVILY_KEY——Tavily 无 Key 时会走 keyless（见 brave.js 两级降级），
  // 以前这个前置条件会让"没配 Key 的部署"直接跳过整段核查。
  if (mode === 'verify' && !skipSearchFallback) {
    const ptext = String(text || '').replace(/\s+/g, ' ').trim();
    // 太短信息量不足、太长（文章级）整段检索召不回原文，两种情况都不做整段核查
    if (ptext.length >= 20 && ptext.length <= 400) {
      // 多形态整段检索：原文 + 去中文引号（引号会让部分检索引擎把整串当短语匹配，
      // 召回集明显变窄）。两种形态并行，结果合并去重。
      // ⚠️ 必须走缓存：整段检索是每请求固定成本（2 形态 × advanced = 4 credits，
      // 而免费额度只有 1000 credits/月）。同一段文字重复核查（多人核对同一份稿子）
      // 是常态，命中缓存则 0 消耗；缓存只存"检索结果"，覆盖率判定每次重算。
      const bare = ptext.replace(/[“”"‘’]/g, '');
      const variants = Array.from(new Set([ptext, bare])).filter(s => s.length >= 20);
      const wholeCacheK = searchCacheKey(`整段:${ptext}`);
      let merged = null;
      try {
        const cachedWhole = await cacheGet(env.FACT_CACHE, wholeCacheK);
        if (Array.isArray(cachedWhole) && cachedWhole.length > 0) merged = cachedWhole;
      } catch { /* 缓存不可用时照常检索 */ }
      try {
        if (!merged) {
          // alwaysTavily：整段检索必须查 Tavily。教材原页不在维基上，而维基对长句
          // 匹配不上时会返回模糊噪音（实测返回《盐酸》《锑》《钛》）——若允许"维基命中
          // 就短路"，噪音会把 Tavily 挡在门外，整段直配就永远不会命中。
          const lists = await Promise.all(variants.map(q => braveSearch({
            query: q,
            preferOfficial: false,
            topK: 6,
            tavilyApiKey: env.TAVILY_KEY, serperApiKey: env.SERPER_KEY,
            diversify: true,
            tavilyDepth: 'advanced',
            alwaysTavily: true,
          }).catch(() => [])));
          const acc = [];
          const seenUrl = new Set();
          for (const list of lists) {
            for (const r of (Array.isArray(list) ? list : [])) {
              if (r?.url && !seenUrl.has(r.url)) { seenUrl.add(r.url); acc.push(r); }
            }
          }
          merged = acc;
          if (acc.length > 0) {
            try { await cacheSet(env.FACT_CACHE, wholeCacheK, acc, SEARCH_TTL); } catch { /* 写不进也无妨 */ }
          }
        }
        const annot = annotateResults(merged, env);
        // 用户生成内容站（博客/问答/论坛）上出现同一段文字，只能说明"有人转载过"，
        // 不能作为"这段文字有权威出处"的依据 → 不参与整段直配。
        const UGC_HOST_RE = /zhidao\.baidu\.com|zhihu\.com|blog\.|bbs\.|forum|csdn\.net|jianshu\.com|douban\.com|sohu\.com|toutiao\.com|baijiahao/i;
        let best = null;
        for (const r of annot) {
          if (!r?.url || !isCitableSource(r)) continue;
          if (UGC_HOST_RE.test(r.url)) continue;
          const page = `${r.title || ''} ${r.snippet || ''}`;
          // 两个方向都算"整段直配"：
          //  ① 正算：整段有多少落在页面里（页面把整段都收录了）
          //  ② 反算：页面摘要有多少出自整段（摘要被截断、只收录了其中一段的情形）
          const q = quoteCoverage(ptext, page);
          const rev = quoteCoverage(page, ptext);
          const fwd = q.coverage >= QUOTE_MATCH_MIN && q.overlap >= QUOTE_MATCH_MIN_OVERLAP;
          const back = rev.coverage >= 0.65 && rev.overlap >= QUOTE_MATCH_MIN_OVERLAP;
          if (!fwd && !back) continue;
          const score = Math.max(q.coverage, rev.coverage);
          if (!best || score > best.score) {
            best = {
              url: r.url,
              title: r.title || '',
              snippet: r.snippet || '',
              coverage: score,
              overlap: Math.max(q.overlap, rev.overlap),
              score,
            };
          }
        }
        if (best) {
          try { best.domain = new URL(best.url).hostname.replace(/^www\./, ''); } catch { best.domain = ''; }
          // ⚠️ 分档处置（用户 2026-09-16 口径）：**教辅材料不等于课本**。
          // 只有权威课本/官方教育来源（政府·教育机构域名、官方出版社/教育平台）
          // 才配享有"整段原文采信"——判"高"并允许自动入库。
          // 教辅/题库/答案/文库站（零五网、菁优网…）整段收录同一段文字，只能说明
          // "某本教辅收录过它"，**不能**证明"它出自教育局/出版社发布的课本"，
          // 故只作**参考出处**展示（referenceMatch），既不判"高"、也不自动入库。
          const tier = sourceTier(best.url);
          best.tier = tier;
          if (isAuthoritativeTextSource(best.url)) {
            // 命中页打"原文直配"标记：入库门槛①（kbStore.autoAudit）认它，
            // bestCitableSource 也优先选它作为事实出处。
            for (const r of annot) {
              if (r.url === best.url) { r.quote_match = true; r.quote_coverage = best.coverage; }
            }
            wholeMatch = best;
            wholeResults = annot;
          } else {
            best.referenceOnly = true;
            // 诗词语料站（古诗文网/诗词库/维基文库…）的整段命中：引文断言走
            // "原文一致性"核对（逐句验票命中即判高），不适用"教辅≠课本"的压制——
            // 诗词不是课本发布的文本，收录页逐字重现即是核对通过。
            // 仅判高不自动入库（autoAudit 的官方来源关不会放行，保守起见）。
            best.poetryCorpus = isPoetryCorpusSite(best.url);
            referenceMatch = best;
            // 诗词语料通道的引文断言要带整段检索结果当来源展示（sources）
            if (best.poetryCorpus) wholeResults = annot;
          }
        }
      } catch { /* 整段检索失败 → 照旧逐点核查 */ }
    }
  }

  // 2. 对每条断言检索证据（逐点覆盖：不再截断到 5 条；限并发避免打爆检索源）
  //    知识库优先：先按断言（及其实体）查 KB，命中则直接采用，不再走全网检索。
  //    子请求预算（Cloudflare 免费版单次调用上限 50，主流程已用 ~20）：
  //    独立检索每条最坏 4 轮 ≈16 个子请求，预算归零后断言改走"主检索复用"
  //    轻量路径（不独立检索，拿主检索结果按相关性过滤后评级），保证每条断言都有结果。
  let claimBudgetLeft = CLAIM_SEARCH_BUDGET;
  // 分批续查：claimOffset 由前端携带（自动续查后续批），跳过已核查的前 N 条。
  const claimsTotal = claims.length;
  const batch = claims.slice(claimOffset, claimOffset + maxClaims);
  const checkSearches = await mapLimit(
    batch, 4, async (c) => {
      const entity2 = (c.entity && c.entity.trim()) ? c.entity.trim() : '';
      // 整段原文已直配（wholeMatch）→ 不再逐点检索：直接沿用整段命中结果当证据。
      // ⚠️ 但要**逐句验票**：整段覆盖率高不代表每一句都被命中页收录——实测改写过的一句
      // （"点燃,火焰呈淡蓝色"）跟着整段一起被判"高"，而命中页里根本没有这句话。
      // 只有本断言自身也出现在命中页里（覆盖率 ≥0.6 且重合 ≥6 个二元组）才能搭这趟车；
      // 否则该断言照旧走下面的逐点检索 + 评级。
      // 诗词语料站的 referenceMatch 同样参与验票：引文断言（诗句本身）在收录页
      // 逐字重现 → 按"原文一致"采信（判高）。现代说明句不会在诗词语料页重现，
      // 验票天然不通过、照旧逐点评级——分流安全。
      const segMatch = wholeMatch || (referenceMatch && referenceMatch.poetryCorpus ? referenceMatch : null);
      if (segMatch) {
        const inPage = (() => {
          const t = String(c.claim || '').replace(/[“”"]/g, '');
          if (!t) return false;
          const q = quoteCoverage(t, `${segMatch.title || ''} ${segMatch.snippet || ''}`);
          return q.overlap >= 6 && q.coverage >= 0.6;
        })();
        if (inPage) {
          // 仍先查一次 KB：库里已有该断言的事实时标记 fromKB，避免重复入库
          // （mergeEntry 虽能去重，但 fromKB 能让前端显示"命中知识库"而不是"可手动入库"）。
          let kb = null;
          try { kb = await lookupKBForClaim(env, c, entity2); } catch { kb = null; }
          if (kb) return { claim: c, query: buildSearchQuery(c), results: kb.results, kb: kb.info, fromKB: true, wholeMatch: true };
          return {
            claim: c,
            query: `【${segMatch === wholeMatch ? '整段原文直配' : '原文一致·诗词语料'}】${segMatch.title || segMatch.domain}`,
            results: wholeResults,
            wholeMatch: true,
            // 评级环节展示命中页信息与挑证据句用（诗词语料通道下闭包 wholeMatch 为 null）
            segInfo: { url: segMatch.url, title: segMatch.title, domain: segMatch.domain, coverage: segMatch.coverage, via: segMatch === wholeMatch ? 'textbook' : 'poetry' },
            segSnippet: segMatch.snippet,
            fromKB: false,
          };
        }
      }
      // ---- 子请求预算闸门（必须在 KB 查/诗句比对/独立检索**之前**）----
      // KB 查（2~4 个 KV get）、检索、评级都占 Cloudflare 免费版 50 上限，
      // 闸门放晚了这些消耗已花掉（实测第 5、6 条断言评级因此爆 1102）。
      // 归零后断言不独立检索，复用主检索结果照常评级，保证每条都有结果。
      if (claimBudgetLeft <= 0) {
        const reused = (entity2 || c.claim || '')
          ? filterRelevant(Array.isArray(searchResults) ? searchResults : [], entity2 || c.claim, { strictName: true, claimText: c.claim }).slice(0, 6)
          : (Array.isArray(searchResults) ? searchResults.slice(0, 6) : []);
        return {
          claim: c, query: `【额度受限·复用主检索】${(buildSearchQuery(c) || '').slice(0, 30)}`,
          results: reused, fromKB: false, budgetCapped: true,
        };
      }
      claimBudgetLeft -= CLAIM_BUDGET_COST;

      // ---- 诗句原文断言：针对性原文比对（不依赖整段命中）----
      // 整段检索时好时坏（本轮未命中时诗句断言会落回通用 LLM 评级——证据匹配难，
      // 实测"淘金女伴满江隈"被评低）。诗句断言的正确核查方式就是原文比对：
      // 用"作品名+诗句"检索收录页，断言句在页面标题/摘要中覆盖率达标即"原文一致"。
      // 消耗 1 次检索，诗句断言通常 2-4 条，量可控。
      if ((c.metric === '原文' || c.quoteClaim) && (env.TAVILY_KEY || env.SERPER_KEY)) {
        try {
          const claimText = String(c.claim || '').trim();
          if (claimText.length >= 6) {
            // 先查 KB：库里已有这句诗 → 直接以知识库作答（fromKB），
            // 否则已入库诗句再查会走入库显示 auto（应显示"知识库已有"）。
            let vkb = null;
            try { vkb = await lookupKBForClaim(env, c, entity2); } catch { vkb = null; }
            if (vkb) {
              return { claim: c, query: buildSearchQuery(c), results: vkb.results, kb: vkb.info, fromKB: true };
            }
            claimBudgetLeft -= 2; // 诗句比对：1~2 次检索（Tavily→Serper 兜底），计入预算
            const vq = (c.searchHint && c.searchHint.trim()) || `${entity2 || ''} ${claimText}`.trim();
            let vres = [];
            if (env.TAVILY_KEY) {
              const tv = await tavilySearch(vq, { apiKey: env.TAVILY_KEY, topK: 4, searchDepth: 'basic' });
              vres = (tv.results || []).filter(r => r && r.url && r.snippet);
            }
            if (!vres.length && env.SERPER_KEY) {
              const sp = await serperSearch(vq, { apiKey: env.SERPER_KEY, topK: 4 });
              vres = (sp.results || []).filter(r => r && r.url && r.snippet);
            }
            for (const r of vres) {
              const qc = quoteCoverage(claimText, `${r.title || ''} ${r.snippet || ''}`);
              if (qc.overlap >= 6 && qc.coverage >= 0.6) {
                let vdomain = '';
                try { vdomain = new URL(r.url).hostname.replace(/^www\./, ''); } catch {}
                return {
                  claim: c,
                  query: `【原文比对】${(r.title || vdomain).slice(0, 30)}`,
                  results: annotateResults(vres, env),
                  wholeMatch: true,
                  segInfo: { url: r.url, title: r.title, domain: vdomain, coverage: Number(qc.coverage.toFixed(2)), via: 'poetry' },
                  segSnippet: r.snippet,
                  fromKB: false,
                };
              }
            }
          }
        } catch { /* 比对失败落回常规逐点 */ }
      }
      const metricRaw = (c.metric && c.metric.trim()) ? c.metric.trim() : '';
      // hint 仅传属性名（维基深度抽取用），数值不当 hint；
      // 非属性名词（如"金黄""柔软"）也不传——维基会拿它去正文里找数据句，
      // 找不到反而把导言里真正相关的一句挤掉
      const hint2 = isSearchableAttr(metricRaw) ? metricRaw : '';
      // 检索词优先用抽取 LLM 给的**现代名称改写句**（searchHint）：
      // 历史术语按字面检索只能召回"同话题噪音"（"可燃空气 水雾"召回细水雾灭火论文、
      // "可燃空气 空气 铁制容器"召回爆轰研究），改写句（"氢气在空气中燃烧生成水雾"）
      // 才能召回维基《氫氣》与化学实验页面——探针实测，两者召回质量天差地别。
      // 改写句只当检索词用：评级的对象始终是原断言，语义不会漂移。
      // 断言不含历史术语时抽取侧留空，此时照旧用 buildSearchQuery(整句/实体+关键词)。
      const sqHint = (typeof c.searchHint === 'string') ? c.searchHint.trim() : '';
      // 改写句必须保留**专名主体**：实测某条断言的 hint 写成"锌与稀硫酸反应生成氢气"，
      // 丢了人名"普里斯特利" → 维基只召回《硫酸》《酸》《锶》这类字面噪音，
      // 评级环节便拿这些噪音编出"主体应为卡文迪什"的假纠错。
      // 兜底：hint 里没有实体时把实体补在前面；但**历史术语/旧称不补**——
      // 它们的现代名称已经在 hint 里，补回去反而召回爆轰/消防等同话题噪音。
      const HIST_TERM = /^(可燃空气|易燃空气|可燃性空气|脱燃素空气|固定空气|燃素|活命空气)$/;
      const sqHintFull = (sqHint && entity2 && !sqHint.includes(entity2) && !HIST_TERM.test(entity2))
        ? `${entity2} ${sqHint}`
        : sqHint;
      const sq = sqHintFull.length >= 6 ? sqHintFull : buildSearchQuery(c);

      // ---- 知识库优先 ----
      const kb = await lookupKBForClaim(env, c, entity2);
      if (kb) {
        return { claim: c, query: sq, results: kb.results, kb: kb.info, fromKB: true };
      }

      const cacheK = searchCacheKey(sq);
      const cached = await cacheGet(env.FACT_CACHE, cacheK);
      // 注意：只复用"有结果"的缓存。空结果不入缓存，
      // 否则一次检索失败会被缓存 30 天，后续请求永远拿不到兜底机会。
      // 同时校验相关性：早期写入的无关结果集（单字实体过滤缺失所致）直接作废。
      if (cached && Array.isArray(cached) && cached.length > 0) {
        const cacheOk = !entity2 || filterRelevant(cached, entity2, { strictName: true, claimText: c.claim }).length > 0;
        if (cacheOk) {
          return { claim: c, query: sq, results: cached, cached: true, fromKB: false };
        }
        try { await cacheDelete(env.FACT_CACHE, cacheK); } catch { /* 删不掉也无妨 */ }
      }

      try {
        // 必须传 tavilyApiKey：braveSearch 在维基命中时会短路，结果常清一色
        // zh.wikipedia.org。diversifyDomains 需要 Tavily 才能补出第二个域名，
        // 否则自动入库门槛②（≥2 域名）永远过不了。
        let raw = await braveSearch({ query: sq, preferOfficial: true, topK: 6, whitelist, hint: hint2, tavilyApiKey: env.TAVILY_KEY, serperApiKey: env.SERPER_KEY, diversify: !skipSearchFallback, tavilyDepth: 'advanced' });
        // 以下兜底会额外消耗子请求额度（Cloudflare 单次调用上限 50）。
        // 古文查证等复合流程调用时置 skipSearchFallback，避免超限整体失败。
        if (!skipSearchFallback) {
          // 检索结果与实体完全不相关 → 强制全网兜底一次
          if (entity2 && raw.length > 0) {
            const relevant = filterRelevant(raw, entity2, { strictName: true, claimText: c.claim });
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
          // 弱结果补一轮：主检索词（整句断言）召不回 **2 条**以上相关结果时，
          // 用「实体 + 辨识性关键词」再搜一次并并入（主结果在前，地位不变）。
          // 两种检索词互补：整句擅长召回"讨论这件事"的页面，但对历史术语
          // （"可燃空气"）的字面召回差；keywords 里有抽取 LLM 给的现代名称
          // （氢气/爆鸣/水雾），能直接召回维基《氫氣》《爆鸣气》——正是这类
          // 权威词条里的"与空气混合点燃发出爆鸣声、燃烧生成水"能把断言撑到"高"。
          // 深度也互补：主搜 advanced（语义好但对术语字面召回方差大），
          // 补搜 basic（实测同一主题 basic 与 advanced 的召回集差异很大）。
          const kwList = String(c.keywords || '').split(/[\s、,，+/／]+/).map(s => s.trim())
            .filter(s => s && s !== entity2 && !entity2.includes(s) && !/\d/.test(s))
            .slice(0, 2);
          const sq2 = (entity2 && kwList.length) ? `${entity2} ${kwList.join(' ')}` : '';
          if (sq2 && sq2 !== sq) {
            const relNow = entity2
              ? filterRelevant(raw, entity2, { strictName: true, claimText: c.claim })
              : raw;
            if (relNow.length < 2) {
              try {
                const raw2 = await braveSearch({ query: sq2, preferOfficial: true, topK: 5, whitelist, hint: hint2, tavilyApiKey: env.TAVILY_KEY, serperApiKey: env.SERPER_KEY, diversify: false, tavilyDepth: 'basic' });
                const seen = new Set(raw.map(r => r.url));
                for (const r of raw2) {
                  if (r?.url && !seen.has(r.url)) { raw.push(r); seen.add(r.url); }
                }
              } catch { /* 忽略 */ }
            }
          }
        }
        const annotated = annotateResults(raw, env);
        // 检索到的结果全与实体无关（实测"金 金黄"→《Bao Zheng》、
        // "浪淘沙·其六 作者"→台湾小说《浪淘沙》）→ 不写缓存：
        // 这种结果集一旦入库会被固化一整天，之后同问永远拿不到兜底机会。
        // 结果照常返回给右侧"检索结果"面板（对用户透明），但评级链路会
        // 在相关性闸门处判为"查无实据"，不会拿它当证据编纠错。
        const stillIrrelevant = entity2 && annotated.length > 0
          && filterRelevant(annotated, entity2, { strictName: true, claimText: c.claim }).length === 0;
        if (annotated.length > 0 && !stillIrrelevant) {
          await cacheSet(env.FACT_CACHE, cacheK, annotated, SEARCH_TTL);
        }
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
    // ---- 整段原文直配：这整段文字已在某个可引用页面上逐字重现（覆盖率达标）----
    // 用户明确要求："查到就整段按高采信、直接入库" —— 不再逐点喂 LLM 评级：
    // ① 逐点评级的输入（同话题噪音论文）常常不如"整段命中页"这个事实本身有力；
    // ② 省掉最耗时的一轮 LLM。
    // 证据仍取**原文句**（不生成任何文字）：从命中页里挑与本断言最贴近的一句；
    // 挑不出（摘要被截断）就留空 → 该断言不产生事实（宁可少存，不可存错）。
    if (sr.wholeMatch) {
      const evText = sr.fromKB
        ? (sr.kb?.facts || []).slice(0, 2).map(f => `${f.label || ''}：${f.value || ''}`).join('；')
        : pickFactSentence(String(sr.segSnippet || ''), {
            metric: sr.claim?.metric || '',
            anchor: sr.claim?.claim || '',
            requireAnchor: true,
          });
      return {
        claim: sr.claim,
        rating: 'high',
        evidence: evText,
        correction: '',
        sources: sourcesWithTier(sr.results),
        fromKB: !!sr.fromKB,
        kbInfo: sr.kb,
        wholeMatch: true,
        wholeMatchInfo: sr.segInfo || (wholeMatch && {
          url: wholeMatch.url, title: wholeMatch.title,
          coverage: Number(wholeMatch.coverage.toFixed(2)), domain: wholeMatch.domain,
        }),
      };
    }
    // 知识库命中的断言：KB 事实作为**证据**走与全网证据同一把尺子（评级 LLM），
    // 不再直接判"高"。label 匹配只能保证"同实体"，保证不了"这条事实支撑这条断言"
    // （实测：词条里"引爆过程"的事实被当成"产生水雾"断言的支撑，评出假"高"）。
    // KB 内容本身经过审核，当证据是安全的；支撑与否交给评级环节判断。
    let relevant;
    let candidates;
    if (sr.fromKB && sr.kb) {
      candidates = sr.results;
      relevant = sr.results; // KB 结果是按实体/标签匹配出来的，直接当证据
    } else {
    if (!sr.results || sr.results.length === 0) {
      return { claim: sr.claim, rating: 'low', evidence: '', correction: '', sources: [], fromKB: false, noRelevantEvidence: true };
    }
    // 相关性闸门：检索来源与断言实体毫不相干时，不能拿它当"证据"去评级。
    // 实测两个典型："金 金黄" 召回《Bao Zheng》（英文维基）、
    // "浪淘沙·其六 作者" 召回台湾作家東方白的小说《浪淘沙》——LLM 会把无关来源
    // 当成"反驳"，编出"《浪淘沙·其六》的作者是刘禹锡，而非东方白"这种荒谬纠错。
    // 无关即视为"查无实据"：不出 correction（前端只显示"未检索到可引用证据"），
    // 同时删掉这份检索缓存，让下次同问重新检索，坏结果不再被缓存固化一整天。
    const relEntity = (sr.claim?.entity || '').trim();
    // strictName：短专名（人名/物名）只认完整实体词，挡住"普里斯特→普里斯特菲尔德球场"式假阳性。
    // claimText：历史术语（"可燃空气"=氢气）按字面匹配必然全灭时的兜底判据。
    // 同实体证据池：同一实体的多条断言（"可燃空气 点燃→爆鸣声"与"→水雾"）检索词不同、
    // 召回互补——把同实体其它断言搜到的结果并入本条的证据候选，由评级 LLM 逐条判断
    // 是否支撑本断言。避免"化学史页面明明检索到过、只是没落在这一条的检索词里"的错杀。
    candidates = sr.results;
    if (relEntity) {
      candidates = [...sr.results];
      const seen = new Set(sr.results.map(r => r.url));
      for (const other of checkSearches) {
        if (other === sr || other.fromKB) continue;
        if ((other.claim?.entity || '').trim() !== relEntity) continue;
        for (const r of other.results || []) {
          if (r?.url && !seen.has(r.url)) { candidates.push(r); seen.add(r.url); }
        }
      }
    }
    relevant = relEntity
      ? filterRelevant(candidates, relEntity, { strictName: true, claimText: sr.claim?.claim })
      : candidates;
    if (relevant.length === 0) {
      try { await cacheDelete(env.FACT_CACHE, searchCacheKey(sr.query)); } catch {}
      return {
        claim: sr.claim,
        rating: 'low',
        evidence: '',
        correction: '',
        sources: [],
        fromKB: false,
        noRelevantEvidence: true,
      };
    }
    }
    // 证据原文完整传给 LLM（用户要求不截取内容）。
    // 提速靠评级缓存：同断言+同证据 → 复用上次评级（确定性计算，结果一致）。
    // 证据缓存 1 天，所以同一查询在证据刷新前评级输入不变，命中率高。
    const evidence = relevant.map(r => ({
      name: r.title,
      snippet: r.snippet,
      url: r.url,
      // 来源档位一并交给评级 LLM：提示词里"高 = 来源为官方/百科/权威机构"这条规则
      // 需要模型自己判断来源性质，而光看站名并不可靠——实测它把教辅答案站
      // （零五网《课时作业本》解析答案）当成权威来源，据此判了"高"。
      // 带上明确档位后，"仅教辅来源"这类证据最高只能给"中"。
      tier: sourceTier(r.url),
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
          correction: sanitizeCorrection(cachedRate.correction),
          sources: sourcesWithTier(candidates),
          fromKB: !!sr.fromKB,
          kbInfo: sr.kb,
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
          const norm = { rating: ratingEn(r.rating), evidence: r.evidence, correction: sanitizeCorrection(r.correction) };
          await cacheSet(env.FACT_CACHE, rateK, norm, RATING_TTL);
          // ⚠️ claim/rating/correction 必须放在 `...r` 之后显式覆盖：
          // ① 模型可能多输出一个 claim 字段（曾把 sr.claim 覆盖成空）→ 入库侧
          //    rt.claim.entity 为空，回退成 fallbackTitle，把"可燃空气"的事实
          //    存进了"普里斯特利"词条——查证再命中时就答非所问；
          // ② `...r` 也会把未净化的 correction 带回来。
          return { ...r, claim: sr.claim, rating: norm.rating, correction: norm.correction, sources: sourcesWithTier(candidates), fromKB: !!sr.fromKB, kbInfo: sr.kb };
        }
        lastErr = 'LLM 返回空';
      } catch (e) {
        lastErr = e.message;
        // 子请求超限（免费版单次调用上限 50）时重试必再失败，白烧一个子请求——直接放弃。
        if (/Too many subrequests/i.test(String(e && e.message))) break;
      }
    }
    // 两次都失败：仍保留检索来源，明确标注为"评级未完成"而非静默丢弃证据。
    // ratingFailed 标记用于**阻止这段系统提示文案被当成"证据原文"写进知识库**
    // （实测：storeFactOf 会把 "自动评级未完成（…）" 当数据句存成一条事实）。
    return {
      claim: sr.claim,
      rating: 'medium',
      ratingFailed: true,
      evidence: `自动评级未完成（${lastErr}），请人工核实。检索到 ${relevant.length} 条相关资料。`,
      correction: '',
      sources: sourcesWithTier(relevant),
      fromKB: false,
    };
  });

  // 4. 知识库入库：**按实体分组**入库（每个实体一张卡），事实由统一构造器生成。
  //    为什么不再用 buildDraftCard 当入库卡：它的标题取"第一条断言的实体"，而事实
  //    取自**全部**断言 —— 多实体段落里会把别的实体的事实存进首个实体的词条
  //    （实测"可燃空气"的爆轰速度事实被存进"普里斯特利"词条，之后查证命中答非所问）。
  //    buildDraftCard 现在只用于前端展示（draftCard 字段），入库一律走按实体分组的卡。
  const draftCard = buildDraftCard(claims, ratings, checkSearches);
  let autoStored = false;
  const partialStored = [];
  const partialSkipped = [];
  let partialDebug = null;
  {
    const { cards, considered } = buildStoreCardsByEntity(ratings, checkSearches);
    partialDebug = { considered, entities: cards.map(c => c.title) };

    for (const item of cards) {
      const ent = item.title;
      const res = await autoStoreCard(env, item.card);
      if (res.stored) {
        partialStored.push(res.merged
          ? { title: ent, count: res.added, merged: true, total: item.facts.length }
          : { title: ent, count: item.facts.length });
      } else {
        partialSkipped.push({
          title: ent,
          reason: res.reason || '未通过自动审核',
          count: item.facts.length,
          refs: (item.card.references || []).map(r => r.url).slice(0, 6),
          ...(res.existing ? { existing: true } : {}),
        });
      }
    }
    if (partialStored.length > 0) autoStored = true;
  }

  // 逐条入库状态 + 检索结果去噪
  // 用户要求：入库提示要跟着「每一条结果」走，而不是右下角弹一个 toast。
  // 前端据此在每条断言下方渲染 已自动入库 / 可手动入库 / 未达入库标准。
  const storedTitles = new Set();
  if (autoStored && draftCard) storedTitles.add(draftCard.title);
  for (const s of partialStored) storedTitles.add(s.title);
  const skippedTitles = new Set(partialSkipped.map(s => s.title));

  ratings.forEach((rt) => {
    const ent = (rt.claim?.entity || draftCard?.title || '').trim();
    const hasSrc = Array.isArray(rt.sources) && rt.sources.length > 0;
    if (rt.fromKB) {
      // 知识库命中的断言：事实已在库里，显示"知识库已有"而非"已自动入库"
      // （重复查证同一文本时此前误显"已入库"，让用户以为又存了一遍）。
      rt.storeStatus = 'kb';
    } else if (rt.rating === 'high' && hasSrc && storedTitles.has(ent)) {
      rt.storeStatus = 'auto';
    } else if (rt.rating === 'high' && hasSrc && skippedTitles.has(ent) && partialSkipped.some(s => s.title === ent && s.existing)) {
      // 评级高、词条已存在且无新增事实（merge 去重后 added=0）——如实显示
      rt.storeStatus = 'existing';
    } else if (rt.rating === 'high' && hasSrc) {
      rt.storeStatus = 'skipped';
    } else {
      rt.storeStatus = 'none';
    }
    rt.storeTitle = ent;
  });

  // 右侧「检索结果」面板同样只展示与实体相关的来源：相关性闸门滤过之后还剩
  // 至少一条才替换（全被滤掉时保留原样，避免看起来像"检索失败"）
  for (const s of checkSearches) {
    if (s.fromKB || !Array.isArray(s.results) || s.results.length === 0) continue;
    const ent = (s.claim?.entity || '').trim();
    if (!ent) continue;
    const rel = filterRelevant(s.results, ent);
    if (rel.length > 0) s.results = rel;
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
    truncated: claimsTotal > claimOffset + batch.length,
    totalClaims: claims.length,
    // 自动续查（前端循环携带 claimOffset 调后续批，直到 nextClaimOffset 为 null）
    claimOffset,
    nextClaimOffset: (claimOffset + batch.length < claimsTotal) ? claimOffset + batch.length : null,
    kbCount,
    corrections: ratings.filter(r => r.correction).map(r => ({
      claim: r.claim?.claim || '', correction: r.correction, evidence: r.evidence,
    })),
    ratings: ratingsCn,
    draftCard,
    autoStored,
    partialStored,
    partialSkipped,
    // 整段原文直配命中信息（前端据此在结果顶部显示"整段命中出处"横幅）
    // ⚠️ 只有权威课本/官方来源命中才会出现在这里；教辅命中走下面的 referenceMatch。
    wholeMatch: wholeMatch
      ? {
          hit: true,
          url: wholeMatch.url,
          title: wholeMatch.title,
          domain: wholeMatch.domain,
          coverage: Number(wholeMatch.coverage.toFixed(2)),
          snippet: wholeMatch.snippet,
        }
      : null,
    // 教辅/题库/答案/文库站的整段命中：**只作参考出处展示**（措辞须体现"非课本"），
    // 不参与判"高"、不触发自动入库。
    referenceMatch: referenceMatch
      ? {
          hit: true,
          url: referenceMatch.url,
          title: referenceMatch.title,
          domain: referenceMatch.domain,
          coverage: Number(referenceMatch.coverage.toFixed(2)),
          tier: referenceMatch.tier,
          snippet: String(referenceMatch.snippet || '').slice(0, 2000),
        }
      : null,
  };
}
