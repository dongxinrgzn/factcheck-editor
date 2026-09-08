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
 * 核查核心流程（供 /api/check 与 /api/kb/submit 复用）
 * @returns {Object} { claims, searches, ratings, rating, corrections, draftCard }
 */
export async function runCheck(text, context, env, apiKey, { autoDraft = false } = {}) {
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

  // 2. 对每条断言检索证据（维基百科主源 → DuckDuckGo → SearXNG）
  const whitelist = env.OFFICIAL_WHITELIST
    ? (typeof env.OFFICIAL_WHITELIST === 'string' ? JSON.parse(env.OFFICIAL_WHITELIST) : env.OFFICIAL_WHITELIST)
    : ['gov.cn', 'org.cn'];

  const searchResults = await Promise.all(
    claims.slice(0, 5).map(async (c) => {
      // 用实体名检索（命中主词条），无实体时退回整句
      const searchQuery = (c.entity && c.entity.trim()) ? c.entity.trim() : c.claim;
      const cacheK = searchCacheKey(searchQuery);
      const cached = await cacheGet(env.FACT_CACHE, cacheK);
      if (cached) return { claim: c, results: cached, cached: true };

      try {
        const raw = await braveSearch({ query: searchQuery, preferOfficial: true, topK: 5, whitelist });
        const annotated = annotateResults(raw, env);
        await cacheSet(env.FACT_CACHE, cacheK, annotated);
        return { claim: c, results: annotated, cached: false };
      } catch (e) {
        return { claim: c, results: [], cached: false, error: e.message };
      }
    })
  );

  // 3. 对每条断言评级
  const ratings = await Promise.all(
    searchResults.map(async (sr) => {
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

  // 4. 构建知识库草稿（单点逻辑，事实含纠错结论与对应来源）
  const draftCard = buildDraftCard(claims, ratings, searchResults);

  if (autoDraft && draftCard && draftCard.facts.length > 0) {
    try {
      await submitDraft(env.FACT_KB, draftCard);
    } catch {
      // 入库失败不影响主流程
    }
  }

  // 综合评级
  const overall = ratings.every(r => r.rating === 'high')
    ? 'high'
    : ratings.some(r => r.rating === 'low')
    ? 'low'
    : 'medium';

  return {
    claims,
    searches: searchResults,
    rating: overall,
    corrections: ratings.filter(r => r.correction).map(r => ({
      claim: r.claim?.claim || '',
      correction: r.correction,
      evidence: r.evidence,
    })),
    ratings,
    draftCard,
  };
}
