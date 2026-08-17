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
7. **登录态失效必须显式打断，游客未登录不得误伤（全局铁律）**：`app/src/services/api.ts` 的 `request()` 与文件上传会在发请求前捕获 `tokenAtRequest`。收到 401 时，**请求原本带 token**才触发全局 `onAuthLost`（`store.ts` 清登录态 + 提示「登录态已失效，请重新登录」+ `reLaunch` 回 `pages/sessions`）；**请求原本无 token**只抛 `{ code:'UNAUTHORIZED', hadToken:false }`，由动作级登录门在原页面承接，不提示“登录态失效”、不清状态、不跳路由。不能在 401 回调里现读 token 决策，因为 API 层会先清 token。页面 `.catch` 只负责本地非鉴权兜底，已有 token 的失效后果仍不得吞；新增鉴权调用优先经 `request()`，面向用户的错误走 `store.handleApiError`。**历史坑**：军师记忆库 / 完整履历页曾吞 401；游客态上线后若把无 token 401 也全局打断，则会把正常浏览误报成掉登录。
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
├── app/                # 微信原生小程序（weapp-native）+ Taro/React H5（src），共享同一后端契约
├── server/             # 后端 API：Fastify + Prisma + PostgreSQL + LLM Gateway（含 src/app.ts 工厂 + test/ 集成测试）
├── admin/              # 运营后台：Vite + React + TS
├── loadtest/           # 隔离压测：Docker Compose + 内网网关 + k6 只读场景（默认零外部资源；真实 LLM 仅受控最小探针）
└── project/            # 原始高保真原型（设计事实来源，勿改）
```

本地生成物约定：微信源码在 `app/weapp-native/`，`app/scripts/build-native-weapp.mjs` 输出 `app/dist-native/`；Taro 只保留 H5，输出 `app/dist-h5/`。`app/project.config.json` 是发布/CLI 配置，固定 `miniprogramRoot=dist-native/`；构建还会在 `dist-native/project.config.json` 生成本地独立配置，当前微信开发者工具 RC 在外层目录热重建后若残留错误索引，手工直接导入 `app/dist-native/` 可稳定本地编译；但 `auto-preview` / `preview` CLI 必须指向外层 `app/`，直接指向 `dist-native/` 可能误报 800059 `app.js, file not found`。`app/project.private.config.json` 只放本机差异。根目录误生成的 `project.config.json/project.private.config.json`、`weapp-preview*.json/png`、`weapp-auto-preview*.json/png`、`app/.impeccable/`、`app/tarojs-cli-*.tgz`、根目录空 `package-lock.json` 均为本机/工具产物，已在 `.gitignore` 排除，不纳入提交。**不要导入仓库根目录；日常手工走查优先导入 `app/dist-native/`，CLI 预览与发布仍以 `app/` 为项目根。**

---

## 3. 技术栈

| 层 | 技术 |
|---|---|
| 微信小程序 `app/weapp-native` | 微信原生 Page/Component · WXML/WXSS/JS · Sass 构建 · Lucide 静态 SVG（问策使用 `messages-square` 双对话气泡；**登录页不得放平台品牌图形**，见 §7.2 审核红线）· towxml-stream-typewriter 1.0.3（MIT，流式 Markdown） |
| H5 `app/src` | Taro 3.6.34 · React 18 · TypeScript · Sass · Webpack5（只构建 H5） |
| 后端 `server/` | Fastify 5 · Prisma 5 · PostgreSQL · Zod · `@anthropic-ai/sdk` · tsx/tsc · 可切换大模型（默认 **Agnes 2.0 Flash**，OpenAI 兼容；后台可切 DeepSeek/Qwen…） |
| 运营端 `admin/` | Vite 5 · React 18 · TypeScript |
| 数据契约 | `shared/contracts.d.ts`（被三端 `import type` 引用） |

---

## 4. ★ 运行模式：mock vs server（配置化）

前端用一个环境变量切换数据来源，**默认 mock**，本地零依赖即可开发完整流程。

| 模式 | 行为 | 启动方式 |
|---|---|---|
| **mock**（默认） | 原生端走 `app/weapp-native/services/mock.js`，H5 走 `app/src/services/mock.ts`；均按账号隔离并落本地 storage | `cd app && npm run dev:weapp` |
| **server** | 连真实后端 REST API | `WEAPP_APP_MODE=server WEAPP_APP_API=https://你的域名/api npm run build:weapp`；生产快捷命令 `npm run build:weapp:server` |

实现要点：
- 原生小程序配置由 `build-native-weapp.mjs --mode/--api/--version` 写入 `dist-native/config/env.js`；环境变量前缀统一 `WEAPP_APP_*`。H5 继续由 `app/config/index.ts` 注入 `TARO_APP_*`，两套产物不得混目录或互相引用运行时。
- **构建身份与防误传**：原生构建写 `dist-native/junshi-build-meta.json`（`schemaVersion=2`、`runtime=native-weapp`、mode/api/apiExplicit/version/gitSha）。微信 `envVersion=develop` 时五个主 Tab 底栏上方显示后端环境角标：按当前真实请求链路区分 `MOCK / LOCAL / PREPROD / PROD`（mock 包附身切真实服务后角标同步切换），其中 MOCK 角标仍可点按切「经营中 / 空态」；`trial / release` 及无法确认版本身份时强制隐藏，体验版与正式版不得露出调试标识。正式发布统一走 `npm run release:weapp -- --version x.y.z --desc "说明"`，强制重建 server 包并校验 runtime/mode/API/`apiExplicit=true`/版本，未显式配置服务端地址或仍是旧 Taro 微信包都会被明确拒绝。`upload:weapp` 同口径校验；不得用裸 DevTools CLI 或 GUI 绕过。
- `app/src/services/config.ts`：`APP_MODE`（读已注入的 `process.env.TARO_APP_MODE`，默认 `mock`）、`IS_MOCK`、`BASE_URL`（读已注入的 `TARO_APP_API`）。不要在浏览器运行时再用 `typeof process` 包裹，否则 H5 bundle 会退回 mock/default。
- `app/src/services/api.ts`：每个方法按 `useMockApi()` 分流 mock 或真实请求（通常等价于构建期 `IS_MOCK`，附身会按下条运行时切换），**两种模式同口径**（同样的入参/返回类型）。
- **附身登录是唯一运行时数据源例外**：`api.verifyImpersonation` 无论构建 mode 为 `mock` 还是 `server` 都必须直连真实 `/me`，绝不能回退本地 `mock.me()`；server 包复用当前 API 基址（生产/预发不串环境），mock 包优先使用构建时显式配置的 API，未显式配置才固定验生产 `https://wxapi.aibuzz.cn/api`。验令通过并把三段 JWT 落入 storage 后，H5 的 `services/runtimeMode.ts` 与原生端的 `weapp-native/services/runtime-mode.js` 都会让整个会话（普通 API、文件上传、流式对话、相对产物 URL、案卷与支付环境判断）跟随该真实身份走同一服务端；退出/换回 `mock-*` token 后自动恢复本地 mock。附身 token 只由真实后端签发；仅修验令而不切后续数据源会出现“登录成功但看到 mock 账号”的假附身。
- **「快出片」分包（2026-08-10，2026-08-11 AI 共创/多句镜头/石榴 v0.120 更新）**：原生端 `packages/video` 只允许经自包含 `host.js` 访问宿主，数据源只有 `mock / bff`；真实请求始终同源到军师 `/api/video/**`，禁止恢复会把军师 JWT 发往 AIStar/第三方的 direct 模式。军师 BFF 用固定 service token + `externalOwnerId` 调 AIStar clip 域，积分只在军师侧按权威报价做幂等 hold/settle/refund。文案页 AI 对话走军师 LLM 并持久化 `scriptChat`；视觉编排统一写 `shots[{startNo,endNo,role,assetId}]`，报价、preflight、worker 与总装消费同一聚合投影。端内三套体验模板以 `catalog.js` 为唯一事实源。数字人创建主链固定为“上传一段视频 → 云端训练”：石榴 `/avatar/create` 的 `speakerId` 只是用于 demo 的选填参数，`authId` 也只在确需授权校验时选填，二者都不得阻断 Avatar 创建。AIStar 会 best-effort 从形象视频提取原声并异步创建基础 V2 声音，提取或声音训练失败只影响后续口播，不回滚形象；用户可在分身管理中独立补录/上传专属声音增强。两类素材先读 `/api/video/avatar/requirements`，端上做时长/大小前检，BFF 校验 MIME/大小，AIStar 再用 ffprobe 验真实时长、H.264/分辨率/音轨；声音真实时长必须 `>2s`（端上按整秒提示 `3s`），形象视频 `>=5s`，8–15 秒声音与 10–20 秒形象仅作软建议。克隆上传当前会发送 7 个 multipart 业务字段（含空的可选字段），服务端全局 `fields` 上限必须至少覆盖完整契约；现有上限为 16，禁止退回 5 导致尾部 `clientRequestId/expectedCredits` 被截断并报 `ERR_STREAM_PREMATURE_CLOSE`。`ClipCaptureRequirements.authorizationVideoRequired` 当前必须为 `false`；禁止恢复额外授权视频 UI、`CLIP_CONSENT_REQUIRED` 或“先采声音”硬闸。形象预览必须用紧凑容器 + `object-fit=contain` 完整展示横竖视频。出片仍需 V2 speaker：若视频原声不可用，preflight 提示去分身管理补录专属声音；avatar 走 `/video/createByVoiceV2`、b-roll 复用同一音频。训练完成可在用户主动订阅后由 `avatar-training-notification` 后台轮询并按微信 32308 模板发送一次通知，形象 ready 即视为数字人创建完成，声音不参与成功门。克隆入口显式 `mode=avatar|voice` 必须优先于旧 `step` 兼容推断；删除分身必须让 AIStar 清掉该 owner 的全部有效 Avatar/Voice 版本，不能只删最新一条让历史版本“复活”。`imageStatus=none` 只能显示未创建和上传入口，不得伪装成训练中。BFF 媒体机审只放行 `none/low`；测试期旁路只允许非 production 并留审计。AIStar v0.120 包含上述删除闭环，多段 ffmpeg 总装、字幕、可选 AI 水印、固定品牌尾卡、音轨归一、亮度/响度/真峰值门和缩略图保持不变。本人真实素材质量/耗时/成本实测、运营 preset 与平台发布未完成时不得宣称生产闭环。当前状态见 `docs/VIDEO_SUBAPP_PLAN_2026-08-10.md`。
- **「快出片」移动视觉与编排约束（2026-08-11，2026-08-14 录音声明校正）**：分包页面统一消费 `packages/video/styles/tokens.scss`，使用轻暖灰底、中性墨黑、暖橙主动作/分身、蓝色素材、绿色成功、红色阻断；间距按 8/4 点网格，卡片基线 20px 圆角与软暖阴影，点击区至少 44px。首页首屏顺序固定为“作品/素材高频入口 → 数字分身开拍条件 → 可恢复草稿 → 轻量产品承诺 → 横滑模板”：数字分身是进入制作的前置条件，不是藏在模板后的增强能力；模板详情仍允许游客浏览，但点“开始制作”时必须验 `imageStatus=ready`，否则引导创建或查看训练进度，禁止先建项目再让用户返回补分身。草稿只用紧凑进度行，模板不得纵向铺满整页，作品不得只藏在导航角落。成片播放器必须由独立外层控制宽度、内层保持真实 9:16，禁止再用固定横卡高度覆盖 `.vd-portrait`。文案页正文保持阅读焦点，AI 改稿固定为底部右侧圆形悬浮入口，点开独立纵向消息抽屉，关闭后已更新文案保留在正文，禁止重新塞回会压缩消息的内嵌横向 flex 卡。配画面默认显示已分好的高层画面段，组合编辑必须从某一当前段进入：段内勾选句子继续共用画面，取消勾选的句子单独成段，并支持全部拆开、与下一段合并；禁止回退到整稿起句/止句圈选。报价不得重新塞回占高的固定页头；确认页按准备状态、摘要、费用、扣费顺序建立信任。数字分身录音点击后先 `getSetting/authorize({scope:'scope.record'})`，只有 `RecorderManager.onStart` 回调到达才进入计时；已拒绝权限必须明确引导 `openSetting`，禁止回退为“点了没反应”。**不得**把 `scope.record` 写入 `app.json.permission`（微信官方当前只接受 `scope.userLocation`，开发者工具会把录音项报 invalid）；录音用途应在小程序管理后台《用户隐私保护指引》按真实调用申报。改视觉时不得回退胶囊避让、底部安全区、overlay 生命周期与 server/mock 构建边界。
- **「快出片」合并镜头字幕（AIStar v0.126，2026-08-11）**：`shots` 只决定视觉素材是否共用，不得吞掉句级字幕。AIStar `ClipShotPlan.materialize()` 必须保留 `captions[{sourceNo,text,durationSec}]`；总装按该 shot 的真实音频总时长等比换算各句时间窗，并用独立 overlay 逐句烧录。禁止再次把聚合 `text` 直接画成一张最多两行的字幕图；测试模式也必须走同一时间轴且不得调用石榴。
- **「快出片」当前预发基线（2026-08-11）**：AIStar clip 为 `f5e21ee5-20260812T031204Z`（v0.129、force-mock=false、active/running、`NRestarts=0`），作品生成时间与可重试的取消/删除已上线，AI 水印缺省关闭且测试演示标识独立保留；军师预发后端为 `0c902ad`（active/running、`NRestarts=0`，公网 health 与 pgvector 2/2 正常），API 固定 `https://wxapi.aibuzz.cn/api_preprod`，同 SHA 原生 server 包已 auto-preview 到 AppID `wx810ebe6dfef8e75f`。后续回归不得拿 mock 包冒充本人素材验收。
- **「快出片」AI 改稿真实性（2026-08-11）**：`server/src/services/video/scriptChat.ts` 必须使用带 Zod 校验、修复轮和足量输出预算的结构化生成；6–10 段 JSON 不得复用 700 token 辅助默认值。用户明确说“换成/改成某行业、门店或产品”时必须生成完整新稿并移除旧主体。结构化输出失败可以保持原稿并提示重试，但严禁把原稿重新分段后写 `applied=true`、显示“已更新文案”。
- **「快出片」AI 改稿预发基线（2026-08-11）**：军师预发后端为 `3b0ea28`，服务 active/running、`NRestarts=0`，公网/本机 health 均正常；当前真机 server 包 `385c863` 无需重推即可调用该后端。旧项目 `scriptChat` 中的假成功历史只作记录，不会自动改正文；用户下一轮消息从当前真实稿继续。
- **「快出片」AI 水印偏好（2026-08-11）**：`ClipProject.subtitleStyle.aiWatermark` 是成片右上角“AI 生成”可见水印的唯一真源；新项目显式为 `false`，历史项目缺字段同样按关闭。确认页切换后必须先保存成功才能出片；AIStar 正式/测试总装、作品 DTO、作品页角标和发布提示均消费同一值，禁止任何一层自行默认开启。测试媒体的“测试演示”标识不受该开关影响。
- **「快出片」形象预览（石榴 v0.121，2026-08-11）**：上传形象视频时必须在供应商调用前抽取约 0.5 秒的 JPEG 预览帧并保存到 `DapAvatar.imageKey`，`ClipAvatarView.imagePreviewUrl` 供首页和分身管理页以 `aspectFill` 展示用户真实形象；历史记录缺预览时由 `GET /avatar` best-effort 从保留的源视频补抽帧。删除分身必须同时清理源视频与预览帧；抽帧失败必须在创建石榴任务前明确失败，不能耗点后才报错。
- **「快出片」配画面素材展示（AIStar v0.125，2026-08-11）**：微信 `tmp_*`、`wxfile://`、长哈希路径只属于传输层，禁止进入画面卡和出片预览；端上统一经 `assetDisplayLabel` 收成可读素材名。AIStar 为视频素材抽取独立 JPEG 缩略图，`ClipAsset.previewUrl` 对图片返回原图、对视频返回缩略图；`contentUrl` 只在用户主动点开时用于播放原视频或查看图片。素材库、配画面已选卡和出片预览必须展示真实封面且可以打开；素材库挑选态仍以整卡点击完成选择，但封面保留独立预览入口，“更换”也不得与打开素材共用同一点击动作。出片预览必须使用“固定头部 + `min-height:0` 独立滚动区 + 固定安全区底栏”，按钮不能覆盖最后一个画面段。
- **「快出片」专属声音状态（AIStar v0.124，2026-08-11）**：`ClipAvatarView.voiceSource` 必须区分 `video`（形象视频自动提取的基础声音）与 `dedicated`（用户主动补录的专属声音）。分身管理页对已有训练任务每 5 秒只读轮询，训练中展示百分比且阻止重复提交；完成后展示“已增强”、完成时间和“重新录制”，失败展示上游可读原因与重录入口。不得把专属声音已完成状态继续写成“提升”，也不得由轮询创建任何供应商任务。
- **「快出片」作品、模板与多数字人（AIStar v0.129，2026-08-11）**：我的作品默认必须是“全部”，再提供“生成中 / 已完成”筛选；`done/published` 都属于已完成，成片缩略图缺失时 AIStar 必须从最终 MP4 补抽，列表用真实 `thumbnailUrl`。作品 DTO 必须同时返回任务 `createdAt` 与成片 `generatedAt`，端上按设备时区显示到分钟；生成中显示开始生成时间，完成/发布显示真正的成片时间，不得用发布或最后编辑时间冒充。每张作品卡提供独立 44px 删除入口并二次确认，`DELETE /video/works/:id` 会取消该项目全部活跃任务、把项目移入 30 天回收区并立即从列表消失；AIStar 必须回传本次实际取消的 jobId，军师 BFF 只逐单幂等退回这些活跃任务对应的未结算预扣，已完成或已结算成片删除不退款；删除点击不得冒泡打开作品。模板详情与创建项目必须消费同一 `scriptSkeleton + tailClips`：运营可通过 AIStar `/api/admin/clip/preset-assets` 上传固定视频并在模板 `tailClips` 绑定 `assetId`，接口必须回传固定片段名称、秒数、封面和视频地址；模板详情必须允许点封面直接播放固定视频，内置模板可只补缺失的竖屏固定视频，禁止覆盖运营配置。数字分身是列表模型：`/video/avatars` 返回多个形象，创建时可选择已有 ready 声音，单个形象可独立更换/删除；项目 `avatarId/voiceId` 必须一起保存，配画面页选择形象时展示真实预览并自动带入其关联声音，报价、预检和 worker 必须解析项目指定的 engineRef，禁止再静默取“最新分身”。
- **「快出片」生产基线（2026-08-12）**：军师生产为 `ae99c3e`，AIStar clip 为 `49cb2086-20260812T112519Z`，两服务 active、`NRestarts=0`；AIStar 数据库到 V15，军师 BFF 以短时 JWT 只读探针可返回 `ct_shouyi / ct_kaimen / ct_shiti` 三套模板。微信开发版 `0.2.32` 已上传 AppID `wx810ebe6dfef8e75f`，指向 `https://wxapi.aibuzz.cn/api`。生产已配置石榴与军师→AIStar 服务鉴权；媒体机审未配置时默认 fail-closed，但测试阶段经用户明确授权已同时设置 `CLIP_MEDIA_MODERATION_BYPASS=true` 与 `CLIP_MEDIA_MODERATION_ALLOW_PRODUCTION=true` 临时放开，所有素材仍写 `operator-bypass` 审计。单开任一项不得生效；正式机审接入后必须双关。合规竖屏探针已完成上传 200、删除 200，未调用石榴生成。
- 两端各有一份同契约 mock 后端：H5 为 `app/src/services/mock.ts`，原生为 `app/weapp-native/services/mock.js`。原生 mock 必须按账号隔离并持久化登录/档案/首判/会话/案卷/军令/目标/经营回填/方案与版本/资料与引用/数据源/模块/SKU/处方/战略账本/海报任务与图库/命盘；所有点击后提示成功的动作都必须能在刷新、回到列表或切换账号后看到相应真值，禁止用 `{ok:true}` 或空数组伪装完整流程。**作品类数据不得自动预置成品**：海报作品库只显示当前 mock 账号亲手创建的任务，旧 `mock-poster-seed-*` 本地记录读时清除；任何真实 JWT 会话仍由 `runtime-mode` 强制切到 server，严禁把 mock 夹具下发给真实用户。智能体/成果文案仍以服务端镜像同步工具保护的字段为准，行为与本地展示夹具允许按平台分别实现，但接口入参与返回结构必须同契约。
- mock 模式下登录/数据按 `mock-<手机号>` token 隔离并持久化，可切换账号验证隔离；新 mock 账号的 `/me.user.name` 必须保持空值，直到用户在注册补全页保存真实称呼，禁止用「主公」等展示兜底名冒充已完成身份资料、从而跳过头像/称呼与首次入局。
- weapp + server 模式下登录弹层优先提供「微信账号登录」：原生端用 `wx.login` 取 code，H5 保持原 Taro 适配；后端 `/auth/wechat-login` 调微信 `jscode2session` 换 openid/unionid 并签发自有 token。
- **H5 与小程序是两套前端实现、同一后端契约**：H5 零后端走查 `npm run dev:h5`；连后端测真实变更 `npm run build:h5:server && npm run serve:h5`（→ http://localhost:5173）。H5 用 hash 路由，产物在 `dist-h5/`；微信问题必须回到 `weapp-native` 与 DevTools/真机验收，不能再用 H5 代替平台行为验证。详见 `docs/TESTING.md` §五。

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
- **登录身份契约（2026-08-15 手机号唯一身份）**：`LoginResult.phoneBinding?: LoginPhoneBinding` 只由手机号快捷登录返回，区分 `matched / placeholder_upgraded / wechat_relinked`（`mismatch` 已删除）。`wechat_relinked` 表示登录已按本次授权手机号进入对应账号，而本次快捷登录的第三方身份此前挂在另一个账号上、已自动迁绑过来：客户端只做非阻断说明并告诉用户原账号可用原手机号验证码登录，不得据此改写账号归属。两个手机号字段均为脱敏展示值。
- **问策入口契约（WP1）**：`WenceForm = 'control'|'dock'|'chat'` 是问策入口 A/B 分组，挂在 `FeatureFlags.wenceForm`（`/me.features`）——**服务端按 userId 稳定分桶后下发，客户端不猜**。开关**关**一律 `control`（零改动现状）；开关**开**但权重未配/非法按三臂均分兜底，不回 control。`SessionMessage.chips?: string[]` 是主动消息的快捷回应，服务端从 `Message.contentJson.chips` 原样透出（当前唯一写入方是 `POST /sessions/proactive`）。另有 `WenceHint/WenceHintsResult`、`ProactiveResult`、`ClientEventName/ClientEventRequest`、`AdminWenceTemplate*`。`WenceHintsResult.guestForm: 'control'|'chat'` 是**游客**的形态（游客没有 `/me`，也没有稳定 userId 可分桶，所以只回答「chat 这条臂开没开」，不把游客塞进三臂分流；`'dock'` 不下发，它与 control 同属列表渲染路径）。登录后端上必须改读 `/me.features.wenceForm`。
- **问策入口预发基线（2026-08-11）**：预发库 `feature_flag.wence_entry` 已显式设置为 `enabled=true`、`payload.arms={control:0,dock:0,chat:100}`，游客与登录用户均全量进入新版“对话即 Tab”，不再参与旧列表 A/B；`GET /api_preprod/wence/hints` 已验证 `guestForm=chat`，`junshi-api-preprod` active、`NRestarts=0`。原生 server 包 `9078b02` 已指向 `https://wxapi.aibuzz.cn/api_preprod` auto-preview 到 AppID `wx810ebe6dfef8e75f`。
- **连续会话与渐进交付契约（2026-08-10）**：`SessionDetail.page` / `SessionMessage.at` 支撑尾页 100 条与复合游标向上分页、可重算视觉分章；`FeatureFlags.conversationContinuity` 是跨 24h 同 Session 的逃生开关（默认开，关后走新 Session + handoff）。`UserFact*` / `FactConfirmation*` 承载可审计事实状态和独立确认卡；`RequestedOutput` / `DeliveryMode` / `ComplexityAssessment` / `DeliveryStage` 将“要不要成果”与“一次还是分阶段”解耦；`GenerationView.imageProgress/refNotices` 和 `AttachmentCapabilities` 承载 9 图进度、失败序号及服务端权威限制。

> 约定：任何新增/修改的接口字段，先改 `shared/contracts.d.ts`，再改实现。

---

## 6. 账号与数据隔离

- **登录与游客态（2026-08 合规重构，默认微信优先）**：冷启动与五个主 Tab 不再自动弹登录；游客可浏览军师与开场白、每日一句、能力目录、套餐价格、协议/隐私/客服，只有发送对话、查看历史/搜索、上传/保存、执行、购买或维护档案等动作才打开可关闭的 `Login`，并用 `AuthReason` 明示本次目的。登录层右上角与遮罩均可退出，关闭后留在原页且不丢对话输入；页面本身**不得反复写「不登录也能看」「公开浏览」「游客浏览」等权限解释**，个人内容缺失统一用 `AsyncState` 的业务空态。原生微信主按钮固定为「微信手机号一键登录」：未勾协议时只是普通按钮并提示先同意，勾选后才渲染 `open-type=getPhoneNumber`；一次点击取得 `phoneCode`，同时 `wx.login` 取 `loginCode`，统一交 `POST /auth/wechat-phone` 完成手机号注册/登录并关联 openid，禁止先创建无手机号微信账号、再到第二页重复补绑。拒绝手机号授权时保留手机号短信验证码登录/注册兜底。**新账号身份与入局主链恢复**：一键或短信登录成功后若账号没有称呼，只进入“先让军师认得你”补称呼与可选微信头像；手机号此时已经绑定，不再重复询问。保存后，权威 `onboarded=false` 自动进入「择本命色 → 填行业/营收阶段/痛点 → 军师首判」。已存在称呼的老账号不重复强拉补全，仍可在设置里绑定/更换手机号（`POST /auth/bind-phone`，跨账号占用返回 409 `PHONE_TAKEN`）并修改头像、称呼、公司和本命色；原生设置页的头像与称呼必须分别使用平台 `chooseAvatar` 与 `input type="nickname"` 组件，复用注册补全页同一授权口径，禁止退回普通 `chooseMedia` 冒充微信头像选择。登录层不承载运营附身入口；附身只保留在设置页长按版本号。新账号仍自动建独立租户+用户；是否自动开通套餐只由 `TEST_DEFAULT_PLAN_NAME` 决定，未配置时不赠送套餐或额度。
- **账号归属与换号铁律（2026-08-15 改口径，覆盖 08-14 旧规则）**：**手机号是唯一的用户身份识别**，openid/unionid 只是附着在账号上的第三方绑定，绝不单独决定账号归属。`POST /auth/wechat-phone` 一律按本次授权手机号定位账号：命中真实号账号即进入（`matched`）；历史 `wx_<openid>` 占位号首次补真实号时升级（`placeholder_upgraded`，占位号只允许升级，**不得再新增**）；本次的第三方身份此前关联着另一个账号时自动迁绑到当前账号并返回 `wechat_relinked`，端上只做非阻断说明、不阻断登录。因此该接口不再返回 `PHONE_TAKEN` / `WECHAT_ACCOUNT_CONFLICT`。`POST /auth/wechat-login`（纯 code 登录，Taro H5/PC 在用）只放行已关联的账号，未关联返回 404 `PHONE_LOGIN_REQUIRED` 且**不建号**，端上转手机号验证码登录，成功后第三方身份自动附着。账号 `phone` 仍不得被静默变更：换号只能走设置里的显式 `POST /auth/bind-phone`，用新号码短信验证码（`scene=bind`）确认，老号失效也不能把用户锁死，跨账号占用返回 409 `PHONE_TAKEN`；数据库故障不得吞成登录成功。
- **登录关闭按钮必须避让微信胶囊**：`Login` 是全屏自定义层，右上关闭按钮不能固定贴右；打开时读取 `getMenuButtonBoundingClientRect()`，与胶囊垂直居中并放在其左侧 12px，H5 / 旧基础库才使用 `safe-area + right:18px` 兜底。不要把按钮移回胶囊右侧、上方或同一命中区。
- **测试期默认套餐**：服务端设置 `TEST_DEFAULT_PLAN_NAME=决策版` 后，微信/短信/本机号等所有新注册入口统一在建号事务中开通指定套餐并发放完整额度；存量低档用户运行 `npm run db:grant-test-plan -- --plan=决策版 --apply` 升级，脚本保留有效同档和企业私有化用户，不重复发放、不降级。测试结束后清空环境变量并重启 API，新注册即恢复默认不送套餐。
- **无套餐首次入局例外**：`PLAN_WRITE_GATE` 仍默认禁止无套餐账号的业务写操作，但为了让默认不送套餐的新账号能完成「择色 → 立案卷 → 首判」，对 `state=none` 精确放行 `PUT /me`、`PUT /me/color`、`POST /me/avatar`、`PUT /profile` 和 `POST /quickscan`；不使用 `/me/*` 宽前缀。`/quickscan` 仍由 `grace:'quickscan'` 限制无额度时每日仅 1 次保底，第 2 次返回 `INSUFFICIENT_QUOTA`；套餐已过期用户不享受该例外，仍返回 `PLAN_EXPIRED`。
- **Token**：演示版 `token = userId`，前端存 `junshi.userId`，每次请求带 `x-user-id` 头。
- **隔离**：后端 `resolveUser` 严格按 token 解析，**无/失效 token 一律 401**（无 demo 兜底）；所有业务查询按 `userId/tenantId` 过滤。
- **微信密钥**：`WECHAT_MINI_SECRET` 与消息推送 `WECHAT_MESSAGE_TOKEN` 只在服务端环境变量保存；微信 `session_key` 仅服务端换取时使用，**不下发前端**。
- **方案购买 / 支付（2026-08-02 新口径）**：小程序「我的 → 方案与权益」固定展示当前方案、服务端计算的月度使用百分比/恢复日和手动购买口径；不展示 Token、精确次数、内部阈值或成本公式。`Plan.planFamilyKey/tierRank` 是商业关系唯一真源，`usageLevel/usageLabel` 只负责「标准/5x/20x/扩展/专属用量」表达；同 family 月/年档的月度权益由后台原子同步。用户态 `GET /plans/options` 返回 relation/action/待支付状态，`POST /plans/:id/quote` 基于 `PlanEntitlement` 真实来源账本给出折抵与 `quoteFingerprint`，下单带 `clientRequestId + expectedChargeAmount`，改价、来源权益或目标条款变化一律 409 `QUOTE_CHANGED`。回调按订单锁 + `entitlement:<userId>` 锁串行，不同订单同时到账也累计时长；同 intent 并发只保留一单且关旧单排除自身。续期/同档月转年只延时长，不重置当月钱包或重复发当月钻石；年付钻石随激活锚点按 `(userId,periodKey)` 惰性幂等月发。退款按 `refund_requested → refund_processing → refunded|refund_closed|refund_abnormal` 流转，只有微信 SUCCESS 且全额才按来源账本撤权益；scheduler 主动查退款补偿。回调验签 fail-closed，支持自动平台证书、匹配序列号的静态证书或微信支付公钥，时间戳限 5 分钟，金额/appid/mchid/transactionId 缺失或不一致拒绝入账；所有微信 HTTP 调用 5 秒超时。production 若开启 `PAY_MOCK_SUCCESS/PAY_SANDBOX/ALLOW_DEMO_PURCHASE` 任一项直接拒绝启动。运营用户详情只用「临时增减 + 原因 + 可选失效时间」调整内部额度，恢复套餐标准保留已用量；旧覆盖式接口只留兼容，不再由新 UI 调用。存量套餐先运行 `npm run db:backfill-plan-commercial` dry-run，复核后再加 `--apply`。
- **自动续费（覆盖上一条中的“手动购买口径”旧描述）**：方案确认页由用户主动二选一——「单次购买」只买当前周期、到期手动续费；「自动续费」走微信官方 V2 委托代扣。默认永远选单次购买，自动续费不得预选；端上最终下单前再次用 `effectivePurchaseMode` 收口，能力不可用时即使残留旧状态也强制走单次购买。首单走 `/pay/contractorder` 支付中签约，签约结果由独立 XML 回调确认；回调迟到/丢失时用正式开放的 `/papay/querycontract` 按模板 ID + 商户协议号补激活，已付款 pending 至少保留 6 小时，不把合法迟到签约误判失败。签约首单与普通支付共用购买意图幂等规则：同 `clientRequestId` 必须逐项匹配套餐、金额、报价指纹与条款哈希，并校验 `created` 状态和 2 小时安全窗口；只有完全相同且仍可支付的重试才复用原 `prepay_id`，终态、过期或变更载荷均返回 409。同一意图并发只允许一个请求向微信创建首单，另一请求在 `prepay_id` 写回前返回 `ORDER_CREATING`，避免重复外呼。周期单在权益到期前 24h 走 `/pay/pappayapply`，扣款回调和 `/pay/paporderquery` 主动查单共用 `PaymentOrder` + `markPaidAndApply` 幂等发放（代扣订单查询接口当前由微信灰度开放，未获权时回调仍是主链路）。`SubscriptionContract` 保存协议状态、签约金额/条款哈希和下一扣款锚点；`PaymentOrder.payMode` 区分 `jsapi/contract_initial/papay_recurring`。签约与扣款回调验 V2 签名，并按各回调实际字段校验 mchid/openid/模板/协议号/金额；scheduler 负责续费申请、单周期最多两次尝试、补查、待解约重试以及“只付款未签约”pending 清理。只有明确业务失败才允许第二次尝试；`SYSTEMERROR`、网络超时、响应验签/解析失败等结果不确定场景保留原单待查，禁止换单导致双扣。用户确认关闭即清空 `nextBillingAt`；远端结果不确定时保持 `cancel_pending` 停扣，由 scheduler 重试而非恢复 active。后台改价、手动换档或退款同样先停扣并补做微信侧解约，旧授权不静默扣新条款。只有 APIv2 Key、两条回调、微信权限、套餐开关和模板 ID 全部齐全时 `papayConfigured=true`；否则 C 端隐藏自动续费，v3 单次购买不受影响。配置见 `server/.env.example`，上线清单见 `docs/DEPLOYMENT.md` §5.1。
- **智能体开通**：`free`/`metered` 智能体无需开通即可用；`unlock` 智能体需用户确认启用（`POST /agents/:key/purchase`）或运营后台开通后才能对话/产出，未开通产出返回 `403 AGENT_LOCKED` 且不落会话。**启用本身不收费（2026-08「确认即启用」）**：对话走 token 额度、出品走钻石计费，启用只落 `UserAgent`（`pricePaid` 恒 0），不再有扣费事务与 402 分支；`Agent.price` 仍供 `metered` 与后台展示用。
- **离线兜底**：server 模式下后端不可达时，登录回退为 `local-<手机号>` 本地会话，保证可体验（无服务端数据）。
- **退出登录**：「我的」页底部。
- 端到端隔离已验证（见 §11）。短信验证码已接入；生产仍应把 `token=userId` 换成 **JWT**，路由隔离逻辑不变。

