# 军师 · AI 商业军师 —— 工程总说明（AGENTS.md）

> **这是本仓库给 coding agent 的入口文件，新会话自动加载。** 它只放三类东西：① 必须无条件遵守的规则与铁律；② 三端的架构骨架与入口命令；③ 章节索引——每个领域的完整约束账本在 **`docs/agents/`** 分册里，章节号与本文一致（代码/文档里写的「AGENTS.md §7.2」= `docs/agents/07-frontend.md` 的 §7.2）。
> **读法**：本文全读；改哪个领域，再读对应分册的相关小节，不要一次全读所有分册。
> **文档与代码不一致 = 缺陷**。产品定位见 `PRODUCT.md`，历史变更见 `docs/CHANGELOG.md`，进展/待做见 `docs/ROADMAP.md`。
> **体量预算**：本文 ≤ 40 KB。2026-09-09 之前它长到 379 KB、每个会话都要整份加载，所以把各章正文原样拆进了分册；不要再把过程叙事和历史基线写回这里。

---

## 0. 给 Coding Agent 的强制指令（务必执行）

**只要改了代码 / 配置 / 接口 / 数据结构，就必须在同一次提交里同步文档——无一例外。** 同步的落点按下表，别写错地方：

| 内容 | 写到哪 |
|---|---|
| 新约束、改口径、踩坑后的「勿回退」 | **`docs/agents/NN-*.md` 对应章节的对应小节**（这是各领域的真源账本） |
| 一条「日期 · 改动 · 影响面」 | **`docs/CHANGELOG.md` 顶部**（最新在上） |
| 决定延后 / 不做 / 留坑 | **`docs/agents/13-todo.md`**，注明原因或前置条件；实现后**删除该条**并在 CHANGELOG 记一笔 |
| 铁律、入口命令、仓库结构、章节索引变化 | 本文对应章节（只有这四类才动本文） |
| 里程碑（完成一个 Mx / 重要功能上线 / 重大决策） | 另同步 Notion「军师 · 工程变更日志（持续更新）」：`https://app.notion.com/p/39205c5098e681e09f9ce4d589b51217`，最新在上、一句话结论 + 要点、产品可读口径 |
| 小程序每次上传的版本/描述 | `docs/WEAPP_RELEASES.md`，不进任何其它文档 |
| 部署/预发的「当前基线 SHA」、一次性验收记录、Notion 待补 | 只进 CHANGELOG，**不进 AGENTS.md 与分册**——它们隔天就过期 |

分册里一条约束的写法：**规则 + 一句为什么（或事故日期）+ 守卫用例/测试文件**；不写过程叙事。

**本文的膨胀防线（机器闸门，`scripts/check-agents-doc.mjs`；`cd app && npm test` 与 CI 会跑它，Claude Code 每次写本文也会触发）**：整文件 ≤ 40 KB / 320 行；单节 ≤ 6 KB（§0 ≤ 9 KB）；单行 ≤ 1400 字；顶层章节骨架固定（§0–§14 + 附录 A/B，加章节要同时改脚本的 `HEADINGS` 与附录 A）；禁止出现部署/预发基线、`NRestarts`、提交 SHA、Notion 待补、TODO 复选框、「**标题（日期）**：正文」这类账本条目形态；附录 A 必须与 `docs/agents/` 目录一一对应，分册必须保留 `## N.` 锚点。**闸门红了不许抬上限**——那是在提醒你这段内容属于分册或 CHANGELOG。往本文加一条铁律的标准：它跨领域、违反即事故、且用两三句话说得完；否则写进分册对应小节，在本文最多留一个短语加链接。

