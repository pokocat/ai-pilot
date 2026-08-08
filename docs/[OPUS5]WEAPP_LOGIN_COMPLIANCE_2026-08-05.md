# 小程序登录门整改方案（游客可浏览 · 手机号最小必要）

> 2026-08-05 · 依据《关于收集用户手机号码授权登录案例解析和整改建议》（微信开放社区知识库，2025-05-18 发布 / 2025-05-19 最后编辑）+ 平台运营规范公开条款梳理。
> 结论先说：**当前 5 个 tab 页全部「进入即弹全屏登录层」，且登录层没有任何取消/返回入口、同时隐藏了底栏**——这同时命中官方列举的违规情形 ①②③，属于必拒项，不是概率问题。

## 实施状态（2026-08-06）

- ✅ P0-1/2/3/4/5/6/7：登录可取消、六个页面取消入场强拦、五 Tab + 对话游客态、动作级理由、手机号可选、anonymous/authLost 分流、建档可退出均已落代码。
- ✅ C 端游客文案已做第二轮收口：页面不再反复写「不登录也能看 / 游客浏览 / 公开浏览」，个人区只呈现业务空态；发送、保存、购买等动作真正发生时，才由 `AuthReason` 解释登录目的。
- ✅ P1-1/3/4：匿名 `/modules`、公开 `/plans` 方案页、老板页账号与数据说明、运营附身入口迁入设置页均已完成。
- ✅ 协议业务口径：手机号、自动续费、信息收集、退款能力等已与当前代码对齐，正文 `【待确认】` 已清除。
- ⛔ P0-8 外部事实：经营主体全称、ICP、算法/生成式 AI 备案、注册地址、客服/隐私邮箱、管辖地仍缺权威输入；不得依据短信签名或公开关联公司猜填。
- ⛔ P0-9 平台配置：微信后台《用户隐私保护指引》须由有权限的运营主体核实、配置并提交。
- ⏭️ P1-2 游客速诊与 P2 足迹继承/半屏登录按本方案原定口径后置，已记录到 `AGENTS.md` §13；自由对话继续登录后使用，避免无匿名配额造成成本与滥用风险。

当前自动校验：app 类型检查与 85 例测试、server 全量 1280 例（含公开模块 9 例）全绿；app H5/server、小程序 server、server 与 admin 构建均通过。隔离 `junshi_test` 服务已在微信开发者工具逐页验证游客五 Tab、公开能力目录、公开套餐、对话输入保留和动作级登录理由，并将同一 server 包通过 auto-preview 推送到手机。最终提审前仍需补齐上述两类外部阻塞，并由真机验收人完成点击与录屏确认。

外部事实复核记录：仓库没有可直接采用的主体/备案证照；`aibuzz.cn` WHOIS 当前显示的域名注册人只能作为候选线索，不能证明其与小程序、支付商户、ICP/算法备案主体一致，因此未写入协议。Chrome 中虽存在已登录的小程序后台页面，但该站点受浏览器安全策略限制，当前会话未读取、未点击、未提交任何平台配置。

---

## 一、规范依据（附件 + 公开信息合并梳理）

### 1.1 附件官方指引的四类违规 + 三条建议

官方列举的**违规收集手机号行为**：

| # | 违规情形 | 官方原文要点 |
|---|---|---|
| ① | 一进入未浏览体验功能服务，即要求授权手机号码登录 | 含「打开即弹窗要求授权」「一进入即要求注册登录才能体验」 |
| ② | 用户浏览商品内容时，要求注册绑定才能查看详情 | 浏览内容不得以登录为前置 |
| ③ | 没有取消/拒绝按钮，强制用户进行授权登录 | 登录页必须能「取消登录」返回 |
| ④ | 体验范围给内部人群使用，首页没增加说明 | 内部专用类需首页说明 + 账号鉴权 |

官方给出的**三条整改建议**（即验收口径）：

1. 用户进入小程序，**应该提供用户体验浏览小程序内容功能**，不得在未体验任何功能页面时，即弹窗要求用户授权手机号码登录。
2. 仅限内部特定人群使用类小程序，应在首页增加账号说明并进行内部账号鉴权，用户了解页面功能再自主选择授权。
3. 用户浏览体验完功能服务后，自主选择授权手机号码登录时，**应当为用户提供取消/拒绝的返回选项**，不得强制要求用户登录无法返回。

