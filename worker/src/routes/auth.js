// POST /api/auth - 权限验证（复用 STORM 三档权限）

import { getClientIp, jsonResponse, errorJson } from '../utils/cors.js';
import { resolveApiKey } from '../utils/llmProxy.js';
import { checkRateLimit } from '../utils/rateLimiter.js';

export async function handleAuth(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorJson('请求体格式错误', 400, 'BAD_REQUEST', request);
  }

  const token = body.token || '';
  const clientIp = getClientIp(request);
  const { role, unlimited } = resolveApiKey(token, env);

  if (role === 'guest') {
    // 陌生人：检查兜底额度
    const limit = parseInt(env.FALLBACK_PER_IP_DAILY_LIMIT || '3', 10);
    const { allowed, used } = await checkRateLimit(env.RATE_LIMIT, clientIp, limit);
    return jsonResponse({
      ok: true,
      data: {
        role: 'guest',
        daily_quota: limit,
        used,
        remaining: Math.max(0, limit - used),
        unlimited: false,
      },
    }, 200, request);
  }

  return jsonResponse({
    ok: true,
    data: {
      role,
      daily_quota: -1,
      used: 0,
      remaining: -1,
      unlimited: true,
    },
  }, 200, request);
}
