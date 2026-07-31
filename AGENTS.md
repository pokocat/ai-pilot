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
9. **运营后台 UI 改动守设计系统**：凡改 `admin/` 前端（`.tsx`/`admin.css`），必须对齐 **`admin/DESIGN.md`「Engineering Compliance」**——颜色只用 `:root` token（禁硬编码 hex/rgb）、只用已定义的组件类（禁裸 class 与一次性 inline 控件样式）、z 轴只用 `--z-*`。提交前跑 `cd admin && npm run lint:ui`（`scripts/audit-admin-ui.mjs`，**递归扫描** `admin/src/**/*.tsx`，已接入 `build`）保持全绿。另外四条硬约束（2026-07-28 运营视角改版后）：① 新页面先在 `admin/src/nav.ts` 登记（归属六组之一 + 一句话 hint + 命令面板别名），页面本身不再手写顶层 `sec-h`，标题走 `PageHead k="<section>"`；② 取数一律 `useResource` + `ViewState`，**禁止 `.catch(() => {})`**——请求失败必须与「确实没数据」区分开且可重试；写操作的 `catch` 必须透出 `e.message`（**禁止盖成固定文案**），否则 403「需要 owner 权限」会被说成「保存失败」，见 §9 的 401/403 分流；③ 破坏性/资金动作用 `ConfirmDialog`（回显对象 + 必要时手打确认词），**禁止 `window.confirm/prompt/alert`**；④ 业务视图放 `admin/src/views/<组>.tsx`，`App.tsx` 只留外壳。
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
├── deploy/             # 部署模板：nginx.conf.example（★分 A 主配置 + B 站点两段，两段都要改）· junshi-api.service · Dockerfile.server · docker-compose.yml · monitoring/（Prometheus+Grafana 监控栈，主文档 docs/MONITORING.md）
├── app/                # Taro 移动端（微信小程序 weapp + H5），React + TS
├── server/             # 后端 API：Fastify + Prisma + PostgreSQL + LLM Gateway（含 src/app.ts 工厂 + test/ 集成测试）
├── admin/              # 运营后台：Vite + React + TS
├── loadtest/           # 隔离压测：Docker Compose + 内网网关 + k6 只读场景（默认零外部资源；真实 LLM 仅受控最小探针）
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
- **构建身份与防误传**：`app/config/index.ts` 同时注入 `TARO_APP_VERSION/TARO_APP_BUILD_SHA`，并给 weapp 产物生成 `dist/junshi-build-meta.json`（mode/api/version/gitSha）。mock 包五个主 Tab 左上常驻红色「MOCK · 本地数据」，设置页「当前版本」显示 `版本 · MOCK/正式 · commit`；正式发布统一走 `npm run release:weapp -- --version x.y.z --desc "说明"`，该命令会强制重建 server 包，再对 mode/API/版本做硬校验，任一不符直接拒绝上传。`upload:weapp` 及旧 CI 脚本也执行同口径元数据校验；不得用裸 DevTools CLI 或 GUI 绕过。
- `app/src/services/config.ts`：`APP_MODE`（读已注入的 `process.env.TARO_APP_MODE`，默认 `mock`）、`IS_MOCK`、`BASE_URL`（读已注入的 `TARO_APP_API`）。不要在浏览器运行时再用 `typeof process` 包裹，否则 H5 bundle 会退回 mock/default。
- `app/src/services/api.ts`：每个方法按 `useMockApi()` 分流 mock 或真实请求（通常等价于构建期 `IS_MOCK`，附身会按下条运行时切换），**两种模式同口径**（同样的入参/返回类型）。
- **附身登录是唯一运行时数据源例外**：`api.verifyImpersonation` 无论 `APP_MODE` 为 `mock` 还是 `server` 都必须直连真实 `/me`，绝不能回退 `mock.me()`；server 包复用当前 `BASE_URL`（生产/预发不串环境），mock 包优先使用显式 `TARO_APP_API`，未传时固定验生产 `https://wxapi.aibuzz.cn/api`。验令通过并把三段 JWT 落入 storage 后，`services/runtimeMode.ts` 会让整个会话（普通 API、文件上传、流式对话、案卷与支付环境判断）跟随该真实身份走同一服务端；退出/换回 `mock-*` token 后自动恢复本地 mock。附身 token 只由真实后端签发；仅修验令而不切后续数据源会出现“登录成功但看到 mock 账号”的假附身。
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
- **测试期默认套餐**：服务端设置 `TEST_DEFAULT_PLAN_NAME=决策版` 后，微信/短信/本机号等所有新注册入口统一在建号事务中开通指定套餐并发放完整额度；存量低档用户运行 `npm run db:grant-test-plan -- --plan=决策版 --apply` 升级，脚本保留有效同档和企业私有化用户，不重复发放、不降级。测试结束后清空环境变量并重启 API，新注册即恢复默认体验版。
- **Token**：演示版 `token = userId`，前端存 `junshi.userId`，每次请求带 `x-user-id` 头。
- **隔离**：后端 `resolveUser` 严格按 token 解析，**无/失效 token 一律 401**（无 demo 兜底）；所有业务查询按 `userId/tenantId` 过滤。
- **微信密钥**：`WECHAT_MINI_SECRET` 与消息推送 `WECHAT_MESSAGE_TOKEN` 只在服务端环境变量保存；微信 `session_key` 仅服务端换取时使用，**不下发前端**。
- **方案购买 / 支付**：前台可读 `GET /plans`；未配齐微信支付凭据时，登录后 `POST /plans/:id/purchase` 走演示购买并按方案写入 `CreditLedger`；配齐 `WECHAT_PAY_*` 且套餐需付款时，演示购买被禁用，改走 `POST /plans/:id/order` 创建小程序 JSAPI 支付订单（支持 `source/refId` 归因，与 SKU 同口径落 `ActivationEvent(itemType='plan')`；下单落**条款快照** `snapshotJson`，发放按下单时点配置防改价漂移；同用户 10 分钟 10 单**频控** `ORDER_RATE_LIMITED`；下新单自动调微信 close-order 关同类旧 created 单，远端关掉才置本地 closed），再由 `POST /pay/wechat/notify` 回调幂等入账（解密后校验金额/appid/mchid 一致，不一致绝不入账；退款事件 `REFUND.*` 单独幂等补记）；入账成功自动发「支付到账」订阅消息（`WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID`，未配则静默跳过）。`requestPayment` 成功后前端统一走 `services/pay.ts`（`awaitPaymentApplied` 轮询 + `ensurePayableEnv` H5 守卫 + `requestWechatPayment` 统一调起）；订单明细页（credits）展示支付订单列表并支持**继续支付**（`GET /pay/orders` + `POST /pay/orders/:no/pay-params`）。服务端 `pay-reconcile-sweep` 定时任务（5 分钟）扫「paid 未 applied / created 超时」自动补账或关单；运营侧（后台「订单」页 + 用户详情均已接 UI）：卡单清单 + 手动补账（`/admin/payments/:no/reconcile`）、**全额退款** `POST /admin/payments/:no/refund`（owner/master；幂等回收权益：模块停用/凭据收回/套餐立即到期+追回未消耗算力）、订单搜索（单号/用户名/手机号）/分页/CSV 导出（`GET /admin/payments/export`，owner/master，审计留痕）、手动开通套餐/模块（`POST /admin/users/:id/plan`、`POST/DELETE /admin/users/:id/modules[...]`，source='admin'）。回调验签的平台证书支持**自动下载/轮换**（`GET /v3/certificates` AEAD 解密后按 serial 缓存 12h，未知 serial 强刷；`WECHAT_PAY_PLATFORM_CERT` 静态证书为兜底）。**降级守卫**：活跃付费套餐买不同套餐仅放行「同套餐续费 / **可折算的升级**」（折算单付款前有实付/抵扣确认弹窗），其余 409 `PLAN_SWITCH_BLOCKED`；企业版（price<0）调整仅走运营。**升级折算范围（2026-07-31 修）**：`computeUpgradeProration` 是「是不是真升级」的**唯一判定源**（路由不再自带第二份，此前两处各写一份 → 同周期升档被误伤 409），触发 = 月付→年付 **或** 同周期涨价（入门版¥68/月 → 决策版¥198/月）；降级/同价横切/同套餐续费不折算，由守卫继续 409。反套利五条未松：按**老套餐自己的日单价**折未消耗天数、双重封顶 `min(新单原价, 老套餐实付)`、只抵现金不退现、credits/token 不参与。**付款人 openid 不接受请求体指定**（`resolvePayerOpenid`，plans/sku 共用）：body 值只在等于调用者自己的 `wechatOpenId` 时采纳，否则静默忽略——真实支付模式下 openid 决定微信向谁收款；mock 模式下无 openid 的账号合成 `mockopenid:<userId>`（真实 JSAPI 分支有 `isMockPayerOpenid` 兜底断言，合成值绝不上路）。**运营手动改档不静默烧时长**（`POST /admin/users/:id/plan`）：升级/同档 → **结转**剩余天数到新到期日（审计 `carriedDays`）；会缩短的（降级，或不限期→限期）→ 无 `force` 一律 409 `PLAN_CHANGE_SHORTENS` 且套餐一点不动，文案带确切损失天数，带 `force:true` 才执行并审计 `daysLost`。档位比较用 `planTier(price<0)=+∞`——企业版是最高档，直接比 price 会把「企业版→入门版」判成升级。`planExpiresAt=null`（不限期）不当成 0 天。本地联调 `npm run pay:mock` 起 mock 微信网关（含下单/查单/关单/退款端点，`WECHAT_PAY_BASE` 指向），完整真实加解密链路离线走通（见 §11）。**测试期 `PAY_MOCK_SUCCESS=true`（2026-07-30）**：没有商户凭据也把真实支付管线整条跑通——下单走既有 `createJsapiOrder`（条款快照/金额/归因/频控/关旧单一个不跳，只是不请求微信 JSAPI），到账由 `POST /pay/mock/pay`（用户自己的单 + **只认 mock 单**，真实微信单一律 409）触发**真实的** `markPaidAndApply`，状态机/幂等/权益发放/到账订阅消息全部真跑。`payMockSuccessEnabled() = PAY_MOCK_SUCCESS && !payConfigured()`——**真凭据一配齐 mock 自动让位**，这就是「将来零改动替换」的实现方式，不存在「配了真支付却还能白拿」的窗口。⚠️ 开启即任何登录用户可自助领取任意付费套餐/SKU，仅测试期用。mock 单标记 `snapshotJson.mock=true` + `provider='mock'` + `transactionId=mock<数字>`（`isMockOrder` 锚在快照 flag 上，关开关后历史单仍可识别）：对账 sweep/关单/退款都不调微信（退款仍**本地回收权益**）、Prometheus 与运营端营收金额**排除 mock**（改计 `junshi_pay_mock_total`），订单列表/CSV 显式标「模拟单」。已知限制：H5 仍被 `ensurePayableEnv` 拦在下单前（「继续支付」路径已按 `o.mock` 放行）。纯短信注册账号（无 openid）在 mock 模式下**已可下单**（合成 `mockopenid:<userId>`），真凭据配齐时仍 `OPENID_REQUIRED`。前台显示为「方案与产出额度」，企业版 `creditsPerMonth<0` 记为不限量（余额 `-1`，产出不扣减）。
- **智能体开通**：`free`/`metered` 智能体无需开通即可用；`unlock` 智能体需用户用算力购买（`POST /agents/:key/purchase`）或运营后台开通后才能对话/产出，未开通产出返回 `403 AGENT_LOCKED` 且不落会话。
- **离线兜底**：server 模式下后端不可达时，登录回退为 `local-<手机号>` 本地会话，保证可体验（无服务端数据）。
- **退出登录**：「我的」页底部。
- 端到端隔离已验证（见 §11）。短信验证码已接入；生产仍应把 `token=userId` 换成 **JWT**，路由隔离逻辑不变。

---

## 7. 前端（app）架构

### 7.1 页面与导航
Tab 页（自定义导航 `navigationStyle: custom` + 自定义底栏 `custom-tab-bar`）：

底栏顺序对齐设计稿：**对话 · 战局 · 执行 · 智库 · 我的**（五个平铺 tab，无中间凸起按钮；`store.tab` 索引 0..4 按此顺序）。启动页为 `pages/sessions`（进小程序默认落到首位「对话」tab，登录门/建档弹层由对应页面承接）。

五个 tab 的页头统一由 `components/TabHeader` 渲染（对齐最新交互原型 `header`）：**一行小字用途（本命色，字距 .3em）+ 大字 tab 名（宋体 29px）+ 背景一枚大字（本命色 100px / 透明度 .1，贴右上）+ 底部细线**。背景大字要**整字露出，不许裁字脚**：`.th-glyph` 的字号（字身 ≈.93em）与 `.tab-head` 的 `margin-bottom` 是配套的——字身要落在细线之后的留白里，改任一个都要核另一个，也不要给标题区加 `overflow:hidden`。字再放大就必然压到下方第一块内容上，而五个 tab 里有三个（问策 NextStepCard / 军情 battle-hero / 老板 用户卡）是深色不透明主卡，做不成半透明透字，所以字号以「整字放得下」为上限。**页头零按钮**——原型右侧那枚「行业 tag」是装饰，按定稿去掉；`TabHeader` 也不再提供 `right` 插槽，任何功能入口都必须回归它所属的内容区（见下表「原页头入口去向」）。三要素定义在各页调用处，勿散落到样式里：

| Tab | 大字 | 小字用途 | 背景大字 | 原页头入口去向 |
|---|---|---|---|---|
| `pages/sessions` | 问策 | 有事问军师 | 谋 | 历史 → 搜索行右侧 `.council-hist`（翻旧对话与搜索同属「找东西」，且是旧线程唯一入口） |
| `pages/home` | 军情 | 看今日判断 | 势 | 案卷 → 老板 tab；↻ → 「三势判断」段头 `.force-redo`「重算」（它调 `refreshForces` 重算三势，不是简单重拉，`useDidShow` 不做这件事） |
| `pages/studio` | 军令 | 做今天的事 | 令 | 复盘 → 删（同屏 `exec-seg` 与「复盘提醒」卡已两处入口）；案卷 → 老板 tab |
| `pages/thinktank` | 锦囊 | 存你的家底 | 库 | 本来就没有 |
| `pages/profile` | 老板 | 你自己 | 我 | 设置 → 「系统」菜单组首行 |

| Tab | 页面 | 说明 |
|---|---|---|
| 对话 | `pages/sessions` | 「对话」微信式列表（第一入口，底栏首位，对齐设计稿 `page-chat`）：`TabHeader`（问策 / 有事问军师 / 谋）+ 搜索行（白底 pill + 右「历史」切换） + 快捷补给横滑 6 卡（资料/数据源/军师锦囊·模块/生成方案/转成军令/今日执行）+ 通栏半透明线程列表（上下发丝线）：总军师置顶（在线点）+ 常驻专业军师 + 「专业参谋」分组（未启用走 `AgentUnlock`）；专业参谋目录以 `/agents` 为真源，除总军师/常驻位/`creative` 外的全部已上架 `advisory/custom` 动态展示，禁止再写死 key 白名单导致后台上架后 C 端消失。每行=拟人立绘 + 宋体名号 + 金色花名 + 两行真实最近会话摘要/时间；「历史」切换到最近会话列表（长按删）。战局/执行/智库/速诊/数据源/能力市场等业务快捷入口带问题进入时必须续接该军师最近线程，只有用户明确点「新对话」、参谋室主动派单或项目内新建会话时才使用 `fresh=1`，避免快捷动作的新短会话遮住原主线程。 |
| 战局 | `pages/home` | 对齐设计稿 `page-battle`：`TabHeader`（军情 / 看今日判断 / 势）+ 军师判断 hero（`--green-hero` 跟随本命色：kicker 主要矛盾 + 案卷来源行 + 大宋体判断=真实 `me.understanding.summary` 兜底案卷判断，点按→总军师对话）+ 战局信号 metric 3 卡（案卷完整度=档案成熟度 / 待补资料 / 风险锁）+ **「下一步」卡**（打磨·WO-07 Journey 占位：按案卷/档案派生一条动作；冷启动无案卷无判断走 `data/emptyStates.ts` 初诊导流）+ 三势判断 force 3 卡（段头右「整卡看全解 · 小框看单势」+「重算」= 原页头刷新，`refreshForces` 重算三势后回读档案；方法框架→发起判断）+ 下一步动作（`nextQuestions` battle-goal 行→访谈）+ 关联模块（linkmod 行：模块名+负责军师 pill+tier 徽章）+「现在不能做」nono 卡（无则隐藏）+ 今日献策（页尾轻量保留）+ 本命色渐变 CTA（有案卷→执行，无→对话）|
| 执行 | `pages/studio` | 对齐设计稿 `page-execution`（军令体系用 `--gold`，现跟随本命色）：`TabHeader`（军令 / 做今天的事 / 令）+ 横滑战役卡组【今日战役本命色卡（案卷+完成度进度条）· 军师献策（优先显示待执行军令，完成后提示归档/回填/复盘）· 今日主令（首条未完成军令→生成脚本，全部完成→生成复盘）· 提醒节奏】+ 执行信号 + 总军师督战紧凑行（去对话）+ 今日最重要 today-focus 本命色条 + 目标阶梯 4 格（引导拆解）+ exec-seg 三视图【今日军令=第 0 号军令补资料（主题色边框 command-card）+ 未完成 task 卡打卡/长按删/手动添加 + 已完成军令默认收起到归档区（可展开取消完成）+ 线索/咨询/成交数据回填（软底+白格）+ 复盘前检查 · 周计划=近 7 天军令记录 · 复盘=带真实军令与回填数据发给经营参谋 + 提醒节奏】+ AI 创作发布（`useDidShow` 刷新 `/agents`，全部已上架 `creative` 智能体动态展示，保留解锁/按需权益）|
| 智库 | `pages/thinktank` | 对齐设计稿 `page-thinktank`：`TabHeader`（锦囊 / 存你的家底 / 库）+ seg 4 分区【案卷资产=上传区（绿调 upload-zone）+ 状态格（已入库/关键缺口/深度整理）+ 资料树（最新上传=真实 `knowledgeDocs` + AI 分类框架）+ 军师提示补充（暖金 asset-gap，真实 `nextQuestions`）· 数据源=绑定目录单卡行 · 能力=费用口径 chips + 免费 Skill/深度 Skill/方案模块分组行 · 方案=真实版本化方案行 + 生成方案/方案库入口】（WO-01 名词统一：报告→方案）。资料上传后明确引导「开始资料整理 → 待确认 → 确认入库」；空间额度卡按剩余字节向下取整为整数 MB，并同时展示可用/总量（如上传 20KB 后显示 `199/200MB`），避免四舍五入掩盖已占用空间；新上传以客户端源文件名写入 `KnowledgeItem.fileName`，微信临时路径不落库；历史缺失源名的记录在智库、资料库列表和资料详情统一使用有效 `fileName`，过滤「上传资料」及 `growth资料` 等分类 key 占位名后，优先用 Markdown 首标题生成带“按正文标题识别”标记的名称，再回退中文分类名；mock 上传也保留源文件名。已优化资料可逐份展开解析正文预览，长正文使用限高 `ScrollView` 在预览框内滚动；确认按钮按当前条目 ids 提交并二次确认，不依赖刷新后会丢失的 `activeBatch`，提交期间显示“切片并建立索引”状态并用同步锁禁止重复确认、上传和阶段切换。三个整理阶段使用容器、强调色边框和底部指示条区分选中态。|
| 我的 | `pages/profile` | 对齐设计稿 `page-profile`：`TabHeader`（老板 / 你自己 / 我）+ 本命色用户卡（头像/称呼/公司/套餐）+ 经营统计 3 卡（案卷/方案/资料真实计数）+ 权益额度 3 卡（钻石/本月额度/套餐→额度弹层；方案长列表 Sheet 使用明确 `92vh` 高度，固定标题/余额/右上关闭，仅套餐区 `ScrollView` 滚动）+ **战略段位卡（WO-03 冷启动延迟曝光：仅 `streak≥3 或 usageDays≥14` 才渲染）** + 菜单（档案/我的案卷/方案库/资料库/数据授权/**设置**/模块管理/订单明细/送你一卦/提醒日历/本命色/企业版/退出登录）+ 军师社群主题卡 + 深度能力解锁主题卡 |

