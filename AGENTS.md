# 军师 · AI 商业军师 —— 产品与工程总说明（AGENTS.md）

> **本文件是本项目的活文档（Single Source of Documentation），Claude Code 新会话会自动加载它。**
> ⚠️ **维护约定（所有后续 agent 必须遵守）：每次变更 / 迭代代码后，都要同步更新本文件**——
> 至少更新对应章节，并在末尾「变更日志」追加一条（日期 · 改动 · 影响）。
> 文档与代码不一致视为缺陷。提交信息可简写，但 AGENTS.md 必须反映当前真实状态。

---

## 0. 给 Coding Agent 的强制指令（务必执行）

**只要改了代码 / 配置 / 接口 / 数据结构，就必须在同一次提交里更新本文档——无一例外。**

1. **记录每一处变更**：更新受影响的章节，并在 **§14 变更日志** 追加一条 `YYYY-MM-DD · 改动 · 影响面`。
2. **暂不做的 → 写进 TODO**：本次决定延后 / 不做 / 留坑的内容，写入 **§13 已知限制 / TODO**，注明原因或前置条件。绝不允许"做了一半且没记录"。
3. **TODO 完成即移出**：实现了某条 TODO，就从 §13 删除，并在 §14 变更日志记一笔。
4. **改数据模型先改 SSOT**：任何接口字段/数据结构变化，先改 `shared/contracts.d.ts`，再改前端/后端/运营端实现。
5. **保持构建绿**：较大改动后按 **§11 构建校验基线** 跑通三端。
6. **新增全屏弹层**记得置 `store.setOverlay(open)`；遵守 **§7.2 UI 约定**，勿回退已修复的坑。

> 判定标准：**文档与代码不一致 = 缺陷。** 纯探索 / 未落地的尝试可以不记；一旦落到代码就必须记。

---

## 1. 产品是什么

**军师**：面向创始人 / CEO 的「AI 商业军师」。两条价值主线：

- **出谋**（智库）：通用军师 + 多位顾问型智能体（战略诊断、增长、融资、竞品、组织…），基于企业档案与行业基准产出**结构化咨询成果**（诊断报告 / 增长方案 / 融资清单…）。
- **出活**（智能体工坊）：创作型智能体产出品牌资产（IP / 宣传片 / 海报 / 短视频 / 文案），并可训练「只懂你」的专属智能体。

特色：
- **本命色**：首登强制选择一种「本命色」主题（金/绿/红/蓝/紫/铁），全站配色随之自适应；可在「我的」重选。
- **Agent Memory**：顾问从对话/资料/反馈中持续学习，越用越懂客户（运营后台可配策略）。
- **企业事务操作系统**（★ 新）：以「**项目**」为主线，串起 会话 / **版本化报告** / **知识库** / 长期记忆。对话可 **@ 引用** 项目/报告/某段知识（可溯源注入）；报告按「报告名」版本化、可**看变更（diff）**；对话可一键**汇总成纪要**并沉淀进知识库；知识库用 **语义检索 + 关键词** 混合召回。详见「✦ 企业事务操作系统」章节。
- **多租户**：每个账号独立租户，业务数据行级隔离。

---

## 2. 仓库结构

```
repo/
├── AGENTS.md           # ← 本文件：产品与工程总说明（活文档，新会话自动加载）
├── IMPLEMENTATION.md   # 与《投产开发指导》章节的对应表（设计溯源）
├── shared/
│   └── contracts.d.ts  # ★ SSOT：全栈数据契约（纯类型，运行时擦除）
├── app/                # Taro 移动端（微信小程序 weapp + H5），React + TS
├── server/             # 后端 API：Fastify + Prisma + PostgreSQL + LLM Gateway
├── admin/              # 运营后台：Vite + React + TS
└── project/            # 原始高保真原型（设计事实来源，勿改）
```

---

## 3. 技术栈