---

## 7. 前端（app）架构

### 7.1 页面与导航
Tab 页（自定义导航 `navigationStyle: custom` + 自定义底栏 `custom-tab-bar`）：

底栏顺序（2026-08-12 IA 重排定稿）：**问策 · 战局 · 锦囊 · 图籍 · 主公**（五个平铺 tab，无中间凸起按钮；`store.tab` 索引 0..4 按此顺序，唯一定义在 `services/tabbar.js`）。图标：问策 counsel / 战局 sandtable / 锦囊 brocade（束口袋）/ 图籍 **codex**（两册线装书，2026-08-12 新画，取代借用的打勾名册 muster）/ 主公 lord。新增底栏字形要同时改 `src/components/Icon/index.tsx` 的 PATHS 与构建脚本的 `CUSTOM_TAB_ICONS`（抽不到即构建失败，不静默回退 lucide）。战局 = 原沙盘+点兵合并（`pages/home`）；锦囊 = 新作品页（`pages/pouch`，方案/海报/成片聚合，规则「第一次归军师，第二次起归锦囊」，能力不设货架）；图籍 = 原 thinktank 收窄为资料+数据源。`pages/studio` 已降为过渡跳转页。启动页为 `pages/sessions`（进小程序默认落到首位「问策」tab，登录门/建档弹层由对应页面承接）。

五个 tab 的页头统一由 `components/TabHeader` 渲染（对齐最新交互原型 `header`）：**一行小字用途（本命色，字距 .3em）+ 大字 tab 名（宋体 29px）+ 背景一枚大字（本命色 100px / 透明度 .1，贴右上）+ 底部细线**。背景大字要**整字露出，不许裁字脚**：`.th-glyph` 的字号（字身 ≈.93em）与 `.tab-head` 的 `margin-bottom` 是配套的——字身要落在细线之后的留白里，改任一个都要核另一个，也不要给标题区加 `overflow:hidden`。字再放大就必然压到下方第一块内容上，而五个 tab 里有三个（问策 NextStepCard / 军情 battle-hero / 老板 用户卡）是深色不透明主卡，做不成半透明透字，所以字号以「整字放得下」为上限。**页头零按钮**——原型右侧那枚「行业 tag」是装饰，按定稿去掉；`TabHeader` 也不再提供 `right` 插槽，任何功能入口都必须回归它所属的内容区（见下表「原页头入口去向」）。三要素定义在各页调用处，勿散落到样式里：

| Tab | 大字 | 小字用途 | 背景大字 | 原页头入口去向 |
|---|---|---|---|---|
| `pages/sessions` | 问策 | 有事问军师 | 谋 | 历史 → 搜索行右侧 `.council-hist`（翻旧对话与搜索同属「找东西」，且是旧线程唯一入口）。**仅 control 形态**；`wenceForm='chat'` 终态用的是自绘页头（kicker 换成对话对象身份 + 右侧双入口），不是 `TabHeader` 实例，见 §7.2 |
| `pages/home` | 战局 | 看今日判断，做今天的事 | 势 | 案卷 → 主公 tab；↻ → 「三势判断」段头 `.force-redo`「刷新判断」（它调 `refreshForces` 重算三势，不是简单重拉） |
| `pages/pouch` | 锦囊 | 军师替你出的妙计 | 计 | 新页无历史入口 |
| `pages/thinktank` | 图籍 | 军师断事的依据 | 籍 | 本来就没有 |
| `pages/profile` | 老板 | 你自己 | 我 | 设置 → 「系统」菜单组首行 |

| Tab | 页面 | 说明 |
|---|---|---|
| 对话 | `pages/sessions` | **★ 按 `/me.features.wenceForm` 分形态（问策入口改版 WP3'，2026-08-08；连续会话升级 2026-08-10）**：`'chat'` → 终态「总军师对话即 tab」；`'control'` / `'dock'` / 字段缺失 / 取数失败 → 现状军师列表（灰度回退前提）。游客读 `GET /wence/hints.guestForm`，登录后读 `/me.features.wenceForm`；本地缓存只为防冷启动闪屏。终态结构为自绘合一页头 + `chat-core` 消息流 + 提示问题 pill + 底部合体浮岛 + 军师团/历史半屏抽屉；游客开场只在本地，发送才登录。<br>**24 小时只分章、不再断链**：`features.conversationContinuity` 默认 true，已登录冷进始终续接最近 `agentKey='general'` 主线 `Session.id`；运营关闭该开关时才在跨 24h 后创建新 Session，并由服务端 `SessionHandoff` 继承上下文。`SESSION_IDLE_HOURS=24` 且无未读只决定是否在底部显示临时“新的一次问策”；首条用户消息发出后分隔归属到该消息。历史分隔由 `SessionMessage.at` 即时重算，只允许画在跨 24h 的用户消息前，不创建假消息、不进摘要；`refreshChat` 绝不跨整点突然分章。服务端建单会按上一条真实消息时间冻结 `newChapter/chapterGapHours` 供 trace 核对，但不驱动渲染。<br>**长主线读取有界**：`GET /sessions/:id` 首屏只回最后 100 条，按 `(createdAt,id)` 游标向上翻；分页接缝会重新计算章节，模型历史仍独立保持最近 16 条/12,000 字符预算。历史抽屉主行=会话标题 + 未读角标，辅行=军师花名 · 相对时间，第三行=snippet，均单行省略；control 仍读 `preview`。<br>无会话才走 `POST /sessions/proactive` / greet；切 tab 回来只同步角标，不重复 boot。现状列表仍为 `TabHeader` + 搜索/历史 + 快捷补给 + 动态军师目录；业务快捷入口默认续接最近线程，只有用户明确“新对话”、参谋室派单或项目内新建才使用 `fresh=1`。 |
| 战局 | `pages/home` | **2026-08-12 起 = 沙盘+点兵合并页**，判断在上、军令在下：`TabHeader`（战局 / 看今日判断，做今天的事 / 势）+ 军师判断 hero（两个动作：问军师 / 判断依据抽屉）+ 军令处方条 rx-strip（`/prescriptions`，军师配兵器）+ 三势一行 force 3 卡（点开=合参 sheet，天势一栏 `fortuneOn && chart` 时参命盘）+「现在不能做」nono 卡。**metric 3 卡、证据链、待补问题、经营数据 kpi 全部收进「判断依据」抽屉，不再平铺** + 军令执行区【`今日军令 / 本周` 两段 —— 今日段=军令卡（带兵器条）+ 数据回填 + 手动加令（showModal）；**本周段=打卡机制**：七日连续条（按日历固定七格，实心/半实/空心/虚线四态，今日带光圈）+ 连续复盘天数 + 本周完成 x/y + 按天军令记录】+ 复盘入口（抽屉内含三势检查、决策验证、周经营数据、目标阶梯、每日战报、提醒）。**已删除**：命盘/时运两个 mode 面板（常驻入口迁主公，情景入口留三势 sheet）、关联模块货架、创意 agents 货架、横滑战役卡组、today-focus、「下一步」卡（journey 在小程序端已无消费方）。|
| 锦囊 | `pages/pouch` | **作品页（2026-08-12 新建，主包 tab）**：顶部「最近做的」跨来源横滑流（posters + video works + reports 归一化混排，带缩略图——海报 `poster.previewUrl` / 成片 `thumbnailUrl`，缺图或 `binderror` 落回类型插画；分类型动词：海报「再来一张」/成片「再出一条」/方案「改一版」）+「手艺」两列宫格（固定子应用格：快出片/海报快印/方案报告 + `type='creative'` agents 动态格）。识别靠 `src/assets/craft/*.jpg` 插画贴片（imagegen 生成，随 ASSET_ROOT 进产物），卡体一律白卡；**卡片宽高写死、标题单行截断、角色行定高两行**，长文案不许撑卡。**铁律**：置灰格不标价、无开通按钮，点击跳问策军师导览；本页不设任何能力货架，分发规则「第一次归军师，第二次起归锦囊」。**游客态整页只出一屏登录引导**（2026-08-12 产品决定）：锦囊装的是账号私产，游客看到的本来只是空架子，与图籍同一口径；游客态不取任何数（连 `/agents` 都不请求）。登录门铁律仍守住——主线留给游客：问策本地开场、发送才登录，战局有游客引导空态。|
| 图籍 | `pages/thinktank` | **2026-08-12 收窄为家底页**：`TabHeader`（图籍 / 军师断事的依据 / 籍）+ seg 2 分区【家底=上传区 + 三阶段整理流 + 知识库 · 数据源=绑定目录单卡行】。**能力中心与方案存档两个 segment 已删**（方案归锦囊，能力开通只发生在军师推荐现场）；`openSkuPurchase`/`waitSkuApplied`/`api.skus()` 保留——深度整理的 `SKU_REQUIRED` 分支仍依赖；游客兜底 segment 0。`/modules`、`enableModule` 现无 UI 消费方（见 §13 TODO）。资料上传后明确引导「帮我整理这批资料 → 待确认 → 确认入库」；空间额度卡按剩余字节向下取整为整数 MB，并同时展示可用/总量（如上传 20KB 后显示 `199/200MB`），避免四舍五入掩盖已占用空间；新上传以客户端源文件名写入 `KnowledgeItem.fileName`，微信临时路径不落库；历史缺失源名的记录在智库、资料库列表和资料详情统一使用有效 `fileName`，过滤「上传资料」及 `growth资料` 等分类 key 占位名后，优先用 Markdown 首标题生成带“按正文标题识别”标记的名称，再回退中文分类名；mock 上传也保留源文件名。确认前预览对所有文档统一只显示内容文本：PDF/Word/Excel/CSV/TXT 用提取结果，Markdown 去除格式标记，HTML/HTM 去掉标签、样式和脚本并保留标题与正文；长正文使用限高 `ScrollView` 在预览框内滚动并按父卡片宽度断行，防止源码、长链接或代码撑破页面。确认按钮按当前条目 ids 提交并二次确认，不依赖刷新后会丢失的 `activeBatch`，提交期间显示“切片并建立索引”状态并用同步锁禁止重复确认、上传和阶段切换。三个整理阶段使用容器、强调色边框和底部指示条区分选中态。|
| 我的 | `pages/profile` | 对齐设计稿 `page-profile`：`TabHeader`（老板 / 你自己 / 我）+ 本命色用户卡（头像/称呼/公司/套餐）+ 经营统计 3 卡（案卷/方案/资料真实计数）+ 权益额度 3 卡（钻石/本月用量百分比/套餐均进入独立 `packages/work/plans` 方案管理页；原 `components/Plans` 弹层已删除）+ **战略段位卡（WO-03 冷启动延迟曝光：仅 `streak≥3 或 usageDays≥14` 才渲染）** + 菜单（档案[fortuneOn 时含命盘报告+天时日历]/锦囊入口/品牌资产/数据授权/**设置**/已启用的兵器[原模块管理，账单视角]/订单明细/送你一卦/提醒日历/本命色/企业版/退出登录）+ 军师社群主题卡 + 进阶能力主题卡 |

非 Tab 页：`pages/chat`（对话流 + 渐进式成果卡 + 参谋室协同导轨「派单/回总军师/转成军令/补上下文」+ 成果卡下「就按这个来→存方案库+生成本地案卷军令→去执行」）、`pages/brief`（军师档案详情）、`pages/settings` 留在主包；我的案卷（列表/详情，前台名词=案卷，工程模型仍是 Project）、方案库、方案详情、资料库、数据源绑定、模块市场、送你一卦、军师社群已拆到 `packages/work/*` 分包（`projects`、`project`、`library`、`report`、`knowledge`、`credits`、`bindings`、`market`、`gift`、`community`），由 `pages/profile`、`pages/thinktank` 与 `pages/chat` 预加载。`packages/work/quickscan` 初诊结果 CTA 统一用「继续问策，完善这份判断」进入总军师，不向用户暴露固定对话轮数。完整履历 `packages/work/dossier` 的个人档案/我的页入口必须反馈分包跳转失败和导航锁等待状态；页面读取失败展示可重试状态并走 `handleApiError`，首次无缓存但已有档案线索时直接自动生成，不得被手动按钮的 `ready` 门禁拦截。

**对话核心 `weapp-native/chat-core/`（主包，2026-08-08 抽取）**：分包可以引用主包，反向不行——所以问策对话的可复用部分必须住在主包。四件物：`behavior.js`（Page Behavior，基础库 2.9.2+；承载消息加载/规范化、发送、SSE 流式对接、生成态/停止/重试、键盘避让、粘贴归卷、asks 问答卡、成果卡闭环）、`message-list.wxml` 与 `composer.wxml`（`<template name>` 模板库，宿主页 `<import>` 后按各自 data 渲染）、`chat-core.scss`（可共享样式，宿主页 `@use`）。宿主页只留**页面专属**的四件事：导航参数解析（解析完交给 `chatCoreLoad(config)`）、页头、返回键、滚动容器（`scroll-into-view` 留在宿主页，避免流式 180ms 自动滚底把整张消息列表带进重算）。`packages/main/chat` 是第一个宿主，`pages/sessions` 的问策终态是第二个。两条硬约束：① 模板里绑定的 handler 名必须与 behavior 提供的方法名一致，`npm test` 会逐个核对；② 模板自己没有 json，用到的 `native-icon / markdown-text / report-card / towxml` 由**宿主页**注册，测试逐标签核对。towxml（568K）仍留在 `packages/main/vendor/towxml` 分包，主包的 chat-core 不得反向 require 它——由宿主页 `useStreamRenderer({ setMdText, setStreamFinish, stopImmediatelyCb })` 注入。

chat-core 的四项对外能力（WP3' 追加）：
- **`chatCoreLoad({ localPrelude })`**：宿主页本地合成的开场 assistant 消息数组（`{ text, chips }`），**只在内存渲染、零服务端写入**，供游客态使用。
- **`SessionMessage.chips` 快捷回应**：`normalizeMessage` 把 chips 带进消息对象，`message-list.wxml` 渲染成一排；点击 = 以该文案代用户发送。作废判据只有一条——**本会话里出现过 user 轮就不再显示**（`chipsSpentFor`），重进会话自然收敛，不另存标记。宿主页必须把 `chipsSpent` 传进模板，否则 chips 永远不消失。
- **`sendText(text, entry)`**：代发一段既有文字（chip / 提示 pill）。有草稿时拒发并提示（不许静默覆盖用户正在写的话）；**未登录时写 `_pendingPrompt` 而不是 `_draft`** 并弹登录门——textarea 非受控，往 `_draft` 里塞一句屏幕上看不见的话，用户登录回来会看到「空输入框 + 发送键亮着」。
- **`chatCoreEvent(name, props)` 事件出口**：behavior 只发 `send` / `chip_tap` / `attach_open` / `prelude_show`，映射与上报都在宿主页实现（chat 分包页不实现 = 不埋点）。**对话核心自己不得调 `api.track`。**

**towxml 未接上时不许白屏**：`useStreamRenderer` 记账三个回调是否都注入到位（`hasStreamRenderer()`）。没接上（宿主页没注入、或跨包 `require.async` 失败）时 `ensureStreamItem` 不发 `streamRenderId`，模板退回 `markdown-text`，由 `updateStreamText` 以 120ms 节流回写正文——这条降级路径明知违反「SSE token 到达不整段 setData」的口径，但比一个永远不出字的空气泡强；正常路径永远走 towxml 增量解析。

命盘报告 `packages/work/mingpan` 的「修改生辰」表单必须紧跟命主档头渲染，并在从档头或报告中段入口展开后自动滚到表单起点；禁止把表单放在八字、紫微、印证和时间轴之后，让用户点击上方入口却去页尾找编辑区。

静态目录数据：`src/data/operatingSystem.ts`（模块市场/Skill 市场/知识分类框架/数据源目录/对话引导，均为能力目录与引导态文案，费用口径 `💎xN`）、`src/data/council.ts`（参谋室常驻军师/派单建议/快速起手式/`ADVISOR_ALIAS` 军师花名：玄衡/观澜/青衍/鸣璋/照微/云枢…）。**这两个文件不得写入用户业务结论**——用户数据一律走 api（会话/报告/知识/项目/`me.understanding`）。

军师拟人头像：`components/AdvisorAvatar`（圆形立绘 + 白描边 + 可选在线点），当前主用立绘资产在 `src/assets/avatars/generated/*-imagegen.jpg`（6 张 376px JPEG ≈306KB，由 imagegen 生成的古代/神话谋略人物商务漫画头像：general=诸葛亮意象、strat=鬼谷子意象、growth=姜子牙意象、ip=文曲星意象、ops=刘伯温意象、org=张良意象；其余智能体按气质就近复用，未映射的按 key 哈希兜底）。旧版雪碧图裁切 `src/assets/avatars/*.jpg` 已删除（未引用即清理，控主包体积）。对话列表行、chat 头部与消息 who 行统一用它，不要再回退成图标色块。

战略案卷（执行闭环，已服务端化 · M0 PR-EX）：H5 的 `services/dossier.ts` 与原生端的 `services/api.js` 都承接「认可方案→案卷（军令/风险锁/判断/目标）→打卡→战果与经营数据回填→复盘」。server 模式走 `/casefile*` API（后端 `Casefile/CasefileOrder/CasefileMetric` 三表，按用户行级隔离，换设备不丢；军令/风险仍按行动/风险类分节标题启发式提取，服务端 `services/casefile.ts` 与前端 mock 分支同一套规则，**不预置业务结论**；自动拆军令和手动补军令均按「同一案卷 + 同一天 + 标准化文本」幂等，重复认可/重复添加不再追加列表）；mock 模式按账号落本地 storage。页面接口全部异步；完成军令后就地填写「做完了多少」，提交后才收进默认折叠的归档区，近 7 天周计划、复盘、每日战报继续读取 `done` 记录；目标阶梯四格读取并局部保存案卷 goals，复盘统一由总军师承接。战局页（案卷行/风险锁/CTA）与执行页共用该真值。

