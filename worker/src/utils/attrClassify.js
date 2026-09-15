// 属性（指标）识别与事实归一化
//
// 这个模块是「属性口径」的唯一来源：检索侧（check.js 的 buildFactCard）用它把数据句
// 拆成单属性事实，知识库侧（kbStore.js 的 mergeEntry / kbSubmit.js 的 normalize_kb）
// 用它写标签与判重。放在一处的原因：这里曾各写一份导致漂移——检索按 A 口径切分、
// 入库按 B 口径贴标签，于是"体长"数据被贴成"体重"，用户再查"体长"就命中不了知识库。

// 数据句单位：货币/百分比（经济）+ 度量衡（自然）
export const CN_UNIT = '(?:万亿元|亿万元|亿元|万元|亿美元|万美元|亿港元|万港元|万亿美元|千亿元|百亿元|亿元|万亿|千亿|百亿|亿元|美元|港元|欧元|日元|人民币|元|%|％|个百分点|百分点|公斤|千克|吨|克|厘米|千米|公里|毫米|公尺|米|平方公里|平方米|公顷|公頃|升|毫升|摄氏度|攝氏度|万人|亿人|萬人|萬隻|万只|万头|牛顿|歲|岁)';
export const EN_UNIT = '(?:trillion|billion|million|thousand|yuan|dollars?|USD|RMB|kg|kgs|kilograms?|lbs?|pounds?|cm|mm|km|meters?|metres?|tons?|tonnes?|km/h|mph|years?|yrs?|hectares?|percent|%)';

/** 按语言取"数字+单位"判据（不含 /g，避免 test 的 lastIndex 陷阱） */
export function makeDataRe(isEn) {
  return isEn
    ? new RegExp('\\d[\\d.,\\-–—~]*\\s*' + EN_UNIT, 'i')
    : new RegExp('\\d[\\d.,，\\-－—~～至到]*\\s*' + CN_UNIT);
}

// 指标关键词 → 属性名（经济类在前，命中即归类）
export const INDICATORS = [
  ['国内生产总值', '国内生产总值'], ['生产总值', '国内生产总值'], ['GDP', '国内生产总值'], ['gdp', '国内生产总值'],
  ['居民消费价格', '居民消费价格指数(CPI)'], ['CPI', '居民消费价格指数(CPI)'], ['cpi', '居民消费价格指数(CPI)'],
  ['人均可支配收入', '人均可支配收入'], ['财政收入', '财政收入'], ['税收收入', '税收收入'],
  ['粮食产量', '粮食产量'], ['总产量', '产量'], ['产量', '产量'],
  ['城镇化率', '城镇化率'], ['失业率', '失业率'], ['出生率', '出生率'], ['人口', '人口'],
  ['同比增长', '增长率'], ['比上年增长', '增长率'], ['增长', '增长率'], ['增速', '增长率'], ['增长率', '增长率'],
  ['人均', '人均值'], ['收入', '收入'],
  ['体重', '体重'], ['體重', '体重'], ['体长', '体长'], ['體長', '体长'], ['身高', '身高'],
  // 动物形体的其它量度：不单列的话会落进"相关数据"桶，只能靠 hint 贴标签，
  // 于是"大熊猫 身高"查出来的肩高句被贴成"身高"、再查"体长"就命中不了（见 splitMultiAttrClauses）
  ['肩高', '肩高'], ['臀高', '臀高'], ['体高', '体高'], ['头躯长', '头躯长'], ['胸围', '胸围'],
  ['尾长', '尾长'], ['耳长', '耳长'], ['后足长', '后足长'],
  ['寿命', '寿命'], ['壽命', '寿命'], ['海拔', '海拔'], ['面积', '面积'], ['面積', '面积'],
  ['速度', '速度'], ['咬合力', '咬合力'], ['翼展', '翼展'], ['重量', '重量'],
  // 英文指标词
  ['weigh', '体重'], ['weight', '体重'], ['body mass', '体重'],
  ['body length', '体长'], ['length', '体长'], ['long', '体长'],
  ['lifespan', '寿命'], ['life span', '寿命'], ['years old', '寿命'], ['old', '寿命'],
  ['speed', '速度'], ['km/h', '速度'],
  ['elevation', '海拔'], ['altitude', '海拔'], ['above sea', '海拔'],
  ['bite force', '咬合力'], ['wingspan', '翼展'],
  ['population', '种群数量'], ['inhabitants', '种群数量'],
];

/** 取第一个命中的属性名（没命中返回 null） */
export function classifyProp(sentence) {
  for (const [kw, prop] of INDICATORS) {
    if (sentence.includes(kw)) return prop;
  }
  return null;
}

