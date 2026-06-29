# 军师 · 天势终极版 V6.0 — 重构实施方案（PR 级拆解）

> 配套阅读：`docs/V6_DIAGNOSIS_AND_REFACTOR.md`（文档解读 × 现状诊断）。本文是其落地版。
> 决策基线（已拍板）：
> - **1A 产品形态**：V6.0 单一常驻军师为**主线/主角**；原 13 个 agent 降级为军师可调用的**专项能力**。计费转**订阅制**（日复盘留存闭环必须免费）。
> - **2B 命理合规**：八字/预言/命中率**明着做**，保留完整命理引擎（不弱化）。
> - **3A 交付**：先出本实施方案。

---

## 0. 总体架构目标

把"一段活在生产 DB 的 41k 字 prompt"变成"**一个有结构化状态的常驻军师**"：

```
采集(八字/营收/痛点)
   → 确定性引擎(排盘/天势)算出命盘+流年        ← 代码算，不让模型算
   → 统一状态层 StrategicArchive(命盘/决策日志/预言/复盘/段位/看板)
   → 每轮: context 注入结构化块 → 模型只"翻译成比喻/做战略映射/行文"
   → 产出: 分型交付物(A级报告 + 12种B级卡片)
   → 会话结束: summarizer 自动写回状态层(无需复制粘贴)
   → 调度器: 到期验证预言 / 久不复盘提醒 / 里程碑·章节更新
```

### 设计铁律（贯穿所有 PR）
1. **算→存→注入，模型只行文**：一切数字与命理/历法运算在代码里算好、落库、再以结构化块注入 prompt；prompt 明确禁止模型自算八字、自数天数、自报命中率。
2. **数字先做真，UI 晚于数据**：任何展示连续天数/命中率/段位的卡片/徽章，必须等其服务端来源就绪后才上线。
3. **单一状态聚合**：所有跨会话状态收敛到一个 `StrategicArchive` 聚合（与既有 `Memory`/`GraphEntity` 协调），不散成 N 张孤立表、N 个注入块。
4. **真实模型门槛**：所有 V6 行为只在真实 provider（Claude）下成立；`mock` 仅用于无关 UI 走查。V6 的 eval 必须跑真模型。

---

## 1. 工作流总览（依赖图 + PR 清单）

```
横切(随时): PR-0a 禁用词lint   PR-0b V6 eval

Phase1 地基 ── PR-1 命理引擎 ─┬─ PR-2 八字采集UI
                              ├─ PR-5 身份重构(V6主军师+prompt入仓)
              PR-3 状态层 StrategicArchive ─ PR-4 调度器
              PR-6 订阅计费

Phase2 核心(依赖 P1) ── PR-7 决策日志 ─┐
                        PR-8 六层复盘  ─┼─ PR-9 预言验证 ─ PR-10 段位/里程碑
                                        ┘
Phase3 编排(依赖会话状态) ── PR-11 路由 ─ PR-12 十二问状态机
                            PR-13 营收分阶段   PR-14 内在状态→语气
Phase4 呈现(依赖 P1-3 数据) ── PR-15 卡片分型 ─ PR-16 看板
                              PR-17 叙事线/仪式   PR-18 前端复盘/段位/命盘页
                              PR-19 行业库结构化
```

