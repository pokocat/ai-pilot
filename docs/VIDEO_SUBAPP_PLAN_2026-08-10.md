# 「快出片」视频子应用 · 技术方案（军师分包形态）

> **状态**：M1 工程、石榴 v0.119 官方单视频 Avatar 创建（`speakerId/authId` 均选填）、可选声音增强、阿里云多模态机审适配器与完整多段总装已落地；真实供应商链已具备本人真机验收条件。测试阶段允许隔离预发显式审核旁路，production 硬拒绝。本人素材质量实测、真实发布与生产合规门槛仍未完成。

> **当前预发**：军师服务 `b0c647d` / AIStar `83670b5e-20260811T144740Z`，两服务 active、`NRestarts=0`；requirements 为 `authorizationVideoRequired=false / avatarMin=5 / voiceMin=3`。麦克风权限热修真机包 `67f0fb1` 已 auto-preview。
> **创建**：2026-08-10
> **上游**：产品方案见 `AIStarEcosystem/docs/clip-avatar-video-plan.md`（549 行，本文不重复其内容，只记**因为改成军师分包而变化的部分**）。
> **设计稿**：`13屏原型与设计确认-handoff.zip` → `快出片 原型.dc.html`（13 屏，暖橙人文纪实）。

## 执行结果（2026-08-10）