> 附件评论区（206 条）的高频信号值得注意：**已上线项目改动无关模块后被反复驳回**是常态，有开发者「改了十几次」。这意味着整改不能做成"最小可过审"，要一次做干净——每次复审都可能重新走查登录门。

### 1.2 平台运营规范 / 组件文档的相关条款

- **常见拒绝情形 3.4.1**：收集用户数据须明示目的并取得用户明确同意；账号注销后须可删除数据。
- **常见拒绝情形 3.4.2**：不得在任何页面请求或诱导用户输入微信用户名/密码。
- **常见拒绝情形 3.4.5**：未经用户授权同意，不得显示用户头像、昵称等相关数据。
- **手机号快速验证组件官方文档**：组件**仅非个人主体、已完成认证**的小程序可用；并明确「开发者应合理使用，若被发现或用户举报**不合理地要求用户提供手机号**、中断正常使用流程、影响使用体验，微信有权依规范处理」。
- **最小必要原则**：用户**未触发**需使用权限或个人信息的功能/服务时，**不得提前弹窗**申请权限或收集个人信息。仅在核心功能路径（下单、注册、开票等）触发授权。
- **用户隐私保护指引**（2023-09 起强制）：调用受保护接口前须在后台声明并经用户同意。

---

## 二、现状诊断（代码级证据）

### 2.1 主因：登录门被写成「页面级前置」而非「动作级后置」

5 个 tab 页用同一个模式初始化，未登录进入即 `showLogin=true`：

| 页面 | 初始化 | `useDidShow` 再次强拉 |
|---|---|---|
| 问策 | [pages/sessions/index.tsx:61](app/src/pages/sessions/index.tsx:61) | [:105](app/src/pages/sessions/index.tsx:105) |
| 军情 | [pages/home/index.tsx:112](app/src/pages/home/index.tsx:112) | [:173](app/src/pages/home/index.tsx:173)（useEffect） |
| 军令 | [pages/studio/index.tsx:82](app/src/pages/studio/index.tsx:82) | [:127](app/src/pages/studio/index.tsx:127) |
| 锦囊 | [pages/thinktank/index.tsx:121](app/src/pages/thinktank/index.tsx:121) | [:176](app/src/pages/thinktank/index.tsx:176) |
| 老板 | [pages/profile/index.tsx:35](app/src/pages/profile/index.tsx:35) | [:50](app/src/pages/profile/index.tsx:50) |
| 对话 | [packages/main/chat/index.tsx:332](app/src/packages/main/chat/index.tsx:332) | [:652](app/src/packages/main/chat/index.tsx:652) |

启动页是 `pages/sessions`，所以**打开小程序第一帧就是全屏登录层**＝违规情形 ①。

### 2.2 登录层是死胡同：没有取消/返回，且底栏被藏

- [components/Login/index.tsx:356-393](app/src/components/Login/index.tsx:356) —— `wechat` 阶段只有「微信一键登录 / 手机号登录 / 同意勾选」，**没有 ✕、没有取消、没有"先看看"**。组件 Props 也没有 `onClose`（[:11-15](app/src/components/Login/index.tsx:11)）。
- [components/Login/index.tsx:54-61](app/src/components/Login/index.tsx:54) 打开即 `store.setOverlay(true,'login')` → [services/store.ts:207](app/src/services/store.ts:207) 写 storage 并 `syncTabBarHidden(true)` → [custom-tab-bar/index.tsx:50](app/src/custom-tab-bar/index.tsx:50) `if (s.overlay() || nativeHidden) return null`。

**底栏消失 + 登录层无出口 = 用户被完全锁死**，连换个 tab 看看都不行。这是违规情形 ③，也顺带让 ② 成立（所有内容都看不到）。

### 2.3 微信登录后仍强制绑定手机号

- [components/Login/index.tsx:103-115](app/src/components/Login/index.tsx:103) `afterAuthed()`：微信登录成功但没手机号 → 一律进 `bindphone` 阶段。
- `bindphone` 阶段（[:447-483](app/src/components/Login/index.tsx:447)）文案写着「也可稍后在『设置』中绑定」，**但界面上根本没有"跳过"按钮**——唯一出口是 [:480](app/src/components/Login/index.tsx:480) 的「退出登录」（`logoutEscape` 把人踢回登录页）。

文案承诺可跳过、实现却不可跳过，这是现存 bug，同时是 ③ 的第二处命中。