1. **绝不允许「做了一半且没记录」**。纯探索 / 未落地的尝试可以不记；一旦落到代码就必须记。
2. **改数据模型先改 SSOT**：任何接口字段/数据结构变化，先改 `shared/contracts.d.ts`，再改前端/后端/运营端实现（§5）。
3. **保持构建绿**：较大改动后按 §11 构建校验基线跑通三端；改路由/鉴权/检索/上下文/数据模型后 `server` 的 `npm test` 必须全绿。
4. **新增全屏弹层**必须成对调用 `store.setOverlay(open, key)` 同步隐藏自定义底栏；遵守 §7.2 UI 约定，勿回退已修复的坑。
5. **登录态失效必须显式打断，游客未登录不得误伤（全局铁律，两端同源）**：`app/src/services/api.ts` 的 `request()`（原生端 `weapp-native/services/request.js`）在发请求前捕获 `tokenAtRequest`。收到 401 时，**只有「请求原本带 token 且当前 storage 仍是同一个 token」**，才由第一条响应触发全局 `onAuthLost`（清登录态 + 提示「登录态已失效，请重新登录」+ `reLaunch` 回 `pages/sessions`）；同一旧 token 的其余并发 401 标 `staleAuth`，页面 catch 不得再次清状态/提示/跳路由，旧请求晚于一次新登录返回时绝不能清掉新 token。**请求原本无 token** 只抛 `{ code:'UNAUTHORIZED', hadToken:false }`，由动作级登录门在原页面承接：不提示「登录态失效」、不清状态、不跳路由。页面 `.catch` 只负责本地非鉴权兜底；已标 `authHandled/staleAuth` 的 401 只收口错误。**埋点 `api.track` 不得走 `request()`**（一条统计请求会把正在打字的用户踢出对话）。历史坑：记忆库/履历页曾吞 401；游客态上线后若把无 token 401 也全局打断，正常浏览会被误报成掉登录；「今日」tab 并发拉取曾让同一失效 token 连续 reLaunch，表现像小程序闪退。
6. **小程序改动先查约束清单**：凡改 `app/` 的页面、tabbar、弹层、登录、键盘、网络请求、路由分包或项目配置，先对照 **`docs/agents/07-frontend.md` §7.2 小程序工程约束清单**；不确定时按清单保守实现。真机行为只能在微信开发者工具/真机验，H5 不能替代。
7. **运营后台 UI 改动守设计系统**：凡改 `admin/` 前端，必须对齐 **`admin/DESIGN.md`「Engineering Compliance」**：颜色只用 `:root` token、只用已定义组件类、z 轴只用 `--z-*`；提交前 `cd admin && npm run lint:ui` 全绿（已接入 `build`）。另五条硬约束：① 新页面先在 `admin/src/nav.ts` 登记，标题走 `PageHead`；② 取数一律 `useResource` + `ViewState`，**禁止 `.catch(() => {})`**，写操作的 `catch` 必须透出 `e.message`（盖成固定文案会把 403「需要 owner 权限」说成「保存失败」）；③ 破坏性/资金动作用 `ConfirmDialog`，**禁止 `window.confirm/prompt/alert`**；④ 开关用共享 `Switch`，弹层用 `useDialogFocus`；⑤ 业务视图放 `admin/src/views/<组>.tsx`，`App.tsx` 只留外壳。shadcn/Tailwind **只允许出现在「增长」组三个目录**（§9）。
8. **品牌红线：禁止「米诺 / Mino」**。任何新增或修改的文案、提示词、模板、代码标识符、注释、seed 里一律用「军师参谋部 / Junshi Strategic Staff」；从 Notion 原稿移植先按 `server/src/data/prompts/README.md` 的映射去品牌。存量残留清扫见分册 §13。
9. **对外数据归运营，不归代码**：套餐价格/额度/权益/上下架、增购包、智能体计价字段、提示词（`agent.systemPrompt` 是唯一运行时真源，`server/prompts/*.md` 只是新环境种子）、问策模板池、代理等级/比例、方向样例等都是**运营目录**——**禁止 seed、禁止全量同步回写、空目录合法**。`npm run db:seed` 有生产护栏（非本地库拒跑）；`npm run admin:sync-content` 默认不覆盖计价与提示词（`--force-pricing` / `--force-prompts` 才覆盖）；这些表刻意不进 `prisma/resetBusinessData.ts`。改线上价只走运营后台。
10. **空态 ≠ 读失败，没好 ≠ 好了**：任何端都不许把「取不到 / 没查过（游客）/ 还在生成」显示成「你还没有」或「已完成」；读失败保留失败态与重试，游客态不说「你还没有」，完成后的动作只在真正完成后出现（§7.2、§9、`docs/ERROR_HANDLING.md`）。
11. **测试全绿不等于体验验收**：mock provider 与静态断言证明不了模型产出质量与真机版式；涉及模型效果、真机布局、支付、真实素材的改动，放量前要用真实 provider / 真机 / 预发走一遍，结论写进 CHANGELOG。
12. **别拿旧注释当事实**：改时间类 raw SQL、计费、长度统计前先量现状（时区偏移、SQL_ASCII 库 `length()` 是字节数、`meterUnit` 已废弃等坑均记在分册）。

---

## 1. 产品摘要

**军师**是面向创始人 / CEO 的 AI 商业军师，主线是「出谋」（智库顾问产出咨询成果）和「出活」（工坊智能体产出品牌资产）。当前核心能力：本命色、专属理解（Agent Memory，前台叫「军师印象」）、军师档案、智能体权益 / 产出额度、项目 / 知识库 / 版本化报告 / @ 引用、多租户隔离、战略案卷执行闭环、命盘/天时、海报成品图、「快出片 / 爱速拍」数字人短视频分包（独立产品规划见 `docs/VIDEO_STANDALONE_MINIAPP_PLAN_2026-08-19.md`）。

详细产品说明、文案口径和升级方向统一放在 **`PRODUCT.md`**。工程实现以本文 + 分册的契约、路径、构建与 TODO 为准。

---

## 2. 仓库结构

```
repo/
├── AGENTS.md           # ← 本文件：规则 + 骨架 + 章节索引（新会话自动加载）
├── PRODUCT.md          # 产品定位、信息架构、文案口径、企业事务操作系统说明
├── IMPLEMENTATION.md   # 与《投产开发指导》章节的对应表（设计溯源）
├── shared/
│   └── contracts.d.ts  # ★ SSOT：全栈数据契约（纯类型，运行时擦除）
├── docs/
│   ├── agents/         # ★ 本文各章节的完整约束账本（04 运行模式 … 13 TODO），章节号与本文一致
│   ├── CHANGELOG.md · ROADMAP.md · TESTING.md · DEPLOYMENT.md · MONITORING.md · RELEASE_SOP.md · WEAPP_RELEASES.md · ERROR_HANDLING.md
│   └── [FABLE5]/[OPUS5]/[HANDOFF] 前缀：各期方案、审计、交接稿（plan-only，与代码冲突以代码与本文为准）
├── deploy/             # 部署模板：nginx.conf.example（★分 A 主配置 + B 站点两段，两段都要改）· junshi-api.service · Dockerfile.server · docker-compose.yml · monitoring/
├── app/                # 微信原生小程序（weapp-native）+ Taro/React H5（src）+ PC 工作台（src/pc），共享同一后端契约
├── server/             # 后端 API：Fastify + Prisma + PostgreSQL + LLM Gateway（src/app.ts 工厂 + test/ 集成测试）
├── admin/              # 运营后台：Vite + React + TS（DESIGN.md 是设计系统与工程合规真源）
├── loadtest/           # 隔离压测：Docker Compose + 内网网关 + k6 只读场景
└── project/            # 原始高保真原型（设计事实来源，勿改）
```