| PR | 标题 | 阶段 | 依赖 | 规模 |
|---|---|---|---|---|
| 0a | 禁用词 output-lint | 横切 | — | XS |
| 0b | V6 专项 eval 用例 | 横切 | 随对应功能 | S |
| 1 | 确定性命理引擎 + BaziChart | P1 | — | L |
| 2 | 八字采集 UI + 接口 | P1 | 1 | M |
| 3 | 统一状态层 StrategicArchive + 写回闭环 | P1 | — | L |
| 4 | 调度器 | P1 | 3 | M |
| 5 | 身份重构：V6.0 为主军师 + prompt 入仓 SSOT | P1 | 1 | M |
| 6 | 订阅计费迁移 | P1 | 5 | M |
| 7 | 决策日志 + 准确率 | P2 | 1,3 | M |
| 8 | 六层复盘 + 对齐率 + streak | P2 | 3,4 | L |
| 9 | 预言验证 + 命中率 | P2 | 1,3,4 | M |
| 10 | 段位/里程碑/上瘾 (UserProgress) | P2 | 7,8,9 | M |
| 11 | Session.mode + 意图分类器路由 | P3 | 3 | M |
| 12 | 十二问/六轮状态机 | P3 | 3,11 | M |
| 13 | 营收分阶段 | P3 | 3 | S |
| 14 | 内在状态→角色语气 | P3 | 3,11 | S |
| 15 | 交付物分型 cardType/grade + 渲染注册表 | P4 | — | L |
| 16 | 数据看板（三层） | P4 | 3,13,15 | L |
| 17 | 命运叙事线/谶语 + 仪式页 | P4 | 1,3,4,15 | M |
| 18 | 前端复盘/段位/命盘页 | P4 | 8,10,2,15 | L |
| 19 | 行业库结构化（美业/大健康拆分） | P4 | — | M |

---

## 2. 逐 PR 详细规格

> 约定：路径以仓库根为基；Prisma 片段为示意（字段名以最终 review 为准）；每个 PR 末尾给**验收标准**。

### 横切

#### PR-0a · 禁用词 output-lint（XS，零依赖快赢）
- **服务**：`server/src/services/moderation.ts` 增 `checkTone(text)`，常量 `BANNED_TONE_WORDS = [赋能,抓手,底层逻辑,颗粒度,范式转移]`（来自 §17）。非阻塞。
- **接入**：`server/src/llm/gateway.ts` 在 `moderate('output')` 之后调用；命中写 `ModerationLog(refType:'tone', detailJson.hits)`，可选做一次受控改写。
- **验收**：构造含禁用词的产出，`moderation_log` 出现 `refType='tone'` 记录；不阻断正常回复。

#### PR-0b · V6 专项 eval 用例（S，随功能补）
- **数据**：`server/prisma/seed.ts` 播种 `EvalSet "v6-behaviors"` + `EvalCase`：缺时辰、不信命理（§16 降级）、禁用词、命盘一致性（同八字两次排盘一致）。
- **验收**：`evals.ts judge()` 能对上述用例打分；CI 可跑（真模型）。

---

### Phase 1 — 地基

#### PR-1 · 确定性命理引擎 + BaziChart（L，解锁一切）
- **依赖库**：新增 `lunar-javascript`（或 `tyme4ts`）做干支历+真太阳时；`iztro` 做紫微。（`package.json` 当前无任何此类依赖。）
- **服务**：新增 `server/src/services/bazi.ts`：
  - `computeChart(input: {gregorianDob, hour|时辰, gender, birthplace, lon?}) → BaziChart`：年/月/日/时柱、日主五行强弱、十神格局、袁天罡称骨、紫微主星、大运(起运岁+每步10年干支+走势)。
  - 真太阳时按出生地经度+均时差修正。
- **服务**：新增 `server/src/services/tianshi.ts`：`monthlyScan(chart, year) → [{month, 用神/忌神, tag: 攻|防|拐点, keyword}]`；`daYunTimeline(chart)`。
- **数据模型**（`schema.prisma`）：
  ```prisma
  model BaziChart {
    id String @id @default(cuid())
    tenantId String
    userId String @unique
    gregorianDob DateTime
    hourBranch String?   // 时辰；null=缺时辰
    gender String
    birthplace String?
    lon Float?
    yearGZ String; monthGZ String; dayGZ String; hourGZ String?
    dayMasterWuxing String; strength String   // 身强/身弱/从格
    geju String          // 十神格局：正官/七杀/偏财/食神…
    chenggu String?      // 称骨几两
    ziweiMain String?
    daYunJson Json       // 大运时间线
    computedAt DateTime @default(now())
    engineVersion String
  }
  ```