| 层 | 技术 |
|---|---|
| 移动端 `app/` | Taro 3.6.34 · React 18 · TypeScript · Sass · Webpack5（一套码出 weapp + H5） |
| 后端 `server/` | Fastify 5 · Prisma 5 · PostgreSQL · Zod · `@anthropic-ai/sdk` · tsx/tsc |
| 运营端 `admin/` | Vite 5 · React 18 · TypeScript |
| 数据契约 | `shared/contracts.d.ts`（被三端 `import type` 引用） |

---

## 4. ★ 运行模式：mock vs server（配置化）

前端用一个环境变量切换数据来源，**默认 mock**，本地零依赖即可开发完整流程。

| 模式 | 行为 | 启动方式 |
|---|---|---|
| **mock**（默认） | 所有 `api.*` 走**纯前端数据源**（`app/src/services/mock.ts`），按账号隔离、落本地 storage，不连后端 | `cd app && npm run dev:weapp` |
| **server** | 连真实后端 REST API | `TARO_APP_MODE=server TARO_APP_API=https://你的域名/api npm run build:weapp` |

实现要点：
- `app/src/services/config.ts`：`APP_MODE`（读 `process.env.TARO_APP_MODE`，默认 `mock`）、`IS_MOCK`、`BASE_URL`（读 `TARO_APP_API`）。
- `app/src/services/api.ts`：每个方法按 `IS_MOCK` 分流 mock 或真实请求，**两种模式同口径**（同样的入参/返回类型）。
- `app/src/services/mock.ts`：前端 mock 后端，实现 login/me/agents/survey/profile/sayings/sessions/generate/library 全量接口；mock 数据来自 `app/src/data/agents.ts`、`app/src/data/deliverables.ts`（**由后端 seed 自动生成，勿手改**）。
- mock 模式下登录/数据按 `mock-<手机号>` token 隔离并持久化，可切换账号验证隔离。

---

## 5. ★ SSOT：全栈数据契约 `shared/contracts.d.ts`

**唯一数据口径**，前端 / 后端 / 运营端共用。

- 形式是 **`.d.ts` 纯类型声明**：编译期类型检查、**运行时被擦除**，各端只 `import type` 引用——不引入运行时依赖、不改打包产物、无需配三套 alias，并绕开后端 `tsc` 的 `rootDir` 限制。
- 三端引用方式（均按各自旧名再导出，**调用方零改动**）：
  - 前端 `app/src/services/api.ts`（`SurveyQuestion→SurveyQ`、`DeliverableSection→Section`、`ChatReply→ChatReplyT`）
  - 后端 `server/src/llm/schema.ts`（`Deliverable / DeliverableSection / ChatReply`）
  - 运营端 `admin/src/api.ts`（`Overview / AdminAgent / AgentDetail / Plan / AdminSaying→Saying / SurveyAdmin→SurveyQ`）
- **改数据模型只改这一处**，三端类型同步。
- **新增能力的契约**（项目/报告/知识/引用）：`ProjectItem/ProjectDetail`、`ReportItem/ReportDetail/ReportVersionItem/ReportVersionContent/ReportDiff/SectionDiff`、`KnowledgeItemT/KnowledgeHit`、`MessageRef`、`SummarizeResult`，以及 `GenRequest.projectId/refs`、`GenResult.knowledgeUsed`、`SessionItem/SessionDetail.projectId`、`SessionMessage.refs`、`LibItem.reportId/version/projectId`。

> 约定：任何新增/修改的接口字段，先改 `shared/contracts.d.ts`，再改实现。

---

## 6. 账号与数据隔离

- **登录**：以**手机号为账号主键**的 fake 登录（验证码暂不校验，演示码 `888888`）。手机号不存在则自动建号（独立租户+用户，套餐赠送算力）。
- **Token**：演示版 `token = userId`，前端存 `junshi.userId`，每次请求带 `x-user-id` 头。
- **隔离**：后端 `resolveUser` 严格按 token 解析，**无/失效 token 一律 401**（无 demo 兜底）；所有业务查询按 `userId/tenantId` 过滤。
- **离线兜底**：server 模式下后端不可达时，登录回退为 `local-<手机号>` 本地会话，保证可体验（无服务端数据）。
- **退出登录**：「我的」页底部。
- 端到端隔离已验证（见 §11）。生产应把 `token=userId` 换成**短信验证码 + JWT**，路由隔离逻辑不变。

