# 军师小程序 · 转发 / 邀请开通 / 关系链 调研方案（v2）

> 2026-08-18 · 调研对象：为什么线上小程序「不能转发」，以及参照 ai-society（主理人公社）
> 的邀请归因体系，在军师里做「转发 → 邀请 → 开通 → 记录关系链」。
> 本文只做调研与方案取舍，不含实现。所有现状结论都带出处，可自行复核。
>
> **v2（2026-08-18 当日）**：按飞书评论修订四处——①分享模式改为**全站可分享 + 固定海报素材轮动**
> ②关系链**数据存满三级**、激励只看一级 ③奖励机制**后定**，本期只记关系、预留运营配置栏位
> ④分享文案切**真实经营痛点**。并新增 §6 本体模型与四视图（融合外部方案，按军师现实适配）。

---

## 0. 一句话结论

**转发不是被谁禁掉的，是绝大多数页面没实现转发回调。** 微信的规则是：页面不实现
`onShareAppMessage`，右上角 ··· 菜单里的「转发给朋友」就是**置灰**的。军师 61 个原生页面里
只有 4 个实现了，5 个 tab 页（问策/战局/锦囊/图籍/主公）**一个都没有**——用户在主界面看到的
转发永远是灰的，观感就是「这小程序不能转发」。朋友圈分享（`onShareTimeline`）**全站为零**，
菜单项根本不出现。而且现有那 4 处返回的是裸路径，**不带任何归因参数**，转发出去也记不下谁带来了谁；
落地侧 `app.js` 的 `onLaunch()` 连 `options` 都没接，query 与小程序码 scene 被直接丢弃。

所以这件事是三层缺口，不是一个开关：**① 转发能力面（回调覆盖）② 归因链路（带码 + 捕获 + 绑定）
③ 关系链与分析（存关系、可视化、防刷、可运营）**。奖励机制评论已定为后置，本期只留栏位。

---

## 1. 现状核查

### 1.1 线上小程序是原生的，Taro 只出 H5/PC

`app/package.json` 描述即「原生微信小程序 + Taro H5」：`build:weapp` 走
[scripts/build-native-weapp.mjs](app/scripts/build-native-weapp.mjs)，源是 `app/weapp-native/`，
产物 `dist-native/`；Taro（`app/src/`）只出 `dist-h5` / `dist-pc`。

**一个容易误判的点**：`app/src/packages/work/*/index.config.ts` 里那几处
`enableShareAppMessage: true`（[quickscan](app/src/packages/work/quickscan/index.config.ts:8)、
calendar、mingpan）是 **Taro 运行时的注册开关，对原生产物无效**——原生页面的 `index.json` 不需要
这个键（见 [quickscan/index.json](app/weapp-native/packages/work/quickscan/index.json)）。
看到这三处配置就以为「转发已经开了」是错的，它只影响 H5/Taro 那条线。

### 1.2 转发回调覆盖率：4 / 61

| 页面 | 出处 | 归因参数 |
|---|---|---|
| 天时日历 | [calendar/index.js:46](app/weapp-native/packages/work/calendar/index.js:46) | 无（裸 path） |
| 命盘报告 | [mingpan/index.js:41](app/weapp-native/packages/work/mingpan/index.js:41) | 无 |
| 速诊 | [quickscan/index.js:13](app/weapp-native/packages/work/quickscan/index.js:13) | 无 |
| 快拍成片 | [video/work/index.js:52](app/weapp-native/packages/video/work/index.js:52) | 无 |

- `onShareTimeline`：**全站 0 处**（`grep -rln onShareTimeline app/weapp-native` 无命中）。
- 5 个 tab 页（`pages/sessions|home|pouch|thinktank|profile`）全无转发。
- 没有任何 `wx.hideShareMenu` 调用——不是被主动关掉的，就是没实现。
- `video/work/index.js:45` 的注释已经把原因写清楚了（「不实现 onShareAppMessage 时 ⋯ 菜单里的
  转发是灰的，必须显式声明」），只是这条认识没有推广到全站。