### 7.2 关键 UI 约定（踩过的坑，勿回退）
- **小程序工程约束清单（先读）**：
  - **项目导入与配置**：微信源码唯一入口是 `app/weapp-native/`，`app/weapp-native/app.json` 自带 `lazyCodeLoading: "requiredComponents"`；`app/project.config.json` 保持 AppID、`miniprogramRoot=dist-native/`、`libVersion=3.16.2` 与正式校验/压缩配置。日常手工走查先构建，再导入 `app/dist-native/`（其中会生成 `miniprogramRoot=""` 的独立 DevTools 配置）；`auto-preview`、`preview` 与发布 CLI 仍指向外层 `app/`。不要导入仓库根目录，也不要再把 Taro `app/src/app.config.ts` 当微信 app.json 真源。
  - **原生构建闸门**：`build-native-weapp.mjs` 编译 SCSS、复制源码与素材，49 条路由全部来自各自独立的 Page 四件套，不存在通用页或 generic fallback；构建会校验路由完整、所有 JS 语法、源码/产物无 Taro 引用，以及聊天 textarea 除 `value="{{composerSeed}}"` 外不得绑定 `value`、且 `onComposerInput` 里不得出现 `composerSeed`（守「编辑期回灌」而非「出现 value」，见 §7.2 输入铁律）——**该校验的目标是 `build-native-weapp.mjs` 顶部的 `CHAT_TEXTAREA_TARGETS` 显式列表**（当前 `chat-core/composer.wxml` + `packages/main/chat/index.wxml` + `pages/sessions/index.wxml`），**列表里的文件缺失本身就让构建失败**，`onComposerInput` 定位不到同样失败，防止铁律检查随文件搬家或重构而静默失效；新增内嵌对话的宿主页要把它的 WXML 加进这个列表。`npm test` 还检查路由覆盖、WXML 事件、Lucide 图标口径、禁用已弃用的 `text selectable`（统一 `user-select`）、mock 账号隔离与 H5/微信产物隔离。H5 仍需 `npm run typecheck`；旧 Taro Webpack 缓存白屏经验仅适用于 `dist-h5`，不再用于解释原生 `dist-native`。
  - **开发者工具 TypeScript 兼容**：`app/tsconfig.json` 同时会被微信开发者工具内置的 TypeScript 4.1.2 读取，`lib` 保持 `ES2020`，不要加入它无法解析的 `moduleDetection`，前端源码也不要依赖 `String.prototype.replaceAll`；完整生产类型检查仍以仓库锁定依赖执行的 `npm run typecheck` 为准。否则命令行构建虽绿，开发者工具「代码质量」会常驻伪错误并遮住真实问题。
  - **上传前恢复正式域名校验**：`app/project.private.config.json` 的 `urlCheck:false` 仅用于局域网临时预览；上传/提审前必须在微信开发者工具「详情 → 本地设置」恢复合法域名、web-view 业务域名、TLS 与 HTTPS 证书检查，并用生产 API 域名完成一次真机回归，不能把“工具关闭校验后能请求”当成上线可用。
  - **原生 tabbar 与图标**：`weapp-native/custom-tab-bar` 直接使用微信 custom tabBar，不得调用 `Taro.showTabBar` 或引入 Taro。问策使用 `lucide-static@1.27.0` 的 `messages-square` 双对话气泡；军情/军令/锦囊/老板与其余功能图标同样从 Lucide 构建主题色 SVG，禁止再手绘或用 Unicode/emoji 冒充图标。不同 SVG 的 viewBox 留白不同，底栏统一 33px 图标槽后仍须按实际笔画包围盒做光学校准：archive 锦囊 26px，其余 Lucide 22px，不能只给所有 `<image>` 同一个盒子尺寸就声称视觉等高。全屏页按原生路由自然不显示 tabbar；组件式全屏层（登录、解锁、全文预览）打开时必须通过 `store.setOverlay(open,key)` 同步隐藏自定义底栏，不能只盖住页面内容却让底栏继续露在弹层上方。`components/agent-unlock` 必须随 `agent` 属性成对开关 `agent-unlock` overlay，并在 `detached` 释放；单纯提高弹层 z-index 压不过微信独立 custom tabbar 层。
  - **★ 登录页不得出现「微信」字样或平台标识（2026-08-08 审核驳回，硬红线）**：驳回原文——「小程序登录页面或弹窗（调用手机号快速验证组件的前置页面），存在混淆腾讯官方的元素，包括但不限于『微信』字样、微信官方 logo，请去除相关元素，如：将手机号授权登录提示修改为『手机号快捷登录』」。**这条推翻了此前**「登录页必须用固定版本 Simple Icons WeChat 品牌 SVG」的老约定，`assets/brand-icons/` 已整目录删除，不要再加回来。现状：主按钮文案固定为「手机号快捷登录」（能力仍是 `open-type="getPhoneNumber"`，未降级）、无任何品牌图形；返回入口作「返回手机号快捷登录」；补档页不再写「使用微信头像/昵称」。JS 里进 `showToast/showModal` 的文案同样不许带平台名，内部标识（`stage:'wechat'`、`.lg-wechat` 类名、`submitWechatPhone` 方法名）不影响审核，保留即可。`npm test` 有反向断言：WXML 全文与 JS 字符串字面量都不得命中「微信」，且 `assets/brand-icons` 不得存在。**登录弹层链出去的协议页同受此约束**——按钮名必须与实际一致（隐私政策里对第三方服务的事实披露，如微信支付/openid 处理，属必要说明，不在此列）。
  - **登录协议勾选必须有对比度**：登录页选中框沿用浅米白底，勾选图标固定用 `#143726` 深绿 Lucide check；不得给浅底传 `tone="white"`，那会让节点存在但肉眼看成没有图标。微信登录主按钮的品牌图形为 21px，手机号登录页返回入口为 15px 浅色版本，尺寸和间距与原 Taro 登录层一致。
  - **原生点选、图文入口与按钮不得依赖平台默认样式**：军情三模式的 `.bmt.on` 必须同时用本命色文字和边框表达当前项，不能只改白底与字重；「打开 + 箭头」等紧凑入口必须把文字和 Lucide 图标放在不换行的同一 flex 行；固定高度的原生 `<button>` 必须显式 `padding:0`、双轴 flex 居中并清掉 `::after` 默认描边，不能沿用 Taro `View` 的样式后期待微信默认按钮自动居中。
  - **迁移复用类不能漏**：原生 WXML 复刻 Taro 层级时，不能只复制页面专属类而漏掉并列的通用类。老板页经营统计必须保持 `account-stat card`，由 `.card` 统一提供 `--line-strong` 实边和双层阴影；只剩 `account-stat` 会在同色页面底上失去整个卡片层级。
  - **老板页服务双卡保持两行真结构**：`老师微信` 卡固定为“Lucide 白色消息图标 + 老师名称”首行和“微信号/分班入口”次行；`班级群` 卡固定为“Lucide 群组图标 + 标题/服务状态”两列。不要在卡片末尾追加独立箭头，老师卡为纵向 flex 时它会掉成第三行，群卡也会被额外挤窄；深绿 `.sa-i` 上不得再传主题绿图标造成绿底绿图不可见。
  - **弹层不进 custom-tab-bar**：`custom-tab-bar` 只做导航和 overlay 状态同步，不渲染 `Login` 或其它全屏业务弹层；未登录点击中间「对话」只提示并跳 `pages/chat`，由聊天页承接登录弹层。
  - **登录层打开必须卸载宿主页原生输入框（iOS 真机）**：`store.setOverlay(open,'login-sheet')` 只负责 custom tabbar，不会处理宿主页的独立原生组件层。`pages/sessions` 与 `packages/main/chat` 在 `showLogin=true` 时必须用 `wx:if` 彻底卸载 `chat-composer` 的 `fixed + always-embed` textarea，`login-sheet` observer 同时调用 `wx.hideKeyboard()`；只提高登录层 z-index 在 iOS 上仍可能让底层 textarea 截获头像、昵称与保存按钮的触摸。头像组件没有返回 `avatarUrl` 时必须提示重选，不得静默 `return`。
  - **overlay 同步不用轮询**：底栏状态同步依赖 `eventCenter` + 页面 `useDidShow` + `hideNativeTabBarOnly()` 短延时兜底；不要恢复 250ms/1500ms 常驻 interval。
  - **顶部安全区统一组件化**：Tab 页用 `Screen topInset`，非 Tab 自定义头用 `SafeHeader`；原生端对应数据统一由 `weapp-native/services/page.js` 的 `capsuleMetrics()` 提供，并在页面根节点透出 `--native-nav-inset/top/row-height/right` 四个变量。非 Tab 标题行必须直接落在 `navTop + navRowHeight` 的胶囊同排区域：36px 返回按钮与胶囊按视觉中线对齐，行底至分隔线固定留 10px 呼吸；右侧按 `navRightInset` 避开系统按钮，正文/ScrollView 从单一 `navInset` 后开始。二级页标题统一在返回按钮后左对齐，不能以“扣掉胶囊后的剩余宽度”伪居中，否则标题会随设备胶囊宽度和右侧操作漂移；禁止再渲染一块 `navInset` 空白后额外叠 48–52px 标题行。`native-safe/form/sub/settings/plans/legal` 六套存量类由 `app.scss` 统一收口为同一结构，新增页面不得另造第七套高度。五个 tab 的标题区统一用 `components/TabHeader`（它在组件自身 WXSS 内建立定位上下文并保留背景大字落脚留白；**不要依赖页面级 `.tab-page-head { position:relative }`**，原生组件样式隔离会让大字改为相对视口定位并撞进微信胶囊；也不要加 `overflow:hidden`——背景大字靠 88px 字号、顶部偏移与 28px 下方留白配套，整字露出而不是被裁），安全区让位只由统一层负责；不要加伪状态栏 `9:41`。
  - **★ 问策终态是「对话即 tab」，它的页头是自绘的新模式，不是 TabHeader（2026-08-08 WP3'）**：`pages/sessions` 在 `wenceForm='chat'` 下渲染 `.wence-page` 那棵树，页头用 `.wh-*` 自绘，**与下一条「tab 页头零按钮」不矛盾**——那条规则约束的是 `TabHeader` 组件与它「一行用途小字」的语义；终态的 kicker 位已经从「用途」换成**对话对象身份**（`{{title}}{{alias}} · 在线`，花名取自 chat-core 的 `ALIASES`，不写死），页头右侧那两枚「军师团 / 历史」是这场对话的上下文切换器，不是往通用页头里塞功能入口。其余四个 tab 与问策 control 形态仍然零按钮，`TabHeader` 依旧不给 `right` 插槽。落位要点：
    - **度量照抄 TabHeader 的约定**（改任何一处都回去核 `components/tab-header`）：谋印 88px / `--accent` / opacity .085 / 贴右 top 4px，大字 29px 宋体 600，细线 1px `--line` / margin-top 14，细线之下留 24px 是**谋印的落脚留白**——删掉字脚就被消息流压住。kicker 字距从 `.3em` 收紧到 `.2em`：八九个字的身份串按 `.3em` 会顶到入口按钮。
    - **入口按钮**：高 30 / radius 999 / `--accent-soft` 底 + `--accent-glow` 描边（accent-soft 裸用会浮在虚空里）/ 12px / Lucide `group`+`clock`。「军师团」右上挂聚合角标。
    - **底部合体浮岛 `.wence-isle`**：上=chat-core composer 模板、细线、下=自绘五 tab 行。tab 表与图标解析由 `services/tabbar.js` 唯一提供，`custom-tab-bar` 与浮岛同源；样式 `@use` 的也是 `custom-tab-bar/index.scss` 本身（含 22/26px 图标光学校准），不许另抄一套。本形态下 `custom-tab-bar` 本体由 `store.setOverlay(true,'wence-isle')` 隐藏，`onHide/onUnload` 与切 tab 前**成对释放**；control 形态完全不碰 overlay。
    - **浮岛刻意不上 `backdrop-filter`**（`custom-tab-bar` 那条有）：它会给浮岛建立 fixed 定位的包含块，composer 模板里的附卷全文预览 / 引用资产选择器两个全屏层就会被这块 26px 圆角的小盒子裁掉。底色因此从 `.9` 提到 `.96` 补足遮挡；同理不写 `overflow:hidden`。视觉差异肉眼不可辨，行为差异是「弹层还在不在」。
    - **提示问题 pill 是「点击即代发」，不是原型的「点选即填」**：代发与 chip 同语义，也少一步「填进去还得自己点发送」。（原因表述 2026-08-08 修正：`composerSeed` 之后，程序化回填并非完全没有实现路径，但那条路径只在**节点重建**时可用——pill 是轮播中的常驻元素，为它重建输入框会打断正在打字的人，所以仍然只代发不回填。）词池 `GET /wence/hints`，空池/失败回退 `data/wence-defaults.js` 本地池，3s 轮换（淡出下移 → 换词 → 淡入）；隐藏条件（**本会话有过 user 轮** / 有草稿 / 生成中 / 键盘弹起 / 抽屉打开）全部写在 WXML 表达式里，不靠 JS 同步。**pill 只在「冷会话」出现**（2026-08-08 真机反馈「一直出现也挺困扰的」）：它的职责只是降低**首次开口**门槛，所以本会话一旦存在任何 user 轮就永久收起——判据直接复用 chat-core 的 `chipsSpent`（与 chips 完全同源，不许另造一套「点过了」标记），老用户带历史会话进来 = 永不出现；轮播定时器也在 `chipsSpent` 为真时停掉，别为看不见的元素烧帧。
    - **键盘避让**沿用 composer 口径：整块浮岛按 `--keyboard-height` 上移，tab 行跟着走，不额外隐藏。
    - **z 轴**：60 页头 / 100 浮岛与 pill（`--z-nav`）/ 900 抽屉（`--z-sheet`）/ 950 登录层 / 960 解锁层，一律写字面量并注释对应 token。
    - **新增 composer 宿主页的义务**：`pages/sessions/index.wxml` `<import>` 了 composer 模板，所以它已加进 `build-native-weapp.mjs` 的 `CHAT_TEXTAREA_TARGETS`；以后再有宿主页，同样要加。
  - **埋点不得走 `request()`**：`api.track(name, props)` 用裸 `wx.request` 发 `POST /events`，fire-and-forget、失败完全静默（不 toast、不 reject、不阻塞），游客照发。走 `request()` 会让「带 token 的 401」触发全局 `onAuthLost`（清登录态 + 「登录态已失效」+ `reLaunch`）——一条统计请求把正在打字的用户踢出对话，是最难查也最难原谅的一类故障；token 失效时宁可丢事件。问策终态埋点位：`wence_enter`（onShow，form + user_state guest/new/returning）、`proactive_show`、`chip_tap`、`hint_tap`、`first_message_send`（本账号首次，ttfm_ms 自 onShow 起算 + entry keyboard/hint/chip）、`drawer_open`、`attach_open`、`tab_switch`。
  - **tab 页头零按钮**：设计稿页头右侧那枚「行业 tag」是装饰，已按定稿去掉，`TabHeader` 也**不提供 `right` 插槽**——不要为了省事又往页头塞入口。新功能入口一律挂到它所属的内容区（段头、卡片、菜单行），落位前先确认：① 它是不是同屏已有入口的重复（军令页原页头「复盘」就是，已删）；② 它是不是别的 tab 已经有的（案卷已在老板 tab 出现两次）；③ 它有没有别处替代（`历史`/`设置` 是唯一入口，必须给新家，分别落到搜索行右侧与老板页「系统」菜单组）。删入口前一定要先核 reachability，别把唯一入口当重复清掉。
  - **H5 组件样式顺序**：`Icon/SafeHeader`、`Picker/Sheet` 的 import 顺序只约束 `app/src` 的 Taro H5 构建；原生微信样式由各页 SCSS 编译成同名 WXSS，不存在 mini-css-extract common chunk。
  - **原生对话输入铁律（华为 + 百度输入法）**：composer 已抽到主包共享模板 `weapp-native/chat-core/composer.wxml`（对话逻辑在 `chat-core/behavior.js`），**下面这条铁律随模板走、对所有宿主页生效**。铁律守的是**编辑过程中回灌**，不是「出现 `value` 三个字母」（2026-08-08 修正，原表述是「不得出现 `value`」）：两个 `<textarea>` 只允许 `value="{{composerSeed}}"` 这一种绑定，`composerSeed` 是**交替挂载那一刻写一次的初值**，写完冻住到下一次重建；输入事件只写普通 JS 字段 `_draft`，编辑过程中绝不 `setData` 回灌文字（`onComposerInput` 里出现 `composerSeed` 即构建失败），也不按输入内容重建节点。发送成功时切换一次以清空（必须同时把 `composerSeed` 置 `''`，否则新挂载的框会把已发出去的话复述一遍）；超 2000 字的长文粘贴转成 pending 附卷卡时也切换一次，**此时 seed = 用户自己打的那段，手打内容原样留在输入框里**——逐字打不到 2000 字，被判成长文的必然是粘进来那段，没有理由连他的提问一起收走（旧实现把它搬到卡外一张「已保留原提问」chip 上复述，且只能删不能还原，已废除；`_draftPrefix` / `combinedDraft()` 这套第二真相源一并删掉，草稿只剩 `_draft`）。日常逐字/语音输入仍绝不重建。保持 `adjust-position={{false}}`、`always-embed={{true}}`、`fixed={{true}}`，这些原生布尔属性必须用 WXML 表达式，不能写成字符串 `"false"` 后被平台按真值再次自动顶起；键盘高度只用于 composer 整体避让，键盘出现后滚到最新，失焦归零。composer 视觉结构必须保持“多行正文在上、附件与发送操作在独立底排”，不得把加号和发送键绝对定位到正文左右，多行时那会让按钮悬在段落旁边；底栏增高继续由 `measureComposer()` 实测回写滚动区。删除/光标问题不得用受控输入“修复”，那会重新引入语音转文字重复上屏、删除时光标跳尾并连删后文的问题。SSE/持久任务/停止/重试等生成态规则继续沿用下文既有口径。
  - **军师追问的「其他」必须是真输入框**：问答卡内直接渲染可见的微信原生 `<input>`，让系统光标、点按定位、长按选字和粘贴自然工作；禁止再用普通 `<text>` 显示答案、另放 `1px` 透明 input 接键盘的“双层假输入”，那种结构视觉层没有光标也无法选字。短回答 input 可用 `ask.other` 作为打开时初值，但 `bindinput` 只写普通 JS 草稿，编辑中不得 `setData` 回灌 `value`；失焦或完成时再一次性提交答案与题目完成度。继续保持 `adjust-position={{false}}`，由页面键盘高度逻辑统一避让。每个 input 使用 `ask-other-m{messageIndex}-q{askIndex}` 稳定锚点；点「其他」、input 再获焦或键盘高度变化时只把当前 input 滚入缩小后的可视区，禁止调用会话级 `toBottom()`，否则长问答卡会把正在编辑的题滚到键盘上方之外。
  - **原生流式正文不得跟着网络包抖动**：普通军师回复使用固定版本 `towxml-stream-typewriter@1.0.3`（MIT，源码与许可证在 `weapp-native/packages/main/vendor/towxml`）承接正在生成的 Markdown；网络层只把累计正文写入组件的 `setMdText` 缓冲，组件以稳定 6ms 字符节奏增量解析/复用已稳定节点，SSE token 到达时不得再对 `messages[index].text` 整段 `setData`。滚到底部按 180ms 节流，网络 `done` 后调用 `setStreamFinish`，用户停止/页面卸载调用 `stopImmediatelyCb`；**打字机只增不减**——这一条决定了下面两道硬约束（2026-08-08 真机漏 JSON 后补，两个宿主页同源同治）：**① 流中扣尾**：token 流是模型原文（尾部 ```ask 协议块要到完整结果处才被服务端剥离），所以喂给 `setMdText` 的累计正文必须先过 `services/chat-reply.js` 的 `streamVisibleText()`——尾部疑似协议块起始（```ask 围栏，含还没写全的 ```/```a…；或独占一行开头的裸 `[{"q"…` / `[{"question"…` / `{"asks"…`，判定特征镜像服务端 `extractAsks`）暂扣不下发，被后文证伪再放行。**宁可短暂少显示几个字，不可把协议块打出来**；扣掉的永远是后缀，所以可见正文恒为最终正文的前缀，done 时只需继续追加。扣尾只操作喂给打字机的缓冲，不得借机回到「token 到达整段 `setData`」。**② 收尾替换**：`done` 后一律以服务端清洗过的最终正文（= 落库版本）重渲染；已打出的字若不是它的前缀（`extendsShown()` 为假，说明扣尾没兜住），或打字机压根没开口（还停在 think-dots），必须 `stopImmediatelyCb` + 清空 `streamRenderId`，整条换回 `markdown-text` 渲染最终正文——喂短文本是收不回去的。中断与 `/generate-sync` 兜底路径同理：落进气泡的只能是已下发正文或服务端正文，不能是含协议块的 `_streamText` 原文。历史消息继续用轻量 `markdown-text`，方案流继续用 `report-card`，不得为了套开源组件改写现有登录、引用、成果闸门或会话协议。上游固定 commit `5b64114d01b58638758009b7cab819f5c391a923`；本地只允许 `user-select` 新口径和禁用未启用的外部 LaTeX/YUML 地址两项兼容补丁，升级必须重新跑原生静态测试与 DevTools 真机长回复验收。
  - **“正在梳理”只是阶段态，公开思路必须与隐藏推理解耦（2026-08-17）**：生成前的 `thinkingText` / `generationSnippet` 只说明正在读上下文、等待 provider 或收尾，不能对用户宣称它是模型真实思维链。普通对话的模型可在可见正文通道开头显式写 `<public_thought>...</public_thought>`：网关 `llm/publicThought.ts` 增量拆成独立 SSE `thought`，最终从正文剥离并落到 `ChatReply.thoughtSummary`；durable worker 必须同步递增写 `GenerationJob.thoughtSummary` 快照，`/generate` 兼容流与断线轮询都从该快照增量续显，禁止只在最终 `chat` 才补摘要。原生/H5/PC 生成时展开流式摘要，完成后折叠，历史消息仍可重开。**这条流只允许简短、可公开的事实核对/判断维度/回答路线**；provider 的 `thinking_delta` / `reasoning_content` 仍只作连接活性信号并丢弃，严禁转发隐藏 chain-of-thought、系统提示、工具参数、密钥或安全策略。旧客户端忽略 `thought` 仍会收到干净正文与完整 `chat` 事件；新增流消费端必须同时保留该兼容路径。
  - **停止之后必须立刻能再发（2026-08-08/09 真机）**：`running` 态的取消是**软取消**——`requestGenerationCancel` 写 `cancelRequestedAt` 并 abort 控制器，落终态要等 worker 那一拍（`queued` 态才是就地终结）。取消事务必须同时把尚未结算的 Token 预留放回钱包并把该 job 的 `quotaReserved` 归零，但保留 `settlementStatus=reserved`，让 worker 最终拿到 provider usage 后仍以 `reserved=0` 扣真实消耗；否则旧任务恰好占完可用额度时，停止后续发会稳定 402，重试也只能继续撞冻结预留。原生 `chat-core` 还要保存取消 Promise，下一轮 `send()` 先等取消确认，防 cancel/send 网络乱序。这段窗口里也不能照旧按「会话已有在途生成」抛 `GENERATION_IN_PROGRESS`：`createGenerationJob` 对 `cancelRequestedAt` 非空的在途任务**一律让位**（清 `activeGenerationId` 后放行新任务），老任务 finalize 用 `activeGenerationId: job.id` 条件更新，抢不回已经指向新任务的会话。端上另两条配套：① `markStreamInterrupted` 遇到「一个字都没出」的气泡（thinking 阶段按停止）必须把它从消息流里摘掉，否则会与下一轮的 thinking 点叠成两个「军师 ···」；② 万一仍收到 `GENERATION_IN_PROGRESS`（多为另一端发起的真在途），**接管它**（`startPolling(error.data.generationId)`）而不是把用户晾在错误态。
  - **错误先判断“原样重试能不能恢复”（2026-08-09）**：C 端通用语义收口在原生 `services/api-error.js` 与 H5 `services/apiError.ts`，按登录、方案/用量、算力、能力门禁、输入/审核、限流、冲突、资源不存在、暂时不可用、用户取消分类，决定 message/action/retryable；页面 catch 只补本动作 fallback，不得再按 HTTP 状态散写。`INSUFFICIENT_QUOTA / PLAN_REQUIRED / PLAN_EXPIRED / KNOWLEDGE_QUOTA` 给「查看方案（与权益）」；`INSUFFICIENT_CREDITS` 给「查看算力」；审核/参数/限流/冲突/404 都不提供立即原样重试；只有网络、超时和可恢复服务异常保留重试。对话卡在 `weapp-native/services/chat-error.js` 与 `src/services/chatError.ts` 做领域呈现，但必须复用通用分类。原生 `enableChunked` 的 4xx 在部分微信基础库会以 `ArrayBuffer` 返回 JSON，`request.js.parseBody()` 必须先 UTF-8 解码保留业务 `code`；JSON、SSE 与 multipart 上传的 408/429/5xx 都要安全降级，技术原文只进 `technicalMessage`。任何手动写操作都必须等服务端成功后再显示“已保存/已启用”；主数据加载失败不得伪装成空数据，需保留失败态与重试。完整矩阵与新增错误码检查清单见 `docs/ERROR_HANDLING.md`。
  - **失败轮次重进后不能静默消失**：GenerationJob 建单会把用户消息持久化，但失败终态会清空 `activeGenerationId` 且不产生 assistant 消息；原生对话恢复会话或兼容轮询结束时，若服务端已不在生成且消息尾部仍是 user，必须识别为“问题已保存、回答未完成”，在尾部恢复明确的「重新回答」入口。重试复用最后一条用户文字与引用并设置 no-echo，不得重复插入用户气泡；正常 assistant/report 尾条、仍在生成或用户主动打开的新会话不得误报失败。
  - **长文粘贴归卷不许留「静默黑箱」**（2026-08-05 真机实拍修）：H5 与原生 `packages/main/chat` 都把超 `INPUT_MAX` 的粘贴自动转成附卷，这条链路上五件事都不能回退。① **不许有空窗**：清空输入框与卡片出现必须同帧——先落 pending 占位卡再打网络，绝不能等 `createKnowledge` 回来才显示，弱网下那就是「框里的字没了、卡片还没来」。② **卡面必须露内容**：粘贴长文走独立 `.paste-card`（字数 + `pasteExcerpt` 首行摘要），不许退回只写「粘贴长文」四个字的 `.ref-chip`。③ **点卡片是看全文，不是删除**：整卡打开本地全文预览（复制 + 移除），删除只走右侧独立按钮并用 Lucide close/trash 图标；H5 全文存 `pasteTextRef`，原生存当前轮 `_pasteTexts`，预览不打网络。④ **去重按内容、不按时间窗**：H5 `services/pasteAbsorb` 与原生 `services/paste-absorb.js` 都用 `isSamePaste`（去空白后互为前缀/后缀 + 九成重合），当前轮与在途内容一并去重。⑤ **归卷未决就不许发送**：`uploading/failed` 卡存在时发送键置灰且 handler 硬拦；失败保留可预览全文并只提供重试/移除，不得异步回灌文字覆盖新草稿。不要加「把附件放回输入框」：本页发送硬上限 2000 字，放回去必撞上限。
  - **卡片的边不许用 `--line`（2026-08-05 实测定量）**：`--line` 是**分割线**色，当卡片边框用等于没画——它对 `--surface-2` 只有 1.12:1、对白底 1.27:1、对 `--paper` 1.22:1。卡片/附件一律用 `--line-strong`（白底 1.62:1）。同理 `--accent-soft` 当图标底时必须自带一圈 `--accent-glow`：它对白底 1.18:1、对 `--surface-2` 只有 1.04:1，裸用就是「图标浮在虚空里」。**还有一条更隐蔽的**：紧邻两块面不要用同一个填充 token —— 粘贴长文卡原本和下方输入框 `.composer .box` 同为 `--surface-2`，两块紧贴读成一整块灰，卡不像独立物件；卡改白底 + `--shadow-card` 浮起才分得开。改这类颜色前先算对比度，别凭眼睛在 DevTools 里判（那里看着有边，真机日光下没有）。
  - **卡片间距分三级，不许再凭页面感觉散写（2026-08-06 五 Tab 游客态走查）**：`app.scss` / `app.h5.scss` 以 `--rhythm-card=12px`、`--rhythm-block=16px`、`--rhythm-section=24px` 作为同组卡片、独立内容块、章节切换的统一语义标尺。相邻同类卡片用 12px；空态与下一块业务内容、搜索与卡组等独立块用 16px；标题分组、卡组跨章节用 24px。三列指标卡必须显式 `gap:8px` 并让子项 `flex:1; min-width:0`，不要再靠 `31.8% + space-between` 的剩余像素挤出约 5-6px 缝；两列仍遵守下方 `48.5% + space-between` 真机规则。`GuestNotice` 只用于登录后的上下文说明，不得拿来重复解释游客权限；它不内置外边距，页面按前后内容的语义就地选择 block/section，避免叠出双倍间距。
  - **深度靠渐隐，不靠 backdrop-filter**：小程序 WebView 对 `backdrop-filter` 支持不可靠，且本项目设计系统不走强玻璃。要表达「内容从面板底下过去」，用一条由 `rgba(255,255,255,0)` 渐到面色的渐变覆盖层（`.dock-fade` / `.paste-body-fade`），`pointer-events:none` 只挡视线不吃点击。渐变起点必须写 `rgba(255,255,255,0)` 而不是 `transparent`——老 WebKit 会让 `transparent` 经黑色插值，出灰带。覆盖层用真实 `View` 而不是伪元素（小程序端伪元素支持面窄），且 absolute 定位在 `.composer-dock` 盒外，不影响它的 `boundingClientRect`（`jump-latest` 靠它测高）。
  - **用户轮是纵向栈，附件在正文之上**：`.msg.u` 必须 `flex-direction: column; align-items: flex-end`，附件容器 `.uref` 渲染在气泡**之前**。曾是行方向 `justify-content: flex-end`，气泡与 `.uref` 成了并排的两个 flex 子节点，带附件时正文被挤成窄条、卡片贴右，多份时排版散掉。`.uref` 还必须 `width: 100%`——纵向栈里按内容收缩会让子卡的 `max-width: 82%` 失去确定参照宽度，卡被压到刚好裁掉元信息尾字（实测「3622字 · 附卷」缺 4px）。
  - **登录/401/网络错误有统一入口**：用户动作前先检查登录态；401 必须清用户态并弹登录/回首页，不能吞成空态或“产出失败”；默认首页 `pages/sessions` 自己承接 `Login`，在本页 401 时只打开登录弹层，不再反复 `reLaunch` 自己，且未登录/退出态仍要加载公开军师注册表并保留 `DEFAULT_AGENTS` 兜底，避免真机旧 token 失效后对话页清空；`Taro.request` reject 要按真实原因区分 `timeout/offline/domain/ssl/dns/unreachable/cancelled/network` 并映射成用户可读提示，合法域名/API 域名等排查细节只放 `reason/technicalMessage`/日志，不直接展示给用户；HTTP 408/504、429、5xx 也要给用户友好但真实的原因，服务端 5xx、SSE `INTERNAL` 和 JavaScript 异常原文一律只进日志/`technicalMessage`，不得直接出现在军师气泡；需要登录的数据页 catch 后先调 `handleApiError`；普通聊天默认走 `/generate` 真流式，小程序用 `enableChunked/onChunkReceived`，**并显式设 `timeout: 180000`**（微信默认约 60 秒会在慢模型仍正常输出时提前断开），H5 用 `fetch` ReadableStream；服务端只对用户输入做前置内容审核，违规输入直接 `MODERATION_BLOCK` 拦截，模型输出不再走阻塞式审核，完成后仅做 trace/禁用词审计；OpenAI/Claude 普通聊天在无工具调用时优先走 provider 原生 streaming，Dify、工具循环、mock 或不支持 stream 的兼容网关回退为完整结果分块；普通聊天**单轮正文**预算统一为 8,000 token（`CHAT_MAX_TOKENS`，净额——开 Thinking 时思考预算另行叠加，见下文 Thinking 段）；provider 返回 Claude `stop_reason=max_tokens` 或 OpenAI `finish_reason=length` 时**不是失败，是「还没写完」**：`max_tokens` 是模型看不见的硬闸刀，调大只是把悬崖往后挪，所以服务端必须**自动续写**——残文作为 assistant 历史 + 续写指令放在其后的 user 轮（**不得用末轮 assistant prefill**，Claude Opus 4.6 及以后已移除、会 400），续写轮显式关思考并把整个预算让给正文，同一条流继续下发 delta，轮内对开头做重叠去重（模型会复述半句）；最多续 2 轮、累计正文预算 24,000 token 封顶、并有 100s 墙钟预算（`CONTINUE_DEADLINE_MS`；续写轮流超时另收紧到 60s）——**续写不得把单轮拖到客户端 180s 超时**，那会走 `clientGone` 退预留 + 不落库，用户连已经看完的半篇都拿不到，比截断更糟；仍未写完则把内容照常落库并置 `reply.truncated=true`，端上按「内容较长，先写到这里 + 继续写完」呈现（只挂在最后一条上），**不得变成错误气泡、不得丢弃已写内容**；同一原则适用于**流中途失败**（慢网关打满流超时、连接被掐）——只要已经向客户端下发过正文，就按「没写完」收尾（内容落库 + `truncated` + 「继续写完」），只有一个字都没吐出来时才如实报错。provider 的 `streamChatRound` 用 `sink` 把已下发正文实时交给调用方，正是为此；`truncated` 的回复不进预言账本（半句预测就是记错账）；续写失败不算整轮失败（手里已有可读内容，标 truncated 交回即可）。两种仍按失败抛 `AI_OUTPUT_TRUNCATED` 的例外：① 结构化成果/工具入参截断（半份报告不能出厂，坏 JSON 无法用）；② 一个字正文都没写就撞上限（无锚点可续写，几乎总是思考预算把 max_tokens 占满了，报错文案必须指向预算而不是笼统的「空响应」）。另外：没有任何 API 参数能让模型自觉写短（`effort` 不可靠地影响正文长度，`task_budget` 是 Anthropic 一方 beta、三方网关不透传），唯一可靠的自我收敛手段是提示词——长度契约在 `llm/schema.ts` 的 `CHAT_STYLE_GUIDE`（对话体例串的 SSOT，此前散着 6 份复制）；总军师 on-demand 普通问答也走 token 流，`/generate-sync` fallback 同样按意图分流，只有明确“生成方案/报告/成果卡/纪要/军令/出报告/战略体检”等成果请求才走强制结构化成果路径（`generateDeliverable`），不得再进入 adaptive 可选工具路径；OpenAI/Claude provider 返回空文本时必须按 AI 服务异常处理，不得伪装成固定追问；结构化工具返回的 `sections` 必须经 `normalizeDeliverableSections` 归一化，非数组/字符串/对象都不能让报告请求变成 503；模型未调用工具但返回普通长文时要转成报告分段，避免直接降级模板；报告成果不得把运行环境、Git 仓库、代码库、IDE、文件系统或 Codex 工作区当成客户资料，gateway 命中“当前工作区/Git 仓库/代码仓库/上传到工作区”等工程语境时必须替换为业务兜底成果并标 `degraded`；前台 degraded 提示不得暴露“结构化产出/降级模板”等技术术语；明确成果请求（如出报告/重新出报告/战略体检/生成方案）与带 `deliverableKey` 的成果型顾问必须按本次 `agentKey` 配置判定并走 `/generate` report SSE：收到 `meta` 先渲染 ReportCard 骨架，`begin/section/footer/done` 增量更新当前卡片，当前页不得只停在全局 thinking；只有 report 流无可渲染事件/传输失败时才回退 `/generate-sync`；普通聊天流成功仍必须收到可渲染 `token/chat` 事件，误收到 report SSE 时不要留下空回复；报告卡「网页版」在小程序内必须跳转 `packages/work/webview` 直接打开自有域名 `/api/r/:id`，web-view/navigate 失败只提示重试，不得自动复制链接。
  - **H5 兼容不污染小程序路径**：H5 自定义底栏只放 `app.h5.tsx/app.h5.scss`；小程序继续走真实 `page` 节点 + `src/custom-tab-bar`，不要把 H5/weui 兼容样式混进小程序原生 tabbar 路径。H5 底栏通过 portal 挂到 `document.body`，避免成为 `.taro_router` 最后一个直接子节点后被 Taro 路由隐藏规则误判，后续不要把固定底栏直接放回 `#app` 路由容器。
  - **主包持续控重**：项目工作台、项目详情、方案库、报告等非首屏工作流留在 `packages/work` 分包；新增重页面优先分包并在入口页配置预加载，除非确实属于首屏主路径。
  - **真机排版防回退**：标题类 `<Text>` 保持块级化；两列网格用 `space-between + 48.5%`；Markdown 内容用 `MarkdownText`；等待模型返回要显示对话流思考气泡；内容可能超过一屏的全屏弹层必须用带明确高度的原生 `ScrollView`，不能依赖普通 `View + overflow-y: auto`（H5 可滚但微信真机可能完全滑不动）；全屏弹层、色盘、商业文案按下方约定处理。
  - **ScrollView 与系统信息 API 保持新口径**：微信 WebView 渲染模式不保证支持直接写在 `ScrollView` 上的 `padding`，滚动区留白统一放进内层 `View`；窗口尺寸/像素比用 `Taro.getWindowInfo()`，设备平台用 `Taro.getDeviceInfo()`，不要新增已废弃的 `getSystemInfo/getSystemInfoSync`。若改完后 DevTools 堆栈仍指向旧哈希分包，先清理 Taro `dist`/`node_modules/.cache` 并重新构建，再执行开发者工具「清缓存并编译」，避免把旧产物误判成当前源码。
- **小程序历史坑只维护一份**：顶部安全区、原生 tabbar、overlay、键盘、登录、H5 样式隔离、网络错误和分包控重以本清单为准；不要在页面里另写一套平行实现。
- **本命色色盘对齐**：`components/Picker` 的色点与名称必须在同一个 `.pk-swatch` 垂直列里渲染；不要拆成上下两条 flex 行，否则选中外圈宽度会导致标签错位。
- **首页标题宋体化**：`pages/home` 通过 `Screen className="home"` 局部定义标题字体栈，品牌名、问候语、今日献策正文、对话卡提问、分区标题与卡片标题使用宋体优先；不要为此改全局 `--serif`，避免影响其它页面。
- **战局页首屏层级**：`pages/home`（战局）的军师判断卡是**纯展示深色卡**（点按整卡进入总军师对话），不要往里塞输入框/chips——对话入口在底栏首位「对话」tab；避免把战局页做成权益/推荐墙。底栏保持浅纸底与明确选中态，避免回退成强玻璃装饰。
- **前台商业文案克制**：面向用户的主路径不要写成“赠送 / 付费解锁 / 充值 / 最受欢迎 / 灵活付费”这类促销口吻；统一用「可用」「已启用」「专项能力」「产出额度」「方案与额度」「常用配置」表达，让用户感到是在调用工作台能力，而不是被推销。智能体费用展示只对**按次产出**用 `💎xN/次`，不要写「每次产出 N 点」；**启用动作一律不标价**（确认即启用，端上锁态只说「需启用 / 启用后可用」，不带价格、不带钻石图标）；后台/代码契约仍可保留 `free/unlock/metered/credits` 等技术术语。
- **Markdown 渲染**：AI 普通回复、成果卡正文、报告详情正文必须经 H5 `components/MarkdownText` 或原生 `components/markdown-text` 渲染，支持标题、段落、列表、引用、加粗、行内代码和代码块；有序列表要兼容模型常见的松散写法（条目间空行且都写 `1.`），连续渲染为 1/2/3…；AI 普通回复允许选择复制，原生流式尾段在尚未稳定时可先按纯文本渲染，稳定段再解析，避免半个 Markdown 标记闪烁。不要直接把模型返回的 `###` / `**` / `-` 原样塞进 `<Text>`；`ChatReply.asks` 必须独立渲染推荐答案与「其他」输入，不能随正文归一时丢掉。asks 的 JSON 协议块不是用户正文：服务端必须剥离标准 `ask` 围栏及可解析的尾部裸 JSON，客户端历史消息收口层还要在其与结构化 `asks` 完全一致时兼容清理旧数据；**原生流式期间还要自己扣住尾部疑似协议块**（token 流是模型原文，剥离只发生在完整结果处，见上面「原生流式正文不得跟着网络包抖动」的两道硬约束），否则打字机会把 `[{"q":"…","o` 这种截断 JSON 打进气泡且再也收不回去；问答卡是选项的唯一可见出口，普通业务 JSON 不得被宽泛正则误删（流式扣尾是**暂扣**，done 时随服务端正文原样放行，不是删）。
- **前台记忆披露**：对话页用「军师印象」包装 Agent Memory（WO-01 名词统一，原「专属理解」；记忆条/记忆披露/@引用分组一致）；我的页只放「军师档案」菜单入口，详情页展示 AI 对客户的结构化理解（经营身份、创业路径、当前难题、已沉淀资料、待补问题），不要在我的页首页直接平铺大段内容。两者都不得暴露 `memoryConfig`/Agent Memory 等后台术语，也不得写死 mock 客户故事或展示 `用户123/企业123` 这类占位名；资料不足时让用户进入对话访谈，由军师先问 1-3 个简单问题，不要先分析旧报告或展开诊断。后端真实记忆开关见 §9。
- **两列网格**：用 `justify-content: space-between` + `width: 48.5%`，**不要用 `calc(50%-5px)+gap`**（亚像素取整会溢出换行成竖排）。
- **原生 Input 定高三件套**：微信原生 `Input` 不随内容撑高，仅靠垂直 padding 定高会把宋体高字形上下裁切（只露上半截，DevTools 看不出、真机必现）。任何单行 `<Input>` 必须显式 `height / min-height / line-height` 三等值（单行居中），padding 只写水平向；多行输入用 `<Textarea autoHeight>` 或显式高度。已两次踩坑：chat 问卷卡「其他」自填框（671779f）、onboarding 公司名输入。新写或改动任何输入框样式时先按此三件套自查。
- **本命色联动**：`--green/--green-hero/--gold/--gold-soft` 等业务主色 token 必须派生自 `--accent`，战局 hero、智库上传、我的用户卡、执行行动色和底栏选中态都要跟随设置里的本命色；`--danger`、正文墨色、纸张底色等语义/中性色保持固定。默认本命色=墨绿（`data/colors.ts` 首位 + `store` 默认 + 服务端 `benmingColor` 默认 `green`）。
- **小程序主题 token 不只写链式 var**：主题类（`.theme-red` 等）必须显式覆盖 `--green/--green-hero/--gold/--gold-soft` 等业务 token，不能只写 `--green: var(--accent)` 这类间接链，否则真机上部分卡片会保留默认绿。
- **H5 token 双写**：新增/修改 `app.scss` 里 `page {}` 的设计 token 时，必须同步 `app.h5.scss` 的 `:root` 兼容层（H5 没有 `page` 节点），否则 H5 上新 token 全部失效（深绿 hero 曾因此透明）。

### 7.3 启动流程
H5 `app.tsx` 与原生 `app.js` 都在启动时水合公开军师与本地身份；登录后再拉 `/me` 和个人角标。认证结果与 `/me.onboarded` 必须使用服务端 `services/onboarding.ts` 的同一权威口径：有 Profile、2026-07-21 入局仪式上线前创建的存量账号、或已有企业身份/会话/项目/成果/资料/案卷任一真实使用痕迹，均视为已入局。不能把“本地无 `junshi.onboarded` / `/me` 尚未返回”误判为新账号；只有认证已完成且权威确认 `onboarded=false`，才在称呼保存后自动导航一次入局页。原生与 H5 入局页同结构：六色卡与批语 → 行业/营收阶段/痛点 chip 云（“其他”就地自填）→ `PUT /profile` 成功 → `POST /quickscan` 初步军情打字机 → 主矛盾/今日一事；Profile 保存失败必须停留原页显式重试。用户中途退出后不循环强拉，战局说明卡承接续做；完成出口先按 token arm 五 Tab 功能点亮，再回问策。

### 7.4 状态与主题
- H5 `services/store.ts` 与原生 `weapp-native/services/store.js` 都维护本命色、用户、智能体缓存、tab、overlay、登录态与入局权威状态；原生 `setOverlay(open,key)` 以来源集合记账并同步 custom tabbar，任一全屏预览/登录/解锁层都必须成对开关，不能因一个弹层关闭误清另一个。
- H5 `components/CoachMarks` 与原生 `components/coach-marks` 的五 Tab「功能点亮」不是“所有没看过 storage 的账号都补弹”：它只在真正完成首次入局的出口写入当前 token 的 `armed` 标记后展示，按真实 route 推进，完成/跳过即清除；历史账号、换机或清 storage 后登录都不得因缺 `done` key 被重新引导。
- `loadAgents()` 必须保留 `DEFAULT_AGENTS` 的 `billing/price/owned` 兜底字段；线上旧 `/agents` 若缺权益字段，不能覆盖掉前台解锁门禁，否则未启用的专项能力会被误判为可直接进入（`price` 仍要兜底：`metered` 的 `💎xN/次` 靠它展示）。
- `data/colors.ts`：6 套本命色主题变量（`--accent` 系列）。

### 7.5 PC 工作台（`/pc/` / `copilot.aibuzz.cn`，2026-08-10）
- PC 是 `app/src/pc/` 下独立的 Vite + React DOM 应用，产物 `app/dist-pc/`；默认线上路径仍为 `/pc/`，独立生产域名为 `https://copilot.aibuzz.cn/`。移动 H5 仍走 Taro 与 `dist-h5/`。两端共用 `services/`、`data/` 与 `shared/contracts.d.ts`，宿主差异只经 `services/platform.ts` 注入。PC 源码不得直接引用 Taro，也不得引用仍绑定 Taro 的 `pay/tabbar/wechatSubscribe/creative/canvasCard/reportShareCard/posterPending/nav`；`app/scripts/pc-bundle.test.mjs` 是强制守卫。
- **PC 独立硬登录门（不改变移动端游客策略）**：`pc/App.tsx` 在无 token 时只渲染 `Login required`，遮罩、Esc 与关闭按钮均不可退出，五区外壳和公开目录都不挂载、不预拉；历史 token 必须先经 `store.loadMe()` 验真，验证完成前只显示核验屏，401 立即清态退回登录，网络失败停在可重试页，绝不能短暂闪出个人工作区。登录成功后才加载军师目录并进入原 hash 对应区；`requireAuth` 继续作为运行中掉线的第二道防线。小程序与移动 H5 仍按 §6 的游客浏览口径执行。
- 三栏外壳固定为导航轨 / 列表栏 / 主工作区；五区注册表在 `pc/regions/index.tsx`。`App.tsx` 只挂一层 `Stage`，区组件只能返回页面体，禁止再次套 `Stage`（否则滚动与抽屉重复）；`Stage` 在 `tab/view` 切换时归零主区滚动。`useBar/useGroups` 可含 hook，必须由按 `st.tab` keyed 的 `RegionBar/RegionList` 调用，不能挪回 App 主函数。
- 已桌面化五区：问策（线程+对话）、沙盘（经营战局/时运策/命盘）、点兵（今日/周计划/复盘）、锦囊（案卷资产/数据/能力/方案）、主公（总览/方案权益/算力账本）。问策回形针直接选择或拖入 PDF/Word/Excel/CSV/MD/TXT，沿用 `/knowledge/upload` 的 20MB/份、9 份/轮、60MB/批边界，逐份显示真进度/取消/重试；成功后作为 `MessageRef(kind='knowledge')` 随本轮 `GenRequest.refs` 发送，空文字时用自然请求补齐，历史用户气泡回显资料签。桌面稿未覆盖的子视图沿用「深色主判断 + 纸面证据卡 + 明确行动落点」语言；头像/创作军师立绘统一复用 `pc/portraits.ts`，字体复用站点根 `/fonts/junshi-serif-*`，不引入设计项目素材。
- 沙盘真相源是 `/me.understanding`（`mainContradiction/summary/battleForces/evidenceCount/nextQuestions`）+ `services/dossier.refreshDossier()`；决策走 `api.decisions/verifyDecision`，时运命盘走 `api.myChart` 且先过 `features.fortune`，认可判断走 `api.battleCommit`。不得把 `journey`、周粒度 `bizMetricSeries` 或生态 `prescriptions` 冒充日战局数据。
- 点兵真相源是 `services/dossier.ts` 的案卷军令、目标、日回填与复盘接口，经营周报另走 `bizMetric*`；表格支持新增、勾选、批量完成/删除、战果回填与 CSV 导出。现有契约没有军令改期接口，「顺延到明天」必须继续显示「施工中」且不改数据，直到先补 SSOT + 后端接口再启用。
- 主公总览读取 `store.me`、`library/projects/reports/progress/strategicProfile/workbench`；方案子视图只按 `planOptions.canPurchase/action/relation` 渲染，算力账本读 `myCredits`。涉及微信支付/签约仍在新标签交给既有移动支付页，PC 不复制支付状态机、不 import `pay.ts`。
- 跨区发问用 `PcState.chatDraft` 内存承接，只预填、由用户确认发送；草稿不得写 URL 或 localStorage。移动长尾路由在 `pc/main.tsx` 映射，未桌面化页面、协议链接与移动支付入口统一经 `pc/mobile.ts` 打开移动 H5；独立域名构建不得写同源 `/#/...`，否则会重新打开 PC 自己。
- 本地：`cd app && npm run dev:pc -- --host 127.0.0.1`（默认 `http://127.0.0.1:5175/pc/`）；四道门为 `npm run typecheck && npm test && npm run build:pc && npm run build:h5`。独立域名构建使用 `PC_BASE=/ VITE_PC_MOBILE_ORIGIN=https://wxapi.aibuzz.cn TARO_APP_MODE=server TARO_APP_API=https://copilot.aibuzz.cn/api npm run build:pc`，窄屏会回现有移动 H5，不能留空导致同域循环。Nginx 模板见 `deploy/nginx.copilot.conf.example`。PC 区域数据源/单层 Stage/施工中约束另由 `scripts/pc-workbench-regions.test.mjs` 锁定。

