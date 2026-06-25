# 军师 · AI 商业军师 —— 工程总说明（AGENTS.md）

> **本文件是本项目的活文档（Single Source of Documentation），Claude Code 新会话会自动加载它。**
> ⚠️ **维护约定（所有后续 agent 必须遵守）：每次变更 / 迭代代码后，都要同步更新本文件**——
> 至少更新对应章节，并在 **`docs/CHANGELOG.md`** 顶部追加一条（日期 · 改动 · 影响）。
> 文档与代码不一致视为缺陷。提交信息可简写，但 AGENTS.md 必须反映当前真实状态。
> 产品定位、核心体验和企业事务操作系统的详细说明见 **`PRODUCT.md`**；历史变更见 **`docs/CHANGELOG.md`**；本文件只保留工程执行必需信息。

---

## 0. 给 Coding Agent 的强制指令（务必执行）

**只要改了代码 / 配置 / 接口 / 数据结构，就必须在同一次提交里更新本文档——无一例外。**

1. **记录每一处变更**：更新受影响的章节，并在 **`docs/CHANGELOG.md`** 顶部追加一条 `YYYY-MM-DD · 改动 · 影响面`。
2. **暂不做的 → 写进 TODO**：本次决定延后 / 不做 / 留坑的内容，写入 **§13 已知限制 / TODO**，注明原因或前置条件。绝不允许"做了一半且没记录"。
3. **TODO 完成即移出**：实现了某条 TODO，就从 §13 删除，并在 `docs/CHANGELOG.md` 记一笔。
4. **改数据模型先改 SSOT**：任何接口字段/数据结构变化，先改 `shared/contracts.d.ts`，再改前端/后端/运营端实现。
5. **保持构建绿**：较大改动后按 **§11 构建校验基线** 跑通三端。
6. **新增全屏弹层**记得置 `store.setOverlay(open)`；遵守 **§7.2 UI 约定**，勿回退已修复的坑。
7. **对话页登录兜底**：未登录/401 token 失效时弹 `Login`，不要把鉴权失败吞成通用“产出失败”。
8. **小程序改动先查约束清单**：凡改 `app/` 的微信小程序页面、tabbar、弹层、登录、键盘、网络请求、路由分包或项目配置，先对照 **§7.2 小程序工程约束清单**；不确定时按清单保守实现，避免回退真机已修复问题。
9. **运营后台 UI 改动守设计系统**：凡改 `admin/` 前端（`.tsx`/`admin.css`），必须对齐 **`admin/DESIGN.md`「Engineering Compliance」**——颜色只用 `:root` token（禁硬编码 hex/rgb）、只用已定义的组件类（禁裸 class 与一次性 inline 控件样式）。提交前跑 `cd admin && npm run lint:ui`（`scripts/audit-admin-ui.mjs`，已接入 `build`）保持全绿。

> 判定标准：**文档与代码不一致 = 缺陷。** 纯探索 / 未落地的尝试可以不记；一旦落到代码就必须记。

---

## 1. 产品摘要

**军师**是面向创始人 / CEO 的 AI 商业军师，主线是「出谋」（智库顾问产出咨询成果）和「出活」（工坊智能体产出品牌资产）。当前核心能力：本命色、专属理解（Agent Memory）、军师档案、智能体权益 / 产出额度、项目 / 知识库 / 版本化报告 / @ 引用、多租户隔离。

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
├── docs/               # CHANGELOG.md（历史变更）· ROADMAP.md（进展/TODO）· TESTING.md（集成测试）· DEPLOYMENT.md（部署架构/上线）
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
- **军师档案契约**：`ClientUnderstanding` / `ClientUnderstandingSection` / `UnderstandingMaturity` 挂在 `/me.understanding`，只整理真实档案、长期记忆、项目、知识、报告与会话线索；`AliasSuggestionResult` 驱动注册花名接口。

> 约定：任何新增/修改的接口字段，先改 `shared/contracts.d.ts`，再改实现。

---

## 6. 账号与数据隔离