### 2.4 登录后还有第二道死胡同：建档仪式

[packages/main/onboarding/index.config.ts](app/src/packages/main/onboarding/index.config.ts) 注释写明「自绘导航，**不留系统返回**」，页面内 `SafeHeader left={<View />}`（[:166](app/src/packages/main/onboarding/index.tsx:166)）无返回键，三步（择色 → 填行业/阶段/痛点 → 首判）没有跳过。

审核员用测试号登进来会直接被关进建档流程——**即使登录门改好了，这里仍然会被判"强制收集个人信息"**。

### 2.5 附带发现（同属过审阻断项）

- **隐私政策/用户协议仍是占位符**：[packages/main/legal/index.tsx:13-21](app/src/packages/main/legal/index.tsx:13) 的 `ENTITY` / `ICP` / `AI_FILING` / `ADDRESS` / `SUPPORT_EMAIL` / `PRIVACY_EMAIL` / `JURISDICTION` / `EFFECTIVE` 全部是 `【填写：…】`。审核员一定会点开隐私政策——看到占位符即拒（对应 3.4.1 明示目的）。
- **无隐私保护指引对接**：全仓没有 `wx.requirePrivacyAuthorize` / `getPrivacySetting` / `onNeedPrivacyAuthorization` 调用。实际调用的受保护接口有：`getPhoneNumber`(实时验证) / `chooseAvatar` / `getUserProfile` / `chooseImage` / `chooseMessageFile` / `saveImageToPhotosAlbum` / `setClipboardData` / `requestSubscribeMessage`。这些都需在后台《用户隐私保护指引》中声明。
- **401 全局处理器会误伤游客**：[services/store.ts:112](app/src/services/store.ts:112) `setAuthLostHandler` 无条件触发 → [:78-94](app/src/services/store.ts:78) 弹「登录态已失效，请重新登录」+ `reLaunch`。放开游客浏览后，游客碰到任何鉴权接口都会看到这句莫名其妙的提示并被弹回首页。**必须先区分「从未登录(anonymous)」与「登录态失效(authLost)」**，否则游客态一放开就到处炸。
- **运营后门暴露在登录首屏**：[components/Login/index.tsx:367](app/src/components/Login/index.tsx:367) 长按 slogan 首字「谋」呼出 `ImpersonateSheet`（附身注入）。它需要令牌、风险不高，但不该挂在游客能长按到的落地首屏上。

### 2.6 服务端可用的公开数据面（好消息）

游客态不需要造假数据，已有真实公开接口：

| 接口 | 鉴权 | 位置 |
|---|---|---|
| `GET /agents`、`GET /agents/:key` | **公开**（带 token 才回填 `owned`） | [server/src/routes/agents.ts:13](server/src/routes/agents.ts:13) |
| `GET /sayings/today` | **公开** | [server/src/routes/sayings.ts:9](server/src/routes/sayings.ts:9) |
| `GET /plans` | **可选鉴权**（`resolveUserOptional`） | [server/src/routes/plans.ts:82](server/src/routes/plans.ts:82) |
| `GET /skus` | **公开** | [server/src/routes/sku.ts:16](server/src/routes/sku.ts:16) |
| `GET /modules`（能力目录） | 需登录 ← **需改可选鉴权** | [server/src/routes/modules.ts:12](server/src/routes/modules.ts:12) |
| `POST /quickscan`（3 问速诊） | 需登录 ← **候选放开** | [server/src/routes/quickscan.ts:38](server/src/routes/quickscan.ts:38) |
| `GET /plans/options` | 需登录 ← 套餐页依赖它 | [server/src/routes/plans.ts:90](server/src/routes/plans.ts:90) |

对话页也**已经有游客骨架**：`primeGuestThread()`（[packages/main/chat/index.tsx:616](app/src/packages/main/chat/index.tsx:616)）会渲染军师立绘 + 开场白，`doSend` 也已在发送时才拦（[:1130](app/src/packages/main/chat/index.tsx:1130)）。只是被 `showLogin` 初始 true 盖住了。

> **原则：游客态只展示真实公共内容 + 业务空态，不编造示例业务数据，也不反复解释「游客可浏览」。** 个人数据区只写当前业务状态；用户真正触发发送、保存、购买等动作时，再由可关闭的登录层说明目的。

---

## 三、目标态：三层门禁模型

把一个"全有或全无"的登录门，拆成三级：