- 端上只保留 `mock / bff` 两种数据源；删除会把军师 JWT 发往第三方域名的 `direct` 形态。报价条可本地即时反馈，但提交前必须取得服务端权威报价并原样回传，报价变化返回 409 且不扣积分、不建任务。
- 文案首步新增连续 AI 对话：模型结合模板、当前稿和最近消息追问或出稿，`scriptChat` 随项目持久化；生成输出会主动把碎句收成完整语义段。文案 `segments` 与视觉 `shots` 已分层，配画面支持圈选连续句范围共用同一素材，默认相邻 b-roll 每 3 句一镜；报价、preflight、worker 与总装均按 shot 聚合。
- 军师 BFF 已落地 `/api/video/**`、service-token 身份桥、`externalOwnerId` 隔离、SSRF/重定向防护、限流、文本审核，以及积分 `hold → settle/refund` 幂等状态机；同一请求并发只允许一个请求创建 AIStar 任务。
- AIStar 已落地独立 `clip_template / clip_project / clip_render_job / clip_asset` 域、OpenAPI、管理员模板与 preset 上传、30 天回收、数据库租约 worker 和 stale reaper。Scheme A 已定：AIStar 不扣用户钱包，只记录军师报价与供应商成本事实。
- 石榴官方 API v1 已接 speaker/avatar 训练、可选授权视频、V2 TTS、V2 音频驱动出片、状态轮询与删除；Train Avatar Model 的 `authId` 不再被误做必填。上游时效成片会立即转存我方持久存储。所有非尾段先生成同一 V2 speaker 音频，avatar 和 b-roll 共用该音频策略，不再混用文本直出的内嵌 TTS。
- 数字人创建主链按官方契约收成“一段视频 → Avatar 训练”：`speakerId` 只是制作 demo 的选填参数，未克隆声音时也必须立即调用 `/avatar/create`。AIStar 会 best-effort 从视频中提取原声创建基础 V2 speaker，任何提取/声音失败都不回滚形象；专门采集声音是独立增强。出片前仍需可用 speaker，视频原声不可用时提示用户补录，而不是把该限制前置成创建门槛。
- 采集 requirements 已按石榴官方硬门纠偏：授权/形象视频均为至少 5 秒，声音真实时长必须超过 2 秒（端上按整秒提示至少 3 秒）；8–15 秒声音与 10–20 秒形象仅作效果建议，不阻断提交。客户端前检时长/大小，BFF 验 MIME/大小，AIStar 以 ffprobe 验 H.264、360p–4K、音轨与真实时长。石榴支持的 24k 单声道 PCM 只列在供应商格式中，当前小程序产品上传不开放 PCM。授权 `authId` 仅表述为声明已受理，不冒充实名认证。
- 军师 BFF 已实现阿里云内容安全增强版图片/视频/语音审核：本地文件通过官方临时 OSS 凭证上传，图片同步判定，视频/语音轮询异步任务；只放行 `none/low`，`medium/high`、配置/权限/欠费、超时和异常返回全部 fail-closed。测试阶段隔离预发显式设置 `CLIP_MEDIA_MODERATION_BYPASS=true`，仍校验媒体类型并记录 `user.video.media.moderation.bypassed` 审计；production 启动硬拒绝该开关。待正确账号开通内容安全并授权专用身份后，再关闭旁路做本人素材验收。
- AIStar v0.113 预发已完成逐段 avatar/b-roll 标准化、真实 TTS 时长、H.264/AAC 多段总装、可选低音量 BGM、字幕与全程 AI 标识、三套模板各自的运行时固定品牌尾卡、最终音轨 -16 LUFS / -1.5 dBTP 归一、平均亮度/综合响度/真峰值失败关闭和作品缩略图。预发宿主 180 秒 720×1280 合成探针得到平均亮度 125.50、-16.05 LUFS、单音轨并通过解析；这只证明宿主编解码/滤镜链路，不替代本人授权真实长片压力验收。
- 预发采用同机隔离拓扑：军师 `junshi-api-preprod :4001` 通过独立 service token 回源 `aistareco-clip-preprod 127.0.0.1:8081`，公网仅暴露预发 BFF 和 `/clip_preprod/cdn|files/`，AIStar 生产未修改。
- v0.117 已部署军师 `f6cb58d` 与 AIStar `b5140a8a-20260811T132756Z`；两服务 active、`NRestarts=0`，AIStar 关闭 force-mock 并走真实石榴。AIStar 与公网军师 BFF 的 requirements 均返回形象硬门 5 秒/建议 10–20 秒、声音供应商硬门 2 秒/端上硬门 3 秒/建议 8–15 秒；自动化没有创建计费任务。AppID `wx810ebe6dfef8e75f` 已收到构建身份为 `native-weapp / server / https://wxapi.aibuzz.cn/api_preprod / f6cb58d` 的 auto-preview。
- 隔离预发公网验收已完成：素材上传 → 本人授权 → 声音/形象克隆 → 三套内置模板 → 文案/配画面 → 权威报价 → 军师积分预扣/结算 → AIStar worker → ffmpeg 总装/质检/封面 → 作品 → 抖音 mock 发布状态全部成功。样本成片 44.05 秒、720×1280、H.264/AAC，抽帧可见「测试演示」「AI 生成」和字幕；该次 force-mock 未调用石榴。随后以 server 模式指向预发完成 AppID `wx810ebe6dfef8e75f` 真机 auto-preview。
- 非生产 mock 可以闭环演示；纯 `api.isMock()` 会话使用 200 点演示额度，避免主应用默认无套餐的新 mock 账号在确认页被 0 余额挡住。隔离预发还可令 AIStar 显式 force-mock：保留真实石榴凭据但以确定性媒体走真实 ffmpeg/质检/存储链，产出永久带「测试演示」的可播放 MP4，不用状态假成功。附身 JWT / server 模式不使用演示额度。production 会同时拒绝媒体审核旁路和 AIStar force-mock。四平台真实代发仍保持 `CLIP_PUBLISH_NOT_CONFIGURED`。
- 端内新增 `catalog.js` 作为三套体验模板的唯一事实源；列表、详情、mock 建项目与重置脚本共用同一目录，每套模板都有独立文案和镜头结构。11 个页面的自定义导航已收成与微信胶囊同层，不再重复叠加 50px 标题栏。
- 外部上线门槛仍包括：军师小程序类目/重新提审与深度合成备案、阿里云内容安全开通和专用 RAM 调用身份、本人合规素材的音色/口型/质量/时延/规格/成本实测、7 项商务/授权决策、授权群像尾片或运营 preset、四平台真实发布接入与双端真机验收。自动化不得替用户创建真实 speaker/avatar/video；真机本人验收才允许消耗点数。

---

## 0. 一句话

