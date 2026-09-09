// 官方站点站内检索入口（各站搜索接口参数不同，逐一验证）
// 已实测可用的站内搜索用直链；接口不稳定的用必应 site: 语法兜底（保证点开有内容）

const GOV_SITES = [
  {
    name: '国家统计局',
    // 实测 200：https://www.stats.gov.cn/search/?searchword=关键词
    searchUrl: (q) => `https://www.stats.gov.cn/search/?searchword=${encodeURIComponent(q)}`,
  },
  {
    name: '中国政府网',
    // 实测 200 有结果
    searchUrl: (q) => `https://sousuo.www.gov.cn/sousuo/search.shtml?code=17da70961a7&searchWord=${encodeURIComponent(q)}`,
  },
  {
    name: '教育部',
    // 实测 200 有结果（教育部官方搜索 so.moe.gov.cn）
    searchUrl: (q) => `https://so.moe.gov.cn/s?siteCode=bm05000001&tab=all&qt=${encodeURIComponent(q)}`,
  },
  {
    name: '国家林草局',
    // nfga.gov.cn 站内搜索接口不稳定，用必应 site: 语法兜底
    searchUrl: (q) => `https://cn.bing.com/search?q=${encodeURIComponent('site:nfga.gov.cn ' + q)}`,
  },
  {
    name: '国家标准全文公开系统',
    // openstd.samr.gov.cn 检索参数特殊，用必应 site: 语法兜底
    searchUrl: (q) => `https://cn.bing.com/search?q=${encodeURIComponent('site:openstd.samr.gov.cn ' + q)}`,
  },
];

/**
 * 返回各官方站点的站内搜索链接
 */
export async function searchGovDirect(query, opts = {}) {
  const { topK = 5 } = opts;
  if (!query) return [];

  const results = [];
  for (const site of GOV_SITES.slice(0, topK)) {
    results.push({
      title: `${site.name}：${query}`,
      url: site.searchUrl(query),
      snippet: `在${site.name}站内搜索"${query}"（点击跳转官方站点）`,
      source: 'gov-direct',
    });
  }
  return results;
}

/**
 * 获取支持的官方站点列表
 */
export function getGovSites() {
  return GOV_SITES.map(s => s.name);
}
