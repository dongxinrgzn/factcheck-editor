# AGENTS.md — 项目接手须知

> 给在此仓库上工作的 AI 助手 / 新加入的开发者。**动代码前先读完本文件。**
>
> 项目原先积累的本地工作笔记（`.workbuddy/`）被 `.gitignore` 排除，不在仓库里。
> 本文件是随仓库走的**唯一**上下文入口，刻意写得自包含。

---

## 1. 这是什么

编辑校次事实核查助手。把一段中文文本拆成断言 → 多源检索证据 → 判「高/中/低」并给纠错建议；
另有两个附加能力：**古文/诗词查证**、**知识库积累**（查到的事实入库，下次直接复用）。

面向编辑校次场景，**不是通用搜索引擎**——宁可少判、不可错判。

| 层 | 技术 | 线上地址 |
|---|---|---|
| 后端 | Cloudflare Worker（入口 `worker/src/index.js`）+ 4 个 KV 命名空间 | `https://factcheck.mymili.top` |
| 推理 | SiliconFlow `Qwen/Qwen2.5-72B-Instruct` | — |
| 前端 | 单文件静态页，GitHub Pages | `https://dongxinrgzn.github.io/factcheck-editor/` |

- 仓库：`dongxinrgzn/factcheck-editor`（**public**）
- Cloudflare account：`671a2f0bf367dfe29abb0db9036e872b`，Worker 名 `factcheck-editor-api`
- 部署走 `CLOUDFLARE_API_TOKEN` 环境变量（**不是** `wrangler login`）

---

## 2. 硬规则（违反会直接造成线上事故）

**① 前端有两份，必须同步。**
`frontend/index.html` 是源，仓库根的 `index.html` 才是 GitHub Pages 入口。
改完源必须 `cp frontend/index.html index.html`。只改一份 → 线上毫无变化，白白部署一轮。

**② 事实的 value 只能是原文，绝不能让模型生成。**
所有事实构造走单一入口 `worker/src/utils/attrClassify.js` 的 `storeFactsOf(o)`：
label 取事实自身属性、value 取**原文**、附出处与评级。模型结论不得当 value。

**③ 属性口径只有一处。**
新增/修改属性词只改 `worker/src/utils/attrClassify.js`。别在其它文件里散着写属性名判断。

**④ 来源分档决定「能不能当权威依据」。**
见 §6。教辅/题库/文库类站点**不得**被判「高」，也**不得**自动入库。

**⑤ 检索结果与评级都有 KV 缓存**（`q:` / `clm:` / `rate:` / `kbSel:`）。
改了 prompt 或检索逻辑后线上没变化，先怀疑缓存：调 `/api/kb/submit {action:"clear_cache"}` 再验。

---

## 3. 目录职责

```
worker/src/
├── index.js            入口 + 路由分发（唯一入口，esbuild 从这里打包）
├── routes/             8 个端点
│   ├── check.js        ★ 核心：/api/check 全链路（提取→检索→评级→入库）
│   ├── verifyAncient.js  /api/verify-ancient 古文查证
│   ├── kbQuery.js · kbSubmit.js   知识库读 / 写（含清缓存、审计）
│   ├── search.js · auth.js · health.js
├── utils/
│   ├── attrClassify.js ★ 属性口径 + 事实构造 + 繁简归一 + 覆盖率算法（项目的地基）
│   ├── officialScore.js★ 官方性评分 + 来源分档 sourceTier()
│   ├── kbStore.js      ★ 入库闸门 autoAudit + 去重 mergeEntry
│   ├── cache.js        缓存键与 TTL
│   ├── llmProxy.js     LLM 调用封装（含 JSON 修复）
│   ├── rateLimiter.js · cors.js · cleanLLM.js
│   ├── ancientMatcher.js · draftBuilder.js
├── sources/            检索源
│   ├── brave.js        ★ 主检索链路（维基 → Tavily）+ filterRelevant 相关性过滤
│   ├── govDirect.js    官方站直抓 · ctext.js / gushiwen.js / zdic.js 古籍 · poetryDb.js 诗词库
└── prompts/            3 个 LLM 提示词模板（extractFacts / rateTruth / matchAncient）
```

---

## 4. 开发与部署

