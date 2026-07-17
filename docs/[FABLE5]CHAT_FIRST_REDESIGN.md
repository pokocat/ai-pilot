# [FABLE5] 整体重构设计规格 v1.3 · 「运筹帷幄 · 纸墨帅帐」

> 作者：Fable 5（交互设计师）· 2026-07-16
> v1.2：军情吞并点将，5 tab → 4 tab；能力直达机制（军令行「去办」按钮 + 外跳配置位）。
> v1.3：并入完整设计语言（用户要求：保留宋体，大胆整体重构，气质=沉稳睿智）。
> 本稿取代 `docs/[FABLE5]REDESIGN_EXEC_SPEC.md` 的 IA 与视觉规范。AGENTS.md §0 语声红线继续有效。

---

## 一、设计语言 · 「运筹帷幄 · 纸墨帅帐」

**总纲：像一部线装兵书，不像一个卡片仪表盘。** 沉稳来自克制与留白，睿智来自文字站 C 位。

### 1.1 核心原则：非行动不设框

**只有可操作的对象才有卡片**（军令、报告、按钮、表单笺）；一切阅读性内容（断语、三势、
结论、督办进展、菜单行）直接排在纸面上，用**题眉 + 细线**分章，如书籍章法。
现状的"方块套方块、卡内三宫格、软底嵌白格"全部废除。

### 1.2 字阶（宋体保留并升格为主角）

| 类名（建议） | 规格 | 用途 |
|---|---|---|
| `.t-display` | serif 28px / lh 1.55 / w600 / ls .02em | 断语、报告标题 |
| `.t-title` | serif 20px / w600 | 页题 |
| `.t-kicker` | serif 11px / --ink-3 / ls .18em | 题眉（「三势」「麾下」「请缨」） |
| `.t-advisor` | serif 15.5px / lh 1.95 | 对话中军师的话（阅读主体） |
| `.t-body` | serif 14px / lh 1.8 | 一般正文 |
| `.t-mark` | serif 11px / --ink-3 | 落款（「军师 · 七月十六」） |

字重铁律 ≤600（清除现有 9 处 700、2 处 900）。

### 1.3 色彩纪律：墨为体，本命色为印

- 纸底 + 墨字占九成；**本命色只作"朱批"**：印章、选中态、朱砂点、关键下划一笔。
  废除：整卡铺色渐变 CTA、金/绿左边框卡、多色徽章。
- **全站唯一深底**：军情断语卡，玄墨底（新令牌 `--ink-deep-bg: #1B1E23`）纸白字 + 本命色小印。
- 徽章收敛为一种：细线描边纸底 pill（serif 11px）；强调徽章 = 本命色实心小印（「生态」）。

### 1.4 印章与落款

- **印章字**：报告类别单字方印（断/策/要），本命色底纸白字，22px 方块，圆角 `--r-sm`。
- **落款**：产出物右下「军师 · {日期}」，替代 timestamp。
- 报告卡/请缨帖收尾一枚 10px 本命色实心小方印，作视觉句读。

### 1.5 动效：墨染，不弹跳

- 入场统一「墨染」：opacity 0→1 + 上移 4px，240ms ease-out；列表逐项错峰 40ms。
- 「军师执笔…」三点墨晕缓动（替代通用 typing）。报告分段渐显保留（520ms）。
- 禁止 scale 弹跳与 bounce。

### 1.6 圆角与间距

圆角三档：卡 `--r-lg` / 行与输入 `--r-md` / 笺签 `--r-sm`（替换 183 处裸写）。
页边距 24px；章间距 28px；细线 `--line`。

---

## 二、对话体验（chat/counsel，主舞台）

**军师的话不装气泡，像读一封手书：**

- **军师消息**：无气泡直排纸面，`.t-advisor`，宽 ≤88%；首条上方 22px 军师小像 + 「军师」签。
- **用户消息**：右对齐浅面小气泡（`--surface-2`、`--r-md`、13.5px）——轻，让军师的话压场。
- **选择笺（choices）**：军师问句下横排纸笺 chips——纸底细线描边 serif 13px，按下墨色实底反白；
  点选后笺文成为用户消息。**输入框永远可用，笺只是捷径。**
- **请缨帖（proposal）**：居中窄卡，题眉「请缨」+ 帖文 + 两枚选择笺（「即刻出策」「再答两问」）+ 小印。
- **报告卡**：卷宗式——题签条（印章字+标题）+ 分段正文 + 落款小印 + 动作行（存/网页版/认可→去执行）。
- **生辰笺（widget: bazi-form）**：行内小表单卡：历法切换 + 日期滚轮 + 十二时辰笺阵 + 「不看这层」。
- **择色笺（widget: color-pick）**：六色圆印横排，点即全局换主题即时预览。
- 输入条：纸面细线输入框 + 墨线图标（+/发送）；删「更多模型」假入口。
- 头部：军师名 + 「往来」（历史）；军师印象条降噪为一行细字。