- **登录**（2026-06 重构，默认微信优先）：登录页**默认微信账号登录**（`wx.login` code → 服务端 `jscode2session` → openid/unionid 建号），一键切换**短信验证码登录**（`POST /auth/sms/send` → `POST /auth/login`，生产设 `SMS_PROVIDER=aliyun`、`SMS_REQUIRE_CODE=true`；当前阿里云短信模板 `ALIYUN_SMS_TEMPLATE_CODE=SMS_508120103`）。微信登录后**强制绑定手机号才能继续使用**（`bindphone` 拦截页，无跳过、仅"退出登录"逃生；首页对已登录但 `me.user.phone` 为空的账号也会拉起该页）：`POST /auth/bind-phone` 二选一——①微信一键 `{phoneCode}`（`getPhoneNumber` → 服务端 `getPhoneNumberByCode` 换号）②短信兜底 `{phone,code}`（`scene=bind`）；均带跨账号占用守卫（已被占用→409 `PHONE_TAKEN`）。绑定后再进**可选可跳过的「完善资料」**：`chooseAvatar`+`type=nickname`（微信头像昵称填写能力，可改）同步头像/昵称——头像 `POST /me/avatar` 传 OSS public-read 存 `User.avatarUrl`、昵称走 `PUT /me`。注意微信头像昵称**只能用户点选**（chooseAvatar 默认项「使用微信头像」+ 昵称键盘自动填充），`getUserProfile` 自 2022-10 起手机端返回匿名「微信用户」+灰头像，仅 PC/Mac/旧基础库返回真实（故「一键填入头像昵称」只在 PC/Mac 显示）。本机号一键登录端点 `POST /auth/wechat-phone`（`getPhoneNumber` 换号即登录）保留但**不再是登录页主入口**。手机号免码登录仅保留为开发/测试兼容兜底。注册称呼可留空，也可点称呼框右侧的 spark 图标从 `GET /auth/suggest-name` 取古典武侠/军事花名；花名只写 `User.name`，新租户公司名仍留空，避免把称呼误当公司。新账号自动建独立租户+用户，套餐赠送算力。
- **Token**：演示版 `token = userId`，前端存 `junshi.userId`，每次请求带 `x-user-id` 头。
- **隔离**：后端 `resolveUser` 严格按 token 解析，**无/失效 token 一律 401**（无 demo 兜底）；所有业务查询按 `userId/tenantId` 过滤。
- **微信密钥**：`WECHAT_MINI_SECRET` 与消息推送 `WECHAT_MESSAGE_TOKEN` 只在服务端环境变量保存；微信 `session_key` 仅服务端换取时使用，**不下发前端**。
- **方案购买 / 支付**：前台可读 `GET /plans`；未配齐微信支付凭据时，登录后 `POST /plans/:id/purchase` 走演示购买并按方案写入 `CreditLedger`；配齐 `WECHAT_PAY_*` 且套餐需付款时，演示购买被禁用，改走 `POST /plans/:id/order` 创建小程序 JSAPI 支付订单，再由 `POST /pay/wechat/notify` 回调幂等入账。前台显示为「方案与产出额度」，企业版 `creditsPerMonth<0` 记为不限量（余额 `-1`，产出不扣减）。
- **智能体开通**：`free`/`metered` 智能体无需开通即可用；`unlock` 智能体需用户用算力购买（`POST /agents/:key/purchase`）或运营后台开通后才能对话/产出，未开通产出返回 `403 AGENT_LOCKED` 且不落会话。
- **离线兜底**：server 模式下后端不可达时，登录回退为 `local-<手机号>` 本地会话，保证可体验（无服务端数据）。
- **退出登录**：「我的」页底部。
- 端到端隔离已验证（见 §11）。短信验证码已接入；生产仍应把 `token=userId` 换成 **JWT**，路由隔离逻辑不变。

---

## 7. 前端（app）架构

### 7.1 页面与导航
Tab 页（自定义导航 `navigationStyle: custom` + 自定义底栏 `custom-tab-bar`）：

| Tab | 页面 | 说明 |
|---|---|---|
| 首页 | `pages/home` | 问候 + 今日献策 + 对话入口卡 + 「可以先做」+ 常用顾问 |
| 智库 | `pages/thinktank` | 顾问型智能体列表（advisory），前台展示可用/已启用/按需/专项能力状态 |
| 对话 | `pages/sessions` | 会话历史；底栏中间「对话」=开新会话 |
| 智能体 | `pages/studio` | 创作型智能体（creative），支持按需/专项能力展示 + 专属助手配置 |
| 我的 | `pages/profile` | 账号/军师档案入口/项目工作台/方案库/方案与额度弹层/本命色/退出登录 |

