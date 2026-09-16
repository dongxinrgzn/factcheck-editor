// GET /api/health - 健康检查
// ?probe=1 时对各检索源做一次真实连通性自测（诊断"搜索结果变少"类问题）

import { jsonResponse } from '../utils/cors.js';
import { wikiSearch, ddgSearch, searxSearch, tavilySearch } from '../sources/brave.js';

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
    // ?q=<检索词> 用指定检索词探针——排查"某个具体查询召不到结果"时用它，
    // 成本远低于反复打 /api/check（不耗 LLM、不占用户额度）。缺省用样例词。
    const q = (url.searchParams.get('q') || '').trim();
    const qWiki = q || '大熊猫';
    const qWeb = q || '大熊猫 身高';
    const probe = {};
    const samples = {};
    const test = async (name, fn) => {
      const t0 = Date.now();
      try {
        const r = await fn();
        const list = Array.isArray(r) ? r : (r?.results || []);
        probe[name] = { ok: list.length > 0, results: list.length, ms: Date.now() - t0 };
        if (q) samples[name] = list.slice(0, 5).map(x => `${x.title || ''} <${x.source || ''}>`);
      } catch (e) {
        probe[name] = { ok: false, error: String(e.message || e).slice(0, 120), ms: Date.now() - t0 };
      }
    };
    await Promise.all([
      test('wikipedia', () => wikiSearch(qWiki, 3, '')),
      test('duckduckgo', () => ddgSearch(qWeb, 5)),
      test('searxng', () => searxSearch(qWiki, 5)),
      test('tavily', () => tavilySearch(qWeb, {
        apiKey: env.TAVILY_KEY, topK: 5, searchDepth: 'basic',
      })),
    ]);
    data.probe = probe;
    data.sources = ['wikipedia', 'tavily']; // Bing（2026-09-16 弃用）、DDG/SearXNG（反爬失效）已移出主链路
    if (q) data.samples = samples;
  }

  return jsonResponse({ ok: true, data }, 200, request);
}
