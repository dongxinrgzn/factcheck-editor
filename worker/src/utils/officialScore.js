// 官方性评分算法 + 白名单管理

// 默认白名单（可被 env.OFFICIAL_WHITELIST 覆盖）
// 注意：仅放真正的官方机构域名。百科类（维基/百度百科）权威但非"官方"，不在此列。
const DEFAULT_WHITELIST = [
  'stats.gov.cn',
  'data.stats.gov.cn',
  'nfga.gov.cn',
  'moe.gov.cn',
  'gov.cn',
  'openstd.samr.gov.cn',
  'ac.cn',
  'edu.cn',
];

/**
 * 从 env 获取白名单
 */
function getWhitelist(env) {
  if (env?.OFFICIAL_WHITELIST) {
    try {
      const list = typeof env.OFFICIAL_WHITELIST === 'string'
        ? JSON.parse(env.OFFICIAL_WHITELIST)
        : env.OFFICIAL_WHITELIST;
      if (Array.isArray(list) && list.length > 0) return list;
    } catch (e) {
      // 解析失败用默认
    }
  }
  return DEFAULT_WHITELIST;
}

/**
 * 从 URL 提取域名
 */
function extractDomain(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ---------- 来源分档：决定"能当权威依据"还是"只能当参考" ----------
// ⚠️ 口径（用户 2026-09-16 明确）：**教辅材料不等于课本**。
// 教辅/题库/答案/文库站（零五网、菁优网、学科网、百度文库…）常整段收录教材原文，
// 但那只能说明"某本教辅收录过这段话"，**不能**作为"这是教育局/出版社发布的课本内容"
// 的依据。故它们只能作为**参考出处**展示，不能用来判定"高"、也不能作为自动入库的依据。
// （此前整段原文直配只排除 UGC 站，教辅站被当成权威出处，把"高"+入库都给了它。）

// 教辅 / 题库 / 答案 / 文库 / 课件站：发布方是商业机构或用户上传，非权威发布
const TUTORING_RE = /(^|\.)(05wang|jyeoo|zxxk|xkw|zujuan|21cnjy|mofangge|51test|1010jiajiao|chazidian|koolearn|yuwenmi|yw11|zuowen|zuowen8|jiajiaoban|xueersi)\.(com|cn|net)$|zujuan\.|book118\.com|doc88\.com|docin\.com|renrendoc\.com|taodocs\.com|360doc\.com|51wendang\.com|wenku\.baidu\.com/i;

// 权威课本 / 官方教育来源：政府与教育科研机构域名，以及官方出版/教育平台。
// **只有这一档**才配享有"整段原文采信"（判"高" + 自动入库）。
const TEXTBOOK_AUTHORITATIVE_RE = /(^|\.)gov\.cn$|(^|\.)edu\.cn$|(^|\.)ac\.cn$|(^|\.)gov$|(^|\.)edu$|(^|\.)smartedu\.cn$|(^|\.)pep\.com\.cn$|(^|\.)moe\.gov\.cn$/i;

// 用户生成内容（博客/问答/论坛）：观点与转载，不构成出处
const UGC_RE = /zhidao\.baidu\.com|(^|\.)zhihu\.com$|tieba\.baidu\.com|(^|\.)csdn\.net$|(^|\.)jianshu\.com$|(^|\.)douban\.com$|(^|\.)blog\.|bbs\.|forum/i;

/**
 * 来源分档
 * @param {string} url
 * @returns {'textbook'|'tutoring'|'ugc'|'other'}
 *   textbook 政府/教育机构、官方出版与教育平台（**唯一**可作整段采信依据的档位）
 *   tutoring 教辅/题库/答案/文库（可作证据与参考出处，但不足以判"高"、不入库）
 *   ugc      用户生成内容（博客/问答/论坛）
 *   other    其余（百科、新闻、企业站等，权威性由 officialScore 另行评分）
 */
export function sourceTier(url) {
  const d = extractDomain(url);
  if (!d) return 'other';
  if (UGC_RE.test(d)) return 'ugc';
  if (TUTORING_RE.test(d)) return 'tutoring';
  if (TEXTBOOK_AUTHORITATIVE_RE.test(d)) return 'textbook';
  return 'other';
}

/** 该来源是否配得上"整段原文采信"（判高 + 自动入库）——只有权威课本/官方来源够格 */
export function isAuthoritativeTextSource(url) {
  return sourceTier(url) === 'textbook';
}

/**
 * 古籍/诗词语料站点判定。
 * 与"教辅≠课本"口径的区别：诗词原文不是课本发布的，是古籍传承的公共文本——
 * 断言"美人首饰侯王印，尽是沙中浪底来"的核查目标就是**这句诗是不是这样写**，
 * 在诗词语料站逐字重现即核对通过，不需要"权威课本"背书。
 * 故此类站点的整段命中，引文断言按"原文一致"采信（仅判高，不自动入库）。
 */
export function isPoetryCorpusSite(url) {
  const d = extractDomain(url);
  if (!d) return false;
  return /gushiwen|shici|poetry|poem|wikisource|shiwen|tangshi|songci/.test(d)
    || /古诗文|诗词|唐诗|宋词/.test(decodeURIComponent(url).slice(0, 300));
}

/**
 * 百科类域名判定：维基/百度百科等是权威参考，但不是政府官方
 */
function isEncyclopedia(domain) {
  return /(^|\.)wikipedia\.org$|(^|\.)wikidata\.org$|baike\.baidu\.com|baike\.sogou\.com|(^|\.)mbalib\.com$|(^|\.)wiki/.test(domain);
}

/**
 * TLD 评分
 * .gov.cn/.edu.cn/.ac.cn = 1.0（中国政府/教育/科研机构，官方）
 * .gov/.edu = 0.9（境外政府/教育）
 * .org.cn/.org = 0.45（非营利组织，参考性但非官方）
 * 其余 = 0.3
 */
function tldScore(domain) {
  if (!domain) return 0;
  if (/(^|\.)gov\.cn$/.test(domain) || /(^|\.)edu\.cn$/.test(domain) || /(^|\.)ac\.cn$/.test(domain)) return 1.0;
  if (/(^|\.)gov$/.test(domain) || /(^|\.)edu$/.test(domain)) return 0.9;
  if (/(^|\.)org\.cn$/.test(domain)) return 0.55;
  if (/(^|\.)org$/.test(domain)) return 0.45;
  return 0.3;
}

/**
 * 白名单加分
 */
function whitelistBonus(domain, whitelist) {
  if (!domain) return 0;
  // 精确匹配或子域匹配
  const hit = whitelist.some(w => domain === w || domain.endsWith('.' + w));
  return hit ? 0.2 : 0;
}

/**
 * 原始出处加分（正文含数据来源关键词）
 */
function primarySourceBonus(content) {
  if (!content) return 0;
  const keywords = ['数据来源', '原始出处', '发布机构', '来源：', '据官方', '国家统计局', '国务院'];
  const hit = keywords.some(k => content.includes(k));
  return hit ? 0.1 : 0;
}

/**
 * 惩罚项（百科/知道/博客/论坛）
 */
function penaltyScore(domain, content) {
  let p = 0;
  if (/百度知道|知乎|博客园|csdn|论坛|bbs/i.test(domain)) p -= 0.3;
  if (/blog|bbs|forum/i.test(domain)) p -= 0.2;
  // 注意：baike.baidu.com 在白名单中，白名单加分可抵消
  return p;
}

/**
 * 计算官方性评分
 * @param {string} url - 结果 URL
 * @param {string} content - 结果摘要/正文
 * @param {object} env - Worker env（含 OFFICIAL_WHITELIST）
 * @returns {{score: number, tag: boolean}}
 */
export function officialScore(url, content = '', env = null) {
  const domain = extractDomain(url);
  const whitelist = getWhitelist(env);
  let score = 0;
  if (isEncyclopedia(domain)) {
    // 百科：权威参考来源，但不是政府官方——给中等可信分，不打官方标签
    score = 0.5;
  } else {
    score += tldScore(domain);
    score += whitelistBonus(domain, whitelist);
    score += primarySourceBonus(content);
    score += penaltyScore(domain, content);
  }
  // 封顶 [0, 1]
  score = Math.max(0, Math.min(1, score));
  return { score: Number(score.toFixed(2)), tag: score >= 0.7 };
}

/**
 * 批量给检索结果打官方性标签
 */
export function annotateResults(results, env = null) {
  const list = Array.isArray(results) ? results : [];
  return list.map(r => {
    const { score, tag } = officialScore(r.url, r.snippet || r.description || '', env);
    return { ...r, official_score: score, official_tag: tag };
  });
}