---

## 7. 前端（app）架构

### 7.1 页面与导航
Tab 页（自定义导航 `navigationStyle: custom` + 自定义底栏 `custom-tab-bar`）：

| Tab | 页面 | 说明 |
|---|---|---|
| 首页 | `pages/home` | 问候 + 今日献策 + 对话入口卡 + 「军师为你发现」+ 智库赠送顾问 |
| 智库 | `pages/thinktank` | 顾问型智能体列表（advisory） |
| 对话 | `pages/sessions` | 会话历史；底栏中间「对话」=开新会话 |
| 智能体 | `pages/studio` | 创作型智能体（creative）+ 训练专属智能体 |
| 我的 | `pages/profile` | 账号/套餐/算力/本命色/退出登录 |

非 Tab 页：`pages/chat`（对话流 + 渐进式成果卡）、`pages/library`（方案库）。

### 7.2 关键 UI 约定（踩过的坑，勿回退）
- **顶部让位胶囊**：自定义导航页内容必须落到「系统状态栏 + 微信胶囊」之下。
  - 首页：品牌行与胶囊**顶端对齐**（`getMenuButtonBoundingClientRect().top`）。
  - 其它 Tab 页：`<Screen topInset>`，由 `components/Screen` 注入实测高度的顶部占位（CSS 兜底 `env(safe-area-inset-top)+52px`）。对话/库各自管理顶部 padding。
  - **不要再加伪状态栏 `9:41`**（已全部移除）。
- **全屏弹层遮挡底栏**：`custom-tab-bar` 是原生层，`wx.hideTabBar` 不可靠。改用全局 `store.overlay` 标志——弹层（登录 / 本命色 picker）打开时底栏组件 `return null`。**新增全屏弹层时务必置 `store.setOverlay(open)`**。
- **两列网格**：用 `justify-content: space-between` + `width: 48.5%`，**不要用 `calc(50%-5px)+gap`**（亚像素取整会溢出换行成竖排）。
- **深色卡光感**：对话入口卡用 `--accent-deep` 对角渐变 + `--accent-glow` 柔光，随本命色自适应。

### 7.3 启动流程
`app.tsx` 启动拉 `loadAgents()` + `loadMe()`（未登录跳过）。首页：未登录→登录弹层；已登录未建档→本命色/30 秒建档 picker。

### 7.4 状态与主题
- `services/store.ts`：轻量全局 store（订阅式）。本命色 / 用户 / 智能体缓存 / tab / overlay / 登录态。
- `data/colors.ts`：6 套本命色主题变量（`--accent` 系列）。

---

## 8. 后端（server）

### 8.1 API 一览（`/api` 前缀）
| 方法 路径 | 说明 | 鉴权 |
|---|---|---|
| `POST /auth/login` | 手机号 fake 登录/注册 | 否 |
| `GET /health` | 健康检查 | 否 |
| `GET /me` · `PUT /me/color` | 当前用户(+onboarded+ai信息) · 改本命色 | 是 |
| `GET /agents` · `GET /agents/:key` | 智能体注册表 | 否 |
| `GET /survey` | 建档问卷 | 否 |
| `GET /profile` · `PUT /profile` | 企业档案读/写（写=完成建档） | 是 |
| `GET /sayings/today` | 每日献策 | 否 |
| `GET /sessions` · `GET/DELETE /sessions/:id` | 会话列表/详情/删除 | 是 |
| `POST /generate-sync` | 同步产出（weapp+H5 通用）·接 `projectId`/`refs` | 是 |
| `POST /generate` | SSE 流式产出（仅 H5/Web）·接 `projectId`/`refs` | 是 |
| `POST /sessions/:id/summarize` | 对话汇总 → 版本化报告 + 知识库 | 是 |
| `GET/POST /library` · `DELETE /library/:id` | 方案库（存库即桥接一版报告） | 是 |
| `GET/POST /projects` · `GET/PUT/DELETE /projects/:id` | 项目主线（详情聚合会话/报告/知识） | 是 |
| `GET /reports` · `GET /reports/:id` · `GET /reports/:id/version` · `GET /reports/:id/diff` · `POST /reports` · `DELETE /reports/:id` | 版本化报告（历史/某版/两版 diff/存版） | 是 |
| `GET/POST /knowledge` · `GET /knowledge/search` · `DELETE /knowledge/:id` | 知识库（摄取/混合检索/删除） | 是 |
| `/admin/*` | 运营后台 API（见 §9） | 演示无 RBAC |