---

## 8. 后端（server）

### 8.1 API 一览（`/api` 前缀）
| 方法 路径 | 说明 | 鉴权 |
|---|---|---|
| `GET /auth/suggest-name` | 注册页 AI 起花名（古典武侠/军事花名，只填用户称呼） | 否 |
| `POST /auth/sms/send` | 发送短信验证码（console/阿里云 provider，模板 `SMS_508120103`） | 否 |
| `POST /auth/login` | 手机号登录/注册；传 `code` 时校验短信验证码，生产可强制 `SMS_REQUIRE_CODE=true` | 否 |
| `POST /auth/wechat-login` | 纯 code 登录：只放行已关联的账号；未关联返回 404 `PHONE_LOGIN_REQUIRED`，不再自动建号 | 否 |
| `POST /auth/wechat-phone` | 手机号快捷登录：按授权手机号定位账号，第三方身份自动跟随迁绑（`wechat_relinked`）；仅 `wx_` 占位号可升级，账号手机号不静默变更 | 否 |
| `GET/POST /wechat/message` | 微信后台消息推送 URL 验签：GET 校验 `signature/timestamp/nonce` 后原样返回 `echostr`；POST 验签后返回 `success`（后续事件处理入口） | 否 |
| `GET /wechat/subscribe/templates` · `POST /wechat/subscribe` | 已登录用户读取订阅消息模板 · 回写 `wx.requestSubscribeMessage` 结果，`accept` 累计一次性发送额度 | 是 |
| `GET /health` | 健康检查（含 DB 探测；结果 1s 短缓存，避免高频探活每次都打一条 SQL） | 否 |
| `GET /health/live` | 存活探针：只看进程，不碰 DB（ALB/k8s liveness——DB 抖动不该把好进程判死重启） | 否 |
| `GET /health/ready` | 就绪探针：含 DB，决定是否给该实例发流量（readiness / 滚动发布连接排空） | 否 |
| `GET /me` · `PUT /me/color` | 当前用户(+onboarded+ai信息+军师档案) · 改本命色 | 是 |
| `GET /agents` · `GET /agents/:key` | 智能体注册表；带 token 时回填 `owned` | 否 |
| `POST /agents/:key/purchase` | 确认即启用 `unlock` 智能体（**不收费**：只落 `UserAgent` + 来源归因 + 审计，`pricePaid` 恒 0；幂等，已开通直接返回） | 是 |
| `GET /survey` | 建档问卷 | 否 |
| `GET /profile` · `PUT /profile` | 企业档案读/写（写=完成建档） | 是 |
| `POST /quickscan` | 3 问首判；有额度正常计量，无套餐新账号享每日 1 次 `grace:'quickscan'` 保底 | 是 |
| `PUT /profile/bazi` · `GET /profile/chart` | 八字采集（→排盘引擎落库；believe=false=不信命理只存偏好；出生城市自动查经度表做真太阳时） · 我的命盘读取 | 是 |
| `GET /profile/strategic` · `PUT /profile/strategic` | 战略档案（已确认战略事实）读取 · 手动校准（局部更新） | 是 |
| `GET /decisions` · `POST /decisions` · `POST /decisions/:id/verify` | 决策日志：列表+统计 · 手动记录 · 验证（correct/revise，准确率服务端算） | 是 |
| `GET /prophecies` · `POST /prophecies` · `POST /prophecies/:id/verify` | 预言账本：列表+命中率 · 显式记录 · 对账（hit/miss；抽取只走真实模型不产生伪预言） | 是 |
| `POST /casefile/review` · `GET /reviews` · `GET /progress` | 发起复盘（day 快照军令/回填事实+连续天数+同步段位） · 复盘账本 · 段位/里程碑 | 是 |
| `GET /cards/daily` | 每日战报内嵌页取数：只返回当前登录用户的案卷/军令/回填/段位，不生成公开 HTML；旧 `POST /cards/daily` 固定 410 | 是 |
| `POST /cards/:kind`（calendar/fate） | B 级卡片发布 → 可分享 htmlUrl：天时日历（命盘逐月+谶语） · 天命速写（送卦：朋友生辰现算不落库） | 是 |
| `GET /sayings/today` | 每日献策 | 否 |
| `GET /plans` · `GET /plans/options` · `POST /plans/:id/quote` · `POST /plans/:id/order` · `POST /pay/wechat/notify` | 兼容套餐列表 · 用户态关系/动作目录 · 账本报价 · 幂等微信 JSAPI 下单 · 严格回调入账 | 列表否 · 其余除回调外是 |
| `POST /plans/events` | 方案页漏斗事件（业务限制/取消/支付失败/到账中分开记录，写 `user.plan.funnel` 审计） | 是 |
| `GET /pay/orders/:outTradeNo` | 支付订单状态轮询（`PayOrderStatus`，仅本人订单）：未发放且配齐支付时先主动查单补账（`reconcileOrder`），`appliedAt` 有值即权益到账 | 是 |
| `GET /pay/orders` · `POST /pay/orders/:outTradeNo/pay-params` | 我的支付订单列表（`PayOrderListResult`，订单明细页）· 继续支付：对未过支付时限（2h−10min）的 created 单重签 `wx.requestPayment` 参数（`PayRepayResult`） | 是 |
| `POST /sessions/proactive` | 问策入口 WP1 进场主动消息注入（军师先开口）：`wence_entry` 关 → `{injected:false,reason:'disabled'}`；已有 general 会话 → `'exists'`（**这就是每用户至多一次的频控幂等，不另建标记表**）；`WenceTemplate` 无 enabled 的 `kind='proactive'` → `'empty-pool'` **且不建会话**；否则同事务建 general 会话 + 一条 `role='assistant'` 消息（`contentJson={text,chips}`）。**刻意不写 `lastReadAt`**——未读角标必须亮。三种 `injected:false` 都回 200，端上静默降级为 greet-only，不得阻塞进场 | 是 |
| `GET /wence/hints` | 问策提示问题 pill 词池：enabled 的 `kind='hint'` 模板（`id`+`text`，按 sort）。**空池是合法状态**回 `{hints:[]}`，端上回退本地兜底池。**不鉴权**——游客也要能看提示词（登录门不得前置）。同时下发 `guestForm`（开关关 → `control`；开且 `effectiveArms().chat > 0` → `chat`）：游客进问策 tab 本来就必发这一条，顺路带上形态，省掉一次专为游客判形态的往返，也就没有「先渲染 control 再跳 chat」的闪烁 | 否 |
| `POST /events` | 客户端埋点：**鉴权可选**（无 token=游客、userId 空；带 token 必须有效，无效仍 401，不静默降级成游客事件）。`name` 走八项白名单（`wence_enter/proactive_show/chip_tap/hint_tap/first_message_send/drawer_open/attach_open/tab_switch`），非白名单 400 且不写库；`props` 序列化超 2KB 截断（事件本身不丢）。只写不查，无读端点；已加入 `app.ts` 禁写闸放行前缀（生产新号默认无套餐，拦了就把要观测的人从分母里切掉） | 可选 |
| `GET /sessions` · `GET/DELETE /sessions/:id` | 会话列表/详情/删除；详情默认只回最后 100 条，`beforeAt + beforeId` 复合游标向上翻并返回 `page.hasMore/nextCursor`，不得恢复为全量消息。列表与详情返回 `activeGeneration`；生成中删除返回 409。读取端继续自愈 report/assistant 内容并透出 `contentJson.chips` | 是 |
| `POST /generate-sync` | 持久生成同步兼容入口：`clientRequestId` 建/附着 GenerationJob，175s 内未终态返回 202 + `generationId`；生产旧客户端缺 key 时服务端补一次性 key，仍走持久链路 | 是 |
| `POST /generate` | 持久生成 SSE 订阅入口：`clientRequestId` 幂等，同 session 仅一个 active job，断连只断订阅不取消；生产旧客户端无 key 也升级为持久 job，不再走断连退款的内联路径 | 是 |
| `GET /generations/:id` · `GET /generations/:id/stream` · `POST /generations/:id/cancel` · `POST /generations/:id/next-stage` | 当前用户查权威快照/按 `snapshotVersion` 续流/显式停止；分阶段成果只在用户点击后幂等创建下一阶段，页面退出、切后台、弱网都不调 cancel | 是 |
| `GET /facts` · `POST /facts/:id/confirm` | 当前用户事实列表；确认/修改/仅本次/拒绝独立动作，不伪造聊天文本。只有 asserted/confirmed 可作硬事实注入 | 是 |
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
| `GET /modules` · `POST /modules/:key/enable` · `PATCH /modules/:key` | V7-08 能力/模块中心：游客返回公开目录（不带推荐/启用/隐藏偏好），有效 token 返回目录×用户态；带无效 token 仍 401 · tier 分流启用(free/credits/sku/member) · 隐藏/排序 | GET 否 · 写是 |
| `GET /reminders` | V7-11 提醒日历（今日军令截止/20:30 复盘/周五周复盘，纯读派生） | 是 |
| `GET /skus` · `POST /skus/:key/order` | V7-12 单次付费商品目录(公开) · JSAPI 下单(挂 skuKey，回调复用 markPaidAndApply 幂等发放) | 列表否·下单是 |
| `GET /me/workbench` · `GET /me/service` · `GET /search?q=` | V7-13 档案工作台(bizCategory 真实计数) · 社群服务分配 · V7-14 跨域搜索(军师/会话/方案/资料，知识仅 confirmed) | 是 |
| `GET /creative/status` | 海报成品图能力位（`enabled` = 后台功能开关行 `creative-poster`，**唯一真源、行缺失视为关**；两档价格由运营价格表下发；`templates` 只含启用版式；`directions` 下发两条路线内的三种创作方向及已审核真实缩略图）——成果卡据此决定**整块隐藏还是显示按钮**，不露出按钮再让用户点到 403 | 是 |
| `GET /creative/posters/brief-draft` | 从成果消息 + 已确认 BrandKit 预填需求单草稿（含 `templateKey`/`templateReason`；LLM 不可用时确定性回退，不阻塞） | 是 |
| `POST /creative/uploads` | 源素材上传（人像/Logo/二维码，multipart 单文件；MIME 白名单 + 10MB，落私有 OSS，`kind='source'`） | 是 |
| `POST /creative/posters` | 建海报任务（`idempotencyKey` 按用户唯一：命中回 **200 + `reused:true`**，新建回 201）；门禁顺序=开关→解锁→套餐→校验→审核→幂等→日限额→扣费 | 是 |
| `GET /creative/jobs/:id` · `POST /creative/jobs/:id/cancel` | 任务状态/成品资产（越权或 `audience=internal` / 方向样例来源一律 404）· 取消（pending 立即退款；running 只打 `cancelRequested`，worker 在阶段检查点收口） | 是 |
| `POST /creative/jobs/:id/revise` · `POST /creative/jobs/:id/regenerate` | 只改文案重排（**不扣钻石**，复用父任务主视觉）· 重出主视觉（**按当前档位价再结算一次**）；两者都新建任务并挂 `parentJobId`，旧资产永不覆盖。内部任务与方向样例来源同样 404，不得从派生动作重新进入用户作品域。任务快照必须显式写 `operation=revise|regenerate`：不限量与运营零价都会 `chargedAt=null`，不得再以扣费时间猜动作。**三个建单入口的门禁必须一致**：开关 + `assertPosterAccess` + 套餐——revise 曾漏掉 `assertPosterAccess`（不扣钻不等于不需要权益），2026-07-29 补齐 | 是 |
| `GET /creative/assets/:id/file` | 资产文件：归属 + 任务 audience + 样例来源三重校验后，配 OSS 则 302 短签名 URL，否则流式返回（本地/测试内存回退）；内部任务资产一律 404 | 是 |
| `GET /creative/direction-samples/:id/file` | 方向样例缩略图（未配 OSS 时的回退取图）：**只发 `published`**（draft/archived 一律 404——样例源自真实客户成品，未发布即不可对外），id 为 cuid，`cache-control: public, max-age=600` | 否（published 即公开物料） |
| `GET/PUT /admin/creative/config` · `POST /admin/creative/provider/dry-run` · `GET /admin/creative/jobs` · `POST /admin/creative/jobs/:id/retry` · `POST /admin/creative/jobs/:id/audience` | 海报配置读/改（改价与密钥要 owner）· 图片供应商连通性试跑 · 任务台（脱敏用户标识 + 退款计数 + 用户/内部归属）· 重试失败任务（**不重复扣费、不动 chargedAt/refundedAt**）· 把 E2E/运营验收显式切成内部任务或恢复用户作品（留审计）；方向样例源任务带 `sampleSource=true` 且禁止恢复 user | 管理员（写=owner） |
| `GET/POST /admin/creative/direction-samples` · `POST .../:id/publish` · `GET .../:id/file` | 方向样例：列表 · 从成功任务生成草稿（核对实际交付路线，sharp 缩短边 360 后入库，存储失败补偿删行/对象）· 发布（先验非空 key、对象存在且图片可解码，再同事务归档同方向旧样例并失效缓存）· 取图（任意状态，供后台预览 draft；`private, no-store`，前端经 `adminImageObjectUrl` 带头取 blob） | 管理员 |
| `GET /admin/ai-v2` · `/admin/ai-endpoints*` · `/admin/ai-routes*` · `/admin/ai-credentials*` | 大模型接入配置：凭证/端点/用途路由读写、直测与深度探活；明文 key 永不回传 | 管理员 |
| `GET/POST/PATCH/DELETE /admin/skus(:key)` · `GET/PUT /admin/users/:id/service` | V7-12 SKU 改价/启停 · 2026-08-13 增购包（kind=credits/quota）后台自建档/改量/删除（仅这两种 kind 可建可删；有订单只许停用）· V7-13 社群分班/配老师 | 管理员 |
| `/admin/*` | 运营后台 API（见 §9）：用户/算力/审计/智能体/套餐/模型/SKU等 | 管理员 |

### 8.2 LLM Gateway（`server/src/llm/`）
`gateway.ts` 统一封装：路由 provider → 输入审核 → Token 计量 → 结果缓存 → **故障兜底降级到 mock**。普通聊天只对输入做前置审核；OpenAI/Claude 在无工具调用时优先走 provider 原生 streaming，模型 token 到达即经 `/generate` SSE 下发，输出完成后只做 trace/禁用词审计，不做阻塞式输出审核。**持久生成链路不得再让 Worker 重判成果意图**：`generationRequest.ts` 用 `outputIntent.ts` 先处理否定表达，再冻结 `GenerationJob.kind/requestedOutput/deliveryMode`；Worker 只读冻结值，chat 走流式回复、report 走 `generateDeliverable`。旧的 `generateAdaptive` 只保留给未迁移兼容调用，不是持久链路的路由真源。`llm/schema.ts` 的 `injectVariables` 会在后台配置的 System Prompt 之后追加运行时业务边界与 `CHAT_STYLE_GUIDE`：像了解客户的真人教练，先接住具体处境，再明确指出做得好/风险/建议路径，用因果连接或反直觉洞察制造惊喜；禁止客服腔、汇报腔、空泛正确话和暴露内部提示词。客户硬事实只来自当前 `UserFact(asserted|confirmed)`、企业/军师档案、项目、引用资料、知识库和本轮用户原文；pending/rejected/superseded 不得写成事实。资料不足时自然追问 1-3 个关键缺口。**长会话连续性**：普通轮携带最近 16 条消息（12,000 字符预算；报告轮在摘要追平时收窄 8 条）；摘要总注入仍受 4,000 字符约束并在接近 350 项时滚动合并。摘要抽取与滚动合并必须分别显式给 4,000 / 8,000 output token，不能退回辅助模型通用 700 token；统一 `coerceJson` 先严格解析，只有语法失败才用 `jsonrepair` 修复模型未转义原话双引号/尾逗号，之后仍须通过 Zod。模型同批某一条结构不规范时只丢该条，不能用顶层严格 Zod 把整批好条目一起判废，但逐条 kind、文本、来源数量与批内来源校验绝不能放松。命中明确回忆意图时，额外扫描同会话较早 160 条并挑最多 6 条相关原文（4,500 字符预算）。新 Session 通过 `SessionHandoff` 带关键决策/目标/最近脉络，但确认事实只从当前 `UserFact` 块注入一次，不能从 handoff 再复制一份导致重复或复活旧事实。多图先走专用轻提示词 `image_observation`，每批最多 4 张且只带用户问题和本批图片；最终主模型只看带图号的文本观察，不重复携带原图和完整 system prompt。
新增：`extractInsights`（LLM 提炼记忆，mock 兜底截断）、`summarizePoints`（LLM 归纳纪要，mock 兜底确定性）、`pingModel`（测试连接）。

**★ 行业身份层（L1，`data/industryPacks.ts`）**：客户画像里的 `Profile.industry` 经 `resolveIndustryPack()`（自由文本模糊匹配，未识别→通用兜底）解析成「行业包」= label + persona + benchmark + levers + glossary。内置 12 个常见行业（SaaS/电商/餐饮/美业/教育/医疗/制造/专业服务/本地生活/文旅酒店/房产家居/零售）+ 通用兜底。注入两处：① `schema.ts contextValues` 的 `{行业基准}` 因行业而异（替代写死的单一 SaaS 串），并新增可用占位符 `{行业身份}`/`{行业要点}`；② `buildSystemParts` 的 **stable 段**追加「行业视角」行（persona+关键杠杆），对任意智能体生效、命中提示词缓存、未识别行业不注入。这是「军师按客户行业具备行业身份」的代码级实现，无需改库或改各 agent 提示词即生效。**禁止再把行业基准写死**——按行业取或扩 `INDUSTRY_PACKS`。
- **本文件即行业真相源**（AI/研发可直接增改）。建档问卷「行业」题的选项由 `industryOptionLabels()` 从行业包**派生**（`data/seedConfig.ts` 的 `SURVEY`）→ **新增一个行业包，建档选项自动多一个**。落库：`npm run db:seed`（破坏性重建）或 **`npm run admin:sync-content`（非破坏 upsert，保留运营启停，推荐）**。运营仍可在后台「问卷」页临时增改选项；选项串经 `resolveIndustryPack()` 模糊匹配回包，命中即获富身份、未命中优雅回退通用。app 端 `Picker`/`mock` 有离线兜底问卷副本，改选项需同步维护。
- **新增行业**：在 `INDUSTRY_PACKS` 补一条（唯一 key + 简短 `label` + 充分 `aliases` + persona/benchmark/levers）；注意 `label`/`aliases` 不要被更靠前的包抢先命中——`test/industryPacks.test.ts` 有 round-trip 断言（每个 label 必须解析回自己的包）兜底。后续如需运营在后台可视化增改「包」本身，再下沉 DB + admin CRUD（L1.5）。后续 L2 意图分诊路由 / L3 行业专家 agent 见 Notion 设计记录。

**★ 模型由「运营后台 → 模型」按凭证 / 接入点 / 用途路由三层配置**。后台直接写 `AiCredential` / `AiEndpoint` / `AiRoute` / `AiRouteMember`，`services/aiRoutes.ts` 按用途解析并由 `services/aiConfig.ts` 接到既有调用方（4s 缓存，写后统一失效）。未配可用 chat 路由时回落旧表/env 以避免停摆；旧 `AiSetting` / `AiModel` 只保留为一次性迁移来源与 `AI_CONFIG_V2=false` 的短时历史快照，禁止新增写路径。缺省不预置厂商，未配真实 key 自动降级 mock。

**模型单价是 model 级 SSOT，不是端点随机覆盖值**：端点池允许多个 `AiEndpoint` 使用同一个模型名，但同名模型只有在 `priceInput/priceOutput` 同时配置且各端点四档价格一致时才视为已校准；半配置或冲突价格会确定性回退——成本记 0、用户额度按裸 token，而不是依赖无序查询的最后一行。新增同名池端点时应复制相同价格；需要供应商级不同价时必须先把费率键升级为 endpointId。算力按输入价折算：未缓存输入 1×、缓存写默认 1.25×、缓存读按后台价、输出按 `out/in`；`CREDIT_WEIGHTED=false` 可即时退回裸 token。`priceCacheWrite=0` 表示按 `priceInput × CACHE_WRITE_MULTIPLIER`（1.25，Anthropic 5m TTL）推导；1h TTL（2×）或供应商按统一单价（1×）必须显式填写。保存前的同名价格事实只能查 `AiEndpoint`，读旧 `AiModel` 会静默漏掉冲突。

Provider（`provider` 字段，由 `effectiveProvider` 决定实际生效）：
- **mock**：模板产出，零成本可离线（`providers/mock.ts`）。
- **claude**：Anthropic 原生 `/v1/messages` 协议，tool use 强约束（`providers/claude.ts`）；官方直连 `baseUrl` 留空，第三方网关填 Anthropic 根路径（如 qnaigc `/bypass/anthropic`）。后台必须允许该模式填写 `baseUrl`；服务端会裁掉误粘贴的尾部 `/v1` 或 `/v1/messages`，再由 SDK 统一补 `/v1/messages`，避免重复路径 404。
- **openai**：OpenAI 通用协议，兼容 **Agnes / DeepSeek / Moonshot(Kimi) / 通义千问** 等（`providers/openai.ts`，function calling 强约束）。
- Claude 模型（`provider=claude` 或 OpenAI 兼容模型名含 `claude`）可在后台配置 `thinkingMode=disabled|enabled|adaptive`；`enabled` 的 `thinkingBudget` 限 1024–7000。**`max_tokens` 在 Anthropic 协议里是「thinking + 正文」的总闸**，所以对话路径下发的是 `chatMaxTokens(CHAT_MAX_TOKENS, ep)` = 正文 8,000 **加上**思考预算（`adaptive` 无预算可查，按手动档上限 7,000 保守预留）——运营调 thinkingBudget 只影响思考深度，永远不会偷走正文预算。此前 chat 路径写死 `max_tokens: 8000`（只有辅助抽取走了 `maxTokensForThinking`），thinkingBudget=7000 时正文只剩 1,000 token，这就是 2026-08 「回复未完整结束」投诉的根因，勿改回去。开启 `enabled/adaptive` 后，仅最终的思考请求临时使用 temperature `1`，**数据库、端点池与后台表单始终保留运营原值**，关闭思考后可无损恢复。关闭时七牛等第三方 **Anthropic 协议**网关显式发送 `thinking.type=disabled`，且**不得携带 `budget_tokens`**（七牛仅在 `enabled` 时接受预算字段，`disabled + budget_tokens:0` 会返回 400），避免网关默认开启思考；Anthropic 官方直连则按官方协议省略 thinking。OpenAI `/chat/completions` 没有标准 `thinking` 字段，因此 OpenAI 兼容 Claude 在后台保持“关闭”时必须完全省略该字段；只有运营显式选择 enabled/adaptive 后才视为网关扩展能力并发送。后台“测试连接”与普通聊天必须携带同一 Thinking/temperature 配置。结构化成果及多轮工具调用显式关闭 Thinking：Anthropic Thinking 只允许 `tool_choice=auto/none` 且要求跨轮保留 thinking block，与现有强制 `emit_deliverable` 收口不兼容，不能为开关破坏成果链路；关闭后的请求使用保存的运营温度，不得沿用思考请求的 `1`。
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

**流式必须有空闲看门狗、且绝不能加总时长超时**：正常写着的长回复不该因为「写了太久」被判失败，但完全不设保护也不行——网关发完响应头就静默会把请求永久挂住并占死一个 LLM 并发槽。两个 provider 统一到 `streamFirstEventIdleMs()`（默认 90s，覆盖 thinking 期可能一个事件都不发）与 `streamIdleMs()`（默认 30s，实测相邻 delta 在毫秒级），均可用同名 env 覆盖；开火即 abort、记 `junshi_chat_stream_stall_total{phase}`，并走既有的残文保全（已下发正文标 truncated 交回，不换成错误气泡）。claude 侧非补不可的原因见 `providerTimeouts.ts`：SDK 的 `timeout` 只约束「多久拿到响应头」。另：**流中途失败不再触发续写**（`partialCause=stream_error` 时跳过）——续写是为撞上限设计的，对着装死的网关再试一轮只会再赔一个空闲超时、还把用户已有正文压着不给。

**上句“绝不能加总时长”的范围只限 provider 存活判定**：健康流不应因累计时长被误判成上游失败；任务本身仍有 300s 默认资源预算与 token 上限，但不与小程序 `wx.request` 的观看连接寿命混为一谈。新客户端带 `clientRequestId` 时，`GenerationJob/Attempt/Effect` 是事实源：事务内落用户消息+预留+job，worker 按 leaseVersion 接管并以权威全文快照续流；结果终态与后置 effect outbox 同事务落库，pending/failed/过期 running 由 worker 补偿，投递语义是 at-least-once，目标副作用必须继续以 `jobId/effectKey` 保证业务幂等，不得宣称 exactly-once。页面退出、切后台、弱网与 180s 到点只关订阅，不取消 job；只有用户点“停止生成”才写 `cancelRequestedAt` 并 Abort provider。重进不强跳，会话列表显示阶段，进入原会话自动恢复。详细不变式见 `docs/CHAT_STREAMING_RELIABILITY_PLAN.md`。

**改 provider 流式循环时的定式**：`streamChatRound` 里那条 `if/else if` 链中间**不许插语句**——插进去会把 `content_block_delta` 分支变成前一个 if 的 else，文字 delta 全被跳过、逐字流静默失效，而正文还能靠 `finalMessage()` 兜底所以不报错、测试全绿（2026-08-04 就这么上过一次线）。sink 赋值与看门狗续期一律放在整条链**之后**，循环体内不用 `continue`。回归用例：`server/test/claudeStream.test.ts`（断言必须在「传了 sink 的真实路径」上看到 delta，且流出字数 == 最终正文字数）。打桩要用 `__setClaudeFetchForTest`——SDK 用自带 fetch shim，打 `globalThis.fetch` 对它无效。

**兼容网关超时口径**：`OPENAI_TIMEOUT_MS` 是**下限之下的配置值**，不是普通对话的实际预算——用户可见的对话（流式与非流式一律）取 `max(OPENAI_TIMEOUT_MS, 150000)`（`chatTimeoutMs`）。150s 不是拍的：实测该上游 55–130 token/s，而开思考后 max_tokens=8000 正文+7000 思考=15000，最长回复在慢的时候要 200s+，60s 连中等长度都装不下。**但要分清这个下限在哪条路径上真正起作用**：① 非流式（`claudeChat` / `openaiChat`）是**总时长**超时——fetch 要等整个 body，所以 150s 就是「最长能等多久拿到完整回复」，线上那 6 次精确 60.0s 超时正是死在这里，这才是本次修复的着力点；② openai 流式是**空闲超时**——`readOpenAIStream` 每收到字节就 `watch.refresh()`，所以它约束的是「相邻字节间隔」，不是总时长（正确设计）；③ **claude 流式实际只约束「多久拿到响应头」**——`@anthropic-ai/sdk` 的 `fetchWithTimeout` 在 fetch promise 的 `.finally()` 里 `clearTimeout`，而流式 fetch 在响应头到达时就 resolve，`streaming.js` / `MessageStream.js` 里再无任何超时逻辑。**后果：claude 流式没有停顿保护**——网关发完头就装死会把这条请求一直挂着并占住一个 LLM 并发槽，只能等客户端断开。要补就补一个「相邻 delta 间隔」看门狗（对齐 openai 侧），**不要**改成总时长超时——那会把正常写着的长回复判失败。此前流式已有 120s 下限、非流式却直接吃配置值，线上 `OPENAI_TIMEOUT_MS=60000` 而上游实测 ≈59 token/s，于是任何稍长的非流式对话必然卡在精确的 60.0s（2026-08-04「连续超时」：每次截断报错后端上补发的非流式兜底全部 60s 超时）。**不要靠抬高 `OPENAI_TIMEOUT_MS` 来修**：它同时管着 700 token 的辅助抽取（记忆/摘要），抬高只会让网关卡住时那些短调用一起吊死。续写轮另取更短的 `CONTINUE_ROUND_TIMEOUT_MS`（60s），与 `CONTINUE_DEADLINE_MS`（100s 墙钟）一起保证「首轮 + 续写」最坏 160s，留在 nginx `proxy_read_timeout` 180s 之内。该配置同时是流式的首包/相邻数据块空闲上限；收到任意上游字节即续期，不能再因累计总时长截断正常流。强制结构化成果（含工具循环终结轮）取 `max(OPENAI_TIMEOUT_MS, 300000)`：报告本来就是可退出后后台完成、回到会话恢复结果的异步链路，允许最长等待 5 分钟；**普通对话的超时与故障转移体验不随之放宽**。失败日志只记录网关 host、模型、阶段、超时配置与耗时，不记录 prompt 或密钥；超时以 `AI_TIMEOUT` 归一为用户可读的重试提示。

**当前流式实现纠偏（2026-08-05）**：上文“100s + 60s = 最坏 160s”只是历史设计意图，不得当作活跃流的总时限。当前以首事件/相邻数据空闲看门狗判定“上游装死”；原生流建流失败且未吐正文时，生产不再用同一故障 provider 整轮非流式重生。推荐选项保留；主正文先落库，缺失选项作为独立 `ask_recovery` attempt，最多等 3s，失败不回滚正文，真实调用仍计入消耗。

