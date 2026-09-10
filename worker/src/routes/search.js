// POST /api/search - 官方数据优先检索（A）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey } from '../utils/llmProxy.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { cacheGet, cacheSet, searchCacheKey } from '../utils/cache.js';
import { annotateResults } from '../utils/officialScore.js';
import { braveSearch, braveSearchAll } from '../sources/brave.js';
import { searchGovDirect } from '../sources/govDirect.js';

export async function handleSearch(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('请求体格式错误', 400, 'BAD_REQUEST', request);
  }

  const { query, prefer_official = true, top_k = 5 } = body;
  if (!query) {
    return errorJson('query 字段必填', 400, 'BAD_REQUEST', request);
  }

  // 权限
  const userKey = request.headers.get('X-Worker-Key') || '';
  const clientIp = getClientIp(request);
  const { role, unlimited } = resolveApiKey(userKey, env);

  if (!unlimited) {
    const limit = parseInt(env.FALLBACK_PER_IP_DAILY_LIMIT || '3', 10) * 40; // 检索放宽
    const { allowed } = await checkRateLimit(env.RATE_LIMIT, clientIp, limit);
    if (!allowed) {
      return errorJson('今日检索额度已用完', 403, 'RATE_LIMITED', request);
    }
  }

  // 缓存
  const cacheK = searchCacheKey(query, String(prefer_official));
  const cached = await cacheGet(env.FACT_CACHE, cacheK);
  if (cached) {
    return jsonResponse({ ok: true, data: { results: cached, source: 'cache' }, cached: true }, 200, request);
  }

  // 检索（SearXNG 免费引擎，无需 API Key）
  let results = [];

  if (prefer_official) {
    // 优先官方：SearXNG site: 过滤 + 政府站内
    const whitelist = env.OFFICIAL_WHITELIST
      ? (typeof env.OFFICIAL_WHITELIST === 'string' ? JSON.parse(env.OFFICIAL_WHITELIST) : env.OFFICIAL_WHITELIST)
      : ['gov.cn', 'org.cn'];
    const govResults = await searchGovDirect(query, { apiKey: env.TAVILY_KEY });
    try {
      const searxResults = await braveSearch({
        query, preferOfficial: true, topK: top_k, whitelist,
      });
      // 官方真实结果优先排前，维基/其他来源其后
      results = [...govResults, ...searxResults];
    } catch {
      results = govResults;
    }
  } else {
    // 全网搜索
    try {
      results = await braveSearchAll(query, top_k);
    } catch {
      results = [];
    }
  }

  // 打官方性标签
  const annotated = annotateResults(results, env);
  await cacheSet(env.FACT_CACHE, cacheK, annotated);

  return jsonResponse({
    ok: true,
    data: { results: annotated, source: 'live' },
  }, 200, request);
}
