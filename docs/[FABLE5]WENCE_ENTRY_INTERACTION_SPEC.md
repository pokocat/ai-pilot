# 问策入口改版 · 交互规格（方案三 · 对话即 tab）

> 2026-08-08 · 依据可交互原型定稿：https://claude.ai/code/artifact/66dd6933-6cd3-4166-ba2c-47fdfd95d1b4
> 背景反馈：「很多人不知道在总军师里聊天就 OK」。目标：用户进入问策 tab 即面对总军师对话，军师先开口。
> 北极星指标：进入问策 → 首次给总军师发消息的转化率；辅助指标 TTFM（进入到首条消息的耗时）。

## ⚑ 实施状态（2026-08-08 归档批注，以 AGENTS.md 与 CHANGELOG 为准）

终态已按本规格在 `feat/wence-entry` 分支落地（WP1 服务端 / WP2' chat-core / WP3' 终态 / WP5 运营配置），
以下与正文的偏差以实现为准：
- **§4「分两步走 / A-B 过渡」已作废**：用户拍板直接做终态；`wence_entry` 开关降级为灰度放量 + 急停（dock 臂闲置为保留臂）。
- **H5 明确不做**（2026-08-08 用户决策）：H5 不消费 wenceForm，恒走现状列表；本规格 H5 相关表述失效。
- **提示 pill「点选即填」→「点击即代发」**：原生 textarea 铁律禁止程序化回填，无实现路径；代发与 chips 同语义。
- **§2.4 浮岛实现取路线自绘**（页面自绘输入行+tab 行同玻璃、隐藏 custom-tab-bar），未走 custom-tab-bar 扩展；
  且刻意不上 backdrop-filter（fixed 包含块会裁掉 composer 的全屏子层），理由见 AGENTS.md §7.2。
- **进场四拍拟真时序未做**（消息为会话真实历史，进 tab 即整条呈现），记 §13 TODO。
- 其余组件规格、登录门口径、埋点位、未读三层引导链按正文落地。

## 0. 结论一句话

问策 tab 的内容从「军师列表」改为「总军师对话」：统一页头合一固定、军师先发一条带判断的主动消息、
输入行长在底栏浮岛上、提示问题点选即填；军师列表与历史会话退为页头「军师团 / 历史」双入口的分段抽屉。
**仅对从未发过消息的用户生效**（老用户落最近一次总军师会话），并与方案一（列表页 + 常驻输入坞）做 A/B。

## 1. 信息架构变更

| 位置 | 现状 | 改后 |
|---|---|---|
| 问策 tab 内容 | 微信式军师列表 + 搜索 + 快捷卡 | 总军师对话（页头 + 消息流 + 底部浮岛） |
| 军师列表 | tab 首屏 | 抽屉「军师团」段（页头入口） |
| 历史会话 | 列表页「历史」切换 | 抽屉「历史会话」段（页头独立入口，与军师团同抽屉） |
| 跨域搜索 | 列表页搜索 pill | 抽屉顶部搜索 pill（两段共用） |
| 快捷补给卡（上传资料等） | 列表页横滑卡 | 撤下；上传走输入行「+」，其余入口不变（锦囊/军令 tab 本有） |

## 2. 组件规格

尺寸均为逻辑 px（750 设计稿 ÷2），色值/圆角一律引用 `app.scss` token，不新增字面量。

### 2.1 合一页头（固定，不随对话滚动）

```
padding: 14px 18px 0
kicker（原 TabHeader kicker 位）：总军师玄衡 · 在线
  —— 12px / var(--accent) / letter-spacing .2em（比标准 .3em 收紧，8 字不炸行）
  在线态文字由 agent 在线状态驱动；花名从 ADVISOR_ALIAS.general 取，不写死
title 行：大字「问策」29px serif 600 + 右侧两个入口按钮（右对齐，gap 6）
  按钮规格（复用一种）：高 30 / radius 999 / padding 0 11 / bg var(--accent-soft)
  / border rgba(22,63,48,.12) / 12px 600 / 图标 13px
  ① 军师团（双人图标） ② 历史（时钟图标）
glyph：「谋」100px / var(--accent) / opacity .1 / right -6 top -10（与 TabHeader 现规格一致）
收口：1px var(--line)，margin-top 14
```