| 级别 | 门槛 | 覆盖内容 | 触发时机 |
|---|---|---|---|
| **L0 游客** | 无 | 军师目录与人设、开场白、每日一句、能力/锦囊目录、套餐与价格、协议/隐私/关于/客服、功能说明与空态 | 默认 |
| **L1 登录**（微信 openid，**不含手机号**） | `wx.login` | 发起对话、上传资料、生成方案、军令与复盘、个人档案、作品库 | 用户点击该动作时 |
| **L2 手机号** | 快速验证组件 或 短信 | 支付开票、人工客服、账号找回/换端 | 仅这些场景，且始终可跳过 |

配套三条铁律：

1. **任何页面进入都不得自动弹登录层**；登录层只能由用户动作触发。
2. **登录层必须可关闭**（✕ + 点遮罩），关闭后回到刚才的游客页面，不改路由、不清状态。
3. **手机号永不作为进入门槛**；微信登录（openid）即完整身份。

---

## 四、实施方案

### P0 — 过审阻断项（必须全做，缺一项即可能再驳）

#### P0-1 登录层改为可取消（`components/Login`）

```ts
interface Props {
  open: boolean;
  reason?: string;                 // 为什么此刻需要登录，写在标题下（明示目的，对齐 3.4.1）
  onClose?: () => void;            // 合规必需
  onLoggedIn: (onboarded: boolean) => void;
}
```

- `wechat` / `phone` 两个阶段右上角加 ✕（`onClose`），底部加弱化文案「先随便看看」。
- 点遮罩空白区可关闭。
- `onClose` 只 `setShowLogin(false)`，**不动路由、不清 token、不 reLaunch**。
- 保留现有"必须主动勾选同意协议"的设计（`ensureAgreed`，[:88](app/src/components/Login/index.tsx:88)）——这一块本来就是对的，别动。

#### P0-2 删除 5 个 tab 页 + 对话页的入场强拦

逐页删掉 `useState(() => !s.isAuthed())` 与 `useDidShow`/`useEffect` 里的 `setShowLogin(true)`，改为 `useState(false)`；数据加载保持现有 `if (!s.isAuthed())` 早退，转而渲染游客态。

已经写好登录态判断的页面（军情/问策）改动很小——它们的 `maturityLabel`、`hydrated`、`loadBadges` 都已经 guard 过未登录。

#### P0-3 每个 tab 的游客态（真实公共内容 + 空态）

| Tab | 游客可见（真实数据） | 空态区（说明 + CTA） |
|---|---|---|
| **问策** | 军师目录（`/agents` 公开）、花名与职责、快捷补给卡、搜索框 | 「最近会话」→「登录后可查看你与军师的会话记录」 |
| **军情** | 每日一句（`/sayings/today` 公开）、三势/指标区骨架说明 | 「登录并建档后，这里出你的经营战局判断」；指标格保持 `—`（已实现） |
| **军令** | 军令台的机制说明（军令 → 回填 → 复盘闭环） | 「登录后生成今天该做的事」 |
| **锦囊** | **能力/模块目录**（放开 `/modules`）、套餐与价格（`/plans`+`/skus`） | 资料/数据源/报告三段各自空态 |
| **老板** | 设置、用户协议、隐私政策、关于、客服、套餐介绍 | 顶部改「未登录 · 点此登录」，权益格显 `—` |
| **对话** | 军师立绘 + 开场白（`primeGuestThread` 已有），输入框可聚焦可打字 | 点发送才 `requireAuth('chat')` |

新增一个共用组件 `components/GuestNotice`（图标 + 一句说明 + 「登录」按钮），全站空态复用，保证文案与视觉一致。

#### P0-4 动作级登录门（`services/authGate.ts`）

```ts
export type AuthReason = 'chat' | 'upload' | 'save' | 'order' | 'profile' | 'exec';
// 每个 reason 一句明示目的的文案，透传给 <Login reason>
export function authReasonText(r: AuthReason): string;
```

各页把现有 `requireLogin()` 统一成 `requireAuth(reason)`：未登录 → 打开可关闭的登录层并带上原因，返回 `false`。已有实现（[pages/sessions/index.tsx:146](app/src/pages/sessions/index.tsx:146)、[pages/home/index.tsx:185](app/src/pages/home/index.tsx:185)）语义已对，只需补 `reason` 与可关闭。

#### P0-5 手机号降级为可选（去掉强制绑定）

