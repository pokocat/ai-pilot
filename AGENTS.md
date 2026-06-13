# 军师 · AI 商业军师 —— 工程总说明（AGENTS.md）

> **本文件是本项目的活文档（Single Source of Documentation），Claude Code 新会话会自动加载它。**
> ⚠️ **维护约定（所有后续 agent 必须遵守）：每次变更 / 迭代代码后，都要同步更新本文件**——
> 至少更新对应章节，并在末尾「变更日志」追加一条（日期 · 改动 · 影响）。
> 文档与代码不一致视为缺陷。提交信息可简写，但 AGENTS.md 必须反映当前真实状态。
> 产品定位、核心体验和企业事务操作系统的详细说明见 **`PRODUCT.md`**；本文件只保留工程执行必需信息。

---

## 0. 给 Coding Agent 的强制指令（务必执行）

**只要改了代码 / 配置 / 接口 / 数据结构，就必须在同一次提交里更新本文档——无一例外。**

1. **记录每一处变更**：更新受影响的章节，并在 **§14 变更日志** 追加一条 `YYYY-MM-DD · 改动 · 影响面`。
2. **暂不做的 → 写进 TODO**：本次决定延后 / 不做 / 留坑的内容，写入 **§13 已知限制 / TODO**，注明原因或前置条件。绝不允许"做了一半且没记录"。
3. **TODO 完成即移出**：实现了某条 TODO，就从 §13 删除，并在 §14 变更日志记一笔。
4. **改数据模型先改 SSOT**：任何接口字段/数据结构变化，先改 `shared/contracts.d.ts`，再改前端/后端/运营端实现。
5. **保持构建绿**：较大改动后按 **§11 构建校验基线** 跑通三端。
6. **新增全屏弹层**记得置 `store.setOverlay(open)`；遵守 **§7.2 UI 约定**，勿回退已修复的坑。
7. **对话页登录兜底**：未登录/401 token 失效时弹 `Login`，不要把鉴权失败吞成通用“产出失败”。
8. **小程序改动先查约束清单**：凡改 `app/` 的微信小程序页面、tabbar、弹层、登录、键盘、网络请求、路由分包或项目配置，先对照 **§7.2 小程序工程约束清单**；不确定时按清单保守实现，避免回退真机已修复问题。

> 判定标准：**文档与代码不一致 = 缺陷。** 纯探索 / 未落地的尝试可以不记；一旦落到代码就必须记。

---

## 1. 产品摘要

**军师**是面向创始人 / CEO 的 AI 商业军师，主线是「出谋」（智库顾问产出咨询成果）和「出活」（工坊智能体产出品牌资产）。当前核心能力：本命色、专属理解（Agent Memory）、智能体权益 / 产出额度、项目 / 知识库 / 版本化报告 / @ 引用、多租户隔离。

详细产品说明、文案口径和升级方向统一放在 **`PRODUCT.md`**。工程实现以本文的契约、路径、构建与 TODO 为准。

---

## 2. 仓库结构

```
repo/
├── AGENTS.md           # ← 本文件：工程总说明（活文档，新会话自动加载）
├── PRODUCT.md          # 产品定位、信息架构、文案口径、企业事务操作系统说明
├── IMPLEMENTATION.md   # 与《投产开发指导》章节的对应表（设计溯源）
├── shared/
│   └── contracts.d.ts  # ★ SSOT：全栈数据契约（纯类型，运行时擦除）
├── docs/               # ROADMAP.md（进展/TODO）· TESTING.md（集成测试）· DEPLOYMENT.md（部署架构/上线）
├── deploy/             # 部署模板：nginx.conf.example · junshi-api.service · Dockerfile.server · docker-compose.yml
├── app/                # Taro 移动端（微信小程序 weapp + H5），React + TS
├── server/             # 后端 API：Fastify + Prisma + PostgreSQL + LLM Gateway（含 src/app.ts 工厂 + test/ 集成测试）
├── admin/              # 运营后台：Vite + React + TS
└── project/            # 原始高保真原型（设计事实来源，勿改）
```

本地生成物约定：`app/project.config.json` 是正式小程序配置（需跟踪，保持 AppID/miniprogramRoot 正确并开启正式校验/压缩）；`app/project.private.config.json` 可在本机覆盖 DevTools 私有设置（例如局域网真机预览临时 `urlCheck:false`）；根目录误生成的 `project.config.json/project.private.config.json`、`weapp-preview*.json/png`、`weapp-auto-preview*.json/png`、`app/.impeccable/`、`app/tarojs-cli-*.tgz`、根目录空 `package-lock.json` 均为本机/工具产物，已在 `.gitignore` 排除，不纳入提交。**不要导入仓库根目录到微信开发者工具，只导入 `app/`。**

---

## 3. 技术栈

| 层 | 技术 |
|---|---|
| 移动端 `app/` | Taro 3.6.34 · React 18 · TypeScript · Sass · Webpack5（一套码出 weapp + H5） |
| 后端 `server/` | Fastify 5 · Prisma 5 · PostgreSQL · Zod · `@anthropic-ai/sdk` · tsx/tsc · 可切换大模型（默认 **Agnes 2.0 Flash**，OpenAI 兼容；后台可切 DeepSeek/Qwen…） |
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
- `app/config/index.ts`：通过 `defineConstants` 显式注入 `process.env.TARO_APP_MODE` / `process.env.TARO_APP_API`，确保 H5/weapp 构建产物在浏览器/小程序运行时拿到构建期模式与 API 地址。
- `app/src/services/config.ts`：`APP_MODE`（读已注入的 `process.env.TARO_APP_MODE`，默认 `mock`）、`IS_MOCK`、`BASE_URL`（读已注入的 `TARO_APP_API`）。不要在浏览器运行时再用 `typeof process` 包裹，否则 H5 bundle 会退回 mock/default。
- `app/src/services/api.ts`：每个方法按 `IS_MOCK` 分流 mock 或真实请求，**两种模式同口径**（同样的入参/返回类型）。
- `app/src/services/mock.ts`：前端 mock 后端，实现 login/me/agents/survey/profile/sayings/sessions/generate/library 全量接口；mock 数据来自 `app/src/data/agents.ts`、`app/src/data/deliverables.ts`（**由后端 seed 自动生成，勿手改**）。
- mock 模式下登录/数据按 `mock-<手机号>` token 隔离并持久化，可切换账号验证隔离。
- weapp + server 模式下登录弹层优先提供「微信账号登录」：前端 `Taro.login` 取 code，后端 `/auth/wechat-login` 调微信 `jscode2session` 换 openid/unionid 并签发自有 token；H5/mock 不显示该入口。
- **H5 浏览器手测（推荐替代小程序）**：weapp 与 H5 同一套码、无平台分叉。零后端走查 `npm run dev:h5`；连后端测真实变更 `npm run build:h5:server && npm run serve:h5`（→ http://localhost:5173，server 模式，默认指向 :4000）。H5 用 hash 路由，`dist/` 任意静态服务器可开。详见 `docs/TESTING.md` §五。

---

## 5. ★ SSOT：全栈数据契约 `shared/contracts.d.ts`

**唯一数据口径**，前端 / 后端 / 运营端共用。

