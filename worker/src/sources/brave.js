// 全网检索：维基百科（主，稳定免费无Key）→ DuckDuckGo HTML（兜底）→ SearXNG（末选）
// 维基百科对人物生平、常识、动植物等实体事实最权威，且 API 从 Cloudflare 稳定可达

const SEARX_INSTANCES = [
  'https://searx.be',
  'https://search.mdosch.de',
  'https://searx.tiekoetter.com',
  'https://searx.party',
];

function stripHtml(s) {
  return String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

// 繁→简常用字映射（仅用于实体相关性比对，避免"大熊猫"匹配不到"大熊貓"）
// 覆盖面以"会出现在检索标题/摘要里、且与实体相关度判定有关"为准。
// 缺字会直接导致误杀：实测"沙里淘金"的词典结果标题写的是"沙裡淘金"，
// 因 裡→里 未收录而被相关性过滤整条剔掉，报告里就成了"查无实据"。
const TRAD2SIMP = {
  '貓': '猫', '體': '体', '長': '长', '壽': '寿', '齡': '龄', '積': '积', '產': '产',
  '萬': '万', '億': '亿', '隻': '只', '國': '国', '學': '学', '東': '东', '業': '业',
  '發': '发', '標': '标', '準': '准', '種': '种', '頭': '头', '條': '条',
  '龍': '龙', '鳥': '鸟', '魚': '鱼', '馬': '马', '蟲': '虫', '貝': '贝', '見': '见',
  '裡': '里', '裏': '里', '於': '于', '與': '与', '為': '为', '這': '这', '個': '个',
  '們': '们', '來': '来', '說': '说', '話': '话', '語': '语', '詞': '词', '讀': '读',
  '寫': '写', '書': '书', '網': '网', '頁': '页', '內': '内', '兩': '两', '從': '从',
  '會': '会', '動': '动', '節': '节', '總': '总', '結': '结', '統': '统', '計': '计',
  '價': '价', '貴': '贵', '點': '点', '數': '数', '據': '据', '樣': '样', '類': '类',
  '開': '开', '關': '关', '門': '门', '問': '问', '題': '题', '實': '实', '際': '际',
  '間': '间', '時': '时', '現': '现', '對': '对', '應': '应', '該': '该', '銀': '银',
  '銅': '铜', '鐵': '铁', '錫': '锡', '鉛': '铅', '鋅': '锌', '鋁': '铝', '鈉': '钠',
  '鈣': '钙', '鉀': '钾', '鎂': '镁', '風': '风', '雲': '云', '區': '区', '醫': '医',
  '藥': '药', '經': '经', '濟': '济', '財': '财', '貿': '贸', '轉': '转', '運': '运',
  '輪': '轮', '戶': '户', '燈': '灯', '號': '号', '稱': '称', '則': '则', '額': '额',
  '豐': '丰', '層': '层', '島': '岛', '灣': '湾', '臺': '台', '華': '华',
};
const TRAD2SIMP_RE = new RegExp('[' + Object.keys(TRAD2SIMP).join('') + ']', 'g');
function normZh(s) {
  return String(s || '').replace(TRAD2SIMP_RE, c => TRAD2SIMP[c] || c);
}

// 从检索串中剔除属性维度词（体重/身高/体长…含繁体变体），只留实体词。
// 维基全文检索 / 相关性过滤都要用纯实体词，避免属性词干扰。
export function entityTermOf(query) {
  let q = String(query || '');
  for (const variants of Object.values(HINT_VARIANTS)) {
    for (const v of variants) q = q.split(v).join(' ');
  }
  q = q.replace(/[?？?多少几什么的是有在和与\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  return q || query;
}

// 断言句 → 内容二元组（"主体严格匹配全灭"时的兜底判据）。
// 剔掉含虚字的二元组，避免"的了是在""与及和"这类公共串让任意结果都算相关。
const FUNC_CHAR = new Set('的了是在有和与及这那它他她我你您们个中于对从把被而且并或则也就都还只不没很将会能可要上下内外前后同时以之类其此等并'.split(''));
function contentBigrams(text) {
  const s = normZh(text || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const out = [];
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    if (!/[\u4e00-\u9fa5]{2}/.test(bg)) continue;
    if (FUNC_CHAR.has(bg[0]) || FUNC_CHAR.has(bg[1])) continue;
    if (!out.includes(bg)) out.push(bg);
  }
  return out;
}

/**
 * 相关性过滤：结果必须与查询实体相关
 * - 去掉数字/年份得到核心词（"2025年国内生产总值"→"国内生产总值"）
 * - 百科类（维基/百科）：标题必须含核心词（否则只是正文顺带提及，如"犬"文中提到大熊猫 → 剔除）
 * - 其它来源（官方站/网页）：标题或正文含核心词，或核心词二元组覆盖率≥60%（容忍措辞/年份差异）
 *
 * @param {Array}  results 检索结果
 * @param {string} entity  断言主体
 * @param {Object} [opts]
 * @param {boolean} [opts.strictName] 短专名只认"完整实体词出现"（逐点核查链路传 true；
 *        查询链路不传，避免误杀导致答非所问）
 * @param {string}  [opts.claimText]  兜底判据：主体严格匹配**全灭**时，改用"断言完整句"
 *        的内容二元组重叠度判定。用于历史术语/别称场景——断言说"可燃空气"（=氢气），
 *        而正文用的是现代名称"氢气"，按字面匹配必然全灭。
 */
export function filterRelevant(results, entity, opts = {}) {
  const list = Array.isArray(results) ? results : [];
  const raw = normZh(entity || '').trim();
  const strictName = !!opts.strictName;
  if (!raw) return list;
  // 去掉数字、年份、百分号、常见时间字，得到用于匹配的核心词
  const core = raw
    .replace(/\d+(\.\d+)?[%％]?/g, '')
    .replace(/[年月份日世纪号]/g, '')
    .replace(/[\s?？?，,。.、：:；;（）()【】\[\]"'"']/g, '')
    .trim();
  if (!core) return list;

  // 单字实体（金/银/铜/铁/水…）：上面那套二元组法在长度 1 时退化成空，
  // 旧代码直接 `return list`（不过滤）——实测断言"金是金黄色的"的证据集里
  // 因此混进了英文维基《Bao Zheng》并真的参与了评级。
  // 单字只能从严：标题含该字，或正文里出现 ≥2 次（真在讲这个字所指的东西）。
  if (core.length === 1) {
    const countOcc = (h) => {
      const s = normZh(h);
      let n = 0, i = 0;
      while ((i = s.indexOf(core, i)) !== -1) { n++; i += 1; }
      return n;
    };
    return list.filter(r => {
      const title = normZh(r.title || '');
      if (title.includes(core)) return true;
      return countOcc(title + ' ' + normZh(r.snippet || '')) >= 2;
    });
  }

  // 中文二元组 + 拉丁单词
  const bigrams = [];
  for (let i = 0; i < core.length - 1; i++) {
    const bg = core.slice(i, i + 2);
    if (/[\u4e00-\u9fa5]{2}/.test(bg)) bigrams.push(bg);
  }
  const latinTokens = (core.match(/[A-Za-z]{2,}/g) || []).map(t => t.toLowerCase());

  // 短专名（2-5 字中文实体，或含间隔号的外文音译名）在 strictName 下**不做二元组近似放行**。
  // 二元组覆盖率对"近名异实体"完全无效：实体"普里斯特"的三个二元组
  // （普里 / 里斯 / 斯特）能在"普里斯特菲尔德球场"里全中，覆盖率 1.0，
  // 却与断言（普里斯特利制可燃空气）毫无关系——正是这种假阳性让 LLM
  // 拿无关证据编出"应为…而非…"的纠错。
  // 这类实体要求**完整实体词**出现在标题或摘要里；做不到就判无关，
  // 宁可走"查无实据"（诚实），也不放无关证据进去（会编造）。
  const isShortProperName = strictName && (/[·・]/.test(raw) || (core.length >= 2 && core.length <= 5));

  // 中文国名 → 外文名称（外国数据英文页标题不含中文国名，需等价放行，否则被误过滤）
  const REGION_EN = {
    '美国': ['united states', 'u.s.a', 'u.s.', 'usa', 'american', 'america'],
    '日本': ['japan', 'japanese'],
    '德国': ['germany', 'german'],
    '英国': ['united kingdom', 'britain', 'british', 'uk'],
    '法国': ['france', 'french'],
    '印度': ['india', 'indian'],
    '韩国': ['south korea', 'korean', 'korea'],
    '加拿大': ['canada', 'canadian'],
    '巴西': ['brazil', 'brazilian'],
    '俄罗斯': ['russia', 'russian'],
    '澳大利亚': ['australia', 'australian'],
    '意大利': ['italy', 'italian'],
    '西班牙': ['spain', 'spanish'],
    '墨西哥': ['mexico', 'mexican'],
    '印尼': ['indonesia', 'indonesian'],
    '荷兰': ['netherlands', 'dutch'],
    '瑞士': ['switzerland', 'swiss'],
    '沙特': ['saudi'],
    '土耳其': ['turkey', 'turkish'],
    '波兰': ['poland', 'polish'],
    '瑞典': ['sweden', 'swedish'],
    '比利时': ['belgium', 'belgian'],
    '爱尔兰': ['ireland', 'irish'],
    '以色列': ['israel', 'israeli'],
    '阿根廷': ['argentina', 'argentinian'],
    '泰国': ['thailand', 'thai'],
    '越南': ['vietnam', 'vietnamese'],
    '新加坡': ['singapore'],
    '马来西亚': ['malaysia', 'malaysian'],
    '菲律宾': ['philippines', 'filipino'],
    '南非': ['south africa'],
    '埃及': ['egypt', 'egyptian'],
    '乌克兰': ['ukraine', 'ukrainian'],
    '欧盟': ['european union', 'euro area', 'eurozone', 'eu '],
    '新西兰': ['new zealand'],
    '挪威': ['norway', 'norwegian'],
    '丹麦': ['denmark', 'danish'],
    '芬兰': ['finland', 'finnish'],
    '奥地利': ['austria', 'austrian'],
    '希腊': ['greece', 'greek'],
    '葡萄牙': ['portugal', 'portuguese'],
    '智利': ['chile', 'chilean'],
    '哥伦比亚': ['colombia', 'colombian'],
    '巴基斯坦': ['pakistan', 'pakistani'],
    '孟加拉国': ['bangladesh'],
    '阿联酋': ['united arab emirates', 'u.a.e', 'uae'],
    '捷克': ['czech'],
  };
  const regionEnTokens = [];
  for (const [zh, ens] of Object.entries(REGION_EN)) {
    if (core.includes(zh)) regionEnTokens.push(...ens);
  }

  const coverage = (hay) => {
    const h = normZh(hay);
    let hit = 0;
    for (const bg of bigrams) if (h.includes(bg)) hit++;
    let latinHit = 0;
    for (const t of latinTokens) if (h.toLowerCase().includes(t)) latinHit++;
    const total = bigrams.length + latinTokens.length;
    if (total === 0) return 0;
    return (hit + latinHit) / total;
  };

  // 外文国名等价命中：含该国外文名 且 内容涉及经济指标（外文百科/网页标题不含中文国名，避免被误杀）
  const regionEnMatch = (hayAll) => {
    if (regionEnTokens.length === 0) return false;
    const low = hayAll.toLowerCase();
    const regionHit = regionEnTokens.some(tok => low.includes(tok));
    const econHit = /gdp|domestic product|生产总值|经济|economy|trillion|美元|dollar/.test(hayAll);
    return regionHit && econHit;
  };

  const pass = (r) => {
    const title = normZh(r.title || '');
    const isBaike = /wikipedia|baike|wiki/i.test(`${r.source || ''} ${r.url || ''}`);
    if (title.includes(core)) return true;
    const hayAll = title + ' ' + normZh(r.snippet || '');
    // 外文百科（如 Economy of the United States）不含中文核心词，但含外文国名+经济指标 → 放行
    if (regionEnMatch(hayAll)) return true;
    if (isBaike) return false; // 百科标题不含核心词 → 仅顺带提及，剔除
    if (hayAll.includes(core)) return true;
    // 短专名只认"完整实体词出现"，不做覆盖率近似（见上 isShortProperName 说明）
    if (isShortProperName) return false;
    if (coverage(hayAll) >= 0.6) return true;
    return false;
  };

  const out = list.filter(pass);
  if (out.length > 0) return out;

  // ---- 兜底：主体按字面匹配全灭 → 改用"断言整句"的内容重叠度判定 ----
  // 场景：断言用了历史术语/别称（"可燃空气"＝氢气、"脱燃素空气"＝氮气），
  // 而正文一律用现代名称 → 按"可燃空气"匹配必然 0 条，报告就成了"查无实据"。
  // 判据：结果中含**≥3 个**断言句的内容二元组（含虚字的二元组已剔除）。
  // 阈值取 3 是有意的保守值——单个公共二元组（如"空气""产生"）随意一个页面都能撞上，
  // 3 个不同的实词二元组同时出现，才足以说明这一页确实在讲同一件事。
  if (!opts.claimText) return out;
  const claimBgs = contentBigrams(opts.claimText);
  if (claimBgs.length < 3) return out;
  return list.filter(r => {
    const hay = normZh(`${r.title || ''} ${r.snippet || ''}`);
    let hit = 0;
    for (const bg of claimBgs) if (hay.includes(bg)) { hit++; if (hit >= 3) return true; }
    return false;
  });
}



// ---------- 维基百科 ----------
// 取词条导言（纯文本开头，含生卒年/定义等关键事实）
async function wikiExtract(lang, title) {
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json&formatversion=2`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'FactCheckEditor/1.0' } });
    clearTimeout(t);
    if (!resp.ok) return '';
    const j = await resp.json();
    const ext = j?.query?.pages?.[0]?.extract || '';
    return stripHtml(ext).slice(0, 600);
  } catch { return ''; }
}

// 强度量单位（噪音小，出现即是数据句）：公斤/千克/吨/米/厘米/平方千米/摄氏度/升/磅…
const STRONG_UNIT = '(?:公斤|千克|吨|克|厘米|千米|公里|毫米|公尺|英尺|英寸|英哩|英里|磅|平方公里|平方米|平方公尺|公顷|公頃|升|毫升|摄氏度|攝氏度|华氏度|萬人|万人|億人|亿人|萬隻|万只|米/秒|公里/小时|km|kg|cm|mm|km²|m²|米)';
// 弱单位（年/岁等，单独出现可能是年份噪音，仅在含 hint 时采用）
const WEAK_UNIT = '(?:岁|歲|年|載|载)';
// 数字部分：支持范围写法 70-125 / 70～125 / 70至125 / 1.2、1.8
const NUM_PART = '[\\d.,，\\-－—~～至到]';
const CN_NUM = '[一二三四五六七八九十百千萬万零兩两]';
const DATA_STRONG_RE = new RegExp('[^。\\n]*(?:\\d' + NUM_PART + '*\\s*' + STRONG_UNIT + '|' + CN_NUM + '[' + CN_NUM.slice(1, -1) + '0-9.,，\\-－—~～至到]*\\s*' + STRONG_UNIT + ')[^。\\n]*[。\\n]', 'g');
const DATA_WEAK_RE = new RegExp('[^。\\n]*(?:\\d' + NUM_PART + '*\\s*' + WEAK_UNIT + '|' + CN_NUM + '[' + CN_NUM.slice(1, -1) + '0-9.,，\\-－—~～至到]*\\s*' + WEAK_UNIT + ')[^。\\n]*[。\\n]', 'g');

// hint 属性词简繁对照（维基中文正文多为繁体）
const HINT_VARIANTS = {
  '体重': ['体重', '體重'], '体长': ['体长', '體長'], '身高': ['身高'],
  '寿命': ['寿命', '壽命'], '年龄': ['年龄', '年齡'], '速度': ['速度'],
  '面积': ['面积', '面積'], '人口': ['人口'], '产量': ['产量', '產量'],
  '距离': ['距离', '距離'], '海拔': ['海拔'], '重量': ['重量'],
  '身长': ['身長', '身长'], '翼展': ['翼展'],
  '出生': ['出生', '生於', '生于', '誕生'], '逝世': ['逝世', '去世', '卒於', '卒于', '歿', '死於'],
  '长度': ['长度', '長度'], '宽度': ['宽度', '寬度'], '直径': ['直径', '直徑'],
};
function hintMatch(sentence, hint) {
  if (!hint) return false;
  const variants = HINT_VARIANTS[hint] || [hint];
  return variants.some(v => sentence.includes(v));
}

// 深度抽取：导言 + 正文中含具体数据的句子（体重/体长/生卒年等不在导言里的事实）
async function wikiExtractDeep(lang, title, hint = '') {
  const intro = await wikiExtract(lang, title);
  try {
    // 拿全文纯文本（特征/数据章节可能在导言 1.6 万字之后），再正则提取数据句
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(title)}&format=json&formatversion=2`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'FactCheckEditor/1.0' } });
    clearTimeout(t);
    if (!resp.ok) return intro;
    const j = await resp.json();
    const full = j?.query?.pages?.[0]?.extract || '';
    if (!full) return intro;

    // 提取含数字+单位的数据句；若有 hint（如"体重"），优先含 hint 的句子
    const strong = [];
    const weak = [];
    let m;
    DATA_STRONG_RE.lastIndex = 0;
    while ((m = DATA_STRONG_RE.exec(full)) !== null) {
      const s = m[0].trim();
      if (s.length < 8 || s.length > 120) continue;
      if (hint && hintMatch(s, hint)) strong.unshift(s); // 含 hint 的优先排前
      else strong.push(s);
      if (strong.length >= 6) break;
    }
    if (hint && strong.filter(s => hintMatch(s, hint)).length === 0) {
      // hint 词没命中强度量句，再用弱单位（年/岁）找含 hint 的句子
      DATA_WEAK_RE.lastIndex = 0;
      while ((m = DATA_WEAK_RE.exec(full)) !== null) {
        const s = m[0].trim();
        if (s.length >= 8 && s.length <= 120 && hintMatch(s, hint)) weak.push(s);
        if (weak.length >= 2) break;
      }
    }
    const picked = [...weak, ...strong].slice(0, 5);
    if (picked.length === 0) return intro;
    return intro + '\n【数据】' + picked.join('');
  } catch { return intro; }
}

// ---------- 英文维基补充（体重/体长等数据常只在 infobox 或英文正文） ----------
// 中文 hint → 英文关键词
const HINT_EN = {
  '体重': ['weigh', 'weight', 'kg', 'kilogram', 'mass'],
  '体长': ['length', 'long', 'measure', 'cm', 'm '],
  '身长': ['length', 'long', 'measure'],
  '身高': ['height', 'tall', 'shoulder'],
  '寿命': ['lifespan', 'live', 'life span', 'years'],
  '年龄': ['age', 'years old', 'born'],
  '速度': ['speed', 'km/h', 'mph', 'fast'],
  '面积': ['area', 'km2', 'square', 'hectare'],
  '人口': ['population', 'inhabitant'],
  '产量': ['production', 'produce', 'output', 'yield'],
  '距离': ['distance', 'km', 'miles', 'far'],
  '海拔': ['elevation', 'altitude', 'above sea'],
  '重量': ['weigh', 'weight', 'kg', 'ton'],
  '翼展': ['wingspan', 'wing span'],
  '出生': ['born', 'birth'],
  '逝世': ['died', 'death', 'dies'],
  '长度': ['length', 'long', 'km', 'miles'],
  '宽度': ['width', 'wide'],
  '直径': ['diameter'],
};

async function wikiEnSupplement(zhTitle, hint) {
  try {
    // 1. 中文词条 → 英文词条名（langlinks）
    const llUrl = `https://zh.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(zhTitle)}&prop=langlinks&lllang=en&format=json&formatversion=2`;
    const ctrl1 = new AbortController();
    const t1 = setTimeout(() => ctrl1.abort(), 7000);
    const llResp = await fetch(llUrl, { signal: ctrl1.signal, headers: { 'User-Agent': 'FactCheckEditor/1.0' } });
    clearTimeout(t1);
    if (!llResp.ok) return null;
    const llJ = await llResp.json();
    const enTitle = llJ?.query?.pages?.[0]?.langlinks?.[0]?.title;
    if (!enTitle) return null;

    // 2. 英文词条全文
    const url = `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(enTitle)}&format=json&formatversion=2`;
    const ctrl2 = new AbortController();
    const t2 = setTimeout(() => ctrl2.abort(), 11000);
    const resp = await fetch(url, { signal: ctrl2.signal, headers: { 'User-Agent': 'FactCheckEditor/1.0' } });
    clearTimeout(t2);
    if (!resp.ok) return null;
    const j = await resp.json();
    const full = j?.query?.pages?.[0]?.extract || '';
    if (!full) return null;
    const pageid = j?.query?.pages?.[0]?.pageid;

    // 3. 提取含数字+单位的英文句子，优先含 hint 英文词的
    // 先按段落切，再按"句号+空格+大写"切句，避免小数点（1.9 m）被误切
    const enHints = HINT_EN[hint] || [];
    const unitRe = /\d[\d.,\-–—~]*\s*(?:kg|kgs|kilograms?|lbs?|pounds?|cm|mm|km|meters?|metres?|ft|feet|foot|inches?|tonnes?|tons?|km\/h|mph|years?|yrs?|hectares?)\b/i;
    const hit = [];
    const other = [];
    for (const para of full.split(/\n+/)) {
      const sentences = para.split(/(?<=\.)\s+(?=[A-Z(])/);
      for (const s0 of sentences) {
        const s = s0.replace(/\s+/g, ' ').trim();
        if (s.length < 10 || s.length > 220) continue;
        if (!unitRe.test(s)) continue;
        const low = s.toLowerCase();
        if (enHints.some(w => low.includes(w))) hit.push(s);
        else other.push(s);
        if (hit.length + other.length >= 10) break;
      }
      if (hit.length + other.length >= 10) break;
    }
    const picked = [...hit.slice(0, 4), ...other.slice(0, 2)];
    if (picked.length === 0) return null;
    return {
      title: `${enTitle}（英文维基）`,
      url: `https://en.wikipedia.org/?curid=${pageid}`,
      snippet: '【英文维基数据】' + picked.join(' '),
      source: 'wikipedia',
    };
  } catch { return null; }
}

export async function wikiSearch(query, topK = 5, hint = '') {
  const out = [];
  // 维基全文检索只按实体词搜；属性词（体重/身高）仅用于 hint 数据抽取，
  // 避免按属性词召回所有含体型数据的无关词条（犬/郊狼/柳江人…）
  const term = entityTermOf(query);
  for (const lang of ['zh', 'en']) {
    try {
      const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(term)}&srlimit=${topK}&format=json&formatversion=2`;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'FactCheckEditor/1.0' } });
      clearTimeout(t);
      if (!resp.ok) continue;
      const j = await resp.json();
      const hits = j?.query?.search || [];
      for (const h of hits) {
        // 第 1 条主词条深度抽取（导言+正文数据句），第 2 条取导言，其余用搜索摘要
        const searchSnip = stripHtml(h.snippet);
        let snippet = searchSnip;
        let deepHasHint = false;
        if (out.length === 0) {
          const ext = await wikiExtractDeep(lang, h.title, hint);
          if (ext) {
            snippet = ext;
            deepHasHint = hint ? hintMatch(ext, hint) : true;
            // 搜索命中片段（含 hint 词的正文局部）往往就是答案所在，若未被深度抽取覆盖则补上
            if (hint && searchSnip && searchSnip.length >= 10 && !deepHasHint) {
              snippet += '\n【相关片段】' + searchSnip;
            }
          }
        } else if (out.length < 2) {
          const ext = await wikiExtract(lang, h.title);
          if (ext) snippet = ext;
        }
        out.push({
          title: h.title || '',
          url: `https://${lang}.wikipedia.org/?curid=${h.pageid}`,
          snippet,
          source: 'wikipedia',
        });

        // 中文主词条有属性维度（体重/体长…）但中文正文没抓到对应数据句时，补英文维基
        if (out.length === 1 && lang === 'zh' && hint && !deepHasHint) {
          const en = await wikiEnSupplement(h.title, hint);
          if (en) out.push(en);
        }
      }
    } catch { /* 该语言失败则继续 */ }
    if (out.length >= topK) break;
  }
  return out.slice(0, topK);
}

