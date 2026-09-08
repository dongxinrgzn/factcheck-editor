// POST /api/verify-ancient - 古文查证端点（C）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey, callLLMJson } from '../utils/llmProxy.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { cacheGet, cacheSet, ancientCacheKey, ANCIENT_TTL } from '../utils/cache.js';
import { searchText, searchClassic, CLASSIC_TEXTS } from '../sources/ctext.js';
import { searchZdic } from '../sources/zdic.js';
import { searchGushiwen } from '../sources/gushiwen.js';
import { segmentAndExtract, scoreMatches, clusterByEdition, isAllLowConfidence, isMathCategory, getMathUrnPrefixes } from '../utils/ancientMatcher.js';
import { buildSegmentMessages, buildMathExtractMessages } from '../prompts/matchAncient.js';

export async function handleVerifyAncient(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('请求体格式错误', 400, 'BAD_REQUEST', request);
  }

  const { text, category = 'general' } = body;
  if (!text) {
    return errorJson('text 字段必填', 400, 'BAD_REQUEST', request);
  }

  // 权限
  const userKey = request.headers.get('X-Worker-Key') || '';
  const clientIp = getClientIp(request);
  const { apiKey, unlimited } = resolveApiKey(userKey, env);

  if (!unlimited) {
    const limit = parseInt(env.FALLBACK_PER_IP_DAILY_LIMIT || '3', 10);
    const { allowed } = await checkRateLimit(env.RATE_LIMIT, clientIp, limit);
    if (!allowed) {
      return errorJson('今日额度已用完', 403, 'RATE_LIMITED', request);
    }
  }

  // 缓存
  const cacheK = ancientCacheKey(text + category);
  const cached = await cacheGet(env.FACT_CACHE, cacheK);
  if (cached) {
    return jsonResponse({ ok: true, data: cached, cached: true }, 200, request);
  }

  // 1. LLM 断句 + 提取锚点
  let segResult;
  try {
    segResult = await callLLMJson({
      messages: buildSegmentMessages(text),
      apiKey,
      temperature: 0.1,
      maxTokens: 1024,
    });
  } catch (e) {
    return errorJson(`古文断句失败：${e.message}`, 502, 'LLM_ERROR', request);
  }

  // 2. 古籍原文匹配（多学科通用：数学用指纹，哲学/诗文用字符重叠）
  let allMatches = [];
  let classicInfo = null;
  try {
    classicInfo = await callLLMJson({
      messages: buildMathExtractMessages(text),
      apiKey,
      temperature: 0.1,
      maxTokens: 512,
    });
    segResult.math_info = { ...classicInfo, auto_detected: true };
    try {
      const classicHits = await searchClassic(text, classicInfo?.suspected_book || '', env);
      allMatches.push(...classicHits);
    } catch {
      // ctext 失败不阻塞
    }
  } catch {
    // 古籍信息提取失败不阻塞
  }

  // 3. ctext 全文检索补充（用锚点，古籍原文未命中时补充）
  if (allMatches.length < 3) {
    for (const anchor of (segResult.anchors || []).slice(0, 3)) {
      try {
        const hits = await searchText(anchor, env, {});
        allMatches.push(...hits);
      } catch {
        // ctext 失败不阻塞
      }
    }
  }

  // 4. 古诗文网 + 汉典兜底
  if (allMatches.length === 0) {
    try {
      const gw = await searchGushiwen(text, env);
      allMatches.push(...gw.map(r => ({
        book: r.title, chapter: '', urn: '', url: r.url, text: r.snippet, edition: 'gushiwen',
      })));
    } catch {}
    try {
      const zd = await searchZdic(text, env);
      allMatches.push(...zd.map(r => ({
        book: r.title, chapter: '', urn: '', url: r.url, text: r.snippet, edition: 'zdic',
      })));
    } catch {}
  }

  // 4. 去重
  const seen = new Set();
  allMatches = allMatches.filter(m => {
    const k = `${m.book}-${m.chapter}-${(m.text || '').slice(0, 20)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // 5. LLM 多版本相似度打分
  let scored = allMatches;
  if (allMatches.length > 0) {
    try {
      scored = await scoreMatches(segResult.segmented || text, allMatches, apiKey);
    } catch {
      // 打分失败用默认
    }
  }

  // 6. 按版本聚类
  const clustered = clusterByEdition(scored);

  // 7. 判断是否全部低置信
  const allLow = isAllLowConfidence(clustered);

  const result = {
    segment: segResult.segmented || text,
    anchors: segResult.anchors || [],
    suspected_err: segResult.suspected_err || [],
    matches: clustered,
    math_info: segResult.math_info || null,
    all_low_confidence: allLow,
    note: allLow ? '未找到精确匹配，疑似讹误/辑佚' : '',
    classic_books: CLASSIC_TEXTS.map(b => b.label),
  };

  // 缓存（古籍 90 天）
  await cacheSet(env.FACT_CACHE, cacheK, result, ANCIENT_TTL);

  return jsonResponse({ ok: true, data: result }, 200, request);
}
