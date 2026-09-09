// 官方站点检索：通过 DuckDuckGo site: 宽域语法探测政府/教育官方站是否真有相关内容
// - site:gov.cn 一次覆盖所有政府子域（统计局/政府网/教育部/林草局/各部委…）
// - site:edu.cn 覆盖高校/教育机构
// - 有结果：返回官方站点的真实文章（标题/摘要/链接），URL 为 gov.cn/edu.cn，自动打★官方
// - 无结果：不返回任何内容（避免"点开空白/0结果"的无效入口）

import { ddgSiteSearch } from './brave.js';

// 政府域名 → 站点中文名（用于结果来源标注）
const DOMAIN_NAMES = [
  { match: 'stats.gov.cn', name: '国家统计局' },
  { match: 'data.stats.gov.cn', name: '国家统计局·国家数据' },
  { match: 'www.gov.cn', name: '中国政府网' },
  { match: 'moe.gov.cn', name: '教育部' },
  { match: 'nfga.gov.cn', name: '国家林草局' },
  { match: 'forestry.gov.cn', name: '国家林草局' },
  { match: 'samr.gov.cn', name: '市场监管总局' },
  { match: 'openstd.samr.gov.cn', name: '国家标准全文公开系统' },
  { match: 'nhc.gov.cn', name: '国家卫健委' },
  { match: 'mof.gov.cn', name: '财政部' },
  { match: 'pbc.gov.cn', name: '中国人民银行' },
  { match: 'customs.gov.cn', name: '海关总署' },
  { match: 'miit.gov.cn', name: '工业和信息化部' },
];

function siteNameFromUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '').replace(/^big5\./, '');
    for (const d of DOMAIN_NAMES) {
      if (host === d.match || host.endsWith('.' + d.match)) return d.name;
    }
    // 未识别的政府/教育域名：归类显示
    if (host.endsWith('.gov.cn') || host === 'gov.cn') return '地方政府部门';
    if (host.endsWith('.edu.cn') || host === 'edu.cn') return '高校/教育机构';
    return host;
  } catch {
    return '官方网站';
  }
}

// 官方域名探测范围：宽域，每次仅 1 个 DDG 请求，降低限流概率
const OFFICIAL_DOMAINS = [
  { domain: 'gov.cn', label: '政府网站' },
  { domain: 'edu.cn', label: '教育机构' },
];

/**
 * 检索官方站点内与 query 相关的真实内容（仅返回确实查到内容的）
 */
export async function searchGovDirect(query, opts = {}) {
  const { perDomain = 5 } = opts;
  if (!query) return [];

  const all = await Promise.all(
    OFFICIAL_DOMAINS.map(async ({ domain }) => {
      // 重试一次（DDG 对数据中心 IP 偶发限流返回空）
      let hits = await ddgSiteSearch(domain, query, perDomain);
      if (hits.length === 0) {
        await new Promise(r => setTimeout(r, 1200));
        hits = await ddgSiteSearch(domain, query, perDomain);
      }
      return hits;
    })
  );

  return all.flat()
    .filter(h => h && h.url)
    .map(h => ({
      title: h.title,
      url: h.url,
      snippet: h.snippet || '来自官方网站的相关内容',
      source: 'gov-direct',
      site_name: siteNameFromUrl(h.url),
    }));
}

/**
 * 获取支持的官方站点范围
 */
export function getGovSites() {
  return OFFICIAL_DOMAINS.map(d => d.label);
}
