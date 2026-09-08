// 统计局/林草局等官方站点内检索（站内搜索 + 抓摘要）

const GOV_SITES = [
  { name: '国家统计局', domain: 'data.stats.gov.cn', searchPath: '/easyquery.htm' },
  { name: '中国政府网', domain: 'www.gov.cn', searchPath: '/search/' },
  { name: '教育部', domain: 'www.moe.gov.cn', searchPath: '/search/' },
  { name: '国家林草局', domain: 'www.nfga.gov.cn', searchPath: '/search/' },
  { name: '国家标准', domain: 'openstd.samr.gov.cn', searchPath: '/search/' },
];

/**
 * 站内搜索官方站点
 * 由于各站搜索接口不一，本函数返回站点入口 + 搜索 URL 列表，
 * 前端可直接跳转，或后续扩展为各站点专门抓取
 */
export async function searchGovDirect(query, opts = {}) {
  const { topK = 5 } = opts;
  if (!query) return [];

  const results = [];
  for (const site of GOV_SITES.slice(0, topK)) {
    const searchUrl = `https://${site.domain}${site.searchPath}?q=${encodeURIComponent(query)}`;
    results.push({
      title: `${site.name}：${query}`,
      url: searchUrl,
      snippet: `在${site.name}站内搜索"${query}"`,
      source: 'gov-direct',
      domain: site.domain,
    });
  }
  return results;
}

/**
 * 获取支持的官方站点列表
 */
export function getGovSites() {
  return GOV_SITES;
}