非 Tab 页：`pages/chat`（对话流 + 渐进式成果卡 + 参谋室协同导轨「派单/回总军师/转成军令/补上下文」+ 成果卡下「认可方案→存方案库+生成本地案卷军令→去执行」）、`pages/brief`（军师档案详情）、`pages/settings` 留在主包；我的案卷（列表/详情，前台名词=案卷，工程模型仍是 Project）、方案库、方案详情、资料库、数据源绑定、模块市场、送你一卦、军师社群已拆到 `packages/work/*` 分包（`projects`、`project`、`library`、`report`、`knowledge`、`credits`、`bindings`、`market`、`gift`、`community`），由 `pages/profile`、`pages/thinktank` 与 `pages/chat` 预加载。`packages/work/quickscan` 初诊结果 CTA 统一用「继续问策，完善这份判断」进入总军师，不向用户暴露固定对话轮数。完整履历 `packages/work/dossier` 的个人档案/我的页入口必须反馈分包跳转失败和导航锁等待状态；页面读取失败展示可重试状态并走 `handleApiError`，首次无缓存但已有档案线索时直接自动生成，不得被手动按钮的 `ready` 门禁拦截。

静态目录数据：`src/data/operatingSystem.ts`（模块市场/Skill 市场/知识分类框架/数据源目录/对话引导，均为能力目录与引导态文案，费用口径 `💎xN`）、`src/data/council.ts`（参谋室常驻军师/派单建议/快速起手式/`ADVISOR_ALIAS` 军师花名：玄衡/观澜/青衍/鸣璋/照微/云枢…）。**这两个文件不得写入用户业务结论**——用户数据一律走 api（会话/报告/知识/项目/`me.understanding`）。

军师拟人头像：`components/AdvisorAvatar`（圆形立绘 + 白描边 + 可选在线点），当前主用立绘资产在 `src/assets/avatars/generated/*-imagegen.jpg`（6 张 376px JPEG ≈306KB，由 imagegen 生成的古代/神话谋略人物商务漫画头像：general=诸葛亮意象、strat=鬼谷子意象、growth=姜子牙意象、ip=文曲星意象、ops=刘伯温意象、org=张良意象；其余智能体按气质就近复用，未映射的按 key 哈希兜底）。旧版雪碧图裁切 `src/assets/avatars/*.jpg` 已删除（未引用即清理，控主包体积）。对话列表行、chat 头部与消息 who 行统一用它，不要再回退成图标色块。

战略案卷（执行闭环，已服务端化 · M0 PR-EX）：`services/dossier.ts` 是页面唯一入口——「认可方案→案卷（军令/风险锁/判断）→打卡→线索/咨询/成交回填→复盘 prompt」。server 模式走 `/casefile*` API（后端 `Casefile/CasefileOrder/CasefileMetric` 三表，按用户行级隔离，换设备不丢；军令/风险仍按 行动/风险 类分节标题启发式提取，服务端 `services/casefile.ts` 与前端 mock 分支同一套规则，**不预置业务结论**；自动拆军令和手动补军令均按「同一案卷 + 同一天 + 标准化文本」幂等，重复认可/重复添加不再追加列表）；mock 模式沿用本地 storage 实现（`junshi.dossier.<token>`）。老用户首次拉取会把本地案卷一次性导入服务端（`POST /casefile/import`，服务端幂等 + 本地 `junshi.dossier.migrated.<token>` 标记）。页面接口全部异步（`refreshDossier/acceptDeliverable/toggleOrder/addOrder/removeOrder/saveBackfill` 返回 Promise），打卡在执行页做乐观更新；完成军令不删除，今日页仅从待执行列表收起到默认折叠的归档区，周计划、复盘、每日战报继续读取 `done` 记录。战局页（案卷行/风险锁/CTA）与执行页共用该服务。

### 7.2 关键 UI 约定（踩过的坑，勿回退）
- **小程序工程约束清单（先读）**：
  - **项目导入与配置**：微信开发者工具只导入 `app/`；`app/project.config.json` 是正式配置，保持 AppID、`miniprogramRoot=dist/`、`libVersion=3.16.2`（真流式 `enableChunked` 目标基础库）、`urlCheck/es6/enhance/postcss/minified` 等正式校验/压缩开启；`app/src/app.config.ts` 保持 `lazyCodeLoading: "requiredComponents"`，且 `app/config/index.ts` 的 weapp webpack 链必须确保 `dist/app.json` 实际写出该字段；本机调试差异放 `app/project.private.config.json`，不要把根目录误生成的 DevTools 配置纳入提交。
  - **发版构建必须清缓存（2026-07-29 实测白屏）**：`app/config/index.ts` 开了 webpack 持久化缓存（`cache:{enable:true}`，落在 `node_modules/.cache/webpack`，不是 `.cache`）。跨分包共享模块变动后（如 `services/creative.ts` 同时被 `packages/main/chat` 与 `packages/work/poster` 引用），缓存里的旧模块会和新构建的模块图拼在一起，产出**引用了不存在模块 id 的 chunk**；小程序运行时表现为 `TypeError: n[e] is not a function`（`n[e]` = `modules[moduleId]`）→ **整个页面白屏、无 React 报错**，后面跟一条 `Component is not found in path "wx://not-found"`。这类白屏与数据无关，别去查数据形状：先 `rm -rf dist .cache node_modules/.cache` 重建。`build:weapp:server` / `build:weapp:preprod` 已前置 `clean:build` 自动清理（发版构建以正确性优先，不吃增量缓存）；`dev:weapp --watch` 仍保留缓存以便迭代。自检办法：产物里若存在「被引用但全 dist 无定义」的模块 id，即为缓存脏。
  - **上传前恢复正式域名校验**：`app/project.private.config.json` 的 `urlCheck:false` 仅用于局域网临时预览；上传/提审前必须在微信开发者工具「详情 → 本地设置」恢复合法域名、web-view 业务域名、TLS 与 HTTPS 证书检查，并用生产 API 域名完成一次真机回归，不能把“工具关闭校验后能请求”当成上线可用。
  - **原生 tabbar 只隐藏不恢复**：custom tabBar 模式下任何路径都不得调用 `Taro.showTabBar`。正常 Tab 挂载/切换只调用 `hideNativeTabBarOnly()` 压住微信原生底栏；全屏 overlay 用 `store.setOverlay(open, stableKey)` 写 storage 并隐藏自定义底栏，关闭/卸载时清理对应 key。custom-tab-bar 在无 overlay 时必须自动清理过期隐藏标记，避免真机重进后导航消失。
  - **弹层不进 custom-tab-bar**：`custom-tab-bar` 只做导航和 overlay 状态同步，不渲染 `Login` 或其它全屏业务弹层；未登录点击中间「对话」只提示并跳 `pages/chat`，由聊天页承接登录弹层。
  - **overlay 同步不用轮询**：底栏状态同步依赖 `eventCenter` + 页面 `useDidShow` + `hideNativeTabBarOnly()` 短延时兜底；不要恢复 250ms/1500ms 常驻 interval。
  - **顶部安全区统一组件化**：Tab 页用 `Screen topInset`，非 Tab 自定义头用 `SafeHeader`；五个 tab 的标题区统一用 `components/TabHeader`（它自带 `tab-page-head`，高度由内容撑开；**不要加 `overflow:hidden`**——背景大字靠字号与下方留白配套，整字露出而不是被裁），安全区让位只由 `Screen` 的 `.nav-inset` 负责，页面内不要再单独测胶囊、写 `env(safe-area-inset-top)`，也不要再各页复制一套页头（`exec-nav/battle-nav/messages-head/think-nav/account-nav` 已删）；不要加伪状态栏 `9:41`。
  - **tab 页头零按钮**：设计稿页头右侧那枚「行业 tag」是装饰，已按定稿去掉，`TabHeader` 也**不提供 `right` 插槽**——不要为了省事又往页头塞入口。新功能入口一律挂到它所属的内容区（段头、卡片、菜单行），落位前先确认：① 它是不是同屏已有入口的重复（军令页原页头「复盘」就是，已删）；② 它是不是别的 tab 已经有的（案卷已在老板 tab 出现两次）；③ 它有没有别处替代（`历史`/`设置` 是唯一入口，必须给新家，分别落到搜索行右侧与老板页「系统」菜单组）。删入口前一定要先核 reachability，别把唯一入口当重复清掉。
  - **组件样式导入顺序统一**：同一页面同时用 `Icon` 与 `SafeHeader` 时，保持 `Icon` import 在前、`SafeHeader` import 在后；同时出现 `Picker` 与直接或间接依赖的 `Sheet` 时，保持 `Picker` 在前、`Sheet` 在后，避免 Taro/mini-css-extract-plugin 在 common chunk 报 CSS order warning。
  - **对话键盘与生成态按真机口径写**：`packages/main/chat` 保持页面 `disableScroll: true`、底部输入 `adjustPosition={false}`、`alwaysEmbed`、整条 `.box` 触发 focus、`onInput` 返回 `e.detail.value`、`onConfirm` 使用事件值发送，并由 `onKeyboardHeightChange` 写 `--keyboard-height` 让 `.chat` 自己压缩底部空间；反问卡「其他」保留卡片内输入外观和原交互，但卡片里只能用 View/Text 显示草稿，真正接收键盘字符的透明 Textarea 必须放在聊天 ScrollView 外，防止 Android 原生文字层漂到状态栏；微信端不存在 `enableNative=false` 能力（当前 Taro 只在支付宝端声明），不要照搬跨端属性；Android 真机的普通表单 Input 不得放在全屏纵向 `ScrollView` 或 fixed 弹层中，执行页因此使用 `Screen scroll={false}` 原生页面滚动，目标编辑器在目标阶梯下方就地展开；页内输入统一用 `KbInput`（`alwaysEmbed + adjustPosition=true`），聚焦期间禁止监听键盘后再改父级 `scrollTop`、追加键盘高度垫片、收缩容器、改 transform/margin 或按键盘 key 重建 Input，避免原生文字层不可见、停在旧坐标或失焦后才出现；Taro/微信首次渲染的 `style` 对象不得传 `undefined` 值（动态 CSS 变量给明确默认值，条件样式用空对象），否则运行时会在 `finalizeInitialChildren` 对 `undefined.toString()` 并整页白屏；等待回复 `busy` 时输入框必须真正锁定（不 focus、不更新草稿、不发送、不清空当前内容）；生成中退出聊天页后，客户端 `chatPending` 短标记先桥接“发送→服务端登记”的网络窗口，服务端继续按 `sessionId` 暴露 `SessionItem/SessionDetail.generating` 权威真值，列表摘要显示「军师正在思考…」，重进同一会话立即恢复思考态并轮询详情，最终回复落库后自动替换历史；重进页面拿不到原请求 abort 句柄，不得展示无效停止键，异常结束且尾条仍是用户消息时给出明确重试；用户上滑查看较早历史、离底部较远时显示「回到最新」浮层按钮，一键回到对话底部，且避让输入区/引用行/键盘；用户消息、AI 回复、记忆提示与成果卡必须支持长按复制（小程序自定义气泡不能依赖系统文本选择）；AI 普通文本回复用无卡片正文样式并开启文字选择复制，用户输入保留右侧气泡卡片。
  - **登录/401/网络错误有统一入口**：用户动作前先检查登录态；401 必须清用户态并弹登录/回首页，不能吞成空态或“产出失败”；默认首页 `pages/sessions` 自己承接 `Login`，在本页 401 时只打开登录弹层，不再反复 `reLaunch` 自己，且未登录/退出态仍要加载公开军师注册表并保留 `DEFAULT_AGENTS` 兜底，避免真机旧 token 失效后对话页清空；`Taro.request` reject 要按真实原因区分 `timeout/offline/domain/ssl/dns/unreachable/cancelled/network` 并映射成用户可读提示，合法域名/API 域名等排查细节只放 `reason/technicalMessage`/日志，不直接展示给用户；HTTP 408/504、429、5xx 也要给用户友好但真实的原因，服务端 5xx、SSE `INTERNAL` 和 JavaScript 异常原文一律只进日志/`technicalMessage`，不得直接出现在军师气泡；需要登录的数据页 catch 后先调 `handleApiError`；普通聊天默认走 `/generate` 真流式，小程序用 `enableChunked/onChunkReceived`，**并显式设 `timeout: 180000`**（微信默认约 60 秒会在慢模型仍正常输出时提前断开），H5 用 `fetch` ReadableStream；服务端只对用户输入做前置内容审核，违规输入直接 `MODERATION_BLOCK` 拦截，模型输出不再走阻塞式审核，完成后仅做 trace/禁用词审计；OpenAI/Claude 普通聊天在无工具调用时优先走 provider 原生 streaming，Dify、工具循环、mock 或不支持 stream 的兼容网关回退为完整结果分块；普通聊天输出预算统一为 8,000 token，provider 返回 Claude `stop_reason=max_tokens` 或 OpenAI `finish_reason=length` 时必须标记 `AI_OUTPUT_TRUNCATED`：残缺正文不得落库、不得触发记忆更新，并向用户提示重试或分段继续，不能把达到上限误判为正常完成；总军师 on-demand 普通问答也走 token 流，`/generate-sync` fallback 同样按意图分流，只有明确“生成方案/报告/成果卡/纪要/军令/出报告/战略体检”等成果请求才走强制结构化成果路径（`generateDeliverable`），不得再进入 adaptive 可选工具路径；OpenAI/Claude provider 返回空文本时必须按 AI 服务异常处理，不得伪装成固定追问；结构化工具返回的 `sections` 必须经 `normalizeDeliverableSections` 归一化，非数组/字符串/对象都不能让报告请求变成 503；模型未调用工具但返回普通长文时要转成报告分段，避免直接降级模板；报告成果不得把运行环境、Git 仓库、代码库、IDE、文件系统或 Codex 工作区当成客户资料，gateway 命中“当前工作区/Git 仓库/代码仓库/上传到工作区”等工程语境时必须替换为业务兜底成果并标 `degraded`；前台 degraded 提示不得暴露“结构化产出/降级模板”等技术术语；明确成果请求（如出报告/重新出报告/战略体检/生成方案）与带 `deliverableKey` 的成果型顾问必须按本次 `agentKey` 配置判定并走 `/generate` report SSE：收到 `meta` 先渲染 ReportCard 骨架，`begin/section/footer/done` 增量更新当前卡片，当前页不得只停在全局 thinking；只有 report 流无可渲染事件/传输失败时才回退 `/generate-sync`；普通聊天流成功仍必须收到可渲染 `token/chat` 事件，误收到 report SSE 时不要留下空回复；报告卡「网页版」在小程序内必须跳转 `packages/work/webview` 直接打开自有域名 `/api/r/:id`，web-view/navigate 失败只提示重试，不得自动复制链接。
  - **H5 兼容不污染小程序路径**：H5 自定义底栏只放 `app.h5.tsx/app.h5.scss`；小程序继续走真实 `page` 节点 + `src/custom-tab-bar`，不要把 H5/weui 兼容样式混进小程序原生 tabbar 路径。H5 底栏通过 portal 挂到 `document.body`，避免成为 `.taro_router` 最后一个直接子节点后被 Taro 路由隐藏规则误判，后续不要把固定底栏直接放回 `#app` 路由容器。
  - **主包持续控重**：项目工作台、项目详情、方案库、报告等非首屏工作流留在 `packages/work` 分包；新增重页面优先分包并在入口页配置预加载，除非确实属于首屏主路径。
  - **真机排版防回退**：标题类 `<Text>` 保持块级化；两列网格用 `space-between + 48.5%`；Markdown 内容用 `MarkdownText`；等待模型返回要显示对话流思考气泡；内容可能超过一屏的全屏弹层必须用带明确高度的原生 `ScrollView`，不能依赖普通 `View + overflow-y: auto`（H5 可滚但微信真机可能完全滑不动）；全屏弹层、色盘、商业文案按下方约定处理。
  - **ScrollView 与系统信息 API 保持新口径**：微信 WebView 渲染模式不保证支持直接写在 `ScrollView` 上的 `padding`，滚动区留白统一放进内层 `View`；窗口尺寸/像素比用 `Taro.getWindowInfo()`，设备平台用 `Taro.getDeviceInfo()`，不要新增已废弃的 `getSystemInfo/getSystemInfoSync`。若改完后 DevTools 堆栈仍指向旧哈希分包，先清理 Taro `dist`/`node_modules/.cache` 并重新构建，再执行开发者工具「清缓存并编译」，避免把旧产物误判成当前源码。
