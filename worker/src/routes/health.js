// GET /api/health - 健康检查

import { jsonResponse } from '../utils/cors.js';

export async function handleHealth(request, env) {
  const kvStatus = {};
  for (const k of ['FACT_CACHE', 'SESSION_STATE', 'RATE_LIMIT', 'FACT_KB']) {
    kvStatus[k] = env[k] ? 'bound' : 'missing';
  }
  return jsonResponse({
    ok: true,
    data: {
      ok: true,
      timestamp: new Date().toISOString(),
      llm: env.LLM_MODEL || 'Qwen/Qwen2.5-72B-Instruct',
      kv: kvStatus,
      sources: ['tavily', 'ctext', 'zdic', 'gushiwen', 'govDirect'],
      tavily_configured: !!env.TAVILY_KEY,
      siliconflow_configured: !!env.SILICONFLOW_KEY,
    },
  }, 200, request);
}