上游方案主张**新建独立小程序 `apps/miniprogram-clip`**；本次决定**先做成军师的一个分包** `packages/video`，后端复用 aidrama 底座。这个改动牵动三件事：**登录与 tabBar 形态**、**后端跨系统接入**、**积分归属**。本文只解决这三件事，其余照上游方案执行。

---

## 1. 已落地的前端框架

```
app/weapp-native/packages/video/
├── host.js          宿主适配层 —— 与军师的唯一耦合点
├── config.js        后端模式开关（mock / bff）+ 仅用于即时反馈的估价参数
├── api.js           clip 域 API 客户端，两种模式下页面代码不变
├── catalog.js       包内模板 SSOT（列表元数据 + 每套独立项目种子）
├── mock.js          分包自带假数据（不写进主包 services/mock.js）
├── model.js         纯计算层：时长、报价、切换、preflight、进度映射
├── styles/tokens.scss  自包含设计令牌
└── 11 个页面 × 4 件套
```

注册在 `app/weapp-native/app.json` 的 `subPackages`，并加了 `pages/studio/index` → `packages/video` 的 `preloadRule`（从「点兵」tab 预下载，点入口时不等分包）。入口挂在点兵 tab 的「军师代笔 · 内容出品」区块，紧邻「我的作品库」。

### 1.1 页面与设计稿的对应

| 设计稿 | 分包页面 | 状态 |
|---|---|---|
| 01 登录 | — | **删除**，复用军师登录浮层 |
| 02 首页 | `home/` | 做实 |
| 03 模板详情 | `template/` | 做实 |
| 04 克隆向导 ①②③ | `clone/` | 声音克隆（录制/上传）→ 形象视频直传 → 云端训练；不另录授权视频 |
| 05 第 1 步 改文案 | `script/` | 做实；AI 改写/试听走桩接口 |
| 06 第 2 步 配画面 | `shots/` | **核心屏，做实** |
| 07 第 3 步 出片确认 | `confirm/` | 做实 |
| 08 正在出片 | `rendering/` | 做实（轮询 + 四阶段） |
| 09 成片详情 | `work/` | 做实；播放器待真实视频源，代发是桩 |
| 10 我的素材库 | `assets/` | 做实（含从配画面屏跳来的挑选态） |
| 11 我的作品 | `works/` | 做实（三段 + 空态 + 生成中轮询） |
| 12 我的 | `avatar/` | 只做分身管理；**积分部分不实现**，跳军师 credits 页 |

「做实」= 交互链路通、mock 态可完整走完；**所有服务端行为都是桩**。

### 1.2 三处必须做的形态转换

**① 登录页删除。** 分包不该有自己的登录。而且军师有整改结论：游客可浏览、手机号非必需。所以浏览类页面（首页、模板详情、作品列表）对游客开放，只有**出片、克隆、上传素材**这类落库+扣费动作才 `host.requireLogin()` 弹军师的登录浮层。

**② tabBar 没有了。** 分包不允许有自己的 tabBar（微信限制）。设计稿的三项底栏（首页/我的作品/我的）+ 中央凸起「开始制作」按钮全部作废，改为：快出片首页作为唯一入口页，作品/素材/分身三个入口做成首页底部的行卡片。

**③ 积分不重复实现。** 设计稿屏 12 含「积分钱包 + 充值套餐（30元/100积分…）」。军师已有 `packages/work/credits` 和 `plans` 两页，且**线上定价只以运营后台为准**——分包里再放一套充值 UI 必然对不上。分身管理页只留一个「我的积分与充值」跳转行。

### 1.3 抽离设计：`host.js` 是唯一耦合点

`packages/video/` 下**任何页面都不许直接 require 军师的 `services/*`**，全部经 `host.js`。这样抽成插件或独立小程序时只重写这一个文件：

| 插件形态的限制 | 散在页面里要改的处数 | 收进 host.js 后 |
|---|---|---|
| 插件 storage 与宿主隔离 | 每处草稿读写 | 1 个文件 |
| 插件只有 `wx.pluginLogin`，没有 `wx.login` | 每处取登录态 | 同上 |
| 插件内路由要 `plugin://` 前缀 | 每处跳转 | 同上 |