### 8.2 LLM Gateway（`server/src/llm/`）
`gateway.ts` 统一封装：路由 provider → 内容审核 → Token 计量 → 结果缓存 → **故障兜底降级到 mock**。

Provider（`AI_PROVIDER`）：
- **mock**（默认）：模板产出，零成本可离线（`providers/mock.ts`）。
- **claude**：Anthropic，tool use 强约束结构化成果（`providers/claude.ts`）。
- **openai**：**OpenAI 通用协议**，兼容 DeepSeek / Moonshot(Kimi) / 通义千问兼容模式 等（`providers/openai.ts`，function calling 强约束）。
- `env.ts` 的 `isRealKey()` 识别占位/假 key——**fake token 不发网络请求，直接降级 mock**；填真实 key 自动切真实模型。

环境变量（见 `server/.env.example`）：
```
DATABASE_URL  PORT  MODERATION_ENABLED
AI_PROVIDER=mock|claude|openai
ANTHROPIC_API_KEY  CLAUDE_MODEL
OPENAI_API_KEY  OPENAI_BASE_URL  OPENAI_MODEL  OPENAI_TIMEOUT_MS
```
常见 OpenAI 兼容网关：OpenAI `https://api.openai.com/v1`、DeepSeek `https://api.deepseek.com/v1`、Moonshot `https://api.moonshot.cn/v1`、通义 `https://dashscope.aliyuncs.com/compatible-mode/v1`。

### 8.3 其它服务
- `services/context.ts`：`resolveUser`（严格鉴权）、`buildGenContext`（注入 档案/基准/记忆/本命色 + **项目背景 + 显式引用 + 知识库混合召回**）。
- `services/memory.ts`：Agent Memory 写入（**带向量**）/召回（**语义相关性排序**）/留存 TTL/反馈回流。
- `services/embedding.ts`（★）：文本向量化。默认本地**确定性嵌入**（零依赖、离线、`EMBED_DIM=256`）；配 `EMBEDDING_MODEL`+真实 openai 兼容 key 走真实 `/embeddings`。`cosine()` 维度不一致返回 0。
- `services/retrieval.ts`（★）：`hybridSearch`（向量+关键词混合、租户隔离、可按项目过滤）、`resolveReferences`（显式 @ 引用 → 带出处注入）。
- `services/knowledge.ts`（★）：`ingestKnowledge`（切片+逐片向量化）、`listKnowledge`、`deleteKnowledge`。
- `services/reports.ts`（★）：`saveReportVersion`（slug 归一 + 内容哈希去重 + 自动变更摘要）、`diffContents`/`getReportDiff`（section 级 diff）、`slugify`。
- `services/summarize.ts`（★）：`summarizeSession`（整段会话 → 纪要报告 + 沉淀知识）。
- 内容审核 `moderation_log`、审计 `audit_log`（演示级，生产替换合规服务）。

---

## 9. 运营后台（admin）

页面/接口：概览看板、每日献策库（增删改启停）、智能体配置（System 提示词 + Agent Memory 策略）、建档问卷、套餐。入口 `admin/src/App.tsx` + `AgentDetailPanel.tsx`，API `admin/src/api.ts`（类型来自 SSOT）。开发期 Vite 代理 `/api → localhost:4000`。