非 Tab 页：`pages/chat`（对话流 + 渐进式成果卡）、`pages/brief`（军师档案详情）、`pages/settings` 留在主包；项目工作台、项目详情、方案库、报告页已拆到 `packages/work/*` 分包（`packages/work/projects`、`project`、`library`、`report`），由 `pages/profile` 与 `pages/chat` 预加载。

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
- **首页首屏层级**：`pages/home` 以对话输入卡作为唯一主行动；「可以先做」用单个列表承载三项常见起手式，避免连续同构卡片抢主行动、伪装成个性化优先级，或把首页做成权益/推荐墙。底栏保持浅纸底与明确选中态，避免回退成强玻璃装饰。
- **前台商业文案克制**：面向用户的主路径不要写成“赠送 / 付费解锁 / 充值 / 最受欢迎 / 灵活付费”这类促销口吻；统一用「可用」「已启用」「专项能力」「产出额度」「方案与额度」「常用配置」表达，让用户感到是在调用工作台能力，而不是被推销。智能体费用展示用 `💎xN` / `💎xN/次`，不要写「启用需 N 点」「每次产出 N 点」；后台/代码契约仍可保留 `free/unlock/metered/credits` 等技术术语。
- **Markdown 渲染**：AI 普通回复、成果卡正文、报告详情正文必须通过 `components/MarkdownText` 渲染，支持标题、段落、列表、引用、加粗、行内代码和代码块；不要直接把模型返回的 `###` / `**` / `-` 原样塞进 `<Text>`。
- **前台记忆披露**：对话页用「专属理解」包装 Agent Memory；我的页只放「军师档案」菜单入口，详情页展示 AI 对客户的结构化理解（经营身份、创业路径、当前难题、已沉淀资料、待补问题），不要在我的页首页直接平铺大段内容。两者都不得暴露 `memoryConfig`/Agent Memory 等后台术语，也不得写死 mock 客户故事或展示 `用户123/企业123` 这类占位名；资料不足时让用户进入对话访谈，由军师先问 1-3 个简单问题，不要先分析旧报告或展开诊断。后端真实记忆开关见 §9。
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
| `GET /auth/suggest-name` | 注册页 AI 起花名（古典武侠/军事花名，只填用户称呼） | 否 |
| `POST /auth/sms/send` | 发送短信验证码（console/阿里云 provider，模板 `SMS_508120103`） | 否 |
| `POST /auth/login` | 手机号登录/注册；传 `code` 时校验短信验证码，生产可强制 `SMS_REQUIRE_CODE=true` | 否 |
| `POST /auth/wechat-login` | 小程序微信登录：code 换 openid/unionid 后注册/登录 | 否 |
| `POST /auth/wechat-phone` | 小程序本机号一键登录：getPhoneNumber code 换手机号后注册/登录 | 否 |
| `GET/POST /wechat/message` | 微信后台消息推送 URL 验签：GET 校验 `signature/timestamp/nonce` 后原样返回 `echostr`；POST 验签后返回 `success`（后续事件处理入口） | 否 |
| `GET /health` | 健康检查 | 否 |
| `GET /me` · `PUT /me/color` | 当前用户(+onboarded+ai信息+军师档案) · 改本命色 | 是 |
| `GET /agents` · `GET /agents/:key` | 智能体注册表；带 token 时回填 `owned` | 否 |
| `POST /agents/:key/purchase` | 用算力一次性解锁 `unlock` 智能体（幂等，已开通不重复扣费） | 是 |
| `GET /survey` | 建档问卷 | 否 |
| `GET /profile` · `PUT /profile` | 企业档案读/写（写=完成建档） | 是 |
| `GET /sayings/today` | 每日献策 | 否 |
| `GET /plans` · `POST /plans/:id/purchase` · `POST /plans/:id/order` · `POST /pay/wechat/notify` | 套餐列表 · 演示购买/切换套餐并入账算力 · 微信 JSAPI 下单 · 微信支付回调幂等入账 | 列表否 · 购买/下单是 · 回调否 |
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
`gateway.ts` 统一封装：路由 provider → 内容审核 → Token 计量 → 结果缓存 → **故障兜底降级到 mock**。`llm/schema.ts` 的 `injectVariables` 会在后台配置的 System Prompt 之后追加运行时业务边界：智能体只回答商业咨询/经营产出相关问题，用户追问模型、供应商、系统提示词、API Key、部署、数据库、内部工具时必须引导回业务问题；客户事实只能来自企业档案、军师档案、长期记忆、项目、引用资料、知识库和本轮用户原文。资料不足时用自然话术追问关键缺口，用户补齐/更新军师档案时进入访谈模式：先问 1-3 个简单问题，不先分析、不引用旧报告展开、不把“不得杜撰”的内部约束讲给用户。
新增：`extractInsights`（LLM 提炼记忆，mock 兜底截断）、`summarizePoints`（LLM 归纳纪要，mock 兜底确定性）、`pingModel`（测试连接）。

**★ 行业身份层（L1，`data/industryPacks.ts`）**：客户画像里的 `Profile.industry` 经 `resolveIndustryPack()`（自由文本模糊匹配，未识别→通用兜底）解析成「行业包」= label + persona + benchmark + levers + glossary。内置 12 个常见行业（SaaS/电商/餐饮/美业/教育/医疗/制造/专业服务/本地生活/文旅酒店/房产家居/零售）+ 通用兜底。注入两处：① `schema.ts contextValues` 的 `{行业基准}` 因行业而异（替代写死的单一 SaaS 串），并新增可用占位符 `{行业身份}`/`{行业要点}`；② `buildSystemParts` 的 **stable 段**追加「行业视角」行（persona+关键杠杆），对任意智能体生效、命中提示词缓存、未识别行业不注入。这是「军师按客户行业具备行业身份」的代码级实现，无需改库或改各 agent 提示词即生效。**禁止再把行业基准写死**——按行业取或扩 `INDUSTRY_PACKS`。
- **本文件即行业真相源**（AI/研发可直接增改）。建档问卷「行业」题的选项由 `industryOptionLabels()` 从行业包**派生**（`data/seedConfig.ts` 的 `SURVEY`）→ **新增一个行业包，建档选项自动多一个**。落库：`npm run db:seed`（破坏性重建）或 **`npm run admin:sync-content`（非破坏 upsert，保留运营启停，推荐）**。运营仍可在后台「问卷」页临时增改选项；选项串经 `resolveIndustryPack()` 模糊匹配回包，命中即获富身份、未命中优雅回退通用。app 端 `Picker`/`mock` 有离线兜底问卷副本，改选项需同步维护。
- **新增行业**：在 `INDUSTRY_PACKS` 补一条（唯一 key + 简短 `label` + 充分 `aliases` + persona/benchmark/levers）；注意 `label`/`aliases` 不要被更靠前的包抢先命中——`test/industryPacks.test.ts` 有 round-trip 断言（每个 label 必须解析回自己的包）兜底。后续如需运营在后台可视化增改「包」本身，再下沉 DB + admin CRUD（L1.5）。后续 L2 意图分诊路由 / L3 行业专家 agent 见 Notion 设计记录。

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
WECHAT_MINI_APPID  WECHAT_MINI_SECRET  WECHAT_MESSAGE_TOKEN
AI_PROVIDER=mock|claude|openai
ANTHROPIC_API_KEY  CLAUDE_MODEL
OPENAI_API_KEY  OPENAI_BASE_URL  OPENAI_MODEL  OPENAI_TIMEOUT_MS
```
常见 OpenAI 兼容网关：OpenAI `https://api.openai.com/v1`、DeepSeek `https://api.deepseek.com/v1`、Moonshot `https://api.moonshot.cn/v1`、通义 `https://dashscope.aliyuncs.com/compatible-mode/v1`。

