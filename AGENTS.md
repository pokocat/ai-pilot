# 军师 · AI 商业军师 —— 工程总说明（AGENTS.md）

> **本文件是本项目的活文档（Single Source of Documentation），Claude Code 新会话会自动加载它。**
> ⚠️ **维护约定（所有后续 agent 必须遵守）：每次变更 / 迭代代码后，都要同步更新本文件**——
> 至少更新对应章节，并在 **`docs/CHANGELOG.md`** 顶部追加一条（日期 · 改动 · 影响）。
> 文档与代码不一致视为缺陷。提交信息可简写，但 AGENTS.md 必须反映当前真实状态。
> 产品定位、核心体验和企业事务操作系统的详细说明见 **`PRODUCT.md`**；历史变更见 **`docs/CHANGELOG.md`**；本文件只保留工程执行必需信息。

---

## 0. 给 Coding Agent 的强制指令（务必执行）

**只要改了代码 / 配置 / 接口 / 数据结构，就必须在同一次提交里更新本文档——无一例外。**

1. **记录每一处变更**：更新受影响的章节，并在 **`docs/CHANGELOG.md`** 顶部追加一条 `YYYY-MM-DD · 改动 · 影响面`。**里程碑级变更（完成一个 Mx / 重要功能上线 / 重大决策）还要同步 Notion「军师 · 工程变更日志（持续更新）」**（`https://app.notion.com/p/39205c5098e681e09f9ce4d589b51217`，最新在上、一句话结论 + 要点，产品可读口径，不贴代码细节）。
2. **暂不做的 → 写进 TODO**：本次决定延后 / 不做 / 留坑的内容，写入 **§13 已知限制 / TODO**，注明原因或前置条件。绝不允许"做了一半且没记录"。
3. **TODO 完成即移出**：实现了某条 TODO，就从 §13 删除，并在 `docs/CHANGELOG.md` 记一笔。
4. **改数据模型先改 SSOT**：任何接口字段/数据结构变化，先改 `shared/contracts.d.ts`，再改前端/后端/运营端实现。
5. **保持构建绿**：较大改动后按 **§11 构建校验基线** 跑通三端。
6. **新增全屏弹层**记得置 `store.setOverlay(open)`；遵守 **§7.2 UI 约定**，勿回退已修复的坑。
7. **登录态失效必须显式打断（全局铁律）**：任何页面 / 接口收到 401（token 失效或未登录），**绝不能静默降级**——不许让用户滞留在小程序界面看旧缓存 + 新功能空白（用户点名要修的真问题）。机制已集中在 `app/src/services/api.ts`：`request()` 与文件上传收到 401 会**无条件**触发全局 `onAuthLost`（由 `store.ts` 用 `setAuthLostHandler` 注册 → 清登录态 + 提示「登录态已失效，请重新登录」+ `reLaunch` 回登录入口 `pages/sessions`，其 `Login` 弹层按 `!isAuthed()` 拉起）。因此：① 页面 `.catch` 只负责**本地非鉴权兜底**（网络 / 空数据），**不得吞掉鉴权后果**——401 一定已被 `request()` 打断到重新登录；② 新增任何直连后端的鉴权调用，让它经 `request()`（默认即可），别绕过；面向用户的错误优先走 `store.handleApiError`，而非裸 `.catch(()=>{})`。**历史坑**：军师记忆库 / 完整履历页曾用 `.catch(()=>{})` 吞掉 401，掉登录后页面空白、用户不自知仍以为功能坏了（2026-07-07 修）。
8. **小程序改动先查约束清单**：凡改 `app/` 的微信小程序页面、tabbar、弹层、登录、键盘、网络请求、路由分包或项目配置，先对照 **§7.2 小程序工程约束清单**；不确定时按清单保守实现，避免回退真机已修复问题。
9. **运营后台 UI 改动守设计系统**：凡改 `admin/` 前端（`.tsx`/`admin.css`），必须对齐 **`admin/DESIGN.md`「Engineering Compliance」**——颜色只用 `:root` token（禁硬编码 hex/rgb）、只用已定义的组件类（禁裸 class 与一次性 inline 控件样式）。提交前跑 `cd admin && npm run lint:ui`（`scripts/audit-admin-ui.mjs`，已接入 `build`）保持全绿。
10. **品牌红线：禁止「米诺 / Mino」**（避免品牌纷争）：任何新增或修改的产品文案、提示词、交付物模板、代码标识符、注释、seed 数据里，一律使用「军师参谋部 / Junshi Strategic Staff」，不得出现「米诺 / Mino」。从 Notion 原稿（含 12 张 B 级卡片骨架、A 级报告模板）移植内容时必须先按 `server/src/data/prompts/README.md` 的映射去品牌再入库。存量残留的清扫任务见 §13 TODO。

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

本地生成物约定：`app/project.config.json` 是正式小程序配置（需跟踪，保持 AppID/miniprogramRoot 正确并开启正式校验/压缩）；`app/src/app.config.ts` 生成正式 `app.json`，`app/config/index.ts` 会在 weapp 构建产物里强制补写 `lazyCodeLoading: "requiredComponents"`（Taro 3.6.34 不稳定透传该字段）；`app/project.private.config.json` 可在本机覆盖 DevTools 私有设置（例如局域网真机预览临时 `urlCheck:false`）；根目录误生成的 `project.config.json/project.private.config.json`、`weapp-preview*.json/png`、`weapp-auto-preview*.json/png`、`app/.impeccable/`、`app/tarojs-cli-*.tgz`、根目录空 `package-lock.json` 均为本机/工具产物，已在 `.gitignore` 排除，不纳入提交。**不要导入仓库根目录到微信开发者工具，只导入 `app/`。**

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
- **新增能力的契约**（项目/报告/知识/引用）：`ProjectItem/ProjectDetail`、`ReportItem/ReportDetail/ReportVersionItem/ReportVersionContent/ReportDiff/SectionDiff`、`KnowledgeItemT/KnowledgeHit`、`MessageRef`、`SummarizeResult`，以及 `GenRequest.projectId/refs`、`GenResult.knowledgeUsed`、`SessionItem/SessionDetail.projectId`、`SessionMessage.refs`、`LibItem.reportId/version/projectId`。智库整理的 `OrganizeItem` 同时返回 `fileName/fileType/nameSource/preview`，供用户在确认入库前核对源名来源和解析正文。
- **军师档案契约**：`ClientUnderstanding` / `ClientUnderstandingSection` / `UnderstandingMaturity` 挂在 `/me.understanding`，只整理真实档案、长期记忆、项目、知识、报告与会话线索；`AliasSuggestionResult` 驱动注册花名接口。

> 约定：任何新增/修改的接口字段，先改 `shared/contracts.d.ts`，再改实现。

---

## 6. 账号与数据隔离

