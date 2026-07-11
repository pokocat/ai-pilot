# 全局复审 · 待优化点清单（2026-07-11）

> **审查方式**：主模型规划 + 3 个 Opus 子代理并行深审（①规格 vs 实现核查 ②服务端代码深审 ③前端深审），主模型交叉验证汇总。
> **基线**：`main` @ e4256df，覆盖 2026-07-04 以来 113 个提交（WO-01~15 落地、V7 效果图对齐、prompt V1.0 重置、军师记忆库 P1-P3、订阅消息、QA 修复等）。
> **上游文档**：`[FABLE5]AUDIT_V6_GLOBAL.md` → `[FABLE5]AUDIT_V6_STRATEGY_ADD_SUBTRACT.md` → `REDESIGN_EXEC_SPEC.md` → `[FABLE5]POLISH_PLAN.md` → **本篇**。

---

## 0. 总评

一周内工程量可观且方向正确：15 个工单 **4 达成 / 10 部分达成 / 1 主动回滚**，后端账本、注入层、n<5 保护、白名单、合规底座（送你一卦不落库）做得扎实。但暴露出一个**系统性模式：引擎在、闸门缺、管道断**——

- **闸门缺**：brandkit 真实 LLM 路径零计费零门禁（资损）；命理开关三层只做了注入一层（合规）；处方状态机可被埋点回退（数据污染）。
- **管道断**：finparse 引擎零调用方、WO-08 基准库无 admin 维护面（表永远空→注入永不触发）、WO-12 漏斗无报表、WO-14 无 scheduler 追踪——六个工单都是"引擎完工、端到端不通"。
- **前端三缝**：假数据兜底（默认三势卡捏造研判）、入口死锁（账本被段位门槛连坐）、名词/叙事漂移（锦囊≠智库、报告≠方案、"处方唯一销售位"被货架打脸）。

另有横切债务：WO-04~15 **已并库未部署 prod**；AGENTS.md §13 多处做了没销账；5 例断言陈旧的失败测试。

---

## 1. P0 · 资损 / 合规 / 信任（先修，均可独立成 PR）

### P0-1 brandkit 生成路径零计费零门禁【资损】
- 来源：服务端深审 H1。证据：`server/src/services/brandKit.ts:55-74` 直接 `structured()` 无 `reserveQuota`；`routes/brandKit.ts:12-15` 无 `assertPlanActive`、无限流。
- 后果：套餐过期/额度用尽用户可无限次触发真实模型调用。
- 任务：入口加 `assertPlanActive` + `reserveQuota`（低配 ratio，参照 quickscan 口径）+ 每日限流；补集成测试（过期用户 403、额度扣减断言）。

### P0-2 命理开关三层只做一层，合规降级仍不可用【合规】
- 来源：规格核查 WO-05 + AUDIT P-3。证据：`grep FEATURE_DISABLED` 全仓零命中；`shared/contracts.d.ts:314` Me 无 `features`；前端天势卡/calendar/gift 不读开关；admin 无 flags 端点。
- 后果：审核事故时无法一键降级前台命理，P0 合规目标实际未达。
- 任务：① `routes/cards.ts` 等命理端点接 `isFeatureEnabled('fortune')` → 403 `FEATURE_DISABLED`；② `/me` 下发 `features.fortune`（契约先行）+ 前端 home 天势卡/calendar/gift/quickscan 命理板块条件渲染；③ admin 配置页加开关行 + `PATCH /admin/flags/:id`；④ 多实例缓存失效（合规类 flag TTL=0 或直读，见 P2-9）。

### P0-3 新用户战局页渲染捏造的三势研判【信任】
- 来源：前端深审 F1。证据：`app/src/pages/home/index.tsx:57-61` `DEFAULT_FORCES` 写死"行业上行/对手抢位/团队待整"+75/45/35 强度条，`:103` 空数据时回退渲染；违背同文件 `:85` 注释"不预置结论"。
- 后果：军师对没聊过的生意"言之凿凿"，戳破即信任崩塌——这正是全系统最忌讳的伪数据。
- 任务：空数据走既有 `force-empty` 空态卡（`:278-284`），删除 DEFAULT_FORCES 回退。

### P0-4 处方状态机可被埋点回退【漏斗数据污染】
- 来源：服务端深审 H2。证据：`server/src/services/prescription.ts:52-57` `status` 直接覆盖为传入 action，无单调约束；已 verified 的处方可被重复上报的 seen 打回。
- 任务：定义 `seen<clicked<activated<used<verified` 等级序，`updateMany` 条件推进（仅目标等级更高时写）；补回退攻击测试。