### 8.3 其它服务
- `services/context.ts`：`resolveUser`（严格鉴权）、`buildGenContext`（注入 档案/基准/记忆/本命色 + **军师档案 + 项目背景 + 显式引用 + 知识库混合召回**）。
- `services/understanding.ts`（★）：生成前台「军师档案」与模型上下文线索，按真实 `Profile/Memory/Project/Knowledge/Report/Session` 汇总经营身份、创业路径、当前难题、已沉淀资料和待补问题；禁止写入固定 mock 客户画像。
- `services/memory.ts`：Agent Memory 写入（**带向量**）/召回（**语义相关性排序**）/留存 TTL/反馈回流。
- `services/embedding.ts`（★）：文本向量化。默认本地**确定性嵌入**（零依赖、离线、`EMBED_DIM=256`）；配 `EMBEDDING_MODEL`+真实 openai 兼容 key 走真实 `/embeddings`。`cosine()` 维度不一致返回 0。
- `services/retrieval.ts`（★）：`hybridSearch`（向量+关键词混合、租户隔离、可按项目过滤）、`resolveReferences`（显式 @ 引用 → 带出处注入）。
- `services/knowledge.ts`（★）：`ingestKnowledge`（切片+逐片向量化）、`listKnowledge`、`deleteKnowledge`。
- `services/reports.ts`（★）：`saveReportVersion`（slug 归一 + 内容哈希去重 + 自动变更摘要；同租户同 slug 用 Postgres advisory lock 串行成版，避免并发版本号冲突）、`diffContents`/`getReportDiff`（section 级 diff）、`slugify`。
- `services/summarize.ts`（★）：`summarizeSession`（整段会话 → 纪要报告 + 沉淀知识；有真实模型走 `summarizePoints`）。
- `services/sms.ts`（★）：短信验证码发放/校验；发码限频在同手机号同场景事务锁内完成，校验用条件更新消费，确保并发下同一验证码只能成功一次。
- `services/credits.ts`（★）：算力计量——`ensureCredits`（只读预检）/`reserveCredits`（已知费用产出前原子预扣）/`chargeCredits`/`refundCredits`/`grantCredits`/`getBalance`；同一用户的 `CreditLedger` 写入用 Postgres advisory lock 串行，避免并发双花或充值丢失。图片/按张类产出在 `sessions.ts` 同步与 SSE 路由中先预扣，异常自动退款；`/agents/:key/purchase` 在同一事务内完成扣费与开通；套餐发放通过 `applyPlanPurchase` 同事务更新套餐、钻石流水与 token 钱包。企业版(creditsPerMonth<0)不限量不扣减。
- `services/entitlements.ts`（★）：智能体权益——`assertAgentAccess` 拦截未解锁 `unlock` 智能体（403 `AGENT_LOCKED`）、`agentCost` 统一 `free/unlock/metered` 的产出计费、`publicOwned` 给前台展示可用状态。
- `services/adminAuth.ts`（★）：运营后台鉴权——`/api/admin/*` 统一要求 `ADMIN_TOKEN`（`x-admin-token` 或 `Authorization: Bearer`）或 `role=admin` 用户；普通小程序用户访问返回 403，无凭证返回 401。
- `services/aiConfig.ts`（★）：大模型配置解析（DB > env），预设 `AI_PRESETS`（Agnes/DeepSeek/Qwen/Moonshot/OpenAI/Claude/mock）、`isReady`/`effectiveProvider`、脱敏 `publicConfig`。
- `services/agentVersions.ts`（★）：智能体草稿发布/回滚/版本列表；`publishDraft` 对同一 `agentKey` 加事务锁，保证并发发布只生成一个版本或串行递增。
- `services/vectorStore.ts`（★）：pgvector ANN 查询/向量列双写（`PGVECTOR_ENABLED` 开启时；默认关闭走内存余弦）。
- `services/audit.ts`（★）：统一审计记录与秒级 ISO 时间格式；Fastify `onResponse` 钩子会记录除 `/api/health` 外的所有 `/api/*` 行为，覆盖匿名、无效 token、登录、后台与用户请求，payload 写入方法/路径/状态码/耗时/IP/UA/鉴权状态/脱敏 body 摘要；登录、短信、后台账号等入口另写成功失败语义审计，关键业务动作继续写语义日志（建档、产出、存库、汇总、后台配置变更）。
- 内容审核 `moderation_log`、审计 `audit_log`（演示级，生产替换合规服务）。

---

## 9. 运营后台（admin）

