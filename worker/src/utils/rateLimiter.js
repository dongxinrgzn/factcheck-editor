// KV 限流 + 指数退避（复用 STORM 模式）

const RATE_LIMIT_TTL = 26 * 60 * 60; // 26 小时（跨日容错）

/**
 * 生成限流 key（按天）
 */
function rateLimitKey(userHash, dateStr) {
  return `rl:${userHash}:${dateStr}`;
}

/**
 * 生成今日日期字符串
 */
function todayStr() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * 简单哈希
 */
function simpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h = h & h;
  }
  return Math.abs(h).toString(36);
}

/**
 * 检查并递增限流计数
 * @returns {Object} {allowed: boolean, used: number, limit: number}
 */
export async function checkRateLimit(kv, clientIp, limit) {
  const key = rateLimitKey(simpleHash(clientIp), todayStr());
  const current = await kvGetNum(kv, key);
  if (current >= limit) {
    return { allowed: false, used: current, limit };
  }
  await atomicIncr(kv, key);
  return { allowed: true, used: current + 1, limit };
}

/**
 * 读取 KV 中的数字
 */
export async function kvGetNum(kv, key) {
  if (!kv || !key) return 0;
  try {
    const v = await kv.get(key);
    return v ? parseInt(v, 10) || 0 : 0;
  } catch {
    return 0;
  }
}

/**
 * 原子递增（KV 无原生 incr，用 read-modify-write 兜底）
 */
export async function atomicIncr(kv, key) {
  if (!kv || !key) return;
  try {
    const cur = (await kvGetNum(kv, key)) + 1;
    await kv.put(key, String(cur), { ttl: RATE_LIMIT_TTL });
  } catch {
    // 限流失败不阻塞请求
  }
}

/**
 * 指数退避重试包装
 * @param {Function} fn - 异步函数
 * @param {Object} opts - {retries, baseDelay}
 */
export async function withRetry(fn, opts = {}) {
  const { retries = 2, baseDelay = 1200 } = opts;
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        const delay = baseDelay * Math.pow(1.5, i);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export { RATE_LIMIT_TTL, todayStr, rateLimitKey, simpleHash };