- **登录**（2026-06 重构，默认微信优先）：登录页**默认微信账号登录**（`wx.login` code → 服务端 `jscode2session` → openid/unionid 建号），一键切换**短信验证码登录**（`POST /auth/sms/send` → `POST /auth/login`，生产设 `SMS_PROVIDER=aliyun`、`SMS_REQUIRE_CODE=true`；当前阿里云短信模板 `ALIYUN_SMS_TEMPLATE_CODE=SMS_508120103`）。微信登录后**强制绑定手机号才能继续使用**（`bindphone` 拦截页，无跳过、仅"退出登录"逃生；前端绑定页不提供“暂不绑定”入口，首页对已登录但 `me.user.phone` 为空的账号也会拉起该页）：`POST /auth/bind-phone` 二选一——①微信一键 `{phoneCode}`（`getPhoneNumber` → 服务端 `getPhoneNumberByCode` 换号）②短信兜底 `{phone,code}`（`scene=bind`）；均带跨账号占用守卫（已被占用→409 `PHONE_TAKEN`）。绑定后再进**可选可跳过的「完善资料」**：`chooseAvatar`+`type=nickname`（微信头像昵称填写能力，可改）同步头像/昵称——头像 `POST /me/avatar` 传 OSS public-read 存 `User.avatarUrl`、昵称走 `PUT /me`。注意微信头像昵称**只能用户点选**（chooseAvatar 默认项「使用微信头像」+ 昵称键盘自动填充），`getUserProfile` 自 2022-10 起手机端返回匿名「微信用户」+灰头像，仅 PC/Mac/旧基础库返回真实（故「一键填入头像昵称」只在 PC/Mac 显示）。本机号一键登录端点 `POST /auth/wechat-phone`（`getPhoneNumber` 换号即登录）保留但**不再是登录页主入口**。手机号免码登录仅保留为开发/测试兼容兜底。注册称呼可留空，也可点称呼框右侧的 spark 图标从 `GET /auth/suggest-name` 取古典武侠/军事花名；花名只写 `User.name`，新租户公司名仍留空，避免把称呼误当公司。新账号自动建独立租户+用户，套餐赠送算力。
- **Token**：演示版 `token = userId`，前端存 `junshi.userId`，每次请求带 `x-user-id` 头。
- **隔离**：后端 `resolveUser` 严格按 token 解析，**无/失效 token 一律 401**（无 demo 兜底）；所有业务查询按 `userId/tenantId` 过滤。
- **微信密钥**：`WECHAT_MINI_SECRET` 与消息推送 `WECHAT_MESSAGE_TOKEN` 只在服务端环境变量保存；微信 `session_key` 仅服务端换取时使用，**不下发前端**。
- **方案购买 / 支付**：前台可读 `GET /plans`；未配齐微信支付凭据时，登录后 `POST /plans/:id/purchase` 走演示购买并按方案写入 `CreditLedger`；配齐 `WECHAT_PAY_*` 且套餐需付款时，演示购买被禁用，改走 `POST /plans/:id/order` 创建小程序 JSAPI 支付订单（支持 `source/refId` 归因，与 SKU 同口径落 `ActivationEvent(itemType='plan')`；下单落**条款快照** `snapshotJson`，发放按下单时点配置防改价漂移；同用户 10 分钟 10 单**频控** `ORDER_RATE_LIMITED`；下新单自动调微信 close-order 关同类旧 created 单，远端关掉才置本地 closed），再由 `POST /pay/wechat/notify` 回调幂等入账（解密后校验金额/appid/mchid 一致，不一致绝不入账；退款事件 `REFUND.*` 单独幂等补记）；入账成功自动发「支付到账」订阅消息（`WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID`，未配则静默跳过）。`requestPayment` 成功后前端统一走 `services/pay.ts`（`awaitPaymentApplied` 轮询 + `ensurePayableEnv` H5 守卫 + `requestWechatPayment` 统一调起）；订单明细页（credits）展示支付订单列表并支持**继续支付**（`GET /pay/orders` + `POST /pay/orders/:no/pay-params`）。服务端 `pay-reconcile-sweep` 定时任务（5 分钟）扫「paid 未 applied / created 超时」自动补账或关单；运营侧（后台「订单」页 + 用户详情均已接 UI）：卡单清单 + 手动补账（`/admin/payments/:no/reconcile`）、**全额退款** `POST /admin/payments/:no/refund`（owner/master；幂等回收权益：模块停用/凭据收回/套餐立即到期+追回未消耗算力）、订单搜索（单号/用户名/手机号）/分页/CSV 导出（`GET /admin/payments/export`，owner/master，审计留痕）、手动开通套餐/模块（`POST /admin/users/:id/plan`、`POST/DELETE /admin/users/:id/modules[...]`，source='admin'）。回调验签的平台证书支持**自动下载/轮换**（`GET /v3/certificates` AEAD 解密后按 serial 缓存 12h，未知 serial 强刷；`WECHAT_PAY_PLATFORM_CERT` 静态证书为兜底）。**降级守卫**：活跃付费套餐买不同套餐仅放行「同套餐续费 / 月→年折算升级」（折算单付款前有实付/抵扣确认弹窗），其余 409 `PLAN_SWITCH_BLOCKED`；企业版（price<0）调整仅走运营。本地联调 `npm run pay:mock` 起 mock 微信网关（含下单/查单/关单/退款端点，`WECHAT_PAY_BASE` 指向），完整真实加解密链路离线走通（见 §11）。前台显示为「方案与产出额度」，企业版 `creditsPerMonth<0` 记为不限量（余额 `-1`，产出不扣减）。
- **智能体开通**：`free`/`metered` 智能体无需开通即可用；`unlock` 智能体需用户用算力购买（`POST /agents/:key/purchase`）或运营后台开通后才能对话/产出，未开通产出返回 `403 AGENT_LOCKED` 且不落会话。
- **离线兜底**：server 模式下后端不可达时，登录回退为 `local-<手机号>` 本地会话，保证可体验（无服务端数据）。
- **退出登录**：「我的」页底部。
- 端到端隔离已验证（见 §11）。短信验证码已接入；生产仍应把 `token=userId` 换成 **JWT**，路由隔离逻辑不变。

---

## 7. 前端（app）架构

### 7.1 页面与导航
Tab 页（自定义导航 `navigationStyle: custom` + 自定义底栏 `custom-tab-bar`）：

底栏顺序对齐设计稿：**对话 · 战局 · 执行 · 智库 · 我的**（五个平铺 tab，无中间凸起按钮；`store.tab` 索引 0..4 按此顺序）。启动页为 `pages/sessions`（进小程序默认落到首位「对话」tab，登录门/建档弹层由对应页面承接）。

| Tab | 页面 | 说明 |
|---|---|---|
| 对话 | `pages/sessions` | 「对话」微信式列表（第一入口，底栏首位，对齐设计稿 `page-chat`）：大标题头（对话+副题，右侧 历史/新对话按钮）+ 白底搜索 pill + 快捷补给横滑 6 卡（资料/数据源/军师锦囊·模块/生成方案/转成军令/今日执行）+ 通栏半透明线程列表（上下发丝线）：总军师置顶（在线点）+ 常驻专业军师 + 「专业参谋」分组（未启用走 `AgentUnlock`）；每行=拟人立绘 + 宋体名号 + 金色花名 + 两行真实最近会话摘要/时间；「历史」切换到最近会话列表（长按删） |
| 战局 | `pages/home` | 对齐设计稿 `page-battle`：居中页头（左「案卷」→我的案卷 / 右刷新）+ 军师判断 hero（`--green-hero` 跟随本命色：kicker 主要矛盾 + 案卷来源行 + 大宋体判断=真实 `me.understanding.summary` 兜底案卷判断，点按→总军师对话）+ 战局信号 metric 3 卡（案卷完整度=档案成熟度 / 待补资料 / 风险锁）+ **「下一步」卡**（打磨·WO-07 Journey 占位：按案卷/档案派生一条动作；冷启动无案卷无判断走 `data/emptyStates.ts` 初诊导流）+ 三势判断 force 3 卡（方法框架→发起判断）+ 下一步动作（`nextQuestions` battle-goal 行→访谈）+ 关联模块（linkmod 行：模块名+负责军师 pill+tier 徽章）+「现在不能做」nono 卡（无则隐藏）+ 今日献策（页尾轻量保留）+ 本命色渐变 CTA（有案卷→执行，无→对话）|
| 执行 | `pages/studio` | 对齐设计稿 `page-execution`（军令体系用 `--gold`，现跟随本命色）：exec-nav（案卷/执行/提醒）+ 横滑战役卡组【今日战役本命色卡（案卷+完成度进度条）· 军师献策（优先显示待执行军令，完成后提示归档/回填/复盘）· 今日主令（首条未完成军令→生成脚本，全部完成→生成复盘）· 提醒节奏】+ 执行信号 + 总军师督战紧凑行（去对话）+ 今日最重要 today-focus 本命色条 + 目标阶梯 4 格（引导拆解）+ exec-seg 三视图【今日军令=第 0 号军令补资料（主题色边框 command-card）+ 未完成 task 卡打卡/长按删/手动添加 + 已完成军令默认收起到归档区（可展开取消完成）+ 线索/咨询/成交数据回填（软底+白格）+ 复盘前检查 · 周计划=近 7 天军令记录 · 复盘=带真实军令与回填数据发给经营参谋 + 提醒节奏】+ AI 创作发布（creative 智能体，保留解锁/按需权益）|
| 智库 | `pages/thinktank` | 对齐设计稿 `page-thinktank`：页头（上传/智库/市场）+ seg 4 分区【案卷资产=上传区（绿调 upload-zone）+ 状态格（已入库/关键缺口/深度整理）+ 资料树（最新上传=真实 `knowledgeDocs` + AI 分类框架）+ 军师提示补充（暖金 asset-gap，真实 `nextQuestions`）· 数据源=绑定目录单卡行 · 能力=费用口径 chips + 免费 Skill/深度 Skill/方案模块分组行 · 方案=真实版本化方案行 + 生成方案/方案库入口】（WO-01 名词统一：报告→方案）。资料上传后明确引导「开始资料整理 → 待确认 → 确认入库」；空间额度卡按剩余字节向下取整为整数 MB，并同时展示可用/总量（如上传 20KB 后显示 `199/200MB`），避免四舍五入掩盖已占用空间；新上传以客户端源文件名写入 `KnowledgeItem.fileName`，微信临时路径不落库；历史缺失源名的记录在智库、资料库列表和资料详情统一使用有效 `fileName`，过滤「上传资料」及 `growth资料` 等分类 key 占位名后，优先用 Markdown 首标题生成带“按正文标题识别”标记的名称，再回退中文分类名；mock 上传也保留源文件名。已优化资料可逐份展开解析正文预览，长正文使用限高 `ScrollView` 在预览框内滚动；确认按钮按当前条目 ids 提交并二次确认，不依赖刷新后会丢失的 `activeBatch`，提交期间显示“切片并建立索引”状态并用同步锁禁止重复确认、上传和阶段切换。三个整理阶段使用容器、强调色边框和底部指示条区分选中态。|
| 我的 | `pages/profile` | 对齐设计稿 `page-profile`：居中「我的军师系统」+ 右「设置」+ 本命色用户卡（头像/称呼/公司/套餐）+ 经营统计 3 卡（案卷/方案/资料真实计数）+ 权益额度 3 卡（钻石/本月额度/套餐→额度弹层）+ **战略段位卡（WO-03 冷启动延迟曝光：仅 `streak≥3 或 usageDays≥14` 才渲染）** + 菜单（档案/我的案卷/方案库/资料库/数据授权/模块管理/订单明细/送你一卦/提醒日历/本命色/企业版/退出登录）+ 军师社群主题卡 + 深度能力解锁主题卡 |