样式同理：`styles/tokens.scss` 自包含，**不 `@use` 军师的 `src/app.scss`**。这一点尤其重要——军师现有 50 个原生 scss 里有 39 个反向依赖 `app/src/` 的 Taro 时代样式（详见 `docs/H5_REMOVAL_TODO_2026-08-10.md` §2.4），那是笔历史债，新分包不加入。

---

## 2. 后端接入（本方案的核心决策）

### 2.1 问题

军师和 aidrama 是两套完全独立的后端：

| | 军师（ai-pilot） | aidrama（AIStarEcosystem） |
|---|---|---|
| 技术栈 | Node / Fastify | Java / Spring Boot |
| 地址 | `https://wxapi.aibuzz.cn/api` | 另一个域名 |
| 鉴权头 | `x-user-id: <JWT>` | `Authorization: Bearer <JWT>` |
| 用户表 | 军师自己的 | AIStarEcosystem 自己的 |
| 积分 | 军师 credits | `CreditService` |

小程序里的用户是**军师用户**。而要复用的 ffmpeg 总装、mixcut 渲染、素材 preset、CreditService 这一坨能力都在 aidrama 侧。所以必须解决身份桥接。

### 2.2 三个方案

**方案 A · 军师 BFF 代理（已采用）**

```
分包 ──x-user-id──> 军师 server /api/video/*  ──service token──> aidrama /api/me/clip/*
                         │
                         └── 军师自己的 credits 扣费、OSS、moderation
```

- 小程序**不用加合法域名**（还是打 wxapi.aibuzz.cn）
- 鉴权不用换票：军师 server 认自己的 token，转发时用服务账号身份调 aidrama
- **积分统一在军师侧**——用户在军师充值，视频出片扣军师积分，aidrama 侧走内部结算或不计费
- 当前 M1 为了先把媒体审核闸收在一处，上传经军师 BFF 代理到 AIStar；军师将 multipart 总上限提高到 100MB，但视频路由单独限流且在读取大文件前检查审核 provider。后续若改成 OSS/CDN 签名直传直取，必须把对应域名加入微信 `uploadFile / downloadFile` 合法域名，并把审核前置/回调做成同等强度，不能继续宣称“不用加合法域名”。

**方案 B · 分包直连 aidrama**

- 要在小程序后台加 request / uploadFile / downloadFile 合法域名（配置项，不需重新过审）
- aidrama 要新增「军师 token 换 aidrama token」端点
- 两套积分要对账 —— 这是最难的部分，用户看到的余额到底是谁的
- 好处：视频流量不过军师，链路短

**方案 C · 在军师 Node 侧重写 clip 域**

排除。上游方案 §5.1 列的可复用能力里，`MixcutRenderingService` 一个文件就 1925 行（交错 concat、裁剪、缩放、BGM 混音、overlay、FilterCaps 逐项降级），`FfmpegRunner` 有 18 个 filter 的三阶段探测。Node 侧重写既不现实也没必要——用户明确说「后台用现成的 aidrama 底座」。

### 2.3 已采用 A，理由

积分。用户是在军师里充的值，看到的是军师的余额；如果出片扣的是另一套账，对账和客服都会失控。方案 A 让积分只有一本账。

`config.js` 只保留 `mock / bff`：用户 JWT 永远只到军师服务端，AIStar 只接受固定 service token 与显式外部属主。`direct` 已删除，避免未来一次配置切换就把军师凭证发往第三方域名。

### 2.4 军师 server 要新增的

```
server/src/routes/video.ts        BFF 转发层 + 军师侧积分 hold/commit/release
server/src/services/video/
  ├── aidramaGateway.ts           调 aidrama 的 HTTP 客户端（照 llm/tools/httpTool 的 SSRF 防护）
  ├── credits.ts                  与军师 credits 打通
  └── moderation.ts               b-roll 素材机审（军师已有 moderation.ts）
```

---

## 3. aidrama 侧要新建的 clip 域