本地生成物约定：微信源码在 `app/weapp-native/`，`app/scripts/build-native-weapp.mjs` 输出 `app/dist-native/`；Taro 只保留 H5，输出 `app/dist-h5/`；PC 输出 `app/dist-pc/`。`app/project.config.json` 是发布/CLI 配置，固定 `miniprogramRoot=dist-native/`。**日常手工走查导入 `app/dist-native/`；`auto-preview` / `preview` / 发布 CLI 的 `--project` 指向外层 `app/`**（直接指向 `dist-native/` 会误报 800059 `app.js, file not found`）。根目录误生成的 `project.config.json` / `weapp-preview*` / `weapp-auto-preview*`、`app/.impeccable/`、空 `package-lock.json` 等均为本机产物，已 `.gitignore`。`.claude/worktrees/*/AGENTS.md` 是工作树副本，不是维护源。

---

## 3. 技术栈

| 层 | 技术 |
|---|---|
| 微信小程序 `app/weapp-native` | 微信原生 Page/Component · WXML/WXSS/JS · Sass 构建 · Lucide 静态 SVG · towxml-stream-typewriter 1.0.3（MIT，流式 Markdown）· 基础库 `libVersion=3.16.2` |
| H5 `app/src` | Taro 3.6.34 · React 18 · TypeScript · Sass · Webpack5（只构建 H5）|
| PC `app/src/pc` | Vite + React DOM，零 Taro（`pc-bundle.test.mjs` 守卫）· 域名 `copilot.aibuzz.cn` |
| 后端 `server/` | Fastify 5 · Prisma 5 · PostgreSQL（生产 pgvector）· Zod · `@anthropic-ai/sdk` · tsx/tsc · 大模型由运营后台三层配置，未配真实 key 自动降级 mock |
| 运营端 `admin/` | Vite 5 · React 18 · TypeScript；仅「增长」组用 Tailwind v4 + shadcn/Radix |
| 数据契约 | `shared/contracts.d.ts`（被三端 `import type` 引用）|
| 运行时 | Node **24.x**（`.nvmrc` / `engines >=24 <25`；CI 同）|

---

## 4. ★ 运行模式：mock vs server（配置化）　→ 全文 `docs/agents/04-run-modes.md`

前端用一个环境变量切换数据来源，**默认 mock**，本地零依赖即可开发完整流程。

| 模式 | 行为 | 启动方式 |
|---|---|---|
| **mock**（默认） | 原生端走 `app/weapp-native/services/mock.js`，H5 走 `app/src/services/mock.ts`；均按 `mock-<手机号>` token 隔离并落本地 storage | `cd app && npm run dev:weapp` |
| **server** | 连真实后端 REST API | `WEAPP_APP_MODE=server WEAPP_APP_API=https://你的域名/api npm run build:weapp`；生产 `npm run build:weapp:server`；预发 `build:weapp:preprod` |

铁律（细节与理由见分册）：
- 原生配置由 `build-native-weapp.mjs --mode/--api/--version` 写入 `dist-native/config/env.js`（前缀 `WEAPP_APP_*`）；H5 由 `app/config/index.ts` 注入 `TARO_APP_*`；两套产物不得混目录或互引运行时。`app/src/services/config.ts` 不要在浏览器运行时再用 `typeof process` 包裹。
- 原生构建写 `dist-native/junshi-build-meta.json`（runtime/mode/api/apiExplicit/version/gitSha）；`envVersion=develop` 时底栏上方显示 `MOCK / LOCAL / PREPROD / PROD` 角标，体验版/正式版强制隐藏。**正式发布只走 `npm run release:weapp -- --version x.y.z --desc "…"`**，它强制重建 server 包并校验构建身份，不得用裸 DevTools CLI/GUI 绕过。
- **两端各一份同契约 mock 后端**：按账号隔离并持久化；所有「提示成功」的动作必须在刷新/切账号后看到真值，禁止 `{ok:true}` 伪装；作品类数据不得预置成品；新 mock 账号 `name` 保持空直到用户真填。
- **附身登录是唯一运行时数据源例外**：`api.verifyImpersonation` 无论 mode 都直连真实 `/me`，验令通过后整个会话由 `runtime-mode` 切到真实服务端；任何真实 JWT 会话严禁下发 mock 夹具。
- **「快出片 / 爱速拍」分包（`app/weapp-native/packages/video` + `server/src/services/video`）**：数据源只有 `mock / bff`，真实请求始终同源到军师 `/api/video/**`，**禁止 direct 模式把军师 JWT / service token 发给 AIStar 或第三方**（唯一直传是军师签发的短时 OSS PostObject 票据）；积分只在军师侧幂等 hold/settle/refund；`catalog.js` 是模板唯一真源；成片保存走 `/api/video/works/:id/file`。幂等/状态机、三层预览、成片页三态、合并镜头字幕、素材展示、多数字人等全部约束在分册 §4，改分包前必读；三层测试分工见分册 §11。

---

## 5. ★ SSOT：全栈数据契约 `shared/contracts.d.ts`　→ 全文 `docs/agents/05-contracts.md`