非 Tab 页：`pages/chat`（对话流 + 渐进式成果卡 + 参谋室协同导轨「派单/回总军师/转成军令/补上下文」+ 成果卡下「认可方案→存方案库+生成本地案卷军令→去执行」）、`pages/brief`（军师档案详情）、`pages/settings` 留在主包；我的案卷（列表/详情，前台名词=案卷，工程模型仍是 Project）、方案库、方案详情、资料库、数据源绑定、模块市场、送你一卦、军师社群已拆到 `packages/work/*` 分包（`projects`、`project`、`library`、`report`、`knowledge`、`credits`、`bindings`、`market`、`gift`、`community`），由 `pages/profile`、`pages/thinktank` 与 `pages/chat` 预加载。完整履历 `packages/work/dossier` 的个人档案/我的页入口必须反馈分包跳转失败和导航锁等待状态；页面读取失败展示可重试状态并走 `handleApiError`，首次无缓存但已有档案线索时直接自动生成，不得被手动按钮的 `ready` 门禁拦截。

静态目录数据：`src/data/operatingSystem.ts`（模块市场/Skill 市场/知识分类框架/数据源目录/对话引导，均为能力目录与引导态文案，费用口径 `💎xN`）、`src/data/council.ts`（参谋室常驻军师/派单建议/快速起手式/`ADVISOR_ALIAS` 军师花名：玄衡/观澜/青衍/鸣璋/照微/云枢…）。**这两个文件不得写入用户业务结论**——用户数据一律走 api（会话/报告/知识/项目/`me.understanding`）。

军师拟人头像：`components/AdvisorAvatar`（圆形立绘 + 白描边 + 可选在线点），当前主用立绘资产在 `src/assets/avatars/generated/*-imagegen.jpg`（6 张 376px JPEG ≈306KB，由 imagegen 生成的古代/神话谋略人物商务漫画头像：general=诸葛亮意象、strat=鬼谷子意象、growth=姜子牙意象、ip=文曲星意象、ops=刘伯温意象、org=张良意象；其余智能体按气质就近复用，未映射的按 key 哈希兜底）。旧版雪碧图裁切 `src/assets/avatars/*.jpg` 已删除（未引用即清理，控主包体积）。对话列表行、chat 头部与消息 who 行统一用它，不要再回退成图标色块。

战略案卷（执行闭环，已服务端化 · M0 PR-EX）：`services/dossier.ts` 是页面唯一入口——「认可方案→案卷（军令/风险锁/判断）→打卡→线索/咨询/成交回填→复盘 prompt」。server 模式走 `/casefile*` API（后端 `Casefile/CasefileOrder/CasefileMetric` 三表，按用户行级隔离，换设备不丢；军令/风险仍按 行动/风险 类分节标题启发式提取，服务端 `services/casefile.ts` 与前端 mock 分支同一套规则，**不预置业务结论**；自动拆军令和手动补军令均按「同一案卷 + 同一天 + 标准化文本」幂等，重复认可/重复添加不再追加列表）；mock 模式沿用本地 storage 实现（`junshi.dossier.<token>`）。老用户首次拉取会把本地案卷一次性导入服务端（`POST /casefile/import`，服务端幂等 + 本地 `junshi.dossier.migrated.<token>` 标记）。页面接口全部异步（`refreshDossier/acceptDeliverable/toggleOrder/addOrder/removeOrder/saveBackfill` 返回 Promise），打卡在执行页做乐观更新；完成军令不删除，今日页仅从待执行列表收起到默认折叠的归档区，周计划、复盘、每日战报继续读取 `done` 记录。战局页（案卷行/风险锁/CTA）与执行页共用该服务。

### 7.2 关键 UI 约定（踩过的坑，勿回退）
- **小程序工程约束清单（先读）**：
  - **项目导入与配置**：微信开发者工具只导入 `app/`；`app/project.config.json` 是正式配置，保持 AppID、`miniprogramRoot=dist/`、`libVersion=3.16.2`（真流式 `enableChunked` 目标基础库）、`urlCheck/es6/enhance/postcss/minified` 等正式校验/压缩开启；`app/src/app.config.ts` 保持 `lazyCodeLoading: "requiredComponents"`，且 `app/config/index.ts` 的 weapp webpack 链必须确保 `dist/app.json` 实际写出该字段；本机调试差异放 `app/project.private.config.json`，不要把根目录误生成的 DevTools 配置纳入提交。
  - **原生 tabbar 只隐藏不恢复**：custom tabBar 模式下任何路径都不得调用 `Taro.showTabBar`。正常 Tab 挂载/切换只调用 `hideNativeTabBarOnly()` 压住微信原生底栏；全屏 overlay 用 `store.setOverlay(open, stableKey)` 写 storage 并隐藏自定义底栏，关闭/卸载时清理对应 key。custom-tab-bar 在无 overlay 时必须自动清理过期隐藏标记，避免真机重进后导航消失。
  - **弹层不进 custom-tab-bar**：`custom-tab-bar` 只做导航和 overlay 状态同步，不渲染 `Login` 或其它全屏业务弹层；未登录点击中间「对话」只提示并跳 `pages/chat`，由聊天页承接登录弹层。
  - **overlay 同步不用轮询**：底栏状态同步依赖 `eventCenter` + 页面 `useDidShow` + `hideNativeTabBarOnly()` 短延时兜底；不要恢复 250ms/1500ms 常驻 interval。
  - **顶部安全区统一组件化**：Tab 页用 `Screen topInset`，非 Tab 自定义头用 `SafeHeader`；五个 tab 的标题区统一加 `tab-page-head`，安全区让位只由 `Screen` 的 `.nav-inset` 负责，页面内不要再单独测胶囊或写 `env(safe-area-inset-top)`；不要加伪状态栏 `9:41`。
  - **组件样式导入顺序统一**：同一页面同时用 `Icon` 与 `SafeHeader` 时，保持 `Icon` import 在前、`SafeHeader` import 在后，避免 Taro/mini-css-extract-plugin 在 common chunk 报 CSS order warning。
  - **对话键盘按真机口径写**：`packages/main/chat` 保持页面 `disableScroll: true`、输入 `adjustPosition={false}`、`alwaysEmbed`、整条 `.box` 触发 focus、`onInput` 返回 `e.detail.value`、`onConfirm` 使用事件值发送，并由 `onKeyboardHeightChange` 写 `--keyboard-height` 让 `.chat` 自己压缩底部空间；Taro/微信首次渲染的 `style` 对象不得传 `undefined` 值（动态 CSS 变量给明确默认值，条件样式用空对象），否则运行时会在 `finalizeInitialChildren` 对 `undefined.toString()` 并整页白屏；等待回复 `busy` 时输入框必须真正锁定（不 focus、不更新草稿、不发送、不清空当前内容）；用户上滑查看较早历史、离底部较远时显示「回到最新」浮层按钮，一键回到对话底部，且避让输入区/引用行/键盘；用户消息、AI 回复、记忆提示与成果卡必须支持长按复制（小程序自定义气泡不能依赖系统文本选择）；AI 普通文本回复用无卡片正文样式并开启文字选择复制，用户输入保留右侧气泡卡片。
  - **登录/401/网络错误有统一入口**：用户动作前先检查登录态；401 必须清用户态并弹登录/回首页，不能吞成空态或“产出失败”；默认首页 `pages/sessions` 自己承接 `Login`，在本页 401 时只打开登录弹层，不再反复 `reLaunch` 自己，且未登录/退出态仍要加载公开军师注册表并保留 `DEFAULT_AGENTS` 兜底，避免真机旧 token 失效后对话页清空；`Taro.request` reject 要按真实原因区分 `timeout/offline/domain/ssl/dns/unreachable/cancelled/network` 并映射成用户可读提示，合法域名/API 域名等排查细节只放 `reason/technicalMessage`/日志，不直接展示给用户；HTTP 408/504、429、5xx 也要给用户友好但真实的原因；需要登录的数据页 catch 后先调 `handleApiError`；普通聊天默认走 `/generate` 真流式，小程序用 `enableChunked/onChunkReceived`，H5 用 `fetch` ReadableStream；服务端只对用户输入做前置内容审核，违规输入直接 `MODERATION_BLOCK` 拦截，模型输出不再走阻塞式审核，完成后仅做 trace/禁用词审计；OpenAI/Claude 普通聊天在无工具调用时优先走 provider 原生 streaming，Dify、工具循环、mock 或不支持 stream 的兼容网关回退为完整结果分块；总军师 on-demand 普通问答也走 token 流，`/generate-sync` fallback 同样按意图分流，只有明确“生成方案/报告/成果卡/纪要/军令/出报告/战略体检”等成果请求才走强制结构化成果路径（`generateDeliverable`），不得再进入 adaptive 可选工具路径；OpenAI/Claude provider 返回空文本时必须按 AI 服务异常处理，不得伪装成固定追问；结构化工具返回的 `sections` 必须经 `normalizeDeliverableSections` 归一化，非数组/字符串/对象都不能让报告请求变成 503；模型未调用工具但返回普通长文时要转成报告分段，避免直接降级模板；报告成果不得把运行环境、Git 仓库、代码库、IDE、文件系统或 Codex 工作区当成客户资料，gateway 命中“当前工作区/Git 仓库/代码仓库/上传到工作区”等工程语境时必须替换为业务兜底成果并标 `degraded`；前台 degraded 提示不得暴露“结构化产出/降级模板”等技术术语；明确成果请求（如出报告/重新出报告/战略体检/生成方案）与带 `deliverableKey` 的成果型顾问必须按本次 `agentKey` 配置判定并走 `/generate` report SSE：收到 `meta` 先渲染 ReportCard 骨架，`begin/section/footer/done` 增量更新当前卡片，当前页不得只停在全局 thinking；只有 report 流无可渲染事件/传输失败时才回退 `/generate-sync`；普通聊天流成功仍必须收到可渲染 `token/chat` 事件，误收到 report SSE 时不要留下空回复；报告卡「网页版」在小程序内必须跳转 `packages/work/webview` 直接打开自有域名 `/api/r/:id`，web-view/navigate 失败只提示重试，不得自动复制链接。
  - **H5 兼容不污染小程序路径**：H5 自定义底栏只放 `app.h5.tsx/app.h5.scss`；小程序继续走真实 `page` 节点 + `src/custom-tab-bar`，不要把 H5/weui 兼容样式混进小程序原生 tabbar 路径。H5 底栏通过 portal 挂到 `document.body`，避免成为 `.taro_router` 最后一个直接子节点后被 Taro 路由隐藏规则误判，后续不要把固定底栏直接放回 `#app` 路由容器。
  - **主包持续控重**：项目工作台、项目详情、方案库、报告等非首屏工作流留在 `packages/work` 分包；新增重页面优先分包并在入口页配置预加载，除非确实属于首屏主路径。
  - **真机排版防回退**：标题类 `<Text>` 保持块级化；两列网格用 `space-between + 48.5%`；Markdown 内容用 `MarkdownText`；等待模型返回要显示对话流思考气泡；全屏弹层、色盘、商业文案按下方约定处理。
