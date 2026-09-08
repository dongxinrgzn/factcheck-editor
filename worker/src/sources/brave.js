// 全网检索：维基百科（主，稳定免费无Key）→ DuckDuckGo HTML（兜底）→ SearXNG（末选）
// 维基百科对人物生平、常识、动植物等实体事实最权威，且 API 从 Cloudflare 稳定可达

const SEARX_INSTANCES = [
  'https://searx.be',
  'https://search.mdosch.de',
  'https://searx.tiekoetter.com',
  'https://searx.party',
];

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

// ---------- 维基百科 ----------
// 取词条导言（纯文本开头，含生卒年/定义等关键事实）
async function wikiExtract(lang, title) {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json&formatversion=2`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'FactCheckEditor/1.0' } });
    clearTimeout(t);
    if (!resp.ok) return '';
    const j = await resp.json();
    const ext = j?.query?.pages?.[0]?.extract || '';
    return stripHtml(ext).slice(0, 600);
  } catch { return ''; }
}

async function wikiSearch(query, topK = 5) {
  const out = [];
  for (const lang of ['zh', 'en']) {
    try {
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${topK}&format=json&formatversion=2`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'FactCheckEditor/1.0' } });
      clearTimeout(t);
      if (!resp.ok) continue;
      const j = await resp.json();
      const hits = j?.query?.search || [];
      for (const h of hits) {
        // 前 2 条取正文摘要（含生卒年等关键事实），其余用搜索摘要
        let snippet = stripHtml(h.snippet);
        if (out.length < 2) {
          const ext = await wikiExtract(lang, h.title);
          if (ext) snippet = ext;
        }
        out.push({
          title: h.title || '',
          url: `https://${lang}.wikipedia.org/?curid=${h.pageid}`,
          snippet,
          source: 'wikipedia',
        });
      }
    } catch { /* 该语言失败则继续 */ }
    if (out.length >= topK) break;
  }
  return out.slice(0, topK);
}

// ---------- DuckDuckGo HTML ----------
async function ddgSearch(query, topK = 5) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    clearTimeout(t);
    if (!resp.ok) return [];
    const html = await resp.text();

    const out = [];
    // 结果块：result__a 标题链接 + result__snippet 摘要
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const links = [];
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let href = m[1];
      // DDG 重定向链接解析真实 URL
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) {
        try { href = decodeURIComponent(uddg[1]); } catch { /* keep */ }
      }
      links.push({ url: href, title: stripHtml(m[2]) });
    }
    const snippets = [];
    while ((m = snipRe.exec(html)) !== null) snippets.push(stripHtml(m[1]));

    for (let i = 0; i < Math.min(links.length, topK); i++) {
      out.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snippets[i] || '',
        source: 'duckduckgo',
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- SearXNG（末选） ----------
async function searxSearch(query, topK = 5) {
  for (const instance of SEARX_INSTANCES) {
    try {
      const params = new URLSearchParams({ q: query, format: 'json', language: 'zh' });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(`${instance}/search?${params}`, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(t);
      if (!resp.ok) continue;
      const j = await resp.json().catch(() => null);
      const raw = j?.results;
      if (!Array.isArray(raw)) continue;
      const results = raw.map(r => ({
        title: r.title || '', url: r.url || '', snippet: r.content || '', source: 'searx',
      })).filter(r => r.url);
      if (results.length > 0) return results.slice(0, topK);
    } catch { /* 下一个实例 */ }
  }
  return [];
}

/**
 * 综合全网检索（多源兜底）
 * @param {Object} opts - { query, preferOfficial, topK, whitelist }
 */
export async function braveSearch(opts = {}) {
  const { query, topK = 5 } = opts;
  if (!query) return [];

  // 维基 → DDG → SearXNG，任一源有结果即返回（合并去重）
  const wiki = await wikiSearch(query, topK);
  if (wiki.length > 0) {
    const ddg = await ddgSearch(query, Math.max(0, topK - wiki.length));
    return dedupe([...wiki, ...ddg]).slice(0, topK);
  }
  const ddg = await ddgSearch(query, topK);
  if (ddg.length > 0) return ddg.slice(0, topK);
  return await searxSearch(query, topK);
}

export async function braveSearchAll(query, topK = 5) {
  return braveSearch({ query, topK });
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const key = r.url;
    if (key && !seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}