// ---------- DuckDuckGo HTML ----------
// DDG 熔断器：html.duckduckgo.com 常被反爬挡住（返回验证页/超时），
// 失败后 10 分钟内直接跳过，避免每次检索都白等超时；到期自动重试恢复。
let _ddgDownUntil = 0;
const DDG_COOLDOWN_MS = 10 * 60 * 1000;

export async function ddgSearch(query, topK = 5) {
  if (topK <= 0) return []; // 维基已给满额时勿空跑 DDG——白等超时
  if (Date.now() < _ddgDownUntil) return []; // 熔断中
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000); // DDG 常被反爬挡住，长超时只会白等
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    clearTimeout(t);
    if (!resp.ok) {
      _ddgDownUntil = Date.now() + DDG_COOLDOWN_MS; // 触发熔断
      return [];
    }
    const html = await resp.text();

    const out = [];
    // 结果块：result__a 标题链接 + result__snippet 摘要
    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

    const links = [];
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let href = m[1];
      // DDG 重定向链接解析真实 URL
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) {
        try { href = decodeURIComponent(uddg[1]); } catch { /* keep */ }
      }
      links.push({ url: href, title: stripHtml(m[2]) });
    }
    const snippets = [];
    while ((m = snipRe.exec(html)) !== null) snippets.push(stripHtml(m[1]));

    for (let i = 0; i < Math.min(links.length, topK); i++) {
      out.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snippets[i] || '',
        source: 'duckduckgo',
      });
    }
    // 200 但 0 结果 = 典型反爬验证页，同样视为不可用
    if (out.length === 0) _ddgDownUntil = Date.now() + DDG_COOLDOWN_MS;
    else _ddgDownUntil = 0; // 成功则解除熔断
    return out;
  } catch {
    _ddgDownUntil = Date.now() + DDG_COOLDOWN_MS; // 超时/网络错误 → 熔断
    return [];
  }
}