/** 一句话里出现的全部属性（去重） */
export function classifyPropsAll(sentence) {
  const out = new Set();
  for (const [kw, prop] of INDICATORS) {
    if (sentence.includes(kw)) out.add(prop);
  }
  return [...out];
}

/**
 * 把"多属性长句"按逗号/分号拆成单属性子句。
 *
 * 为什么必须拆（用户实测 bug）："通常情况下，大熊猫的体长为1.2-1.8米，肩高为65-75厘米，
 * ……，体重为60-125千克"这样一句里混了七八个属性，整句只能按**第一个**命中的属性归类
 * （此处 classifyProp 返回"体重"）。于是体长数据被"藏"在这条"体重"事实的 value 里：
 * 之后用户查"大熊猫 体长"时 label 是"体重"、命中不了知识库 → 重新全网检索 → 同一批数据
 * 又被贴成"体长"存一遍，词条里就出现两条体长事实。
 *
 * 拆句后每条子句自带正确的属性名，知识库按属性精确命中，也不会重复入库。
 * 拆不出来（<2 条有效子句）时原样返回整句，保证不丢数据。
 */
export function splitMultiAttrClauses(sentence, dataRe) {
  if (classifyPropsAll(sentence).length < 2) return [sentence];
  const clauses = String(sentence).split(/[，,；;]/).map(c => c.trim()).filter(Boolean);
  const keep = clauses.filter(c => c.length >= 6 && dataRe.test(c));
  return keep.length >= 2 ? keep : [sentence];
}

// 不可引用为"知识库事实来源"的主机：检索引擎把多来源压缩成一段话后给出的
// 聚合地址，指向的不是原页面。它只能当**证据**喂给 LLM 作答，不能当**事实来源**——
// 否则相当于把一段模型生成的文字当成"有出处的事实"存进知识库（用户明确要求：
// 知识库里的数据不能是编造的，必须有真实出处）。
const NON_CITABLE_HOSTS = new Set(['app.tavily.com', 'tavily.com']);

/** 该来源能否作为知识库事实的出处（必须有真实页面 URL，且不是聚合器伪地址） */
export function isCitableSource(source) {
  const u = String(source?.url || '').trim();
  if (!u) return false;
  try {
    return !NON_CITABLE_HOSTS.has(new URL(u).host.toLowerCase());
  } catch {
    return false;
  }
}

// 可换算的度量单位 → [量纲, 到基准单位的倍数]。
// 只收"长度/质量"这类能无歧义换算的；货币/百分比等一概不收（不同年份的亿元不可比）。
const UNIT_SCALE = {
  '毫米': ['len', 1], '厘米': ['len', 10], '米': ['len', 1000], '公尺': ['len', 1000],
  '公里': ['len', 1e6], '千米': ['len', 1e6],
  '克': ['mass', 1], '千克': ['mass', 1000], '公斤': ['mass', 1000], '吨': ['mass', 1e6],
};

/**
 * 事实的"测量值指纹"：把带单位的数字统一换算到基准单位，排序后拼成字符串。
 * 只取"可换算量纲"的数字，忽略年份/计数等裸数字——否则多一个年份就会让指纹不同，
 * 反而永远判不了重。
 *
 * 用途：`体长1.2-1.8米` 与 `体长一般在1200—1800毫米` 其实是同一个事实，
 * 纯文本比对判不出来，换算后指纹都是 len:1200,len:1800。
 */
export function measureSignature(text) {
  const s = String(text || '');
  const re = /(\d+(?:\.\d+)?)\s*(?:[-–—~～至到]\s*(\d+(?:\.\d+)?))?\s*(毫米|厘米|公尺|米|公里|千米|千克|公斤|克|吨)/g;
  const out = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    const g = UNIT_SCALE[m[3]];
    if (!g) continue;
    for (const raw of [m[1], m[2]]) {
      if (!raw) continue;
      const v = parseFloat(raw);
      if (!isFinite(v)) continue;
      out.push(`${g[0]}:${Math.round(v * g[1] * 1000) / 1000}`);
    }
  }
  return out.sort().join(',');
}

/**
 * 两条事实是否"同一条"：
 *   属性名相同（归一化后）且测量值指纹相同（且指纹非空）。
 * 指纹为空时一律判为不同——宁可留下重复，也不能把两条无关数据合并掉。
 */
export function isDuplicateFact(a, b) {
  if (!a || !b) return false;
  const la = String(a.label || '').trim();
  const lb = String(b.label || '').trim();
  if (!la || la !== lb) return false;
  const va = measureSignature(a.value);
  if (!va) return false;
  return va === measureSignature(b.value);
}