---

## 三、入帐对话（新用户引导，取代 Picker 弹层）

军师先开口，逐条墨染浮现（约 400ms 间隔），全程选择笺点选。服务端确定性状态机
（`GREET → ASK_INDUSTRY → ASK_STAGE → ASK_PAIN → ASK_BAZI → ASK_COLOR → FORGE → DONE`），
答案实时落 `saveProfile` / `PUT /profile/bazi` / `User.benmingColor`；问答落库为 general
会话真实 Message；**Profile 行存在 = onboarded**（废除本地双轨）。收官自动生成
《初见断语》（≤2 分钟 aha moment）。

接口：`GET /onboarding/state`、`POST /onboarding/advance`、`GET /onboarding/result`。
`OnboardingMsg = { text, choices?: {label,value}[], widget?: 'bazi-form'|'color-pick' }`

### 文案（军师语声，逐字实现）

**GREET**（与 ASK_INDUSTRY 一次下发两条）：
> {称呼}，坐。既入此帐，往后你的局，我与你一同看。
> 开局不必长谈——答我几问，我便知该如何辅佐你。

**ASK_INDUSTRY**：
> 先说营生。你如今做的，是哪一路生意？　　choices: 〔行业选项〕+「其他，我自己说」

**ASK_STAGE**：
> 知道了。这一路走到哪一步了？
> choices: 「尚在筹备」「刚开张，未见利」「有进项，起伏不定」「站稳了，想再上一层」

**ASK_PAIN**：
> 最要紧的一问：眼下最让你夜里睡不安稳的，是哪一桩？　　choices: 〔痛点选项〕+「一言难尽，我自己说」

**ASK_BAZI**（可跳过）：
> 还有一问，答不答随你。留个生辰，我能多看一层天时——何时宜攻，何时宜守。
> 不信这一套，也不碍事。　　widget: bazi-form；choices: 「不看这层」

**ASK_COLOR**：
> 最后一桩。择一色，作你的帅旗——往后帐中器物，皆随此色。　　widget: color-pick

**FORGE**：
> 够了。情报虽薄，已可落笔。
> 容我片刻，为你写下第一道《初见断语》——你我初见，我眼中你的局。

**DONE**：
> 断语在此，收好。往后你每多告诉我一分，我便多看准一分。
> 有事直说；无事，我也会寻你。

《初见断语》模板 key `first-read`：我看到的你 / 局面三行 / 天势一眼（有命盘才出）/
第一道军令 / 下回我要问你的三件事。

**隐性画像**：人格类推断永不出问卷，沿用 learnFromConversation + StrategicProfile 内部抽取。

**老用户回帐一句**：`GET /counsel/opening → { text, chips }`，确定性拼装
（上回议到{主题}+nextQuestions 追问；兜底「回来了。今日想从何处入手？」）。

---

## 四、出策契约

1. **入帐必得一断**（初见断语自动出）。
2. **火候到了军师递请缨帖**：on-demand 成果型 agent（general）∧ maturity≠empty ∧
   距上次报告 ≥5 轮 ∧ 拒后冷却 3 轮 → SSE `propose` 事件
   `{ title, prompt, declinePrompt, readiness }`，proposal 持久化进 assistant Message。
   帖文：「这几轮问答下来，火候到了七分。我可即刻为你立一道《{title}》；或再答我两问，凑到十分再出。」
   「即刻出策」发 prompt（命中现有正则）；「再答两问」发 declinePrompt。
3. **点名即出**（现有正则保留）。

报告落库 → 锦囊朱砂点（store.lastSeenReportAt 对比，进锦囊即清）+ 微信订阅消息（现有）。

---

## 五、信息架构（4 tab，每 tab 单一职责）

| # | 路径 | 名 | 图标 | 职责 |
|---|---|---|---|---|
| 0 | pages/counsel（新，落地页） | 问策 | hat | 总军师对话本体（含入帐流） |
| 1 | pages/home（原地重建） | 军情 | flag | 沙盘+调兵 |
| 2 | pages/satchel（新） | 锦囊 | pouch | 报告书架+履历/天时+朱砂点 |
| 3 | pages/profile（瘦身） | 主公 | crown | 档案/钱粮/设置 |

### 军情页：一屏五章（章法排版，非卡片堆叠）