- **Prompt**：改写 §4.2 由「内部完成推演」→「**使用系统提供的【命盘】排盘结果，禁止自行排八字/大运/流年；你只做命格×战略映射与比喻翻译**」。
- **注入**：`server/src/llm/schema.ts buildSystemParts` 增结构化【命盘】块（仅在 strat/主军师且 chart 存在时）。
- **验收**：对已知正确八字（用 `dossier.seed.md` 的 `乙丑 庚辰 丙午 戊戌` 校验），引擎输出四柱/格局/大运稳定一致；`tianshi.monthlyScan` 给出 12 月攻/防/拐点标注。

#### PR-2 · 八字采集 UI + 接口（M）
- **前端**：扩展 `app/src/components/Picker/index.tsx`（或新建 `app/src/pages/birthchart`）增 阳历/阴历日期 + 时辰(可"不确定") + 性别 + 出生地。当前 **0 个此类输入**。
- **接口**：新增 `POST /api/profile/bazi`（`server/src/routes/profile.ts`）→ 调 `bazi.computeChart` 落 `BaziChart`。
- **入口**：首登问卷流（§4.1 第1轮）与"送你一卦"（§11.4）都复用此采集组件。
- **缺时辰**：`hourBranch=null` 时，前端提示"先用年月日做基础分析"，并写回 `chart` 标记，供 prompt 走 §16 降级分支。
- **验收**：新用户走完采集 → `BaziChart` 落库 → 下一轮对话 prompt 含【命盘】块；缺时辰路径不报错且有降级提示。

#### PR-3 · 统一状态层 StrategicArchive + 写回闭环（L）
- **数据模型**：新增聚合根（与 `Memory`/`GraphEntity` 协调，避免重复）：
  ```prisma
  model StrategicArchive {
    id String @id @default(cuid())
    tenantId String; userId String @unique
    mainConflict String?      // 主要矛盾(一句话)
    positioning String?       // 战略定位
    focusTrack String?        // 聚焦赛道
    threeStepStage String?    // 三步走当前阶段
    narrativeArcId String?    // → NarrativeArc(PR-17)
    updatedAt DateTime @updatedAt
  }
  ```
  （决策日志/预言/复盘/段位/KPI 各自建表，见后续 PR，统一通过 `userId` 关联，由 archive 作为读取入口。）
- **写回闭环**：新增 `server/src/services/archive.ts`：`persistArchiveSummary(sessionId)`——在会话结束/`summarize` 时，从结构化记录(决策/预言/复盘/streak/段位/命盘) **自动重生成**【战略档案摘要】并落库；**替代** §9.2 现状的"让老板复制粘贴"。
- **注入重构**：`server/src/services/understanding.ts:172-183` 由"逐字塞 6000 字 dossier 文本"改为"**从结构化记录渲染**【战略档案】块"；保留 `extraJson.dossier` 仅作迁移兼容（一次性导入后弃用）。
- **接入**：`sessions.ts` 在 `learnFromConversation` 旁挂 `archive.persistArchiveSummary`。
- **验收**：跑完一轮含决策的对话 → 不手动粘贴 → 下次新会话开局 prompt 已带上次的主要矛盾/决策/命盘；`PUT /profile` 不再能整块冲掉档案。

#### PR-4 · 调度器（M）
- **实现**：引入 `node-cron`（或 DB 轮询的 reminder 队列，单实例够用）。新增 `server/src/services/scheduler.ts`，在 `server/src/index.ts` 启动。
- **作业**：① 久不复盘提醒（依赖 PR-8 streak）；② 预言到期翻 `pending`（依赖 PR-9）；③ 里程碑/章节更新触发（依赖 PR-10/17）。先搭框架，作业随对应 PR 接入。
- **推送**：复用 `server/src/services/wechat.ts`（小程序订阅消息）/ `sms.ts`。
- **验收**：调度器随服务启动，能按配置周期扫描并打点日志（作业空实现也要可观测）。

