// 教材索引查询（v2 — master 索引单 KV 读取 + Isolate 内存缓存）
// 索引由 scripts/index-textbooks-v2.py 构建：
//   tb:master → {prefix_30chars: {b:书名, p:页码, t:原文}, ...}
//   tb:meta   → {book_count, sentence_count, last_updated, books: [...]}
//
// Worker: 首次请求读 tb:master（~860KB，Isolate 缓存后续 0 KV 读），
// 用户句子归一化 → 取前 30 字符 → 内存 Map 查找

// Isolate 级缓存（同实例内多请求共享，KV 只读一次）
let _masterCache = null;
let _masterLoadedAt = 0;
const MASTER_CACHE_TTL = 5 * 60 * 1000; // 5 分钟后重新加载（教材索引更新后自愈）

/**
 * 句子归一化（与 index-textbooks-v2.py 的 norm_sentence 完全一致）
 */
export function normForTextbook(s) {
  return String(s || '')
    .replace(/[，。；、：\u201c\u201d\u2018\u2019（）\[\]【】\s.\-,;:!?！？"'']/g, '');
}

/**
 * 加载教材主索引（Isolate 缓存）
 */
async function loadMaster(kv) {
  if (!kv) return null;
  const now = Date.now();
  if (_masterCache && (now - _masterLoadedAt) < MASTER_CACHE_TTL) {
    return _masterCache;
  }
  try {
    const raw = await kv.get('tb:master');
    if (!raw) return null;
    _masterCache = JSON.parse(raw);
    _masterLoadedAt = now;
    return _masterCache;
  } catch {
    return _masterCache; // 加载失败用旧缓存
  }
}

/**
 * 检查一段文本是否包含教材原句
 * @param {KVNamespace} kv - FACT_CACHE
 * @param {string} text - 用户输入
 * @returns {Promise<{hit:boolean, coverage:number, matches:Array}>}
 *   coverage = 命中句子数 / 总有效句子数
 */
export async function checkTextbookIndex(kv, text) {
  if (!kv || !text) return { hit: false, coverage: 0, matches: [] };

  const master = await loadMaster(kv);
  if (!master || Object.keys(master).length === 0) {
    return { hit: false, coverage: 0, matches: [] };
  }

  // 分句（与索引侧一致）
  const sentences = String(text)
    .replace(/\s+/g, '')
    .split(/[。；！？!?]+/)
    .map(s => s.trim())
    .filter(s => s.length >= 12 && s.length <= 300);

  if (sentences.length === 0) return { hit: false, coverage: 0, matches: [] };

  const matches = [];
  let checked = 0;

  for (const sent of sentences) {
    const normed = normForTextbook(sent);
    if (normed.length < 10) continue;
    checked++;

    // 双端匹配：首 30 字（从头引用）+ 尾 30 字（容忍头部混入章节标题）
    const headKey = normed.slice(0, 30);
    const tailKey = normed.length > 30 ? normed.slice(-30) : normed;
    const hit = master[headKey] || master[tailKey];
    if (hit) {
      matches.push({
        sentence: sent,
        book: hit.b || '',
        page: hit.p || 0,
        original: hit.t || '',
      });
    }
  }

  const coverage = checked > 0 ? matches.length / checked : 0;
  return {
    hit: matches.length > 0 && coverage >= 0.4,
    coverage: Number(coverage.toFixed(2)),
    matches,
  };
}

/**
 * 构造教材命中的 wholeMatch 对象
 */
export function textbookToWholeMatch(tbResult) {
  if (!tbResult || !tbResult.hit || !tbResult.matches.length) return null;
  const m = tbResult.matches[0];
  return {
    url: '',
    title: `${m.book}·第${m.page}页`,
    domain: 'textbook',
    coverage: tbResult.coverage,
    overlap: tbResult.matches.length,
    snippet: tbResult.matches.slice(0, 3).map(x => x.original).join('\n'),
    tier: 'textbook',
    isTextbook: true,
  };
}
