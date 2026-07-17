# [FABLE5] 参谋部 · 原型融合设计规格 v2.0

> 作者：Fable 5 · 2026-07-17
> 依据用户提供的交互原型 `docs/prototype/junshi-app-prototype.dc.html`（军师 App 原型.dc.html）。
> **本稿取代 v1.3「纸墨帅帐」的视觉与 IA。** 原型是简化交互演示，本稿负责把它接到真后端。
> 用户已定夺三事：①保留完整后端套设计稿皮 ②整体照搬直角案卷视觉 ③按 5-tab 融合。
> 实施者**必读原型源码**取每屏精确结构/尺寸/文案：`docs/prototype/junshi-app-prototype.dc.html`。

---

## 0. 融合总则

- 视觉与 IA 照搬原型；**功能/数据/接口全部沿用现有真后端**（入帐状态机 /onboarding、《初见断语》
  first-read、出策请缨 propose、能力打标 capabilityKey、真实报告/档案/军令/命盘）。
- 原型的 mock 数据（咖啡馆案例、假 convos/versions/tasks）只作视觉参照，**一律换成真实接口数据**。
- 宋体保留（原型已用 `'Noto Serif SC','Songti SC',serif`，与现有 --serif 一致）。
- 本次是「推倒重绘」：上一版 v1.3 的圆角纸墨体系被直角案卷体系取代（含 --r-* 语义翻新）。

---

## 1. 设计语言 · 直角案卷（tokens 见原型 `:root` 与 renderVals 的 N 对象）

### 1.1 颜色令牌（app.scss / app.h5.scss 全量替换）

浅色（默认）：
```
--bg:#F0EBE0  --surf:#FAF7EF  --surf-2:#EFE9DB  --surf-3:#E3DBC9
--hair:rgba(34,32,27,.13)  --hair-2:rgba(34,32,27,.24)
--ink/--tx:#211F1A  --mut:#6B6456  --faint:#A79E8C  --onac:#FAF7EF
舞台底:radial-gradient(ellipse 1000px 760px at 50% -8%,#F7F2E7 0%,#E8E1D2 62%)
```
深色（跟随系统/主题，原型 N.dark）：
```
--bg:#1C1A16 --surf:#252219 --surf-2:#2E2A20 --surf-3:#3A352A
--hair:rgba(240,235,223,.11) --hair-2:rgba(240,235,223,.2)
--tx:#F0EBDF --mut:#A59C8B --faint:#6E6656
```
保留现有令牌名兼容（--ink=--tx、--line=--hair、--paper=--surf 等做别名映射），避免全站改引用。

### 1.2 本命色（6 枚，替换 app/src/data/colors.ts；每枚含 hex/acd/acg/name/motto）

| key | name | hex | acd | motto（军师批语用） |
|---|---|---|---|---|
| song | 松 · 谋 | #2F5D50 | #1E3E35 | 稳中求进，守正出奇 |
| hu | 琥 · 势 | #B0782A | #7A5216 | 聚财为势，顺势而为 |
| dan | 丹 · 决 | #BC4A31 | #83301F | 当机立断，先发制人 |
| dian | 靛 · 远 | #38516E | #26374C | 高瞻远瞩，谋定后动 |
| yao | 曜 · 局 | #6E4A66 | #4B3145 | 格局为先，纵横捭阖 |
| shuang | 霜 · 藏 | #3F6B67 | #294845 | 大巧若拙，藏锋于鞘 |
`--ac`=hex、`--acd`=深、`--acg`=hex@~.12 glow。选色即换全局 --ac/--acd/--acg（沿用现有 theme 注入机制，
但改为直接注入 hex 三件套，与原型一致；现有 6 主题 class 机制可保留做兜底）。
现有 colors.ts 与后端 benmingColor 的 key 若不同（如 green/gold…），**做 key 映射表**（song↔green 等），
不改后端存储值，只在前端展示层映射到新 name/motto/hex。

### 1.3 直角与形状