#### PR-5 · 身份重构：V6.0 为主军师 + prompt 入仓 SSOT（M）
- **prompt 入仓**：以 `server/src/data/prompts/strat.v6.md` 为**源**，`server/prisma/seed.ts` 把它 seed 进**主军师 agent 的 `systemPrompt`**（终结"仅生产 DB、3 行 stub"现状）。
- **主角化**：`server/src/data/agents.ts` 把 V6.0 prompt 绑到默认/首屏 agent（`general` 升级为天势军师，或令 `strat` 成为默认主线）；原 8 顾问 + 5 工坊降级为**军师可调用的专项能力**（作为 tool / 子能力，而非首屏并列市场）。
- **前端 IA**：`app/src/app.config.ts` + `custom-tab-bar`：以单一军师对话为主轴；"智库/工坊"收进军师内的"专项能力"入口（保留页面，弱化为二级）。
- **验收**：仓库 `db:seed` 后，默认进入即是 V6.0 天势军师（真模型下能走 §6 第1轮开场+八字采集）；prompt 改动走 git/CI 可见。

#### PR-6 · 订阅计费迁移（M）
- **模型**：`Plan` 增 `kind: subscription`；`entitlements.ts` 增"订阅期内主军师全链路（含日/周/月复盘、决策日志、预言、段位）**免计费**"。
- **保留按次**：仅**重产出**（工坊：宣传片/海报/短视频等）继续走 `credits/metered`（💎xN/次），与留存闭环解耦。
- **前端文案**：沿用 PRODUCT.md 口径（可用/已启用/方案与额度），新增"订阅"表达；移除让日复盘"按条扣费"的路径。
- **验收**：订阅用户连续多日复盘不扣 💎；工坊重产出仍按次计费；`CreditLedger` 记录正确。

---

### Phase 2 — 有状态核心（数字先做真）

#### PR-7 · 决策日志 + 准确率（M）
- **模型**：
  ```prisma
  model DecisionLog {
    id String @id @default(cuid())
    tenantId String; userId String; seq Int
    date DateTime; scene String        // 复盘/紧急/规划
    decision String; rationale String
    celestialRef String?               // 天势参考
    expected String; verifyCriteria String; verifyPeriod String
    status String                      // pending|correct|needs_fix
    speed String                       // fast|slow
    verifiedAt DateTime?; outcome String?
  }
  ```
- **接口/服务**：`POST/PATCH /api/decisions`；`decisionStats(userId) → {accuracy, fastAccuracy, slowAccuracy}`（§9.3，由 status 计数得出，非模型叙述）。
- **LLM 工具**：`server/src/llm/schema.ts` 增 `emit_decision` tool，模型做决策时写结构化行而非散文。
- **注入**：近期决策 + 准确率进【战略档案】块。
- **验收**：模型产出决策 → `DecisionLog` 落库并自增 seq → 月复盘时准确率由代码计算返回。

#### PR-8 · 六层复盘 + 对齐率 + streak（L，核心留存）
- **模型**：
  ```prisma
  model Review { id String @id @default(cuid()); tenantId String; userId String
    mode String; periodKey String; createdAt DateTime @default(now()) }
  model ReviewItem { id String @id; reviewId String; text String
    done Boolean; alignedToMainConflict Boolean; strategicValue String? }
  model ReviewStreak { userId String @id; current Int; longest Int; lastReviewDate DateTime }
  ```