- **小程序历史坑只维护一份**：顶部安全区、原生 tabbar、overlay、键盘、登录、H5 样式隔离、网络错误和分包控重以本清单为准；不要在页面里另写一套平行实现。
- **本命色色盘对齐**：`components/Picker` 的色点与名称必须在同一个 `.pk-swatch` 垂直列里渲染；不要拆成上下两条 flex 行，否则选中外圈宽度会导致标签错位。
- **首页标题宋体化**：`pages/home` 通过 `Screen className="home"` 局部定义标题字体栈，品牌名、问候语、今日献策正文、对话卡提问、分区标题与卡片标题使用宋体优先；不要为此改全局 `--serif`，避免影响其它页面。
- **战局页首屏层级**：`pages/home`（战局）的军师判断卡是**纯展示深色卡**（点按整卡进入总军师对话），不要往里塞输入框/chips——对话入口在底栏首位「对话」tab；避免把战局页做成权益/推荐墙。底栏保持浅纸底与明确选中态，避免回退成强玻璃装饰。
- **前台商业文案克制**：面向用户的主路径不要写成“赠送 / 付费解锁 / 充值 / 最受欢迎 / 灵活付费”这类促销口吻；统一用「可用」「已启用」「专项能力」「产出额度」「方案与额度」「常用配置」表达，让用户感到是在调用工作台能力，而不是被推销。智能体费用展示用 `💎xN` / `💎xN/次`，不要写「启用需 N 点」「每次产出 N 点」；后台/代码契约仍可保留 `free/unlock/metered/credits` 等技术术语。
- **Markdown 渲染**：AI 普通回复、成果卡正文、报告详情正文必须通过 `components/MarkdownText` 渲染，支持标题、段落、列表、引用、加粗、行内代码和代码块；有序列表要兼容模型常见的松散写法（条目间空行且都写 `1.`），连续渲染为 1/2/3…；AI 普通回复传 `selectable` 以支持用户选择文字复制；不要直接把模型返回的 `###` / `**` / `-` 原样塞进 `<Text>`。
- **前台记忆披露**：对话页用「军师印象」包装 Agent Memory（WO-01 名词统一，原「专属理解」；记忆条/记忆披露/@引用分组一致）；我的页只放「军师档案」菜单入口，详情页展示 AI 对客户的结构化理解（经营身份、创业路径、当前难题、已沉淀资料、待补问题），不要在我的页首页直接平铺大段内容。两者都不得暴露 `memoryConfig`/Agent Memory 等后台术语，也不得写死 mock 客户故事或展示 `用户123/企业123` 这类占位名；资料不足时让用户进入对话访谈，由军师先问 1-3 个简单问题，不要先分析旧报告或展开诊断。后端真实记忆开关见 §9。
- **两列网格**：用 `justify-content: space-between` + `width: 48.5%`，**不要用 `calc(50%-5px)+gap`**（亚像素取整会溢出换行成竖排）。
- **本命色联动**：`--green/--green-hero/--gold/--gold-soft` 等业务主色 token 必须派生自 `--accent`，战局 hero、智库上传、我的用户卡、执行行动色和底栏选中态都要跟随设置里的本命色；`--danger`、正文墨色、纸张底色等语义/中性色保持固定。默认本命色=墨绿（`data/colors.ts` 首位 + `store` 默认 + 服务端 `benmingColor` 默认 `green`）。
- **小程序主题 token 不只写链式 var**：主题类（`.theme-red` 等）必须显式覆盖 `--green/--green-hero/--gold/--gold-soft` 等业务 token，不能只写 `--green: var(--accent)` 这类间接链，否则真机上部分卡片会保留默认绿。
- **H5 token 双写**：新增/修改 `app.scss` 里 `page {}` 的设计 token 时，必须同步 `app.h5.scss` 的 `:root` 兼容层（H5 没有 `page` 节点），否则 H5 上新 token 全部失效（深绿 hero 曾因此透明）。

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
| `GET /wechat/subscribe/templates` · `POST /wechat/subscribe` | 已登录用户读取订阅消息模板 · 回写 `wx.requestSubscribeMessage` 结果，`accept` 累计一次性发送额度 | 是 |
| `GET /health` | 健康检查 | 否 |
| `GET /me` · `PUT /me/color` | 当前用户(+onboarded+ai信息+军师档案) · 改本命色 | 是 |
| `GET /agents` · `GET /agents/:key` | 智能体注册表；带 token 时回填 `owned` | 否 |
| `POST /agents/:key/purchase` | 用算力一次性解锁 `unlock` 智能体（幂等，已开通不重复扣费） | 是 |
| `GET /survey` | 建档问卷 | 否 |
| `GET /profile` · `PUT /profile` | 企业档案读/写（写=完成建档） | 是 |
| `PUT /profile/bazi` · `GET /profile/chart` | 八字采集（→排盘引擎落库；believe=false=不信命理只存偏好；出生城市自动查经度表做真太阳时） · 我的命盘读取 | 是 |
| `GET /profile/strategic` · `PUT /profile/strategic` | 战略档案（已确认战略事实）读取 · 手动校准（局部更新） | 是 |
| `GET /decisions` · `POST /decisions` · `POST /decisions/:id/verify` | 决策日志：列表+统计 · 手动记录 · 验证（correct/revise，准确率服务端算） | 是 |
| `GET /prophecies` · `POST /prophecies` · `POST /prophecies/:id/verify` | 预言账本：列表+命中率 · 显式记录 · 对账（hit/miss；抽取只走真实模型不产生伪预言） | 是 |
| `POST /casefile/review` · `GET /reviews` · `GET /progress` | 发起复盘（day 快照军令/回填事实+连续天数+同步段位） · 复盘账本 · 段位/里程碑 | 是 |
| `POST /cards/:kind`（daily/calendar/fate） | B 级卡片发布 → 可分享 htmlUrl：每日战报（真实账本） · 天时日历（命盘逐月+谶语） · 天命速写（送卦：朋友生辰现算不落库） | 是 |
| `GET /sayings/today` | 每日献策 | 否 |
| `GET /plans` · `POST /plans/:id/purchase` · `POST /plans/:id/order` · `POST /pay/wechat/notify` | 套餐列表 · 演示购买/切换套餐并入账算力 · 微信 JSAPI 下单 · 微信支付回调幂等入账 | 列表否 · 购买/下单是 · 回调否 |
| `GET /pay/orders/:outTradeNo` | 支付订单状态轮询（`PayOrderStatus`，仅本人订单）：未发放且配齐支付时先主动查单补账（`reconcileOrder`），`appliedAt` 有值即权益到账 | 是 |
| `GET /pay/orders` · `POST /pay/orders/:outTradeNo/pay-params` | 我的支付订单列表（`PayOrderListResult`，订单明细页）· 继续支付：对未过支付时限（2h−10min）的 created 单重签 `wx.requestPayment` 参数（`PayRepayResult`） | 是 |
| `GET /sessions` · `GET/DELETE /sessions/:id` | 会话列表/详情/删除 | 是 |
| `POST /generate-sync` | 同步产出兜底（weapp+H5 通用）·接 `projectId`/`refs` | 是 |
| `POST /generate` | SSE 流式产出（H5 + weapp chunk 真流式）·接 `projectId`/`refs` | 是 |
| `POST /sessions/:id/summarize` | 对话汇总 → 版本化报告 + 知识库 | 是 |
| `POST /sessions/:id/messages/:mid/report` | 按需渲染成果网页版；`htmlUrl` 固定返回自有域名 `/api/r/:id` 供小程序 web-view 打开，`cdnUrl` 仅作 OSS 镜像 | 是 |
| `GET /casefile` · `POST /casefile/accept` · `POST/PATCH/DELETE /casefile/orders(:id)` · `PUT /casefile/backfill` · `POST /casefile/import` | 战略案卷（执行闭环）：当前案卷 · 认可方案建案卷+拆军令 · 军令增/打卡/删 · 当日回填 upsert · 本地案卷幂等导入 | 是 |
| `GET/POST /library` · `DELETE /library/:id` | 方案库（存库即桥接一版报告） | 是 |
| `GET/POST /projects` · `GET/PUT/DELETE /projects/:id` | 项目主线（详情聚合会话/报告/知识） | 是 |
| `GET /reports` · `GET /reports/:id` · `GET /reports/:id/version` · `GET /reports/:id/diff` · `POST /reports` · `DELETE /reports/:id` | 版本化报告（历史/某版/两版 diff/存版） | 是 |
| `GET/POST /knowledge` · `GET /knowledge/search` · `DELETE /knowledge/:id` | 知识库（摄取/混合检索/删除） | 是 |
| `POST /forces/refresh` · `POST /battle/commit` | V7-04 三势结构化刷新（限频 3/日）· 认可判断一键生成军令与报告（5 分钟幂等） | 是 |
| `PUT /casefile/goals` | V7-10 目标阶梯局部更新（3-5年/年度/季度/本周） | 是 |
| `GET /knowledge/pipeline` · `POST /knowledge/organize` · `POST /knowledge/confirm` · `POST /knowledge/deep-organize` · `POST /knowledge/upload?staged=true` | V7-06 智库三段管道：待整理/已优化/知识库视图 · AI 粗分去重 · 确认入库(切片嵌入) · 深度整理(SKU 门禁) · staged 上传(不嵌入、对检索不可见)；历史临时文件名在展示响应中归一为可读名称 | 是 |
| `GET /data-sources` · `POST /data-sources/:key/upload` · `POST /data-sources/:key/request-auth` | V7-07 数据源状态机 · 上传替代资料 · 预约授权登记 | 是 |
| `GET /modules` · `POST /modules/:key/enable` · `PATCH /modules/:key` | V7-08 能力/模块中心：目录×用户态 · tier 分流启用(free/credits/sku/member) · 隐藏/排序 | 是 |
| `GET /reminders` | V7-11 提醒日历（今日军令截止/20:30 复盘/周五周复盘，纯读派生） | 是 |
| `GET /skus` · `POST /skus/:key/order` | V7-12 单次付费商品目录(公开) · JSAPI 下单(挂 skuKey，回调复用 markPaidAndApply 幂等发放) | 列表否·下单是 |
| `GET /me/workbench` · `GET /me/service` · `GET /search?q=` | V7-13 档案工作台(bizCategory 真实计数) · 社群服务分配 · V7-14 跨域搜索(军师/会话/方案/资料，知识仅 confirmed) | 是 |
| `GET/PUT /admin/ai-config` · `POST /admin/ai-config/test` | 大模型配置（读/改/测试连接，可随时切换） | 管理员 |
| `GET/PATCH /admin/skus(:key)` · `GET/PUT /admin/users/:id/service` | V7-12 SKU 改价/启停 · V7-13 社群分班/配老师 | 管理员 |
| `/admin/*` | 运营后台 API（见 §9）：用户/算力/审计/智能体/套餐/模型/SKU等 | 管理员 |