// ---------------------------------------------------------------------------
// 入库事实构造（查询链路与查证链路**共用**，这是"两条链路入库标准一致"的落点）
//
// 背景：两条链路曾各自造事实，形态完全不通用——
//   查询链路：label=属性名（体重）      value=数据原文（野生大熊猫的体重为60—73千克）
//   查证链路：label=整句断言（金不易被氧化） value=核查结论（属实：<证据>／纠错：<模型结论>）
// 后果有两个，都很致命：
//   ① 知识库复用靠"属性词匹配 facts[].label"，查证存进去的 label 是整句话，
//      结构上永远匹配不上 → 查证链路的自动入库等于白存；
//   ② "纠错：…" 是模型生成的结论性文字，把它当"事实"存进库，违背
//      "知识库不能有编造内容"的硬要求（纠错内容可能是错的/带主观推断）。
// 因此统一为：**只存「属性 + 数据原文 + 可引用出处」形态的事实，且只存评级为高的**。
// ---------------------------------------------------------------------------

// 属性名词白名单：既是"可拼进检索词"的判据，也是"能否当事实标签"的判据。
// 大模型给的 metric 混杂属性名词（体重/熔点/作者）与形容词性表述（金黄/柔软/
// 不易被氧化/最古老的采金方法），后者当标签会污染知识库、拼进检索词会污染召回。
export const SEARCHABLE_ATTRS = new Set([
  ...INDICATORS.map(([, prop]) => prop),
  '熔点', '沸点', '密度', '硬度', '颜色', '含量', '成分', '作者', '成句', '出处', '别名',
  '出生', '逝世', '成立', '发行', '上映', '位置', '高度', '宽度', '深度', '厚度', '直径',
  '长度', '销量', '市值', '股价', '注册资本', '总部', '创始人', '首都',
]);

/** 该词是否是"可检索/可当标签的属性名词"（精确命中，或包含已知属性词，如"地壳含量"） */
export function isAttrNoun(metric) {
  const m = String(metric || '').trim();
  if (!m) return false;
  if (SEARCHABLE_ATTRS.has(m)) return true;
  for (const a of SEARCHABLE_ATTRS) if (a.length >= 2 && m.includes(a)) return true;
  return false;
}

/**
 * 从证据原文里挑出**最相关的一句**，作为知识库事实的 value。
 * 必须是证据原文（片段），不能是"属实：/纠错："这类核查结论。
 * 优先级：属性词+数值单位 > 数值单位 > 属性词 > 首句。
 * 返回空串表示证据为空（调用方据此放弃该条）。
 *
 * opts.strict：只在"挑出的句子确实与属性相关"（含属性词或含数值单位）时才返回，
 * 否则返回空串。用于「把检索摘要当事实来源」的场景——摘要里根本不含该属性的数据句时，
 * 退回首句会存进一条与查询毫不相干的事实（实测："大熊猫 体长 体重" 把
 * "概括起来，孑遗生物一定是「活化石」…" 当成了体重事实入库）。宁可少存，不能存错。
 */
export function pickFactSentence(text, opts = {}) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const metric = String(opts.metric || '').trim();
  // metric 可能是多属性串（"体长 体重"）→ 拆词，任一词命中即算"含属性词"
  const metricWords = metric.split(/[\s、,，+/／和与及]+/).map(s => s.trim()).filter(w => w.length >= 2);
  const dataRe = makeDataRe(!!opts.isEn);
  const parts = raw.split(/(?<=[。；;！!？?])/).map(s => s.trim()).filter(Boolean);
  const list = parts.length ? parts : [raw];
  const withData = (s) => dataRe.test(s);
  const withMetric = (s) => metricWords.length > 0 && metricWords.some(w => s.includes(w));
  const pick =
    list.find(s => withMetric(s) && withData(s)) ||
    list.find(withData) ||
    list.find(withMetric) ||
    list[0];
  if (opts.strict && !withMetric(pick) && !withData(pick)) return '';
  return String(pick || '').slice(0, 300).trim();
}

/**
 * 事实标签：优先事实自身识别出的属性名，其次断言给的属性名词，最后才是实体名。
 * 绝不把整句断言当标签（那会让知识库按属性匹配时永远命中不了）。
 */
export function storeFactLabel({ property, metric, entity, value }) {
  const p = String(property || '').trim();
  if (p && p !== '相关数据') return p;
  const m = String(metric || '').trim();
  if (m && m !== '相关数据') {
    // 多属性查询的 hint 形如 "体长 体重"：**绝不能整串当标签**，否则知识库按属性
    // 匹配时"体长"和"体重"都命中不了。拆词后取第一个属性名词。
    const words = m.split(/[\s、,，+/／和与及]+/).map(s => s.trim()).filter(Boolean);
    const w = words.find(x => isAttrNoun(x));
    if (w) return w;
  }
  const c = classifyProp(String(value || ''));
  if (c) return c;
  return String(entity || '').trim();
}

