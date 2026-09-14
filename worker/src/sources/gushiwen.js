// 古诗文网 gushiwen.cn 检索

const GUSHIWEN_BASE = 'https://www.gushiwen.cn';

/**
 * 从文本中抽取诗词查询串：《浪淘沙·其六》(刘禹锡):"日照澄洲..." 
 * → "浪淘沙·其六"（作品名优先，避免整段长文喂给搜索框导致 0 结果）
 */
export function extractPoemQuery(text) {
  const s = String(text || '');
  // 《...》 书名号内的作品名
  const bookTitle = s.match(/《([^》]{2,40})》/);
  if (bookTitle) return bookTitle[1].trim();
  // 取第一个句子（到标点截断），最多 20 字
  const firstClause = s.split(/[，,。.；;：:！!？?"'\n]/).find(x => x.trim().length >= 2);
  if (firstClause) return firstClause.trim().slice(0, 20);
  return s.trim().slice(0, 20);
}

/**
 * 搜索古诗文（作品名 + 首句双路检索，合并去重）
 */
export async function searchGushiwen(query, env) {
  if (!query) return [];
  const poemName = extractPoemQuery(query);
  const candidates = [poemName];
  // 首句也试一次（作品名检索不到时，正文首句往往能命中）
  const firstVerse = String(query).split(/[，,。.；;：:！!？?"'\n]/).map(x => x.trim())
    .find(x => x.length >= 5 && !x.includes('《'));
  if (firstVerse && firstVerse !== poemName) candidates.push(firstVerse.slice(0, 20));

  const out = [];
  const seen = new Set();
  for (const q of candidates) {
    try {
      const url = `${GUSHIWEN_BASE}/search.aspx?value=${encodeURIComponent(q)}&title=`;
      const resp = await fetch(url, {
        headers: { 'Accept': 'text/html', 'User-Agent': 'factcheck-editor/1.0' },
      });
      if (!resp.ok) continue;
      const html = await resp.text();
      for (const r of parseGushiwenHtml(html, q)) {
        if (!seen.has(r.url)) { seen.add(r.url); out.push(r); }
      }
    } catch { /* 单路失败继续 */ }
    if (out.length >= 5) break;
  }
  return out.slice(0, 5);
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
  // 注意：不做"无结果时构造伪结果"的兜底——伪结果没有真实正文，
  // 会被 scoreMatches 打低分并污染报告。宁可返回空数组，由上层给明确提示。
  return results;
}