```bash
# 编译校验（比 wrangler 快得多；输出到 worker/dist/，已被 gitignore）
# ⚠️ 不要加 --external:*（那验不出未定义符号）；也不要写 --outfile=/dev/null
#    （Windows 原生 esbuild 会把它当相对路径，真建出 worker/dev/null 这个垃圾文件）
cd worker && node node_modules/esbuild/bin/esbuild src/index.js \
  --bundle --format=esm --outfile=dist/_build_check.js

# 部署（必须显式传 -c wrangler.toml；不传会向上找到仓库根的错误配置）
cd worker && node node_modules/wrangler/bin/wrangler.js deploy -c wrangler.toml
```

部署输出里**出现 `Uploaded factcheck-editor-api` 就算成功**；紧随其后的
`/zones/.../workers/routes ... Authentication error [code: 10000]` 是 API Token 缺
Zone 路由权限导致的**路由查询**失败，路由已绑定时不影响新代码生效，**不用管**。

生产环境约束（免费版，改代码时时刻记着）：
- **单次调用子请求上限 50**，且声明 `[limits]` 会被 API 拒绝。复合流程必须省着用：
  `verifyAncient.js` 跳过 7 部书遍历、`maxClaims=6`；`check.js` 用 `mapLimit` 限并发。
- **KV 是最终一致**：写入后几十秒内跨节点可能读不到；**删除同样要等传播**（约 60s）。
  验「写入→读取」闭环时要等一会儿，别误判成代码 bug。

当前 Secret（4 个，值只能在各服务商后台重新获取，Cloudflare **不允许读回**）：
`SILICONFLOW_KEY` · `TAVILY_KEY` · `WORKER_KEY`（管理员密钥）· `KB_CURATOR_PASSWORD`

---

## 5. 检索链路

**主链路 = 维基百科 → Tavily。** Bing 抓取与 DDG/SearXNG 都已废弃并从代码中删除。

- 三路检索**必须并行**（主检索 + 属性补齐 + 官方站直抓），串行要 16–18s，并行 8–10s。
- `filterRelevant(results, entity, opts)` 是相关性闸门：单字实体从严；过滤为空**不覆盖**原结果。
  它是防止「拿无关来源编纠错」的关键（历史上出过「《浪淘沙·其六》作者是刘禹锡而非东方白」这类荒谬纠错）。
- **检索词优先用抽取阶段的 `searchHint`**（历史术语改写成现代名称的整句），
  按字面检索历史术语只会召回同话题噪音。无历史术语时留空，回退 `buildSearchQuery`。

### Tavily 两级额度（关键，容易踩）
| 通道 | 额度 | 超额返回 |
|---|---|---|
| 带 Key（`TAVILY_KEY`） | 1000 credits/月，每月 1 日重置（basic=1 / advanced=2 credit） | **432** |
| keyless（免 Key，`X-Tavily-Access-Mode: keyless`） | **按出口 IP、约 30 次/小时**、滚动窗口、令牌桶（每 120s 回 1 个名额） | **429** + `error.code="hourly_cap_reached"` + `Retry-After` |

`brave.js` 的 `tavilySearch()` 已实现自动降级：Key 侧返回 401/403/429/432/433 时改走 keyless，
**降级请求必须剥掉 `Authorization`**（官网明确「两者同时给时 Key 优先」，带着超额的 Key 仍会 432）。
参数类错误（400）不降级。返回值带 `mode: 'key'|'keyless'`，撞限状态记在模块级
`keylessCapUntil`（限幅 10s~3600s，未到期直接 fail-fast 不发请求，成功即清零）。

> ⚠️ **额度耗尽是静默故障的典型来源**：旧代码 `if (!resp.ok) return []` 把 432 吞掉，
> 表现为「主链路只剩维基噪音、断言莫名判低、evidence 为空」而**毫无报错**。
> 排查第一动作：打探针 `GET /api/health?probe=1&q=<检索词>` 看原始状态码，**先探针后改码**。
> 探针会真实消耗 Tavily 额度，别反复跑。
>
> keyless 是**过渡方案不是长久解法**（一个 IP 约每 2 小时才够一次完整查证）。
> 要稳定必须加第三个带 Key 的通道。**没拿到真实 Key 前不要先写适配器**——无法验证的代码等于没写。

---

## 6. 来源分档：教辅材料 ≠ 课本

项目口径：**教辅材料不是教育局发布的课本内容**，只能作参考项展示。