- **唯一数据口径**，形式是 `.d.ts` 纯类型：编译期检查、运行时擦除，三端只 `import type`（前端 `app/src/services/api.ts`、后端 `server/src/llm/schema.ts`、运营端 `admin/src/api.ts`，各按旧名再导出，调用方零改动）。
- **改数据模型只改这一处**，三端类型同步；新增/修改接口字段先改契约再改实现。
- 埋点事件名等「两处同源」的常量（`ClientEventName` ↔ `routes/wence.ts` 的 `EVENT_NAMES`）必须同时改，守卫用例会钉住。
- 各领域契约清单（权益、报告/知识/引用、军师档案、登录身份 `phoneBinding`、邀请归因 `referralToken`、问策入口 `wenceForm`、连续会话/渐进交付）见分册。

---

## 6. 账号与数据隔离　→ 全文 `docs/agents/06-account-isolation.md`

- **游客可浏览、动作级登录门、可关闭**：冷启动与五个主 Tab 不自动弹登录；只有发送对话、看历史、上传/保存、执行、购买、维护档案等动作才打开可关闭的 `Login` 并用 `AuthReason` 明示目的；关闭后留在原页且不丢输入。页面**不得写「不登录也能看 / 游客浏览」类权限解释**。原生主按钮固定「手机号快捷登录」（`open-type=getPhoneNumber`，勾协议后才渲染），一次点击同时取 `phoneCode` + `wx.login` code 交 `POST /auth/wechat-phone`；拒绝授权保留短信验证码登录。
- **手机号是唯一用户身份**，openid/unionid 只是附着绑定：`/auth/wechat-phone` 按本次授权手机号定位账号（`matched` / `placeholder_upgraded` / `wechat_relinked`，不再返回 `PHONE_TAKEN`）；`/auth/wechat-login` 只放行已关联账号，未关联 404 `PHONE_LOGIN_REQUIRED` **不建号**；换号只走设置里的 `POST /auth/bind-phone`（短信 `scene=bind`，跨账号占用 409 `PHONE_TAKEN`）；`phone` 不得静默变更。
- **隔离**：后端 `resolveUser` 严格按 token 解析，无/失效 token 一律 401（无 demo 兜底）；所有业务查询按 `userId/tenantId` 过滤；新增可被引用/召回的数据类型必须补跨用户不可见断言（TC-G）。
- **生产 fail-fast**：`NODE_ENV=production` 必须同时有高强度 `APP_JWT_SECRET`（≥32 字节）、`APP_JWT_REQUIRED=true` 与至少一个完整登录通道，否则启动即失败；只接受 HS256 JWT；`uncaughtException/unhandledRejection` 记日志后 15s 内优雅退出交 systemd 拉起。
- **统一账号中心 aibuzz-id**（爱速拍先用）：`Authorization: Bearer <RS256 JWT>` 由 `services/identity.ts` 验签；**`ID_ISSUER` 留空 = 整体关闭，RS256 令牌一律 401，没有「没配就放行」**。`sub` → `User.identityUid`，未命中且 `phone_verified !== true` → 403 `PHONE_BINDING_REQUIRED`（绝不建无手机号账号），有手机号按手机号回填（已绑别的 uid → 409 `IDENTITY_CONFLICT`）。落地为 `app.ts` 的 `attachIdentityUser` 钩子换成短时内部 `x-user-id`；**老 `x-user-id` 链路一个字节不改**。`aud` 含 `quickreel-api` 的已验签令牌写 `/api/video/**` 时**只免套餐闸 `PLAN_WRITE_GATE`**（三条同时满足才免），钻石/审核/限流/401/403 照常。守卫 `test/identity.test.ts`。
- **套餐禁写闸**：`PLAN_WRITE_GATE` 默认禁止无套餐账号的业务写；对 `state=none` 精确放行 `PUT /me`、`PUT /me/color`、`POST /me/avatar`、`PUT /profile`、`POST /quickscan`（每日 1 次 `grace:'quickscan'`）与 `POST /events`；是否自动送套餐只由 `TEST_DEFAULT_PLAN_NAME` 决定（生产恒空）。
- **支付**：`Plan.planFamilyKey/tierRank` 是商业关系真源；下单带 `clientRequestId + expectedChargeAmount`，报价变化一律 409 `QUOTE_CHANGED`；`markPaidAndApply` 是真金入账唯一收口（订单锁 + `entitlement:<userId>` 锁）；回调验签 fail-closed；`production` 开启 `PAY_MOCK_SUCCESS/PAY_SANDBOX/ALLOW_DEMO_PURCHASE` 任一项拒绝启动；自动续费默认永不预选，能力不齐（`papayConfigured=false`）C 端隐藏；读价一律先过 `services/planPricing.ts` 的 `withEffectivePrice()`（挂牌价/优惠价窗）。
- **账号注销**：`DELETE /me` 绕过套餐闸；立即停用 + 至少 30 天隔离保留（`ACCOUNT_DELETION_RETENTION_DAYS`）+ 到期 `account-erasure-sweep` 清除/匿名化；不得宣称「已彻底删除」。
- **智能体开通不收费**：`unlock` 智能体确认即启用（只落 `UserAgent`，`pricePaid` 恒 0）；对话走 token 额度，出品走钻石。
- 微信密钥、`session_key` 只在服务端；`WECHAT_MINI_SECRET`、`WECHAT_MESSAGE_TOKEN` 不进前端包。

---

## 7. 前端（app）架构　→ 全文 `docs/agents/07-frontend.md`