### 1.3 落地侧：进来的码会被丢掉

[app/weapp-native/app.js:9](app/weapp-native/app.js:9) 的 `onLaunch()` **不接 `options`**，
只做 `store.bootstrap()` + 字体加载。冷启动的 `query`（分享卡带的参数）与 `scene`（小程序码带的）
都没有读取，也没有 `onShow`。即便前端现在开始带码转发，落地这一侧也接不住。

### 1.4 已经有的地基（不用从零起）

| 能力 | 现状 | 出处 |
|---|---|---|
| 用户邀请码 | **已有**：`User.inviteCode @unique`，`"JS"+4 位 base32`，惰性生成、撞码重试、并发读回 | [schema.prisma:238](server/prisma/schema.prisma:238)、[community.ts:27](server/src/services/community.ts:27) |
| 邀请码已透出 | `/me` 主视图已返回 `inviteCode` | [meta.ts:74](server/src/routes/meta.ts:74) |
| 关系链 | **完全没有**：无关系表、无绑定、无归因日志 | — |
| 小程序码出图 | **已有** `miniCodeDataUri(scene)`（getwxacode/unlimit，凭据缺失/测试环境降级 null） | [wechat.ts:177](server/src/services/wechat.ts:177) |
| 注册收口 | 三个登录入口（短信 / 微信一键 / 运营商一键）共用 `loginOrRegisterByPhone()`，`isNew` 已算出 | [auth.ts:170](server/src/routes/auth.ts:170) |
| 注册侧风控原料 | `clientIp()` 已在取（X-Forwarded-For 首段），审计里已存 `userAgent` | [auth.ts:50](server/src/routes/auth.ts:50)、[audit.ts:69](server/src/services/audit.ts:69) |
| 前端登录收口 | `components/login-sheet/`（88 个页面引用）两条登录路径 | [login-sheet/index.js:140](app/weapp-native/components/login-sheet/index.js:140)、[:181](app/weapp-native/components/login-sheet/index.js:181) |
| 页面基座 | `baseData()` 几乎每页都用 | [services/page.js:30](app/weapp-native/services/page.js:30) |
| 奖励发放（预留用） | `grantCredits()`（带账户锁与流水，支持幂等 key）/ `grantQuotaPack()` | [credits.ts:121](server/src/services/credits.ts:121)、[tokenQuota.ts:491](server/src/services/tokenQuota.ts:491) |
| 付费开通收口 | `markPaidAndApply()`（advisory lock + appliedAt 幂等）→ `applyPlanPurchase()` | [wechatPay.ts:629](server/src/services/wechatPay.ts:629)、[purchase.ts:31](server/src/services/purchase.ts:31) |
| 开通归因表 | `ActivationEvent` 已有，source = `prescription / catalog / market`（**没有 invite**） | [activation.ts:7](server/src/services/activation.ts:7) |
| 埋点 | `ClientEvent`（name 白名单 + props ≤2KB） | [schema.prisma:926](server/prisma/schema.prisma:926) |
| 运营配置位 | `FeatureFlag.payload`（数值项后台可调，监控二期同套路） | [schema.prisma:151](server/prisma/schema.prisma:151) |

**结论**：邀请码、小程序码、注册收口、幂等发放、IP/UA 采集全都在了。缺的是**关系链表 + 绑定时机 +
分享带码 + 落地捕获**这四件事，以及把它们串起来的分析视图。

---

## 2. ai-society 的现成逻辑（值得照搬的形状）

### 2.1 前端

- **全站分享 mixin**：[behaviors/share.js](../ai-society/apps/member-app/miniprogram/behaviors/share.js)
  用法 `Page(share.withShare({...}))`。**刻意用 `Object.assign` 而不是 `Behavior`**——页面级
  behaviors 对生命周期函数的合并语义随基础库版本有差异，而分享回调漏挂是**静默失效**（按钮变灰但不报错）。
