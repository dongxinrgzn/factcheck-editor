// POST /api/verify-ancient - 古文查证端点（C）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey, callLLMJson } from '../utils/llmProxy.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { cacheGet, cacheSet, ancientCacheKey, ANCIENT_TTL, clearKBCache } from '../utils/cache.js';
import { searchText, searchClassic, CLASSIC_TEXTS } from '../sources/ctext.js';
import { searchZdic } from '../sources/zdic.js';
import { searchGushiwen, extractPoemQuery } from '../sources/gushiwen.js';
import { segmentAndExtract, scoreMatches, clusterByEdition, isAllLowConfidence, isMathCategory, getMathUrnPrefixes } from '../utils/ancientMatcher.js';
import { buildSegmentMessages, buildMathExtractMessages } from '../prompts/matchAncient.js';
import { submitDraft, autoAudit, approveEntry, slugify } from '../utils/kbStore.js';
import { runCheck } from './check.js';

/** 粗判是否为诗词类文本（长短句 + 书名号标题 + 无古籍关键词） */
function isPoem(text) {
  const s = String(text || '');
  if (/《[^》]{2,40}》/.test(s)) return true;          // 有作品名
  if (/[，。；]"|"[，。；]/.test(s)) return true;        // 引号包住的成句
  // 多个四/五/七言短句，逗号分隔
  const clauses = s.split(/[，,。；;]/).filter(x => x.trim().length >= 4);
  const short = clauses.filter(x => x.trim().length <= 12).length;
  return clauses.length >= 3 && short / clauses.length >= 0.6;
}

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
  //    子请求预算：searchClassic 会遍历 7 部书 × 各章（每章 1 次 fetch，含 1.1s 限速），
  //    是整条链路上最耗额度的环节。诗词类文本在古籍库里必然 0 命中，
  //    先判定再决定是否走这一步，避免白白烧掉几十个子请求导致整体失败。
  let allMatches = [];
  let classicInfo = null;
  const poemLike = isPoem(text);
  if (!poemLike) {
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
  } else {
    segResult.math_info = { suspected_book: '', keywords: [], poem_like: true };
  }

  // 3. ctext 全文检索补充（用锚点，古籍原文未命中时补充）
  if (!poemLike && allMatches.length < 3) {
    for (const anchor of (segResult.anchors || []).slice(0, 2)) {
      try {
        const hits = await searchText(anchor, env, {});
        allMatches.push(...hits);
      } catch {
        // ctext 失败不阻塞
      }
    }
  }

  // 4. 古诗文网（诗词优先）+ 汉典兜底
  if (allMatches.length === 0) {
    try {
      const gw = await searchGushiwen(text, env);
      allMatches.push(...gw.map(r => ({
        book: r.title, chapter: '', urn: '', url: r.url, text: r.snippet, edition: 'gushiwen',
      })));
    } catch {}
  }
  if (allMatches.length === 0 && !poemLike) {
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

  // 生成古文 draftCard + 自动入库逻辑
  let ancientDraftCard = null;
  let ancientAutoStored = false;
  let auditDebug = null;
  if (clustered.length > 0 && !allLow) {
    const bestMatch = clustered[0];
    const confidence = bestMatch.confidence >= 0.8 ? '高' : '中';
    ancientDraftCard = {
      title: text.slice(0, 30),
      aliases: [],
      category: '古文',
      facts: [{
        label: text,
        value: `出处：${bestMatch.book || ''}${bestMatch.chapter ? ' · ' + bestMatch.chapter : ''}`,
        rating: confidence === '高' ? 'high' : 'medium',
        source: {
          name: bestMatch.book || bestMatch.edition || '',
          url: bestMatch.url || '',
          official_tag: bestMatch.edition === 'ctext',
          official_score: bestMatch.edition === 'ctext' ? 0.9 : 0.5,
        },
        verified_at: new Date().toISOString().slice(0, 10),
        confidence: confidence,
      }],
      references: clustered.slice(0, 5).map(m => ({
        name: `${m.book || ''}${m.chapter ? ' · ' + m.chapter : ''}`,
        url: m.url || '',
        official_tag: m.edition === 'ctext',
        official_score: m.edition === 'ctext' ? 0.9 : 0.5,
      })),
      confidence_tier: confidence,
    };
    // 高可信度 + autoAudit 通过 → 自接入库
    // 注意：auditDebug 在函数作用域（上方）已声明，此处直接赋值，勿再 let 声明否则遮蔽
    if (confidence === '高') {
      const audit = autoAudit(ancientDraftCard);
      auditDebug = audit;
      if (audit.pass) {
        try {
          const slug = slugify(ancientDraftCard.title);
          await approveEntry(env.FACT_KB, slug, { ...ancientDraftCard, status: 'auto_verified' }, 'auto_audit');
          await clearKBCache(env.FACT_KB);
          ancientAutoStored = true;
        } catch (e) {
          auditDebug = { ...audit, storeError: e.message };
        }
      }
    }
  }

  const ancientConfidence = ancientDraftCard?.confidence_tier || '中';

  // 8. 叠加事实核查：古文查证只解决"出处是否有据"，
  //    用户还要求"每个点都能验证是否属实"——所以再跑一遍逐点核查，
  //    让报告同时包含【出处比对】与【事实真伪】两部分。
  let factCheck = null;
  let factCheckError = null;
  try {
    // 限 6 条 + 关闭检索兜底：古文流程本身已消耗十余个子请求，
    // 叠加完整核查会撞上 Cloudflare "Too many subrequests"（单次调用上限 50）。
    const fc = await runCheck(text, '', env, apiKey, {
      mode: 'verify',
      maxClaims: 6,
      skipSearchFallback: true,
    });
    if (fc && Array.isArray(fc.claims) && fc.claims.length > 0) {
      factCheck = {
        claims: fc.claims,
        ratings: fc.ratings || [],
        rating: fc.rating || '中',
        confidenceReason: fc.confidenceReason || '',
        totalClaims: fc.totalClaims || fc.claims.length,
        truncated: !!fc.truncated,
        draftCard: fc.draftCard || null,
        autoStored: !!fc.autoStored,
        partialStored: fc.partialStored || [],
        partialSkipped: fc.partialSkipped || [],
        kbCount: fc.kbCount || 0,
        searches: fc.searches || [],
      };
    } else {
      factCheckError = '未提取到可核查的事实点';
    }
  } catch (e) {
    // 事实核查失败不阻塞古文查证主流程，但要暴露原因（否则前端只能看到静默无结果）
    factCheckError = e.message;
  }

  const result = {
    segment: segResult.segmented || text,
    anchors: segResult.anchors || [],
    suspected_err: segResult.suspected_err || [],
    matches: clustered,
    math_info: segResult.math_info || null,
    all_low_confidence: allLow,
    // 分类：诗词类文本（古籍库无诗词集）给明确提示，而非静默"疑似讹误"
    poem_title: extractPoemQuery(text),
    note: allLow
      ? (isPoem(text)
          ? '未在古籍库中找到出处（内置古籍库仅含先秦/哲学/算学七部，不含诗词集）。下方"事实核查"已对文本中各事实点逐条验证。'
          : '未找到精确匹配，疑似讹误/辑佚')
      : '',
    classic_books: CLASSIC_TEXTS.map(b => b.label),
    factCheck: factCheck,
    factCheckError: factCheckError,
    draftCard: ancientDraftCard || factCheck?.draftCard || null,
    autoStored: ancientAutoStored || !!factCheck?.autoStored,
    confidence: factCheck?.rating || ancientConfidence,
    confidenceReason: factCheck?.confidenceReason || '',
    auditDebug: auditDebug,
  };

  // 缓存（古籍 90 天）
  await cacheSet(env.FACT_CACHE, cacheK, result, ANCIENT_TTL);

  return jsonResponse({ ok: true, data: result }, 200, request);
}