- **IA**（2026-08-18 定稿）：五个平铺 tab **问策 · 战局 · 今日 · 图籍 · 主公**，顺序与图标唯一定义在 `services/tabbar.js`；锦囊 `pages/pouch` 是普通页；启动页 `pages/sessions`。页头统一 `components/TabHeader`（一行用途小字 + 大字 tab 名 + 背景大字 + 细线），**零按钮、不提供 `right` 插槽**，功能入口回归内容区。问策 `wenceForm='chat'` 终态是自绘「对话即 tab」页头 + `chat-core` + 底部合体浮岛，不是 TabHeader 实例。
- **对话核心 `weapp-native/chat-core/`** 住主包（分包可引主包，反向不行）：`behavior.js` + `message-list.wxml` + `composer.wxml` + `chat-core.scss`；宿主页只留导航参数/页头/返回/滚动容器，并负责注册组件与注入 towxml（`useStreamRenderer`）；`chat-core` 自己不得调 `api.track`。
- **§7.2 小程序工程约束清单是全部真机坑的唯一账本**（分册），改前必读。最常回退的几条：
  - **登录页不得出现「微信」字样或平台图形**（2026-08-08 审核驳回，硬红线）；`npm test` 有反向断言。
  - **composer 输入铁律**：两个 `<textarea>` 只允许 `value="{{composerSeed}}"`，编辑过程绝不 `setData` 回灌（`onComposerInput` 里出现 `composerSeed` 即构建失败）；`adjust-position={{false}} always-embed={{true}} fixed={{true}}` 用 WXML 表达式；新增内嵌对话宿主页要加进 `build-native-weapp.mjs` 的 `CHAT_TEXTAREA_TARGETS`。
  - **tabBar 页的清理写 `onHide`（配 `onShow` 恢复），不能只写 `onUnload`**：切 tab 只触发 `onHide`，漏了会让定时器累积到真机被杀（2026-08-28 事故）；`reLaunch` 复现不出来。
  - **原生流式正文只增不减**：喂打字机前先过 `services/chat-reply.js` 的 `streamVisibleText()` 暂扣尾部疑似 `ask` 协议块；`done` 后以服务端最终正文收尾替换。
  - **原生 `<Input>` 定高三件套** `height / min-height / line-height` 三等值；**两列网格** `space-between + 48.5%`；全屏弹层内容用带高度的原生 `ScrollView`；卡片边用 `--line-strong` 不用 `--line`；`--accent-soft` 图标底必须带 `--accent-glow`；深度用渐隐不用 `backdrop-filter`。
  - **顶部安全区只由统一层负责**（`Screen topInset` / `SafeHeader` / 原生 `capsuleMetrics()`）；不要再造第七套高度；`TabHeader` 不加 `overflow:hidden`。
  - **全站分享**：54 页统一 `withShare`，`imageUrl` **绝不能留空**（留空会截当前页把私密内容带进分享卡）；朋友圈只开 3 页（问策/命盘/天时日历），白名单守卫 `weapp-share.test.mjs`；素材池按本地自然日确定性轮动，禁 `Math.random`。
  - **错误先判「原样重试能不能恢复」**：分类收口在 `services/api-error.js` / `services/apiError.ts`，页面 catch 不按 HTTP 状态散写；5xx/SSE 原文只进 `technicalMessage`。
  - **前台商业文案克制**：不写「赠送 / 付费解锁 / 充值 / 最受欢迎」；启用动作一律不标价；Markdown 必须经 `MarkdownText` / `markdown-text` 渲染，asks 独立渲染。
  - **H5 token 双写**（`app.scss` 的 `page{}` ↔ `app.h5.scss` 的 `:root`）；主题类必须显式覆盖业务 token。
- **启动/状态**：认证与 `onboarded` 以服务端 `services/onboarding.ts` 为唯一权威；`setOverlay(open,key)` 以来源集合记账；`loadAgents()` 保留 `DEFAULT_AGENTS` 兜底。
- **PC 工作台** `app/src/pc/`（§7.5）：独立硬登录门，五区注册表，不得引用 Taro；四道门 `typecheck && test && build:pc && build:h5`。
- **邀请归因与关系链**（§7.6）：`services/invite.js` 捕获、`referralToken` 服务端签名；建边并发口径是有序 advisory lock（`services/referral.ts` 的 `bindReferral`，两 id 排序取锁后重读）。

---

## 8. 后端（server）　→ 全文 `docs/agents/08-backend.md`