- 形式是 **`.d.ts` 纯类型声明**：编译期类型检查、**运行时被擦除**，各端只 `import type` 引用——不引入运行时依赖、不改打包产物、无需配三套 alias，并绕开后端 `tsc` 的 `rootDir` 限制。
- 三端引用方式（均按各自旧名再导出，**调用方零改动**）：
  - 前端 `app/src/services/api.ts`（`SurveyQuestion→SurveyQ`、`DeliverableSection→Section`、`ChatReply→ChatReplyT`）
  - 后端 `server/src/llm/schema.ts`（`Deliverable / DeliverableSection / ChatReply`）
  - 运营端 `admin/src/api.ts`（`Overview / AdminAgent / AgentDetail / Plan / AdminSaying→Saying / SurveyAdmin→SurveyQ`）
- **改数据模型只改这一处**，三端类型同步。
- **智能体权益契约**：`AgentBilling`（`free|unlock|metered`）、`Agent.billing/price/owned`、`AgentPurchaseResult`、`AdminAgentCreate/AdminAgentUpdate`、`AdminUserDetail/AdminUserAgentRow`，驱动前台解锁、后台定价与指定用户开通。
- **新增能力的契约**（项目/报告/知识/引用）：`ProjectItem/ProjectDetail`、`ReportItem/ReportDetail/ReportVersionItem/ReportVersionContent/ReportDiff/SectionDiff`、`KnowledgeItemT/KnowledgeHit`、`MessageRef`、`SummarizeResult`，以及 `GenRequest.projectId/refs`、`GenResult.knowledgeUsed`、`SessionItem/SessionDetail.projectId`、`SessionMessage.refs`、`LibItem.reportId/version/projectId`。

> 约定：任何新增/修改的接口字段，先改 `shared/contracts.d.ts`，再改实现。

---

## 6. 账号与数据隔离

- **登录**：小程序 server 模式支持微信账号登录（`wx.login` code → 服务端 `jscode2session` → openid/unionid 建号）；手机号 fake 登录仍保留为演示/兜底（验证码暂不校验，演示码 `888888`）。新账号自动建独立租户+用户，套餐赠送算力。
- **Token**：演示版 `token = userId`，前端存 `junshi.userId`，每次请求带 `x-user-id` 头。
- **隔离**：后端 `resolveUser` 严格按 token 解析，**无/失效 token 一律 401**（无 demo 兜底）；所有业务查询按 `userId/tenantId` 过滤。
- **微信密钥**：`WECHAT_MINI_SECRET` 只在服务端环境变量保存；微信 `session_key` 仅服务端换取时使用，**不下发前端**。
- **方案购买（演示级）**：前台可读 `GET /plans`，登录后 `POST /plans/:id/purchase` 切换方案并按方案写入 `CreditLedger`；前台显示为「方案与产出额度」，企业版 `creditsPerMonth<0` 记为不限量（余额 `-1`，产出不扣减）。真实支付/微信支付回调尚未接入，见 §13。
- **智能体开通**：`free`/`metered` 智能体无需开通即可用；`unlock` 智能体需用户用算力购买（`POST /agents/:key/purchase`）或运营后台开通后才能对话/产出，未开通产出返回 `403 AGENT_LOCKED` 且不落会话。
- **离线兜底**：server 模式下后端不可达时，登录回退为 `local-<手机号>` 本地会话，保证可体验（无服务端数据）。
- **退出登录**：「我的」页底部。
- 端到端隔离已验证（见 §11）。生产应把 `token=userId` 换成**短信验证码 + JWT**，路由隔离逻辑不变。

---

## 7. 前端（app）架构

### 7.1 页面与导航
Tab 页（自定义导航 `navigationStyle: custom` + 自定义底栏 `custom-tab-bar`）：

| Tab | 页面 | 说明 |
|---|---|---|
| 首页 | `pages/home` | 问候 + 今日献策 + 对话入口卡 + 「今日经营线索」+ 常用顾问 |
| 智库 | `pages/thinktank` | 顾问型智能体列表（advisory），前台展示可用/已启用/按需/专项能力状态 |
| 对话 | `pages/sessions` | 会话历史；底栏中间「对话」=开新会话 |
| 智能体 | `pages/studio` | 创作型智能体（creative），支持按需/专项能力展示 + 专属助手配置 |
| 我的 | `pages/profile` | 账号/项目工作台/方案库/方案与额度弹层/本命色/退出登录 |

非 Tab 页：`pages/chat`（对话流 + 渐进式成果卡）留在主包；项目工作台、项目详情、方案库、报告页已拆到 `packages/work/*` 分包（`packages/work/projects`、`project`、`library`、`report`），由 `pages/profile` 与 `pages/chat` 预加载。

### 7.2 关键 UI 约定（踩过的坑，勿回退）
- **小程序工程约束清单（先读）**：
  - **项目导入与配置**：微信开发者工具只导入 `app/`；`app/project.config.json` 是正式配置，保持 AppID、`miniprogramRoot=dist/`、`urlCheck/es6/enhance/postcss/minified` 等正式校验/压缩开启；本机调试差异放 `app/project.private.config.json`，不要把根目录误生成的 DevTools 配置纳入提交。
  - **原生 tabbar 只隐藏不恢复**：custom tabBar 模式下任何路径都不得调用 `Taro.showTabBar`。正常 Tab 挂载/切换只调用 `hideNativeTabBarOnly()` 压住微信原生底栏；全屏 overlay 用 `store.setOverlay(open, stableKey)` 写 storage 并隐藏自定义底栏，关闭/卸载时清理对应 key。
  - **弹层不进 custom-tab-bar**：`custom-tab-bar` 只做导航和 overlay 状态同步，不渲染 `Login` 或其它全屏业务弹层；未登录点击中间「对话」只提示并跳 `pages/chat`，由聊天页承接登录弹层。
  - **overlay 同步不用轮询**：底栏状态同步依赖 `eventCenter` + 页面 `useDidShow` + `hideNativeTabBarOnly()` 短延时兜底；不要恢复 250ms/1500ms 常驻 interval。
  - **顶部安全区统一组件化**：Tab 页用 `Screen topInset`，非 Tab 自定义头用 `SafeHeader`；不要在页面里各写一套 `env(safe-area-inset-top)`，不要加伪状态栏 `9:41`。
  - **对话键盘按真机口径写**：`pages/chat` 保持页面 `disableScroll: true`、输入 `adjustPosition={false}`、`alwaysEmbed`、整条 `.box` 触发 focus、`onInput` 返回 `e.detail.value`、`onConfirm` 使用事件值发送，并由 `onKeyboardHeightChange` 写 `--keyboard-height` 让 `.chat` 自己压缩底部空间。
  - **登录/401/网络错误有统一入口**：用户动作前先检查登录态；401 必须清用户态并弹登录/回首页，不能吞成空态或“产出失败”；`Taro.request` reject 要映射成网络/合法域名提示；需要登录的数据页 catch 后先调 `handleApiError`。
  - **H5 兼容不污染小程序路径**：H5 自定义底栏只放 `app.h5.tsx/app.h5.scss`；小程序继续走真实 `page` 节点 + `src/custom-tab-bar`，不要把 H5/weui 兼容样式混进小程序原生 tabbar 路径。
  - **主包持续控重**：项目工作台、项目详情、方案库、报告等非首屏工作流留在 `packages/work` 分包；新增重页面优先分包并在入口页配置预加载，除非确实属于首屏主路径。
  - **真机排版防回退**：标题类 `<Text>` 保持块级化；两列网格用 `space-between + 48.5%`；Markdown 内容用 `MarkdownText`；等待模型返回要显示对话流思考气泡；全屏弹层、色盘、商业文案按下方约定处理。
