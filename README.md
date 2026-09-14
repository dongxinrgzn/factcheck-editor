# 编辑校次事实核查助手

基于 STORM 架构的编辑校次事实核查系统。Cloudflare Worker + SiliconFlow Qwen2.5-72B + GitHub Pages。

## 功能

- **官方数据优先检索**：自动筛选 gov.cn 等官方域名，结果带"★官方"标签
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

# 设置 Secret
npx wrangler secret put SILICONFLOW_KEY
npx wrangler secret put WORKER_KEY
npx wrangler secret put BRAVE_API_KEY
npx wrangler secret put KB_CURATOR_PASSWORD

# 重新部署（携带 Secret）
npm run deploy
```

### 2. 前端部署

将 `frontend/index.html` 上传到 GitHub Pages 仓库（可沿用 STORM 的 deploy 脚本思路）。

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
| Brave Search | 通用搜索（替代已退役的 Bing v7） | 免费层 2000 次/月 |

## 关键踩坑清单

1. wrangler 版本与 Node 版本匹配（Node 20 用 wrangler@^3）
2. **先 deploy 再 secret put**（否则 PowerShell TTY 报错）
3. `wrangler.toml` 中 `routes` 必须在 `[vars]` 之前
4. 至少 32B 模型避免乱码（本项目用 72B）
5. `authors`/`urn` 等字段用 `?.` 防御处理
6. 检索词用用户原始输入（古文尤其敏感）
7. KV 写入有最终一致性延迟，限流计数要本地兜底
8. CORS 白名单只放你的 GitHub Pages 域名
9. ctext.org 调用最小间隔 1100ms（防封 IP）

## 目录结构

```
factcheck-editor/
├── worker/                 # Cloudflare Worker 后端
│   ├── src/
│   │   ├── index.js        # 入口 + 路由
│   │   ├── routes/         # 7 个 API 端点
│   │   ├── utils/          # 8 个工具模块
│   │   ├── sources/        # 5 个检索源
│   │   └── prompts/        # 3 个 Prompt 模板
│   ├── wrangler.toml
│   └── package.json
├── frontend/
│   └── index.html          # 单文件前端
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