- **入口**：`server/src/app.ts` 的 `buildApp()` 工厂（`index.ts` listen，测试 `app.inject`）。API 一览（`/api` 前缀，含 `/admin/*`、`/video/*`、`/creative/*`）见分册 §8.1。
- **LLM Gateway `server/src/llm/gateway.ts`**：路由 provider → 输入审核 → Token 计量 → 缓存 → 故障降级 mock。普通聊天只前置审核输入；无工具调用时走 provider 原生 streaming 经 `/generate` SSE 下发。**模型由运营后台三层配置**（`AiCredential` / `AiEndpoint` / `AiRoute` / `AiRouteMember`，按用途 chat/deliverable/aux/embedding/rerank/moderation），`services/aiRoutes.ts` + `aiConfig.ts` 投影到调用方；旧 `AiSetting/AiModel` 只读；**未配真实 key 一律降级 mock，不发网络请求**。凭证明文存库（已拍板），对外只回 `hasKey`。
- **持久生成链路**：`GenerationJob/Attempt/Effect` 是事实源，`clientRequestId` 幂等，`outputIntent.ts` 在建单时冻结 kind/requestedOutput/deliveryMode，Worker 只读冻结值；投递 **at-least-once**，副作用靠 `jobId/effectKey` 幂等；页面退出/切后台/180s 到点只关订阅不取消 job；`generationWorker.ts` 有界并发 + 套餐优先级（虚拟到达时间）。取消是软取消，取消事务要放回未结算预留。
- **流式保护**：**只设空闲看门狗（首事件 90s / 相邻 30s），绝不加总时长超时**；撞 `max_tokens` 不是失败而是「没写完」→ 自动续写（≤2 轮、正文累计 24k、100s 墙钟），仍未完则落库 + `truncated=true`；流中途失败不续写。`streamChatRound` 的 `if/else if` 链中间不许插语句（2026-08-04 事故）。**`max_tokens` 在 Anthropic 协议是 thinking + 正文总闸**，chat 路径下发 `chatMaxTokens()` = 正文 8,000 + 思考预算；`OPENAI_TIMEOUT_MS` 是下限之下的配置值，对话取 `max(配置, 150s)`，成果 `max(配置, 300s)`，不要靠抬它来修。
- **并发与配额**：`services/llmGate.ts` 全局并发闸挂 provider 层，按端点各占车道，429 整窗冷却；`llmPool.ts` 端点池 HRW + 会话粘性，探活/测试连接必须 `poolBypass:true`；辅助抽取全部经 `gateway.rawText()` 走 aux 档（强制关思考、上限 700）。
- **计费两条轴**：对话 = 月度 token 额度 × `Agent.billingRatio`（`services/tokenQuota.ts`，`meterUnit` 已废弃不得再读）；产出 = 钻石按 `技能 key × 规格` 在 `services/artifactPricing.ts`（`artifactPrice()` 未配返回 `null`，回退用 `??`）。`services/credits.ts` 的 `CreditReservation.refund` 幂等。
- **`services/scheduler.ts`**：任务注册制，**同进程严格 FIFO 串行队列 + `pg_try_advisory_xact_lock` 选主**（生产 Prisma 池只有 5 连接）；`NODE_ENV=test` 不自启；新定时逻辑必须挂在这里，不得在路由实例另起 timer。
- **上下文注入**：`services/context.ts` 的 `buildGenContext` 是总入口（档案/记忆/本命色/军师档案/项目/引用/知识召回/天势/战略档案/事实块）；行业身份层 `data/industryPacks.ts`（新增行业包 = 建档选项自动 +1，**禁止写死行业基准**）；`CHAT_STYLE_GUIDE` 在 `llm/schema.ts` 是对话体例 SSOT。
- **审计与探活**：`services/audit.ts` 的 `onResponse` 钩子记录全部 `/api/*`；`/api/metrics` 需 `METRICS_TOKEN`；`services/aiProbe.ts` 能力靠测不靠猜（真实计费，`kind='probe'`）。
- **海报成品图 `canvas_design`（§8.4）**：三表 `CreativeJob/CreativeAsset/CreativeDirectionSample`；预扣即实扣 + `refundJob()` 幂等退款；`tier` 决定主视觉来源、`layoutEngine` 只决定排版；LLM 写的 HTML 是不可信输入，静态审计只拒不洗；功能开关只有 `FeatureFlag` 行 `creative-poster` 一层（行缺失视为关）；图片审核目前只有 `none`（合规缺口，见 §13）。

---

## 9. 运营后台（admin）　→ 全文 `docs/agents/09-admin.md`

- **`admin/src/nav.ts` 是导航 SSOT**：按「只读归观测、可写归配置」分 8 组（今日 / 用户 / 经营 / **增长** / 智能体 / 观测 / 商品 / 配置），**单组不超过 8 项**，label/hint/icon/`ownerOnly`/命令面板别名都在这里。`App.tsx` 只做外壳（鉴权、分组导航、hash 路由 `#/<section>[/<id>]`、详情面板、命令面板 ⌘K、toast），业务视图在 `views/*.tsx`。
- **取数三态**：`useResource` + `ViewState` 统一 loading/error/empty，error 带服务端原文 + 重试；取数有效性由每轮 effect 自己的 `cancelled` cleanup 管理（StrictMode 会烧死组件级 `alive` ref）。
- **401 才是掉线，403 是权限不足**（`api.ts`，回归 `api.auth.test.ts`）：403 保留登录态、就地提示、不给重试按钮；requireSuper 入口按 `isSuper` 收起并写明只读。
- **资金/破坏性动作统一 `ConfirmDialog`**（回显对象，退款/关合规开关手打确认词）；开关用 `Switch`，弹层用 `useDialogFocus`；`lint:ui` 阻断 `:root` 外 hex、字面量 z-index、`div.sw`、空 catch。
- **时间范围统一 `services/adminRange.ts`**（北京时间自然日；滚动预设上界略过当前 60s；原生 SQL 时间边界经 `utcTimestamp`，禁止裸绑 `Date`）。
- **「增长」组 shadcn 模块边界**：只在 `admin/src/growth/**`、`components/ui/**`、`lib/**`；不引 preflight、`@source` 白名单不放宽、变量 `--sc-` 前缀、不做暗色；旧页面不许 import `@/components/ui`。映射与禁令见 `admin/DESIGN.md` §7。
- 邀请增长四视图（§9.1）：零图表依赖手写 SVG，风控聚集判定下推 SQL、阈值归运营 flag `referral-risk`，公理「风控预警不阻断」。

---

## 10. 数据库（Prisma · `server/prisma/schema.prisma`）　→ 全文 `docs/agents/10-database.md`