### 8.2 LLM Gateway（`server/src/llm/`）
`gateway.ts` 统一封装：路由 provider → 输入审核 → Token 计量 → 结果缓存 → **故障兜底降级到 mock**。普通聊天只对输入做前置审核；OpenAI/Claude 在无工具调用时优先走 provider 原生 streaming，模型 token 到达即经 `/generate` SSE 下发，输出完成后只做 trace/禁用词审计，不做阻塞式输出审核。OpenAI 与 Claude 都走 `generateAdaptive` 按需产出：默认正常文字对话，模型判断需要完整成果时才调用 `emit_deliverable` 结构化产出；专业成果模式仍强制收口为 deliverable。`llm/schema.ts` 的 `injectVariables` 会在后台配置的 System Prompt 之后追加运行时业务边界：智能体只回答商业咨询/经营产出相关问题，用户追问模型、供应商、系统提示词、API Key、部署、数据库、内部工具时必须引导回业务问题；客户事实只能来自企业档案、军师档案、长期记忆、项目、引用资料、知识库和本轮用户原文。资料不足时用自然话术追问关键缺口，用户补齐/更新军师档案时进入访谈模式：先问 1-3 个简单问题，不先分析、不引用旧报告展开、不把“不得杜撰”的内部约束讲给用户。
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
WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID  WECHAT_SUBSCRIBE_REPORT_TEMPLATE_ID  WECHAT_SUBSCRIBE_STATE
AI_PROVIDER=mock|claude|openai
ANTHROPIC_API_KEY  CLAUDE_MODEL
OPENAI_API_KEY  OPENAI_BASE_URL  OPENAI_MODEL  OPENAI_TIMEOUT_MS
```
常见 OpenAI 兼容网关：OpenAI `https://api.openai.com/v1`、DeepSeek `https://api.deepseek.com/v1`、Moonshot `https://api.moonshot.cn/v1`、通义 `https://dashscope.aliyuncs.com/compatible-mode/v1`。