- [components/Login/index.tsx:103-115](app/src/components/Login/index.tsx:103) `afterAuthed()`：**删掉「无手机号 → bindphone」分支**。微信登录（openid）即完成登录。
- `bindphone` 阶段保留，但只在**用户主动**从「设置」进入、或 L2 场景（支付开票/人工客服）时使用，且必须有「暂不绑定」按钮（兑现 [:452](app/src/components/Login/index.tsx:452) 已写的文案承诺）。
- `phone` 阶段的「微信一键登录」（`getRealtimePhoneNumber`）**保留但不作为首选**——它本质是手机号收集，放在短信验证码下方或折叠。默认首选是 `wechat` 阶段的 `wx.login`。
- 顺带确认：`WX_PHONE_ONETAP = true`（[:27](app/src/components/Login/index.tsx:27)）依赖**非个人主体 + 已认证**。若主体为个人，该按钮在真机必失败，应直接置 false。

#### P0-6 区分 anonymous 与 authLost（防游客态误报）

[services/store.ts:112](app/src/services/store.ts:112) 的处理器加前置：

```ts
setAuthLostHandler(() => {
  if (!getUserId()) return;            // 游客：从未登录 → 不提示、不 reLaunch，由调用方渲染空态
  reportApiError({ code: 'UNAUTHORIZED' });
});
```

这条保住了 AGENTS.md「登录态失效必须显式打断」铁律的**本意**（有 token 却失效时绝不静默降级），同时不再误伤从未登录的游客。**改完需同步更新 AGENTS.md 第 21 行那条铁律的表述**，把「未登录」从触发条件里摘出来，否则下一个人会照着老规则改回去。

#### P0-7 建档仪式可退出、可跳过

- [packages/main/onboarding/index.config.ts](app/src/packages/main/onboarding/index.config.ts)：`SafeHeader` 左侧放返回键（`Taro.navigateBack`）。
- 三步各加「稍后再说」，退出后落到问策 tab 的已登录态（可对话，只是档案不完整——`maturity='pending'` 本来就支持）。
- `shouldOpenOnboarding`（[services/onboardingStateCore.ts](app/src/services/onboardingStateCore.ts)）加一个本地「本次已跳过」标记，避免切 tab 反复弹。

#### P0-8 填齐协议与隐私政策

[packages/main/legal/index.tsx:13-21](app/src/packages/main/legal/index.tsx:13) 的 8 个 `【填写：…】` 全部落实：经营主体全称、ICP 备案号、算法备案/大模型登记编号、注册地址、客服邮箱、个人信息保护负责人邮箱、争议管辖地、生效日期。同时扫掉正文里剩余的 `【待确认：…】`（退款口径等）。

> 这一项是纯业务信息补全，**不是代码问题，但审核必看**。建议填齐后过一次法务。

#### P0-9 后台配置《用户隐私保护指引》

必须按**当前包的真实调用**逐项声明，不得把计划中提过、但代码没有调用的接口也报进去。2026-08-06 静态核对如下（后台中文字段可能随平台调整，以后台实际选项为准）：

| 能力 / 信息 | 当前调用点 | 用户触发与用途 | 后台申报口径 |
|---|---|---|---|
| 微信手机号 | 原生 `components/login-sheet` 的 `open-type="getPhoneNumber"` | 用户先勾选协议，再主动点「微信手机号一键登录」；服务端用一次性 code 换取微信绑定手机号并注册/登录 | 声明手机号用于账号注册、登录、找回与必要服务联系；不得写成静默获取 |
| 微信账号标识 | 原生登录的 `wx.login` | 与用户本次手机号授权同时取 code，服务端换 openid/unionid 并关联同一账号 | 声明用于账号登录与身份识别；与手机号一键登录的关联用途保持一致 |
| 微信头像 | `packages/main/settings` 的 `openType="chooseAvatar"` | 用户主动在设置页点「更换头像」后上传 | 声明头像，仅用于账号资料展示 |
| 相册 / 相机图片 | `packages/main/chat`、`packages/work/poster` 的 `Taro.chooseImage` | 用户主动上传对话图片或海报肖像/素材 | 声明选取照片/拍摄，仅用于本次上传与生成 |
| 微信聊天文件 | `pages/thinktank`、`packages/work/knowledge`、`packages/main/chat` 的 `Taro.chooseMessageFile` | 用户在明确说明后主动选择资料 | 声明选取聊天文件，用于资料解析、检索和本次对话引用 |
| 保存到相册 | `reportShareCard`、`canvasCard`、老板页社群二维码、`posterJob` 的 `Taro.saveImageToPhotosAlbum` | 用户主动点保存分享图/二维码/海报 | 声明写入相册，不描述为读取相册 |
| 订阅消息 | `services/wechatSubscribe` 的 `Taro.requestSubscribeMessage` | 用户主动点提醒/支付状态等订阅入口，一次授权一次消息 | 声明订阅消息用途与对应场景 |
| 客服会话 | 老板页、设置页 `openType="contact"` | 用户主动进入微信客服 | 按后台是否要求声明客服会话处理；不要表述为读取通讯录 |
| 剪贴板 | 对话复制、老板页复制微信号的 `Taro.setClipboardData` | 仅在用户点复制后**写入**其选中内容 | 小程序不读取剪贴板；若后台仅询问“读取剪贴板”则不要勾选 |