`worker/src/utils/officialScore.js` 的 `sourceTier(url)` 分四档（判定顺序 UGC → tutoring → textbook）：

| 档位 | 代表 | 能否当权威依据 |
|---|---|---|
| `textbook` | `gov.cn` / `edu.cn` / `ac.cn` / `smartedu.cn` / `pep.com.cn`（人教社）/ `moe.gov.cn` | **只有这档**可整段采信、判「高」、自动入库 |
| `tutoring` | 零五网、菁优网、学科网、组卷网、百度文库、道客巴巴… | ❌ 只作参考出处 |
| `ugc` | 知乎、百度知道、贴吧、CSDN、简书、豆瓣、blog/bbs | ❌ 不参与整段比对 |
| `other` | 维基、百度百科、新闻、学术站 | ❌ 只作参考出处 |

落地要点：
- **整段原文直配**（成段教材原文先整段检索，命中即整段采信、跳过逐点评级）：
  只有 `textbook` 档命中才走 `wholeMatch`（打 `quote_match`、判「高」、可入库）；
  其余档转 `referenceMatch`（响应字段，前端橙色横幅展示，**不判高、不入库**），随后回落逐点评级。
- **评级提示词**（`prompts/rateTruth.js`）把档位标在证据前；证据**全部**为教辅/题库/文库档时，
  内容再吻合**最高只能给「中」**。
- **入库闸门**（`utils/kbStore.js` 的 `autoAudit`）：教辅命中不再授予 `quote_match`。
- 前端横幅措辞**随档位变化**（教辅说「教辅/题库类站点」，其余说「不是权威课本/官方教育来源」）。
- ⚠️ `edu.cn` 会把**大学学报/学术期刊**（如 `xb.dlmu.edu.cn`）也算作 `textbook`。这是刻意的
  （国内只有教育机构能注册 edu.cn），因此标签统一写「权威课本/官方教育来源」而非「课本」。

---

## 7. 已知坑速查

| 现象 | 原因 / 处置 |
|---|---|
| 改了前端线上没变 | 只改了 `frontend/index.html`。根 `index.html` 才是 Pages 入口，两份都要改 |
| 推送后线上还是旧的 | GitHub Pages CDN 缓存，加 `?t=$(date +%s)` 重新拉 |
| wrangler 报 `Asset too large` 或 `/memberships` 鉴权失败 | 没传 `-c wrangler.toml`，读到了仓库根的错误配置 |
| 改 prompt 后行为不变 | KV 缓存（`q:`/`clm:`/`rate:`/`kbSel:`）固化了旧结果，先清缓存 |
| 刚写进 KV 立刻读不到 | KV 最终一致，等几十秒；删除同理（约 60s） |
| python/curl 调线上 API 返回 403 | Cloudflare 拦默认 UA，加浏览器 `User-Agent`（+ `Origin`/`Referer`） |
| 反复线上验证后 `403 NEED_API_KEY` | 游客兜底额度 3 次/天；测试请求带 `X-Worker-Key` |
| 端到端质量突然变差但无报错 | 外部 API 额度/鉴权失败被静默吞掉。先打 `?probe=1` 看原始状态码 |
| 维基返回的全是无关噪音 | 维基对长句匹配不上会返回模糊词条（《盐酸》《锑》《钛》）。检索成段原文时须传 `alwaysTavily: true`，否则「维基有结果就短路」会把真正的兜底引擎挡在门外 |
| `correction` 编出「应为…而非…」 | 证据为空/无关时**必须**让 `evidence` 与 `correction` 一起留空，不允许凭空纠错 |

---

## 8. 验证套路

改动前后**至少跑一次编译校验**，涉及线上行为时补一次真实调用：

```bash
# 编译校验（必做）
cd worker && node node_modules/esbuild/bin/esbuild src/index.js --bundle --format=esm --outfile=dist/_build_check.js
# 健康检查
curl -s "https://factcheck.mymili.top/api/health"
```

- 调业务 API 验证时必须伪装浏览器 UA 并带 `X-Worker-Key: <WORKER_KEY>`，否则很快撞游客额度。
- 纯函数逻辑（属性分类、覆盖率、来源分档）适合先写单测离线跑绿再部署，省线上往返。
- 前端 UI 行为（分支是否渲染）语法检查发现不了，需要真实浏览器渲染验证。