租户 `Tenant` / 用户 `User`（phone 唯一；`wechatOpenId/wechatUnionId`、`identityUid` 可选唯一）/ 档案 `Profile` / 智能体 `Agent` + `UserAgent` / 会话 `Session` / 消息 `Message` / 成果 `Deliverable` / 记忆 `Memory` / 项目 `Project` / 报告 `ReportDoc` + `ReportVersion` / 知识 `KnowledgeItem` + `KnowledgeChunk` / 套餐 `Plan` + `PlanEntitlement` + `SkuEntitlement` / 算力 `CreditLedger` + `TokenWallet` / 支付 `PaymentOrder` + `SubscriptionContract` / 案卷 `Casefile*` / 命盘 `NatalChart` / 账本 `ReviewLog` `ProphecyLog` `DecisionLog` `UserProgress` `StrategicProfile` / 邀请 `Referral` + `ReferralAttribution` / 代理分销六表 / 生成 `GenerationJob*` / 海报 `Creative*` / 大模型 `AiCredential/AiEndpoint/AiRoute/AiRouteMember` / 审计 `AuditLog` / 审核 `ModerationLog` 等。**业务表均含 `tenantId` 行级隔离。**

- **运营目录不进 `prisma/resetBusinessData.ts`**（`WenceTemplate`、`DistributorTier/DistributionRule`、AI v2 四表、方向样例），测试自己建自己清（AI v2 用 `__wipeAiV2()`）；埋点 `ClientEvent` 无外键、必须进 reset。
- `Referral.userId` 主键 = **单推荐人公理**，绑定后不可变更；判环沿 `referrerId` 递归上溯（物化 lv1/lv2/lv3 只给运营看）；`CommissionEntry` 是只追加账本，幂等键 `(outTradeNo, beneficiaryUserId, level, kind)`。
- 无 migrations 目录：部署走 `prisma db push`（纯加法为主）；pgvector 列由 `prisma/pgvector.sql` 建（非 Prisma 管理），`PGVECTOR_ENABLED=false` 走内存余弦。
- Prisma raw SQL 的 `Date` 参数有时区偏移坑，改时间类 raw SQL 前先看分册与 `adminAuditView.ts` 的 `utcTimestamp` 口径。
- 企业事务操作系统工程边界：报告版本只由 `services/reports.ts` 管；检索走 `services/retrieval.ts` / `memory.ts` / `vectorStore.ts`；回忆意图由 `services/recallIntent.ts` 判断。

---

## 11. 构建、运行、验证、发布　→ 全文 `docs/agents/11-build-run-verify.md`

**本地**
```bash
npm run dev                         # 根目录一键：PG → 建库 → 迁移 → (首次)种子 → API :4000 + H5 :5173 + 后台 :5174
cd app && npm run dev:weapp         # 小程序 mock 包（DevTools 导入 app/dist-native/）
cd app && npm run dev:h5            # H5 零后端；连后端 npm run dev:h5:server
cd app && npm run dev:pc -- --host 127.0.0.1   # PC 工作台
```
演示账号 `13800000000`；小程序连本机后端用局域网 IP（`WEAPP_APP_MODE=server WEAPP_APP_API=http://$LAN_IP:4000/api npm run dev:weapp`）。

**构建校验基线（每次大改后全绿）**
- `server`：`npx tsc -p tsconfig.json --noEmit` → 0；`npm test`（见下）。
- `app`：`npm test`（原生路由四件套 / 事件绑定 / 图标口径 / 输入铁律 / mock 隔离 / 产物隔离 / 分享白名单 / PC 零 Taro …）→ `npm run build:weapp:server` → `npm run build:h5`；改 PC 另跑 `npm run build:pc`。
- `admin`：`npx tsc -b && npx vite build` → 0（`build` 已含 `lint:ui`）；`npm test`。
- 两端纯函数单测走 `node --import tsx --test`，测试文件 `exclude` 出生产 tsc；`node --test` 匹配 0 文件时退出码仍是 0，CI 额外断言 pass > 0。

**后端集成测试（★ 改路由/鉴权/检索/上下文/数据模型后必跑全量）**
- `server/.env.test` 是唯一环境入口（hermetic：**绝不吃 `server/.env`**，用例要用的变量写进 `.env.test` 或用例内显式 set）；`DATABASE_URL=...junshi_test npm run db:push` → `AI_PROVIDER=mock npm test`。
- **并行会话/worktree 各开自己的测试库**（`createdb junshi_test_<主题>` + 显式 `DATABASE_URL`），`junshi_test` 全机共享，同时跑会互相清库；合回 main 前把 `.env.test` 改回。
- Node 24 固定；写了 AI v2 四表的用例必须 `__wipeAiV2()` 归还现场；`UserJourney` 首次建行用 `createMany({skipDuplicates:true})`。
- 微信支付本地验证：`npm run pay:e2e`（沙箱状态机）与 `npm run pay:e2e:mock`（真实代码路径 + mock 网关）。

**「快出片」三层测试**：纯函数 `video-{catalog,model}.test.mjs` → 页面行为 `video-chain.test.mjs`（`weapp-runtime.mjs` 跑 `weapp-native/` 源码，不冒充渲染）→ 布局 `npm run e2e:weapp`（需 DevTools 已登录 + 服务端口已开）。e2e 夹具注入的假数据必须是该状态真会出现的值。改界面文案「去 AI 味」用 `shuorenhua` skill，口径见分册 §11。

**小程序真机预览与发布**
```bash
# 真机预览（--project 指外层 app/，输出到仓库根，不入库）
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto-preview --project /Users/donis/dev/ai-pilot/app --info-output /Users/donis/dev/ai-pilot/weapp-auto-preview-info.json --lang zh
# 正式发布（强制 server 模式重建 + 校验 junshi-build-meta.json；上传由 agent 自己执行）
cd app && npm run release:weapp -- --version <版本号> --desc "<说明>"
```
上传前后同步 `docs/WEAPP_RELEASES.md`；DevTools 需已登录且开启「设置 → 安全 → 服务端口」；转体验版/提审/发布是 mp 后台手动步骤。`project.private.config.json` 的 `urlCheck:false` 只用于局域网预览。

