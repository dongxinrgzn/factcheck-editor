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