- **分享路径统一带自己的邀请码**，码从 `app.globalData.inviteCode` 取（不为一个分享参数在每页多打一次
  `/mp/invite`）；**拿不到码就退回无参路径**——分享照常可用，只是这一跳不计归因，不因缺参数把按钮变哑。
- **两个入口两张封面图**：转发给好友按 5:4 原样显示，朋友圈按 1:1 **居中裁剪**，共用会把字标裁掉。
- **朋友圈只能给 query，不能改 path**（落地页固定为当前页）。
- **冷启动即捕获**：`app.js` 的 `onLaunch` 和 `onShow` 都调 `captureInviteCode(options)` 写 storage
  ——游客也可能从分享进来，他之后某一刻登录时才用得上这个码。
- **scene 通道多用途共用要按形状分流**：邀请码（`FLM-` 前缀）与管理台扫码票据（`S`+24hex）共用
  scene，各只认自己的形状，互不误吞。
- **邀请页 + 海报页**：邀请页给下线名单 / 影响力 / 本月新增 / 已开通数；海报页本机 canvas 出图，
  **小程序码取不到就把码位换成邀请码大字**——不给一张扫不出来的图。
- **给分享写了测试**：[test/share.test.js](../ai-society/apps/member-app/test/share.test.js)
  是不依赖框架的 node 脚本，断言两张图不接反、比例正确、有码/无码两态的 path 形状。理由写在文件头：
  分享是静默失效的，接错了转发照样成功，只有真机发一条朋友圈才看得见。

### 2.2 服务端（Java，只借形状不借代码）

- **`referral_relation` 表 = 物化路径**：`member_id`(PK) + `referrer_id` + `lv1/lv2/lv3_parent`，
  对应三条公理：① **单推荐人**（PK 保证一人一行）② **无环**（沿 `referrer_id` 递归上溯，途中撞见本人即拒绝，
  加 hop 上限兜底——物化路径只存 3 级，深环会漏检）③ **深度 ≤3**。
- **`attribution_log`**：每次归因落一行（code / source / new / referrer / project）。
- **绑定时机 = 登录**；已绑定的**不可变更**；码失效走 `recordUnresolvedInviteCode`
  **留痕但不阻断进线**——静默丢弃会导致「推荐人无从解释客户为什么没归到我」。
- **并发风控**：`SELECT ... FOR UPDATE` 锁推荐人行，串行化「同一邀请码多个新号并发进线」（TOCTOU）。
- **发奖每日封顶，且封顶只停发奖、关系照常绑定**（归因不受限）。
- **奖励数值外置到规则表**，前端也读服务端，代码里不写死。
- **合规**：不做返佣结算、不承诺现金收益；邀请页把设计稿的「预计收益 ¥2,870」**刻意换成**
  「邀请成长值（累计已获得）」——摆一个收益等于承诺一件系统算不出也不结算的事。

---

## 3. 方案

### 3.1 分层

```
① 能力面：全站分享 mixin（转发 + 朋友圈）+ 固定海报素材池轮动
② 归因面：分享带码 → 落地捕获（query + scene）→ 注册时绑定
③ 关系面：Referral 表（物化路径存满三级）+ 归因日志（含风控字段）
④ 分析面：本体四视图（Schema / 邀请树 / 漏斗 / 风控），落运营后台
⑤ 呈现面：主公页「我的邀请」；奖励机制后定，只留运营配置栏位
```

### 3.2 ① 能力面：全站可分享 + 固定素材轮动（评论④已定）

**模式**：分享内容与页面解耦。不再按页面各写一套标题，而是内置一个**海报素材池**
（图 + 文案成对），mixin 按日确定性轮动（同 cardHtml 语录的轮换套路，不引入随机性，便于排查），
所有页面转发出去是同一套精修素材，落地路径统一指向**固定公开落地页**（如速诊或首页）并带 `?ic=`。