要点：
- 页头**固定**。对话区独立滚动，上翻只翻聊天历史——不做"页头随滚动收起"（已验证该模式在 chat 语境语义颠倒：老用户进来永远收起态，上翻读历史会翻出页头）。
- 入口按钮在微信胶囊下方一行，无需避让胶囊。
- 五 tab 页头语言（小字 + 大字 + 印章 + 细线）不破坏；仅 kicker 语义从"用途"换成"对话对象"。

### 2.2 对话区

- 复用 chat 分包页的消息渲染（气泡、markdown、成果卡、liveGen 流式），滚动容器独立，`padding-bottom ≈ 190`（浮岛 120 + 提示 pill 42 + 呼吸）。
- 日期分隔、气泡规格照 chat 现有（AI 白底 4/16/16/16，用户 accent 底 16/4/16/16）。
- **进场主动序列**（仅触发人群，见 §3.1）：
  1. greet 气泡（即时）
  2. +1.1s 出现「正在输入…」三点气泡（拟真关键帧，不可省）
  3. +1.9s 替换为主动判断消息：**一个具体判断 + 一个问题**，禁止"有什么可以帮你"式空话
  4. +0.5s 出现 2 个快捷回应 chips（缩进对齐气泡左沿 43px）
- chips 规格：radius 999 / border rgba(22,63,48,.28) / bg rgba(255,255,255,.85) / 13px serif 600 /
  padding 8 14。点击 = 以 chip 文案代用户发送，chips 组即销毁；用户手动输入发送也销毁。
- 主动消息内容源（按可用性降级）：经营数据异动 → 昨日军令完成情况 → onboarding 档案/命盘 → 运营配置模板池。
  内容与模板池归运营后台配置，代码不落常量（对外内容归运营，同定价权益原则）。

### 2.3 提示问题 pill（点选即填）

原型迭代结论：**不用 placeholder 轮播**——手机上 placeholder 只能看不能点，聚焦后即消失。

```
位置：absolute，left 14，bottom = 浮岛顶 + 8（问策 tab 专属）
结构：[圆形「问」标 20px accent-soft/accent-deep] + [问题文本 12.5px serif 600 ink-2，单行省略]
容器：radius 999 / bg rgba(251,250,246,.96) / border var(--line-strong) / shadow 0 6 18 rgba(42,36,20,.10)
轮换：3s 一换（淡出 .32s + 下移 6px → 换词 → 淡入）；输入框非空时暂停并隐藏
交互：点击 → 整句填入输入框 + 聚焦拉起键盘（不直接发送，允许改）
隐藏时机：输入框有内容 / 「+」菜单打开 / 切到其他 tab；条件解除即复出并继续轮换
```

词池：运营后台配置 + 服务端按用户画像排序；客户端每次进入拉一批（带 `hint_id`），断网回退本地兜底池。
方案一的列表页输入坞使用同一组件。

### 2.4 底部合体浮岛（输入行 + tabbar 同一块玻璃）

```
容器：left/right 14，bottom calc(14px + env(safe-area-inset-bottom))，radius 26，
  玻璃规格与现 custom-tab-bar 一致（rgba(255,255,255,.9) + blur(18) saturate(1.4) + 白描边 + 三层影）
第一行（仅问策 tab 选中时渲染）：
  [+ 34px 圆形线框钮] [输入框 serif 14.5 placeholder「直接说，总军师在线」] [发送 36×36 radius 13 accent]
  padding 10 10 9 18
分隔：1px var(--line)，margin 0 14
第二行：五 tab，高 62，规格照现 custom-tab-bar（选中态图标 1.08 缩放 + 文字变色）
切到其他 tab：第一行 + 分隔收起（120px → 66px），视觉即现有普通底栏；切回问策展开
```