- **小程序历史坑只维护一份**：顶部安全区、原生 tabbar、overlay、键盘、登录、H5 样式隔离、网络错误和分包控重以本清单为准；不要在页面里另写一套平行实现。
- **本命色色盘对齐**：`components/Picker` 的色点与名称必须在同一个 `.pk-swatch` 垂直列里渲染；不要拆成上下两条 flex 行，否则选中外圈宽度会导致标签错位。
- **首页标题宋体化**：`pages/home` 通过 `Screen className="home"` 局部定义标题字体栈，品牌名、问候语、今日献策正文、对话卡提问、分区标题与卡片标题使用宋体优先；不要为此改全局 `--serif`，避免影响其它页面。
- **前台商业文案克制**：面向用户的主路径不要写成“赠送 / 付费解锁 / 充值 / 最受欢迎 / 灵活付费”这类促销口吻；统一用「可用」「已启用」「专项能力」「产出额度」「方案与额度」「常用配置」表达，让用户感到是在调用工作台能力，而不是被推销。智能体费用展示用 `💎xN` / `💎xN/次`，不要写「启用需 N 点」「每次产出 N 点」；后台/代码契约仍可保留 `free/unlock/metered/credits` 等技术术语。
- **Markdown 渲染**：AI 普通回复、成果卡正文、报告详情正文必须通过 `components/MarkdownText` 渲染，支持标题、段落、列表、引用、加粗、行内代码和代码块；不要直接把模型返回的 `###` / `**` / `-` 原样塞进 `<Text>`。
- **前台记忆披露**：对话页用「专属理解」包装 Agent Memory，不直接暴露后台术语；问候气泡披露会参考企业档案、对话偏好、引用资料，顶部记忆条展示当前顾问已理解的上下文，学习成功提示用“专属理解已更新/已校准业务偏好和判断口径”。后端真实记忆开关见 §9。
- **两列网格**：用 `justify-content: space-between` + `width: 48.5%`，**不要用 `calc(50%-5px)+gap`**（亚像素取整会溢出换行成竖排）。
- **深色卡光感**：对话入口卡用 `--accent-deep` 对角渐变 + `--accent-glow` 柔光，随本命色自适应。

### 7.3 启动流程
`app.tsx` 启动拉 `loadAgents()` + `loadMe()`（未登录跳过）。首页：未登录→登录弹层；已登录未建档→本命色/30 秒建档 picker。

### 7.4 状态与主题
- `services/store.ts`：轻量全局 store（订阅式）。本命色 / 用户 / 智能体缓存 / tab / overlay / 登录态。
- `loadAgents()` 必须保留 `DEFAULT_AGENTS` 的 `billing/price/owned` 兜底字段；线上旧 `/agents` 若缺权益字段，不能覆盖掉前台解锁门禁，否则 `💎xN` 专项能力会被误判为可直接进入。
- `data/colors.ts`：6 套本命色主题变量（`--accent` 系列）。

---

## 8. 后端（server）

### 8.1 API 一览（`/api` 前缀）
| 方法 路径 | 说明 | 鉴权 |
|---|---|---|
| `POST /auth/login` | 手机号 fake 登录/注册 | 否 |
| `POST /auth/wechat-login` | 小程序微信登录：code 换 openid/unionid 后注册/登录 | 否 |
| `GET /health` | 健康检查 | 否 |
| `GET /me` · `PUT /me/color` | 当前用户(+onboarded+ai信息) · 改本命色 | 是 |
| `GET /agents` · `GET /agents/:key` | 智能体注册表；带 token 时回填 `owned` | 否 |
| `POST /agents/:key/purchase` | 用算力一次性解锁 `unlock` 智能体（幂等，已开通不重复扣费） | 是 |
| `GET /survey` | 建档问卷 | 否 |
| `GET /profile` · `PUT /profile` | 企业档案读/写（写=完成建档） | 是 |
| `GET /sayings/today` | 每日献策 | 否 |
| `GET /plans` · `POST /plans/:id/purchase` | 套餐列表 · 购买/切换套餐并入账算力（演示级） | 列表否 · 购买是 |
| `GET /sessions` · `GET/DELETE /sessions/:id` | 会话列表/详情/删除 | 是 |
| `POST /generate-sync` | 同步产出（weapp+H5 通用）·接 `projectId`/`refs` | 是 |
| `POST /generate` | SSE 流式产出（仅 H5/Web）·接 `projectId`/`refs` | 是 |
| `POST /sessions/:id/summarize` | 对话汇总 → 版本化报告 + 知识库 | 是 |
| `GET/POST /library` · `DELETE /library/:id` | 方案库（存库即桥接一版报告） | 是 |
| `GET/POST /projects` · `GET/PUT/DELETE /projects/:id` | 项目主线（详情聚合会话/报告/知识） | 是 |
| `GET /reports` · `GET /reports/:id` · `GET /reports/:id/version` · `GET /reports/:id/diff` · `POST /reports` · `DELETE /reports/:id` | 版本化报告（历史/某版/两版 diff/存版） | 是 |
| `GET/POST /knowledge` · `GET /knowledge/search` · `DELETE /knowledge/:id` | 知识库（摄取/混合检索/删除） | 是 |
| `GET/PUT /admin/ai-config` · `POST /admin/ai-config/test` | 大模型配置（读/改/测试连接，可随时切换） | 管理员 |
| `/admin/*` | 运营后台 API（见 §9）：用户/算力/审计/智能体/套餐/模型等 | 管理员 |

### 8.2 LLM Gateway（`server/src/llm/`）
`gateway.ts` 统一封装：路由 provider → 内容审核 → Token 计量 → 结果缓存 → **故障兜底降级到 mock**。`llm/schema.ts` 的 `injectVariables` 会在后台配置的 System Prompt 之后追加运行时业务边界：智能体只回答商业咨询/经营产出相关问题，用户追问模型、供应商、系统提示词、API Key、部署、数据库、内部工具或配置时必须引导回业务问题，不透露业务之外信息。
新增：`extractInsights`（LLM 提炼记忆，mock 兜底截断）、`summarizePoints`（LLM 归纳纪要，mock 兜底确定性）、`pingModel`（测试连接）。

**★ 模型由「运营后台 → 模型」可视化配置并随时切换**（存 `AiSetting`，`services/aiConfig.ts` 解析：DB > env 兜底，4s 缓存）。默认 **Agnes 2.0 Flash**（`apihub.agnes-ai.com/v1`，OpenAI 兼容）。