页面/接口：概览看板、**注册用户管理**（小程序注册用户、微信绑定、租户/套餐、最后会话、会话/成果数、算力余额，并可点进用户详情为其开通/取消 `unlock` 智能体）、**算力消耗**（按用户汇总赠送/消耗/余额、30 天活跃、成果数）、**审计日志**（最近 100 条，时间精确到秒；默认过滤 `admin.*` 后台自身行为，以单行列表展示用户 API、登录尝试、业务动作、用户/租户、摘要、方法/路径/状态码、IP/UA；窄屏切换为紧凑事件流，避免手机横向滚动；每条可点击打开详情面板，查看完整账号上下文、请求状态、IP/UA 与原始 payload；需要后台日志时传 `includeAdmin=true`）、每日献策库（增删改启停）、智能体/功能配置（新增智能体、基础信息、`free/unlock/metered` 定价、System 提示词 + Agent Memory 策略 + **上架/下架**，前台 `/agents` 默认只展示已上架功能）、**技能库**（新增/编辑自定义 HTTP 工具，复用后台统一的 `add-btn full`、`crd new-agent`、`ai-field`、`ai-btn`、`mini-btn` 组件语汇，避免局部 inline button 样式）、**模型配置（默认 Agnes，可一键切 DeepSeek/Qwen…，含测试连接，即时生效）**、建档问卷、套餐编辑。所有 `/api/admin/*` 路由由 `services/adminAuth.ts` 保护：运营端登录页填写后端 `ADMIN_TOKEN`，请求以 `x-admin-token` 发送；后端也支持 `role=admin` 用户。新增/扩展 admin API：`GET /admin/users/:id`、`POST /admin/users/:id/agents`、`DELETE /admin/users/:id/agents/:key`、`POST /admin/agents`、`PATCH /admin/plans/:id`，并保留 `GET /admin/users`、`GET /admin/usage`、`GET /admin/audit-logs`。入口 `admin/src/App.tsx`（`UsersView/UserDetailPanel/UsageView/AuditView/ModelView/PlansView`）+ `AgentDetailPanel.tsx`，API `admin/src/api.ts`（类型来自 SSOT）。默认 System Prompt 位于 `server/src/data/agents.ts`，商业咨询类按麦肯锡式问题解决法（MECE、假设驱动、80/20、金字塔原则、So what/Now what、30 天行动清单）设置；上线同步用 `cd server && npm run admin:sync-content`，同步智能体基础信息、权益计费、提示词与记忆配置并追加缺失每日献策，不删除业务数据、不覆盖启停状态。Agent Memory 开关保存到 `Agent.memoryConfig` 并由后端真实读取：`longTerm=false` 时不召回/不写入长期记忆，`autoLearn=false` 或去掉 `conversation` 来源时不从对话学习，`intensity/retentionDays` 影响写入权重和过期时间，`deliverable_feedback` 控制成果反馈回流。开发期 Vite 代理 `/api → localhost:4000`。本地后台使用全屏无边框容器，`admin/src/styles/admin.css` 需要保持视口安全收缩、横向隐藏和长文本断行，底部导航为横向滚动，避免新增模块或模型 URL/API Key/状态文案撑出屏幕。

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
- `buildGenContext` 是上下文注入总入口：企业档案、本命色、军师档案、项目背景、显式引用、知识库召回、长期记忆都从这里进模型；新增客户事实来源必须先接入这里，不能只做前台展示。
- 报告版本由 `services/reports.ts` 管：slug 归一、内容哈希去重、section/word diff；不要在页面层自己拼版本逻辑。
- 知识与记忆检索走 `services/retrieval.ts` / `services/memory.ts`；默认本地向量 + 内存余弦，`PGVECTOR_ENABLED=true` 后走 `services/vectorStore.ts`。
- 升级方向和产品口径看 `PRODUCT.md`；未完成项仍以 §13 TODO 为准。

## 11. 构建、运行、验证

### 常用操作路径（给 Agent 直接执行）

默认仓库根目录：`/Users/donis/dev/ai-pilot`。微信开发者工具只导入 `/Users/donis/dev/ai-pilot/app`，不要导入仓库根目录或 `app/dist`；`app/project.config.json` 已把 `miniprogramRoot` 指向 `dist/`。本机预览二维码和信息文件统一输出到根目录 `weapp-preview.png` / `weapp-preview-info.json` / `weapp-auto-preview-info.json`，这些是本地工具产物，不纳入提交。

**本地调试**
```bash
cd /Users/donis/dev/ai-pilot
npm run dev
```
这是首选三端联调入口：自动准备本地 PostgreSQL，启动 API `:4000`、H5 `http://localhost:5173`、运营后台 `http://localhost:5174`。只看小程序前端时用 mock：
```bash
cd /Users/donis/dev/ai-pilot/app
npm run dev:weapp
```
H5 单端走查：`cd app && npm run dev:h5`；H5 连真实后端：`cd app && npm run dev:h5:server`（默认 API `http://localhost:4000/api`）。

**小程序真机实时预览**

用户说“推送真机实时预览”时，优先复用/启动一个 `screen` 后台 watch，再触发微信开发者工具预览；不要开多个重复 watch。
```bash
screen -ls | rg ai-pilot-weapp-watch || \
screen -dmS ai-pilot-weapp-watch bash -lc 'cd /Users/donis/dev/ai-pilot/app && TARO_APP_MODE=mock npm run dev:weapp > /tmp/ai-pilot-weapp-screen.log 2>&1'

tail -n 80 /tmp/ai-pilot-weapp-screen.log

/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto-preview \
  --project /Users/donis/dev/ai-pilot/app \
  --info-output /Users/donis/dev/ai-pilot/weapp-auto-preview-info.json \
  --lang zh

/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview \
  --project /Users/donis/dev/ai-pilot/app \
  --qr-format image \
  --qr-output /Users/donis/dev/ai-pilot/weapp-preview.png \
  --info-output /Users/donis/dev/ai-pilot/weapp-preview-info.json \
  --lang zh
```
停止实时 watch：`screen -S ai-pilot-weapp-watch -X quit`。如果只是“编译推送一下”，不用常驻 watch，直接 `cd app && npm run build:weapp` 后跑上面的 `auto-preview` 和 `preview` 两条 CLI。

