// 教材索引查询 v3 — 按学科拆分存储 + Isolate 缓存
// 索引由 scripts/index-textbooks-full.py 构建：
//   tb:subj:{学科} → {prefix: {bi:book_id, p:page}}
//   tb:books       → {book_id: {t:title, s:stage, sub:subject, v:version, g:grade}}
//   tb:dir         → {学科: entry_count}
//
// Worker: 先查最可能的相关学科（化学→物理→数学→...），命中即返回

// Isolate 级缓存
let _dirCache = null;
let _subjectCaches = {};  // {subject: index}
let _booksCache = null;
let _loadedAt = 0;
const CACHE_TTL = 5 * 60 * 1000;

// 学科查询优先级（校次场景化学最常用）
const SUBJECT_PRIORITY = ['化学', '物理', '数学', '语文', '生物', '英语', '历史', '地理', '科学', '道法'];

export function normForTextbook(s) {
  return String(s || '')
    .replace(/[，。；、：\u201c\u201d\u2018\u2019（）\[\]【】\s.\-,;:!?！？"'']/g, '');
}

async function kvGetJson(kv, key) {
  if (!kv || !key) return null;
  try {
    const raw = await kv.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.log('[TB-INDEX] kvGetJson error:', key, e.message || String(e).slice(0, 100));
    return null;
  }
}

async function ensureLoaded(kv) {
  const now = Date.now();
  if (_dirCache && (now - _loadedAt) < CACHE_TTL) return true;
  _dirCache = await kvGetJson(kv, 'tb:dir');
  if (!_dirCache) return false;
  _loadedAt = now;
  _subjectCaches = {};
  _booksCache = null;
  return true;
}

async function getSubjectIndex(kv, subject) {
  if (_subjectCaches[subject]) return _subjectCaches[subject];

  // 尝试分块格式（tb:subj:{subject}:{chunk_idx}）
  const meta = await kvGetJson(kv, `tb:subj:${subject}:_meta`);
  if (meta && meta.chunks > 0) {
    const merged = {};
    for (let ci = 0; ci < meta.chunks; ci++) {
      const chunk = await kvGetJson(kv, `tb:subj:${subject}:${ci}`);
      if (chunk) Object.assign(merged, chunk);
    }
    if (Object.keys(merged).length > 0) {
      _subjectCaches[subject] = merged;
      return merged;
    }
  }

  // 回退：旧的单块格式
  const idx = await kvGetJson(kv, `tb:subj:${subject}`);
  if (idx) _subjectCaches[subject] = idx;
  return idx;
}

async function getBooksMeta(kv) {
  if (_booksCache) return _booksCache;
  _booksCache = await kvGetJson(kv, 'tb:books');
  return _booksCache;
}

/**
 * 在单个学科索引中查找句子
 */
function searchInIndex(index, sentences) {
  const matches = [];
  let checked = 0;
  for (const normed of sentences) {
    if (normed.length < 10) continue;
    checked++;
    const headKey = normed.slice(0, 30);
    const tailKey = normed.length > 30 ? normed.slice(-30) : normed;
    const hit = index[headKey] || index[tailKey];
    if (hit) {
      matches.push({ bi: hit.bi, page: hit.p });
    }
  }
  return { matches, checked };
}

/**
 * 检查文本是否包含教材原句（跨学科搜索）
 */
export async function checkTextbookIndex(kv, text) {
  if (!kv || !text) return { hit: false, coverage: 0, matches: [] };
  if (!(await ensureLoaded(kv))) {
    console.log('[TB-INDEX] ensureLoaded failed - tb:dir not found');
    return { hit: false, coverage: 0, matches: [] };
  }
  console.log('[TB-INDEX] dir loaded:', Object.keys(_dirCache).length, 'subjects');

  const sentences = String(text)
    .replace(/\s+/g, '')
    .split(/[。；！？!?]+/)
    .map(s => normForTextbook(s))
    .filter(s => s.length >= 10);
  if (sentences.length === 0) return { hit: false, coverage: 0, matches: [] };
  console.log('[TB-INDEX] sentences to check:', sentences.length);

  const availableSubjects = Object.keys(_dirCache);
  const ordered = [
    ...SUBJECT_PRIORITY.filter(s => availableSubjects.includes(s)),
    ...availableSubjects.filter(s => !SUBJECT_PRIORITY.includes(s)),
  ];

  let bestResult = null;

  for (const subject of ordered) {
    const index = await getSubjectIndex(kv, subject);
    if (!index) {
      console.log('[TB-INDEX] no index for:', subject);
      continue;
    }

    const { matches, checked } = searchInIndex(index, sentences);
    console.log('[TB-INDEX]', subject, 'entries:', Object.keys(index).length, 'checked:', checked, 'matched:', matches.length);

    if (checked === 0) continue;

    const coverage = matches.length / checked;
    if (matches.length > 0 && coverage >= 0.4) {
      const booksMeta = await getBooksMeta(kv);
      const enriched = matches.map(m => ({
        book: booksMeta?.[m.bi]?.t || '',
        stage: booksMeta?.[m.bi]?.s || '',
        subject: booksMeta?.[m.bi]?.sub || subject,
        version: booksMeta?.[m.bi]?.v || '',
        grade: booksMeta?.[m.bi]?.g || '',
        page: m.page || 0,
      }));

      bestResult = {
        hit: true,
        coverage: Number(coverage.toFixed(2)),
        subject,
        matches: enriched,
      };
      break;
    }
  }

  return bestResult || { hit: false, coverage: 0, matches: [] };
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
    snippet: '',
    tier: 'textbook',
    isTextbook: true,
  };
}