**已落地独立领域**：`packages/types/src/clip.ts` 与 Java `clip` 包是本线真源；`packages/types/src/clip-studio.ts` 仍是另一个 MCN 真人切片台，不能混用。四张表通过 `V14__add_clip_domain.sql` 建立，并以 `externalOwnerId` 做军师用户隔离。

数据模型、API 端点、枚举、错误码、Gateway 抽象全部照上游方案 §6 / §7 执行，本文不重复。只补两条因分包形态产生的差异：

1. **`ownerUserId` 是 aidrama 的用户 id 还是军师的？** 走方案 A 时 aidrama 侧看到的是服务账号，真实属主是军师用户 —— clip 表要额外存一个 `externalOwnerId`（军师 userId）做属主隔离，否则所有军师用户的作品会混在一个 aidrama 账号下。**这是方案 A 最容易漏的一条。**
2. **计费双写**：aidrama 侧仍要记 `creative_job` 的真实成本（供成本核算），但**对用户的扣费在军师侧**。两边口径要在设计时就写清，别指望流水表事后对账。

---

## 4. 上游方案里必须照做的三条坑

这三条是上游方案从基座摸底里挖出来的，实现时容易原样踩进去：

1. **job 必须自带 stale reaper**（§11.7）。`DapJobRunner` 勤快写 `heartbeatAt` 但**全仓没有任何 `@Scheduled` 扫它**——进程在 job running 中被 kill，该 job 永远停在 `running`，冻结积分既不 commit 也不 release，且 `retry` 只接受 `failed`，用户无法自救。clip 的 job 要么自带 reaper，要么走 `MaterialVideoWorker` 模式。
2. **preset 素材链不完整**（§11.9）。`MixcutPresetSeeder` 引用的 `resources/preset-stickers/` 目录不存在，`uploadPreset` / `registerPresetRow` 没有任何 controller 调用方。clip 若复用 preset 机制做「通用垫底素材」，必须先补 admin 上传路由。
3. **代发平台边界**（§11.11）。真正可发只有抖音/快手/小红书/视频号，其余 501。短信二次验证只有抖音接了真 selector。**产品文案不要承诺「全平台一键发布」**——`work/index.js` 里我已经把平台列表写死成这四个并加了注释。

---

## 5. 分包相对军师主包的新增能力面

这些 API 中，军师既有代码已使用 `wx.chooseMedia` 的**图片模式**；本线真正新增且必须在 iOS/Android 各验一次的是 video 模式、录音和保存视频：

| API | 用在哪 | 风险 |
|---|---|---|
| `wx.chooseMedia`（video） | 配画面选素材、形象采集 | 先做能力检测并回退 `wx.chooseVideo`；两端返回结构有差异，取消要静默 |
| `wx.uploadFile` | b-roll 上传 | 已有 `services/request.js` 的 upload 封装可复用 |
| `wx.getRecorderManager` | 声音采集 | 需录音权限；后台切换会中断 |
| `wx.saveVideoToPhotosAlbum` | 保存成片 | 需 `scope.writePhotosAlbum`；拒绝过一次只能引导 `wx.openSetting` |
| `<video>` 组件 | 成片播放 | 小程序里 video 是原生组件，层级最高，会盖住普通 view |

另外照 `apps/miniprogram/agent.md` 的坑库，已经在代码里规避的：`position:sticky` 在 scroll-view 里失效（价格条放在 scroll-view 外，靠 flex 占位）、WXSS 不支持 `aspect-ratio`（9:16 用 padding-bottom hack）、轮询必须在 `onUnload`/`onHide` clearInterval。

---

## 6. 分期

沿用上游方案 §10 的 M0–M3，只改 M1 的端：

| 阶段 | 内容 | 出口判据 |
|---|---|---|
| **M0 · POC** | `ShiliuGateway`/Mock 已建；仍需测试 key 实测 §3.2 全部 10 项、A/B 策略定稿和 ffmpeg 配方本地跑通 | **外部阻塞**：五项达标 → go |
| **M1 · MVP** | 分包、aidrama clip 域与军师 BFF 骨架已落地；克隆、真实总装、CDN 与机审尚未接真 | **未达出口**：真链从模板到成片 < 5 分钟 |
| **M2** | 模板库扩展；代发四平台；保存相册 | — |
| **M3** | 模板市场化；b-roll 智能校验；数字人画中画 | — |