---

## 10. 数据库（Prisma · `server/prisma/schema.prisma`）

租户 `Tenant` / 用户 `User`(phone 唯一) / 档案 `Profile` / 智能体 `Agent` / 会话 `Session` / 消息 `Message` / 成果 `Deliverable` / 记忆 `Memory` / 献策 `Saying` / 问卷 `SurveyQuestion` / 套餐 `Plan` / 算力流水 `CreditLedger` / 审计 `AuditLog` / 审核 `ModerationLog`。业务表均含 `tenantId` 行级隔离。

**新增模型（企业事务操作系统）**：
- `Project`（项目主线，租户级，`(tenantId,slug)` 唯一）；`Session.projectId` / `Memory.projectId` / `Deliverable.projectId` 归属项目。
- `ReportDoc`（逻辑报告，`(tenantId,slug)` 唯一，`currentVersion`）+ `ReportVersion`（不可变快照，`contentHash` 去重，`changeSummary` 变更摘要，`(reportId,version)` 唯一）。`Deliverable.reportId` 桥接。
- `KnowledgeItem`（知识条目，可挂项目）+ `KnowledgeChunk`（切片 + `embedding`）。
- `Message.refsJson`（本条消息引用的 项目/报告/知识/记忆）。

> 生产：`Memory.embedding` 与 `KnowledgeChunk.embedding` 应用 **pgvector** 的 `vector` 类型 + HNSW 索引；本地降级为 `Json(float[])` + 内存余弦相似度（与 schema 注释一致）。详见「✦ 升级路径」。

---

## ✦ 企业事务操作系统：项目 / 知识库 / 版本化报告 / 引用

一条主线 + 四块能力，长在既有 会话/记忆/成果 之上。

| 能力 | 后端落点 | 前端落点 |
|---|---|---|
| **项目（主线）** | `routes/projects.ts`、`Session/Memory/Deliverable.projectId` | `pages/projects`（列表+新建）、`pages/project`（详情：会话/报告/知识三段）；首页入口条 + 「我的」入口 |
| **知识库 + 语义记忆** | `services/{embedding,retrieval,knowledge}.ts`、`routes/knowledge.ts`、`Memory` 改语义召回 | 项目详情「知识」段（列表+手动加）；`@引用` 选择器拉候选 |
| **版本化报告** | `services/reports.ts`、`routes/reports.ts`、`ReportDoc/ReportVersion`、`/library` 桥接 | `pages/report`（版本时间线 + 查看某版 + 对比上一版 diff）；方案库 `vN` 徽标跳转 |
| **@ 引用（上下文工程）** | `buildGenContext` 解析 `refs` → `resolveReferences` 注入；`injectVariables` 追加「参考资料」块；`Message.refsJson` 持久化 | 对话页 📎 唤起选择器，已选引用以 chip 呈现并随消息发送/回显 |
| **对话→汇总报告** | `services/summarize.ts`、`POST /sessions/:id/summarize` | 对话页「生成纪要」按钮 → 版本化报告 + 沉淀知识库 |

要点：
- **检索**：`hybridSearch` = 向量(语义) × 关键词 加权（`alpha≈0.65`）；演示在内存算余弦，生产换 pgvector `<=>` 下推。
- **记忆质量**：`learnFromConversation` 写入即向量化；召回按当前问题语义排序（无 query 退回 weight+时间）。
- **报告版本**：按「报告名 slug」归一，**同名再产出/编辑=新版本**，**同内容（hash）不重复成版**，自动算「新增/修改/删除 N 段」摘要；diff 读时实时计算（section 级匹配 `h`）。
- **mock 可见**：mock provider 会把「引用/知识/项目」体现在产出里（多一段「参考依据」或一条提示），不接真实模型也能直观验证。
- **隔离**：项目/报告/知识全部 `tenantId` 过滤；引用解析只取该用户/租户可见资料。
- **演示数据**：`seed.ts` 灌入项目「2026 融资冲刺」+ 报告「战略诊断报告」v1→v2（可看 diff）+ 2 条知识。