### 8.3 其它服务
- `services/llmGate.ts`（2026-07-26 压测 P0-2）：**上游模型的全局并发闸**。挂在 `llm/providers/{claude,openai,dify}.ts` 的真实外呼处（不挂 gateway 的业务分支——那里有 17 个动态 import 调用点，逐个包既漏又难维护；挂 provider 层则新增调用路径自动被覆盖）。车道键已泛化为任意字符串（`main` / `aux` / `main#<endpointId>`），接入端点池后**每个端点各占一条独立车道**，并发预算与 429 冷却都按端点算，一个端点被限流不连累其它端点。默认 8 并发 / 12 突发（`LLM_MAX_CONCURRENCY` / `LLM_BURST_CONCURRENCY`），排队超 15s 降级为 `AI_BUSY(503)`。**429 走整窗冷却**：压测实测 20 并发触发 429 后，紧接着的 12 并发复测 48/48 全挂，说明上游是滚动时间窗限额，所以收到 429 就整窗停发（优先采信 `Retry-After`，否则指数退避），冷却结束从低水位逐步爬回常态——而不是让每条请求各自重试去放大打击；只有一次完整成功才清零连续 429 计数并推进爬坡，失败请求释放槽位时不得提前复位退避状态。显式速率窗口 `LLM_RATE_MAX_PER_MIN` 默认 0（关闭），等线上跑出真实 429 率再校准，不去猜上游配额。流式路径手动 `acquireLlmSlot`/`release`，槽位持有到整条流消费完（只包"建流"那一下等于没限）。mock provider 不过闸，测试与演示环境不受影响。`llmGateStats()` 供后续 `/metrics`。
- **辅助档（aux tier，2026-07-26）**：`services/aiConfig.resolveAuxConfig()` + `llmGate` 的 main/aux **双车道**。核对发现一条用户消息实际触发 3–4 次模型调用——主生成 + `extractInsights`（记忆学习）+ `extractProphecies`（预言抽取）+ 首条消息的 `summarizeSessionTitle`——原来全走同一个 `getAiConfig()`，**上游 8 个槽位里 2–3 个被后台任务占着**。配 `AI_AUX_MODEL` 即把抽取切小模型；再配 `AI_AUX_BASE_URL` / `AI_AUX_API_KEY`（独立账号）则切到独立并发车道（默认 4 并发、5s 排队超时），主配额全留给用户可见生成。只换模型名不换账号时车道仍是 main——同账号配额本就共享，分两个计数器等于把限额悄悄放大一倍。**收口点是 `gateway.ts` 的 `rawText()`**：所有抽取（`extractInsights`/`extractProphecies`/`summarizeSessionTitle`/`extractGraphTriples`/`summarizePoints`/`llmJson`/`completeJson`/`structured*`）都经它落地，新增抽取路径自动继承；调用方显式指定 `model` 时（评测评委要独立模型避免自评）不被覆盖。rawText 无论是否配置 `AI_AUX_MODEL` 都**强制关闭 Thinking 并把上限固定回 700**，避免记忆抽取/汇总继承主档预算而放大 output 成本；没有 sessionId 的辅助任务用 `sha1(system+user)` 生成稳定亲和键，使不同抽取可在池内分流、相同输入仍命中同端点缓存。**对话与成果生成永远走主配置，提示词不受影响**；`AI_AUX_MODEL` 留空时仅复用主模型/账号，不再继承主档 Thinking。
- `services/llmPool.ts`（2026-07-27，2026-08-08 归一化）：**上游端点池＝chat 路由的一组 `AiRouteMember`，用加权 Rendezvous 哈希（HRW）+ 会话粘性做分流与故障转移**。同一会话固定端点以保住上游提示词缓存；成员变化只重映射约 1/N，`weight` 控制比例，`tier=1+` 仅在低层全部冷却后兜底。429/5xx/超时转移并冷却，4xx、`AI_BUSY`、审核拦截、输出截断不转移；429 冷却优先写 Redis 跨实例共享，无 Redis 退化进程内。`maxConcurrency` 仍是每实例上限，未做跨实例精确信号量。OpenAI 非流式与 Claude 全部调用点已接池；Claude 流式只允许首个 delta 前转移，OpenAI 流式转移仍在 §13。后台在「路由 · 对话」维护模式、成员、权重、备份层与并发。**任何测试连接/深度探活都必须 `poolBypass:true`**，当前唯一端点表单入口是 `/admin/ai-endpoints/test`，Agent 自带接入的 `pingAgentRuntime` 同样 bypass；`providerMode=openai` 的 Agent 真实生成也必须 bypass 全局池，只有 `inherit` 才进入用途路由，避免探活与线上使用不同端点。回归见 `test/aiProbeBypass.test.ts`、`test/gatewayProvider.test.ts`。
- `services/tokenQuota.ts`：月度 Token 额度的强一致预留/结算。跨激活锚点周期的惰性重置与预扣共用 `quota:<userId>` 事务锁，并发请求发现其他请求已重置时复用当前余额，禁止二次刷满。rawJson 等固定估算路径沿用 `RESERVE_TOKENS=2000`；用户可见真实生成在 `sessions.ts` 调 `generationQuotaReserveTokens()`，按最大输入预算 128k、最大输出 8k、所有已校准模型中最高 `out/in` 权重和缓存写 1.25×计算悲观在途占额。mock/测试仍只预留 2k；自定义 OpenAI 智能体强制走动态上界。预留大于余额时只占满当前余额到 0，让其它并发被锁内门禁拦下，不能在模型尚未调用前由预留制造巨额负数；余额已耗尽但命中复盘/速诊保底时也只预留基础 2k，完成后再按真实用量追扣。真实结算始终按 `usage.billableTokens × billingRatio` 多退少补，最多允许最后一个真实请求单次透支。**增购算力包（2026-08-13，pack-in-balance）**：`TokenWallet.packBalance` 记「购买算力存量」，pack 余额并在同一个 `balance` 里（扣费热路径零改动），任意时刻剩余按 `packRemainingOf` 派生（消耗先吃月度后吃 pack：`clamp(balance,0,packBalance)`，不限量套餐直接取存量）；只有「刷写 balance 的同步点」要保 pack——跨周期重置、过期冻结、`setQuota` 硬覆盖、套餐退款回退（`planEntitlements.revokePlanEntitlement` 两处）。永久有效直到用完：跨期不清零、套餐到期只冻结（AI 入口仍被 `assertPlanActive` 拦，续费后可用）。用量 % 只算月度（`toState` 把 pack 从 used 里剔除；月度用满但 pack>0 时 `usageView` 不报 exhausted）。发放/回收走 `grantQuotaPack`/`revokeQuotaPack`（退款只追回未消耗部分）。
- `services/redis.ts`：共享 Redis 客户端（可选依赖，懒加载）。从 `cache.ts` 抽出独立成模块，因为缓存、全站限流的跨实例 store、后续的 LLM 队列/调度选主需要**同一个连接**。未配 `REDIS_URL` 或 ioredis 不可用 → 返回 null，各调用方回退进程内实现，绝不因此让进程起不来。
- `services/context.ts`：`resolveUser`（严格鉴权）、`buildGenContext`（注入 档案/基准/记忆/本命色 + **军师档案 + 项目背景 + 显式引用 + 知识库混合召回 + 天势档案**）。
- `services/dailyBattleReport.ts` + `packages/work/daily`（2026-08-05）：每日战报已改当前登录用户的小程序内嵌页，数字只读案卷/军令/回填/段位账本；不生成 ReportHtml、不返公开链接、不提供分享态。旧 daily 公开记录在 `/api/r/:id(.pdf)` 统一 404，`POST /cards/daily` 固定 410；calendar/fate 仍由 `services/cardHtml.ts` 生成可分享卡片。普通报告 `htmlUrl` 仍固定返回自有域名 `/api/r/:id`，OSS 仅作可选 `cdnUrl` 镜像。
- `data/industryPacks.ts` 深度字段（M4 PR-19）：`decisionChain/ticketRange/benchmarkCases/mingLink` 可选，配了才拼进「行业视角」注入行；美业与大健康已拆分为两个包（新增行业包=建档选项自动 +1，app Picker 兜底问卷需手动同步）。
- `services/wence.ts`（★ 问策入口 WP1）：实验分桶 + 模板池读取。`resolveWenceForm(userId)` 用 **sha1(`wence_entry:`+userId) 稳定哈希**按 `payload.arms` 权重分桶——**禁止 `Math.random`**：随机分桶会让同一用户每次进 tab 看到的形态都在跳，A/B 也就没有归因可言（同 `llmPool` HRW 的理由：无状态、各实例同输入独立算出同结果，无需建表存分配）。盐取开关 key，避免以后再开别的实验时同一批用户被同一条分界线切成同样两拨。**降级口径分两档，别混**：开关**关闭** → `'control'`（零改动现状，实验没开）；开关**开启**但 payload 缺失 / 权重全 0 / 形状不对 → 按 `DEFAULT_ARMS` 三臂均分兜底，**不回 control**——「开关拨开了却静默零分流」会让运营以为实验在收数据，比误开实验更坏，因为它失败得无声；写入端 `PATCH /admin/flags/:id` 的 arms 校验已挡住非法权重入库，所以均分兜底不会把人分到运营没打算开的臂。生效权重的唯一真源是 `effectiveArms()`，**后台展示与运行时分桶必须共用它**（两边分头算迟早漂移，运营就会照着假数字调实验）。
- `services/intent.ts`（M3 编排与适配，全部确定性规则）：`detectIntent`（V6.0 §3 入口识别：复盘六层触发词/紧急/择时/团队匹配/送你一卦/情绪→师父）→ `modeDirective` 模式指令；`Session.mode` 粘性存储（`resolveMode` 本轮检测优先、检测不出沿用；复盘意图在 sessions 路由自动落对应层 ReviewLog）；`detectInnerState`→`roleDirective` 五角色语气（教官/参谋长/大哥/战略家/师父）；`stageOf/stageDirective` 营收阶段自适应（问卷已改营收区间，旧标签兼容）；诊断轮次由历史用户消息数计算注入。注入位：模式/角色/轮次=【本轮导引】dynamic 首位，阶段=stable。**本命色语气注入已移除（PR-14，本命色回归纯 UI 品牌色）**，`{本命色}` 占位符路径保留。
- `services/wechatSubscribe.ts`：微信小程序订阅消息通道。`GET /wechat/subscribe/templates` 只返回已配置模板；前端 `wx.requestSubscribeMessage` 后 `POST /wechat/subscribe` 回写结果，`accept` 才给 `WechatSubscription.remaining +1`；发送成功后扣减一次额度并写 `WechatNotificationLog`。当前场景：`review`（复盘提醒，模板字段 `thing1/time2/thing3`）、`report`（报告生成完成，模板字段 `thing1/phrase2/time3/thing4`）和 `payment`（付款后到账提醒；支付确认点击手势内优先索权，拒绝/失败不阻断支付）。未配模板、无 openid、无额度、微信接口失败都不阻断主流程。
- `services/scheduler.ts`（M1 定时任务框架）：任务注册制 + 进程内周期扫描（生产单实例；`NODE_ENV=test` 不自启，测试直接 `runJob/scan*` 驱动）；任务彼此隔离（单任务崩不影响其它）。已挂：`casefile-idle-recall`（案卷 ≥48h 未推进 → 登记 `system.recall.candidate` 审计，按用户按天幂等）、`daily-review-reminder`（服务端本地时间 `REVIEW_REMINDER_HOUR` 后，活跃案卷且当天未复盘、当天未发过 review、仍有订阅额度 → 发微信复盘提醒）、`review-gap-reminder`（久不复盘登记候选并尝试发送）、`prophecy-due-scan`（预言到期登记候选 + 订阅消息推送——借 review 场景模板，同轮同用户至多一条，岁验预言〔basis 前缀 `年度谶语·岁验`〕用专属措辞；推送 best-effort，失败不阻断 `dueNotifiedAt` 锚点）。
- `services/strategicProfile.ts`（M1 统一状态层）：战略档案提取（`extractStrategicFacts` 按分节标题确定性规则，只取语义明确分节、不猜）/合并写入（只覆盖出现的字段）/注入块（`strategicBlock`）。叙事线与年度谶语存 `extraJson`，谶语同时盖 `verseYear` 与 `verseSource`。**谶语三个写入方 + 一条优先级（#16）**：① `ensureAnnualVerse`（`verseSource='auto'`，读档案 `GET /profile/strategic` 时当年无谶而有命盘 → 按 `mingpan.composeAnnualVerse` 由盘确定性出谶，零 LLM、同盘同年同句、命理开关关则不出）；② 认可方案（`/casefile/accept`、`battle/commit`）时 `extractStrategicFacts` 从「谶语/箴言」分节或封面 `cover.motto` 抽模型亲写的谶（`verseSource='llm'`，过**形状闸门**：七言或五言两句、两句等长、纯汉字——封面 motto 也可能是毛选语录/定场诗，收错就锁一整年，宁可漏收）；③ 老板手改 `PUT /profile/strategic`（`verseSource='manual'`）。守卫统一在 `upsertStrategicProfile`：跨年/从未有谶直接立谶；当年已有谶时**只允许 auto → llm → manual 单向升级一次**，同级/降级一律不采（同一句原样回传也不改来源，免得算法谶被镀成模型谶占掉升级额度），`manual` 任何时候都压得住自动路。报告封面没有箴言时仅读当年谶语补位，不回写成果（故不构成「兜底谶 → 被当成模型谶捕获」的回环）。**谶语周期陪伴（#16 升级）**：`extraJson` 另存 `verseAt`（获谶时刻）/`verseMoments[]`（点谶记录，年上限 12、同日同来源去重）/`verseHistory[]`（换谶归档，岁验对的是「去年那句」）；`maybeMarkVerseMoment` 在认可方案、`recordReview`、预言应验三处 fire-safe 点谶（LLM 严判「事件与谶中某半句真切相应」才落，短路条件全在调模型之前）；注入块带周期上下文（获谶月份/点谶次数/最近一次）+ 点谶行为指引 + 获谶满半年的半验提示；谶语盖章时幂等登记岁验预言（`ProphecyLog.basis='年度谶语·岁验·<谶年>'` 兼作幂等键，到期 = min(获谶+1年, 次年立春)，骑 `prophecy-due-scan` 推送）。逐轮 LLM 结构化抽取与 M2 决策日志共用抽取管道（§13 TODO）。
- `services/paipan.ts`（★ M1 排盘引擎 `paipan-v4`）：确定性命理/历法计算——干支历/八字/大运用 `lunar-typescript`，紫微命宫/身宫主星用 `iztro`；产出四柱十神/月令取格/日主强弱与喜用/大运时间线/年度逐月攻守。v4 明确采用子初换日：真太阳时校正后的 23:00 起按次日子时排日柱，报告公历/农历与日柱共用同一有效日期（如公历 2025-03-16 23:30 → 排盘日 2025-03-17、农历二月十八、乙酉日、丙子时）。新排/主动重排写 v4；存量 v3 首次读取惰性重算并落 v4，避免命盘报告与对话/天时读到两套日柱；存量 v1/v2 原盘照旧读取。命盘页出生地区用微信省/市/区三级滚轮录入，服务端仍按保守城市表匹配经度。**铁律：算→存（`NatalChart.engineVersion`）→拼指令，AI 只做比喻翻译**。
- `services/understanding.ts`（★）：生成前台「军师档案」与模型上下文线索，按真实 `Profile/Memory/Project/Knowledge/Report/Session` 汇总经营身份、创业路径、当前难题、已沉淀资料和待补问题；禁止写入固定 mock 客户画像。
- `services/memory.ts`：Agent Memory 写入（**带向量**）/召回（**语义相关性排序**）/留存 TTL/反馈回流。
- `services/embedding.ts`（★）：文本向量化。默认本地**确定性嵌入**（零依赖、离线、`EMBED_DIM=256`）；配 `EMBEDDING_MODEL`+真实 openai 兼容 key 走真实 `/embeddings`。`cosine()` 维度不一致返回 0。
- `services/retrieval.ts`（★）：`hybridSearch`（向量+关键词混合、租户隔离、可按项目过滤）、`resolveReferences`（显式 @ 引用 → 带出处注入）。
- `services/knowledge.ts`（★）：`ingestKnowledge`（切片+逐片向量化）、`listKnowledge`、`deleteKnowledge`。
- `services/reports.ts`（★）：`saveReportVersion`（slug 归一 + 内容哈希去重 + 自动变更摘要；同租户同 slug 用 Postgres advisory lock 串行成版，避免并发版本号冲突）、`diffContents`/`getReportDiff`（section 级 diff）、`slugify`。
- `services/summarize.ts`（★）：`summarizeSession`（整段会话 → 纪要报告 + 沉淀知识；有真实模型走 `summarizePoints`）。
- `services/sessionTitle.ts`（★ 2026-08-08 改口径）：**会话标题 = 首轮问答的 ≤12 字提炼**，不是首问硬截断。建会话时仍先落 `text.slice(0,18)` 占位（`sessions.ts` / `generationJobs.ts` 同口径，常量 `TITLE_PLACEHOLDER_CHARS`），等**首轮回复真的落库**后由 `maybeGenerateTitle(sessionId)` 换掉——标题要拿问 + 答一起提炼，很多开场是「帮我看看」这种没信息量的一句，只喂 user 文本会拟出与内容无关的标题。四条口径：① **只在首轮改**（会话内 user 消息恰好一条 + 其后已有 assistant/report），后续轮次一律不动，一个每聊几句就自己变一次的历史列表比截断更难用；② **幂等靠「标题还是占位吗」判，不另建标记列**——占位只有三种形状（`'新对话'` / 首条 user 文本前 18 字 / **主动消息注入会话的模板文本前 18 字**），不是这三种说明已生成过或被用户改过，直接跳过；③ **即发即忘**，挂在所有完成路径上（持久任务的 `title` post-effect + 内联 `/generate-sync`、`/generate` 的八个落库点，后者经 `sessions.ts` 的 `bumpSessionTitle`），调用方一律 `void ... .catch()`，函数自身也整体 try/catch，**绝不阻塞回复链路**；④ 无真实 provider（测试 / 未配 key 的 mock 降级）走 `fallbackSessionTitle` 确定性兜底（去开场虚词 → 取首个语义片段 → 12 字），真实模型在位却失败则**静默保留现状**，不拿兜底顶替真结果。gateway 侧 `summarizeSessionTitle(userText, assistantText)` 走 rawText/rawJson 辅助档，预算固定 `SESSION_TITLE_MAX_TOKENS=200`（十来个字的产出不该再向上游多要配额），归一化 `normalizeSessionTitle` 剥引号/书名号/句末标点要**剥到不动为止**（`《…》。` 的书名号被句号挡在里面）。
- `services/sms.ts`（★）：短信验证码发放/校验；发码限频在同手机号同场景事务锁内完成，校验用条件更新消费，确保并发下同一验证码只能成功一次。
- **计费两条轴（2026-08-13 定，别再把它们混成一条）**：
  - **对话轴 = agent 属性**：所有对话一律扣**月度 token 额度 × `Agent.billingRatio`**（`reserveQuota`）。
    `Agent.meterUnit` **已废弃、不再参与任何计费判定**——旧行为是 `meterUnit='image'` 的智能体
    按**对话轮次**扣钻（线上 poster 8 钻/轮、ip 3 钻/轮，且完全不吃 token），等于"聊天按张卖"：
    用户还没拿到任何产出物就在掉钻，聊 5 轮 40 钻，而真正的成品图在另一条链路上另收一次。
    库里的 `meterUnit` 值留着只为可追溯，后台已标废弃；**新增计费逻辑不许再读它**。
  - **产出轴 = 产出物属性**：钻石只在产出物落地时扣，价格按 **`技能 key × 规格`** 存在
    `services/artifactPricing.ts`（FeatureFlag 行 `artifact-pricing`，如
    `{"canvas_design":{"standard":10,"premium":25}}`）。**刻意不挂 agent**：等名片/易拉宝设计师
    都用上 `canvas_design`，价挂 agent 会变成"同一张海报在不同入口卖不同价"。
  - `artifactPrice()` 未配置返回 **`null` 而不是 0**，回退链一律用 `??` 不用 `||`
    ——0 是"免费"这个明确的业务含义，用 `||` 会把一次免费改价悄悄打回付费（守卫用例钉住了这条）。
  - 海报价的三层回退：**产出物价格表 → `creative-poster` 的旧价字段 → 代码默认常量**。
    后台改价**只写价格表**，旧字段只读不写——它是迁移期的安全绳，跟着一起写就等于没有。
- `services/credits.ts`（★）：钻石计量——`ensureCredits`（只读预检）/`reserveCredits`（已知费用产出前原子预扣）/`chargeCredits`/`refundCredits`/`grantCredits`/`getBalance`；同一用户的 `CreditLedger` 写入用 Postgres advisory lock 串行，避免并发双花或充值丢失。图片/按张类产出在 `sessions.ts` 同步与 SSE 路由中先预扣，异常自动退款；**`CreditReservation.refund` 自身幂等**（对齐 `tokenQuota.QuotaReservation` 的 `done` 标志）——同一次预扣重复调用只落一条正向流水、返回首次退款后的余额，因为路由里降级退款与 catch 兜底退款会叠在一起（守卫用例 `test/creditReservation.test.ts`）；退款失败不置位，后续路径仍可重试。`/agents/:key/purchase` **不再走 credits**（2026-08「确认即启用」：事务内只落 `UserAgent`、`pricePaid` 恒 0，没有 `chargeCredits`，也没有 402 `INSUFFICIENT_CREDITS`）；套餐发放通过 `applyPlanPurchase` 同事务更新套餐、钻石流水与 token 钱包。企业版(creditsPerMonth<0)不限量不扣减。**钻石增购包（2026-08-13，SKU kind=credits）与套餐赠送合池**（同一 `CreditLedger`，流水 reason 标来源）；**不限量余额（-1）用户禁买**——`grantCredits` 对不限量余额发放会把 -1 写成有限值（降级），故下单口 409 `CREDITS_UNLIMITED` + 入账兜底跳过发放（审计 `skippedUnlimited`、entitlement `quantity=0`），端上也按 `creditBalance<0` 隐藏钻石包。
- `services/entitlements.ts`（★）：智能体权益——`assertAgentAccess` 拦截未解锁 `unlock` 智能体（403 `AGENT_LOCKED`）、`agentCost` 统一 `free/unlock/metered` 的产出计费、`publicOwned` 给前台展示可用状态。
- `services/adminAuth.ts`（★）：运营后台鉴权——`/api/admin/*` 统一要求 `ADMIN_TOKEN`（`x-admin-token` 或 `Authorization: Bearer`）或 `role=admin` 用户；普通小程序用户访问返回 403，无凭证返回 401。
- `services/aiConfig.ts`（★）：把用途路由投影到既有 `ResolvedAiConfig` 消费面，并在 V2 无可用 chat 路由时回落旧表/env；负责就绪判断、费率解析和端点表单直测合并 `mergedTestConfig`。厂商/能力/预设常量在 `llm/vendors.ts`，方言在 `llm/dialects.ts`；预设按「厂商 × 协议」建条目，同一家 OpenAI 与 Anthropic 入口必须分开。缺省不预置厂商，未配 key 自动降级 mock。旧 `publicConfig`、全局测试合并与旧模型 CRUD 已删除；不要重新在本文件增加 admin 写路径。
- `llm/dialects.ts` + `llm/vendors.ts`（★ 2026-08-07）：**协议方言与厂商能力是两个正交维度，别合并**。方言回答「同一协议下这家的请求细节怎么写」（关闭思考省略 / 显式 disabled / 仅当运营开过才显式 / 压根没这字段，四种都真实存在）；厂商回答「有没有这个能力」（七牛不提供 Embedding）。二者少判一条就漏：七牛 OpenAI 入口协议完全合法但没有嵌入模型。**方言推断只允许存在于 `inferDialect()` 一个函数**，且严格复刻历史判据（claude + baseUrl 空才算官方直连，非空一律网关）——不要「优化」成按域名认 `api.anthropic.com`，那会改掉既有端点的请求组装。端点固化了 `dialect` 列就不再推断。等价性由 `test/dialects.test.ts` 的 315 组全矩阵 oracle 比对锁死，刻意差异必须登记进 `KNOWN_DELTAS` 并论证不可能命中存量配置。
- `llm/validate.ts` + `services/aiValidation.ts`（★ 2026-08-07，2026-08-08 收尾）：**接入配置的互斥规则只有一处**。保存端点、编辑已入路由端点、加入分流池、切换生效、保存路由、探活共用纯校验规则（数据库事实由取数层提供）。`error` 拒绝保存，`warn` 可存但展示风险，`info` 提示。校验覆盖 provider/方言协议、池成员协议、重复/失效成员、唯一 primary、用途预算、Embedding/Rerank 厂商能力，以及迁移/自定义凭证的 vendor 确认；端点更新会反查并重算所有引用它的路由。关系不存在保持 404，配置冲突才是 409。新增约束只改这两层，不要在路由里另写一套。
- `services/aiProbe.ts`（★ 2026-08-07，2026-08-16 告警可信度加固）：**能力靠测不靠猜**。8 个检测项，结果回填 `capsJson` 后校验器立刻据此拦截，形成闭环。三条铁律：**必须 `poolBypass`**（否则测的不是被测端点）、**必须与真实请求同一条组装路径**（另写一份 mini 请求等于测了个不存在的东西）、**探活是真实计费请求**故按 `kind='probe'` 单独记账并留 `AI_PROBE_SCHEDULED=false` 一键全停。定时任务只覆盖启用 route 的实际承载端点：文本用途跑 chat 检测，embedding/rerank 只跑各自协议；`single` 只取 primary、`pool` 取全部启用成员。探活历史按 kind 合并保存，不能再由高频 connectivity 覆盖低频结果；进程重启后从这些持久结果恢复最新 gauge，低频探针到期前也不能监控失明。`GET /models` 是可选能力，网关明确返回 404/405/501 时只记录 skipped，不能把聊天已经成功的端点判坏；鉴权、限流和 5xx 仍如实失败。Prometheus 最新状态必须带 `endpoint/label/purpose/kind/source`，手动检测与定时告警隔离；路由下线同步移除旧失败序列。`JunshiAiEndpointProbeFailing` 需持续 25 分钟且恢复保留 15 分钟，卡片明确具体端点。新增检测项要同时想清楚适用用途、定时周期与成本。
- `services/aiRoutes.ts` + `services/aiV2Admin.ts` + `scripts/migrateAiConfig.ts`（★ 2026-08-08 三期收尾）：**按用途路由**（chat / deliverable / aux / embedding / rerank / moderation）已取代「一个全局配置 + 拷贝式生效」。首次生产切换用幂等迁移把旧表转换成四张归一化表；迁移允许无法推断 vendor 的凭证入路由但标 `needsReview`，迁移后的任何路由改动必须先在凭证区确认。后台此后只经 `aiV2Admin` 直接写新表；路由成员重建在同一事务中，失败完整回滚，单端点用途换主项会清掉旧成员。`AI_CONFIG_V2` 默认开；用途没有可用路由时仍回落避免停摆，显式 `false` 只读旧表历史快照。旧 CRUD、投影函数和旧 admin 路由已删除，`test/aiLegacyReadOnly.test.ts` 阻止重新引入旧表写路径。
- `services/agentVersions.ts`（★）：智能体草稿发布/回滚/版本列表；`publishDraft` 对同一 `agentKey` 加事务锁，保证并发发布只生成一个版本或串行递增。
- `services/vectorStore.ts`（★）：pgvector ANN 查询/向量列双写（`PGVECTOR_ENABLED` 开启时；默认关闭走内存余弦）。
- `services/audit.ts`（★）：统一审计记录与秒级 ISO 时间格式；Fastify `onResponse` 钩子会记录除 `/api/health` 外的所有 `/api/*` 行为，覆盖匿名、无效 token、登录、后台与用户请求，payload 写入方法/路径/状态码/耗时/IP/UA/鉴权状态/脱敏 body 摘要；登录、短信、后台账号等入口另写成功失败语义审计，关键业务动作继续写语义日志（建档、产出、存库、汇总、后台配置变更）。
- 内容审核 `moderation_log`、审计 `audit_log`（演示级，生产替换合规服务）。

### 8.4 海报成品图（`canvas_design` artifact 技能，2026-07-29）

「海报设计师」（agent `poster`）用短对话确认需求；这个技能把确认后的 brief 变成**真图**（3:4 PNG，1080×1440）。完整设计见 `docs/CANVAS_DESIGN_SKILL_INTEGRATION_PLAN.md`，实现落在 `server/src/services/creative/*` + `routes/creative.ts` + admin`views/creative.tsx` + app `packages/work/poster|posterJob`。

- **第三类技能**：`SkillKind` 从 `tool | output` 扩到 `tool | output | artifact`。artifact 只进 `nativeSkillMeta()` 的元信息登记（后台技能库 kind 文案「成品交付」、agent 可勾选），**不建通用 ArtifactSkill 注册表**——只有一个成员时抽象是负债。
- **三表任务/物料模型**：`CreativeJob`（一次出图动作 = 一行，状态机 `pending → running → succeeded|failed|cancelled`，progress `philosophy|visual|render|upload`；`audience=user|internal` 是作品可见性真源，默认 user）+ `CreativeAsset`（`source|visual|poster_png`，`jobId` 可空以支持「先传素材后建任务」，`userId` 是归属校验真源）+ `CreativeDirectionSample`（全局运营样例，不带用户/租户归属；只从成功任务成品复制为 draft，审核 publish 后才下发）。C 端作品列表、详情、派生动作与资产文件只认 `audience=user`，并额外排除 audience 上线前已有的 `sourceJobId`。E2E/运营验收必须先在任务台显式标 internal；方向样例也只允许从已标 internal 的成功任务复制，**禁止在建样例时自动隐藏真实客户作品**，更禁止靠标题或 id 前缀猜。方向样例与 `WenceTemplate` 同属运营目录，**不进 `resetBusinessData`**，测试自行清理。状态真源是数据库行，不是进程内 Map。
- **计费：预扣即实扣 + job 行幂等退款**。两档价格只由运营价格表下发，代码默认值仅作灾备回退，不对外承诺固定数字。建单事务内 `chargeCredits` + 写 `chargedAt`；退款唯一入口 `refundJob()` 用 `updateMany({ where: { chargedAt: {not:null}, refundedAt: null } })` 抢占，抢到才真退。三条不变式：① 不限量用户（余额 -1）`chargedAt` 恒为 null，`creditCost` 仍记名义价供成本统计；② revise 只改文案、复用父版本真实主视觉与钉死的 `styleKey/subject`，`creditCost=0` 且不得调图片供应商；原主视觉文件不可用时拒绝并引导 regenerate；regenerate（含换创作方向）按目标档位重新计费；③ **admin 重试不动 `chargedAt/refundedAt`**。
- **worker**：`FOR UPDATE SKIP LOCKED` 抢占，2s 轮询，`setInterval+unref`，`NODE_ENV=test` 不自启（测试直接调 `tickCreativeWorker()`）。**不继承 scheduler 的单实例约束**（那是选主未做完的历史包袱，多进程抢占本身是安全的）。一轮最多串行处理 `TICK_BATCH_SIZE=2` 单（不是并发，见下文）。`sweepCreativeJobs`（挂 scheduler，5min）：running 超 `STALE_RUNNING_MS`（10 分钟）→ 回 pending 或 failed+退款，外加「已扣未退的终态任务」兜底重扫。
  - **「还能不能重试」只有一个实现 `canRetry(attempts)`**（`attempts < MAX_ATTEMPTS`，抢占时就 +1 所以入参含当次）。此前 worker 收口与 sweep 回收分别写 `<` 和 `<=`，于是 worker 判定重试用尽、落了终态失败的任务，在 sweep 眼里还能再入队一次；测试还用 `MAX_ATTEMPTS + 1` 把这个错误固化了。两处必须共用同一把尺子。
  - **终态写入一律带状态守卫**：成功路径也是 `updateMany({ where: { id, status: 'running' } })`，影响行数为 0 视为已被他人收口 → 记 warn 后放弃写入，**不抛错**（抛了会走退款路径，而钱早已正常结算）。原先只有失败路径有守卫，一旦发生双执行（如超时阈值错配那次）就会覆盖终态并产出两张资产。