这个模式顺带解决了 v1 里 A/B/C 分级要处理的问题：**转发卡不再暴露当前页面**，私密页（账本/档案/
支付）转发出去的也是固定海报 + 公开落地页，收到的人不会撞上别人的空态或登录门。

- 新建 `app/weapp-native/services/share.js`：`withShare(page)` 用 `Object.assign` 合并
  （理由继承 ai-society：Behavior 生命周期合并语义随基础库版本漂移，漏挂静默失效）；
  页面自定义同名方法优先——速诊/日历/命盘/成片这 4 个已有页保留自己的成果型分享（分享的是「我的结果」，
  比通用海报更有效），只是 path 补上 `?ic=`。
- **素材池双层**：服务端可配（运营后台维护图 URL + 文案，`/me` 或独立轻接口下发，缓存本地）+
  内置兜底一套（网络不可用时分享不哑）。对外素材归运营不归代码，与定价同一条铁律。
- **文案切真实经营痛点**（评论②）：素材文案不用「攻守」这类盘面语，落在老板真实场景上——
  获客贵、现金流紧、招人难、不知道下一步押哪里；军师语感保留在称谓与语气，不体现在痛点表述里。
  例（方向示意，终稿走运营）：「生意上的难题，先让军师给你过一遍」「10 分钟，把你最头疼的事拆开看」。
- **朋友圈（onShareTimeline）只在公开内容页开启**：技术限制——朋友圈落地页强制为当前页、只能带
  query 改不了 path，私密页开朋友圈会把陌生访客直接落在登录门/空态上。转发给好友无此限制（path 可指定），
  所以「任何页面都可以分享」在转发通道全量成立，朋友圈通道按页面性质收敛。
- 两张图规格照搬 ai-society：好友 5:4、朋友圈 1:1 单独排版；素材走网络 URL（onShareAppMessage 的
  imageUrl 支持网络图），不占主包体积（公社踩过 369KB 顶穿主包上限的坑）。

### 3.3 ② 归因面

- 分享 path 统一 `?ic=<inviteCode>`（参数名短，给 scene 留余量）；码取 `store` 里 `/me` 已有的
  `inviteCode`（**零新增请求**）；**取不到就发无参路径**。
- `app.js` 的 `onLaunch(options)` / `onShow(options)` 调 `captureInvite(options)`：
  读 `query.ic`，再读 `scene`（解码失败不得中断启动），**按形状校验**（`/^JS[0-9A-HJKMNP-TV-Z]{4}$/`，
  与 `community.ts` 的 Crockford 字母表同源），存 storage 并**记下捕获时间**。
- **归因窗口 30 天**：军师的 `inviteCode` 是**永久码**（不像公社 7 天轮换），不设窗口会出现
  「半年前点过一次分享的人今天注册，归给早已忘记这件事的推荐人」。窗口值归运营后台。
- 绑定时机：**注册那一刻**（`loginOrRegisterByPhone` 里 `isNew === true`）。已注册用户登录时**不追认**
  ——存量互相刷是最容易被薅的口子。
- 前端把码带上去只需改两处：`services/api.js` 的 `login` / `wechatPhoneLogin` 加参数，
  `login-sheet/index.js` 两条路径读 storage 传入。**88 个页面零改动。**
- 码解析失败（不存在 / 是自己 / 超窗口）：**照常注册，落归因失败记录**，绝不阻断登录。

### 3.4 ③ 关系面：数据存满三级，激励口径只看一级（评论①已定）

新表（Prisma）。**物化路径 lv1/lv2/lv3 从第一天就写全**——本体视图要能看到完整链路；
「只做一级」收敛的是激励与呈现口径，不是数据：