- **服务**：`server/src/services/review.ts`：`对齐率 = aligned/total`（服务端算）；`advanceStreak()`（断签按 §16 重置/递减）。
- **路由**：`server/src/routes/reviews.ts`：`POST /reviews`、`GET /reviews/streak`、`GET /reviews/timeline`。
- **触发词路由**：把 今天|6件事→daily、这周|周报→weekly、月度→monthly、季度|Q[1-4]→quarterly、年度|年终→yearly、团队|人员→team 接进 PR-11 的分类器（先用关键词兜底）。
- **调度**：PR-4 接入"久不复盘提醒"。
- **验收**：提交 6 件事 → 对齐率/streak 由服务端算并落库；连续两日复盘 streak=2；隔日不复盘触发提醒。

#### PR-9 · 预言验证 + 命中率（M，上瘾核心）
- **模型**：
  ```prisma
  model Prophecy { id String @id @default(cuid()); tenantId String; userId String; seq Int
    content String; basis String; verifyCriteria String; verifyDueAt DateTime
    verdict String                     // pending|hit|miss
    verifiedAt DateTime?; evidence String?; sourceMessageId String? }
  ```
- **服务/路由**：`server/src/routes/prophecy.ts`（create/list/verify）；`hitRate = hits/(hits+misses)` 按窗口聚合（§4.8）。
- **LLM 工具**：`emit_prophecy`（模型做八字判断时写行）。
- **调度**：PR-4 到期把 `pending` 标记为待验证，月/季复盘时引导确认。
- **验收**：预言落库带 `verifyDueAt`；到期被调度器挑出；命中率由代码聚合（绝不让模型报数）。

#### PR-10 · 段位/里程碑/上瘾 UserProgress（M）
- **模型**：
  ```prisma
  model UserProgress { userId String @id; firstUseAt DateTime
    currentStreak Int; longestStreak Int; lastReviewDate DateTime?
    rank String; milestonesJson Json }  // rank: 新兵/尉官/校官/将军/元帅
  ```
- **服务**：`progress.ts`：`deriveRank()` 按 §11.2 门控（14天→尉官；30天+首份月报→校官；90天+准确率>60%→将军；180天+准确率>70%+命中率>50%→元帅），消费 PR-7/8/9 真实指标；`checkMilestones()` 按 firstUseAt+7/30/90/180/365。
- **接口**：`GET /api/me/progress`。
- **调度**：里程碑解锁触发推送/晋升卡（卡片走 PR-15）。
- **验收**：段位/里程碑只在真实指标达标时变化；绝不出现"连续复盘 47 天"而无 streak 支撑的文案。

---

### Phase 3 — 编排与适配

#### PR-11 · Session.mode + 意图分类器路由（M）
- **模型**：`Session` 增 `mode`（onboarding|tianshi_sketch|review_*|emergency|exploration|team_match|timing|divination|empower|milestone）+ `routeStateJson`。
- **服务**：`server/src/services/router.ts`：`classifyEntry(text, sessionState)`（一次廉价结构化 small-model 调用，关键词兜底），替代 `KEY2AGENT` 精确串匹配（自由句"这周复盘/帮我算一卦"现在会落 `general`）。
- **注入**：当前模式 + 本轮要做的事进 prompt 动态块。
- **验收**：输入"这周复盘"进 review_weekly；"帮我算一卦"进 divination；模式跨轮保持（写 `Session.mode`）。

#### PR-12 · 十二问/六轮状态机（M）
- **模型**：`Session` 增 `flowMode`(full6|fast3|survival)、`currentRound`、`interviewJson`({12问: asked/answered/summary})。
- **服务**：`context.ts buildGenContext` 推进轮次并注入【对话进度】块（当前轮/剩余十二问/模式）；post-turn 更新器写回。
- **Prompt**：插 `{当前轮次}/{已答十二问}/{流程模式}` 占位（当前 0 占位符），按 §6 脚本确定性选轮。
- **修复**：解决 `HISTORY_TURNS=8` 截断导致六轮丢位。
- **验收**：六轮流程不重复发问、不早产报告；快/慢通道由 flowMode 决定而非模型猜。