## ✦ 升级路径（生产增强，按需推进）

1. **激活 pgvector**：把 `Memory.embedding` / `KnowledgeChunk.embedding` 迁到 `vector(N)` 类型，建 HNSW 索引；`hybridSearch`/`recallMemories` 改为 `prisma.$queryRaw` 的 `ORDER BY embedding <=> $q LIMIT k` 下推（替代内存全量余弦）。切换嵌入来源后需**重嵌历史数据**（向量须同源同维）。
2. **真实嵌入模型**：设 `EMBEDDING_MODEL` + openai 兼容真实 key（`embedding.ts` 已含 `/embeddings` 路径），语义质量更高。
3. **Learned Memory 提炼**：`learnFromConversation` / `summarize` 现为确定性启发式；接 LLM 做「事实/偏好/决策/待办」结构化抽取（Mem0 思路，写洞察而非堆原文）。
4. **更细 diff**：现为 section 级；可加 词级 diff（diff-match-patch）高亮句内改动。
5. **时序知识图谱**：在向量之上叠加 Graphiti 式时序图，回答「X 时谁负责 Y」类关系/时序问题（图与向量互补，不替换）。
6. **运营后台**：补「项目/报告/知识」只读看板（当前 admin 未覆盖，见 §13 TODO）。

## 11. 构建、运行、验证

### 本地 mock（零依赖，推荐日常）
```bash
cd app && npm install && npm run dev:weapp   # 微信开发者工具导入 app/ 目录
```

### 真实后端（PostgreSQL）
```bash
cd server && npm install
cp .env.example .env            # 配 DATABASE_URL；AI_PROVIDER 按需
npm run db:push && npm run db:seed
npm run dev                     # http://localhost:4000
# 前端连后端：TARO_APP_MODE=server TARO_APP_API=http://localhost:4000/api npm run dev:weapp
cd admin && npm install && npm run dev   # 运营后台
```

### 构建校验基线（每次大改后应保持全绿）
- `server`：`npx tsc -p tsconfig.json --noEmit` → 0
- `app`：`npm run build:weapp` → Compiled successfully
- `admin`：`npx tsc -b && npx vite build` → 0 + built

### 端到端隔离验证（本地 Postgres + mock provider）
已用 curl 跑通 **19/19**：无 token→401、新号建号、A/B token+租户不同、A 建档/产出/存库后 A 有数据而 **B 全空（隔离）**、A 复登 token 不变且 onboarded 持久化、demo 号可登录、非法 token→401、非法手机号→400。

---

## 12. 上线前硬约束（微信小程序）

mock 可随时预览；**正式上传/审核**还需：
1. **真实 AppID**（`app/project.config.json` 现为 `touristappid`，仅能预览）。
2. **后端公网 HTTPS + ICP 备案域名**，并加入小程序后台 request 合法域名；前端用 `TARO_APP_MODE=server TARO_APP_API` 指向它。
3. **生成式 AI 备案 / 算法备案 + 内容安全**（AI 类小程序审核硬性门槛）。
4. 真实模型：服务端设 `AI_PROVIDER` + 真实 key（国内合规建议走备案的国产模型，走 openai 兼容协议即可）。

---

## 13. 已知限制 / TODO

- 登录是 fake（token=userId）；待接短信验证码 + JWT。
- `server/.env.example` 的 `OPENAI_API_KEY` 是 fake 占位，自动降级 mock；填真实 key 才走真模型。
- 内容审核/计量/缓存为演示级（关键词 / 内存）；生产替换为合规审核 + Redis + 计费台账。
- 签名服务偶发不可用时提交为未签名（不影响功能）。
- **知识库/记忆向量**：当前 `embedding` 存 `Json(float[])`、检索为内存余弦 + 本地确定性嵌入；生产应启用 **pgvector + HNSW + 真实嵌入模型**（见「✦ 升级路径」1–2）。`db push` 不需要 pgvector 扩展。
- **Learned Memory / 汇总** 为确定性启发式（非 LLM 抽取）；可升级为 LLM 结构化提炼（升级路径 3）。
- **报告 diff** 为 section 级（按小标题匹配）；句内词级高亮待加（升级路径 4）。
- **运营后台未覆盖** 项目/报告/知识管理；如需在 admin 加只读看板，后端 `/projects`·`/reports`·`/knowledge` 已就绪（升级路径 6）。
- **@引用** 当前支持 项目/报告/知识/记忆；记忆引用在选择器里暂未列出候选（可由「知识」覆盖），如需可在选择器补一组。