- **小程序历史坑只维护一份**：顶部安全区、原生 tabbar、overlay、键盘、登录、H5 样式隔离、网络错误和分包控重以本清单为准；不要在页面里另写一套平行实现。
- **本命色色盘对齐**：`components/Picker` 的色点与名称必须在同一个 `.pk-swatch` 垂直列里渲染；不要拆成上下两条 flex 行，否则选中外圈宽度会导致标签错位。
- **首页标题宋体化**：`pages/home` 通过 `Screen className="home"` 局部定义标题字体栈，品牌名、问候语、今日献策正文、对话卡提问、分区标题与卡片标题使用宋体优先；不要为此改全局 `--serif`，避免影响其它页面。
- **战局页首屏层级**：`pages/home`（战局）的军师判断卡是**纯展示深色卡**（点按整卡进入总军师对话），不要往里塞输入框/chips——对话入口在底栏首位「对话」tab；避免把战局页做成权益/推荐墙。底栏保持浅纸底与明确选中态，避免回退成强玻璃装饰。
- **前台商业文案克制**：面向用户的主路径不要写成“赠送 / 付费解锁 / 充值 / 最受欢迎 / 灵活付费”这类促销口吻；统一用「可用」「已启用」「专项能力」「产出额度」「方案与额度」「常用配置」表达，让用户感到是在调用工作台能力，而不是被推销。智能体费用展示用 `💎xN` / `💎xN/次`，不要写「启用需 N 点」「每次产出 N 点」；后台/代码契约仍可保留 `free/unlock/metered/credits` 等技术术语。
- **Markdown 渲染**：AI 普通回复、成果卡正文、报告详情正文必须通过 `components/MarkdownText` 渲染，支持标题、段落、列表、引用、加粗、行内代码和代码块；有序列表要兼容模型常见的松散写法（条目间空行且都写 `1.`），连续渲染为 1/2/3…；AI 普通回复传 `selectable` 以支持用户选择文字复制；不要直接把模型返回的 `###` / `**` / `-` 原样塞进 `<Text>`。
- **前台记忆披露**：对话页用「军师印象」包装 Agent Memory（WO-01 名词统一，原「专属理解」；记忆条/记忆披露/@引用分组一致）；我的页只放「军师档案」菜单入口，详情页展示 AI 对客户的结构化理解（经营身份、创业路径、当前难题、已沉淀资料、待补问题），不要在我的页首页直接平铺大段内容。两者都不得暴露 `memoryConfig`/Agent Memory 等后台术语，也不得写死 mock 客户故事或展示 `用户123/企业123` 这类占位名；资料不足时让用户进入对话访谈，由军师先问 1-3 个简单问题，不要先分析旧报告或展开诊断。后端真实记忆开关见 §9。
- **两列网格**：用 `justify-content: space-between` + `width: 48.5%`，**不要用 `calc(50%-5px)+gap`**（亚像素取整会溢出换行成竖排）。
- **原生 Input 定高三件套**：微信原生 `Input` 不随内容撑高，仅靠垂直 padding 定高会把宋体高字形上下裁切（只露上半截，DevTools 看不出、真机必现）。任何单行 `<Input>` 必须显式 `height / min-height / line-height` 三等值（单行居中），padding 只写水平向；多行输入用 `<Textarea autoHeight>` 或显式高度。已两次踩坑：chat 问卷卡「其他」自填框（671779f）、onboarding 公司名输入。新写或改动任何输入框样式时先按此三件套自查。
- **本命色联动**：`--green/--green-hero/--gold/--gold-soft` 等业务主色 token 必须派生自 `--accent`，战局 hero、智库上传、我的用户卡、执行行动色和底栏选中态都要跟随设置里的本命色；`--danger`、正文墨色、纸张底色等语义/中性色保持固定。默认本命色=墨绿（`data/colors.ts` 首位 + `store` 默认 + 服务端 `benmingColor` 默认 `green`）。
- **小程序主题 token 不只写链式 var**：主题类（`.theme-red` 等）必须显式覆盖 `--green/--green-hero/--gold/--gold-soft` 等业务 token，不能只写 `--green: var(--accent)` 这类间接链，否则真机上部分卡片会保留默认绿。
- **H5 token 双写**：新增/修改 `app.scss` 里 `page {}` 的设计 token 时，必须同步 `app.h5.scss` 的 `:root` 兼容层（H5 没有 `page` 节点），否则 H5 上新 token 全部失效（深绿 hero 曾因此透明）。

### 7.3 启动流程
`app.tsx` 启动拉 `loadAgents()` + `loadMe()` + `loadBadges()`（未登录跳过）。首页：未登录→登录弹层；已登录账号必须等 `/me.onboarded` 权威结果完成水合后再裁定是否进入全屏入局，不能把“本地无 `junshi.onboarded` / `/me` 尚未返回”当成未建档。服务端 `services/onboarding.ts` 统一判定：有 Profile、2026-07-21 入局仪式上线前创建的存量账号、或已有企业身份/会话/项目/成果/资料/案卷任一真实使用痕迹，均视为已入局；登录响应与 `/me` 必须复用该口径。只有服务端明确未完成的新账号才走「择本命色 → 填行业/阶段/痛点 → 首判」；Profile 保存失败必须停留原页显式重试，不得只写本地完成态。

### 7.4 状态与主题
- `services/store.ts`：轻量全局 store（订阅式）。本命色 / 用户 / 智能体缓存 / tab / overlay / 登录态 / 底栏角标；`loadBadges()` 以 15 秒节流单飞聚合会话未读与复盘账本，问策显示未读数，21:00 后当日尚未复盘时军令显示红点，复盘落账后强制回刷熄灭。
- `components/CoachMarks` 的五 Tab「功能点亮」不是“所有没看过 storage 的账号都补弹”：它只在真正完成首次入局的出口写入当前 token 的 `armed` 标记后展示，完成/跳过即清除；历史账号、换机或清 storage 后登录都不得因缺 `done` key 被重新引导。
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
| `GET /health` | 健康检查（含 DB 探测；结果 1s 短缓存，避免高频探活每次都打一条 SQL） | 否 |
| `GET /health/live` | 存活探针：只看进程，不碰 DB（ALB/k8s liveness——DB 抖动不该把好进程判死重启） | 否 |
| `GET /health/ready` | 就绪探针：含 DB，决定是否给该实例发流量（readiness / 滚动发布连接排空） | 否 |
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
| `GET /sessions` · `GET/DELETE /sessions/:id` | 会话列表/详情/删除。**详情是读取端自愈路径（只在响应上变换，不改库）**：`role=report` 过 `healDeliverableSections` 并保证 `sections` 一定是数组，`role=assistant/system` 过 `scrubSectionJson` 并保证 `content.text` 一定是字符串——端上渲染期一旦解引用到脏形状就是整页白屏（小程序无红屏无堆栈），而客户端防御要等发版，所以这类存量脏数据的热修必须落在这条读取路径上（与方案库 / 版本化报告同口径） | 是 |
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
| `GET /creative/status` | 海报成品图能力位（`enabled` = 后台功能开关行 `creative-poster`，**唯一真源、行缺失视为关**；`pricePerPoster` 供前端显示 `💎x`；`templates` 只含**启用中**的版式，前端不许再存本地目录）——成果卡据此决定**整块隐藏还是显示按钮**，不露出按钮再让用户点到 403 | 是 |
| `GET /creative/posters/brief-draft` | 从成果消息 + 已确认 BrandKit 预填需求单草稿（含 `templateKey`/`templateReason`；LLM 不可用时确定性回退，不阻塞） | 是 |
| `POST /creative/uploads` | 源素材上传（人像/Logo/二维码，multipart 单文件；MIME 白名单 + 10MB，落私有 OSS，`kind='source'`） | 是 |
| `POST /creative/posters` | 建海报任务（`idempotencyKey` 按用户唯一：命中回 **200 + `reused:true`**，新建回 201）；门禁顺序=开关→解锁→套餐→校验→审核→幂等→日限额→扣费 | 是 |
| `GET /creative/jobs/:id` · `POST /creative/jobs/:id/cancel` | 任务状态/成品资产（越权一律 404）· 取消（pending 立即退款；running 只打 `cancelRequested`，worker 在阶段检查点收口） | 是 |
| `POST /creative/jobs/:id/revise` · `POST /creative/jobs/:id/regenerate` | 只改文案重排（**不扣钻石**，复用父任务主视觉）· 重出主视觉（**再扣一次**）；两者都新建任务并挂 `parentJobId`，旧资产永不覆盖。**三个建单入口的门禁必须一致**：开关 + `assertPosterAccess` + 套餐——revise 曾漏掉 `assertPosterAccess`（不扣钻不等于不需要权益），2026-07-29 补齐 | 是 |
| `GET /creative/assets/:id/file` | 资产文件：归属校验后配了 OSS 则 302 短签名 URL，否则流式返回（本地/测试内存回退） | 是 |
| `GET/PUT /admin/creative/config` · `POST /admin/creative/provider/dry-run` · `GET /admin/creative/jobs` · `POST /admin/creative/jobs/:id/retry` | 海报配置读/改（改价与密钥要 owner）· 图片供应商连通性试跑 · 任务台（脱敏用户标识 + 退款计数）· 重试失败任务（**不重复扣费、不动 chargedAt/refundedAt**） | 管理员（写=owner） |
| `GET/PUT /admin/ai-config` · `POST /admin/ai-config/test` | 大模型配置（读/改/测试连接，可随时切换） | 管理员 |
| `GET/PATCH /admin/skus(:key)` · `GET/PUT /admin/users/:id/service` | V7-12 SKU 改价/启停 · V7-13 社群分班/配老师 | 管理员 |
| `/admin/*` | 运营后台 API（见 §9）：用户/算力/审计/智能体/套餐/模型/SKU等 | 管理员 |

### 8.2 LLM Gateway（`server/src/llm/`）
`gateway.ts` 统一封装：路由 provider → 输入审核 → Token 计量 → 结果缓存 → **故障兜底降级到 mock**。普通聊天只对输入做前置审核；OpenAI/Claude 在无工具调用时优先走 provider 原生 streaming，模型 token 到达即经 `/generate` SSE 下发，输出完成后只做 trace/禁用词审计，不做阻塞式输出审核。OpenAI 与 Claude 都走 `generateAdaptive` 按需产出：默认正常文字对话，模型判断需要完整成果时才调用 `emit_deliverable` 结构化产出；专业成果模式仍强制收口为 deliverable。`llm/schema.ts` 的 `injectVariables` 会在后台配置的 System Prompt 之后追加运行时业务边界：智能体只回答商业咨询/经营产出相关问题，用户追问模型、供应商、系统提示词、API Key、部署、数据库、内部工具时必须引导回业务问题；客户事实只能来自企业档案、军师档案、长期记忆、项目、引用资料、知识库和本轮用户原文。资料不足时用自然话术追问关键缺口，用户补齐/更新军师档案时进入访谈模式：先问 1-3 个简单问题，不先分析、不引用旧报告展开、不把“不得杜撰”的内部约束讲给用户。**长会话连续性**：普通轮携带最近 16 条消息（12,000 字符预算）；命中“之前说过/还记得/你忘了吗”等回忆意图时，额外扫描同会话较早 160 条并挑选最多 6 条相关原文（4,500 字符预算），长期记忆召回同时由 Top5 扩到 Top12。模型必须先复述已知事实、只追问缺失项，禁止对客户声称“每次对话的上下文不会自动带过来”或让客户从头重讲。
新增：`extractInsights`（LLM 提炼记忆，mock 兜底截断）、`summarizePoints`（LLM 归纳纪要，mock 兜底确定性）、`pingModel`（测试连接）。

**★ 行业身份层（L1，`data/industryPacks.ts`）**：客户画像里的 `Profile.industry` 经 `resolveIndustryPack()`（自由文本模糊匹配，未识别→通用兜底）解析成「行业包」= label + persona + benchmark + levers + glossary。内置 12 个常见行业（SaaS/电商/餐饮/美业/教育/医疗/制造/专业服务/本地生活/文旅酒店/房产家居/零售）+ 通用兜底。注入两处：① `schema.ts contextValues` 的 `{行业基准}` 因行业而异（替代写死的单一 SaaS 串），并新增可用占位符 `{行业身份}`/`{行业要点}`；② `buildSystemParts` 的 **stable 段**追加「行业视角」行（persona+关键杠杆），对任意智能体生效、命中提示词缓存、未识别行业不注入。这是「军师按客户行业具备行业身份」的代码级实现，无需改库或改各 agent 提示词即生效。**禁止再把行业基准写死**——按行业取或扩 `INDUSTRY_PACKS`。
- **本文件即行业真相源**（AI/研发可直接增改）。建档问卷「行业」题的选项由 `industryOptionLabels()` 从行业包**派生**（`data/seedConfig.ts` 的 `SURVEY`）→ **新增一个行业包，建档选项自动多一个**。落库：`npm run db:seed`（破坏性重建）或 **`npm run admin:sync-content`（非破坏 upsert，保留运营启停，推荐）**。运营仍可在后台「问卷」页临时增改选项；选项串经 `resolveIndustryPack()` 模糊匹配回包，命中即获富身份、未命中优雅回退通用。app 端 `Picker`/`mock` 有离线兜底问卷副本，改选项需同步维护。
- **新增行业**：在 `INDUSTRY_PACKS` 补一条（唯一 key + 简短 `label` + 充分 `aliases` + persona/benchmark/levers）；注意 `label`/`aliases` 不要被更靠前的包抢先命中——`test/industryPacks.test.ts` 有 round-trip 断言（每个 label 必须解析回自己的包）兜底。后续如需运营在后台可视化增改「包」本身，再下沉 DB + admin CRUD（L1.5）。后续 L2 意图分诊路由 / L3 行业专家 agent 见 Notion 设计记录。

**★ 模型由「运营后台 → 模型」可视化配置并随时切换**（存 `AiSetting`，`services/aiConfig.ts` 解析：DB > env 兜底，4s 缓存）。默认 **Agnes 2.0 Flash**（`apihub.agnes-ai.com/v1`，OpenAI 兼容）。

**模型单价是 model 级 SSOT，不是端点随机覆盖值**：端点池允许多个 `AiModel` 使用同一个模型名，但同名模型只有在 `priceInput/priceOutput` 同时配置且各端点三档价格一致时才视为已校准；历史半配置或冲突价格会记一次 error 并确定性回退——成本记 0、用户额度按裸 token，而不是依赖无序 `findMany()` 的最后一行。新增同名池端点时应复制相同价格；需要供应商级不同价时必须先把费率键升级为 endpointId，不能继续复用同一 model 名偷偷分叉。算力按输入价折算：未缓存输入 1×、缓存写默认 1.25×、缓存读按后台价、输出按 `out/in`；`CREDIT_WEIGHTED=false` 可即时退回裸 token。

