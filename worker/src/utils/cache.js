// FACT_CACHE 读写（KV 缓存）

const DEFAULT_TTL = 30 * 24 * 60 * 60;          // 30 天
const ANCIENT_TTL = 90 * 24 * 60 * 60;          // 古籍原文 90 天
const KB_CACHE_TTL = 24 * 60 * 60;              // 知识库命中缓存 1 天
// 网页检索结果缓存 1 天：检索源时好时坏（DDG 反爬/SearXNG 实例失效/维基抖动），
// 30 天 TTL 会把某次"只剩官方站"的退化结果固化近一个月（踩过：维基结果消失、
// 只剩林业局官网）。1 天足以抗抖动，又不会固化退化状态。
const SEARCH_TTL = 24 * 60 * 60;
// LLM 评级结果缓存 3 天：评级是确定性计算（同断言+同证据 → 同结果），
// 重复查证同一条说法时直接复用，省 3-5s 的 LLM 调用。评级质量不受影响。
const RATING_TTL = 3 * 24 * 60 * 60;
// 断言提取（LLM 拆句）缓存 1 天：同一段文本重复提交时跳过提取调用。
// 与检索缓存同周期——证据刷新后评级输入会变，提取结果本身不依赖证据。
const CLAIMS_TTL = 24 * 60 * 60;

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
 * 生成 LLM 评级缓存 key（断言 + 全部证据片段共同决定评级结果）
 */
export function ratingCacheKey(claim, evidence) {
  const evPart = (evidence || []).map(e => (e.snippet || e.text || '')).join('|');
  return 'rate:' + simpleHash((claim || '') + '##' + evPart);
}

/**
 * 生成断言提取缓存 key（原文 + 上下文）
 */
export function claimsCacheKey(text, context) {
  return 'clm:' + simpleHash((text || '') + '|' + (context || ''));
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
 * 注意：空数组/空字符串不写入。检索类缓存若把"0 结果"写进去，
 * 一次上游抖动就会让该查询在 TTL 内永远拿不到兜底机会（踩过这个坑）。
 */
export async function cacheSet(kv, key, value, ttl = DEFAULT_TTL) {
  if (!kv || !key || value == null) return;
  if (Array.isArray(value) && value.length === 0) return;
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

// FACT_CACHE 中"缓存"身份的键前缀。clearAllCache **只**清这些。
// 不能无前缀 list 全删：FACT_CACHE 里还存着 kbbackup:（知识库每日备份）
// 与 kbaudit:del:（删除审计）——它们是数据不是缓存，被"清缓存"顺带删掉
// 等于把保险和证据一起销毁（本地 KB 曾无声丢词条，这两样是唯一的兜底）。
const CACHE_PREFIXES = ['q:', 'anc:', 'rate:', 'clm:'];

/**
 * 清除所有缓存（仅 CACHE_PREFIXES 命中的条目，备份与审计不动）
 */
export async function clearAllCache(kv) {
  if (!kv) return { cleared: 0 };
  let cleared = 0;
  for (const prefix of CACHE_PREFIXES) {
    let cursor = null;
    // 分页：单次 list 上限 1000，超过一页的缓存要接着清，否则残留会一直命中
    do {
      let list;
      try {
        list = await kv.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      } catch { break; }
      const keys = list.keys || list || [];
      for (const item of keys) {
        try {
          await kv.delete(item.name);
          cleared++;
        } catch {}
      }
      if (list.list_complete === false && list.cursor) cursor = list.cursor;
      else cursor = null;
    } while (cursor);
  }
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

export { DEFAULT_TTL, ANCIENT_TTL, KB_CACHE_TTL, SEARCH_TTL, RATING_TTL, CLAIMS_TTL };
