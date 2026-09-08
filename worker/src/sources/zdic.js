// 汉典 zdic.net 检索（字词释义、古籍用字）

const ZDIC_BASE = 'https://www.zdic.net';

/**
 * 查字/词释义
 * 注意：汉典无官方 API，只能抓页面
 */
export async function searchZdic(word, env) {
  if (!word) return [];
  const url = `${ZDIC_BASE}/hint/sc/?q=${encodeURIComponent(word)}`;
  const resp = await fetch(url, {
    headers: {
      'Accept': 'text/html',
      'User-Agent': 'factcheck-editor/1.0',
    },
  });
  if (!resp.ok) {
    throw new Error(`ZDIC_HTTP_${resp.status}`);
  }
  const html = await resp.text();
  return parseZdicHtml(html, word);
}

/**
 * 简易解析汉典结果
 */
function parseZdicHtml(html, word) {
  const results = [];
  // 提取释义片段
  const defRegex = /<div[^>]*class="[^"]*def[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let match;
  while ((match = defRegex.exec(html)) !== null && results.length < 3) {
    const text = match[1].replace(/<[^>]+>/g, '').trim();
    if (text) {
      results.push({
        title: `汉典：${word}`,
        url: `${ZDIC_BASE}/search/?q=${encodeURIComponent(word)}`,
        snippet: text,
        source: 'zdic',
      });
    }
  }
  // 兜底：若无匹配，至少返回一条入口链接
  if (results.length === 0) {
    results.push({
      title: `汉典：${word}`,
      url: `${ZDIC_BASE}/search/?q=${encodeURIComponent(word)}`,
      snippet: '点击查看汉典详细释义',
      source: 'zdic',
    });
  }
  return results;
}