Provider（`provider` 字段，由 `effectiveProvider` 决定实际生效）：
- **mock**：模板产出，零成本可离线（`providers/mock.ts`）。
- **claude**：Anthropic 原生 `/v1/messages` 协议，tool use 强约束（`providers/claude.ts`）；官方直连 `baseUrl` 留空，第三方网关填 Anthropic 根路径（如 qnaigc `/bypass/anthropic`）。后台必须允许该模式填写 `baseUrl`；服务端会裁掉误粘贴的尾部 `/v1` 或 `/v1/messages`，再由 SDK 统一补 `/v1/messages`，避免重复路径 404。
- **openai**：OpenAI 通用协议，兼容 **Agnes / DeepSeek / Moonshot(Kimi) / 通义千问** 等（`providers/openai.ts`，function calling 强约束）。
- Claude 模型（`provider=claude` 或 OpenAI 兼容模型名含 `claude`）可在后台配置 `thinkingMode=disabled|enabled|adaptive`；`enabled` 的 `thinkingBudget` 限 1024–7000（业务普通聊天 `max_tokens=8000`，必须留出正文预算）。开启 `enabled/adaptive` 后，仅最终的思考请求临时使用 temperature `1`，**数据库、端点池与后台表单始终保留运营原值**，关闭思考后可无损恢复。关闭时七牛等第三方 **Anthropic 协议**网关显式发送 `thinking.type=disabled`，且**不得携带 `budget_tokens`**（七牛仅在 `enabled` 时接受预算字段，`disabled + budget_tokens:0` 会返回 400），避免网关默认开启思考；Anthropic 官方直连则按官方协议省略 thinking。OpenAI `/chat/completions` 没有标准 `thinking` 字段，因此 OpenAI 兼容 Claude 在后台保持“关闭”时必须完全省略该字段；只有运营显式选择 enabled/adaptive 后才视为网关扩展能力并发送。后台“测试连接”与普通聊天必须携带同一 Thinking/temperature 配置。结构化成果及多轮工具调用显式关闭 Thinking：Anthropic Thinking 只允许 `tool_choice=auto/none` 且要求跨轮保留 thinking block，与现有强制 `emit_deliverable` 收口不兼容，不能为开关破坏成果链路；关闭后的请求使用保存的运营温度，不得沿用思考请求的 `1`。
- `temperature` 保留为模型级运营参数；后台开启 Thinking 时控件可只读但不能改写值，provider 仅在组装启用思考的请求时取 effective value `1`。不得用省略 temperature/Thinking 的轻量请求把错误配置测成“连通”。
- `isRealKey()` 识别占位/假 key——**未配置真实 key 一律降级 mock**，不发网络请求；后台填入真实 key 即时切真实模型（无需重启/改 env）。
- baseUrl/model/key/温度/Thinking/嵌入模型 全部来自运行时配置，providers 接 `ResolvedAiConfig` 入参。

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

**兼容网关超时口径**：`OPENAI_TIMEOUT_MS` 控制普通对话，以及流式的首包/相邻数据块空闲上限；收到任意上游字节即续期，不能再因累计总时长截断正常流。强制结构化成果（含工具循环终结轮）取 `max(OPENAI_TIMEOUT_MS, 300000)`：报告本来就是可退出后后台完成、回到会话恢复结果的异步链路，允许最长等待 5 分钟；**普通对话的超时与故障转移体验不随之放宽**。失败日志只记录网关 host、模型、阶段、超时配置与耗时，不记录 prompt 或密钥；超时以 `AI_TIMEOUT` 归一为用户可读的重试提示。

### 8.3 其它服务
- `services/llmGate.ts`（2026-07-26 压测 P0-2）：**上游模型的全局并发闸**。挂在 `llm/providers/{claude,openai,dify}.ts` 的真实外呼处（不挂 gateway 的业务分支——那里有 17 个动态 import 调用点，逐个包既漏又难维护；挂 provider 层则新增调用路径自动被覆盖）。车道键已泛化为任意字符串（`main` / `aux` / `main#<endpointId>`），接入端点池后**每个端点各占一条独立车道**，并发预算与 429 冷却都按端点算，一个端点被限流不连累其它端点。默认 8 并发 / 12 突发（`LLM_MAX_CONCURRENCY` / `LLM_BURST_CONCURRENCY`），排队超 15s 降级为 `AI_BUSY(503)`。**429 走整窗冷却**：压测实测 20 并发触发 429 后，紧接着的 12 并发复测 48/48 全挂，说明上游是滚动时间窗限额，所以收到 429 就整窗停发（优先采信 `Retry-After`，否则指数退避），冷却结束从低水位逐步爬回常态——而不是让每条请求各自重试去放大打击；只有一次完整成功才清零连续 429 计数并推进爬坡，失败请求释放槽位时不得提前复位退避状态。显式速率窗口 `LLM_RATE_MAX_PER_MIN` 默认 0（关闭），等线上跑出真实 429 率再校准，不去猜上游配额。流式路径手动 `acquireLlmSlot`/`release`，槽位持有到整条流消费完（只包"建流"那一下等于没限）。mock provider 不过闸，测试与演示环境不受影响。`llmGateStats()` 供后续 `/metrics`。
- **辅助档（aux tier，2026-07-26）**：`services/aiConfig.resolveAuxConfig()` + `llmGate` 的 main/aux **双车道**。核对发现一条用户消息实际触发 3–4 次模型调用——主生成 + `extractInsights`（记忆学习）+ `extractProphecies`（预言抽取）+ 首条消息的 `summarizeSessionTitle`——原来全走同一个 `getAiConfig()`，**上游 8 个槽位里 2–3 个被后台任务占着**。配 `AI_AUX_MODEL` 即把抽取切小模型；再配 `AI_AUX_BASE_URL` / `AI_AUX_API_KEY`（独立账号）则切到独立并发车道（默认 4 并发、5s 排队超时），主配额全留给用户可见生成。只换模型名不换账号时车道仍是 main——同账号配额本就共享，分两个计数器等于把限额悄悄放大一倍。**收口点是 `gateway.ts` 的 `rawText()`**：所有抽取（`extractInsights`/`extractProphecies`/`summarizeSessionTitle`/`extractGraphTriples`/`summarizePoints`/`llmJson`/`completeJson`/`structured*`）都经它落地，新增抽取路径自动继承；调用方显式指定 `model` 时（评测评委要独立模型避免自评）不被覆盖。rawText 无论是否配置 `AI_AUX_MODEL` 都**强制关闭 Thinking 并把上限固定回 700**，避免记忆抽取/汇总继承主档预算而放大 output 成本；没有 sessionId 的辅助任务用 `sha1(system+user)` 生成稳定亲和键，使不同抽取可在池内分流、相同输入仍命中同端点缓存。**对话与成果生成永远走主配置，提示词不受影响**；`AI_AUX_MODEL` 留空时仅复用主模型/账号，不再继承主档 Thinking。
- `services/llmPool.ts`（2026-07-27）：**上游端点池——多路分流 + 故障转移，分布式安全**。此前后台只能让一个 `AiModel` 生效（`AiSetting.activeModelId`），该端点一被上游限流全站 AI 就停摆。现在 `AiSetting.routingMode='pool'` 时，所有 `poolEnabled=true` 的 `AiModel` 组成池。**路由用加权 Rendezvous 哈希（HRW）+ 会话粘性，不是轮询**——理由是生产实测提示词缓存已只剩 12% 命中而系统提示词占单次输入约 95%，轮询会把同一会话打散到不同端点、把缓存彻底归零（上游缓存按账号/端点隔离）。HRW 的四个性质正好对上：① 无状态无需协调，各实例用同样输入独立算出同样结果 → 多实例天然一致；② key 取 sessionId → 同一会话恒定同端点，缓存保得住；③ 成员变化只重映射 1/N（端点冷却下线只迁走它承载的那部分）；④ 支持权重。**协议与配置边界**：池只会选与当前激活模型 `effectiveProvider` 一致的端点，后台保存路由、修改入池模型或切换激活模型时也会拒绝 Claude/OpenAI 混池；这是协议硬约束，不是模型名偏好。`AI_AUX_*` 显式辅助档始终 `poolBypass`，防止抽取任务被主池改回主模型/账号。池内每个 Claude 端点保留自己的原始 `thinkingMode/thinkingBudget/temperature`，只有 provider 最终组装实际思考请求时才把有效温度临时改为 `1`；连接测试与真实请求同口径。**实际命中留痕**：每次 provider 尝试会在当前异步调用上下文记录端点快照，`LlmTrace.model/endpointId/endpointLabel` 最终写成功命中的端点与模型；全链路失败则写最后一次实际尝试，不能再拿全局激活配置冒充真实路由。**分布式健康态**：429 冷却写 Redis（`llm:pool:cool:<id>`，TTL=冷却时长）跨实例可见——否则实例 A 撞 429 标冷却、实例 B 毫不知情继续打，上游滚动窗口惩罚会被持续续期；无 Redis 时退化进程内（单实例正确，多实例恢复慢但不崩）。达到尝试上限的最后一个/唯一一个端点失败也必须写入共享冷却，不能因已无下一跳就遗漏健康状态。**tier**：0=同质对等正常分流，1+=降级备份仅当低 tier 全冷却才启用（跨模型降级会改变回答质量，故默认全 tier 0，需显式配）。**转移判定**：429/5xx/超时转移并冷却；4xx、`AI_BUSY`、审核拦截、输出截断不转移（换端点也一样）。上限 `LLM_POOL_MAX_ATTEMPTS`（默认 3）。**明确不做**：跨实例精确并发计数——`maxConcurrency` 是**每实例**上限，全局精确信号量要 Redis INCR/DECR + 泄漏回收，复杂度和失败模式都高，而端点真实约束是上游配额、本来就只能撞了才知道，已由 429 整窗冷却兜住；多实例按实例数分摊配置即可。`routingMode` 默认 `single`，**不配就完全是旧行为**。**覆盖面**：openai 兼容协议的非流式 + claude 协议的全部 5 处调用点（含流式）已接入转移；claude 流式只在**尚未吐出任何 delta 前**才允许转移（已 yield 过内容再换端点会让前后文对不上）；openai 兼容的流式转移尚未做。注意 `claude.ts` 的 `getClient` 已从单槽缓存改为 Map——接池后相邻请求在不同 `(apiKey, baseUrl)` 间交替，单槽会每次重建 client 丢掉连接池。运营后台配置在「模型」页的「端点池」分区（入池开关、权重/备份层/每实例并发、实时冷却态）。
- `services/tokenQuota.ts`：月度 Token 额度的强一致预留/结算。rawJson 等固定估算路径沿用 `RESERVE_TOKENS=2000`；用户可见真实生成在 `sessions.ts` 调 `generationQuotaReserveTokens()`，按最大输入预算 128k、最大输出 8k、所有已校准模型中最高 `out/in` 权重和缓存写 1.25×计算悲观在途占额。mock/测试仍只预留 2k；自定义 OpenAI 智能体强制走动态上界。预留大于余额时只占满当前余额到 0，让其它并发被锁内门禁拦下，不能在模型尚未调用前由预留制造巨额负数；余额已耗尽但命中复盘/速诊保底时也只预留基础 2k，完成后再按真实用量追扣。真实结算始终按 `usage.billableTokens × billingRatio` 多退少补，最多允许最后一个真实请求单次透支。
- `services/redis.ts`：共享 Redis 客户端（可选依赖，懒加载）。从 `cache.ts` 抽出独立成模块，因为缓存、全站限流的跨实例 store、后续的 LLM 队列/调度选主需要**同一个连接**。未配 `REDIS_URL` 或 ioredis 不可用 → 返回 null，各调用方回退进程内实现，绝不因此让进程起不来。
- `services/context.ts`：`resolveUser`（严格鉴权）、`buildGenContext`（注入 档案/基准/记忆/本命色 + **军师档案 + 项目背景 + 显式引用 + 知识库混合召回 + 天势档案**）。
- `services/cardHtml.ts`（M4 PR-15 第一批）：B 级卡片渲染——每日战报（军令/对齐率/回填/段位/连续天数）、天时日历（命盘 12 月攻守+拐点+谶语）、天命速写（送你一卦：命格/大势/建议由命盘确定性生成；朋友生辰 `computeChart` 现算**不落库**）。铁律：卡上每个数字都来自服务端账本，读不到整块不显示；品牌一律军师参谋部（V6.0 原稿外置 CSS 未保留，样式按小程序设计体系重制）；卡片发布走自有域名 `{PUBLIC_BASE_URL}/api/r/:id`。`services/reportHtml.ts` 的普通报告模板已改为 V6.0 天势卡片风（暖纸底、深绿封面、白色章节卡、金印落款、军师参谋部品牌）；报告 `htmlUrl` 也固定返回自有域名 `/api/r/:id` 供小程序 web-view 打开，OSS 仅作为可选 `cdnUrl` 镜像，旧 OSS `htmlUrl` 会在再次请求时迁回自有域名；不要回退旧米色卷轴页脚或 OSS 直开入口。叙事线/谶语存 `StrategicProfile.extraJson`（PUT /profile/strategic 接受 narrative/verse，注入块带「跨月复述一致/全年沿用」口径）。剩余 9 卡 + A 级模板见 §13。
- `data/industryPacks.ts` 深度字段（M4 PR-19）：`decisionChain/ticketRange/benchmarkCases/mingLink` 可选，配了才拼进「行业视角」注入行；美业与大健康已拆分为两个包（新增行业包=建档选项自动 +1，app Picker 兜底问卷需手动同步）。
- `services/intent.ts`（M3 编排与适配，全部确定性规则）：`detectIntent`（V6.0 §3 入口识别：复盘六层触发词/紧急/择时/团队匹配/送你一卦/情绪→师父）→ `modeDirective` 模式指令；`Session.mode` 粘性存储（`resolveMode` 本轮检测优先、检测不出沿用；复盘意图在 sessions 路由自动落对应层 ReviewLog）；`detectInnerState`→`roleDirective` 五角色语气（教官/参谋长/大哥/战略家/师父）；`stageOf/stageDirective` 营收阶段自适应（问卷已改营收区间，旧标签兼容）；诊断轮次由历史用户消息数计算注入。注入位：模式/角色/轮次=【本轮导引】dynamic 首位，阶段=stable。**本命色语气注入已移除（PR-14，本命色回归纯 UI 品牌色）**，`{本命色}` 占位符路径保留。
- `services/wechatSubscribe.ts`：微信小程序订阅消息通道。`GET /wechat/subscribe/templates` 只返回已配置模板；前端 `wx.requestSubscribeMessage` 后 `POST /wechat/subscribe` 回写结果，`accept` 才给 `WechatSubscription.remaining +1`；发送成功后扣减一次额度并写 `WechatNotificationLog`。当前场景：`review`（复盘提醒，模板字段 `thing1/time2/thing3`）、`report`（报告生成完成，模板字段 `thing1/phrase2/time3/thing4`）和 `payment`（付款后到账提醒；支付确认点击手势内优先索权，拒绝/失败不阻断支付）。未配模板、无 openid、无额度、微信接口失败都不阻断主流程。
- `services/scheduler.ts`（M1 定时任务框架）：任务注册制 + 进程内周期扫描（生产单实例；`NODE_ENV=test` 不自启，测试直接 `runJob/scan*` 驱动）；任务彼此隔离（单任务崩不影响其它）。已挂：`casefile-idle-recall`（案卷 ≥48h 未推进 → 登记 `system.recall.candidate` 审计，按用户按天幂等）、`daily-review-reminder`（服务端本地时间 `REVIEW_REMINDER_HOUR` 后，活跃案卷且当天未复盘、当天未发过 review、仍有订阅额度 → 发微信复盘提醒）、`review-gap-reminder`（久不复盘登记候选并尝试发送）、`prophecy-due-scan`（预言到期登记候选 + 订阅消息推送——借 review 场景模板，同轮同用户至多一条，岁验预言〔basis 前缀 `年度谶语·岁验`〕用专属措辞；推送 best-effort，失败不阻断 `dueNotifiedAt` 锚点）。
- `services/strategicProfile.ts`（M1 统一状态层）：战略档案提取（`extractStrategicFacts` 按分节标题确定性规则，只取语义明确分节、不猜）/合并写入（只覆盖出现的字段）/注入块（`strategicBlock`）。叙事线与年度谶语存 `extraJson`，谶语同时盖 `verseYear` 与 `verseSource`。**谶语三个写入方 + 一条优先级（#16）**：① `ensureAnnualVerse`（`verseSource='auto'`，读档案 `GET /profile/strategic` 时当年无谶而有命盘 → 按 `mingpan.composeAnnualVerse` 由盘确定性出谶，零 LLM、同盘同年同句、命理开关关则不出）；② 认可方案（`/casefile/accept`、`battle/commit`）时 `extractStrategicFacts` 从「谶语/箴言」分节或封面 `cover.motto` 抽模型亲写的谶（`verseSource='llm'`，过**形状闸门**：七言或五言两句、两句等长、纯汉字——封面 motto 也可能是毛选语录/定场诗，收错就锁一整年，宁可漏收）；③ 老板手改 `PUT /profile/strategic`（`verseSource='manual'`）。守卫统一在 `upsertStrategicProfile`：跨年/从未有谶直接立谶；当年已有谶时**只允许 auto → llm → manual 单向升级一次**，同级/降级一律不采（同一句原样回传也不改来源，免得算法谶被镀成模型谶占掉升级额度），`manual` 任何时候都压得住自动路。报告封面没有箴言时仅读当年谶语补位，不回写成果（故不构成「兜底谶 → 被当成模型谶捕获」的回环）。**谶语周期陪伴（#16 升级）**：`extraJson` 另存 `verseAt`（获谶时刻）/`verseMoments[]`（点谶记录，年上限 12、同日同来源去重）/`verseHistory[]`（换谶归档，岁验对的是「去年那句」）；`maybeMarkVerseMoment` 在认可方案、`recordReview`、预言应验三处 fire-safe 点谶（LLM 严判「事件与谶中某半句真切相应」才落，短路条件全在调模型之前）；注入块带周期上下文（获谶月份/点谶次数/最近一次）+ 点谶行为指引 + 获谶满半年的半验提示；谶语盖章时幂等登记岁验预言（`ProphecyLog.basis='年度谶语·岁验·<谶年>'` 兼作幂等键，到期 = min(获谶+1年, 次年立春)，骑 `prophecy-due-scan` 推送）。逐轮 LLM 结构化抽取与 M2 决策日志共用抽取管道（§13 TODO）。
- `services/paipan.ts`（★ M1 排盘引擎 v1）：确定性命理/历法计算——干支历/八字/大运用 `lunar-typescript`，紫微命宫/身宫主星用 `iztro`；产出 四柱十神/月令取格（打法映射 `data/baziPlaybook.ts`，源自 V6.0 表）/日主强弱与喜用（v1 计分法，basis 写明依据）/大运时间线/年度逐月攻守；真太阳时 v1 平太阳时校正（经度）。**铁律：算→存（`NatalChart`，带 engineVersion）→拼指令（`chartBriefing` 注入【天势档案】+ 禁止 AI 自算），AI 只做比喻翻译**；「不信命理」注入 `TIANSHI_OPTOUT_LINE` 降级指令。回归口径：同输入同输出（`test/paipan.test.ts` 已知八字校验）。
- `services/understanding.ts`（★）：生成前台「军师档案」与模型上下文线索，按真实 `Profile/Memory/Project/Knowledge/Report/Session` 汇总经营身份、创业路径、当前难题、已沉淀资料和待补问题；禁止写入固定 mock 客户画像。
- `services/memory.ts`：Agent Memory 写入（**带向量**）/召回（**语义相关性排序**）/留存 TTL/反馈回流。
- `services/embedding.ts`（★）：文本向量化。默认本地**确定性嵌入**（零依赖、离线、`EMBED_DIM=256`）；配 `EMBEDDING_MODEL`+真实 openai 兼容 key 走真实 `/embeddings`。`cosine()` 维度不一致返回 0。
- `services/retrieval.ts`（★）：`hybridSearch`（向量+关键词混合、租户隔离、可按项目过滤）、`resolveReferences`（显式 @ 引用 → 带出处注入）。
- `services/knowledge.ts`（★）：`ingestKnowledge`（切片+逐片向量化）、`listKnowledge`、`deleteKnowledge`。
- `services/reports.ts`（★）：`saveReportVersion`（slug 归一 + 内容哈希去重 + 自动变更摘要；同租户同 slug 用 Postgres advisory lock 串行成版，避免并发版本号冲突）、`diffContents`/`getReportDiff`（section 级 diff）、`slugify`。
- `services/summarize.ts`（★）：`summarizeSession`（整段会话 → 纪要报告 + 沉淀知识；有真实模型走 `summarizePoints`）。
- `services/sms.ts`（★）：短信验证码发放/校验；发码限频在同手机号同场景事务锁内完成，校验用条件更新消费，确保并发下同一验证码只能成功一次。
- `services/credits.ts`（★）：钻石计量——`ensureCredits`（只读预检）/`reserveCredits`（已知费用产出前原子预扣）/`chargeCredits`/`refundCredits`/`grantCredits`/`getBalance`；同一用户的 `CreditLedger` 写入用 Postgres advisory lock 串行，避免并发双花或充值丢失。图片/按张类产出在 `sessions.ts` 同步与 SSE 路由中先预扣，异常自动退款；**`CreditReservation.refund` 自身幂等**（对齐 `tokenQuota.QuotaReservation` 的 `done` 标志）——同一次预扣重复调用只落一条正向流水、返回首次退款后的余额，因为路由里降级退款与 catch 兜底退款会叠在一起（守卫用例 `test/creditReservation.test.ts`）；退款失败不置位，后续路径仍可重试。`/agents/:key/purchase` 在同一事务内完成扣费与开通；套餐发放通过 `applyPlanPurchase` 同事务更新套餐、钻石流水与 token 钱包。企业版(creditsPerMonth<0)不限量不扣减。
- `services/entitlements.ts`（★）：智能体权益——`assertAgentAccess` 拦截未解锁 `unlock` 智能体（403 `AGENT_LOCKED`）、`agentCost` 统一 `free/unlock/metered` 的产出计费、`publicOwned` 给前台展示可用状态。
- `services/adminAuth.ts`（★）：运营后台鉴权——`/api/admin/*` 统一要求 `ADMIN_TOKEN`（`x-admin-token` 或 `Authorization: Bearer`）或 `role=admin` 用户；普通小程序用户访问返回 403，无凭证返回 401。
- `services/aiConfig.ts`（★）：大模型配置解析（DB > env），预设 `AI_PRESETS`（Agnes/DeepSeek/Qwen/Moonshot/OpenAI/Claude/mock）、`isReady`/`effectiveProvider`、脱敏 `publicConfig`。
- `services/agentVersions.ts`（★）：智能体草稿发布/回滚/版本列表；`publishDraft` 对同一 `agentKey` 加事务锁，保证并发发布只生成一个版本或串行递增。
- `services/vectorStore.ts`（★）：pgvector ANN 查询/向量列双写（`PGVECTOR_ENABLED` 开启时；默认关闭走内存余弦）。
- `services/audit.ts`（★）：统一审计记录与秒级 ISO 时间格式；Fastify `onResponse` 钩子会记录除 `/api/health` 外的所有 `/api/*` 行为，覆盖匿名、无效 token、登录、后台与用户请求，payload 写入方法/路径/状态码/耗时/IP/UA/鉴权状态/脱敏 body 摘要；登录、短信、后台账号等入口另写成功失败语义审计，关键业务动作继续写语义日志（建档、产出、存库、汇总、后台配置变更）。
- 内容审核 `moderation_log`、审计 `audit_log`（演示级，生产替换合规服务）。

