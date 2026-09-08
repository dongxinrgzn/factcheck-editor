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
function slugify(title) {
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

  // 2. 查别名索引
  let slug = await kv.get(aliasKey(keyword));
  if (!slug) {
    // 别名未命中，尝试直接作为 slug
    slug = slugify(keyword);
  }

  // 3. 查主键
  const raw = await kv.get(entryKey(slug));
  if (!raw) return { hit: false, card: null };

  let card;
  try {
    card = JSON.parse(raw);
  } catch {
    return { hit: false, card: null };
  }

  // 4. 检查是否过期（时事类强制 30 天）
  if (card.category === '时事' || card.tags?.includes('时事')) {
    const age = Date.now() - new Date(card.updated_at).getTime();
    if (age > 30 * 24 * 60 * 60 * 1000) {
      return { hit: false, card: null, expired: true };
    }
  }

  // 5. 写缓存
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
