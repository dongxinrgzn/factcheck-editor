// 官方站点检索：通过 DuckDuckGo site: 宽域语法探测政府/教育官方站是否真有相关内容
// - site:gov.cn 一次覆盖所有政府子域（统计局/政府网/教育部/林草局/各部委…）
// - site:edu.cn 覆盖高校/教育机构
// - 有结果：返回官方站点的真实文章（标题/摘要/链接），URL 为 gov.cn/edu.cn，自动打★官方
// - 无结果：不返回任何内容（避免"点开空白/0结果"的无效入口）

import { ddgSiteSearch, bingSiteSearch, searxSiteSearch, ddgSearch, tavilySearch } from './brave.js';

// 判断 URL 是否为政府/教育官方域名
function isOfficialHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.endsWith('.gov.cn') || host === 'gov.cn' ||
           host.endsWith('.edu.cn') || host === 'edu.cn';
  } catch { return false; }
}

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
    // 保留 www 前缀用于精确匹配（www.gov.cn=中国政府网）；仅去 big5 繁体镜像前缀
    const host = new URL(url).hostname.toLowerCase().replace(/^big5\./, '');
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
 * 主通道：Tavily 正规搜索 API（对云服务器友好、返回正文），定向 gov.cn/edu.cn 官方域名
 * 兜底：免费爬取（DDG 全网过滤 + SearXNG/Bing/DDG site:），云IP被限流时可能为空
 */
export async function searchGovDirect(query, opts = {}) {
  const { apiKey, perDomain = 8 } = opts;
  if (!query) return [];

  let hits = [];

  // 主通道：Tavily（稳定、含正文，能提取数据句）
  if (apiKey) {
    try {
      const tv = await tavilySearch(query, {
        apiKey, topK: 10,
        includeDomains: ['gov.cn', 'edu.cn', 'stats.gov.cn'],
      });
      hits = tv.results
        .filter(r => isOfficialHost(r.url))
        .map(r => ({ ...r, source: 'gov-direct', site_name: siteNameFromUrl(r.url) }));
    } catch { /* 走兜底 */ }
  }

  // 兜底通道：免费爬取（仅当 Tavily 无 key 或结果不足时）
  if (hits.length < 3) {
    let globalHits = [];
    try {
      const g = await ddgSearch(query, 18);
      globalHits = g.filter(r => isOfficialHost(r.url))
        .map(r => ({ ...r, source: 'gov-direct', site_name: siteNameFromUrl(r.url) }));
    } catch { /* ignore */ }

    let siteHits = [];
    if (globalHits.length < 4) {
      const per = await Promise.all(
        OFFICIAL_DOMAINS.map(async ({ domain }) => {
          const sx = await searxSiteSearch(domain, query, perDomain).catch(() => []);
          if (sx.length >= 3) return sx;
          const bing = await bingSiteSearch(domain, query, perDomain).catch(() => []);
          let merged = mergeByUrl(sx, bing);
          if (merged.length < 3) {
            let ddg = await ddgSiteSearch(domain, query, perDomain).catch(() => []);
            if (ddg.length === 0) {
              await new Promise(r => setTimeout(r, 600));
              ddg = await ddgSiteSearch(domain, query, perDomain).catch(() => []);
            }
            merged = mergeByUrl(merged, ddg);
          }
          return merged;
        })
      );
      siteHits = per.flat()
        .filter(h => h && h.url && isOfficialHost(h.url))
        .map(r => ({ ...r, source: 'gov-direct', site_name: siteNameFromUrl(r.url) }));
    }
    hits = mergeByUrl(hits, mergeByUrl(globalHits, siteHits))
      .filter(h => h && h.url && isOfficialHost(h.url));
  }

  // 权威站点加权排序：统计局/政府网/部委在前，edu.cn 在后
  hits.sort((a, b) => govRank(a.url) - govRank(b.url));

  // 按 URL 去重后返回
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = h.url.split('#')[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: h.title,
      url: h.url,
      snippet: h.snippet || '来自官方网站的相关内容',
      source: 'gov-direct',
      site_name: h.site_name || siteNameFromUrl(h.url),
    });
    if (out.length >= 10) break;
  }
  return out;
}

// 权威度排序：统计局/政府网/部委 gov.cn → 地方 gov.cn → edu.cn
function govRank(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (/stats\.gov\.cn|www\.gov\.cn|sousuo\.gov\.cn/.test(host)) return 0;
    if (/[a-z]+\.gov\.cn$/.test(host) || host === 'gov.cn') return 1; // 部委/省级
    if (host.endsWith('.gov.cn')) return 2; // 地方政府
    if (host.endsWith('.edu.cn')) return 3; // 高校
    return 4;
  } catch { return 5; }
}

function mergeByUrl(a, b) {
  const seen = new Set((a || []).map(x => x.url));
  const out = [...(a || [])];
  for (const x of (b || [])) {
    if (x && x.url && !seen.has(x.url)) { seen.add(x.url); out.push(x); }
  }
  return out;
}

/**
 * 获取支持的官方站点范围
 */
export function getGovSites() {
  return OFFICIAL_DOMAINS.map(d => d.label);
}