### 8.4 海报成品图（`canvas_design` artifact 技能，2026-07-29）

「海报设计师」（agent `poster`）出的是文本方案；这个技能把方案变成**真图**（3:4 PNG，1080×1440）。完整设计见 `docs/CANVAS_DESIGN_SKILL_INTEGRATION_PLAN.md`，实现落在 `server/src/services/creative/*` + `routes/creative.ts` + admin`views/creative.tsx` + app `packages/work/poster|posterJob`。

- **第三类技能**：`SkillKind` 从 `tool | output` 扩到 `tool | output | artifact`。artifact 只进 `nativeSkillMeta()` 的元信息登记（后台技能库 kind 文案「成品交付」、agent 可勾选），**不建通用 ArtifactSkill 注册表**——只有一个成员时抽象是负债。
- **双表任务模型**：`CreativeJob`（一次出图动作 = 一行，状态机 `pending → running → succeeded|failed|cancelled`，progress `philosophy|visual|render|upload`）+ `CreativeAsset`（`source|visual|poster_png`，`jobId` 可空以支持「先传素材后建任务」，`userId` 是归属校验真源）。**状态真源是数据库行，不是进程内 Map**——这条是从两处教训来的：会话 generating 活在内存里重启即丢，知识库 `processDocument` 曾 fire-and-forget 把条目永久卡在 parsing。
- **计费：预扣即实扣 + job 行幂等退款**。10 钻/张（价格存后台配置，**不硬编码**）。建单事务内 `chargeCredits` + 写 `chargedAt`；退款唯一入口 `refundJob()` 用 `updateMany({ where: { chargedAt: {not:null}, refundedAt: null } })` 抢占，抢到才真退 → worker catch / sweep / 用户取消三条路径叠一起也只退一次。**刻意不用 `credits.reserveCredits` 的内存闭包**（跨不过 worker 进程边界）。三条不变式：① 不限量用户（余额 -1）`chargedAt` 恒为 null（`appendCreditDelta` 对不限量零流水，标了 chargedAt 一次退款就是凭空铸币 10 钻），`creditCost` 仍记名义价供成本统计；② revise 不扣钻（`creditCost=0`），regenerate 重新扣；③ **admin 重试不动 `chargedAt/refundedAt`**（清 `refundedAt` 想「让钱重新算消费」= 重试再失败又退一次，资损）。
- **worker**：`FOR UPDATE SKIP LOCKED` 抢占，2s 轮询，`setInterval+unref`，`NODE_ENV=test` 不自启（测试直接调 `tickCreativeWorker()`）。**不继承 scheduler 的单实例约束**（那是选主未做完的历史包袱，多进程抢占本身是安全的）。一轮最多串行处理 `TICK_BATCH_SIZE=2` 单（不是并发，见下文）。`sweepCreativeJobs`（挂 scheduler，5min）：running 超 `STALE_RUNNING_MS`（10 分钟）→ 回 pending 或 failed+退款，外加「已扣未退的终态任务」兜底重扫。
  - **「还能不能重试」只有一个实现 `canRetry(attempts)`**（`attempts < MAX_ATTEMPTS`，抢占时就 +1 所以入参含当次）。此前 worker 收口与 sweep 回收分别写 `<` 和 `<=`，于是 worker 判定重试用尽、落了终态失败的任务，在 sweep 眼里还能再入队一次；测试还用 `MAX_ATTEMPTS + 1` 把这个错误固化了。两处必须共用同一把尺子。
  - **终态写入一律带状态守卫**：成功路径也是 `updateMany({ where: { id, status: 'running' } })`，影响行数为 0 视为已被他人收口 → 记 warn 后放弃写入，**不抛错**（抛了会走退款路径，而钱早已正常结算）。原先只有失败路径有守卫，一旦发生双执行（如超时阈值错配那次）就会覆盖终态并产出两张资产。
- **AI 排版引擎（第 3 档，2026-07-29；`layoutEngine='ai'` 是默认值 = 部署即切换）**：模型**自己写整张海报的 HTML/CSS**，而不是往三套模板里填空。动因是真机那张图的画质问题（撞色 + 被画成占位卡片的"负空间" + 六维度哲学只被消费了 palette），而上游 `canvas-design` 根本不用图片模型——「哲学长文 → 用代码在画布上创作 → 强制二次打磨」。链路：`manifesto.ts`（LLM #1：中文宣言 4–6 段 + 色板 + 隐性主题）→ `canvasEngine.ts`（LLM #2：540×720 整页 HTML，纯 CSS/SVG 作画，**不调图片供应商**）→ `canvasSanitize.ts` 静态审计 → 占位符替换 + AI 标识兜底注入 → `renderer.renderCanvasPoster`（加固渲染）+ `canvasMeasure.ts` 量测 → **无条件打磨一轮** → 最多再修一轮。
  - **「首轮干净也无条件打磨一轮」是上游 skill 的核心机制，不是可选优化**（原文 FINAL STEP："The user ALREADY said it isn't perfect… take a second pass."）。守卫用例断言 **LLM 被调 2 次而不是 1 次**——想省这一轮 token 的"优化"会立刻让测试红。另一半同样重要：**打磨轮不许让画面变差**，首轮干净而打磨轮量出违规就退回首轮那张（`resultJson.polishReverted`）。
  - **轮次与预算**：HTML 相关 LLM 调用 ≤3 次（`MAX_HTML_CALLS`，加宣言整单 ≤4），整段 ≤180s（`AI_ENGINE_BUDGET_MS`；仍小于 `STALE_RUNNING_MS`，别把它调过 10 分钟）。每轮都要跑一次真实渲染，成本与时延都在这里。
  - **回落矩阵（付费任务永不因 AI 引擎失败）**：模型不可用（mock/无 key）/ 宣言不完整或未过审 / 三轮仍违规 / 渲染异常 / **量测拿不到结果**（= 无法验证，不当成干净）/ 超预算 → 一律回落，且**复用同一个 `runTemplatePipeline`**，不复制一份——图片供应商调用、`degraded/visualError` 留痕、竖向弹性契约、溢出闸这些教训全长在那条路径上。回落原因写进 `resultJson.aiEngineError` 并在任务台可见；指标 `junshi_creative_engine_total{engine=ai:Nrounds|template|template_fallback}`，**`template_fallback` 的斜率就是「AI 排版在生产悄悄失效」的告警信号**（同 `degraded` 那次的教训：不可观测的降级等于没降级）。
  - **LLM 写的 HTML 是不可信输入，与用户上传文件同级**。静态审计**只拒不洗**：清洗既改变模型的构图意图（删掉一块布局可能整版塌）又给绕过留缝（`<scr<script>ipt>`），而拒绝可回喂、清洗不可观测。白名单口径：`<head>` 只放行 `meta charset/viewport + title + style`；图片只放行 `{{PORTRAIT_URL}}/{{LOGO_URL}}/{{QR_URL}}` 与 `data:image`；`script`/`on*`/`iframe`/`object`/`embed`/`link`/`base`/其它 `meta`/`@import`/`javascript:`/外链 `url()` 一律整份打回。渲染层再加两道（`renderHtmlToPng` 的 **opt-in** 参数，报告 PDF 与模板海报行为一字不变）：`javaScriptEnabled:false`（CDP 关页面脚本执行，**已在真实 Chromium 实测：内联脚本改不动 DOM，而 `page.evaluate` 照常工作**）+ `allowUrlPrefixes` 请求拦截（只放行 `data:`/`about:`/`blob:` 与 OSS 签名域）。
  - **量测器违规码**（`canvasMeasure.posterScanFn`，页内纯 DOM 扫描）：`html_rejected` / `overflow` / `out_of_bounds` / `margin`(<12px) / `min_font`(<10px) / `text_overlap`(交叠 ≥ 较小块 25%) / `headline_missing` / `aimark_missing` / `qr_quiet_zone`(缺 `data-role="qr"` / <64px / 静区 <4px / 底色非白) / `placeholder_residue`。**每条必须带 selector + 实测数值**并逐条回喂——模糊的「有问题请改进」喂回去等于没喂。两个刻意设计：未提供素材的占位符**不清理**（留成违规回喂，否则模型永远不知道引用错了）；AI 标识缺失**直接注入固定 overlay**而不回喂（合规是服务端义务，不能取决于模型这轮听不听话；注入元素带 `data-poster-exempt` 豁免边距检查）。
  - **`posterScanFn` 必须自包含**（会被 `Function.prototype.toString` 序列化后在页面里执行，引用任何模块作用域标识符都会变成浏览器里的 `ReferenceError`，而那个错误只表现为「整单回落模板」，极难查）。相关坑：`npm test` 走 tsx/esbuild（默认 `--keep-names`）会往函数体塞 `__name(fn,"name")` helper，`tsc` 产物没有 → 「测试炸/生产好用」。现在渲染前用**字符串表达式**注入恒等 `__name` shim（用箭头函数注入会被同一个转译器改写，等于用坏的工具修坏的工具）。
  - **`gateway.completeText(system, user, {maxChars,maxTokens,temperature,model})`**：raw 文本原语（HTML 不塞 JSON string——长文本里一个坏转义就报废整份产物，而 HTML 自带 `<!DOCTYPE` 与标签闭合可直接结构校验）。无 live provider / 异常 → `null`，与 `structured`/`completeJson` 同口径，绝不伪造。`maxTokens` 默认 4000 且 `allowAux:false`：`openaiRaw/claudeRaw` 的 700 是辅助抽取预算（会把一页 HTML 拦腰截断），画质任务也不该被切到小模型。
  - **进度值仍是既有四段**（`philosophy|visual|render|upload`）：AI 引擎的创作+打磨+渲染整体记作 `render`。刻意不加 `compose`——小程序进度条按这四个值写死（`app/src/services/creative.ts`），新值会让它退回第一档文案。等前端跟上再拆。
  - **模板/回落路径顺带止血**：`philosophy.composeVisualPrompt()` 把色板主色（转中文色彩词）与负向约束（禁文字/禁 UI 卡片占位框/禁 logo/禁边框）拼进图片模型提示词——原先只发一句 ≤80 字的 `visualPrompt`，色彩全由图片模型自选，那正是撞色与"三个空粉色卡片"的来源。
  - **契约**：`AdminCreativeConfig.layoutEngine`（`'ai'|'template'`，缺省 `'ai'`，白名单外的值一律按默认处理）；`AdminCreativeJobItem.layoutEngine`（读 `resultJson.engine`，老任务 `null`）/`rounds`/`aiEngineError`。⚠️ 别把它和 `AdminCreativeJobItem.engine` 混——那是 `CreativeJob.engine` 列（任务模型实现引擎，恒 `'native'`）。