实现落点：**扩展 `custom-tab-bar/index`**（custom: true，本就是自有组件），
`selected === 0` 时渲染输入行。输入行与页面通信两条路线，开发拍板：
- A（推荐先做）：输入行只做「唤起」——点击后 focus 页面内真输入面板（复用 chat composer，含字数、
  引用签、上传清单），浮岛输入行仅静态展示。改动小，键盘/组件状态都留在页面侧。
- B（终态）：浮岛内真输入，经 store 桥接页面发送；需处理 input 在 fixed 组件内的
  adjust-position / cursor-spacing / 键盘顶起时 tab 行是否隐藏（建议隐藏，露输入行贴键盘）。

「+」菜单：三项与线上 chat `onPlus` 完全一致——
`上传资料（PDF/Word/Excel…）/ 上传图片 / 引用已有案卷 · 方案 · 资料`，直接复用现 ActionSheet 逻辑。

### 2.5 军师团 / 历史抽屉（半屏）

```
半屏 sheet：radius 26 26 0 0，max-height 72%，grab 36×4
分段器：军师团 | 历史会话 —— surface-2 底 radius 999 padding 3；
  选中段白底 + 0 1 3 rgba(22,25,29,.08)；13.5px serif 600
搜索 pill：高 40 radius 14，「搜索军师、会话、方案或资料」，走现 api.search（V7-14 跨域搜索）
军师团段：专业军师 wx-item 行（50 头像 + 名 + 花名 + 职责），锁定态照现 diamondCost 规则
历史会话段：wx-item 行 = 会话标题 + 军师花名 + 相对时间 + 摘要 + 未读角标；长按删除（现有接口）；
  底注「仅展示最近，更早的用上方搜索」（首屏 20 条，下拉加载）
```

- 双入口开同一抽屉：军师团按钮 → 落军师团段；历史按钮 → 落历史段；段内可互切。
- 点军师行为与现列表一致（未启用先走 AgentUnlock，其余 continueWith）；点历史行进对应会话。
- **未读联动**：专业军师有未读 → 「军师团」按钮右上聚合数字角标（复用 .unread 规格 16px）；
  历史段行内未读照现 unreadCount 规则。底栏问策 tab 角标口径不变（syncUnreadFromSessions）。

### 2.6 tab 切换

- 底栏五 tab 行为完全不变（switchTo）；唯一新增：问策 tab 选中态浮岛展开输入行。
- 切走再切回：对话状态原样保留（页面级 state，本就是 tab 页缓存行为）。
- 其余四 tab 页面零改动。

## 3. 状态与规则

### 3.1 触发人群（服务端判定，客户端不猜）

| 人群 | 问策 tab 落点 | 主动序列 |
|---|---|---|
| 游客（未登录） | 对话形态，greet + 主动消息为**本地模板**（不写服务端） | 播，内容取本地兜底池 |
| 已登录 · 从未发过消息 | 对话形态 | 播，服务端生成并**写入 general 会话**（真消息，未读联动） |
| 已登录 · 发过消息 | 对话形态，直接续接最近 general 会话 | 不播；日常主动消息走每日军情对话化（另立项） |

主动消息频控：每用户至多 1 条进场主动消息；生成失败静默降级为 greet-only，不得阻塞进场。

### 3.2 登录门（微信整改红线，不可违背）

- 游客可完整浏览：对话形态、主动消息、抽屉、tab 切换全部可看可点。
- 登录弹层只在动作时出：发送（reason=chat）、「+」上传/引用（upload）、历史段（history）、点军师新开线程（chat）。
- 不得进入即弹登录；手机号非必需。401 处理沿用现有铁律（只管「有 token 却失效」）。

### 3.3 键盘与安全区

