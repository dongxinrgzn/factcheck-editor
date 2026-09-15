// 知识库草稿卡片构建（单点逻辑：自动入库与手动提议共用）

import { storeFactOf, bestCitableSource } from './attrClassify.js';

/**
 * 由核查结果构建知识库词条草稿
 * @param {Array} claims LLM 提取的断言 [{claim, entity, metric, time}]
 * @param {Array} ratings 评级结果 [{claim, rating, evidence, correction, sources, fromKB}]
 * @param {Array} searchResults 每条断言的检索结果 [{claim, results:[...]}]
 * @returns {Object|null} 草稿 card（title/facts/references），无有效内容返回 null
 */
export function buildDraftCard(claims, ratings, searchResults) {
  if (!Array.isArray(claims) || claims.length === 0) return null;
  const entity = (claims[0]?.entity || '').trim();
  if (!entity) return null;

  const today = new Date().toISOString().split('T')[0];

  // 每条断言生成一条事实，且必须经过**统一构造器 storeFactOf**——与查询链路的
  // 事实形态逐字段一致：label = 属性名（体重/熔点/作者…），value = 证据原文片段，
  // source = 可引用的真实页面，rating = 这条断言自己的评级。
  //
  // 历史形态（label = 整句断言，value = "纠错：…"/"属实：…"）有两个致命问题：
  //   ① 知识库复用靠属性词匹配 facts[].label，整句 label 结构上永远匹配不上
  //      → 查证链路的自动入库等于白存（用户实测：查证存进去的东西查不出来）；
  //   ② "纠错：…" 是模型生成的结论性文字，把它当"事实"入库违背
  //      "知识库绝不能有编造内容"的硬要求。
  const facts = claims.map((c, i) => {
    const sr = searchResults?.[i];
    const rt = ratings?.[i] || {};
    // 知识库已命中的断言：事实本来就在库里，无需重复入库。
    // （再存一次只会把库里的原文又拼一遍，产生近重复条目）
    if (rt.fromKB) return null;
    // 评级未完成的断言：evidence 是系统提示文案（"自动评级未完成（…）"），
    // 不是证据原文——不能当事实存进库。
    if (rt.ratingFailed) return null;
    const src = bestCitableSource(sr?.results);
    if (!src) return null;
    const f = storeFactOf({
      metric: c.metric || '',
      entity: c.entity || entity,
      evidence: rt.evidence || '',
      source: src,
      rating: rt.rating || 'medium',
      verifiedAt: today,
    });
    if (!f) return null;
    return { key: `fact_${i}`, ...f, time: c.time || '' };
  }).filter(Boolean);

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

/**
 * 由"逐条评级 + 逐条检索结果"构造**按实体分组**的入库卡片（部分入库用）。
 * 只有评级为 high 且能挑出可引用来源的断言才会变成事实点。
 * 事实形态同样统一走 storeFactOf，与 buildDraftCard 完全一致。
 * @returns {{cards:Array<{card:object, facts:Array, refs:Array, title:string}>, considered:number}}
 */
export function buildStoreCardsByEntity(ratings, searchResults, fallbackTitle = '') {
  const byEntity = new Map();
  let considered = 0;
  (ratings || []).forEach((rt, i) => {
    if (!rt || rt.rating !== 'high' || rt.fromKB || rt.ratingFailed) return;
    considered++;
    const sr = searchResults?.[i];
    const results = (sr?.results || []).filter(r => r && r.url);
    const src = bestCitableSource(results);
    if (!src) return;
    const rt2 = rt.claim || {};
    const ent = String(rt2.entity || fallbackTitle || '').trim();
    if (!ent) return;
    const f = storeFactOf({
      metric: rt2.metric || '',
      entity: ent,
      evidence: rt.evidence || '',
      source: src,
      rating: 'high',
    });
    if (!f) return;
    if (!byEntity.has(ent)) byEntity.set(ent, { facts: [], refs: [] });
    const bucket = byEntity.get(ent);
    bucket.facts.push({ key: `fact_${bucket.facts.length}`, ...f, time: rt2.time || '' });
    for (const r of results) {
      bucket.refs.push({ name: r.title, url: r.url, official_score: r.official_score || 0 });
    }
  });

  const cards = [];
  for (const [ent, bucket] of byEntity) {
    // references 去重（按 url），最多 5 条；事实自身的来源也算进去
    const seenRef = new Set();
    const uniqRefs = [];
    for (const r of bucket.refs) {
      if (!r.url || seenRef.has(r.url)) continue;
      seenRef.add(r.url);
      uniqRefs.push(r);
      if (uniqRefs.length >= 5) break;
    }
    for (const f of bucket.facts) {
      if (f.source?.url && !seenRef.has(f.source.url)) {
        seenRef.add(f.source.url);
        uniqRefs.push({ name: f.source.name, url: f.source.url, official_score: f.source.official_score || 0 });
      }
    }
    if (bucket.facts.length === 0) continue;
    cards.push({
      title: ent,
      card: { title: ent, aliases: [], category: 'auto', facts: bucket.facts, references: uniqRefs },
      facts: bucket.facts,
      refs: uniqRefs,
    });
  }
  return { cards, considered };
}