① **玄墨断语卡**（全站唯一深底）：案卷 judgment 大字 `.t-display` + 本命色小印 + 落款；
　未建档空态「军师尚未为你立断。先入帐一叙。」→ counsel。
② **三势**（题眉+三行）：势名印 + 一句结论 + chevron；天→calendar，市/人→已研判开 report 否则 counsel 预填。
③ **今日军令卡**（可操作故有卡）：≤3 条 checkbox 打卡 + 命中能力映射的行显示
　**「去办 · {花名}」按钮** + 底行「回填 · 复盘 · 详」→ studio；空态「军令未立。让军师为你拆一道。」
④ **各线督办**（题眉+行式）：花名 + 最新一句 + 落款 → chat 线程；空则隐藏整章。
⑤ **麾下**（题眉+行式）：五位创作军师（IP打造/宣传片/海报/短视频/文案）+「生态」印 → chat；
　章头「点将 ›」→ roster 点将堂。

### 点将堂（pages/roster，navigateTo 次级页，非 tab）

统帅卡（「你只管提出问题，我决定叫谁上阵。」→ switchTab counsel）+ 出谋八将 + 出活五将（生态印），
行式一种样式（AdvisorAvatar+花名+一句职责+状态/AgentUnlock），数据沿用 council.ts + agents。

### 能力直达机制（生态位地基）

配置 `app/src/data/capabilities.ts` + server 同源常量：
`{ key, label, agentKey, keywords: string[], external?: { type:'miniprogram'|'web', appId?, path?, url? } }`
首批 5 条（ip/promo/poster/shortvideo/copy），keywords 如「宣传片|短片」→promo。
- server：`CasefileOrder` 加可空列 `capabilityKey`；`extractOrders()` 拆军令时按 keywords 打标。
- app：军令行命中 → 「去办 · {花名}」→ 现跳 `pages/chat?agentKey=&send=`；
  external 配置就绪后走 navigateToMiniProgram（届时补 app.config 白名单）或 webview 外跳。
  本次只留分支与空配置位。

### 锦囊页

顶部两卷宗（完整履历→dossier / 全年天时→calendar，唯一横向并列）+ 过滤笺（全部/断语/方案/纪要）
+ 报告折子流（印章字+标题+一行摘要+落款+版本数+朱砂点 → report?id=）。
空态：「帐中尚无锦囊。与军师聊过，锦囊自会出现。」→ counsel。

### 主公页

用户卡（→settings）+ 钱粮卡（合并权益三格，→Plans/credits）+ **细线菜单**（非卡片堆，≤10 行）：
个人档案/我的案卷/资料库/数据源/钱粮明细/战略账本(有数据才显示)/送你一卦/军师社群/本命色/设置
+ 社群卡。删除：经营统计三宫格、深度能力解锁卡、方案库、完整履历、模块管理、
「提醒与日历」「私有化部署」toast 假入口。

### 其余处置

sessions → 历史往来页（counsel 头部「往来」进入，仅历史+搜索）；thinktank 删除；
studio 摘 tab 留为军令详情页（回填/周计划/复盘）；library 保留但主入口撤；
「深度整理」「更多模型」假入口删；**dossier 页收编**：废黑金整页配色（#0a0a2e/#c5a55a/900 字重），
改纸墨+本命色+宋体章法，时间线用 --line/--accent。

### 正典路径

上传资料→对话「+」，管理→主公·资料库；添置模块→点将堂页脚→market；看报告→锦囊；
执行→军情·军令卡（详→studio）；找军师→军情·麾下/点将堂；历史→counsel·往来。

---

## 六、工单与验收

| WO | 范围 | 依赖 |
|---|---|---|
| WO-S | （已完成待测试）入帐状态机+first-read+propose+/counsel/opening；追加：capabilityKey 列+extractOrders 打标+capabilities 常量 | 无 |
| WO-A1 | 设计体系落地（app.scss 字阶/题眉/细线章/印章/落款/墨染/--ink-deep-bg/统一 pill + 圆角字重清理）+ 4-tab IA + 军情五章 + 点将堂 + 主公瘦身 + sessions 收窄 + thinktank 删除 | 与 WO-S 并行 |
| WO-A2 | ChatView 手书体重排 + 选择笺/请缨帖/生辰择色笺/墨染动效/军师执笔 + 入帐流对接 + 回帐一句 + 军令去办按钮 + 朱砂点 | WO-S、WO-A1 |
| WO-V | dossier 收编 + 全站视觉走查对齐 | WO-A1 |

验收（H5 预览逐条截图）：
1. 新用户：登录→称呼→军师先开口→全程点选→（跳过生辰）→择色→自动出《初见断语》→锦囊朱砂点。
2. 老用户：回帐一句 + 选择笺。
3. 总军师 5 轮后请缨帖；「即刻出策」生成报告。
4. 军情五章正确反映对话产物；军令行「去办」按钮跳创作军师。
5. 4 tab 可达全部保留页；无假入口；无 700/900；墨染动效；军师消息无气泡手书体。