---

## 14. 变更日志（每次迭代追加，最新在上）

> 格式：`YYYY-MM-DD · 改动 · 影响面`

- **2026-06-02** · **企业事务操作系统落地**：引入「项目」主线 + 知识库（语义记忆/混合检索）+ 版本化报告（slug 归一·内容哈希去重·section 级 diff）+ @引用（上下文工程）+ 对话汇总。
  - SSOT：`shared/contracts.d.ts` 新增 Project/Report/Knowledge/MessageRef/Summarize 等类型及 Gen/Session/Lib 字段扩展。
  - 后端：新增 `services/{embedding,retrieval,knowledge,reports,summarize}.ts`、`routes/{projects,reports,knowledge}.ts`；升级 `memory.ts`(向量+语义召回)/`context.ts`(项目背景+引用+召回注入)/`schema.ts`(GenContext+injectVariables)/`library.ts`(桥接报告版本)/`sessions.ts`(projectId/refs+summarize)；Prisma 新增 5 模型 + 字段；`seed.ts` 灌演示项目/报告 v1→v2/知识。
  - 前端：新增 `pages/{projects,project,report}`；对话页加 @引用选择器/生成纪要/项目作用域；方案库 vN 跳转；首页+「我的」入口。
  - 校验：三端构建全绿（server tsc=0 / app build:weapp ok / admin tsc+vite ok）；核心逻辑运行时自检通过（向量自相似 1.0/相关 0.86/无关 0.0、slug 归一、diff=新增1·修改1·删0）。
- **2026-06-02** · 新增 §0「给 Coding Agent 的强制指令」：任何代码变更必须记入文档、暂不做的写入 §13 TODO、完成即移出。
- **2026-06-02** · 文档落为 `AGENTS.md`（Claude Code 新会话自动加载），确立「每次变更必更文档」约定。
- **2026-06-02** · 配置化 mock/server 模式 + 全栈数据模型统一到 SSOT(`shared/contracts.d.ts`)；新增 `services/config.ts`/`mock.ts`/`token.ts`；后端/运营端类型改为引自 SSOT。三端构建全绿。
- **2026-06-02** · 内置离线兜底智能体（`data/agents.ts` 14 个，自后端 seed 生成）+ 成果模板（`data/deliverables.ts`），修复无后端时对话页空白。
- **2026-06-02** · 各 Tab 页顶部让位微信胶囊（`Screen topInset`，移除伪状态栏）；两列卡片改 `space-between+48.5%` 修复竖排。
- **2026-06-02** · 登录支持离线兜底（后端不可达→`local-<phone>`）。
- **2026-06-02** · 手机号 fake 登录 + 账号数据隔离（`resolveUser` 严格鉴权、`/auth/login`、登录门、退出登录）；端到端 19/19 通过。
- **2026-06-02** · 后端新增 OpenAI 通用协议 provider（兼容 DeepSeek/Moonshot/Qwen），`isRealKey` 占位 key 自动降级 mock。
- **2026-06-02** · UI 修复：本命色弹层用 `overlay` 标志隐藏原生底栏；对话入口卡本命色渐变+柔光；首页紧凑化、今日献策分隔线、建档问卷本地兜底。
- **（更早）** · 「军师」全栈实现落地（Taro 小程序+H5 / 运营后台 / Fastify+Prisma 后端 / LLM Gateway / Agent Memory）。