当前原生微信包**使用** `getPhoneNumber`，但只在用户勾选协议并主动点击一键登录后触发；拒绝授权可改用短信验证码。当前代码没有 `getUserProfile`、`getUserInfo`、`getDeviceInfo`、读取剪贴板或位置接口，后台应如实申报手机号与微信账号标识，不得漏报，也不得超范围申报。小程序内《隐私政策》已同步为同一口径。

---

### P1 — 显著降低复审风险

#### P1-1 放开能力目录为公开只读

[server/src/routes/modules.ts:12](server/src/routes/modules.ts:12) 的 `GET /modules` 改 `resolveUserOptional`：未登录返回完整目录，`owned`/`enabled` 一律 false，价格照出。

这是**直接对应违规情形 ②（浏览商品内容不得要求注册）的一屏**——锦囊的能力目录就是"商品列表"，必须让游客看得见、点得开详情。购买动作才 `requireAuth('order')`。

同理让套餐页可浏览：`GET /plans/options`（[server/src/routes/plans.ts:90](server/src/routes/plans.ts:90)）改可选鉴权，或游客态改用已公开的 `GET /plans` + `GET /skus` 渲染。

#### P1-2 给游客一条能走通的完整功能路径（最强过审信号）

官方建议第 1 条要的是「**提供用户体验浏览小程序内容功能**」——纯浏览目录只满足了"浏览"，"体验功能"最好也给。现成的抓手是 **3 问速诊**（`POST /quickscan`，WO-06 本就是获客入口）：

- 服务端改可选鉴权，未登录按**设备指纹 + IP 双维度限流，每日 1 次**，走最便宜的模型档，产出精简初诊卡。
- 结果页 CTA：「登录保存这份初诊 / 让军师接着往下问」。
- 成本可控（1 次/设备/日 + 便宜档），且把"必须登录"的时点自然推到"想保存结果"——**这正是官方合规案例的形状**（浏览体验完，再自主选择登录）。

风险与取舍：需要一套匿名限流（当前 `app.ts` 的限流是全局宽松兜底 + 路由级收紧，[server/src/app.ts:105](server/src/app.ts:105)），要新增匿名维度。若不想现在做，P1-2 可延后，但 P0 全做完的前提下过审概率已经很高。

> 不建议给游客开放**免登录自由对话**：无匿名配额体系，成本与滥用风险都不可控，且非过审必需。

#### P1-3 老板 tab 首屏加"账号与数据说明"卡

对齐官方建议第 2 条的精神（让用户先了解页面功能与账号规则，再自主选择授权）：一张卡讲清「军师用什么、存什么、不用什么」+ 协议/隐私入口 + 「登录」按钮。这也是审核员寻找"账号说明"的第一落点。

#### P1-4 运营后门移出游客可触面

`ImpersonateSheet` 的长按触发点（[components/Login/index.tsx:367](app/src/components/Login/index.tsx:367)）从登录首屏移到「设置」页深层（如长按版本号），登录层不再承载它。

---

### P2 — 体验优化（非过审必需）

- **游客足迹继承**：游客浏览过的军师/看过的能力/速诊结果暂存本地，登录后一次性归户，避免"登录即清零"的挫败。
- **登录层由全屏改半屏 Sheet**：底栏保持可见，"可取消"的观感更强，也更贴近微信生态常见做法。
- **`reason` 文案逐场景打磨**：「登录后军师才能记住你的处境」比「请先登录」更能提升转化，也更符合"明示目的"。
- **底栏角标游客态**：`loadBadges` 已 guard 未登录，确认游客态不出现红点残留。