### 8.3 其它服务
- `services/context.ts`：`resolveUser`（严格鉴权）、`buildGenContext`（注入 档案/基准/记忆/本命色 + **军师档案 + 项目背景 + 显式引用 + 知识库混合召回 + 天势档案**）。
- `services/cardHtml.ts`（M4 PR-15 第一批）：B 级卡片渲染——每日战报（军令/对齐率/回填/段位/连续天数）、天时日历（命盘 12 月攻守+拐点+谶语）、天命速写（送你一卦：命格/大势/建议由命盘确定性生成；朋友生辰 `computeChart` 现算**不落库**）。铁律：卡上每个数字都来自服务端账本，读不到整块不显示；品牌一律军师参谋部（V6.0 原稿外置 CSS 未保留，样式按小程序设计体系重制）；卡片发布走自有域名 `{PUBLIC_BASE_URL}/api/r/:id`。`services/reportHtml.ts` 的普通报告模板已改为 V6.0 天势卡片风（暖纸底、深绿封面、白色章节卡、金印落款、军师参谋部品牌）；报告 `htmlUrl` 也固定返回自有域名 `/api/r/:id` 供小程序 web-view 打开，OSS 仅作为可选 `cdnUrl` 镜像，旧 OSS `htmlUrl` 会在再次请求时迁回自有域名；不要回退旧米色卷轴页脚或 OSS 直开入口。叙事线/谶语存 `StrategicProfile.extraJson`（PUT /profile/strategic 接受 narrative/verse，注入块带「跨月复述一致/全年沿用」口径）。剩余 9 卡 + A 级模板见 §13。
- `data/industryPacks.ts` 深度字段（M4 PR-19）：`decisionChain/ticketRange/benchmarkCases/mingLink` 可选，配了才拼进「行业视角」注入行；美业与大健康已拆分为两个包（新增行业包=建档选项自动 +1，app Picker 兜底问卷需手动同步）。
- `services/intent.ts`（M3 编排与适配，全部确定性规则）：`detectIntent`（V6.0 §3 入口识别：复盘六层触发词/紧急/择时/团队匹配/送你一卦/情绪→师父）→ `modeDirective` 模式指令；`Session.mode` 粘性存储（`resolveMode` 本轮检测优先、检测不出沿用；复盘意图在 sessions 路由自动落对应层 ReviewLog）；`detectInnerState`→`roleDirective` 五角色语气（教官/参谋长/大哥/战略家/师父）；`stageOf/stageDirective` 营收阶段自适应（问卷已改营收区间，旧标签兼容）；诊断轮次由历史用户消息数计算注入。注入位：模式/角色/轮次=【本轮导引】dynamic 首位，阶段=stable。**本命色语气注入已移除（PR-14，本命色回归纯 UI 品牌色）**，`{本命色}` 占位符路径保留。
- `services/wechatSubscribe.ts`：微信小程序订阅消息通道。`GET /wechat/subscribe/templates` 只返回已配置模板；前端 `wx.requestSubscribeMessage` 后 `POST /wechat/subscribe` 回写结果，`accept` 才给 `WechatSubscription.remaining +1`；发送成功后扣减一次额度并写 `WechatNotificationLog`。当前场景：`review`（复盘提醒，模板字段 `thing1/time2/thing3`）与 `report`（报告生成完成，模板字段 `thing1/phrase2/time3/thing4`）。未配模板、无 openid、无额度、微信接口失败都不阻断主流程。
- `services/scheduler.ts`（M1 定时任务框架）：任务注册制 + 进程内周期扫描（生产单实例；`NODE_ENV=test` 不自启，测试直接 `runJob/scan*` 驱动）；任务彼此隔离（单任务崩不影响其它）。已挂：`casefile-idle-recall`（案卷 ≥48h 未推进 → 登记 `system.recall.candidate` 审计，按用户按天幂等）、`daily-review-reminder`（服务端本地时间 `REVIEW_REMINDER_HOUR` 后，活跃案卷且当天未复盘、当天未发过 review、仍有订阅额度 → 发微信复盘提醒）、`review-gap-reminder`（久不复盘登记候选并尝试发送）、`prophecy-due-scan`（预言到期登记候选）。
- `services/strategicProfile.ts`（M1 统一状态层）：战略档案提取（`extractStrategicFacts` 按分节标题确定性规则，只取语义明确分节、不猜）/合并写入（只覆盖出现的字段）/注入块（`strategicBlock`）。逐轮 LLM 结构化抽取与 M2 决策日志共用抽取管道（§13 TODO）。
- `services/paipan.ts`（★ M1 排盘引擎 v1）：确定性命理/历法计算——干支历/八字/大运用 `lunar-typescript`，紫微命宫/身宫主星用 `iztro`；产出 四柱十神/月令取格（打法映射 `data/baziPlaybook.ts`，源自 V6.0 表）/日主强弱与喜用（v1 计分法，basis 写明依据）/大运时间线/年度逐月攻守；真太阳时 v1 平太阳时校正（经度）。**铁律：算→存（`NatalChart`，带 engineVersion）→拼指令（`chartBriefing` 注入【天势档案】+ 禁止 AI 自算），AI 只做比喻翻译**；「不信命理」注入 `TIANSHI_OPTOUT_LINE` 降级指令。回归口径：同输入同输出（`test/paipan.test.ts` 已知八字校验）。
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
- `Casefile` + `CasefileOrder`（军令，`aligned` 对齐性标注）+ `CasefileMetric`（每日回填，`(casefileId,date)` 唯一）——执行闭环（M0 PR-EX），用户级 active 案卷唯一。
- `NatalChart`（命盘，`userId` 唯一、重排覆盖；`engineVersion` 支持按版本批量复算；`chartJson`=ChartView 全量结构）——排盘引擎（M1 PR-1）。生辰输入与「不信命理」偏好存 `Profile.extraJson.bazi`。
- `ReviewLog`（复盘日志，`(userId,layer,date)` 唯一）——M2 PR-8：六层复盘事件账本；day 层由执行页发起复盘时落库（快照当日军令完成/对齐/回填事实）；**对齐率=对齐军令÷总军令、连续复盘天数由服务端从行计算**（今天未复盘不打断，从昨天起算）；scheduler 挂断档提醒（`review-gap-reminder`）。注入【复盘账本】块。
- `WechatSubscription` + `WechatNotificationLog`：订阅消息一次性授权额度与发送日志。`(userId,scene,templateId)` 唯一；`accept` 增额度，发送成功扣额度；日志记录 `sent/failed/skipped` 便于排查复盘提醒、报告生成触达。
- `ProphecyLog`（预言账本，`(userId,seq)` 唯一）——M2 PR-9：预言/依据/验证标准/到期时间/状态（pending|hit|miss）；**写入源=真实模型结构化抽取（gateway.extractProphecies，测试/mock 返回空→绝不产生伪预言）+ 显式接口**；总军师输出后 sessions 路由异步收割（有命盘用户才抽）；`prophecy-due-scan` 到期登记对账候选（行级 `dueNotifiedAt` 幂等）；命中率服务端算、无样本 null。注入【天机账本】块。
- `UserProgress`（用户进度，`userId` 唯一）——M2 PR-10：战略段位（新兵→尉官14天→校官30天+月复盘→将军90天+准确率>60%→元帅180天+>70%+命中率>50%；**只升不降**，null 指标视为不达标不放水）+ 里程碑（使用天数 7/30/90/180/365 解锁，记首次解锁日期）；晋升记审计 `user.rank.promoted`（晋升卡素材）；`syncProgress` 无变化不写库。注入【段位·里程碑】块（新用户零记录不注入）。
- **复盘保底（M2 PR-6）**：`reserveQuota(userId, ratio, {grace:'review'})`——余额≤0 时复盘类调用（`buildReviewPrompt` 确定性前缀识别）每日最多 `REVIEW_GRACE_PER_DAY`(2) 次放行（透支记账+`system.quota.grace` 审计）；套餐到期锁定不受影响。**复盘动线归属总军师 general（免费），ops 经营参谋保留为可解锁深聊**——复盘是留存生命线，不设解锁墙。
- `DecisionLog`（决策日志，`(userId,seq)` 唯一自增序号）——M2 PR-7：决策/理由/天势参考/验证标准/验证期/状态（pending|correct|revise）/快慢标注；写入源=认可方案自动记账 + 手动接口（AI 工具位与 LLM 抽取随 PR-9 共建）；**准确率（含快/慢分开）一律服务端从状态行统计，无已验证样本返回 null 不编 0%**；注入【决策账本】块（近 5 条 + 准确率 + 禁止 AI 自算口径）。
- `StrategicProfile`（战略档案，`userId` 唯一）——统一状态层（M1 PR-3）：只存**客户已确认**的战略事实（主要矛盾/定位/赛道/阶段 + 预留 十二问/KPI/extra）；回写触发=认可方案（`/casefile/accept` 按分节标题确定性提取）+ 手动校准；注入为【战略档案】块、置于推断型【客户档案】之前。与 `understanding`（证据自动推断）分工明确，不重复。

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

体验版 token 月额度调整后，先运行 `cd server && npm run db:sync-plans` 同步套餐配置；已有体验版用户的钱包额度使用 `npm run db:bump-free-quota` 试运行核对，确认后追加 `--apply` 执行。脚本只更新已有体验版钱包，不为没有钱包的用户预建记录。

Taro Webpack5 持久化缓存已开启（`app/config/index.ts` 的 `cache.enable=true`），用于提升二次 `dev:weapp`/`build:weapp`/H5 编译速度；如果遇到疑似缓存脏数据，先删本地 `app/node_modules/.cache` 后重编，不要提交缓存目录。

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
停止实时 watch：`screen -S ai-pilot-weapp-watch -X quit`。如果只是“编译推送一下”，不用常驻 watch；真机连线上后端验收时必须 `cd app && npm run build:weapp:server` 后跑上面的 `auto-preview` 和 `preview` 两条 CLI，避免默认 `build:weapp` 生成 mock 包。

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

### 微信支付本地验证（不触达微信，两条通道互补）
- **沙箱通道** `npm run pay:e2e`（22 项）：`PAY_SANDBOX=true`，绕过加解密专注业务状态机——套餐/SKU 下单入账、月→年折算、过期降级/只读、续费恢复、幂等。
- **真实代码路径通道** `npm run pay:e2e:mock`（19 项）：起本地 mock 微信支付网关（`src/services/wechatPayMock.ts`）+ 真实监听端口的 app，完整走 商户请求 RSA 签名 → 网关验签发 `prepay_id` → `paySign` 可验 → 官方格式加密回调（APIv3 AES-256-GCM + 平台私钥签名）→ `/pay/wechat/notify` 验签解密幂等入账 → 重复回调幂等 → 篡改签名 401 → 回调丢失时 `GET /pay/orders/:no` 主动查单补账 → 他人订单 404。同链路已入 `npm test`（`test/wechatPayMockFlow.test.ts` 14 用例，另覆盖：降级守卫 409、对账 sweep 自动补账/关单、admin 卡单清单与手动补账、回调金额不一致拒绝入账、条款快照发放、close-on-supersede、订单列表/继续支付/超时 409、全额退款+权益回收+幂等、下单频控 429、admin 手动开通套餐/模块、平台证书自动下载轮换验签、admin 搜索/分页/CSV 导出）。mock 网关模拟 下单/查单/关单/退款/平台证书下载 五个 v3 端点。
- **手动联调**：`npm run pay:mock` 独立起 mock 网关（默认 `:9860`，密钥持久化 `server/.paymock/` 已 gitignore），启动时打印整套可粘贴进 `server/.env` 的 `WECHAT_PAY_*`（含 `WECHAT_PAY_BASE` 指向 mock）；下单后 `curl -X POST http://127.0.0.1:9860/mock/pay/<outTradeNo>` 模拟用户付款触发真实格式回调。

### 端到端隔离验证（本地 Postgres + mock provider）
已用 curl 跑通 **19/19**：无 token→401、新号建号、A/B token+租户不同、A 建档/产出/存库后 A 有数据而 **B 全空（隔离）**、A 复登 token 不变且 onboarded 持久化、demo 号可登录、非法 token→401、非法手机号→400。

### 本机上传到小程序平台（miniprogram-ci）
> 云端沙箱网络白名单未放行 `servicewechat.com`，需在**本机**执行。
> 每次上传前后必须同步 `docs/WEAPP_RELEASES.md`，上传命令里的版本号/描述要与该文件记录一致；不要把每次上传明细塞进 AGENTS.md。
```bash
cd app && npm run build:weapp:server   # 产物在 app/dist（server 版，连 https://wxapi.aibuzz.cn/api）
npx miniprogram-ci upload \
  --pp ./ \                              # 项目路径=app（其 project.config.json 的 miniprogramRoot=dist/）
  --pkp /path/to/private.<appid>.key \
  --appid wx810ebe6dfef8e75f \
  --uv 0.1.0 -r 1 --ud "junshi server build"
```
注意：上传脚本会拒绝未注入 `https://wxapi.aibuzz.cn/api` 或仍包含 `localhost:4000/api` 的产物；上传密钥若在小程序后台开启了 **IP 白名单**，须把本机出口 IP 加入；连真实后端版本另需把 API 域名加入 request 合法域名（见 §12）。

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
微信后台「消息推送 URL」填 `https://你的域名/api/wechat/message`，Token 填 `WECHAT_MESSAGE_TOKEN` 的值。GET 验签通过会原样返回微信传入的 `echostr`；POST 推送会先验签再返回 `success`。