#### PR-13 · 营收分阶段（S）
- **采集**：`app` 问卷 + `seedConfig` 用**营收**替换"融资轮次"；`Profile.annualRevenue`(万元)。
- **服务**：`deriveStage(revenue) → 生存|起步|成长|扩张`（<100/100-500/500-5000/>5000 万）；注入【阶段适配】块（轮次/八字深度/看板布局约束，见 §7）。
- **验收**：生存期用户不会拿到完整六轮全案；阶段枚举落库供看板 gate。

#### PR-14 · 内在状态→角色语气（S）
- **模型**：`Session` 增 `innerState`（survival_anxiety|growth_excitement|management_pain|bottleneck|meaning）+ `lastClassifiedAt`。
- **服务**：`innerState.ts` 分类器（每轮用户消息，关键词+情感或一次 small-model）。`schema.ts` 把语气行由 `BENMING_TONE`（现由本命色决定）改为 `ROLE_VOICE[innerState] → {role:教官/参谋长/大哥/战略家/师父, toneLine}`；本命色回归"纯品牌色"。
- **前端**：`app/src/pages/chat` 头部显示当前角色，使切换可感知。
- **验收**：焦虑文本 → 师父语气；增长兴奋 → 参谋长；跨会话延续上次 innerState 不突变。

---

### Phase 4 — 呈现与外化

#### PR-15 · 交付物分型 cardType/grade + 渲染注册表（L）
- **契约**：`shared/contracts.d.ts` 的 `Deliverable` 增 `cardType`（report_A | daily/weekly/monthly_report | quarterly_review | yearly_milestone | team_power | positioning_onepager | twelve_q_diagnosis | emergency_decision | tianshi_calendar | fate_sketch | promotion | personality_manual）+ `grade`('A'|'B') + 每卡 `fields` 对象。`Deliverable/ReportDoc` 同步加列。
- **工具**：`emit_deliverable`(schema.ts) 增 `cardType` + 类型化 `fields`（如 promotion → {newRank, reviewStreak, decisionAccuracy}）。
- **渲染**：`server/src/services/reportHtml.ts` 由单一 `renderReportHtml()` 重构为**按 cardType 的渲染注册表**（`renderTianshiCalendar/renderPromotion/renderFateSketch/...`），共用金/衬线/印章基座 CSS——**从 Notion 原页还原被删的 12 种卡片骨架**。
- **前端**：`app/src/components/ReportCard` 按 cardType 分型（或新增专属组件）。
- **数据依赖闸门**：含量化字段的卡（晋升卡/月度战报命中率/天时日历攻防月）必须读 PR-1/8/9/10 的真实来源，否则不渲染数字。
- **验收**：天时日历卡 ≠ 晋升卡 ≠ 战略诊断报告 的版式；量化字段来自真实表。

#### PR-16 · 数据看板（三层）（L）
- **模型**：`KpiMetric`(key,label,unit,stageScope,targetValue,direction) + `KpiSnapshot`(metricId,periodStart,value,source) + `HealthScore`(dimension:营收|客户|产品|团队|品牌, score0-100, period)。
- **服务**：`dashboard.ts` 聚合三层；趋势(↑↓→)按相邻期 diff；战略健康度由五维派生；检测"某 KPI 连续 2 周下降→追溯"事件（§13 天势联动）。
- **路由/前端**：`GET /api/dashboard`（按阶段过滤）+ `POST /api/dashboard/kpi`；新增 `app/src/pages` 看板页（态势总览 + KPI 卡带趋势箭头 + 五维雷达）。阶段适配布局 gate 在 PR-13 的 stage 枚举。
- **验收**：录入 KPI → 趋势/健康度由代码算；连续 2 周下降触发追溯事件；生存期 3 指标、成长期完整三层。

