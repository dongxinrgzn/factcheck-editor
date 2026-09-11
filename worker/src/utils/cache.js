// FACT_CACHE 读写（KV 缓存）

const DEFAULT_TTL = 30 * 24 * 60 * 60;          // 30 天
const ANCIENT_TTL = 90 * 24 * 60 * 60;          // 古籍原文 90 天
const KB_CACHE_TTL = 24 * 60 * 60;              // 知识库命中缓存 1 天

/**
 * 生成检索缓存 key
 */
export function searchCacheKey(query, extra = '') {
  const raw = 'q:' + (query || '') + '|' + (extra || '');
  return 'q:' + simpleHash(raw);
}

/**
 * 生成古籍缓存 key
 */
export function ancientCacheKey(text) {
  return 'anc:' + simpleHash(text || '');
}

/**
 * 生成知识库查询缓存 key
 * 注意：使用 kbcache: 前缀避免与词条主键 kb:${slug} 冲突
 */
export function kbCacheKey(keyword) {
  return 'kbcache:' + simpleHash(keyword || '');
}

/**
 * 读取缓存
 */
export async function cacheGet(kv, key) {
  if (!kv || !key) return null;
  try {
    const v = await kv.get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

/**
 * 写入缓存
 */
export async function cacheSet(kv, key, value, ttl = DEFAULT_TTL) {
  if (!kv || !key || value == null) return;
  try {
    await kv.put(key, JSON.stringify(value), { ttl });
  } catch (e) {
    // KV 写入失败不影响主流程
  }
}

/**
 * 删除缓存
 */
export async function cacheDelete(kv, key) {
  if (!kv || !key) return;
  try {
    await kv.delete(key);
  } catch (e) {
    // KV 删除失败不影响主流程
  }
}

/**
 * 清除所有缓存（FACT_CACHE 中的所有条目）
 */
export async function clearAllCache(kv) {
  if (!kv) return { cleared: 0 };
  let cleared = 0;
  try {
    const list = await kv.list({ limit: 1000 });
    const keys = list.keys || list || [];
    for (const item of keys) {
      try {
        await kv.delete(item.name);
        cleared++;
      } catch {}
    }
  } catch {}
  return { cleared };
}

/**
 * 清除知识库缓存（FACT_KB 中以 kbcache: 开头的缓存条目）
 */
export async function clearKBCache(kv) {
  if (!kv) return { cleared: 0 };
  let cleared = 0;
  try {
    const list = await kv.list({ prefix: 'kbcache:', limit: 1000 });
    const keys = list.keys || list || [];
    for (const item of keys) {
      try {
        await kv.delete(item.name);
        cleared++;
      } catch {}
    }
  } catch {}
  return { cleared };
}

/**
 * 简单哈希（非加密用途，仅用于 KV key 去重）
 */
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h = (h << 5) - h + c;
    h = h & h; // 转 32bit
  }
  return Math.abs(h).toString(36);
}

export { DEFAULT_TTL, ANCIENT_TTL, KB_CACHE_TTL };