Provider（`provider` 字段，由 `effectiveProvider` 决定实际生效）：
- **mock**：模板产出，零成本可离线（`providers/mock.ts`）。
- **claude**：Anthropic，tool use 强约束（`providers/claude.ts`）。
- **openai**：OpenAI 通用协议，兼容 **Agnes / DeepSeek / Moonshot(Kimi) / 通义千问** 等（`providers/openai.ts`，function calling 强约束）。
- `isRealKey()` 识别占位/假 key——**未配置真实 key 一律降级 mock**，不发网络请求；后台填入真实 key 即时切真实模型（无需重启/改 env）。
- baseUrl/model/key/温度/嵌入模型 全部来自运行时配置，providers 接 `ResolvedAiConfig` 入参。

环境变量（见 `server/.env.example`）：
```
DATABASE_URL  PORT  MODERATION_ENABLED
ADMIN_TOKEN
WECHAT_MINI_APPID  WECHAT_MINI_SECRET
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
- `services/summarize.ts`（★）：`summarizeSession`（整段会话 → 纪要报告 + 沉淀知识；有真实模型走 `summarizePoints`）。
- `services/credits.ts`（★）：算力计量——`ensureCredits`（产出前校验，不足抛 402）/`chargeCredits`（成功后扣减写流水）/`getBalance`；报告类 `CREDIT_COST.report=1`、对话免费，企业版(creditsPerMonth<0)不限量。在 `sessions.ts` 两个产出路由接入；套餐购买由 `routes/plans.ts` 写入充值/不限量流水并记录审计。
- `services/entitlements.ts`（★）：智能体权益——`assertAgentAccess` 拦截未解锁 `unlock` 智能体（403 `AGENT_LOCKED`）、`agentCost` 统一 `free/unlock/metered` 的产出计费、`publicOwned` 给前台展示可用状态。
- `services/adminAuth.ts`（★）：运营后台鉴权——`/api/admin/*` 统一要求 `ADMIN_TOKEN`（`x-admin-token` 或 `Authorization: Bearer`）或 `role=admin` 用户；普通小程序用户访问返回 403，无凭证返回 401。
- `services/aiConfig.ts`（★）：大模型配置解析（DB > env），预设 `AI_PRESETS`（Agnes/DeepSeek/Qwen/Moonshot/OpenAI/Claude/mock）、`isReady`/`effectiveProvider`、脱敏 `publicConfig`。
- `services/vectorStore.ts`（★）：pgvector ANN 查询/向量列双写（`PGVECTOR_ENABLED` 开启时；默认关闭走内存余弦）。
- `services/audit.ts`（★）：统一审计记录与秒级 ISO 时间格式；Fastify `onResponse` 钩子会记录所有带有效 `x-user-id` 的小程序 `/api/*` 行为（方法/路径/状态码），关键业务动作另写语义日志（登录、建档、产出、存库、汇总、后台配置变更）。
- 内容审核 `moderation_log`、审计 `audit_log`（演示级，生产替换合规服务）。

---

## 9. 运营后台（admin）

页面/接口：概览看板、**注册用户管理**（小程序注册用户、微信绑定、租户/套餐、最后会话、会话/成果数、算力余额，并可点进用户详情为其开通/取消 `unlock` 智能体）、**算力消耗**（按用户汇总赠送/消耗/余额、30 天活跃、成果数）、**审计日志**（最近 100 条，时间精确到秒，展示用户/租户/动作/payload）、每日献策库（增删改启停）、智能体/功能配置（新增智能体、基础信息、`free/unlock/metered` 定价、System 提示词 + Agent Memory 策略 + **上架/下架**，前台 `/agents` 默认只展示已上架功能）、**模型配置（默认 Agnes，可一键切 DeepSeek/Qwen…，含测试连接，即时生效）**、建档问卷、套餐编辑。所有 `/api/admin/*` 路由由 `services/adminAuth.ts` 保护：运营端登录页填写后端 `ADMIN_TOKEN`，请求以 `x-admin-token` 发送；后端也支持 `role=admin` 用户。新增/扩展 admin API：`GET /admin/users/:id`、`POST /admin/users/:id/agents`、`DELETE /admin/users/:id/agents/:key`、`POST /admin/agents`、`PATCH /admin/plans/:id`，并保留 `GET /admin/users`、`GET /admin/usage`、`GET /admin/audit-logs`。入口 `admin/src/App.tsx`（`UsersView/UserDetailPanel/UsageView/AuditView/ModelView/PlansView`）+ `AgentDetailPanel.tsx`，API `admin/src/api.ts`（类型来自 SSOT）。默认 System Prompt 位于 `server/src/data/agents.ts`，商业咨询类按麦肯锡式问题解决法（MECE、假设驱动、80/20、金字塔原则、So what/Now what、30 天行动清单）设置；上线同步用 `cd server && npm run admin:sync-content`，同步智能体基础信息、权益计费、提示词与记忆配置并追加缺失每日献策，不删除业务数据、不覆盖启停状态。Agent Memory 开关保存到 `Agent.memoryConfig` 并由后端真实读取：`longTerm=false` 时不召回/不写入长期记忆，`autoLearn=false` 或去掉 `conversation` 来源时不从对话学习，`intensity/retentionDays` 影响写入权重和过期时间，`deliverable_feedback` 控制成果反馈回流。开发期 Vite 代理 `/api → localhost:4000`。本地后台使用全屏无边框容器，`admin/src/styles/admin.css` 需要保持视口安全收缩、横向隐藏和长文本断行，底部导航为横向滚动，避免新增模块或模型 URL/API Key/状态文案撑出屏幕。

---

## 10. 数据库（Prisma · `server/prisma/schema.prisma`）

租户 `Tenant` / 用户 `User`(phone 唯一；`wechatOpenId/wechatUnionId` 可选唯一绑定微信账号；`role=owner|member|admin`) / 档案 `Profile` / 智能体 `Agent`（`billing/price/gift/enabled` 定义权益与价格）/ 用户智能体权益 `UserAgent` / 会话 `Session` / 消息 `Message` / 成果 `Deliverable` / 记忆 `Memory` / 献策 `Saying` / 问卷 `SurveyQuestion` / 套餐 `Plan` / 算力流水 `CreditLedger` / 审计 `AuditLog` / 审核 `ModerationLog`。业务表均含 `tenantId` 行级隔离。

**新增模型（企业事务操作系统）**：
- `UserAgent`（用户已开通的智能体，`(userId,agentKey)` 唯一；`source=gift|purchase|admin_grant`，用于 `unlock` 权益校验和后台开通管理）。
- `Project`（项目主线，租户级，`(tenantId,slug)` 唯一）；`Session.projectId` / `Memory.projectId` / `Deliverable.projectId` 归属项目。
- `ReportDoc`（逻辑报告，`(tenantId,slug)` 唯一，`currentVersion`）+ `ReportVersion`（不可变快照，`contentHash` 去重，`changeSummary` 变更摘要，`(reportId,version)` 唯一）。`Deliverable.reportId` 桥接。
- `KnowledgeItem`（知识条目，可挂项目）+ `KnowledgeChunk`（切片 + `embedding`）。
- `Message.refsJson`（本条消息引用的 项目/报告/知识/记忆）。
- `AiSetting`（单例 id=`default`，大模型配置：provider/baseUrl/model/apiKey/embeddingModel/temperature）；pgvector 开启时 `knowledge_chunk`/`memory` 另有 `embedding_vec vector(N)` 列（由 `prisma/pgvector.sql` 建，非 Prisma 管理）。

> 生产：`Memory.embedding` 与 `KnowledgeChunk.embedding` 应用 **pgvector** 的 `vector` 类型 + HNSW 索引；本地降级为 `Json(float[])` + 内存余弦相似度（与 schema 注释一致）。详见「✦ 升级路径」。

---

## ✦ 企业事务操作系统（工程摘要）

完整产品说明见 `PRODUCT.md`。工程上只需记住这些边界：

- 项目、报告、知识、记忆、引用都必须按 `tenantId` 隔离；新增可被引用/召回的数据类型时，补跨用户不可见断言。
- `buildGenContext` 是上下文注入总入口：企业档案、本命色、项目背景、显式引用、知识库召回、长期记忆都从这里进模型。
- 报告版本由 `services/reports.ts` 管：slug 归一、内容哈希去重、section/word diff；不要在页面层自己拼版本逻辑。
- 知识与记忆检索走 `services/retrieval.ts` / `services/memory.ts`；默认本地向量 + 内存余弦，`PGVECTOR_ENABLED=true` 后走 `services/vectorStore.ts`。
- 升级方向和产品口径看 `PRODUCT.md`；未完成项仍以 §13 TODO 为准。

## 11. 构建、运行、验证

### ★ 一键开发（PostgreSQL，推荐）
```bash
npm run dev            # 根目录：确保 PG → 建库 → 迁移 → (首次)灌种子 → 同时起 后端 + H5 + 运营后台
```
- 入口 `scripts/dev.sh`（根 `package.json`）。打开 **H5 http://localhost:5173**（浏览器手测）、后台 http://localhost:5174（改模型）、API :4000。
- 可配：`AI_PROVIDER=openai npm run dev`（真实模型）、`SEED=1 npm run dev`（强制重灌种子）、`DATABASE_URL=... npm run dev`（指向已有库）、`DB_NAME/DB_USER/DB_PASS/DB_HOST/DB_PORT` 覆盖默认。
- 演示账号手机号 `13800000000`（含演示项目/报告/知识）；Ctrl+C 一并关闭三端。

### 本地 mock（零依赖，纯前端走查）
```bash
cd app && npm install && npm run dev:weapp   # 微信开发者工具导入 app/ 目录；或 npm run dev:h5 浏览器
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

### 后端集成测试（★ 大变更必跑 · 详见 `docs/TESTING.md`）
- 入口：`server/src/app.ts` 的 `buildApp()` 工厂（`index.ts` 用它 listen，测试用 `app.inject` 免端口）。
- 跑法：备好测试库 → `DATABASE_URL=...junshi_test npm run db:push` → `AI_PROVIDER=mock npm test`。
- 全程 mock 模型（确定性、可复现），无需真实 key/pgvector。**现状 47 用例 / 21 套件（0 跳过）**；覆盖微信登录 openid 复登、运营后台鉴权、算力/套餐购买、智能体权益与用户主路径。最近一次本地临时 PostgreSQL 测试库实跑为 2026-06-13，47/47 全过。
- 覆盖：鉴权隔离、微信 openid 登录/复登、运营后台鉴权、多智能体对话、智能体 `free/unlock/metered` 权益、记忆语义召回+TTL、项目+知识库+跨对话召回、跨项目隔离、对话汇总、版本化报告+diff、**★跨用户隔离（防信息泄露 TC-G）**、模型配置不泄露明文 key、SSE 流式、内容审核拦截、算力赠送/扣减/不足拦截、套餐购买/企业版不限量、并发冒烟、首登建档个性化、老用户回流、跨智能体协同+引用闭环、成果反馈回流、用户主路径、边界健壮性。
- CI：`.github/workflows/server-integration.yml` 用 GitHub Actions `postgres:16-alpine` 服务（tmpfs 数据目录）执行 `npm ci`、`prisma generate`、后端 build、`prisma db push`、`npm test`。
- 红线：改 路由/鉴权/检索/上下文/数据模型 后必须 `npm test` 全绿；新增可隔离数据类型须在 TC-G 补「跨用户不可见」断言。

### 端到端隔离验证（本地 Postgres + mock provider）
已用 curl 跑通 **19/19**：无 token→401、新号建号、A/B token+租户不同、A 建档/产出/存库后 A 有数据而 **B 全空（隔离）**、A 复登 token 不变且 onboarded 持久化、demo 号可登录、非法 token→401、非法手机号→400。

### 本机上传到小程序平台（miniprogram-ci）
> 云端沙箱网络白名单未放行 `servicewechat.com`，需在**本机**执行。
```bash
cd app && npm run build:weapp           # 产物在 app/dist（默认 mock 版）
npx miniprogram-ci upload \
  --pp ./ \                              # 项目路径=app（其 project.config.json 的 miniprogramRoot=dist/）
  --pkp /path/to/private.wx05a49967e2adb557.key \
  --appid wx05a49967e2adb557 \
  --uv 0.1.0 -r 1 --ud "junshi mock build"
```
注意：上传密钥若在小程序后台开启了 **IP 白名单**，须把本机出口 IP 加入；连真实后端版本另需把 API 域名加入 request 合法域名（见 §12）。

### 微信账号登录联调
```bash
cd server
cp .env.example .env
# 填 WECHAT_MINI_APPID=wx05a49967e2adb557 与 WECHAT_MINI_SECRET
npm run db:push && npm run dev

cd ../app
TARO_APP_MODE=server TARO_APP_API=https://你的域名/api npm run build:weapp
```
微信开发者工具导入 `app/`；本地调试可勾选“不校验合法域名”，真机/预览必须把 `TARO_APP_API` 的 HTTPS 域名加入小程序后台 request 合法域名。

---

## 12. 上线前硬约束（微信小程序）

> 服务器部署（裸机 Node+Nginx+PG / Docker）见 **`docs/DEPLOYMENT.md`** + `deploy/` 模板（含架构图、Nginx/systemd/compose、HTTPS、模型配置、安全 checklist）。
> 运营后台路径部署在 `/admin/`；Nginx 模板已将 `/admin` 301 到 `/admin/`，避免无尾斜杠时被 H5 fallback 当作移动端首页。

mock 可随时预览；**正式上传/审核**还需：
1. **真实 AppID**：已设为 `wx05a49967e2adb557`（`app/project.config.json`）。
2. **微信登录密钥**：服务端配置 `WECHAT_MINI_APPID/WECHAT_MINI_SECRET`；AppSecret 不得进入前端包或仓库。
3. **后端公网 HTTPS + ICP 备案域名**，并加入小程序后台 request 合法域名；前端用 `TARO_APP_MODE=server TARO_APP_API` 指向它。
4. **生成式 AI 备案 / 算法备案 + 内容安全**（AI 类小程序审核硬性门槛）。
5. 真实模型：服务端设 `AI_PROVIDER` + 真实 key（国内合规建议走备案的国产模型，走 openai 兼容协议即可）。

---

## 13. 已知限制 / TODO

- **miniprogram-ci 上传**：云端执行环境的网络白名单未放行 `servicewechat.com`（报 `Host not in allowlist`），无法在本沙箱内直传。需从**本机**执行上传，或放开环境网络策略后重试；另注意上传密钥若开了 IP 白名单，需把执行机出口 IP 加入小程序后台。本机命令见 §11。
- 自有登录态仍是演示 token（`token=userId`）；微信 openid 已接入，手机号短信校验与 JWT 仍待生产化。
- `server/.env.example` 的 `OPENAI_API_KEY` 是 fake 占位，自动降级 mock；填真实 key 才走真模型。
- 内容审核/计量/缓存为演示级（关键词 / 内存）；生产替换为合规审核 + Redis + 计费台账。
- 套餐购买为演示级（直接切套餐并写入算力流水）；生产需接微信支付/订单状态机/支付回调验签/幂等入账，避免绕过支付直接加算力。
- 签名服务偶发不可用时提交为未签名（不影响功能）。
- **pgvector 路径已实现但未真库验证**：本地无扩展，默认 `PGVECTOR_ENABLED=false` 走内存余弦（已验证）；上真库执行 `npm run db:pgvector` 并置 true 后需端到端验一遍（升级路径 1）。
- **模型密钥明文存库**（`AiSetting.apiKey`，演示）；生产加密/接密管。运营后台已有共享密钥/`role=admin` 基线鉴权，但仍需细粒度 RBAC、管理员账号体系与密钥轮换策略（升级路径 8）。
- **时序知识图谱**（Graphiti 式）未做；运营后台暂无 项目/报告/知识 只读看板（接口已就绪）。
- **@引用** 选择器候选含 项目/报告/知识；记忆引用未单列候选（可由「知识」覆盖），如需可补一组。

---

## 14. 变更日志（每次迭代追加，最新在上）

> 格式：`YYYY-MM-DD · 改动 · 影响面`

- **2026-06-13** · **修复智能体解锁门禁被旧接口冲掉**：`store.loadAgents()` 合并线上 `/agents` 与本地 `DEFAULT_AGENTS`，当旧后端缺少 `billing/price/owned` 时保留本地权益字段，避免标 `💎xN` 的 `unlock` 智能体被误判为可直接进入对话。
- **2026-06-13** · **扩展线上智能体内容同步**：`server/scripts/syncAdminContent.ts` 现会同步智能体基础展示字段、`billing/price/gift` 权益字段、提示词与记忆配置，并继续保留线上上架/下架状态，避免旧库新增列默认 `free/0` 后把专项能力误开为免费。
- **2026-06-13** · **修复成果缓存串公司抬头**：`llm/gateway.ts` 的结构化成果缓存 key 纳入 `companyName`、行业、阶段、痛点与项目名，避免不同用户相同输入复用旧成果导致报告 meta 不带当前公司；`.gitignore` 排除微信预览二维码/信息文件，Docker 临时 Postgres + Node 容器完整测试用于回归验证。
- **2026-06-13** · **拆分产品说明并统一智能体钻石价格**：新增 `PRODUCT.md` 承接产品定位、信息架构、文案口径、企业事务操作系统和升级方向；`AGENTS.md` 收敛为工程入口与约束摘要。前台智能体费用展示新增 `services/format.ts`，智库/工坊卡片与专项能力弹层将「启用需 N 点」「每次产出 N 点」「用 N 点启用」统一改为 `💎xN` / `💎xN/次` 口径。
- **2026-06-13** · **沉淀小程序工程约束清单**：§0 新增小程序改动前置检查要求，§7.2 将项目配置、原生 tabbar、overlay key、登录弹层归属、键盘避让、401/网络错误、H5/小程序样式隔离、分包控重与真机排版修复收敛为防回归清单，后续改 `app/` 需先对照执行。
- **2026-06-13** · **彻底避免真机默认底栏回弹**：`services/tabbar.ts` 移除 `Taro.showTabBar` 分支，`store.setOverlay(false)` 关闭弹层时只恢复自定义胶囊底栏并继续强制 `hideTabBar`，避免真机偶发出现微信默认底栏与自定义悬浮底栏并存；AGENTS 更新底栏约定，明确 custom tabBar 模式下不得 show 原生 tabbar。
- **2026-06-13** · **修复对话页键盘顶起整页**：`pages/chat` 禁用页面级滚动，输入框关闭 `adjustPosition` 并改为监听键盘高度设置 `--keyboard-height`，让输入区随键盘上移但头部/问候卡不再被推到系统状态栏下方；AGENTS 同步更新对话输入兼容约定。
- **2026-06-13** · **修复小程序 High 级 review 项**：`app/project.config.json` 切为正式安全口径（开启 urlCheck/es6/enhance/postcss/minified），删除根目录误生成 DevTools 配置并保留本机 `app/project.private.config.json` 覆盖局域网预览；新增 `store.handleApiError`，会话/项目/方案库/报告/方案与专项能力弹层不再把 401/网络错误吞成空态。
- **2026-06-13** · **修复小程序 Medium 级 review 项**：`custom-tab-bar` 移除 250ms/1500ms 常驻轮询，改用 `eventCenter` 与页面 `useDidShow` 触发式同步；项目工作台/项目详情/方案库/报告页移动到 `packages/work` 分包，`pages/profile` 与 `pages/chat` 配置预加载，降低后续主包膨胀和启动风险。
- **2026-06-13** · **前台商业文案去促销化**：首页「智库 · 赠送顾问」改为「常用顾问」，「军师为你发现」改为「今日经营线索」；智库/工坊/专项能力弹层/方案弹层/我的页/对话错误提示统一将“赠送、付费解锁、充值、算力”降级为「可用、已启用、专项能力、方案与产出额度」等工作台口径；同步 mock 与 seed 套餐 feature 文案，避免用户感到首屏在卖权益。
- **2026-06-13** · **智能体权益/解锁计费与运营后台鉴权**：SSOT 新增 `AgentBilling`、`Agent.billing/price/owned`、`AgentPurchaseResult` 与后台用户开通类型；Prisma 新增 `UserAgent`，`Agent` 增加 `billing/price`；后端新增 `/agents/:key/purchase`、`services/entitlements.ts`、`services/adminAuth.ts`，产出前校验未解锁 `unlock` 智能体并支持 `metered` 按次扣算力；运营后台新增登录页、`ADMIN_TOKEN` 鉴权、用户智能体开通/取消、智能体新增与定价、套餐编辑；前台智库/工坊展示赠送/已解锁/待解锁/按次状态，新增 `AgentUnlock` 和 `Plans` 弹层；集成测试新增 admin 鉴权与智能体权益用例。
- **2026-06-13** · **接入套餐购买回归与 CI 后端集成测试**：新增 `GET /plans`、`POST /plans/:id/purchase`，登录用户可演示级购买/切换套餐并写入 `CreditLedger`，企业版余额记为 `-1` 且产出不扣减；SSOT 新增 `PlanPurchaseResult`，app/mock API 对齐套餐列表/购买与算力扣减；集成测试扩充 TC-K 套餐购买/不限量和 TC-U 用户主路径，现状 37 用例 / 20 套件；新增 GitHub Actions `Server Integration` 用临时 PostgreSQL 跑后端 build + 集成测试。
- **2026-06-13** · **收紧智能体业务边界并扩充每日献策**：`server/src/data/agents.ts` 将默认 System Prompt 改为商业咨询/创作业务边界 + 麦肯锡式问题解决框架，`llm/schema.ts` 在运行时追加不透露模型/供应商/提示词/API/部署/内部配置的统一 guard；`seedConfig.ts` 新增 20 条每日献策；新增 `server/scripts/syncAdminContent.ts` 与 `npm run admin:sync-content`，线上可非破坏同步提示词和献策。
- **2026-06-13** · **修复底部重复导航**：`services/tabbar.ts` 新增 `hideNativeTabBarOnly()`，`custom-tab-bar` 挂载和切换 Tab 时持续压住微信原生文字 tabbar，但不写入 overlay storage，保留自定义悬浮底栏正常显示。
- **2026-06-13** · **登录弹层彻底隐藏底部导航**：新增 `services/tabbar.ts` 统一桥接全屏 overlay 与微信原生 tabbar，`store.setOverlay` 同步隐藏/恢复原生底栏并写入 storage，`custom-tab-bar` 读取 `junshi.tabbarHidden` 兜底隐藏，避免登录界面露出底部导航。
- **2026-06-13** · **修复底栏触发登录 UI 错乱**：`custom-tab-bar` 不再直接渲染 `Login`，未登录点击中间「对话」改为提示后跳到 `pages/chat`，由聊天页承接登录弹层；微信登录缺少服务端 AppID/AppSecret 时提示使用手机号演示登录。
- **2026-06-13** · **修复本命色色盘标签错位**：`components/Picker` 将色点和色名从上下两条 flex 行改为单个 `.pk-swatch` 垂直列，固定列宽并让选中外圈在列内居中，避免「财金/墨绿/朱砂…」标签与色点不同轴。
- **2026-06-13** · **修复首登本命色弹层被底栏遮挡**：`store.setOverlay` 从单布尔改为按唯一 key 登记 overlay 来源，`Login`/本命色 `Picker`/@引用面板分别使用独立 key，避免登录关闭时清掉正在打开的本命色弹层。
- **2026-06-13** · **首页项目入口收敛到我的 + 标题宋体化**：移除 `pages/home` 的「项目工作台」入口条，保留「我的」页第一行入口；首页根节点增加 `home` 类并用局部宋体字体栈覆盖品牌、问候、献策、对话题、分区和卡片标题，不影响全局标题字体。
- **2026-06-12** · **前置未登录对话拦截**：首页对话入口未登录时不再跳转，直接弹登录提示；底栏中间「对话」未登录时在当前页弹登录并在登录后再开新会话；`pages/chat` 首帧检测无 token/401，先渲染兜底问候并立即弹登录，避免先白屏再显示登录。
- **2026-06-12** · **前台产品化披露 Agent Memory**：`pages/chat` 顶部记忆条改为「专属理解」表达，问候气泡新增轻量说明卡，披露顾问会参考企业档案、对话偏好和引用资料；记忆写入成功提示改为“专属理解已更新/已校准业务偏好和判断口径”，避免直接暴露后台术语。
- **2026-06-12** · **运营后台改为全屏无边框并补严记忆主开关**：`admin/src/styles/admin.css` 去掉本地后台手机壳边框、圆角、阴影和页面外边距，改为占满视口；`services/context.ts` 在 `longTerm=false` 时不再召回既有长期记忆，`services/memory.ts` 在 `longTerm=false` 时不再写入成果反馈记忆，使 Agent Memory 主开关语义与后台配置一致。
- **2026-06-12** · **扩充运营后台为真实管理台**：SSOT 新增 `AdminUserItem/AdminUsageView/AdminAuditItem`；后端新增 `/admin/users`、`/admin/usage`、`/admin/audit-logs`，概览改为读取真实用户/会话/成果/算力/审计数据；新增 `services/audit.ts` 统一秒级审计时间与小程序 API 行为审计，登录/建档/产出/存库/汇总/后台配置变更写入语义审计；运营端新增用户、消耗、审计模块，顾问页支持功能上架/下架并记录审计，底部导航改为横向滚动以容纳真实后台模块。
- **2026-06-12** · **修复运营后台本地预览边框越界**：`admin/src/styles/admin.css` 收紧手机壳宽高为视口安全值，给滚动容器/表单/卡片/flex 子项补 `min-width:0` 与长文本断行，并在窄屏下让新增/模型操作按钮自动换行，避免本地 `npm run dev` 预览时边框或内容横向溢出。
- **2026-06-12** · **接入微信小程序账号登录**：新增 `POST /auth/wechat-login` 与 `services/wechat.ts`，服务端用 `WECHAT_MINI_APPID/WECHAT_MINI_SECRET` 调 `jscode2session`，按 openid/unionid 注册或复登并保留 `session_key` 不下发；`User` 增加 `wechatOpenId/wechatUnionId/wechatLinkedAt`；小程序 server 模式登录弹层新增「微信账号登录」，H5/mock 保持手机号演示登录；补后端集成测试、`.env.example`、部署/测试文档。
- **2026-06-04** · **统一非 Tab 页顶部安全区与报告页排版**：新增 `components/SafeHeader`，对话/项目/项目列表/方案库/报告页统一按微信胶囊实测值避让状态栏和右侧胶囊，移除各页独立 `env(safe-area-inset-top)` 头部实现；报告详情页优化版本卡、模式切换与文档正文间距，成果卡/报告/对话要点列表改用块级 Markdown 渲染，避免 `**` 等标记在真机原样显示。
- **2026-06-04** · **格式化 AI 返回 Markdown 文档**：新增 `components/MarkdownText` 轻量 Markdown 渲染器，覆盖标题/段落/列表/引用/加粗/代码；`pages/chat`、`ReportCard`、`pages/report` 接入，避免模型返回的 Markdown 原文未格式化显示。
- **2026-06-04** · **新增对话 AI 思考动效**：`pages/chat` 在 `busy` 状态下渲染对话流内思考气泡，包含顾问身份、三点 pulse 动画与“正在梳理上下文”提示，并在发送后自动滚到底部，避免等待模型返回时页面像卡死。
- **2026-06-04** · **明确小程序网络/合法域名错误**：`services/api.ts` 捕获 `Taro.request` reject，根据 `errMsg` 提示 request 合法域名需配置 `https://wxapi.aibuzz.cn` 或网络失败，避免小程序端请求未到服务器时仍显示泛化“产出失败”。
- **2026-06-04** · **修复小程序对话输入无法输入**：`pages/chat` 输入框新增整条输入区 focus、显式 `type=text`、`cursorSpacing/adjustPosition/alwaysEmbed`，`onInput` 返回当前值并由 `onConfirm` 直接用事件值发送；补 `.chat-log min-height:0` 与 `.cinput min-width/width`，提升真机输入框可点、可输、可发送稳定性。
- **2026-06-04** · **修复小程序 Chat/Studio 顶部界面错位**：`pages/chat` 用微信胶囊实测值设置顶部栏 padding 与右侧避让，避免标题/生成纪要落到状态栏或胶囊下；全局 `.kicker/.h1` 改为块级标题，`pages/studio` 补齐 hero、分组标题与两列智能体卡样式，修复标题文字挤成一行和工坊列表排版缺失。
- **2026-06-03** · **修复 H5/小程序视觉差异**：新增 `app/src/app.h5.tsx` 在 H5 手动挂载同款胶囊自定义底栏，新增 `app/src/app.h5.scss` 给浏览器根节点补设计 token、隐藏 Taro H5 默认 `weui` tabbar，并保持小程序 `page` + 原生 custom-tab-bar 路径不变。
- **2026-06-03** · **清理本地生成物跟踪噪声**：`.gitignore` 增加本地评审产物、微信开发者工具私有/误生成配置、Taro CLI tarball、根目录空 `package-lock.json` 忽略规则；还原 `server/package-lock.json` 的 npm 元数据抖动，保持工作区只显示真实代码/配置变更。
- **2026-06-03** · **修复运营后台无尾斜杠访问**：`deploy/nginx.conf.example` 增加 `location = /admin { return 301 /admin/; }`；ECS Nginx 已同步 reload，避免访问 `/admin` 时落入 H5 首页 fallback。
- **2026-06-03** · **修复对话页未登录错误提示**：`pages/chat` 增加登录态兜底，未登录发送/401 token 失效时弹登录并提示“请先登录/登录态失效”，402 算力不足也显示明确文案，避免统一落成“抱歉，产出失败了”。
- **2026-06-03** · **H5 server 构建环境注入修复 + IP 测试部署**：`app/config/index.ts` 显式注入 `TARO_APP_MODE/TARO_APP_API`，`app/src/services/config.ts` 直接读取注入常量，避免浏览器运行时拿不到构建期变量而退回 mock/default；已用 `TARO_APP_API=http://8.136.36.175/api` 重新构建 H5 并部署到 ECS（`/`=H5，`/api`=后端，`/admin/`=后台）。
- **2026-06-03** · `project.config.json` AppID 设为 `wx05a49967e2adb557`；尝试用 miniprogram-ci 上传，被云端网络白名单拦截（`servicewechat.com` 未放行），改为本机上传（见 §13 TODO / §11）。
- **2026-06-03** · **部署文档与模板**：新增 `docs/DEPLOYMENT.md`（架构图 + 裸机/Docker 上线步骤 + Nginx/HTTPS + 模型配置 + 安全 checklist）+ `deploy/`（nginx/systemd/Dockerfile/compose 模板）。实测后端生产构建 `npm run build`→`node dist/index.js` 可跑、admin `--base=/admin/` 资源路径正确。
- **2026-06-03** · **一键本地开发 + 修复 seed 潜伏 bug**：新增根 `package.json` 的 `npm run dev` + `scripts/dev.sh`（确保 PG/建库/迁移/首次种子/同起 后端+H5+后台，Ctrl+C 全关）。**修复 `prisma/seed.ts` 演示项目 `project.create` 缺必填 `slug`**（该段此前从未真跑过——集成测试用 `seedBaseline` 未覆盖；由一键脚本实跑暴露）。本地实跑：三端就绪、演示账号 13800000000 读到「2026 融资冲刺」项目 + 战略诊断报告 v2 + 2 条知识。
- **2026-06-03** · **H5 浏览器联调打通（替代小程序测试）**：H5 路由设 hash（`config/index.ts`，`dist/` 任意静态服务器可开）；新增 `app/scripts/serve-h5.mjs`（零依赖静态服务器）+ 脚本 `build:h5:server`/`dev:h5:server`/`serve:h5`。**本地实跑**：浏览器(:5173)→后端(:4000) CORS 预检放行 `x-user-id`、登录/产出/算力扣减全通、`/me` 读出 Agnes 配置。weapp 与 H5 无平台分叉、功能对齐。文档 `docs/TESTING.md §五`。
- **2026-06-03** · **算力计量落地（解锁 TC-K2/K3）**：新增 `services/credits.ts`（按次扣费/余额/不足拦截），`sessions.ts` 两个产出路由接入——报告类产出前校验余额（不足→402 且不建会话）、成功后扣 1 并回填 `GenResult.creditBalance`/SSE `credit` 事件；对话免费；企业版不限量。移除 gateway 空壳 `meter`。`GenResult` 加 `creditBalance?`。集成测试 **33 全过 / 0 跳过**。
- **2026-06-03** · **集成测试扩容到企业主全旅程**：在原 7 套件基础上新增 TC-I~TC-T（SSE 流式 / 内容审核拦截 / 算力赠送+扣减占位 / 并发冒烟 / 首登建档个性化 / 老用户回流 / 跨智能体协同+引用闭环 / 成果反馈回流 / 记忆 TTL / 跨项目知识隔离 / 每日献策 / 边界健壮性）；`helpers.ts` 加 `seedBaseline`（套餐+智能体+献策+问卷）。**本地 Postgres 16 实跑 31 通过 + 1 skip / 19 套件**。
- **2026-06-03** · **后端集成测试 + 文档沉淀**：抽出 `src/app.ts`(`buildApp` 工厂)、`index.ts` 改用之；新增 `server/test/`（`helpers.ts` + `integration.test.ts`，Node 原生 test runner + Fastify inject，mock 模型）；`package.json` 加 `test` 脚本。覆盖 7 套件 16 用例（鉴权隔离/多智能体/记忆召回/项目+知识库召回/汇总/报告版本+diff/**★跨用户隔离 TC-G**/模型配置）。新增 `docs/ROADMAP.md`、`docs/TESTING.md`。**本地 Postgres 16 实跑 16/16 全过**。
- **2026-06-03** · **接入 Agnes 2.0 Flash + 可切换模型配置 + 四项升级全做**：
  - 模型配置：新增 `AiSetting` 模型 + `services/aiConfig.ts`（DB>env、预设 Agnes/DeepSeek/Qwen/Moonshot/OpenAI/Claude/mock、脱敏视图、就绪/降级判定）；Gateway 与 providers/embedding 全面改为「运行时配置驱动」；新增 `/admin/ai-config`(GET/PUT/test)；运营后台新增「模型」页（预设一键切换 + 测试连接 + 即时生效）。默认 Agnes（`apihub.agnes-ai.com/v1`，OpenAI 兼容），未配 key 安全降级 mock。
  - 升级项：① pgvector 路径（`services/vectorStore.ts` + `prisma/pgvector.sql` + `PGVECTOR_ENABLED`，flag 内 ANN 下推/向量列双写，默认关）；② 真实嵌入配置驱动；③ Learned Memory/汇总 LLM 化（`extractInsights`/`summarizePoints`，mock 兜底）；④ 词级 diff（`reports.ts wordDiff` LCS，报告页句内高亮）。
  - 校验：三端构建全绿；运行时自检通过（词级 diff `eq/add` 正确；无 DB 时配置链路安全降级 mock、不泄露 key、洞察启发式兜底）。⚠️ pgvector 与真实模型联调需在你的 DB/Key 上验证。
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