**服务端部署**（主文档 `docs/DEPLOYMENT.md`，发布前先读 **`docs/RELEASE_SOP.md`**）
```bash
bash scripts/deploy-prod.sh                # 默认 server + admin；DEPLOY_H5=1 同时发 H5；SKIP_DB_PUSH=1 仅限已核对无 schema 变更的热修
bash scripts/deploy-preprod.sh             # 预发：/opt/junshi-preprod · :4001 · https://wxapi.aibuzz.cn/api_preprod
```
- 生产 `ecs-user@8.136.36.175`（key `/Users/donis/dev/aliyun/aiartist.pem`），`/opt/junshi` 是 `git archive` 包式部署，**不要远端 `git pull`**；例行升级不跑 `db:seed`；`server/.env` 不入包。阻断标准：构建失败、`junshi-api` 非 active、`/api/health` 非 200、域名 `/admin/` 非 200。
- **预发与生产同宿主机**：构建曾伴随宿主机内存耗尽（2026-08-15），脚本有 `MemAvailable<3GiB` 拒绝 + cgroup 限制 + 原子 release 切换；部署前后探生产健康。预发真连 AI，支付强制 mock 不许动。
- 快出片后端边界：军师 BFF 管 JWT/租户/脚本 AI/审核/积分/通知；AIStar Clip 管模板/素材/数字人/任务/总装；生产跨机私网回源，预发回源同机 `127.0.0.1:8081`。详见 `docs/DEPLOYMENT.md` §8.1。

---

## 12. 上线前硬约束（微信小程序）

> 服务器部署见 **`docs/DEPLOYMENT.md`** + `deploy/`；监控见 **`docs/MONITORING.md`** + `deploy/monitoring/`。运营后台部署在 `/admin/`（Nginx 已将 `/admin` 301 到 `/admin/`）；裸 IP 只保留 `/api/`。

mock 可随时预览；**正式上传/审核**还需：
1. **真实 AppID**：`wx810ebe6dfef8e75f`（`app/project.config.json`）。
2. **微信登录密钥**：服务端 `WECHAT_MINI_APPID/WECHAT_MINI_SECRET`；AppSecret 不得进入前端包或仓库。
3. **后端公网 HTTPS + ICP 备案域名**，并加入小程序后台 request 合法域名。
4. **生成式 AI 备案 / 算法备案 + 内容安全**（AI 类小程序审核硬性门槛）。
5. 真实模型：运营后台配置凭证/端点/路由（国内合规建议走备案的国产模型）。
6. **登录页无「微信」字样与平台图形**（§7）；协议页的经营主体/备案号等 `【填写】` 项由主体负责人提供，不得靠猜（分册 §13）。

---

## 13. 已知限制 / TODO　→ 全文 `docs/agents/13-todo.md`

规则：决定延后/不做/留坑的内容写进分册 §13（新条目放顶部，带日期、原因或前置条件）；实现即删并在 CHANGELOG 记一笔；不要把「明确不做」当遗漏去补齐（分册里已标注的拍板项）。当前顶部为 2026-09-05 爱速拍脚本 AI 真实产出未验、账号中心 outbox 未接、爱速拍新用户初始钻石无来源等。

## 14. 变更日志

历史变更在 `docs/CHANGELOG.md`（最新在上）；小程序上传记录在 `docs/WEAPP_RELEASES.md`。

---

## 附录 A · 章节索引（代码/文档里「AGENTS.md §N」的落点）

| § | 主题 | 全文 |
|---|---|---|
| §0–§3 | 强制指令 · 产品摘要 · 仓库结构 · 技术栈 | 本文 |
| §4 | 运行模式 mock/server · 快出片/爱速拍分包约束 | `docs/agents/04-run-modes.md` |
| §5 | SSOT 契约 | `docs/agents/05-contracts.md` |
| §6 | 账号、登录、隔离、支付、注销、账号中心 | `docs/agents/06-account-isolation.md` |
| §7 | 前端架构 · **§7.2 小程序工程约束清单** · §7.5 PC · §7.6 分享与邀请 | `docs/agents/07-frontend.md` |
| §8 | 后端 · §8.1 API 一览 · §8.2 LLM Gateway · §8.3 服务 · §8.4 海报成品图 | `docs/agents/08-backend.md` |
| §9 | 运营后台 · §9.1 邀请增长 | `docs/agents/09-admin.md` |
| §10 | 数据库 · 企业事务操作系统工程摘要 | `docs/agents/10-database.md` |
| §11 | 构建、测试、预览、发布、部署、预发 | `docs/agents/11-build-run-verify.md` |
| §12 | 上线前硬约束 | 本文 |
| §13 | 已知限制 / TODO | `docs/agents/13-todo.md` |
| §14 | 变更日志 | `docs/CHANGELOG.md` |

## 附录 B · 其它必读文档

`docs/RELEASE_SOP.md`（上线核查清单）· `docs/DEPLOYMENT.md`（部署/预发/AIStar 边界）· `docs/TESTING.md`（集成测试）· `docs/MONITORING.md`（监控告警）· `docs/ERROR_HANDLING.md`（错误分类矩阵）· `admin/DESIGN.md`（后台设计系统与工程合规）· `server/src/data/prompts/README.md`（提示词去品牌映射）· `docs/VIDEO_STANDALONE_MINIAPP_PLAN_2026-08-19.md`（爱速拍产品 SSOT）。