**小程序连本机后端真机调试**

真机不能访问 Mac 上的 `localhost`，必须用局域网 IP。后端需监听 `0.0.0.0:4000`，先用手机同网可访问的地址验健康检查：
```bash
# 终端 A：启动后端，server/src/index.ts 已监听 0.0.0.0
cd /Users/donis/dev/ai-pilot/server
npm run dev
```
```bash
# 终端 B：取 Mac 局域网 IP，启动小程序 server-mode watch
LAN_IP="$(ipconfig getifaddr en0 || ipconfig getifaddr en1)"
curl "http://$LAN_IP:4000/api/health"

cd /Users/donis/dev/ai-pilot/app
TARO_APP_MODE=server TARO_APP_API="http://$LAN_IP:4000/api" npm run dev:weapp
```
也可用本机技能脚本减少漂移：
```bash
/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh print-env
/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh check-api
/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh build
/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh auto-preview
/Users/donis/.codex/skills/ai-pilot-weapp-preview/scripts/weapp_preview.sh preview
```
注意：`/api/health` 只证明服务端存活；如果业务接口因 `DATABASE_URL`/Prisma 连不上库报错，应先修数据库。用户只是要可扫码验收时，可先退回 mock 预览保持体验可用。

**小程序发布上线（开发版 → 体验版 → 发布）**

小程序是独立于服务端的发布渠道，**不在 `deploy-prod.sh` 内**；后端用 `deploy-prod.sh` 单独上线，且必须向后兼容线上旧版小程序（新增字段/可选参数/新端点，不改既有响应契约）。发布前务必 **server 模式构建**，否则连的是 mock 而非线上 API：
```bash
cd /Users/donis/dev/ai-pilot/app
npm run build:weapp:server   # = TARO_APP_MODE=server TARO_APP_API=https://wxapi.aibuzz.cn/api npm run build:weapp
```
产物在 `app/dist/`（`miniprogramRoot=dist/`）。**上传这一步由 agent 自己执行，不要甩给用户**——历史反复踩坑：曾误以为上传只能让用户在 GUI 里点，其实开发者工具自带 CLI 可直接上传（用已登录会话、无需密钥）。默认用①：
1. **微信开发者工具 CLI（首选，agent 直接跑，无需上传密钥）**：复用已登录的 DevTools 会话。前置：DevTools 已打开且开启「设置 → 安全 → 服务端口」。`--project` 指向 `app/`（含 `project.config.json`，**不是** `dist/`）：
   ```bash
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli upload \
     --project /Users/donis/dev/ai-pilot/app \
     -v <版本号> -d "<本次变更说明>"
   ```
   退出码 0 且打印 `✔ upload` + 体积表即成功，进入 mp 后台「版本管理 · 开发版」。**版本号每次递增，最近一次上传 `0.2.8`**（2026-06-21）；上传前后同步 `docs/WEAPP_RELEASES.md`。GUI 等效（仅当 CLI 不可用时回退）：DevTools 只导入 `app/` → 右上角「上传」→ 填版本号 + 备注。
2. **miniprogram-ci（CI/headless 备选）**：需在 mp 后台 *开发管理 → 开发设置 → 小程序代码上传* 下载上传密钥 `private.<appid>.key` 并把**本机公网 IP**加进白名单。该密钥本地通常没有，**除非用户给出密钥路径，否则一律用①**：
   ```bash
   cd app && WEAPP_UPLOAD_KEY=/绝对路径/private.<appid>.key \
     npm run upload:weapp -- --version <版本号> --desc "本次变更说明"
   ```
上传后在 mp 后台 `mp.weixin.qq.com`「版本管理」：**开发版 → 转「体验版」自测 → 「提交审核」→ 审核通过后「发布」** 给全体用户。CLI 只产出开发版；转体验版、提交审核、正式发布是 mp 后台手动步骤（这几步才需要用户操作）。

**部署发布**

服务器部署/升级主文档是 `docs/DEPLOYMENT.md`，模板在 `deploy/`。当前固定线上环境：`ecs-user@8.136.36.175`，SSH key `/Users/donis/dev/aliyun/aiartist.pem`，代码目录 `/opt/junshi`，后台静态 `/var/www/junshi/admin`，H5 静态 `/var/www/junshi/h5`，API systemd 服务 `junshi-api`，公网域名 `https://wxapi.aibuzz.cn`。裸 IP `http://8.136.36.175` 仅保留 `/api/` 访问，`/admin` 与 `/admin/` 必须返回 404；运营后台只从域名 `https://wxapi.aibuzz.cn/admin/` 进入。**不要再探测远端是不是 git 仓库，也不要走远端 `git pull`**：当前 `/opt/junshi` 是本地 `git archive` 上传包式部署，不是 git checkout；例行「提交部署」直接跑仓库脚本。

