# 军师 · 工程变更日志（CHANGELOG）

> 本文件承接原 `AGENTS.md` §14 的历史变更日志，按最新在上维护。
> 任何代码 / 配置 / 接口 / 数据结构变更，都必须在同次提交中更新受影响文档，并在本文顶部追加一条 `YYYY-MM-DD · 改动 · 影响面`。
> `AGENTS.md` 只保留工程执行必需信息与本文入口，以降低新 agent 初始加载上下文。

## 变更日志

### 2026-08-08 · 问策终态第二轮产品反馈：主线会话过期 + 会话标题 LLM 摘要 · 影响面：weapp-native 问策 tab（纯端上）+ server 会话标题服务（**需要重新部署服务端**）

用户反馈两条：「会话有没有过期一说？很多 app 过段时间再进就另开新会话了」「历史会话不显示标题，常见 AI app 是根据用户第一个问题抽象成会话标题」。

- **主线会话过期（纯客户端，`pages/sessions/index.js`）**。服务端不引入过期概念——旧会话原封不动躺在历史抽屉里，
  只是端上冷进时不再自动续接。规则：`SESSION_IDLE_HOURS=24`，`updatedAt` 闲置超 24h **且 `unreadCount===0`** → 走
  「无会话」分支重开（`proactiveSession()` 对已有会话用户回 `exists`，是**预期结果**，照常回落 greet 空会话）；
  闲置超 24h **但有未读仍续接**——军师主动说了新东西，连续性比新鲜感重要。**只在 `bootChat` 判、`refreshChat` 绝不判**：
  切 tab 回来时判会让人聊着聊着跨过 24h 整点就被切走。判定天然只发生在冷启动/杀进程重进（依赖 `_chatBooted` 缓存
  「同一次生命周期只 boot 一次」），正好对上「过一段时间再进去」的语义。
- **会话标题改成首轮问答的 LLM 摘要（`server/src/services/sessionTitle.ts`）**。原来是首问前 18 字硬截断，
  历史列表里一排「我想请教一下今年餐饮门店到底」认不出哪条是哪条。改动要点：
  - 触发点从**建会话那一刻**挪到**首轮回复落库之后**（旧的 `refineSessionTitle` 在建会话时就调，那时根本没有回复可用）。
    提炼素材 = 首条 user + 它后面第一条 assistant/report：很多开场是「帮我看看」这种没信息量的一句，
    只喂 user 文本会拟出与内容无关的标题。
  - 挂在**所有**完成路径：持久任务的 `title` post-effect（`generationWorker`）+ 内联 `/generate-sync`、`/generate`
    的八个落库点（`sessions.ts` 的 `bumpSessionTitle`）。一律 `void ... .catch()` 即发即忘，函数自身也整体 try/catch。
  - **只在首轮改**（user 消息恰好一条 + 其后已有回复），后续轮次不再动——标题反复横跳比截断更难用。
    幂等靠「标题还是占位吗」判、不建标记列：占位只有 `'新对话'` / 首条 user 前 18 字 / **主动消息注入会话的模板前 18 字**
    三种形状，第三种让 proactive 会话也能在用户首次回复后取到名。用户改过名的标题一律不覆盖。
  - `summarizeSessionTitle(userText, assistantText)` 走辅助档，预算固定 200 token；`normalizeSessionTitle` 剥引号/书名号/
    句末标点**剥到不动为止**（`《…》。` 的书名号被句号挡在里面），上限 12 字。无真实 provider（测试 / 未配 key 的 mock 降级）
    走 `fallbackSessionTitle` 确定性兜底，真实模型在位却失败则静默保留现状，不拿兜底顶替真结果。
- **历史抽屉版式（`pages/sessions/index.wxml|scss`）**。终态抽屉的历史行改为：主行=会话标题（宋体 15 加粗）+ 未读角标，
  辅行=军师花名 · 相对时间，第三行=snippet；三行都单行省略（抽屉固定 46vh，任一行换行把可见条数压掉一半）。
  **control 形态那棵历史列表一个节点都不动**，仍读 `preview`（`${title} · ${snippet}`）。
- 测试：server `test/sessionTitle.test.ts` 重写（12 例：mock 确定性 / 幂等不重写 / 只在首轮 / 改过名不覆盖 /
  proactive 同规则 / 失败静默 / TC-G 跨用户）→ 1479 例全绿；app 静态断言补过期常量与新版式 → 93 + 40 例全绿。

### 2026-08-08 · 问策终态首轮真机反馈修复（ask 协议块漏进正文 / 提示 pill 太频繁） · 影响面：weapp-native chat-core 流式收口 + 问策 tab pill（**纯端上，服务端零改动、不需要重新部署**）

上线后首轮真机反馈两条，都在 `weapp-native`；第一条 **chat 分包页同病**（同一份 chat-core，只是以前没人盯着看），一处修复两页同治。

- **ask 协议块漏进可见正文**。根因是三件事叠在一起：① SSE `token` 流是**模型原文**，尾部 ```ask 协议块原样流出——
  剥离只发生在完整结果处（`server/src/llm/schema.ts` 的 `extractAsks`，gateway 注释写的就是「前端流式期间负责隐藏」，
  而端上从来没做这件事）；② towxml 打字机**只增不减**（`c` 单调递增、`allText` 只累加），协议块一旦被打出来，
  done 之后 `setMdText` 喂再短的文本也收不回去，`setStreamFinish` 的收尾还会把已打出的残段再解析一遍，
  于是气泡底部留下被当代码渲染的 `[{"q":"你做的是什么行业/品类？","o`；③ done 时的替换源其实**已经是**服务端清洗后的正文，
  但因为 ② 那次替换等于无效。两道都补：
  - **流中扣尾**：新增 `services/chat-reply.js` 的 `streamVisibleText()`，喂给 `setMdText` 的累计正文先扣掉尾部疑似协议块
    （```ask 围栏含没写全的开头；独占一行开头的裸 `[{"q"…` / `[{"question"…` / `{"asks"…`——判定特征镜像服务端 `extractAsks`，
    流式期间只拿得到半个开头所以做前缀比对），被后文证伪自动放行。扣掉的永远是后缀 → 可见正文恒为最终正文的前缀。
    只操作打字机缓冲，**没有**回到「token 到达整段 setData」。
  - **收尾替换**：done 以服务端正文（落库版本）为准重渲染；已打出的字不是它的前缀（`extendsShown()` 为假）、
    或打字机压根没开口（还停在 think-dots）时，`stopImmediatelyCb` + 清空 `streamRenderId`，整条换回 `markdown-text`。
    顺带修好一个潜伏缺陷：done 早于首字时，旧代码会把 think-dots 永久留在屏幕上。
  - 中断（`markStreamInterrupted`）与 `/generate-sync` 兜底（`finishResult`）也改成只落已下发正文 / 服务端正文，
    不再把含协议块的 `_streamText` 原文当正文写进气泡；兜底替换前先停掉被替换掉的打字机。
- **提示 pill 出现太频繁**（用户原话「一直出现也挺困扰的」）。pill 的职责只是降低**首次开口**门槛，
  却只在草稿非空/生成中/键盘弹起/抽屉打开时隐藏，热聊中也常驻。改成**冷会话专属**：本会话存在任何 user 轮即永久收起，
  判据直接复用 chat-core 的 `chipsSpent`（与 chips 完全同源，没另造标记），老用户带历史会话进来 = 永不出现；
  轮播定时器同步在 `chipsSpent` 为真时停掉。
- AGENTS §7.2 两处补写（流式打字机的「只增不减」两道硬约束、pill 的隐藏条件）。
- `cd app && npm test` 全绿（49 + 93，新增静态断言：扣尾函数行为与接线、done 换渲染器、pill 条件含 `chipsSpent`）；
  `npm run build:weapp:server` 绿。

### 2026-08-08 · 问策入口改版 WP5（运营配置页） · 影响面：admin 导航/问策入口页/共享 CSS 一处修复

- 新增「问策入口」独立页（`settings` 组，`admin/src/views/wence.tsx`）：hint / proactive 双池 CRUD
  （文案、chips ≤4 条、启停、整段重排 sort）+ 灰度开关卡（chat 占比单滑杆 + 0/10/50/100 快捷档、
  dock 保留臂如实提示、急停说明）。权重展示归一化到 100%，与服务端 `effectiveArms` 同一口径。
- 修存量缺陷：`.flag-num` 与 `.ai-input` 同特异性且后者靠后，数值输入撑满整行挤垮同行按钮；
  改 `.ai-input.flag-num` 提升特异性，功能开关页的数值项一并修复。
- admin tsc / vite build / lint:ui 全绿；`npm test` 75/75（基线 61 + 本包 14）。

### 2026-08-08 · 问策入口改版 WP3'（终态：对话即 tab） · 影响面：weapp-native 问策 tab / chat-core / 埋点通道 / `GET /wence/hints`

规格 `docs/[FABLE5]WENCE_ENTRY_INTERACTION_SPEC.md`（其中「分两步走 / A-B 过渡」的节奏描述已作废，
端上直接做终态）。背景：很多人不知道「在总军师里聊天就 OK」。北极星＝进入问策 → 首次发消息的转化率。

- **`pages/sessions` 按 `/me.features.wenceForm` 分形态**。`'chat'` 走终态「总军师对话即 tab」；
  `'control'` / `'dock'` / 字段缺失 / 取数失败一律落回**现状军师列表，一个节点都不动**（灰度回退的前提，
  两棵树在同一份 WXML 里 `wx:if / wx:else` 并列）。形态初值取本地缓存 `junshi.wenceForm.<token>`，
  默认 control，免得 chat 用户每次冷启动先闪一屏列表。
- **终态结构**：自绘合一页头（固定不滚，kicker 位换成「总军师玄衡 · 在线」+ 大字问策 + 谋印 +
  右侧「军师团 / 历史」双入口）+ chat-core 消息流 + 提示问题 pill + 底部合体浮岛（composer 模板 + 细线 +
  与 `custom-tab-bar` 同源的五 tab 行）+ 军师团/历史半屏抽屉。**这个页头是新模式，不是 TabHeader 实例**，
  与「tab 页头零按钮」不矛盾——那条约束的是 TabHeader 组件与它「用途小字」的语义（AGENTS §7.2 已立段说明）。
- **会话装载**：已登录续接 `agentKey='general'` 最近会话 → 没有就 `POST /sessions/proactive` 注入主动消息 →
  `injected:false`（exists / empty-pool / disabled）走 greet 空会话。游客走新加的
  `chatCoreLoad({ localPrelude })` 本地开场序列（**零服务端写入**，文案在 `weapp-native/data/wence-defaults.js`），
  发送动作才弹登录门（reason='chat'，可关、不丢输入）。切走再切回只同步角标与已读，不重复装载、不重复注入。
- **towxml 跨包异步接线**（本包最关键的技术点）：主包页面用 `require.async('../../packages/main/vendor/towxml/globalCb.js')`
  取流式回调，`index.json` 给 towxml 配 `componentPlaceholder: view`。**顺序铁律：先 `useStreamRenderer` 再
  `chatCoreLoad`**，反过来第一轮流式的 `setMdText` 会打进 no-op。拿不到也不许白屏：chat-core 新增
  `hasStreamRenderer()` 记账，没接上就不发 `streamRenderId`，模板退回 `markdown-text`，正文以 120ms 节流回写。
- **chat-core 四项新能力**（chat 分包页自然继承 chips）：`localPrelude`、`SessionMessage.chips` 快捷回应
  （点击即代发，本会话出现过 user 轮就整排作废）、`sendText(text, entry)`（有草稿拒发；**未登录写
  `_pendingPrompt` 而不是 `_draft`**，否则登录回来是「空输入框 + 发送键亮着」）、`chatCoreEvent` 事件出口
  （核心只发事件，映射与上报都在宿主页；核心自己不碰 `api.track`）。
- **提示 pill 是「点击即代发」，不是原型的「点选即填」**：textarea 铁律禁止绑定 `value`，程序化回填在原生
  没有实现路径；代发与 chip 同语义，也少一步「填进去还得自己点发送」。词池 `GET /wence/hints`，
  空池/失败回退本地兜底池，3s 轮换，有草稿/生成中/键盘/抽屉时隐藏。
- **未读三层引导链**：① 浮岛问策角标＝全会话聚合（`store.syncUnread`）② 「军师团」按钮右上＝除 general 外
  各会话未读之和 ③ 抽屉行内各自角标。装载 general 会话后（服务端写 `lastReadAt`）本地缓存就地掉掉这份未读，
  专业军师的一条不动。
- **埋点通道 `api.track(name, props)`**：裸 `wx.request` 发 `POST /events`，fire-and-forget、失败完全静默、
  游客照发。**刻意不走 `request()`**——那条路径上「带 token 的 401」会清登录态 + `reLaunch`，一条统计请求
  能把正在打字的用户踢出对话。埋点位：`wence_enter` / `proactive_show` / `chip_tap` / `hint_tap` /
  `first_message_send`（ttfm_ms + entry）/ `drawer_open` / `attach_open` / `tab_switch`。
- **服务端只改一处**：`GET /wence/hints` 增加 `guestForm: 'control'|'chat'`（开关关 → control；开且
  `effectiveArms().chat > 0` → chat）。游客没有 `/me` 也没有稳定 userId，不做三臂分流，只回答「chat 臂开没开」；
  顺路搭在游客必发的这条请求上，省掉一次专为判形态的往返，也就没有「先渲染 control 再跳 chat」的闪烁。
  `shared/contracts.d.ts` 的 `WenceHintsResult` 同步。
- **底栏 tab 表抽到 `services/tabbar.js`**：`custom-tab-bar` 与浮岛那排 tab 同源（顺序/图标/主题态/角标口径），
  样式也直接 `@use` `custom-tab-bar/index.scss`，不许再抄一套。
- **浮岛刻意不上 `backdrop-filter`**（`custom-tab-bar` 那条有）：它会建立 fixed 定位包含块，把 composer 模板里的
  附卷全文预览 / 引用资产选择器两个全屏层裁进 26px 圆角小盒子。底色从 `.9` 提到 `.96` 补足遮挡。
- **其它**：`custom-tab-bar` 本体在终态下由 `store.setOverlay(true,'wence-isle')` 隐藏，`onHide/onUnload` 与
  切 tab 前成对释放；`CHAT_TEXTAREA_TARGETS` 加入 `pages/sessions/index.wxml`（§7.2 新宿主页义务）；
  CoachMarks 第一步文案改成两形态通用口径；mock 平价（`/me.features.wenceForm='chat'`、`wence/hints`
  带 `guestForm`、`sessions/proactive` 按账号隔离持久化且二次调用回 `exists`、读详情清未读、`events` no-op）。
- **测试**：`app` 48 + 93 全绿（新增 4 测：分形态与终态结构、埋点静默通道、chips 生命周期、mock 主动消息隔离；
  既有断言一条未删，tab 表断言改指真源 `services/tabbar.js`）；`server` **1459/1459**（新增 guestForm 用例）。
  三端构建 `build:weapp` / `build:weapp:server` / `build:h5` 全绿。

### 2026-08-08 · 问策入口改版 WP2'（对话核心抽到主包 chat-core） · 影响面：weapp-native 主包/分包结构 · 原生构建闸门 · 原生静态测试

为下一包「问策 tab 内嵌总军师对话」做准备。分包可以引用主包、反向不行，所以先把
`packages/main/chat`（分包）的对话核心抽成主包内可复用结构，**chat 分包页行为零变化**。

- **新增 `weapp-native/chat-core/`（主包）四件物**：`behavior.js`（Page Behavior，基础库 2.9.2+）承载
  消息加载/规范化、发送、SSE 流式对接、生成态/停止/重试、键盘避让、粘贴归卷、asks 问答卡、成果卡闭环；
  `message-list.wxml` / `composer.wxml` 是 `<template name>` 模板库；`chat-core.scss` 是可共享样式。
  方法体、WXML、SCSS 全部逐行搬运，未改写实现。
- **chat 分包页只剩 33 行**：导航参数解析（解析完交给 `chatCoreLoad(config)`）、页头、返回键、页头菜单、
  滚动容器。`scroll-into-view` 特意留在宿主页——放进模板会让流式期间 180ms 的自动滚底把整张消息列表
  也带进重算。
- **towxml 不动**（568K，仍在 `packages/main/vendor/towxml` 分包）。主包的 chat-core 不得反向 require 它，
  改由同包宿主页 `useStreamRenderer({ setMdText, setStreamFinish, stopImmediatelyCb })` 注入；
  调用点一字未改，新宿主页不注入就没有流式打字机（下一包要处理）。
- **输入铁律的静态校验跟着模板走**：`build-native-weapp.mjs` 顶部新增 `CHAT_TEXTAREA_TARGETS` 显式列表
  （`chat-core/composer.wxml` + chat 页），**列表里的文件缺失本身就让构建失败**，防止「只扫分包页 → 文件搬走
  → 铁律静默失效」。两种失败模式都实测过会 throw。
- **测试只挪目标不删断言**：`native-weapp.test.mjs` 里 21 处 chat 四件套读取改为读
  `chat-core + chat 页` 的并集（`chatSource/chatMarkup/chatStyle`），原有正则一条未改；新增一测
  `对话核心抽到主包 chat-core，分包页只留页头与导航`，硬保 chat-core 四件物存在、主包不反向引用分包、
  模板 handler 名与 behavior 方法一一对应、模板用到的组件被宿主页注册齐、构建器扫 composer 模板。
  `app` 静态测试 43 → 44 全绿；`npm run build:weapp:server` / `build:h5` 通过。
- **体积**：主包 810,966 → 923,345 B（+112,379），`packages/` 分包 1,026,350 → 937,712 B（−88,638）。
  主包增量里有 19,599 B 是构建把 `chat-core.scss` 也编译成了独立 `chat-core.wxss`——宿主页走 Sass `@use`
  内联，这个独立产物当前无人引用（与既有 `styles/subpage.wxss`、`pages/shared-stage.wxss` 同类）。

### 2026-08-08 · 问策入口改版 WP1（契约 + 服务端） · 影响面：SSOT / Prisma / server 路由与服务 / 运营后台 API

规格见 `docs/[FABLE5]WENCE_ENTRY_INTERACTION_SPEC.md`。本包只做契约与服务端，端上改造留给后续包。

- **SSOT**：`WenceForm('control'|'dock'|'chat')` 挂进 `/me.features.wenceForm`；`SessionMessage` 加可选
  `chips?: string[]`；新增 `WenceHint/WenceHintsResult`、`ProactiveResult`、`ClientEventName/ClientEventRequest`、
  `AdminWenceTemplate*`。
- **两张新表**：`WenceTemplate`（kind='hint'|'proactive' 的运营模板池）与 `ClientEvent`（埋点原始事实）。
  **模板池禁止 seed**——对外内容归运营（同定价权益原则），空池是合法状态：`/wence/hints` 回 `[]`、
  proactive 回 `empty-pool` 且不建会话。`ClientEvent` 的 userId/tenantId 无外键（游客为空），
  已按 `CreativeJob` 同口径加进 `prisma/resetBusinessData.ts`；`WenceTemplate` 作为运营目录刻意不加。
- **实验分桶**（`services/wence.ts`）：`wence_entry` 开关登记进 `FEATURE_FLAG_CATALOG`，payload 存
  `{ arms: { control, dock, chat } }`。`resolveWenceForm` 用 **sha1(salt+userId) 稳定哈希**分桶，
  绝不用 `Math.random`——否则用户每次进 tab 形态都在跳、A/B 也无从归因。**降级分两档**：开关**关闭** →
  `control`（零改动现状，实验没开）；开关**开启**但 payload 缺失 / 权重全 0 / 形状不对 → `DEFAULT_ARMS`
  三臂均分兜底，**不回 control**——「开关拨开了却静默零分流」会让运营以为实验在收数据，比误开实验更坏，
  因为它失败得无声（写入端的 arms 校验已挡住非法权重入库，故均分兜底安全）。生效权重唯一真源是
  `effectiveArms()`，**后台展示与运行时分桶共用它**，避免运营照着假数字调实验。开关目录新增 `arms` 类型：
  实验开关**未落库时默认关**（既有开关仍默认开），PATCH 可单独提交 `arms` 且只改 `enabled` 不清权重。
- **`POST /sessions/proactive`**：军师先开口。判据「已有 general 会话 → `exists`」同时就是每用户至多一次的
  频控幂等，不另建标记表。会话 + 首条 assistant 消息**同事务**落库（半截状态会让主动消息永远注入不成），
  且**刻意不写 `lastReadAt`**——未读角标必须亮。三种 `injected:false` 都回 200，端上静默降级为 greet-only。
- **`GET /wence/hints`**、**`POST /events`**（`routes/wence.ts`）：两条都**不要求登录**（微信整改红线：
  问策 tab 对游客完整可浏览）；带了 token 仍严格校验，无效 token 401 而非静默降级成游客。
  `/events` 有八项事件名白名单（非白名单 400 且不写库），props 序列化超 2KB 截断但事件本身不丢。
  `/api/events` 已加进 `app.ts` 商业化禁写闸的放行前缀——生产新注册用户默认无套餐，
  不放行等于把要观测的那批人从漏斗分母里静默切掉。
- **`/admin/wence-templates` CRUD**（照献策库范式 + `recordAudit`，支持 kind 过滤 / enabled / sort / chips 编辑）。
  UI 留给后续包。
- 测试：`server/test/wenceEntry.test.ts` 26 用例（分桶稳定性、proactive 幂等与空池降级、unreadCount=1 与
  snippet、chips 透出、TC-G 跨用户隔离含 ClientEvent 归属、hints 游客可访问、events 白名单与截断、后台 CRUD）。
### 2026-08-08 · 修复完整部署在 H5 复制阶段中断 · 影响面：生产部署脚本 + 工程/部署文档

主分支 `205b4d9` 走 `DEPLOY_H5=1 bash scripts/deploy-prod.sh` 时，server、schema 与 admin 均已成功构建并更新，但 H5 构建成功后脚本仍执行 `cp dist/.`；微信端迁为原生运行时后 Taro H5 产物早已固定到 `app/dist-h5/`，因此发布在复制阶段报 `cannot stat 'dist/.'`，版本标记、Nginx/监控验收也随之中止，线上 H5 继续保留旧包。现生产脚本改为只复制 `dist-h5/`，并在 AGENTS/DEPLOYMENT 固化这条产物边界；后续完整部署必须跑到 `DEPLOYED <sha>` 与公网 smoke，不能把“Webpack 编译成功”当作 H5 已上线。

### 2026-08-08 · 三期收尾：后台直接写归一化表，旧表降为只读 · 影响面：server（删旧 CRUD + 新写路径）+ admin（模型页重写）+ shared + 测试重组 + docs

三期此前只建了四张表、读路径带开关，**后台仍写旧表、V2 靠 `syncV2FromLegacy` 投影**——于是三笔债一笔都没收，反而多了一层拷贝（净负）。本次把写路径也搬过去，三笔债一次性收掉。

**① 消掉拷贝。** 删除 `aiConfig` 里整套旧 CRUD（`setAiConfig` / `addModel` / `updateModel` / `deleteModel` / `activateModel` / `syncActiveSetting` / `ensureSeededModels`），**删掉而不是留着不用**——两套写路径并存，下一个人迟早往错的那套加东西，一分叉「后台改完线上没变」就以新形态回来。「生效」现在是 `AiRouteMember.primary` 一个指针，`setPrimary` 不复制任何字段（回归逐行比对端点表证明这一点）。投影函数 `syncV2FromLegacy` 随之删除。

**② 一把 key 喂多个端点。** 新增 `services/aiV2Admin.ts`：凭证**按 key 隐式去重**——运营在端点表单里照常填 Key，填一把已存在的就复用那条凭证。不要求运营先建凭证再建端点（那是把内部结构强加给使用者）。轮换走 `PATCH /admin/ai-credentials/:id`，改一处、下面所有端点一起生效；旧结构要挨个改，漏一个就是那个端点静默失败。

**③ 用途化落到界面。** 后台模型页按真实结构重排为三层：**接入点**（一行一个上游，属性与操作都在这行）/ **路由**（六个用途结构同构，用同一个 `RouteRow` 组件——旧版嵌入/重排是另写的一套 UI）/ **凭证**（换 Key 的唯一入口）。辅助抽取从此是后台里一个正常配置项，不再只能改 `AI_AUX_*` 环境变量。

**读路径默认切换。** `AI_CONFIG_V2` 默认值从 `false` 改为 `true`——旧表已不再被写，继续读它就是读一份不再更新的快照。保留 `=false` 作为切换当天的应急逃生口，但它只能救急：关掉后读到的是**历史快照**而非真相。

**review 后继续加固写路径**（都属「不报错但结果不对」或会留下半写状态）：
- **写完没人清 `aiConfig` 的 4 秒缓存** —— 旧的 `setAiConfig` 顺手做的 `cache = null`，删掉那套 CRUD 后没人接手。后果是运营改完配置、页面显示已保存，运行时最多 4 秒仍用旧值且无任何报错。现由写路径的 `invalidate()` 统一清掉，并有回归（**不传 `force`**，走线上真实读法）。
- **费率表仍读 `ai_model`** —— 单价现在配在端点上，不改的话运营填的价一分钱进不了成本核算，只会看到成本恒为 0。
- **探活结果仍写 `ai_model`** —— 切到 V2 后运行时读端点表，能力回填（「这个模型不支持思考」）到不了运行时，「能力靠测」的闭环恰好断在最要紧的一环。现 `probeEndpointById` 直接写端点表并清路由缓存。
- **路由删旧成员与重建不在同一事务** —— 中途失败会留下空路由；现改为原子事务，并验证回滚、预算写入/清空与唯一 primary。
- **只校验当前按钮对应端点** —— 会漏掉变更后的完整池内协议、厂商能力、重复/缺失 primary；现保存路由、入池、切 primary、端点更新统一复核完整关系集合。
- **迁移待确认凭证可直接进入新路由** —— 现必须先在凭证层确认 vendor；embedding/rerank 还要求 OpenAI 协议与厂商能力同时成立。
- **非池用途保留旧成员** —— 辅助抽取/嵌入/重排切换端点时现替换旧成员，不再让无效成员静默残留。

**契约同步**：`AiDialectMeta.thinkingOff` 补上二期就加了却漏同步的第四档 `explicit_when_configured`（类型检查抓出来的）。`AiV2View` 顺带下发接入商预设与方言目录，前端建端点少两次往返。

**测试重组**：删除 `aiModelUpsert` / `aiTemperatureConfig` / `aiV2Writeback` 三个只测旧 CRUD 与投影的文件，覆盖点由新增的 `test/aiV2Admin.test.ts`（30 例，覆盖三笔债、事务、关系校验、用途预算与凭证确认）接手；`aiProbe` 改测端点；`aiCredentialStorage` 的旧密文迁移部分显式走 `AI_CONFIG_V2=false`（V2 已是默认读路径，不显式关就测了个寂寞）；`integration` 的 TC-H 改为 V2 口径。新增 `test/aiLegacyReadOnly.test.ts` **扫源码**钉死「运行时不得再写旧表」——这类回退不报错也测不出来，只能结构性防。

**验证**：独立数据库 `junshi_test_v2` 上 server 提交前 **1427/1427**，rebase 到主线、重新生成 Prisma Client 后再跑 `npm run build && npm test` 为 **1442/1442（237 套件，0 fail / 0 skip）**；admin `lint:ui` + `tsc -b` + `vite build` + **61/61**；app TypeScript + 原生构建脚本 **43/43** + H5 测试 **93/93**，H5 与原生微信 mock 包均构建成功（仅既存 bundle 体积警告）。全程在 `git worktree`（`/Users/donis/dev/ai-pilot-v2`）里做，主工作区已有未跟踪文档未受影响。**未做**：生产迁移与发布、旧列删除（仍按 `npm run ai:check-drop` 的结论 + 观察一个发布周期）、后台登录态实机走查；Notion 里程碑日志因本会话无可用连接器待补，已记 AGENTS §13。

### 2026-08-08 · 周期 tab 按实际配出来的档展示 · 影响面：原生小程序 + H5 方案页

运营只配了年付档时，方案页仍固定渲染「月付 / 年付」二选一且默认停在月付，用户开屏就是
一片「暂无这一周期的方案」——本地验收时第一次打开就撞上了。现在两端都改为按实际数据决定：
某个周期下**一条都排不出来就不给它 tab**，只剩一种周期时整个切换器收起（一个选不动的二选一
是纯噪音），当前选中的周期没货时自动落到第一个有货的周期；一档都没有时不出切换器、交给空态文案。

关键点是「哪个 tab 有货」与「tab 里实际显示什么」**复用同一个筛选器**（H5 传 `visiblePlanOptions`
的计数进 `availablePeriods`，原生用同一个 `filter` 判空），不另写一套「有没有月付档」的规则——
两套规则一旦漂移就会出现「tab 点得进去、里面空着」。因此面议档（在每个 tab 都展示）会让两个
周期都算有货，与实际渲染一致。H5 用派生值而不是在 load 里 setState 修正，避免先渲染一帧空列表再跳；
原生把 tab 文案与 `showPeriodSwitch` 预计算进 data（WXML 不能调函数）。两端各加静态/纯函数用例钉住。

### 2026-08-08 · 折扣展示移植到原生小程序端 · 影响面：app/weapp-native 方案页

去 Taro 迁移后微信端从 `app/weapp-native/` 出包，而折扣 UI 此前只写在 Taro 侧（现为 H5 专用），
线上小程序拿到服务端的 `promotion` 字段却整个忽略——用户只看得到 ¥3,980，看不到划线原价、
折扣角标与立省。本次把同一套版式落到原生页：`normalizeOption` 增加 `promo`（`promoView()` 预计算
`discountLabel/kickerText/listPriceText/saveText/deadlineText`）与 `priceUnitText`，报价对象补 `quote.promo`；
WXML 用大号现价 + 周期单位替换标题行右侧的小字价，优惠档叠加右上角实心折扣角标、活动名 kicker、
划线原价、立省胶囊、可选截止日，并整卡换本命色描边 + 顶部晕开底；确认弹层补「挂牌价 → 活动名·折扣 -¥X」
两行并给折扣行强调色，自动续费说明补一句「优惠结束后不会按原价自动扣款」。

关键约束与 H5 一致且新增静态用例钉住（`app/scripts/native-weapp.test.mjs`）：折扣率与立省金额只用服务端
下发的 `promotion` 字段，端上不得相减或相除；**WXML 不能调函数**，所有文案必须在 `setData` 前算完，
模板里不得出现价格算术；促销色只用 `--accent*` token（本命色 6 套主题，写死红会在其中 5 套里显脏）。
原生 mock 增加一档带 `promotion` 的夹具，本地 mock 包即可走查排版。

### 2026-08-08 · 套餐挂牌价/优惠价与生效时间（小程序显示折扣费率） · 影响面：SSOT 契约 + prisma schema（纯加法）+ server 定价读路径 + 运营后台「商品 · 套餐」+ 小程序方案页

运营侧新增三件可配项：**挂牌价**（原 `Plan.price`，语义收敛为标价）、**优惠价** `promoPrice`、**生效时间窗** `promoStartsAt/promoEndsAt`，另加只展示的活动名 `promoLabel`。窗口到点自动切换，不需要人工二次改价：未到生效时间按挂牌价卖（可预约调价），过了结束时间自动回挂牌价。后台列表行直接回显「现价 + 划线挂牌价 + 折扣角标 + 生效状态」，运营不用自己心算用户看到的是几折。

服务端把「此刻该收多少钱」收进 `services/planPricing.ts` 一个出口：`withEffectivePrice()` 把 `price` 换成成交价、把挂牌价挪到 `listPrice`、并算好用户侧折扣对象 `promotion`（含 `discountLabel`「1折」、`savedFen`、`endsAt`）。理由是报价、条款哈希、权益账本快照、委托代扣授权额读的都是同一个 `plan.price`，逐处判断必漏。已接入 `GET /plans`、`/plans/options`、`/plans/:id/quote|order|contract-order|purchase`、`quotePlanChange` 的在册档、`buildOrderSnapshot` 与 `scanAutoRenewals`。**开发期被新用例抓到一处真实资损路径**：订单快照 `buildOrderSnapshot` 原样存挂牌价，回调入账优先读快照，导致 `PlanEntitlement.listPrice` 记成 ¥39800——按 ¥3980 买的档在后续升级里能抵掉 ¥39800；已改为快照冻结下单时的成交价。

护栏：`1 ≤ promoPrice < price` 且只允许配在正价档（`price>0`）上，写入口 400 拦截、读出口再兜一次底。这保证生效价恒为正，`price<=0`（免费层不设到期）与 `price<0`（面议档禁止自助购买、档位置顶）的语义不会被优惠翻转，调用方无需为优惠新增分支；`withEffectivePrice` 同时固化 `tierRank`，避免空 tierRank 的存量档因优惠掉档位、把升级判成降档。已开自动续费的档配优惠时，优惠结束后 `scanAutoRenewals` 发现成交价 ≠ 授权金额会转 `cancel_pending` 停扣并等用户重新确认，不按挂牌价静默续（用户侧确认页也写明这一点）。

折扣率只有服务端一份实现（中式「折」，一位小数，深折下限 0.1 折、浅折写「限时优惠」不写「10折」）；小程序 `promotionKicker/promotionSave/promotionDeadline` 与后台列表都只做文案拼装，不按价格自己算——避免「显示 1 折、下单扣原价」。

小程序方案卡的价格区按促销转化重排：价格从标题行右侧的小字提为整卡主角——所有档共用同一套结构（大号现价 + `/年` 周期单位），优惠档在同一行接上划线原价与「立省 ¥X」胶囊，上方是活动名 kicker，下方是配了结束时间才出现的「优惠 X 月 X 日 截止」；整卡换成本命色描边 + 顶部晕开的浅色底，右上角一枚实心折扣角标（全屏唯一的高对比色块）。**不给优惠档另换一种排版**——同一列表里两种版式看起来像坏了，促销感靠角标、底色与原价/立省的对比拉出来。颜色全部走 `--accent*` token：本命色有 6 套主题，写死促销红会在其中 5 套里显脏。确认支付弹层保持清单式（挂牌价 → 活动名·折扣 -¥X → 方案价格 → 本次实付），只给折扣行上强调色，不做角标底色——付款前的界面越吵，用户越要停下来重读。游客列表、登录后列表、确认弹层三处一致。测试：新增 `server/test/planPromotion.test.ts`（15 例，覆盖折扣率算法、生效窗左闭右开、报价/订单/账本三处金额一致、后台护栏与审计）与 `app` 两条纯函数用例。部署带 `cd server && npm run db:push`（4 个可空列，纯加法）。
### 2026-08-08 · 问策底栏改用 Lucide 双对话气泡 · 影响面：原生微信/H5 底栏

撤销军师帽图标及其全部自绘 SVG、构建分支和尺寸补偿，问策改用固定版本 `lucide-static@1.27.0` 的 `messages-square` 双对话气泡，直接表达会话、交谈与持续问策。原生微信由构建器从 Lucide 官方包生成全部本命色资源，H5 同步使用该官方图标的原始路径；显示尺寸回归通用 22px，与军情、军令和老板保持同一线宽与图标体系。静态回归同时禁止自绘帽子重新进入源码或构建产物。

### 2026-08-08 · 问策军师帽统一为 Lucide 风格单线图标 · 影响面：原生微信/H5 底栏

问策底栏原品牌帽使用实心矢量描摹，小尺寸缩放后每个形体会露出内外两条边缘，与其余 Lucide 单线图标明显割裂。现严格沿原稿比例保留左侧立边、拱形帽身、三道弧形帽骨、右侧内卷纹和矩形帽座，只把每个有厚度的填充形体收成中心单线；成稿为 24×24、2px、圆角端点与圆角连接的纯描边 SVG。未选中与六种本命色选中态共用同一结构，仅替换颜色。原生底栏显示尺寸由补偿旧稿大留白的 28px 收回 24px，与其他 22px Lucide 图标按实际笔画做光学校准；H5 同步使用同一源图。新增静态回归，禁止军师帽重新变成实心填充或无描边素材。

### 2026-08-08 · 微信手机号绑定前置为一键注册登录 · 影响面：原生微信登录与新账号补全

原生微信主入口由“微信账号登录 → 第二页再绑定手机号”收成一次官方授权动作：用户先主动勾选协议，主按钮才切换为 `open-type=getPhoneNumber`；点击后同步取得手机号 `phoneCode` 与 `wx.login` 的 `loginCode`，调用既有 `/auth/wechat-phone` 直接注册/登录并关联微信身份。拒绝授权时继续提供短信验证码登录/注册，不阻断用户。新账号随后的“先让军师认得你”只补称呼和可选头像，不再重复出现手机号表单；原生 mock 同步走稳定手机号的一键登录真值。未勾协议时不会提前弹手机号授权，避免平台授权先于用户同意。原生与 H5 的用户协议、隐私政策，以及微信后台隐私申报清单同步改为真实的手机号授权口径，明确需申报 `getPhoneNumber`，不再沿用“微信登录不收手机号”的旧说明。

### 2026-08-08 · 新注册补齐手机号绑定，附件允许无文字直接发送 · 影响面：原生微信/H5 登录与对话

微信新账号的“先让军师认得你”注册补全页新增手机号绑定硬闸：优先使用微信 `getPhoneNumber` 一键绑定，拒绝授权或平台能力不可用时可用 `scene=bind` 短信验证码兜底；手机号登录创建的账号直接显示已绑定。称呼与手机号完成后才进入本命色和首判仪式，头像继续可选；老账号不被重复强拉，设置页仍可更换手机号。原生 mock 同步按账号保存绑定结果并返回契约完整字段，便于本地预览走完注册主链。

对话发送条件由“必须有文字”改为“文字或附件任一存在”：图片、文件、案卷、方案或资料引用上传完成后发送键立即可用；用户未输入文字时，客户端会生成一条自然可见的“通读附件并给出关键判断”请求，与引用一并发送，避免向后端提交空 text。上传/长文归卷尚在途或失败时仍维持原硬拦，原生微信与 H5 同口径。

### 2026-08-08 · 修复军师提问协议 JSON 泄漏到正文 · 影响面：对话生成网关 + 原生微信/H5 历史消息

模型偶发漏掉 `ask` 围栏、直接在回复末尾输出问题数组时，旧网关会把该数组当普通 Markdown 正文保留，随后兜底抽取又生成结构化问答卡，用户因此同时看到 JSON 代码和正常选项。现服务端统一识别标准 `ask`、合法 `json` 围栏和单独成行的裸 asks JSON，只有能严格归一为问题与选项时才从正文剥离并作为 `ChatReply.asks` 交付；普通业务 JSON 与行内代码保持原样。原生微信与 H5 的历史消息收口层同步兼容已落库旧数据，且只在尾部 JSON 与结构化问答卡完全一致时清理，确保问答卡成为选项唯一可见出口。

### 2026-08-08 · 原生军师回复接入开源流式 Markdown 打字机 · 影响面：原生微信对话渲染 + 分包体积 + 本地验收

原生对话此前把服务端每个 SSE token 直接整段 `setData` 到不断增长的消息文本，并在同一 token 上反复触发滚底与 Markdown 尾段更新；微信逻辑层到视图层的桥接频率随网络突发节奏抖动，所以视觉上会成批跳字而不是稳定打字。现固定引入 MIT 的 `towxml-stream-typewriter@1.0.3`（commit `5b64114d...`）到 `packages/main` 分包，只替换普通军师回复的“正在输出”文字层：SSE 只更新组件缓冲，组件按 6ms 稳定节奏局部解析新增 Markdown 并复用旧节点，滚底收敛为 180ms；网络完成、停止与页面卸载分别走组件既有 finish/stop 生命周期。历史消息、方案卡、问答选项、资料引用、登录和后端协议保持不变。

上游许可证、版本和 commit 已随源码保存；本地仅把已弃用 `selectable` 改为 `user-select`，并清空未启用的 LaTeX/YUML 外部 HTTP 地址，组件不新增第三方网络请求。新增静态回归，锁定组件来源、事件生命周期，并禁止 SSE token 路径重新整段 `setData`。未上传微信开发版，继续由本地 DevTools/真机长回复确认真实帧率与滚动手感。

### 2026-08-08 · 微信端从 Taro 完整切换为原生小程序运行时 · 影响面：app 微信端 + H5 构建隔离 + 发布工具 + 本地验收

微信端新增 `app/weapp-native` 原生 Page/Component、WXML/WXSS/JS 实现，覆盖 `app.json` 的 38 条主包/分包路由；`build:weapp*` 改由 `build-native-weapp.mjs` 输出 `dist-native`，Taro/React 仅保留 H5 并输出 `dist-h5`。发布元数据升级为 schema 2 + `runtime=native-weapp`，release/upload 会拒绝旧 Taro 微信包；构建校验路由四件套、JS 语法、产物无 Taro，以及聊天 textarea 不得绑定 `value`。原生聊天只把输入写入普通 JS 草稿，编辑时不 `setData` 回灌，规避华为手机 + 百度输入法语音转文字重复、光标跳尾和连删后文问题；SSE 流式、停止生成、附件、登录与主要业务 API 均接入原生服务层。

五个主 Tab、聊天、登录、设置、首次入局、协议与方案管理复用既有视觉 token/页面 SCSS，头像和背景资产沿用原资源。问策底栏保留品牌定制军师帽，微信登录使用固定版本 Simple Icons WeChat 品牌 SVG（CC0-1.0），除此之外的导航、操作、状态和返回图标（包括搜索框清除键）统一使用 `lucide-static@1.27.0` 的 ISC 授权 SVG，构建产物附带来源与许可证；自动测试拦截 Unicode/emoji 字符图标，避免局部又混回手写符号。原生可复制文本统一改用 `user-select`，不再触发微信已弃用 `selectable` 的警告。微信开发者工具 RC 对外层 `miniprogramRoot` 热重建存在旧索引残留，构建同时生成可直接导入的 `dist-native/project.config.json`；本地已用生产 API server 包逐页编译并打开五 Tab 与聊天，未执行 preview/upload。新增原生路由、输入法守卫、图标口径和产物隔离测试，工程与部署文档同步改为原生微信 + Taro H5 双实现口径。

按真机截图继续收口组件样式隔离细节：`TabHeader` 在组件自身建立定位上下文，背景「我 / 令 / 势」完整落在微信胶囊下方；登录全屏层通过 overlay 真值隐藏 custom tabbar，关闭按钮改为高对比白色 Lucide；游客老板页登录按钮显式定高并垂直居中。登录主按钮移除迁移期「微」字圆标，恢复 21px 微信双气泡品牌图形，手机号登录页返回入口同步恢复 15px 浅色品牌图形；两个协议选择框都改为浅米白底 + 深绿 Lucide check，不再出现白勾落在浅底上而肉眼消失。军令页今日战役卡不再直接倾倒方案长文，统一去除 Markdown 标记和拼音前缀、展示紧凑摘要/来源/日期/进度，并补回提醒节奏卡；近 7 天军令按真实日期窗口筛选。默认 mock 下 38 条原生路由已按游客、已登录与未建档状态逐页加载，零页面异常；应用测试共 39 条原生/构建脚本断言与 85 条 H5 纯函数断言全绿。

同轮继续按开发工具截图修复三个原生默认样式回归：军情的经营战局/时运策/命盘分析点选项恢复本命色文字与边框；天时日历、命盘报告的「打开 + Lucide 箭头」固定同一行；方案卡与支付确认的原生按钮清除默认内边距/描边并以 flex 双轴居中，续期、升级、购买文字不再偏上。新增对应静态回归断言。

继续按对话与设置截图收口：原生对话标题改为与微信胶囊同排，右侧操作按胶囊宽度避让，消息区顶部由 133px 收紧到 99px；两个非受控 textarea 和问卷输入的 `adjust-position` 改为真实布尔 false，避免系统自动顶起与手动键盘高度叠加，键盘出现后只滚到最新、失焦归零。底栏按 SVG 实际笔画包围盒放大留白较多的军师帽与锦囊图标，非选中态视觉高度统一；设置页保存身份、绑定手机号、删除账号和色盘确认按钮统一清除原生默认内边距/描边并双轴居中。

老板页经营统计三卡补回迁移时遗漏的并列 `card` 类，重新复用 Taro 原稿的 `--line-strong` 实边与双层卡片阴影；案卷、方案、资料三格不再与页面底融成一片，并新增通用类完整性回归断言。

老板页服务双卡重新对齐 Taro 原稿层级：老师卡恢复“图标与名称 / 微信号或分班入口”上下两行，班级群恢复“群组图标 / 标题与服务状态”左右两列，删除迁移时额外塞入并挤乱排版的卡尾箭头；老师卡深绿图标底改用白色 Lucide 消息图标，避免绿底绿图视觉消失，并增加结构回归断言。

全局收口原生自定义导航顶部空间：此前非 Tab 页把微信胶囊 `bottom` 先渲染成整段空白，再另起 48–52px 返回/标题行，算力、设置、协议、资料、方案、海报等页面因此普遍多出一层假导航。现由 `capsuleMetrics()` 统一输出胶囊 `top/height/right/bottom`，36 个页面根节点透出同一组 CSS 变量；普通详情、native-safe、form、report、settings、plans、legal 与 onboarding 标题均直接和微信胶囊垂直同排，正文从单层导航底部开始。五个主 Tab 的品牌大标题仍从胶囊下缘起排，不侵入系统命中区。新增静态回归，防止任何一种旧页头重新叠回第二层高度。影响面：原生微信全部自定义导航页面与首次入局；H5 不变。

按公司与事业架构页实拍二次校准非 Tab 导航：返回按钮最小行高统一为 36px，并与微信胶囊按视觉中线对齐；按钮底部至分隔线固定保留 10px，修复边框与按钮贴边。二级页标题不再按扣除右侧胶囊后的剩余区域伪居中，统一在返回按钮后左对齐；form/report/settings/plans/legal 与普通 safe header 同口径，右侧真实操作仍保留、空配平占位统一移除。新增导航几何与标题对齐回归断言。

按原生多行对话框实拍恢复 Taro 原稿的上下两层输入结构：非受控 textarea 独占上方正文区，附件加号与发送/停止键进入独立底排并左右对齐，不再绝对定位到段落两侧；多行文字增长时两个操作保持稳定基线，字数提示随发送键同行。按钮同步清除微信原生描边，composer 仍由实际高度驱动消息区避让，不改华为 + 百度输入法的非受控输入铁律。新增结构与定位回归断言。

恢复在游客浏览改造中被删掉的新账号注册与入局主链，并同步迁入原生端：微信/手机号认证后若缺称呼，先进入历史“先让军师认得你”身份页，称呼必填、微信头像可选且走真实 `/me`/头像上传；权威未建档账号保存称呼后自动进入入局仪式。原生 onboarding 不再使用迁移期简化的“圆角四步顺序题”替代页，改为与 Taro 原稿同结构的六色卡与批语、三题 chip 云/其他自填、公司选填、Profile 保存硬闸门、quickscan 初步军情打字机、主要矛盾和今日一事，完成后继续五 Tab 功能点亮。已入局老账号不重复进入，中途退出由战局说明卡续做；H5 登录同样恢复身份页与自动导航。原生 mock 新账号同步移除“主公”假称呼，确保本地预览也真实经过身份补全；新增跨原生/H5 的注册主链回归断言。

里程碑日志尝试同步 Notion：页面在现有 Chrome 登录态可打开，但自动编辑连续超时；为避免盲写或重复插入，本次未提交远端文档，待补内容已明确记入 `AGENTS.md` §13，仓库本条仍为当前完整真源。
### 2026-08-08 · 补三期的写回缺口：切到 V2 后后台改配置必须真的生效 · 影响面：server（迁移体从 scripts 挪进 src）+ 新增 1 个测试文件 + docs

**这是三期我自己埋进去的缺陷，复盘时才发现。** 切到 `AI_CONFIG_V2` 之后，运行时读的是 `ai_route`，而后台写的仍是 `ai_model` / `ai_setting`——中间没有任何东西把改动投影过去。表现是：运营在后台改完配置，页面显示已保存、审计日志有记录、旧表里确实变了，**但线上纹丝不动，且没有任何报错**。所有东西看起来都对，是最难排查的一类故障；要恢复只能有人手动重跑一次迁移脚本，而没人会知道该重跑。

**修法：投影而不是另写一套同步。** 新增 `services/aiRoutes.syncV2FromLegacy()`，直接复用迁移体——它本来就是幂等的（端点按 `legacyModelId` upsert、凭证按 key 去重、路由成员全量重放）。另写一份同步逻辑迟早会和迁移分叉，而分叉的那天就是这个故障重新出现的那天。挂在五个写路径上：`setAiConfig` / `syncActiveSetting`（切换生效模型）/ `addModel` / `updateModel` / `deleteModel`，以及 `PUT /admin/ai-routing`。V2 没开时是空操作；投影失败只记日志不抛——配置已经写进旧表了，投影失败不该让后台的保存请求变红。

**顺带修掉迁移的一个不完整**：此前只做「按旧表算出该有什么」的增量，没有清理**孤儿端点**——运营在后台删掉一个模型后，它对应的端点仍留在路由里继续接流量。现按 `legacyModelId` 反查并清理。

**迁移体从 `scripts/` 挪进 `src/services/aiConfigMigrate.ts`**：它现在是运行时代码（投影函数），不再只是一次性脚本；`scripts/migrateAiConfig.ts` 退化成薄 CLI 壳。tsc 的 `rootDir` 也要求这么放。

**顺着同一条线索又查出两处断线（同类缺陷，都已修）**：
① **探活的能力回填到不了运行时**——`probeModelById` 写的是 `ai_model.capsJson`，切到 V2 后运行时读的却是 `ai_endpoint.capsJson`，中间同样没有投影。于是「探活证伪 → 校验器拦截 → 请求不再发 thinking」这个闭环恰好断在最后一环，而它正是二期的核心主张。现在探活写完也调 `syncV2FromLegacy()`。
② **`model_scope` 探活把查回来的模型清单扔掉了**——`MODEL_OUT_OF_KEY_SCOPE` 这条规则等的就是它，而取数层读的是 `capsJson.modelScope` 这个从来没有人写过、且 `EndpointCapsSchema` 是 `.strict()` 根本不接受的字段。一根线的两头从来没接上，规则写了却永远不会触发。现在 caps schema 收下 `modelScope`，探活写入、校验器读取（迁移会把 caps 一起带进 V2，两种模式都通）。

**验证**：新增 `test/aiV2Writeback.test.ts` **10 例**——改模型 / 改温度与思考模式 / 新增 / 切换生效 / 删除（含孤儿清理）/ V2 关闭时不写新表 / 投影失败不阻断保存 / 探活 caps 投影后真的影响请求组装 / 模型范围规则能被触发 / 没探过时不误报。server `tsc` 0 错、`npm test` **1409/1409**。

**这三处是同一类缺陷**：写路径改了旧表、读路径已经切到新表，中间少一次投影——共同特征是**不报错**，页面、日志、旧表全都显示正常。三期引入双表并存就必然带来这类风险，凡是「写旧表」的地方都要问一句「投影了吗」。

### 2026-08-07 · 重设计收尾：修掉 D1 的第三个入口 + 切换彩排 + 决策点证据收窄 · 影响面：server + admin + docs

针对「哪些还没做」的复盘，把四条待办里能做的都做掉，并在过程中发现一个一期漏修的缺陷。

**D1 还有第三个入口（新发现，已修）**。一期只修了 `/admin/ai-models/test` 与 `/admin/ai-config/test`；`gateway.pingAgentRuntime`——智能体自带接入（`providerMode=openai`）的探活——**同样自己拼 cfg + 调 `pingModel`**，在 `routingMode=pool` 下同样被端点池整体改写，测的不是这个智能体的端点。现补 `poolBypass: true`，并按设计稿决策点 5 的 B 项让它过 `validateEndpoint` 的 error 级校验（此前 Agent 这条路径完全不校验，`baseUrl` 粘成 `/v1/chat/completions` 也照测不误）。回归两例。这条正好印证了当初「唯独不要 C（明确不管）」的判断：盘点了五处配置只修三处，漏掉的那处就是缺陷藏身的地方。

**切换彩排（`test/aiCutover.test.ts`，6 例）**。生产迁移与 `AI_CONFIG_V2` 切换属运维动作、需要窗口，但**切换真正的风险可以先在测试库上按生产形态跑掉**：两个 claude 端点直连七牛、池开启、粘性开启、adaptive 思考、四档单价。`aiMigrate` 验「写出来的行对不对」、`aiRoutes` 验「读出来的配置对不对」，而这里验的是**第三件、也是真正会出事的那件**——切过去之后运行时拿到的配置跟切之前是不是同一份。逐字段比对运行时配置、比对组装出的 thinking 参数（方言不能在迁移里丢）、比对池成员的数量/权重/tier、比对四档单价，以及关掉开关后的回滚等价性。任一字段在迁移中丢失，两边各自的单测都还是绿的，只有这个文件会红。

**决策点 1 / 2 的证据收窄**（都没有据此改生产配置或记账常量——推断不是确认）。① 生产在用的 `/bypass/anthropic` **在七牛任何公开文档里都查不到**：FAQ 只讲 `https://api.qnaigc.com/v1`，官方 `qiniu/coding-helper` 写死 `ANTHROPIC_BASE_URL=https://api.qnaigc.com`。② 七牛模型广场的价目表**确有「缓存输入」档**（DeepSeek-V4-Pro 标「缓存输入 0.000025 元/K」），说明缓存读分开计价；但**没有单独的缓存写档位**——若七牛按输入价结算缓存写，我们默认的 `×1.25` 就是系统性高估 25%。两条都落成校验器 info 提示（`QINIU_ANTHROPIC_UNDOCUMENTED_PATH` / `PRICE_CACHE_WRITE_UNSET_QINIU`），让运营在改配置时当场看见，而不是躺在文档里。

**旧列删除自检（`scripts/checkAiLegacyDrop.ts`）**。「观察一个发布周期」是时间条件、压不掉，但「能不能删」不该靠人凭印象拍板：现在一条命令检查读路径是否真的切过去、每行 `ai_model` 是否都有对应端点、chat 路由有无可用成员、旧表开着的能力在新表有无对应路由、有无待确认 vendor 的凭证。**全绿也不等于现在就删**——仍需人工确认已观察满一个周期且期间没回滚过开关，脚本会把这两条打印出来。

**后台展示逻辑从组件闭包提成纯函数并补测**（`admin/src/modelGateway.ts` + 12 例）。运营后台的登录态实机走查我做不了——该页在管理员鉴权之后，登录要往表单里填 `ADMIN_TOKEN`，这是我不做的事。**这一条只能由你或运维完成**。能做的是别让判断逻辑处于零覆盖：方言展示（已固化 vs 推断中）、检测态展示（本次结果优先于历史值、从没测过要如实说「从未检测」）、嵌入/重排的保存前拦截，现在都是可单测的纯函数，JSX 只剩取值绑定。

**验证**：server `tsc` 0 错、`npm test` **1399/1399**；admin `tsc -b` 0 错 + `lint:ui` + `build` 通过 + `modelGateway.test.ts` **26/26**。

### 2026-08-07 · 大模型接入配置重设计二期 + 三期：方言表 / 互斥校验器 / 检测体系 / 四表归一化 · 影响面：server + admin + shared + Prisma（纯加法列 + 四张新表）+ 监控规则 + 新增 5 个测试文件 + docs

承接同日一期。设计稿 `docs/[OPUS5]AI_CONFIG_REDESIGN_2026-08-07.md`。**默认零变化**：`AI_CONFIG_V2` 不开就完全走旧表；方言表与校验器对既有两条生产链路逐位不变，由全矩阵等价测试锁死。

**二期① · 方言表：把「猜」变成数据（`llm/dialects.ts`）**。根因是 `provider: 'mock'|'claude'|'openai'` 一个字段同时扛四件事（厂商 / 协议 / 方言 / 就绪），信息丢了只能靠 `if (provider==='claude' && !baseUrl.trim())` 和 `/claude/i.test(model)` 两处推断补回来。现拆成 `WireProtocol`（请求形状）+ `Dialect`（同协议下的细节写法）+ `VendorCaps`（有没有这个能力）三个正交维度。**关闭思考有四种写法且各家不同**：Anthropic 官方整体省略、七牛等网关显式 `{type:'disabled'}` 且不得带 `budget_tokens`、OpenAI 协议**仅当运营开过时**才显式发（`explicit_when_configured` —— 这条极易在重构中丢掉：运营开过说明网关认这个扩展，工具/成果请求必须显式按下去，否则网关带着思考进多轮工具调用会破坏强制 `emit_deliverable` 收口）、以及压根没有该字段。`AiModel` 加**可空 `dialect` 列**（纯加法）——没有这一列，推断只是从三处 `if` 集中成一处，根因要拖到三期；后台端点行展示推断结果并提供「固化方言」一键写回。推断收敛到全仓唯一的 `inferDialect()`，且**严格复刻历史判据**（claude + baseUrl 空才算官方直连，非空一律网关——不「优化」成按域名认 `api.anthropic.com`，那会改掉既有端点的请求组装）。另加 `capsJson` 能力三态：探活证伪后 `caps.thinking='no'` 立刻压过模型名正则。**等价性由 `test/dialects.test.ts` 用 315 组全矩阵比对锁死**——把历史逻辑原样抄成 oracle，新旧任一组合不一致即红；两条刻意差异（`openai_official` / `mock` + claude 系模型名）登记在 `KNOWN_DELTAS` 并论证了不可能命中存量配置。

**二期② · 互斥校验器收口（`llm/validate.ts` + `services/aiValidation.ts`）**。此前「保存端点 / 入池 / 切换生效 / 保存路由 / 探活」五处各写各的 `if`：池协议校验在 `routes/admin.ts` 抄了三遍、判据还都是 `AiSetting.provider` 这个**拷贝值**；而 thinking 的约束根本没有保存期校验，后台能存下运行时必然 400 的配置。现收成一个纯函数（事实由取数层查好传入），五个入口共用，返回 `error/warn/info` 三级：error 拒绝保存、warn 可存但后台常驻黄标。规则含 `THINKING_UNSUPPORTED_DIALECT`、`THINKING_CAP_NO`、`THINKING_BUDGET_IGNORED`（DeepSeek 的 Anthropic 端点收下 `budget_tokens` 但忽略取值——不提示的话运营以为调大预算就想得更深）、`BUDGET_EXCEEDS_MAX_TOKENS`、`BASEURL_HAS_ENDPOINT_PATH`（七牛 FAQ 点名过的错法）、`AUX_ORIGIN_PROTOCOL_MISMATCH` / `AUX_VENDOR_UNSUPPORTED`（**两条独立否决**，只判协议会漏掉七牛 OpenAI 入口那种「协议合法但厂商没有嵌入」）、`POOL_PROTOCOL_MISMATCH`（判据换成**成员自身的方言**，不再用任何全局拷贝值）等。`test/aiValidate.test.ts` 30 例，重点覆盖每条规则「不该误伤」的那一侧——校验器最容易出的事故不是漏拦，是把正常配置拦住让运营改不动线上。

**二期③ · 检测体系（`services/aiProbe.ts`）**。从前只有一个按钮、一次 `'ping'`，只能回答「网络通不通」；而线上真正会炸的都不在覆盖里。现为 8 个独立检测项：`connectivity` / `model_scope`（`GET /v1/models` 验七牛 model groups）/ `thinking`（**按被测端点自己的方言真发一次**——2026-07-27 那次 400 只有真发才知道）/ `tools` / `streaming` / `long_output` / `embedding` / `rerank`。三条铁律：必须 `poolBypass`、必须与真实请求同一条组装路径、探活是真实计费请求故按 `kind='probe'` 单独记账并留 `AI_PROBE_SCHEDULED=false` 一键全停。结果落 `lastProbeAt/lastProbeOk/probeJson` 并**回填 `capsJson`** —— 探活说「不支持思考」，校验器下一秒开始拦截，这是「能力靠猜 → 能力靠测」的闭环。定时任务 `ai-endpoint-probe`（连通性 10min / thinking 1h / 模型范围 24h）+ `junshi_ai_endpoint_probe_*` 指标 + Alertmanager 规则 `JunshiAiEndpointProbeFailing` + 飞书卡片知识条目。注：该规则**不带 `signal` 标签**——本仓库 `signal` 的语义是成对 warning/critical 的抑制键，探活是先行指标只有一档。

**三期 · 四表归一化（`ai_credential` / `ai_endpoint` / `ai_route` / `ai_route_member`）**。消掉三笔结构债：① **双真相源**——「生效」不再是把 8 个字段拷进 `AiSetting`，而是 `AiRouteMember.primary` 一个指针；② **key 复制 N 份**——key 提到凭证上，一把 key 喂多个端点，换 key 只改一处；③ **用途混用**——新增 `purpose` 维度（chat / deliverable / aux / embedding / rerank / moderation），各有各的端点、权重与预算，**辅助档从此不再只能用 `AI_AUX_*` 环境变量配**（运营在后台看得见、测得了）。迁移脚本 `scripts/migrateAiConfig.ts`（`npm run ai:migrate` 预演 / `ai:migrate:apply` 写入）：幂等（`legacyModelId` 唯一键 + 凭证按 apiKey 去重，可反复跑）、只增不删（旧表一个字段都不动）、**vendor 推断不出时只标黄不阻断**（在这里拦住会把 chat 路由迁成空的＝把线上 AI 关掉，比 vendor 标错严重得多）、算不出任何 chat 成员时宁可不迁。读路径由 `AI_CONFIG_V2` 切换（默认关），**且只有该用途真有可用路由时才走新表，否则静默回落旧路径**——迁移没跑完、路由被清空、数据库刚恢复都不该让 AI 停摆；回滚＝把开关关掉。`llmPool` 的池成员在 V2 下来自 chat 路由；`getAiConfig` 把嵌入 / 重排路由投影回原字段，让 `services/{embedding,rerank}` 零改动。新增 `GET /admin/ai-v2-status` 与后台只读分区（切换故意不做成一键开关：这是需要迁移窗口 + 观察期的读路径切换）。

**验证**：server `prisma generate` + `tsc --noEmit` 0 错、`npm test` **1391/1391 全绿**（新增 `test/{dialects,aiValidate,aiProbe,aiRoutes,aiMigrate}.test.ts` 共 85 例）；admin `tsc -b` 0 错 + `lint:ui` 通过 + `vite build` 成功；app `tsc --noEmit` 0 错。**未做**：运营后台的登录态实机走查（该页在管理员鉴权之后，登录需填 `ADMIN_TOKEN`）；生产迁移与 `AI_CONFIG_V2` 切换（需迁移窗口，属运维决定）；旧列删除（按设计稿应观察一个发布周期后再做）。设计稿 §8 的五个决策点仍待拍板。

### 2026-08-07 · 大模型接入配置重设计一期：修四个已确认缺陷 + 补七牛预设 · 影响面：server + admin + shared + Prisma（纯加法一列）+ 新增/扩展 4 个测试文件 + docs

设计稿见 `docs/[OPUS5]AI_CONFIG_REDESIGN_2026-08-07.md`（六维度归一化目标结构、26 条互斥规则清单、检测体系、三期迁移路径）。本次只落一期：**不改数据结构语义，只修已实测确认的缺陷**，二期（方言表 + 校验器 + 检测体系）与三期（表结构归一化）另行排期。

**D1 · 「测试连接」在 `routingMode=pool` 下测的不是被测端点（已实测复现）。** 探活走 `pingModel → claudeRaw/openaiRaw → withEndpoint → resolveCandidates` 这条正常外呼链路，而传进去的表单配置**没有 `poolBypass`**，于是被 `llmPool.toCfg()` 整体改写：实测输入 `baseUrl=being-edited / model=model-being-edited / apiKey=sk-being-edited / temperature=0.3 / thinking=enabled·4096`，实际发出的第一候选是 `pool-a / pool-model-a / sk-pool-a / 0.9 / disabled·1024`，**无一字段相同**。后果：刚粘错的 key 照样返回「连通 ✓」；想确认某端点是否恢复却测到另一个；探活没有 `affinityKey` → HRW 的 key 恒为 `'anon'` → 永远命中同一个池成员，多测几次也发现不了。**这是「配置改完看着没问题、上线却出事」最直接的来源。** 修法：`mergedTestConfig()` 与新提取的 `mergedConfigTest()` 一律返回 `poolBypass: true`（与 `AI_AUX_*` 辅助档同一个 bypass 通道）。**两个入口必须一起改**——`/admin/ai-models/test`（模型表单探活）与 `/admin/ai-config/test`（全局配置探活）此前各写一份合并逻辑，只修一个另一个照样被劫持，故把后者的合并整块提进 `aiConfig.mergedConfigTest()` 收成同源纯函数。

**D2 · `POST /admin/ai-models` 静默丢弃池参数。** 路由层为 `poolEnabled` 做了协议校验（不匹配返回 409 `AI_POOL_PROVIDER_MISMATCH`），但 `addModel()` 的 `data` 里根本没有 `poolEnabled/weight/tier/maxConcurrency` 四个字段——校验通过后写库时被丢掉。契约 `AiModelUpsert` 声明支持、实际只有 `PATCH` 生效，于是「新增时勾了入池」静默变成未入池。修法：补写四字段，并把 clamp 提成 `clampWeight/clampTier/clampConcurrency` 三个常量供 `addModel`/`updateModel` 同源使用（`weight≥1` 是硬要求：0 会让 HRW 打分恒为 0，等于悄悄踢出池）；同时补上 `addModel` 后的 `__resetLlmPool()`，与 `updateModel` 同口径。

**D4 · 缓存写单价这一档在库里不存在。** `data/modelPrices.ts` 的 `ModelRate.cacheWrite` 有读取逻辑、注释也写着「运营需显式填 `rate.cacheWrite`」，但 `AiModel` 没有这一列、后台没有输入框、`buildConfiguredRateMap()` 也不产出这一档——**实际永远走硬编码的 `CACHE_WRITE_MULTIPLIER = 1.25`**，而这个 1.25 的前提（上游透传 Anthropic 缓存计价）至今未向七牛确认。修法：`AiModel` 加 `priceCacheWrite Float @default(0)`（**纯加法列，`db push` 安全**）+ 后台第四个输入框 + `buildConfiguredRateMap` 产出该档并**纳入同名模型的一致性判定**（四档只要有一档不一致就整体退回未校准，维持既有确定性回退口径）。**向后兼容**：未填/历史行 → `cacheWrite` 为 `undefined` → 折算继续按 `in × 1.25` 推导，与加这一档之前逐位相同。

**D5 · 嵌入 / 重排的「留空＝复用对话模型」是必错的默认值。** 服务端回退是 `cfg.xxxBaseUrl || cfg.baseUrl` + `cfg.xxxApiKey || cfg.apiKey`，而请求路径是 OpenAI 风格的 `${baseUrl}/embeddings`、`${baseUrl}/rerank`。**两条独立的否决理由**：① 对话端点走 Anthropic 协议时（生产正是如此），baseUrl 是 Anthropic 协议根，拼出的路径**协议上就不存在**；② [七牛官方 FAQ](https://developer.qiniu.com/aitokenapi/12897/how-to-use-ai-token-api) 明示「暂未提供文本向量/Embedding 模型」——**这一条协议上是合法的**（`api.qnaigc.com/v1` 是标准 OpenAI 兼容），所以只判协议会漏掉它。修法：新增 `admin/src/modelGateway.ts` 的 `auxReuseBlock(provider, baseUrl)`，两条理由都判；命中时后台禁用「留空」、把 baseUrl/Key 标为必填、给出具体原因，并在保存前拦截。**不改任何运行时行为**——只加闸门与文案（生产 `embeddingEnabled` 现状待确认，见决策点 3；若从未开启则 D5 是陷阱而非现役故障）。域名清单是一期的临时兜底，二期由 `VendorPreset.caps.embedding` 取代。

**D7 · 生产在用的厂商不在预设表里。** `AI_PRESETS` 12 项里没有七牛，默认值还指向已不在用的 Agnes（`baseUrl=apihub.agnes-ai.com/v1`、label「Agnes 2.0 Flash」），运营接七牛只能手打 bypass 路径。修法：**一个厂商可能要占两条预设**——同一家的 OpenAI 协议与 Anthropic 协议是**两个不同的 baseUrl**（七牛 `…/v1` vs 根路径、DeepSeek `/v1` vs `/anthropic`、火山 `/api/v3` vs `/api/coding`），选错入口就是上线后 404/400，协议不是「模型名的属性」。新增 `qiniu-anthropic` / `qiniu` / `deepseek-anthropic` / `volcengine-anthropic` 四条，note 里写明各家方言差异（七牛 `disabled` 不得带 `budget_tokens`、DeepSeek 的 `budget_tokens` 被忽略、火山那条来自 Coding Plan 形态需直测）。**model 只在已实测可用时才预填**（七牛 Anthropic 填 `claude-opus-4-6`，2026-07-27 生产直测过），没验证过的一律留空并把查法写进 note——预填一个不存在的模型名，失败时看起来像我们的 bug，比留空更糟。`AiSetting` 的 Agnes 默认值改为 `mock`/空（未配 key 时 `effectiveProvider` 本就降级 mock，这里只是让库里的值与事实一致；`agnes` 预设本身保留，不动既有环境）。

**验证**：server `prisma generate` + `tsc --noEmit` 0 错、`npm test` **1306/1306 全绿**（新增 `test/aiProbeBypass.test.ts` 6 例含一条**反向锁**——先证明不带 `poolBypass` 时确实会被池改写，再证明修复生效；新增 `test/aiModelUpsert.test.ts` 9 例覆盖池字段落库/clamp 同源/缓存写档存取/预设完整性；扩 `test/aiRates.test.ts` 至 9 例覆盖第四档）。admin `tsc -b` 0 错 + `lint:ui` 通过 + `vite build` 成功 + `modelGateway.test.ts` **10/10**（新增 7 例锁住两条否决理由、子域名命中、相似域名不误判）。运营后台页面本身未做登录态实机走查——该页在管理员鉴权之后，登录需要填 `ADMIN_TOKEN`，未做。**未做**：二期（`dialect` 列 + 方言表 + 互斥校验器 + 检测体系）、三期（四张新表归一化）；决策点 1–5 待拍板。

### 2026-08-06 · 监控告警整体梳理并升级高信息量飞书 Card 2.0 · 影响面：server + Prometheus/Alertmanager + 运维配置/文档

API 时延与错误率完成生产 SLO 重定基线：生产 24h 数据显示原“普通接口”P95 的 0.49 秒主要来自 `/api/alerts/webhook` 同步等待飞书回执，并非用户页面变慢；旧规则还缺最小样本门槛，低流量下单个慢请求或单个 500 会被放大成 P2/P1。现统一改为“用户交互接口”口径，剔除生成/流式、上传、webhook、callback、metrics、health 等天然长耗时或控制面路径，阻断“通知接口慢 → 再通知”的自激风险；P95 与 5xx 均使用 15 分钟窗口且要求至少 20 次请求。生产 P95 默认线由压测容量护栏 200ms/500ms 改为线上体验 SLO 800ms/2s（预警持续 10m、严重持续 5m），5xx 严重线保留 1% 但同样加样本门槛。Grafana API 总览同步改为相同筛选、窗口和色阶；后台新增“接口告警最小样本量”配置项。首次发布验收同时发现 Grafana 容器的 dashboard bind mount 为空，界面仍在使用数据库中的旧看板；部署脚本现对比看板目录哈希、校验主机/容器 JSON 数量，变化或不一致时强制重建 Grafana，避免看板代码已更新但线上未生效。生产最终部署 `15647b7`：Grafana 自动重建并确认挂载 4 个看板，Grafana API 返回“用户接口 P95（15m）/ 用户接口 5xx 率（15m）”及新查询；Prometheus 51 条规则全部加载，三条 API 新规则 health=ok，运行阈值为 800ms/2000ms/最少20次，当前用户接口 P95 约 24ms且无活动告警，API/DB 健康、近 10 分钟无 warning/error。

告警口径按可处置性再次收紧：`JunshiChatUsageEstimated` 只是正常兜底统计，没有独立人工动作，已撤出 Alertmanager 并继续保留为 Grafana 指标；真正需要通知的“模型用量数据缺失”与“对话生成任务异常接管”拆开说明成本报表影响和用户体验影响。用户可见摘要统一改为自然中文，不再直接暴露 `provider / usage / fallback / sweep / GenerationJob` 等实现词，并增加回归测试防止重新引入。

飞书通知由一行 text 升级为 Card 2.0：Alertmanager 改按 `category + severity` 聚合同领域关联信号；卡片标题直接写具体故障，副标题固定 `P1/P2/P3 + 业务领域 + 当前信号`，结论区展示环境与时间。全局态势保留状态/信号数/持续或恢复耗时，每个信号新增“当前指标 / 告警条件 / 超限状态”三栏指标区，超限幅度或状态按级别高亮，恢复时明确显示已回落至告警线内；下方再展示现象、业务影响、处置建议、影响对象和 Grafana 看板按钮。告警风暴最多展开 8 条并明示剩余数量，外部标签与注解进入 Markdown 前统一转义。新增 `services/alertCard.ts` 告警知识字典，所有 alertname 都有中文标题、阈值解释、影响和动作；规则侧强制 `category/current/summary`，对账测试会阻止“只有 PromQL、没有可读卡片”的新规则进入。生产发布后用后台“发测试消息”向当前飞书机器人发送完整卡片作为验收，不以代码已合并代替线上渲染确认。

规则从 41 条补到 51 条可处置告警：新增 API 限流激增、模型调用错误率/P95/队列拒绝、模型日预算 100% 红线、支付自动对账停跑、创作失败率/AI 排版模板回退、主机文件句柄、数据库死锁与监控采集目标离线；动态阈值从 18 项扩为 20 项（API 限流频次、模型调用 P95）。成对预警/严重规则新增 `signal`，critical 只压住同信号 warning，避免不同告警因缺标签被误抑制；info 重复提醒降为 12 小时。四块 Grafana 看板从 81 个补到 95 个面板，新增采集目标/飞书转发自检、模型错误率/P95、支付自动对账心跳和创作失败/回退定位。后台“发测试消息”同步改为完整卡片验收，`server/.env.example` 新增环境名、Grafana 地址和卡片时区。

生产首次实发捕获到飞书 webhook `10002 invalid background_style`：Card 2.0 文档声明可用的 `rgba(...)` 在机器人入口被拒绝。三格态势分栏已去掉该非必需背景字段，保留分栏、留白和全部信息层级；回归测试禁止卡片重新带入 `background_style/rgba()`。最终生产部署为 `097069a`，`junshi-api` 健康、Alertmanager 配置通过、Prometheus 实际加载 51 条规则；后台实发测试卡获得飞书成功回执 `sent:true`。飞书 macOS 客户端可视验收确认：红色 P1 卡片标题为“普通接口延迟严重（测试）”，指标区完整显示“接口 P95 0.82 秒 / 严重线 0.50 秒 / 高于告警线 64%”，超限幅度按严重等级高亮，未退化为纯文本且无截断。Notion 工程变更日志因当前浏览器无可用登录会话暂未更新，已在 AGENTS §13 明确记录待补内容。

### 2026-08-06 · 生产发布 `9f7167e` 并上传微信小程序 `0.2.29` 开发版 · 影响面：production + server/admin/H5 + 微信开发版

生产已部署游客浏览与动作级登录调整：服务端、运营后台和 H5 均由提交 `9f7167e` 构建并切换，线上 `.deploy-version` 与该提交一致；`junshi-api` active、`NRestarts=0`、健康检查数据库正常，发布后 15 分钟无 warning/error。匿名 `/api/modules` 返回 10 项公开目录、匿名 `/api/plans` 返回 4 个方案，无效 token 请求公开模块仍严格返回 401；H5 与 `/admin/` 均返回 200。小程序按生产 server 模式重建并核对生产 API、版本与 Git SHA 后，以 `0.2.29` /「游客浏览与动作登录优化」上传成功，包体 1.3 MB（1412678 B）。本次只进入微信后台开发版；经营主体/备案/联系方式等外部事实与微信后台隐私指引尚未补齐，因此未提交审核或正式发布。

### 2026-08-06 · 登录关闭按钮动态避让微信胶囊 · 影响面：app 登录层

登录全屏层不再用固定 `right:18px` 摆放关闭按钮。打开时读取微信 `getMenuButtonBoundingClientRect()`，让按钮与原生胶囊垂直居中并保持左侧 12px 间距，避免不同机型上被右上角原生功能按钮遮挡；H5 与旧基础库保留 safe-area 兜底，同时补齐关闭按钮的可访问名称。

### 2026-08-06 · 游客页去权限解释文案，统一业务空态 · 影响面：app 五个主 Tab + 登录 + 方案页

删除 C 端「不登录也能看」「游客浏览」「公开浏览」「浏览不需要登录」「先随便看看」等自我解释型文案。问策页与锦囊页直接展示真实目录，不再额外挂游客说明卡；军情、军令、老板页改为「还没有战局判断 / 还没有军令 / 尚未登录」轻量空态，动作只写「去问策 / 登录」；方案页去掉公开浏览说明卡，购买按钮回归「购买 / 咨询」，点击后再由登录层说明本次目的。登录层保留右上角和遮罩退出，移除底部浏览提示；建档退出文案收敛为「稍后再建档」。动作级 `AuthReason` 继续保留，避免用户触发发送、购买、保存时不知道为何需要登录。

### 2026-08-06 · 小程序卡片层级与页面节奏精调 · 影响面：app 五个主 Tab + 对话 + 公开方案

按微信开发者工具 iPhone 12/13 Pro 逐页走查游客问策、军情、军令、锦囊、老板、总军师对话和公开方案后，收敛出三级间距语义：同组卡片 12px、独立内容块 16px、章节切换 24px，并在 weapp/H5 token 中同步定义；问策搜索/快捷卡/军师列表、军情登录提示与判断卡、军令三步卡与登录卡、锦囊导航/提示/能力列表、老板游客卡/登录卡/菜单分组均按该节奏重排。三列指标卡改为明确 8px gap + 等分伸缩，不再依赖 `31.8% + space-between` 产生只有约 5-6px 的偶然缝隙；对话开场气泡与四问卡、公开方案卡之间同步拉开。

通用 `.card` 修正为 `--line-strong` 实边，`--line` 继续只用于卡内分割线；快捷卡、四问卡和方案卡等未完全继承通用卡片的表面也同步补齐实边。登录全屏保持原有留白重心，不为追求统一而硬塞卡片或压缩品牌区。同步统一游客态页面 `Login / GuestNotice / AsyncState / Sheet / CoachMarks` 的组件样式导入顺序，避免 common chunk 覆盖关系随入口变化。

### 2026-08-06 · 小程序登录改为游客可浏览、动作级触发，手机号降为可选 · 影响面：app + server + 合规文案

冷启动与五个主 Tab 不再自动弹全屏登录；问策、军情、军令、锦囊、老板和军师对话均新增真实公共内容或诚实空态，游客可浏览军师人设与开场白、每日一句、能力目录、公开套餐价格、协议/隐私与客服。发送、历史/搜索、上传/保存、执行、购买和档案维护才按 `AuthReason` 打开登录层；登录层补齐右上角关闭、遮罩关闭和「先随便看看」，关闭后保留原页面及对话输入。`GET /modules` 新增严格匿名目录：无 token 返回公开价格与详情、有效 token 返回个性态、无效 token 仍 401；方案页游客改用公开 `/plans`，购买时再登录。

微信 `wx.login` 成功即完成账号登录，不再串强制绑手机号、头像昵称或建档；手机号验证码保留为主动替代登录，设置页新增可展开、可取消的短信绑定。首次入局建档改为自愿入口，恢复返回键并在三步均提供稍后退出。401 语义按请求发出时的 token 快照分流：有凭证失效仍全局清态并回登录入口，无凭证游客只由当前动作承接，不再误报「登录态已失效」。运营附身入口已从登录首屏移除，仅保留设置页长按版本号。

协议正文同步改正手机号、自动续费、隐私收集和退款实现口径，并清除业务规则类 `【待确认】`；经营主体/备案/地址/邮箱/管辖地仍需主体负责人给出权威事实，微信后台《用户隐私保护指引》也需运营完成，二者已记入 AGENTS §13，未补齐前不得提审。新增动作理由与匿名 401 纯函数测试、公开模块服务/HTTP 测试；app 85 例、server 全量 1280 例、server 公开模块 9 例均通过，app H5/server、小程序 server、server 与 admin 构建全绿。隔离 `junshi_test` 服务已完成 DevTools 游客五 Tab、对话输入保留、公开套餐与购买登录理由的运行验收，并将同一 server 包 auto-preview 推送到手机；手机端最终点击录屏仍由有设备的验收人完成。

同日完成 P0-9 实际接口复核并收紧隐私口径：当前包没有 `getPhoneNumber/getUserProfile/getUserInfo/getDeviceInfo`、剪贴板读取或位置接口；真实能力为用户主动触发的头像选择、相册/相机、微信聊天文件、保存相册、一次性订阅消息、客服会话，以及只写不读的剪贴板。隐私政策不再笼统声称采集“设备标识”，改为如实列明 IP、User-Agent/基础运行环境与访问日志，并在整改方案追加可直接对照微信后台的调用点/目的矩阵，防止多报或漏报。

### 2026-08-05 · 生产发布 `279fa6c` 并上传微信小程序 `0.2.28` 开发版 · 影响面：production + server/admin/H5 + 微信开发版

生产已完成纯加法 GenerationJob 数据结构迁移、AI 模型凭证明文化、server/admin/H5 构建与切换，线上部署版本为 `279fa6c`；API 健康、数据库、运营后台与 H5 均返回 200，`junshi-api` active，AI 历史密文字段为 0，Prometheus 41 条规则已加载。小程序按生产 server 模式与 `https://wxapi.aibuzz.cn/api` 重建，类型检查和构建元数据校验通过后，以 `0.2.28` /「断连续生成、内嵌战报与命盘军令修复」上传成功，包体 1.3 MB（1407403 B）。本次只进入微信后台开发版，尚未提交审核或正式发布。

### 2026-08-05 · 修复军令页未定义日期变量导致的运行时白屏，并给小程序构建补类型闸门 · 影响面：app + build

预发真机点击「军令」后路由已切换、相关 `/casefile`/`/me`/`/decisions` 请求也全部 200，但页面没有挂载任何节点。根因是战役卡引用了未定义的 `dateStr`；Taro/Babel 只做转译仍显示 `Compiled successfully`，真机首次渲染才抛 `ReferenceError`。现由 `todayDate` 明确派生月日文案，并新增 `npm run typecheck`：app 单测、weapp/H5 正式构建、生产与预发专用构建均先执行 `tsc --noEmit`，同类未定义变量不再进入预览或上传产物。

### 2026-08-05 · 命盘修改生辰入口与编辑区同位 · 影响面：app（命盘报告）

修复命盘报告里「生辰录错了？修改并重新立盘」入口位于命主档头、编辑表单却渲染在整份长报告页尾的问题。表单现紧跟命主档头展开，并在从档头、真太阳时提示或报告中段补时辰入口进入时自动滚到编辑区；表单字段、原始生辰回填和主动重排 `paipan-v3` 口径不变。

### 2026-08-05 · 取消 AI 模型凭证存库加密，保留旧密文无停机迁移 · 影响面：server + deployment + docs

按产品决策，`AiSetting` 的对话/Embedding/Rerank API Key 与 `AiModel.apiKey` 新写统一明文存库，不再让真实 AI 运行依赖 `APP_ENCRYPTION_KEY`；运营 API 仍只返回 `hasKey`，不向前端下发明文。新增 `aiCredentialStorage` 作为唯一读写口径：读路径兼容历史 `enc:v1`，写路径遇到旧密文先解开再落明文；新增幂等 `npm run secrets:decrypt-ai`，所有字段先成功解密后才在同一事务写入，错钥/缺钥 fail-closed，不会留下半迁移。

生产部署在服务重启前执行同一迁移，旧版本本就兼容读取明文，因此数据库切换不要求停机。预发仍从生产复制 `ai_setting/ai_model`，但不再把生产 `APP_ENCRYPTION_KEY` 持久写入预发；兼容窗口仅通过迁移进程环境临时传入旧钥，并在重启前硬验 AI 密文为 0。`secrets:encrypt` 同步移除 AI 表，避免后续运维命令反向加密；Agent/Dify/技能库/告警/图片供应商等其它业务密钥仍走 `secretBox`。接受的取舍是数据库读权限与备份持有者可见模型凭证，须继续以最小权限、备份 0600 和主机访问控制收口；无接口/数据库结构变化，小程序无需因本项单独发版。

### 2026-08-05 · 对话生成可靠性方案落地，并完成每日战报内嵌化与排盘 v3 · 影响面：shared + Prisma + server + app + monitoring + deployment + docs

新增持久化 `GenerationJob / GenerationAttempt / GenerationEffect`：新客户端以稳定 `clientRequestId` 建单，同一用户请求只落一条 user message、一次额度预留和一个生成任务；worker 用租约、心跳与 `leaseVersion` fencing 跨进程接管，按权威全文快照续流。页面退出、切后台、弱网或 HTTP 断开只结束订阅，不再取消后端任务；会话列表展示生成阶段，进入原会话按 `generationId + snapshotVersion` 恢复，不强制跳页，只有显式停止才写持久取消。生成中的输入仍锁定，服务端同时禁止同会话并发。同步兼容入口超过等待预算返回 202 后转轮询，不再空白收尾。

生产兼容旧客户端时，即使请求没有 `clientRequestId`，服务端也会生成一次性 `legacy-<uuid>` 并强制进入持久任务链路，避免旧包继续触发“断连即退款/丢结果”和旧结算分支；跨 HTTP 重传幂等仍只由升级后的客户端稳定 key 保证。

预发首次真实生成冒烟又发现部署脚本只复制生产 `ai_setting/ai_model` 密文，预发 `.env` 却没有生产 `APP_ENCRYPTION_KEY`，于是数据库校验显示 4 个带 key 模型、运行时仍全部解密失败并返回 `AI_UNAVAILABLE`。当时先补了同步且不回显地对账配置解密钥匙的止血；随后产品决定取消 AI 模型凭证加密，已由上方新条目的“临时解密迁移、预发不持有生产旧钥”替代。JWT、微信、支付等其它生产凭据始终不复制，预发真支付隔离仍保持。

同轮补正 `deploy-preprod-aicopy.test.sh` 中环境变量紧邻中文右引号却未加 `${...}` 的 Bash 展开歧义；旧写法在当前 locale 下把右引号字节并入变量名，导致回归脚本还没测到复制逻辑就因 `set -u` 退出。

用量改为按真实 provider attempt 统一结算：完成、截断、失败、取消、租约恢复与推荐选项补生成均累计 provider usage，缺失时保守估算；纯 mock、缓存命中及 provider 前审核拦截为 0。主回复先持久化，再用独立 `ask_recovery` attempt 在 3 秒预算内补推荐选项；补出的可见文本纳入用户/租户/会话成本归因、输出审核和禁用词审计，失败只少选项。进程若在 `finalize` 阶段退出，接管者只恢复推荐项与终态，不重新调用主 provider、不改写已交付正文；重进端也持续锁定输入直到 job 真正终态。结果终态与 `GenerationEffect` outbox 同事务登记，失败/stale effect 后续补偿投递；业务目标仍按 at-least-once 语义自行幂等。

同时完成相关止损与产品项：provider AbortSignal、首事件/流中空闲窗与续写墙钟、工具路径续写、残文/usage 保全、OpenAI 端点命中后再构造 body；长文归卷 uploading/failed 均禁止发送，失败不覆盖新草稿；每日战报改为 `GET /cards/daily` + `packages/work/daily` 登录态内嵌页，旧 canvas/发布入口已删除或 410、历史 daily 公开页 404；排盘升级 `paipan-v3`，新排/主动重排写 v3，存量 v1/v2 不改。补齐生成生命周期/首字/恢复/估算指标与告警，provider 前无 attempt 的确定 0 不误报为估算；部署脚本对监控单文件挂载做哈希重建，并把已存在但 exited 的监控容器拉起后做 readiness/SHA/规则数硬验收。已部署预发并完成真实断连续跑/重进恢复验收，生产尚未发布；生产发布后仍须按 `docs/CHAT_STREAMING_RELIABILITY_PLAN.md` §12.4 连续观察 24 小时。

### 2026-08-05 · 附件卡视觉层次重做：新增 --line-strong / --shadow-card 两个 token + 渐隐式深度 · 影响面：app（app.scss + app.h5.scss token；chat 页卡片/弹层样式 + 两个渐隐层）

**现象**（真机反馈）：粘贴长文卡「颜色太像了，比如边框」。

**定量核过，反馈准确**——问题是三块近似色叠在 60px 之内，且唯一的分隔线几乎没有对比度：

| 组合 | 对比度 | 结论 |
|---|---|---|
| `--line` on `--surface-2`（卡的边） | **1.12:1** | 画了等于没画 |
| `--accent-soft` on `--surface-2`（图标底） | **1.04:1** | 比边框更糊，图标像浮在虚空里 |
| `--surface-2` vs `--surface`（卡底 vs dock 底） | 1.13:1 | 卡与下方同色输入框读成一整块灰 |
| `--line` on `--paper`（已发出的 `.uref-card` 边） | 1.22:1 | 发出后的附件卡同样是一片糊白 |

**新增两个 token**（`app.scss` + `app.h5.scss` 双写，H5 无 `page` 节点）：
- `--line-strong: #D2CBB9` —— 卡片/附件的**实边**（白底 1.62:1 / `--surface-2` 1.43:1 / `--paper` 1.55:1）。看得见，又不至于变成硬黑框。**分割线继续用 `--line`，没有整体替换**。
- `--shadow-card` —— 三层递进 + 负 spread 的漫射阴影，给「浮在同色底上的卡」用。白卡压白底只靠边框会贴死在底上。

**卡片层次三件套**（`.paste-card`）：底色离开 `--surface-2`（改白，与下方输入框分开）→ 边走 `--line-strong` → `--shadow-card` 浮起。再加左侧 2px **本命色脊**，一眼认出「这是要带上的资料」，且随设置里的本命色走（六色已逐一验过脊与柔光环都跟 `--accent`/`--accent-glow`）。图标内核补一圈 `--accent-glow`。三种状态拉开距离：常态本命色脊 / 重复高亮改用柔光外环 + 淡底（不改尺寸、不引起重排）/ 在途脊不上色 + 压低阴影 + 徽标呼吸动画（原来的虚线边在 3px 直角上只显得潦草）。`.uref-card` 同步换边并给更轻的 `--shadow-sm`——已发出是「落定的引用」，输入区那张是「此刻要带上的」，层级上后者更亮。

**深度用渐隐，不用 backdrop-filter**：反馈提到「加一些模糊效果」，但 `backdrop-filter` 在小程序 WebView 不可靠，且 dock 本身不透明、底下没有东西可虚化，真正起作用的是渐变。新增两处 `pointer-events:none` 的渐隐覆盖层——`.dock-fade`（对话内容滑进输入区前先化掉，改前问卷卡正好被齐平裁在附件卡上沿）与 `.paste-body-fade`（预览弹层正文滑到动作条前化掉，改前切在半个字上）。两处同一手法，本组件不再另立第二种。用真实 `View` 而非伪元素（小程序端伪元素支持面窄），absolute 定位在 `.composer-dock` 盒外，不影响它的 `boundingClientRect`（`jump-latest` 靠它测高）。

**顺带**：弹层动作按钮的边也从 `--line`（白面板上 1.27:1）换成 `--line-strong`，并在正文与动作之间压一条分隔线；卡片按下与重复高亮都改成 `cubic-bezier(.32,.72,0,1)` 插值，瞬切读成「闪了一下故障」，插值才读成「回应了这一下」。

**新发现的既有问题已记 §13 TODO**：`app.h5.scss` 基础 token 块选择器带 `#app`（特异度 1,0,0）压过主题类 `.theme-*`（0,1,0），**H5 上切本命色完全无效**；weapp 端基础块是 `page`（0,0,1），主题类正常，线上无影响。是全局 token 级联的根，须单独开任务，不并入本次。

app 83 例全绿；weapp / H5 均 Compiled successfully；H5 面板走查：常态/重复/在途三态一屏对比、预览弹层、两处渐隐、六色本命色跟随均已确认。

### 2026-08-05 · 粘贴长文归卷的前端交互重做：卡面露内容 + 可点开看全文 + 按内容去重 + 用户轮改纵向栈 · 影响面：app（chat 页 + 新增 services/pasteAbsorb + 8 例单测）

**现象**（真机实拍两张）：主公把腾讯会议记录粘进对话框，输入框随即清空，上方只留一枚写着「粘贴长文 ✕」的小签——没有字数、没有内容、点一下反而把它删了。主公判定粘贴没成功，隔约一分钟又粘了一遍，于是挂出两份 2612 字的重复附卷；发出后气泡与附件卡还并排挤在同一行，排版彻底散掉。

**根因四处，逐一归位**：

1. **空窗期（最要紧的一处）**：`settlePaste` 同步清空输入框，但引用签要等 `await api.createKnowledge` 回来才 `setRefs`。弱网下（实拍第二张信号从 4 格掉到 2 格）这中间就是「框里的字没了、卡片还没来」，唯一提示是 1.5 秒就消失的 toast。改为**先落一张 pending 占位卡再打网络**——清空与卡片出现同帧，成功后原地换成真引用签，失败照旧回填全文。
2. **卡面信息量倒挂**：`refCardParts` 把 `粘贴长文·2612字` 按「·」拆成 title/meta，而输入区的 `.ref-chip` 只渲染 title——发出后的卡片反而比发出前更清楚。粘贴长文改走独立的 `.paste-card`：图标 + `粘贴长文 · 2612字` + **首行内容摘要**（`pasteExcerpt` 压掉换行取开头 42 字）。对齐 ChatGPT / Claude 的 pasted-text 附件卡，两家都在卡上露内容。
3. **点卡片是删除**：整张 chip 的点击走 `toggleRef`，想核对内容一点就把长文删了。改为**点卡片 = 打开预览浮层**（全文可滚可选中 + 复制全文 + 移除这份），全文取本地 `pasteTextRef`，零网络、点开即有；删除只留右侧 `✕`（`stopPropagation`）。这是 Claude 的可展开附件预览；ChatGPT 那侧「看不到内容、无法核对」正是其社区里最集中的抱怨，照抄它反而会继承缺陷。
4. **去重口径不对**：旧规则是「10 秒窗口 + 长度和首尾 32 字指纹」。实拍那条两头都不满足——隔了约一分钟（超窗），且第二次粘贴前先打了「还有会议记录：」，被 diff 裹进 pasted 段后指纹全变。改为**按内容去重、不设时间窗**，作用域 = 当前这一轮 composer（发出或撤掉卡片即忘）：去空白后互为前缀/后缀且短段占长段九成以上即判同一段，命中则不新建第二份，只 toast +高亮已在的那张卡。在途那一份也先按占位 key 记进账本，免得第一份还在打网络时又粘一遍照样出两份。

**排版**：`.msg.u` 原是 `display:flex; justify-content:flex-end` 的**行**方向，气泡与 `.uref` 成了并排的两个 flex 子节点——这就是实拍第二张里正文被挤成窄条、附件卡贴在右侧的直接原因。改为纵向栈（`flex-direction: column; align-items: flex-end`），并把附件卡渲染到正文**之上**：与输入区「卡片在上、输入框在下」同序，也与 ChatGPT / Claude 的用户轮一致。`.uref` 同时要 `width: 100%`——纵向栈里它若按内容收缩，子卡的 `max-width: 82%` 没有确定参照宽度可算，会被压到刚好裁掉元信息尾字（实测「3622字 · 附卷」缺 4px）。

**另外**：首次触发自动归卷时在卡下给一次性说明（`chat-paste-hinted` storage 标记），toast 一闪即逝教不会人。**未做**：不提供 ChatGPT 的「Show in text field」（把附件放回输入框）——本页发送硬上限 2000 字，把 2000+ 的长文塞回去必撞上限，是死路。

纯判定逻辑抽到 `app/src/services/pasteAbsorb.ts`（`diffPasted` / `pasteExcerpt` / `pasteNorm` / `isSamePaste`）并配 8 组单测，其中一例直接锚定实拍那条漏判路径。app 83 例全绿；weapp / H5 构建 Compiled successfully；H5 面板实测走查：单份卡面、重复粘贴只出一张、预览浮层、发出后两份附件的纵向栈排版均如实呈现。

### 2026-08-04 · 提问选项（```ask 块）在长回复里丢失：协议移到提示词最末 + 服务端兜底抽取 · 影响面：server（llm/schema + gateway + 两个 provider + metrics + tests）

**现象**：军师提了问题，端上不出可点选项。

**线上定位**（生产库只读查证，两条真实测试消息）：一条 2845 字的长回复结尾问了三个问题，`asks` 为空、正文里连半截 ```ask 围栏都没有（`truncated` 也为空 → 正常收尾），即**模型压根没输出这个块**；同一会话下一条 727 字的短回复正常带上了块，但把选项在正文里又用 Markdown 列表抄了一遍。ask 协议的代码链路（提示词注入 → `extractAsks` 剥离 → SSE 下发 → 端上 `ask-card` 渲染）逐环核查完好，不是链路故障。

**根因分两层**。①「回复越长、越容易丢块」是长期存在的模型遵从性问题：近 14 天「结尾提问的回复」带 asks 比例与平均长度明显负相关（1076 字 → 74%，3168 字 → 29%），规律贯穿本次部署前后。② 上一次「对话撞输出上限改为自动续写」（94f6ae6）把 `chatMaxTokens` 从写死 8000（thinking 与正文共用总闸）改成正文净额 + 思考预算叠加，线上 `thinkingMode=adaptive` 下即 8000+7000=15000。改动前 adaptive 的 thinking 会吃掉大半预算，长回复物理上写不出来；改好之后长回复第一次能正常产出，于是把①这个既有缺陷从「被截断掩盖」变成了天天可见。另外 `adaptive`/`enabled` 都被 Anthropic 强制 `temperature: 1`，格式约定的稳定性本就更差。

**改动**：
- `ASK_OPTIONS_DIRECTIVE` 从 `buildSystemParts` 的 stable 段（业务守则之后）移出，与 `CHAT_STYLE_GUIDE` 合成新的 `CHAT_TAIL_DIRECTIVE`，由对话路径拼在系统提示词**最末尾**（dynamic 段之后）。原先它前面还压着体例约束和整个 dynamic 段——线上一轮 dynamic 能有两万多 token 的参考资料/长期记忆/会话快照，指令离生成点太远。stable 段仍是独立 `cache_control` 块，缓存前缀不被打断；反而比原先「体例约束拼进 stable」更好——改体例不再废掉缓存。顺带收益：成果/工具路径不再收到对话专用的 ask 协议。
- 体例约束里「严禁输出 `[{"type":...}]` 形式的结构化 JSON」显式豁免 ```ask 块（ask 块本身正是 `[{...}]` JSON，这条排在协议之后，等于在禁止它）；「先给纲要再问用户展开哪一部分」补上按协议附块的回指；协议本身按线上两种失败形态各加一条（长回复复查、不要在正文重复列选项）。
- `claudeAdaptive` / `openaiAdaptive` 此前只拼 hint、**完全没有**体例约束与 ask 协议，一并补上 tail。
- 新增服务端兜底：`recoverAsks` 在「正文尾部像在提问 + `asks` 为空」时走 `completeJson`（辅助路径、已关思考、几百 token）把末尾问题抽成 asks，归一化与 `extractAsks` 共用抽出的 `normalizeAsks`。抽不出/超时/上游不可用一律静默返回原 reply——兜底失败绝不能让整轮对话失败。mock 降级路径不兜底（上游已不可用，再发一次只是白等）。触发闸门 `looksLikeAsking` 只看末 300 字，避免长回复中段的修辞性反问白烧调用。
- 新增指标 `junshi_chat_asks_recovered_total{outcome=recovered|miss}`：这是**模型对 ask 协议遵从率的反向指标**。涨说明提示词层失效了，该回去调协议措辞或考虑改 tool use；归零说明模型自己守约，兜底可以收窄触发面省钱。

**未做 / 留给后续治理**：
1. **ask 块改 tool use** 是最可靠的解法（模型对 tool schema 的遵从性远高于「在末尾追加代码块」），但 `chatCompleteStream` 要求 `!tools.length` 才走 provider 原生流式，加 tool 会把普通对话踢出流式路径、失去逐字体验。等上面那条指标能证明提示词层不够用了再做这个取舍。
2. **提示词缓存完全没命中**：本次三条 trace 的 `cachedInput` 全是 0，单轮 input 27379 / 29008 token 全价买。与 ask 无关，但是笔实钱，需单独查（端点亲和是否生效、stable 段是否真稳定、第三方网关是否透传 `cache_control`）。
3. **adaptive thinking 下的延迟离超时线不远**：本次实测单轮 94s / 96s，其中一条 96 秒、4057 output token 的请求走了 `clientGone`（退预留、不落库），用户白等且拿不到内容。流超时 150s、客户端 180s 的余量需要复核。

测试：server 1253 例全绿（新增 3 例：`normalizeAsks` 与 `extractAsks` 同口径、`looksLikeAsking` 只看尾部、`CHAT_TAIL_DIRECTIVE` 装配顺序回归闸）。

### 2026-08-02 · 微信官方自动续费完整接入并保留单次购买 · 影响面：app + server + admin + shared + Prisma + tests + deployment docs

方案购买确认页新增用户主动二选一：「单次购买」只买当前周期、到期后手动续费；「自动续费」使用微信支付委托代扣支付中签约，默认从不勾选。当前方案卡展示签约确认/已开启/关闭中状态和下一续费时间，并允许随时关闭；全局权限、APIv2 Key、回调或套餐模板任一未配置时自动隐藏该选项，现有单次购买不受影响。运营后台逐套餐配置是否开放及模板 ID，并显示“可用/待配置”；用户用量下钻可见真实订阅状态。

后端新增 `SubscriptionContract`，扩展 `PaymentOrder` 区分签约首单与周期扣款；接入官方 `/pay/contractorder`、`/pay/pappayapply`、`/papay/deletecontract`、`/papay/querycontract`、`/pay/paporderquery` 及支付/签解约 XML 回调。APIv2 MD5/HMAC 签名、XML 实体/XXE 防护、响应验签，以及按各回调实际字段执行的 mchid/openid/模板/协议号/金额一致性校验和既有权益锁共同 fail-closed；签约回调不错误强求官方未下发的 appid，18 位请求序列号严格落在 int64 范围内，重复 ADD/DELETE/到账通知均幂等。签约回调迟到或丢失时，scheduler 用正式开放的“查询签约关系”补激活；未付款保留 2 小时支付窗口，已付款待签约保留 6 小时回调/查关系窗口，不再 30 分钟误判失败。签约首单复用既校验订单状态与安全窗口，也逐项核对同一购买意图的套餐、金额、报价指纹和条款哈希；只有完全相同的可支付重试才复用原 `prepay_id`，终态、过期或载荷变化均 409，同意图并发也只允许一个请求外呼微信。scheduler 在权益到期前 24 小时申请续费，单周期最多两次；普通明确失败才延后再试，`SYSTEMERROR`、网络超时、响应验签/解析失败等“可能已受理”结果一律保留原单等待查单，绝不直接换单造成双扣。用户关闭续费时立即清空下一扣款时间；远端解约结果不确定则保持 `cancel_pending` 停扣并由 scheduler 重试，不恢复 active。代扣订单主动查单只作获权后的补偿链路，未开放灰度权限时仍以官方异步回调为主。用户只付款未签约、手动换档、改价、退款、远端协议已不存在及待解约协议均有明确收口，后台改价不会沿旧授权静默扣新价。新增 V2 XML/签名篡改、配置降级、自动续费下单/并发幂等、签约身份不一致、签约关系主动补偿、主动解约、签约/支付重复回调、失败通知、未知结果不换单与系统错误防双扣集成测试及部署配置清单；端上新增默认单次购买与不可用时强制回落单次的回归。

### 2026-08-02 · 方案购买与月度权益全链路重构：稳定档位、账本报价、支付幂等、退款状态机与不透明额度 · 影响面：app + server + admin + shared + Prisma + tests + deployment docs

小程序新增独立「方案与权益」页，当前方案固定置顶，只展示用量等级、服务端百分比状态、恢复日、有效期与手动购买口径；升级、续期、转年付、降档提醒、企业顾问、待支付继续和到账处理中均由 `GET /plans/options` 的服务端 relation/action 驱动，不再按名称或价格猜测，也不渲染 Token、精确咨询次数、点数/月或顾问数量。确认购买先取账本报价，显示原价、剩余价值抵扣、实付与新有效期；同一购买意图复用 `clientRequestId`，报价变化返回 `QUOTE_CHANGED`。订单页展示真实继续支付截止时间和退款中间态，支付文案按业务限制、取消、创建失败、支付失败、到账中分流；方案页新增到期提示、基于公开用量状态的轻量推荐和分阶段漏斗审计。

后端新增 `planFamilyKey/tierRank/usageLevel/usageLabel`、`PlanEntitlement/MonthlyCreditGrant/TokenQuotaAdjustment` 与订单报价/退款字段：商业档位与公开用量表达彻底分离，月付/年付同档月度权益后台原子同步；升级折抵优先按真实来源权益账本计算，退款只撤对应成功退款的来源。订单回调增加用户级权益锁，不同订单并发到账正确累计；同 intent 并发的唯一键竞态与关旧单误关自身均已收口。续期和同档转年不再刷满当月钱包，年付钻石按激活锚点逐月幂等补发。退款申请保留 PROCESSING/CLOSED/ABNORMAL，只有 SUCCESS 全额退款才写终态并回收权益，定时任务主动查退款补偿。回调验签改为 fail-closed，支持平台证书轮换、匹配序列号的静态证书和微信支付公钥，强校验五分钟时间窗及交易必填字段；所有微信 HTTP 请求统一 5 秒超时，production 发现任一免支付开关即拒绝启动。

运营后台套餐表单可配置 family、档位、公开用量名与状态阈值，并校验 standard/5x/20x 真实倍率；用户额度处置改为带原因、可选失效时间的临时增减和保留已用量的恢复标准。新增 `db:backfill-plan-commercial` dry-run/apply 脚本与测试矩阵，存量原始额度字段仅为旧版小程序兼容保留，新版客户端不读取。完整实施方案与验收映射见 `docs/SUBSCRIPTION_PURCHASE_UX_PLAN.md`、`docs/SUBSCRIPTION_PURCHASE_TEST_MATRIX.md`。

额度并发边界同步收口：跨激活锚点月度周期的惰性重置与预扣共用 `quota:<userId>` 事务锁，另一请求已重置后不再二次刷满。运营改档的损失保护继续返回 `daysLost`，不因新的用户权益事务锁而丢失既有提示契约。

预发支付隔离同步改为部署脚本硬保证：`scripts/deploy-preprod.sh` 每次都删除全部 `WECHAT_PAY_*` 真商户凭据，强制 `NODE_ENV=development` + `PAY_MOCK_SUCCESS=true`，同时关闭 `PAY_SANDBOX/ALLOW_DEMO_PURCHASE`，并在重启前 fail-closed 检查。这仅影响预发：可验真实订单、回调入账与权益状态机，不触发微信真扣款，不修改生产服务或生产库。
预发首次 dry-run 还抓到回填脚本误用不存在的 `Plan.createdAt` 排序；已改用 `sort + id` 稳定排序，保证 dry-run/apply 在真实 Prisma schema 上可执行且输出一致。

### 2026-08-02 · 后端 GitHub Actions 对齐 Node 24，消除 Node 20 异步测试误取消 · 影响面：CI（`server-integration.yml`）+ 工程测试基线（`AGENTS.md`）

`Server Integration` 的 build、Prisma schema sync 与业务断言均已通过，但 Node 20.20.2 的 `node:test` 会在 gateway provider 的 500 分支和 LLM 队列计时分支仍有待决 Promise 时提前结束事件循环，使 19 条测试被标记 `cancelledByParent`、job 以 exit 1 结束。这不是产品逻辑回归：同一组 28 条针对性用例在 Node 24.13.0 全部通过（0 cancelled）。后端 workflow 现使用与前端 CI 一致的 Node 24；禁止后续因“后端原先是 20”而降回该不稳定组合。

### 2026-08-01 · 资料预览统一为纯内容视图，修复溢出与 HTML 源码直出 · 影响面：app（智库资料确认页）+ server（文档解析/资料整理预览）+ 回归测试

确认前预览统一为纯内容文本，不再按原始文件的样式渲染：PDF、Word、Excel、CSV、TXT 使用其提取文本；Markdown 去掉标题/加粗/链接/列表等标记；HTML/HTM 文件去掉 doctype、标签、样式和脚本，仅保留标题与正文，并纳入可上传格式。服务端在入库时完成归一化，客户端对历史响应重复兜底，预览区使用原生纯文本而非 Markdown 渲染。预览滚动区按父卡片计算宽度、长链接/代码自动断行，最大展开高度从 300px 收紧到 220px；公共 Markdown 正文、列表、表格和代码块也补上同一断行保护。不再出现预览框越过卡片右边缘、长内容挤压确认操作的问题。新增前后端回归测试覆盖 HTML、Markdown 清理与预览长度边界。无接口或数据契约变更。

### 2026-08-01 · 修复默认不送套餐后新账号首判被商业化禁写闸误杀 · 影响面：server 门禁 + 新用户入局 + 首判回归测试 + docs

`/quickscan` 本身已有 `grace:'quickscan'` 每日 1 次获客保底，但全局 `PLAN_WRITE_GATE` 会在路由执行前把无套餐用户拦成 `PLAN_REQUIRED`；同一门禁还会让「立案卷」的 `PUT /profile` 先于首判失败。现仅对 `state=none` 精确放行新用户入局所需的身份/本命色/头像/建档路由及 `POST /quickscan`，其他业务写能力仍锁定。无套餐首判仍只保底 1 次/日，第 2 次返回 402，已过期账号仍返回 `PLAN_EXPIRED`。新增真实无套餐账号集成回归，锁定「建档 + 1 次首判可用、第 2 次与其他写能力仍受限」。无 API 或数据库契约变更。

### 2026-08-01 · 小程序全站文案终稿本地落地：军师人格、操作词与状态词统一，补安全的文案镜像和后台窄字段编辑链路 · 影响面：app + server + admin + shared + docs

按 `docs/文案优化终稿.md` 完成仓库侧落地：14 位军师的 `greet/memText/learnText`、默认回复模板、战局/执行/智库/我的/对话/资料/套餐等页面文案统一改为更自然的中文；用户动作收敛为「就按这个来」，状态与描述收敛为「定了」，生成态统一为「容我想想…」，并补齐 onboarding、上传进度、提醒和无障碍文案等全量检索漏项。`PRODUCT.md` 与 `AGENTS.md` 同步更新产品口径。

新增 `server/scripts/syncAppCopy.ts`（`npm run copy:sync` / `--check`），只从服务端源同步 app 镜像中的 `greet/memText/learnText` 与 `REPLIES['默认']`，明确不触碰 `enabled/owned/billing/price/deliverableKey` 和 `DELIVERABLES` 全表；新增回归测试锁定幂等性与行为字段不变。`AgentDetail/AdminAgentUpdate` 补齐 `memText/learnText`，后台智能体详情可编辑三项公开文案并采用 dirty-field PATCH，只发送实际改动字段；后端继续做权限、审计与 `draftDirty` 重算，发布前不会夹带未编辑的 prompt、模型、权益或运行参数。

生产仅做只读前置检查：14 位 agent 当前均无脏草稿，4 位下架状态未变；`general/poster` 已有发布版本，其余首次发布项以开工前干净草稿快照作为完整字段基线。未执行生产写入、智能体发布或小程序上传，标题继续保留「终稿候选」，待四类环境和真机验收后再转终稿方案。

全量回归同时暴露并修正两处过期夹具：`gatewayProvider.test.ts` 的新注册用户没有 Profile，过去只因测试运行日早于首次入局上线日而偶然绕过补档案流程；上线日过去后，10 条 provider 用例里 9 条被首次入局提前接管。绕过入局后又发现该测试仍只改 `Agent` 草稿，而当前 C 端运行时读取已发布 `AgentVersion`，因此仍走旧快照。现由测试显式创建已入局 Profile、发布测试端点配置，并在结束时发布恢复配置，确保它只验证 Gateway，不再随日历日期或历史版本数据变红。

验证：文案镜像 `--check` 通过；server/admin TypeScript 构建通过，admin `lint:ui` 通过；weapp server 包与 H5 server 包编译通过（H5 仅保留既有 bundle 体积告警）；app 36 项、admin 38 项、server 1188 项测试全绿。

### 2026-08-01 · 定价真相源迁到运营后台：删掉两个会打回线上价的脚本 + 套餐后台可建可删 + 计价字段列为「运营所有」 · 影响面：server（删 `scripts/{syncPlans,bumpFreeQuota}.ts`、`scripts/syncAdminContent.ts`、`prisma/seed.ts`、`src/routes/admin.ts`、`src/data/seedConfig.ts`、`package.json` + 新增 `test/pricingOperatorOwned.test.ts`）+ admin（`api.ts` / `views/catalog.tsx`）+ shared（`contracts.d.ts`）+ docs（`AGENTS.md`）

**起因是一个 dry-run**：生产入门版实价是运营在后台改的 ¥99/月，而 `seedConfig.PLANS` 里写着 6800，`scripts/syncPlans.ts` 按 name 做全字段 upsert —— dry-run 打印「更新 入门版」，也就是说**任何一次全量同步都会把线上价静默打回 ¥68**（30% 的价，全站在售）。这不是新发现：`docs/[FABLE5]PRELAUNCH_AUDIT_2026-07-22.md` 第 64 行早就写过「`db:sync-plans` 会把 seedConfig 覆盖回 DB（运营在 admin 改价后跑它=回退），固化『价格真相源』流程」——当时只记了风险，没定流程，十天后就踩上了。

**这次定的流程：线上定价的真相源是运营后台，代码只有夹具。** 不是「把 6800 改成 9900」——那只是把同一个陷阱重设一遍，下次运营再改价还是会被打回。

**① 删掉两个能改真实数据的脚本。** `syncPlans.ts` 连 `db:sync-plans` 一起删除。顺带查出同类第二个：`bumpFreeQuota.ts` 写死 `PLANS[0]`，而 2026-07-28 砍掉免费体验档后 `PLANS[0]` 已经变成**付费入门版**——这个脚本现在跑一次就把付费用户的 token 钱包 `quota/balance` 重置成夹具值（40 万），一并删除。`seedConfig.PLANS` 改名 `DEV_PLANS` 并在文件头写清「本地/测试夹具，改它不影响线上、也别指望能改线上」——改名是刻意的，`PLANS` 这个名字被当成过生产真相源。

**② 套餐后台补齐 CRUD，否则「后台配置」是句空话。** 原先 admin 只有 `GET` + `PATCH`，且 PATCH 白名单里连 `period`/`hidden`/`sort` 都没有——年付档和隐藏档**只能靠脚本建**。脚本删了不补 CRUD，全新部署会起来一个套餐都没有，而无套餐用户被 `planGate` 全局禁写 → 付费转化路径直接断。新增 `POST /admin/plans`（requireSuper + 审计；同名 409 `PLAN_NAME_EXISTS`——同名会让 `TEST_DEFAULT_PLAN_NAME` 这类「按 name 找档」的存量逻辑撞车；`price=-1` 面议档放行，其余负数 400；`period` 只认 month/year，野值回落 month 而不是写进库，它参与到期日推算与升级折算；`sort` 缺省排末尾，不抢第一档位置）、`DELETE /admin/plans/:id`（**有用户在册一律 409 `PLAN_IN_USE`**，文案带确切在册人数并指路「改 hidden 停售」——引用计数守卫从被删的脚本里搬过来，Plan 被 `user.planId` 引用且在册用户的续费/折算都要回读该档）。PATCH 补 `period`/`hidden`/`sort`，审计的 before/after 快照跟着补这三个字段。运营端「商品 · 套餐」页补新建表单、删除确认弹窗、周期下拉、主推/隐藏开关与排序。

**③ 同一缺陷在 `admin:sync-content` 里还有两处。** 它的 update 分支无条件回写 `sku.priceFen` 和 `agent.price`，而这两个字段都在运营后台的 PATCH 白名单里（`AdminAgentUpdate` / `PATCH /admin/skus/:key`）——运营调完价，下一次同步照样打回。改为沿用本文件已有的 `OPERATOR_OWNED`（提示词）约定：计价字段 **create 写初值、update 默认不碰**，`--force-pricing` 才回写。agent 侧 `gift/billing/price/billingRatio/meterUnit`、sku 侧 `name/desc/priceFen/sort` 归运营；`kind`/`grantsModuleKey`/`metaJson` 仍是仓库真相源（必须与 `data/modules.ts` 的 moduleKey 对齐，漂移会让支付后发不出权益）。

**④ `db:seed` 加生产护栏。** 它对套餐/智能体/格言/问卷都是 `deleteMany` + 重建，此前只靠「别在生产跑」的口头约定。现在 `assertNotProduction()`：`NODE_ENV=production` 一律拒绝（`--i-know` 也救不回来），`DATABASE_URL` 的 host 不是回环地址则拒绝（连远程测试库的正当场景才加 `--i-know`）。同时给 seed 加 `isDirectRun` 守卫——`import` 它取护栏函数做回归时不能顺手把库 seed 一遍（写这条测试时就踩到了）。

**未改（明示取舍）**：`DEV_PLANS` 里入门版仍是 6800。它现在只喂本地 seed 和 `test/helpers.ts`，而 `wechatPayMockFlow`/`planExpiry` 的折算金额断言都钉在这个形状上（¥68→¥198 抵 ¥34 实付 ¥164）；把夹具改成 9900 只会为了「看起来和线上一致」去动一批与线上无关的断言，而线上价本来就不该从这里读。**代价说清楚**：`GET /admin/plans` 才是线上现价的唯一答案，本地起的库价格与线上不同是预期行为。另外没给套餐做「改价前后影响面预演」（改价不影响已购用户的锚点，续费才按新价）——现有审计已能回答「谁把价从多少改成多少」，预演等有真实客诉再说。

**测试**：新增 `test/pricingOperatorOwned.test.ts` 20 例——建档 201 + 落库 + 审计、operator 越权 403 且套餐不动、缺名 400 / 同名 409 / 负价 400、面议档可建、非法 period 回落、sort 排末尾、PATCH 三个新字段 + 审计 before/after、DELETE 无人在册可删并留痕 / 有人在册 409 且库不动 / 迁走后可删 / 404 / 越权 403、seed 护栏四个方向、sync-content 默认不动 sku priceFen 与 agent price、结构性字段照常同步、`--force-pricing` 才覆盖、`--dry-run` 连 force 都不落库、计价字段清单完整性（漏一个就等于留一条静默打回的路）。另有两例钉死「syncPlans.ts / bumpFreeQuota.ts 与对应 npm script 不得复活」「`PLANS` 这个导出名不得回来」——这类脚本复活等于线上价随时会被打回。`npm test` **1185 全绿**、server tsc 0 错、admin `tsc -b` + `lint:ui` 0 错。

### 2026-08-01 · 文案终稿二次工程复核：收紧生产草稿、发布与离线镜像保护 · 影响面：docs（`文案优化终稿.md`）

纠正初稿中会误导实施的执行路径：不再用 `--dump-prompts` 把完整提示词写进仓库，也不再建议通过全量 `admin:sync-content` 更新 `memText/learnText`；改为仓库外仅备份草稿/已发布公开文案和版本状态，先扩窄字段契约与后台编辑能力，再逐个核草稿 diff、沙盒验收并发布。同步策略收敛为只处理 `greet/memText/learnText` 与默认回复的文案字段专用同步器，避免顺手改变 mock 目录、权益与行为字段；同时补齐服务端 journey、执行页和 mock 目录遗漏的「认可」文案台账，并把 `systemPrompt` 验收从字符数升级为内容哈希。仅文档调整，不改变当前运行时文案。

### 2026-08-01 · 文案优化终稿完成工程校正：补运行时真相源、统一声音分层并收敛过度人格化表达 · 影响面：docs（`文案优化终稿.md`）

将原“可直接执行的终稿”调整为待运行时台账验收的终稿候选：明确智能体文案必须覆盖数据库 `Agent` 草稿与已发布 `AgentVersion`、服务端模板、前端自动生成离线镜像和页面 fallback，不能只改 `app/src/data`；把声音规则改为“表达者 + 场景”双维度，Toast 只报告结果，军师叙述才使用第一人称；禁词由全仓单字归零改为用户可见短语审查，保留「产出额度 / 已启用 / 专项能力」等既有产品名词；收敛「坐。」「把故事圆上」「哪块是虚的」「掰扯」等命令感、误导性或过度市井表达；新增 weapp server、weapp mock / 离线、H5 server 与生产智能体版本四类验收矩阵。仅文档调整，不改变当前运行时文案。

### 2026-07-31 · 支付/权益四处收口：同周期升级解禁 + 套餐购买补索权 + 付款人 openid 硬化 + 运营改档不烧时长 · 影响面：server（`services/{wechatPay,proration,scheduler}.ts` / `routes/{plans,sku,admin}.ts` / `scripts/pay-e2e.ts` + `test/{planExpiry,wechatPayMockFlow,payMockSuccess,adminOps}.test.ts`）+ admin（`api.ts` / `views/users.tsx`）+ app（`components/Plans/index.tsx` / `services/api.ts`）+ docs（`AGENTS.md` §6 支付段）

真机在预发实测触发的一串连锁排查。**四个 bug 里有三个属于同一类：失败无人可见。**

**① 同周期跨档升级被守卫拦死**（真机：持决策版年付点任何套餐都 409，`payment_order` 生产表 0 行 —— mock 支付一次都没被摸到，此前误判为「mock 没生效/没部署」）。根因：升级规则在**两处各写一份**——`routes/plans.ts` 写死 `curPlan.period==='month' && plan.period==='year'`，`proration.ts` 规则 5 同义重复。于是入门版¥68/月 → 决策版¥198/月这种**真升级、同为月付**被误伤，付费用户想升同周期更高档只能等到期。修法：折算触发推广到「任何真升级」= 月→年 **或** 同周期涨价；`computeUpgradeProration` 成为「是不是真升级」的**唯一判定源**，路由改读 `applies`。降级/同价横切/同套餐续费仍不折算 → 守卫继续 409（那条守卫本身是对的：降级会烧掉剩余时长且不支持退现）。反套利五条一条未松：按**老套餐自己的日单价**折未消耗天数、双重封顶 `min(新单原价, 老套餐实付)`、只抵现金不退现、credits/token 不参与。顺带：付费但无到期日的历史不限期档，409 文案不再报「还有 0 天」。

**② 套餐购买从不申请到账提醒授权**（真机：订单全 `applied`，但 `wechat_notification_log` 里 payment 记录 **0 条**、`wechat_subscription` 里**没有 payment 场景**）。根因：`components/Plans`（套餐路径）整条链路从未调用 `requestWechatSubscribe('payment')`，而 `PaySheet`（SKU/算力）有 —— 微信订阅消息是**一次授权一条配额**，没授权就没配额，服务端 `sendWechatSubscribeMessage` 查不到配额直接 return。修法：照 PaySheet 模式在本函数**首个 `await` 之前**同步索权（微信要求订阅弹窗由点击手势直接唤起，先 await 网络请求会丢手势上下文、真机上弹窗静默不出），拒绝或失败不阻断购买；免费档不索权。**并给 `notifyPaymentApplied` 加 `logSkipped: true`** —— 此前「无配额」这一跳连日志都不落，于是「到账通知从未发出」在库里**完全无痕**，这才是它上线至今无人发现的真正原因。

叠加同日修的模板字段键与生产缺配模板 ID，结论是：**军师上线至今，套餐到账通知从来没有成功发出过一条**，三层原因（生产没配模板 ID → 字段键全错 → 购买路径不索权）缺一层都发不出。

**③ 付款人 openid 可由请求体任意指定**。历史实现 `req.body.openid || user.wechatOpenId` —— 真实支付模式下 openid 决定微信向**谁**收款，绝不能由请求体指定；且已核实小程序端 `api.createOrder/createSkuOrder` 从不传 openid，body 那个入口纯属测试遗留。修法：新增 plans/sku **共用**的 `resolvePayerOpenid()`（不再两处各写一份 —— 本仓刚因此栽过一次，见①），body 值只在等于调用者自己的 openid 时采纳，否则静默忽略 + `console.warn` 留线索。mock 模式下无 openid 的账号（纯短信注册，预发 HTTP E2E 用的就是这类）合成 `mockopenid:<userId>`，且 `createJsapiOrder` 真实 JSAPI 分支加 `isMockPayerOpenid` 兜底断言，保证合成值绝不上路。

**④ 运营手动改档静默烧掉用户剩余时长**（`POST /admin/users/:id/plan` 直调 `applyPlanPurchase`，无守卫无折算；`isRenewal` 只认同套餐，改档即 `planExpiresAt = computeExpiry(now, period)`）。真实投诉形态：「客服帮我升级，结果少了 20 天」。C 端早有守卫+折算，只有运营这条是裸的。修法（保留超级权限，只是不许静默造成损失）：升级/同档 → **结转**剩余天数到新到期日（审计 `carriedDays`）；会缩短的 → 无 `force` 返回 409 `PLAN_CHANGE_SHORTENS`，文案带确切损失天数与两个套餐名、**用户套餐一点不动**，带 `force:true` 才执行并审计 `daysLost`。档位比较用 `planTier(price<0)=+∞` —— **企业版是最高档**，直接比 price 会把「企业版→入门版」判成升级（400 > -1）从而把不限期权益静默换成 1 个月。`planExpiresAt=null` 明确**不当成 0 天**。运营端 409 文案原样透出 + 「确认强制改档」二次确认（换选套餐会清掉该确认，否则强制会打到别的套餐上）。

**顺带修两处「不核实的计数器」**（与②同源的观测盲区）：`scanDueProphecies` 的 `pushed` 统计的是「尝试过的用户数」且 `.catch()` 吞掉了结果、`r.sent` 根本没读 —— 无配额/微信拒收时日志照样宣称「pushed N」；改为只把真送达的计入。`scripts/pay-e2e.ts` 硬编码 `tokenQuota.limit === 1_000_000` 在 2026-07-28 定价改版后恒失败（脚本取的第一个付费月付套餐已是入门版 400k），坏断言会长期掩盖真问题；改为从它实际选中的套餐派生（另两处硬编码同样派生化），`pay:e2e` 回到 **22/22**。

**未改（明示取舍）**：升级按新套餐**足额**发 credits、`setQuota` 硬覆盖 token 额度 —— 「买入门版¥68 → 当天升决策版月付」现金侧密不透风（合计 ¥198 = 直接买的原价），但用量侧多拿 20 点 + 400k token（≈¥69 成本/客）。该形状在**已上线的月→年路径上完全相同**，非本次引入；且不可循环（升完想再来一次须先降级，降级被 409 拦住），最长链条 入门版→决策版月付→决策版年付 即终止。按差额发点数会让「升级后当月可用量少于直接购买同档」，客诉成本大于收益，故保留原口径；月付档位增多、链条变长时再收口。

**测试**：`payMockSuccess` +5、`adminOps` +8、`planExpiry` +4、`wechatPayMockFlow` +1；覆盖伪造/他人 openid 不被采纳（纯函数 + 端到端 + stub fetch 抓包断言「发往微信的 payer.openid 必是账号自己的」）、mock 无 openid 账号可下单到账、真凭据配齐时仍 `OPENID_REQUIRED`、升级结转 20 天、降级无 force 409 且套餐未动、降级带 force 审计 `daysLost`、不限期两个方向、同套餐续费不双算、同周期折算金额 `19800-round(6800/30*15)=16400`、31 天月封顶 `remainingValue<=old.price`、月→年既有金额回归未变。`npm test` **1153 全绿**、tsc 0 错、`pay:e2e` 22/22、`pay:e2e:mock` 19/19、app tsc 0 错、admin `lint:ui` + `tsc -b` 0 错。

**⚠️ 同机并行跑全量测试会互相打断**：多个会话共用 `junshi_test` 库，彼此的 `seedBaseline()` / `plan.deleteMany()` 会打断对方 `login()` 的 `app_user_planId_fkey`（症状是随机文件随机失败、两轮失败集合完全不同，且单跑全绿）。验收请错开，或给每个会话一个独立测试库（`createdb junshi_test_iso && prisma db push && DATABASE_URL=… npm test`）。

### 2026-07-30 · 测试期 mock 支付（`PAY_MOCK_SUCCESS`）：没有商户凭据也把**真实支付管线整条跑通** · 影响面：server（`services/wechatPay.ts` / `services/sandbox.ts` 注释 / `services/metrics.ts` / `routes/{pay,plans,sku,admin}.ts` + 新增 `test/payMockSuccess.test.ts`）+ shared（下单/订单契约加 `mock` 标记 + `PayMockPayResult`）+ admin（`views/revenue.tsx` mock 徽章与营收口径）+ app（`services/pay.ts` 统一 `payOrder` + 4 个支付触点 + PaySheet/Plans/credits/thinktank）+ docs（`AGENTS.md` §6 支付段、`DEPLOYMENT.md` §5、`.env.example`）

**动因**：生产一直没有微信支付商户凭据，回落路径 `/plans/:id/purchase`（演示发放）**整条绕过支付管线**——不建 PaymentOrder、不走 `markPaidAndApply`、不发到账通知。结果是订单状态机、幂等锁、条款快照、权益发放、到账订阅消息这一大片代码**在真实环境里从未被执行过**（同日刚修的 payment 模板字段键就是例证：错了半个月无人发现，因为那条路根本没跑过）。

**做法**：新开关 `PAY_MOCK_SUCCESS=true`，与演示发放正好相反——**只把「调微信」那两步换成本地模拟，其余全走真实代码**。下单仍走既有 `createJsapiOrder`（条款快照 `snapshotJson`、金额、归因 `parseAttribution`、下单频控、关同类旧单一个不跳），只是不请求微信 JSAPI、`pay` 返回占位值并带 `mock:true`；到账由新端点 `POST /pay/mock/pay` 触发**真实的** `markPaidAndApply`（advisory lock + `appliedAt` 终态锚点 + `ActivationEvent` + 到账订阅消息），`source='wechat_pay_mock'`。

**「将来零改动替换」写进了开关本身**：`payMockSuccessEnabled() = PAY_MOCK_SUCCESS==='true' && !payConfigured()`——真凭据一配齐 mock 自动让位，不需要记得去删 env，也不存在「配了真支付却还能白拿套餐」的窗口。函数放在 `wechatPay.ts` 而非 `sandbox.ts`：`payConfigured` 住在前者，放后者会成环（`wechatPay → sandbox → wechatPay`），`sandbox.ts` 头部留指路注释 + 四套「白拿通道」对照表（① 本地 mock 微信网关 ② `PAY_SANDBOX` 仿真回调 ③ `demoPurchase` 演示发放 ④ 本次）。

**三道闸**（`/pay/mock/pay`）：开关（含真凭据让位，在任何库查询之前）→ 订单归属（他人单 404，与 `/pay/orders/:no` 同口径不区分「不存在/不是你的」）→ **只认 mock 单**（真实微信单一律 409 `ORDER_NOT_MOCK`，绝不能被这条端点「模拟」成已付款）。金额自校验复用真实回调那段防串单逻辑。每笔落审计 `pay.mock.paid`（单号/金额/套餐或 SKU）。

**mock 单不污染真实链路**（逐处处理）：标记锚在**下单时写死的** `snapshotJson.mock=true` + `provider='mock'` + `transactionId=mock<纯数字>`（`isMockOrder` 优先读快照 flag，故关掉开关乃至配齐真凭据后历史单仍可正确识别）。① 对账 sweep 与 `reconcileOrder` 跳过且**不标 failed**；② 关陈旧单走本地置 closed，不调微信（测试用 fetch 桩断言全程零出站）；③ 退款跳过微信接口但**本地权益回收照常**（套餐立即到期 + 追回未消耗算力 + 停模块），`wechatStatus='MOCK'`；④ **营收不含 mock**——`notePayApplied`/`notePayRefund` 对 mock 单不计，改计 `junshi_pay_mock_total`；`/admin/payments` 的 `paidAmount`/`paidCount`/`byDay` 与卡单 gauge 全部加 `provider='wechat'` 过滤（否则 mock created 单永不被 sweep 关单 → 只涨不落的假告警）。订单列表/CSV 仍可见并显式标「模拟单」，运营端退款弹窗改口径为「撤销模拟支付并回收权益」。

`transactionId` 形状是 `mock` + 13 位时间戳 + 6 位随机数字，正则 `^mock\d+$` 收得很紧——本地 mock 微信网关给**真实路径**订单发的是 `mocktx_*`，用 `startsWith('mock')` 会把真单误判成模拟单从而跳过真退款（实测在 `wechatPayMockFlow` 退款用例上踩到）。数字为主也是为了到账模板 `number6` 位（微信 number 类型只认纯数字，发送侧抽数字后仍能对回订单）。

**小程序端**：新增统一 `services/pay.ts › payOrder({outTradeNo, pay, mock})`，4 个支付触点各改一行；mock 时跳过 `wx.requestPayment` 直接调 mock 端点，复用既有 `awaitPaymentApplied` 轮询。到账提示明确写「模拟支付已到账（测试期，未实际付款）」——**不伪装成真实支付成功**，避免用户以为自己付了钱。

**顺手修注释**：`demoPurchaseEnabled()` 原注释称「生产恒 false」，但代码只判 `NODE_ENV==='test' || ALLOW_DEMO_PURCHASE==='true'`，并不排除 production。按「不收紧只改注释」处理（收紧会打断在用的演示环境），写清真实语义与生产真正的防线。

⚠️ **启用即任何登录用户可自助领取任意付费套餐/SKU**，仅测试期使用；测试期收口时移除该 env，`snapshotJson.mock` 标记可用于把测试期订单从账目里干净摘出。已知限制：下单仍要求 openid（纯短信注册账号测不了，改动点是路由的 `OPENID_REQUIRED`）、H5 仍被 `ensurePayableEnv()` 拦在下单前（「继续支付」路径已按 `o.mock` 放行）。

**测试**：新增 `payMockSuccessEnabled` 全链路 16 例（下单→模拟付款→权益/到期日/算力真落地 + 到账订阅消息真发；重复付款只发一次；**`payConfigured()` 为真时一律拒绝**；env 未设时拒绝；他人订单 404；真实单 409；sweep 跳过不标 failed；关单/退款零出站 + 权益被回收）。server `npm test` **1080 例全绿**、tsc 0 错；app tsc 0 错 + 33 例绿；admin `lint:ui` + `tsc -b` 0 错。

### 2026-07-30 · 老板页年度谶语并入账户服务卡（去掉夹在档案组里的独立白卡）· 影响面：app（`pages/profile/index.tsx` / `index.scss`）+ docs（CHANGELOG、RETENTION_MECHANISMS #16）

用户反馈：「谶语和上面个人信息栏能不能整合到一起，这块空间排版有点乱。」原谶语卡夹在「档案」组标题与菜单之间，上下都是卡、自成一张白面，视觉上像掉队的一块，且 19px 竖排七言独占约 290px 高度，把段位卡和菜单全顶到折叠线以下。

- **有谶态**：谶语落到深色账户服务卡尾部的**题字带**（`.verse-band`）——一条 `rgba(255,255,255,.16)` 发丝线收口，带子与卡内各行同宽同边距。头行左「年 度 谶 语」右「丙午年 · 军师赠」，中间一句一行居中排成一副对子（16px 宋体，烫金沿用卡内既有的 `#F4D99E`，与 member-pill / 邀请码同色，不新造颜色；`letter-spacing` 末尾多出的一个字宽用等量 `padding-left` 补回中线），末行点谶足迹「已点谶 N 次 · 最近：…」，无点谶记录时落「岁末逐句对账」。原竖排改横排：竖排七言在卡内要占 160px+ 且只能靠边栏摆，会让权益格/服务格/落款各自一个右边界。
- **无谶态**：同一条带子里一行「年度谶语 · 你还没有今年的谶 / 去命盘领一句 ›」，不另起虚线盒子（卡内已有两排盒子，第三个盒子只会更碎）。
- **一卡一套对齐**（第一版侧栏方案的返工原因）：先试过把竖排谶语挂在资料区右侧分栏，实测卡内出现两套右边界——权益格停在竖线、服务动作却通到卡边，落款又悬在左侧空档上，「不对齐 / 有的挤有的空」。改成全宽题字带后卡内只剩一套左右边界。
- **净效果**：我的页首屏少一张卡、约省 190px；战略段位卡与「档案」菜单组回到首屏可见。命理开关关闭时整块不渲染（gating 不变），谶语数据链路与文案口径未动；`verseColumns` 随之更名 `verseLines`（一句一行，仍最多 4 行、>8 字按 7 字再断）。

### 2026-07-30 · 年度谶语升级为「周期陪伴」（点谶/半验/岁验锚点/换谶归档）+ 预言到期订阅消息推送（#1 补上缺失的推送半截）+ **修订阅消息模板字段键（review/payment 两个模板全错，推送全线静默失效）** · 影响面：server（`services/strategicProfile.ts` / `services/scheduler.ts` / `services/wechatSubscribe.ts` / `services/reminders.ts` / `services/reviewLog.ts` / `services/prophecyLog.ts` / `routes/casefiles.ts` / `data/prompts/strat.v6.md` §4.4 + 新增 `test/verseCompanion.test.ts`、`test/prophecyLog.test.ts` 与 `test/wechatMessage.test.ts` 追加）+ shared（`contracts.d.ts` 加 `VerseMoment`/`verseAt`/`verseMoments`，并从可写 Patch 集合 Omit）+ app（老板页谶语卡点谶足迹 + mock）+ docs（AGENTS §services、RETENTION_MECHANISMS #1/#16）

**谶语从「挂一年的一句话」升级为「军师全年主动把真实事件对到谶上的一条线」**（产品意图：贯穿周期的陪伴，军师睿智的体现）：

- **点谶**：`maybeMarkVerseMoment` 在 认可方案（`/casefile/accept`）、复盘落账（`recordReview`——`/casefile/review` 与聊天复盘意图两条路都汇到这）、预言应验（`verifyProphecy` hit 分支）三处 fire-safe 触发；LLM 严判「这件真事与谶中某半句**真切相应**」（含糊/牵强/气氛相近一律不算——点谶的分量全在真切，不能把谶语做成星座运势），命中才落 `extraJson.verseMoments[]`（`{at, clause:1|2, note≤40字}`，年上限 12、同日同来源去重）。全部短路条件（无当年谶/命理关/已满/当日已点/空复盘）都在调模型之前判完；判定期间档案可能被并发写过 → 落库前重读复查守卫，防整块 extraJson 回压。测试注入确定性判官（`judge?` 参数），生产走 `llmJson`。
- **注入块周期上下文**：谶语行升级为「N月获谶 + 已点谶 K 次 + 最近一次（M月：note）」+ 点谶行为指引（引原句半联+一句白话，一次对话至多一次，对不上不硬圆、平时不提）；获谶满 6 个整月且后半句尚无点谶时追加**半验**提示（复盘带出「谶语过半，前半句已有眉目」）。跨年未换谶时只报句子——去年的点谶不当今年的账。增量约 120 字。
- **岁验锚点**：谶语盖章/换句成功即幂等登记一条岁验预言——`ProphecyLog` 无 kind 列，用 `basis='年度谶语·岁验·<谶年>'` 约定值承载，`(userId, basis)` 兼作幂等键（同年升级只 update 文本，跨年才新建）；到期 = min(获谶+1年, 次年 2-04 立春)。到期后自动骑 `prophecy-due-scan`。
- **换谶归档 `verseHistory[]`**：任何真正换句/换谶年的写入都先把旧谶连同它的点谶推进归档（上限 10）——岁验对的是「去年那句」，跨年 auto 兜底谶一落库旧谶就没了，不归档等于把去年的账烧掉。manual 复写原句（老板点保存）不算换谶：不清点谶、不重记 `verseAt`。存量谶下次盖章补记 `verseAt`。
- **prompt**：`strat.v6.md` §4.4 补封面 motto 落位铁律（A 级/交底报告封面 motto 固定写谶语本句，语录放正文）——提高认可时模型谶的捕获命中率。
- **app**：老板页谶语卡尾部一行点谶足迹（已点谶 N 次 · 最近一句白话；无 moments 不渲染）。

**预言到期推送（#1 的缺失半截）**：`scanDueProphecies` 此前只记审计 + 标 `dueNotifiedAt`，用户手机上毫无动静——全体系最强回访事件（预言到期）静默漏掉。补上订阅消息推送：借 review 场景模板（与 reminders.ts 同口径，不新增 scene），同轮同用户至多一条（多条同日到期只打扰一次），岁验预言（basis 前缀识别）用专属措辞「岁验之日·一年前那句话」+ 谶语整句作备注（恰 15 字 ≤ 模板 20 字上限）；best-effort——推送失败/无额度不阻断 `dueNotifiedAt` 锚点，对账候选照常进复盘。公众号模板消息方案经决策**不做**，只走小程序订阅消息。

**同日修复：三个订阅消息模板里两个的字段键全错，对应推送在生产恒 47003 拒发（用户一条也没收到过）。** 对着微信后台三个模板的「详细内容」逐字核对后发现：

- **review（26922「最新分析报告提醒」）曾全错**：模板要 `thing2`(报告类型)/`thing3`(报告名称)/`thing5`(备注)/`time6`(生成时间)，代码发的是 `thing1`/`time2`/`thing3` → 早间军令、每日复盘、周复盘、久不复盘召回、以及本次新接的预言到期/岁验推送**全部静默失效**。已改为真实键，并补一个「报告类型」位（新增 `category` 参数：复盘提醒/军令提醒/周复盘/预言对账/岁验），否则该位只能重复标题。
- **payment（29967「套餐购买成功通知」）曾全错且缺位**：模板要 `thing1`(类型)/`amount2`(金额)/`thing3`(用户)/`time5`(时间)/`number6`(订单号)，代码发的 `phrase2`/`time3`/`thing4` 三个键**模板里根本不存在**，还缺金额/用户/订单号三个位 → 支付到账通知同样恒 47003（用户付了钱收不到确认，会以为没买成）。已补全：金额走 `amount2` 金额型（`¥6888.00`，币种符号 + 两位小数）、用户位取账户昵称（发送侧本来就要查用户，顺带取 `name`）、订单号走 `number6` **数字型（纯数字 ≤32 位）**——我们的商户单号形如 `js{时间戳}{hex}` 带字母，发上去必被拒，故优先发微信自己的 `transactionId`（全数字，也正是用户在微信账单里看到的那个号），回调未回填时退化为商户单号抽数字。
- **report（76218「报告生成通知」）本来就是对的**：`thing1/phrase2/time3/thing4` 与历史写法恰好一致——三条里唯一一直正常的，未改。

根因是这类失败**只落 `WechatNotificationLog`、线上无人翻**，键错了看起来和"用户没授权"一模一样。`wechatMessage.test.ts` 新增一例按 scene 钉死三个模板的键集与各位语义（含带字母单号必须抽成纯数字），文档也补了「改字段键前必读」的警示——这类漂移只有断言拦得住。

**测试**：新增 `verseCompanion.test.ts` 16 例（换谶归档三条路/点谶短路与去重/注入行/omen 幂等/契约字段）+ `prophecyLog.test.ts` 追加到期推送 1 例（额度扣减/岁验措辞/同轮去重/重扫零网络）；server `npm test` **1053 例全绿**、tsc 0 错；app 33 例全绿 + tsc 0 错。

### 2026-07-30 · 报告等待上限提高到 5 分钟，调用诊断记录实际命中端点/model · 影响面：shared 诊断契约 + server（provider 超时、端点命中捕获、trace 落库）+ Prisma 纯加法字段 + admin 调用诊断 + tests + docs

生产报告失败集中暴露了两个独立问题：结构化报告虽然已经异步生成、用户可以退出后再回来，但 provider 仍沿用最低 120 秒等待，长报告会被本服务提前取消；同时 `LlmTrace.model` 过去写的是调用开始前的全局配置，端点池成功记录无法回答「最终究竟命中了哪个端点和模型」。

本次将强制结构化成果（含工具循环终结轮）的上游等待下限从 **120 秒提高到 300 秒**，OpenAI/Claude 两条协议统一复用 `deliverableTimeoutMs()`；配置本来高于 300 秒时仍尊重更高值。**普通对话的超时、转移判定和故障转移体验完全不动**，不把报告的异步容忍度扩散到即时对话。

端点追踪由 `llmPool` 在当前异步调用上下文记录每次真实尝试，gateway 在成功时写最终命中的 `provider/model/endpointId/endpointLabel`，全链路失败时写最后一次实际尝试；single 模式写当前激活模型快照，智能体自定义 OpenAI 端点标为「`<agentKey> 自定义端点`」。`LlmTrace` 新增 nullable `endpointId/endpointLabel`（纯加法），后台「调用诊断」列表与详情同时展示；老记录字段为空时保持兼容。部署需沿用既有流程先执行 `prisma db push` 再重启 API。

验证：Prisma format/generate 与本地测试库 `db push` 通过；server/admin 正式构建通过，app TypeScript 检查通过；端点命中、超时下限、trace API/自定义端点及 provider 超时定向测试 **43/43** 通过；server 全量测试 **1036/1036** 通过；admin `lint:ui` 通过。

### 2026-07-29 · 海报「AI 排版引擎」（第 3 档）：模型自己写整张海报的 HTML/CSS + 量测 refine 闭环 + 模板回落 · 影响面：shared 契约（`AdminCreativeConfig.layoutEngine`、`AdminCreativeJobItem.layoutEngine/rounds/aiEngineError`）+ server（`llm/gateway.completeText`、providers `maxTokens`、`services/reportPdf` 渲染加固、`services/creative/{canvasEngine,canvasSanitize,canvasMeasure,manifesto,renderer,worker,philosophy,config}`、`services/metrics`、`routes/admin`）+ tests（新增 `test/creativeCanvas.test.ts` 45 例 + `test/fixtures/posterBriefs.ts`）+ docs

动因是真机实测那张图很差，且**根因不在"观测缺口"而在画质本身**：给图片模型的只有一句 ≤80 字的 `visualPrompt`，palette / 构图 / 材质全没传（于是墨绿页头压一块大红照片），「留出负空间供排版」被画成了三个空的粉色占位卡片；LLM 算出的六维度视觉哲学模板只消费 `palette + movement`，设计思考全被丢掉。而上游 `canvas-design` 根本不用图片模型——**哲学长文 → 模型用代码在画布上创作 → 强制二次打磨**。本笔把那三步做成自动化等价物。

**新链路**（`layoutEngine='ai'`，**默认**）：`manifesto`（LLM，4–6 段中文宣言 + 色板 + 隐性主题）→ `canvasEngine`（LLM 直接产出 540×720 整页 HTML/CSS，纯 CSS/SVG 作画，不调图片供应商）→ 静态审计 → 占位符替换 + AI 标识兜底注入 → 渲染（`javaScriptEnabled:false` + 请求白名单）+ **量测** → **无条件打磨一轮** → 最多再修一轮。三条不变式：① HTML 相关 LLM 调用 ≤3 次（含宣言整单 ≤4），整段预算 180s；② **打磨轮不许让画面变差**（首轮干净而打磨轮量出违规 → 退回首轮那张，`polishReverted` 留痕）；③ 引擎内部失败一律**返回**而不抛（抛会被 worker 归成 INTERNAL 并退款，而那时用户本该拿到一张模板图）。

**「首轮干净也打磨一轮」是移植的核心机制，不是可选优化**（上游 FINAL STEP：*"The user ALREADY said it isn't perfect… take a second pass."*）。用「LLM 被调 2 次而不是 1 次」的断言把它钉住——这条断言在，任何「干净就直接交付」的省钱优化都会立刻红。

**回落矩阵**（付费任务永不因 AI 引擎失败）：模型不可用 / 宣言不完整或未过审 / 三轮仍违规 / 渲染异常 / 量测拿不到结果 / 超预算 → 全部回落，且**复用同一个 `runTemplatePipeline`**（图片供应商调用、`degraded/visualError` 降级留痕、弹性版面契约、溢出闸这些教训都在那条路径上，抄一份等于把它们作废一次）。回落原因落 `resultJson.aiEngineError` 并在任务台可见——`layoutEngine='template_fallback'` 的斜率就是「AI 排版在生产悄悄失效」的告警信号，新增指标 `junshi_creative_engine_total{engine=ai:Nrounds|template|template_fallback}`。

**把 LLM 写的 HTML 当不可信输入**：静态审计**只拒不洗**（洗一洗再渲染既改变构图意图又给 `<scr<script>ipt>` 这类嵌套留缝，且拒绝可回喂、清洗不可观测）；白名单口径——`<head>` 只放行 `meta charset/viewport + title + style`，图片只放行占位符与 `data:image`，`script/on*/iframe/object/embed/link/base/@import/javascript:/外链 url()` 一律整份打回。渲染层再加两道：CDP 关掉页面脚本执行（**已在真实 Chromium 上实测：内联脚本改不动 DOM，而 `page.evaluate` 照常工作**），请求拦截只放行 `data:` 与 OSS 签名域。

**量测器**（`canvasMeasure.posterScanFn`，puppeteer 页内纯 DOM 扫描）违规码：`html_rejected / overflow / out_of_bounds / margin / min_font / text_overlap / headline_missing / aimark_missing / qr_quiet_zone / placeholder_residue`，每条带 **selector + 实测数值**并逐条回喂——模糊的「有问题请改进」喂回去等于没喂。两个刻意的设计：未提供素材的占位符**不清理**（留成 `placeholder_residue` 违规，否则模型永远不知道自己引用错了）；AI 标识缺失**直接注入**而不回喂（合规是服务端义务，不能取决于模型这一轮听不听话）。

**顺带止血了模板/回落路径**：`composeVisualPrompt()` 把色板主色（转中文色彩词）与负向约束（禁文字/禁 UI 卡片占位框/禁 logo/禁边框）拼进图片提示词，`worker` 那句兜底同步加强。

**踩到并修掉的坑**：`page.evaluate` 是把函数**源码**送进浏览器执行的，`npm test` 走 tsx/esbuild（默认 `--keep-names`）会往函数体里塞 `__name(fn,"name")` helper → 浏览器里 `ReferenceError: __name is not defined`，而 `tsc` 编译的生产产物没有这层，典型的「测试炸/生产好用」错配；现在渲染前用**字符串表达式**注入恒等 `__name` shim（用箭头函数注入会被同一个转译器改写，等于用坏的工具修坏的工具）。另一处：`openaiRaw/claudeRaw` 的 `max_tokens` 硬编码 700（辅助抽取预算），一页 HTML 会被拦腰截断 → 两个 provider 加可选 `maxTokens`，**缺省仍是 700**，`completeText` 传 4000 并 `allowAux:false`（画质任务不该被切到小模型）。

**验证**：`cd server && npm run build` 0 错；`npm test` **1032/1032 通过**（新增 40 例常规 + 5 例真实渲染量测）；量测器那组默认 skip（`NODE_ENV=test` 下 `renderHtmlToPng` 返回 1×1 桩），用 `PUPPETEER_REAL=1 npm test` 跑真实 Chromium，本地 45/45 全绿。`admin npm run build`（含 `lint:ui`）通过——契约新增字段都是只读消费，未破坏编译；后台 UI 暴露 `layoutEngine` 开关与任务台 `layoutEngine/rounds` 列由 admin 那一包跟进。真图对比只能部署后在生产做（本地无模型 key），brief 形状已固化为 `test/fixtures/posterBriefs.ts`（酒店 OTA 获客场景，就是那张差图的输入）。

### 2026-07-29 · 修运营后台与用户端配置脱节：新上架智能体动态可见、技能/知识可钻取、调用来源可辨识、审计降噪 · 影响面：shared 契约 + server（智能体类型、技能元信息、知识归属、LLM trace 来源、audit 过滤）+ admin（智能体/技能库/知识库/调用诊断/审计日志）+ app（对话/执行智能体目录）+ tests

后台新增/上架的智能体不再依赖小程序写死 key：`advisory/custom` 动态进入「对话 → 专业参谋」，`creative` 进入「执行 → 内容出品」，两页 `useDidShow` 都会刷新 `/agents`；后台新增与详情面板补「用户端入口」类型选择，避免 `custom` 智能体上架后无落点。技能库内置项可点开查看中文名称、执行方式和只读参数 Schema；知识库列表补 `userId/姓名/手机号`，可按用户筛选并点开正文与切片，用户知识详情/删除/重嵌 URL 同时收紧为 `userId + itemId` 真归属校验。

调用诊断现在由 `LlmTrace` 的既有 `userId/tenantId/sessionId/agentKey` 回填用户、手机号、租户和智能体名称；界面优先显示「方案生成 / 对话回复」与顾问中文名，`general/deliverable/ip` 等原始值只留在排障标识。HTTP 审计不再记录 `/api/metrics` Prometheus 抓取，历史抓取默认过滤、需要时可点「含监控抓取」查看；分批回读避免历史 metric 把最近 100 条真实用户动作淹没。

验证：按暂存区生成干净源码快照后，server `npm run build`、admin `npm run build`（含 `lint:ui`）、app TypeScript 检查全部通过；server 定向集成 `adminVisibility.test.ts` 4/4、app `npm test` 33/33 通过。

### 2026-07-29 · 年度谶语捕获链路补齐（#16）：模型亲写的谶可入档 + 三来源优先级（auto → llm → manual）· 影响面：server（`services/strategicProfile.ts` / `services/casefile.ts` `DeliverableInput` / `routes/casefiles.ts` / `routes/battle.ts` / `routes/profile.ts` + `test/strategicProfile.test.ts`）+ docs（`AGENTS.md` §services、`docs/[FABLE5]RETENTION_MECHANISMS.md` #16、`docs/[FABLE5]RETENTION_DESIGN_SPECS.md` §5.1/5.3）

承接同日「出谶触发点 `ensureAnnualVerse`」那笔（那笔只解决「卡恒空」，谶语仍是**按盘算出来的兜底句**，不是老板那一份）。本笔补的是**捕获**：`strat.v6.md` §4.4 要求模型在 A 级报告封面写一句七言/五言谶语、§第 6 轮交底仪式当场念给老板听，但 `extractStrategicFacts()` 只认 主要矛盾/定位/赛道/阶段 四种分节标题，**既不读封面 `cover.motto` 也不读任何「谶语/箴言」分节**（`builtin.ts` 的 `withVerseCover` 只把档案里的谶补进渲染入参，是反方向），所以模型亲写的那句从来落不进 `StrategicProfile.extraJson` —— 文档（RETENTION_MECHANISMS #16 / DESIGN_SPECS §5.1）声称的「verse 捕获已在跑」对捕获侧一直不成立。

**捕获**：认可方案（`/casefile/accept`、`battle/commit`）时先认「谶语/箴言」分节，再退到封面 `cover.motto`（`DeliverableInput` 补 `cover` 字段；剥「年度谶语：」前缀与各式引号、半角逗号归一、去句末句号，与 `composeAnnualVerse` 同口径）。**形状闸门**：只收七言或五言两句、两句等长、纯汉字的句子——§4.4 明说封面上谶语与毛选语录并列，而谶语一旦收下就锁一整年，宁可漏收也不能把一句语录当成老板的谶（「一切反动派都是纸老虎」「藏锋，今岁南风助势成」这类一律不收）。抽不到就不给 `verse` 键，避免 undefined 键把库里的谶清空。

**优先级（本笔的真问题）**：兜底谶现在会在老板首访老板页时落库，原来的「一年一句」守卫（`当年已有谶 → 一律不采`）会把随后到来的、真正个人化的交底谶语一并挡死。改为按来源单向升级：`extraJson.verseSource` 记 `auto`（按盘出谶）/ `llm`（模型亲写）/ `manual`（老板手改 PUT），跨年或从未有谶直接立谶，当年已有谶时**只允许 auto → llm → manual 升级一次**，同级/降级一律不采（`forceVerse` 参数由 `verseSource` 取代）。两条护栏：① `manual` 任何时候都压得住自动路——老板的最终解释权不变；② 同一句原样回传时不改来源，免得兜底谶被一次回传镀成「模型谶」白占掉当年唯一的升级额度（认可动线传的 deliverable 来自库里未注入 motto 的原件，本不构成回环，但这条闸门不依赖那个前提）。「一年一句、不改不换」在 llm/manual 落定后仍然成立：同年再认可几份带谶的报告都不换。

**未做（仍是 M2/M3）**：显式「求谶」按钮（当前 auto 那条是读档案时隐式触发，缺仪式感）、ProphecyLog `kind:'omen'` 登记、岁验对账与应验卷、旧谶 `verseHistory[]` 留档。文档三处「捕获已在跑」的表述已按实际实现改写。

**测试**：`test/strategicProfile.test.ts` 新增 3 例（捕获与形状闸门：谶语分节/封面 motto/语录散文不收/五言也收/不留 undefined 键；优先级：auto 可被 llm 升级一次、同句回传不改来源、同年第二句 llm 不换、manual 压全场、跨年重新开局；端到端：录生辰得兜底谶 → 认可带封面谶语的交底全案即升级 → 同年再认可不换），全量 `npm test` **985 → 988** 例通过，`npm run build` 0 错。

### 2026-07-29 · 修「军师 tab 点品牌营销官进对话页整页白屏」（双层：服务端读取端自愈 + app 端渲染防御）· 影响面：server（`routes/sessions.ts` + 新增 `test/sessionReadHeal.test.ts`）+ app（`components/MarkdownText` / `components/ReportCard` / `packages/main/chat` / `services/deliverableSection.ts` + `deliverableSection.test.ts`）+ docs（`AGENTS.md` 接口表 `GET /sessions/:id`）

用户生产真机实测：军师 tab 点「品牌营销官」进对话页**整页白屏**。**不是当天海报成品图两个提交（`d2de9a8` / `c0a7e41`）的回归**——那两笔在对话页新增的代码 brand 会话一行都走不到（`posterEntryOn` 第一个条件就是 `agent?.key === 'poster'`），唯一无条件求值的新表达式 `m.deliverable.creativeJobId` 所依赖的 `m.deliverable`，在它之前早已被既有代码 `!m.deliverable.degraded`（2026-07-28 起）解引用过，没有引入任何新的抛错点。

**根因：渲染期解引用存量脏形状抛错。** 小程序渲染期抛错既无红屏也无堆栈，表现就是白屏。已在 H5 mock 里逐条复现并拿到确切堆栈，三条同形状的 throw 表达式：

- ① `ReportCard` 的 `useState(animate ? 0 : data.sections.length)`（另有 `data.sections.slice` 与 effect 依赖数组）→ 成果消息 contentJson **缺 `sections` 字段** → `Cannot read properties of undefined (reading 'length')`。讽刺的是父级 `chat/index.tsx` 判 `reportReady` 时早就写成 `sections?.length ?? 0`，子组件没跟上——于是「父级判定为已中断卡」和「子组件直接崩」同时成立。
- ② `services/deliverableSection.ts` 的 `cardSection` 把非字符串叶子原样透给 `<MarkdownText>` → `parseBlocks` 首行 `input.replace(...)` → `e.replace is not a function`。脏形状是 section 的 `list` 项 / `b` 是**对象**——早于服务端 `normalizeDeliverableSections`（报告 V2 归一化）落库的历史成果消息就是这个样子。
- ③ 同一个 `parseBlocks` → `role=assistant` 消息 contentJson **缺 `text`**。

**为什么偏偏是品牌营销官**：`/agents` 线上数据已核实，brand 的 agent 记录本身完全健康（chips / memText 齐全），排除配置。但 `retireAgents` 之后线上顾问只剩 `general/strat/growth/ops/brand`，**brand 是「专业参谋」组唯一还在的一行**；而它的开场 chip 发的正是 `营销内容` = 自身 `deliverableKey`，所以 brand 会话是**成果消息为主**的会话，正好是 ①② 的载体。另一条关键事实：`GET /sessions/:id` 的读取端此前**只做 `scrubAssistantContent`、不做 `healDeliverableSections`**（那只用在方案库 / 版本化报告读取路径），脏数据原样到端上——这也解释了为什么同一份报告在「方案库详情」不炸、只在会话成果卡炸。

**第一层（服务端，部署即救线上，不必发版）**：`GET /sessions/:id` 补齐读取端自愈口径，与方案库 / 版本化报告统一。`presentMessageContent` 按角色分流——report 走 `healDeliverableSections`；`scrubAssistantContent` 在原有 section JSON 擦除之外，追加「`text` 一定是字符串」的形状保证；user 原文与未来新增角色一律原样透传（不做任何形状改写）。**`sections` 字段整个缺失的情况单独补**：`healDeliverableSections` 对「没有 sections 字段」的对象刻意原样返回（它是通用工具，不该给任意对象凭空加字段，`reportV2.test.ts` 有幂等断言钉着），所以补成空数组这一步放在会话读取路径的 `presentReportContent` 里，不动共享工具的语义。**热路径成本已量**：纯内存变换、零额外 IO、健康数据幂等——满配 12 段成果消息单条 **4.39 µs**，一条含 30 份成果的会话合计 **0.132 ms**，约为同一条消息 `JSON.stringify` 的 1.8×（响应序列化本来就要做一次），相对该路由既有的三次 DB 往返（session findFirst + lastReadAt UPDATE + agentVersion findUnique）可忽略；正常数据不触发 `JSON.parse`（`parseStringifiedSections` 只做一次锚定正则 test 就返回）。

**顺带堵掉一条同形状的对话中途白屏**：流式聊天的 `send('chat', reply2)` 里 `reply2` 可为 `null`（provider 流静默收尾、只来过 delta），端上把 null 整体替换进气泡后下一帧读 `m.reply.text` 就抛错；而紧随其后的 `message.create` 又因 `contentJson` 是必填 Json 列而拒绝 null，这一轮本来也落不了库。新增 `assertStreamReply` 断言守卫：没有结果就按 `AI_UNAVAILABLE` 抛出，交给既有 catch 退预留 + `send('error')`，端上走错误气泡 + ↻ 重试，而不是「看起来成功、内容为空」。

**第二层（app 端渲染防御，随下次发版加固）**：脏数据不止一个来源，端上也不能靠服务端兜住一切。`MarkdownText`（全站正文唯一渲染口）新增 `asText()` 入参防线，一处收口掉整类 `parseBlocks` 崩溃，`text` 类型同步放宽为可选；`cardSection` 真正兑现声明的 `{h:string; b?:string; list?:string[]}`——新增 `str()/arr()/strList()`，12 个分支的容器字段（`items/rows/paras/people/quads/headers/list`）全部过 `arr()`（防 `.map/.join/展开` 抛错），叶子全部过 `str()`，**口径与服务端 `textOf/listOf` 一致（非字符串标量转字符串、对象丢弃），保证会话成果卡与方案库详情显示同一份内容**；`ReportCard` 用 `secs = Array.isArray(data.sections) ? … : []` 替换三处直读，`title/meta/trust/icon` 过 `plain()`（对象进 `<Text>` 会触发 React「Objects are not valid as a React child」，同样白屏），`data` 加空成果默认参数；`chat/index.tsx` 新增 `asReply()` 收口 assistant contentJson（`restore` 与 SSE `setChat` 两个入口都过），并给 `mm.reply.asks`、`m.reply.text/points`、`a.options`、`m.agent.chips`、`m.deliverable?.*`、`cur.deliverable?.sections`、`stripTags`、`data_delay`、`deliverableToText`、`visibleStreamText` 补齐同形状防御。

**降级后的表现**（修复前全部白屏）：缺 sections → 骨架 + 「已中断」，且查看/分享/存入/认可一律不开；对象叶子 → 该段只留编号标题（与方案库详情一致）；缺 text → 只渲染 points。海报会话共用同一个 `ReportCard`，同受影响、同被覆盖，回归验证「查看成品图 / 生成成品图 💎x10」两行入口不变。

**测试**：server `test/sessionReadHeal.test.ts` 新增 5 例（缺 sections 补空数组且不改库 / 对象叶子归一化且健康段完整保留 / assistant 缺 text 补空串 / 健康数据逐字段幂等 / user 原文不被改写），全量 `npm test` **980 → 985** 例通过；app `deliverableSection.test.ts` 新增 4 例（对象 list 项、对象 b、对象 h、10 种非数组容器不抛错），`npm test` **28 → 32** 例通过。

### 2026-07-29 · 年度谶语补上出谶触发点（有八字必有当年谶）· 影响面：server（`services/mingpan.ts` / `services/strategicProfile.ts` / `routes/profile.ts` / `test/strategicProfile.test.ts`）+ app（`services/mock.ts` / `services/api.ts` 的 mock 分支）+ docs（`AGENTS.md` §services）

用户实测：「我已经有八字了，但年度谶语还是没显示」。不是回归，是 `3bce564`（老板页年度谶语卡）上线以来的存量缺陷——**谶语在生产上从来没有任何自动写入方**。

**根因（精确到条件表达式）**：`upsertStrategicProfile` 里的 `if (verse && (forceVerse || !extra.verse || extra.verseYear !== thisYear))` 从未有机会成立。两条写入路径：① 自动路径（认可方案 `/casefile/accept`、`/battle/commit`）传的是 `extractStrategicFacts(deliverable)`，而该函数只按分节标题匹配 主要矛盾/定位/赛道/阶段 四个键，**返回的 patch 里永远没有 `verse`**；② 手动路径 `PUT /profile/strategic` 能写谶，但小程序端只有 GET，没有任何调用方。于是 `strategic.verse` 恒为 `''`，老板页那张卡对所有真实用户恒落空态「你还没有今年的谶 · 去命盘 ›」，而命盘报告页也没有任何出谶动作 —— 空态把人指过去，那边什么也不会发生，是条断头路。（`RETENTION_MECHANISMS.md` #16 里「verse 捕获已在跑」这句只对存储管线成立，捕获本身没在跑。）

**修法**：谶语本就该由命盘确定性派生（与「天命速写」同口径，零 LLM），缺的只是触发点。`mingpan.ts` 新增纯函数 `composeAnnualVerse(chart, year)`——上句取命局本气（喜用五行 × 日主旺衰），下句取流年应期（流年天干五行与喜用/日主的生克关系 × 流年干阴阳），**同盘同年恒同句**（「一年一句·不改不换」不允许随机），阴阳这一维保证相邻两年必换新谶（否则甲乙、丙丁这类同五行年份会出同一句）。`strategicProfile.ts` 新增 `ensureAnnualVerse`：命理开 + 有 `NatalChart` + 当年无谶 → 出谶；`GET /profile/strategic` 读档案时顺手补齐（fire-safe，出谶失败不拖垮档案读取）。「一年一句」守卫仍由 `upsertStrategicProfile` 统一执行 —— 已有当年谶（含老板手动改的、或将来 LLM 抽取到的）绝不被这条路覆盖；命理开关关闭时不出谶，也就不进注入块。

**存量用户自动恢复**：无需任何补数据操作。已有八字的用户下一次进老板 tab（`useDidShow` → `api.strategicProfile()`）就会写入当年谶语并立刻显示。没有八字的用户维持求谶引导，录完生辰返回老板页即出谶。

**顺带**：mock 的 `strategicProfile` 此前恒返回 `null`，导致这张卡在本地/H5 走查里**永远只有空态**——这正是缺陷长期没被发现的原因；现在 mock 按「有八字且信命理才有谶」镜像真实端两态（谶语仍是固定样例，mock 不排盘），与样例履历封面共用同一句。测试 +3（出谶纯函数锚定 1988-03-15 命例 2026 年出句、连续六年六句不重复；有八字 → 读档案即得当年谶语且再读不换、手动改谶不被回压；命理关 → 有八字也不出谶）。

### 2026-07-29 · 海报成品图：配置面简化（去掉部署级开关）+ 七个真缺陷 · 影响面：server（`env.ts` / `services/creative/*` / `routes/creative.ts` / 两份测试）+ shared（`contracts.d.ts`）+ admin（创作任务页 / 任务台）+ app（确认页 / 换风格面板）+ docs（`AGENTS.md` §8.4 §13、`DEPLOYMENT.md` §5 §5.1、方案 §6.2 §8.1 §14 §16 §21 §22）+ `server/.env.example` / `.env.test`

同一天上线的功能（`d2de9a8` / `bce1969` / `fcfadad`）在两轮独立评审后做的收口。起因是「配置面冗余」这一条：一个功能挂了 4 个环境变量 + 一排后台配置项，而这 4 个 env **没有一个是运维真的会去调的**，却各自制造了一种失败模式。顺着同一条线索翻出七个真缺陷——其中最重的一个让整套 BrandKit 集成在生产上根本走不到。

**开关从两层收成一层**。原设计是 env `CANVAS_DESIGN_ENABLED`（部署级硬开关）**&&** 后台 `creative-poster` 开关，实现后立刻暴露两个问题：① 运营在后台打开却不生效，界面还无法解释原因——这是静默失败；② 它想承担的「部署级熔断」要 SSH + 改 env + 重启，比后台点一下慢一个数量级，真出事时没人会走这条路。现在唯一真源是后台那个开关，**行缺失显式视为关**（`isFeatureEnabled(CREATIVE_FLAG_ID, false)` —— 该函数默认值参数缺省是 `true`，这里必须显式传 false，删了就是无声放量）。判断依据：env 开关在本仓的正当用途是回答「外部依赖是否存在」（embedding / rerank / moderation / pgvector 那批），而 puppeteer 与 OSS 是既有功能的硬依赖、字体已确认在位；预发是独立库 `junshi_preprod`，DB 开关本就按环境隔离。**放量动作随之从「改 .env 置 true + 重启 API」变成「后台点一下」**，回滚同理。

**顺带堵住一个会自己放量的坑**：`FeatureFlag.enabled` 在 prisma 里是 `@default(true)`，而写 payload 走 upsert，生产库本来没有 `creative-poster` 这一行。运营第一次进后台**只改个单价**并保存，行被创建时 `enabled` 就取默认 `true` → 一次改价把还没验收的功能放出去了。`updateCreativeConfig` 现在每次都显式落一遍 `enabled`（patch 不带就回落到读到的当前值，行缺失=false）。

**另外三个 env 各有各的死法**（一并删，理由写进 `env.ts` 与 `.env.example` 同名段落，防止后人加回来）：`_ENGINE` 全仓没有一处 `engine ===` 分支、`anthropic_skill` 也无实现，改它只改变库里那个标签的字面值——一个会撒谎的旋钮；`_MAX_CONCURRENCY` / `_TIMEOUT_MS` 只作 payload 缺省值，而后台保存是**全量重写 payload**，运营点过一次保存后改 env 重启就永久无效果（双真源）。**`maxConcurrency` 这个配置项本身也删了**：worker 一轮是串行 `await`，渲染又被 `reportPdf` 的单并发队列串起来，后台标签「worker 并发槽（1–8）」是个不会兑现的承诺；现为内部常量 `TICK_BATCH_SIZE = 2`（含义是「一轮最多连处理几单」，不是并发）。**本功能现在一个环境变量都没有。**

**七个真缺陷**：

- **BrandKit 集成在生产走不到（最重）**：服务端 brief 草稿下发了 `brandKitVersion`，但确认页 submit 时重拼 brief 把它丢了，于是建单恒为 null → `approvedBrandKit()` 查询、提示词里的品牌语气块、`THEME_HINT_COLORS` 色板表、语气合并**整条链路都是死代码**。「已确认的品牌资产会进海报」这个承诺在生产上一次都没兑现过。修法是确认页与换风格面板原样带回 `brandKitVersion` / `negativePrompt`（水化时也存进 state），并补服务端测试断言带 approved BrandKit 建单时提示词快照里有品牌痕迹——**这类"前端丢字段"的缺陷只有端到端断言抓得住**，服务端单测各自都是绿的。
- **`reviseJob` 漏门禁**：`createPosterJob` / `regenerateJob` 都有 `assertPosterAccess`，只有 revise 少这一行（归属校验 `loadOwnedJob` 在，缺的是权益校验）。于是权益到期或被运营取消开通的用户，照样能对自己的历史任务无限次发起「改文案重排」——revise 不扣钻，所以这条路是**免费**的。三个建单入口的门禁必须一致，补齐后 403 `AGENT_LOCKED`。
- **成功写入缺状态守卫，双执行可覆盖终态**：失败路径有 `status:'running'` 守卫，成功路径的 `update` 没有。叠加下一条的阈值错配就会产出两张资产、两条成功消息。改成 `updateMany({ where: { id, status: 'running' } })`，影响行数为 0 视为已被他人收口——记一条 warn 后放弃写入，**不抛错**（抛了会触发退款路径，而钱早已正常结算）。
- **渲染超时上限（900s）> sweep 卡死阈值（600s）**：两个数写在两个文件里、谁都没看谁。后果是**一次正常的长渲染会在还没结束时被 sweep 判为卡死、抢回队列重跑**。上限收到 480s（留足余量），并在两处加互相引用的注释把这个不变式写死。
- **重试上限 off-by-one**：`attempts < MAX_ATTEMPTS` 与 `attempts <= MAX_ATTEMPTS` 各出现一次，同一个任务在两条路径上对「还能不能重试」给出不同答案，而测试用 `MAX_ATTEMPTS + 1` 把错误固化了。抽 `canRetry()` 单一实现，两处都用。
- **模板被停用后静默换版且照常扣费**：运营停用某套版式通常正是因为它出问题了，而服务端把「显式请求了它」和「没指定」当成一件事，都回退默认模板照收 10 钻——用户为自己挑的那套付了钱，拿到的是别的。现在显式请求被停用模板返回 **422**（这句文案早就写好了，只是走不到），未指定才按 scene 回退；启用中的清单由 `GET /creative/status` 下发（`templates` 字段），app 删掉硬编码目录（三份目录到上线时 app 与 admin 的描述已经对不上）；全部停用 = 无法建单。
- **供应商降级零痕迹**：两条降级路径只 `console.warn`，而任务台的 `provider` 是**建单时**快照的 `'configured'`，metrics 也用它——**供应商挂一整天，任务台全绿，用户拿到的全是纯排版版本**。现在 `resultJson` 带 `degraded` + `visualError`（对外可读文案），任务台显示「无主视觉」标签，metrics 的 provider 标签取本轮实际结果（`reused` / 供应商名 / `degraded`）。老任务无该字段按 false。

**删掉图片审核的 `http` 半成品**（`HttpModerator` + 三处 `process.env` 读取 + `imageModerationProvider` 配置项）。它直读 `CREATIVE_IMAGE_MODERATION_URL/_KEY/_TIMEOUT_MS` 三个**全仓只在该文件出现、既不在 `env.ts` 也不在 `.env.example`** 的变量，且 `provider='http'` 但缺 URL 时 `return new NoneModerator()` —— 后台显示「已开审核」、实际全部放行、连一条 error 审计都没有。**一个让人误以为已经在审的开关，比明确的「未接入」危险得多。** 保留 `ImageModerator` 接口 + `NoneModerator` 作二期接入缝（真接入时只需加一个 class + 一个 resolve 分支），`check()` 入参从 `Buffer | {ossKey}` 收窄为 `Buffer`（第二个分支从没有人走）。**「图片内容审核未接 = 合规缺口」这条记录保留在 `AGENTS.md` §13**，删的是半成品，不是待办。

**后台文案与行为对齐**（三处说的都不是代码在做的事）：`dailyLimit=0` 从「不允许创建」正名为**不限量**——0=不限是通行约定，紧急停量该用功能开关（一次操作、语义明确、有审计），不该靠把限额改成 0 等用户撞墙，契约注释同步并补测试钉住；`timeoutMs` 从「单任务端到端超时」改为**渲染超时**（它只传给 `renderPoster`）；模板全停从「按场景回退默认」改为「无法建单（422）」。

**契约收窄到现实**：`PosterRatio` → `'3:4'` 单值（9:16 / 1:1 服务端一律 422、模板画布写死 540×720，二期放开时往联合类型里加，让编译器去找该改的地方）；`CreativeJobView.kind` 注释里的 `cover | social_card` 收成 `'poster'`；上传入口从「query + multipart 两种」收成一种。**同批清死代码**：异步供应商整条分支（`query()` / `VisualQueryResult` / `status:'pending'` / 写 `providerTaskId` 那句「让 sweep 续查」的假注释——sweep 从不查它）、`TemplateInput.signature` + `signatureOf()`（注释写「P4 可传」，P4 已上线且没传）、`VisualRequest.size`、`RequestSnapshot.visualConfigured`、三个永不出现的 `USER_FACING_ERROR` key、`templateName()` / `clearPosterPending()` / `__clearCreativeMemStore()` 等零引用导出，`resolveBriefAssets()` 返回值三个调用点全丢弃 → 签名改 `Promise<void>`。app 两份 LIMITS 与两份 progress 词表各自合一。

**兑现已付出的 LLM 成本**：`promptSnapshot`（视觉哲学六维度 + note）此前**没有任何读者**——模型每单都在算，运营和用户都看不到。任务台行内加「展开视觉哲学」（`AdminCreativeJobItem.promptSnapshot`，列表接口超 2000 字符截断并标注，避免大字段拖慢列表）。

**测试**：`server/test/creative.test.ts` 28 → 37 例、`creativeWorker.test.ts` 17 → 21 例，全量 `npm test` **964 → 977** 例通过。新增覆盖：BrandKit 命中、revise 门禁、终态守卫（手工置 succeeded 后再驱动一轮，断言资产不翻倍）、`timeoutMs` 900s 被 clamp 到 480s、`dailyLimit=0` 不拦截、显式请求停用模板 422、降级留痕、主视觉复用路径（此前整条零覆盖——原测试标题声称的两件事都没断言，且测试环境无供应商，父任务本就不产 visual 资产）。`.env.test` 里那行 `CANVAS_DESIGN_ENABLED=true` 随 env 一起删；**用例改开关后仍必须 `__clearFeatureCache()`**，只是原因从「env 单例冻结」换成了「featureFlag 的 60s 读缓存」。

**明确不做（需产品决策，单独提）**：`Deliverable.assets` / `creativeJobId` 服务端已回写且有测试，但「用户过一周想再拿一次那张图」该从哪进、要不要版本列表页、同一方案出过三版怎么排——没有产品答案，不是补两行代码的活，记进 `AGENTS.md` §13。

### 2026-07-29 · 修运营后台「403 被当 401 踢登出」 · 影响面：`admin/src/{api.ts,useResource.ts,components.tsx,App.tsx}` + 视图 `views/{catalog,studio,settings,creative}.tsx` + 新增 `admin/src/api.auth.test.ts`（清 `AGENTS.md` §13 TODO）

`admin/src/api.ts` 的 `req()` 原先写成 `if (res.status === 401 || res.status === 403)`：两者一起清 token + 广播 `admin:unauth` 切回登录页。于是普通运营点**任何** `requireSuper` 接口——支付退款、创作任务改价 `/admin/creative/config`、供应商 dry-run、新增智能体、套餐/SKU 改价、告警通知——看到的都是「掉线，请重新登录」。这个伪装的代价不只是文案：运营会去查密钥和网络，重新登录还必然重现同一现象，而真正该做的是找 owner 要授权。同一文件的 `uploadUserKnowledge` 有同样的合并，`downloadPaymentsCsv` 则连 401 都没清登录态。

**现在的契约**：401 = 掉线（清登录态 + 广播，唯一该踢回登录页的状态）；403 = 权限不足（**保留登录态**，抛 `{ code, status: 403 }` 交给页面就地提示）。文案取服务端原文（它更具体，如「你对该智能体仅有只读权限」），服务端只回 code 时按 `OWNER_ONLY` / `ADMIN_AGENT_FORBIDDEN` / `ADMIN_FORBIDDEN` 兜底人话；响应体不是 JSON（反代兜的 403 页）也照此处理，不再退化成裸状态码。三处 fetch（`req` / 知识库上传 / CSV 导出）口径统一。

**只读通道**：`useResource` 只对 401 静默（那已经在切登录页，再闪一屏红字没意义），403 记进新增的 `Resource.forbidden` 并照常进错误态；`ErrorState` 的 `forbidden` 形态把标题换成「当前账户没有查看这块内容的权限」、补一句「让 owner 调整授权」，并**撤掉重试按钮**——再点还是 403，给重试等于让人白试。`ViewState` 与 `AccountsView`（`GET /admin/accounts` 本身就是 requireSuper）已接。

**顺带修的三处「静默/说谎」**（403 不再踢登出后，这些 catch 就成了唯一出口）：① `views/studio.tsx` 的上下架 `await api.saveAgent(...)` 没有 catch，viewer 协作者点下去会变成彻底无声的「什么也没发生」；② 同文件新增智能体一律 `toast('新增失败（key 可能已存在）')`，会让非超管反复改 key 试；③ `views/catalog.tsx` 套餐/SKU 改价与 `settings.tsx` 的 `saveKeys` 用 `catch { toast('保存失败') }` 盖掉了服务端权限文案。**各页「藏按钮 + isSuper」的做法保留**——先让运营知道自己不能改，比点下去再吃错误好；403 兜底只是 `me()` 取不到角色或被降权时的第二道网。

**测试**：新增 `admin/src/api.auth.test.ts`（5 例，`cd admin && npm test` 20/20）钉住 401 清登录态 + 广播、403 保留登录态 + 不广播 + 带 code、403 无文案/非 JSON 的兜底、500 不吞服务端原文。`npx tsc --noEmit`、`npm run lint:ui`、`npm run build` 全绿。**未动后端**：`requireSuper` 回的仍是 403 `OWNER_ONLY`（语义本就正确，错在前端消费）。

### 2026-07-29 · 海报成品图（`canvas_design` artifact 技能）全链路 · 影响面：server（契约/两张表/creative 服务与路由/worker/sweep/admin 段）+ admin（创作任务页）+ app（成果卡入口/需求确认页/制作中页）+ deploy（字体/环境变量/上线动作）

「海报设计师」此前只出文本方案，用户拿到的还是一段"怎么做"，得自己找设计。这次把方案变成**真图**：3:4 竖版 PNG（1080×1440），10 钻/张。完整设计与决策记录见 `docs/CANVAS_DESIGN_SKILL_INTEGRATION_PLAN.md`，工程约定收进 `AGENTS.md` §8.4。

**技能体系**：`SkillKind` 从 `tool | output` 扩到 `tool | output | artifact`。artifact 只做元信息登记（后台技能库显示「成品交付」、agent 可勾选），**没有**建通用 ArtifactSkill 注册表——只有一个成员时抽象是负债。

**任务模型**：`CreativeJob`（一次出图 = 一行）+ `CreativeAsset`（`source|visual|poster_png`）。状态真源是数据库行，不是进程内 Map——会话 generating 活在内存里重启即丢、知识库 `processDocument` 曾把条目永久卡在 parsing，这两处教训是第一天就配 sweep + 幂等退款的原因。worker 用 `FOR UPDATE SKIP LOCKED` 抢占（不继承 scheduler 的单实例约束），`sweepCreativeJobs` 每 5 分钟捞 running 超 10 分钟的任务：`attempts<=3` 回队列，超限 failed + 退款。

**计费三条不变式**（都有回归用例钉住）：

- **退款只退一次**：唯一入口 `refundJob()` 用 `updateMany({ chargedAt: {not:null}, refundedAt: null })` 抢占，抢到才真退。worker catch / sweep / 用户取消三条路径叠在一起也只落一条正向流水。刻意不用 `credits.reserveCredits` 的内存闭包——它跨不过 worker 进程边界。
- **不限量用户不铸币**：余额 -1 的用户 `appendCreditDelta` 直接 return（连流水都不写），所以 `chargedAt` 必须保持 null；若按「名义价非 0 就标已扣」写，一次失败退款就凭空给用户发 10 钻。`creditCost` 仍记名义价，成本统计看它、是否退钱看 `chargedAt`，两件事分开。余额还必须在**事务内**读：事务外读会留一个「套餐从不限量切成限量」的窗口。
- **admin 重试不动资金字段**：失败任务通常已退过款，运营点重试 = 善意再免费跑一次。清 `refundedAt` 想「让这笔钱重新算消费」会导致重试再失败又退 10 钻（用户只付过一次）。

**revise vs regenerate**：只改文案重排不扣钻（复用父任务主视觉），重出主视觉再扣一次；两者都新建任务并挂 `parentJobId`，**成功任务的资产永不被覆盖**。

**渲染**：复用 `reportPdf` 的 puppeteer 单例 + 单并发队列（绝不另起浏览器，一份 Chromium 就几百 MB），新增导出 `renderHtmlToPng`。模板是自包含 HTML（无外链、无脚本、字体只用系统栈），渲染前跑确定性自检，渲染后过**溢出闸**——固定画布只截视口，文档一旦更高超出部分就被无声裁掉（最常见形态正是最后一条卖点被切掉半个笔画），所以宁可整单失败退款也不发裁字的图。

**模板与校验**：MVP 三套 3:4（`person_hero`/`editorial`/`business_launch`）。poster 提示词让模型在成果里直出「成品图版式推荐：xxx（key）—— 理由」，服务端只认白名单，无效/被停用回退 scene 默认。文案超限 **422 不静默截断**（不让用户以为写进去了却被砍掉）；`ratio` 只放行 `3:4`。

**功能双开关**（⚠️ **同日已推翻，见本文顶部那条**：env `CANVAS_DESIGN_ENABLED` 与 `_ENGINE` / `_MAX_CONCURRENCY` / `_TIMEOUT_MS` 全部删除，开关收成后台一层、行缺失视为关；`maxConcurrency` 配置项亦删。下面保留当日原文以记录判断的演变）：~~env `CANVAS_DESIGN_ENABLED`（部署级硬开关，默认 false）&& 后台功能开关 `creative-poster`（运营的即时熔断闸）~~。配置复用 `FeatureFlag` 单行的 `enabled + payload` 存价格/日限额/~~并发~~/模板启停/图片供应商接入点（apiKey 经 `secretBox` 加密、对外只回 `hasKey`），不为一行配置新建一张表。**图片供应商不硬编码**，未配置时走「无主视觉」纯排版路径——纯排版本身就是完整可交付产物，不该因为没配供应商就报错。

**顺带修的缺陷**（P5 测试期发现）：老任务带着已下线的 `templateKey` 时，`RENDERERS[key]` 是 undefined，直接调用抛 `... is not a function`，被 worker 归成 `errorCode='INTERNAL'`——运营在任务台上分不清「模板问题」和「代码 bug」。现在 `renderPosterHtml` 显式判空、`renderPoster` 把拼 HTML 阶段的异常收成 `PosterRenderError`，落成有语义的 `POSTER_RENDER_FAILED`。

**测试**：新增 `server/test/creative.test.ts`（28 例）+ `server/test/creativeWorker.test.ts`（17 例），覆盖幂等（含 6 路并发同 key）、三条财务不变量、五类门禁、brief 校验、worker 生命周期与成果消息回写、sweep 两条分支、`parseTemplateRecommendation` 三态、admin 配置与任务台。~~`.env.test` 加 `CANVAS_DESIGN_ENABLED=true`（`env` 是模块加载时冻结的单例，用例内改 `process.env` 太晚，而 `hermeticEnv.mjs` 会抹掉进程启动后新增的键）~~（该 env 同日删除，这行也随之删掉；改开关后仍需 `__clearFeatureCache()`）。全量 `npm test` 964 例通过。

**上线动作（三条，缺一不可）**：① `cd server && npm run db:push` 建两张表（本仓无 migrations）；② 中文字体——镜像已装 `fonts-noto-cjk`，**裸机部署需自行安装**，否则海报中文掉方框；③ `npm run db:upgrade-poster-prompt -- --apply` 幂等把版式推荐段落追加进库内 poster 提示词（同时改草稿与已发布快照，否则 C 端不生效）。~~放量最后一步才把 `CANVAS_DESIGN_ENABLED` 置 true~~ → **放量 = 后台「创作任务」页打开开关**（同日改，不再需要改 env 重启；现行步骤见 `docs/DEPLOYMENT.md` §5.1）。**明确不做 / 后置**：PDF 二期、图片审核供应商未接（默认 none = 放行）、9:16 与 1:1 后置 —— 清单见 `AGENTS.md` §13。

### 2026-07-29 · 修钻石预扣「双退」资损：`CreditReservation.refund` 改为幂等 · 影响面：`server/src/services/credits.ts` + `server/src/routes/sessions.ts`（注释）+ `server/test/creditReservation.test.ts`

`reserveCredits` 返回的 `refund` 是裸闭包，调多少次就追加多少条正向流水。而路由里退款路径本来就会叠：

- 降级产出（真实模型没出结构化成果）走 `settleCreditForDeliverable` 退一次钻石；
- 紧随其后的 `quotaReservation.settle(...)` 若抛错（DB 抖动 / 连接超时），catch 块按 `charged` 仍为 true 再退一次；
- 两次都落账 → 同一次预扣退了两笔，用户白拿一份钻石。窗口很窄但代码上必然可达，且 sync 与 SSE 两条路径都有（`sessions.ts` :401/:423 与 :666/:704 → catch :444/:735）。

改法对齐 `tokenQuota.QuotaReservation` 的 `done` 标志思路：把「已退过」记在 reservation 自己身上，`refund` 只生效一次，重复调用直接返回首次退款后的余额、不再落账。因 `refund` 需要返回余额（`settleCreditForDeliverable` 拿它当 `creditBalance` 回给前端），标志位实现为**记忆化 promise**，顺带让并发调用共享同一次落账。

**退款失败不置位**——与 `tokenQuota.settle` 同一取舍：若失败也算「已退」，一次 DB 抖动就把用户的钻石吞掉；失败清空重置，后续 catch 路径仍能把钻石退回去。

`sessions.ts` 只补注释说明双退靠 reservation 侧幂等兜住，两条路径语义不变（降级只退一次、断连只退一次、失败退款仍可重试）。新增 `test/creditReservation.test.ts` 三例：refund 调两次只退一次（流水断言 `[-cost, +cost]`）、`cost<=0` 多次 refund 不写流水、退款失败后重试仍能退回。回归前把 fix 撤掉验证过用例会红（余额 20 → 23）。

### 2026-07-28 · 运营后台菜单按「看 vs 改」重排为 7 组（修上一版分组逻辑错误）· 影响面：`admin/src/nav.ts` + views 文件名

上一版（`795d89a`）的分组有两处逻辑错误，运营实际用起来才暴露：

1. **「模型配置」被放进「稳定性」组**。当时理由是端点池冷却状态算健康信号，但那是次要属性——该页主体是写操作（换模型 / 填 key / 配单价 / 池权重 / 嵌入重排）。把唯一的写屏塞进三个只读观测屏（调用诊断 / 内容审核 / 审计日志）里，正是让人找不到东西的根因。
2. **「配置」组堆到 8 项**，把「配商品」「配开关」「配内容」「配权限」混装，已顶到 DESIGN.md 自己写的「超 8 项就拆组」上限。

改法是立一条可自证的原则：**只读的归观测/经营，可写的归商品/配置；看页面的主导动词，不看次要属性。** 由此 6 组 → 7 组：

| 组 | 分区 |
|---|---|
| 今日 | 概览 |
| 用户 | 用户 |
| 经营 | 订单 · 处方漏斗 · 钻石消耗 · Token 成本 |
| 智能体 | 顾问 · 技能库 · 知识库 · 检索调试 |
| 观测 | 调用诊断 · 内容审核 · 审计日志 |
| 商品 | 套餐 · 单次付费 · 生态工具 |
| 配置 | 模型配置 · 功能开关 · 行业基准 · 每日献策 · 问卷 · 运营账户 |

22 个分区一个不少，单组最多 6 项。组名统一 2-3 字，移动底栏 7 格 flex 均分（375px 下每格约 52px）仍不横滚。组图标 = 该组头牌分区的图标。
文件名跟着组名对齐：`views/health.tsx` → `views/observe.tsx`；`views/config.tsx` 拆成 `views/catalog.tsx`（商品 3 屏）+ `views/settings.tsx`（配置 5 屏）；`views/model.tsx` 因体量单独保留，逻辑归 `settings`。`trace` 分区补 `稳定性` 别名，老习惯搜「稳定性」仍能命中。

### 2026-07-28 · 运营后台按「值班动线」重构（导航 / 三态 / 待处理 / 资金确认 / 拆文件）· 影响面：`admin/` 全量前端 + `scripts/audit-admin-ui.mjs`

**动机（运营管理操作视角的真实痛点）**：① 22 个目的地平铺在一条 56px 宽、横向滚动的底栏里，找「行业基准」要横滑到第 22 格；② 桌面端整块视口被一列窄内容浪费（`.stats`/`.usage-summary`/`.kv-grid` 恒定 2 列）；③ 客服拿到一个手机号却没有搜索框，只能靠浏览器 Ctrl+F 在全量用户列表里翻；④ 散落 32 处 `.catch(() => {})` 让「接口 500」和「确实没数据」在界面上长得一模一样；⑤ 当前位置只在 React state 里，F5 丢现场、返回键无效、排查现场没法分享；⑥ 退款这种真实资金动作靠 `window.prompt` 收原因，不回显金额、回车即执行。

**改动**：

- **导航按运营场景收敛**：新增 `admin/src/nav.ts` 作为导航 SSOT，22 个 section 归入 6 组（今日/用户/经营/智能体/稳定性/配置）。桌面左栏常驻 204px + 组内 segmented 分区；移动底栏只放 6 个组 → 组数固定、永不横滚。内容进 `--wrap`(1180px) 容器，数据格栅改 `auto-fit minmax`。
- **hash 路由**（`admin/src/router.ts`，零依赖 ~50 行）：`#/<section>[/<id>][?params]`，刷新/返回/分享链接均可复现现场（含打开着的用户或顾问详情）；非法/越权 hash 兜回概览。详情面板改为锚在 `.main` 内，桌面端钻进详情时左栏仍可见，不再是无出口全屏层。
- **命令面板 ⌘K**（`CommandPalette.tsx`）：按名称/别名跳任意一屏 + 按姓名/手机号直接定位用户（纯数字优先匹配用户），↑↓/↵/esc 全键盘。
- **三态统一**（`useResource.ts` + `components.tsx` 的 `ViewState`/`Skeleton`/`ErrorState`）：替掉全部 32 处静默 catch，区分骨架/错误+重试/空态；刷新失败保留旧数据并顶部提示，不把运营正在看的内容抽走；`PageHead` 统一渲染标题（取自 nav.ts）+ 计数 + 刷新 + 「刚刚更新」新鲜度。
- **今日「待处理」队列**：卡单（已支付未发放=资损单）/近 24h 调用失败/端点冷却/审核拦截/额度耗尽五格，全部复用既有接口、零后端改动，点进去即筛好的清单；各格独立取数互不拖累；全零折叠成一行。
- **用户屏可用化**：搜索（姓名/手机号/租户/ID）+ 三个值班筛选（额度耗尽/无套餐/未绑微信）+ 四种排序；审计屏加接口/动作/用户/IP 搜索。
- **资金与破坏性动作**：新增 `ConfirmDialog`，回显「对谁/多少钱/哪一单」；退款与关闭合规开关要求手打确认词，退款原因在弹层内收集入审计。清掉全部 `window.confirm`(8) 与 `window.prompt`(2)，其中重置运营密码不再把新密码明文回显在系统弹窗里。
- **跨屏直达**：订单→查用户（契约只有 `userName`，按姓名带进 `#/users?q=…`；补 `userId` 需改后端契约，已记 TODO）、审核拦截→查看用户、Token Top 用户→用户详情。
- **拆文件**：2841 行 `App.tsx` → 外壳 `App.tsx`(约 250 行) + `views/{overview,users,revenue,health,studio,config,model}.tsx` + `format.tsx` + `components.tsx`。`scripts/audit-admin-ui.mjs` 改为**递归扫描** `admin/src/**/*.tsx`（旧版硬编码 6 个文件，新文件可静默逃检），违规定位改相对路径。

**顺手修掉的存量缺陷**（都是递归扫描后暴露的）：`Icon.tsx` 缺 `shield` 路径——「内容审核 / 功能开关 / 沙盒可信标记」四处图标一直渲染成空 SVG；`StudioEval`/`StudioSandbox` 3 处裸 `.sv`/`.gh`（只在 `.save-bar .sv` 下有定义）实际退化成无样式原生按钮；`ui.tsx` 的 `scoreColor` 返回硬编码 hex 拼进 inline style，改为 `scoreClass` + `.score.*` token 类；`--warning` 补进 `:root`，`.audit-status.warn` 不再硬编码；新增 `--z-*` z 轴刻度与 `--wrap`。

**验证**：`admin` `npx tsc --noEmit` 0 错、`npm run lint:ui` 全绿、`npm test` 15/15。本地起 `server:4000` + `admin:5174` 走查（详见下条注意事项）。

**注意 / 未做**：`AdminPaymentItem`/`AdminPaymentStuckItem` 契约没有 `userId`，所以订单→用户是按姓名搜索而非精确跳转，补契约要动 `shared/contracts.d.ts` + 后端路由，本次未做；`server/prisma/seed.ts` 的 `deleteMany` 顺序在 `User` 前没清 `TokenWallet`，本地已有数据时 seed 会 P2003 失败（本次只在本地绕过，未改脚本）；`.tag.warn`/`.tag.live` 仍是历史硬编码色值（不等于任何 token，linter 放过），未一并收进 token。

> 格式：`YYYY-MM-DD · 改动 · 影响面`

- **2026-07-28** · **长会话记忆（批次 3）：带来源的会话上下文快照 SessionContextSnapshot 上线**：解决「普通轮只带最近 16 条原文，第 3 轮确认的事实到第 60 轮就掉出窗口、报告漏早期约束/决策」的结构性遗忘。**① 数据与服务**：新增 Prisma `SessionContextSnapshot`（每会话一行，纯加法）+ `services/sessionDigest.ts`：按 `lastMessageAt` 游标增量抽取（每批 ≤20 条消息、走 `structured()`→aux 档自动记账），十类条目（事实/目标/约束/数据/决策/已给建议/待确认/行动项/原话/已出方案）。**三条铁律落在代码而非注释**：每条 `sourceMessageIds` 必须是本批消息 id 子集（伪造即整条丢弃）；只追加绝不改写（矛盾双存按时间升序，谁作数交给模型判断）；宁缺勿假（无 live provider / 抽取失败不落条目**也不推游标**——推进即永久跳过）。同会话进程内链式互斥防交错覆盖；per-batch 原子落库（崩溃只回到上一批一致态）。**② 注入**：`GenContext.digestLine` 经 `formatDigestBlock`（4000 字符 cap：先整类丢 quote→deliverable_ref→advice→open_question→action_item，仍超再丢最早并如实标注条数）注入 dynamic 段【客户档案】之前——**只进 dynamic，不打穿提示词缓存前缀**（有测试显式断言 stable 段不含摘要）。`contextTrace.digest` 记条目数与实际注入字符数（运营后台调用诊断可见）。**③ 接线**：报告轮同步补齐（`maxBatches:3` + **25s 墙钟预算**，超时降级纯读、后台更新照常跑完下轮受益）；聊天轮纯读零延迟；每轮成功收尾即发即忘更新（8 条路径）；报告轮在「快照追平且非空」时历史窗 16→8（摘要兜早期脉络，原文留最近 8 条）——聊天轮恒 16 不动。**④ 对抗性审查后加固**（独立 Opus 审查：2 个 P1 + 4 个 P2，全修）：P1-1 报告轮同步补齐原本无 deadline（最坏 3 批 ×2 轮 ×3 端点 ×20s=360s，会把 /generate-sync 推过 nginx 180s）→ 25s 预算；P1-3 摘要文本未清洗换行/【】，53 字符即可在 system 段伪造【系统最高指令】块且只追加语义使其永久驻留 → 写读两路 `sanitizeDigestText`；P1-2 `structured()` 永不抛导致失败告警是死代码、毒批次每轮复烧 2 次真实调用 → 连续 3 次失败进 10 分钟冷却（进入时 warn 一次带游标位）；P2：同毫秒 capacity 边界静默丢消息（`extendToMillisecondBoundary` 同毫秒组不可分割，回退修复对应测试即红）、`readSessionDigest` 加 userId 归属校验、`readItems` 过滤非法 kind 防「[undefined]」进提示词。**⑤ 测试**：`test/sessionDigest.test.ts` 27 例——200 条会话第 3 条事实进快照且溯源到真实消息 id、批次并集严格等于全部消息 id、矛盾双存、伪造溯源丢弃、mock 安全、并发串行、预算降级、冷却进出、同毫秒回归；全量 **915/915**、tsc 干净。**已知边界**：条目 400 上限后冻结待合并/压缩（记债）；多实例并发靠只追加语义容忍重复抽取；**部署前置**：生产需确认 `AI_AUX_MODEL` 已配——未配时每轮抽取会占 main 车道槽位与用户生成抢并发（.env 权限收紧无法远程核实，需登服务器确认）。影响面：server（schema/新服务/两生成端点/context/llm schema）、shared 契约；无 API 破坏性变更，DB 纯加法（`db push` 安全）。

- **2026-07-28** · **监控大盘二期：告警阈值与飞书通知后台配置化（改阈值/换群不再发版）**：**① 阈值配置化**：新增 `services/alertConfig.ts` 注册表——15 项阈值（主机 CPU 预警/严重、PG 连接、普通接口 P95 两档、5xx 率、LLM 429 率两档、队列等待两档、Token 日预算、RSS、退款激增、审核拦截）全部注册为运营后台**「功能开关」页的「告警 ·」数值项**（复用既有 number 型开关的 UI/校验/审计，零新页面；单位全部整数化：ms/‰/%/元/MB，规则表达式里换算）；存 FeatureFlag payload → `/api/metrics` 新增 `junshi_alert_config{key}` 配置指标 → 四个告警规则文件的可调项全部改为 `scalar(junshi_alert_config{key="…"})` 取值（含 Token 预算 70%/90% 派生）。**后台改完 ≤75s 生效**（payload 60s 缓存 + 15s 抓取周期）。默认值仍=压测方案 §7 口径；DB 里的越界/脏值回落默认，不会把告警线带沟里。**② 飞书通知配置化**：Alertmanager 默认 receiver 改投 `POST /api/alerts/webhook`（新路由 `routes/alerts.ts`，与 /api/metrics 同一把 METRICS_TOKEN 门禁：未配 404/不对 401；compose 已给 alertmanager 挂载同一份 token 文件），服务端按后台配置的飞书群自定义机器人转发（text 消息 + 可选签名校验，算法 HMAC-SHA256(key=`ts\n secret`) 已锁测试）；转发失败回 502 让 Alertmanager 按自身策略重投，成败计入新指标 `junshi_alerts_forwarded_total{outcome}`。**取代原 PrometheusAlert 桥方案**（少一个容器）。webhook 配置入口=后台「功能开关」页底部「告警通知」卡（仅 owner/master 可见——api.req 对 403 会强制登出，非超管整卡不渲染）：掩码回显（绝不回明文 hook id）、secretBox 加密落库、URL 白名单只收 `https://open.feishu.cn|larksuite.com` 机器人域名（防「告警外发」被改成任意 URL 的数据外带口）、「发测试消息」自检按钮；admin 端点 GET/PUT `/admin/monitor-notify` + POST `/admin/monitor-notify/test`（写/测=requireSuper+审计）。**③ 契约与文档**：`shared/contracts.d.ts` 增 `AdminMonitorNotify`；MONITORING.md §5 改为「默认阈值=压测口径、运行值后台可调」+ 飞书配置步骤；已知限制补「API 挂掉时通知通道同亡（JunshiApiDown 只在 Alertmanager UI 可见），必须配外部拨测兜底」。**④ 测试**：新增 `test/alertConfig.test.ts` 12 例（默认/覆盖/越界回落、URL 白名单、掩码、签名向量、code!=0 判失败、端点 404/401/502/空组不转发）+ metrics 测试补配置指标断言；promtool 4 规则文件（33 条）与 amtool 复验通过；server tsc 干净。**已知搭车风险**：admin 前端 lint:ui 当前有 6 处**存量**违规（StudioEval/StudioSandbox/ui.tsx/admin.css，均非本次代码引入，与进行中的后台导航改版相关），`admin npm run build` 的 lint 闸暂红，本次仅以 `tsc -b` 验证类型；待改版完成后一并清。影响面：server（metrics/alertConfig/alerts 路由/admin 路由/app.ts）、admin（功能开关页+api）、deploy/monitoring（规则/alertmanager/compose）、契约、文档；无数据库 schema 变更（复用 feature_flag 表）。
- **2026-07-28** · **后台监控大盘：打点补全 + 自建 Prometheus/Grafana 栈 + 4 块预置看板 + 告警规则**：**① 应用打点补全**（`services/metrics.ts` 新增带标签计数器/直方图基建，序列基数有折叠保护）：HTTP 路由级时延直方图 `junshi_http_request_duration_seconds{method,route}`（路由用模板防基数爆炸；P95 告警从此不依赖 k6 采集）+ 路由级状态计数（定位哪条路由冒 5xx）；LLM 调用数/时延挂 `trace.ts` recordTrace 单点（与 llm_trace 同口径，含 mock 与错误）；token 分流向/成本（元）挂 `usage.ts` recordTokenUsage 单点（与 token_usage 同口径，成本告警数据源）；产出降级计数挂 gateway 全部 7 个 mock 兜底分支（含工程语境泄漏替换）、输出截断挂 completionGuard；业务事件——注册（分渠道）、审核判定（pass/block）、算力流水（reason 取 `·` 首段 + 100 种上限折 other）、商业化禁写闸拦截（none/expired，转化信号）、支付全链（下单/入账分 plan|sku/退款/对账 sweep 快照）+ **卡单 gauge**（paid 未 applied 抓取时查库 60s 缓存，>10 分钟触发 critical——资损信号）。观测口径=尝试落账，对账以业务表为准。**② 采集与看板**（`deploy/monitoring/`，全开源）：docker compose 一套起 Prometheus(30d)/Grafana/Alertmanager/node_exporter/postgres_exporter/blackbox_exporter（+可选 profile：Loki/Promtail 收 journald+nginx 日志）；全部 host 网络 + UI 只绑 127.0.0.1（生产 API/PG 只听 loopback，桥接网络摸不到），对外仅 Nginx 反代 Grafana（nginx.conf.example 新增 /grafana/ 段与 /api/metrics 公网 404 双保险）；Grafana 预置数据源 Prometheus + JunshiDB（PG 只读账号 junshi_ro，业务历史直查库）+ Loki。**4 块看板**（主机与数据库/API 服务/LLM 网关/业务大盘，共 69 面板）由 `grafana/dashboards/build.mjs` 生成——改看板改脚本再生成，UI 改动不回写。**③ 告警**（阈值=压测方案 §7 原文，四个规则文件）：主机 CPU 65/80%、PG 连接 60/75%、普通接口 P95 200/500ms（剔除 generate/stream，与过载闸同口径）、LLM 429 率 0.5/2%、队列等待 5/15s、Token 日预算 70/90%（基准 200 元/天写死在 llm.rules.yml）、已付未发放 >10min critical、TLS 证书 14 天到期、磁盘 24h 写满预测等；Alertmanager 含 critical 压 warning 的抑制规则，推飞书走 PrometheusAlert 桥（配置注释就位，默认不外发）。**④ 测试**：`test/metrics.test.ts` 扩到 17 例（直方图 bucket/sum/count、成本折元、reason 折叠守恒、TYPE 声明兼容直方图后缀），全量 `npm test` 通过；tsc 干净。主文档 **`docs/MONITORING.md`**（部署 15 分钟步骤、指标清单、只读账号 SQL、已知限制）。影响面：server 打点（app.ts/trace/usage/gateway/completionGuard/auth/moderation/credits/wechatPay）、deploy 模板、文档；无 API 契约与数据库变更。
- **2026-07-28** · **报告生成「假完成」修复（第一批）：断流接管不再伪装已生成 + 报告操作硬条件 + Claude SDK 重试关死**：线上截图症状「页面还在『正在梳理上下文』，报告卡却已显示『已生成』且操作全开」，与外部 review 方案的病灶判断逐条核对后确认三处叠加缺陷，本批只修误导与耗时放大，不动正常对话流程。**① liveGen 假完成（主病灶）**：`drive()` 的旧 P0-5 双保险「报告轮无论结果一律 `finishReport`」在断流对账把本轮交回页面轮询（handoff）之后仍会执行——把还在生成的报告卡收成非流式（`messageId=undefined`、正文可能半截），卡片即显「已生成」并开放查看/存入/认可，而轮询的思考态还在头顶转。收尾裁决抽成纯核 `app/src/services/liveGenCore.ts`（`classifyReconcileTick`/`reportCloseAction`/`streamClosedWithoutVerdict`，沿用 `runtimeModeCore` 的「纯核+平台壳」先例可 node 单测）：handoff/stored 一律不动卡片；有真实落库 id 才 `finishReport`；无 id 且错误路径没收过（主动停止/流静默结束）按中断收尾挂 ↻ 重试——**没有 messageId 就没有「已生成」**。**② 流层第二个假完成源**：h5/weapp 两路「流被连接层收掉但没收到 done/error 终态」时旧行为就地补发 `onDone(undefined)`（反代切流、weapp 180s 总超时、服务端中途死都会走到），改为按 `disconnect` 交断流对账，由 stored/handoff/dead 三态各自收尾。**③ 报告操作硬条件**：`ReportCard` 新增 `operable` 属性（无落库 id / 降级 / 空正文时状态签写「已中断」、查看/分享/存入操作行整体不渲染），聊天页以 `reportReady = 非流式 && 有 messageId && 非 degraded && sections 非空` 统一门禁操作与「认可 · 去执行」卡；轮询到顶（10 分钟）仍无定论时把残留流式卡收成中断态而非永转。**④ Claude SDK 重试关死**：`providers/claude.ts` client `maxRetries` 2→0（并删 `claudeRaw` 的 per-request 1），重试权唯一归端点池 `withEndpoint`（可转移错误→冷却→换端点，至多 3 次）；此前 SDK 2 次 × 端点池 3 次层层相乘，报告最坏 3×3×120s≈18 分钟全是客户端早已断开的僵尸请求，现收敛为 **3×120s=6 分钟硬上界**（与「最迟 5–6 分钟明确成败」目标一致）。**诚实边界**：未启用端点池的部署（候选无 endpointId）从此没有任何自动重试，瞬态 529 会直接报错给用户挂重试入口——生产端点池已启用故接受，若要回退单端点部署需重估。**测试**：新增 `liveGenCore.test.ts` 9 例覆盖方案要求的三场景（断流后接管显示生成中、最终成功以落库为准、最终失败中断不装完成）+ storedReplyFor 防误认领；app 28/28、server 870/870、双侧 tsc 干净。**未做（属方案后续批次，见 review 结论）**：持久化 GenerationJob/Worker（服务重启恢复）、带来源的上下文快照（长会话早期信息进报告）、报告独立提示词、重复点击幂等。影响面：app 聊天生成收尾链（liveGen/streaming/ReportCard/聊天页）、server Claude provider 重试策略；无 API/数据库契约变更。

- **2026-07-28** · **商业化改版上线（去免费档）+ 计费改版回归压测（v3）+ 三个生产缺陷修复**：**① 套餐与定价（已上线生产）**：砍免费体验版（生产 0 引用，`syncPlans.ts` 引用计数安全删除）；新增**入门版 ¥68/月**（40 万加权 token ≈ 13 次咨询，满耗 LLM 成本 ¥14.4、毛利 79%），兼任测试期默认档（`TEST_DEFAULT_PLAN_NAME=入门版`，生产 .env 已切换、备份在服务器 `/tmp/junshi-env-bak-20260728`）——测试期每注册用户成本被额度天然封顶；决策版月/年付额度 **100 万→150 万**（加权口径下重度用户实测月耗 269 万，100 万 11 天即穿；150 万覆盖 P75 整月）。定价锚点：生产 30 天实测**一次咨询 ≈ 3.0 万加权 token ≈ ¥1.09**（chat 30,266 / deliverable 29,671，几乎同重）。档位时长测算：P25/P50 入门版整月够用，P75 需决策版，P90+ 连决策版也 23 天内穿（留给加量包/企业版）。**② 注册与禁写闸**：注册不再白送「排序第一的套餐」（第一档已是付费档，回退等于免费送）——`TEST_DEFAULT_PLAN_NAME` 配置时走 `applyPlanPurchase` 正式链路（带锚点/到期），未配置则**不送任何套餐**；新增 `services/planGate.ts` + app.ts 全局 onRequest 禁写闸：无套餐登录用户一切写方法 403 `PLAN_REQUIRED`、到期 403 `PLAN_EXPIRED`（区分两态，不能把续费用户引去「开通」文案）；GET 与 auth/pay/plans/skus/wechat/admin 前缀放行（付费转化路径必须永远可达）；30s 缓存 + 购买/延期处 bust；应急开关 `PLAN_WRITE_GATE=false`。**③ 安全修复（生产漏洞，未被利用）**：`/plans/:id/purchase` 只拦 `price > 0`，企业版 `price=-1`（面议）从缝里漏过——任何登录用户拿公开的套餐 id 即可免费自助开通**不限量+永不过期**；补 `price < 0 → 402 CONTACT_SALES`。生产审计核实 41 个企业版全部来自 `admin_test_batch_2026-07-23`，无人踩洞。**④ LLM 可用性两修**：`callChat` 超时窗建在端点池重试外面，第一个端点耗尽预算后转移请求带着濒死 signal 出发、重试形同虚设 → 每次端点尝试各建各的窗；`callChatStream` 流式完全绕过端点池（单端点 429/宕机无兜底、冷却不共享）→ 建流阶段走候选转移（与 claude 流式同规则：响应头前可转移，流建立后如实报错）+ 会话亲和保提示词缓存。**⑤ 回归压测 v3**（测试机 47.98.162.120，10x 数据全量重建，被测代码含加权计费+动态预留）：只读 250/350/450 RPS 各 5 分钟全 0 错误（p95 19.8/19.9/86.3ms），与端点分压轮结论一致、无退化；**首次覆盖写路径**——mock 走真实 `/generate-sync` 预留→生成→结算链，32/200 并发共 528 次生成 0 非预期错误，收尾核对 **1 万钱包无一负余额且全部精确回到初值**（无预留泄漏）。诚实边界：mock 延迟注入被 `sudo env_reset` 剥掉（`VAR=x sudo docker compose` 变量不透传，已改 `sudo env`；饱和 503 场景本轮未覆盖，v2 结论仍有效）；动态大额预留分支仅单测覆盖。**⑥ 测试**：全量 `npm test` **870/870**；新增 `planGate.test.ts` 8 例、面议档回归 1 例；测试直建用户统一挂 `anyPlanId()`（禁写闸下裸用户写必 403）；查实本地并行跑多测试文件共享库互踩是假失败（`--test-concurrency=1` 即绿）。部署 `aa10729`，双域名健康通过；套餐目录经 `syncPlans` dry-run 核对后同步。影响面：套餐/计费/权限/LLM provider/部署配置/测试；报告见飞书《军师 · 第三轮压测与商业化改版报告（2026-07-28）》。

- **2026-07-29** · **第三轮压测：系统与 LLM 端点分压，查出「限错维度」与 13.9% 对话失败率**：新增 `server/scripts/llmEndpointProbe.ts`（直连上游、绕过我方并发闸的端点探针，含并发阶梯与恒速 RPM 两种模式；密钥经 `loadPool()` 进程内解密、只用于请求头、从不打印，仅输出 sha256 前 8 位区分端点；`--budget` 为元级硬预算，预估超了直接不跑）。**系统侧**：隔离栈（4 核 / 7GB / 300 万消息）阶梯 250·350·450 三档各跑满 5 分钟共 31.5 万请求、失败率 0；600 档 21.37%、800 档 53.07% 全部为过载闸 503，非预期 5xx 与误判 429 均为 0；拐点落在 450–600 之间。资源采样揭示扩容方向：450 档 API 单进程 CPU 峰 259%/均 234%，而 600 档 CPU **不再上涨**（均 191%）却已 21% 拒绝 → 瓶颈是单进程事件循环 + `MAX_IN_FLIGHT=200`，机器尚余约 1 核，应加进程而非加规格。第二轮的 `Profile.tenantId` 索引确认生效（6 次顺序扫 / 81,710 次索引扫，此前 105,086 / 0）。1000 档 k6 自身报 `Error while allocating unplanned VU`，客户端先成瓶颈，该档数据不用于任何结论。**LLM 侧（本轮最重要的发现）**：池内两条记录 baseUrl 与 key 的 sha256 **完全相同**，只有 model 名不同 → 无任何冗余、故障转移无从发生；并发 1→12 延迟恒定约 3.3 秒、零错误，16 起出现 429，错误正文为 `rate limit reached for RPM` → **上游限的是每分钟请求数，不是并发数**，而后台配的 `maxConcurrency=4`×2 限的正是并发，维度错了。恒速探测钉出可持续速率 **120 RPM**（2.0 req/s 满分，3.0 req/s 在第 33.7 秒触发限流）；429 不带 `retry-after` 与任何 `ratelimit-*` 头，配额无法程序化发现。结合生产实测对话平均耗时 27.4 秒，当前 8 并发只用掉配额约 15%，放开后在途可达约 55 并发（约 7 倍）。**额度侧**：按 07-28 上线的加权口径实测每次调用中位 28,503 等价 token（输入 28,313 中约 2.5 万是系统提示词，而缓存命中率仅 10.6%）→ 体验版 20 万仅约 7 次、决策版 100 万约 35 次；34 个活跃用户中体验版覆盖 41%、决策版 82%；额度打满的 LLM 成本分别 ¥7.2 / ¥36（决策版毛利 82%），故额度偏紧不是成本约束。缓存命中率提到 70% 可让决策版从 33 次翻到 67 次且成本不变。**顺带查实的生产问题**：近 30 天 330 次对话 46 次失败（13.9%），其中 44 次集中在 07-28 09:00–15:00，根因是输出长度从基线 490–1,024 暴涨到均 1,776、12 点均 5,124/最大 7,506，撞 `CHAT_MAX_TOKENS=8000` 与超时（失败平均耗时 164 秒）；当天服务重启均在 19:54 之后，**与部署无关**。另记录一处待产品确认的耦合：动态预留上界 128k×1.25 + 8k×5 = **200,000**，与体验版月度额度完全相同，`strat`（`billingRatio=2`）则为 400,000。仅新增脚本，无 API / 数据库 / 生产配置变更；压测栈连卷删除、同机其它租户未动、短信等不可逆资源全程未触碰。影响面：新增运维脚本、工程文档；报告见飞书《军师第三轮压测报告 · 系统与 LLM 端点分压 · 2026-07-29》。

- **2026-07-28** · **新增 Canvas Design 接入军师 App 方案**：形成 `docs/CANVAS_DESIGN_SKILL_INTEGRATION_PLAN.md`，明确不把 Claude Directory 链接当作可直接安装的 App SDK，而是将其 Apache 2.0 视觉工作流改造为军师原生 `artifact` 产物型 Skill；方案覆盖海报设计师入口、PosterBrief/CreativeJob/CreativeAsset 契约草案、图片模型与确定性中文排版边界、Claude Custom Skill API 可选 POC、Puppeteer PNG/PDF 渲染、OSS 私有资产、异步恢复、按任务计费退款、隐私审核、运营配置、分阶段实施与验收。不含代码、接口或数据库实际变更。影响面：工程方案文档。

- **2026-07-28** · **计费 review 四项闭环：缓存写聚合、模型费率 SSOT、动态额度预留、空资料指针**：① `runToolLoop.addUsage()` 补齐 `cacheWrite` 累加，Claude 多轮工具调用不再把缓存创建量静默丢掉并按普通输入 1× 少算；测试样本同步带缓存写，锁定四档 Usage 聚合。② 端点池价格明确为 **model 级 SSOT**：模型名大小写归一，同名多端点只有输入/输出价完整且三档一致才校准；冲突或半配置记一次 error 并确定性回退（成本 0、用户额度裸 token），不再由无序查询最后一行随机覆盖；`billableTokenEquivalents` 本身也对 `out=0` 做裸 token 兜底，避免输出被免费送掉。③ 用户可见真实生成不再固定只预留 2k：新增 `generationQuotaReserveTokens()`，按 128k 最大输入、8k 最大输出、最高已校准模型输出权重及缓存写 1.25×计算动态悲观占额；mock/测试仍为 2k，自定义 OpenAI 智能体强制动态预留。预留上界超过余额时只占满余额到 0，让其它并发被锁内拦下，预留动作本身不再制造负余额；余额≤0 的复盘/速诊保底也只预留基础 2k，完成后再按真实加权用量追扣。④ 底座使用 `{知识库}`/`{引用资料}` 而本轮为空时，dynamic 段显式注入“无相关知识/无引用资料”，稳定指针不再指向不存在的章节。新增模型费率 SSOT、动态预留、空资料、缓存写聚合回归；无 API/数据库契约变更。影响面：server 模型计费、Token 并发门禁、提示词组装、测试与工程文档。

- **2026-07-28** · **算力扣减改为按后台单价加权，修掉长输出用户被系统性少扣**：原实现 `creditCost = ceil((输入 + 输出) × ratio)` 把输入输出等价合并，而输出比输入贵约 5 倍（¥180 vs ¥36 / 1M）。**先用生产近 30 天真实数据量了影响再动手**：`chat`（占 93% token）只 **+2.9%**——因为缓存读的 0.1× 折扣大幅抵消了输出溢价；`deliverable` **+31.8%**；单用户最差 **+46.3%**（其余 +30% / +19% / +17% / +14%）；`aux` 虽 +54.8% 但无 `userId`、不扣用户额度，与计价无关。**改法**：新增 `billableTokenEquivalents(usage, rate)`，把一次调用折成「**输入 token 等价量**」——以 `rate.in` 为基准，各档权重自然是 未缓存输入 1 / 输出 `out/in`（约 5）/ 缓存读 `cachedIn/in`（约 0.1）/ 缓存写 约 1.25。选 `rate.in` 做基准的好处是**量级几乎不变**（输入占 token 约 97%），老用户余额观感基本不动，只有长输出场景才被正确加价；且权重自动跟着后台单价走，换供应商价目表无需改代码。**关键约束：扣减与记账必须同源。** 加权只能在 gateway 的 `maybeRecord` 里做——只有它同时握有**实际生效的 model**（端点池会换 model，路由拿不到）和后台单价；算好后回填到 `usage.billableTokens`，路由侧统一经 `billableOf(usage)` 读取而**不重新计算**，保证「实扣额度」与「`token_usage.creditCost`」永远是同一个数。改了 9 处 `settle()` 调用点（`sessions.ts` 8 处 + `battle.ts` 1 处，均为传真实 usage 的路径；`knowledge`/`brandKit`/`quickscan`/`graph` 传的是结构化操作的固定估算 token，无输出/缓存分档可加权，保持原样）。另修一个会让改动**静默失效**的类型陷阱：两处 SSE 路径写 `let usage = { inputTokens: 0, outputTokens: 0 }`，TS 由初值推断出窄类型，`done` 事件整体替换后运行时虽有 `billableTokens`、类型上却已消失 → 额度会悄悄退回旧口径；已显式标注为 `Usage`。**兜底与回滚**：`rate.in <= 0`（未配单价）或单价解析失败（DB 抖动）→ 回落裸 token 求和，与旧口径逐位一致，绝不因记账问题拖垮产出；`CREDIT_WEIGHTED=false` 可**不改代码即时回滚**整个计价变更。新增 `test/billableTokens.test.ts` **14 例**：各档权重、权重随单价变动、生产 chat 形态的变化幅度、未配单价不除零、开关关闭后与旧口径逐位相同、读+写超总输入不产生负数、`billableOf` 对 NaN/负数回落而 0 是合法值。验证：`tsc` 0 错、定向单测 **135/135** 全绿、`npm run build` 通过。⚠️ **这是用户可见的计价变更，部署即生效**：`deliverable` 用量大的少数用户（最差 +46%）会感到余额消耗变快，是否给一次性补偿或宽限需产品侧定；`CREDIT_WEIGHTED=false` 是即时退路。影响面：`data/modelPrices.ts`、`llm/schema.ts` 的 `Usage`、`llm/gateway.ts`、`services/usage.ts`、`routes/{sessions,battle}.ts`、新增测试；无 API 契约变更、无数据库变更。

- **2026-07-28** · **修掉三个 agent「stable 段其实不稳定」导致提示词缓存永不命中**：提示词缓存是前缀匹配——`cache_control` 断点之前的字节变一个，整段前缀就失效；而 `buildSystemParts` 的 stable 段恰在断点之前，`fillPlaceholders(base, ctx)` 却会把 `contextValues` 里**逐轮变化**的占位符一并填进去。登生产核对：`strat`/`growth` 的底座含 `{长期记忆}`（随对话累积）、`intel` 含 `{知识库}` + `{引用资料}`（每轮 RAG 召回不同），**这三个 agent 的缓存命中率恒为 0**；主力 `general`（占大头流量）不含，故此前 10.6% 的整体命中率主要由它贡献。**改法**：新增 `VOLATILE_PLACEHOLDERS = ['{用户消息}','{知识库}','{引用资料}','{长期记忆}']`，出现在 base 时在 stable 段**降级为稳定指针**（如「（见下方「参考资料」中的知识库召回）」——只删不留指针会让模型以为该项缺失），真正内容一律走 dynamic 段（断点之后）。**内容不能丢是硬约束**：`{知识库}`/`{引用资料}` 在 dynamic 段本就有对应块（属重复注入，剥掉即可），但 **`{长期记忆}` 是记忆进入提示词的唯一通道**（无独立 dynamic 块），故剥离后在参考资料段补回 `【长期记忆】`，且**只对原本用了该占位符的 agent 注入**——给其他 7 个 agent 凭空加一段会改掉它们既有的提示词行为。另加一次性 `console.warn`（按 agentKey+占位符组合去重，不按请求刷屏）提示运营把这些占位符从后台底座移除，避免以后再犯。新增 `test/promptStable.test.ts` **12 例**：四个占位符各自的跨轮字节一致性、多占位符同时出现（intel 真实形态）、稳定占位符仍被正常填充、stable 段不残留占位符原文、记忆不丢、未用该占位符的 agent 不被加段、`general` 形态不受影响。验证：`tsc` 0 错、定向单测 **121/121** 全绿、`npm run build` 通过。⚠️ 注意这只修了**我方**让前缀失效的部分；供应商侧的后端扇出（同一段提示词被分发到不同上游后端、各自独立缓存）仍是命中率的主要制约，需向七牛确认固定后端。影响面：`server/src/llm/schema.ts`、新增 `test/promptStable.test.ts`；无 API 契约变更、无数据库变更、不改后台提示词内容。

- **2026-07-28** · **全仓排查「缺失被当成 0」这一类缺陷，修掉两处生产请求路径上的高危项**：承接同日缓存写计价那条里的观察——短期内连续三次遇到同一根因（`deploy-preprod.sh` 管道取错退出码、备份脚本让坏备份触发轮转、缓存写并档丢失），共同点是**把语义不同的量合并、或把缺失当成 0，再按其中一个规则处理**。按四类模式全仓扫了一遍：

  ① **shell 管道退出码**——9 个脚本全部已有 `pipefail`，并逐个复核了 `bash -c` / `bash -s` 的**内层子 shell**（`pipefail` 不继承，这正是 `deploy-preprod.sh` 当初有 pipefail 仍静默失败的原因）；`copy_ai_table` 的管道已用 `if ! …; then` 显式判成败。**这一类干净。**

  ② **`Number(process.env.X ?? 默认值)`**——`??` 只挡 `undefined` 挡不住空串，而 `.env` / docker-compose 里「设了但留空」极常见，`Number('')` 是 **0** 不是 NaN，默认值形同虚设。`llmGate.ts` 早前已为此写了安全的 `num()` 但**没被复用**。两处在**生产请求路径**且失败方向相反：`MAX_IN_FLIGHT=""` → 0 → 被 `if (maxInFlight > 0)` 判掉，**过载闸静默关闭、保护消失**；`RATE_LIMIT_MAX=""` → `max: 0` → **每个请求都 429，等于全站宕机**。现把安全解析提升为 `env.ts` 的 `envNum()`（未设置/空串/非有限数/负数 → 默认值；显式写 `0` 才真的是 0），替换 `app.ts` 两处 + `env.ts` 内 8 处（`PORT`、`OPENAI_TIMEOUT_MS`、`SKILL_TOOL_TIMEOUT_MS`、`SMS_*` 四项、`AEP_CDN_OSS_TIMEOUT_MS`——其中 `SMS_MAX_ATTEMPTS=""` 会让验证码一次都验不过，`PORT=""` 会让服务起在随机端口）。

  ③ **provider 未回传 usage 被当成 0 消耗**——`openai.ts` / `dify.ts` 的 `usageOf` 用 `?? 0` 归一，网关不回传 `usage` 时得到 `{0,0,0}`，随后 `recordTokenUsage` 的 `if (totalTokens <= 0) return` 把整条记录丢掉：**真实付费调用花掉真金白银，却在 `token_usage` 里查不到任何行、也不报警**。原注释的理由（mock / Dify 无 usage）只覆盖良性情况，没区分真实供应商漏报。现保持不写垃圾行，但新增 `/metrics` 计数器 `junshi_usage_unreported_total{provider,model}`（mock 不计），且**无漏账时导出 0 而非省略整条指标**——否则告警无法区分「没漏」和「没采到」。生产当前走 claude（会回传 usage），故该缺陷**休眠**，切到任何 OpenAI 兼容端点即刻生效。

  ④ **多档合并计价**——除已修的缓存写，另发现 `gateway.ts:164` 的 `creditCost = ceil((input + output) × ratio)` 把输入输出等价合并，而两者单价差 **5 倍**（¥36 vs ¥180/1M）。按实测：`chat` 的输出占 token 2.8% 却占成本约 13%、`deliverable` 占 token 10% 却占成本约 36%，即输出被系统性低配约 3.6 倍。**此项未改**——算力作为对用户简化的计量单位是产品决策而非缺陷，留待产品侧定。

  新增 `test/silentZero.test.ts` **9 例**锁定 `envNum` 的六种输入与漏账计数的导出形态。验证：`tsc` 0 错、定向单测 **109/109** 全绿、`npm run build` 通过。影响面：`server/src/env.ts`（新增 `envNum` + 8 处替换）、`server/src/app.ts`（2 处高危）、`services/{usage,metrics}.ts`、新增 `test/silentZero.test.ts`；无 API 契约变更、无数据库变更。

- **2026-07-28** · **修掉缓存写少算 25% 的计价缺陷：输入 token 从两档拆为三档**：承接同日那条更正里点出的唯一真缺陷。`ModelRate` 原本只有 `in/out/cachedIn`，**没有缓存写这一档**；而 `providers/claude.ts` 的 `usageOf()` 把 `cache_creation_input_tokens` 并进 `inputTokens` 且不单独记，于是 `estimateCostMicros()` 把缓存写的 token 按 **1.0× 基础价**计——Anthropic 官方是 **1.25×**（5 分钟 TTL；1 小时 TTL 为 2×），**每次缓存写少算 25%**，且该用量不落库、事后无法量化差多少。**改法**：输入 token 明确拆三档、各按各自单价累加 —— 命中缓存 `cachedIn`（约 0.1×）、写入缓存 `cacheWrite`（缺省 `in × CACHE_WRITE_MULTIPLIER`，常量取官方 5m TTL 的 **1.25**，运营可显式填 `rate.cacheWrite` 以支持 1h TTL 的 2×）、其余未缓存 `in`（1×）；`Usage` 新增 `cacheWrite` 字段并由 `usageOf()` 独立上报（`inputTokens` 语义明确为**三档之和**）；`TokenUsage` 与 `LlmTrace` 各新增 `cacheWrite Int @default(0)`（**纯加法列**）并由 `recordTokenUsage()` / `recordLlmTrace()` 写入，此后缓存写用量可直接按 SQL 量化。**向后兼容是硬要求且已锁定**：provider 不报 `cacheWrite` 时（openai / dify / mock 及全部历史记录）第二档为 0，折算结果与旧的两档拆法**逐位相同**——新增 `test/modelPrices.test.ts` **12 例**覆盖三档混合、全命中、全写入、显式覆盖 1h TTL 单价、`cachedIn` 未配时回退 `in`、未配单价仍计 0、以及读+写之和超过总输入时未缓存档不算成负数（逐档 clamp）。⚠️ `CACHE_WRITE_MULTIPLIER = 1.25` 的前提是**上游透传缓存计价**；若七牛按统一单价结算，该常量应改为 1，否则会高估成本——这与「缓存能省 51%」是同一个待向供应商确认的前提。历史缓存写用量因从未记录，**无法回溯补算**，只能从本次上线起累积。验证：`prisma generate` + `tsc` 0 错，定向单测 **100/100** 全绿。影响面：`server/src/data/modelPrices.ts`、`llm/schema.ts` 的 `Usage`、`providers/claude.ts` 的 `usageOf`、`services/{usage,trace}.ts` 落库、`prisma/schema.prisma` 两张表各加一列（纯加法，`db push` 安全）、新增 `test/modelPrices.test.ts`；不改 API 契约，不动 admin 前端。

- **2026-07-28** · **按官方价刷入生产单价并核准成本口径；更正「低估 5.2 倍 / modelPrices.ts 需校准」两处错误结论**：着手校准时先发现 **`data/modelPrices.ts` 里本来就没有价表**——它只有 `estimateCostMicros()` 折算函数（元/1M → 微元整数），单价来自数据库 `AiModel.priceInput/priceOutput/priceCachedInput`，由运营在后台填、经 `resolveModelRate()`（最长前缀匹配 + 短缓存 `rateCache`）解析。**其次发现历史缺口的成因不是缺陷**：生产两个 claude 端点其实已配 `35/150/20`（元/1M），用这组价重算近 30 天得 ¥754.89，而按官方价重算 ¥759.81 —— **两者只差 0.7%，单价基本是准的**；但系统 `costMicros` 只记了 ¥78.56。按周拆开即见时间模式：06-29 / 07-13 / 07-20 三周准确度均约 **3%**，07-27 那周跳到 **78%**，且 `costMicros=0` 的行数为 **0**（排除「查不到单价 → 计 0」）——即**单价约在 07-27 才被配上**，此后记账就基本正确。故真实历史缺口约 **9.5 倍**（¥78.56 vs ¥745.57）而非 5.2 倍，且属历史数据陈旧而非在线缺陷。**本次动作**：按 Anthropic Opus 4.6 官方列表价（input \$5 / output \$25 / 缓存读 0.1×＝\$0.5，每 1M）× 汇率 7.2 刷库，两行 claude 端点 `priceInput` 35→**36**、`priceOutput` 150→**180**、`priceCachedInput` 20→**3.6**（原值中 input 已准、output 低 17%、缓存读高 5.6 倍——¥20 既不合官方价也不合任何一致加价率）；改前值已在事务中留档可回滚，`rateCache` 短缓存自动过期无需重启。**核准后的权威口径（近 30 天）**：合计 **¥745.57 ＝ \$103.55**；`chat` 623 次、均输入 28,417 / 输出 829 token、缓存命中率 10.6%、**\$0.1493/次**；`deliverable` 60 次 \$0.1488/次；`aux` 500 次仅 **\$0.0032/次、合计 \$1.60（占总成本 1.5%）**——再次印证 2026-07-27 那条「拆辅助抽取省 token」被高估的自我更正。缓存全命中理论下限 **\$0.0349/次**，扣除不可缓存动态段后现实目标约 \$0.073，**约省 51%**（与此前 49% 估算吻合）。**仍存一个真缺陷（未修）**：`ModelRate` 只有 `in/out/cachedIn`、**无缓存写字段**，而 `providers/claude.ts` 的 `usageOf()` 把 `cache_creation_input_tokens` 并入 `inputTokens`，导致缓存写按 1.0× 基础价计而非官方 1.25×（1h TTL 2×），且 `cacheCreate` 不落库、事后无法量化；修法为 `ModelRate` 加 `cacheWrite`、`Usage` 加 `cacheCreate` 并持久化。口径说明：我们实际付款对象是七牛而非 Anthropic，本次刷的是**官方列表价**（权威参照与成本下限），拿到七牛价目表后应替换并反推加价率。影响面：生产 `ai_model` 两行单价（数据变更，可回滚）、`AGENTS.md` §13、飞书压测报告成本章节；**无代码改动**。

- **2026-07-28** · **更正「生产零备份」并修掉备份脚本一个会自我清空历史的缺陷**：准备给生产加备份时发现**已经有了**——systemd `junshi-pgdump.timer` 自 2026-07-23 起每日 03:30 跑 `pg_dump`，落 `/var/backups/junshi/*.sql.gz`，保留 14 天，约 12MB/份（库 49MB），抽验 6 份全部 `gunzip -t` 通过、63 张 `CREATE TABLE` + 63 个 `COPY` 段齐全、体积单调增长。故 `AGENTS.md` 与压测报告里「当前零备份」的描述**已过时**，一并更正。**但该 unit 未纳入版本管理（手搓在服务器上，机器重建即丢），且有一个与 `deploy-preprod.sh` 同类的缺陷**：`ExecStart` 是一行流 `pg_dump junshi | gzip > f.sql.gz && find ... -mtime +14 -delete`——管道退出码取自 `gzip` 而非 `pg_dump`，无 `pipefail`，故 pg_dump 失败（库不可达/权限/磁盘满/OOM 被杀）时 gzip 仍成功写出残缺或空的 gz、整条命令返回 0、systemd 判定成功，**紧接着 `&&` 后的轮转照常按 14 天龄删除旧备份**；连坏两周即把历史清空，全程无任何报错。本地实证对比：原一行流在 pg_dump 失败时**退出码 0 且产出 20 字节空 gz（能过 `gunzip -t`）**，新脚本退出码 1 且不产出任何文件。现纳入 `deploy/junshi-pgdump.{sh,service,timer}` + `deploy/README-backup.md`，改为 `set -Eeuo pipefail`、先写 `.partial`、经**三项校验**（gzip 完整性 / 体积下限 / `CREATE TABLE` 计数 ≥ 10）全过才原子 `mv` 落地、**轮转移到校验之后**、并清理历史残留 `.partial`；service 加 `IOSchedulingClass=idle` + `Nice=10` 避免与线上请求抢 IO，timer 加 `RandomizedDelaySec=300`。首次部署踩到一个自伤：内容校验原写 `zcat | grep -q`，而 `grep -q` 命中即关管道使 `zcat` 收 SIGPIPE 退 141，被 `pipefail` 判为整体失败 → 明明有表却误报「缺少 CREATE TABLE」（journal 里是 `gzip: stdout: Broken pipe`），改用 `grep -c` 读完全部输入并补 `|| true`。该次失败**未产出文件、未触发轮转、6 份旧备份完好**，正是「校验后才轮转」的设计意图。已在生产安装并手动跑通一次（新增 `junshi-2026-07-28-1646.sql.gz`，12MB，63 表校验通过），旧 unit 存为 `.bak-20260728` 可回滚，timer 仍武装（次跑 2026-07-29 03:32）。**仍缺三样已写入文档**：无异地副本（备份与库同盘，实例损毁即全失，最大缺口）、无 PITR（最坏丢 24h）、从未做过恢复演练。影响面：新增 `deploy/junshi-pgdump.{sh,service,timer}`、`deploy/README-backup.md`，更正 `AGENTS.md` §13 与飞书报告；生产 systemd 配置已更新，无应用代码或数据库变更。

- **2026-07-28** · **定调提示词真相源：后台是唯一事实来源，`prompts/*.md` 降级为种子文件**：此前 `prompts/README.md` 第 21 行与 `agents.ts` 顶部注释**同时**写着「线上库 `agent.systemPrompt` 仍是运行时事实来源」和「此后提示词变更走 git 版本管理（改文件 → 同步线上）」——两句互相矛盾，一个说以库为准、一个说以文件为准。这正是 `admin:sync-content` 会静默用旧文件覆盖线上调教的根源：脚本按后半句实现，而现实按前半句运行。**现统一为前者**：数据库 `agent.systemPrompt` → `agent_version` 已发布快照是唯一运行时事实来源，`server/prompts/*.md` 仅用于新环境初始化（seed / sync 的 create 分支），**不做定期回灌对齐**。实测支持该选择——9 个专业 agent 与仓库逐字节一致、从未被改过，只有 `general` 被持续微调（多 24 行，相似度 98.1%），说明真实工作流本就是「后台微调 general、其余不动」。相应地 `sync-content` 默认跳过 `systemPrompt`/`greet` 是**有意设计而非遗漏**，README 中已如此标注。另修 README 两处失效内容：① 取回命令查的是 `key='strat'`，但 V6.0 已于 2026-07-03 迁到 `general`（`strat` 回归专业模板），该命令实际取不到主提示词，改为指向新增的 `--dump-prompts`；② 长度记录仍是 2026-07-02 的 41,711 字节 / 16,168 字符，已更新为实测值并补上字节/字符对照表与 SQL_ASCII 陷阱说明。新增两条硬约束：**md 全文即提示词，不得在文件内写任何说明文字或注释**（`loadPromptFile` 只做 `trim()`，`<!-- -->` 对模型同样是正文）；量长度必须区分字节与字符。影响面：`server/prompts/README.md`、`server/src/data/agents.ts` 顶部注释、`AGENTS.md` §13；无逻辑改动，`tsc` 与 `syncAdminContent` 10 例回归通过。

- **2026-07-28** · **更正：「提示词漂移 2.85 倍」是单位错误，实际仅 9–13%，且只有 `general` 一个 agent 漂了**：2026-07-27 那条生产探查结论里，`general` 的 49,094 取自 `SELECT length("systemPrompt") FROM agent`，而生产库 `server_encoding = SQL_ASCII`——**该编码下 PG 的 `length()` 返回字节数、恒等于 `octet_length()`**，中英混排约 2.5 字节/字符。拿它与仓库文件的**字符数** 17,230 相比，等于字节比字符，于是把 9% 的差算成了 2.85 倍。**同口径复核**：`general` 生产 49,094 字节 / 19,486 UTF-8 字符，仓库 `prompts/strat.v6.md` 44,959 字节 / 17,232 字符 → 实际 **+9.2%（字节）/ +13.1%（字符）**；把线上提示词逐个 dump 下来与 `src/data/agents.ts` 按字符比对，**其余 9 个 agent（strat/growth/intel/fund/model/org/brand/ops/promo）全部 0.0% 差异、逐字节一致**——此前「生产 1,650–1,764 vs 本地 620–670」同样是字节比字符造出的假象。仍然成立的是版本内自比（同为字节口径）：v1 41,710 → v2 45,342 → v3 44,957 → v4 49,094，三周 +18%。**结论修正后风险量级下调但性质不变**：跑同步仍会把 `general` 回退约 2,250 字符的调教且无 diff 无确认，护栏依然必要；但「推平三周三个版本的调教」这个描述过重，实际只影响一个 agent 的一次增量。同步更正 `AGENTS.md` §13 与飞书压测报告 §8.1。**通用教训：SQL_ASCII 库上做任何长度统计都必须显式区分 `length()` 与字符数**，跨系统比长度前先对齐单位。影响面：仅文档结论；无代码改动。

- **2026-07-28** · **给 `admin:sync-content` 加提示词覆盖护栏——拆掉一颗会推平三周调教的雷**：`scripts/syncAdminContent.ts` 的 upsert **update 分支原本无条件写 `systemPrompt: a.systemPrompt`**，无 diff、无确认。而生产提示词早已漂离仓库：`general` 线上 **49,094 字符**、仓库 `prompts/strat.v6.md` 仅 **17,230**（2.85 倍，v1 41,710 → v4 49,094，三周 +18%），其余 agent 线上 1,650–1,764、本地 620–670。运行时读 `AgentVersion` 已发布快照所以同步不立刻生效，但草稿被换成旧版后，**之后任何一次「发布」就把三个版本的调教推平且不可恢复**——这是一条随时可能被误触（人、脚本或未来的 agent）的不可逆数据风险。**改法沿用本脚本已有的约定**（`syncSurvey`/`syncSkus` 早就写了「不动 enabled，保留运营启停」，`systemPrompt` 恰恰是最该受此保护却漏掉的字段）：新增 `OPERATOR_OWNED = ['systemPrompt','greet']`，create 时写初值（新 agent 需要）、**update 默认跳过**；`--force-prompts` 才允许覆盖，且仓库版本比线上短超过 20%（`SHRINK_REFUSE_RATIO`）时**直接拒绝并以退出码 1 结束**——「短很多」正是「仓库是旧快照」的特征，需再加 `--allow-shrink` 才执行。另加 `--dry-run` 预演（全程不写库）与 `--dump-prompts <目录>`（把线上现行 systemPrompt/greet 导出成文件 + index.json，供回灌仓库时人工比对，只读）。所有提示词字段的处置逐条打印，因为这是本脚本最危险的部分、必须可见。决策逻辑抽成纯函数 `decidePromptWrite()` 并由 `test/syncAdminContent.test.ts` **10 例**锁定（默认跳过、库空写初值、仓库空不清空、内容一致不写、force 遇缩水仍拒绝、force+allow-shrink 才写、小幅修订放行、greet 同等受保护等）；`main()` 改为仅直接执行时运行，import 进测试不触发副作用。**尚未完成的另一半：把线上 v4 回灌进仓库文件对齐**，在此之前仓库那份旧稿不是提示词真相源。影响面：`server/scripts/syncAdminContent.ts`、新增 `server/test/syncAdminContent.test.ts`、`AGENTS.md` §13；无数据库结构变更、无 API 契约变更、无运行时行为变更（该脚本不参与请求路径）。

- **2026-07-28** · **补齐 LLM 闸门实际压测与确定性 429 冷却验证**：此前真实 OpenAI 兼容最小探针以 401/零 token 按护栏停止，未猜测或复用生产凭据；新增 `loadtest/k6-llm-queue.js` 以隔离 mock `/generate-sync` 覆盖 8/12/20/40 并发，实测 40 个同时到达请求全成功、最大排队 28、最长等待 9.64s，未越过 15s 队列超时。`mock` provider 在显式 `AI_MOCK_LATENCY_MS>0` 时走真实 `llmGate`，新增 `AI_MOCK_429_FIRST_N` 只用于隔离环境确定性注入前 N 次 429；实际验证首个 429 触发冷却、下一请求等待后恢复。`monitor.sh` 增加 LLM 闸门 CSV，Compose 透传该测试开关，README 固化本机网络/0600 token 与 S5 运行方式。补测后已清理隔离 Compose/卷并恢复测试机原服务。影响面：`server/src/llm/providers/mock.ts`、`loadtest/{docker-compose.yml,k6-llm-queue.js,monitor.sh,README.md}`、压测报告与工程说明；无 API 契约或数据库变更，真实供应商并发仍需独立限额 key 复测。

- **2026-07-27** · **复测前置一次性补齐：源码 NUL 字节、preprod 静默失败、`/metrics`、mock 过闸、压测栈同构**：为下一轮压测把「确定的修复 + 可观测性」清掉，六件事。① **四个源文件含字面 NUL 字节**（`llm/gateway.ts` 缓存键分隔符、`services/embedding.ts` 两处嵌入缓存键、`services/llmPool.ts` 的 HRW 哈希键、`services/docParse.ts` 一句讲 NUL 的注释里真嵌了个 NUL）。运行时完全正常，但 `file(1)` 因此把它们判成 `data`，grep/ripgrep/ugrep 一律按二进制**静默整文件跳过**——也就是说 LLM 网关和刚建的端点池对所有基于 grep 的检索（代码搜索、批量重构、安全扫描）是隐形的，且没有任何报错提示你漏了。全部改为转义序列（运行时值完全等价），并新增 `test/sourceHygiene.test.ts` 扫描六棵源码树防复发（这条测试当场就抓出了后三个文件）。② **`scripts/deploy-preprod.sh` 的 AI 配置复制不再静默谎报**：旧实现 `pg_dump --column-inserts | psql >/dev/null 2>&1` 叠了三个问题——管道退出码取 psql、psql 不带 `ON_ERROR_STOP` 时每条语句报错也退 0、stderr 被丢掉，于是生产库比 preprod 多一列时每行 INSERT 全失败却照样打印「已从生产复制」，preprod 静默回退 mock。改为只复制**两库共有列**（Prisma 的 camelCase 列名逐个加双引号，否则 PG 折成小写直接 `column does not exist`）、显式判管道成败而不依赖调用处 `set -e`、复制后校验「ai_setting 恰好 1 行 + 至少一个带 key 的 ai_model」，不通过即中止（此时新代码尚未构建重启，旧服务照常在跑）。新增 `scripts/test/deploy-preprod-aicopy.test.sh`：造出真实列漂移场景，先证明旧实现「报成功但复制 0 行」，再验新实现正确复制、预发新增列由默认值补齐、真失败时非零退出（**7/7**，且它抓出了新实现最初的两个 bug）。③ **新增 `GET /api/metrics`**（Prometheus 文本，32 个业务指标 + 启用 Prisma `metrics` 预览特性带来的 18 个 `prisma_*`，含 `pool_connections_busy/idle/open`、`client_queries_wait`）：在途请求（全量 + 过载闸两套口径）、事件循环延迟分位数、RSS、LLM 各车道并发/队列深度/排队等待/429/冷却、端点池模式与逐端点冷却态。鉴权**必须配 `METRICS_TOKEN`**，未配则整个端点 404——不能退化成内网 IP 白名单：本部署是 Nginx 反代且按 P0-0 开了 `trustProxy`，`req.ip` 取自可伪造的 `X-Forwarded-For`，真实 TCP 对端又恒为 Nginx 的 `127.0.0.1`，公网流量与本机 curl 在 IP 层无法区分。指标输出经测试断言不含 apiKey/baseUrl。④ **mock provider 支持模拟真实上游**（`AI_MOCK_LATENCY_MS` / `_JITTER_MS` / `AI_MOCK_429_RATE`，默认全 0 行为逐字节不变）。关键点是压测方案 §3.2 只写了「给 mock 加延迟」，但**mock 在 gateway 里是被直接调用的、根本不过 `llmGate` 并发闸**（只有真 provider 才过），所以只注入延迟队列深度照样恒为 0，S5「LLM 闸门与队列」等于什么都没测——而闸门和端点池正是本轮新建的核心。现在开启后 mock 会占一个真实槽位，并发上限/排队/排队超时降级/429 整窗冷却全部可复现且零 Token 成本。只套在「mock 就是配置的 provider」的 5 个分支，真 provider 失败后的 6 个降级兜底一律不套（故障路径本该尽快返回）。⑤ 新增 `SCHEDULER_ENABLED`（默认 true 行为不变）：压测栈切到 `production` 后定时任务会真跑，周期性全量扫库并尝试推送，给容量测量掺进无关背景负载；这个开关也是 AGENTS §13「选主没做完不许加第二个进程」在拆出 cron worker 前的过渡形态。⑥ **压测栈按 V2 §0 逐项同构**：`NODE_ENV` 切 `production`（此前 `test` 会让 `isAiTestMode()` 为真、**限流插件根本不注册**，「入口层只有约 5 RPS」这类缺陷结构上不可能被发现）、接隔离 Redis（此前 `REDIS_URL=""`，限流退化为单实例内存计数）、真实 HS256 JWT（新增 `loadtest/prepare.sh` 生成 0600 的压测专用密钥 + `server/scripts/mintLoadtestTokens.ts` **直接 import 服务端 `signUserToken` 并自检验签回原 userId**，不另写一份签名实现以免口径漂移变成运行期全站 401）、CPU 配额从主 compose 移到 `docker-compose.limits.yml`（默认不设，因为上一轮观测到的 CPU 229% 是 cgroup 配额跑满，却被读成「Node 单进程到顶」）、15 个 `LT_*` 参数化开关、API 4000 端口只绑 `127.0.0.1:14000` 供 monitor 直连抓指标（走 nginx 会把观测流量算进被测容量）、k6 改用真实 JWT 并按 VU 带稳定的合成 `X-Forwarded-For`（限流按用户/IP 分桶，匿名请求全挤一个 IP 会把限流层测成「一撞就 429」）。`loadtest/.env` 与 `tokens.json` 已 gitignore。验证：server `tsc` 0 错、定向测试 **79/79**、admin **15/15**、app **19/19**、shell 回归 **7/7**、两个 compose 文件 YAML 与变量解析核对通过。影响面：`server/src/{llm/gateway.ts,llm/providers/mock.ts,services/{metrics,embedding,docParse,llmPool,scheduler}.ts,routes/metrics.ts,app.ts}`、`server/prisma/schema.prisma`（仅 generator 加 `previewFeatures=["metrics"]`，**无 DDL**）、`server/.env.example`、`scripts/deploy-preprod.sh`、`loadtest/*`、`.gitignore`、新增 4 个测试文件；无 API 契约破坏、无数据库迁移、小程序无需发版。

- **2026-07-27** · **Thinking 温度无损化、辅助抽取强制关闭思考，并收紧 OpenAI 兼容默认参数**：修复四条同源配置污染。① `AiSetting/AiModel`、端点池与后台表单不再在开启 Thinking 时把 temperature 永久覆写为 `1`，始终保存运营原值；只有 provider 组装实际 enabled/adaptive 请求时临时使用 `1`，关闭后可恢复。② 结构化成果与多轮工具请求强制关闭 Thinking 后使用保存的原温度，不再被主聊天的有效温度 `1` 污染。③ `rawText` 收口的记忆抽取/标题汇总/图谱等后台轻量任务无论是否配置 `AI_AUX_MODEL` 都强制 `allowThinking=false`，`max_tokens` 固定回 700；同时用输入摘要生成稳定亲和键，让匿名辅助任务在双端点间分流而不全部粘到同一端点。④ OpenAI `/chat/completions` 默认关闭时完全省略非标准 `thinking` 字段，只有运营显式启用 Claude 网关扩展后才发送；真正启用 OpenAI 兼容 Claude 前仍须直测。后台文案明确区分“配置温度”与“思考请求实际温度”。验证：server build 通过，Thinking/配置/端点池/辅助档定向测试 **58/58 全绿**。影响面：`server/src/{services/aiConfig.ts,services/llmPool.ts,llm/gateway.ts,llm/thinking.ts,llm/providers/{claude,openai}.ts}`、admin 模型表单、相关测试与工程文档；无数据库迁移、无 API 契约变化，小程序无需发版。

- **2026-07-27** · **生产双 Claude 端点实测修复 Thinking 关闭协议**：按生产冗余扩容验收先分别直测 `dj-claude-4.6-opus` 与 `claude-opus-4-6`；带 `dj-` 端点成功，不带 `dj-` 端点确定性返回 400 `thinking.disabled.budget_tokens: Extra inputs are not permitted`。七牛 Claude API 文档规定 `budget_tokens` 仅在 `type=enabled` 时必填，故将第三方 Anthropic 网关的关闭参数从 `{type:'disabled',budget_tokens:0}` 修正为 `{type:'disabled'}`；官方 Anthropic 直连仍按既有逻辑省略整个 thinking 字段，enabled/adaptive 行为不变。同步更新请求组装回归、AGENTS 协议约束；修复发布并让两个端点各自探活通过后，才允许开启生产端点池。影响面：`server/src/llm/thinking.ts`、Thinking/Claude baseUrl 测试、工程文档；不改数据库与前端契约。

- **2026-07-27** · **Claude/七牛端点池上线前加固，并合并 Thinking 配置链路**：在当前端点池分支合并 `origin/main` 的 Claude Thinking 与后台测试连接修复，保留 `thinkingMode=disabled|enabled|adaptive`、预算与 temperature=1 约束，并确保池内按每个端点自己的配置组装请求。补齐四个生产高优边界：① **禁止跨协议混池**——解析层只选与激活模型相同 `effectiveProvider` 的端点，后台在启用池、手动修改全局协议、新增/修改入池项、切换激活模型等入口均提前返回 `AI_POOL_PROVIDER_MISMATCH`；② 显式 `AI_AUX_*` 辅助档标记 `poolBypass`，抽取任务不再被主池改写模型/账号；③ 达到尝试上限的最后/唯一端点发生 429、5xx 或超时也写 Redis/本地共享冷却，避免其它请求继续撞同一坏节点；④ `llmGate` 只有完整成功才清连续 429 并推进恢复爬坡，失败释放不再错误重置退避。新增/扩展回归锁住协议过滤、辅助档隔离、端点 Thinking 配置继承、末节点冷却与 429 状态保持。验证：server `prisma generate` + `tsc` 通过；定向测试 **56/56 全绿**。按产品决定，当前未使用的 OpenAI 兼容流式转移与非流式跨端点独立 `AbortSignal` 延后并记录到 `AGENTS.md` §13。影响面：`server/src/services/{aiConfig,llmPool,llmGate}.ts`、`server/src/routes/admin.ts`、Claude/OpenAI provider 合并、admin 模型配置、相关测试与工程文档；数据库字段仍为纯加法，端点池默认 `single` 不改变未配置环境。

- **2026-07-27** · **修复 `admin` 测试基座停摆 + 前端单测进 CI**：承接同日端点池那条里「已单开任务」的 `admin` `npm test` 报 `Cannot find package 'tsx'`。**根因是本地 `node_modules` 半装**，不是清单漂移——`admin/package.json` 与 `admin/package-lock.json` 里 `tsx@^4.19.2` 都在（lock 有完整 `node_modules/tsx` 条目），只是本地 39 个包的 `node_modules` 里没装上；`cd admin && npm install` 补 3 个包即修复，`package-lock.json` 未变（`git diff` 空），另跑 `rm -rf node_modules && npm ci` 全新重建复核，两次 `npm test` 均 **12/12 全绿**（`src/ui.sandbox.test.ts` 覆盖 `sandboxSection` 9 种类型化 section）。`app` 侧同批复核 **11/11 全绿**，未受影响。**真正的问题是没人会发现它坏了**：`.github/workflows/` 此前只有 `server-integration.yml`，AGENTS.md §11 把 `cd admin && npm test` 列进构建校验基线却全靠人工执行，于是这套基座停摆了一段时间无人察觉。故新增 **`.github/workflows/frontend-unit.yml`**——`admin` / `app` 两个 matrix job 跑 `npm ci` + `npm test`（用 `npm ci` 而非 `npm install`，严格按 lockfile 重建，正是为了挡住这种半装状态）。落地时踩实两个坑并写进 §11：① **CI 固定 node 24，必须 >= 22**——`src/**/*.test.ts` 不是 shell 展开的（npm 用 `/bin/sh`，不支持 globstar，原样透传），而是 `node --test` 自己 glob，该能力 Node 22 才有，照抄 `server-integration.yml` 的 node 20 会直接找不到用例；② **`node --test` 匹配到 0 个文件时退出码仍是 0**（实测确认，只打印 `tests 0`），测试文件被挪走/改名也会一片绿，故 CI 那步额外断言 `pass` 计数 > 0，守卫已按 0 用例与正常用例双向验证，且对 spec / tap 两种 reporter 都成立。影响面：新增 `.github/workflows/frontend-unit.yml`、`AGENTS.md` §11；无源码改动、无依赖版本变化、无 API 契约破坏。

- **2026-07-27** · **端点池接入 claude 协议 + 运营后台配置面**：承接同日的端点池，补齐两块使其对现网真正生效。① **claude provider 全部 5 处调用点接入故障转移**——生产走的正是 claude 协议直连七牛，此前只有 openai 兼容路径覆盖到。非流式 4 处（`claudeDeliverable`/`claudeChat`/`claudeRaw`/`claudeStep`）改走 `withEndpoint`，请求体在闭包内按选中端点组装，转移时能按新端点原样重发；`claudeStep` 新增 `affinityKey` 参数，保证工具循环的多轮落在同一端点（否则每轮换端点、缓存与工具上下文都乱）。**流式路径**（`claudeChatStream`）按「只在未吐出任何 delta 前才允许转移」实现——已经 yield 过内容再换端点意味着重新生成，前面吐给用户的半句话会和新内容对不上；建流阶段和首个 delta 之前的 429/5xx 都能救回来，之后如实报错。② **`getClient` 从单槽缓存改为 Map**（上限 16）——接了端点池后相邻请求会在不同 `(apiKey, baseUrl)` 间交替，单槽缓存等于每次都重建 Anthropic client、丢掉底层连接池，这是接池后必然踩到的性能坑。③ **运营后台端点池配置面**（`admin/src/App.tsx` ModelView）：模型列表行新增「入池/在池中」按钮与池参数摘要；新增「端点池（多路分流 · 故障转移）」分区——启用开关、会话粘性开关（附「关掉会打散上游提示词缓存、成本上升」的说明）、每端点的权重/备份层/每实例并发上限输入，以及**实时冷却态展示**（哪个端点正被限流、几点恢复）。SSOT 新增 `AiRoutingStatus`；`admin/src/api.ts` 新增 `aiRouting` / `saveAiRouting`。验证：`server` `tsc --noEmit` 0 错 + `npm test` **754/754 全绿**；`admin` `tsc -b` 0 错 + `npm run lint:ui` 通过 + `npm run build` 成功；`app` `tsc --noEmit` 0 错。（`admin` 的 `npm test` 报 `Cannot find package 'tsx'`，把本次改动 stash 掉照样失败，属既有环境问题、与本次无关，已单开任务。）影响面：`server/src/llm/providers/claude.ts`、`shared/contracts.d.ts`、`server/src/llm/schema.ts`、`admin/src/{App.tsx,api.ts}`；无数据库变化、无 API 契约破坏。**仍未做**：openai 兼容协议的流式转移（`callChatStream`）。

- **2026-07-27** · **上游端点池：多路分流 + 故障转移（分布式安全）**：解决「后台只能配唯一生效端点、该端点一被限流全站 AI 停摆」。`AiSetting` 新增 `routingMode`（`single` 默认／`pool`）+ `stickyRouting`；`AiModel` 新增 `poolEnabled`/`weight`/`tier`/`maxConcurrency`（全部带默认值，纯加法，`db push` 安全）。新增 `services/llmPool.ts`：**加权 Rendezvous 哈希（HRW）+ 会话粘性**做路由，**不是轮询**——生产实测提示词缓存已只剩 12% 命中、系统提示词占单次输入约 95%，轮询会把同一会话打散到不同端点从而把缓存归零（上游缓存按账号隔离）。HRW 同时给到四个必需性质：无状态无需协调（各实例独立算出同样结果，多实例天然一致，不需要共享计数器或选主）、会话粘性、成员变化只重映射 1/N、支持权重。**分布式健康态**走 Redis（`llm:pool:cool:<id>`，TTL=冷却时长），确保一个实例撞 429 后所有实例都停发该端点——否则上游的滚动窗口惩罚会被其它实例持续续期；无 Redis 时退化进程内。`tier` 支持降级备份（0=同质对等，1+ 仅当低 tier 全冷却才启用；跨模型降级会改变回答质量，故默认全 0）。转移判定：429/5xx/超时转移并冷却，4xx／`AI_BUSY`／审核拦截／输出截断不转移。`llmGate` 车道键从固定枚举泛化为任意字符串，端点池下每端点一条独立车道（并发与冷却按端点隔离），并支持 `setLaneMaxConcurrency` 覆盖。**明确不做跨实例精确并发计数**——`maxConcurrency` 是每实例上限，理由见 `AGENTS.md` §8.3。新增 admin API `GET/PUT /admin/ai-routing`（切 pool 前校验池内确有可用端点，否则 409）；`ai-models` 的增改接受池字段。**默认零变化**：`routingMode` 默认 `single`，不配就是旧行为；`resolveCandidates` 在未启用池时原样返回传入 cfg（引用相等）。验证：`tsc --noEmit` 0 错；`npm test` **754/754 全绿**（新增 `test/llmPool.test.ts` 15 例，锁住分布式一致性、会话粘性、最小重映射、权重分布、tier 降级、转移边界）。影响面：`shared/contracts.d.ts`（SSOT 先行）、`server/prisma/schema.prisma`（纯加法）、新增 `services/llmPool.ts`、`services/{llmGate,aiConfig}.ts`、`llm/providers/openai.ts`（非流式路径接入转移 + 会话亲和键）、`llm/schema.ts`、`routes/admin.ts`。**未做**：运营后台前端表单（池开关/权重/tier 的 UI）、claude provider 的 5 处调用点接入转移（openai 兼容路径已覆盖，生产当前走 claude 协议直连七牛，需后续补）、流式路径转移。

- **2026-07-27** · **生产只读探查：提示词漂移 2.85 倍 + 缓存 88% 未命中 + 成本低估 5.2 倍（仅文档，无代码改动）**：登生产机 `8.136.36.175` 只读核对，推翻了此前基于仓库文件的三处判断。① **提示词漂移**：`general`（总军师）生产 `Agent.systemPrompt` 是 **49,094 字符**，仓库 `prompts/strat.v6.md` 只有 17,230，运行时用的已发布快照 `AgentVersion` v4 = 49,094（v1 41,710 → v2 45,342 → v3 44,957 → v4，三周 +18%）；其余 agent 生产 1,650–1,764 字符 vs 本地 620–670，同样漂移。**`npm run admin:sync-content` 的 update 分支会用文件覆盖 `systemPrompt`，无 diff 无确认**——运行时读已发布快照所以不会立刻生效，但草稿会被换成旧版，之后任一次「发布」即推平三个版本的调教，**跑同步前必须先把线上版本回灌对齐**。② **提示词缓存 88% 未命中**：30 天 580 次 chat 中 509 次 `cachedInput=0`，白付 13,740,038 输入 token。排除了 TTL（71.6% 相邻对话在 5 分钟内；只看窗口内的 415 次命中率仍仅 15.2%）与本仓库代码（`stable` 段无随时间变的值，`buildSystemParts` 稳定段在前）；指向 `api.qnaigc.com/bypass/anthropic` 中转在多上游账号间轮询而 Anthropic 缓存按账号隔离（两个模型标签命中率 9.4% / 17.5%，呈零星脉冲，符合 1/账号池规律）。③ **成本按 Anthropic 官方价重算**：Opus 4.6 input $5/1M、output $25/1M、缓存写 5m TTL $6.25/1M、缓存读 $0.5/1M —— 近 30 天实际 **≈$95.28**，而系统 `costMicros` 只记 18.36，**低估 5.2 倍**，`data/modelPrices.ts` 需校准，运营后台「算力消耗」与成本告警目前不可信。修好缓存约省 **$46/月 = 总账单 49%**（$0.164/次对话 → $0.084），但**前提是七牛透传缓存定价**，若按统一单价结算则只改善延迟不省钱。④ 同时修正此前两处估算错误：辅助抽取扇出实测只有 **0.69 次/条消息**（不是 2–3 次）、占输入 token 仅 **0.8%**，此前「拆走能翻 2–3 倍」的说法高估了一个数量级（该改动仍有效，但价值在隔离后台任务与 429 冷却，不在 token）；系统提示词占单次输入约 **95%**，账本块是零头。影响面：`docs/[OPUS5]LOADTEST_OPT_PLAN_2026-07-26.md` §2.5 全节重写为实测口径、`AGENTS.md` §13 新增四条；**无代码改动**，生产全程只读（`sudo -u postgres psql` 查询，未碰 `.env`、未改任何配置）。

- **2026-07-26** · **辅助抽取拆到小模型 + 并发闸双车道；修复闸门默认值失效**：承接压测瓶颈归属分析（LLM 比本机紧 6–20 倍，且是账号级配额、加 ECS 无效）。核对代码发现**一条用户消息实际触发 3–4 次模型调用**——主生成 + `extractInsights`（记忆学习，每轮）+ `extractProphecies`（预言抽取，有命盘用户每轮）+ 首条消息的 `summarizeSessionTitle`——它们原来全走同一个 `getAiConfig()`，同账号同模型，等于**上游 8 个并发槽位里有 2–3 个被后台任务占着**，而这些任务既不需要主模型质量也没人在等其延迟。① 新增**辅助档** `services/aiConfig.resolveAuxConfig()`：配 `AI_AUX_MODEL` 把抽取切到小模型（temperature 归零、超时收紧到 ≤20s）；再配 `AI_AUX_BASE_URL` / `AI_AUX_API_KEY` 指向独立账号时，还会切到独立并发车道。只换模型名不换账号则车道仍是 main——同账号配额本就共享，分两个计数器等于把限额悄悄放大一倍。**收口点是 `gateway.ts` 的 `rawText()`**（所有抽取都经它或 `rawJson` 落地，新增路径自动继承）；调用方显式指定 `model` 时（评测评委用独立模型避免自评）通过 `allowAux:false` 保护不被覆盖。② `services/llmGate.ts` 从单例状态改为 **main/aux 双车道**，各自独立的并发上限、队列、429 冷却与统计（aux 默认 4 并发 / 5s 排队超时，刻意低于主车道）；`llmGateStatsAll()` 供后续 `/metrics`。原设想的「单队列加优先级」由双车道更彻底地覆盖。③ **修复上一条提交里的真 bug**：`llmGate` 的 `num()` 用 `Number(process.env[k] ?? '')` 判默认值，而 `Number('')===0`（不是 NaN），导致**未设 `LLM_MAX_CONCURRENCY` 时并发上限被算成 1 而不是 8**、排队超时被算成 1s 而不是 15s，且零报错——由新增的车道测试暴露，已加回归用例锁定。**默认行为零变化**：`AI_AUX_MODEL` 留空时 `resolveAuxConfig` 原样返回主配置（引用相等），对话与成果生成永远走主配置，**提示词一个字节没改**。验证：`tsc --noEmit` 0 错；`npm test` **739/739 全绿**（新增 `test/aiAuxConfig.test.ts` 9 例 + `test/llmGate.test.ts` 增至 18 例）。影响面：`server/src/services/{aiConfig,llmGate}.ts`、`llm/gateway.ts`、`llm/providers/{claude,openai,dify}.ts`（传车道）、`server/.env.example`；无 API 契约与数据库变化，小程序无需发版。**未做**：提示词模块化省 input（机制 `llm/promptAssembly.ts` 已就绪但 `prompts/strat.v6.md` 无标记，17,232 字符底座每轮全发、约占单次输入 45%——产品侧要求对话效果不受影响，需先定切分方案 + 评测基线，见 §13）。

- **2026-07-27** · **修复测试环境不自足：开发机 `server/.env` 渗进测试进程，用例红绿取决于谁的机器**：`cd server && npm test` 在本机长期 722 例中挂 2 例（`wechatMessage`「订阅消息 accept 后累计一次额度」期望模板列表只有 `[['review','tpl-review']]`、实得多出 `report`/`payment` 两条真实模板 ID；`reminders`「三条提醒节奏（逐字文案）」的 `subscribeReady` 期望 `false` 实得 `true`），而 CI 全绿——不是业务缺陷，是**测试环境不自足**：`npm test` 用 `node --env-file=.env.test` 注入测试变量，dotenv 系「不覆盖已存在的 process.env」只保住了 `.env.test` **已声明**的键（`DATABASE_URL` 因此始终指向 `junshi_test`，从未误碰 dev 库），`.env` 里那些 `.env.test` **没声明**的键（`WECHAT_SUBSCRIBE_*_TEMPLATE_ID`、OSS、短信…共 26 个）照样被注入。排查中发现注入源有**两个**，只堵 dotenv 不够：① `src/env.ts` 的 `import 'dotenv/config'`；② **`@prisma/client` 自己也会读 `server/.env`**，且在「模块 import」与「每次 `new PrismaClient()`」两个时机各注入一遍（路径 `relativeEnvPaths.schemaEnvPath` 烤进生成产物、是绝对路径、与 cwd 无关；已 grep 确认 Prisma 5.22 runtime 没有任何 opt-out 开关）——所以第一版只改 `env.ts` 时两例仍然失败。修复按「通用、不 pin 变量名」的口径分三层：① `src/env.ts` 改为 `NODE_ENV=test` 时**整体跳过** dotenv，并导出 `dotenvLoaded` 供守卫核对；② 新增预载模块 `server/test/hermeticEnv.mjs`（`test` 脚本加 `--import ./test/hermeticEnv.mjs`，node 会把 execArgv 透给 test runner 派生的每个子进程，与既有 `--import tsx` 同理）：记下**进程启动那一刻**的键集合（= 真实 shell 环境 + `.env.test`，故本机 shell 里导出的同名变量不会被误伤），主动引一次 `@prisma/client` 让 import 期注入落地后立即抹除，并把 `scrub()` 挂到 globalThis；`src/db.ts` 在 `new PrismaClient()` 的**下一行**调该钩子（全仓唯一构造点；钩子只在测试预载时存在，生产进程是 no-op，实测抹除后 Prisma 查询正常、`DATABASE_URL` 因属启动键而保留）；③ 新增守卫用例 `server/test/envHermetic.test.ts`（2 例）：断言 `dotenvLoaded===false`，并读一遍 `server/.env` 的键、断言「本文件没声明、shell 也没导出」的键一个都没漏进 `process.env`——通用断言，往 `.env` 里加任何新键都罩得住。三层机制**逐层拆掉都验证过会失败**（去掉预载 → 守卫报「未被预载」；去掉 `db.ts` 钩子 → 守卫 + `wechatMessage` 双挂；恢复 `env.ts` 旧行为 → 守卫 + `reminders` 双挂）。顺带修正 `.env.test` 里「dotenv 不覆盖已存在变量所以安全」的过时注释（不覆盖 ≠ 隔离）。验证：`server` `npx tsc -p tsconfig.json --noEmit` 0 错；`npm test` **724/724 全绿**（722 既有 + 2 守卫），并在「有 `server/.env`」与「把 `.env` 移开模拟 CI」两种条件下**各跑一次、结果一致**——即本机与 CI 从此同真值。影响面：`server/src/{env,db}.ts`、`server/package.json`（test 脚本）、`server/.env.test`（注释）、新增 `server/test/{hermeticEnv.mjs,envHermetic.test.ts}`、`AGENTS.md` §11 与 `docs/TESTING.md`（新增「测试环境自足」小节，并把两处过时的用例数 215/57 更新为 724）；不改 API 契约、不改数据库结构、不影响生产运行时（生产/开发仍由 `env.ts` 的 dotenv 正常加载 `.env`）。

- **2026-07-26** · **压测后确定性优化项落地（入口层 5 RPS 天花板 / 上游并发闸 / 过载保护 / 连接池显式化）**：按 2026-07 隔离压测报告执行「证据等级 A/B 级」优化项（数据直接证明 + 读代码确证、不依赖复测的部分），产出 `docs/[OPUS5]LOADTEST_OPT_PLAN_2026-07-26.md`（优化计划 + 证据分级）与 `docs/[OPUS5]LOADTEST_PLAN_V2_2026-07-26.md`（复测方案）。① **修生产入口层约 5 RPS 的隐藏天花板**：`app.ts` 建 Fastify 实例时从未设 `trustProxy`，`req.ip` 取 socket 对端地址，而生产 Nginx 从 `127.0.0.1` 反代 → 所有用户折叠成同一个 IP，`@fastify/rate-limit` 默认按 `req.ip` 分桶，全站因此共用一个 300/min 的桶；新增 `trustProxyOption()`（默认 `'loopback'`，只信任本机反代的 XFF，避免进程直接暴露时客户端自报 IP 绕过限流；`TRUST_PROXY` 可覆盖为 CIDR/跳数/false），限流 `keyGenerator` 改为「已登录按用户 / 未登录按 IP」，阈值提到 600/min 可配，配了 `REDIS_URL` 时用 Redis store 跨实例共享。该缺陷压测**结构上测不到**——压测栈跑 `NODE_ENV=test`，`app.ts` 的 `if (!isAiTestMode())` 直接跳过了限流插件注册。② **新增上游模型全局并发闸** `services/llmGate.ts`（此前全仓 grep semaphore/concurrency/p-limit/queue **零命中**，所有调用点直接打上游）：默认 8 并发 / 12 突发，排队超 15s 降级 `AI_BUSY(503)`，队列有界；**429 走整窗冷却**（压测实测 20 并发触发 429 后紧接着的 12 并发复测 48/48 全挂，说明上游是滚动时间窗限额，故收到 429 即整窗停发、优先采信 `Retry-After`、否则指数退避，冷却后从低水位爬回），显式速率窗口默认关闭留待线上 429 率校准；挂在 `llm/providers/{claude,openai,dify}.ts` 的真实外呼处（gateway 有 17 个动态 import 调用点，挂 provider 层才不漏），流式手动持槽到整条流消费完，mock 不过闸故测试/演示零影响。③ **过载主动降级**（压测实测 450 RPS 交付 450、800 RPS 只交付约 366，过载时有效吞吐不升反降）：Nginx `limit_req` + 应用层在途非流式请求上限 `MAX_IN_FLIGHT`（默认 200，SSE 与探活不计入）。④ **生产 Nginx 模板回流压测调优**：此前 `deploy/nginx.conf.example` 既无 `worker_connections`、也无 upstream 块与 keepalive（每请求新建一条到 Node 的 TCP），比压测里那档失败 46% 的「默认 Nginx」还差；改为 A 主配置（8192 连接 + `limit_req_zone`）+ B 站点（`upstream junshi_api` + `keepalive 64` + `Connection ""`）两段式，`nginx -t` 已实测通过。⑤ **连接池显式化**：`connection_limit` 此前只在压测栈设过（报告写的「80/实例」是压测专有值），生产完全未设、走 Prisma 的「容器 CPU 数×2+1」推导，扩容时连接总量不可预算；`deploy/docker-compose.yml` 显式设 15 + `pool_timeout`，`index.ts` 加生产启动告警。⑥ 顺带：健康检查拆 `/health/live`（不碰 DB）与 `/health/ready`（含 DB），DB 探测结果加 1s 短缓存；SSE 补 `X-Accel-Buffering: no`（换 ALB/多层反代的前置条件）；Redis 客户端抽到 `services/redis.ts` 供缓存与限流共用。验证：`server` `tsc --noEmit` 0 错；`npm test` **720/722**（新增 `test/llmGate.test.ts` 12 例全绿，另 2 例失败为改动前既有的 `.env` 泄漏到测试环境所致，与本次无关，基线同样是这 2 例）；`trustProxy` 修复用独立脚本实测复现「旧行为两个客户端折叠成 127.0.0.1、修复后分别计数」。影响面：`server/src/{app,index}.ts`、`routes/{meta,sessions}.ts`、`llm/gateway.ts`、`llm/providers/{claude,openai,dify}.ts`、新增 `services/{llmGate,redis}.ts`、`services/cache.ts`（客户端外移）、`deploy/{nginx.conf.example,docker-compose.yml}`、`server/.env.example`；无 API 契约变化、无数据库 schema 变化、小程序无需重新发版。**未做**（等复测或需运维前置）：同机多进程（收益因压测容器 `cpus: 2.25` 配额而未被测量）、scheduler 选主、Puppeteer 出进程、`/metrics`、PG 迁 RDS——见 AGENTS.md §13。

- **2026-07-26** · **新增隔离服务器压测工具链**：新增 `loadtest/` 专用 Dockerfile/Compose/内网 Nginx/k6 只读场景、真实 LLM 最小消耗探针，以及 `server/prisma/loadtestSeed.ts` 确定性测试数据生成器；压测栈使用独立 PostgreSQL volume、仅回环监听，通过 Docker internal network 硬断 API 公网出口，并固定 mock AI、console SMS、禁用微信/支付/OSS/embedding/rerank，避免消耗型资源和生产数据；隔离 Nginx 显式提高连接上限与 upstream keepalive，避免默认 1024 连接上限污染 API 容量判断；LLM 探针固定一个字符输入和 `max_tokens=1`，逐档核算并受 Token 护栏约束。影响面：仅压测/运维工具与工程文档，不改变产品运行时。
- **2026-07-27** · **后台补齐 Claude Thinking 开关、预算与温度联动**：模型配置新增 `Thinking=关闭/手动预算/自适应`，同时兼容 Anthropic 原生与 OpenAI 兼容的 Claude 模型别名；手动预算按七牛/Anthropic 约束限制为 1024–7000，开启思考时 temperature 自动锁为 1，测试连接与普通聊天统一携带当前 Thinking 配置。关闭时七牛等第三方网关显式发送 `thinking.type=disabled`，不再受网关默认思考模式影响；Anthropic 官方直连按官方协议省略 thinking。结构化成果和多轮工具调用因 Anthropic Thinking 只允许 `tool_choice=auto/none` 且要求跨轮保留 thinking block，继续显式关闭思考以保护既有强制成果工具链。新增共享契约字段、`AiSetting/AiModel` 数据列、请求参数归一化及 server/admin 回归测试。影响面：admin 模型配置、server OpenAI/Claude provider、数据库纯加法字段；小程序无需发版。

- **2026-07-27** · **修复 Claude“测试连接”未携带 temperature 导致错误配置假绿**：保留后台模型级 temperature 参数；线上历史 trace 确认 qnaigc `dj-claude-4.6-opus` 在 OpenAI thinking/adaptive 兼容链路下使用 `0.7` 会返回 400、要求固定为 `1`。OpenAI 探活原本已通过统一 `callChat` 携带 temperature，Claude 探活 `claudeRaw` 却遗漏该字段，导致测试请求与真实聊天不一致；现抽出可回归的 `claudeRawRequest` 并显式携带当前配置值，后台连接测试会按表单/已存 temperature 暴露真实错误，不再假绿。影响面：server Claude provider 与模型连接测试；不改 API/数据库结构，不改小程序。

- **2026-07-27** · **修复后台“完全自主定义”误配 Claude 网关后 404**：线上确认 `provider=claude + qnaigc /v1 + dj-claude-4.6-opus` 会被 Anthropic SDK 再次补成错误的 `/v1/v1/messages` 路径，探活返回 404；同一 key 改回 `openai + /v1 + dj-claude-4.6-opus` 及 `claude + /bypass/anthropic + claude-opus-4-6` 均实测连通。运营后台现对 Claude 同样展示 baseUrl 输入，并按协议明确区分 OpenAI `/v1/chat/completions` 与 Anthropic `/v1/messages`；服务端统一裁掉 Claude baseUrl 尾部 `/v1`/`/v1/messages` 后再交给 SDK 补路径，避免历史或手工配置重复拼接。新增 admin 指引与 server URL 规范化回归测试。影响面：admin 模型配置、server Claude provider、共享契约注释；无 API 字段和数据库结构变化，小程序无需发版。

- **2026-07-25** · **修复老用户重复弹首次入局与五 Tab 功能引导**：根因有三处——冷启动时本地无 `junshi.onboarded` 会在 `/me` 返回前被直接当成未建档；服务端登录与 `/me` 仅用“是否存在 Profile 行”判断，历史账号缺行即误判新人；CoachMarks 只看本机 `done` storage，老账号升级/换机后也会补弹。前端 store 新增 `onboardingKnown` 水合态，问策/军情只在服务端权威状态已知且明确未入局时跳转；入局页若迟到的 `/me` 确认老用户会自动退出，Profile 保存失败改为留页显式重试。服务端新增统一 `hasCompletedOnboarding`：Profile、2026-07-21 前存量账号、已有企业身份或真实业务资产任一命中均视为已入局，登录与 `/me` 同口径。五 Tab 引导新增 `armed` 门禁，仅真正完成首次入局的出口启用，老账号缺 storage 不再补弹。新增 3 项前端门禁测试及 2 项后端回流集成用例；app 19 项测试/tsc/正式 weapp 构建、server tsc 与全量测试全绿。影响面：app 首次入局/功能引导状态机、server 登录与 `/me` 的 onboarded 判定；无接口字段、数据库结构变化，需同时发布 server 与新小程序版本后生产生效。

- **2026-07-25** · **小程序新增 mock 可见标识与发布硬守卫**：五个主 Tab 在 mock 构建中常驻红色「MOCK · 本地数据」，设置页版本改为显示 `版本 · MOCK/正式 · commit`；app 包版本从长期滞后的 `0.1.6` 对齐当前 `0.2.21`。weapp 构建新增 `junshi-build-meta.json`（mode/api/version/gitSha），正式上传统一收口到 `npm run release:weapp -- --version x.y.z --desc "说明"`：强制重建生产 server 包并核对模式、生产 API、构建/上传版本一致后才调用 DevTools CLI（`--dry-run` 可只验不传）；miniprogram-ci 与旧上传脚本同步执行元数据校验。实测 mock 构建被拒、server 构建放行、版本不一致被拒；新增 3 项上传守卫测试，既有 16 项 app 测试、tsc、mock/server 构建全绿。影响面：app 构建配置、主 Tab/设置页、上传脚本与发布文档；不改服务端/API/数据结构，本次未再次上传微信后台。

- **2026-07-25** · **小程序 `0.2.21` 已上传成功**：附身登录修复提交 `85a6ae1` 已按正式 server 模式构建，16 项 app 测试通过，产物确认只含生产 API；恢复开发者工具登录后通过 DevTools CLI 上传成功，微信侧包体 1.2 MB（1219012 B）。影响面：微信后台新增 `0.2.21` 开发版本，尚未自动提交审核或发布上线。

- **2026-07-25** · **修复附身登录始终误报“令牌无效”及 mock 包假附身**：生产日志确认后台附身令牌均签发成功（200），但小程序验令请求未到 `/api/me`；根因是当前 mock 构建把 `verifyImpersonation` 错分流到 `mock.me()`，未登录时无论粘贴何种线上有效令牌都会本地失败。附身验令现作为运维特例始终携传入 token 直连真实 `/me`：server 包复用当前生产/预发 API，mock 包优先使用显式 `TARO_APP_API`、否则验生产 API；继续保持“校验通过前不覆盖当前登录态、不触发全局 401 登出”。验令通过并落地三段 JWT 后，新增运行时数据源选择会让该会话的普通 API、上传、流式对话、案卷和支付守卫全部切到同一真实服务端，避免只验令成功、后续仍显示 mock 用户；退出或换回 `mock-*` token 自动恢复本地模式。新增验令选址与整会话切换回归测试。影响面：app 附身登录、运行时数据源与配置文档，无接口/数据结构变化。

- **2026-07-25** · **年度谶语、支付到账订阅与底栏待办角标收口**：战略档案契约新增 `verseYear`，自动抽取按「一年一句」守卫（同年不换、跨年才更新，老板手动校准可强制改谶）；老板页在命理开关开启时展示年度谶语竖排卡和干支落款，无谶引导去命盘，报告封面缺省箴言时仅在渲染入参补当年谶语、不污染成果存档。支付确认点击在微信手势内优先申请一次「到账提醒」订阅，拒绝或失败不阻断支付。自定义底栏新增问策未读数字与 21:00 后未复盘军令红点；会话页就地同步未读、复盘落账后立即熄灭，并由全局 15 秒节流单飞刷新避免 tab 切换重复请求。影响面：`shared/contracts.d.ts`、app 战略档案/支付/底栏、server 战略档案/报告渲染与回归测试；无数据库 schema 变化。

- **2026-07-25** · **五个 tab 页头统一移植最新原型（小字用途 + 大字 tab 名 + 背景大字 · 页头零按钮）**：新增 `app/src/components/TabHeader`，页头改为「一行小字用途（本命色，字距 .3em）+ 宋体大字 tab 名 + 背景一枚本命色大字（100px/.1，贴右上、整字露出不裁字脚——字号与 `.tab-head` 下方留白配套，标题区不加 `overflow:hidden`；再放大就会压到下方第一块内容，而五个 tab 有三个是深色不透明主卡、做不成半透明透字，故以「整字放得下」为字号上限）+ 底部细线」；问策·有事问军师·谋 / 军情·看今日判断·势 / 军令·做今天的事·令 / 锦囊·存你的家底·库 / 老板·你自己·我（背景字取表意的字，不用「囊/板」这种单看无义的；我的页大标题由「我的军师系统」改为与底栏一致的「老板」）。原型页头右侧的「行业 tag」是装饰，按定稿去掉，`TabHeader` 也不设 `right` 插槽；原页头五个入口按 reachability 逐个定去向：军令页「复盘」删（同屏 `exec-seg` 与「复盘提醒」卡已两处入口）、军情/军令页「案卷」删（老板 tab 有我的案卷菜单 + 案卷统计卡）、军情页刷新下移到「三势判断」段头做「重算」（它调 `refreshForces` 重算三势，`useDidShow` 不做这件事，属唯一入口）、问策「历史」下移到搜索行右侧（旧线程唯一入口，与搜索同属「找东西」）、老板「设置」进「系统」菜单组首行（此前只有用户卡姓名块能进，标签看不出是设置）。五份各自复制的页头样式（`exec-nav/battle-nav/messages-head/think-nav/account-nav`）删除，`Screen` 的 `.tab-page-head` 从固定 56px 改为内容撑开 + 裁切外壳，顺带解掉 `sessions` 与 `thinktank` 对 `.mh-t/.mh-s` 的全局类名冲突。影响面：app 五个 tab 页头（视觉 + 文案）与三处入口位置，无接口/数据结构变化；weapp + H5 构建与 tsc 全绿，H5 逐 tab 视觉校验，并实测「历史」切换、「重算」（toast 军情已刷新）、「设置」菜单行均生效。

- **2026-07-24** · **测试期注册默认高级套餐 + 存量安全升级**：服务端新增 `TEST_DEFAULT_PLAN_NAME` 注册开关；启用时微信/短信/本机号等所有注册入口统一在建号事务中通过 `applyPlanPurchase` 开通指定套餐，完整写入套餐有效期、钻石流水与 token 钱包；未启用时严格保留体验版自然月额度的原注册口径。新增 `db:grant-test-plan` dry-run/apply 脚本，只升级无套餐、低档或已过期用户，保留有效同档与企业私有化用户，支持线上存量测试账号安全补开。影响面：`server` 注册、环境配置、运维脚本与集成测试；无数据结构变化。

- **2026-07-23** · **修复业务快捷入口新建短会话后遮住原对话线程**：生产只读核验确认发布前已有的 45 条会话、872 条消息均仍在库，受影响用户原总军师主会话 116 条消息完整；实际问题是执行页「生成今日军令」等快捷入口固定携带 `fresh=1` 新建短会话，而对话首页点击军师只续接更新时间最新的会话，短会话因此成为默认入口，让旧主线程看起来像“丢失”。战局、执行、智库、速诊、数据源、能力市场及 mock 搜索中的军师快捷入口现统一改为 `continue=1`，先还原该军师最近线程再自动发送问题；仅保留用户明确「新对话」、参谋室主动派单及项目新会话的 `fresh=1`。影响面：app 对话路由入口；不改数据库、接口和已有会话，历史页仍可打开全部旧线程。

- **2026-07-23** · **修复超长对话撞模型输出上限后被误判为完整回复**：生产核验确认一条用户可见回复以半句“把”结束，落库正文 9,589 字、Claude trace 输出恰好 4,000 token，根因是普通聊天预算固定为 4,000 token 且 provider 层未检查 `stop_reason=max_tokens`，导致残缺正文仍按成功落库并继续展示「军师印象已更新」。OpenAI/Claude 普通聊天预算现统一提升至 8,000 token；新增统一 completion guard，非流式、原生流式及工具循环均识别 Claude `max_tokens` / OpenAI `length`，命中后抛出 `AI_OUTPUT_TRUNCATED`，不落 assistant 消息、不学习残缺上下文、不触发记忆更新，并向用户显示「内容较长、尚未完整写完，可重试或分段继续」；OpenAI 请求阶段不再通过 `max_tokens` 数值猜测，避免聊天与成果同为 8,000 时误用错误超时口径。新增纯 guard 与 OpenAI 流式上限回归测试。影响面：server Claude/OpenAI provider、gateway 错误保真、会话用户提示；不改 API/数据库结构，无需更新小程序包。

- **2026-07-23** · **对话退出重进后续显军师思考态并自动接回结果**：此前“正在思考”只存在聊天页 React `busy` 状态，退出页面后即丢失；客户端新增带 TTL 的 `chatPending` 短标记桥接“发送→服务端登记”的极短网络窗口，服务端按 `sessionId` 维护在途生成计数，并在会话列表/详情新增 `generating` 权威真值，列表摘要同步显示「军师正在思考…」且留在列表时会自动刷新为最终摘要/未读。聊天页重进生成中的会话会立即恢复思考图标和输入锁，按先快后慢节奏刷新详情，回复落库后自动更新对话，无需反复退出确认；重进页面不展示无法实际中断旧请求的假停止键，异常结束且尾条仍为用户消息时给出可重试提示。验证覆盖服务端生成态列表/详情/并发清理回归。影响面：shared 会话契约、server 会话生成状态与接口、app 对话页/列表摘要；不改数据库结构。

- **2026-07-23** · **例行 QA 独立审计：功能点亮引导卡直接点底栏切 tab 会与实际页面错位 + gantt 刻度无上限可撑爆 PDF 渲染队列**：① `CoachMarks`（功能点亮五步引导）的 `evaluate()` 只从 storage 读取上次持久化的 `step`，从不核对「当前实际停留在哪个 tab」——`0dd5611` 把底栏 `z-index` 提到引导遮罩之上正是为了让箭头能指向真实底栏，代价是底栏在引导期间仍可正常点击（`CustomTabBar.switchTo` 对引导态毫无拦截，这是有意保留，不能反过来直接屏蔽点击）；结果用户若不点「下一步」而是直接点别的 tab，`Taro.switchTab` 正常跳转，但新页面挂载的 `CoachMarks` 渲染的仍是旧 `step` 对应的文案与箭头位置——引导卡内容与用户实际所在页错位（如站在「锦囊」tab 却看到指向「问策」tab 的箭头和文案）。修复：新增 `currentRoute()`/`stepForRoute()`，`evaluate()` 优先按「当前页面路由」反查对应步骤号（找不到才回退用持久化值），并回写 storage 保持后续一致；`advance()`/正常按「下一步」流程行为不变（目标页路由与写入的 step 本就一致）。② `server/src/llm/schema.ts` 的 `gantt` typed section：`from`/`to`/`total` 只保证 `from<=to`，从未设过上限——`reportHtml.ts` 的 `ganttHtml()` 直接拿 `total` 当 `Array.from({length:total})` 的数组长度铺刻度行，LLM 若吐出数值合法但异常大的 `to`/`total`（如四位数），会在 Puppeteer 单并发 PDF 渲染队列里产出巨型 HTML，卡住/耗尽内存并拖住排在后面的所有用户。修复：`from`/`to`/`total` 统一 `clamp` 到 120（同 `gauge.score` 的 clamp 同规格兜底），覆盖常见「周/旬/月」排期场景（120 周≈2.3 年）。验证：`app` `npx tsc --noEmit` 0 错 + `npm test` 11/11 + `npm run build:weapp` 编译成功；`server` `npx tsc --noEmit` 0 错 + `npm test` **647/647 全绿**。影响面：`app/src/components/CoachMarks/index.tsx`、`server/src/llm/schema.ts`（gantt 分支）；不改 API 契约、不改数据库结构。

- **2026-07-23** · **例行 QA：承接 #47 后回归测试发现 `extractOrders` 军令提取被合成 list 污染 + phases/gantt 兜底分支永远不命中**：承接 2026-07-22 的 `casefile.ts` typed-section 修复（本身承接自 #46）时，本地全量跑 `npm test` 发现既有测试 `extractOrders：白卡 list 缺位时兜底 phases.actions，再兜底 gantt 行 label` 回归失败——根因两处：① 承接的 `normalizedSections` 把每个 section 整个替换成 `cardSection()` 的 `{h,b?,list?}`，原始 `type`/`items`/`rows` 字段被丢弃，导致 `extractOrders` 里 `sections.filter(s => s.type === 'phases')`/`'gantt'` 两条兜底分支从此永远匹配不到任何 section（恒为空数组）；② 即使不考虑①，`phases`/`gantt` 类型化 section 经 `cardSection` 会合成出带「〔序号〕标题」「· 」项目符号的展示用 `list`，标题未命中「行动/计划」等关键词时，旧的兜底顺序会把这份**装饰过的** list 当成任意分节兜底选中，军令文本里混入 `〔第一阶段〕止血` 这类标题行与项目符号前缀，而不是干净的动作句。修复：`normalizedSections` 改为保留原始字段与归一化 `h/b/list` 合并返回（`{...s, ...cardSection(s)}`）；`extractOrders` 调整兜底顺序——标题命中关键词才用该分节的（可能合成的）list，未命中时依次尝试 `phases.actions`/`gantt` 行 label 的干净兜底，最后才退到「任意分节的 list」。验证：回退本次两处改动会让上述既有测试重新失败（已手工验证）；`server` `npm test` **647/647 全绿**（较承接基线 624 净增，含本仓库既有测试首次跑通）；`app` `npx tsc --noEmit` 0 错 + `npm test` 11/11 + `npm run build:weapp` 编译成功；`admin` `npx tsc -b` 0 错 + `npm test` 12/12 + `npm run build` 成功。影响面：`server/src/services/casefile.ts`（`normalizedSections`/`extractOrders` 内部实现，函数签名与对外行为不变，仅修正被污染的提取结果）；不改 API 契约、不改数据库结构。

- **2026-07-22** · **修复 Android 真机输入文字不可见/漂到页面顶部，并恢复反问卡原交互**：确认根因是微信原生输入层与纵向 `ScrollView`、fixed 弹层的坐标体系冲突；执行页切换为原生页面滚动，目标编辑改为目标阶梯下方就地展开；对话反问卡「其他」恢复卡片内输入外观，卡片用 View/Text 实时显示草稿，真正接收键盘字符的透明 Textarea 移到聊天 ScrollView 外，避免原生文字层随聊天滚动错位；未采用微信端不存在的 `enableNative=false`。影响面：app Screen/KbInput、执行页目标与任务回填、对话反问卡键盘捕获 + AGENTS/CHANGELOG。

- **2026-07-22** · **例行 QA：认可方案核心执行闭环（案卷/军令/风险锁/战略档案）对报告 V2 类型化 section 系统性失效**：`2026-07-21` 修过报告 V2 typed section 在「方案库详情」页与运营「调教沙盒」被剥空，但那两处都是纯前端展示；本轮排查发现同一根因（`shared/contracts.d.ts` 把 `h`/`b`/`list` 以「可选」形式挂在所有 section 变体的公共基上，只保证类型层面兼容，不代表运行时有值）在**服务端**同样存在，且波及面更大：`server/src/services/casefile.ts`（`extractOrders`/`extractRisks`/`firstJudgment`/`deliverableText`，被 `POST /casefile/accept` —— 认可方案生成/更新案卷 —— 直接消费）与 `server/src/services/strategicProfile.ts`（`extractStrategicFacts`/`extractForceVerdict`）此前都直接读 `sec.h`/`sec.b`/`sec.list`；用真实 V2 数据验证：`stats`/`roster`/`table`/`phases`/`timeline` 的实际内容在 `items`/`people`/`rows` 等专属字段读不到，`quote`/`letter` 干脆没有 `h`（`deliverableText` 会把 `undefined` 当文本喂给 LLM 拆军令/目标阶梯提示词）——用户认可一份现代报告 V2 方案后，案卷的军师判断/军令/风险锁/目标阶梯可能被静默清空或取到错位内容（如把风险提示误判为主判断）。同一模式还存在于 `server/src/routes/sessions.ts`（`harvestText`，喂给「预言账本」抽取，quote/letter 类型会漏采具体预测）与 `server/src/services/evals.ts`（`deliverableToText`，喂给运营「调教沙盒」评测打分的 LLM 评委，评分→建议定价档位因此可能系统性失真）。修复：新增服务端共享工具 `server/src/services/deliverableSection.ts`（`cardSection`，与 `app/src/services/deliverableSection.ts` 同口径的类型化 section 归一化映射），`casefile.ts`/`strategicProfile.ts`/`sessions.ts`/`evals.ts` 四处读取前统一先过一遍归一化。新增回归测试 `server/test/casefileTypedSections.test.ts`（4 例：喂真实 V2 typed sections，断言 `extractOrders`/`extractRisks`/`firstJudgment`/`extractStrategicFacts` 均能正确提取，已用「仅读裸 `s.h`/`s.b`/`s.list` 的旧实现」手工验证过会失败）。**2026-07-23 承接时同步补齐**：`20c0951`（同为 2026-07-22，报告模板新增 gauge/matrix/gantt 三种类型化 section）落在本修复分叉之后，`app`/`server` 两侧共享的 `deliverableSection.ts` 与 `admin/src/ui.tsx` 的 `sandboxSection` 都还没有这 3 种类型的归一化分支，会重新剥空——已一并补上（口径对齐 `ReportCard` 原有实现），避免修复自身引入新的 section 类型 drift。验证：`server` `npx tsc -p tsconfig.json --noEmit` 0 错 + 本地真实 PostgreSQL 16 跑通 `npm test` **624/624 全绿**（较基线 620 净增 4 例）。影响面：`server/src/services/{casefile,strategicProfile,deliverableSection,evals}.ts`、`server/src/routes/sessions.ts`（读取报告 V2 sections 的方式，不改 API 契约/数据库结构）；`app/src/services/deliverableSection.ts`、`admin/src/ui.tsx` 补 gauge/matrix/gantt。

- **2026-07-21** · **例行 QA：报告 V2 类型化 section 在「方案库详情」页与运营后台「调教沙盒」仍被静默剥空**：`e193b13`（2026-07-19）修过「V2 typed section 被剥空」，但那次只堵住了 SSE 流式传输通道（`streaming.ts`/`chat/index.tsx`）——`ReportCard`（成果卡）从报告 V2 落地（`f16d517`）起就靠 `cardSection()` 正确处理全部 9 种类型，本身没有这个问题。本轮排查发现另外两个独立展示位从未接入过等价的映射，仍在直接读 `sec.h`/`sec.b`/`sec.list`：① `app/src/packages/work/report/index.tsx`（**用户可见**的「方案库详情」页——内容 tab 的编号章节、版本 diff 的标题栏与改前/改后预览）；② `admin/src/ui.tsx` 的 `DeliverableView`（**运营可见**的「调教沙盒」试跑结果预览，`StudioSandbox.tsx` 复用）。`shared/contracts.d.ts` 把 h/b/list 以“可选”形式挂在所有 section 变体的公共基上，这类代码能通过类型检查、`tsc` 不会报错，但 stats/roster/table/phases/timeline 的真实内容在 `items`/`people`/`rows` 等专属字段，quote/letter 干脆没有 `h`——用真实数据验证：这两处对 quote/letter 会渲染成完全空白的章节（连标题都没有），对 stats/roster/table/phases/timeline 只剩标题（若有）、正文和列表全部消失。「调教沙盒」是运营发布配置前唯一的预览工具，这个坑意味着任何产出报告 V2 内容的智能体配置在发布前实际上无法被正确预览。修复：把 `cardSection` 从 `ReportCard/index.tsx` 提到共享的 `app/src/services/deliverableSection.ts`（新增 `cardSectionText` 供 diff 一行预览复用），`ReportCard` 与 `report/index.tsx` 都改为导入这份唯一实现；`admin/src/ui.tsx` 独立实现同口径的 `sandboxSection`（admin 与 app 是两个独立构建，不跨目录共享运行时模块，遵循仓库既有的「两端各自维护同口径实现」惯例）。为验证与固化这两处此前完全没有测试覆盖的纯函数，给 `app/` 与 `admin/` 各自补上此前缺失的最小测试基座（`node --import tsx --test`，与 `server/` 同一套工具链）：`admin/package.json` 新增 `test` 脚本 + `tsx` devDependency + `admin/tsconfig.json` 排除 `*.test.ts`（避免污染 `tsc -b` 生产编译门，浏览器端项目没有 `@types/node`）；`app/` 同理。新增 `admin/src/ui.sandbox.test.ts`（12 例）+ `app/src/services/deliverableSection.test.ts`（11 例），覆盖全部 9 种类型化 section + 旧版白卡兼容 + 未知 type 降级，均已用「仅读 `s.h`/`s.b`/`s.list` 的旧实现」手工验证过会失败（quote/letter 返回 `{}`）。验证：`server` `npx tsc --noEmit` 0 错 + 本地真实 PostgreSQL 16 跑通 620/620；`app` `npx tsc --noEmit` 0 错 + `npm test` 11/11 + `npm run build:weapp` 编译成功；`admin` `npx tsc -b` 0 错 + `npm test` 12/12 + `npm run build` 成功（含 `lint:ui` 设计系统合规）。影响面：`app/src/components/ReportCard/index.tsx`（改为导入共享函数，行为不变）、`app/src/packages/work/report/index.tsx`（方案库详情页可见渲染修复）、`app/src/services/deliverableSection.ts`（新增共享工具）、`admin/src/ui.tsx`（调教沙盒预览可见渲染修复）、`app/tsconfig.json` + `admin/tsconfig.json`（排除测试文件）、`app/package.json` + `admin/package.json`（新增 `test` 脚本与 `tsx` devDependency）；不改接口契约、不改数据库结构。

- **2026-07-20** · **初诊完成 CTA 去固定轮次化**：速诊结果页按钮由「想要完整作战方案？进参谋室聊 6 轮」改为「继续问策，完善这份判断」，继续进入总军师完整诊断，但不再把内部轮次机制当作用户任务。影响面：小程序速诊结果页可见文案；不改诊断流程、路由或服务端逻辑。

- **2026-07-20** · **小程序 WebView 滚动区与系统信息 API 告警清理**：对话流和参谋室横滑栏不再把 `padding` 直接写在 `ScrollView` 上，统一迁到内层容器，避免微信 WebView 模式忽略留白导致内容贴边；登录平台、安全头、分享卡 DPR 与对话窗口高度改用 `getDeviceInfo/getWindowInfo`，移除 4 处已废弃的 `getSystemInfoSync`；工程约束补充上传/提审前必须恢复合法域名、web-view、TLS 与 HTTPS 证书检查，本机 `urlCheck:false` 仅限局域网临时预览。验证：`npx tsc --noEmit` 0 错；清理旧 `dist`/Taro 缓存后 `npm run build:weapp` 成功，业务分包产物不再含 `getSystemInfoSync`，ScrollView 本体不再输出 padding。影响面：app 登录、安全头、Canvas 分享卡、对话页滚动布局与小程序发版检查；不改接口、数据结构或正式基础库版本。

- **2026-07-18** · **长对话“有记忆但本轮没带入”修复**：生产排查确认客户账号已有长期记忆、模型调用正常，但同一主会话超过 100 条消息时服务端只注入最近 8 条，且模糊的“之前聊过/你忘了吗”仅做 Top5 语义召回，导致较早的社群服务细节未进入本轮上下文。生成链路现改为最近 16 条（12,000 字符预算）；识别回忆意图后额外扫描同会话较早 160 条、按中文业务词重合度带回最多 6 条原始摘录（4,500 字符预算），长期记忆同步扩至 Top12。运行时守卫要求先复述已知事实、只问缺失项，禁止向客户声称“每次对话上下文不会自动带过来”。`LlmTrace` 新增 `contextJson`，记录历史窗口及召回记忆 id/score/source/时间但不存正文，后台调用详情可直接诊断。影响面：server 会话上下文/长期记忆召回/模型提示/trace 数据结构、shared 诊断契约、admin 调用诊断；生产部署需执行 `prisma db push` 后再重启服务。

- **2026-07-18** · **首登建档弹层恢复真机纵向滚动**：`components/Picker` 原先用普通 `View + overflow-y:auto + max-height` 承载长问卷，该组合在 H5 可滚、微信真机却不会形成可靠滚动视口，导致下方问题和提交按钮无法触达。弹层卡片现改为 92vh 定高的原生纵向 `ScrollView`，保留遮罩防穿透、圆角、安全区和现有视觉；会话页同步统一 `Picker`/`Sheet` 依赖导入顺序，消除 weapp 公共样式抽取的顺序警告。影响面：首次登录 30 秒建档、天势档案、“我的本命色”弹层及小程序公共样式构建。

- **2026-07-18** · **军师提问卡输入框随键盘保持可见**：修复真机上填写多题反问卡「其他」答案时，键盘弹出后对话仍贴在最下方、正在输入的题目被遮住的问题。每道自填题现在有稳定滚动锚点，输入框聚焦及键盘高度变化后都会将对应题目滚入对话可视区；键盘高度继续由页面统一接管，收起后清理定位状态，不改底部聊天输入框行为。影响面：小程序对话页军师反问卡多题自填交互。

- **2026-07-18** · **小程序流式对话延长客户端总超时**：线上确认 server 已在 73.6 秒正常完成 `/generate`，但微信 `wx.request` 未设 `timeout`，默认约 60 秒先触发 `fail`，前台遂显示「网络连接中断」。`app/src/services/streaming.ts` 为 `enableChunked` 请求显式设为 180 秒；用户主动停止仍走 `RequestTask.abort()`，真实中断仍保留重试入口。影响面：小程序流式对话客户端；需重新编译/上传小程序包后生效，不改 API 或服务端。

- **2026-07-18** · **模型网关超时从累计时长改为空闲时长**：排查线上 `qnaigc / dj-claude-4.6-opus` 两次 `This operation was aborted` 后，确认均由服务端 60 秒 `AbortController` 触发，而非小程序取消或 Nginx 超时。OpenAI 兼容流式调用现在把 `OPENAI_TIMEOUT_MS` 作为首包及相邻字节空闲上限：每收到一个上游字节即续期，持续输出的长回复不再在累计 60 秒被截断；强制结构化成果（含工具循环终结轮）自动取至少 120 秒预算。超时归一为 `AI_TIMEOUT`，诊断日志记录网关 host、模型、阶段、配置上限、实际耗时，不记录 prompt 或密钥。影响面：server OpenAI provider / gateway 错误映射 / 环境变量说明 / 工程运行口径；不改接口和数据结构。
- **2026-07-18** · **例行 QA：carry forward 周报提醒时区修复 + AGENTS §13 陈旧 TODO 清理 + progress.test.ts 时区嫌疑排查结案**：① 沿用 2026-07-16 例行 QA（PR #42）对 `server/test/reminders.test.ts` 的修复（裸 `Date#getDay()` → `clock.ts` 的 `weekdayOf()`），本轮用本地真实 Postgres 实跑 578/578 全绿复核，并额外用 `clock.ts` 直接仿真复现了 CI 实际失败时刻（UTC 2026-07-16 17:33，`weekdayOf()`=周五 vs 裸 `getDay()`=周四）证实根因，比原 PR 仅凭 CI 日志推断更进一步。② 清理 `AGENTS.md` §13 陈旧 TODO「测试库纪律缺口（2026-07-11）」——该项描述的问题（仓库无 `.env.test`）已被同日晚些的 commit `d9cca13`（P1-7）修复（`.env.test` 入库 + `pretest` 自动 `db push`），且 `docs/CHANGELOG.md` 当时已记录，但 §13 的 TODO 条目未随之移除，属于本仓库自己 §0.3「TODO 完成即移出」纪律的一次遗漏（文档与代码不一致 = 缺陷）。③ 结案 PR #42 记录的另一条「强怀疑但未证实」——`server/test/progress.test.ts` 的 `isoDaysAgo()` 同样用裸本地时区取日期，怀疑与 reminders bug 同根同源：本轮用 `clock.ts` 直接仿真扫描整个 UTC 风险窗口（16:00-23:59）及边界时刻，证实 `reviewStreak()`（`reviewLog.ts`）「今天未打卡就退一天再起算」的既有容错设计恰好完全吸收了 UTC↔Asia/Shanghai 之间恒 ≤1 天的日历偏移，streak 计算在任何时刻都不会算错——**结论：不是同类 bug，判定为已排查确认安全，不改代码**，仅在 `isoDaysAgo()` 处补充注释记录排查结论，避免后续 agent 重复怀疑同一疑点。影响面：`AGENTS.md`（删一条陈旧 TODO）、`server/test/progress.test.ts`（仅注释）、`server/test/reminders.test.ts`（carry-forward，无新改动）；无 API/schema/契约变更。

- **2026-07-16** · **体验版额度与产品路演交付**：体验版月 token 配额由 100,000 提升至 10,000,000；新增 `server/scripts/bumpFreeQuota.ts` 与 `npm run db:bump-free-quota`，支持先试运行、再按需把已有体验版用户的钱包 quota/balance 刷到新额度；新增 `docs/roadshow/junshi-roadshow.html` 路演页及 `.claude/launch.json` 本地静态服务启动项。影响面：套餐同步与存量体验版钱包迁移、产品演示资料；不改数据库结构。

- **2026-07-15** · **例行 QA：聊天流式失败兜底误判导致重复追答 + 下单频控 TOCTOU 竞态 + 基准 CSV 导入朴素分列**：① `app/src/packages/main/chat/index.tsx` 的 `canStreamChat` 分支：`generateStream` 在绝大多数失败场景（SSE `error` 事件、HTTP 非 2xx、fetch 异常、mid-stream 网络中断）返回 `false` 之前都已经调用过 `onError` 把错误话术 + 重试按钮渲染进了这条聊天气泡，但原代码把 `!streamOk` 一律当作「什么都没展示的静默失败」处理，无条件调 `api.generate` 兜底重发一遍——用户会在已展示的错误气泡后面看到一条自动补发的重复回复，且后端真的被多打了一次 LLM 请求（对高频的默认聊天路径尤其浪费）。对照下方 `canStreamReport` 分支已有的 `!reportStarted && !chatStarted` 护栏（同一份代码里已验证过的正确写法），说明这是遗漏而非有意设计。修复：新增本地 `chatErrored` 标记（在 `onError` 回调里置位），兜底重发改为 `!streamOk && !chatErrored`，只有 `onError` 从未触发的真正静默失败（如 weapp 请求还没吐出任何内容就 `fail`）才走兜底。② `server/src/services/wechatPay.ts` 的 `assertOrderRate`：原实现是无锁 `count()` 后再判断，与随后的 `paymentOrder.create` 不在同一事务里，属于经典 TOCTOU——并发下单请求可以一起读到同一份「未过 10 单」的计数，一起放行超出 `ORDER_RATE_MAX`（10 单/10 分钟）的下单量，各自触发真实出站调用微信 JSAPI 下单接口（与已修复的证书拉取节流绕过是同一类漏洞，但在下单这条路径上此前没有一并堵上）。修复：把频控判定挪进 `pg_advisory_xact_lock(hashtext('orderrate:'+userId))` 锁住的事务里，与订单落库合并为一次原子操作，锁随事务提交/回滚释放（不包住后续调微信 API 的出站请求，避免长时间占用 DB 连接）。③ `admin/src/App.tsx` 的行业基准 CSV 批量导入 `onImport`：用朴素 `line.split(',')` 分列，`note`/`source` 等自由文本字段一旦包含逗号（如从 Excel 编辑后再导出的常见情况）会让后续列全部错位、静默产出错误的 `p25/p50/p75` 数值而非报错。修复：新增最小 RFC4180 单行 CSV 解析 `parseCsvLine`（支持 `"..."` 包裹字段与 `""` 转义引号），替换朴素 `split`。验证：`npx tsc -p tsconfig.json --noEmit`（server，含 `prisma generate`）0 错；`npx tsc -b`（admin）0 错；`npx tsc --noEmit`（app，仅原有 2 条与本次改动无关的 `moduleResolution`/`baseUrl` deprecation 警告，非 error，exit 0）。影响面：`app/src/packages/main/chat/index.tsx`（仅 `canStreamChat` 分支内部状态跟踪，不改契约）、`server/src/services/wechatPay.ts`（`assertOrderRate` 签名内部化为接收 `Prisma.TransactionClient`，仅内部调用点改动，不改 API/契约）、`admin/src/App.tsx`（仅 CSV 导入解析逻辑，不改导出/契约）；不改数据库结构。

- **2026-07-14** · **例行 QA 安全修复：支付回调证书拉取节流可被绕开（放大攻击）+ admin 导出 CSV 公式注入**：① `server/src/services/wechatPay.ts` 的 `fetchPlatformCertificates`：`/pay/wechat/notify` 是 `permitAll` 的公开 webhook，`verifyNotifySignature` 遇到缓存里没有的 `wechatpay-serial` 头就会以 `force=true` 强刷证书；但原逻辑 `force=true` 会同时绕开「缓存新鲜度」与「失败退避 5 分钟」两条短路，等于攻击者每次带一个伪造/随机 serial 都能触发一次真实出站请求打微信证书接口——放大攻击且可能拖累微信侧对本商户真实证书请求的限流。修复：新增 `lastAttemptAt`，不论 `force` 与否，距上次尝试不足 `CERT_RETRY_MS`（5 分钟）一律短路返回缓存，彻底堵死重复伪造 serial 的放大路径；`resetPlatformCertCache` 同步重置。② `server/src/routes/admin.ts` 的 `GET /admin/payments/export`：CSV 转义函数 `esc` 只转义双引号，未中和以 `=`/`+`/`-`/`@` 开头的字段——而导出行包含用户昵称（`routes/meta.ts` `PUT /me` 允许任意 20 字内自由文本，无字符限制），攻击者可把昵称设为 `=HYPERLINK(...)` 之类公式，运营用 Excel/Numbers/Sheets 打开导出的 CSV 时会被动执行该公式（经典 CSV/公式注入，可用于数据外泄）。修复：`esc` 对以 `= + - @` 开头的字段值加前导单引号中和，Excel 按纯文本渲染，不影响正常内容可读性。验证：`test/wechatPayMockFlow.test.ts` 新增 2 例回归测试（均已确认在修复前失败、修复后通过：证书节流用 `globalThis.fetch` 计数断言 3 次伪造 serial 强刷只触发 1 次真实出站；CSV 注入用恶意昵称下单后导出断言字段带前导单引号中和）；server 全量 563/563 绿（新增 2 例）、tsc 0 错。影响面：`server/src/services/wechatPay.ts`（导出的 `fetchPlatformCertificates`/`resetPlatformCertCache` 行为收紧，无 API/契约变化）、`server/src/routes/admin.ts`（仅 CSV 转义逻辑，响应结构不变）、`server/test/wechatPayMockFlow.test.ts`；不改数据库结构、不改契约。

- **2026-07-14** · **例行 QA：普通聊天气泡在小程序端网络中断时永久卡在「产出中」**：`app/src/services/streaming.ts` 的 SSE 流终态兜底（`state.finished`）此前只覆盖了 H5 fetch 路径正常读流结束的场景；weapp 端 `wx.request({..., fail: () => resolve(false) })` 的失败回调从不调用 `onDone`/`onError`。报告卡 UI 有 `chat/index.tsx` 的 `finally` 双保险兜底（无论如何强制把 `streaming` 置 false），但普通聊天气泡（`chatStarted` 分支）没有等价兜底——若 weapp 请求已收到部分 chunk（气泡进入 `streaming:true`）后网络中断走 `fail` 回调而非 `success`，气泡会永久停在「产出中」，用户无法重试。修复：`fail` 回调里，非主动中断（`!aborted`）且已有产出但未终态时补发一次 `onError`（复用既有 `state.finished` 幂等标记，语义对齐已有的 H5 兜底注释风格）。影响面：仅 `app/src/services/streaming.ts` 一处；不改契约、不改后端。验证：`npx tsc --noEmit`（app）0 错；`npm run build:weapp` 编译成功；该文件历史上无既有单测覆盖，未新增（沿用仓库对这个纯前端 Taro 服务文件的既有验证方式）。

- **2026-07-14** · **支付收尾：admin 支付运营 UI + 订单搜索/分页/导出 + 平台证书自动轮换**：① 运营后台「订单」页补齐操作 UI（仅 owner/master 可见资金操作）：**退款按钮**（明细行 applied/paid 与卡单区 paid_unapplied，prompt 原因 + 服务端幂等回收权益，错误文案透传）、**搜索框**（单号包含/用户名/手机号，回车或点搜索生效）、**分页**（服务端 page/pageSize + total，默认 20/页）、**导出 CSV**（`GET /admin/payments/export`，owner/master 专属，BOM+UTF-8 含完整单号/手机号/快照商品名，上限 5000 行，审计记操作人）；`req()` 错误信息改为透传服务端 `error` 文案。② 用户详情「运营动作」新增 **开通套餐**（下拉选套餐 → `POST /admin/users/:id/plan`，含无套餐用户）与 **模块管理**（按 moduleKey 发放/收回）。③ **平台证书自动下载/轮换**：`fetchPlatformCertificates()` 调 `GET /v3/certificates`、APIv3 密钥 AEAD 解密后按 serial 内存缓存（TTL 12h，未知 serial 强刷一次，失败 5 分钟退避），`verifyNotifySignature` 改按回调头 `Wechatpay-Serial` 选证书、`WECHAT_PAY_PLATFORM_CERT` 静态证书降为兜底——平台证书 5 年轮换期新旧并存也无感；`decryptNotifyResource` 拆出 `decryptAeadResource`（证书明文是 PEM 非 JSON）。mock 网关补 `/v3/certificates` 端点。验证：`wechatPayMockFlow` 14 用例（新增 证书轮换验签+篡改 401、搜索/分页/导出 2 例）、全量 561/561 绿、`pay:e2e` 22/22、`pay:e2e:mock` 19/19、server tsc 0 错、admin tsc+vite+lint:ui 全绿（app 本轮无改动）。影响面：`server`（wechatPay/wechatPayMock/admin 路由）、`admin`（PaymentsView/OpsActionModal/api）、`shared/contracts.d.ts`（AdminPaymentsView 加 total/page/pageSize）。支付 review 遗留仅剩：部分退款、发票。
- **2026-07-14** · **支付 P1/P2 落地（退款/快照/关单/订单历史/继续支付/频控/归因/支付消息/手动开通）**：① `PaymentOrder` 新增 `snapshotJson/refundId/refundedAt/refundReason`（纯加法，prod 部署带 db push）；下单落**套餐/SKU 条款快照**，发放（`markPaidAndApply`）优先按快照，防「下单后改价/删配置」漂移，也让 plan/sku_not_found 卡单可自愈；② 下新单自动调微信 **close-order** 关同类旧 created 单（套餐单关全部旧套餐单、SKU 单关同 key），远端关掉才置本地 closed——彻底消除「折算下单→续费→再付旧折算单」的 2h 套利窗；③ **全额退款闭环（后端）**：`refundWechatOrder`（v3 /refund/domestic/refunds，同退款单号幂等）+ 权益回收（模块停用/一次性凭据收回/存储加档追回/套餐立即到期+追回未消耗算力，advisory lock 串行化）+ `POST /admin/payments/:no/refund`（requireSuper，双审计）+ notify 识别 `REFUND.*` 事件幂等补记，UI 后续补；④ **用户订单历史/继续支付**：`GET /pay/orders`（本人 50 条，含快照商品名/payable）+ `POST /pay/orders/:no/pay-params`（未过 2h−10min 时限的 created 单重签调起参数）；前台订单明细页（credits）新增「支付订单」段，待支付单一键继续支付并走统一到账确认；⑤ **下单频控** 10 单/10 分钟（429 `ORDER_RATE_LIMITED`）；⑥ **套餐订单归因**：`/plans/:id/order` 接 `source/refId`，入账落 `ActivationEvent(itemType='plan')`；⑦ **支付到账订阅消息**：新增 `payment` 场景（`WECHAT_SUBSCRIBE_PAYMENT_TEMPLATE_ID`），入账后事务外发送，未配模板静默跳过；⑧ **admin 手动开通（后端）**：`POST /admin/users/:id/plan`（补齐 plan-extend 的 NO_PLAN 缺口，复用 applyPlanPurchase，source='admin_grant'）、`POST/DELETE /admin/users/:id/modules[...]`（UserModule source='admin'）；⑨ 前端：Plans 折算单付款前弹「实付/抵扣」确认、直达 `PAYMENT_COMING_SOON` 友好提示；四触点接 `ensurePayableEnv` H5 守卫（server 模式 H5 下单前拦截）+ `requestWechatPayment` 统一调起；mock 层同口径补 `myOrders/orderPayParams`。mock 微信网关补 关单/退款 端点。验证：`wechatPayMockFlow` 12 用例（新增快照/关单/续付/退款/频控/手动开通 5 例）+ 全量 559/559 绿、`pay:e2e` 22/22、`pay:e2e:mock` 19/19、三端构建绿。影响面：`server`（wechatPay/wechatPayMock/pay/plans/admin/scheduler/wechatSubscribe/activation + schema）、`app`（services/pay + api/mock + Plans/PaySheet/thinktank/credits 页）、`shared/contracts.d.ts`（`PayOrderListItem/PayOrderListResult/PayRepayResult` 加法 + `PayOrderStatus.status` 增 refunded + `WechatSubscribeScene` 增 payment）；admin 前端本轮不动（端点已就绪，UI 排后）。
- **2026-07-14** · **支付 P0 收口（跨三端 review 后落地七项）**：① 回调/查单入账前校验解密报文的金额/appid/mchid 与本单一致（`markPaidAndApply` 新增可选比对字段），不一致绝不入账、订单保持原状态、原文落 `rawNotifyJson` 供排查（防串单/伪造）；② 新增 `pay-reconcile-sweep` 定时任务（5 分钟）：paid 未 applied 查单补账、created 超 15 分钟查单、微信侧无单且超 time_expire 的 created 单本地关单（`sweepPendingOrders`，查单 404 区分 `WECHAT_PAY_ORDER_NOT_EXIST`）；③ 套餐降级守卫：`POST /plans/:id/order` 对「活跃付费套餐 → 不同套餐」仅放行同套餐续费与月→年折算升级，其余 409 `PLAN_SWITCH_BLOCKED`（防切换重置锚点烧剩余时长），企业版套餐调整仅走运营；④ 前端支付到账确认统一收口 `app/src/services/pay.ts`（`awaitPaymentApplied` 轮询 `GET /pay/orders/:outTradeNo`）：套餐 Plans、通用 PaySheet、智库深度整理、模块开通四触点接入——`appliedAt` 有值才报成功，否则如实提示「到账中稍后生效」；支付成功后刷新失败不再被误报为「支付失败」（钱已扣）；mock 层新增同口径 `payOrderStatus`；⑤ admin「订单」页新增卡单清单（paid 未发放 = 资损优先 + created 超 30 分钟，带完整商户单号）与「查单补账」按钮（`POST /admin/payments/:outTradeNo/reconcile`，幂等、审计带操作人），订单列表回传完整 `outTradeNo`（点击复制）、状态筛选补 `applied`、清除不存在的 `refunded` 死映射；⑥ 改价内控：`PATCH /admin/plans/:id`、`PATCH /admin/skus/:key` 加 `requireSuper`（与资金三写同级），审计带操作人与前后快照，套餐 PATCH 由 `data: req.body` 直透改为字段白名单 + 数值校验（堵 mass-assignment）。验证：server 全量 554/554 绿（新增 4 例：金额不一致拒绝、降级守卫、sweep 补账/关单、admin 卡单/补账/幂等）、`pay:e2e` 22/22、`pay:e2e:mock` 19/19、server tsc 0 错、`build:weapp` 通过、admin `lint:ui`+`tsc -b`+`vite build` 全绿。影响面：`server`（wechatPay/pay/plans/admin/scheduler）、`app`（services/pay 新增 + api/mock + Plans/PaySheet/thinktank）、`admin`（PaymentsView + api）、`shared/contracts.d.ts`（`AdminPaymentStuckItem`/`AdminPayReconcileResult` 纯加法 + `AdminPaymentItem.outTradeNo`）；不改数据库结构。遗留 P1/P2 见 AGENTS.md §13 支付段。

- **2026-07-14** · **微信支付模块补全：本地 mock 微信网关走通真实加解密链路 + 主动查单补账 + 订单状态轮询端点**：① 新增本地 mock 微信支付服务器（`server/src/services/wechatPayMock.ts` + `npm run pay:mock` 独立启动，密钥持久化 `server/.paymock/` 已 gitignore）——原样模拟微信 v3 网关：JSAPI 下单校验商户 Authorization RSA 签名后发 `prepay_id`、商户查单、`POST /mock/pay/:no` 按官方报文格式（APIv3 密钥 AES-256-GCM 加密 resource + 平台私钥签名 `Wechatpay-*` 头）真实 HTTP 投递回调；`services/wechatPay.ts` 的 API 基址支持 `WECHAT_PAY_BASE` 覆盖指向 mock，真实商户网关默认不变。② 补 TODO「主动查单对账」：`queryWechatOrder`（签名 GET 查单）+ `reconcileOrder`（SUCCESS 走与回调同一 `markPaidAndApply` 幂等底座入账、终态失败标 failed、NOTPAY/USERPAYING 中间态不动）。③ 新增鉴权端点 `GET /pay/orders/:outTradeNo`（契约 `PayOrderStatus`，仅本人订单）：未发放且配齐支付时先查单补账再返回状态，前端 `requestPayment` 成功后轮询到 `appliedAt` 即权益到账，消除回调丢失/延迟竞态（自愈）。④ 验证：新增 `npm run pay:e2e:mock`（19 项断言：下单验签/paySign 可验/加密回调入账/幂等/篡改签名 401/查单补账/越权 404）与 `test/wechatPayMockFlow.test.ts`（4 用例入 `npm test`）；`pay:e2e` 22/22、`wechatPay.test.ts` 4/4、server tsc 0 错保持全绿。影响面：`server`（wechatPay/wechatPayMock/pay 路由/两个 scripts）、`shared/contracts.d.ts`（纯加法 `PayOrderStatus`）、`.env.example`（`WECHAT_PAY_BASE`）；不改数据库结构，真实支付路径行为不变（仅基址可配 + 新增查单）。
- **2026-07-13** · **小程序履历与智库流程收口、H5 底栏白屏防护**：H5 自定义底栏改用 portal 脱离 Taro 路由容器，避免非 Tab 页面被路由样式误隐藏；完整履历入口补充分包跳转失败/导航锁提示，首次有档案线索时自动生成不再被旧状态门禁拦截，并增加加载失败重试与卸载保护；智库正文预览改为限高可滚动，确认入库增加处理中状态和同步防重。影响面：`app` H5 壳、完整履历页/入口、智库页；不改接口、数据结构与服务端配额计算。
- **2026-07-13** · **军师反问结构化选项（提问即出可点选项卡）**：军师向用户提问时不再只靠正文追问——契约 `ChatReply` 新增 `asks?: ChatAsk[]`（`{q, options[]}`）；服务端 prompt 增设「提问选项协议」（常驻 stable 段保提示词缓存，访谈指令联动），模型在回复末尾附 ` ```ask ` JSON 块，`schema.extractAsks` 解析归一（q≤120 字、每题 2-4 选项、最多 4 题，JSON 非法也剥离防漏原文），gateway 所有 ChatReply 出口（chatComplete/流式 done/generateAdaptive/mock 兜底）统一过 `withAsks`；mock 访谈分支产出带选项三问供离线联调。前端 chat 页在「最后一条实质消息」为带 asks 的军师回复时渲染内联选项卡（其后出现用户消息/报告自然失效，历史消息不误激活）：单问题点选即发送、点「其他…」聚焦输入框；多问题每题一组选项 + 「其他…」内联自填，答完「发送回答」按 `问题 答案` 逐行合并发出（用户气泡补 `white-space: pre-line` 保行）；流式期间 `visibleStreamText` 隐藏尾部半截 ```ask 围栏，onChat 权威替换；选择草稿按消息索引挂靠 + 函数式更新防连点覆盖。影响面：`shared` 契约、`server` schema/gateway/mock（+askOptions 5 例单测，21/21 绿）、`app` chat 页与样式；不改数据库结构，H5 全链路实测（三问点选+其他自填+合并发送+选项卡失效）通过。：我的页与个人档案入口增加分包跳转失败反馈，导航防重锁命中时也显示等待提示；履历页修复首次读取完成后仍被旧 `ready=false` 状态拦截自动生成的问题，增加同步防重、卸载保护和加载失败可重试状态，错误继续走全局鉴权/网络处理。影响面：`app/pages/profile`、`app/packages/main/brief`、`app/packages/work/dossier`；不改接口和数据结构。
- **2026-07-13** · **智库剩余空间按整数 MB 展示**：空间额度卡改为“可用/总量”口径，剩余字节换算 MB 后向下取整；例如 200MB 总额度上传 20KB 后显示 `199/200MB`，避免通用字节格式四舍五入后仍误显 200MB。影响面：`app/pages/thinktank` 展示逻辑；不改服务端配额计算、接口和数据结构。
- **2026-07-13** · **智库确认处理中状态与限高预览**：确认入库增加同步防重锁和可见处理中状态，服务端切片/建索引期间锁定按钮、上传及阶段切换，完成真实刷新后再进入知识库；正文预览改为短文自适应、最高 300px 的纵向 `ScrollView`，长文在展开框内滑动。影响面：`app/pages/thinktank` 交互与样式；不改接口和数据结构。
- **2026-07-13** · **智库确认前文件核对闭环**：`OrganizeItem` 增加文件类型、名称来源和正文预览；新上传显示源文件名，历史源名丢失时从 Markdown 首标题生成明确标注的识别名，`growth` 等服务端分类 key 统一显示中文。整理完成与已优化列表均可逐份展开正文，空正文明确提示；确认改为按当前条目 ids 提交并增加二次确认，修复刷新后 `activeBatch` 丢失导致无法确认。影响面：`shared` 契约、`app` 智库/mock、`server` 整理管道；不改数据库结构。
- **2026-07-13** · **资料文件名全链路归一**：修复资料详情页仍显示 `tmp_`、资料库标题优先取「上传资料」占位名、mock 上传未保存源名的问题；列表、详情和整理管道统一优先有效 `fileName`，过滤微信临时路径及通用占位名，新上传 mock/server 均保留源文件名。影响面：`app` 资料库/资料详情/mock 上传、`server` 知识库响应与上传命名；不改数据结构。
- **2026-07-13** · **源文件名落库与整理阶段选中态增强**：上传链路只把客户端有效源文件名写入 `KnowledgeItem.fileName`，`tmp_`/`wxfile:` 等临时路径不再落库；已无法恢复源名的历史记录显示「待识别资料」或分类兜底。智库三段整理 tab 增加容器底色、强调色边框、选中文字和底部指示条。影响面：`app` 上传入口/资料库/智库页、`server` 知识库上传命名与单测；不改数据结构。
- **2026-07-13** · **资料库文件名与整理动线修正**：历史微信临时名（`tmp_`/`wxfile:`）在服务端管道、资料库列表/详情和智库页统一显示为可读兜底名，新上传继续保留原始文件名；案卷资产页新增「资料已接收 → 开始资料整理 → 待确认 → 确认入库」下一步引导，整理完成状态改为「待确认」，确认/同步动作补充明确按钮。影响面：`app` 智库与资料库页面、`server` 知识库展示响应与上传兼容、文件名单测；不改数据结构，历史数据库无需迁移。

- **2026-07-13** · **修复小程序对话页首次打开白屏**：真机/DevTools 复现并定位为 `packages/main/chat` 首屏两个动态 `style` 字段向 Taro 传入 `undefined`，微信运行时在 `finalizeInitialChildren` 执行 `undefined.toString()` 导致整页挂载失败；CSS 变量改为明确 `0px` 默认值，发送键无动态背景时改传空样式对象。影响小程序对话页首屏挂载，不改接口与数据结构；`build:weapp` + DevTools 实际进入对话页验证。
- **2026-07-13** · **打磨后续批次：白屏硬化 + 知识库整改 + 三项还债（主模型裁决 + Opus 多代理执行）**：
  - **① sessions 白屏防御性硬化（`5b01c2e`）**：用户报会话首页白屏；h5 Playwright 双态（未登录/已登录）×5 tab 共 10 组复现全部正常、pageerror 为零，循环 import/AsyncState/token 作用域（反编译 wxss 核实 `--z-*` 与 `--accent` 同在 `page{}` 块）/showLogin 循环/分包懒加载五嫌疑逐条排除。最可疑点=本轮把 Login（scroll-view 内 fixed 全屏层）与弹层 z-index 从字面量改 `var(--z-*)`，而库内已有「weapp 真机 page 级 token 链式引用不稳定」的文档化结论。裁决：**z-index 属性全库回退字面量（950/900）**，`--z-*` 定义保留作标尺并注明「weapp 端 z-index 请写字面量」；`--fs-*`/`--space-*` 等非布局关键 token 不动。⚠️ 后续定论：真实根因由 main `5a04fdc` 定位修复——对话页（chat）首屏 style 传 `undefined`（含本轮 Wave B 引入的 `--jump-bottom: undefined`）致 weapp `undefined.toString()` 挂载崩溃；本条 z-index 回退非根因，保留为防御性硬化。教训入库：**weapp 动态 style 字段严禁传 undefined**。
  - **② 知识库（资料库）四项整改（`3cc1bd6`，app+server）**：长文件名溢出——列表/详情标题、meta、chat `@引用` chip 补省略+断词；**上传原始文件名**——前端 `chooseMessageFile` 的 `file.name` 经 multipart `originalName` 透传，服务端新增 `sanitizeUploadName`（去路径分隔符/控制字符/超长截断保扩展名，7 例单测）后作展示名，老客户端缺字段回退旧行为，存储 key 维持 `randomUUID`（免重名免注入，未采用「时间戳+原名」方案）；**内容可查看**——根因是锦囊 tab 目录卡只显示「N 份」且不可点入，现在可点入逐份清单，knowledge 列表项重做为「原名+摘要+类型/大小/时间+解析状态徽章」（服务端 `KnowledgeDocRow` 补 `summary` 字段），详情正文支持展开全文+AsyncState 三态；**上传真进度/真取消（记债⑥清账）**——`uploadKnowledgeFile` 透出 UploadTask（`onProgress/onTask` 钩子，旧调用点兼容），chat/knowledge 上传显示真实百分比、取消调 `task.abort()` 真中止。
  - **③ 报告流失败语义收敛（记债⑩，`87e2bbd`）**：`degraded`（后端完整保底草案标记，免扣额度）与 Wave B 新加 ↻ 重试共用状态位导致「保底草案」与「生成中断请重试」两套话术并存。收敛为单一话术：有部分内容→trust 行「生成中断——已生成部分已保留，可点击重试补全」+ ↻（degraded 位保留供埋点）；完全无内容→不留半空报告卡，就地替换为普通错误气泡+重试（审核类错误不给重试）；restore 的中断报告同套话术+重试；「认可·去执行」guard 收紧为 `!degraded && !retryText`（须先补全再认可）。
  - **④ Sheet 基座抽取（记债②，`d9c9fd4`）**：新建 `components/Sheet`（visible/onClose/title/footer/maskClosable/onMaskClose/align/panelClassName），内聚弹层五要素（z-index **900 字面量**、遮罩 `rgba(22,25,29,.55)`、`sheet-rise`、`var(--r-lg)`、catchMove）+ `setOverlay` 桥接；PaySheet/OnboardSheet（遮罩关闭「置已看」语义经 `onMaskClose` 表达）/ExceptionSheet/AgentUnlock/Plans 五弹层迁入，视觉零回归；sweep 实收编 **5 处**漏网 overlay（工单 3 处 report 军令同步屏/profile 详情/thinktank 双 sheet + 额外发现 home 三势全解/studio 目标编辑——后者因键盘避让 transform 与入场动画冲突就地对齐五要素不迁基座）；全库无 `rgba(15,17,20)` 遮罩残留。h5 Playwright 实测 AgentUnlock 弹出/关闭计算样式与截图无断裂。
  - 全批次 app tsc/weapp/h5 三绿；**记债余额**：存量字号 token 迁移（codemod 分批）、chat 虚拟化（待长度分布数据）、Segmented 公共组件、Icon mask-image 方案、credits 分页（需服务端）、brandkit 硬编码色、a11y 语义推广。
- **2026-07-13** · **前端交互精细化打磨（四路并行审查 → 五波执行；方案 `[FABLE5]UX_POLISH_2026-07-13.md`）**：以「可用性硬伤 + 专业感一致性」为主，重构类大动作记债不做。
  - **① Wave A 基建（app.scss/共享组件）**：token 补层（`--fs-*`/`--space-*`/`--shadow-sm`/`--z-nav|sheet|full`、`--r-*`）；`--ink-3` 由 `#969BA1`(≈2.6:1) 提到 `#7E848B`(≈3.5:1) 改善对比度；按钮三态基类 `.btn/.btn-primary/.btn-ghost/.btn-danger`（48px/圆角 14px/active 按压/disabled），六个 Sheet 主次按钮迁入（Plans 40px→48px）；弹层五要素统一（`z-index=var(--z-sheet)=900`、遮罩 `rgba(22,25,29,.55)`、入场 `.sheet-rise`、圆角、catchMove）；`navTo()` 防重入导航工具（800ms 时间锁 + in-flight 锁，fail 回调释放）；`AsyncState` 三态组件；NextStepCard/PrescriptionStrip 接 accent 族 token 去 theme-blind + `:active` + 占位高度防位移；MarkdownText 走 memo/按 text 缓存。
  - **② Wave C 五 tab 页 + custom-tab-bar**：studio/thinktank/profile 补齐登录门（对齐 sessions/home）；三态落地（sessions 失败态可重试不再伪装空态、home/thinktank 骨架与重试）；跳转全量换 `navTo()` 防重入；触控热区透明外扩至 ≥44px；文案统一走 `REVIEW_TIME` 常量、去英文口吻（SKILL CENTER/深度 Skill → 「能力」）。
  - **③ Wave B chat·brief·settings**：滚动「贴底才跟随」单一策略（上滑停跟随 + 回到最新，聊天与报告两链路共用）；生成中发送键切「停止」接 abort；草稿 onBlur/useDidHide 持久化并回填；报告卡失败挂重试、history restore 下发 `saved` 真值防重复入库；SSE 错误改中文友好话术（raw 仅入日志）。
  - **④ Wave D work 分包 19 页**：report「同步为军令」in-flight 防抖禁用（防重复记账）；ledger/project 等吞错改错误态 + 重试、首屏 loading 防闪空态；`calc(100vh-魔法数)` 改 flex/动态头高、底栏补 `constant()/env()` 安全区回退；quickscan 套 themeClass、market 处方卡内联 hex → token；创建/加资料成功后再清空输入 + busy 防重。
  - **⑤ Wave E 终验（本次）**：双端 `build:weapp`/`build:h5` 联合编译通过（四波各自仅跑过 tsc，本轮补联合验证）；口径复查漏网就地修掉——`settings/sessions` showModal `confirmColor: #c0392b` → `#9C4A38`(=var(--danger)) 带注释、`credits.scss .cd-rd.neg` 硬编码 → `var(--danger)`、两处 Icon 烘焙 `#9C4A38` 补注释、mock `reminders.review` 与 reminders 页注释 `20:30` → `21:30`（走 REVIEW_TIME 口径）、chat/brief/community/bindings/knowledge-detail 十处裸 `Taro.navigateTo` 全量迁 `navTo()`；交叉冲突抽查（六 Sheet 按钮基类/遮罩/z-index、NextStepCard/PrescriptionStrip accent 族 token）无断裂。app tsc/weapp/h5 三绿。
- **2026-07-12** · **生产部署核销 `4ee133c`（admin 运营能力改造）**：备份 `/tmp/junshi-db-backup-20260712-025139.dump`(1.9M) → deploy-prod.sh（无 schema 变更，db push already in sync）→ 验证 health/deploy-version/服务 active/启动日志干净/新端点 GET 冒烟（overview 带 deltaPct、payments 结构完整、users 含 tokenUsed30d）/admin 静态资源已更新 全过。纯 server+admin 网页变更，**无需 weapp 发版，部署即全量生效**。⚠️ `.env EACCES` 瞬时告警**第三次复现**（prisma generate 阶段，自愈未阻塞）——已从「观察」升级为「立案排查」：deploy 脚本远端构建的 .env 归属/权限时序。另记：远端 DATABASE_URL 带 `?schema=public` 会使 pg_dump CLI 解析报错，备份时需剥离该参数（脚本可固化此处理）。
- **2026-07-12** · **Admin 运营能力改造（用户反馈「看不到用量/数据假/没运营动作」→ 评审+改造；主模型规划 + Opus 双代理执行，方案 `[FABLE5]ADMIN_OPS_PLAN.md`）**：
  - **① per-user 用量下钻**：`GET /admin/users/:id/usage`（月度额度 getQuotaState/套餐 getPlanStatus/30 天 token 全 SQL 聚合 byModel/byAgent/byDay 上海日历日/钻石流水 20/支付订单 10 尾 6 位脱敏/开通归因 10）；用户列表补 `tokenUsed30d`+`quotaRemaining`（批量 groupBy 无 N+1，-1 不限量/null 无钱包）。
  - **② 三个资金运营写端点（owner-only requireSuper + 审计 before/after）**：调整/按套餐重置月度 token 额度（复用 setQuota）、补发/扣减钻石（走 credits 服务、reason 必填存 `admin:` 前缀、扣减越界 400 拒绝）、延长套餐有效期（仅推 planExpiresAt=max(now,现值)+days，不动快照/锚点/钱包）。
  - **③ 假数据修正**：`/admin/overview` 删硬编码 trend 箭头，改近 7 天 vs 前 7 天真实环比（无前期数据→null 显示「—」）；「累计消耗（点）」正名「钻石消耗」；新增第 5 卡「30 天 Token 成本(¥)」。契约 `Overview.stats` 改形 `{t,v,deltaPct,sub}`（仅 admin 消费，已核实 app 无引用）。
  - **④ 支付订单可见**：`GET /admin/payments`（状态筛选/7-30-90 天/实收含 paid+applied/按日金额上海日历日）+ admin 新「订单」tab（纯只读，退款流程挂 backlog）。
  - **⑤ admin 前端**：用户详情顶部「用量与额度」块（额度 meter/30 天四格/byAgent·byModel 前 3/byDay 迷你分布不引图表库/三折叠流水）+ 运营动作确认弹窗（仅超管渲染，后端双重闸）；用户列表「已消耗 X 点」正名「钻石消耗」+ 30 天 Token 列；Token 榜 Top 用户点击下钻用户详情。金额统一后端回分、前端转元。
  - **明确不做（backlog）**：封禁（需 User 加列+双闸）、退款（需 refunded 态+微信退款 API）、admin 直改 planId（快照语义冲突）。server 532/532（+20）；admin lint:ui+build 绿。**纯代码+契约变更，无 schema 迁移**。
- **2026-07-12** · **生产部署核销 `a2c763c`（知识库可见性修复）**：备份 `/tmp/junshi-db-backup-20260712-022353.dump`(1.9M) → deploy-prod.sh（schema 无变更 already in sync）→ 验证 health/admin/deploy-version/服务 active/启动日志干净 全过。注意：远端 prisma generate 阶段的 `.env EACCES` 瞬时告警连续两次部署出现（不阻塞，疑似构建用户与 junshi 用户权限时序），下次部署若恶化需排查 deploy 脚本的 env 归属时序。**用户可见改动需 weapp 发版后生效。**
- **2026-07-11** · **知识库可见性修复（用户反馈「看不到上传了啥/整理成了啥」→ 诊断 7 断点全修；主模型规划 + Opus 执行）**：
  - **server**：批次逐份文件清单（`KnowledgeBatch.files`，原 select 层丢字段）+ 整理结果逐份分类/摘要回传（`OrganizeResult.items`，摘要本已写库未回传）+ 已优化区持久化数据源（`optimizedItems`，原为前端瞬态 state 切 tab 即失）+ 资料库透出 `stage`（staged 失败项如实 failed）；**深度整理 ¥39 差异化产出《资料整理报告》**（逐份 structuredMetered 精炼摘要·幂等跳过·失败不编造 + 5 节报告走 saveReportVersion 版本去重 + reserveQuota(0.3) 保守结算），原付费产出与免费仅差两字标题。
  - **app**：待整理批次改可展开逐份清单（状态徽章「已备好/在读/排队/读不出」+失败标红删重传）；整理结果改逐份归档表（文件→类目·摘要、重复合并标注、深度整理「查看整理报告」跳方案详情）；已优化区改 pipeline 持久数据源（刷新不丢、计数一致）；资料库列表/详情 stage 标注 + 待整理副文案 +解析退避轮询（2s→4s→8s，30s 上限+下拉刷新）。
  - **附带**：修 reviewLog 测试时区时间炸弹（根因=测试用本地 TZ 造数 vs 实现按上海日历，实现无 bug；注入时钟后 4 时区验证通过）。server 512/512、app tsc/h5 构建绿。
- **2026-07-11** · **生产部署核销 `5457bd9`（批次三全量）**：备份 `/tmp/junshi-db-backup-20260711-222749.dump`(1.3M) → deploy-prod.sh（db push 5 处纯加法过、未用 ACCEPT_DATA_LOSS）→ `seedBenchmarks.ts` 插 17 行基准占位（p50 空待运营回填，回填前不注入）→ 验证 health/agents 4+1/admin/deploy-version/服务 active 全过。**待办：weapp 发版（分包结构有变建议先真机回归）；运营录入 EcoTool appId（须同主体关联）与基准 p50 回填。**
- **2026-07-11** · **批次三·第二波（WO-08 admin 面 + D-3-3 健康度 + D-3-4 转图片 + D-3-7 前端 + 主包瘦身；主模型规划 + Opus 执行）**：
  - **① WO-08 行业基准库 admin 维护面**：CRUD + CSV 逐行导入 + 三行业占位种子（p50 留空「待运营核实」，空分位不注入、幂等 create-only 不覆盖运营真数）。
  - **② D-3-3 健康度估测框架**：月复盘落库挂钩、输入全服务端算好、空维强制 na 且不触达 LLM、同月幂等、落 `kpiJson.health`、月战报【健康度·军师估测】只读落库值（高/中/低水位、禁百分比、na→暂无法评估）。
  - **③ D-3-4 报告分享转图片（app）**：报告卡/方案库分享改品牌分享图（标题+首节核心结论+落款，无全文与敏感数字），发好友/存相册；移除复制链接，webview 自用保留。
  - **④ D-3-7 前端收口（app）**：处方 external 走 `navigateToMiniProgram`（缺 appId/非 weapp 降级）；开通归因 source/refId 三入口贯通（处方/锦囊 catalog/市场 market）。
  - **⑤ 主包瘦身（app）**：chat/brief/settings 迁 `packages/main` 分包 + preloadRule，主包 1120KB→992KB；15 处路由路径全量修正。
  - **⑥ WO-03 收尾**：`progressBriefing` streak<3 不注入准确率/命中率百分比。
  - **⑦ 卫生项**：bizMetric 填报校验（周一+行业模板 key）、journey 条件 updateMany 消竞态、记忆治理接口补 tenantId、prescription 注释对齐。
  - 合并终审：server 507/507、app tsc/weapp/h5 构建绿、admin lint:ui+build 绿。
- **2026-07-11** · **批次三·第一波（D-1 归因 + D-3-7 生态注册 + WO-14/12/11/10 收尾 + 文案 sweep；主模型规划 + Opus 执行）**：
  - **① D-1 开通来源归因**：新增 `ActivationEvent`（agent 解锁与 SKU 购买双写入点，SKU 异步支付经 `PaymentOrder.attrSource/attrRefId` 穿透回调落账）；admin 新增「处方漏斗」页（处方六态 × 开通来源双块对比，7/30/90 天）。
  - **② D-3-7 生态工具注册表（server）**：新增 `EcoTool`（appId/path 运营录入，种子不预置）；处方白名单扩为 enabled agents ∪ EcoTool，`Prescription.toolType` 落库归属；admin「生态工具」CRUD（启用强校验 appId）。
  - **③ WO-14 处方追踪闭环**：scheduler `prescription-followup-scan`（activated≥7 天幂等打标）+ 周复盘要效果话术 + 月战报【处方效果】块（线索占比服务端算、禁算口径）。
  - **④ WO-12 可开方工具表**：deliverable 生成路径注入工具菜单（最多开 3 条、表外不开），与落库白名单双保险；chat 路径不注入防带偏。
  - **⑤ WO-11 异议闭环收口**：`disputeNote/disputedAt` 进契约与列表回显（app 已有「有出入？」入口与标记）。
  - **⑥ WO-10 周报填报（app）**：执行页「本周经营数据」卡（行业模板动态字段、已填只读可改、周一归一）；未填报复盘旁轻提示。
  - **⑦ 文案 sweep（app）**：智库→锦囊、报告→方案（含报告库→方案库）、履历空态项目→案卷、「AI 创作发布」→军师语汇；F15 删智库假样例改真空态；ledger 命理措辞随 fortune 开关降级。
  - server 501/501（+16）；app tsc/build 绿；admin lint:ui+build 绿。**dev/prod 库需 db push 补 4 处纯加法（ActivationEvent/EcoTool/followupAt/attrSource）**。
- **2026-07-11** · **生产部署核销 `a060f7b`**：备份 `/tmp/junshi-db-backup-20260711-205252.dump`(1.3M) → deploy-prod.sh（db push 纯加法过、未用 ACCEPT_DATA_LOSS）→ `retireAgents.ts` 下架 intel/fund/model/org（enabled 余 general+4 顾问+5 创作型）→ 线上验证 health/agents 4+1/admin/deploy-version 全过。批次一（P0 五刀）+ 批次二（P1 七项 + D-8/10/11 + WO-09 端到端）自此全部上线。**weapp 端改动仍需微信 DevTools 发版方达真机**。
- **2026-07-11** · **全局复审批次二·第二波（P1-4/6 + D-8/10/11 + WO-09 前端；主模型规划 + Opus 子代理执行）**：
  - **① P1-4 时区计算集中化**：`clock.ts` 增 Asia/Shanghai 显式日历工具（Intl 固定 timeZone），全量替换 13 个服务 + 6 个路由的裸本地 getter——裸机部署时连续天数/推送时机/日限流不再随进程 TZ 漂移；例外仅 paipan.ts（lunar 库对象 API 与出生时刻构造，非「今天」派生）。
  - **② P1-6 上下文装配并发化**：`buildGenContext` 15+ 次串行 DB 改两批 `Promise.all`（并发取数、顺序拼装，注入块文本与顺序不变），新增 `$use` 查询计数防 N+1 回归测试（实测 ~38 次，上限 50）。
  - **③ D-10 复盘保底额度配置化**：`REVIEW_GRACE_PER_DAY` 2→默认 6，读 `FeatureFlag('review-grace').payload.perDay` 覆盖；admin 功能开关面支持数值配置（min/max 校验）；契约 `AdminFeatureFlag` 扩 kind/value/min/max/unit。
  - **④ D-11 复盘层级收敛日/周/月**：季/年/团队触发词在 `detectIntent` 降级 month 并注入军师引导话术，只产 month 层 ReviewLog、粘性落 `review:month`；枚举保留向后兼容。遗留：`/casefile/review` 直连 API 仍接受全层（前端无入口，暂不 clamp）。
  - **⑤ D-8 军师收编 4+1**：下架冗余顾问 intel/fund/model/org（`data/agents.ts` + 幂等 `scripts/retireAgents.ts`，prod 需 scp 后跑一次）；**创作型 agent 保留 enabled**——它们是处方 toolKey 白名单（=enabled agents）的供给方且属 D-1 保留货架 SKU，不在「顾问收编」范畴；已购用户对下架 agent 经 entitlements 天然豁免仍可对话。
  - **⑥ WO-09 前端接线（app）**：资料列表→新增详情分包页，`canAnalyze` 显示「生成经营体检」（军师过账文案）→ 跳报告详情；逐码友好错误（SKU_REQUIRED→fin-checkup PaySheet / 日限 / 非财务表 / 额度沿用全局）；补 `analyzeKnowledge` API 与确定性 mock，修 F7（knowledgeDetail mock 由 reject 改可用样例）。
  - 合并终审：服务端 485/485 全绿（+8 测试）、app tsc/build 绿、admin lint:ui+build 绿。
- **2026-07-11** · **全局复审批次二·第一波（P1-1/2/3/5/7 + WO-09 接线；主模型规划 + Opus 子代理执行）**：
  - **① P1-1 认可方案幂等化**：`recordDecisionFromAccept` 按 userId+方案指纹（title+主判断确定性拼出）去重——快路径无锁双检 + 慢路径用户级 `pg_advisory_xact_lock` 串行 check→seq→insert（顺带消灭并发不同方案撞 `(userId,seq)` 唯一键的旧竞态），重复 accept 不再重复记账污染决策准确率分母。
  - **② P1-3 structured() 计费口径**：新增 `structuredMetered()` 回传 `{data, attempts, live}`（attempts 调用前自增，超时/5xx 保守计入），`structuredBillTokens` 统一「成功定额 / 失败按 attempts 保守扣 / mock 零扣」，quickscan/brandKit/经营体检三个计费调用方接入——堵「已发生真实调用却 settle(0) 全额退款」的资损口子；原 `structured()` 变薄封装，非计费消费者零改动。
  - **③ WO-09 经营体检端到端接线（决策 A）**：`KnowledgeItem.analysisJson`（db push 纯加法）+ `POST /knowledge/:id/analyze`（canAnalyze=解析完成且财务关键词+数值≥6 启发式；fin-checkup 为解锁型 module SKU 走 `isModuleEnabled` 门禁非核销，未购 402；assertPlanActive + reserveQuota(0.3) + 日限 3 次 + 失败退款）；解析→派生指标全纯代码，LLM 仅产出行动条目（禁算口径），5 节报告数字全部来自 analysisJson、缺数写「表内未见」；归属 ops 经营参谋成版、内容哈希去重。契约 `KnowledgeDetail.canAnalyze` / `AnalyzeResult`。
  - **④ P1-7 测试库配置固化**：`server/.env.test` 入库（`node --env-file` 注入 junshi_test）+ pretest 自动 `prisma db push`，`.env` 指向 dev 库时 `npm test` 不再误碰 dev 数据；`.gitignore` 显式豁免。
  - **⑤ P1-2 战略账本入口解耦（app）**：profile 菜单加常驻「战略账本」行，与段位卡 `streak≥3‖usageDays≥14` 展示门控解耦（原 rank-card 入口保留），中期用户可稳定进入账本。
  - **⑥ P1-5 下一步卡数据源统一（app）**：战局页删本地手搓 nextStep 派生，改挂共享 `NextStepCard`（统一读 `/journey`），消除三 tab 指引互相矛盾；quickscan 空态导流保留。
  - 服务端 477/477 全绿（+11 测试）；app tsc/build 绿。**注意：本地 dev 库需跑一次 `npm run db:push` 补 `analysisJson` 列（纯加法）。**
- **2026-07-11** · **全局复审批次一（P0 五刀之四，见 `docs/[FABLE5]REVIEW_2026-07-11.md`；主模型规划 + Opus 子代理执行）**：
  - **① P0-3 三势研判拒绝捏造（前后端）**：前端删除战局页写死的默认三势卡（「行业上行/对手抢位/团队待整」75/45/35），`battleForces` 为空走 `force-empty` 空态卡引导对话（`app/src/pages/home/index.tsx`、mock 同步两态可走查）；服务端 `generateForces` 零档案不调 LLM/不落库返回 null，生产 LLM 失败不再把 `DEFAULT_FORCES` 写进 `forcesJson`（仅 `isAiTestMode` 保留确定性兜底），缺势用「待研判/先补档案」诚实占位（`server/src/services/forces.ts`、`routes/battle.ts` 空结果不烧每日刷新名额；battle 测试 +2）。
  - **② P0-5 报告卡「产出中」卡死残留**：`generateStream` H5/weapp 两条收尾路径在流正常结束但未收到 done/error 事件时补发一次 `onDone`（`finished` 标记防双发）；chat 页报告流加 `try/finally` 兜底强制解除 streaming（`app/src/services/streaming.ts`、`pages/chat/index.tsx`）。
  - **③ P0-1 品牌资产包生成补计费与门禁（资损）**：`POST /brand-kit/generate` 加 `assertPlanActive`（过期 403）+ `reserveQuota(0.3)` 预留→按 billable 结算/异常退款 + 每日 3 次限流（与 quickscan 同实现；多实例限流落 DB 为 P2-13 另一工单）（`server/src/routes/brandKit.ts`、`services/brandKit.ts` 回传 billable；brandKit 测试 +3：过期 403 / 额度空 402 / 失败全额退回）。
  - **④ P0-4 处方状态机单调化**：`advancePrescription` 按等级序 `proposed<seen<clicked<activated<used<verified` 用 `updateMany + status in 前置集合` 单语句条件推进（防读改竞态），重复/乱序埋点不再把高状态打回；新增 `dismissed` 独立终态（仅 proposed/seen 可作废）；`recordOutcome` 追加 outcome 但 status 不回退（prescription 测试 +2）。
  - **⑤ P0-2 命理开关三层补全（合规）**：命理端点（送你一卦 fate/preview、排盘 profile/bazi、命盘 profile/chart、天时日历/天命速写卡）在 fortune 关时统一 403 `FEATURE_DISABLED`（daily 战报不受约束）；`/me` 下发 `features.fortune`（契约 `Me.features` 必填）；前端隐藏全部命理入口（Picker 八字步骤/送你一卦/天时日历）且深链 403 友好降级；admin 新增「功能开关」面（`GET/PATCH /admin/flags`，关合规开关二次确认）。合规类开关直读 DB（TTL=0），消除多实例 60s 缓存窗口。服务端 466/466、三端 tsc、admin lint:ui 全绿（fortuneFlag 测试 +4）。
  - **⑥ P1-8 结论：无陈旧断言**——此前报告的 5 例失败测试系环境产物（dev 库 `junshi` schema 落后导致 `seedBaseline` 崩溃），对已迁移的 `junshi_test` 库全绿（462/462）。测试库纪律缺口记入 AGENTS §13。
- **2026-07-09** · **例行 QA：深度整理一次性凭据从不核销（资损）+ 上传体积前置校验与服务端限额不符**（`qa/routine/2026-07-09-deep-organize-consume-and-upload-limit` 分支）：
  - **① 深度整理（sku:deep-organize）付费凭据从未核销**：`deepOrganize()` 此前只判断 `UserModule` 存在，从不写回，导致同一笔 ¥39 购买可无限次调用 `POST /knowledge/deep-organize`（与 `applySkuGrant` 注释「记一次性服务凭据…后续核销」及 V7 计划文档「执行 → 核销一次性凭据」的设计矛盾）。改为**原子核销**：`updateMany({ enabled: true } → { enabled: false })` 返回 0 行即 402 `SKU_REQUIRED`，成功核销后才执行；若执行过程抛错（如批次不存在），best-effort 把凭据改回 `enabled: true` 允许用户重试，不白白吃掉已付费凭据。
  - **② 上传前置校验体积上限与服务端不符**：`app/src/services/uploadGuard.ts` 的 `MAX_UPLOAD_BYTES` 写死 30MB，而 `server/src/app.ts` 的 `@fastify/multipart` 硬限额一直是 20MB——22~29MB 的文件会被客户端放行、上传后却被服务端 413 拒绝，用户只看到一个通用错误提示、体验割裂。改为 20MB 与服务端保持一致。
  - **验证**：`knowledgePipeline.test.ts` 新增 2 例（同一凭据用过一次后第二批次 402、执行失败不核销允许重试）+ 原有 6 例，8/8 通过；全量 server 测试 455/455 通过、0 回归；`server tsc --noEmit` 0 错。影响面：server（`services/knowledgePipeline.ts`、`test/knowledgePipeline.test.ts`）+ app（`services/uploadGuard.ts`）。


- **2026-07-09** · **对话页新增「回到最新」浮层按钮**：`pages/chat` 监听聊天 ScrollView 距离底部的距离，用户上滑查看较早历史且离底部较远时显示右下浮层，点击复用回底逻辑快速回到最新消息；按钮避让输入区、引用行与键盘。影响面：app（`pages/chat`）+ AGENTS。

- **2026-07-09** · **修复对话 Markdown 松散有序列表编号全部显示为 1**：`MarkdownText` 解析层支持条目间空行且 marker 均为 `1.` 的模型常见写法，连续归组渲染为 1/2/3…；同时放宽编号列宽，避免两位数挤压正文。影响面：app（`components/MarkdownText`）+ AGENTS。

- **2026-07-09** · **V7 新版效果图对齐·实现（V7-03~V7-15，跳过 V7-01/02；tab 样式与菜单名 by-design 保持不动）**（`claude/ai-pilot-miniapp-tech-plan-5jzsfa` 分支）：按 `docs/[FABLE5]V7_EFFECT_ALIGN_PLAN.md` 落地。**后端全绿（449 例，0 回归，server+app tsc 0 错）**。
  - **schema 加法**：`Casefile.goalsJson`、`CasefileOrder +ownerName/dueAt(标签串)/etaMinutes/sourceQuote/stepsJson/metricsJson/actionType`、`KnowledgeItem +stage/bizCategory/batchId/dupOfId`、`User.inviteCode @unique`、`PaymentOrder.skuKey`，新表 `Sku/UserDataSource/UserModule/ServiceAssignment`（`prisma db push`）。
  - **V7-04** 三势结构化（`services/forces.ts`：structured() 产 level/结论/打法，strength 代码按 level 映射禁 AI 自算；落 `StrategicProfile.forcesJson.battle`；注入【战略档案】）+ `POST /forces/refresh`（限频 3/日）+ `POST /battle/commit`（认可判断一键：buildGenContext→generateDeliverable→acceptDeliverable→saveReportVersion，5 分钟幂等）。**V7-05** `acceptDeliverable` 升级 structured() 拆军令 + 启发式确定性兜底（owner=称呼、actionType 关键词映射）+ 军令详情页。**V7-10** `PUT /casefile/goals` + accept 抽取（抽不出留空不编造）+ 注入。**V7-06** 智库三段管道（staging→optimized→confirmed；staged 上传不切片嵌入、对检索不可见，confirm 才 embed；`data/bizCategories.ts` 8 类 + organize 去重/分类 + 免费额度 30 份/200MB + deep-organize 402 占位）。**V7-07** `UserDataSource` 状态机 + 上传替代/预约授权（广告/CRM 不做假授权）。**V7-08** `data/modules.ts` 10 能力目录下沉 + `UserModule` + tier 分流启用（free/credits/sku/member）。**V7-11** scheduler 09:00 军令 + 周五周复盘 job + `GET /reminders`。**V7-12** `Sku` 单次付费（复用 `markPaidAndApply` 幂等，按 skuKey 分流发放 module/service/storage 权益）+ 对外「算力」文案统一（💎 图标保留）。**V7-13** 邀请码惰性生成 + `ServiceAssignment` + 档案工作台（bizCategory 真实计数）。**V7-14** `GET /search` 四域聚合（知识仅 confirmed，staging 隔离）。**V7-15** `GET /sessions` unreadCount + `role='system'` sys-card。
  - **前端**：全局弹层三件套（PaySheet 台账式/ExceptionSheet 四格/OnboardSheet 4 步 + uploadGuard）、战局三势真渲染 + 认可 CTA 三态、执行军令 meta chips + 军令详情页 + 目标阶梯编辑、我的账户卡 + 档案工作台 + 提醒页、对话跨域搜索 + 未读数、智库四面板重做（管道/数据源/能力/报告）。api/mock 严格 lockstep，SSOT 契约先行。
  - 影响面：server（schema +9 列 +4 表、多路由、forces/casefile/knowledgePipeline/modules/dataSources/reminders/community/sku/collab 服务、context+schema 注入）+ shared/contracts + app（services/api·mock·dossier、5 tab + 3 全局组件 + command/reminders 分包页）。**未含**：真机回归走查、admin 端 SKU/服务分配可视化、真实 OAuth 数据源、第 7 位军师·明止 agent（按 D-9 不落地）。

- **2026-07-09** · **V7 新版效果图对齐技术迭代方案·设计文档（设计先行，不动代码）**（`claude/ai-pilot-miniapp-tech-plan-5jzsfa` 分支）：新增 `docs/[FABLE5]V7_EFFECT_ALIGN_PLAN.md`——对照业务方新版原型 `ai-pilot-temp/design/junshi-miniapp-effect.html`（深绿+宋体重构版）与现有前后端全量盘点后的 gap 分析与执行规格。第一部分（给人看）：一句话结论「换壳+补三块地基」、差距地图（A 视觉/B 前端/C 后端建模/D 拍板 四级）、4 批次 15 工单策略、9 个产品拍板点（tab 命名/积分去留/算力名词统一/数据源 OAuth 范围等，均带建议默认值）；第二部分（给 coding agent）：V7-01~V7-15 工单（契约/schema/端点/前端改动点/验收标准/依赖图），核心新增建模=智库三段整理管道（KnowledgeItem.stage 生命周期）、三势结构化（ForceView + POST /battle/commit）、军令字段扩展、UserDataSource/UserModule/Sku/ServiceAssignment 四张新表、跨域搜索。影响面：docs only。

- **2026-07-08** · **上线后 QA 三修：初诊后首页刷新 + 初诊复用档案不重复问 + 对话未读信号**（`refactor/structured-output` 分支）：
  - **① 首页初诊卡重复**：home「下一步」卡接服务端 `/journey`（`useDidShow` 刷新）——初诊后 journey new→scanned，卡片变「进参谋室继续诊断」，不再重复「开始初诊」。
  - **② 初诊与注册引导重复问行业/阶段**：注册入场 Picker 已收 `Profile.industry/stage`；速诊页进来 `api.getProfile()` 预填并折叠行业/阶段（「来自你的档案·重新选」），用户只补「最痛的一件事」。纯前端。
  - **③ 对话返回即终止 → 后台异步 + 未读**：核实服务端**本就不因客户端断开中止生成、AI 回复完整落库**（缺的只是未读信号）。`Session +lastReadAt`（加法列）；`GET /sessions` 算 `hasUnread`（最后一条是 AI 回复且晚于 lastReadAt）；`GET /sessions/:id` 打开即置已读；`send()` 加 socket 已关守卫（防 write-after-end 中断落库）；契约 `SessionItem.hasUnread`；列表页军师行/总军师行加未读红点。
  **验证**：`unread.test.ts`（回复后未读 → 打开清除）全绿；全量 376 例 0 回归；`app tsc` 零错 + `npm run build:weapp` 编译成功。影响面：server(schema +lastReadAt、sessions 路由) + shared/contracts + app(home/quickscan/sessions)。**未含**：回复在当前会话页 live 收到后离开会短暂显未读（重进即清，MVP 可接受）；历史会话行红点。

- **2026-07-08** · **WO-15 生态统一账户与跨产品结算·设计文档（设计先行）**（`refactor/structured-output` 分支）：新增 `docs/ECOSYSTEM_ACCOUNT_DESIGN.md`——生态第二产品立项蓝图，回答身份（手机号+unionid 单库多产品共用 `User`）/钱包（`CreditLedger` 加 `product` 字段、单库事务跨产品扣费）/权益互通（套餐附赠、处方 activate 跨产品支付回调复用 `PaymentOrder` 幂等）/数据授权（service token + `user_grant` 表 + BrandKit export 签名 TTL 1h）/风险（单库 schema 耦合边界、unionid 同主体依赖、拆分触发线）+ 落地顺序。影响面：docs only。**至此 FABLE5 加法路线图 WO-01~15 全部工单落核心**（多个 admin/前端/注入子项按各条 CHANGELOG「未含」列为后续）。

- **2026-07-08** · **WO-09 经营体检·财务解析引擎（`structured()` 消费者 + 纯派生）**（`refactor/structured-output` 分支，未部署）：知识库分析产品化的分析核。`services/finParse`：`FinancialsSchema`（Zod：periods/revenue/cogs/expenses/cash，缺失容错空数组）+ `parseFinancials`（走统一 `structured()` 从财务表文本抽取，无 provider → null）+ `deriveMetrics`（**纯代码算** 毛利率/费用率/现金净流，不交给 LLM）+ `finReportSections`（经营体检 5 段：收入结构｜成本与毛利｜费用异动｜现金流信号｜三个最该动手的地方，数字全部来自结构化数据、禁推算）。**验证**：`finParse.test.ts` 3 例（派生指标算对、5 段骨架 + 现金为负告警、schema 缺字段容错）全绿；`tsc` 0 错；全量 375 例、0 回归。影响面：server（services/finParse 新增，standalone 零改存量）。**未含**（wiring 后续）：`KnowledgeItem.analysisJson` 落库、`POST /knowledge/:id/analyze` 端点 + saveReport 成版、资料卡「生成经营体检」按钮、战局页体检引用。

- **2026-07-08** · **WO-04 复盘周/月账本聚合（修 A-4「月复盘 LLM 现编」）**（`refactor/structured-output` 分支，未部署）：`recordReview` 从「仅 day 层快照」升为**期聚合**——week=本周一 → 今天、month=当月 1 号 → 今天，覆盖区间内 CasefileOrder(完成/对齐) + CasefileMetric(线索/咨询/成交)求和，落 `ReviewLog.metricsJson`（加法列）+ date=期起始（周一/月一号）。`reviewBriefing` 追加「最近月报（线索/咨询/成交/军令）」——月复盘对账素材由系统求和、非 LLM 现编。**day 层行为不变**。**验证**：`reviewPeriod.test.ts`（月复盘聚合当月三数 → month 行 metricsJson + 注入月报块）全绿；`tsc` 0 错；全量 372 例、0 回归（day 层既有复盘测试未破坏）。影响面：server（schema ReviewLog +metricsJson、reviewLog.recordReview 期聚合 + reviewBriefing）。**未含**：季/年/团队降级到月度线、执行页月战报按钮、军师收编 4 科室。

- **2026-07-08** · **WO-10 结构化经营周报数（报什么就能对比什么）**（`refactor/structured-output` 分支，未部署）：手工报数升级为行业模板化周报，形成连续序列供军师对比。新增 `BizMetricWeekly` 模型（weekStart + metricsJson，`@@unique([userId,weekStart])`）。`services/bizMetric`：`metricTemplate`（按行业返回可报 metricKey，与基准库对齐）+ `upsertWeek` + `series` + `bizMetricBlock`（本周实报 + **与行业中位 p50 的差由服务端算**，如「复购率 31%，低于行业中位 14%」）。`routes/bizMetrics`：`GET /biz-metrics/template`、`PUT /biz-metrics/:weekStart`、`GET /biz-metrics`。注入【经营序列】块（context + schema，benchmarkLine 同款）。**验证**：`bizMetric.test.ts` 2 例（模板/填报/序列/注入含差、非法 weekStart 400）全绿；`tsc` 0 错；全量 371 例、0 回归。影响面：server（schema +BizMetricWeekly、services/bizMetric + routes/bizMetrics 新增 + app 注册、context + llm/schema 注入）。**未含**：前端周复盘填报表单（动态渲染 template）+ 契约、多周趋势/连续下行提示、周五要数 modeLine。

- **2026-07-08** · **WO-08 行业基准库·注入层（「咨询与聊天的分界线」）**（`refactor/structured-output` 分支，未部署）：审计称基准数据是咨询与聊天的分界线。新增 `IndustryBenchmark` 模型（industry/revenueBand/metricKey + p25/p50/p75 + note/source/enabled，`@@unique([industry,revenueBand,metricKey])`）。`services/benchmark.benchmarkBlock`：取用户行业下 enabled 且 **p50 非空** 的指标 → 「复购率：行业中位 45%（P25 30% / P75 60%）」，**宁缺勿假**（p50 空不注入）；数字铁律「本块没有的指标不得引用行业数据、不得自行推算」。`context.ts` 装配 `benchmarkLine` → `schema.ts` 注入块（decisionLine 同款位置）。顺带修 `test/helpers.cleanBusiness` 重置本轮新增表（user_journey/prescription/brand_kit/feature_flag/industry_benchmark）。**验证**：`benchmark.test.ts` 2 例（有 p50 注入含分位、p50 空 / 无行业不注入）全绿；`tsc` 0 错；全量 369 例、0 回归。影响面：server（schema +IndustryBenchmark、services/benchmark 新增、context.ts + llm/schema 注入、test/helpers）。**未含**：admin 基准 CRUD + CSV 导入、运营种子（p50 待运营核实）、废弃 industryPacks 静态基准。

- **2026-07-08** · **WO-05 命理功能开关·注入层（合规前置，一键降级）**（`refactor/structured-output` 分支，未部署）：合规 P0——命理可一键降级为经营节奏话术。新增 `FeatureFlag` 模型（id=flag key，如 'fortune'）；`services/featureFlag.ts`：`isFeatureEnabled`（60s 内存缓存）+ `setFeatureFlag`（清缓存）。`context.ts`：fortune 关闭 → 天势降级为禁令（不注入命盘、禁八字/命格/流月术语），复用既有「不信命理」opt-out 口径。**验证**：`featureFlag.test.ts`（默认开 → 关闭后 isEnabled=false 且 `buildGenContext` 的 tianshiLine 变禁令而非命盘）全绿；`tsc` 0 错；**全量 367 例、0 回归（context.ts 热路径未破坏）**。影响面：server（schema +FeatureFlag、services/featureFlag 新增、context.ts 天势门槛）。**未含**（三层开关另两层）：路由层（fate/calendar 端点 403）、前端层（/me `features.fortune` + 命理 UI 条件渲染）、admin 开关页。

- **2026-07-08** · **WO-11 账本异议流（决策/天机「有出入」→ 复盘带出确认）**（`refactor/structured-output` 分支，未部署）：账本页（批次C 已做）之上补异议闭环。`DecisionLog`/`ProphecyLog` 各加 `disputeNote/disputedAt`（加法列）；`disputeDecision/disputeProphecy` 服务 + `PATCH /decisions/:id`、`PATCH /prophecies/:id`（body `{dispute}`，**不改状态**——异议不直接改判，复盘时军师带出确认后再走既有验证更新）；decision/prophecy briefing 注入块追加「用户有异议（复盘时先确认）」标注（数字铁律口径不变）。**验证**：`dispute.test.ts` 2 例（决策/预言异议 → 账本块含异议 + 空 400 + 不存在 404）全绿；`tsc` 0 错；全量 366 例、0 回归。影响面：server（schema 2 加法列、decisionLog/prophecyLog service + briefing、decisions/prophecies routes）。**未含**：前端账本页「有出入？」入口（drop-in PATCH 调用）。

- **2026-07-08** · **WO-12 处方生成端（军师出方案时经 emit_deliverable 携带处方，闭合「生成 → 落库」）**（`refactor/structured-output` 分支，未部署）：处方引擎最后一块——让 AI 真正开方。`DELIVERABLE_TOOL`(emit_deliverable) schema 加可选 `prescriptions` 数组（问题/打法/toolKey，最多 3 条，指引「从【可开方工具表】选，表外不写、不需要不填」）；`schema.normalizePrescriptions` 归一化；claude/openai **全部 5 处报告构造点**（Deliverable / DeliverableWithTools / Adaptive）透传 prescriptions；provider mock 报告携带一条白名单内样例（toolKey=growth），mock/H5 全链路可走通。**安全**：toolKey 白名单过滤在落库（`persistPrescriptions`）做——生成端即使模型乱写也被服务端拦，故无需先注入白名单即安全（注入块提准确率，留作后续）。**验证**：`prescription.test.ts` 新增生成端例（出方案 → `deliverable.prescriptions` 含 growth）全绿；`tsc` 0 错；**全量 `npm test` 364 例、0 回归（生成核心未破坏，stash 对照 clean tree 同 5 例 pre-existing）**。影响面：server（`llm/schema` DELIVERABLE_TOOL + helper、`providers/claude`+`openai` 各报告构造点、`providers/mock`）。**未含**：上下文注入【可开方工具表】（提准确率）、漏斗报表 E-5。

- **2026-07-08** · **WO-12 处方落地页（军令处方条 → market 展示开方上下文 + 开通埋点，收口转化动线）**（`refactor/structured-output` 分支，未部署）：market 页读 `from=prescription&pid`：展示「军师为『{问题}』开出 + 打法」上下文条 + 曝光(seen)埋点；「开通完成·回执行」→ activated 埋点 + 返回。至此处方转化动线前端闭环：军令条(clicked) → 落地页(seen) → 开通(activated)。**验证**：`app tsc` 零错、`npm run build:weapp` 编译成功。影响面：app（market/index +pid 处理，内联样式单文件改）。**未含**：LLM 生成处方（deliverable 生成经 `structured()` 从白名单产出）、漏斗报表 E-5、真实购买流对接 activate。

- **2026-07-08** · **WO-13 品牌资产包·前端（三段卡片页 + 主公菜单入口，收口 WO-13 端到端）**（`refactor/structured-output` 分支，未部署）：新增 `packages/work/brandkit` 分包页——IP 人设 / 话术库 / 视觉调性三段卡片 + 生成/重生成 + 确认无误；`api.ts` 加 `brandKit()/generateBrandKit()/approveBrandKit()` + `mock.ts` 确定性样例；`app.config` 注册分包；主公(profile)菜单加「我的品牌资产」入口。**验证**：`app tsc` 我方零错、`npm run build:weapp` 编译成功。影响面：app（packages/work/brandkit 新增 + api/mock/app.config/profile）。

- **2026-07-08** · **WO-14 成果回流·服务端（处方效果回填 → used/verified 闭环）**（`refactor/structured-output` 分支，未部署）：生态引流下半场——处方开通后回填效果，让「处方有效」可验证。`services/prescription.recordOutcome` + `POST /prescriptions/:id/outcome`（body `{period, metrics:{posts,leads,gmv}, note}`）：追加到 `Prescription.outcomeJson`、首期 → used、连续 ≥2 期有正指标 → verified、落 firstUsedAt；静态段 `outcome` 路由优先于 `:action`。复用现有 `outcomeJson` 字段，无 schema 变更。**验证**：`prescription.test.ts` 新增 WO-14 例（首期 used → 二期 verified → 不存在 404）全绿；全量 363 例、0 回归。影响面：server（prescription service + route）。**未含**：月战报注入【处方效果】块 + 周复盘要数 `modeLine`（属复盘注入）、activated 7 天 scheduler 追踪。

- **2026-07-08** · **WO-13 品牌资产包·服务端（档案 → 数字人/短剧的预填输入）**（`refactor/structured-output` 分支，未部署）：审计点名「生态产品碾压外部竞品的唯一结构性优势」。新增 `BrandKit` 模型（personaJson/voiceJson/themeJson + version + approvedAt）。`services/brandKit.ts`：从战略档案 + 企业档案组装输入，走统一 `structured()`（Zod 三段：人设/话术/调性）生成，无 provider → 确定性模板；**生成门槛 journey ∈ {executing, reviewing}**（没方案就没定位 → 403 `BRANDKIT_LOCKED`）；重生成 version+1 且清 approved。`routes/brandKit.ts`：`POST /brand-kit/generate`、`GET /brand-kit`、`POST /brand-kit/approve`（生态产品只读 approved 的包）。契约 `BrandKitView/Persona/Voice/Theme` 进 shared。复用 `structured()`(重构①) + journey stage(WO-07) 双地基。**验证**：`test/brandKit.test.ts`（未到执行 403 → 认可进 executing → 三段齐全 → 确认 approved → 重生成 v2 清确认）全绿；`tsc` 0 错；全量 362 例、0 回归。影响面：server（schema +BrandKit、services/routes brandKit 新增 + app 注册）+ shared/contracts。**未含**：前端三段卡展示页；`GET /brand-kit/export?token=`（签名 TTL 1h 跨产品预填，属 WO-15 生态账户）。

- **2026-07-08** · **WO-12 处方引擎·前端处方条（军令页可见）**（`refactor/structured-output` 分支，未部署）：`components/PrescriptionStrip` 自取 `api.prescriptions()`，在军令(执行)页渲染「⚡ 军师为『{问题}』配了工具」，点击 = clicked 埋点 + 跳 market 落地页（`from=prescription&pid`）；已开通/dismissed 不显示，无处方不渲染。`api.ts` 加 `prescriptions()/prescriptionAction()` + `mock.ts` 样例；契约 re-export。**验证**：`app tsc` 我方零错、`npm run build:weapp` 编译成功。影响面：app（components/PrescriptionStrip 新增 + api/mock/studio）。**未含**：market 落地页读 pid 展示处方上下文 + activate 回调、方案详情处方汇总、漏斗报表（后续）。

- **2026-07-08** · **WO-12 处方引擎·服务端首刀（诊断结论 → 生态工具的结构化桥）**（`refactor/structured-output` 分支，未部署）：生态引流从「货架」转「处方」的地基。新增 `Prescription` 模型（问题/打法/toolKey + 状态机 proposed→seen→clicked→activated→used→verified|dismissed + 各阶段时间戳）。`services/prescription.ts`：`toolWhitelist`（启用 `Agent.key` 白名单——LLM 只能点菜，表外 toolKey 丢弃 + 审计）+ `persistPrescriptions`（认可方案时从 `deliverable.prescriptions` 落库：白名单过滤 + 同案卷同工具去重 + 挂案卷，最多 3 条）+ `advancePrescription`（seen/clicked/activated 埋点）+ `listPrescriptions`。`routes/prescriptions.ts`：`GET /prescriptions`、`POST /prescriptions/:id/:action`。认可方案（casefiles accept）新增 fire-safe 落处方。契约 `DeliverablePrescription`（+ `Deliverable.prescriptions?`）/`PrescriptionView` 进 shared。复用 WO-07：处方挂在「认可=executing」的信任峰值上。**验证**：`test/prescription.test.ts` 2 例（白名单内落库+表外丢弃+点击埋点；空处方不落+动作 400+404）全绿；`tsc` 0 错；全量 `npm test` 361 例、0 回归（同 5 例 pre-existing）。影响面：server（schema +Prescription、services/routes prescription 新增 + app 注册、casefiles accept +1）+ shared/contracts。**未含**（下一步）：LLM 生成处方（deliverable 生成经 `structured()` 从【可开方工具表】产出 prescriptions[]）、军令卡挂载/market 落地页/漏斗报表（E-5）、外部产品 toolType=external。

- **2026-07-08** · **WO-07 journey·前端 NextStepCard（接 `/journey`，收口 WO-07）**（`refactor/structured-output` 分支，未部署）：`components/NextStepCard` 自取 `api.journey()`、只渲染服务端派生的 `nextStep`（route `chat`/`studio`/分包路径 → 对应 navigateTo/switchTab），无 nextStep 不渲染；挂执行页（studio）头部与卡组之间。`api.ts` 加 `journey()` + `mock.ts` 确定性样例（按档案给 new/diagnosing）；契约 re-export。**验证**：`app tsc` 我方文件零错、`npm run build:weapp` 编译成功。影响面：app（components/NextStepCard 新增 + api/mock/studio）。**未含**：home（现有本地 nextStep 占位）/ sessions 顶部挂同组件（drop-in `<NextStepCard/>`，后续）。

- **2026-07-08** · **WO-07 用户 journey 状态机·服务端（重构③，借鉴 LangGraph StateGraph 思想）**（`refactor/structured-output` 分支，未部署）：全 tab「下一步」主线的服务端地基。新增 `UserJourney` 模型（stage `new→scanned→diagnosing→plan_ready→executing→reviewing` + quickScanAt/planAcceptedAt/firstReviewAt；diagRound 仍以 StrategicProfile 为真源）；`services/journey.ts` 约百行领域状态机——**声明式 TRANSITIONS 表**（事件 × 允许起始态 → 目标态 + 落时间戳，无效态触发即忽略）+ `applyJourneyEvent`（内部吞错，fire 安全）+ **纯函数 `deriveNextStep`**（stage + 当日信号 → 下一步卡）+ `getJourneyView`。`GET /journey` 返回 `{stage, diagRound, nextStep}`。事件在 4 处以 `await import()` 反向 fire（防环 + 保序 + 吞错不阻断宿主）：速诊完成→scanned、诊断推进(`bumpDiagRound`)→diagnosing、认可方案→executing、首次日复盘→reviewing。契约 `JourneyView/JourneyStage/JourneyNextStep` 进 shared。**验证**：`test/journey.test.ts` 9 例（`deriveNextStep` 8 纯分支 + 注册→速诊→scanned 端到端）全绿；`tsc` 0 错；全量 `npm test` 359 例、我方 0 回归（同 5 例 pre-existing 无关失败）。影响面：server（schema +UserJourney、services/journey + routes/journey 新增 + app 注册、casefiles/reviewLog/strategicProfile 各加一行 fire）+ shared/contracts。**未含**（下一步）：前端 NextStepCard 接 `/journey`（home 现有本地 nextStep 占位可平滑替换）+ 挂 3 tab 顶部。

- **2026-07-08** · **WO-06 速诊·前端分包页（PR-B2，收口 WO-06）**（`refactor/structured-output` 分支，未部署）：新增 `packages/work/quickscan` 分包页——3 问表单（行业 / 阶段·营收段复用 `/survey` 选项 + 最痛的事自由文本）→ `api.quickScan` → 初诊卡（主要矛盾 / 军师判断 / 今天做的一件事），`useShareAppMessage` 原生分享 +「进参谋室聊 6 轮」CTA。`api.ts` 加 `quickScan` + `mock.ts` 确定性样例（含建档回填同口径）；`app.config.ts` 注册分包；契约 `QuickScanRequest/Result` re-export。WO-03 冷启动空态 CTA（home `goQuickScan`）由「跳对话预填开场语」翻为跳速诊页（emptyStates 早留的接口）。**验证**：`app tsc` 我方文件零错；`npm run build:weapp` 编译成功。影响面：app（packages/work/quickscan 新增 + api/mock/app.config/home）。**未含**（后续）：HTML 分享卡 `cardHtml` quickscan + `/cards/quickscan`（weapp 原生分享已覆盖主链路，cardUrl 暂 null）；对话 tab 顶部常驻入口。

- **2026-07-08** · **WO-06 速诊·服务端引擎（PR-B，`structured()` 首个计费路径消费者）**（`refactor/structured-output` 分支，未部署；前端页/分享卡待 PR-B2）：3 问速诊（行业 + 年营收段 + 最痛的一件事）→ 初诊卡（主要矛盾 / 军师判断 / 今天能做的一件事），替代「送你一卦」承担获客。新增 `POST /api/quickscan`（`routes/quickscan.ts` + `services/quickscan.ts`）：① LLM 走统一 `structured()`（Zod 三字段强约束），无 provider → 确定性模板兜底；② 每用户每日 3 次限流（`cache.ts`）；③ token 轴 metered ratio=0.3 + **grace:'quickscan' 每日 1 次保底**（额度耗尽仍放行首次，获客不拦）；④ 速诊即建档——`Profile.industry/stage/pain`「空则回填、不覆盖」（revenueBand→stage）。`tokenQuota.reserveQuota` 的 grace 从单一 `'review'`（每日 2）扩为**按类别独立配额**（`GraceKind='review'|'quickscan'`，`payloadJson.kind` 过滤计数，review 行为不变）。契约 `QuickScanRequest/Result` 进 shared（cardUrl 暂 null）。**验证**：新增 `test/quickscan.test.ts` 4 例（出卡+回填 / 不覆盖 / 限流 429 / 零额度 grace 1 次后 402）全绿；grace 改动跑 `quotaGrace.test.ts` 回归全绿；**全量 `npm test` 350 例、我方 0 回归**（5 例 pre-existing 失败——#89 断言 general 载 V6.0 全文=批次A 已改名 V1.0、#35/#124=批次C 已改 n≥5 口径、#14 送你一卦、#84 注入 e2e——stash 对照 clean tree 同样失败，与本次无关）。影响面：server（routes/services/quickscan 新增 + app.ts 注册 + tokenQuota grace 扩类别）+ shared/contracts。**未含**（PR-B2/后续）：前端分包页 + api.ts/mock.ts、分享卡 cardHtml+publishCard、`UserJourney.quickScanAt` 打点（WO-07）。

- **2026-07-08** · **重构①·结构化输出统一原语 `structured()`（借鉴 Vercel AI SDK generateObject / Spring AI StructuredOutputConverter）**（`refactor/structured-output` 分支，未部署）：针对「LLM 调用层手写脆弱、辅助抽取六份雷同正则副本」的架构债起步。`llm/gateway.ts` 新增 `structured(zodSchema, {system,user})` 统一原语——Zod schema 同时充当 **运行时校验 + TS 返回类型 + 归一化(transform)** 的单一真源；抠 JSON/校验失败自动把错误回喂、只修复一轮；无真实 provider（测试/mock）或异常一律返回 null（绝不伪造，沿用 `extractInsights`/`completeJson` 口径）。纯逻辑（抠 JSON + 校验）拆到导出的 `coerceJson`，可零 I/O 单测。首刀移植 `extractProphecies`：原「`rawJson` 正则 + 手写 filter/map/slice + dueDate 校验」约 30 行 → `ProphecyResult` schema + 一行调用，**行为等价**（逐条容错、空 prophecy 丢弃、dueDate 归一为 null、最多 2 条、mock 返空）。顺带把 `rawJson` 抽出 `rawText`（DRY，供 structured 复用；rawJson 行为不变）。这是「LLM 编排层借鉴开源框架思想」重构线第 1 步，也为 FABLE5 加法批次的结构化抽取（WO-06 速诊 / WO-09 finParse / WO-12 处方）铺底座。**验证**：新增 `server/test/structured.test.ts` 9 例全绿（8 纯逻辑 + 1「mock 不伪造」安全性质）；既有 DB-free llm 层测试 28 例全绿（`rawJson→rawText` 回归）；`tsc` 我方文件零错（仅遗留 `paipan` 缺包的 env 噪声）。影响面：server（`llm/gateway.ts` 纯新增 + `extractProphecies` 内部重构，对外签名/行为不变）+ test；无 schema / 无契约 / 无前端改动。

- **2026-07-07** · **批次C 账本闭环 + 完整履历自动生成 + 放宽长度上限**：
  - **批次C 账本闭环（F-8/P-2）**（server 待部署无 schema / 账本页待发版）：服务端账本(决策/天机/段位)全建好但 App 够不到→条目永 pending→比率 null→段位不可达。新增 `packages/work/ledger` 页(决策账本/天机账本 双 tab + 待验证条目点验证，调既有 verify 路由)；`decisionStats/prophecyStats` 加 **n≥5 才出比率**(原 >0 即出，1 条 100% 直接喂晋升)+ briefing「先攒够 5 条」口径；Decision/Prophecy View/Stats/Ledger 进 contracts；api+mock 同口径；profile 段位卡可点进账本。H5 实测：4 条验证显「先打满5条」、第5条切「准确率80%」。
  - **完整履历自动生成**（`f8ee2cc`，前端待发版）：进详情无缓存+资料够(maturity≠empty)→自动立档，免手动点。
  - **放宽长度上限**（`816cda1`，✅ 已部署 prod）：对话回复 800→4000、报告 2600→8000、输入框 500→2000；对话不再半句截断（回复上限服务端已生效，输入框待发版）。

- **2026-07-07** · **L-6 三势真数据化 + tab 页顶部上移**（三势后端 ✅ 已部署 prod `deploy-prod.sh` SHA 2114b00：migrate diff 预检确认仅 `strategic_profile ADD COLUMN forcesJson`、零 DROP，db push + 构建 + 重启健康、forcesJson 列已验在；UI 纯前端 + 前端展示待 weapp 发版）：
  - **三势真数据化**：军情页 市势/人势 原静态「发起判断」→ 结构化研判结论。`StrategicProfile.forcesJson`（加法列，{shishi/renshi:{verdict:攻/守/等/撤,note}}）；`strategicProfile.extractForceVerdict`（认可「市势/人势研判」时 LLM 提炼 verdict+note、关键词兜底、只用报告真实判断）+ `upsertForce`/`loadForces`；`/casefile/accept` 收 `force` 参数；`understanding.forces` 带出 /me；home 卡回显「守 · 一句话」+ 攻/守/等/撤 配色徽。天势继续走命盘 monthlyOutlook。契约 + mock 同口径。
  - **UI 顶部上移**：tab 页头部从「顶到胶囊底 + 64px 标题行」改为进胶囊带（nav-inset 到胶囊 top，下发 `--cap-right` 让右侧操作按钮避让胶囊，tab-page-head 64→52），回收顶部约 50px，每屏更饱满。5 个 tab 页统一。
  - 影响面：server(schema/strategicProfile/casefiles/understanding) + shared/contracts + app(dossier/chat/home/mock + Screen/5 tab 页 scss) + docs。

- **2026-07-07** · **修复：登录态失效时不再静默滞留（全局 401 打断）+ 记忆入口前置**：用户真机实测「军师记忆」空白——排查确认后端已产出真实分类记忆、weapp 也在调 `/me/memory-library`，但**登录 token 失效**导致该接口 401，而页面 `.catch(()=>{})` 吞掉了 401，用户滞留在旧缓存界面、新功能空白却不自知。① **全局修复**：`api.request()`/文件上传收到 401 **无条件**触发 `onAuthLost`（`store` 注册 → 清登录态 + 提示「登录态已失效，请重新登录」+ `reLaunch` 回登录），任何页面的 `.catch` 再也吞不掉掉登录后果；写入 **AGENTS §0 #7 全局铁律**。② **可发现性**：`brief` 页把「军师记忆」六类 + 「完整履历」卡提到 hero 之下最前（原埋在 understanding 长段后），加「整理中」非空态；`profile` 菜单加「完整履历」直达入口 + 「个人档案·军师记忆」。影响面：app（api/store/brief/profile）+ AGENTS + CHANGELOG。⚠ 前端改动需重新 build:weapp 发版；掉登录时**重新登录**即可看到真实记忆。

- **2026-07-06** · **批次B：军师记忆库（P1-P3）+ F-5 诊断轮次持久化 · ✅ 已部署 prod（`deploy-prod.sh`，SHA 77b06c8）**。部署前用 `prisma migrate diff` 预检确认**纯加法零 DROP**；db push 落 5 加法列（strategic_profile: diagRound/diagSessionId/dossierJson/dossierAt；memory: category）+ 顺带补齐 feat 07-04 起滞留未部署的 `wechat_subscription`/`wechat_notification_log` 两表（也是加法）。server tsc 建成、junshi-api 重启健康、公网 /api/health ok。**小程序新页面（记忆库/完整履历）仍需微信 DevTools 手动发版**。明细：
  - **F-5**：`StrategicProfile.diagRound`+`diagSessionId` 用户级持久化诊断轮次（换/删会话不清零）；context.ts 改读 `getDiagRound`、sessions.ts 两路由战略一问一答 `bumpDiagRound`。
  - **P1 记忆库地基**：`Memory.category`（六类 founder/company/status/vision/strategy/rapport）；`extractInsights` 改归类抽取；**recall 改用户级共享事实池**（跨军师，弃 agentKey 隔离，`vectorSearchMemories` agentKey 可空）；**总军师 general 开始写记忆**（删 sessions.ts 4 处 general 短路）。此为用户拍板「用户级共享事实池」方案（取舍点1）。
  - **P2 军师记忆**：主公·个人档案页六类结构化卡（现代白话标签：创始人/企业/现状/目标愿景/战略/陪跑；充实度 待补/部分/较全/已确认）+ 逐条可删纠错；`services/memoryLibrary` + `GET /me/memory-library`。
  - **P3 完整履历**：`services/dossier`（gather 全量→LLM 结构化生成→coerce 校验→确定性兜底→缓存 `StrategicProfile.dossierJson`）+ `gateway.llmJson` + `GET /me/dossier` + `POST /me/dossier/generate`；原生商务风长页面 `packages/work/dossier`（深色封面+编号小节+重点框/数据条/时间线/寄语），命盘段由 believe 开关 gated。语气按用户定：**导航标签现代白话、报告正文专业咨询风 grounded 不拔高、全程去 AI 腔**（见 memory junshi-voice-no-ai-speak）。
  - schema 加法 5 列（strategic_profile: diagRound/diagSessionId/dossierJson/dossierAt；memory: category）。契约 + mock 同口径，H5 全程实测（六类渲染、履历 8 段商务风）。影响面：server(schema/context/sessions/memory/vectorStore/gateway/memoryLibrary/dossier/meta) + shared/contracts + app(api/mock/brief/dossier/app.config) + docs。

- **2026-07-06** · **军师版本重置 V6.0/V6.1 → V1.0（全新体系首个正式版本）· 已发布 prod**：旧「天势终极版 V6.0」沿袭自更早的米诺老版本；全新搭建的军师参谋部体系从 1.0 起版。prompt 头部 V6.0→V1.0（中英），第十九部分撤「V6.0 更新说明/相比V5.1新增 + V6.1 去机制化修订」历史，改「V1.0 · 军师参谋部体系」founding note（能力总览 + 去机制化并入 V1.0 地基铁律「数据自洽」），保留一句 provenance「由旧天势终极版重构而来」。文件名 strat.v6.md/常量 MASTER_V6 属内部 plumbing（DB 存内容不存文件名），不改。经 `publishDraft('general')` 发布为 **AgentVersion version 3**（`cmr9ae963…`，44957B），预检基线=V6.1(v2) 逐字节确认，指针 v2→v3，draftDirty 清零，无 V6.0/V6.1/命中率67% 残留，service active。回滚：`rollbackToVersion('general', 'cmr8tt9ep0002bf6qjzlyxsfj')`(v2)。影响面：server prompts（两副本，纯文案）+ prod DB agent(general)。

- **2026-07-06** · **统一五个 tab 页标题区高度**：五个 tab 页统一使用 `Screen topInset + tab-page-head`，战局页移除独立胶囊测量与页内安全区 padding，问策/军情/军令/锦囊/我的标题栏收敛为同一 64px 标题区，避免切换 tab 时标题高度和首屏内容起点不一致。影响面：app tab 页头样式 + Screen 公共样式 + AGENTS/CHANGELOG。

- **2026-07-05** · **批次A·prompt 去机制化（V6.0→V6.1，AUDIT A-1/P-12/F-10/F-2/F-3/A-9）**：POLISH_PLAN 最高优先「止血信任裂缝」批次。总军师 V6.0 全文 prompt 里所有「AI 自产账本 + 自报数字 + 索要档案 + 埋死时间钩子 + 写死里程碑天数 + 五维自评分」逐处收敛，消除「同屏两套命中率/准确率」的信任裂缝——账本产出权收归系统、prompt 只引用注入块：① 4.8 预言验证 / 9.1 决策日志：不再自建「预言日志 #N」「决策日志 #N」、不再自报「命中率 67%/准确率 XX%」，改「以【天机账本】【决策账本】块为准，块里没有不编，样本不足如实说」（A-1）；② 9.2/十九章 战略档案：改「系统持续沉淀、以【战略档案】块注入、直接引用」，删「把这段发给我」回传话术（F-10）；③ 11.1 悬念钩子改开放式、去掉「下周二/30天后」系统兑现不了的死时间（F-2 止血）；④ 11.2/11.3 里程碑明确=使用天数、以【段位·里程碑】块为准、话术不写死天数（F-3）；⑤ 第八部分去掉点名公司（榕树家/瑞斯国际）与冻结客单价，量化基准以【行业基准】块或追问三问为准（A-9）；⑥ 第十三部分取消五维健康度 0-100 自评分，改定性研判（强/稳/承压/告急）（P-12）；⑦ 文末加全局【数字铁律】兜底。同步改**两处committed副本**（`server/prompts/strat.v6.md` 运行时加载 + `server/src/data/prompts/strat.v6.md` prod-DB 部署源，二者原本逐字一致），`strat.v6.baseline.md`（prod 还原点）不动。**✅ 已发布 prod（2026-07-06）**：V6.0 全文人格自 2026-07-03 挂在**总军师 `general`**（`agents.ts` `MASTER_V6`→`key=general.systemPrompt`；`strat` 已非 V6.0 载体）。经 `publishDraft('general')`（=admin 发布同逻辑）发布——先只读预检确认 prod 现值与改动前基线**逐字节一致（41710B）**无线上漂移，再 update 草稿+发布：产出 **AgentVersion version 2**（`cmr8tt9ep…`，45342B），`publishedVersionId` v1→v2，draftDirty 清零，8 条旧病灶串全消、4 条新护栏就位，service active/health ok，**无需重启**（`resolveEffectiveAgent` 每请求实时读 DB）。回滚：`rollbackToVersion('general','cmr4c01b600c8hprmo80g415s')`；V6.0 备份在 prod `/tmp/general-v60-backup-*.txt` + 本地 `dev/aliyun/prod-backups/`。见 memory strat-v6-embedding/prod-deploy-method。影响面：server prompts（两副本，纯文案，无代码/schema）+ prod DB agent(general) + docs。**未含**：命理择时「精确到日」降级（P-6，属命理批次）、账本闭环 App 页（F-8，批次C）。

- **2026-07-05** · **战局(军情)页真数据化：hero 真主要矛盾 + 三势研判可靠反查报告**：① hero「主要矛盾」不再渲染通用档案摘要——`ClientUnderstanding` 加 `mainContradiction/positioning`，server `understanding.ts` 从 `StrategicProfile` 带出真结论优先展示（mock 按 `profile.pain` 派生样例），修 hero 标签与内容不符的说假话 bug；② 市势/人势「已研判→查看」从「猜标题」升级为可靠反查——研判入口带 `force` 标签→认可存库时报告 `type` 打成「{势}研判」→战局卡按 type 精确匹配（复用现有 type 字段，无 schema 变更），有则「已研判 · {标题}」点开报告详情。影响面：shared/contracts + server(understanding) + app(home/chat/mock)。（军令卡血缘 L-3 属执行页，留后续。）

- **2026-07-05** · **修复小程序按需注入字段未写入产物**：Taro 3.6.34 对 `app.config.ts` 中的 `lazyCodeLoading: "requiredComponents"` 没有稳定输出到 `dist/app.json`，导致 DevTools 仍按旧 app.json 载入。weapp 构建链新增 `PatchWeappAppJsonPlugin`，在 webpack assets 阶段补写 `dist/app.json.lazyCodeLoading`；AGENTS 同步记录产物校验要求。影响面：app 构建配置 + 小程序 app.json 产物 + AGENTS/CHANGELOG。

- **2026-07-05** · **修复：三势·市势/人势 区分研判 + 已研判卡片可点开报告**：两处业务逻辑问题——① 市势/人势 原本都进战略诊断官发**同一条**指令，现各有独立研判开场（市势=市场与竞争格局；人势=资源与组织承载力，产出各以「市势研判/人势研判」为题），仍走免费 strat 避开 intel/org 解锁墙；② 生成并存入方案库后，战局「市势/人势」卡不能像天势那样点开预览，现按标题/类型关键词反查方案库对应研判方案——已研判则显「已研判 · {标题}」并点开报告详情，否则「发起判断」。`THREE_FORCES` 加 `ForceItem` 类型（agentKey/prompt/match）；home 拉 `api.reports()` 供反查。影响面：app（operatingSystem/home）。

- **2026-07-05** · **集成 main（merge）**：本分支合入 main 最新（底栏/tab 图标与大标题 redesign + 对话页/报告卡/军令卡修复）。自动合并零冲突（名词统一/打磨改动与 main 的 tab redesign 落在不同代码行）。原意 rebase，但本分支含 WO-02→revert 提交对会让 rebase 对重叠文件重复解冲突且有风险，改用 merge 一次性合入，结果等价更稳。

- **2026-07-05** · **打磨②：天时日历（三势·天势）改 canvas 图片交付**：顺着送你一卦的图片交付，把「全年天时日历」也从公开 HTML 链接（`publishCard('calendar')`→`/api/r/:id`）改成小程序 canvas 出图。新增 `app/src/services/canvasCard.ts`（`renderCardToImage` + `shareCardImage`/`saveCardImage` + `wrapText`/`roundRect`）作送你一卦/天时日历/后续战报卡的**共享出图管道**；gift 页重构复用它（行为不变）；calendar 页撤「生成网页打印版」改「生成天时日历图片」（`paintCalendarCard`：12 月攻守网格/拐点/日主口径/裂变位，固定品牌配色）→ 发好友/存相册，顺带缓解该卡 P-5/F-9/A-10。`mock.ts` 的 `saveBazi/myChart` 返回确定性样例命盘（`sampleChartM`），修 review 铁律③「mock 命盘恒空导致天时/天势卡/送你一卦本地走查断裂」——现 mock/H5 可完整走查。**canvas 出图 weapp-only，需真机复验**（复用已真机验过的送你一卦同一管道）。影响面：app（canvasCard 新增 / gift / calendar / mock）。

- **2026-07-05** · **打磨①：送你一卦合规化（AUDIT P-4/P2）**：`docs/[FABLE5]POLISH_PLAN.md` 打磨方向第一单。把「送你一卦」从「服务端渲 HTML→`reportHtml.create` 永久落库→`/api/r/:id` 无鉴权公开」改为「服务端现算即返卡文本→小程序 canvas 画卡导出**图片**→用户点对点分享」，关掉第三人敏感生辰永久落库+公开访问，并顺带了结 P-5/F-9/A-10（图片无公开 URL、渲染自带）。新增 `POST /cards/fate/preview`（校验+现算+返回 `FateCardContent`，不落库；`consent!==true`→400 PIPL；封禁 `/cards/:kind` 的 fate+friendBazi 落库路径）；抽 `validatePaipanInput`（修 P2 friendBazi 零校验）+ `fateCardContent`，`/profile/bazi` 统一校验口径；SSOT 加 `FateCardContent`；gift 页重写（同意勾选门槛 + canvas 画卡导图 + 发好友/存相册，去公开链接，文案改真话）。**待真机复验 canvas 出图**。影响面：server（cards/profile/paipan/cardHtml）+ shared/contracts + app（gift/api/mock）+ docs。

- **2026-07-05** · **新增 `docs/[FABLE5]POLISH_PLAN.md`**：review 工作流（12 功能区×诊断×对抗性复核）产出 79 条已核实 finding 的逐功能精细打磨方案（含总判断、最先打磨 8 件事、逐功能清单、4+1 批次、7 个产品拍板点、2 条 P0 命理合规红线）。

- **2026-07-05** · **方向调整：撤销减法，回到全功能 + 打磨**：产品侧判断"功能都是客户想要的"，不再做减法。**回滚 WO-02** 的真减法——恢复市场货架（thinktank 能力目录 4 分区 + market 页 + profile「模块管理」+ sessions「军师锦囊/模块」快捷卡 + CHAT_GUIDES「打开模块市场」）、战局三势卡（市势/人势）+ 关联模块、profile「送你一卦」，`market`/`gift` 恢复为正常可达入口。**保留 WO-01**（名词统一：案卷/方案/军令/资料 + 军师印象）与 **WO-03**（段位卡冷启动延迟曝光 + `data/emptyStates.ts` 空态导流 + 战局「下一步」卡，作为打磨叠加在全功能之上）。后续按 `AUDIT_V6_GLOBAL` 的问题清单逐功能捋顺逻辑、精细打磨（先 review 出方案再改码）。构建 `build:weapp` 全绿。影响面：app（thinktank/home/profile/sessions/market + operatingSystem 恢复；home/profile 手术保留 WO-01/03）+ docs（AGENTS §7/§13、CHANGELOG）。

- **2026-07-05** · **小程序重构·批次一减法（WO-01/02/03，纯前端）**：按 `docs/[FABLE5]REDESIGN_EXEC_SPEC.md` 落地批次一三张工单，Project/Casefile 等数据模型与路由不动。**WO-01 名词统一**：前台业务名词收敛为「案卷 / 方案 / 军令 / 资料」；项目→案卷（projects/project 页改「我的案卷/案卷详情」，详情三视图 战况|方案|资料），报告/成果→方案，记忆/专属理解→军师印象；profile 统计三卡改 案卷/方案/资料。**WO-02 撤货架**：智库 tab 改「我的军备库」三段（我的能力/资料库/方案库），未开通能力与价格/💎 不再露出；market 页保留文件与路由（处方落地页，读 `from=prescription` 显示来源）但移除全部 tab/菜单/引导入口；战局页撤市势/人势静态卡（留天势），空出区放「下一步」卡占位（WO-07）；profile 移除「送你一卦」。**WO-03 冷启动**：profile 段位卡延迟曝光（streak≥3 或 usageDays≥14 才渲染）；空态导流文案集中到 `app/src/data/emptyStates.ts`，战局/执行冷启动空态导流初诊（速诊 WO-06 未上线前跳对话预填开场语）。构建 `npm run build:weapp` 全绿。影响面：app（home/studio/thinktank/profile/sessions/chat/brief/projects/project/market/report/library + data/emptyStates·operatingSystem + mock）+ docs（AGENTS §7/§13、CHANGELOG）。**批次一未含**：WO-03 §3 服务端注入块、WO-04/05 及批次二三，见 §13 TODO。

- **2026-07-04** · **接入微信订阅消息触达**：新增 `WechatSubscription/WechatNotificationLog` 两张表，`GET /wechat/subscribe/templates` 返回已配置模板，`POST /wechat/subscribe` 记录 `wx.requestSubscribeMessage` 结果并仅对 `accept` 累计一次性发送额度；新增 `services/wechatSubscribe.ts` 调微信 `subscribe/send`，发送成功扣减额度并写日志。执行页复盘视图「订阅复盘提醒」接入授权；scheduler 新增 21 点后当日复盘提醒并在久不复盘候选时尝试发送；报告保存、会话报告生成和网页版报告渲染完成后尝试发送报告完成提醒。`.env.example`/部署文档补订阅模板配置，单测覆盖订阅额度与发送扣减。影响面：server schema/wechat/scheduler/reports/sessions + shared contracts + app api/studio + docs/tests。

- **2026-07-04** · **完成军令改为归档展示**：执行页「今日军令」只渲染未完成任务，勾选完成后自动从待执行列表收起到默认折叠的「已归档」区；归档区可展开查看、长按删除、点勾取消完成，避免误操作后无法恢复。顶部军师献策、今日主令和执行信号同步改为按待执行/已归档状态展示；周计划、复盘、每日战报仍读取完整 `done` 记录，不删除历史数据。影响面：app 执行页 + dossier 视图 helper + AGENTS/CHANGELOG。

- **2026-07-04** · **修复今日军令重复保存导致执行页过长**：`/casefile/accept` 自动拆军令改为按「同一案卷 + 同一天 + 标准化文本」幂等，重复认可同一成果返回 `newOrders=0/skippedOrders>0`，不再追加重复军令；`casefileView` 读取时过滤历史重复行，手动添加同日同文本军令也直接忽略。小程序 mock 分支同步同口径，聊天页重复点击“认可方案/转成军令”时提示“已转成军令，不重复添加”，不再重复存库或跳转刷长列表。新增 casefile 回归测试覆盖自动/手动重复。影响面：server casefile service/routes + app dossier/chat + casefile 测试 + AGENTS/CHANGELOG。

- **2026-07-04** · **拦截报告误带代码工作区语境**：LLM 运行时业务边界新增“工作区仅指客户业务项目/档案/知识库”的硬约束，禁止把 Git 仓库、代码库、IDE、文件系统等工程环境当客户资料；gateway 对结构化成果增加工程语境检测，命中“当前工作区/Git 仓库/代码仓库/上传到工作区”等跑偏内容时替换为业务兜底成果并标记 `degraded`，避免错误报告入库或扣用户额度。新增 OpenAI 兼容 stub 回归测试复现“当前工作区为 Git 仓库”。影响面：server llm schema/gateway + provider 集成测试 + AGENTS/CHANGELOG。

- **2026-07-04** · **修复小程序报告“网页版”误变复制链接**：报告卡「网页版」继续走 `packages/work/webview` 直接打开自有域名 `/api/r/:id`；`web-view` 加载失败与 `navigateTo` 失败不再自动写剪贴板，避免小程序内点击后表现成“复制链接”。影响面：app chat/webview + AGENTS/CHANGELOG。

- **2026-07-04** · **普通聊天切换 provider 原生流式并收口为输入审核**：`chatCompleteStream` 改为只对用户输入做前置内容审核，违规输入直接拦截；OpenAI/Claude 普通聊天在无工具调用时优先调用 provider 原生 `stream:true` / Claude stream，token 到达即经 `/generate` SSE 下发，输出不再走阻塞式审核，仅保留 trace 与禁用词审计；Dify、工具循环、mock 或兼容网关不支持 stream 时回退为完整结果分块。新增 OpenAI 兼容 SSE stub 测试覆盖原生 token 事件与输出不写 `moderation_log`。影响面：server LLM gateway + OpenAI/Claude provider + sessions 注释 + provider/集成测试 + AGENTS/CHANGELOG。

- **2026-07-04** · **修复“出报告”当前页一直输入中**：小程序聊天页补齐“出报告/重新出报告/战略体检”等成果意图识别，明确成果请求与成果型顾问改走 `/generate` report SSE；收到 `meta` 立即渲染 ReportCard 骨架，`begin/section/footer/done` 增量更新同一卡片，完成前不开放存库/网页版/认可动作；普通聊天流 fallback 若拿到 report 也会替换空 assistant 占位。影响面：app streaming/chat/ReportCard + AGENTS/CHANGELOG。

- **2026-07-04** · **减少报告保底草案并去技术化提示**：报告类真实模型输出上限从 1500 提高到 2600，OpenAI/Claude provider 在强制结构化工具未返回但存在普通文本时，会把文本归一化为报告分段而不是直接标 `degraded`；小程序 degraded 提示从“降级模板/结构化产出”改为业务可理解的“保底草案，已免扣额度”。影响面：server OpenAI/Claude provider + app chat + AGENTS/CHANGELOG。

- **2026-07-04** · **修复报告工具返回非数组 sections 导致流式报错**：新增 `normalizeDeliverableSections`，OpenAI/Claude provider 对 `emit_deliverable` 的 `sections` 做归一化（数组/对象/字符串均转合法分段，解析失败走降级成果），避免 qnaigc 返回 `{sections:{...}}` 时触发 `d.sections.map is not a function` 并让 `/generate` 发出 AI_UNAVAILABLE；回归测试覆盖“出报告”强制工具调用且 `sections` 非数组仍返回 report。影响面：server llm schema + OpenAI/Claude provider + provider 集成测试 + AGENTS/CHANGELOG。

- **2026-07-04** · **修复“出报告”连续报 AI 服务不可用**：总军师 on-demand 在明确“出报告 / 战略体检 / 重新出报告”等成果请求时不再走 `generateAdaptive` 可选工具模式，改为直接 `generateDeliverable` 强制结构化报告，避开 qnaigc/OpenAI 兼容 Claude 在 adaptive 下返回空文本并导致 `/generate-sync` 503 的问题；补充 provider 回归测试，断言“出报告”必须强制调用 `emit_deliverable`。影响面：server sessions + provider 集成测试 + AGENTS/CHANGELOG。

- **2026-07-04** · **修复总军师普通输入被固定追问兜底**：`/generate-sync` 与 `/generate` 统一 on-demand 意图分流，普通问答走纯 chat，只有“出报告/战略体检/生成方案”等明确成果请求才进入结构化成果路径；OpenAI/Claude provider 遇到空 `content` 改为 AI 服务异常，不再把“我需要更多信息来给你一个可执行的判断…”作为伪成功回复落库。影响面：server sessions + OpenAI/Claude provider + 测试 + AGENTS/CHANGELOG。

- **2026-07-04** · **修复对话成果卡“网页版”在小程序内打不开**：报告 HTML 发布链路改为 `htmlUrl` 固定返回自有域名 `{PUBLIC_BASE_URL}/api/r/:id`，避免小程序 `web-view` 直开 OSS 域名时被业务域名白名单拦截；OSS 上传保留为可选 `cdnUrl` 镜像。`POST /sessions/:id/messages/:mid/report` 对已生成过的旧 OSS `htmlUrl` 做兼容迁移，再次点击会自动写回自有域名链接；web-view 页增加安全解码和加载失败复制链接兜底；契约新增 `Deliverable.cdnUrl`，并补覆盖 OSS 旧链接转换的单测。影响面：server reportHtml/render_report/sessions + shared contracts + app webview/api 注释 + AGENTS/CHANGELOG。

- **2026-07-04** · **修复成果型顾问自动发送误入流式导致无返回**：`pages/chat` 的流式判定不再依赖可能滞后的 React `agent` state，改为按本次发送的 `agentKey` 重新读取顾问配置；路由携带 `send=` 自动发送给「战略诊断官」等带 `deliverableKey` 的成果型顾问时，稳定走 `/generate-sync` 成果路径，并显式传入本次 `projectId`，避免首条自动发送丢项目作用域。`generateStream` 成功条件收紧为必须收到可渲染的 `token/chat` 事件，误收到 report SSE（`begin/section/footer`）会返回 `false` 触发同步 fallback，不再留下空回复。影响面：app chat/streaming + AGENTS/CHANGELOG。

- **2026-07-04** · **小程序恢复真流式并锁定基础库 3.16.2**：`project.config.json` 增加 `libVersion=3.16.2`；`STREAM_CHAT` 恢复默认开启，小程序端 `generateStream` 重新启用 `wx.request enableChunked + RequestTask.onChunkReceived` 消费 `/generate` SSE，按字节切完整 SSE block 后 UTF-8 解码，失败/无事件时返回 `false` 由聊天页自动回退 `/generate-sync`，避免先展示假网络错误；H5 继续走 `fetch` ReadableStream。总军师 on-demand 普通问答前后端都放行真 token 流，只有明确要“生成方案/报告/成果卡/纪要/军令”等成果请求才回同步成果路径。影响面：app project config + streaming/config/chat + server sessions + AGENTS/TESTING/CHANGELOG。

- **2026-07-04** · **AI 对话正文去卡片并支持选择复制**：`pages/chat` 普通 AI 回复从白色边框卡片改为无卡片正文排版，用户输入继续保留右侧气泡卡片；`MarkdownText` 增加 `selectable` 支持，AI 回复正文和要点可直接选择文字复制，同时保留长按复制兜底。影响面：app chat/MarkdownText + AGENTS/CHANGELOG。

- **2026-07-04** · **手机号唯一身份口径收口：微信登录后强制绑定**：保留“手机号唯一确定用户身份”的既有方案，撤回微信 openid 作为业务主键的改造方向；小程序登录弹层移除「暂不绑定，先进去看看」，微信账号登录后必须完成手机号绑定或退出登录，避免未绑定微信占位账号与手机号账号割裂。影响面：app 登录弹层 + AGENTS/CHANGELOG。

- **2026-07-03** · **对话输入区升级 + Claude 自适应产出 + 报告 HTML 换 V6.0 卡片风**：小程序聊天输入区从单行 `Input` 改为多行 `Textarea`，底栏补加号、固定模型胶囊和发送态；加号支持微信 `chooseMessageFile` 上传资料到知识库并自动挂本轮引用，也可打开已有项目/报告/知识引用；长按复制与 busy 锁定保留。`generateAdaptive` 的 Claude 分支改走 `claudeAdaptive`，与 OpenAI 一样默认文字对话，只有模型判断需要完整成果时才可选调用 `emit_deliverable`；普通报告 HTML 从旧米色卷轴样式改为 V6.0 天势卡片风（深绿封面、白色章节卡、金印落款、军师参谋部品牌）。影响面：app chat/Icon + server LLM Gateway/Claude provider/reportHtml + AGENTS/CHANGELOG。

- **2026-07-03** · **网络错误按真实原因友好分流**：`api.request` 新增 `networkErrorInfo/httpErrorInfo`，将请求失败区分为超时、断网、合法域名配置、SSL/证书、DNS、服务不可达、取消、普通网络波动，并对 HTTP 408/504、429、5xx 做用户友好映射；前台展示真实但不技术化的原因，`reason/technicalMessage/origin/url/statusCode` 保留给开发排查。影响面：app API 错误映射 + AGENTS/CHANGELOG。

- **2026-07-03** · **网络错误提示去技术化**：小程序 `Taro.request` reject 不再把 request 合法域名和 API 域名直接展示给用户，前台只提示“军师暂时没有连上服务/当前网络有点不稳”；原合法域名排查说明保留在错误对象 `technicalMessage`、`origin`、`url` 字段，方便开发排查。影响面：app API 错误映射 + AGENTS/CHANGELOG。

- **2026-07-03** · **卡片分享链接改自有域名 + 小程序码回流**：B 级卡片发布不再走 OSS，改 `cardHtml.publishCardHtml` 直接返回 `{PUBLIC_BASE_URL}/api/r/:id`（品牌域名、微信聊天内点开即达；`/api/r/:id` 本就是不可猜 id 免鉴权公开页）；`wechat.miniCodeDataUri`（getwxacode/unlimit + stable_token 复用，check_path:false，测试/未配凭据/接口失败一律 null 降级）生成小程序码 base64 内嵌卡片页脚「长按识别 · 找军师参谋部」，网页卡自带回流钩子。OSS 托管保留给报告（reportHtml.publishHtml 未动）。影响面：server cardHtml/wechat + cards 测试（330）。

- **2026-07-03** · **天时改原生展示（用户反馈：到处引导对话/网页链接奇怪）**：删除战局页「本月天时」条与「日历卡」按钮；三势里的天势卡直接承载——卡面显示本月攻守+拐点，点开新原生页 `packages/work/calendar`（12 月攻守网格+图例+关键节点说明，`useShareAppMessage` 支持微信右上角转发；无命盘时页内就地补生辰 `saveBazi`，老用户不用回炉建档）；网页版降级为页脚「打印版」次要入口。市势/人势结论产自对话，保留发起判断。影响面：app 战局页 + 新 calendar 分包页 + 路由。

- **2026-07-03** · **P0-3 总军师成果承接（on-demand）**：general 配 `deliverableKey='战略方案'` + `skillsConfig.deliverableMode='on-demand'`（`data/agents.ts`/`prisma/seed.ts`/`test/helpers.ts` 三处同步），新增「战略方案（破局方案）」模板于 `data/deliverables.ts`（段名对齐案卷提取启发式：军令取「30 天行动军令」、风险锁取「现在不能做」），`KEY2AGENT` 增 战略方案→general；六轮主线聊成熟后总军师直接产出可采纳成果卡，H5 对 general 的逐 token 流式随 deliverableKey 自动关闭（小程序不受影响）。SSE 纯聊天流式测试改用临时无产出体覆盖 + 增 general on-demand 断言；masterIdentity 增承接测试（329 tests）。影响面：server 注册表/模板/seed + 测试 + AGENTS §13 #3。

- **2026-07-03** · **P0-1 两张卡前端入口**：战局页「本月天时」条新增「日历卡」按钮（`publishCard('calendar')` → 复制分享链接）；新建 `packages/work/gift` 送你一卦页（朋友称呼+阳/阴历生辰+十二时辰含不确定+性别 → `publishCard('fate')` 现算不落库出天命速写卡），入口挂「我的」菜单；`app.config.ts` work 分包注册 `gift/index`。影响面：app 战局/我的/分包路由 + 新页面。

- **2026-07-03** · **恢复对话内容长按复制**：`pages/chat` 给自定义消息气泡补齐 `onLongPress` 复制能力，覆盖用户消息、AI 回复（含要点）、问候/专属理解提示、记忆更新提示与结构化成果卡全文；避免小程序自定义 `View/Text` 气泡无法依赖系统文本选择导致长按无效。影响面：app 聊天气泡交互 + AGENTS/CHANGELOG。

- **2026-07-03** · **修复对话等待回复时点击输入框清空草稿**：`pages/chat` 在 `busy` 状态下真正锁定输入区——外层输入槽不再触发 focus，`Input` 置 disabled，`onInput/onSend` 先行拦截并保留当前草稿，发送按钮等待态只置灰不触发发送；AGENTS 同步对话键盘等待态约束。影响面：app 聊天输入区 + AGENTS/CHANGELOG。

- **2026-07-03** · **修复 server 真机预览旧 token 失效后对话页清空**：`pages/sessions` 每次显示都先刷新公开 `/agents` 注册表，即使未登录也保留总军师/专业军师列表；`store.logout()` 不再把 `agents` 清成空数组，改回 `DEFAULT_AGENTS` 离线兜底。影响面：app 对话首页登录兜底 + store 退出态 + AGENTS/CHANGELOG。

- **2026-07-03** · **修复真机登录态失效提示闪烁但不弹登录**：默认首页 `pages/sessions` 补齐 `Login` 承接，未登录/401 时直接打开登录弹层，快捷入口先走登录门；该页捕获 401 时静默清状态并开弹层，不再依赖 `handleApiError` 反复 `reLaunch` 自己。`store.handleApiError` 对 401 toast 加 1.5s 节流，并且当前已在 `pages/sessions/index` 时不再二次 reLaunch，避免多个接口同时 401 造成真机提示闪烁。影响面：app 登录兜底 + store 401 处理 + AGENTS/CHANGELOG。

- **2026-07-03** · **开启 Taro Webpack5 持久化缓存**：`app/config/index.ts` 将 `cache.enable` 从 `false` 改为 `true`，按 Taro 官方建议启用 filesystem cache，提升二次 `dev:weapp`/`build:weapp`/H5 编译速度；AGENTS 补充缓存脏数据时清理本地 `app/node_modules/.cache` 的处理口径。影响面：app 构建配置 + AGENTS/CHANGELOG。

- **2026-07-03** · **小程序上传前阻断 mock/dev 构建**：`weapp-upload.mjs` 与旧 `upload-weapp.js` 上传前扫描 `app/dist`，必须包含预期线上 API（默认 `https://wxapi.aibuzz.cn/api`）且不得残留 `localhost:4000/api`，否则直接失败，避免误把默认 `build:weapp` 的 mock 包上传到微信后台导致对话返回模板答案。AGENTS 同步把“编译推送/本机上传”命令改为 `npm run build:weapp:server`。影响面：app 上传脚本 + AGENTS/CHANGELOG。

- **2026-07-03** · **生产补齐 M0-M4 后端代码与主军师身份迁移收口**：已用 `scripts/deploy-prod.sh` 将 `4902b0b` 发布到 `wxapi.aibuzz.cn` 生产环境（server+admin），新增依赖安装、Prisma schema 同步、后端构建重启、admin 构建发布与 nginx reload 均通过；生产库确认 9 张新增表与 `Session.mode` 已就位。按既定剧本只对 `survey_question` 做两条定向 UPDATE：阶段题改为年营收四档，行业题改为美业/大健康拆分后的行业列表，未重跑 seed。公网验证：`/api/health`、`/api/survey`、`/admin/` 正常，新增鉴权路由返回 401 而非 404，`/api/agents` 返回 general V6 开场白与 `strat=战略诊断官`。影响面：生产 server/admin 部署 + 生产问卷配置 + AGENTS/CHANGELOG。

- **2026-07-02** · **M4 PR-15/17 第一批：B 级卡片（每日战报/天时日历/天命速写）+ 叙事线/谶语存档**：新增 `services/cardHtml.ts` + `POST /cards/:kind`——①每日战报卡：当日军令完成/对齐率/回填三数/段位/连续复盘天数全部读服务端账本，语录按日确定性轮换（公版语录）；②天时日历卡：命盘 12 月攻守网格+拐点标注+谶语；③天命速写卡（送你一卦·裂变）：命格速写/今年大势/一条建议由命盘确定性生成，**朋友生辰现算不落库**，底部引导找军师参谋部。发布复用 `publishHtml`（reportHtml 抽出的通用链路：存库留底+OSS/后端兜底）。叙事线/谶语：`StrategicProfile.extraJson` 存档（PUT /profile/strategic 接受 narrative/verse），注入块带「跨月复述一致/全年沿用」口径——V6.0「数月后还能复述同一句谶语」达成。前端：执行页复盘视图新增「生成每日战报卡（可分享）」。品牌红线：卡片测试含无米诺断言。测试 +5（323→328）✓；双端构建 ✓。剩余 9 卡+A 级模板+PR-20 智库管道记 §13。影响面：server cardHtml/cards 路由/reportHtml 重构/strategicProfile + app 执行页/api + AGENTS/CHANGELOG。

- **2026-07-03** · **小程序聊天禁用 SSE 流式避免假网络失败**：`STREAM_CHAT` 改为仅 H5/Web 生效，小程序端聊天固定走 `/generate-sync`；`generateStream` 加平台守卫并移除 weapp `enableChunked/onChunkReceived` 分支，避免 `/generate` 已在后端生成并落库但微信 chunk/fail 回调让当前页显示“网络请求失败”，返回再进才看到回复。AGENTS 同步小程序端不得调用 SSE `/generate`。影响面：app config + streaming/chat + AGENTS/CHANGELOG。

- **2026-07-03** · **补齐战局页本命色真机联动**：主题类显式覆盖 `--green/--green-hero/--gold/--gold-soft` 等业务 token，避免小程序真机对链式 CSS 变量重算不完整导致 hero/卡片仍保持默认绿；战局页模块 pill、能力标签、CTA 阴影、天时条和 hero 辅助文字改走 `--accent` 系列。PRODUCT/AGENTS 同步“业务主色随本命色联动，语义风险色固定”。影响面：app 全局主题 token + home 样式 + PRODUCT/AGENTS/CHANGELOG。

- **2026-07-03** · **修复小程序底部导航消失与默认入口**：`custom-tab-bar` 在无全屏 overlay 时自动清理过期隐藏标记，避免真机上次异常退出后自定义导航持续不渲染；`app.config.ts` 页面顺序改为 `pages/sessions` 首位，鉴权失效、退出登录和注销后也回到「对话」tab；active tab 增加本命色柔底和描边，选中态更明显。影响面：app.config + custom-tab-bar + store/profile/settings + AGENTS/CHANGELOG。

- **2026-07-03** · **修正本命色全局联动**：`app.scss` / `app.h5.scss` 将 `--green/--green-hero/--green-soft/--gold/--gold-deep/--gold-soft` 改为派生自 `--accent`，让战局 hero、智库上传与按钮、执行行动/军令、我的用户卡与主题卡跟随设置里的本命色；`--danger`、纸张底色、正文墨色等语义/中性色保持固定。AGENTS §7.1/§7.2 同步从“固定角色色”改为“业务主色跟随本命色”。影响面：app 全局主题 token + H5 兼容 token + home 注释 + AGENTS/CHANGELOG。

- **2026-07-03** · **修复线上小程序对话“网络错误”兜底**：公网实测生产 `/api/health`、`/api/agents` 正常，临时诊断用户验证 `/generate-sync` 与 `/generate` 均可返回 200；前端问题定位为小程序聊天默认走流式 `/generate`，`enableChunked`/SSE 失败或无事件时只显示“网络请求失败”且不回退。`generateStream` 现在返回成功/失败并解析 HTTP 错误，小程序/H5 流式失败会在聊天页自动切回稳定的 `/generate-sync`，避免线上用户卡在网络错误气泡。影响面：app 聊天流式服务 + chat 页 + AGENTS。

- **2026-07-02** · **M4 PR-18/19（第一批）：真数据前端落位 + 行业库深度**：① 前端落位——我的页新增「战略段位卡」（段位/连续复盘/使用天数/决策准确率/下一段位要求，`GET /progress`）；战局页新增「本月天时」条（命盘逐月攻守当月窗口+拐点月，进攻绿/防守金调）与「经营数据」卡（近 7 天回填三数聚合=看板第一层 v1，无回填不展示）；执行页提醒卡与复盘视图显示「连续复盘 N 天」（`GET /reviews`）；`api.progress/reviews` + mock 返回空 → 界面优雅隐藏（不造假数字）。② 行业库深度（V6.0 §8）——IndustryPack 新增 decisionChain/ticketRange/benchmarkCases/mingLink 可选字段并入注入行；**美业/医美 与 大健康/养生 拆分为两个行业包**（各自决策链/客单价/天势关联），建档行业选项随之 +1（前端兜底同步）。测试 323/323 ✓；双端 tsc/构建 ✓；H5 mock 走查零报错。影响面：app 三页 + api + server industryPacks/注入行 + AGENTS/CHANGELOG。

- **2026-07-02** · **M3 PR-11/12/13/14：意图路由/诊断轮次/营收分阶段/角色语气（编排与适配收官）**：新增 `services/intent.ts`（全确定性规则）：① 意图路由——「这周复盘/月度总结/Q3 回顾/帮朋友算一卦/什么时候签约/出大事了/很迷茫」正确分流到 复盘(六层)/送卦/择时/紧急/师父 模式，`Session.mode` 粘性存储（本轮检测优先、检测不出沿用），**复盘意图自动落对应层 ReviewLog**（「这周复盘」=week 账）；② 诊断轮次——从会话历史确定性计算「本会话第 N 轮」注入（六轮制不丢位，快速通道提示）；③ 营收分阶段——建档问卷阶段题改「年营收区间」四档（前后端同步，旧标签 `stageOf` 兼容），注入 V6.0 §7 阶段适配指令（生存期只做短期战术等，stable 段）；④ 内在状态→五角色——生存焦虑/增长兴奋/管理痛苦/瓶颈迷茫/意义追问 → 教官/参谋长/大哥/战略家/师父 指令注入；**本命色语气注入移除**（回归纯 UI 品牌色，`{本命色}` 占位符保留），systemParts 测试同步改写。注入结构：【本轮导引】置 dynamic 首位（执行不复述）。测试 +6（317→323）全绿；双端 tsc ✓。影响面：server intent 服务/sessions 路由/schema 注入层/Session.mode + seed 问卷 + app Picker 兜底问卷 + AGENTS/CHANGELOG。

- **2026-07-02** · **M2 PR-8/9/10/6：复盘账本/预言验证/段位里程碑/复盘保底（留存闭环真数据收官）**：① `ReviewLog`（(userId,layer,date) 唯一）——执行页发起复盘落 day 账（快照当日军令完成/对齐/回填），对齐率与连续复盘天数服务端算（今天未复盘不打断），`review-gap-reminder` 断档提醒任务；前端 `startReview` 接入执行页复盘动线。② `ProphecyLog`——预言只来自真实模型结构化抽取（`gateway.extractProphecies`，mock/测试返回空=绝不伪造）+ 显式接口；总军师输出后 sessions 六个出口异步收割（有命盘才抽、同文去重）；`prophecy-due-scan` 到期对账候选（行级幂等）；命中率服务端算无样本 null。③ `UserProgress`——段位按真实门槛派生（V6.0 §11.4 五级，null 指标不放水，只升不降），里程碑按使用天数 7/30/90/180/365 解锁，晋升记 `user.rank.promoted` 审计；读路径无变化不写库。④ 复盘保底——`reserveQuota` 支持 grace：额度耗尽时复盘调用（确定性前缀识别）每日 2 次放行透支记账；**复盘动线从 ops(💎解锁) 改归总军师 general（免费）**——复盘是留存生命线不设付费墙。注入新增【复盘账本】【天机账本】【段位·里程碑】三块（均带禁止 AI 自算口径）。测试 +16（301→317）全绿；双端 tsc/构建 ✓。影响面：server 四服务/两路由/调度器/tokenQuota/sessions 收割 + prisma 三表 + app 执行页 + AGENTS/CHANGELOG。

- **2026-07-02** · **M2 PR-7：决策日志 + 准确率服务端统计（留存真数据第一块）**：新增 `DecisionLog` 表（`(userId,seq)` 自增序号；决策/理由/天势参考/验证标准/30 天默认验证期/状态/快慢标注）与 `services/decisionLog.ts`（记录/验证/统计/注入简报）。写入源：认可方案自动记一条「采纳《方案》：主判断」（`/casefile/accept` 钩子）+ 手动 `POST /decisions`；验证 `POST /decisions/:id/verify`（correct/revise + 事实记录）。准确率（总/快决策/慢决策）由服务端从状态行计算，**无已验证样本返回 null 而非 0%**；对话注入【决策账本】块（近 5 条 + 准确率 + 「系统计数禁止自算」口径），无记录不注入。测试 +4（自动记账/验证与快慢准确率/注入/隔离），全量 301/301 ✓。影响面：server 决策服务/路由/上下文注入 + prisma + AGENTS/CHANGELOG。

- **2026-07-02** · **M1 PR-5b：主军师身份切换（V6.0 人格移交总军师）**：仓库 seed 层 `general` systemPrompt 改为加载 V6.0 全文（prompts/strat.v6.md，缺失回退通用模板），greet 换 V6 开场口吻（前端离线注册表同步）；`strat` 回归战略诊断官专业参谋（短模板 + 「诊断结论回流总军师主线」口径），避免双 V6 人格分裂。调度白名单语义明确：unlock=可深聊/可被调度资格（403 AGENT_LOCKED 既有行为保持）；派单引擎（consult_specialist 编排 + on-demand 产出移交 general）列 §13 待 M2/M3。**prod 迁移剧本记 §13（线上仍是 strat=V6，上线 M1 时一次性搬移）**。测试 +2（身份/白名单 + 注册表品牌红线扫描），修 1 处因 V6 全文含「天势档案」字样误伤的旧断言（收紧为注入块完整标记），全量 297/297 ✓，双端 tsc ✓。影响面：server 注册表 + app 离线注册表 + AGENTS/CHANGELOG。
- **2026-07-02** · **M1 PR-4：定时任务框架 + 案卷久未推进召回扫描**：新增 `services/scheduler.ts`（任务注册制、进程内周期执行、单任务异常隔离、test 环境不自启），`index.ts` 启动挂载；首个真实任务 `casefile-idle-recall`（活跃案卷 ≥48h 无动作 → `system.recall.candidate` 审计候选，按用户按天幂等，发送待订阅消息通道接入——一次性授权需前端在打卡/复盘动线埋点）。测试 +2（任务隔离/召回命中+幂等+不误报），全量 295/295 ✓，tsc ✓。影响面：server 调度框架/入口 + AGENTS/CHANGELOG。
- **2026-07-02** · **M1 PR-3：统一状态层 StrategicProfile（战略档案）+ 城市经度表**：新增 `StrategicProfile` 表（userId 唯一：主要矛盾/定位/赛道/阶段 + 预留 十二问/KPI/extra）与 `services/strategicProfile.ts`（`extractStrategicFacts` 按分节标题确定性提取、合并写入只覆盖出现字段、`strategicBlock` 注入块）。回写触发：`/casefile/accept`（认可=用户确认的战略事实）+ `PUT /profile/strategic` 手动校准；`GET /profile/strategic` 读取。注入：`buildGenContext` → `ctx.strategicLine` → dynamic 段【战略档案（已确认，优先于推断）】置于【客户档案】之前——「聊完带决策的对话，下次开局记得要点」达成（PR-3 完成标志）。附带：`data/cityLongitude.ts` 主要城市→东经映射（~48 城），`/profile/bazi` 出生城市自动查表做真太阳时校正（乌鲁木齐正午→巳时 e2e 用例）。测试 +6（提取/回写覆盖语义/注入次序/校准隔离/空块/城市经度），全量 293/293 ✓，server tsc ✓。影响面：server 状态层/上下文注入/采集路由 + prisma + AGENTS/CHANGELOG。
- **2026-07-02** · **M1 PR-1/PR-2：排盘引擎 + 八字采集 + 天势注入（数字先做真）**：新增 `server/src/services/paipan.ts` 确定性排盘引擎 v1（干支历/八字/大运=lunar-typescript，紫微命宫/身宫=iztro；四柱十神、月令取格+打法映射 `data/baziPlaybook.ts`、日主强弱与喜用 v1 计分、大运时间线、年度逐月攻守、真太阳时经度校正；称骨暂缓待核表）+ `NatalChart` 表（userId 唯一、engineVersion 版本化，重排覆盖）。采集：`PUT /profile/bazi`（校验历法/性别/时辰/年份，缺 hour=三柱排盘，believe=false 只存偏好不排盘）+ `GET /profile/chart`；生辰偏好存 `Profile.extraJson.bazi`。注入：`buildGenContext` 组装 `ctx.tianshiLine`（`chartBriefing` 结构化简报 + 禁止 AI 自算铁律，随用户稳定放 stable 段命中提示词缓存；不信命理→`TIANSHI_OPTOUT_LINE` 降级指令；无命盘不注入）。前端：建档流新增第三步「天势档案（选填）」（阳/阴历、年月日、十二时辰含不确定、性别、出生城市、「不用命理视角」与跳过双出口），`api.saveBazi/myChart` + mock 分支（mock 不伪造命理结论）。测试：`test/paipan.test.ts` 6 条（已知八字 1988-03-15 逐项回归/两次排盘一致/农历等价/缺时辰/真太阳时午→巳/落库 upsert）+ `test/bazi.test.ts` 6 条（采集回显/校验/缺时辰/注入/降级/空白），全量 287/287 ✓；app tsc + weapp/H5 编译 ✓，H5 走查建档新步骤。已知边界记 AGENTS §13。影响面：server 排盘引擎/采集路由/上下文注入 + prisma + app 建档流 + AGENTS/CHANGELOG。
- **2026-07-02** · **品牌红线入档：禁止「米诺 / Mino」**：AGENTS §0 新增第 10 条强制指令（产品文案/提示词/交付物模板/代码标识/seed 一律用「军师参谋部」，从 Notion 原稿移植内容须先按 prompts README 映射去品牌）；存量残留（baseline 快照、`id:'mino'`、agents.ts 注释、双 prompt 目录合并）列入 §13 TODO 后扫。影响面：AGENTS 工程规范。

- **2026-07-02** · **M0 快赢周落地（V6.0 重构第一批，对应 Notion「③ 方案 Review」）**：①**执行闭环落库（PR-EX）**——新增 `Casefile/CasefileOrder/CasefileMetric` 三表（用户行级隔离，`casefile_order.aligned` 预留对齐率标注）+ `/casefile*` 路由（认可方案建案卷+按分节启发式拆军令、军令增/打卡/删、当日回填 upsert、本地案卷幂等导入），提取规则与原前端本地版一致（`services/casefile.ts`）；前端 `services/dossier.ts` 切 API（mock 模式沿用本地 storage 实现），页面接口异步化（执行页打卡乐观更新），老用户本地案卷首次拉取自动迁移；9 条集成测试覆盖提取/累积/打卡/回填 upsert/跨用户隔离/幂等导入。②**禁用词检查（PR-0a）**——`services/bannedWords.ts`（赋能/抓手/底层逻辑/颗粒度/范式转移），挂 gateway `traced()` 成功路径（所有 provider 的 chat/deliverable 输出恰好经过一次），命中写 `ai.banned_words` 审计、绝不拦截。③**V6.0 prompt 版本管理（PR-5a，完成）**——`data/agents.ts` 从 `server/prompts/strat.v6.md` 加载 strat 全文（缺失回退占位）；全文已从生产库只读取回入库（41711 字节/16168 字符，与 Notion 原稿差异：品牌「军师参谋部」+ 结尾结构化输出约束），仓库初始化即 V6.0，重取命令见 prompts/README.md。④**V6 专项评测集（PR-0b）**——seed 新增「V6.0 防呆与语气」4 用例（缺时辰/不信命理/禁用词与语气/排盘纪律），评测台可跑真实模型打分。服务端 275/275 测试 ✓，双端 tsc/构建 ✓。影响面：server schema+routes+services+seed+gateway、app dossier 服务与 home/studio/chat 页、AGENTS/CHANGELOG。
- **2026-07-02** · **5-tab 界面按设计稿全面还原（junshi-miniapp-effect.html）**：主色体系对齐设计稿——默认本命色改为墨绿（`data/colors.ts` 墨绿置首、`store` 默认 `green`、mock 用户与服务端 `benmingColor` 默认 `green`，`schema.prisma` 默认值同步；存量用户保留已存颜色），`app.scss`/`app.h5.scss` 新增固定角色色 token（`--green/--green-hero/--green-soft/--gold-deep/--gold-soft/--blue`，绿=判断/行动、金=军令/权益、红=风险，不随本命色切换）。底栏从悬浮胶囊改为设计稿平铺 5-tab（纸底+顶部发丝线+选中变色）。对话页：大标题头（对话+副题）+ 白底搜索 pill + 快捷卡补齐 6 张（+转成军令/今日执行）+ 通栏半透明线程列表（金色花名、两行摘要）。战局页：重排为 居中页头（案卷/刷新）→深绿军师判断 hero→metric 信号 3 卡→三势 force 卡→下一步动作 battle-goal→关联模块 linkmod（金 pill+tier 徽章）→现在不能做→今日献策（页尾保留）→绿渐变 CTA。执行页：exec-nav + 横滑战役卡组（今日战役深绿卡/军师献策三步/今日主令/提醒节奏）+ 督战紧凑行 + today-focus 深绿条 + 目标阶梯 4 格 + 软底 seg + 金边 command-card + task 打卡卡 + 软底数据回填。智库页：页头（上传/智库/市场）+ seg（案卷资产/数据源/能力/报告）+ 绿调上传区 + 状态格 + 资料树（真实 docs+分类框架）+ 暖金军师提示补充 + 数据源单卡行 + 能力分组行（chips+免费/深度/模块）+ 报告行。我的页：居中「我的军师系统」+ 深绿用户卡 + 统计/额度 3+3 卡 + 设计稿菜单 + 军师社群暖金卡 + 深度能力绿卡（企业版并入菜单行）。修复：H5 token 兼容层同步新变量（否则深绿 hero 失效）、home 导入顺序消除 CSS chunk 告警、`.claude/launch.json` autoPort。weapp/H5 编译通过 + tsc 0 错，H5 五 tab 截图逐页核对。影响面：app 五个 tab 页 + 全局 token/底栏 + server 默认色 + AGENTS/PRODUCT/CHANGELOG。
- **2026-07-02** · **修复小程序 common chunk CSS 顺序告警**：`pages/brief` 与 `pages/settings` 统一为先导入 `Icon`、再导入 `SafeHeader`，消除与 chat/work 分包页面相反的样式模块顺序；AGENTS §7.2 补充组件样式导入顺序约束。影响面：app 非 Tab 页导入顺序 + 工程文档。
- **2026-07-02** · **交互回归设计稿（消除偏差项）**：战局页军师判断卡改为纯展示深色卡（移除输入框与 chips，点按整卡进总军师对话；对话入口统一在首位 tab），关联模块行改显示负责军师；智库页 seg 分区上移置顶，「方法底座」并入模块分区改称「已启用 Skill · 方法底座」；我的页钻石卡新增真实本月产出额度行（tokenQuota 已用百分比/不限量），菜单新增「提醒与日历」（即将开放）。AGENTS §7.2 首屏层级约束同步改写为战局页口径。weapp/H5 编译通过 + tsc 0 错。影响面：home/thinktank/profile + AGENTS。
- **2026-07-02** · **5-tab 设计功能还原（前端先行）+ 执行闭环本地跑通**：新增 `app/src/services/dossier.ts`（本地战略案卷：认可方案→按分节启发式提取军令/风险锁→打卡→线索/咨询/成交回填→复盘 prompt，storage 按用户隔离，不预置业务结论）。chat：「认可方案」同时存方案库并生成案卷军令、council 导轨新增「转成军令」（取本轮最新成果）。执行页重写为军令台：今日战役卡（完成度进度条）+ 执行信号 + 总军师督战条 + 目标阶梯引导 + 今日军令打卡（手动添加/长按删）+ 数据回填表单 + 复盘前检查（真实状态）+ 周计划（近 7 天军令记录）+ 复盘视图（带真实数据发给经营参谋）+ 保留 AI 创作发布。战局页：新增当前案卷行、「现在不能做」风险锁（来自认可方案，无则隐藏）、信号对齐设计（案卷完整度=档案成熟度/待补资料/风险锁）、CTA 按案卷状态动态。智库资料区新增「军师提示补充」（真实 nextQuestions）；我的页新增 案卷/报告/方案 真实统计行。顺手清理：home goal 行重复分支、删除未引用的旧雪碧图头像（imagegen 版为唯一来源）。gap 清单（执行闭环服务端化/订阅提醒/数据源授权/模块状态/知识分类/军师协同引擎/三势结构化/目标阶梯/社群分班/跨域搜索）整理进 AGENTS §13。weapp/H5 编译通过 + tsc 0 错，weapp dist 1.3M。影响面：app 五个 tab 页 + chat + dossier 服务 + AGENTS/CHANGELOG。
- **2026-07-02** · **内置军师头像改为 imagegen 谋略人物系列**：新增 `app/src/assets/avatars/generated/*-imagegen.jpg` 六张 376px 商务漫画头像（general 诸葛亮意象、strat 鬼谷子意象、growth 姜子牙意象、ip 文曲星意象、ops 刘伯温意象、org 张良意象），`AdvisorAvatar` 改为引用新资产；旧 `src/assets/avatars/*.jpg` 保留为未引用备份。影响面：app 头像资产 + AdvisorAvatar + AGENTS。
- **2026-07-02** · **对话页拟人化改版（对齐设计稿「军师消息」样式）**：`pages/sessions` 重写为微信式消息列表——顶栏（历史/军师消息/＋新对话）、搜索框（客户端过滤军师与会话）、快捷补给横滑卡（知识库/数据源/模块市场/报告库）、总军师置顶（在线点）+ 常驻军师线程 + 「专业参谋」分组，行内容为拟人立绘 + 名号 + 花名 + 真实最近会话摘要；「历史」切换最近会话视图（保留长按删除）。新增 `components/AdvisorAvatar`（圆形立绘 + 白描边 + 在线点）与 `src/assets/avatars/*.jpg`（6 张 188px 立绘共 ≈136KB，从设计稿选定的 qimen-variant-bc-vivid-color 雪碧图按设计 CSS 坐标裁切；general/strat/growth/ip/ops/org 显式映射，其余就近复用）；`data/council.ts` 新增 `ADVISOR_ALIAS` 花名（玄衡/观澜/青衍/鸣璋/照微/云枢…）。chat 页头部改为 立绘+名号+花名+职责，问候/回复/成果/思考气泡的 who 行统一换成立绘头像。主包 dist 1.1M（<2M）。weapp/H5 编译通过 + tsc 0 错。影响面：sessions/chat 页 + 新组件与资产 + council 数据 + AGENTS。
- **2026-07-02** · **底部导航按设计稿重排**：底栏顺序改为 对话·战局·执行·智库·我的（对话居首=第一入口），并按设计稿改为五个平铺 tab、移除中间凸起「对话」圆形按钮（`custom-tab-bar` 删除 `tab-center/center-btn` 分支与样式）；`app.config.ts` tabBar list 同序，五个 tab 页 `setTab` 索引改为 0..4 对应新顺序（对话0/战局1/执行2/智库3/我的4）；启动页仍为 `pages/home`（登录门/建档弹层不动）。weapp/H5 编译通过 + tsc 0 错。影响面：custom-tab-bar + app.config + 五个 tab 页 + AGENTS。
- **2026-07-01** · **小程序 5-tab 重构（对齐 ai-pilot-temp 设计包的功能与动线，视觉沿用现有设计系统）**：tab 改为 战局(`home`)/执行(`studio`)/对话(`sessions`)/智库(`thinktank`)/我的(`profile`)，底栏中间「对话」改为切到军师参谋室。战局页以真实 `me.understanding` 渲染军师判断/待补线索/下一步动作，并提供三势判断方法入口；执行页承接案卷（真实 `projects`）+ 第 0 号军令 + 一日节奏 + AI 创作发布（原「智能体」tab 的 creative 网格与解锁权益保留于此）；对话页改造为参谋室（总军师置顶 + 专业军师线程真实会话摘要 + 快速诊断）；智库页改为分区工作台（资料=真实 `knowledgeDocs`、数据=数据源目录、模块=模块/Skill 市场、报告=真实版本化报告+方案库）。chat 页新增参谋室协同导轨（总军师派单/专业军师回主线/补上下文引导）与成果卡「认可方案→存方案库→去执行」。新增分包页 `packages/work/{bindings,market,community}`（数据源绑定/模块+Skill 市场/军师社群，均为诚实引导态，不写死客户数据）与静态目录 `src/data/{operatingSystem,council}.ts`；「我的」页新增数据源/模块/社群入口；方案库空态改指参谋室。原智库 advisory 顾问目录合并进参谋室线程（解锁弹层保留）。构建：weapp/H5 编译通过 + app tsc 0 错。影响面：app 全部 tab 页 + chat + 分包 + app.config + custom-tab-bar + AGENTS/PRODUCT 文档。
- **2026-06-24** · **修复生产部署脚本 SHA 插值**：`scripts/deploy-prod.sh` 将日志与远端命令中的 `$SHA` 改为 `${SHA}`，避免中文标点紧贴变量名时在 `set -u` 下被解析成未绑定变量，恢复 server/admin 部署流程。影响面：生产部署脚本。
- **2026-06-24** · **切换微信小程序 AppID 上传配置**：`app/project.config.json` 切到 `wx810ebe6dfef8e75f`；小程序上传/预览脚本默认读取项目配置里的 AppID，不再硬编码旧值；`server/.env.example` 与工程文档同步新的 AppID，上传私钥继续只通过本机 ignored key 文件传入。影响面：app 小程序项目配置 + 上传脚本 + server env 示例 + AGENTS。
- **2026-06-22** · **并发临界区加固**：权益点流水写入改为同用户 advisory lock 串行，新增 `reserveCredits/refundCredits/grantCredits` 支持图片/按张产出前预扣、异常退款与套餐赠送叠加；`/agents/:key/purchase` 在同一事务内完成扣费与开通，`applyPlanPurchase` 同事务更新套餐、钻石流水与 token 钱包，避免不同智能体并发购买双花和并发套餐发放丢充值。短信发放限频加同手机号场景锁，验证码消费改条件更新保证一次性；报告版本保存与智能体发布按资源加事务锁，避免并发版本号冲突；项目创建 slug 唯一键冲突自动重试、改名冲突返回 409。新增 `test/concurrency.test.ts` 覆盖购买、套餐发放、短信、报告版本和发布竞态，并收紧审计回归断言避免同秒日志排序误读。影响面：server credits/tokenQuota/purchase/sessions/agents/sms/reports/agentVersions/projects + tests + AGENTS。
- **2026-06-22** · **修复微信支付回调并发幂等**：`markPaidAndApply` 改为同一 `outTradeNo` 先拿 PostgreSQL 事务级 advisory lock，再读取/抢占/发放/写 `appliedAt`，避免 `status=paid && appliedAt=null` 窗口下并发成功回调重复入账；套餐权益发放与 token 额度授予支持复用当前 Prisma transaction client，避免 CI 并发回调下事务连接池饥饿；保留 `paid+appliedAt=null` 订单的后续回调恢复能力。AGENTS 同步购买/支付接口与 TODO 口径。影响面：server 微信支付/套餐发放服务 + 工程文档。
- **2026-06-21** · **关闭裸 IP 运营后台入口**：线上 Nginx 已将 `http://8.136.36.175/admin` 与 `/admin/` 改为 404，后台只保留 `https://wxapi.aibuzz.cn/admin/` 域名入口；`scripts/deploy-prod.sh` 公网 smoke 改为裸 IP 只验 `/api/health`、域名验 `/api/health` 与 `/admin/`，部署文档和 Nginx 模板同步裸 IP server 块约束。
- **2026-06-20** · **微信消息推送 URL 验签接口**：新增 `GET/POST /api/wechat/message`，按 `WECHAT_MESSAGE_TOKEN` 校验微信后台 `signature/timestamp/nonce`；GET 验签通过原样返回 `echostr`，POST 支持 XML 推送体并返回 `success`，为后续客服/订阅事件处理预留可信入口。`.env.example`、AGENTS/DEPLOYMENT 同步 Token 与公网 URL 说明，新增 `test/wechatMessage.test.ts`。
- **2026-06-20** · **时序知识图谱（Graphiti 式，P1 功能增强）**：新增 `GraphEntity/GraphRelation`（关系带 `validFrom/validTo/invalidatedAt` 时间窗）、`services/knowledgeGraph.ts`（实体去重、同主谓新事实软失效旧事实、`queryRelations` as-of 时序查询）、`gateway.extractGraphTriples`（真实模型抽三元组，mock 返回空）、`routes/graph.ts`（`POST /graph/extract`、`GET /graph/entities`、`GET /graph/relations?asOf=`）。新增 `test/knowledgeGraph.test.ts`（4 例）。
- **2026-06-20** · **@引用「记忆」候选分组（P1 功能增强）**：新增 `GET /memories`（tenant+user 隔离列本人长期记忆，可按项目/智能体/关键词过滤，权重优先）+ `routes/memories.ts`，供 @引用选择器单列「记忆」组（`resolveReferences` 早已支持 `kind:'memory'`）。SSOT 增 `MemoryCandidate`。
- **2026-06-20** · **运营只读看板（项目/报告）+ 报告重命名（P1 功能增强）**：新增 `GET /admin/projects`、`GET /admin/reports`（跨租户运营视图）；报告新增 `PATCH /reports/:id` 重命名（仅改展示名不动 slug，租户隔离）。SSOT 增 `AdminProjectItem/AdminReportItem`。（知识库看板与文档上传以 main 06-16 实现为准，本分支不再重复。）
- **2026-06-20** · **微信支付 v3 脚手架 + 幂等入账（P2 生产硬化）**：新增 `PaymentOrder` 状态机（created→paid→applied，`appliedAt` 幂等锚点）、`services/wechatPay.ts`（JSAPI 下单签名、回调 AEAD 解密、平台证书可选验签、`markPaidAndApply` 用 `updateMany where appliedAt:null` 原子抢占防并发双发）、`services/purchase.ts`（演示购买与回调共用发放）、`routes/pay.ts`（回调保留原文验签）。`/plans/:id/purchase` 改共享发放并在配齐支付后禁用（走 `POST /plans/:id/order`）。配齐 `WECHAT_PAY_*` 启用。新增 `test/wechatPay.test.ts`（4 例）。SSOT 增 `WechatOrderResult`。测试改 `--test-concurrency=1`。
- **2026-06-20** · **缓存抽象 + 可插拔内容审核（P2 生产硬化）**：新增 `services/cache.ts`（默认内存，配 `REDIS_URL`+可选依赖 `ioredis` 切 Redis，动态 import 失败回退内存）与 `services/moderation.ts`（provider 可选 `keyword`/`http`，`MODERATION_FAIL_OPEN` 控抖动策略）。`gateway.ts` 的内存缓存与内联关键词审核改调这两个服务，保留 main 的「启用技能不缓存」语义。`.env.example` 增 `REDIS_URL`/`MODERATION_*`；`optionalDependencies.ioredis`。
- **2026-06-20** · **用户登录态 JWT 化（P2 生产硬化）**：新增 `services/userToken.ts`（HS256，零依赖）。配 `APP_JWT_SECRET` 后 `/auth/*` 登录签发带 `sub/iat/exp` 的 JWT；`resolveUser`、审计 HTTP 钩子、`adminAuth` role 路径、`ownedKeysForHeader` 统一经 `verifyUserToken` 解析身份。未配密钥时回退历史 `token=userId`，`APP_JWT_REQUIRED=true` 强制只认 JWT。新增 `.env.example` 三个变量、单测 `test/userToken.test.ts`。
- **2026-06-20** · **存库密钥 AES-256-GCM 加密（P2 生产硬化）**：新增 `services/secretBox.ts`（AES-256-GCM，零依赖），对 模型/Dify/技能库 密钥写时加密、读时解密；密文带 `enc:v1:` 前缀，历史明文自动兼容；未配 `APP_ENCRYPTION_KEY` 时透传明文。接入 `aiConfig/context/skillTools/admin`；新增回填脚本 `npm run secrets:encrypt`、单测 `test/secretBox.test.ts`、`.env.example` 增 `APP_ENCRYPTION_KEY`。
- **2026-06-16** · **知识库重构为「上下文按用户」的文档管线 + 检索可观测（架构定调：自建，不改 Dify）**：基于信息架构（短期记忆=会话 / 长期记忆=用户×顾问 / 知识库=租户 RAG / 军师档案=实时合成）定两条决策——①上下文按**用户**隔离（记忆、军师档案不下沉到项目）②要支持**文档上传**。分四期（P1–P4）落地。影响面：server + shared + admin + app 全栈。
- **2026-06-16** · **P1 文档上传管线 + 知识检索改用户级**：`KnowledgeItem` 加 `status/fileName/fileType/fileSize/fileKey/error`(db push)；新增 `docParse.ts`（PDF=pdf-parse 2.x `PDFParse.getText` / Word=mammoth / Excel=xlsx / MD·TXT，重型库**按需动态 import**，`String.fromCharCode(0)` 剔 NUL 防 Postgres TEXT 拒存）、`ossUpload` 加 `ossPutBuffer`(私有 ACL)+`ossSignedUrl`(签名 URL 强制公网 host)+`ossDelete`；`knowledge.ingestUploadedFile`（原件→OSS→建 `parsing` item→**异步** `processDocument` 解析+切片+嵌入→`ready`/`failed`）、`reembedItem/getKnowledgeDetail/listKnowledgeDocs/knowledgePreviewUrl`，抽 `chunkAndEmbed` 入库+重嵌共用；`@fastify/multipart`(≤20MB) + 用户路由 `POST /knowledge/upload`、`GET /knowledge/docs`、`GET /knowledge/:id`、`POST /knowledge/:id/reembed`、`GET /knowledge/:id/preview`。**检索改用户级**：`hybridSearch` 由 `projectId` 硬过滤改 `userId` 过滤 + 当前项目仅 `+0.05` 加权（`vectorSearchChunks` 同步），`context.ts` 传 `userId`。`ossConfigured` 在 `NODE_ENV=test` 恒 false（不打真实 OSS）。契约加 `KnowledgeDocRow/KnowledgeDetail/KnowledgeChunkRow/KnowledgeUploadResult`。改 TC-R（同用户跨项目可召回）+ 加 TC-KB（上传→ready→可召回 / 不支持类型→failed）。影响面：server schema/docParse/ossUpload/knowledge/retrieval/vectorStore/context/app.ts/routes + contracts。
- **2026-06-16** · **P2 检索调试台**：`retrieval.hybridSearchDebug`（展开每候选 sem/kw/融合分 + rerank 前后名次，不做 TopK 收口）+ `retrievalDebug.ts`（聚合 embed/rerank 生效状态 + 候选 + `recallMemories` + `buildGenContext` 实际注入的知识/军师档案行）；`POST /admin/retrieval-test`。admin 新增「检索」tab：选用户 + 问题 → 看命中/分数/rerank/记忆召回/最终注入上下文，把「embedding/rerank 到底生效没」一把闭环。契约加 `AdminRetrievalDebug/RetrievalDebugCand`。影响面：server retrieval/retrievalDebug/admin.ts + contracts + admin App/api。
- **2026-06-16** · **P3 运营端「用户上下文中心」**：用户详情从「只有智能体开通」扩成上下文面板——**军师档案**（成熟度/四段/缺口，只读）+ **长期记忆**（按顾问、可删、记审计）+ **知识库**（文档状态/切片钻入/重嵌/删除/代上传）。新增 `adminUserContext.userContextView`、`memory.listUserMemories/deleteUserMemory`；`GET /admin/users/:id/context`、`DELETE …/memories/:mid`、`GET/DELETE …/knowledge/:kid`、`POST …/knowledge/:kid/reembed`、`POST …/knowledge/upload`（代上传）。契约加 `AdminUserContext/AdminUserMemory`；admin `api.uploadUserKnowledge`(FormData) + `.file-hidden`。lint:ui + tsc 绿。影响面：server adminUserContext/memory/knowledge/admin.ts + contracts + admin。
- **2026-06-16** · **P4 小程序「我的资料库」**：新增 `packages/work/knowledge` 页——上传文档（weapp `chooseMessageFile` + `Taro.uploadFile` multipart；H5 提示去小程序内传）、列表展示解析状态/切片数/大小、删除；`api.knowledgeDocs/knowledgeDetail/reembedKnowledge/uploadKnowledge`（`uploadKnowledgeFile` 走 Taro.uploadFile）；profile 加「我的资料库」入口、`app.config` 注册子包页。**待小程序发版**。影响面：app api/profile/app.config + 新增页。
- **2026-06-16** · **运营后台「知识库」视图 + 维度体检/一键重嵌**：新增 admin「知识库」tab——看用户知识库被切片/嵌入加工的状态（每项：归属租户、kind、切片数、嵌入维度），并做「维度体检」把之前**静默**的维度不匹配显式化（当前嵌入维度 vs 存量切片/记忆维度，不一致→标「旧维度·需重嵌」+ 待重嵌计数），配「重新嵌入存量」按钮。后端 `services/knowledgeAdmin.ts`（`knowledgeView` + `reembedAll`，与 `scripts/reembed.ts` 共用）、`GET /admin/knowledge` + `POST /admin/knowledge/reembed`（记审计）；`embedding.embeddingDim()` 探维度不记基建用量。契约加 `AdminKnowledgeView/AdminKnowledgeItemRow/ReembedResult`。影响面：新增 server knowledgeAdmin + admin.ts 路由 + embedding + contracts + admin App/api。
- **2026-06-16** · **嵌入/重排 token 消耗计量（与用户用量区分）**：`embed()`/`rerank()` 真实调用从响应取 `usage` token 数（rerank 不报时按字符粗估），经 `usage.recordInfraUsage` 落 `token_usage`(`kind=embedding|rerank`、无 user 归属、不扣额度)。`tokenUsageSummary` 把行按 kind 拆成「用户产出(chat/deliverable)→totals/byModel/byDay/topUsers」与「检索基建→infra[]」；契约加 `TokenUsageKindStat` + `AdminTokenUsageView.infra`；admin「Token 用量」看板单列「检索基建消耗」段(嵌入/重排 token+成本，未配单价则成本计 0)。加 Y4 测试。线上实测 embed→infra 记录、与用户 totals 分离。影响面：server embedding/rerank/usage + contracts + admin。
- **2026-06-16** · **存量数据重嵌 + 嵌入「真实生效」核查**：发现线上启用远程 `bge-m3`(1024维) 后，**存量知识库切片(5)+长期记忆(18)仍是开启前入库的 256维本地向量** → 查询1024维 vs 存量256维 → `cosine` 维度不匹配返回 0 → 向量召回**静默失效**（只剩关键词命中）。已用现跑 `embed()` 重嵌全部为 1024维（cosine(查询,同源切片)=0.871 验证召回恢复）。新增可复用脚本 `scripts/reembed.ts`(`npm run db:reembed`，知识库+记忆，pgvector 开启则双写)——**切换嵌入来源后必跑**。运行时 embedding/rerank 经 live 探针确认在真跑(embed→1024、rerank 重排)。影响面：新增 server scripts/reembed + package.json。
- **2026-06-16** · **修复模型切换 400（空 JSON body 被拒）**：上一条 `npm install`(装 ali-oss)把 `fastify` 从 5.1 升到 5.8.5，新版对「`Content-Type: application/json` 但 body 为空」严格抛 `FST_ERR_CTP_EMPTY_JSON_BODY`(400)；而 admin/app 的请求封装无条件带 json 头，无 body 的 POST（如 `activate`、新加的报告渲染接口）就 400。修复：`app.ts` 加自定义 `application/json` content-type parser，空体解析成 `{}`（非法 JSON 仍 400）。一处修复覆盖所有无 body 接口。加 `H3` 回归测试。线上实测空体 activate 由 400→200。影响面：server app.ts。
- **2026-06-16** · **OSS 改用 ali-oss SDK**：`ossUpload.ts` 从手写签名换成官方 `ali-oss`（更易维护/扩展：删除/签名URL/STS/图片产出存储），接口不变(`ossConfigured`/`ossPutHtml`)，对象 public-read，endpoint 优先(内网)。新增 `ali-oss` + `@types/ali-oss` 依赖——**prod 部署需 `npm install`，且 `node_modules` 属主须先 `chown -R junshi`（否则 EACCES）**。已部署并实测仍返回 OSS 公网链接、200。影响面：server package.json + ossUpload + env(`AEP_CDN_OSS_REGION`)。
- **2026-06-16** · **嵌入模型从「模型接入」表单移除（embedding 全局化收口）**：嵌入/重排是「检索增强」全局配置，但「添加/编辑模型」表单仍有 per-model `embeddingModel`，且 `aiConfig.syncActiveSetting` 切换对话模型时会把它(多为空)拷进 `ai_setting.embeddingModel` → **静默清空全局嵌入模型、embedding 退回本地**。修复：syncActiveSetting 不再同步 embeddingModel；admin 模型表单去掉该字段（改提示「在检索增强处统一配」）。影响面：server aiConfig + admin ModelView。
- **2026-06-16** · **检索增强「生效」状态可视化**：admin「检索增强」加状态徽标（嵌入 远程·model / 本地兜底；重排 远程·model / 未启用），并提示「配置可用≠每次成功，点测试增强项实地探活；失败静默回退本地」。影响面：admin ModelView。
- **2026-06-16** · **小程序成果卡「网页版」按钮（render_report 触发）**：`app` 成果卡新增「网页版」→ 调 `POST /sessions/:id/messages/:mid/report`（OSS 托管）→ 复制分享链接(setClipboardData)。`api.renderReport`、`Msg.messageId`(从 `GenResult.messageId` / 会话还原 `m.id` 带入)、ReportCard `onShare`。**待小程序发版**(weapp build+上传)。影响面：app api/chat/ReportCard。
- **2026-06-15** · **报告网页版托管到阿里云 OSS（不暴露后端域名）**：新增 `services/ossUpload.ts`（手写 OSS 签名 V1，用 `node:https` 而非 fetch——后者丢 `Date` forbidden header 致签名失败；无 SDK，对齐 sms.ts），对象 `public-read`。`publishReport` 配齐 `AEP_CDN_OSS_*`(env.ts) 即上传 OSS 返回公网静态链接 `https://<bucket>.oss-...aliyuncs.com/<prefix>/<id>.html`，否则回退 `/api/r/:id`；上传走内网 endpoint(免流量)、分享用公网 baseUrl；DB `report_html` 行保留。已部署 prod 并实测(返回纯 OSS 链接、公网 200)。影响面：server env/reportHtml + 新增 ossUpload。
- **2026-06-15** · **技能与「模型接入方式」解耦**：自建技能（工具调用）原本只在 per-agent 自定义 OpenAI 端点(`providerMode=openai`)下生效，跟随全局模型(inherit)的智能体会被 `resolveAgentRuntime` 丢弃 skillsConfig 且全局路径不跑工具循环。现 `GenContext` 增 `skills` 字段，`buildGenContext` 对**所有** agent 注入 `agent.skillsConfig`；`gateway` 全局 chat/deliverable 路径在 `live==='openai'` 且技能启用时改走 `openaiChatWithTools/openaiDeliverableWithTools`（工具产出绕过结果缓存），`resolveAgentTools(rt)`→`skillToolsFor(ctx)`；admin 智能体详情把「启用技能」区从 `openai` 块移到 `mode!=='dify'`（inherit/openai 均可配，dify 自带编排除外）。纯增量：未启用技能的现有 agent 行为不变。影响面：server schema/context/gateway + admin AgentDetailPanel。
- **2026-06-15** · **运营后台设计系统全面收口 + 强制约束**：修掉裸 `gh`（无全局规则→无样式原生控件）等组件误用，取消→`ai-btn ghost`、列表行动作→`mini-btn[.danger]`、测试连接→`ai-btn ghost auto`；新增 `--success` token 并把 CSS/TSX 里硬编码的成功绿/危险红/`#F3F1EA`/`#969BA1`/账户菜单与弹层遮罩等全部改走 `var()` 或组件类（新增 `.empty/.acct-menu/.modal-scrim/.usage-num.ok/.blk-d.ok/.err/.ai-btn.auto/.ai-preset.add`）。新增设计系统 linter `scripts/audit-admin-ui.mjs`（未定义 class / 内联硬编码色 / 一次性 inline 控件样式 / CSS 裸 token 色），接入 `admin` 的 `npm run build`（`lint:ui`）。规范写入 `admin/DESIGN.md「Engineering Compliance」`，并加入 `AGENTS.md` §0 强制指令 #9。影响面：admin 前端 + 文档 + CI 约束。
- **2026-06-15** · **Token 成本核算单价（内部审计）**：`AiModel` 增 `priceInput/priceOutput/priceCachedInput`（元/1M，SSOT + prisma db push），运营在「模型」表单填；`aiConfig.resolveModelRate` 只认配置单价、**没配则计 0 不回退**（删除内置价表 `MODEL_RATES/rateFor/DEFAULT_RATE`），`usage` 写库按单价算 `costMicros`，看板「成本」汇总、未配标「未配价」。影响面：schema/contracts/aiConfig/usage/modelPrices/admin。
- **2026-06-15** · **可插拔技能体系 + HTML 报告作为 output 技能**：技能带 `kind`（`tool` 模型调用 / `output` 产出后处理）；`tools/registry` 可插拔注册，`render_report` 为内置 output 技能（包 `reportHtml`）；网页报告改**按需生成**（`POST /sessions/:id/messages/:mid/report` 跑该 agent 的 output 技能），`selectableMeta` 统一吐 kind，admin 技能库按 kind 展示。影响面：server tools/skills/sessions + contracts + admin。
- **2026-06-15** · **网页报告服务端品牌化渲染**：`reportHtml.ts` 重写为「军师·战略参谋部」战略报告版式（封面格言/章节印章/落款印章/免责），数据契约不变。影响面：server reportHtml。
- **2026-06-15** · **固化生产部署为通用脚本**：新增 `scripts/deploy-prod.sh`，默认发布当前 git HEAD 到固定 ECS `ecs-user@8.136.36.175`，覆盖 `server + admin` 并可用 `DEPLOY_H5=1` 补发 H5；AGENTS §11 与 `docs/DEPLOYMENT.md` 运维段改为引用脚本入口与覆盖变量，明确 `/opt/junshi` 是上传包式部署、`.claude/worktrees` 是工作树副本，不再把远端 git 探测作为例行部署步骤。- **2026-06-15** · **统一技能库新增/编辑组件语汇**：运营端技能库「新增技能」入口改用后台统一 `add-btn full`，新增/编辑表单改用 `crd new-agent`、`ai-field`、`ai-btn` 组件组合，删除动作改用 `mini-btn danger`，去掉局部 `sv/gh` 与 inline button 样式，保持与智能体、套餐、模型配置页一致。- **2026-06-15** · **优化审计页移动端扫描与详情排查体验**：运营端审计页在窄屏下从横向宽表切换为紧凑事件流，单条日志按状态、接口/动作、时间、摘要、用户/IP 分区展示，避免手机端横向滚动和信息挤压；每条日志可点击打开详情面板，查看完整账号上下文、请求状态、IP/UA 与原始 payload；桌面端仍保留高密度表格。- **2026-06-15** · **审计页收敛为用户 API 单行列表**：`GET /admin/audit-logs` 默认过滤 `admin.*` 后台自身行为，保留用户 API、登录尝试和业务动作，显式 `includeAdmin=true` 才返回后台日志；运营端审计页由卡片明细改为紧凑单行表格，展示时间、状态、方法、接口/动作、用户、IP 与摘要，避免 payload 默认展开占用过多空间。- **2026-06-15** · **扩展审计为全量排查日志**：`services/audit.ts` 改为记录除健康检查外的所有 `/api/*` 请求，覆盖匿名、无效 token、登录、后台与用户行为，并写入方法、路径、状态码、耗时、IP、UA、鉴权状态和脱敏后的请求摘要；登录、短信、微信/本机号/运营商入口与后台账号登录/初始化/改密新增成功失败语义审计；`AdminAuditItem` 与运营端审计页增加摘要、状态徽标、路径、账号/租户、IP/UA 和更完整 payload 明细，便于后续定位登录失败、权限失败与异常请求。- **2026-06-15** · **优化首页首屏层级与底栏质感**：`pages/home` 将三张同构「推荐产出」卡收敛为单组「可以先做」列表，强化对话输入作为首页主行动，并避免静态入口伪装成个性化优先级；`custom-tab-bar` 降低玻璃装饰并补清晰选中态，减少首屏认知负担与模板感。AGENTS 同步记录首页层级约束。- **2026-06-14** · **配置短信验证码模板并补登录链路文档**：`server/.env.example` 将阿里云短信模板固定为 `SMS_508120103`；AGENTS/DEPLOYMENT/SMS_LOGIN/ROADMAP 同步短信验证码、本机号一键登录与 JWT 待生产化状态，后续线上部署需在服务端环境写入同一模板号。- **2026-06-14** · **拆分 AGENTS 变更日志**：新增 `docs/CHANGELOG.md` 承接历史变更日志，`AGENTS.md` 只保留维护约定与入口链接，减少后续 agent 初始加载上下文；§0/§14 同步改为要求在独立 changelog 顶部追加记录。
- **2026-06-14** · **沉淀常用调试/部署/实时预览指令**：§11 新增本地三端调试、小程序 mock/server 真机预览、`screen` 实时 watch、DevTools `auto-preview/preview`、服务器升级发布与微信小程序上传路径，后续 agent 可直接按 AGENTS 执行常用操作。
- **2026-06-13** · **新增小程序上传版本记录**：新增 `docs/WEAPP_RELEASES.md` 作为微信小程序上传版本 ledger；§11 上传约束改为引用该文件，要求上传命令版本号/描述与记录一致，AGENTS 不再承载每次上传明细。
- **2026-06-13** · **军师档案改为访谈式补全**：登录弹层「AI 起名」改为 spark 图标按钮；`pages/brief` 的补档案动作改为“让军师来问我”，进入对话时明确访谈模式；后端过滤 `用户123/企业123` 占位名，访谈请求跳过旧项目/知识库召回，模型 guard 改为自然追问，避免把内部约束说给用户或先分析旧报告。
- **2026-06-13** · **军师档案入口化**：将「经营底稿」更名为用户更易懂的「军师档案」；`pages/profile` 只保留菜单入口，不再在我的页首页平铺完整内容；新增 `pages/brief` 详情页展示完整档案与待补问题。
- **2026-06-13** · **新增注册花名与军师档案**：`GET /auth/suggest-name` 返回古典武侠/军事花名，登录弹层新增可选称呼输入与「AI 起名」，花名只写用户称呼不写公司；SSOT 新增 `ClientUnderstanding`，`/me` 返回「军师档案」，我的页只保留菜单入口，详情页展示经营身份/创业路径/当前难题/沉淀资料/待补问题；`buildGenContext` 将同一档案注入模型上下文，运行时 guard 明确禁止编造客户事实，资料不足先追问。
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
- **2026-07-22** · **修复旧命盘导致对话崩溃并收口技术异常展示**：`chartBriefing` 兼容 `paipan-v1` 快照缺少 v2 `tiaoHou` 字段，跳过不存在的调候段而非读取 `undefined.gods`；服务端同步/流式生成失败先记录用户、会话、智能体与原始堆栈，再下发友好提示；普通 HTTP 5xx 与流式 SSE `INTERNAL`/JavaScript 异常在前端继续兜底，原始错误仅保留在日志或 `technicalMessage`；新增旧命盘回归测试。影响面：server 排盘上下文/会话错误观测、app API/流式错误提示 + AGENTS/CHANGELOG。
- **2026-07-23** · **修复方案支付弹层无法滚动和缺少明确关闭入口**：方案 Sheet 改为明确 `92vh` 高度并限制溢出，标题、权益余额与右上圆形关闭按钮固定在顶部，仅套餐卡区域使用有确定高度的微信 `ScrollView` 滚动；移除列表末尾不可达的“关闭”文字。影响面：app Plans 弹层 + AGENTS/CHANGELOG。
- **2026-07-27** · **完成 V2 隔离压测并固化可复现实验链路**：在独立测试机完成 production 鉴权、Redis 限流、过载闸、同机 PostgreSQL 的只读阶梯测试；基础假数据下 T1 450 RPS 连续 5 分钟 0 错误，600 RPS 由过载闸快速 503，10 倍数据下 350/450 RPS 均越过 1% 错误护栏。新增匿名 IP 精确限流 k6 场景，验证单 IP 5/8 精确 429、多 IP 无连带以及审计保留原始 IP；真实 LLM 最小探针因 401 在零 usage 后停止，未得出并发结论。压测工具补齐动态 Compose 容器监控、PostgreSQL/Redis/API 进程/Prometheus 采样；`prepare.sh` 支持干净服务器复用隔离镜像签发 JWT；README 写明本机 k6 网络与 0600 token 挂载口径。测试后删除精确隔离卷并恢复测试机原服务。影响面：`loadtest/` 工具与运维文档、AGENTS；不改业务 API、数据模型或生产部署。
### 2026-08-08 · 修复军师追问「其他」答案无法定位光标和选字 · 影响面：原生微信对话问答卡

原生问答卡此前用普通文字展示答案，另用屏幕底部 `1px` 透明 input 接收键盘，用户看到的文字并不属于输入控件，因此无法点按定位光标、长按选择或修改中间字符。现改为卡片内可见的微信原生 input；打开时承接既有答案，输入过程中仅写 JS 草稿、不 `setData` 回灌 value，失焦或完成后再提交题目状态，兼顾系统文本编辑能力与华为/百度输入法稳定性。
### 2026-08-08 · 修复生成失败后重进会话丢失重试入口 · 影响面：原生微信对话恢复与失败反馈

持久生成建单时用户消息已经落库，但失败终态会清空会话的 active generation 且不会产生助手消息；原生页此前重进后只恢复消息并清空本地 `errorText`，形成“问题还在、回复没有、也没有下一步”的静默断点。现会话恢复与兼容轮询结束统一识别“服务端已停止生成 + 尾条仍为用户消息”，恢复说明和「重新回答」按钮；重试复用原文字与引用并保持 no-echo，不重复显示用户消息。失败反馈同时改为两行说明 + 清晰主动作，普通读取错误在没有可重试用户轮次时不再显示无效按钮。
### 2026-08-08 · 修复长问答卡唤起键盘后「其他」输入框滚出视野 · 影响面：原生微信对话问答卡键盘避让

问答卡此前在点「其他」、input 聚焦及键盘高度变化时调用会话级 `toBottom()`；卡片较长或当前题不在末尾时，ScrollView 会滚到整段会话最底部，正在编辑的 input 反而越过键盘上沿并消失。现每个其他回答 input 都有按消息与题号生成的稳定锚点，键盘使可视区缩小时只重定位当前 input；50ms 合并焦点与键盘的连续事件，关闭输入时清理锚点与定时器，不再滚动整张问答卡。