订阅消息另配小程序后台「订阅消息」模板：
- `WECHAT_SUBSCRIBE_REVIEW_TEMPLATE_ID`：复盘提醒，字段 `thing1=提醒事项`、`time2=提醒时间`、`thing3=备注`。
- `WECHAT_SUBSCRIBE_REPORT_TEMPLATE_ID`：报告生成，字段 `thing1=报告名称`、`phrase2=状态`、`time3=完成时间`、`thing4=备注`。
- 前端执行页「复盘 → 订阅复盘提醒」会调 `wx.requestSubscribeMessage`，服务端只在用户接受后累计一次可发送额度。

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

- **测试库纪律缺口（2026-07-11）**：仓库无 `.env.test`，`npm test` 直接读 `.env` 的 `DATABASE_URL`（可能指向 schema 落后的 dev 库 `junshi`，`seedBaseline` 崩溃会被误判为"断言陈旧"）。跑测试前请确认指向已 `prisma db push` 的 `junshi_test`。待办：加 `.env.test` 或在 test 脚本内固定测试库 + push 前置。
- **产品决策记录（2026-07-11）**：`docs/[FABLE5]DECISIONS_2026-07-11.md` 已拍板 D-1 多入口+来源归因 / D-2 军师收编 4+1 / D-3 七参数（记忆用户级共享、复盘日周月、健康度 LLM 估测水位约束框架、报告分享转图片、保底额度可配置默认 6、生态纯跳转）。与旧规格冲突以决策文档为准；全局复审待办清单见 `docs/[FABLE5]REVIEW_2026-07-11.md`（**批次一 P0 五项 + 批次二 P1 七项 + D-8/D-10/D-11 + WO-09 端到端接线均已完成**；**批次三亦已完成**（D-1 归因/D-3-3 健康度/D-3-4 转图片/D-3-7 生态跳转/WO-08~14 全部管道/文案 sweep/主包瘦身，计划见 `docs/[FABLE5]BATCH3_PLAN.md`），仅剩该计划「明确不做」清单挂 backlog）。遗留注意：① `/casefile/review` 直连 API 仍接受 quarter/year/team 层（前端无入口暂不 clamp）；② **D-3-7 运维前提：EcoTool 目标小程序（数字人等）须与本小程序同一微信开放平台主体关联，`navigateToMiniProgram` 才可用**，appId 由运营在 admin「生态工具」录入；③ 批次三 schema 新增 ActivationEvent/EcoTool/Prescription.followupAt/PaymentOrder.attrSource（纯加法），prod 部署时 db push 带上并可跑 `prisma/seedBenchmarks.ts` 种子；④ 报告分享图/周报卡等 canvas 出图需真机抽查；⑤ estimateHealth 的 product/brand 维暂无服务端信号源常态 na。注意存量已排盘用户的 `NatalChart` 数据在命理关闭后仅停止读取展示、未物理清除，如合规要求下架历史命盘数据需另开任务。
- **小程序方向调整（2026-07-05）：从「减法」改为「精细打磨现有功能」**。原 `docs/[FABLE5]*` 三份文档是「先减法后加法」方案；产品侧判断"功能都是客户想要的"，**不再做减法**，改为按文档把各功能逻辑捋顺、补全、打磨。已执行的处置：
  - **保留**：WO-01（名词统一：前台收敛「案卷/方案/军令/资料」，记忆/专属理解→军师印象；属打磨）+ WO-03（冷启动段位卡延迟曝光 `streak≥3‖usageDays≥14`、空态导流 `data/emptyStates.ts`、战局「下一步」卡；属打磨）。
  - **已回滚**：WO-02 的真减法——市场货架（thinktank 能力目录 + market 页 + profile 模块管理 + sessions 快捷卡 + CHAT_GUIDES 入口）、战局三势卡（市势/人势）+ 关联模块、送你一卦，全部恢复；`market`/`gift` 恢复为正常可达入口。
  - **打磨方案已产出**：`docs/[FABLE5]POLISH_PLAN.md`（review 工作流 12 功能区 × 诊断 × 对抗性复核，79 条已核实 finding + 4+1 批次 + 7 个产品拍板点 + 2 条 P0 命理合规红线）。后续打磨逐单对照它执行。
  - **V7 新版效果图对齐已落（2026-07-09，V7-03~15，跳过 V7-01/02）**：按 `docs/[FABLE5]V7_EFFECT_ALIGN_PLAN.md` 实现——三势结构化 + `battle/commit`、军令结构化拆解 + 详情页、智库三段管道（`KnowledgeItem.stage` 生命周期）、`Sku/UserDataSource/UserModule/ServiceAssignment` 四张新表、目标阶梯、提醒补全、跨域搜索、未读数/sys-card；对外「算力」文案统一（💎 保留）。后端 449 例全绿、server+app tsc 0 错、`build:weapp` 通过、`pay:e2e` 22/22（含 SKU 段）；server 已上线（`42f5c9c`）+ SKU 目录已 `admin:sync-content`。运营后台 SKU 改价/启停 + 社群分班/配老师已接（`/admin/skus`、`/admin/users/:id/service`）。**tab 样式/菜单名 by-design 未改**。**未含**：小程序前端发布（独立渠道，走微信 DevTools）、真机走查、真实 OAuth 数据源、深度整理 LLM 加强、第 7 位军师·明止（D-9 不落地）。详见 CHANGELOG 2026-07-09。
  - **打磨①已落（P-4）**：送你一卦第三人生辰不落库、无公开链接，改小程序 canvas 图片交付 + 同意勾选（见 CHANGELOG 2026-07-05）。**待真机复验 canvas 出图**；server 集成测试需带 Postgres 环境跑。
  - **命理合规 P-3（下一条 P0，仍待）**：加全局 `AiSetting.tianshiMode(full/downgrade/off)` 凌驾 believe，前端 home 天势卡/calendar/gift 读同一开关（downgrade 去八字/命宫术语、off 隐藏），切换免发版、先于提审接好。
  - **其余打磨待办**：prompt 去机制化（A-1/P-12，动生产 V6.0 prompt）、UserJourney 诊断轮次持久化（F-5）、账本 App 页+verify 入口+最小样本（F-8/P-2）、复盘周期聚合+grace 全层保底（A-4/A-8）、报告脱敏分享等——见 POLISH_PLAN §3 批次。
  - **WO-03 §3（服务端，仍待）**：`server/src/services/context.ts`【段位·里程碑】块 `streak<3` 时去具体百分比字段（只留天数），配 server 集成测试。
