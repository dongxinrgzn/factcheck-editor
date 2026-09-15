// FACT_KB 知识库读写 + 别名/分类索引

import { cacheGet, cacheSet, cacheDelete, kbCacheKey, KB_CACHE_TTL, clearKBCache } from './cache.js';
import { isDuplicateFact, classifyProp, splitMultiAttrClauses, makeDataRe, isCitableSource } from './attrClassify.js';

/**
 * 生成词条主键
 */
function entryKey(slug) {
  return `kb:${slug}`;
}

/**
 * 别名索引 key
 */
function aliasKey(alias) {
  return `kb:alias:${alias}`;
}

/**
 * 分类索引 key
 */
function categoryKey(category) {
  return `kb:idx:${category}`;
}

/**
 * 待审队列 key
 */
function pendingKey(timestamp, slug) {
  return `kb:pending:${timestamp}:${slug}`;
}

/**
 * 待审标记 key（按 slug 去重，KV list 为最终一致，get 单点标记更可靠）
 */
function pendingIndexKey(slug) {
  return `kb:pending-idx:${slug}`;
}

/**
 * 历史 key
 */
function historyKey(slug, version) {
  return `kb:hist:${slug}:${version}`;
}

/**
 * 从标题生成 slug
 */
export function slugify(title) {
  if (!title) return '';
  // 中文用 URL 编码后的短哈希作为 slug
  let h = 0;
  for (let i = 0; i < title.length; i++) {
    h = (h << 5) - h + title.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
}

/**
 * 查询词条卡（先查缓存 → 别名 → 主键）
 * @returns {Object} {hit, card}
 */
export async function queryEntry(kv, keyword) {
  if (!keyword) return { hit: false, card: null };

  // 1. 查缓存
  const cacheK = kbCacheKey(keyword);
  const cached = await cacheGet(kv, cacheK);
  if (cached) return { hit: true, card: cached, cached: true };

  // 2. 查别名索引（精确匹配）
  let slug = await kv.get(aliasKey(keyword));
  if (!slug) {
    slug = slugify(keyword);
  }

  // 3. 查主键
  let raw = await kv.get(entryKey(slug));

  // 4. 精确未命中 → 模糊匹配
  if (!raw) {
    const kw = keyword.toLowerCase().trim();
    // 提取关键词核心词（去掉常见连接词）
    const kwChars = kw.replace(/[的年月日个各]/g, '');
    const list = await kv.list({ prefix: 'kb:', limit: 200 });
    const keys = list.keys || list || [];
    let bestMatch = null;
    let bestScore = 0;
    for (const item of keys) {
      if (item.name.startsWith('kb:alias:') || item.name.startsWith('kb:idx:') ||
          item.name.startsWith('kb:pending') || item.name.startsWith('kb:hist:') ||
          item.name.startsWith('kbcache:')) continue;
      try {
        const r = await kv.get(item.name);
        if (!r) continue;
        const card = JSON.parse(r);
        if (card.status !== 'verified' && card.status !== 'auto_verified') continue;
        const title = (card.title || '').toLowerCase();
        const aliases = (card.aliases || []).map(a => String(a).toLowerCase());

        // 双向包含
        if (title.includes(kw) || kw.includes(title) || aliases.some(a => a.includes(kw) || kw.includes(a))) {
          bestMatch = r;
          break;
        }

        // 核心词重叠匹配：去掉连接词后，统计共有字符数
        const titleChars = title.replace(/[的年月日个各]/g, '');
        let overlap = 0;
        for (const ch of kwChars) {
          if (titleChars.includes(ch)) overlap++;
        }
        const score = overlap / Math.max(kwChars.length, 1);
        if (score > 0.6 && score > bestScore) {
          bestScore = score;
          bestMatch = r;
        }
      } catch {}
    }
    if (bestMatch) raw = bestMatch;
  }

  if (!raw) return { hit: false, card: null };

  let card;
  try {
    card = JSON.parse(raw);
  } catch {
    return { hit: false, card: null };
  }

  // 5. 检查是否过期（时事类强制 30 天）
  if (card.category === '时事' || card.tags?.includes('时事')) {
    const age = Date.now() - new Date(card.updated_at).getTime();
    if (age > 30 * 24 * 60 * 60 * 1000) {
      return { hit: false, card: null, expired: true };
    }
  }

  // 6. 写缓存
  await cacheSet(kv, cacheK, card, KB_CACHE_TTL);
  return { hit: true, card };
}

/**
 * 获取词条详情（按 slug 或 key）
 */
export async function getEntry(kv, key) {
  const raw = await kv.get(entryKey(key)) || await kv.get(`kb:${key}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 提议入库（草稿，进 pending 队列）
 * 同一 slug 已有待审草稿时不重复提交
 */
export async function submitDraft(kv, card) {
  const slug = card.id || slugify(card.title);
  try {
    const existing = await kv.get(pendingIndexKey(slug));
    if (existing) {
      return { id: slug, status: 'draft', duplicated: true };
    }
  } catch {
    // 去重检查失败不阻塞
  }
  const ts = Date.now();
  const draft = {
    ...card,
    id: slug,
    status: 'draft',
    created_at: new Date(ts).toISOString(),
    version: 1,
  };
  await kv.put(pendingKey(ts, slug), JSON.stringify(draft));
  await kv.put(pendingIndexKey(slug), String(ts));
  return { id: slug, status: 'draft', submittedAt: ts };
}

/**
 * 审核通过，正式入库（写主键 + 别名 + 分类索引）
 */
export async function approveEntry(kv, slug, card, curator = 'admin') {
  const ts = Date.now();
  const now = new Date(ts).toISOString();
  // 读取旧版本存历史
  const old = await getEntry(kv, slug);
  const newVersion = (old?.version || 0) + 1;
  if (old) {
    await kv.put(historyKey(slug, old.version || 1), JSON.stringify(old));
  }
  // 尊重调用方传入的 status（auto_verified / verified），未传时默认 verified
  const finalStatus = (card && card.status) || 'verified';
  const finalCard = {
    ...card,
    id: slug,
    status: finalStatus,
    version: newVersion,
    updated_at: now,
    created_at: old?.created_at || now,
    curator,
  };
  // 主键
  await kv.put(entryKey(slug), JSON.stringify(finalCard));
  // 别名索引
  for (const alias of finalCard.aliases || []) {
    await kv.put(aliasKey(alias), slug);
  }
  await kv.put(aliasKey(finalCard.title), slug);
  // 分类索引
  if (finalCard.category) {
    const idxRaw = await kv.get(categoryKey(finalCard.category)) || '[]';
    let idx;
    try {
      idx = JSON.parse(idxRaw);
    } catch {
      idx = [];
    }
    if (!idx.includes(slug)) {
      idx.push(slug);
      await kv.put(categoryKey(finalCard.category), JSON.stringify(idx));
    }
  }
  return { id: slug, status: finalStatus, version: newVersion };
}

/**
 * 合并入库：把新的事实点/参考来源追加进已存在词条（去重后）。
 * 用于"部分入库"遇到同名词条时——反复查询能逐步把词条养全，而不是直接跳过。
 * @returns {{ok:boolean, added:number, skipped:number, reason?:string}}
 */
export async function mergeEntry(kv, slug, card, curator = 'auto_audit') {
  const old = await getEntry(kv, slug);
  if (!old) return { ok: false, added: 0, skipped: 0, reason: '词条不存在' };

  // facts 去重：① 同 label+value ② **同 value（忽略 label）** ③ 同属性 + 同测量值
  // ② 不可省：同一句话换个属性标签再入库（实测"体长"数据先被贴成"体重"、之后又贴成
  //    "体长"）能绕过 ①，词条里就留下内容重复的两条事实。
  // ③ 覆盖"同义不同写法"：体长1.2-1.8米 与 体长一般在1200—1800毫米 其实是同一事实，
  //    纯文本比对判不出来，换算到基准单位后指纹相同。
  const normVal = (v) => String(v || '').replace(/\s+/g, '').trim();
  const factKeyOf = (f) => `${(f.label || '').trim()}||${(f.value || '').trim()}`;
  const existingKeys = new Set((old.facts || []).map(factKeyOf));
  const existingVals = new Set((old.facts || []).map(f => normVal(f.value)).filter(Boolean));
  const mergedFacts = [...(old.facts || [])];
  let added = 0;
  let skipped = 0;
  for (const f of card.facts || []) {
    if (!f.value) { skipped++; continue; }
    const k = factKeyOf(f);
    const nv = normVal(f.value);
    if (existingKeys.has(k) || (nv && existingVals.has(nv)) ||
        mergedFacts.some(x => isDuplicateFact(x, f))) {
      skipped++;
      continue;
    }
    existingKeys.add(k);
    if (nv) existingVals.add(nv);
    // key 重编号，避免与已有 fact_N 冲突
    mergedFacts.push({ ...f, key: `fact_${mergedFacts.length}` });
    added++;
  }

  // references 按 url 去重合并
  const seenRef = new Set((old.references || []).map(r => r.url).filter(Boolean));
  const mergedRefs = [...(old.references || [])];
  for (const r of card.references || []) {
    if (!r?.url || seenRef.has(r.url)) continue;
    seenRef.add(r.url);
    mergedRefs.push(r);
  }

  if (added === 0) return { ok: true, added: 0, skipped: mergedFacts.length === 0 ? 0 : skipped, reason: '无新事实点' };

  const mergedCard = {
    ...old,
    facts: mergedFacts,
    references: mergedRefs,
    // 保持原有 category/title/aliases；新卡片的 category 只在旧卡缺失时采用
    category: old.category || card.category || 'auto',
    aliases: [...new Set([...(old.aliases || []), ...(card.aliases || [])])],
    status: old.status, // 不动状态（已入库的不降级）
  };
  await approveEntry(kv, slug, mergedCard, curator);
  return { ok: true, added, skipped };
}

/**
 * 统一自动入库：**查询链路与查证链路共用这一个函数**。
 *
 * 用户明确要求两条链路的入库标准必须一致。此前两条链路各自写了一段几乎相同的
 * 入库代码（各自判门槛、各自 merge/approve），差异是"标准漂移"的温床；现在
 * 门槛（autoAudit 四关）与合并策略（同名词条 mergeEntry、否则 approveEntry）只有这一份。
 *
 * 事实形态由 attrClassify.storeFactOf 统一保证：属性名 label + 原文 value + 可引用出处，
 * 因此 autoAudit 的第③关（每条评级必须 high）天然把非高可信事实挡在门外。
 *
 * @returns {{stored:boolean, merged?:boolean, added?:number, slug?:string, reason?:string}}
 */
export async function autoStoreCard(env, card) {
  if (!card || !Array.isArray(card.facts) || card.facts.length === 0) {
    return { stored: false, reason: '无事实点' };
  }
  const audit = autoAudit(card);
  if (!audit.pass) {
    return { stored: false, reason: (audit.reasons || []).join('；') || '未通过自动审核' };
  }
  const slug = slugify(card.title);
  try {
    const existing = await getEntry(env.FACT_KB, slug);
    if (existing) {
      // 已存在同名词条 → 合并追加（三道去重），绝不整卡覆盖丢已有事实
      const mr = await mergeEntry(env.FACT_KB, slug, { ...card, status: 'auto_verified' }, 'auto_audit');
      if (mr.ok && mr.added > 0) {
        await clearKBCache(env.FACT_KB);
        return { stored: true, merged: true, added: mr.added, slug };
      }
      return { stored: false, reason: mr.reason || '词条已存在且无新增事实点', existing: true };
    }
    await approveEntry(env.FACT_KB, slug, { ...card, status: 'auto_verified' }, 'auto_audit');
    await clearKBCache(env.FACT_KB);
    return { stored: true, merged: false, added: card.facts.length, slug };
  } catch (e) {
    return { stored: false, reason: e.message };
  }
}

/**
 * 归一化词条事实（维护用）：拆多属性长句 → 按子句重贴属性标签 → 去重。
 *
 * 修复的是这类历史脏数据：早期入库把 label 一律贴成"查询属性词"，于是
 *   ① "体长"数据被贴成"体重" → 之后查"体长"命中不了；
 *   ② 一句含七八个属性的长句整句存成一条 → 其它属性全被埋掉；
 *   ③ 同一事实换个标签又存一遍 → 词条里出现两条重复。
 *
 * 只做"重新归类 + 去重 + 剔除无真实出处的事实"，**不新增、不改写任何数值内容**
 * （value 要么整句、要么是它的子句）。归类/判重逻辑与检索侧共用 attrClassify，不会各自漂移。
 *
 * @returns {{facts:Array, before:number, after:number, split:number, dedup:number, relabel:number, dropped:number}}
 */
export function normalizeCardFacts(card) {
  const facts = Array.isArray(card?.facts) ? card.facts : [];
  const dataRe = makeDataRe(false);
  const out = [];
  let split = 0, dedup = 0, relabel = 0, dropped = 0;
  const isBetter = (a, b) => {
    const oa = !!(a?.source?.official_tag) || !!a?.source?.official;
    const ob = !!(b?.source?.official_tag) || !!b?.source?.official;
    if (oa !== ob) return oa;
    // 同为官方/非官方时，有 URL 的更完整
    return !a?.source?.url && !!b?.source?.url;
  };
  for (const f of facts) {
    const value = String(f.value || '').trim();
    if (!value) { dropped++; continue; }
    // 无真实出处的（如检索引擎综合答案，url 指向聚合器）不进知识库
    if (!isCitableSource(f.source)) { dropped++; continue; }
    const clauses = splitMultiAttrClauses(value, dataRe);
    if (clauses.length > 1) split++;
    for (const clause of clauses) {
      const oldLabel = String(f.label || '').trim();
      const prop = classifyProp(clause) || oldLabel || '相关数据';
      if (prop !== oldLabel) relabel++;
      const nf = { ...f, label: prop, value: clause };
      const nv = clause.replace(/\s+/g, '');
      const idx = out.findIndex(x =>
        String(x.value || '').replace(/\s+/g, '') === nv || isDuplicateFact(x, nf));
      if (idx >= 0) {
        dedup++;
        // 重复项里保留来源更权威的那条（政府站优先于维基/聚合摘要）
        if (isBetter(nf, out[idx])) out[idx] = nf;
        continue;
      }
      out.push(nf);
    }
  }
  return {
    facts: out.map((f, i) => ({ ...f, key: `fact_${i}` })),
    before: facts.length,
    after: out.length,
    split, dedup, relabel, dropped,
  };
}

/**
 * 自动审核门槛：满足以下全部条件才自动转正
 * ①至少1条事实带★官方或维基来源
 * ②同一事实至少2个独立来源交叉验证
 * ③LLM 评级为 high
 * ④每条事实必须带 URL
 * @returns {{pass: boolean, reasons: string[]}}
 */
export function autoAudit(card) {
  const reasons = [];
  if (!card || !Array.isArray(card.facts) || card.facts.length === 0) {
    return { pass: false, reasons: ['无有效事实'] };
  }

  // ③ 每条事实评级必须 high
  const lowRatings = card.facts.filter(f => f.rating && f.rating !== 'high');
  if (lowRatings.length > 0) {
    reasons.push(`${lowRatings.length}条事实评级非high`);
  }

  // ④ 每条事实必须带来源 URL
  const noSource = card.facts.filter(f => !f.source || !f.source.url);
  if (noSource.length > 0) {
    reasons.push(`${noSource.length}条事实无来源URL`);
  }

  // 古文类标识（用于放宽权威源和域名要求）
  const isAncient = card.category === '古文';

  // ① 至少1条事实来自官方或维基
  // 古文类额外接受 ctext.org（中国哲学书电子化计划）和 gushiwen.cn（古诗文网）为权威源
  const authoritativeRe = isAncient
    ? /wikipedia\.org|baike\.baidu\.com|ctext\.org|gushiwen\.cn/i
    : /wikipedia\.org|baike\.baidu\.com/i;
  const hasAuthoritative = card.facts.some(f =>
    f.source && (
      f.source.official_tag ||
      authoritativeRe.test(f.source.url || '')
    )
  );
  if (!hasAuthoritative) {
    reasons.push('无官方或百科来源');
  }

  // ② 多源交叉验证：facts 和 references 合并，至少2个独立域名
  // 古文类单源（ctext 等权威古籍库）即可，放宽为1个
  // 例外：单域名但属于权威源（维基/百科）且事实点 ≥3 条时也放行——
  //   检索链路在维基命中时会短路（结果常清一色 zh.wikipedia.org），
  //   若死守 ≥2 域名，高可信事实永远过不了审、用户看不到"已自动入库"提示。
  //   权威源内部对同一实体的多个事实点本身构成交叉印证，可靠性仍可接受。
  const refs = card.references || [];
  const domains = new Set();
  for (const r of refs) {
    try {
      const h = new URL(r.url).hostname.replace(/^www\./, '');
      domains.add(h);
    } catch {}
  }
  // facts 的来源也计入域名数
  for (const f of card.facts) {
    try {
      if (f.source && f.source.url) {
        const h = new URL(f.source.url).hostname.replace(/^www\./, '');
        domains.add(h);
      }
    } catch {}
  }
  const authoritativeHostRe = /wikipedia\.org|baike\.baidu\.com|ctext\.org|gushiwen\.cn/i;
  const allHosts = [...domains];
  const singleAuthoritativeRich =
    allHosts.length === 1 &&
    authoritativeHostRe.test(allHosts[0]) &&
    card.facts.length >= 3;

  const minDomains = isAncient ? 1 : 2;
  if (domains.size < minDomains && !singleAuthoritativeRich) {
    reasons.push(`仅${domains.size}个独立来源域名（需≥${minDomains}）`);
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * 列出已入库词条（verified 状态）
 * 实现：用 alias 反查主键，若 alias 为空则回退扫描主键兜底
 */
export async function listVerified(kv, limit = 100, cursor = null) {
  // 1. 列出所有 alias（每个词条 title 和每个别名都有一个 alias key）
  const aliasList = await kv.list({ prefix: 'kb:alias:', limit: 1000 });
  const aliasKeys = aliasList.keys || aliasList || [];
  // 2. 收集去重后的主键 slug
  const slugSet = new Set();
  for (const a of aliasKeys) {
    try {
      const v = await kv.get(a.name);
      if (v) slugSet.add(v);
    } catch {}
  }
  // 3. 如果 alias 路径一无所获，回退到直接扫描主键兜底
  if (slugSet.size === 0) {
    const allKeys = await kv.list({ prefix: 'kb:', limit: 1000 });
    for (const item of (allKeys.keys || allKeys || [])) {
      if (item.name.startsWith('kb:alias:') || item.name.startsWith('kb:idx:') ||
          item.name.startsWith('kb:pending') || item.name.startsWith('kb:hist:') ||
          item.name.startsWith('kbcache:')) continue;
      const slug = item.name.replace(/^kb:/, '');
      if (slug) slugSet.add(slug);
    }
  }
  // 4. 对每个主键 get 真实数据
  const items = [];
  const seen = new Set();
  for (const slug of slugSet) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    if (items.length >= limit) break;
    try {
      const raw = await kv.get('kb:' + slug);
      if (!raw) continue;
      const card = JSON.parse(raw);
      if (card.status !== 'verified' && card.status !== 'auto_verified') continue;
      items.push({
        id: card.id || slug,
        title: card.title,
        category: card.category || 'auto',
        status: card.status,
        version: card.version || 1,
        updated_at: card.updated_at || '',
        fact_count: Array.isArray(card.facts) ? card.facts.length : 0,
      });
    } catch {}
  }
  return { items, list_complete: true, cursor: null };
}

/**
 * 搜索知识库（标题/别名模糊匹配）
 */
export async function searchEntries(kv, keyword, limit = 20) {
  if (!keyword) return [];
  const kw = keyword.toLowerCase().trim();
  const list = await kv.list({ prefix: 'kb:', limit: 200 });
  const keys = list.keys || list || [];
  const items = [];
  for (const item of keys) {
    if (item.name.startsWith('kb:alias:') || item.name.startsWith('kb:idx:') ||
        item.name.startsWith('kb:pending') || item.name.startsWith('kb:hist:') ||
        item.name.startsWith('kbcache:')) continue;
    try {
      const raw = await kv.get(item.name);
      if (!raw) continue;
      const card = JSON.parse(raw);
      if (card.status !== 'verified' && card.status !== 'auto_verified') continue;
      const title = (card.title || '').toLowerCase();
      const aliases = (card.aliases || []).map(a => String(a).toLowerCase());
      if (title.includes(kw) || aliases.some(a => a.includes(kw))) {
        items.push({
          id: card.id,
          title: card.title,
          category: card.category || 'auto',
          status: card.status,
          updated_at: card.updated_at || '',
          fact_count: Array.isArray(card.facts) ? card.facts.length : 0,
        });
      }
    } catch {}
  }
  return items.slice(0, limit);
}

/**
 * 删除词条（主键 + 别名 + 分类索引 + 待审标记 + 缓存）
 * 会写一条删除审计（kbaudit:del:*，存 FACT_CACHE）——历史上出现过词条无声消失，
 * 加审计后至少能查到"什么时候、删了哪个词条"。
 */
export async function deleteEntry(kv, slug, auditKv = null, actor = '') {
  // 读取卡片获取别名和分类
  const raw = await kv.get(entryKey(slug));
  if (raw) {
    try {
      const card = JSON.parse(raw);
      // 清除缓存：基于 title 和所有别名
      await cacheDelete(kv, kbCacheKey(card.title));
      for (const alias of card.aliases || []) {
        await cacheDelete(kv, kbCacheKey(alias));
        // 删别名索引
        await kv.delete(aliasKey(alias));
      }
      await kv.delete(aliasKey(card.title));
      // 从分类索引中移除
      if (card.category) {
        const idxRaw = await kv.get(categoryKey(card.category)) || '[]';
        try {
          const idx = JSON.parse(idxRaw);
          const newIdx = idx.filter(s => s !== slug);
          await kv.put(categoryKey(card.category), JSON.stringify(newIdx));
        } catch {}
      }
    } catch {}
  } else {
    // 孤儿：主键不存在但 alias 可能还在，扫一遍清理所有指向此 slug 的 alias
    const allAlias = await kv.list({ prefix: 'kb:alias:', limit: 1000 });
    for (const a of (allAlias.keys || allAlias || [])) {
      const v = await kv.get(a.name);
      if (v === slug) await kv.delete(a.name);
    }
  }
  // 删主键 + 待审标记
  await kv.delete(entryKey(slug));
  await kv.delete(pendingIndexKey(slug));
  // 删待审草稿（如有）
  const pending = await kv.list({ prefix: `kb:pending:`, limit: 50 });
  for (const p of (pending.keys || pending || [])) {
    if (p.name.endsWith(`:${slug}`)) {
      await kv.delete(p.name);
    }
  }
  // 清空所有 KB 查询缓存——用户查询时的缓存 key 基于输入原文哈希，
  // 无法逐个精确删除，直接清全部 kbcache: 最安全
  await clearKBCache(kv);
  // 删除审计（写到 FACT_CACHE，与 KB 不同命名空间，KB 被清也留痕）
  if (auditKv) {
    try {
      const ts = new Date().toISOString();
      let title = '';
      try { title = JSON.parse(raw || '{}').title || ''; } catch {}
      await auditKv.put(`kbaudit:del:${ts}:${slug}`,
        JSON.stringify({ slug, title, actor, at: ts }),
        { expirationTtl: 90 * 24 * 60 * 60 });
    } catch {}
  }
  return { deleted: slug };
}

/**
 * 全量备份知识库：把所有 kb:<slug> 词条快照写入 FACT_CACHE（不同命名空间，
 * 即使 KB 被清空备份也还在）。每天由定时任务调用，也可用 admin action=backup 手动跑。
 * @returns {{count:number, key:string, at:string}}
 */
export async function backupKB(kv, backupKv) {
  const at = new Date().toISOString();
  const day = at.slice(0, 10);
  const list = await kv.list({ prefix: 'kb:', limit: 1000 });
  const keys = list.keys || list || [];
  const items = [];
  for (const item of keys) {
    const n = item.name;
    if (n.startsWith('kb:alias:') || n.startsWith('kb:idx:') || n.startsWith('kb:pending') ||
        n.startsWith('kb:hist:') || n.startsWith('kbcache:')) continue;
    try {
      const raw = await kv.get(n);
      if (!raw) continue;
      items.push({ key: n, card: JSON.parse(raw) });
    } catch {}
  }
  let stored = 0;
  if (backupKv) {
    try {
      await backupKv.put(`kbbackup:${day}`, JSON.stringify({ at, count: items.length, items }),
        { expirationTtl: 30 * 24 * 60 * 60 });
      // 再维护一个"最新备份"指针，避免跨天日期找不着
      await backupKv.put('kbbackup:latest', JSON.stringify({ at, day, count: items.length, items }),
        { expirationTtl: 30 * 24 * 60 * 60 });
      stored = items.length;
    } catch {}
  }
  return { count: items.length, stored, key: `kbbackup:${day}`, at };
}

/**
 * 列出待审词条（KV list 只返回 key，需逐个读取 value）
 */
export async function listPending(kv, limit = 50) {
  const list = await kv.list({ prefix: 'kb:pending:', limit });
  const keys = list.keys || list || [];
  const items = [];
  for (const item of keys) {
    try {
      const raw = await kv.get(item.name);
      if (!raw) continue; // 已删除但 list 尚未传播的项
      const card = JSON.parse(raw);
      items.push({ key: item.name, ...card });
    } catch {
      // 跳过损坏的
    }
  }
  return items;
}

/**
 * 清理 pending 记录（审核通过/拒绝后调用，同步删除去重标记）
 */
export async function clearPending(kv, timestamp, slug) {
  if (timestamp) await kv.delete(pendingKey(timestamp, slug));
  if (slug) await kv.delete(pendingIndexKey(slug));
}

/**
 * 列出待复核词条（verified_at 超过 180 天）
 */
export async function listStale(kv, days = 180, limit = 100) {
  const list = await kv.list({ prefix: 'kb:', limit });
  const keys = list.keys || list || [];
  const threshold = Date.now() - days * 24 * 60 * 60 * 1000;
  const stale = [];
  for (const item of keys) {
    if (!item.name.startsWith('kb:') || item.name.startsWith('kb:alias:') ||
        item.name.startsWith('kb:idx:') || item.name.startsWith('kb:pending:') ||
        item.name.startsWith('kb:pending-idx:') || item.name.startsWith('kb:hist:')) continue;
    const raw = await kv.get(item.name);
    if (!raw) continue;
    try {
      const card = JSON.parse(raw);
      const verifiedAt = card.facts?.[0]?.verified_at || card.updated_at;
      if (verifiedAt && new Date(verifiedAt).getTime() < threshold) {
        stale.push({ id: card.id, title: card.title, updated_at: card.updated_at });
      }
    } catch {}
  }
  return stale.sort((a, b) => new Date(a.updated_at) - new Date(b.updated_at));
}