常规升级（默认部署 `server + admin`；仅 `app/` 变更时再加 `DEPLOY_H5=1` 发布 H5）：
```bash
bash scripts/deploy-prod.sh

# 需要同时发布 H5：
DEPLOY_H5=1 bash scripts/deploy-prod.sh

# 目标变化时覆盖默认值：
DEPLOY_HOST=ecs-user@1.2.3.4 SSH_KEY=/path/key REMOTE_ROOT=/opt/junshi \
REMOTE_RUNTIME_USER=junshi PUBLIC_BASE=http://1.2.3.4 PUBLIC_DOMAIN=https://example.com \
bash scripts/deploy-prod.sh
```
脚本会打包当前 git `HEAD`、上传到 ECS、替换 tracked 应用目录（保留 `server/.env`、`logos/`、`backups/` 等运行时/主机产物）、执行 `npm ci` / `prisma generate` / `db push --skip-generate` / 后端构建重启 / admin 构建发布 / nginx reload / 公网 smoke。例行升级不跑 `npm run db:seed`，避免重灌演示数据影响线上业务；`server/.env` 不纳入上传包、不改权限。`npm audit` 提示只作为依赖治理信号，非部署阻断项；真正阻断以构建失败、`junshi-api` 非 active、裸 IP/域名 `/api/health` 非 200 或域名 `/admin/` 非 200 为准；裸 IP `/admin` 预期为 404。
`.claude/worktrees/*/AGENTS.md` 是 Claude 工作树副本，不是维护源；需要固化流程时改根目录 `AGENTS.md`、`scripts/deploy-prod.sh` 和必要的 `docs/*`。
正式微信小程序发布仍走 §11「本机上传到小程序平台」：上传前后同步 `docs/WEAPP_RELEASES.md`，版本号/描述与上传命令一致；连真实后端的小程序包用 `TARO_APP_MODE=server TARO_APP_API=https://你的域名/api npm run build:weapp`。

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
- 全程 mock 模型（确定性、可复现），无需真实 key/pgvector。**现状 215 用例 / 50 套件（0 跳过）**；覆盖微信登录 openid 复登、运营后台鉴权、算力/套餐购买、智能体权益、军师档案访谈与用户主路径。最近一次本地 PostgreSQL 测试库实跑为 2026-06-22，215/215 全过。
- 覆盖：鉴权隔离、微信 openid 登录/复登、注册花名、军师档案、运营后台鉴权、多智能体对话、智能体 `free/unlock/metered` 权益、记忆语义召回+TTL、项目+知识库+跨对话召回、跨项目隔离、对话汇总、版本化报告+diff、**★跨用户隔离（防信息泄露 TC-G）**、模型配置不泄露明文 key、SSE 流式、内容审核拦截、算力赠送/扣减/不足拦截、套餐购买/企业版不限量、并发回归（智能体购买、套餐发放、短信发放/消费、报告版本、智能体发布）、首登建档个性化、老用户回流、跨智能体协同+引用闭环、成果反馈回流、用户主路径、边界健壮性。
- CI：`.github/workflows/server-integration.yml` 用 GitHub Actions `postgres:16-alpine` 服务（tmpfs 数据目录）执行 `npm ci`、`prisma generate`、后端 build、`prisma db push`、`npm test`。
- 红线：改 路由/鉴权/检索/上下文/数据模型 后必须 `npm test` 全绿；新增可隔离数据类型须在 TC-G 补「跨用户不可见」断言。

### 端到端隔离验证（本地 Postgres + mock provider）
已用 curl 跑通 **19/19**：无 token→401、新号建号、A/B token+租户不同、A 建档/产出/存库后 A 有数据而 **B 全空（隔离）**、A 复登 token 不变且 onboarded 持久化、demo 号可登录、非法 token→401、非法手机号→400。

### 本机上传到小程序平台（miniprogram-ci）
> 云端沙箱网络白名单未放行 `servicewechat.com`，需在**本机**执行。
> 每次上传前后必须同步 `docs/WEAPP_RELEASES.md`，上传命令里的版本号/描述要与该文件记录一致；不要把每次上传明细塞进 AGENTS.md。
```bash
cd app && npm run build:weapp           # 产物在 app/dist（默认 mock 版）
npx miniprogram-ci upload \
  --pp ./ \                              # 项目路径=app（其 project.config.json 的 miniprogramRoot=dist/）
  --pkp /path/to/private.<appid>.key \
  --appid wx810ebe6dfef8e75f \
  --uv 0.1.0 -r 1 --ud "junshi mock build"
```
注意：上传密钥若在小程序后台开启了 **IP 白名单**，须把本机出口 IP 加入；连真实后端版本另需把 API 域名加入 request 合法域名（见 §12）。

### 微信账号登录联调
```bash
cd server
cp .env.example .env
# 填 WECHAT_MINI_APPID=wx810ebe6dfef8e75f 与 WECHAT_MINI_SECRET
npm run db:push && npm run dev

cd ../app
TARO_APP_MODE=server TARO_APP_API=https://你的域名/api npm run build:weapp
```
微信开发者工具导入 `app/`；本地调试可勾选“不校验合法域名”，真机/预览必须把 `TARO_APP_API` 的 HTTPS 域名加入小程序后台 request 合法域名。

