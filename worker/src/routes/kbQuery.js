// POST /api/kb/query - 知识库查询端点（D）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey } from '../utils/llmProxy.js';
import { checkRateLimit } from '../utils/rateLimiter.js';
import { queryEntry } from '../utils/kbStore.js';

export async function handleKbQuery(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('请求体格式错误', 400, 'BAD_REQUEST', request);
  }

  const { keyword, alias_match = true } = body;
  if (!keyword) {
    return errorJson('keyword 字段必填', 400, 'BAD_REQUEST', request);
  }

  // 权限（知识库查询对所有人开放，但仍限流陌生人）
  const userKey = request.headers.get('X-Worker-Key') || '';
  const clientIp = getClientIp(request);
  const { unlimited } = resolveApiKey(userKey, env);

  if (!unlimited) {
    const limit = parseInt(env.FALLBACK_PER_IP_DAILY_LIMIT || '3', 10) * 20;
    const { allowed } = await checkRateLimit(env.RATE_LIMIT, clientIp, limit);
    if (!allowed) {
      return errorJson('今日查询额度已用完', 403, 'RATE_LIMITED', request);
    }
  }

  // 查询词条卡
  const { hit, card, cached, expired } = await queryEntry(env.FACT_KB, keyword);

  if (hit && card) {
    return jsonResponse({
      ok: true,
      data: { hit: true, card, cached: !!cached, expired: !!expired },
    }, 200, request);
  }

  // 未命中
  return jsonResponse({
    ok: true,
    data: { hit: false, card: null, suggestion: '走 /api/search 检索，或 /api/kb/submit 提议入库' },
  }, 200, request);
}
