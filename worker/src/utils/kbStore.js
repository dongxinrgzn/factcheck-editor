// FACT_KB 知识库读写 + 别名/分类索引

import { cacheGet, cacheSet, kbCacheKey, KB_CACHE_TTL } from './cache.js';

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
export async function queryEntry(kv, keyword, cacheKv = null) {
  if (!keyword) return { hit: false, card: null };
  // 查询缓存写到独立缓存库（FACT_CACHE），避免与知识库词条主键混淆
  const ck = cacheKv || kv;

  // 1. 查缓存
  const cacheK = kbCacheKey(keyword);
  const cached = await cacheGet(ck, cacheK);
  if (cached) return { hit: true, card: cached, cached: true };

  // 2. 查别名索引（精确匹配）
  let slug = await kv.get(aliasKey(keyword));
  if (!slug) {
    slug = slugify(keyword);
  }

  // 3. 查主键
  let raw = await kv.get(entryKey(slug));

  // 4. 精确未命中 → 模糊匹配（标题/别名/事实内容，bigram 二元词重叠）
  if (!raw) {
    const kw = keyword.toLowerCase().trim();
    // 去掉常见连接词/标点后的核心串
    const kwChars = kw.replace(/[的年月日个各吗呢啊是在有，。？?！!\s]/g, '');
    // 关键词中的长数字串（年份/数值，强信号）
    const kwNums = kw.match(/\d{3,}/g) || [];
    // 二元词集合
    const toBigrams = (s) => {
      const set = new Set();
      for (let i = 0; i < s.length - 1; i++) set.add(s[i] + s[i + 1]);
      return set;
    };
    const kwBigrams = toBigrams(kwChars);
    // kw 二元词在目标中的覆盖率
    const overlap = (target) => {
      if (kwBigrams.size === 0) return 0;
      const tb = toBigrams(target);
      let hit = 0;
      for (const b of kwBigrams) if (tb.has(b)) hit++;
      return hit / kwBigrams.size;
    };
    // 目标（标题）二元词被 kw 覆盖的比例（短标题命中长查询时用）
    const coverage = (target) => {
      const tb = toBigrams(target);
      if (tb.size === 0) return 0;
      let hit = 0;
      for (const b of tb) if (kwBigrams.has(b)) hit++;
      return hit / tb.size;
    };

    const list = await kv.list({ prefix: 'kb:', limit: 200 });
    const keys = list.keys || list || [];
    let bestMatch = null;
    let bestScore = 0;
    for (const item of keys) {
      if (item.name.startsWith('kb:alias:') || item.name.startsWith('kb:idx:') ||
          item.name.startsWith('kb:pending') || item.name.startsWith('kb:hist:')) continue;
      try {
        const r = await kv.get(item.name);
        if (!r) continue;
        const card = JSON.parse(r);
        if (card.status !== 'verified' && card.status !== 'auto_verified') continue;
        const title = (card.title || '').toLowerCase();
        const aliases = (card.aliases || []).map(a => String(a).toLowerCase());

        // 双向包含（标题/别名）→ 直接命中
        if (title.includes(kw) || kw.includes(title) || aliases.some(a => a.includes(kw) || kw.includes(a))) {
          bestMatch = r;
          bestScore = 1;
          break;
        }

        // 标题/别名 bigram 匹配（kw 覆盖率 与 标题覆盖率 取大，阈值 0.6）
        const titleChars = (title + ' ' + aliases.join(' ')).replace(/[的年月日个各吗呢啊是在有，。？?！!\s]/g, '');
        const tScore = Math.max(overlap(titleChars), coverage(titleChars));
        if (tScore >= 0.6) {
          if (tScore > bestScore) { bestScore = tScore; bestMatch = r; }
          continue;
        }

        // 事实内容匹配（label+value+metric）
        const content = (card.facts || [])
          .map(f => `${f.label || ''} ${f.value || ''} ${f.metric || ''}`)
          .join(' ')
          .toLowerCase();
        // 数字串精确命中（如查"1881年出生"命中含 1881 的卡片）→ 强信号
        if (kwNums.length > 0 && kwNums.some(n => content.includes(n))) {
          if (0.9 > bestScore) { bestScore = 0.9; bestMatch = r; }
          continue;
        }
        // 内容 bigram 覆盖（阈值 0.5，要求 kw 核心串≥4字）
        if (kwChars.length >= 4) {
          const cScore = overlap(content.replace(/[的年月日个各吗呢啊是在有，。？?！!\s]/g, ''));
          if (cScore >= 0.5 && cScore > bestScore) {
            bestScore = cScore;
            bestMatch = r;
          }
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

  // 6. 写缓存（写到独立缓存库）
  await cacheSet(ck, cacheK, card, KB_CACHE_TTL);
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
  const finalCard = {
    ...card,
    id: slug,
    status: 'verified',
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
  return { id: slug, status: 'verified', version: newVersion };
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

  // ① 至少1条事实来自官方或维基
  const hasAuthoritative = card.facts.some(f =>
    f.source && (
      f.source.official_tag ||                              // ★官方
      /wikipedia\.org|baike\.baidu\.com/i.test(f.source.url || '') // 维基/百科
    )
  );
  if (!hasAuthoritative) {
    reasons.push('无官方或百科来源');
  }

  // ② 多源交叉验证：references 中至少2个独立域名
  const refs = card.references || [];
  const domains = new Set();
  for (const r of refs) {
    try {
      const h = new URL(r.url).hostname.replace(/^www\./, '');
      domains.add(h);
    } catch {}
  }
  if (domains.size < 2) {
    reasons.push(`仅${domains.size}个独立来源域名（需≥2）`);
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * 列出已入库词条（verified 状态）
 */
export async function listVerified(kv, limit = 100, cursor = null) {
  const list = await kv.list({ prefix: 'kb:', limit, cursor });
  const keys = list.keys || list || [];
  const items = [];
  for (const item of keys) {
    // 跳过非主键（别名/索引/待审/历史）
    if (item.name.startsWith('kb:alias:') || item.name.startsWith('kb:idx:') ||
        item.name.startsWith('kb:pending') || item.name.startsWith('kb:hist:')) continue;
    try {
      const raw = await kv.get(item.name);
      if (!raw) continue;
      const card = JSON.parse(raw);
      if (card.status === 'verified' || card.status === 'auto_verified') {
        items.push({
          id: card.id,
          title: card.title,
          category: card.category || 'auto',
          status: card.status,
          version: card.version || 1,
          updated_at: card.updated_at || '',
          fact_count: Array.isArray(card.facts) ? card.facts.length : 0,
        });
      }
    } catch {}
  }
  return { items, list_complete: list.list_complete !== false, cursor: list.cursor || null };
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
        item.name.startsWith('kb:pending') || item.name.startsWith('kb:hist:')) continue;
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
 * 删除词条（主键 + 别名 + 分类索引 + 待审标记）
 */
export async function deleteEntry(kv, slug) {
  // 读取卡片获取别名和分类
  const raw = await kv.get(entryKey(slug));
  if (raw) {
    try {
      const card = JSON.parse(raw);
      // 删别名索引
      for (const alias of card.aliases || []) {
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
  return { deleted: slug };
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