mock 态可做确定性回归，但不能作为 M0/M1 出口；真实供应商与合规闸通过后还必须做微信 DevTools、iOS、Android 真机验收。

---

## 7. 合规（上线前置，不可省）

照上游方案 §9 执行。分包形态下额外注意两条：

1. **深度合成算法备案绑的是主体和 appid。** 做在军师分包里，意味着这套备案要挂在**军师这个小程序**上，且这块代码进包后可能连带影响军师的下次提审（军师现在是商业咨询类目，加数字人口播是新的服务类目）。这是「放进军师」相对「独立小程序」多出来的风险，也是当初上游方案主张独立小程序的原因之一。
2. **AI 生成标识**已在代码里落地：`work/index.wxml` 的播放器角标、`confirm/index.wxml` 的首帧角标、`styles/tokens.scss` 的 `.vd-ai-badge`。成片内的水印/片尾说明由服务端渲染时加，**端上这层不算数**。

---

## 8. 待决问题

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | 后端接法 A / B（见 §2） | 决定服务端工作量与积分架构 | **已决：A**；军师扣积分，AIStar 不重复扣用户钱包 |
| 2 | 军师小程序加数字人口播，是否触发新服务类目与重新提审 | 可能卡住军师自身迭代 | **开工前先问一次微信侧** |
| 3 | 设计稿的数字不自洽 | 影响价格条可信度 | 见下 |
| 4 | 视觉基调：快出片的暖橙 vs 军师的墨绿米白 | 同一小程序内两套色系 | 已按移动生产力产品重构：轻暖灰 60% + 中性墨黑 30% + 暖橙/素材蓝 10%，模板主任务与 AI 对话层级已收紧；待真机体验反馈 |
| 5 | 上游方案 §12 的 7 个待决项（石榴商务条款、产品名、模板授权、克隆定价…） | — | 照上游走 |

**关于 #3**：设计稿屏 05 标「共 14 句 · 预计 2:42」，屏 07 标「出镜 38 秒 · 4 句 / 68 积分」。但 162 秒 ÷ 14 句 = 平均每句 11.6 秒，按中文口播 4 字/秒反推需要每句 46 字；而稿面实际展示的句子只有 15–25 字。**这组数字自身对不上。**

两种可能：真实模板的句子比稿面样例长得多（稿面做了截断），或者 4 字/秒的估算系数不对。这个直接影响「配画面」屏价格条的可信度——用户第一次看到的总价如果跟实际出片差一倍，这一屏的核心说服力就没了。**M0 拿到真实 TTS 时长后必须校准 `config.js` 的 `charsPerSecond`。**

当前 `catalog.js` 的三套脚本按真机可读密度编写，卡片上的 2:42 / 68 等数字仍是模板营销侧预估；制作过程中即时估价会按句子长度变化。两者在接入真实 TTS 前不应被宣称为最终扣费真值，真实提交仍以服务端权威报价为准。

---

## 9. 关键文件索引

| 主题 | 位置 |
|---|---|
| 宿主耦合层 | `app/weapp-native/packages/video/host.js` |
| 包内模板目录 | `app/weapp-native/packages/video/catalog.js` |
| 后端模式开关 | `app/weapp-native/packages/video/config.js` |
| 报价 / 时长 / preflight | `app/weapp-native/packages/video/model.js` |
| 核心屏（配画面） | `app/weapp-native/packages/video/shots/` |
| 分包注册 | `app/weapp-native/app.json` |
| 入口 | `app/weapp-native/pages/studio/index.wxml`（内容出品区块） |
| 上游产品方案 | `AIStarEcosystem/docs/clip-avatar-video-plan.md` |
| aidrama 小程序坑库（必读） | `AIStarEcosystem/apps/miniprogram/agent.md` |
| 军师样式历史债 | `docs/H5_REMOVAL_TODO_2026-08-10.md` §2.4 |