```prisma
/// 邀请关系（单推荐人 / 无环 / 物化路径存满三级；激励与呈现口径当前只读 lv1）
model Referral {
  userId      String   @id            // 被邀人，一人一行 = 单推荐人公理
  tenantId    String
  referrerId  String                  // 直接邀请人
  lv1         String                  // = referrerId（物化路径，查询免递归）
  lv2         String?                 // 邀请人的邀请人
  lv3         String?                 // 再上一级
  inviteCode  String
  source      String                  // share_friend | share_timeline | poster_qr | manual
  boundAt     DateTime @default(now())
  @@index([lv1])
  @@index([lv2])
  @@index([lv3])
}

/// 归因日志（含失败与风控字段）：一次进线一行，成功与否都留痕
model ReferralAttribution {
  id          String   @id @default(cuid())
  inviteCode  String
  source      String
  newUserId   String?
  referrerId  String?
  outcome     String   // bound | self | unknown_code | expired | already_bound
  clientIp    String?  // 风控视图原料（auth.ts clientIp() 现成）
  userAgent   String?  // 同上（audit.ts 已在采）
  createdAt   DateTime @default(now())
  @@index([referrerId, createdAt])
  @@index([clientIp])
}
```

- **既然存满三级，无环检查就要按 ai-society 的完整版做**：绑定前沿 `referrerId` 递归上溯到根，
  途中撞见本人即拒绝，hop 上限兜底。物化路径只存 3 级，靠它查环会漏深环。
- 绑定服务 `services/referral.ts`：`bindOnRegister({ tx, user, inviteCode, source, ip, ua })`，
  **与建号同事务**（`createUserWithTenant` 已是 `$transaction`，直接搭车），失败只记日志不回滚注册。
- lv2/lv3 取法照搬：读邀请人自己那行的 lv1/lv2 平移即可，无需递归。

### 3.5 ④ 激励面：本期不做，只留栏位（评论③已定）

本期**只记录邀请关系，不发任何奖励**。为「后定的奖励机制」预留三样东西，届时零改表开闸：

1. **运营后台配置栏位**（`FeatureFlag.payload`，与告警阈值同套路）：预留 key ——
   `referral.rewardInviter`（邀请人奖励，形态+数值）、`referral.rewardInvitee`（被邀人）、
   `referral.rewardOnPaid`（好友首付费）、`referral.dailyCap`（每日封顶）、
   `referral.ladder`（阶梯规则，见 §6 公理 4 的说明）；**归因窗口天数已独立成 `referral-window.window`**（`PATCH /admin/flags/:id` 是整块覆盖写 payload，与奖励键共用一个 flag 会互相抹掉；读取时新键优先、回退旧 `referral.window` 兼容搬迁前的存量配置）。
   全部后台可改，代码不留常量、不 seed。
2. **幂等挂点**：奖励将来走 `idempotencyKey`（`credits.ts` 的 `appendCreditDelta` 已支持），
   key 形如 `referral:{referrerId}:{newUserId}:{stage}`；开通侧挂已经幂等的 `markPaidAndApply`
   成功分支。挂点位置本期就在代码里留好注释锚，不实现。
3. **`ActivationEvent.source` 增加 `invite`**（[activation.ts:7](server/src/services/activation.ts:7)），
   本期就加——它服务的是漏斗分析，不是发奖。

### 3.6 ⑤ 呈现面

- 主公页加一张「我的邀请」卡 → 新页 `packages/work/invite`：邀请码 + 直邀人数 + 已开通数
  （**全部来自服务端账本**；取不到显示「—」，与真实的 0 区分开）。不展示奖励区块——机制未定，
  不摆空承诺；页面结构留出位置。
- 海报（分享素材池里的图）由运营出图起步；个人化海报页（canvas 印本人码）降为后续增强，
  复用现成 `miniCodeDataUri(scene=ic:JSxxxx)`。

---

## 4. 本体模型与四视图（融合外部方案）

外部方案的骨架（类 + 公理 + 多视图投影）直接采用；两处按军师现实改写，见 §4.2 说明。