- **生成来源与排版引擎是两个阶段**：`tier` 是商品契约、唯一决定主视觉来源；`layoutEngine` 只决定排版由 LLM 写 HTML 还是白名单模板，绝不能改变档位语义。`standard`（用户名「创意排版」）全路径只做 graphic，含 `layoutEngine='template'` 与 AI 回落都**零图片供应商调用**；`premium`（「主视觉大片」）必须生成或复用全幅无文字主视觉，任何排版引擎下拿不到主视觉都失败重试/退款，绝不按高级价交纯排版。旧全局 `aiMode` 配置与运营旋钮已退役；图片供应商熔断只用 `visual.enabled`。
- **AI 排版引擎（`layoutEngine='ai'` 默认）**：模型自己写整张海报的 HTML/CSS，而不是往三套模板里填空。链路：`manifesto.ts`（LLM #1：中文宣言 4–6 段 + 色板 + 隐性主题 + 正向 Art Direction）→ `canvasEngine.ts`（LLM #2：540×720 整页 HTML；standard 用纯 CSS/SVG，premium 在主视觉上叠排版）→ 静态审计 → 占位符替换 + AI 标识兜底注入 → 加固渲染 + `canvasMeasure.ts` 量测 → **无条件打磨一轮** → 最多再修一轮。
  - **「首轮干净也无条件打磨一轮」是上游 skill 的核心机制，不是可选优化**（原文 FINAL STEP："The user ALREADY said it isn't perfect… take a second pass."）。守卫用例断言 **LLM 被调 2 次而不是 1 次**——想省这一轮 token 的"优化"会立刻让测试红。另一半同样重要：**打磨轮不许让画面变差**，首轮干净而打磨轮量出违规就退回首轮那张（`resultJson.polishReverted`）。
  - **轮次与预算**：HTML 相关 LLM 调用 ≤3 次（`MAX_HTML_CALLS`），看图评审 ≤2 次（`MAX_VISION_CALLS`，独立计数），整段 ≤300s（`AI_ENGINE_BUDGET_MS`；仍小于 `STALE_RUNNING_MS`）。每轮都要跑一次真实渲染。**单次渲染超时取 `min(后台 timeoutMs, 引擎剩余预算)`**（下限 15s）。
  - **看图打磨闭环（2026-08-12）**：此前整条链路**没有任何一个环节在评审审美**——量测器量的是越界/重叠/字号这类事故，审美只由模型盲写那一次决定，之后再没人看过。这是「军师出的图不如 Claude Code 里出的图」的第一位原因。现在补上：`visualCritique.ts` 把**渲染出来的 PNG** 交回模型做艺术总监评审（构图/层级/留白/色彩/排印/收口），产出「判定 + 最多 5 条具体意见」，意见逐条回喂给打磨轮；**打磨轮本身也带着那张图发出去**（作者要看见自己画成了什么样，而不是对着自己写的 HTML 凭空想象）。
    - **顾问不是闸门**：评审失败 / 解析不出判定 → 一律 `null`，退回 2026-07-29 的老行为（无条件打磨一轮即交），**绝不让一单因为评审失灵而失败**。引擎侧还有一层 try/catch 兜注入实现，这条不变式与具体实现无关。
    - **评审判定不能跳过无条件打磨**：收工条件是「已打磨过 且（达标 或 评审不可用）」。首轮就判达标也照打一轮——让一个宽松的评委把 second pass 省掉，等于拿这次改动去退化既有行为。
    - **脏图不请艺术总监看**：有量测违规时本轮只喂违规清单（`fixDirective`），不掺审美意见——带着违规的版面再美也交不出去，而两套指令同时喂会打架。
    - **结构化机会式重构**：评审输出严格 JSON：`pass / needsRebuild / rebuildReason / notes`。只有艺术总监明确判定「缺少视觉主角或记忆母题，局部微调救不回来」且仍有 HTML 轮次时，才在既有三轮预算内重构一次；重构若引入机器违规，直接退回上一张干净产物，不追加轮次。禁止用「与常见 AI 海报差异度」这类不可验证的空泛标准。
    - **指标 `junshi_creative_critique_total{verdict=pass|revise|unparsed|unavailable}`**：`unparsed` 区分模型有返回但结构解析失败，`unavailable` 区分 provider 未配置/调用失败；两者斜率都是「看图打磨在生产悄悄失效」的告警信号（与 `template_fallback` 同类：画面不会报错，只是悄悄变回没人看过的样子）。该计数器必须进入 `/metrics` 输出与 `__resetMetrics`。留痕另见 `resultJson.visualCritiques` / `critiquePassed`。
    - **注入面**：评审读的图上印着用户文案，理论上存在「用户把指令写进主标题 → 评审转述 → 作者照做」的路径。三层防住：意见块明确框成「只谈画面表现，不改文案、不动合规元素」；硬约束在 system、意见在 user；真绕过了也没用——主标题在场与 AI 标识在场是**量测器**逐条量的，机器判定不看任何模型的说法。
  - **HTML 轮不开思考**（2026-08-12 预发实测后定，别再打开）：线上是 `adaptive` 档，思考量由模型自己决定，而 `max_tokens` 管的是「思考 + 正文」**总量**。实测出现过「接口成功返回、正文是空串」——224s 后拿回一个空字符串，引擎判「模型不可用」整单回落模板，**全程无异常无日志**。`gateway` 已按 `chatMaxTokens` 给正文留 +7000 净额（那条修正本身是对的，见下），但 adaptive 照样能越过预留，失败模式消不掉、只能压概率。而它并没换来质量：同一段提示词实测「思考关 42.6s→9416 字符 / 思考开 37.6s→7724 字符」，时间相当、产出反而更少——这一轮的设计决策本来就由宣言那一轮承载。要再试思考，必须把 `thinkingMode` 显式覆盖成 `enabled` + 固定 budget 让预留真的生效，**不能把 adaptive 直接放进来**。守卫用例断言 `allowThinking === false`。
  - **`rawText` 开思考时必须换算净正文预算**（`chatMaxTokens`）：provider 侧的 `maxTokensForThinking` 只在 `thinkingMode='enabled'` 时加预留，**adaptive 档原样返回** —— 于是「思考 + 正文」共用一个上限，正文可能被吃到零。这与 chat 路径当年那个「回复未完整结束」是同一个根因。海报虽然已经关了思考，这条修正仍对任何未来开思考的 raw 调用方成立。
  - **`allowThinking` / `images` / `timeoutMs`** 是 2026-08-12 给 `completeText`/`rawText`（以及 `structured` 的 `timeoutMs`）加的可选参数，**一律缺省关**，既有辅助抽取行为一字未变。`HTML_MAX_TOKENS` 保持 6000：实测产物只有 11–13k **字符**（≈3.5–4k token），6000 从没截断过它；曾调到 12000 又收回来，那个「写不下」的动机站不住。
  - **双路线商品契约（内部字段 `tier`）**：确认页对用户只说「创意排版 / 主视觉大片」，不再说“标准 / 高级”。`standard`=graphic，全排版引擎与回落路径都零图片供应商；`premium`=photo，先由图片模型出**全幅无文字主视觉**，再由 AI 或固定模板排中文/Logo/二维码。中文来自用户确认的 brief，排版层由服务端审计、Chromium 渲染并量测；不得误称为图片模型写字或“完全确定性排版”。
    - **主视觉大片不可用一律 422，绝不静默换路线**（`PREMIUM_UNAVAILABLE`）。可用 = 图片供应商配置完整且 `visual.enabled=true`。判断只有一个实现 `premiumTierAvailable()`，同时供 `/creative/status` 的 `premiumAvailable` 与建单闸门用。
    - **主视觉大片 + 本人照片 → 建单即 422**（`PREMIUM_PORTRAIT_CONFLICT`）：模型画的人与用户的照片必然打架，而这件事建单时就知道，不该先扣费再退。
    - **失败不跨路线交付**：photo 链走不通 / AI 或模板排版路径拿不到主视觉 → **整单失败 + 全额退款**（复用既有幂等退款），`PREMIUM_VISUAL_FAILED`。创意排版失败可回落模板，但回落仍是 graphic、不得借机调用图片供应商。
    - **定价独立**（`premiumPricePerPoster`）不是倍率。`priceForTier()` 是唯一定价口径，create 与 regenerate 共用；revise 不调供应商、不计费，也不因当前供应商熔断而被拦。
  - **六个用户创作方向（每条路线三种）**：standard = `强标题视觉 / 品牌图形 / 本人形象`，premium = `人物意象 / 产品大片 / 场景叙事`。方向不是质量等级，而是正向视觉母题；`directions.ts` 定义母题、构图骨架与 premium 风格子集并注入宣言。`人物意象` 必须标明 AI 演绎非本人；真实本人形象只在 standard + 已上传 portrait 时可选。负向反廉价清单保持不动。
  - **方案优先：影像风格档是「结构 + 可覆盖缺省」，不是整段写死的骨架**（2026-08-15，预发真单 `cmsucfvax0se` 实证）。此前 `styleLibrary` 的 12 档各是一整段 `imagePromptSkeleton`，颜色/光线被写死在里面（编辑部黑金写死 `black seamless backdrop / rich true black point / pure unbroken black`），于是宣言跟客户聊定的「沉稳深灰 + 柔暖光」**一个字都进不了生图提示词**——用户看到的方案与产出结构性脱节，而两边各自都「正常」，没有任何日志或测试会红。现在每档拆成两块：
    - `structure`（**不可覆盖**）：`opening`（含唯一 `{SUBJECT}` 槽）/ `camera`（景别只在这里出现一次）/ `negativeSpace`（负空间形状与占比）/ `actionZone`（叠层放二维码 CTA 的那一小块）/ `negatives`。**`negativeSpace` 里不许出现任何颜色词**，只能写 `in the backdrop tone` 指代——它一旦写死 `pure unbroken black`，覆盖了 `backdrop` 也会被这句话拽回去（单测按颜色词表逐档扫）。
    - `defaults`（**可覆盖**）：`backdrop / lighting / palette / material / props / mood / figure`。字段名与 `manifesto.artDirection`、`imagePrompt.mergeArtDirection` **全库统一**——名字对不上就等于覆盖静默失效，正是这次要修的那类缺陷。
    - 合成规则在 `imagePrompt.mergeArtDirection` + `composeImageBody`：**逐字段**取「ad 有值用 ad、空用缺省」，technical 位（no-text 恒为正文最后一句、负向框、`3:4`）与 structure 一样不可被方案改写。`graphic` 路线共用同一个合成器，只是没有风格档 → 只合成方案真的说过的字段，由 `artDirectionNote()` 输出中文摘要给排版层。**一套机制两条路线**，别再各写一份。
    - 守卫用例分两层：`LEGACY_CLAUSES` 是拆分当天从旧骨架逐字摘下的关键子句快照，钉住「方案什么都没说时必须还原出语义等价的提示词」（拆错一个字段不会让 prompt 变得不通顺，只会让这一档不再是这一档）；另一层钉覆盖优先级、留空回落、structure 不可覆盖与行动区存在性。**加一档新风格必须同时补 `LEGACY_CLAUSES`**，否则等价还原对它是空断言。
  - **承诺同源：客户读到的画面描述与生图提示词必须出自同一份字段**。`artDirection` 的每个字段是 `{zh, en}`：`zh` 原样念给客户（`briefDraft` 的 designNote 尾句、`artDirectionNote()`），`en` 原样进 prompt；模型只给中文时由 `AD_LEXICON` 补英文，词表命中不了的中文**原样透传**（不做机器翻译，也绝不丢字段）。三条硬规则：① 宣言与 brief 抽取的提示词都写明「**没聊到的字段必须留空**」，硬编一个字段就是替客户许下他从没提过的承诺，他会在确认页读到、然后在成品图上找不到；② 中文摘要**只念 `source==='ad'` 的字段**，缺省是骨架的事，念出来就成了没人许过的诺；③ AD 值是不可信文本，与 subject 同一套卫生（剥 `BANNED_QUALITY_WORDS`、剥景别词——景别归 `structure.camera`、去花括号、截断）。`briefDraft` 把 AD 序列化进 `visualDirection`（只有 100 字，序列化按 背景→光线→色彩 的重要性排序，被 clip 砍掉的是尾部次要字段）往下游走；宣言原文仍进 `promptSnapshot` 供排障。资产 metadata 另记 `artDirectionOverrides`/`artDirectionNote`，线上出现「说的和画的不一样」时直接给答案，不必拿宣言长文与英文 prompt 逐句对读。
  - **真实方向缩略图**：运营后台用已显式标为 `audience=internal` 的成功 `CreativeJob.poster_png` 创建 `CreativeDirectionSample` 草稿；未归类的 user 任务一律 `SOURCE_JOB_NOT_INTERNAL`，避免运营误填真实客户任务后让其作品消失或未经归类成为公开物料。建草稿必须同时核对 brief 与 `resultJson` 的实际 tier/方向/route/degraded，避免把历史跨档降级图挂成高级样例。上传失败补偿删除对象与草稿；发布前验非空 key、对象存在且可解码，空 key 绝不传给 OSS 签名。审核发布后 `/creative/status.directions[].previewUrl` 才对外；发布新样例会归档同方向旧样例。不得把用户归属的 `CreativeAsset` 直接当全局物料，也不得把样例塞进小程序代码包。确认页和收费换方向面板用**横向可浏览的 3:4 大图卡**（手机上一屏露出约两张半提示可滑），禁止退回三列等宽小卡把名称、说明和 AI 人物提示挤到不可读。
  - **图片供应商方言（`visual.dialect`，2026-08-12）**：三家的 images 接口长得像但请求体不通用，`buildVisualBody()` 是纯函数、单测钉死：`ark_seedream` **必须显式 `watermark:false`**（方舟默认 true，印着水印的付费海报没法交付；该字段刻意放在 `extraParams` 之后，运营改不回来）+ 用原生 `negative_prompt` + `optimize_prompt:false`（提示词被改写会把"画面内不得有文字"改没）；`gpt_image` **绝不能带 `response_format`**（gpt-image-1 收到直接 400）；`openai` 保持原行为。填错方言的现场信息只有一句 HTTP 400，所以后台选项文案必须把这三条差异写出来。
  - **主视觉尺寸必须是 3:4**（`assertVisualSize`，写入口校验，宽高比 0.6–0.9）：主视觉全幅铺底，比例不符会被 `object-fit:cover` 裁掉一整条，人像档裁掉的往往正是脸，而且**完全静默**（渲染成功、任务全绿、图是坏的）。⚠️ 2026-08-12 实况：生产这一项配的是 `1440x2560`（9:16），每张影像海报都在被上下裁；同时 `extraParams.size='2K'` 从未生效（显式 `size` 覆盖它）。缺省值同步从 `1024x1024` 改为 `1440x1920`。
  - **反廉价清单**：创作提示词里那段「别让它看起来像自动生成的」（卡里套卡 / 均匀铺满 / 处处居中 / 三种强调手法叠加 / box-shadow 浮起来的卡片 / 纯平色块 / 数字英文抢眼）管的是**量测器一条都量不出来**的东西——这些特征完全合规，却一眼露怯。删掉它除了那条守卫用例不会有任何测试变红。
  - **回落矩阵**：standard 的 AI 排版遇模型不可用 / 宣言失败 / 三轮仍违规 / 渲染或量测异常 / 超预算 → 复用同一个 `runTemplatePipeline` 交 graphic 模板，回落原因写 `resultJson.aiEngineError`；premium 不走这条回落，失败退款。两档共享模板函数，但主视觉必须在进入排版前由 tier 门禁确定。
  - **LLM 写的 HTML 是不可信输入，与用户上传文件同级**。静态审计**只拒不洗**：清洗既改变模型的构图意图（删掉一块布局可能整版塌）又给绕过留缝（`<scr<script>ipt>`），而拒绝可回喂、清洗不可观测。白名单口径：`<head>` 只放行 `meta charset/viewport + title + style`；图片只放行 `{{PORTRAIT_URL}}/{{LOGO_URL}}/{{QR_URL}}` 与 `data:image`；`script`/`on*`/`iframe`/`object`/`embed`/`link`/`base`/其它 `meta`/`@import`/`javascript:`/外链 `url()` 一律整份打回。渲染层再加两道（`renderHtmlToPng` 的 **opt-in** 参数，报告 PDF 与模板海报行为一字不变）：`javaScriptEnabled:false`（CDP 关页面脚本执行，**已在真实 Chromium 实测：内联脚本改不动 DOM，而 `page.evaluate` 照常工作**）+ `allowUrlPrefixes` 请求拦截（只放行 `data:`/`about:`/`blob:` 与 OSS 签名域）。
  - **量测器违规码**（`canvasMeasure.posterScanFn`，页内纯 DOM 扫描）：`html_rejected` / `overflow` / `out_of_bounds` / `margin`(<12px) / `min_font`(<10px) / `text_overlap`(交叠 ≥ 较小块 25%) / `headline_missing` / `aimark_missing` / `qr_quiet_zone`(缺 `data-role="qr"` / <64px / 静区 <4px / 底色非白) / `placeholder_residue`。**每条必须带 selector + 实测数值**并逐条回喂——模糊的「有问题请改进」喂回去等于没喂。两个刻意设计：未提供素材的占位符**不清理**（留成违规回喂，否则模型永远不知道引用错了）；AI 标识缺失**直接注入固定 overlay**而不回喂（合规是服务端义务，不能取决于模型这轮听不听话；注入元素带 `data-poster-exempt` 豁免边距检查）。
  - **`posterScanFn` 必须自包含**（会被 `Function.prototype.toString` 序列化后在页面里执行，引用任何模块作用域标识符都会变成浏览器里的 `ReferenceError`，而那个错误只表现为「整单回落模板」，极难查）。相关坑：`npm test` 走 tsx/esbuild（默认 `--keep-names`）会往函数体塞 `__name(fn,"name")` helper，`tsc` 产物没有 → 「测试炸/生产好用」。现在渲染前用**字符串表达式**注入恒等 `__name` shim（用箭头函数注入会被同一个转译器改写，等于用坏的工具修坏的工具）。
  - **`gateway.completeText(system, user, {maxChars,maxTokens,temperature,model,images,allowThinking})`**：raw 文本原语（HTML 不塞 JSON string——长文本里一个坏转义就报废整份产物，而 HTML 自带 `<!DOCTYPE` 与标签闭合可直接结构校验）。无 live provider / 异常 → `null`，与 `structured`/`completeJson` 同口径，绝不伪造。`maxTokens` 默认 4000 且 `allowAux:false`：`openaiRaw/claudeRaw` 的 700 是辅助抽取预算（会把一页 HTML 拦腰截断），画质任务也不该被切到小模型。
  - **进度值仍是既有四段**（`philosophy|visual|render|upload`）：AI 引擎的创作+打磨+渲染整体记作 `render`。刻意不加 `compose`——小程序进度条按这四个值写死（`app/src/services/creative.ts`），新值会让它退回第一档文案。等前端跟上再拆。
  - **模板排版路径**：standard 直接排 graphic；premium 才用 `philosophy.composeVisualPrompt()` 生成无文字主视觉，再安全叠加中文/Logo/二维码。`layoutEngine` 只切排版实现，不得绕过 tier 门禁。
  - **契约**：`AdminCreativeConfig.layoutEngine`（`'ai'|'template'`，缺省 `'ai'`，白名单外的值一律按默认处理）；`AdminCreativeJobItem.layoutEngine`（读 `resultJson.engine`，老任务 `null`）/`rounds`/`aiEngineError`。⚠️ 别把它和 `AdminCreativeJobItem.engine` 混——那是 `CreativeJob.engine` 列（任务模型实现引擎，恒 `'native'`）。
- **渲染**：`services/creative/renderer.ts` 调 `reportPdf.renderHtmlToPng`，**复用同一个 puppeteer 单例 + 单并发队列 + 超时骨架**（绝不另起浏览器，一份 Chromium 就几百 MB）。模板自包含 HTML（无外链/无脚本/字体只用系统栈），渲染前跑确定性自检 + **溢出闸**（文档高于画布即整单失败退款，不把裁掉半个字的图发给用户）。test 模式返回 1×1 桩 PNG 但仍上报名义尺寸。
- **brief 必须原样往返**（2026-07-29 修，别再回退）：`GET /creative/posters/brief-draft` 下发的字段里，`brandKitVersion` / `negativePrompt` 是**服务端行为的开关**而不是展示用文案——前者决定是否走 `approvedBrandKit()` 注入品牌语气与色板，后者进提示词负向约束。确认页与换方向面板 submit 时是**重新拼一个 brief 对象**，漏带就等于把整条 BrandKit 链路变成死代码（提示词品牌块、`THEME_HINT_COLORS` 色板表、语气合并全部走不到），而且服务端单测各自都是绿的、什么都不会报。水化本地草稿时也要一起存进 state。这类缺陷只有「带 approved BrandKit 建单 → 断言 `promptSnapshot` 里有品牌痕迹」这样的端到端断言抓得住。
- **模板白名单**：MVP 三套 3:4（`person_hero` / `editorial` / `business_launch`）。poster 提示词让模型在成果里给出「成品图版式推荐：xxx（key）—— 理由」，服务端**只认白名单**。**「未指定」与「指定了被停用的」是两件不同的事**：未指定按 scene 回退默认（`SCENE_DEFAULT_TEMPLATE`）；**显式请求了被运营停用的模板 → 422**，不静默换一套版式照常扣 10 钻——用户为自己挑的那套付了钱，给别的就是货不对板，且运营停用某套模板通常正是因为它出问题了。启用中的清单由 `GET /creative/status` 下发（`TEMPLATE_CATALOG` 是名称/描述的唯一真源，前端不建本地目录——三份各自维护到 P4 上线时 app 与 admin 的描述已经对不上），**全部停用 = 无法建单**（不是回退，是 422）。文案长度超限 **422 不截断**；`ratio` 契约已收窄为 `'3:4'` 单值（9:16/1:1 是「能力未就绪」而不是「可以兜底」，二期放开时再往联合类型里加，让编译器去找该改的地方）。
- **功能开关只有一层**：后台「创作任务」页那个开关 = `FeatureFlag` 行 `creative-poster` 的 `enabled`，**唯一真源，行缺失视为关**（`isFeatureEnabled(CREATIVE_FLAG_ID, false)` —— 注意该函数的默认值参数缺省是 `true`，这里必须**显式传 false**，把它删了就是无声放量）。曾经在它之上还有一层 env `CANVAS_DESIGN_ENABLED` 取合取，2026-07-29 删掉：合取让「后台开了却不生效」变成静默失败，而它想承担的熔断职责比后台点一下慢一个数量级（SSH + 改 env + 重启）。**本功能现在一个环境变量都没有**（`_ENGINE` / `_MAX_CONCURRENCY` / `_TIMEOUT_MS` 同批删，理由见下条与 `server/src/env.ts` 同名段落）。配置持久化复用 `FeatureFlag` 单行的 `enabled + payload`（价格/日限额/渲染超时/模板启停/图片供应商接入点），供应商 `apiKey` 经 `secretBox` 加密、对外只回 `hasKey`。**图片供应商不硬编码**：未配置时「创意排版」照常可用，「主视觉大片」不开放；在途 premium 任务若拿不到主视觉则失败退款。
  - **写 payload 时必须显式落 `enabled`**（`updateCreativeConfig` 已这么做，别"优化"掉）：`FeatureFlag.enabled` 在 prisma 里是 `@default(true)`，而写 payload 走 upsert。生产库本来没有 `creative-poster` 这一行，运营第一次进后台**只改了个单价**并保存，行被创建时 `enabled` 就取默认 `true` → 一次改价操作把还没验收的功能放量了。现在 patch 不带 `enabled` 时回落到读到的 `cur.enabled`（行缺失 = false）。
  - `dailyLimit = 0` 是**不限量**，不是禁止创建（0=不限是常见约定，且真要停量该用上面那个开关，而不是把限额改成 0 等着用户撞墙）。
  - `timeoutMs` 是**渲染超时**（只传给 `renderPoster`，不是端到端），上限 `MAX_TIMEOUT_MS = 480_000`。**这是个不变式**：它必须小于 worker 的 `STALE_RUNNING_MS`（10 分钟，sweep 判卡死的阈值），否则一次正常的长渲染会在还没结束时被 sweep 抢回队列 → 同一单跑两遍、产出两张资产。改这两个数任何一个都要回头看另一个。
  - 删掉的三个 env 各有各的死法，别再加回来：**ENGINE** 全仓没有一处 `engine ===` 分支、`anthropic_skill` 也没实现，改它只改变 DB 里那个标签的字面值——一个会撒谎的旋钮；**MAX_CONCURRENCY / TIMEOUT_MS** 只作 payload 缺省，而后台保存是全量重写 payload，运营点过一次保存后改 env 重启就永久无效果（双真源）；**`maxConcurrency` 这个配置项本身也删了**——worker 一轮是串行 `await`，渲染又被 `reportPdf` 的单并发队列串起来，「worker 并发槽 1–8」是个假承诺，现为内部常量 `TICK_BATCH_SIZE = 2`（含义是「一轮最多连处理几单」，不是并发）。
- **路线与成本留痕**：`requestJson.operation=create|revise|regenerate` 是任务业务动作真源；只有 revise 禁止供应商调用，不能用 `parentJobId + chargedAt` 代替（不限量与零价 regenerate 同样没有真实扣费时间）。`resultJson.aiMode` 是历史字段名，现只记实际 `graphic|photo`，不是运营意图；`directionKey/styleKey/rebuildTriggered` 同步落结果。`CreativeJobView.styleName` 读的就是 `resultJson.styleKey`（画面已经按这一档出过了），**不读 brief**：建单时没人知道模型会选哪一档，影像路线失败的单也压根没有这个字段——那时就不该对用户说风格。`CreativeJob.provider` 只给实际可能承担图片成本的 premium 新单记 `configured`；standard 即使系统已配置供应商也记 null。`degraded/visualError/photoError` 仅兼容历史跨路线降级任务，新契约不再产生跨档降级。
- **图片审核**：`services/creative/imageModeration.ts` **只有 `none` 一种实现**（放行 + 落一条 skipped 审计，让「没审」这件事在 `audit_log` 里可查，而不是零痕迹放过）。同批删掉了 `HttpModerator` 半成品与 `imageModerationProvider` 配置项：那个实现直读三个**全仓只在该文件出现、既不在 `env.ts` 也不在 `.env.example`** 的 `process.env`，且 `provider='http'` 但缺 URL 时 return `NoneModerator` —— 后台显示「已开审核」、实际全部放行、连一条 error 审计都没有，比明确的「未接入」危险得多。保留 `ImageModerator` 接口 + `NoneModerator` 作二期接入缝（那时只需加一个 class + 一个 resolve 分支）。**这仍是合规缺口，见 §13。** 文案走既有 `moderate('input'|'output')`。
- **部署要求**（三条，缺一不可）：① `cd server && npm run db:push`（建/更新 `creative_job`、`creative_asset` 与全局方向样例表 `creative_direction_sample`；本仓无 migrations 目录）；② 中文字体——`deploy/Dockerfile.server` 已装 `fonts-noto-cjk`，**裸机部署需自行装**（当前生产 ECS 是 Alibaba Cloud Linux 4、已自带 `google-noto-cjk`、**没有 apt**，细节与 family 名的坑见 `docs/DEPLOYMENT.md` §5.2）；③ `npm run db:upgrade-poster-prompt -- --apply` 幂等把版式推荐段落追加进库内 poster 提示词（同时改 `Agent.systemPrompt` 与已发布的 `AgentVersion`，否则 C 端不生效；默认 dry-run）。**放量与回滚都不再需要动部署**：后台开关一开即放量、一关即熔断（约 1 分钟内生效，已入队任务留在库里，重新打开后 worker 继续跑）。
- **测试基线**：`creative.test.ts` 覆盖门禁/计费/status/admin；`creativeWorker.test.ts` 覆盖生命周期/退款/sweep/revise 真实字节复用；`creativePhotoRoute.test.ts` 覆盖 tier 在 AI/template 两种排版引擎、免费 revise、**不限量/零价 regenerate** 下的路线契约；`creativeCanvas.test.ts` 覆盖结构化评审、单次重构及违规回退；`creativeDirectionSamples.test.ts` 覆盖真实样例草稿/发布/实际路线、存储补偿与文件完整性。`metrics.test.ts` 必须覆盖视觉评审指标导出/reset。闭环用例注入 stub；量测器真实 Chromium 组仍用 `PUPPETEER_REAL=1 npm test`。

---

## 9. 运营后台（admin）

### 9.0 信息架构与外壳（2026-07-28 运营视角改版）

改版动机是「22 个目的地平铺在一条 56px 宽横滚底栏里、桌面端整屏当手机用、请求失败伪装成没数据」。现在的结构：

- **`admin/src/nav.ts` 是导航 SSOT**：24 个 section 按**「只读的归观测、可写的归配置」**归入 7 个运营场景组——`today 今日`（概览）、`people 用户`、`revenue 经营`（订单/漏斗/钻石消耗/Token 成本）、`studio 智能体`（顾问/技能库/知识库/检索调试）、`observe 观测`（调用诊断/内容审核/审计日志）、`catalog 商品`（套餐/单次付费/生态工具）、`settings 配置`（模型配置/功能开关/创作任务/行业基准/献策/**问策入口**/问卷/运营账户——已满 8 项，再加就拆组）。「问策入口」页（2026-08-08 WP5）承载提示问题池 / 进场主动消息池（含 chips 编辑）与改版灰度权重（chat 占比单滑杆 + 急停说明；权重展示归一化到 100%，与服务端 `effectiveArms` 同源）。label、hint、icon、`ownerOnly`、命令面板别名都在这里，页面不再各写一份标题。**分组时看页面的主导动词，别看次要属性**——初版把「模型配置」放进「稳定性」（理由是端点池冷却算健康信号），但该页主体是写操作，一个写屏混在三个只读观测屏里正是运营找不到东西的根因；同期「配置」组堆到 8 项混装商品/开关/内容/权限，也一并按此原则拆开。新增分区要么进现有组，要么拆组，**单组不超过 8 项**。
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

页面/接口：概览看板、**注册用户管理**（小程序注册用户、微信绑定、租户/套餐、最后会话、会话/成果数、算力余额，并可点进用户详情为其开通/取消 `unlock` 智能体）、**算力消耗**（按用户汇总赠送/消耗/余额、30 天活跃、成果数）、**审计日志**（最近 100 条，时间精确到秒；默认过滤 `admin.*` 后台自身行为，以单行列表展示用户 API、登录尝试、业务动作、用户/租户、摘要、方法/路径/状态码、IP/UA；窄屏切换为紧凑事件流，避免手机横向滚动；每条可点击打开详情面板，查看完整账号上下文、请求状态、IP/UA 与原始 payload；需要后台日志时传 `includeAdmin=true`）、每日献策库（增删改启停）、智能体/功能配置（新增智能体、基础信息、`free/unlock/metered` 定价、System 提示词、对外问候语、专属理解提示 `memText/learnText` + Agent Memory 策略 + **上架/下架**，前台 `/agents` 默认只展示已上架功能）、**技能库**（新增/编辑自定义 HTTP 工具，复用后台统一的 `add-btn full`、`crd new-agent`、`ai-field`、`ai-btn`、`mini-btn` 组件语汇，避免局部 inline button 样式）、**模型配置（凭证 / 接入点 / 六用途路由，含直测、深度探活、分流池与用途预算，即时生效）**、建档问卷、套餐编辑。所有 `/api/admin/*` 路由由 `services/adminAuth.ts` 保护：运营端登录页填写后端 `ADMIN_TOKEN`，请求以 `x-admin-token` 发送；后端也支持 `role=admin` 用户。新增/扩展 admin API：`GET /admin/users/:id`、`POST /admin/users/:id/agents`、`DELETE /admin/users/:id/agents/:key`、`POST /admin/agents`、`PATCH /admin/plans/:id`，并保留 `GET /admin/users`、`GET /admin/usage`、`GET /admin/audit-logs`。入口 `admin/src/App.tsx`（`UsersView/UserDetailPanel/UsageView/AuditView/ModelView/PlansView`）+ `AgentDetailPanel.tsx`，API `admin/src/api.ts`（类型来自 SSOT）。智能体详情保存采用真正的 dirty-field PATCH：只提交本次改动字段，保存 `greet/memText/learnText` 时不得夹带提示词、模型、权益或运行参数；后端继续统一审计并重算 `draftDirty`。默认 System Prompt 与公开文案初值位于 `server/src/data/agents.ts`，但既有环境的数据库草稿/已发布版本才是运行时事实来源；`npm run admin:sync-content` 默认只做目录结构与缺失内容的非破坏同步，提示词、问候语和计价字段均属运营所有，不能把它当成文案发布工具。前端离线文案镜像只走 `cd server && npm run copy:sync`，既有环境则在后台逐个改草稿、核完整可发布字段 diff、沙盒验收并发布。Agent Memory 开关保存到 `Agent.memoryConfig` 并由后端真实读取：`longTerm=false` 时不召回/不写入长期记忆，`autoLearn=false` 或去掉 `conversation` 来源时不从对话学习，`intensity/retentionDays` 影响写入权重和过期时间，`deliverable_feedback` 控制成果反馈回流。LLM 调用详情的 `LlmTrace.contextJson` 持久化本轮回忆意图、近期/较早消息数量以及召回记忆的 id/score/source/时间（不存记忆正文），运营后台「调用诊断」可直接查看；部署这次结构加法时需先执行既有 `prisma db push` 流程。开发期 Vite 代理 `/api → localhost:4000`。本地后台使用全屏无边框容器，`admin/src/styles/admin.css` 需要保持视口安全收缩、横向隐藏和长文本断行，底部导航为横向滚动，避免新增模块或模型 URL/API Key/状态文案撑出屏幕。

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
- 大模型真源为 `AiCredential` / `AiEndpoint` / `AiRoute` / `AiRouteMember`；旧 `AiSetting` / `AiModel` 只用于一次性迁移和 `AI_CONFIG_V2=false` 应急历史快照。pgvector 开启时 `knowledge_chunk` / `memory` 另有 `embedding_vec vector(N)` 列（由 `prisma/pgvector.sql` 建，非 Prisma 管理）。
- `Casefile` + `CasefileOrder`（军令，`aligned` 对齐性标注）+ `CasefileMetric`（每日回填，`(casefileId,date)` 唯一）——执行闭环（M0 PR-EX），用户级 active 案卷唯一。
- `NatalChart`（命盘，`userId` 唯一、重排覆盖；`engineVersion` 支持按版本批量复算；`chartJson`=ChartView 全量结构）——排盘引擎（M1 PR-1）。生辰输入与「不信命理」偏好存 `Profile.extraJson.bazi`。
- `ReviewLog`（复盘日志，`(userId,layer,date)` 唯一）——M2 PR-8：六层复盘事件账本；day 层由执行页发起复盘时落库（快照当日军令完成/对齐/回填事实）；**对齐率=对齐军令÷总军令、连续复盘天数由服务端从行计算**（今天未复盘不打断，从昨天起算）；scheduler 挂断档提醒（`review-gap-reminder`）。注入【复盘账本】块。
- `WechatSubscription` + `WechatNotificationLog`：订阅消息一次性授权额度与发送日志。`(userId,scene,templateId)` 唯一；`accept` 增额度，发送成功扣额度；日志记录 `sent/failed/skipped` 便于排查复盘提醒、报告生成触达。
- `PlanEntitlement` + `SkuEntitlement` + `MonthlyCreditGrant` + `TokenQuotaAdjustment`：套餐/SKU 权益来源账本、年付月度钻石幂等锚点、运营临时额度增量；报价/退款按来源订单重算，重复购买同一模块时退款一单不撤其它来源，临时调整不覆盖已用量。增购包（credits/quota）的 `SkuEntitlement.quantity` 记**实际发放量**（不限量兜底跳过发放时显式写 0，盖掉默认值 1），退款回收以 entitlement 量为准、下单快照量只作缺行兜底——防「没发出去的量被退款追扣」。
- `ProphecyLog`（预言账本，`(userId,seq)` 唯一）——M2 PR-9：预言/依据/验证标准/到期时间/状态（pending|hit|miss）；**写入源=真实模型结构化抽取（gateway.extractProphecies，测试/mock 返回空→绝不产生伪预言）+ 显式接口**；总军师输出后 sessions 路由异步收割（有命盘用户才抽）；`prophecy-due-scan` 到期登记对账候选（行级 `dueNotifiedAt` 幂等）；命中率服务端算、无样本 null。注入【天机账本】块。
- `UserProgress`（用户进度，`userId` 唯一）——M2 PR-10：战略段位（新兵→尉官14天→校官30天+月复盘→将军90天+准确率>60%→元帅180天+>70%+命中率>50%；**只升不降**，null 指标视为不达标不放水）+ 里程碑（使用天数 7/30/90/180/365 解锁，记首次解锁日期）；晋升记审计 `user.rank.promoted`（晋升卡素材）；`syncProgress` 无变化不写库。注入【段位·里程碑】块（新用户零记录不注入）。
- **复盘保底（M2 PR-6）**：`reserveQuota(userId, ratio, {grace:'review'})`——余额≤0 时复盘类调用（`buildReviewPrompt` 确定性前缀识别）每日最多 `REVIEW_GRACE_PER_DAY`(2) 次放行（透支记账+`system.quota.grace` 审计）；套餐到期锁定不受影响。**复盘动线归属总军师 general（免费），ops 经营参谋保留为可解锁深聊**——复盘是留存生命线，不设解锁墙。
- `DecisionLog`（决策日志，`(userId,seq)` 唯一自增序号）——M2 PR-7：决策/理由/天势参考/验证标准/验证期/状态（pending|correct|revise）/快慢标注；写入源=认可方案自动记账 + 手动接口（AI 工具位与 LLM 抽取随 PR-9 共建）；**准确率（含快/慢分开）一律服务端从状态行统计，无已验证样本返回 null 不编 0%**；注入【决策账本】块（近 5 条 + 准确率 + 禁止 AI 自算口径）。
- `WenceTemplate` + `ClientEvent`（问策入口 WP1）：前者是运营模板池（`kind='hint'` 提示词 / `'proactive'` 进场主动消息，带 `chipsJson/enabled/sort`）——**禁止 seed，空池合法**，与定价权益同一「对外内容归运营」原则，故它作为运营目录**不进** `prisma/resetBusinessData.ts`（进了就会在预发 seed 时被清掉运营录入的内容）；后者是埋点原始事实表，`userId/tenantId` 可空且**无外键**（游客上报），因此必须像 `CreativeJob` 那样显式写进 `resetBusinessData`，否则跨用例累积。
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