#### PR-17 · 命运叙事线/谶语 + 仪式页（M）
- **模型**：`NarrativeArc`(userId,currentChapter,premiseText,daYunStoryJson,businessRoleText) + `NarrativeChapter`(arcId,chapterNo,summary)；`Prophecy` 复用 PR-9 表存年度谶语（与预言验证共用，§4.4「事后神准」靠**存同一句谶语**再现）。
- **服务**：`narrative.ts`：出 A 级报告时抽取/落库谶语+叙事线（或由 PR-1 命盘种子生成）；注入**存储值**而非每次重生成。
- **调度**：PR-4 按 install-date 触发 180 天/年度"章节更新"（§4.3）。
- **前端**：命运叙事线时间线（章节卡）+ 可分享"天命速写卡"（裂变入口）+ 开局/授旗/年度复盘仪式页。
- **验收**：数月后再开仍能复述**同一句谶语**与"现在第几幕"；章节更新是 append 而非重写。

#### PR-18 · 前端复盘/段位/命盘页（L）
- **页面**：`app/src/pages` 增 ① 复盘入口（6 件事输入 + 对齐率读数）；② 段位/里程碑卡（streak + rank 徽章 + 下一里程碑进度，喂 `GET /me/progress`）；③ 命盘页（读 BaziChart：命格速写/性格操作手册/天时日历）。
- **验收**：三页数据均来自真实接口；无任何"假数字"占位。

#### PR-19 · 行业库结构化（M）
- **扩展**：`server/src/data/industryPacks.ts` 的 `IndustryPack` 补 §8 八字段（行业速写/典型主要矛盾/关键成功因素/典型陷阱/势的方向/AI机会/typed kpis）+ 深度字段（决策链/标杆案例 榕树家·瑞斯国际/客单价/天势关联 命格×行业）。
- **拆分**：`beauty` 拆为**美业**与**大健康**两包（不同决策链/客单价）。
- **收敛**：把 strat.v6.md §8 散文与 `industryPacks.ts` 收敛到**一处事实源**；新增 `{行业陷阱}/{行业天势关联}` 注入。
- **验收**：`industryPacks.test.ts` 断言 7 核心行业 §8 八字段齐全；编辑 pack 对主军师生效（不再与 DB prompt 双轨漂移）。

---

## 3. 里程碑与排期建议

| 里程碑 | 含 PR | 可演示成果 |
|---|---|---|
| **M1 地基可跑** | 0a,1,2,3,5 | 真模型下：采集八字→命盘入库→主军师带【命盘】开场→会话结束自动写回档案 |
| **M2 留存闭环真数据** | 4,7,8,9,10,6 | 决策/复盘/预言/段位全部由代码计算；订阅用户日复盘免费；段位徽章可信 |
| **M3 编排与适配** | 11,12,13,14 | "这周复盘/算一卦"正确路由；六轮不丢位；分阶段深度；角色语气随状态切换 |
| **M4 呈现完整** | 15,16,17,18,19 | 12 种分型卡片 + 三层看板 + 叙事线/仪式 + 前端复盘/段位/命盘页 |

---

## 4. 风险与回滚
- **命盘错误**：引擎用已知八字回归测试（PR-0b）；`engineVersion` 落库便于复算。
- **prompt 入仓后行为漂移**：M1 起所有 V6 行为有 eval 守护；改 prompt 走 PR/CI。
- **状态层迁移**：`extraJson.dossier` 保留只读兼容期，导入后再弃用；`PUT /profile` 收紧不可整块覆盖档案。
- **订阅/计费切换**：灰度；旧 credits 用户平滑迁移，工坊重产出仍按次。
- **平台审核（2B 明做命理）**：上线前过一遍小程序类目与内容规范；准备 §16 降级话术作为应急开关（运行时可切弱化模式），但默认按 2B 全量命理。

---

*本方案与 `docs/V6_DIAGNOSIS_AND_REFACTOR.md` 共同构成 V6.0 工程 SSOT。下一步可从 M1（PR-0a/1/2/3/5）开始落地。*