### P0-5 报告卡「产出中」卡死残留路径【信任/可用性】
- 来源：前端深审 F16。证据：`app/src/services/streaming.ts:138-147,106-112` 流正常结束但无 `done` 事件时不触发 `onDone`；`chat/index.tsx:470-487` 依赖 onDone 才置 `streaming:false` 且 `streamOk=true` 不走兜底。
- 后果：弱网/服务端异常收尾时报告卡永久转圈——与已修 bug 同类场景。
- 任务：generateStream 对已 rendered 且无 done 的流补发 onDone（或 chat finally 兜底置位）。

---

## 2. P1 · 正确性 / 留存

| # | 问题 | 证据 | 任务 |
|---|---|---|---|
| P1-1 | **认可方案无幂等 → 决策账本注水**：双击/重试 accept 每次新建决策，准确率分母虚高，污染段位素材 | `routes/casefiles.ts:51-62`、`decisionLog.ts:88-109` 无去重 | accept 加幂等键或按 (userId, casefileId+judgment 指纹) 去重；补双击测试 |
| P1-2 | **战略账本入口死锁**：唯一入口 rank-card 被 `streak>=3\|\|usageDays>=14` 门控连坐，新中期用户永远看不到账本（批次C 核心留存功能不可见） | `app/src/pages/profile/index.tsx:174-175`；ledger 全仓仅此一入口 | profile 菜单加常驻「战略账本」行（ledger 自身已有 n<5 空态保护），与段位曝光解耦 |
| P1-3 | **structured() 计费旁路**：schema 校验失败做 2 次真实调用后返回 null → `settle(0)` 全额退款，失败调用零计费（quickscan/finparse/brandkit 全范式） | `quickscan.ts:42-44`、`routes/quickscan.ts:59-60`、`llm/gateway.ts:698-703` | structured() 回传实际轮次/用量，失败也按已发生调用保守结算 |
| P1-4 | **时区修复只到配置层**：业务代码仍裸用本地 getter 派生"今天/几点"，裸机部署时区不对则连续天数/推送整体偏移 | `clock.ts:15-17`、`journey.ts:71-72`、`reviewLog.ts:9,94-98`、`wechatSubscribe.ts:91-92`、`scheduler.ts:70,101` | 新建按 Asia/Shanghai 显式计算的日历工具函数（Intl 固定 timeZone），全量替换本地 getter |
| P1-5 | **NextStepCard 三处不一致**：规格要求战局/执行/对话同一数据，home 用本地手搓派生，可能与另两 tab 指向打架 | `home/index.tsx:193-205` 本地 nextStep；NextStepCard 只挂 sessions:206 + studio:240 | home 换 `<NextStepCard/>` 接 `/journey`，删本地派生 |
| P1-6 | **context 注入链 20+ 次串行 DB 查询**：每条消息 25-35 次 round-trip，块越加越慢 | `context.ts:96-172` 连续独立 await | 无依赖 briefing 用 Promise.all 并发；decision/review/prophecy 各自内部合并查询；补注入链集成测试作回归护栏 |
| P1-7 | **finparse 引擎孤立**：SKU `fin-checkup` 可售但功能未接线（无 analysisJson 字段、无 /analyze 路由、无前端按钮、无模板注册） | `grep finParse` src 零引用；`seedConfig.ts:112` SKU 在售 | 要么一个 wiring PR 收口（务必套 assertPlanActive+reserveQuota，勿复制 P0-1），要么先下架 SKU 防"可售未落地" |
| P1-8 | **5 例断言陈旧的失败测试**：#89 仍断言 general 载 V6.0 全文（已改 V1.0）、#35/#124 n≥5 口径、#84 注入 e2e、#14 送你一卦 | POLISH_PLAN/CHANGELOG 自陈 | 更新测试基线至当前行为，恢复全绿——失败测试常态化会掩盖真回归 |

---

## 3. P2 · 端到端补全 / 一致性 / 工程卫生

