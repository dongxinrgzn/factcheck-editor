// 诗词库：KV 内置数据集（唐诗三百首 / 宋词三百首 / 诗经，共 ~950 篇）
// 索引由脚本构建（繁→简已预转换），存于 FACT_KB：
//   key = poetry:index:v1
//   每条：t=标题 a=作者 c=合集 ch=诗经章节 p=段落[] f=首20字(规范化) n=全文规范化(仅汉字)
// 匹配优先级：标题 → 全文/首句包含 → 二元组模糊（容忍"床前明月光/床前看月光"式版本差异）

const POETRY_KEY = 'poetry:index:v1';
let _indexCache = null;

/** 仅保留汉字（去标点/空白/数字/拉丁），用于文本比对 */
export function normCJK(s) {
  return String(s || '').replace(/[^\u4e00-\u9fff]/g, '');
}

/** 加载诗词库索引（isolate 内缓存一次，~630KB JSON） */
export async function loadPoetryIndex(env) {
  if (_indexCache) return _indexCache;
  try {
    const raw = await env.FACT_KB.get(POETRY_KEY);
    if (!raw) return null;
    _indexCache = JSON.parse(raw);
  } catch {
    _indexCache = null;
  }
  return _indexCache;
}

function bigramSet(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 查询串与某词条头部的二元组相似度 */
function simToEntry(ub, entry) {
  const eb = bigramSet(entry.n.slice(0, 50));
  let hit = 0;
  for (const g of ub) if (eb.has(g)) hit++;
  return hit / ub.size;
}

/**
 * 在诗词库中查找与 text 匹配的作品
 * @returns {null|{entry, mode: 'title'|'full'|'part'|'first-line'|'fuzzy', sim: number}}
 */
export async function lookupPoem(env, text) {
  const idx = await loadPoetryIndex(env);
  if (!idx || !text) return null;
  const u = normCJK(text);
  if (u.length < 6) return null;
  const ub = bigramSet(u.slice(0, 40));

  // ---- 1. 标题匹配：《X》----
  // 组诗（如"浪淘沙·其六"）标题有歧义：多候选时必须内容印证，否则放弃交给兜底
  const m = String(text).match(/《([^》]{2,40})》/);
  if (m) {
    const x = normCJK(m[1]);
    if (x.length >= 2) {
      const cands = [];
      for (const e of idx) {
        if (e.t === x) cands.push({ entry: e, mode: 'title', sim: 1 });
        else if (e.t.length >= 2 && x.includes(e.t)) cands.push({ entry: e, mode: 'title', sim: 0.9 });
        else if (e.t.includes(x)) cands.push({ entry: e, mode: 'title', sim: 0.85 });
      }
      if (cands.length === 1) return cands[0];
      if (cands.length > 1) {
        for (const c of cands) {
          // 印证：候选任一段落开头出现在用户文本，或头部二元组相似度过关
          const corr = (c.entry.p || []).some(p => {
            const pn = normCJK(p);
            return pn.length >= 6 && u.includes(pn.slice(0, 12));
          }) || (ub.size >= 4 && simToEntry(ub, c.entry) >= 0.6);
          if (corr) return { ...c, sim: Math.max(c.sim, 0.9) };
        }
        return null;
      }
    }
  }

  // ---- 2. 全文/首句包含 ----
  let best = null;
  const pick = (c) => { if (!best || c.sim > best.sim) best = c; };
  for (const e of idx) {
    if (e.n === u) return { entry: e, mode: 'full', sim: 1 };
    if (u.length >= 10 && e.n.includes(u)) pick({ entry: e, mode: 'part', sim: u.length / e.n.length });
    if (e.f.length >= 6 && u.includes(e.f)) pick({ entry: e, mode: 'first-line', sim: 0.95 });
  }
  if (best) return best;

  // ---- 3. 二元组模糊（版本差异容忍，阈值 0.72）----
  if (ub.size < 4) return null;
  let fuzzy = null;
  for (const e of idx) {
    const sim = simToEntry(ub, e);
    if (sim >= 0.72 && (!fuzzy || sim > fuzzy.sim)) fuzzy = { entry: e, mode: 'fuzzy', sim };
  }
  return fuzzy;
}
