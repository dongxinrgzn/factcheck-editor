# 编辑校次事实核查助手

基于 STORM 架构的编辑校次事实核查系统。Cloudflare Worker + SiliconFlow Qwen2.5-72B + GitHub Pages。

> **接手开发 / 换平台继续开发，请先读 [`AGENTS.md`](./AGENTS.md)** —— 那里有架构、硬规则、
> 来源分档口径、检索链路与已知坑速查表。本 README 只讲怎么跑起来。

## 功能

- **官方数据优先检索**：自动筛选 gov.cn 等官方域名，结果带"★官方"标签
- **来源分档**：权威课本/官方教育来源、教辅题库文库、UGC、一般来源四档区别对待——
  教辅材料不是教育局发布的课本，只能作参考项展示
- **事实真实度评估与纠错**：LLM 提取断言 + 多源交叉验证 + 高/中/低评级 + 纠错建议
- **古文/古籍查证**：ctext.org + 古诗文网 + 汉典，多版本比对，算书专项
- **常见事实知识库积累**：词条卡长期存储（KV 无 TTL），别名/分类索引，自动提议 + 人工审核入库

## 快速开始

### 1. 后端部署

```bash
cd worker
npm install
npx wrangler login

# 创建 4 个 KV 命名空间
npx wrangler kv namespace create FACT_CACHE
npx wrangler kv namespace create SESSION_STATE
npx wrangler kv namespace create RATE_LIMIT
npx wrangler kv namespace create FACT_KB

# 把 4 个 id 填入 wrangler.toml
# 然后首次部署
npm run deploy

# 设置 Secret（4 个）
npx wrangler secret put SILICONFLOW_KEY
npx wrangler secret put TAVILY_KEY
npx wrangler secret put WORKER_KEY
npx wrangler secret put KB_CURATOR_PASSWORD

# 重新部署（携带 Secret）
npm run deploy
```

> ⚠️ Cloudflare **不允许读回** secret 值。换机器/换平台时，只要继续用同一个账号与同一个
> Worker，这 4 个值都不需要重设；只有换账号或换 key 时才需去各服务商后台重新获取。

### 2. 前端部署

前端是单文件静态页。**注意有两份**：`frontend/index.html` 是源，仓库根的 `index.html` 才是
GitHub Pages 入口。改完源必须同步：

```bash
cp frontend/index.html index.html
```

然后提交推送，Pages 约 40–60 秒构建完成。因为 CDN 有缓存，验证时要加时间戳：

```bash
curl -s "https://dongxinrgzn.github.io/factcheck-editor/?t=$(date +%s)"
```

### 3. 验证

```bash
curl.exe -s "https://你的域名/api/health"
```

返回 `ok:true` + `llm:"Qwen/Qwen2.5-72B-Instruct"` 即成功。

## 账号准备

| 账号 | 用途 | 费用 |
|---|---|---|
| Cloudflare | Worker + KV | 免费 |
| SiliconFlow | Qwen2.5-72B 推理 | 注册送额度 |
| GitHub | 前端 Pages | 免费 |
| 阿里云域名 | 国内访问 | ¥9-14/年 |
| Tavily | 主检索（维基之后的兜底） | 免费 1000 credits/月，每月 1 日重置 |

检索链路：**维基百科 → Tavily**（Bing 抓取与 DDG/SearXNG 已废弃并从代码中删除）。
Tavily 额度耗尽会自动降级到免 Key 的 keyless 通道（按出口 IP 约 30 次/小时）。

## 关键踩坑清单

1. **前端有两份**：`frontend/index.html`（源）与根 `index.html`（Pages 入口），改完必须 `cp` 同步
2. **部署要传 `-c wrangler.toml`**，否则 wrangler 向上找到仓库根的错误配置，报
   `Asset too large` 或 `/memberships` 鉴权失败
3. **先 deploy 再 secret put**（否则 PowerShell TTY 报错）
4. `wrangler.toml` 中 `routes` 必须在 `[vars]` 之前
5. **单次调用的子请求上限 50**（免费版硬性），复合流程必须限并发
6. KV 写入/删除都有最终一致性延迟（几十秒 ~ 60s），别当成 bug
7. 改了 prompt 或检索逻辑线上没变 → 先清 KV 缓存（`q:` / `clm:` / `rate:` / `kbSel:`）
8. 端到端质量突然变差却无报错 → 大概率外部 API 额度耗尽被静默吞掉，先打 `?probe=1` 看原始状态码
9. 检索词用用户原始输入（古文尤其敏感）；历史术语要用抽取阶段的现代名称改写句
10. CORS 白名单只放你的 GitHub Pages 域名
11. ctext.org 调用最小间隔 1100ms（防封 IP）

更完整的坑表与排查手法见 [`AGENTS.md`](./AGENTS.md) §7。

## 目录结构

```
factcheck-editor/
├── AGENTS.md               # ★ 项目上下文入口（架构/硬规则/已知坑），接手先读
├── index.html              # GitHub Pages 入口（由 frontend/index.html 同步而来）
├── worker/                 # Cloudflare Worker 后端
│   ├── src/
│   │   ├── index.js        # 入口 + 路由分发
│   │   ├── routes/         # API 端点（核心 check.js）
│   │   ├── utils/          # 工具模块（attrClassify / officialScore / kbStore 是地基）
│   │   ├── sources/        # 检索源（brave.js 为主链路）
│   │   └── prompts/        # 3 个 Prompt 模板
│   ├── wrangler.toml
│   └── package.json
├── frontend/
│   └── index.html          # 单文件前端（源）
├── docs/
│   └── official-whitelist.json
└── README.md
```

## API 端点

| 路径 | 方法 | 用途 |
|---|---|---|
| `/api/auth` | POST | 权限验证 |
| `/api/check` | POST | 事实核查（A+B） |
| `/api/search` | POST | 官方检索（A） |
| `/api/verify-ancient` | POST | 古文查证（C） |
| `/api/kb/query` | POST | 知识库查询（D） |
| `/api/kb/submit` | POST | 知识库入库（D） |
| `/api/kb/entry/:key` | GET | 词条详情 |
| `/api/health` | GET | 健康检查 |