- **近直角**：按钮/输入 `border-radius:2px`；卡片/面 0–2px。翻新 --r-sm/md/lg 全部压到 2px（或直接弃用改写）。
  圆形元素（头像、色环、雷达点、进度环、check）保持 50%。
- 卡片 = `var(--surf)` 面 + `1px solid var(--hair/-2)` 描边，无阴影（弹层/手机壳除外）。
- **左强调边**：关键卡 `border-left:3px solid var(--ac)`（主要矛盾、军令任务、预言）。
- **顶强调边**：置顶/入口卡 `border-top:3px solid var(--ac)`（总军师卡、弹层、coach）。

### 1.4 标志性元素（做成可复用组件/样式类）

- **水印巨字**：页头右侧 `font-weight:900;opacity:.06~.1;font-size:88~130px;color:var(--ac)` 的单字
  （问策=谋 军情=势 军令=令 锦囊=囊 主公=公）。绝对定位、pointer-events:none。
- **CJK 序数**：壹贰叁肆伍陆（入帐行业列表、下一步）。
- **字距按钮**：主行动按钮文字每字间空格 + `letter-spacing:.2~.24em`，实底 --ac，2px 角。
- **三势雷达**：SVG 三角 polygon（原型 junqing 段有完整 SVG + radarPoints 算法，直接移植）。
- **算力环**：SVG circle stroke-dasharray 进度环（原型 zhugong 段，powerDash 算法移植）。
- **打字揭示**：军师首判逐字（原型 pickIndustry 的 _typer，38ms/2字）。
- **动效**：fadeUp/fadeIn/popIn/drawRule/blink/caret/slideUp（原型 keyframes 全移植），
  统一 ease `cubic-bezier(.16,1,.3,1)`。

### 1.5 字阶（沿用原型行内值，抽象成类）

标题 30px/600、大数 34–56px/600、正文 14–18px/1.7–2.1、题眉 kicker 12px/`letter-spacing:.24~.4em`/--ac、
落款/faint 10.5–12px。字重仍 ≤600（原型水印字 900 是**唯一例外**，仅装饰水印用，不算正文）。
→ WO-V 的「全站 ≤600」放行水印字这一处 900。

---

## 2. 信息架构（5 tab）

底栏 5 tab（原型 navDef 顺序）：问策 zhance / 军情 junqing / 军令 junling / 锦囊 jinnang / 主公 zhugong。
底栏样式见原型：`--surf` 底、顶 hairline、选中态 16px 短横 bar + --ac 字加粗、字号 16px 字距 .08em。
落地页 = 问策。

**现有页面 → 新 IA 映射**（现在是 counsel/home/satchel/profile 4-tab + roster/sessions 次级）：

| 新 tab | 页面 | 现有来源 → 处置 |
|---|---|---|
| 问策 zhance | pages/counsel（改造） | 融合 counsel(总军师对话) + sessions(名录) + roster(专业军师)。一屏：总军师置顶卡（统筹/未读数/主要矛盾预览）+「专业军师·分线出策」名录（真实 agents/council.ts）；点任一军师**就地展开 thread**（内嵌 ChatView）。**点将/往来两个次级页取消**（名录并入本页；历史会话入口降为本页顶部小入口或先不做）。 |
| 军情 junqing | pages/home（重绘） | 主要矛盾 hero + 三势雷达 + 下一步就做/现在别做 双栏 + 拆军令 CTA。 |
| 军令 junling | pages/junling（新建或由 studio 改造回 tab） | 独立 tab 回归。done/total 双格 + 今日战役任务卡（打卡/回填）+ 督战。原 studio 的回填/周计划/复盘作次级。 |
| 锦囊 jinnang | pages/satchel（重绘） | 四宫格库（资料库/方法论/历次报告/创作成品）+ 方案 v1→v7 版本时间线。 |
| 主公 zhugong | pages/profile（重绘） | 档案卡 + 算力环 + 三行统计 + 本命色换色 + 彩蛋列表（送你一卦/天时日历/天机记账 弹层）。 |

navigateTo 次级页保留：projects/project/report/knowledge/bindings/market/dossier/credits/settings/brief/studio 详情。
彩蛋 gift/calendar/ledger 由独立页改为**主公内弹层**（modal），复用其数据接口。

