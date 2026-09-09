// POST /api/check - 事实核查主端点（A+B：事实提取 + 检索 + 真实度评级）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey, callLLMJson } from '../utils/llmProxy.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { cacheGet, cacheSet, searchCacheKey } from '../utils/cache.js';
import { annotateResults } from '../utils/officialScore.js';
import { braveSearch } from '../sources/brave.js';
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

/**
 * 把维基/英文维基结果中的数据句解析成百科卡片（属性→数值→来源）
 */
function buildFactCard(results, entity) {
  const facts = [];
  const DATA_LINE_RE = /【数据】([\s\S]*)/;
  const EN_DATA_PREFIX = '【英文维基数据】';
  const SYS_PROP = new Set(['海拔', '高度', '栖息', '分布', '活动', '面积', '现存']);

  for (const r of results) {
    const snip = r.snippet || '';
    // 中文维基数据句
    const m = snip.match(DATA_LINE_RE);
    if (m) {
      const lines = m[1].split(/(?<=。)/g).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.length < 8) continue;
        // 从中文句子里抽属性词
        const propM = line.match(/(体重|体长|身高|寿命|年龄|速度|面积|海拔|重量|翼展|跨度|直径|厚度|深度|宽度|长度|产量|人口|分布|栖息|现存|数量|咬合力|出生|逝世)/);
        if (propM && line.match(/\d|公斤|千克|米|厘米|岁|年|公里|公顷|牛顿/)) {
          facts.push({ property: propM[1], value: line, source: { name: r.title, url: r.url } });
        }
      }
    }
    // 英文维基数据句（直接保留原始英文，已含完整数据）
    const m2 = snip.match(new RegExp(EN_DATA_PREFIX + '([\\s\\S]*)'));
    if (m2) {
      const lines = m2[1].split(/(?<=\.)\s+/g).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.length < 15) continue;
        // 粗略属性分类
        let prop = '其他数据';
        if (/weigh|weight|kg|kilogram/i.test(line)) prop = '体重';
        else if (/long|length|meter|cm/i.test(line)) prop = '体长';
        else if (/old|age|year/i.test(line)) prop = '寿命';
        else if (/speed|km\/h|mph/i.test(line)) prop = '速度';
        else if (/elevation|altitude|above sea|m\s/i.test(line)) prop = '海拔';
        else if (/force|newton|bite/i.test(line)) prop = '咬合力';
        else if (/population|inhabitant|million|billion/i.test(line)) prop = '数量';
        facts.push({ property: prop, value: line, source: { name: r.title, url: r.url } });
      }
    }
  }

  // 去重：同一属性保留最完整的一条
  const seen = new Map();
  for (const f of facts) {
    const key = f.property + '|' + f.value.slice(0, 30);
    if (!seen.has(key)) seen.set(key, f);
  }
  return {
    title: entity || text,
    facts: [...seen.values()],
  };
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

  // ---------- 分支 A：查询模式 → 百科卡片 + 直接解答 + 可信度 ----------
  if (intent === 'query') {
    const factCard = buildFactCard(searchResults, entity || text.trim());

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
