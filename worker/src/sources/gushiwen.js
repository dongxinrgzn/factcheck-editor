// 古诗文网 gushiwen.cn 检索

const GUSHIWEN_BASE = 'https://www.gushiwen.cn';

/**
 * 搜索古诗文
 */
export async function searchGushiwen(query, env) {
  if (!query) return [];
  const url = `${GUSHIWEN_BASE}/search.aspx?value=${encodeURIComponent(query)}&title=`;
  const resp = await fetch(url, {
    headers: {
      'Accept': 'text/html',
      'User-Agent': 'factcheck-editor/1.0',
    },
  });
  if (!resp.ok) {
    throw new Error(`GUSHIWEN_HTTP_${resp.status}`);
  }
  const html = await resp.text();
  return parseGushiwenHtml(html, query);
}

/**
 * 简易解析古诗文网搜索结果
 */
function parseGushiwenHtml(html, query) {
  const results = [];
  // 古诗文网搜索结果大致结构
  const itemRegex = /<div[^>]*class="[^"]*sons[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let match;
  while ((match = itemRegex.exec(html)) !== null && results.length < 5) {
    const block = match[1];
    const aMatch = block.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    const title = aMatch ? aMatch[2].replace(/<[^>]+>/g, '').trim() : '';
    const href = aMatch ? aMatch[1] : '';
    const text = block.replace(/<[^>]+>/g, '').trim().slice(0, 200);
    if (title || text) {
      results.push({
        title: title || `古诗文：${query}`,
        url: href.startsWith('http') ? href : `${GUSHIWEN_BASE}${href}`,
        snippet: text,
        source: 'gushiwen',
      });
    }
  }
  // 兜底
  if (results.length === 0) {
    results.push({
      title: `古诗文网：${query}`,
      url: `${GUSHIWEN_BASE}/search.aspx?value=${encodeURIComponent(query)}`,
      snippet: '点击查看古诗文网搜索结果',
      source: 'gushiwen',
    });
  }
  return results;
}
