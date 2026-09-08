// Cloudflare Worker 入口 + fetch 路由分发

import { handlePreflight, withCors, jsonResponse, errorJson } from './utils/cors.js';
import { handleAuth } from './routes/auth.js';
import { handleCheck } from './routes/check.js';
import { handleSearch } from './routes/search.js';
import { handleVerifyAncient } from './routes/verifyAncient.js';
import { handleKbQuery } from './routes/kbQuery.js';
import { handleKbSubmit, handleKbEntry } from './routes/kbSubmit.js';
import { handleHealth } from './routes/health.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // CORS 预检
    if (method === 'OPTIONS') {
      return handlePreflight(request);
    }

    try {
      // 健康检查
      if (path === '/api/health' && method === 'GET') {
        return await handleHealth(request, env);
      }

      // 权限验证
      if (path === '/api/auth' && method === 'POST') {
        return await handleAuth(request, env);
      }

      // 事实核查（A+B）
      if (path === '/api/check' && method === 'POST') {
        return await handleCheck(request, env);
      }

      // 官方检索（A）
      if (path === '/api/search' && method === 'POST') {
        return await handleSearch(request, env);
      }

      // 古文查证（C）
      if (path === '/api/verify-ancient' && method === 'POST') {
        return await handleVerifyAncient(request, env);
      }

      // 知识库查询（D）
      if (path === '/api/kb/query' && method === 'POST') {
        return await handleKbQuery(request, env);
      }

      // 知识库入库（D）
      if (path === '/api/kb/submit' && method === 'POST') {
        return await handleKbSubmit(request, env);
      }

      // 知识库词条详情
      const entryMatch = path.match(/^\/api\/kb\/entry\/([^\/]+)$/);
      if (entryMatch && method === 'GET') {
        return await handleKbEntry(request, env, decodeURIComponent(entryMatch[1]));
      }

      // 404
      if (path === '/' || path === '/index.html') {
        return jsonResponse({
          ok: true,
          data: {
            name: 'factcheck-editor-api',
            version: '1.0.0',
            endpoints: [
              'POST /api/auth',
              'POST /api/check',
              'POST /api/search',
              'POST /api/verify-ancient',
              'POST /api/kb/query',
              'POST /api/kb/submit',
              'GET /api/kb/entry/:key',
              'GET /api/health',
            ],
          },
        }, 200, request);
      }

      return errorJson(`路径不存在：${path}`, 404, 'NOT_FOUND', request);
    } catch (e) {
      return errorJson(
        `服务器内部错误：${e.message}`,
        500,
        'INTERNAL_ERROR',
        request,
      );
    }
  },
};