---

## 五、验收清单（按审核员视角走查，逐条录屏）

冷启动 = 删除小程序 + 清缓存后首次进入。

**A. 游客可浏览（对应 ①②）**
- [ ] 冷启动进入，**首屏没有任何登录弹窗**，看到的是军师目录（真实数据）
- [ ] 5 个 tab 全部可自由切换，每个 tab 都有实质可读内容，无一处弹登录
- [ ] 锦囊 → 能力目录可浏览，可点开某项能力的**详情**（不弹登录）
- [ ] 套餐与价格可浏览（不弹登录）
- [ ] 点进任一军师 → 看到立绘 + 开场白 + 可聚焦输入框（不弹登录）
- [ ] 老板 tab → 用户协议 / 隐私政策 / 关于 / 客服 全部可打开
- [ ] 隐私政策与用户协议正文**无任何 `【填写：…】`/`【待确认：…】`**

**B. 登录可取消（对应 ③）**
- [ ] 点「发送」才弹登录层，且标题下写明为什么需要登录
- [ ] 登录层有 ✕，点 ✕ 回到刚才页面、内容仍在、底栏恢复可见
- [ ] 点遮罩也能关闭
- [ ] 关闭后可继续浏览其它 tab，不被再次弹窗骚扰

**C. 手机号授权与替代路径**
- [ ] 未勾选用户协议与隐私政策时，主按钮不带 `getPhoneNumber`，点击只提示先同意
- [ ] 勾选后主动点击「微信手机号一键登录」才拉起手机号授权，并用同次 `wx.login` 关联微信账号
- [ ] 用户拒绝手机号授权时留在当前登录层，可改用手机号短信验证码注册/登录
- [ ] 一键登录成功后的身份补全只询问称呼与可选头像，不再出现第二次手机号绑定

**D. 登录后不再有第二道墙**
- [ ] 建档仪式有返回键，每步可「稍后再说」
- [ ] 跳过建档后能正常对话，不被反复弹回建档

**E. 回归（别把已有铁律改坏）**
- [ ] 有 token 但服务端返回 401：仍然弹「登录态已失效」+ 回登录入口（AGENTS.md 铁律不能破）
- [ ] 游客碰到鉴权接口：**不**出现「登录态已失效」提示、**不**被 reLaunch
- [ ] `npm run typecheck` + `app` / `server` 测试全绿（server 测试记得带 `.env.test`）

---

## 六、提审建议

1. **版本描述**里主动写明整改内容：「本版本按平台指引整改登录流程：支持游客浏览全部内容与能力目录，登录仅在发起对话/保存资料等必要动作时触发且可取消，手机号改为非必需。」
2. **补充说明/录屏**：附一段冷启动到浏览完 5 个 tab 的录屏，证明"未登录可浏览体验"。评论区大量案例显示审核员会重点看这一段。
3. **测试账号**：仍按要求提供，但确保**不登录也能走完主要浏览路径**——审核员经常压根不用测试号。
4. 若被驳回，申诉时直接引用本方案的验收清单 A/B/C 三组，逐条对应官方三条建议。

---

## 七、工作量与排期建议

| 批次 | 内容 | 规模 | 依赖 |
|---|---|---|---|
| P0 前端 | P0-1/2/3/4/6/7 | 6 个 tab 页 + Login + 新增 2 个模块 + store | 无 |
| P0 业务 | P0-8 协议填写、P0-9 后台隐私指引 | 需你提供主体/备案/联系方式等事实 | **阻塞项，尽早启动** |
| P0 确认 | P0-5 中的主体类型确认（是否非个人主体） | 一次查证 | 决定 `WX_PHONE_ONETAP` 取值 |
| P1 | 放开 `/modules`、套餐可浏览、说明卡、后门迁移 | 服务端 2 处 + 前端 2 处 | P0 完成后 |
| P1-2 | 游客速诊（含匿名限流） | 服务端新增匿名配额维度 | 可延后，非过审必需 |
| P2 | 足迹继承、半屏登录、文案打磨 | — | 上线后迭代 |

**关键路径不在代码上**：P0-8（协议主体信息）和 P0-9（后台隐私指引）需要你提供业务事实，建议今天就开始收集，前端改造可并行。