- **渲染**：`services/creative/renderer.ts` 调 `reportPdf.renderHtmlToPng`，**复用同一个 puppeteer 单例 + 单并发队列 + 超时骨架**（绝不另起浏览器，一份 Chromium 就几百 MB）。模板自包含 HTML（无外链/无脚本/字体只用系统栈），渲染前跑确定性自检 + **溢出闸**（文档高于画布即整单失败退款，不把裁掉半个字的图发给用户）。test 模式返回 1×1 桩 PNG 但仍上报名义尺寸。
- **brief 必须原样往返**（2026-07-29 修，别再回退）：`GET /creative/posters/brief-draft` 下发的字段里，`brandKitVersion` / `negativePrompt` 是**服务端行为的开关**而不是展示用文案——前者决定是否走 `approvedBrandKit()` 注入品牌语气与色板，后者进提示词负向约束。确认页与换风格面板 submit 时是**重新拼一个 brief 对象**，漏带就等于把整条 BrandKit 链路变成死代码（提示词品牌块、`THEME_HINT_COLORS` 色板表、语气合并全部走不到），而且服务端单测各自都是绿的、什么都不会报。水化本地草稿时也要一起存进 state。这类缺陷只有「带 approved BrandKit 建单 → 断言 `promptSnapshot` 里有品牌痕迹」这样的端到端断言抓得住。
- **模板白名单**：MVP 三套 3:4（`person_hero` / `editorial` / `business_launch`）。poster 提示词让模型在成果里给出「成品图版式推荐：xxx（key）—— 理由」，服务端**只认白名单**。**「未指定」与「指定了被停用的」是两件不同的事**：未指定按 scene 回退默认（`SCENE_DEFAULT_TEMPLATE`）；**显式请求了被运营停用的模板 → 422**，不静默换一套版式照常扣 10 钻——用户为自己挑的那套付了钱，给别的就是货不对板，且运营停用某套模板通常正是因为它出问题了。启用中的清单由 `GET /creative/status` 下发（`TEMPLATE_CATALOG` 是名称/描述的唯一真源，前端不建本地目录——三份各自维护到 P4 上线时 app 与 admin 的描述已经对不上），**全部停用 = 无法建单**（不是回退，是 422）。文案长度超限 **422 不截断**；`ratio` 契约已收窄为 `'3:4'` 单值（9:16/1:1 是「能力未就绪」而不是「可以兜底」，二期放开时再往联合类型里加，让编译器去找该改的地方）。
- **功能开关只有一层**：后台「创作任务」页那个开关 = `FeatureFlag` 行 `creative-poster` 的 `enabled`，**唯一真源，行缺失视为关**（`isFeatureEnabled(CREATIVE_FLAG_ID, false)` —— 注意该函数的默认值参数缺省是 `true`，这里必须**显式传 false**，把它删了就是无声放量）。曾经在它之上还有一层 env `CANVAS_DESIGN_ENABLED` 取合取，2026-07-29 删掉：合取让「后台开了却不生效」变成静默失败，而它想承担的熔断职责比后台点一下慢一个数量级（SSH + 改 env + 重启）。**本功能现在一个环境变量都没有**（`_ENGINE` / `_MAX_CONCURRENCY` / `_TIMEOUT_MS` 同批删，理由见下条与 `server/src/env.ts` 同名段落）。配置持久化复用 `FeatureFlag` 单行的 `enabled + payload`（价格/日限额/渲染超时/模板启停/图片供应商接入点），供应商 `apiKey` 经 `secretBox` 加密、对外只回 `hasKey`。**图片供应商不硬编码**：未配置时任务走「无主视觉」纯排版路径（不报错，纯排版本身是完整可交付产物）。
  - **写 payload 时必须显式落 `enabled`**（`updateCreativeConfig` 已这么做，别"优化"掉）：`FeatureFlag.enabled` 在 prisma 里是 `@default(true)`，而写 payload 走 upsert。生产库本来没有 `creative-poster` 这一行，运营第一次进后台**只改了个单价**并保存，行被创建时 `enabled` 就取默认 `true` → 一次改价操作把还没验收的功能放量了。现在 patch 不带 `enabled` 时回落到读到的 `cur.enabled`（行缺失 = false）。
  - `dailyLimit = 0` 是**不限量**，不是禁止创建（0=不限是常见约定，且真要停量该用上面那个开关，而不是把限额改成 0 等着用户撞墙）。
  - `timeoutMs` 是**渲染超时**（只传给 `renderPoster`，不是端到端），上限 `MAX_TIMEOUT_MS = 480_000`。**这是个不变式**：它必须小于 worker 的 `STALE_RUNNING_MS`（10 分钟，sweep 判卡死的阈值），否则一次正常的长渲染会在还没结束时被 sweep 抢回队列 → 同一单跑两遍、产出两张资产。改这两个数任何一个都要回头看另一个。
  - 删掉的三个 env 各有各的死法，别再加回来：**ENGINE** 全仓没有一处 `engine ===` 分支、`anthropic_skill` 也没实现，改它只改变 DB 里那个标签的字面值——一个会撒谎的旋钮；**MAX_CONCURRENCY / TIMEOUT_MS** 只作 payload 缺省，而后台保存是全量重写 payload，运营点过一次保存后改 env 重启就永久无效果（双真源）；**`maxConcurrency` 这个配置项本身也删了**——worker 一轮是串行 `await`，渲染又被 `reportPdf` 的单并发队列串起来，「worker 并发槽 1–8」是个假承诺，现为内部常量 `TICK_BATCH_SIZE = 2`（含义是「一轮最多连处理几单」，不是并发）。
- **供应商降级留痕**：`resultJson.degraded` + `visualError`（对外可读文案，不含内部细节），`AdminCreativeJobItem.degraded` 让任务台显示「无主视觉」标签，metrics 的 provider 标签取**本轮实际结果**（`reused` / 供应商名 / `degraded`）。原先 `provider` 是建单时快照的 `'configured'`、降级只 `console.warn`，供应商挂一整天任务台照样全绿，而用户拿到的全是纯排版版本。老任务无该字段按 false。
- **图片审核**：`services/creative/imageModeration.ts` **只有 `none` 一种实现**（放行 + 落一条 skipped 审计，让「没审」这件事在 `audit_log` 里可查，而不是零痕迹放过）。同批删掉了 `HttpModerator` 半成品与 `imageModerationProvider` 配置项：那个实现直读三个**全仓只在该文件出现、既不在 `env.ts` 也不在 `.env.example`** 的 `process.env`，且 `provider='http'` 但缺 URL 时 return `NoneModerator` —— 后台显示「已开审核」、实际全部放行、连一条 error 审计都没有，比明确的「未接入」危险得多。保留 `ImageModerator` 接口 + `NoneModerator` 作二期接入缝（那时只需加一个 class + 一个 resolve 分支）。**这仍是合规缺口，见 §13。** 文案走既有 `moderate('input'|'output')`。
- **部署要求**（三条，缺一不可）：① `cd server && npm run db:push`（建 `creative_job` / `creative_asset`，本仓无 migrations 目录）；② 中文字体——`deploy/Dockerfile.server` 已装 `fonts-noto-cjk`，**裸机部署需自行装**（当前生产 ECS 是 Alibaba Cloud Linux 4、已自带 `google-noto-cjk`、**没有 apt**，细节与 family 名的坑见 `docs/DEPLOYMENT.md` §5.1）；③ `npm run db:upgrade-poster-prompt -- --apply` 幂等把版式推荐段落追加进库内 poster 提示词（同时改 `Agent.systemPrompt` 与已发布的 `AgentVersion`，否则 C 端不生效；默认 dry-run）。**放量与回滚都不再需要动部署**：后台开关一开即放量、一关即熔断（约 1 分钟内生效，已入队任务留在库里，重新打开后 worker 继续跑）。
- **测试基线**：`server/test/creative.test.ts`（37 例：门禁/校验/幂等/计费/status 与模板下发/brief 草稿/BrandKit 命中/admin 配置与任务台/纯函数）+ `server/test/creativeWorker.test.ts`（21 例：生命周期/退款不变量/sweep/终态守卫/主视觉复用/降级留痕）+ `server/test/creativeCanvas.test.ts`（45 例：静态审计/占位符与 AI 标识/refine 闭环状态机/宣言与提示词/**量测器（真实 Chromium，默认 skip）**/worker 回落矩阵与 `layoutEngine` 契约）。闭环用例一律**注入 stub 的 `completeText` 与 render**（那条闭环的价值在「几轮、喂什么、什么时候放弃」，是纯编排逻辑，不该被外部服务可用性绑定）；量测器那 5 例必须真渲染，用 `PUPPETEER_REAL=1 npm test` 跑（`renderHtmlToPng` 的 `allowInTestMode` 是**唯一**解除 test 桩的后门，生产代码不许传）。brief 固定输入在 `server/test/fixtures/posterBriefs.ts`（酒店 OTA 获客场景 = 那张差图的原始输入，用于引擎变更前后可比）。`.env.test` 里那行 `CANVAS_DESIGN_ENABLED=true` 已随 env 一起删。**开关现在只能从库里改**：用例里改完必须 `__clearFeatureCache()`（featureFlag 有 60s 读缓存，而 `cleanBusiness()` 只删库不清缓存）——这条坑没变，只是原因从「env 单例冻结」换成了「读缓存」。

---

## 9. 运营后台（admin）

### 9.0 信息架构与外壳（2026-07-28 运营视角改版）

改版动机是「22 个目的地平铺在一条 56px 宽横滚底栏里、桌面端整屏当手机用、请求失败伪装成没数据」。现在的结构：

- **`admin/src/nav.ts` 是导航 SSOT**：22 个 section 按**「只读的归观测、可写的归配置」**归入 7 个运营场景组——`today 今日`（概览）、`people 用户`、`revenue 经营`（订单/漏斗/钻石消耗/Token 成本）、`studio 智能体`（顾问/技能库/知识库/检索调试）、`observe 观测`（调用诊断/内容审核/审计日志）、`catalog 商品`（套餐/单次付费/生态工具）、`settings 配置`（模型配置/功能开关/行业基准/献策/问卷/运营账户）。label、hint、icon、`ownerOnly`、命令面板别名都在这里，页面不再各写一份标题。**分组时看页面的主导动词，别看次要属性**——初版把「模型配置」放进「稳定性」（理由是端点池冷却算健康信号），但该页主体是写操作，一个写屏混在三个只读观测屏里正是运营找不到东西的根因；同期「配置」组堆到 8 项混装商品/开关/内容/权限，也一并按此原则拆开。新增分区要么进现有组，要么拆组，**单组不超过 8 项**。
- **外壳 `admin/src/App.tsx` 只做**：鉴权、分组导航（桌面左栏 204px / 移动底栏按组 flex 均分，组数有界=永不横滚；组名保持 2-3 字）、分区 segmented、hash 路由、详情面板挂载、命令面板、toast、改密弹层。业务视图全在 `admin/src/views/{overview,users,revenue,studio,observe,catalog,settings,model}.tsx`（原 2841 行 App.tsx 已拆分，文件名对齐组名；`model.tsx` 因页面体量单独成文件，逻辑上属 `settings` 组），共享格式化在 `format.tsx`，共享组件在 `components.tsx`。
- **`admin/src/router.ts`（极简 hash 路由，零依赖）**：`#/<section>[/<id>][?params]`。刷新 / 浏览器返回 / 把链接甩给同事都能回到同一现场（含打开着的用户详情，如 `#/users/<userId>`）；非法或越权 hash 兜回 `#/home` 而不是白屏。旧版当前 tab 与详情态只在 React state 里，F5 就丢现场。
- **命令面板 ⌘K / Ctrl+K（`CommandPalette.tsx`）**：按名称/别名跳任意一屏，或按姓名/手机号直接定位用户（纯数字输入优先匹配用户）。新增目的地必须能在这里被搜到。
- **`admin/src/useResource.ts` + `components.tsx` 的 `ViewState`**：统一 loading（骨架屏）/ error（带服务端原文 + 重试）/ empty 三态，并在 `PageHead` 显示数据新鲜度。替掉旧版散落 32 处的 `.catch(() => {})`——接口 500 时页面渲染成「近 30 天暂无订单」，运营会把它当业务结论上报。
- **`admin/src/api.ts` 的 401 / 403 分流（2026-07-29 修，回归用例 `admin/src/api.auth.test.ts`）**：**401 才是掉线**——清 token + 广播 `admin:unauth` 切回登录页；**403 是权限不足**——保留登录态，抛 `{ code, status: 403 }` 由页面就地提示（服务端原文优先，缺文案时按 `OWNER_ONLY` / `ADMIN_AGENT_FORBIDDEN` / `ADMIN_FORBIDDEN` 兜底人话）。`useResource` 把 403 记进 `Resource.forbidden`，`ErrorState forbidden` 换成「没有查看这块内容的权限 · 找 owner 授权」并撤掉重试按钮（再点还是 403）。**新增 requireSuper 交互时的两条要求**：① 入口按 `isSuper` 收起并写明只读（别摆注定失败的按钮）；② 写操作的 `catch` 必须透出 `e.message`，禁止盖成固定文案——`catch { toast('保存失败') }` 会把「需要 owner 权限」说成故障，让运营去查网络或反复改参数。旧写法是 `401 || 403` 一起踢登出，等于把权限问题伪装成掉线，且重新登录必然重现。
- **今日「待处理」队列**：卡单（已支付未发放=资损单）、近 24h 调用失败、端点冷却、审核拦截、额度耗尽五格，全部复用既有接口（`payments.stuck` / `traces` / `aiRouting` / `moderationLogs` / `users`），点进去就是筛好的清单；各格独立取数，一个接口挂了只该格显示「—」。全零才折叠成一行「无待处理」。
- **资金/破坏性动作统一 `ConfirmDialog`**：回显「对谁/多少钱/哪一单」，退款与关闭合规开关要求手打确认词，退款原因在弹层内收集并入审计。旧版退款原因是 `window.prompt` 收的、回车即执行、不显示金额。
- **跨屏直达**：订单 →「查用户」（订单契约只有 `userName`，故按姓名带进用户搜索 `#/users?q=…`；补 `userId` 需改后端契约，留作后续）、审核拦截 →「查看用户」、Token Top 用户 → 用户详情。
- **智能体上架与用户端目录一致性**：新增/详情都必须明确 `Agent.type` 对应的「用户端入口」；`advisory/custom` 动态进入小程序「对话 → 专业参谋」，`creative` 动态进入「执行 → 内容出品」，两页显示时重拉 `/agents`。后台 `enabled=true` 即进入对应目录，不得在 app 再维护一份 key 白名单。
- **技能/知识可钻取且知识按用户辨识**：技能库内置项可点开查看中文名、执行类型、说明与只读参数 Schema；知识库每行必须带 `userId/姓名/手机号/租户`，支持按用户筛选并点开正文与切片。`/admin/users/:id/knowledge/:kid` 的详情/删除/重嵌必须同时校验 `KnowledgeItem.userId=:id`，不能只按同租户放行。
- **观测信息人话化与审计降噪**：调用诊断用 `LlmTrace.userId/tenantId/sessionId/agentKey` 回填来源用户、手机号、租户与智能体中文名；`model/endpointId/endpointLabel` 保存实际命中的模型及端点快照，端点改名或退出池后历史记录仍可辨认。界面主信息显示「对话回复/方案生成」等业务标签与实际端点，`general/deliverable/ip` 原始 key 只留排障标识。`/api/metrics` 是 Prometheus 机器抓取，不写 `AuditLog`；修复前历史抓取默认过滤，只有显式 `includeMetrics=true`/「含监控抓取」才展示，避免淹没用户行为。

页面/接口：概览看板、**注册用户管理**（小程序注册用户、微信绑定、租户/套餐、最后会话、会话/成果数、算力余额，并可点进用户详情为其开通/取消 `unlock` 智能体）、**算力消耗**（按用户汇总赠送/消耗/余额、30 天活跃、成果数）、**审计日志**（最近 100 条，时间精确到秒；默认过滤 `admin.*` 后台自身行为，以单行列表展示用户 API、登录尝试、业务动作、用户/租户、摘要、方法/路径/状态码、IP/UA；窄屏切换为紧凑事件流，避免手机横向滚动；每条可点击打开详情面板，查看完整账号上下文、请求状态、IP/UA 与原始 payload；需要后台日志时传 `includeAdmin=true`）、每日献策库（增删改启停）、智能体/功能配置（新增智能体、基础信息、`free/unlock/metered` 定价、System 提示词 + Agent Memory 策略 + **上架/下架**，前台 `/agents` 默认只展示已上架功能）、**技能库**（新增/编辑自定义 HTTP 工具，复用后台统一的 `add-btn full`、`crd new-agent`、`ai-field`、`ai-btn`、`mini-btn` 组件语汇，避免局部 inline button 样式）、**模型配置（默认 Agnes，可一键切 DeepSeek/Qwen…，含测试连接，即时生效）**、建档问卷、套餐编辑。所有 `/api/admin/*` 路由由 `services/adminAuth.ts` 保护：运营端登录页填写后端 `ADMIN_TOKEN`，请求以 `x-admin-token` 发送；后端也支持 `role=admin` 用户。新增/扩展 admin API：`GET /admin/users/:id`、`POST /admin/users/:id/agents`、`DELETE /admin/users/:id/agents/:key`、`POST /admin/agents`、`PATCH /admin/plans/:id`，并保留 `GET /admin/users`、`GET /admin/usage`、`GET /admin/audit-logs`。入口 `admin/src/App.tsx`（`UsersView/UserDetailPanel/UsageView/AuditView/ModelView/PlansView`）+ `AgentDetailPanel.tsx`，API `admin/src/api.ts`（类型来自 SSOT）。默认 System Prompt 位于 `server/src/data/agents.ts`，商业咨询类按麦肯锡式问题解决法（MECE、假设驱动、80/20、金字塔原则、So what/Now what、30 天行动清单）设置；上线同步用 `cd server && npm run admin:sync-content`，同步智能体基础信息、权益计费、提示词与记忆配置并追加缺失每日献策，不删除业务数据、不覆盖启停状态。Agent Memory 开关保存到 `Agent.memoryConfig` 并由后端真实读取：`longTerm=false` 时不召回/不写入长期记忆，`autoLearn=false` 或去掉 `conversation` 来源时不从对话学习，`intensity/retentionDays` 影响写入权重和过期时间，`deliverable_feedback` 控制成果反馈回流。LLM 调用详情的 `LlmTrace.contextJson` 持久化本轮回忆意图、近期/较早消息数量以及召回记忆的 id/score/source/时间（不存记忆正文），运营后台「调用诊断」可直接查看；部署这次结构加法时需先执行既有 `prisma db push` 流程。开发期 Vite 代理 `/api → localhost:4000`。本地后台使用全屏无边框容器，`admin/src/styles/admin.css` 需要保持视口安全收缩、横向隐藏和长文本断行，底部导航为横向滚动，避免新增模块或模型 URL/API Key/状态文案撑出屏幕。

