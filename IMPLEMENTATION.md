# 军师 · AI 商业军师 — 实现说明

本仓库将 Claude Design 导出的高保真原型（`project/`）落地为**可运行的全栈实现**，并遵循 `project/军师-投产开发指导.md` 的工程规格。

> 设计事实来源：`project/方案A · 本命色.html`、`project/运营后台.html`、`project/scripts/app.js`、`project/styles/*`
> 工程规格：`project/军师-投产开发指导.md`

## 技术选型（按需求确认）

- **移动端 App**：[Taro](https://taro.zone) 3.6（React + TypeScript），**一套代码同时产出微信小程序 + H5**，便于两端 review。
- **运营后台**：Vite + React（移动端布局），消费同一套后端 API。
- **后端**：Fastify + Prisma + **PostgreSQL**，自建 **LLM Gateway**。
- **AI**：默认 `mock`（模板产出，零成本可离线）；可切换 `claude`（真实模型 + tool use 强约束结构化成果）。

```
repo/
├── project/        # 原始原型（设计事实来源，保持不动）
├── server/         # 后端 API（LLM Gateway / 会话 / 记忆 / 成果库 / 运营配置）
├── app/            # Taro 移动端（微信小程序 + H5）
└── admin/          # 运营后台（Vite + React）
```

## 与《投产开发指导》的对应

| 指导章节 | 实现位置 |
|---|---|
| §3 数据模型 | `server/prisma/schema.prisma`（租户/用户/档案/智能体/会话/消息/成果/**记忆**/献策/问卷/套餐/计费/审计/审核） |
| §4.1 智能体注册表 | `server/src/data/agents.ts`（13 + 通用），前端 `GET /api/agents` 拉取 |
| §4.2 结构化成果契约 | `server/src/llm/schema.ts`（`emit_deliverable` tool）+ `app` 端 `ReportCard` 渐进式呈现 |
| §4.3 会话隔离/可回溯 | `server/src/routes/sessions.ts` + `app/src/pages/chat`、`sessions` |
| §5.1 LLM Gateway | `server/src/llm/gateway.ts`（路由/审核/计量/缓存/故障兜底） |
| §5.2 提示词 + function calling | `server/src/llm/providers/claude.ts`（tool_choice 强约束） |
| §6 Agent Memory | `server/src/services/memory.ts`（写入/召回/留存 TTL/反馈回流），后台可配策略 |
| §7 运营后台 | `admin/`（概览/献策/顾问提示词+记忆/问卷/套餐）+ `server/src/routes/admin.ts` |
| §8 本命色/多租户 | `tenant_id` 行级隔离；本命色首登强制选择（金色默认）、可在「我的」重选 |
| §9 合规 | 内容审核（`moderation_log`）、免责页脚、审计日志（演示级，生产需替换合规服务） |

## 新增能力：企业事务操作系统（项目 / 知识库 / 版本化报告 / 引用）

在既有 会话/记忆/成果 之上扩展，详见 `AGENTS.md`「✦ 企业事务操作系统」「✦ 升级路径」。

| 能力 | 实现位置 |
|---|---|
| 项目主线 | `server/src/routes/projects.ts`、`Session/Memory/Deliverable.projectId`、`app/src/pages/{projects,project}` |
| 知识库 + 语义记忆 | `server/src/services/{embedding,retrieval,knowledge}.ts`、`routes/knowledge.ts`、`memory.ts`(语义召回)、项目详情「知识」段 |
| 版本化报告 | `server/src/services/reports.ts`、`routes/reports.ts`、`ReportDoc/ReportVersion`、`app/src/pages/report`（版本时间线 + diff） |
| @ 引用（上下文工程） | `buildGenContext`+`resolveReferences`+`injectVariables`、`Message.refsJson`、对话页 📎 选择器 |
| 对话→汇总报告 | `server/src/services/summarize.ts`、`POST /sessions/:id/summarize`、对话页「生成纪要」 |
| 可切换大模型（默认 Agnes 2.0 Flash） | `server/src/services/aiConfig.ts`、`routes/admin.ts`(`/admin/ai-config`)、`llm/{gateway,providers}` 配置驱动、运营后台「模型」页 |
| pgvector / 真实嵌入 / LLM 提炼 / 词级 diff | `services/vectorStore.ts`+`prisma/pgvector.sql`(flag)、`embedding.ts`(配置驱动)、`gateway.extractInsights/summarizePoints`、`reports.wordDiff` |

技术取舍：语义检索用 **pgvector（生产）/ 内存余弦（本地）** 单库收敛，避免独立向量库的运维税；报告版本用 **全量快照 + 内容哈希去重 + 读时 section 级 diff**（小 JSON 文档无需 Dolt 类重型方案）；引用走 **显式注入** 而非纯自动检索（可控、可溯源）。

## 本地运行

### 0. 前置
- Node 18+、PostgreSQL 14+
- 建库：`createdb junshi`，配置 `server/.env`（参考 `server/.env.example`）

### 1. 后端
```bash
cd server
npm install
npm run db:push      # 建表
npm run db:seed      # 灌入 14 个智能体 / 献策 / 问卷 / 套餐 / 演示租户(云栖科技·王总)
npm run dev          # http://localhost:4000/api
```
切真实模型：在 `server/.env` 设 `AI_PROVIDER=claude` 且 `ANTHROPIC_API_KEY=...`，重启即可（产出走 Claude tool use，结构与 mock 一致）。

### 2. 移动端 App（Taro）
```bash
cd app
npm install
npm run dev:h5       # H5：dist/ 可用静态服务器打开，或 npm run build:h5
npm run dev:weapp    # 微信小程序：用微信开发者工具打开 app/dist
```
H5 后端地址见 `app/.env.development`（`TARO_APP_API`）；小程序需在小程序后台配置合法域名。

### 3. 运营后台
```bash
cd admin
npm install
npm run dev          # http://localhost:5174（/api 已代理到 :4000）
```

## 已验证（Puppeteer 端到端）

- **首登入场仪式**：本命色选择（金色默认 / 6 色）→ 30 秒建档 → 全局主题联动。
- **首页**：问候 + 每日献策（按日期取一条）+ 对话入口 + 主动洞察 + 智库赠送顾问。
- **会话隔离 + 可回溯**：每位顾问独立线程；中间 Tab 直接开新会话；历史本地+云端持久化。
- **结构化产出**：点「战略体检」→ 战略诊断官会话 → 骨架→分段渐显 → 可信赖页脚 → 存入方案库；产出按企业档案个性化插值（如「增长乏力」）。
- **Agent Memory**：产出后写入长期记忆，对话内出现「记忆已更新」。
- **运营后台**：概览看板、献策启停/新增、顾问 **System 提示词在线编辑 + Agent Memory 策略**（保存后端持久化、即时下发）、问卷、套餐。

## 与生产的差距（演示用简化）

- 记忆召回为 weight+时间排序；生产应启用 **pgvector** 语义检索（schema 已预留 `embedding`）。
- 内容审核为关键词级；生产替换为**已备案**的合规审核服务（§9）。
- 算力计量/支付、RAG 行业基准库、创作类图像/视频生成、多智能体编排引擎为占位，按 §5/§11 里程碑推进。
- 鉴权为演示级（`x-user-id` 头回退 demo 用户）；生产需手机号/微信登录 + RBAC。