// ---------- DuckDuckGo 站内探测（site:域名，用于判断官方站是否真有相关内容） ----------
/**
 * 在指定域名内用 DDG 检索，仅返回 URL 确实属于该域名的结果
 * @returns {Promise<Array<{title,url,snippet}>>} 无结果时返回空数组
 */
export async function ddgSiteSearch(domain, query, topK = 3) {
  try {
    const q = `site:${domain} ${query}`;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    });
    clearTimeout(t);
    if (!resp.ok) return [];
    const html = await resp.text();

    const linkRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links = [];
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      let href = m[1];
      const uddg = href.match(/[?&]uddg=([^&]+)/);
      if (uddg) { try { href = decodeURIComponent(uddg[1]); } catch { /* keep */ } }
      links.push({ url: href, title: stripHtml(m[2]) });
    }
    const snippets = [];
    while ((m = snipRe.exec(html)) !== null) snippets.push(stripHtml(m[1]));

    const out = [];
    for (let i = 0; i < links.length; i++) {
      // 仅保留 URL 确实属于该官方域名的结果
      let host = '';
      try { host = new URL(links[i].url).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
      if (host !== domain && !host.endsWith('.' + domain)) continue;
      out.push({ title: links[i].title, url: links[i].url, snippet: snippets[i] || '' });
      if (out.length >= topK) break;
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- Bing site: 搜索（DDG 限流时的独立兜底通道） ----------
function decodeBingUrl(href) {
  // Bing 跳转链接 /ck/a?...&u=a1<base64>，去掉 a1 前缀后 base64 解码
  const m = href.match(/[?&]u=a1([A-Za-z0-9+/=_-]+)/);
  if (m) {
    try {
      let b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      const dec = atob(b64);
      if (/^https?:\/\//.test(dec)) return dec;
    } catch { /* fall through */ }
  }
  return href;
}

/**
 * Bing 通用网页搜索（HTML 抓取，无需 API Key）
 * DDG/SearXNG 相继被反爬或实例失效后的免费兜底源。
 * @returns {Promise<Array<{title,url,snippet}>>}
 */
export async function bingWebSearch(query, topK = 5) {
  try {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-CN&count=${Math.max(topK * 3, 15)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    clearTimeout(t);
    if (!resp.ok) return [];
    const html = await resp.text();
    const blocks = html.split(/<li class="b_algo"/).slice(1);
    const out = [];
    for (const blk of blocks) {
      const linkM = blk.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!linkM) continue;
      const realUrl = decodeBingUrl(linkM[1]);
      let snippet = '';
      const capM = blk.match(/<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
      if (capM) snippet = stripHtml(capM[1]);
      if (!snippet) {
        const pM = blk.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
        if (pM) snippet = stripHtml(pM[1]);
      }
      out.push({ title: stripHtml(linkM[2]), url: realUrl, snippet });
      if (out.length >= topK) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function bingSiteSearch(domain, query, topK = 5) {
  try {
    const q = `site:${domain} ${query}`;
    const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&count=20`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const resp = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
    });
    clearTimeout(t);
    if (!resp.ok) return [];
    const html = await resp.text();

    // 每个结果块 <li class="b_algo"> ... <h2><a href="...">title</a></h2> ... <p ...>snippet</p>
    const blocks = html.split(/<li class="b_algo"/).slice(1);
    const out = [];
    for (const blk of blocks) {
      const linkM = blk.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!linkM) continue;
      const realUrl = decodeBingUrl(linkM[1]);
      let host = '';
      try { host = new URL(realUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
      if (host !== domain && !host.endsWith('.' + domain)) continue;
      // 摘要：b_caption 内的 <p>
      let snippet = '';
      const capM = blk.match(/<div class="b_caption"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/);
      if (capM) snippet = stripHtml(capM[1]);
      if (!snippet) {
        const pM = blk.match(/<p class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/);
        if (pM) snippet = stripHtml(pM[1]);
      }
      out.push({ title: stripHtml(linkM[2]), url: realUrl, snippet });
      if (out.length >= topK) break;
    }
    return out;
  } catch {
    return [];
  }
}

// ---------- SearXNG（末选） ----------
export async function searxSearch(query, topK = 5) {
  for (const instance of SEARX_INSTANCES) {
    try {
      const params = new URLSearchParams({ q: query, format: 'json', language: 'zh' });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const resp = await fetch(`${instance}/search?${params}`, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(t);
      if (!resp.ok) continue;
      const j = await resp.json().catch(() => null);
      const raw = j?.results;
      if (!Array.isArray(raw)) continue;
      const results = raw.map(r => ({
        title: r.title || '', url: r.url || '', snippet: r.content || '', source: 'searx',
      })).filter(r => r.url);
      if (results.length > 0) return results.slice(0, topK);
    } catch { /* 下一个实例 */ }
  }
  return [];
}

// ---------- Tavily 正规搜索 API（对云服务器友好，返回网页正文） ----------
/**
 * @param {string} query
 * @param {Object} opts - { apiKey, topK, includeDomains:[], searchDepth }
 * @returns {{results: Array, answer: string}}
 */
export async function tavilySearch(query, opts = {}) {
  const { apiKey, topK = 8, includeDomains = null, searchDepth = 'advanced' } = opts;
  if (!apiKey || !query) return { results: [], answer: '' };
  try {
    const payload = { query, search_depth: searchDepth, include_answer: true, max_results: topK };
    if (includeDomains && includeDomains.length) payload.include_domains = includeDomains;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });
    clearTimeout(t);
    if (!resp.ok) return { results: [], answer: '' };
    const j = await resp.json().catch(() => null);
    if (!j || !Array.isArray(j.results)) return { results: [], answer: '' };
    const results = j.results
      .filter(r => r && r.url)
      .map(r => ({
        title: r.title || '',
        url: r.url,
        snippet: r.content || '',
        source: 'tavily',
      }));
    return { results, answer: j.answer || '' };
  } catch {
    return { results: [], answer: '' };
  }
}

// ---------- SearXNG site: 官方域名检索（聚合多实例，JSON 稳定，官方主通道） ----------
export async function searxSiteSearch(domain, query, topK = 6) {
  const q = `site:${domain} ${query}`;
  const pooled = [];
  for (const instance of SEARX_INSTANCES) {
    try {
      const params = new URLSearchParams({ q, format: 'json', language: 'zh' });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 7000);
      const resp = await fetch(`${instance}/search?${params}`, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(t);
      if (!resp.ok) continue;
      const j = await resp.json().catch(() => null);
      const raw = j?.results;
      if (!Array.isArray(raw)) continue;
      for (const r of raw) {
        const url = r.url || '';
        let host = '';
        try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { continue; }
        if (host !== domain && !host.endsWith('.' + domain)) continue;
        pooled.push({ title: r.title || '', url, snippet: r.content || '', source: 'searx' });
      }
      if (pooled.length >= topK) break; // 该实例已够用，不再试下一个
    } catch { /* 下一个实例 */ }
  }
  // 去重
  const seen = new Set();
  const out = [];
  for (const r of pooled) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push(r);
    if (out.length >= topK) break;
  }
  return out;
}

/**
 * 结果域名去重后的主机名集合（去掉 www. 前缀）
 */
function hostSetOf(results) {
  const s = new Set();
  for (const r of results) {
    try { s.add(new URL(r.url).hostname.toLowerCase().replace(/^www\./, '')); } catch {}
  }
  return s;
}

/**
 * 域名多样性兜底
 * 上游 braveSearch 的链路是「维基有结果就直接返回」，实际拿到的常常是清一色
 * zh.wikipedia.org（单一域名）。但自动入库门槛②要求 ≥2 个独立来源域名，
 * 单一域名会导致高可信事实永远过不了审 → 用户看不到"已自动入库"提示。
 * 这里在域名单一时补一轮全网检索，把结果凑到至少 2 个域名。
 * 补位结果排在维基之后，不改变原首条（维基深度抽取）的地位。
 */
async function diversifyDomains(results, query, topK, tavilyApiKey) {
  const hosts = hostSetOf(results);
  if (hosts.size >= 2) return results;
  if (!query) return results;

  const extra = [];
  // 多样性补充：Tavily（有 key）→ Bing（免费兜底）。DDG/SearXNG 已从主链路移除。
  if (tavilyApiKey) {
    try {
      const tv = await tavilySearch(query, { apiKey: tavilyApiKey, topK: topK + 3, searchDepth: 'basic' });
      for (const r of tv.results || []) if (r?.url) extra.push(r);
    } catch { /* 忽略 */ }
  }
  if (hostSetOf([...results, ...extra]).size < 2) {
    try {
      const bing = await bingWebSearch(query, topK + 3);
      for (const r of bing) if (r?.url) extra.push(r);
    } catch { /* 忽略 */ }
  }
  // 上游已有域名清一色时，优先让"新域名"的结果排在前面（否则 slice 截断会
  // 把补充来源砍掉，白消耗一次检索）。同一域名内保持原有相对顺序。
  const known = hosts;
  const ranked = [...extra].sort((a, b) => {
    const na = known.has(hostOf(a)) ? 1 : 0;
    const nb = known.has(hostOf(b)) ? 1 : 0;
    return na - nb;
  });
  return dedupe([...results, ...ranked]);
}

/** 单条结果的规范化主机名（去掉 www.） */
function hostOf(r) {
  try { return new URL(r.url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

/**
 * 综合全网检索（多源兜底）
 *
 * 主链路（2026-09 重构）：维基 → Bing → Tavily。
 * DDG html 端与 SearXNG 公共实例已被反爬/失效（探针实测 0 结果），
 * 从主链路移除；Bing HTML 抓取实测可用（~200ms）且无需 API Key。
 * ddgSearch/searxSearch 函数仍保留——govDirect 兜底通道与健康探针在用。
 *
 * @param {Object} opts - { query, preferOfficial, topK, whitelist, hint, tavilyApiKey, diversify }
 *   hint: 核查的属性维度（如"体重""体长"），用于从词条正文中定向提取数据句
 */
export async function braveSearch(opts = {}) {
  const { query, topK = 5, hint = '', tavilyApiKey, diversify = true } = opts;
  if (!query) return [];

  // 1. 维基（权威来源 + 深度抽取属性数据句）
  const wiki = await wikiSearch(query, topK, hint);
  if (wiki.length > 0) {
    let merged = dedupe([...wiki]);
    // 域名多样性兜底：维基结果常清一色 zh.wikipedia.org，而自动入库门槛要求
    // 「≥2 个独立域名」，单一域名会让高可信事实永远过不了审。域名单一时
    // 补 Bing/Tavily 凑多样性。diversify=false 用于子请求额度紧张的复合流程。
    if (diversify) merged = await diversifyDomains(merged, query, topK, tavilyApiKey);
    return merged.slice(0, topK);
  }

  // 2. 维基无结果 → Bing（免费、快）
  const bing = await bingWebSearch(query, topK);
  if (bing.length > 0) return bing.slice(0, topK);

  // 3. Bing 也无结果 → Tavily（付费，最后兜底）
  if (tavilyApiKey) {
    try {
      const tavily = await tavilySearch(query, { apiKey: tavilyApiKey, topK, searchDepth: 'basic' });
      if (tavily.results && tavily.results.length > 0) return tavily.results.slice(0, topK);
    } catch {}
  }
  return [];
}

/**
 * 强制全网搜索（跳过缓存，Tavily 优先）
 * 当 braveSearch 返回的结果不相关时使用
 */
export async function braveSearchForce(query, topK = 5, tavilyApiKey) {
  if (!query) return [];
  if (tavilyApiKey) {
    try {
      const tavily = await tavilySearch(query, { apiKey: tavilyApiKey, topK, searchDepth: 'advanced' });
      if (tavily.results && tavily.results.length > 0) return tavily.results.slice(0, topK);
    } catch {}
  }
  return braveSearch({ query, topK });
}

export async function braveSearchAll(query, topK = 5) {
  return braveSearch({ query, topK });
}

function dedupe(list) {
  const seen = new Set();
  const out = [];
  for (const r of list) {
    const key = r.url;
    if (key && !seen.has(key)) { seen.add(key); out.push(r); }
  }
  return out;
}