模型“完全自主定义”按协议显示不同 baseUrl 指引：OpenAI 兼容地址通常带 `/v1`；Claude 官方直连可留空，第三方填写 Anthropic 网关根路径；只提供 `/v1/chat/completions` 的 Claude 模型网关仍应选择 `openai` provider。

---

## 10. 数据库（Prisma · `server/prisma/schema.prisma`）

租户 `Tenant` / 用户 `User`(phone 唯一；`wechatOpenId/wechatUnionId` 可选唯一绑定微信账号；`role=owner|member|admin`) / 档案 `Profile` / 智能体 `Agent`（`billing/price/gift/enabled` 定义权益与价格）/ 用户智能体权益 `UserAgent` / 会话 `Session` / 消息 `Message` / 成果 `Deliverable` / 记忆 `Memory` / 献策 `Saying` / 问卷 `SurveyQuestion` / 套餐 `Plan` / 算力流水 `CreditLedger` / 审计 `AuditLog` / 审核 `ModerationLog`。业务表均含 `tenantId` 行级隔离。

**新增模型（企业事务操作系统）**：
- `UserAgent`（用户已开通的智能体，`(userId,agentKey)` 唯一；`source=gift|purchase|admin_grant`，用于 `unlock` 权益校验和后台开通管理）。
- `Project`（项目主线，租户级，`(tenantId,slug)` 唯一）；`Session.projectId` / `Memory.projectId` / `Deliverable.projectId` 归属项目。
- `ReportDoc`（逻辑报告，`(tenantId,slug)` 唯一，`currentVersion`）+ `ReportVersion`（不可变快照，`contentHash` 去重，`changeSummary` 变更摘要，`(reportId,version)` 唯一）。`Deliverable.reportId` 桥接。
- `KnowledgeItem`（知识条目，可挂项目）+ `KnowledgeChunk`（切片 + `embedding`）。
- `Message.refsJson`（本条消息引用的 项目/报告/知识/记忆）。
- `AiSetting`（单例 id=`default`，大模型配置：provider/baseUrl/model/apiKey/embeddingModel/temperature/thinkingMode/thinkingBudget）；pgvector 开启时 `knowledge_chunk`/`memory` 另有 `embedding_vec vector(N)` 列（由 `prisma/pgvector.sql` 建，非 Prisma 管理）。
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
- `buildGenContext` 是上下文注入总入口：企业档案、本命色、军师档案、项目背景、显式引用、知识库召回、长期记忆都从这里进模型；回忆意图统一由 `services/recallIntent.ts` 判断，命中时扩大长期记忆召回并由 `routes/sessions.ts` 补同会话较早相关原文；新增客户事实来源必须先接入这里，不能只做前台展示。
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

小程序是独立于服务端的发布渠道，**不在 `deploy-prod.sh` 内**；后端用 `deploy-prod.sh` 单独上线，且必须向后兼容线上旧版小程序（新增字段/可选参数/新端点，不改既有响应契约）。发布前统一走**一体化正式发布命令**，它会强制 server 模式重建并校验构建身份，避免复用旧 dist 或误传 mock：
```bash
cd /Users/donis/dev/ai-pilot/app
npm run release:weapp -- --version <版本号> --desc "<本次变更说明>"
```
该命令依次执行 `build:weapp:server` → 校验 `dist/junshi-build-meta.json` 的 `mode=server`、生产 API 与上传版本完全一致 → 检查 DevTools 登录态 → CLI 上传；加 `--dry-run` 可只构建校验、不触达微信。产物在 `app/dist/`（`miniprogramRoot=dist/`）。**上传这一步由 agent 自己执行，不要甩给用户**。DevTools 需已打开且开启「设置 → 安全 → 服务端口」。底层等效命令如下，仅用于排障，正常发布不得直接调用：
1. **微信开发者工具 CLI（底层首选，无需上传密钥）**：复用已登录的 DevTools 会话，`--project` 指向 `app/`（含 `project.config.json`，**不是** `dist/`）：
   ```bash
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli upload \
     --project /Users/donis/dev/ai-pilot/app \
     -v <版本号> -d "<本次变更说明>"
   ```
   退出码 0 且打印 `✔ upload` + 体积表即成功，进入 mp 后台「版本管理 · 开发版」。**版本号每次递增，最近一次上传 `0.2.21`**（2026-07-25）；上传前后同步 `docs/WEAPP_RELEASES.md`。GUI 仅作为 CLI 不可用时的最后回退：上传前必须人工打开 `dist/junshi-build-meta.json` 核对 `mode=server`、API 与版本，且预览中不得出现红色 MOCK 标识。
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

**app / admin 纯函数单测（2026-07-21 起，`node --import tsx --test`，与 server 同一套工具链，无需额外起服务）**：
两端此前完全没有测试基座；例行 QA 发现「方案库详情」页 / 运营「调教沙盒」都对报告 V2 类型化 section
直接读 `sec.h/sec.b/sec.list` 而静默剥空内容后，才各自补上最小基座——只覆盖**不依赖 JSX/DOM 渲染的纯函数**
（如 `app/src/services/deliverableSection.ts`、`admin/src/ui.tsx` 的 `sandboxSection`），不是完整的组件/端到端测试。
```bash
cd app   && npm test   # node --import tsx --test src/**/*.test.ts
cd admin && npm test   # 同上
```
**CI：`.github/workflows/frontend-unit.yml`**（2026-07-27 起）用 `admin` / `app` 两个 matrix job 跑 `npm ci` + `npm test`。
此前 CI 只跑 server，这两条命令全靠人工执行，`admin` 的 `tsx` 漏装后测试基座整整停摆一段时间都没人发现。
两个坑写在这里，别再踩：
- **Node 必须 >= 22**：`src/**/*.test.ts` 不是被 shell 展开的（npm 用 `/bin/sh`，不支持 globstar，原样透传给 node），
  而是 `node --test` 自己 glob——该能力 Node 22 才有。CI 固定 node 24；照抄 `server-integration.yml` 的 node 20 会直接找不到用例。
- **`node --test` 匹配到 0 个文件时退出码仍是 0**（只打印 `tests 0`），测试基座整体失踪也会是一片绿。
  所以 CI 那步额外断言 `pass` 计数 > 0；移动/重命名测试文件后留意这个守卫。

两端 `tsconfig.json` 都 `exclude: ["src/**/*.test.ts"]`——测试文件不参与 `tsc -b`/`build:weapp` 的生产编译门
（两端都没有 `@types/node`，`node:test`/`node:assert` 类型解析不进生产类型检查范围）；新增纯函数时尽量一并补测试，
但不要为了凑测试覆盖率把需要真实 DOM/Taro 运行时的组件也塞进这套基座。

### 后端集成测试（★ 大变更必跑 · 详见 `docs/TESTING.md`）
- 入口：`server/src/app.ts` 的 `buildApp()` 工厂（`index.ts` 用它 listen，测试用 `app.inject` 免端口）。
- 跑法：备好测试库 → `DATABASE_URL=...junshi_test npm run db:push` → `AI_PROVIDER=mock npm test`。
- **隔离服务器压测**：使用 `loadtest/docker-compose.yml` 部署独立 API/PostgreSQL/网关，网关仅绑定
  `127.0.0.1:14080`，可通过 SSH 隧道从外部运行 `loadtest/k6-readonly.js`；在测试机本机运行 k6 时必须加入
  `junshi-loadtest_edge` 并访问 `http://gateway:8080`，不能从容器访问宿主 loopback。运行态固定
  `NODE_ENV=production`、HS256 JWT、Redis 限流与 `SCHEDULER_ENABLED=false`，同时使用 `AI_PROVIDER=mock`；API 仅接无公网出口的 Docker internal network；
  短信、微信、支付、OSS、embedding/rerank 与生产数据库均不接入。数据由
  `server/prisma/loadtestSeed.ts` 生成确定性假数据，禁止复制线上用户数据。操作与清理命令见
  `loadtest/README.md`。真实 LLM 仅允许使用独立的 `loadtest/k6-llm.js` 最小消耗探针：
  一个字符输入、`max_tokens=1`、固定请求数、逐档核算总 Token；0600 token 文件挂入 k6 时使用只读 root 容器，不放宽宿主文件权限；密钥只进临时 `0600`
  env 文件且测试后删除，不得接入业务生成接口或写入仓库。
- **LLM 零 Token 闸门补测（2026-07-28）**：默认 mock 不占槽位；仅隔离压测显式配置 `AI_MOCK_LATENCY_MS>0` 时，`providers/mock.ts` 才经同一 `llmGate` 持槽，配合 `k6-llm-queue.js` 实测 8/12/20/40 并发的排队与超时行为。`AI_MOCK_429_FIRST_N` 可确定性注入前 N 次 429，用于验证冷却及恢复，默认 0；这些变量禁止出现在生产环境。实测 40 个约 3 秒的同到请求全部成功，最大队列 28、最长等待 9.64 秒；这不是供应商并发配额，真实提供方仍须使用可撤销、日限额的独立 key 做最小探针。
- 全程 mock 模型（确定性、可复现），无需真实 key/pgvector。**现状 724 用例 / 114 套件（0 跳过）**；覆盖微信登录 openid 复登、运营后台鉴权、算力/套餐购买、智能体权益、军师档案访谈与用户主路径。最近一次本地 PostgreSQL 测试库实跑为 2026-07-27，724/724 全过（有 / 无 `server/.env` 两种条件下各跑一次，结果一致）。
- **★ 测试环境自足（hermetic env，2026-07-27 起）**：`npm test` 只吃 `.env.test` + 真实 shell 环境 + 用例内显式设置，**绝不吃开发机的 `server/.env`**——否则用例红绿取决于谁的机器（CI 没有 `.env` 故长期为绿）。三层机制：① `src/env.ts` 在 `NODE_ENV=test` 时整体跳过 dotenv；② `@prisma/client` 会在 import 与每次 `new PrismaClient()` 时**无条件**读 `server/.env`（路径烤进生成产物、与 cwd 无关，Prisma 5.22 无 opt-out），故 `test/hermeticEnv.mjs`（由 test 脚本 `--import` 预载）记下进程启动时的键集合并抹除后来被注入的键，`src/db.ts` 在构造语句下一行调该钩子；③ 守卫用例 `test/envHermetic.test.ts` 读 `.env` 的键做通用断言（不 pin 变量名），所以往 `.env` 里加新键不会再弄红测试。**推论**：用例要用的变量写进 `.env.test` 或在用例里显式 set/delete，别指望 `.env`。
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
> 每次上传前后必须同步 `docs/WEAPP_RELEASES.md`，上传命令里的版本号/描述要与该文件记录一致；不要把每次上传明细塞进 AGENTS.md。正式上传只走 `release:weapp`，不要裸调 DevTools CLI/GUI。
```bash
cd app
npm run release:weapp -- --version 0.2.22 --desc "本次变更说明"
```
注意：发布脚本会强制重建并校验 `junshi-build-meta.json`，拒绝 mock、非生产 API、旧产物及构建/上传版本号不一致；备用 `upload:weapp` 使用上传密钥时仍受 **IP 白名单**约束。连真实后端版本另需把 API 域名加入 request 合法域名（见 §12）。

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

> 服务器部署（裸机 Node+Nginx+PG / Docker）见 **`docs/DEPLOYMENT.md`** + `deploy/` 模板（含架构图、Nginx/systemd/compose、HTTPS、模型配置、安全 checklist）。监控大盘（Prometheus/Grafana/告警/看板）见 **`docs/MONITORING.md`** + `deploy/monitoring/`。
> 运营后台路径部署在 `/admin/`；Nginx 模板已将 `/admin` 301 到 `/admin/`，避免无尾斜杠时被 H5 fallback 当作移动端首页。

mock 可随时预览；**正式上传/审核**还需：
1. **真实 AppID**：已设为 `wx810ebe6dfef8e75f`（`app/project.config.json`）。
2. **微信登录密钥**：服务端配置 `WECHAT_MINI_APPID/WECHAT_MINI_SECRET`；AppSecret 不得进入前端包或仓库。
3. **后端公网 HTTPS + ICP 备案域名**，并加入小程序后台 request 合法域名；前端用 `TARO_APP_MODE=server TARO_APP_API` 指向它。
4. **生成式 AI 备案 / 算法备案 + 内容安全**（AI 类小程序审核硬性门槛）。
5. 真实模型：服务端设 `AI_PROVIDER` + 真实 key（国内合规建议走备案的国产模型，走 openai 兼容协议即可）。

---

## 13. 已知限制 / TODO

- **海报成品图 MVP 明确不做 / 后置项（2026-07-29，已拍板，不要当遗漏来"补齐"）**：
  - **PDF 交付是二期**：MVP 只出 PNG。印刷级 PDF 要处理出血/CMYK/字体嵌入/矢量文字，与当前「截图式渲染」不是同一条管线，不为一个未验证需求先建它。
  - **图片审核未接真实供应商（合规缺口，不是技术债）**：`services/creative/imageModeration.ts` **只有 `none` 一种实现** = 放行 + 审计记 `skipped`。用户上传的人像与供应商生成的主视觉**都没有机器审核**，真实放量前必须接一家图片内容安全服务：新增一个实现 `ImageModerator` 接口的 class + 一个 resolve 分支（接口与 `NoneModerator` 就是为此保留的），并把地址/密钥按 `visual` 那套走后台配置 + `secretBox`。⚠️ 2026-07-29 删掉的 `http` 半成品**不要照着抄回来**：它直读三个未注册的 `process.env`，缺 URL 就静默 return `NoneModerator`，于是「已开审核」状态下全部放行且无任何日志——真接入时必须做到「配置不全 = 显式失败」而不是静默放行。文案侧走既有 `moderate()`，不受影响。
  - **9:16 / 1:1 规格后置**：渲染器与三套模板都只按 3:4（540×720@2x）做过版式与溢出验证，`ratio` 传其它值一律 422。要开新比例得**每套模板各写一份布局**并重跑溢出闸，不能靠缩放同一份 HTML（字号/留白/行数比例全变，出来就是错版式）。
  - **模板视觉回归靠人工**：`auditPosterHtml` 只查结构性问题（AI 标识在位、无外链、无脚本）+ 渲染器的溢出闸，**没有像素级基线比对**。改模板 CSS 后仍需人工看图（方案 §18.3 的视觉回归未落）。
  - **历史海报的入口是产品级缺口（2026-07-29 记，待产品决策）**：服务端已把 `assets` / `creativeJobId` 回写到 `Deliverable` 并有测试覆盖，但「用户过一周想再拿一次那张图」该从哪进、要不要版本列表页、同一方案出过三版怎么排——这几个问题没有产品答案，所以不是一个补两行代码的活。要动就连着 IA 一起定，不要在成果卡上再堆一个孤立按钮。