**管道补全（按"没有它上游功能等于没做"排序）**：
1. WO-08 admin 基准库 CRUD + CSV 导入 + 种子——没有维护面基准表永远空、注入块永不触发（`admin.ts` 无 benchmark 端点）。
2. WO-12 漏斗报表 `GET /admin/prescriptions/funnel` + 【可开方工具表】注入块——没有报表无法验证生态转化。
3. WO-14 scheduler `prescription-followup-scan`（activated 7 天追踪）+ 月战报【处方效果】块。
4. WO-10 前端周报填报表单 + 周五复盘要数 modeLine。
5. WO-11 前端「有出入?」异议提交入口（后端 PATCH 已就绪，drop-in）。
6. WO-13 export 签名出口（按 `ECOSYSTEM_ACCOUNT_DESIGN.md` 的 TTL 1h 蓝图，生态第二产品需要时再上）。
7. WO-03 服务端 `progressBriefing` 加 streak<3 去百分比闸（`progress.ts:127-128` 现无条件注入）。
8. WO-06 cardHtml quickscan 分享卡（低优，原生分享已覆盖）。

**一致性清理**：
9. 名词收口：锦囊 tab 页面大标题仍叫「智库」（`thinktank:412`）；「报告」与「方案」混用（home:181,210 / thinktank:27,674 / sessions:214,248）；dossier 空态残留「项目」（`dossier/index.tsx:43`）；studio「AI 创作发布」技术腔（`studio:532`）——一次文案 sweep PR 全清。
10. thinktank 已优化/知识库假数据兜底（`OPTIMIZED_ROWS`/`FOLDER_FALLBACK`，`thinktank:35-45`）与同屏真实计数 0 打架——同 P0-3 性质，空态给真空态。
11. AGENTS.md §13 销账：prompt 去机制化/F-5/账本页/周期聚合/三势 forces（§13:539,564）均已实现未销账；WO-02 在 REDESIGN_EXEC_SPEC 标记「作废（产品决策回滚）」防后续 agent 照旧执行。

**工程卫生**：
12. 主包瘦身：chat(1031 行)/brief/settings 三个非 tab 页压主包（`app.config.ts:3-11`），迁子包后构建实测主包体积。
13. quickscan 限流落 DB/Redis（现进程内存，多实例×N、重启清零，`routes/quickscan.ts:48-52`）。
14. bizmetric 填报校验：metric key ∈ 模板、weekStart 归一周一（`routes/bizMetrics.ts:16-22`）。
15. journey applyEvent 条件 updateMany 替代 read-then-update（`journey.ts:29-39`）。
16. memory 治理接口补 tenantId 作用域（`memory.ts:223-235`）。
17. prescription recordOutcome「连续 2 期」注释与「累计 2 期」实现对齐（`prescription.ts:73,85-86`）。
18. mock `knowledgeDetail` 由 reject 改空壳（`api.ts:374`）；`ProgressView/BaziBody` 等遗留类型并入 contracts。
19. **部署核销**：WO-04~15 已并库未上 prod，安排一次部署（走 `scripts/deploy-prod.sh`，注意 db push 新表 + 不重跑 seed 的既有纪律）。

---

## 4. 需要产品拍板的决策项（不拍板则相关工单无法收口）

| # | 决策 | 冲突现场 |
|---|---|---|
| D-1 | **销售位叙事**：「处方是唯一销售位」还是承认多货架并存？ | PrescriptionStrip 注释宣称唯一 vs 智库能力 tab 带价签直接 PaySheet 下单 + market 全量货架，共 3 个销售面（WO-02 回滚的后果） |
| D-2 | **军师科室**：收编 4 科室还是保留 14 个全 enabled？ | WO-04 验收未做（`data/agents.ts` 14 个全开）；若保留 14 个则从 spec 删除该验收 |
| D-3 | POLISH_PLAN §4 七个开放取舍点 | 记忆归属、复盘六层去留、五维健康度、脱敏分享、保底额度、命理浓度、多案卷/处方生态启动时机——其中命理浓度与 P0-2 联动，建议优先拍 |

---

## 5. 建议执行批次（供派单）

- **批次一（本周，全部可并行独立 PR）**：P0-1 ~ P0-5 五刀 + P1-8 测试基线修复。
- **批次二**：P1-1 ~ P1-7（其中 P1-7 finparse 先拍"接线还是下架 SKU"）。
- **批次三**：P2 管道补全 1-8 按序 + 一致性清理 9-11（一个文案 sweep PR + 一个文档销账 PR）+ 卫生项 12-18 可捎带。
- **随时**：P2-19 部署核销（建议批次一合入后一起上，减少一次 prod 操作）。
- **前置**：D-1/D-2/D-3 三个决策项越早拍板，批次三返工越少。

---

*三份子代理原始报告（规格核查/服务端深审/前端深审）的完整发现已按上表去重收编；确认无问题项（订阅消息并发修复、SKU advisory lock、额度透支修复、n<5 保护、注入禁算口径、mock 同口径、401 打断、overlay 协调、按需注入）不再列出。*