---

## 3. 逐 tab 结构与真数据接线（结构照原型对应 sc-if 段）

### 3.1 问策 zhance（原型 isZhance 段）
- **noThread 态**：总军师置顶卡（顶 3px --ac 边）——「师」圆像 + 总军师 + 统筹 pill + 未读数圆点 +
  虚线下 `conflictPreview`（真实：取当前案卷 judgment/主要矛盾）。点击→展开总军师 thread。
  下方「专业军师·分线出策」名录（真实 council.ts + store.agents()，头像用 AdvisorAvatar，
  ini 首字 + role + 最新一句 preview）。点击→展开该军师 thread（未启用付费军师仍走 AgentUnlock）。
- **hasThread 态**：返回问策 + 内嵌 **ChatView**（现有组件，含流式/报告卡/选择笺/请缨帖/引用/上传）。
  原型的简化气泡换成真 ChatView；保留原型的「军师无气泡手书」不必强求，以 ChatView 现状为准，
  但气泡圆角改 2px 案卷风（14px→2px），配色对齐新令牌。快捷追问 chips 用 --ac 描边 2px。
- 融合注意：这是把 counsel+sessions+roster 三者并一屏，删掉点将 tab 逻辑与 sessions 独立页主入口。

### 3.2 军情 junqing（原型 isJunqing 段）
- **今日主要矛盾**卡：水印「势」+ 题眉 + 左 3px 边大字 = 真实案卷 judgment/主要矛盾（GET /casefile）。
- **三势研判**：SVG 雷达（radarPoints 算法移植）+ 右侧三条 meter（天势/市势/人势）。
  真数据来源：understanding.forces（shishi/tianshi/renshi 结论与分值）；无分值时给确定性兜底占位并标「待研判」。
  点雷达/meter 可下钻（天势→calendar 弹层，市/人→report 或 counsel 追问）。
- **下一步就做**（真实：案卷 orders 或 understanding.nextSteps）/ **现在别做**（真实：casefile risksJson）双栏。
- **拆军令 CTA**→ switchTab 军令。
- 空态（未建档）：引导入帐。

### 3.3 军令 junling（原型 isJunling 段）
- done/total + 战役进度% 双格（真实：GET /casefile 的 orders 当日完成数）。
- 今日战役任务卡：checkbox 打卡（PATCH /casefile/orders/:id）、who/due/est 元信息、
  完成盖「已办」章、点开**数据回填**内联输入（PUT /casefile/backfill 或现有回填接口）。
  **军令带 capabilityKey 者**：卡内加「去办 · {花名}」按钮（navigateTo chat?agentKey=&send=，
  external 就绪后外跳）——沿用 v1.3 能力直达，融进原型任务卡。
- 总军师督战卡（marshalNote：确定性文案或 understanding 派生）。

### 3.4 锦囊 jinnang（原型 isJinnang 段）
- 四宫格库：资料库（knowledge 数量）/方法论（market 模块或框架数）/历次报告（reports 数）/创作成品（创作类产出数）。
  点击→各自 navigateTo（knowledge/market/library-or-satchel-list/…）。**保留** v1.3 的「完整履历/全年天时」两卷宗
  可并入本宫格或置顶。
- 方案版本时间线：真实某案卷/报告的版本链（reports.ts saveReportVersion 的版本，v1→vN），
  时间线点 + 版本号 + 摘要 + 日期。点击→report?id=&version=。
- 未读朱砂点仍在锦囊 tab（沿用 store.lastSeenReportAt）。

### 3.5 主公 zhugong（原型 isZhugong 段）
- 档案卡（顶 3px 边）：头像「主」+ 称呼 + 行业 + 会员 pill（真实 user + plan）。→ settings。
- 算力环 + 三行统计（本月算力%=真实额度、案卷数、在役军师数、连续经营天数）。
- 本命色换色排（6 色圆环，真实 setColor 全局换 --ac）。
- **彩蛋**三行 → 弹层：送你一卦（gift 数据/canvas）、天时日历（calendar 12 月攻守）、天机记账（ledger 预言对账）。
  合规总开关说明保留（命理类）。