- **存量「米诺 / Mino」品牌残留待清扫**（规则见 §0 #10；新增内容一律禁用，存量后扫）：① `server/src/data/prompts/strat.v6.baseline.md`——2026-06-20 从 prod 拉的原始基线快照，正文含米诺品牌（该目录 README 记录了去品牌映射，运行时不加载、tsc 不打包，风险=仓库存档层面）；② `app/src/data/operatingSystem.ts` SKILL_MARKET 里 `id: 'mino'`（三势初判的内部 id，用户不可见，改名需同步排查引用）；③ `server/src/data/agents.ts` 顶部注释书名号里的《米诺战略参谋部…》字样；④ 两个 prompt 目录并存待合并（运行时加载 `server/prompts/`，基线存档在 `server/src/data/prompts/`）。清扫时机：M1 收尾或专项小 PR。
- **miniprogram-ci 上传**：云端执行环境的网络白名单未放行 `servicewechat.com`（报 `Host not in allowlist`），无法在本沙箱内直传。需从**本机**执行上传，或放开环境网络策略后重试；另注意上传密钥若开了 IP 白名单，需把执行机出口 IP 加入小程序后台。本机命令见 §11。
- 自有登录态支持 JWT（`services/userToken.ts`，HS256）：配 `APP_JWT_SECRET` 后登录签发 JWT、`resolveUser`/审计/admin role/entitlement 统一 `verifyUserToken` 校验；未配则回退历史 `token=userId`，`APP_JWT_REQUIRED=true` 可强制只认 JWT。短信强制校验开关（`SMS_REQUIRE_CODE`）已就绪，生产置 true 即可。
- `server/.env.example` 的 `OPENAI_API_KEY` 是 fake 占位，自动降级 mock；填真实 key 才走真模型。
- 输入审核与缓存已抽象可插拔：审核 `services/moderation.ts`（keyword 默认 / `MODERATION_PROVIDER=http` 接合规服务，当前只用于用户输入前置拦截）；缓存 `services/cache.ts`（内存默认 / 配 `REDIS_URL`+ioredis 切 Redis）。计量台账仍为演示级，生产接真实计费台账。
- 套餐购买已接微信支付 v3 脚手架（`services/wechatPay.ts` + `PaymentOrder` 状态机 + `routes/pay.ts` 回调）：配齐 `WECHAT_PAY_*` 后走 `/plans/:id/order` 下单 + `/pay/wechat/notify` 回调，`markPaidAndApply` 用同订单事务级 advisory lock + `appliedAt` 终态锚点做幂等入账，套餐权益发放复用同一 Prisma transaction client，防重复/并发回调双发；未配齐回退 `/plans/:id/purchase` 演示购买。P0~P2 已落地（2026-07-14，详见 §6 支付段与 CHANGELOG）：主动查单对账（轮询自愈 + `pay-reconcile-sweep` 定时批扫 + admin 手动补账）、回调金额/appid/mchid 校验、降级守卫、前端统一到账确认、条款快照、微信 close-order 关陈旧单、全额退款+权益回收（后端）、订单列表/继续支付、proration 事前确认、H5 守卫、下单频控、套餐归因、支付到账订阅消息、admin 手动开通套餐/模块（后端）。admin 前端 UI（退款按钮/开通套餐/模块管理/订单搜索/分页/CSV 导出）与平台证书自动下载/轮换（`GET /v3/certificates` 按 `Wechatpay-Serial` 缓存选证书，env 静态证书为兜底）已于同日补齐。仍待：部分退款（当前仅全额）、发票。注意：PaymentOrder 新增 `snapshotJson/refundId/refundedAt/refundReason` 列（纯加法），prod 部署带 `db push`；支付到账订阅消息需在微信后台申请模板并配 `WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID`。
- 签名服务偶发不可用时提交为未签名（不影响功能）。
- **pgvector 路径已实现但未真库验证**：本地无扩展，默认 `PGVECTOR_ENABLED=false` 走内存余弦（已验证）；上真库执行 `npm run db:pgvector` 并置 true 后需端到端验一遍（升级路径 1）。
- **模型密钥加密存库**：`services/secretBox.ts`（AES-256-GCM）对 模型/Dify/技能库 密钥写时加密、读时解密，配 `APP_ENCRYPTION_KEY` 后生效（未配=透传明文兼容演示），存量跑 `npm run secrets:encrypt` 回填。仍待：密钥接 KMS/密管 + 轮换策略（升级路径 8）。
- 运营后台 项目/报告 只读看板已加（`GET /admin/projects`、`GET /admin/reports`）；知识库看板走既有 `/admin/knowledge`。前端看板页待接。
- **时序知识图谱**（Graphiti 式）已落首版：`GraphEntity/GraphRelation`（关系带有效时间窗）+ `services/knowledgeGraph.ts`（实体去重、新事实软失效旧事实、as-of 查询）+ `routes/graph.ts`（抽取/实体/关系查询）。抽取依赖真实模型（mock 返回空）。仍可增强：对话汇总/知识入库时自动触发抽取、图谱可视化前端。
- **@引用** 选择器候选含 项目/报告/知识/记忆：记忆候选走 `GET /memories`（后端就绪），`resolveReferences` 支持 `kind:'memory'`；前端选择器接「记忆」分组待补。
- **5-tab 设计还原（2026-07）· 前端已跑通但缺后端建模的能力（gap 清单，按优先级）**：
  1. **拆军令 LLM 结构化升级**：执行闭环已服务端化（`Casefile/CasefileOrder/CasefileMetric` + `/casefile*`，M0 PR-EX 完成）；「认可方案→拆军令」目前仍是分节启发式提取 + 整体 aligned=true 标注，待升级为 LLM 结构化拆解与逐条对齐性标注（M2 复盘阶段接入，配合对齐率计算）。
  2. **主军师身份 prod 迁移已完成（2026-07-03）**：prod `agent` 表已迁移——general=V6.0 全文（用户 07-03 晨手动灌入+发布快照）+ 新主线 greet（草稿与 `agent_version` 快照同步）；strat 卸下 V6.0 回归「战略诊断官」专业模板并重新上架（`skillsConfig.deliverableMode='on-demand'` 与 deliverableKey 保留未动）。后端代码已通过 `scripts/deploy-prod.sh` 发布 `4902b0b` 到线上，`prisma db push` 纯加法完成（9 张新表 + `Session.mode`），`survey_question` 已定向 UPDATE 为年营收四档与美业/大健康拆分后的行业列表，未重跑 seed。备份：`/tmp/junshi-db-backup-20260703-172937.dump`（全库，已拉回本地）。
  3. **总军师派单引擎（consult_specialist）未建**：调度白名单目前语义=「unlock 已解锁 → 可进专属线程深聊」（`assertAgentAccess` 既有行为）；总军师自动派单/结论回流（多 agent 编排 + 未解锁 specialist 标记 skipped）待建 orchestrate 层时实现。~~同期把 on-demand 成果产出移交 general~~ **已完成（2026-07-03 P0-3）**：general 配 `deliverableKey='战略方案'` + `skillsConfig.deliverableMode='on-demand'`（注册表 `data/agents.ts` + `prisma/seed.ts` + 测试基线 `test/helpers.ts` 三处同步；模板在 `data/deliverables.ts`，段名对齐案卷提取启发式——「30 天行动军令」拆军令、「现在不能做」提风险锁）——六轮主线聊成熟后总军师直接产出可采纳成果卡。当前分流：general 普通问答仍逐 token 流式；明确成果请求走 report SSE 卡片流，必要时回退 `/generate-sync`。**生产迁移注意**：`agent` 行与已发布 `agent_version` 快照两处都要 UPDATE 这两个字段。
  4. **B 级卡片剩余 9 张 + A 级报告模板待做（M4 PR-15 第二批）**：已上线 每日战报/天时日历/天命速写 三张（`services/cardHtml.ts`）；剩余 周/月/季战报、年度里程碑图、紧急决策推演卡、晋升卡、性格操作手册卡、定位一页纸、十二问诊断卡 + A 级七章报告模板——其中战报类依赖对话内容沉淀（复盘产出结构化），晋升卡/性格手册数据已就绪可先做；卡片骨架语义参考 Notion 原稿（须按 §0 #10 去米诺）。
  5. **排盘引擎 v1 已知边界**（`services/paipan.ts` 头注同步）：称骨暂缓（60 干支年表需可靠来源核对后再上，防带错表）；格局仅月令取格（不处理从格/化格）；身强弱/喜用为 v1 计分启发式；真太阳时只做经度平太阳时（未含均时差；城市→经度映射 `data/cityLongitude.ts` 覆盖 ~48 城，未命中不校正）；阴历闰月后端支持（负 month）但前端采集 UI 暂未提供闰月选项。战略档案 v1 回写触发点=认可方案+手动校准，逐轮 LLM 抽取待 M2 与决策日志共建抽取管道。引擎升级须提 `PAIPAN_ENGINE_VERSION` 并按版本复算，不得悄改历史命盘。
  2. **提醒与日历剩余项**：21:30 复盘提醒已接微信订阅消息（执行页授权 + scheduler 发送）；09:00 军令提醒、周五周复盘提醒、日历视图仍待建模与模板配置。
  3. **数据源授权绑定**：店铺（淘宝/抖店/小红书）、内容账号、企业工商（企查查类）、企微 CRM 均无真实接入，`packages/work/bindings` 为目录引导（仅财务表走资料库上传）。每类需独立 OAuth/采买与同步管道，且按 PRD 属可单独收费能力。
  4. **模块/Skill 状态持久化**：市场为静态目录，「启用」= 跳军师对话承接；添加/隐藏/排序/基础版-深度版状态、模块↔报告↔任务关联（设计里「报告已回写模块」）需后端 `UserModule` 建模。
  5. **知识库 AI 自动分类**：设计的「AI 分类文件夹」（企业档案/老板档案/产品服务…8 类 + 份数）未实现——`KnowledgeItem.kind` 现为技术枚举，需入库时 LLM 归类到业务文件夹并出计数接口；前端文件夹网格暂为框架展示（不显示假份数）。
  6. **总军师↔专业军师自动协同**：派单/回流现靠前端 prompt 跳线程（用户手动触发），设计要求自动派发与结论摘要自动回流主线（多 agent 协作引擎 + 未读数）。会话未读数也无模型。
  7. **三势判断结构化**：战局页三势卡现为方法框架 + 发起对话；设计的强弱条/打法结论需产出结构化 `forces` 字段（gateway schema 扩展）后才能真实渲染。
  8. **目标阶梯**：3-5 年/年度/季度/本周目标无结构化存储，执行页目标阶梯为引导态；可并入案卷模型（goals）。
  9. **社群/分班**：注册分班、服务老师、班级二维码、入群任务需运营后台 + 后端支持；`packages/work/community` 为待分配引导态。
  10. **搜索**：对话页搜索现为客户端过滤军师/会话；设计口径「搜索军师、案卷、报告或资料」需服务端跨域搜索接口（可复用 `knowledgeSearch` + reports/sessions 模糊查询聚合）。

---

## 14. 变更日志

历史变更日志已拆到 `docs/CHANGELOG.md`，避免 `AGENTS.md` 初始加载过重。后续凡代码 / 配置 / 接口 / 数据结构变更，仍需在同次提交中更新受影响章节，并在 `docs/CHANGELOG.md` 顶部追加 `YYYY-MM-DD · 改动 · 影响面`。
