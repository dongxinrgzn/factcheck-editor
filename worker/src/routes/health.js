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

    // ---- 备用检索源探针（Tavily 免费额度只有 1000 credits/月，评估替代方案时用）----
    // 必须**从 Worker 侧实测**：本机网络与 Cloudflare 边缘的可达性完全不同
    // （实测本机连不上 zh.wikipedia.org / s.jina.ai，而 Worker 连得上）。
    const rawProbe = async (name, url, init = {}) => {
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const resp = await fetch(url, { ...init, signal: ctrl.signal });
        clearTimeout(timer);
        const text = await resp.text();
        probe[name] = { ok: resp.ok, status: resp.status, ms: Date.now() - t0, bytes: text.length };
        if (q && text) samples[name] = [text.replace(/\s+/g, ' ').slice(0, 220)];
        return text;
      } catch (e) {
        probe[name] = { ok: false, error: String(e.message || e).slice(0, 120), ms: Date.now() - t0 };
        return '';
      }
    };
    const enc = encodeURIComponent(qWeb);
    await Promise.all([
      // Tavily 余额/额度状态：直接看原始 HTTP 码（432/429 = 超额，401 = key 无效）
      env.TAVILY_KEY
        ? rawProbe('tavily-raw', 'https://api.tavily.com/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.TAVILY_KEY}` },
            body: JSON.stringify({ query: qWeb, max_results: 1, search_depth: 'basic' }),
          })
        : Promise.resolve(probe['tavily-raw'] = { ok: false, error: 'TAVILY_KEY 未配置' }),
      // Jina Search（免 Key 可用；新 key 另送 10M token）
      rawProbe('jina-search', `https://s.jina.ai/${enc}`, { headers: { Accept: 'text/plain' } }),
      // Jina Reader：URL → Markdown（免 Key），用于"拿到 URL 后抓正文"的便宜替代
      rawProbe('jina-reader', 'https://r.jina.ai/https://zh.wikipedia.org/wiki/%E6%B0%A2', { headers: { Accept: 'text/plain' } }),
      // 中文百科直抓（零 Key）：维基查不到的中文实体（教材/百科类）用它兜底
      rawProbe('baike-direct', 'https://baike.baidu.com/item/%E6%B0%A2%E6%B0%94', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' },
      }),
      // 以下三家需要 Key，未配置时只报告"未配置"，不影响其余探针
      env.SERPER_KEY
        ? rawProbe('serper', 'https://google.serper.dev/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-KEY': env.SERPER_KEY },
            body: JSON.stringify({ q: qWeb, num: 5 }),
          })
        : Promise.resolve(probe.serper = { ok: false, error: 'SERPER_KEY 未配置（注册送 2500 次）' }),
      env.EXA_KEY
        ? rawProbe('exa', 'https://api.exa.ai/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': env.EXA_KEY },
            body: JSON.stringify({ query: qWeb, numResults: 5 }),
          })
        : Promise.resolve(probe.exa = { ok: false, error: 'EXA_KEY 未配置（1000 次/月）' }),
      env.BRAVE_KEY
        ? rawProbe('brave-search', `https://api.search.brave.com/res/v1/web/search?q=${enc}&count=5`, {
            headers: { Accept: 'application/json', 'X-Subscription-Token': env.BRAVE_KEY },
          })
        : Promise.resolve(probe['brave-search'] = { ok: false, error: 'BRAVE_KEY 未配置（$5/月额度）' }),
    ]);
    data.probe = probe;
    data.sources = ['wikipedia', 'tavily']; // Bing（2026-09-16 弃用）、DDG/SearXNG（反爬失效）已移出主链路
    data.fallback_candidates = ['jina(免Key)', 'serper(2500次)', 'exa(1000/月)', 'brave($5/月)', 'baike-direct(免Key)'];
    data.tavily_free_tier = '1000 credits/月（basic=1、advanced=2 credit/次）';
    if (q) data.samples = samples;
  }

  return jsonResponse({ ok: true, data }, 200, request);
}