/**
 * 构造"可入库的事实列表"（0..n 条）。这是**查询链路与查证链路唯一的事实构造器**——
 * 两条链路的入库标准必须完全一致（用户明确要求），任何一边单独造事实形态都会重新
 * 引入"存进去查不出来"的问题。
 *
 * 为什么返回数组：一条数据句里常常含多个属性子句
 *   "体长1.2—1.8米，体重60—73千克"
 * 不拆的话只能按第一个命中的属性归类，其余属性全被埋在 value 里——
 * 之后按"体重"查知识库永远命中不了。拆分口径与维护用的 `normalize_kb` 完全一致
 * （共用 splitMultiAttrClauses），所以入库侧拆过之后 normalize_kb 再跑是幂等的。
 *
 * @param {{property?:string, metric?:string, entity?:string, evidence?:string, value?:string,
 *          source?:object, rating?:string, isEn?:boolean, verifiedAt?:string, strict?:boolean}} o
 *   value 已给定（查询链路的正则抽取结果）时直接用；否则从 evidence 原文里挑一句。
 *   strict=true 用于"只有检索摘要、不确定里面有没有该属性数据句"的场景：
 *   挑不到相关句就放弃（见 pickFactSentence）。
 * @returns {Array<{label:string,value:string,metric:string,rating:string,source:object,verified_at:string,confidence:string}>}
 */
export function storeFactsOf(o = {}) {
  const evidence = String(o.evidence || '').trim();
  const explicit = String(o.value || '').trim();
  // 查询链路：正则抽取已经给出了「数据原文句」，直接用它当 value；
  // 查证链路：只有证据全文，需要从中挑出最相关的一句。
  // 两条链路都只用**原文片段**，绝不使用模型生成的结论性文字。
  const value = explicit || (evidence
    ? pickFactSentence(evidence, { metric: o.metric, isEn: o.isEn, strict: !!o.strict })
    : '');
  if (!value) return [];
  const src = o.source || {};
  if (!src.url) return [];

  const rawClauses = splitMultiAttrClauses(value, makeDataRe(!!o.isEn));
  const parts = Array.isArray(rawClauses) && rawClauses.length > 0 ? rawClauses : [value];

  const rating = o.rating || 'high';
  const date = o.verifiedAt || new Date().toISOString().slice(0, 10);
  const source = {
    name: src.name || '',
    url: src.url || '',
    official_tag: !!src.official_tag,
    official_score: src.official_score != null ? src.official_score : (src.official_tag ? 0.9 : 0.5),
  };

  const seen = new Set();
  const out = [];
  for (const clause of parts) {
    const v = String(clause || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    // 拆成多条时，label 以**子句自身**识别出的属性为准——否则"体长"子句会被贴上
    // 整句的"体重"标签，正是历史上踩过的坑（数据被贴错属性后按属性查就命中不了）。
    // 单条时不走这条捷径，保持原优先级（事实自身 property → metric → classifyProp → 实体）。
    const own = parts.length > 1 ? classifyProp(v) : '';
    const label = own || storeFactLabel({ property: o.property, metric: o.metric, entity: o.entity, value: v });
    if (!label) continue;
    out.push({
      label,
      value: v,
      metric: String(o.metric || ''),
      rating,
      source: { ...source },
      verified_at: date,
      confidence: rating,
    });
  }
  return out;
}

/**
 * 构造单条事实（storeFactsOf 的便捷封装，取第一条）。
 * 返回 null 表示这条不该入库（无原文/无出处）。
 * @returns {{label:string,value:string,metric:string,rating:string,source:object,verified_at:string,confidence:string}|null}
 */
export function storeFactOf(o = {}) {
  const list = storeFactsOf(o);
  return list.length > 0 ? list[0] : null;
}

/**
 * 从一条断言的**检索结果**里挑出最优来源（官方性最高的一条，且必须是可引用的真实页面）。
 * @returns {object|null} {name,url,official_tag,official_score}
 */
export function bestCitableSource(results) {
  const list = (Array.isArray(results) ? results : [])
    .filter(r => r && r.url && isCitableSource(r));
  if (list.length === 0) return null;
  const sorted = list.slice().sort((a, b) => (b.official_score || 0) - (a.official_score || 0));
  const top = sorted[0];
  return {
    name: top.title || top.site_name || '',
    url: top.url,
    official_tag: !!top.official_tag,
    official_score: top.official_score != null ? top.official_score : (top.official_tag ? 0.9 : 0.5),
  };
}
