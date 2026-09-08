// 官方性评分算法 + 白名单管理

// 默认白名单（可被 env.OFFICIAL_WHITELIST 覆盖）
const DEFAULT_WHITELIST = [
  'stats.gov.cn',
  'data.stats.gov.cn',
  'nfga.gov.cn',
  'moe.gov.cn',
  'gov.cn',
  'openstd.samr.gov.cn',
  'baike.baidu.com',
  'zh.wikipedia.org',
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

/**
 * TLD 评分
 * .gov.cn/.edu.cn = 1.0
 * .org.cn/.org = 0.7
 * .com/.cn(非政府) = 0.3
 */
function tldScore(domain) {
  if (!domain) return 0;
  if (/(^|\.)gov\.cn$/.test(domain) || /(^|\.)edu\.cn$/.test(domain)) return 1.0;
  if (/(^|\.)gov$/.test(domain) || /(^|\.)edu$/.test(domain)) return 0.9;
  if (/(^|\.)org\.cn$/.test(domain) || /(^|\.)org$/.test(domain)) return 0.7;
  if (/(^|\.)ac\.cn$/.test(domain)) return 0.8;
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
  score += tldScore(domain);
  score += whitelistBonus(domain, whitelist);
  score += primarySourceBonus(content);
  score += penaltyScore(domain, content);
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
