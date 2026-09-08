// CORS 白名单 + IP 提取（复用 STORM 模式）

const ALLOWED_ORIGINS = [
  'https://dongxinrgzn.github.io',       // GitHub Pages（事实核查助手前端）
  'http://localhost:5173',               // 本地 wrangler dev
  'http://127.0.0.1:5173',
  'http://localhost:8787',               // wrangler dev 默认
  'http://127.0.0.1:8787',
];

/**
 * 从请求头提取客户端 IP
 */
export function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Real-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

/**
 * 给 Response 添加 CORS 头
 */
export function withCors(response, request) {
  const origin = request?.headers?.get('Origin') || '';
  const corsHeaders = {};
  if (ALLOWED_ORIGINS.includes(origin)) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
    corsHeaders['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    corsHeaders['Access-Control-Allow-Headers'] = 'Content-Type, X-Worker-Key, Authorization';
    corsHeaders['Access-Control-Max-Age'] = '86400';
    corsHeaders['Vary'] = 'Origin';
  }
  // 合并已有头
  const newHeaders = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([k, v]) => newHeaders.set(k, v));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * 处理 OPTIONS 预检请求
 */
export function handlePreflight(request) {
  const origin = request?.headers?.get('Origin') || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Worker-Key, Authorization',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
      },
    });
  }
  return new Response('Forbidden', { status: 403 });
}

/**
 * 构造 JSON 响应（自动加 CORS）
 */
export function jsonResponse(data, status = 200, request = null) {
  const response = new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
  return request ? withCors(response, request) : response;
}

/**
 * 构造错误 JSON 响应
 */
export function errorJson(message, status = 500, code = 'ERROR', request = null, retryAfter = null) {
  const body = {
    ok: false,
    error: { code, message, ...(retryAfter ? { retry_after: retryAfter } : {}) },
  };
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
  return request ? withCors(response, request) : response;
}