- 键盘拉起：pill 隐藏；路线 A 下页面 composer 照 chat 现有 onKeyboardHeightChange 行为；
  路线 B 下浮岛 tab 行隐藏、输入行贴键盘。
- 浮岛 bottom 含 safe-area-inset-bottom；抽屉内容底部同理。

### 3.4 CoachMarks 与 onboarding 衔接

- 五步 coach marks 第一步（问策）文案需改：从「列表怎么用」改为「直接说话即可，军师团/历史在右上」。
- onboarding 出口落问策 tab 时，主动序列与 coach 覆盖层不得同帧出现：coach 未完成则序列延迟到 coach 结束后播。

## 4. 实现策略与工程注意

1. **分两步走**：先上「低成本过渡」做 A/B 验证——问策 tab 保留现列表，未发过消息用户进入时自动
   `navTo(chat?agentKey=general&proactive=1)`，返回落列表。数据成立再做本规格的「对话即 tab」终态。
2. 终态需要把 chat 分包页（packages/main/chat，~2600 行）**组件化**：抽 `MessageList` + `Composer`
   两个组件供 sessions tab 页复用；chat 分包页保留（专业军师线程、历史会话仍用它）。
   注意主包体积：组件进主包，评估 lazyCodeLoading 下的增量，超预算则考虑首帧骨架 + 组件按需注入。
3. liveGen / 流式 / 重进重放（reattach）逻辑随 Composer/MessageList 走，行为以 chat 页现状为准，不重写。
4. 服务端新增：`GET /session/proactive-greeting`（或等价）——判人群 + 生成进场主动消息 + chips 文案；
   词池与模板 CRUD 进运营后台，禁止 seed（对外内容归运营，同 pricing 原则）。
5. CSS 全部走既有 token；z-index 按 weapp 惯例写字面量并注释对应层（浮岛 100 层、抽屉 900 层）。

## 5. 埋点

| 事件 | 字段 | 说明 |
|---|---|---|
| wence_enter | user_state(guest/new/returning), form(list/chat) | 进入问策 tab |
| proactive_show | msg_id, source(data/order/profile/template) | 主动消息曝光 |
| chip_tap | msg_id, chip_idx | 快捷回应点击 |
| hint_show / hint_tap | hint_id | 提示 pill 曝光/点选 |
| first_message_send | ttfm_ms, entry(keyboard/hint/chip/dock) | 每用户首条消息（北极星分子） |
| attach_open / attach_pick | item(doc/image/ref) | 加号菜单 |
| drawer_open / drawer_seg | entry(council/history), seg | 抽屉 |
| advisor_open | agent_key, from(drawer/search) | 专业军师触达（防藏太深的护栏指标） |
| tab_switch | from, to | 底栏切换 |

上线判定（两周窗口）：
- 主指标：新用户 首发转化率、TTFM 中位数；
- 护栏：专业军师触达率、D1 回访、会话删除率、投诉/差评关键词（"找不到列表/历史"）。

## 6. A/B 计划

- A 对照：现状列表页。
- B 方案一：列表页 + 浮岛输入行 + 提示 pill（改动最小，复用 §2.3/2.4 组件，dock 版式见原型左机）。
- C 方案三：本规格，仅新注册用户灰度。
- B 与 C 共享组件与埋点口径，先 B 后 C 或并行由流量决定。

## 7. 开放问题

1. 路线 B（浮岛真输入）的键盘细节需真机验证：input 在 fixed 玻璃容器内的 adjust-position 表现。
2. 老用户的日常主动消息（军情对话化、隔日军令回访）本规格未覆盖，另立项做频控与内容策略。
3. 快捷补给卡撤下后，「生成方案 / 转成军令」入口依赖对话内成果卡与军令 tab——观察是否需要在
   对话空态补一组静默入口。
4. 原型与本规格的视觉基（花名印章头像）最终以拟人立绘为准，规格尺寸不变。