默认仓库根目录：`/Users/donis/dev/ai-pilot`。微信源码在 `app/weapp-native`，产物在 `app/dist-native`；本地 DevTools 走查优先导入 `app/dist-native/`，发布/auto-preview CLI 仍指向 `app/`（`project.config.json` 的 `miniprogramRoot=dist-native/`）。H5 产物独立放在 `app/dist-h5/`。本机预览二维码和信息文件统一输出到根目录 `weapp-preview.png` / `weapp-preview-info.json` / `weapp-auto-preview-info.json`，均不纳入提交。

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

**套餐与定价改动走运营后台，不走代码（2026-08-01 定）**：线上套餐的价格/额度/权益/周期/上下架只有一个入口——运营后台「商品 · 套餐」（`GET/POST/PATCH/DELETE /admin/plans`，requireSuper + 审计留痕），全新部署也是先在后台建档。`GET /admin/plans` 必须在响应出口用 `planRules` 补齐迁移期可空的 `planFamilyKey/tierRank/usageLevel/usageLabel`，并为用量阈值提供契约默认值，保持 `AdminPlan` 的非空口径；否则存量档进入编辑态后会在字符串 `.trim()` 处崩溃。`server/src/data/seedConfig.ts` 的 `DEV_PLANS` 只是**本地/测试夹具**，改它不影响线上、也别指望能改线上。原 `db:sync-plans` / `db:bump-free-quota` 两个脚本已删除：前者按 name 全字段 upsert，运营把入门版从 ¥68 改成 ¥99 之后，任何一次全量同步都会静默把线上价打回代码常量（dry-run 实测会打印「更新 入门版」）；后者写死 `PLANS[0]`，免费档下架后 `PLANS[0]` 变成付费入门版，跑一次就把付费用户的 token 钱包重置成夹具值。`npm run db:seed` 是破坏性的（deleteMany 套餐/智能体），现带生产护栏：`NODE_ENV=production` 或 `DATABASE_URL` 非本地一律拒绝执行（确认是测试库才加 `--i-know`）。同理 `npm run admin:sync-content` 默认**不覆盖**计价字段（agent 的 `gift/billing/price/billingRatio/meterUnit`、sku 的 `name/desc/priceFen/sort`）——与提示词同一「运营所有」约定，确需用仓库常量改线上价才加 `--force-pricing`。

**挂牌价 / 优惠价 / 生效时间（2026-08-08）**：`Plan.price` 是**挂牌价**，`promoPrice` + `promoStartsAt/promoEndsAt` + `promoLabel` 是一段有生效窗的**优惠价**，全部在运营后台「商品 · 套餐」里配（POST/PATCH `/admin/plans`，requireSuper + 审计带优惠前后快照）。窗口到点自动切换，不需要人工改价：未到 `promoStartsAt` 按挂牌价卖（可预约调价），过了 `promoEndsAt` 自动回挂牌价。**服务端一切读价都必须先过 `services/planPricing.ts` 的 `withEffectivePrice()`**——它把 `price` 换成「此刻的成交价」、把挂牌价挪到 `listPrice`、并算好用户侧折扣对象 `promotion`（`discountLabel` 形如「1折」）。已接入：`GET /plans`、`/plans/options`、`/plans/:id/quote|order|contract-order|purchase`、`quotePlanChange` 的在册档、`buildOrderSnapshot`（下单快照冻结成交价）、`scanAutoRenewals` 的改价停扣判断。**漏包一处就是真金白银的偏差**：`PlanEntitlement.listPrice` 记的是成交价快照，写挂牌价会让 ¥3980 买的档在升级时抵掉 ¥39800（`test/planPromotion.test.ts` 钉住）。硬约束是 `1 ≤ promoPrice < price` 且只允许配在正价档（`price>0`）上——保证生效价恒为正，`price<=0`（免费层不设到期）与 `price<0`（面议档禁止自助购买）的语义不会被优惠翻转，所以调用方无需为优惠新增分支。折扣率只有服务端一份实现，三个端只做文案拼装：**原生小程序** `weapp-native/packages/work/plans/index.js` 的 `promoView()`（WXML 不能调函数，`discountLabel/kickerText/listPriceText/saveText/deadlineText` 必须在 `setData` 前算完）、**H5** `app/src/packages/work/plans/model.ts` 的 `promotionKicker/promotionSave/promotionDeadline`、**运营后台**列表行。方案卡的价格区**所有档共用一套结构**（大号现价 + 周期单位），优惠档只叠加角标、整卡提色与「原价/立省/截止」——不给优惠档另换排版，同一列表里两种版式会看起来像坏了；促销色一律走 `--accent*` token，本命色有 6 套主题，写死红色会在其中 5 套里显脏。以上由 `app/scripts/native-weapp.test.mjs` 的折扣用例静态钉住（禁止端上重算折扣率或立省金额、禁止 WXML 里出现价格算术、禁止写死非白 hex 底色）。已开自动续费的档配优惠时：优惠结束后 `scanAutoRenewals` 发现成交价 ≠ 授权金额会转 `cancel_pending` 停扣并等用户重新确认，不会按挂牌价静默续。

注意套餐额度调整只影响新用户：钱包 `quota` 是首建/购买时的快照，跨月重置也复用快照、不回读 live plan（见 `services/tokenQuota.ts`）。要给存量用户补额度，用运营后台的 per-user 额度写端点（`POST /admin/users/:id/token-quota`），不要再写批量刷库脚本。

Taro Webpack5 缓存只服务 H5。微信原生构建不经过 Webpack；若 DevTools RC 在外层 `miniprogramRoot` 重建时保留旧文件索引，先关闭项目、完成 `npm run build:weapp:server`，再直接导入 `app/dist-native/`，不要把缓存报错误判成源码缺文件。

**小程序真机实时预览**