- **订单→用户精确跳转待补契约（2026-07-28，运营后台改版留坑）**：`AdminPaymentItem` / `AdminPaymentStuckItem` 只有 `userName`，没有 `userId`，所以「订单 → 查用户」目前是按姓名带进用户搜索（`#/users?q=…`），同名用户需人工分辨。要做精确跳转须先在 `shared/contracts.d.ts` 给两个接口加 `userId`，再改 `server/src/routes/admin.ts` 的订单查询 select 与运营端跳转。本次改版只动 `admin/`，未动后端契约，故延后。
- **本地 seed 的删除顺序缺陷（2026-07-28 发现，未修）**：`server/prisma/seed.ts` 在 `prisma.user.deleteMany()` 之前没有清 `TokenWallet`，本地库已有用户数据时 seed 会因 `token_wallet_userId_fkey` 报 P2003 中断（空库首次 seed 不受影响）。本次只在本地手工 `TRUNCATE` 绕过，未改脚本，避免与他人并行改动冲突。修法：把 `tokenWallet.deleteMany()` 补进现有删除序列的 `user` 之前。
- **`.tag.warn` / `.tag.live` 仍是硬编码色值（2026-07-28）**：`admin/src/styles/admin.css` 末尾这两个状态徽标用的 `#FBE9D8/#C1791F/#DCEEE2/#1A8A5A` 不等于任何 `:root` token，`lint:ui` 因此放过。要彻底守住「颜色只走 token」需先在 `:root` 加 warn/live 两组底色 token 再替换；本次未动以免改变现有视觉。
- **OpenAI 兼容协议端点池后续（2026-07-27，当前生产未使用，按产品决定延后）**：`callChatStream` 尚未接端点池的建流前故障转移；非流式 `callChat` 目前在一次 `withEndpoint` 尝试链中复用同一个 `AbortSignal`，首端点超时后信号已终止，不能安全重试下一端点。OpenAI `/chat/completions` 默认关闭 Thinking 时已完全省略非标准字段，但任何要启用 `enabled/adaptive` 的 Claude 兼容扩展仍必须先对目标网关直测，不能只凭模型名推断支持。生产当前走 Claude/七牛链路，不阻塞本次上线；启用 OpenAI 兼容网关前应为每次端点尝试创建独立 deadline，并补齐流式首 delta 前转移测试。
- **产品观察（2026-07-20 例行 QA，未处理，待产品确认）**：`576be96` 把成果卡操作行从 `onSave/onExport/onShare/onPdf` 收敛为单一 `onShareMenu` 后，`app/src/packages/main/chat/index.tsx` 里原本跳转小程序内 `/packages/work/webview` 查看自有域名报告网页版的 `shareReport()` 函数已不再被任何地方调用（`grep` 确认），但函数本体和 webview 页面本身都还在，commit message 写「网页版 shareReport 函数与 webview 页保留不动」，读起来像是想保留这个入口，但收敛后的分享选单目前只剩图片/PDF/复制全文，没有一个选项能触达它。不确定是有意去掉「查看网页版」这个入口还是遗漏，未改动代码，留给产品侧确认后再决定是重新接回选单还是连同 webview 页一起清理。
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
- **小程序上传鉴权（2026-07-25 现状）**：本机 DevTools CLI 服务端口已开启且扫码登录恢复，`0.2.21` 已通过 DevTools CLI 上传成功；本机备用密钥 `/Users/donis/dev/aliyun/private.wx810ebe6dfef8e75f.key` 可被 `miniprogram-ci` 正常读取、编译和打包，但当前出口 IP `120.204.218.229` 未加入小程序后台上传密钥白名单，CI 直传仍会返回 `-10008 invalid ip`。后续优先复用 DevTools CLI 登录态，或在 mp 后台把当前出口 IP 加白后走 `npm run upload:weapp`；云端执行环境另有 `servicewechat.com Host not in allowlist` 的历史限制。
- 自有登录态支持 JWT（`services/userToken.ts`，HS256）：配 `APP_JWT_SECRET` 后登录签发 JWT、`resolveUser`/审计/admin role/entitlement 统一 `verifyUserToken` 校验；未配则回退历史 `token=userId`，`APP_JWT_REQUIRED=true` 可强制只认 JWT。短信强制校验开关（`SMS_REQUIRE_CODE`）已就绪，生产置 true 即可。
- `server/.env.example` 的 `OPENAI_API_KEY` 是 fake 占位，自动降级 mock；填真实 key 才走真模型。
- 输入审核与缓存已抽象可插拔：审核 `services/moderation.ts`（keyword 默认 / `MODERATION_PROVIDER=http` 接合规服务，当前只用于用户输入前置拦截）；缓存 `services/cache.ts`（内存默认 / 配 `REDIS_URL`+ioredis 切 Redis，客户端在 `services/redis.ts` 与限流共用）。计量台账仍为演示级，生产接真实计费台账。
- **压测后续待办（2026-07-26，A/B 级已落，以下是等复测或需运维前置的）**——完整计划见 `docs/[OPUS5]LOADTEST_OPT_PLAN_2026-07-26.md`，复测方案见 `docs/[OPUS5]LOADTEST_PLAN_V2_2026-07-26.md`：
  - **同机多进程（收益待实测）**：V2 已完成 T0/T1：同机 PostgreSQL 的单 API 进程在基础假数据下 450 RPS 连续 5 分钟 0 错误，600 RPS 触发过载闸；10 倍数据下 350 RPS 已超过 1% 错误，完整证据见 `docs/[OPUS5]LOADTEST_REPORT_V2_2026-07-27.md`。这仍不是独立 RDS 或多进程结论，不能据此直接横向扩容；当前仍是单进程（`deploy/junshi-api.service` 的 `node dist/index.js`）。
  - **scheduler 选主（多进程/多实例的硬前置，仍待）**：`services/scheduler.ts` 仍是每进程 `setInterval` 跑全量 job，直接加进程会重复推送微信订阅消息、重复发一次性额度。需 Redis 选主或拆独立 cron worker + `(userId,scene,date)` 幂等唯一约束。**这条不做完，不许加第二个进程。**
    2026-07-27 补了 `SCHEDULER_ENABLED`（默认 true，行为不变）作为**过渡手段**：可把所有 API 进程置 false、只留一个专职进程为 true，从而在选主落地前也能跑多进程；压测栈已置 false（切到 `production` 后定时任务会真跑，周期性全量扫库给容量测量掺背景负载）。**它不是选主**——靠人工保证「只有一个 true」，配错就退化成原问题，因此 T2/T3 拓扑仍以真正的选主为前提。
  - **Puppeteer 出 API 进程**：`services/reportPdf.ts` 仍是进程内单浏览器单例。本轮只读压测完全没碰它，所以 450 RPS 这个数字不含报告渲染；生产上并发出报告会和只读流量抢同一个进程的资源。**报告功能对外放量前必须完成。**
  - ~~**`/metrics`**~~ **已落（2026-07-27）**：`GET /api/metrics` 返回 Prometheus 文本（`routes/metrics.ts` + `services/metrics.ts`）——在途请求（全量与过载闸两套口径）、事件循环延迟分位数、RSS、LLM 各车道并发/队列深度/排队等待/429/冷却、端点池模式与逐端点冷却态，另有 18 个 `prisma_*`（含连接池 busy/idle/open、查询等待）来自 `schema.prisma` 新启用的 `previewFeatures = ["metrics"]`。**鉴权必须配 `METRICS_TOKEN`，未配整个端点 404**；不要改成内网 IP 白名单——本部署 Nginx 反代 + `trustProxy`，`req.ip` 来自可伪造的 `X-Forwarded-For`，真实 TCP 对端恒为 Nginx 的 `127.0.0.1`，IP 层区分不了公网与本机。指标名与优化计划 §7 告警线一一对应。**2026-07-28 扩容**：补 HTTP 路由级时延直方图（`junshi_http_request_duration_seconds{method,route}`，P95 告警不再依赖 k6）、LLM 调用/token/成本计数（与 llm_trace/token_usage 同口径，挂 `trace.ts`/`usage.ts` 单点）、产出降级/截断、业务事件（注册/审核/算力/禁写闸/支付全链 + 卡单 gauge）；标签基数有折叠保护。**采集与看板已自建落地**（替代原「接 SLS/ARMS」计划）：`deploy/monitoring/` 一套 compose（Prometheus/Grafana/Alertmanager/node_exporter/postgres_exporter/blackbox（+可选 Loki/Promtail），host 网络、UI 全绑 127.0.0.1、Grafana 经 Nginx /grafana/ 出公网），4 块预置看板由 `grafana/dashboards/build.mjs` 生成，告警阈值=优化计划 §7 原文；主文档 `docs/MONITORING.md`。**二期（2026-07-28）：告警配置化**——15 项阈值注册为运营后台「功能开关」页的数值项（`services/alertConfig.ts` 注册表，FeatureFlag payload 存储），经 `/api/metrics` 的 `junshi_alert_config{key}` 喂给告警规则的 `scalar()`，后台改完 ≤75s 生效不发版；飞书通知走 Alertmanager → `POST /api/alerts/webhook`（同 METRICS_TOKEN 门禁）→ 服务端按后台配置的群机器人 webhook 转发（`routes/alerts.ts`，URL 白名单限飞书域名 + secretBox 加密落库 + 掩码回显，签名校验支持；转发成败进 `junshi_alerts_forwarded_total`），不再需要 PrometheusAlert 桥。**仍待**：request-id 贯穿；API 挂掉时通知通道同亡，需外部拨测兜底（MONITORING.md §7）。
  - **PG 迁 RDS**：需运维前置。能拿到异地备份/PITR/高可用，并把约 0.5 核还给 API。⚠️ **更正「当前零备份」这个旧描述（2026-07-28 实测）**：生产已有 systemd `junshi-pgdump.timer` 每日 03:30 逻辑备份（`/var/backups/junshi/*.sql.gz`，2026-07-23 起，保留 14 天，约 12MB/份，抽验 6 份全部 `gunzip -t` 通过 + 63 张表齐全）。同日修掉其一个会**静默销毁备份历史**的缺陷并纳入版本管理（`deploy/junshi-pgdump.{sh,service,timer}` + `deploy/README-backup.md`）：原 `ExecStart` 一行流 `pg_dump | gzip > f && find -mtime +14 -delete` 的管道退出码取自 gzip，pg_dump 失败时仍返回 0 并产出空壳 gz（实测 20 字节、能过 `gunzip -t`），随后轮转照常删旧备份——连坏两周即自我清空且无报错。现改为 `set -Eeuo pipefail` + 写 `.partial` 经三项校验（gzip 完整性 / 体积下限 / `CREATE TABLE` 计数≥10）后原子改名 + **校验通过才轮转**。**仍缺三样**：① **无异地副本**（备份与库同盘，实例损毁即全失，这是最大缺口，需 OSS 或异地 rsync，机器未装 ossutil）；② 无 PITR，最坏丢 24h；③ **从未做过恢复演练**——没恢复过的备份不算备份，建议在测试机 47.98.162.120 灌入最新备份核对表数与标志性数据。另：备份失败无告警通道（`OnFailure=` 未挂），只进 journal。
  - ~~**mock provider 注入延迟（`AI_MOCK_LATENCY_MS`）**~~ **已落（2026-07-27）**：`AI_MOCK_LATENCY_MS` / `AI_MOCK_LATENCY_JITTER_MS` / `AI_MOCK_429_RATE`，默认全 0 行为不变。**注意一个原方案漏掉的前提**：mock 在 `gateway.ts` 里是被直接调用的、**根本不过 `llmGate` 并发闸**（只有真 provider 才 `withLlmSlot`），所以只注入延迟队列深度仍恒为 0，S5 照样测不出东西。现在开启后 mock 会占一个真实槽位（`providers/mock.ts` 的 `mockUpstream`），并发上限/排队/排队超时降级/429 整窗冷却全部可复现且零 Token 成本。只套在「mock 就是配置的 provider」的 5 个分支，真 provider 失败后的 6 个降级兜底不套。
  - ✅ **`npm run admin:sync-content` 的提示词覆盖风险已加护栏（2026-07-28）**。⚠️ **同时更正 2026-07-27 那条「漂移 2.85 倍」的结论——那是单位错误**：生产库 `server_encoding = SQL_ASCII`，此时 PG 的 `length()` 返回的是**字节数**而非字符数（`length()` 恒等于 `octet_length()`），当时拿它与仓库文件的**字符数**相比，把 9% 的差算成了 2.85 倍。**同口径实测**：`general` 生产 49,094 字节 / 19,486 UTF-8 字符，仓库 `prompts/strat.v6.md` 44,959 字节 / 17,232 字符，实际差 **+9.2%（按字节）/ +13.1%（按字符）**；其余 9 个 agent（strat/growth/intel/fund/model/org/brand/ops/promo）与仓库**逐字节完全一致，漂移 0.0%**。仍成立的是版本内自比：v1 41,710 → v2 45,342 → v3 44,957 → **v4 49,094** 字节，三周 +18%。**覆盖风险依然真实**（同步会把 `general` 回退约 2,250 字符的调教，且无 diff 无确认），只是量级远小于此前描述。**现改为**：`systemPrompt` / `greet` 归入 `OPERATOR_OWNED`——create 写初值、**update 默认跳过**（与本脚本 survey/sku 既有的「不动 enabled，保留运营启停」同一约定，这是主要保护）；`--force-prompts` 才允许覆盖，且仓库比线上短超过 20%（`SHRINK_REFUSE_RATIO`）时拒绝——注意按实测 13% 的真实差距**该护栏不会触发**，它是防粗粒度误配的兜底，不是本场景的主防线；另有 `--dry-run` 预演与 `--dump-prompts <目录>` 导出线上提示词供回灌。护栏由 `test/syncAdminContent.test.ts` 10 例锁定。**提示词真相源已定调（2026-07-28）：数据库 `agent.systemPrompt` 是唯一运行时事实来源，`server/prompts/*.md` 仅作新环境初始化种子，不做定期回灌对齐。** 此前 `prompts/README.md` 与 `agents.ts` 注释同时写着「线上库是运行时事实来源」和「提示词变更走 git 版本管理」，两句互相矛盾，正是同步脚本会静默覆盖调教的根源，现已统一为前者。实测也支持这个选择：9 个专业 agent 与仓库逐字节一致、从未被改过，只有 `general` 被持续微调（24 行，相似度 98.1%）。**通用教训：SQL_ASCII 库上做任何长度统计都必须显式区分字节与字符（`length()` = `octet_length()`）；`wc -m` 在非 UTF-8 locale 下同样退化成字节数。**
  - **提示词缓存 88% 未命中（最大的一笔可省成本，且不需要动提示词）**：生产 30 天 580 次 chat 里 509 次 `cachedInput=0`。**不是 TTL**（71.6% 的相邻对话在 5 分钟内；只看窗口内的 415 次，命中率仍只有 15.2%），**也不是我们代码**（`stable` 段无随时间变的值）。指向 `api.qnaigc.com/bypass/anthropic` 中转在多上游账号间轮询、而 Anthropic 缓存按账号隔离。按官方价（Opus 4.6 input $5/1M、缓存读 $0.5/1M）修好约省 **$46/月 = 总账单的 49%**，单次对话 $0.164 → $0.084。**前提**：需确认七牛是否透传缓存定价；若它按统一单价结算则省不到钱，只改善延迟。详见 `docs/[OPUS5]LOADTEST_OPT_PLAN_2026-07-26.md` §2.5。
  - ✅ **单价已按官方价刷入生产并核准（2026-07-28）**，同时更正此前「低估 5.2 倍 / `modelPrices.ts` 需校准」的两处错误结论。**① `data/modelPrices.ts` 里本来就没有价表**——它只有 `estimateCostMicros()` 折算函数，单价来自数据库 `AiModel.priceInput/priceOutput/priceCachedInput`（运营在后台填，见 `resolveModelRate`）。**② 历史缺口不是 5.2 倍而是约 9.5 倍，且成因不是缺陷**：按周拆开看，06-29 至 07-20 三周记账准确度只有约 3%，而 07-27 那周跳到 78%——`costMicros=0` 的行数为零，说明不是查不到单价，而是**单价大约在 07-27 才被配上**，配上之后记账就基本准了。**现已按 Anthropic Opus 4.6 官方列表价 × 汇率 7.2 刷库**（两个 claude 端点：`priceInput` 35→**36**、`priceOutput` 150→**180**、`priceCachedInput` 20→**3.6**；原值 35/150/20 中 input 已准、output 低 17%、缓存读高 5.6 倍）。`rateCache` 是短缓存，无需重启。**核准后的真实口径（近 30 天）**：合计 **¥745.57 = $103.55**；按 kind 拆 —— `chat` 623 次均输入 28,417 / 输出 829 token、缓存命中率 10.6%、**$0.1493/次**；`deliverable` 60 次 $0.1488/次；`aux` 500 次仅 **$0.0032/次、合计 $1.60（占总成本 1.5%）**，再次印证「拆辅助抽取省 token」当初被高估。缓存全命中的理论下限 **$0.0349/次**，扣掉不可缓存的动态段后现实目标约 $0.073（**约省 51%**，与此前 49% 的估算吻合）。✅ **缓存写计价缺陷已修（2026-07-28）**：此前 `ModelRate` 只有 `in/out/cachedIn`、没有缓存写档，而 `claude.ts` 的 `usageOf` 把 `cache_creation_input_tokens` 并进 `inputTokens` 且不单独记，于是缓存写按 **1.0× 基础价**计而非 Anthropic 的 **1.25×**（5m TTL；1h TTL 为 2×）——每次写少算 25%，且用量不落库、事后无法量化。**现改为输入 token 拆三档各自计价**：命中缓存 `cachedIn`（约 0.1×）/ 写入缓存 `cacheWrite`（缺省 `in × CACHE_WRITE_MULTIPLIER = 1.25`，可由运营显式填以支持 1h TTL 的 2×）/ 其余 `in`（1×）；`Usage` 新增 `cacheWrite`，`usageOf` 独立上报，`TokenUsage`/`LlmTrace` 各加一列 `cacheWrite Int @default(0)`（纯加法）并由 `recordTokenUsage`/`recordLlmTrace` 落库，此后可按 SQL 量化。**向后兼容**：provider 不报 `cacheWrite` 时（openai/dify/mock 与全部历史记录）第二档为 0，折算结果与旧的两档拆法逐位相同——由 `test/modelPrices.test.ts` **12 例**锁定，含三档混合、显式覆盖 1h TTL 单价、读+写超过总输入时不产生负数、未配单价仍计 0。注意 `CACHE_WRITE_MULTIPLIER` 的前提是**上游透传缓存计价**；若七牛按统一单价结算，该常量应设为 1，否则会高估成本。历史缓存写用量因未曾记录，**无法回溯补算**。⚠️ 汇率与加价率口径：我们付的是七牛而非 Anthropic，当前刷的是**官方列表价**（作为权威参照与下限）；拿到七牛价目表后应替换，并据此反推加价率。
  - **提示词模块化标记（省 input，待产品确认 + 评测基线）**：`llm/promptAssembly.ts` 的 `===MODULE deliverable===` / `===MODULE keyword:...===` 机制已实现并上线，但生产提示词**一个标记都没有**，49,094 字符底座每轮全发（占单次输入约 95%）。给哪几章加标记 = 决定哪些人格/方法论在闲聊轮次里对模型不可见，**产品侧已明确要求对话效果不能受影响**，故必须先定切分方案再用评测验证。**注意顺序**：要改必须在线上那份 49,094 字符版本上改，不能在仓库那份 17,230 字符的旧文件上改。另：`general` 现在 `publishedVersionId` 指向 v4，但 `Agent.systemPrompt` 草稿态无版本保护，改前建议先建版本快照。
  - **用户引用资料的 input 尾部风险**：`MAX_REF_CHARS_TOTAL = 120_000` 字符（`services/retrieval.ts:67`），用户一次 @ 满 9 份文档就是约 9 万 token 的单请求——若上游按 TPM 限，一次就能打满窗口。未改（会影响「长文转附卷」这一既有能力），但要在 V2 的 S8 里量出后果。
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