### 4.1 类目录（映射到既有 schema，能复用的不新建）

| 本体类 | 落点 | 说明 |
|---|---|---|
| User | `User`（已有） | `inviteCount` 不落列，从 `Referral.lv1` 计数派生——账本派生原则，不存冗余可漂移字段 |
| InviteCode | `User.inviteCode`（已有） | 军师是永久码、一人一码，**不单独建表**；外部方案的 clickCount/convertCount 从 ClientEvent/Attribution 派生 |
| Referral（关系边） | `Referral`（新，§3.4） | 自关联邀请链的实体化：物化路径三级 |
| ShareEvent / Channel | `ClientEvent`（已有） | 渠道=枚举（share_friend/share_timeline/poster_qr），不值得独立成类 |
| Campaign | 暂缺 | 军师当前无营销活动系统；素材池的「期次」可充当弱 Campaign，先不建 |
| Reward | 预留（§3.5） | 机制后定；届时优先复用 `CreditLedger`（已有 reason/幂等），不新建表 |
| Device | `ReferralAttribution.clientIp/userAgent`（新列） | 小程序拿不到稳定 deviceId，用 IP+UA 近似；openid 天然一人一号是更硬的锚 |

### 4.2 公理（外部 4 条 → 军师 5 条）

1. **首邀归因**：一个用户只归因一个邀请人，绑定后不可变更（`Referral.userId` 主键保证）。
2. **无环 + 深度**：绑定前递归上溯查环；物化路径存三级，**激励与呈现口径只读一级**（评论①）。
3. **奖励后置**：奖励只挂在真实结果（注册成功 / 首次付费）之后，绝不挂在分享动作上；
   每日封顶，封顶只停发奖、关系照常绑定。——本期只留栏位不实现。
4. **阶梯规则归运营**：外部方案的「1-5 人 ¥5、6-15 人 ¥8、16+ ¥12」**现金形态不可用**
   （微信小程序内做现金裂变返利是审核红线，也违反本仓「不做返佣结算」的既有口径）；
   阶梯这个**形状**保留为 `referral.ladder` 配置（按人数分档、奖励为算力/额度等虚拟权益），
   数值与是否启用归运营后台。
5. **风控预警不阻断**：同一 IP（后续可加设备指纹）在窗口期内注册 ≥N 个带码新号 → 落风险记录、
   进风控视图、可暂停该码发奖（将来），但**关系照常绑定、注册照常放行**——阈值 N 归运营后台。

### 4.3 四视图（落运营后台 admin，一份数据四个投影）

外部方案对「力导向毛球」的批评成立，采纳其视图拆分：

| 视图 | 回答的问题 | 布局 | 数据来源 |
|---|---|---|---|
| ① 本体 Schema | 模型长什么样（给建模/架构） | UML 类图风格，连线标关系名与基数，**不用力导向** | 静态（本文档 + admin 里一张说明图） |
| ② 邀请关系树 | 谁在带人、带了多少 | **从左到右层级树**（L1→L2→L3），节点大小=直邀数，颜色=状态（已开通/已注册/风控标记），点击展开折叠 | `Referral` 物化路径（存满三级在这里兑现价值） |
| ③ 转化漏斗 | 哪个环节流失最多 | 漏斗：分享曝光→落地打开→注册→首开通 | `ClientEvent` 四段埋点 + `ActivationEvent(source=invite)` |
| ④ 风控关联 | 谁在刷 | 以 IP/设备为中心的**二部图**（IP ↔ 新号），正常用户分散、刷号聚集一眼可见 | `ReferralAttribution.clientIp/userAgent` |

可视化纪律（照单收下外部方案的反模式表）：不做一张图塞所有实体；节点大小/颜色必须编码业务指标；
有层级用树、流程用漏斗、关联用二部图；布局可预测；支持下钻。落地形态：admin-pc 新增「邀请增长」页，
四视图做成同页四个 tab——数据只存一份，视图只是投影。

