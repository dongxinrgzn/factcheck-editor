// GET /api/health - 健康检查
// ?probe=1 时对各检索源做一次真实连通性自测（诊断"搜索结果变少"类问题）

import { jsonResponse } from '../utils/cors.js';
import { wikiSearch, ddgSearch, searxSearch, tavilySearch, bingWebSearch } from '../sources/brave.js';

export async function handleHealth(request, env) {
  const kvStatus = {};
  for (const k of ['FACT_CACHE', 'SESSION_STATE', 'RATE_LIMIT', 'FACT_KB']) {
    kvStatus[k] = env[k] ? 'bound' : 'missing';
  }
  const data = {
    ok: true,
    timestamp: new Date().toISOString(),
    llm: env.LLM_MODEL || 'Qwen/Qwen2.5-72B-Instruct',
    kv: kvStatus,
    sources: ['wikipedia', 'bing', 'tavily', 'ctext', 'zdic', 'gushiwen', 'govDirect'],
    tavily_configured: !!env.TAVILY_KEY,
    siliconflow_configured: !!env.SILICONFLOW_KEY,
  };

  // 检索源探针：各源真实搜一次，报告结果数/耗时/错误原因
  const url = new URL(request.url);
  if (url.searchParams.get('probe') === '1') {
    const probe = {};
    const test = async (name, fn) => {
      const t0 = Date.now();
      try {
        const r = await fn();
        const n = Array.isArray(r) ? r.length : (r?.results?.length ?? -1);
        probe[name] = { ok: n > 0, results: n, ms: Date.now() - t0 };
      } catch (e) {
        probe[name] = { ok: false, error: String(e.message || e).slice(0, 120), ms: Date.now() - t0 };
      }
    };
    await Promise.all([
      test('wikipedia', () => wikiSearch('大熊猫', 3, '')),
      test('duckduckgo', () => ddgSearch('大熊猫 身高', 5)),
      test('searxng', () => searxSearch('大熊猫', 5)),
      test('bing', () => bingWebSearch('大熊猫 身高', 5)),
      test('tavily', () => tavilySearch('giant panda', {
        apiKey: env.TAVILY_KEY, topK: 3, searchDepth: 'basic',
      })),
    ]);
    data.probe = probe;
  }

  return jsonResponse({ ok: true, data }, 200, request);
}
