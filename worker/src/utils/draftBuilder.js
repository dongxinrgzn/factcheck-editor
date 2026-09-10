// 知识库草稿卡片构建（单点逻辑：自动入库与手动提议共用）

/**
 * 由核查结果构建知识库词条草稿
 * @param {Array} claims LLM 提取的断言 [{claim, entity, metric, time}]
 * @param {Array} ratings 评级结果 [{claim, rating, evidence, correction, sources}]
 * @param {Array} searchResults 每条断言的检索结果 [{claim, results:[...]}]
 * @returns {Object|null} 草稿 card（title/facts/references），无有效内容返回 null
 */
export function buildDraftCard(claims, ratings, searchResults) {
  if (!Array.isArray(claims) || claims.length === 0) return null;
  const entity = (claims[0]?.entity || '').trim();
  if (!entity) return null;

  const today = new Date().toISOString().split('T')[0];

  // 每条断言生成一条事实：value 取纠错结论/核查证据，source 取该断言自己的最优来源
  const facts = claims.map((c, i) => {
    const sr = searchResults?.[i];
    const results = Array.isArray(sr?.results)
      ? sr.results.filter(r => r && r.title && r.url)
      : [];
    const top = results.slice().sort(
      (a, b) => (b.official_score || 0) - (a.official_score || 0)
    )[0] || null;

    // rating 与 claim 按引用对应（ratings 顺序与 searchResults 一致）
    const rt = ratings?.[i] || {};
    const evidence = (rt.evidence || '').slice(0, 100);
    // 评级归一化（兼容英文旧值）
    const rating = ({ high: '高', medium: '中', low: '低' })[rt.rating] || rt.rating || '中';
    let value = '';
    if (rt.correction) value = `纠错：${rt.correction}`;
    else if (rating === '高') value = evidence ? `属实：${evidence}` : '属实';
    else if (rating === '低') value = evidence ? `存疑：${evidence}` : '存疑，建议人工核实';
    else value = evidence || '待人工核实';

    return {
      key: `fact_${i}`,
      label: c.claim || c.entity,
      value,
      metric: c.metric || '',
      time: c.time || '',
      rating,
      source: top ? {
        name: top.title,
        url: top.url,
        official_score: top.official_score || 0,
        official_tag: !!top.official_tag,
      } : null,
      verified_at: today,
      confidence: rating,
    };
  }).filter(f => f.value && f.source);

  // 参考来源：所有检索结果去重后取前 5 条
  const refs = [];
  const seenUrl = new Set();
  for (const sr of searchResults || []) {
    for (const r of (Array.isArray(sr?.results) ? sr.results : [])) {
      if (!r?.url || seenUrl.has(r.url)) continue;
      seenUrl.add(r.url);
      refs.push({ name: r.title, url: r.url, official_score: r.official_score || 0 });
      if (refs.length >= 5) break;
    }
    if (refs.length >= 5) break;
  }

  if (facts.length === 0) return null;

  return {
    title: entity,
    aliases: [],
    category: 'auto',
    facts,
    references: refs,
  };
}