---

## 5. 分期落地（v2 调整：激励出列，分析视图入列）

| 期 | 内容 | 交付判据 | 规模 |
|---|---|---|---|
| **P0** | 分享 mixin 全站挂载 + 素材池（内置兜底一套）+ 两张封面图 + 落地捕获（app.js） | 真机：任意页 ··· 转发可点、出固定海报；从分享卡进入 storage 有码 | 前端小 |
| **P1** | `Referral`（三级物化）+ `ReferralAttribution`（含 IP/UA）+ 注册绑定 + 递归查环 + 读数接口 | 单测：自邀拒绝 / 环拒绝 / 重复绑定拒绝 / 失效码留痕不阻断 / 三登录入口都能绑 / lv2lv3 平移正确 | 服务端中 |
| **P2** | 埋点四段（share_expose/landing/register/activate）+ `ActivationEvent.source=invite` + 素材池后台可配 | 事件入库可查；后台改素材 ≤缓存周期生效 | 小 |
| **P3** | admin「邀请增长」四视图（Schema 说明图 / 邀请树 / 漏斗 / 风控二部图） | 后台能看树、看漏斗、看同 IP 聚集 | admin 中 |
| **P4** | 我的邀请页（主公页入口） | 真机：码/人数/开通数三读数与后台一致 | 前端小 |
| **P5** | 奖励机制（后定）：读 §3.5 预留栏位开闸 | 届时另立验收 | 待定 |

**防回归**：照 ai-society 加不依赖框架的 node 测试——①按页面清单遍历源码断言全站挂上了 mixin
（漏挂静默失效，review 看不出来）②素材池兜底套的图文完整、两图比例不接反 ③有码/无码两态 path 形状
④轮动函数同日幂等。

---

## 6. 合规与风险

| 风险 | 说明 | 处置 |
|---|---|---|
| 利益诱导分享 | 微信明令禁止「分享后解锁 / 分享得奖励」 | 本期无奖励天然合规；将来开闸也只挂注册/开通结果，不挂分享动作 |
| 现金裂变返利 | 外部方案的 ¥/人阶梯是审核红线 | 公理 4：阶梯形状保留，形态限定虚拟权益，数值归运营 |
| 多级分销观感 | 多级 + 利益 = 最敏感形状 | 数据存三级仅供内部分析；对用户呈现与激励只一级 |
| 登录门整改红线 | 游客可浏览、启动不得自动跳登录（2026-08-05 整改） | 归因只在用户主动登录时发生；捕获到码绝不触发跳转 |
| 批量小号刷 | 同一码/同一 IP 批量进线 | 公理 5 预警不阻断 + `phone @unique` + 将来发奖侧封顶与行锁 |
| 命理内容分享 | 命盘/天时页的成果型分享涉运势表述 | 这 4 页保留自定义分享但文案走经营语；通用素材池完全不含命理表述 |
| 素材文案空洞 | 「攻守」盘面语对经商用户无代入感（评论②） | 素材文案切真实痛点（获客/现金流/用人），运营终审 |

---

## 7. 决策状态

已定（飞书评论 2026-08-18）：

1. **关系链**：数据存满三级，激励与呈现只看一级。
2. **奖励**：机制后定；本期只记关系 + 预留运营配置栏位与幂等挂点。
3. **分享模式**：全站可分享，内容为固定内置海报素材（图+文案）轮动，与页面解耦。
4. **文案**：切真实经营痛点，不用盘面黑话。

仍待定（不阻塞 P0/P1 动工）：

1. **素材池首批谁出**：设计出 3~5 套图文，还是先用运营文案 + 简版模板图起步？
2. **朋友圈通道范围**：按 §3.2 建议只在公开内容页开，还是首期干脆不开朋友圈、只做转发？
3. **风控阈值 N 与归因窗口天数**：归运营后台，上线前给个初值即可。