- 现有 profile 菜单（个人档案/案卷/资料库/数据源/钱粮/社群/设置等）**收进本页**：可作彩蛋下方的细行菜单，
  或整合进算力卡下的入口区。不要丢功能，但按原型减到清爽。

---

## 4. 入帐引导（保留完整后端 + 套设计稿皮，原型 splash/color/industry/judge 段 + coach）

顺序（融合：本命色提前，保留后端全部采集）：
1. **splash**（原型）：军师大字 logo + 装进微信里的AI商业参谋部 + 出谋/出活 + 「请 主 公 落 座」。
2. **择本命色**（原型 color 段）：6 色 2 宫格 + 选后「军师批曰」批语（motto 派生）+ 落定下一步。
   → 写 User.benmingColor（现有 /onboarding advance color 步骤，调整为第一步）。
3. **行业**（原型 industry 段）：壹贰叁数字列表。→ /onboarding advance industry。
4. **阶段 / 痛点 / 生辰**：**保留**（原型没有，但用户选「保留完整后端」）。用原型同款视觉续接
   （题眉「叁/肆/伍」+ 选择笺/内嵌生辰笺），走 /onboarding 后续 stage/pain/bazi 步骤；生辰可跳过。
5. **军师首判**（原型 judge 段）：打字揭示 → 主要矛盾高亮 → 「进入参谋部」。
   融合：这里触发/串接真实 **FORGE→《初见断语》**（/onboarding result 轮询）；首判打字文案可取初见断语摘要，
   完整报告落锦囊并亮朱砂点。
6. **进 App + coach marks**（原型 COACH 五步）：五步点亮导览（问策/军情/军令/锦囊/主公各一句，原型 COACH 文案可直接用）。
   仅首次入帐后展示，跳过即止；本地记 flag。

onboarded 判据仍是 Profile 行存在（不改后端）。文案：入帐问句沿用 v1.3 §3.3 军师语声，
splash/coach 用原型文案。

---

## 5. 工单与顺序

**Phase 1 · 地基（一个 Opus agent，串行先行）** WO-F：
- app.scss/app.h5.scss 令牌全量替换为原型直角案卷体系（颜色/直角/水印/字距/动效 keyframes/深色）+ 令牌别名兼容。
- data/colors.ts 替换为 6 本命色（hex/acd/acg/name/motto）+ 与后端 benmingColor key 映射表。
- 抽可复用件：水印巨字类、字距按钮类、CJK 序数、三势雷达组件、算力环组件、案卷卡基类、题眉类。
- IA 骨架：app.config + custom-tab-bar 回 5-tab（问策/军情/军令/锦囊/主公），军令 tab 挂载点就位。
- build:h5 + build:weapp 绿。产出「可复用件清单 + 令牌对照表」供 Phase 2。

**Phase 2 · 分页重绘（Phase 1 完成后，2-3 个 Opus agent 并行，文件不重叠）**：
- WO-P1：问策（counsel 融合 sessions+roster）+ 入帐引导（splash/color/industry/…/judge/coach，接 /onboarding）+ ChatView 案卷化微调。
- WO-P2：军情（home 重绘：主要矛盾/三势雷达/双栏/拆军令）+ 军令（junling tab：任务卡/回填/督战/能力去办）。
- WO-P3：锦囊（satchel 重绘：四宫格+版本时间线）+ 主公（profile 重绘：档案/算力环/本命色/彩蛋弹层，接 gift/calendar/ledger）。

**Phase 3 · 验收（Sonnet）**：build 双端 + H5 真后端走查全流程截图（入帐→五 tab→彩蛋）+ grep 终检 + 分批 commit。

验收要点：直角案卷视觉到位（水印/雷达/算力环/字距按钮/2px 角）；5-tab 可达；入帐保留阶段/痛点/生辰且出《初见断语》；
问策名录+就地 thread；军令能力去办；彩蛋三弹层接真数据；宋体；深浅色。