用户说“推送真机实时预览”时，优先复用/启动一个 `screen` 后台 watch，再触发微信开发者工具预览；不要开多个重复 watch。
```bash
screen -ls | rg ai-pilot-weapp-watch || \
screen -dmS ai-pilot-weapp-watch bash -lc 'cd /Users/donis/dev/ai-pilot/app && WEAPP_APP_MODE=mock npm run dev:weapp > /tmp/ai-pilot-weapp-screen.log 2>&1'

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
WEAPP_APP_MODE=server WEAPP_APP_API="http://$LAN_IP:4000/api" npm run dev:weapp
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
该命令依次执行 `build:weapp:server` → 校验 `dist-native/junshi-build-meta.json` 的 `runtime=native-weapp`、`mode=server`、生产 API 与上传版本完全一致 → 检查 DevTools 登录态 → CLI 上传；加 `--dry-run` 可只构建校验、不触达微信。产物在 `app/dist-native/`（外层 `miniprogramRoot=dist-native/`）。**上传这一步由 agent 自己执行，不要甩给用户**。DevTools 需已打开且开启「设置 → 安全 → 服务端口」。底层等效命令如下，仅用于排障，正常发布不得直接调用：
1. **微信开发者工具 CLI（底层首选，无需上传密钥）**：复用已登录的 DevTools 会话，`--project` 指向 `app/`（含发布配置；本地界面走查才导入 `dist-native/`）：
   ```bash
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli upload \
     --project /Users/donis/dev/ai-pilot/app \
     -v <版本号> -d "<本次变更说明>"
   ```
   退出码 0 且打印 `✔ upload` + 体积表即成功，进入 mp 后台「版本管理 · 开发版」。版本号每次递增，上传前后同步 `docs/WEAPP_RELEASES.md`。GUI 仅作为 CLI 不可用时的最后回退：上传前必须人工打开 `dist-native/junshi-build-meta.json` 核对 `runtime/mode/API/version`，且预览中不得出现红色 MOCK 标识。
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
脚本会打包当前 git `HEAD`、上传到 ECS、替换 tracked 应用目录（保留 `server/.env`、`logos/`、`backups/` 等运行时/主机产物）、执行 `npm ci` / `prisma generate` / `db push --skip-generate` / 后端构建重启 / admin 构建发布 / nginx reload / 公网 smoke。`DEPLOY_H5=1` 时构建并发布 `app/dist-h5/`；微信原生迁移后不得再从旧 `app/dist/` 复制，否则构建虽绿、复制阶段仍会中断且线上继续保留旧 H5。例行升级不跑 `npm run db:seed`，避免重灌演示数据影响线上业务；`server/.env` 不纳入上传包、不改权限。`npm audit` 提示只作为依赖治理信号，非部署阻断项；真正阻断以构建失败、`junshi-api` 非 active、裸 IP/域名 `/api/health` 非 200 或域名 `/admin/` 非 200 为准；裸 IP `/admin` 预期为 404。
`.claude/worktrees/*/AGENTS.md` 是 Claude 工作树副本，不是维护源；需要固化流程时改根目录 `AGENTS.md`、`scripts/deploy-prod.sh` 和必要的 `docs/*`。
正式微信小程序发布仍走 §11「本机上传到小程序平台」：上传前后同步 `docs/WEAPP_RELEASES.md`，版本号/描述与上传命令一致；连真实后端的小程序包用 `WEAPP_APP_MODE=server WEAPP_APP_API=https://你的域名/api npm run build:weapp`（生产固定域名直接用 `npm run build:weapp:server`）。

**预发环境**固定为 `/opt/junshi-preprod` · `junshi-api-preprod` · `:4001` · DB `junshi_preprod` · `https://wxapi.aibuzz.cn/api_preprod`，只用 `scripts/deploy-preprod.sh`。该脚本每次部署都会复制生产 `ai_setting/ai_model` 供真实模型验收；AI 对话/Embedding/Rerank 凭证现统一明文存库，不再把生产 `APP_ENCRYPTION_KEY` 持久写进预发。兼容窗口里若生产行仍是旧 `enc:v1` 密文，脚本只在迁移进程环境中临时传入生产旧主密钥，整批解密成功后原子写为明文，并硬验密文为 0；生产完成同一迁移后自然不再需要主密钥。脚本仍会删除预发 `.env` 中所有 `WECHAT_PAY_*` 真商户凭据，并强制 `NODE_ENV=development` + `PAY_MOCK_SUCCESS=true` + `PAY_SANDBOX=false` + `ALLOW_DEMO_PURCHASE=false`：预发可走真实订单/权益状态机，但绝不触发微信真扣款。快出片预发固定回源同机隔离 AIStar `http://127.0.0.1:8081`，必须配置 `AIDRAMA_CLIP_ALLOW_PRIVATE_NET=true` 与双方一致的独立 service token；AIStar 其它 API 不对公网开放。**注意：`8.136.36.175` 是军师生产宿主机，所以这套 AIStar 只能称“共宿主的逻辑预发”，不是独立预发服务器；军师生产并不调用它，而是以 `AIDRAMA_CLIP_BASE_URL=https://api.aibuzz.cn` 跨服务器调用 `47.98.162.120` 的 `aistareco-server`。**小程序预发包用 `cd app && npm run build:weapp:preprod`，并核对 `dist-native/junshi-build-meta.json` 的 `runtime/mode/api/gitSha`；DevTools CLI 的 `--project` 仍指向 `app/`。**预发构建与生产同机，这不是免费的（2026-08-15 事故）**：Prometheus 还原出部署前 `/tmp` tmpfs 的 Shmem 已随 AIStar Clip 历史 JAR 残留从约 48MiB 阶梯增长到约 2.97GiB，宿主 `MemAvailable` 只剩约 670MiB且无 Swap；随后预发 `npm ci` 把 CPU 推到约 84%，SSH/HTTP/监控陆续失联。Dify 已按用户决定下线并保留 `/opt/dify` 数据。部署脚本不再覆盖在线 server：候选版本在 `/opt/junshi-preprod/releases/release-*` 完成依赖、Prisma 生成和 build，确认 `dist/index.js` 后原子切换 `/opt/junshi-preprod/server` 符号链接；启动/本机 health 失败自动切回上一版。构建前 `MemAvailable <3GiB` 拒绝，npm/prisma/build 通过 transient systemd cgroup 限制为 `MemoryMax=2G`、`MemorySwapMax=0`、`CPUQuota=100%`、`Nice=19` 与 idle IO。AIStar 的 `deploy-clip-preprod.sh` 同步以 `trap` 清当前 `/tmp` JAR并兜底清理超过 60 分钟的同类残留。

**「快出片」后端职责与配置边界**：军师 BFF 负责军师 JWT/租户、脚本 AI、文本与媒体审核、积分预扣结算退款、通知、审计与限流，其运行时真源是 `AIDRAMA_CLIP_*`、`CLIP_MEDIA_MODERATION_*`、`ALIYUN_GREEN_*`、`WECHAT_SUBSCRIBE_AVATAR_TEMPLATE_ID` 和军师自身 LLM/套餐配置；AIStar Clip 负责模板/项目/素材/数字人/声音/任务/作品、石榴 speaker/avatar/TTS/video、ffprobe、抽帧、FFmpeg 总装、字幕/BGM/标识、质检、存储与回收，其真源是 `AEP_CLIP_SERVICE_TOKEN`、`AEP_CLIP_SHILIU_*`、`AEP_CLIP_PRICE_*`、任务/素材/回收/质检阈值及 AIStar DB/存储/CDN/FFmpeg 配置。两边 service token 必须成对一致；军师用户 JWT 不发给 AIStar，石榴 token 不进入军师或小程序。生产目标是 `172.30.184.223` 军师 → `172.30.184.224` AIStar 的同 VPC 私网回源，并继续保持两机资源隔离；4 核 / 7.3 GiB、无 Swap 的军师宿主当前不允许再常驻一套 Clip 生产。详见 `docs/DEPLOYMENT.md` §8.1。

### ★ 一键开发（PostgreSQL，推荐）
```bash
npm run dev            # 根目录：确保 PG → 建库 → 迁移 → (首次)灌种子 → 同时起 后端 + H5 + 运营后台
```
- 入口 `scripts/dev.sh`（根 `package.json`）。打开 **H5 http://localhost:5173**（浏览器手测）、后台 http://localhost:5174（改模型）、API :4000。
- 可配：`AI_PROVIDER=openai npm run dev`（真实模型）、`SEED=1 npm run dev`（强制重灌种子）、`DATABASE_URL=... npm run dev`（指向已有库）、`DB_NAME/DB_USER/DB_PASS/DB_HOST/DB_PORT` 覆盖默认。
- 演示账号手机号 `13800000000`（含演示项目/报告/知识）；Ctrl+C 一并关闭三端。

### 本地 mock（零依赖，纯前端走查）
```bash
cd app && npm install && npm run dev:weapp   # 微信开发者工具导入 app/dist-native/；或 npm run dev:h5 浏览器
```

### 真实后端（PostgreSQL）
```bash
cd server && npm install
cp .env.example .env            # 配 DATABASE_URL；AI_PROVIDER 按需
npm run db:push && npm run db:seed
npm run dev                     # http://localhost:4000
# 原生小程序连后端：WEAPP_APP_MODE=server WEAPP_APP_API=http://localhost:4000/api npm run dev:weapp
cd admin && npm install && npm run dev   # 运营后台
```

### 构建校验基线（每次大改后应保持全绿）
- `server`：`npx tsc -p tsconfig.json --noEmit` → 0
- `app`：`npm test` → 原生路由/非受控 textarea/Lucide/产物隔离 + H5 typecheck + PC 零 Taro/区域真源守卫全绿；`npm run build:weapp:server` → 原生 49 路由四件套、JS 语法、无 Taro 引用、生产元数据校验通过；`npm run build:h5` → Taro H5 构建成功；改 PC 另跑 `npm run build:pc`
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
  而是 `node --test` 自己 glob——该能力 Node 22 才有。前后端 CI 都固定 node 24；后端 gateway/LLM gate 的异步计时用例在 Node 20 会被测试运行器提前结束事件循环并批量标为 cancelled，禁止降回 Node 20。
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
- 全程 mock 模型（确定性、可复现），无需真实 key/pgvector。**现状 1530 用例 / 256 套件（0 跳过）**；覆盖微信登录 openid 复登、运营后台鉴权、算力/套餐购买（含挂牌价/优惠价生效窗）、大模型接入配置、智能体权益、军师档案访谈、问策入口 WP1（分桶/主动消息/词池/埋点）、连续主线/摘要滚动合并、事实确认、复杂交付、9 图批处理与用户主路径。最近一次本地 PostgreSQL 测试库全量实跑为 2026-08-10（独立测试库 `junshi_test`），1530/1530 全过。
- **并行分支要用独立测试库**：`server/.env.test` 的 `DATABASE_URL` 是唯一入口，worktree 里改成 `junshi_test_<主题>` 即可与主检出并行跑测试而不互相 `db push` 冲 schema（本次 WP1 用的是 `junshi_test_wence`）。合回 main 前记得把这行改回 `junshi_test`。
- **★ 测试环境自足（hermetic env，2026-07-27 起）**：`npm test` 只吃 `.env.test` + 真实 shell 环境 + 用例内显式设置，**绝不吃开发机的 `server/.env`**——否则用例红绿取决于谁的机器（CI 没有 `.env` 故长期为绿）。三层机制：① `src/env.ts` 在 `NODE_ENV=test` 时整体跳过 dotenv；② `@prisma/client` 会在 import 与每次 `new PrismaClient()` 时**无条件**读 `server/.env`（路径烤进生成产物、与 cwd 无关，Prisma 5.22 无 opt-out），故 `test/hermeticEnv.mjs`（由 test 脚本 `--import` 预载）记下进程启动时的键集合并抹除后来被注入的键，`src/db.ts` 在构造语句下一行调该钩子；③ 守卫用例 `test/envHermetic.test.ts` 读 `.env` 的键做通用断言（不 pin 变量名），所以往 `.env` 里加新键不会再弄红测试。**推论**：用例要用的变量写进 `.env.test` 或在用例里显式 set/delete，别指望 `.env`。
- **★ AI v2 测试配置必须归还现场（2026-08-14 起）**：`AiCredential/AiEndpoint/AiRoute/AiRouteMember` 是运营配置，刻意不进 `resetBusinessData()`（该函数还被生产 seed 共用，加入会误删真实接入）；任何测试用 `configurePurpose()` 或直接写这四表，都必须在 `after/finally` 调 `__wipeAiV2()`。约定“全程 mock”的聚合套件还要在入口显式复位，不能相信共享 `junshi_test` 恰好干净。历史坑：`structuredBilling.test.ts` 留下 OpenAI chat 路由后，TC-L 动态预留从 2,000 变 136,000，8 并发中第 4 个起返回 402；这不是 429 限流或 503 过载。
- **UserJourney 首次并发建行**：禁止用空更新 `upsert()` 假设数据库原子建行；Prisma 在首次并发下可能撞 `userId` 唯一键。统一用 `createMany({ skipDuplicates:true })` 建幂等初始行后再读取，事件迁移继续走带状态条件的 `updateMany()`。
- **测试夹具不得依赖日历碰巧未过功能上线日**：只验证 provider/gateway 的新注册用户必须显式创建 Profile 或其它已入局锚点，不能靠 `createdAt < ONBOARDING_ROLLOUT_AT` 绕过首次入局；否则固定上线日期一过，请求会被补档案流程提前接管，原本绿色的测试会集体变红。
- 覆盖：鉴权隔离、微信 openid 登录/复登、注册花名、军师档案、运营后台鉴权、多智能体对话、智能体 `free/unlock/metered` 权益、记忆语义召回+TTL、项目+知识库+跨对话召回、跨项目隔离、对话汇总、版本化报告+diff、**★跨用户隔离（防信息泄露 TC-G）**、模型配置不泄露明文 key、SSE 流式、内容审核拦截、算力赠送/扣减/不足拦截、套餐购买/企业版不限量、并发回归（智能体购买、套餐发放、短信发放/消费、报告版本、智能体发布）、首登建档个性化、老用户回流、跨智能体协同+引用闭环、成果反馈回流、用户主路径、边界健壮性。
- CI：`.github/workflows/server-integration.yml` 用 GitHub Actions Node 24 + `postgres:16-alpine` 服务（tmpfs 数据目录）执行 `npm ci`、`prisma generate`、后端 build、`prisma db push`、`npm test`。
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
WEAPP_APP_MODE=server WEAPP_APP_API=https://你的域名/api npm run build:weapp
```
微信开发者工具本地走查导入 `app/dist-native/`；真机/预览必须把 `WEAPP_APP_API` 的 HTTPS 域名加入小程序后台 request 合法域名。

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

- **Notion 工程变更日志待补 2026-08-15 宿主机事故闭环**：本次已完成 Dify 下线、AIStar Clip `/tmp` JAR 泄漏修复、军师预发原子 release 与资源 cgroup，并以真实预发 8925cc2 验收生产/预发/AIStar 三服务健康；完整产品可读结论在 `docs/CHANGELOG.md` 顶部。当前会话无已安装的 Notion 连接器，无法同步「军师 · 工程变更日志（持续更新）」；连接恢复后应补到页面顶部，完成后删除本条。
- **宿主机进一步扩容项暂缓（2026-08-15 用户决定 hold）**：本次已下线不再使用的 Dify（Compose 容器/网络移除，`/opt/dify` 持久化数据保留）、补齐预发原子 release 与 3GiB preflight/2GiB+单核构建 cgroup，并修复 AIStar Clip `/tmp` JAR 泄漏。以下暂不做：增加 Swap、把预发/AIStar Clip 迁出生产宿主、ECS 扩到 8C16G。继续共宿主期间必须保留现有资源闸；若再次出现 MemAvailable 长期低于 3GiB、FFmpeg 与部署并发、或生产延迟受影响，应优先恢复迁机/扩容议题，不能靠反复重启。
- **预发 release 自动轮转暂缓（2026-08-15）**：原子发布会在 `/opt/junshi-preprod/releases/release-*` 保留候选/历史版本，当前先保留用于快速回滚，不在事故修复里加入自动 `rm -rf`。磁盘仍有约 117GiB 可用；后续应在验证 3 次发布/回滚后增加只匹配 `release-*`、保留当前目标和最近 2 个版本的安全轮转，并纳入磁盘告警。
- **存量预发验收任务待部署后显式归类（2026-08-14）**：只读核查确认生产没有任何活跃用户的海报任务；预发 12 个任务中有 6 个方向样例来源、2 个明确 E2E、其余为人工验收。代码已让方向样例来源（含字段上线前旧来源）退出 C 端，并提供 owner 可用的 `POST /admin/creative/jobs/:id/audience`；但部署前数据库还没有 `audience` 列，且 2 个 E2E/人工验收任务尚未标 internal。本次未获部署/改线上数据授权。上线顺序必须是 `db push → 发服务端/后台 → 把明确 E2E 与不应保留的验收任务标 internal → 用新真实手机号验空作品库`；禁止用标题前缀作为长期过滤规则。
- **历史静默换绑只能审计、不能自动复原（2026-08-14）**：只读生产审计在 8 个手机号快捷登录用户中发现 2 个 `userId` 曾出现多个脱敏手机号，且中间没有显式 `auth.bind_phone.attempt`；本次修复已阻止后续真实号在登录时被覆盖，但历史审计只保留 `phoneMasked`，没有旧号码明文，不能安全自动恢复。手机号还可能被运营商回收，禁止用“曾绑定过”永久占号或仅凭旧号码把当前持有人导回原账号；历史投诉需结合同一 openid/unionid、现绑定号验证与人工审计处理。若量级扩大，再单独设计带验证状态和释放策略的凭证历史表。
- **`/api/video/*` 过载闸豁免与超时对齐已完成（2026-08-12）**：`server/src/app.ts` 的 `isLongRunning` 已把 `/api/video/` 前缀纳入豁免（它是到 aidrama 的同步 BFF 代理，耗时由外部系统决定，不是本服务排队的信号）；`/video/works` 另给 10s 上游上限（`aidramaJson` 支持 per-call `timeoutCapMs`，只能收紧不能放大全局预算），端上对应 12s——服务端先于端上放手，槽位不再被占。守护测试 `test/overloadGateExempt.test.ts` 钉住这两条。**仍未做**：`GET /reports` 无分页（全量 + include agent），锦囊拿它当方案作品源，量大后要补 take/游标。
- **五 tab IA 重排的遗留项（2026-08-12）**：① `/modules`、`enableModule`、`patchModule` 在小程序端已无 UI 消费方（原锦囊能力中心已删），server 路由与运营端暂保留；「已启用的兵器」现指向 `packages/work/market`（硬编码目录页），后续应改读 `/modules` 真数据做账单视角清单。② `pages/studio` 过渡跳转页保留一个发布周期后连注册一起删——**删之前必须先改 `server/src/services/wechatSubscribe.ts` 的默认落地页**（它下发的是无前导斜杠的 `pages/studio/index`；路由守卫已放宽到能扫出无斜杠写法，删注册会立刻变红，别硬改测试）。③ 锦囊「最近做的」为客户端三路聚合（posters/video works/reports），量大后应落 server 统一作品索引（registerWork：appKey/类型/缩略图/deepLink，上新子应用不改锦囊代码）。④ **军令兵器已落地（2026-08-12）**：绑定由**拆军令那一轮 LLM** 顺带选 `toolKey` 产生——同一次调用既写军令文案又选工具，1:1，不再事后按位置/下标对齐（端上旧实现是「第 N 条处方贴第 N 条军令」，属展示层凑数，已删并有守护测试挡回退）。链路：`ordersSystem()` 注入【可开方工具表】（与开处方共用 `toolWhitelist`）→ `CasefileOrder.toolKey` 落库前过白名单 → `casefileView` 读时 `resolveWeapons()` 解析成 `OrderWeapon`（停用/改名立刻生效，external 缺 appId 不下发）→ 端上按 `weapon.kind` 走对话或外跳。**对话兵器卡（`ChatReply.weapon`）明确暂缓（2026-08-12 产品决定，不是没做完）**：理由是**对话里的推荐留不住**——用户当场不点，划过去就忘了；而军令是生成出来、明天还在列表里的任务，兵器挂在它上面才有第二次、第三次被点的机会。所以推荐继续走「生成任务时配兵器」这一条，不急着往对话轮加。真要做时注意：**不能走尾部围栏**，`llm/schema.ts` 的兜底会先匹配住任意结尾围栏，归一失败后既不剥离也不下发，整块原文会漏进用户可见正文——必须用独立字段。⑤ H5 三处 tab 配置未随改（分叉记录见 `docs/H5_REMOVAL_TODO_2026-08-10.md` 末尾追记）。⑥ 图籍/锦囊语义迁移依赖 coach v2 一轮引导，观察一周内客服反馈决定是否需要页内横幅补强。⑦ `PATCH /modules/:key`（隐藏/排序）全端无调用方，是死路由。⑧ **复盘红点 `reviewDue` 在小程序端从来不会亮**：`custom-tab-bar` 消费它，但 `services/page.js` 的 `syncTabBar` 不传、`services/store.js` 也没有产出方（只有 H5 侧 `app/src/services/store.ts` 有实现）——本次把索引 2→1 是空操作，要它真亮得先在 store 里补产出。⑨ H5/PC 侧 21 处 tab 分叉（tabBar 文案、无 pouch 页、红点索引、`MOBILE_TO_PC` 映射、CoachMarks 旧五步等），随 H5 移除一并消灭，清单见 `docs/H5_REMOVAL_TODO_2026-08-10.md`。
- **「快出片」代码与服务已进入生产，真实素材闭环仍待真机验收（2026-08-12）**：生产基线见 §4；素材机审在测试阶段已由用户明确授权通过 production 双开关临时放开，旁路仍校验 MIME/大小并逐素材写审计。正式媒体机审接入前不得把该状态称为合规上线。仍需：① 微信类目、重新提审与深度合成/生成式 AI 备案；② 正式媒体内容安全服务并验证拒绝/放行审计；③ 用户用本人合规素材完成音色、口型、训练/出片耗时、规格与成本实测，并拍板商务/素材条款；④ 运营 preset 与真实长视频压力验收；⑤ 四平台真实发布；⑥ iOS/Android 真机完成权限拒绝/恢复、100MB 上传、原生 video 层级、下载相册、长任务恢复与扣费幂等验收。本里程碑已同步 Notion 工程变更日志。
- **PC 工作台外部与接口边界（2026-08-10）**：沙盘/点兵/主公主区已落地并完成 mock 下 1440×900、1024×768 浏览器验收；仍有三条明确边界：① `CasefileOrder` 现无改期接口，点兵「顺延到明天」只能标「施工中」且不改数据，后续必须先扩 `shared/contracts.d.ts` 与后端再启用；② PC 不复制微信支付/自动续费状态机，方案页到付款步骤会开既有移动 H5，再由其按环境引导微信小程序；③ 真实 server 模式尚需用有案卷、三势、命盘、军令、账本和谶语的账号逐项回归，mock 只证明前端状态机与持久化形状。里程碑的 Notion「军师 · 工程变更日志」本会话没有可用 Notion 连接器，待连接恢复后同步本文与 CHANGELOG 的产品可读结论，完成后删除本句。
- **真人教练感仍需真实模型发布闸门（2026-08-10）**：自动化已锁定上下文继承、事实可信度、路由和通用 `CHAT_STYLE_GUIDE/COACH_QUALITY_RUBRIC`，但 mock 与静态断言不能证明用户主观上“更聪明、更懂我、更有人情味”。放量前必须用生产同款 provider + 当前已发布 `AgentVersion` + 至少 20 组脱敏真实上下文做新旧盲测和预发真机走查；准确使用客户事实不得退步，真人教练感综合偏好率需 ≥60%，事实编造率不得上升。未过时只能继续调优或停止放量，不能把构建/单测全绿当作体验验收。出现跨日质量反馈时先按 `LlmTrace.versionId/provider/model/endpointId/createdAt` 与部署版本核对真实运行身份，再比较上下文 trace；不能只看仓库 seed prompt。另需在 1,000+ 消息真实形态会话上验证 WXML 滚动、阅读位置保持和分页接缝；当前自动化只证明 205 条同毫秒 API 分页无重无漏及 1,000 条摘要持续更新。
- **可审计客户事实首版词典边界（2026-08-10）**：`UserFact` 已覆盖用户明确“帮我记住”的任意文本，以及门店数、经营年限、团队人数、年营收、当前预算、创始人持股六类可稳定归一的高影响事实；用户原话直接 `asserted`，资料抽取/军师新推断只进 `pending` 并在下一轮显示独立确认卡。其它开放域事实仍留在语义 Memory，不会冒充可替代硬事实。扩词典时必须同时定义稳定 `factKey`、否定/假设反例与替代链测试；禁止用向量相似度猜 key。旧 Memory 按保守迁移决策不批量升级，只有用户重新陈述、明确确认或手动编辑后才进入 `UserFact`。
- **问策入口改版（终态 WP3' 已落地，2026-08-08）未做的**：规格 `docs/[FABLE5]WENCE_ENTRY_INTERACTION_SPEC.md`（其中「分两步走 / A-B 过渡」的节奏描述已作废，端上直接做的终态）。
  - **`dock` 臂没有实现**：`WenceForm` 有三臂，端上只区分 `chat` 与其余；分到 `dock` 的用户看到的是 control 现状列表。**放量前必须把 `dock` 权重配成 0**，否则那一桶用户既不是对照组也不是实验组，数据不可用。
  - **进场主动序列没有拟真节奏**：规格 §2.2 的 greet → +1.1s「正在输入…」→ +1.9s 主动判断 → +0.5s chips 四拍未做；服务端注入的主动消息是会话里的真实历史消息，进 tab 时**整条已经在那儿**。要补拟真节奏得让端上区分「本次刚注入」与「历史消息」并延迟渲染，属体验优化，不影响转化口径。
  - **游客开场文案是本地静态的**：`weapp-native/data/wence-defaults.js` 的 `GUEST_PRELUDE` 与兜底词池写在代码里（引导态文案，同 `src/data/operatingSystem.ts` 的定位）。游客没有档案也没有会话，服务端给不出个性化内容且不该为一次浏览写库；但**运营一旦录了 proactive 模板，登录用户看到的必须是模板**，端上没有反向优先本地池的分支。
  - **抽屉历史段没有分页**：规格 §2.5 的「首屏 20 条 + 下拉加载」未做，`api.sessions()` 返回什么就列什么；更早的靠上方搜索。
  - **CoachMarks 在终态没有重新排版**：`components/coach-marks` 的面板底部留白按 66px 底栏算（`calc(safe-area + 122px)`），终态浮岛高约 159px，第一步的面板会与浮岛叠一段（浮岛 z-index 100 > coach 90，压在遮罩之上）。文案已改成两形态通用口径，**版式没动**——要修得让 coach 读到当前形态的底部占位高度，属体验优化，先记在这里别当遗漏。规格 §3.4 的「coach 未完成则主动序列延后播」也未做（服务端注入的主动消息本来就是历史消息，不存在"播"的时机）。
  - **主动消息内容源只有模板池**：规格 §2.2 的降级链（经营数据异动 → 昨日军令 → onboarding 档案/命盘 → 模板池）只落了最后一档。补前三档的落点是 `POST /sessions/proactive` 里 `firstProactiveTemplate()` 之前加分支，返回体形状不用变。
  - **词池不按用户画像排序**：`GET /wence/hints` 目前只按 `sort` 出全量 enabled 词，规格里「服务端按用户画像排序」未做；接口不鉴权，要做个性化得先决定是否加可选鉴权分支。
  - **埋点白名单少四个事件**：规格 §5 列了 `hint_show / advisor_open / attach_pick / drawer_seg`，本包白名单只放了八个高频项。补的时候改 `routes/wence.ts` 的 `EVENT_NAMES` **和** `shared/contracts.d.ts` 的 `ClientEventName` 两处。护栏指标 `advisor_open`（专业军师触达率）缺位意味着「军师团藏太深」这条风险目前只能靠 `drawer_open` 间接看。
  - **`ClientEvent` 没有读端点也没有留存策略**：只写不查，运营取数直接查库。表会无限增长，放量前应加按 `createdAt` 的清理任务或分区。
  - **无套餐用户注入不了主动消息**：`POST /sessions/proactive` 受 `app.ts` 商业化禁写闸管辖（`/api/events` 已显式放行，注入没有）。生产未配 `TEST_DEFAULT_PLAN_NAME` 时新注册用户 `state='none'`，注入会 403；端上按「静默降级 greet-only」处理不会出错，但那批人恰好是本改版的目标人群。要不要放行是商业化决策，本包不擅自开口子。
- **Notion 工程变更日志待补大模型配置 V2 写路径收尾（2026-08-08）**：仓库已完成四张归一化表的直接写路径、旧表只读、路由事务与完整关系校验、凭证确认、用途预算和三端回归，完整产品可读结论见 `docs/CHANGELOG.md` 顶部及 `docs/[OPUS5]AI_CONFIG_V2_WRITEPATH_HANDOFF.md`。本会话没有可用 Notion 连接器，无法可靠更新「军师 · 工程变更日志（持续更新）」；恢复可写连接后应在顶部同步一句话结论与关键影响，完成后删除本 TODO。
- **Notion 工程变更日志待补本次原生微信迁移（2026-08-08）**：`docs/CHANGELOG.md` 已记录「微信端从 Taro 完整切换为原生小程序运行时」的完整结论，包括 38 路由覆盖、原生非受控对话输入、Taro 仅保留 H5、Lucide 图标口径和本地 DevTools 验收；Notion 页面在现有 Chrome 登录态可打开，但自动编辑连续超时，为避免盲写或重复插入未提交。浏览器编辑恢复后应在「军师 · 工程变更日志（持续更新）」顶部同步同一条产品可读记录，并在完成后删除本 TODO。
- **Notion 工程变更日志待补登录后同步（2026-08-06）**：监控告警 Card 2.0 与 API 生产 SLO 已部署 `15647b7`，完成飞书客户端和 Grafana API 验收，仓库 `docs/CHANGELOG.md` 已记录完整结论；但当前浏览器无可用 Notion 登录会话，未能把现有「军师 · 工程变更日志（持续更新）」顶部记录从“尚未部署”更新为线上验收结果。取得登录态后应补写：51 条可处置规则、估算结算只保留看板指标、P1/P2/P3 直接标题与超限指标区、用户接口 P95 800ms/2s + 15m 最少 20 次样本、Grafana 挂载验收和生产实发通过。
- **小程序登录合规仍有两类外部事实待运营补齐（2026-08-08，代码主链已完成）**：① `app/src/packages/main/legal/index.tsx` 与原生协议页已按当前“协议勾选后主动触发微信手机号一键登录”、可选自动续费和实际退款能力更新，但经营主体全称、ICP、算法/生成式 AI 备案号、注册地址、客服邮箱、个人信息保护邮箱与管辖地在仓库及公开信息里均无法权威确认，当前 `【填写】` 不得靠猜；须由小程序主体负责人提供后再提审。② 微信后台《用户隐私保护指引》需由有后台权限的人按实际能力声明并提交，属于平台外部配置，代码无法代办；当前真实调用包含 `getPhoneNumber`（用户勾选协议并主动点一键登录后取得手机号）、`wx.login`（openid/unionid 账号关联）、`chooseAvatar`、`chooseImage`、`chooseMessageFile`、`saveImageToPhotosAlbum`、`requestSubscribeMessage`、`openType=contact` 与只写不读的 `setClipboardData`。当前包没有 `getUserProfile/getUserInfo/getDeviceInfo`、剪贴板读取或位置接口，后台不得漏报手机号，也不得超范围申报；逐项用途和调用点见登录整改方案 P0-9。未完成这两项不得宣称 P0 合规闭环或提交审核。
- **游客完整速诊与足迹继承后置（2026-08-06）**：本轮按过审必需范围开放真实公共内容、军师开场白、能力目录与套餐价格；自由对话仍不向游客开放，`POST /quickscan` 仍需登录。若后续做游客 3 问速诊，必须先补设备指纹 + IP 双维度每日限流和低成本模型档，不能直接放开现有鉴权端点。游客浏览足迹归户、登录半屏化属于体验 P2，待上线后按转化数据决定。
- **GenerationEffect 是 at-least-once，不是 exactly-once（2026-08-05）**：终态与 outbox 已同事务落库，pending/failed/stale-running 会补偿，报告通知也会等待真实发送结果后才完成 effect；但进程若在“外部动作已成功、effect 尚未标 completed”之间退出，仍可能重投。标题覆盖与记忆近重已有天然幂等，digest/预言有来源去重；微信报告通知等外部动作还没有统一的 `jobId/effectKey` 下游唯一键。上多实例或把通知升级为资金/权益类动作前，必须给目标账本补幂等键，不能依赖 effect 状态冒充 exactly-once。
- **海报成品图 MVP 明确不做 / 后置项（2026-07-29，已拍板，不要当遗漏来"补齐"）**：
  - **PDF 交付是二期**：MVP 只出 PNG。印刷级 PDF 要处理出血/CMYK/字体嵌入/矢量文字，与当前「截图式渲染」不是同一条管线，不为一个未验证需求先建它。
  - **图片审核未接真实供应商（合规缺口，不是技术债）**：`services/creative/imageModeration.ts` **只有 `none` 一种实现** = 放行 + 审计记 `skipped`。用户上传的人像与供应商生成的主视觉**都没有机器审核**，真实放量前必须接一家图片内容安全服务：新增一个实现 `ImageModerator` 接口的 class + 一个 resolve 分支（接口与 `NoneModerator` 就是为此保留的），并把地址/密钥按 `visual` 那套走后台配置 + `secretBox`。⚠️ 2026-07-29 删掉的 `http` 半成品**不要照着抄回来**：它直读三个未注册的 `process.env`，缺 URL 就静默 return `NoneModerator`，于是「已开审核」状态下全部放行且无任何日志——真接入时必须做到「配置不全 = 显式失败」而不是静默放行。文案侧走既有 `moderate()`，不受影响。
  - **9:16 / 1:1 规格后置**：渲染器与三套模板都只按 3:4（540×720@2x）做过版式与溢出验证，`ratio` 传其它值一律 422。要开新比例得**每套模板各写一份布局**并重跑溢出闸，不能靠缩放同一份 HTML（字号/留白/行数比例全变，出来就是错版式）。
  - **模板视觉回归靠人工**：`auditPosterHtml` 只查结构性问题（AI 标识在位、无外链、无脚本）+ 渲染器的溢出闸，**没有像素级基线比对**。改模板 CSS 后仍需人工看图（方案 §18.3 的视觉回归未落）。
- **H5 上本命色主题类完全失效（2026-08-05 发现，未修，仅影响 H5 走查/预览）**：`app.h5.scss` 的基础 token 块选择器带了 `#app`（特异度 1,0,0），而主题类 `.theme-red` 等是 0,1,0 —— 无论源码顺序，`#app` 都压过主题类，于是 H5 上 `--accent` 恒为默认墨绿，切本命色只有底栏等少数硬写处会变。weapp 端基础块是 `page`（元素选择器 0,0,1），主题类正常生效，**线上无影响**。修法是把 `#app` 从那条基础 token 选择器里摘掉（或给主题类同等提权），但它是全局 token 级联的根，改动面覆盖整个 H5 应用，须单独开任务并逐页回归，不要顺手塞进别的改动里。发现于粘贴长文卡的本命色走查：卡的本命色脊/柔光环本身接的是 `--accent`/`--accent-glow`，已用直改 token 的方式验过六色都跟随。
- **订单→用户精确跳转待补契约（2026-07-28，运营后台改版留坑）**：`AdminPaymentItem` / `AdminPaymentStuckItem` 只有 `userName`，没有 `userId`，所以「订单 → 查用户」目前是按姓名带进用户搜索（`#/users?q=…`），同名用户需人工分辨。要做精确跳转须先在 `shared/contracts.d.ts` 给两个接口加 `userId`，再改 `server/src/routes/admin.ts` 的订单查询 select 与运营端跳转。本次改版只动 `admin/`，未动后端契约，故延后。
- **本地 seed 的删除顺序缺陷（2026-07-28 发现，未修）**：`server/prisma/seed.ts` 在 `prisma.user.deleteMany()` 之前没有清 `TokenWallet`，本地库已有用户数据时 seed 会因 `token_wallet_userId_fkey` 报 P2003 中断（空库首次 seed 不受影响）。本次只在本地手工 `TRUNCATE` 绕过，未改脚本，避免与他人并行改动冲突。修法：把 `tokenWallet.deleteMany()` 补进现有删除序列的 `user` 之前。
- **`.tag.warn` / `.tag.live` 仍是硬编码色值（2026-07-28）**：`admin/src/styles/admin.css` 末尾这两个状态徽标用的 `#FBE9D8/#C1791F/#DCEEE2/#1A8A5A` 不等于任何 `:root` token，`lint:ui` 因此放过。要彻底守住「颜色只走 token」需先在 `:root` 加 warn/live 两组底色 token 再替换；本次未动以免改变现有视觉。
- **大模型接入配置重设计 · 收尾后的状态（2026-08-08）**：设计稿 `docs/[OPUS5]AI_CONFIG_REDESIGN_2026-08-07.md`，完成记录 `docs/[OPUS5]AI_CONFIG_V2_WRITEPATH_HANDOFF.md`。一二三期**全部落地，含写路径与 review 加固**：后台只写四张归一化表，旧表只读；`AI_CONFIG_V2` 默认 `true`，`false` 仅为历史快照逃生口。写路径统一失效路由、解析配置、费率与端点池缓存；路由重建事务化；端点更新会复核引用路由；入池/切 primary/保存路由共用校验；未确认 vendor 的凭证禁止进入新路由；六用途预算可在后台读写和清空。单价与同名冲突事实只查端点表，探活结果只写端点表。**仍待外部动作**：① 生产备份后跑 `ai:migrate` 预演→`ai:migrate:apply`→确认 `/admin/ai-v2-status.ready` 与待确认凭证→发布；② 后台登录态实机走查；③ 观察一个发布周期后按 `ai:check-drop` 删除旧列；④ §8 的产品/供应商决策；⑤ Agent 自带接入是否收编为 scoped 路由。
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
  - ~~**`/metrics`**~~ **已落（2026-07-27）**：`GET /api/metrics` 返回 Prometheus 文本（`routes/metrics.ts` + `services/metrics.ts`）——在途请求（全量与过载闸两套口径）、事件循环延迟分位数、RSS、LLM 各车道并发/队列深度/排队等待/429/冷却、端点池模式与逐端点冷却态，另有 18 个 `prisma_*`（含连接池 busy/idle/open、查询等待）来自 `schema.prisma` 新启用的 `previewFeatures = ["metrics"]`。**鉴权必须配 `METRICS_TOKEN`，未配整个端点 404**；不要改成内网 IP 白名单——本部署 Nginx 反代 + `trustProxy`，`req.ip` 来自可伪造的 `X-Forwarded-For`，真实 TCP 对端恒为 Nginx 的 `127.0.0.1`，IP 层区分不了公网与本机。指标名与优化计划 §7 告警线一一对应。**2026-07-28 扩容**：补 HTTP 路由级时延直方图（`junshi_http_request_duration_seconds{method,route}`，P95 告警不再依赖 k6）、LLM 调用/token/成本计数（与 llm_trace/token_usage 同口径，挂 `trace.ts`/`usage.ts` 单点）、产出降级/截断、业务事件（注册/审核/算力/禁写闸/支付全链 + 卡单 gauge）；标签基数有折叠保护。**采集与看板已自建落地**（替代原「接 SLS/ARMS」计划）：`deploy/monitoring/` 一套 compose（Prometheus/Grafana/Alertmanager/node_exporter/postgres_exporter/blackbox（+可选 Loki/Promtail），host 网络、UI 全绑 127.0.0.1、Grafana 经 Nginx /grafana/ 出公网），4 块预置看板由 `grafana/dashboards/build.mjs` 生成，容量/成本阈值参考优化计划 §7，用户 API 时延使用生产 SLO；主文档 `docs/MONITORING.md`。**二期（2026-07-28）：告警配置化**——21 项阈值注册为运营后台「功能开关」页的数值项（`services/alertConfig.ts` 注册表，FeatureFlag payload 存储），经 `/api/metrics` 的 `junshi_alert_config{key}` 喂给告警规则的 `scalar()`，后台改完 ≤75s 生效不发版；飞书通知走 Alertmanager → `POST /api/alerts/webhook`（同 METRICS_TOKEN 门禁）→ 服务端按后台配置的群机器人 webhook 转发（`routes/alerts.ts`，URL 白名单限飞书域名 + secretBox 加密落库 + 掩码回显，签名校验支持；转发成败进 `junshi_alerts_forwarded_total`），不再需要 PrometheusAlert 桥。**三期（2026-08-06）：高信息量飞书告警卡片 + 关键规则补齐**——通知升级为 Card 2.0，Alertmanager 按 `category+severity` 聚合关联信号；标题直接写具体故障，副标题固定 P1/P2/P3、业务领域与当前信号；每个信号用三栏指标区展示当前值、告警条件、超限幅度/状态（超限按等级高亮、恢复显示已回落），再给出中文现象、业务影响、处置建议、对象维度和 Grafana 跳转，告警风暴最多展开 8 条但明示截断数。`services/alertCard.ts` 的知识字典与规则侧 `category/current` 共同构成展示真源，测试强制每条规则信息完整且用户可见摘要不暴露内部实现词；规则总数 51，新增 API 限流、模型错误率/调用 P95/队列拒绝、模型成本 100% 红线、支付自动对账停跑、创作失败/模板回退、文件句柄、数据库死锁与监控目标离线。无人工处置动作的“估算结算”只保留为 Grafana 指标，不发告警。**四期（2026-08-06）：API 生产 SLO 重定基线**——“用户交互接口”剔除生成/流式、上传、webhook、callback、metrics、health，避免飞书通知回执耗时污染 P95 并形成自激告警；P95/5xx 统一使用 15 分钟窗口且至少 20 次请求，默认 P95 预警/严重线改为 800ms/2s，Grafana 共用同一筛选和色阶；生产部署对比看板目录哈希并校验主机/容器 JSON 数量，变化或挂载不一致时强制重建 Grafana。**仍待**：request-id 贯穿；API 挂掉时通知通道同亡，需外部拨测兜底（MONITORING.md §7）。
  - **PG 迁 RDS**：需运维前置。能拿到异地备份/PITR/高可用，并把约 0.5 核还给 API。⚠️ **更正「当前零备份」这个旧描述（2026-07-28 实测）**：生产已有 systemd `junshi-pgdump.timer` 每日 03:30 逻辑备份（`/var/backups/junshi/*.sql.gz`，2026-07-23 起，保留 14 天，约 12MB/份，抽验 6 份全部 `gunzip -t` 通过 + 63 张表齐全）。同日修掉其一个会**静默销毁备份历史**的缺陷并纳入版本管理（`deploy/junshi-pgdump.{sh,service,timer}` + `deploy/README-backup.md`）：原 `ExecStart` 一行流 `pg_dump | gzip > f && find -mtime +14 -delete` 的管道退出码取自 gzip，pg_dump 失败时仍返回 0 并产出空壳 gz（实测 20 字节、能过 `gunzip -t`），随后轮转照常删旧备份——连坏两周即自我清空且无报错。现改为 `set -Eeuo pipefail` + 写 `.partial` 经三项校验（gzip 完整性 / 体积下限 / `CREATE TABLE` 计数≥10）后原子改名 + **校验通过才轮转**。**仍缺三样**：① **无异地副本**（备份与库同盘，实例损毁即全失，这是最大缺口，需 OSS 或异地 rsync，机器未装 ossutil）；② 无 PITR，最坏丢 24h；③ **从未做过恢复演练**——没恢复过的备份不算备份，建议在测试机 47.98.162.120 灌入最新备份核对表数与标志性数据。另：备份失败无告警通道（`OnFailure=` 未挂），只进 journal。
  - ~~**mock provider 注入延迟（`AI_MOCK_LATENCY_MS`）**~~ **已落（2026-07-27）**：`AI_MOCK_LATENCY_MS` / `AI_MOCK_LATENCY_JITTER_MS` / `AI_MOCK_429_RATE`，默认全 0 行为不变。**注意一个原方案漏掉的前提**：mock 在 `gateway.ts` 里是被直接调用的、**根本不过 `llmGate` 并发闸**（只有真 provider 才 `withLlmSlot`），所以只注入延迟队列深度仍恒为 0，S5 照样测不出东西。现在开启后 mock 会占一个真实槽位（`providers/mock.ts` 的 `mockUpstream`），并发上限/排队/排队超时降级/429 整窗冷却全部可复现且零 Token 成本。只套在「mock 就是配置的 provider」的 5 个分支，真 provider 失败后的 6 个降级兜底不套。
  - ✅ **`npm run admin:sync-content` 的提示词覆盖风险已加护栏（2026-07-28）**。⚠️ **同时更正 2026-07-27 那条「漂移 2.85 倍」的结论——那是单位错误**：生产库 `server_encoding = SQL_ASCII`，此时 PG 的 `length()` 返回的是**字节数**而非字符数（`length()` 恒等于 `octet_length()`），当时拿它与仓库文件的**字符数**相比，把 9% 的差算成了 2.85 倍。**同口径实测**：`general` 生产 49,094 字节 / 19,486 UTF-8 字符，仓库 `prompts/strat.v6.md` 44,959 字节 / 17,232 字符，实际差 **+9.2%（按字节）/ +13.1%（按字符）**；其余 9 个 agent（strat/growth/intel/fund/model/org/brand/ops/promo）与仓库**逐字节完全一致，漂移 0.0%**。仍成立的是版本内自比：v1 41,710 → v2 45,342 → v3 44,957 → **v4 49,094** 字节，三周 +18%。**覆盖风险依然真实**（同步会把 `general` 回退约 2,250 字符的调教，且无 diff 无确认），只是量级远小于此前描述。**现改为**：`systemPrompt` / `greet` 归入 `OPERATOR_OWNED`——create 写初值、**update 默认跳过**（与本脚本 survey/sku 既有的「不动 enabled，保留运营启停」同一约定，这是主要保护）；`--force-prompts` 才允许覆盖，且仓库比线上短超过 20%（`SHRINK_REFUSE_RATIO`）时拒绝——注意按实测 13% 的真实差距**该护栏不会触发**，它是防粗粒度误配的兜底，不是本场景的主防线；另有 `--dry-run` 预演与 `--dump-prompts <目录>` 导出线上提示词供回灌。护栏由 `test/syncAdminContent.test.ts` 10 例锁定。**提示词真相源已定调（2026-07-28）：数据库 `agent.systemPrompt` 是唯一运行时事实来源，`server/prompts/*.md` 仅作新环境初始化种子，不做定期回灌对齐。** 此前 `prompts/README.md` 与 `agents.ts` 注释同时写着「线上库是运行时事实来源」和「提示词变更走 git 版本管理」，两句互相矛盾，正是同步脚本会静默覆盖调教的根源，现已统一为前者。实测也支持这个选择：9 个专业 agent 与仓库逐字节一致、从未被改过，只有 `general` 被持续微调（24 行，相似度 98.1%）。**通用教训：SQL_ASCII 库上做任何长度统计都必须显式区分字节与字符（`length()` = `octet_length()`）；`wc -m` 在非 UTF-8 locale 下同样退化成字节数。**
  - **提示词缓存 88% 未命中（最大的一笔可省成本，且不需要动提示词）**：生产 30 天 580 次 chat 里 509 次 `cachedInput=0`。**不是 TTL**（71.6% 的相邻对话在 5 分钟内；只看窗口内的 415 次，命中率仍只有 15.2%），**也不是我们代码**（`stable` 段无随时间变的值）。指向 `api.qnaigc.com/bypass/anthropic` 中转在多上游账号间轮询、而 Anthropic 缓存按账号隔离。按官方价（Opus 4.6 input $5/1M、缓存读 $0.5/1M）修好约省 **$46/月 = 总账单的 49%**，单次对话 $0.164 → $0.084。**前提**：需确认七牛是否透传缓存定价；若它按统一单价结算则省不到钱，只改善延迟。详见 `docs/[OPUS5]LOADTEST_OPT_PLAN_2026-07-26.md` §2.5。
  - ✅ **单价已按官方价刷入生产并核准（2026-07-28）**，同时更正此前「低估 5.2 倍 / `modelPrices.ts` 需校准」的两处错误结论。**① `data/modelPrices.ts` 里本来就没有价表**——它只有 `estimateCostMicros()` 折算函数，单价来自数据库 `AiModel.priceInput/priceOutput/priceCachedInput`（运营在后台填，见 `resolveModelRate`）。**② 历史缺口不是 5.2 倍而是约 9.5 倍，且成因不是缺陷**：按周拆开看，06-29 至 07-20 三周记账准确度只有约 3%，而 07-27 那周跳到 78%——`costMicros=0` 的行数为零，说明不是查不到单价，而是**单价大约在 07-27 才被配上**，配上之后记账就基本准了。**现已按 Anthropic Opus 4.6 官方列表价 × 汇率 7.2 刷库**（两个 claude 端点：`priceInput` 35→**36**、`priceOutput` 150→**180**、`priceCachedInput` 20→**3.6**；原值 35/150/20 中 input 已准、output 低 17%、缓存读高 5.6 倍）。`rateCache` 是短缓存，无需重启。**核准后的真实口径（近 30 天）**：合计 **¥745.57 = $103.55**；按 kind 拆 —— `chat` 623 次均输入 28,417 / 输出 829 token、缓存命中率 10.6%、**$0.1493/次**；`deliverable` 60 次 $0.1488/次；`aux` 500 次仅 **$0.0032/次、合计 $1.60（占总成本 1.5%）**，再次印证「拆辅助抽取省 token」当初被高估。缓存全命中的理论下限 **$0.0349/次**，扣掉不可缓存的动态段后现实目标约 $0.073（**约省 51%**，与此前 49% 的估算吻合）。✅ **缓存写计价缺陷已修（2026-07-28）**：此前 `ModelRate` 只有 `in/out/cachedIn`、没有缓存写档，而 `claude.ts` 的 `usageOf` 把 `cache_creation_input_tokens` 并进 `inputTokens` 且不单独记，于是缓存写按 **1.0× 基础价**计而非 Anthropic 的 **1.25×**（5m TTL；1h TTL 为 2×）——每次写少算 25%，且用量不落库、事后无法量化。**现改为输入 token 拆三档各自计价**：命中缓存 `cachedIn`（约 0.1×）/ 写入缓存 `cacheWrite`（缺省 `in × CACHE_WRITE_MULTIPLIER = 1.25`，可由运营显式填以支持 1h TTL 的 2×）/ 其余 `in`（1×）；`Usage` 新增 `cacheWrite`，`usageOf` 独立上报，`TokenUsage`/`LlmTrace` 各加一列 `cacheWrite Int @default(0)`（纯加法）并由 `recordTokenUsage`/`recordLlmTrace` 落库，此后可按 SQL 量化。**向后兼容**：provider 不报 `cacheWrite` 时（openai/dify/mock 与全部历史记录）第二档为 0，折算结果与旧的两档拆法逐位相同——由 `test/modelPrices.test.ts` **12 例**锁定，含三档混合、显式覆盖 1h TTL 单价、读+写超过总输入时不产生负数、未配单价仍计 0。注意 `CACHE_WRITE_MULTIPLIER` 的前提是**上游透传缓存计价**；若七牛按统一单价结算，该常量应设为 1，否则会高估成本。历史缓存写用量因未曾记录，**无法回溯补算**。⚠️ 汇率与加价率口径：我们付的是七牛而非 Anthropic，当前刷的是**官方列表价**（作为权威参照与下限）；拿到七牛价目表后应替换，并据此反推加价率。
  - **提示词模块化标记（省 input，待产品确认 + 评测基线）**：`llm/promptAssembly.ts` 的 `===MODULE deliverable===` / `===MODULE keyword:...===` 机制已实现并上线，但生产提示词**一个标记都没有**，49,094 字符底座每轮全发（占单次输入约 95%）。给哪几章加标记 = 决定哪些人格/方法论在闲聊轮次里对模型不可见，**产品侧已明确要求对话效果不能受影响**，故必须先定切分方案再用评测验证。**注意顺序**：要改必须在线上那份 49,094 字符版本上改，不能在仓库那份 17,230 字符的旧文件上改。另：`general` 现在 `publishedVersionId` 指向 v4，但 `Agent.systemPrompt` 草稿态无版本保护，改前建议先建版本快照。
  - **用户引用资料的 input 尾部风险**：`MAX_REF_CHARS_TOTAL = 120_000` 字符（`services/retrieval.ts:67`），用户一次 @ 满 9 份文档就是约 9 万 token 的单请求——若上游按 TPM 限，一次就能打满窗口。未改（会影响「长文转附卷」这一既有能力），但要在 V2 的 S8 里量出后果。
- 套餐购买已接微信支付 v3 脚手架（`services/wechatPay.ts` + `PaymentOrder` 状态机 + `routes/pay.ts` 回调）：配齐 `WECHAT_PAY_*` 后走 `/plans/:id/order` 下单 + `/pay/wechat/notify` 回调，`markPaidAndApply` 用同订单事务级 advisory lock + `appliedAt` 终态锚点做幂等入账，套餐权益发放复用同一 Prisma transaction client，防重复/并发回调双发；未配齐回退 `/plans/:id/purchase` 演示购买。P0~P2 已落地（2026-07-14，详见 §6 支付段与 CHANGELOG）：主动查单对账（轮询自愈 + `pay-reconcile-sweep` 定时批扫 + admin 手动补账）、回调金额/appid/mchid 校验、降级守卫、前端统一到账确认、条款快照、微信 close-order 关陈旧单、全额退款+权益回收（后端）、订单列表/继续支付、proration 事前确认、H5 守卫、下单频控、套餐归因、支付到账订阅消息、admin 手动开通套餐/模块（后端）。admin 前端 UI（退款按钮/开通套餐/模块管理/订单搜索/分页/CSV 导出）与平台证书自动下载/轮换（`GET /v3/certificates` 按 `Wechatpay-Serial` 缓存选证书，env 静态证书为兜底）已于同日补齐。仍待：部分退款（当前仅全额）、发票。注意：PaymentOrder 新增 `snapshotJson/refundId/refundedAt/refundReason` 列（纯加法），prod 部署带 `db push`；支付到账订阅消息需在微信后台申请模板并配 `WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID`。
- **微信自动续费运维前置（代码已完成，权限待用户配置）**：在微信支付商户平台申请委托代扣自动续费权限与各套餐模板，选择「通知后 24 小时扣费」，再配置 `WECHAT_PAY_V2_KEY` 与两条 `WECHAT_PAPAY_*_NOTIFY_URL` 并在运营后台填模板 ID。可选的「预扣费通知 API」属于另一种模板/权限模式，本期没有暴露半套开关；如未来改用，需按官方时窗另做完整状态机。
- 签名服务偶发不可用时提交为未签名（不影响功能）。
- **pgvector 路径已实现但未真库验证**：本地无扩展，默认 `PGVECTOR_ENABLED=false` 走内存余弦（已验证）；上真库执行 `npm run db:pgvector` 并置 true 后需端到端验一遍（升级路径 1）。
- **AI 模型凭证已拍板明文存库**：正常写路径使用 `AiCredential.apiKey`，一把 key 可挂多个端点；旧 `AiSetting`/`AiModel` 凭证仅作迁移历史。对外接口一律只回 `hasKey`。`services/aiCredentialStorage.ts` 兼容读取旧 `enc:v1`，`npm run secrets:decrypt-ai` 负责 fail-closed 原子明文化。代价是数据库读权限与备份持有者可见这些凭证，故数据库最小权限、0600 备份与主机隔离仍是硬要求。`secretBox` 继续负责 Agent/Dify/技能库/告警/图片供应商等其它业务密钥；`npm run secrets:encrypt` 不触碰大模型接入表。
- 运营后台 项目/报告 只读看板已加（`GET /admin/projects`、`GET /admin/reports`）；知识库看板走既有 `/admin/knowledge`。前端看板页待接。
- **时序知识图谱**（Graphiti 式）已落首版：`GraphEntity/GraphRelation`（关系带有效时间窗）+ `services/knowledgeGraph.ts`（实体去重、新事实软失效旧事实、as-of 查询）+ `routes/graph.ts`（抽取/实体/关系查询）。抽取依赖真实模型（mock 返回空）。仍可增强：对话汇总/知识入库时自动触发抽取、图谱可视化前端。
- **@引用** 选择器候选含 项目/报告/知识/记忆：记忆候选走 `GET /memories`（后端就绪），`resolveReferences` 支持 `kind:'memory'`；前端选择器接「记忆」分组待补。
- **5-tab 设计还原（2026-07）· 前端已跑通但缺后端建模的能力（gap 清单，按优先级）**：
  1. **拆军令 LLM 结构化升级**：执行闭环已服务端化（`Casefile/CasefileOrder/CasefileMetric` + `/casefile*`，M0 PR-EX 完成）；「认可方案→拆军令」目前仍是分节启发式提取 + 整体 aligned=true 标注，待升级为 LLM 结构化拆解与逐条对齐性标注（M2 复盘阶段接入，配合对齐率计算）。
  2. **主军师身份 prod 迁移已完成（2026-07-03）**：prod `agent` 表已迁移——general=V6.0 全文（用户 07-03 晨手动灌入+发布快照）+ 新主线 greet（草稿与 `agent_version` 快照同步）；strat 卸下 V6.0 回归「战略诊断官」专业模板并重新上架（`skillsConfig.deliverableMode='on-demand'` 与 deliverableKey 保留未动）。后端代码已通过 `scripts/deploy-prod.sh` 发布 `4902b0b` 到线上，`prisma db push` 纯加法完成（9 张新表 + `Session.mode`），`survey_question` 已定向 UPDATE 为年营收四档与美业/大健康拆分后的行业列表，未重跑 seed。备份：`/tmp/junshi-db-backup-20260703-172937.dump`（全库，已拉回本地）。
  3. **总军师派单引擎（consult_specialist）未建**：调度白名单目前语义=「unlock 已解锁 → 可进专属线程深聊」（`assertAgentAccess` 既有行为）；总军师自动派单/结论回流（多 agent 编排 + 未解锁 specialist 标记 skipped）待建 orchestrate 层时实现。~~同期把 on-demand 成果产出移交 general~~ **已完成（2026-07-03 P0-3）**：general 配 `deliverableKey='战略方案'` + `skillsConfig.deliverableMode='on-demand'`（注册表 `data/agents.ts` + `prisma/seed.ts` + 测试基线 `test/helpers.ts` 三处同步；模板在 `data/deliverables.ts`，段名对齐案卷提取启发式——「30 天行动军令」拆军令、「现在不能做」提风险锁）——六轮主线聊成熟后总军师直接产出可采纳成果卡。当前分流：general 普通问答仍逐 token 流式；明确成果请求走 report SSE 卡片流，必要时回退 `/generate-sync`。**生产迁移注意**：`agent` 行与已发布 `agent_version` 快照两处都要 UPDATE 这两个字段。
  4. **B 级卡片剩余 9 张 + A 级报告模板待做（M4 PR-15 第二批）**：每日战报已改为小程序内嵌鉴权页，天时日历/天命速写仍是可分享卡；剩余 周/月/季战报、年度里程碑图、紧急决策推演卡、晋升卡、性格操作手册卡、定位一页纸、十二问诊断卡 + A 级七章报告模板。
  5. **排盘引擎 `paipan-v4` 已知边界**（`services/paipan.ts` 头注同步）：称骨暂缓（60 干支年表需可靠来源核对后再上，防带错表）；格局仅月令取格（不处理从格/化格）；身强弱/喜用仍为加权启发式；真太阳时包含经度平太阳时 + 均时差，但城市→经度映射只覆盖约 48 城，滚轮能选择的其他城市未命中时仍按北京时间排盘并显式回执；阴历闰月后端支持（负 month）但前端采集 UI 暂未提供闰月选项。存量 v3 首读惰性升级 v4，v1/v2 照旧；以后再升级必须提 `PAIPAN_ENGINE_VERSION`，不得悄改历史命盘。
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