### 微信消息推送 URL 验签联调
```bash
cd server
# .env 里配置：WECHAT_MESSAGE_TOKEN=与你在微信后台填写的 Token 完全一致
npm run dev
```
微信后台「消息推送 URL」填 `https://你的域名/api/wechat/message`，Token 填 `WECHAT_MESSAGE_TOKEN` 的值。GET 验签通过会原样返回微信传入的 `echostr`；POST 推送会先验签再返回 `success`（当前只建立可信入口，业务事件处理后续再接）。

---

## 12. 上线前硬约束（微信小程序）

> 服务器部署（裸机 Node+Nginx+PG / Docker）见 **`docs/DEPLOYMENT.md`** + `deploy/` 模板（含架构图、Nginx/systemd/compose、HTTPS、模型配置、安全 checklist）。
> 运营后台路径部署在 `/admin/`；Nginx 模板已将 `/admin` 301 到 `/admin/`，避免无尾斜杠时被 H5 fallback 当作移动端首页。

mock 可随时预览；**正式上传/审核**还需：
1. **真实 AppID**：已设为 `wx810ebe6dfef8e75f`（`app/project.config.json`）。
2. **微信登录密钥**：服务端配置 `WECHAT_MINI_APPID/WECHAT_MINI_SECRET`；AppSecret 不得进入前端包或仓库。
3. **后端公网 HTTPS + ICP 备案域名**，并加入小程序后台 request 合法域名；前端用 `TARO_APP_MODE=server TARO_APP_API` 指向它。
4. **生成式 AI 备案 / 算法备案 + 内容安全**（AI 类小程序审核硬性门槛）。
5. 真实模型：服务端设 `AI_PROVIDER` + 真实 key（国内合规建议走备案的国产模型，走 openai 兼容协议即可）。

---

## 13. 已知限制 / TODO

- **miniprogram-ci 上传**：云端执行环境的网络白名单未放行 `servicewechat.com`（报 `Host not in allowlist`），无法在本沙箱内直传。需从**本机**执行上传，或放开环境网络策略后重试；另注意上传密钥若开了 IP 白名单，需把执行机出口 IP 加入小程序后台。本机命令见 §11。
- 自有登录态支持 JWT（`services/userToken.ts`，HS256）：配 `APP_JWT_SECRET` 后登录签发 JWT、`resolveUser`/审计/admin role/entitlement 统一 `verifyUserToken` 校验；未配则回退历史 `token=userId`，`APP_JWT_REQUIRED=true` 可强制只认 JWT。短信强制校验开关（`SMS_REQUIRE_CODE`）已就绪，生产置 true 即可。
- `server/.env.example` 的 `OPENAI_API_KEY` 是 fake 占位，自动降级 mock；填真实 key 才走真模型。
- 内容审核与缓存已抽象可插拔：审核 `services/moderation.ts`（keyword 默认 / `MODERATION_PROVIDER=http` 接合规服务）；缓存 `services/cache.ts`（内存默认 / 配 `REDIS_URL`+ioredis 切 Redis）。计量台账仍为演示级，生产接真实计费台账。
- 套餐购买已接微信支付 v3 脚手架（`services/wechatPay.ts` + `PaymentOrder` 状态机 + `routes/pay.ts` 回调）：配齐 `WECHAT_PAY_*` 后走 `/plans/:id/order` 下单 + `/pay/wechat/notify` 回调，`markPaidAndApply` 用同订单事务级 advisory lock + `appliedAt` 终态锚点做幂等入账，套餐权益发放复用同一 Prisma transaction client，防重复/并发回调双发；未配齐回退 `/plans/:id/purchase` 演示购买。仍待：平台证书自动下载/轮换、对账兜底（主动查单）、退款。
- 签名服务偶发不可用时提交为未签名（不影响功能）。
- **pgvector 路径已实现但未真库验证**：本地无扩展，默认 `PGVECTOR_ENABLED=false` 走内存余弦（已验证）；上真库执行 `npm run db:pgvector` 并置 true 后需端到端验一遍（升级路径 1）。
- **模型密钥加密存库**：`services/secretBox.ts`（AES-256-GCM）对 模型/Dify/技能库 密钥写时加密、读时解密，配 `APP_ENCRYPTION_KEY` 后生效（未配=透传明文兼容演示），存量跑 `npm run secrets:encrypt` 回填。仍待：密钥接 KMS/密管 + 轮换策略（升级路径 8）。
- 运营后台 项目/报告 只读看板已加（`GET /admin/projects`、`GET /admin/reports`）；知识库看板走既有 `/admin/knowledge`。前端看板页待接。
- **时序知识图谱**（Graphiti 式）已落首版：`GraphEntity/GraphRelation`（关系带有效时间窗）+ `services/knowledgeGraph.ts`（实体去重、新事实软失效旧事实、as-of 查询）+ `routes/graph.ts`（抽取/实体/关系查询）。抽取依赖真实模型（mock 返回空）。仍可增强：对话汇总/知识入库时自动触发抽取、图谱可视化前端。
- **@引用** 选择器候选含 项目/报告/知识/记忆：记忆候选走 `GET /memories`（后端就绪），`resolveReferences` 支持 `kind:'memory'`；前端选择器接「记忆」分组待补。

---

## 14. 变更日志

历史变更日志已拆到 `docs/CHANGELOG.md`，避免 `AGENTS.md` 初始加载过重。后续凡代码 / 配置 / 接口 / 数据结构变更，仍需在同次提交中更新受影响章节，并在 `docs/CHANGELOG.md` 顶部追加 `YYYY-MM-DD · 改动 · 影响面`。
