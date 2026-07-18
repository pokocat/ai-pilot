# 产品/架构决策记录（2026-07-11，用户拍板）

> 对应 `[FABLE5]REVIEW_2026-07-11.md` §4 的三项决策。**后续执行 agent 以本文为准**，与旧规格冲突处以本文覆盖。

## D-1 · 付费入口架构 → 方案 A：多入口并存 + 来源归因

- 保留锦囊 tab 能力区、market 目录页、处方（PrescriptionStrip）三个付费入口。
- 工程任务（批次三）：
  1. 开通/购买行为统一加 `source` 归因（`prescription` / `catalog` / `market`）——扩展现有埋点或 `UserAgent.source` 语义，处方链路继续写 Prescription 状态机；
  2. 删除 `PrescriptionStrip/index.tsx:2` 等处「处方是唯一销售位」的注释与文档表述；
  3. WO-12 漏斗报表改为**多来源对比报表**（各来源的曝光→开通转化）。

## D-2 · 顾问 Agent 数量 → 方案 A：缩减为 4 + 1

- 保留：general（总军师）+ strat（战略诊断）/ growth（增长）/ ops（经营）/ brand（品牌）。其余 10 个 `enabled=false` 下架。
- 工程任务：幂等 UPDATE 脚本（禁止重跑 seed）；`assertAgentAccess` 确认/补充已购用户豁免（owned 则忽略 enabled=false）；已下架 agent 的存量会话入口保留；admin 端同步；生产执行时 agent 行与 agent_version 快照两处都要处理。

## D-3 · 七个开放参数的结论

### 1) 记忆归属 → 用户级共享事实池（最终模型）
像 Claude app 一样：记忆属于用户，不按 agent 隔离。recall 忽略 agentKey 的现行为即最终态。任务：文档定调（AGENTS.md 记忆章节）；写入端如仍有按 agentKey 私有语义的路径，标记为 legacy 并逐步归并；userId/tenantId 隔离不变。

### 2) 复盘层级 → 只保留 日 / 周 / 月
季/年/团队后续再说。任务：`resolveMode` 对季/年/团队触发词降级到月度线（军师话术引导）；UI 不提供入口；ReviewLog 枚举保留不删（向后兼容）；prompt 中相关章节按三层修剪。

### 3) 五维健康度 → 保留，由 LLM 估测「水位」，不要求精确
工程约束（防伪数据的红线内做 LLM 估测）：
- **输入**：只基于服务端注入的真实数据（CasefileMetric 聚合、BizMetricWeekly、ReviewLog 统计、账本统计）；
- **输出**：结构化 `{dimension, level, rationale}`，level 为粗粒度水位（高/中/低 或 0-100 的十位粒度），不输出精确分数假象；
- **时机**：月复盘/月战报生成时一次性产出并**落库**（`StrategicProfile.kpiJson` 或 ReviewLog 快照），对话中只引用落库值，不逐次现编；
- **展示**：UI 与报告一律标注「军师估测」；某维度输入数据不足时输出「暂无法评估」，禁止硬给水位。

### 4) 报告分享 → 转图片，链接只留自用
分享动作改为 canvas/图片交付（复用天时日历/送你一卦的共享出图工具）；报告 HTML 链接定位为本人自用（webview 查看），对外分享入口不再暴露公开链接。任务：报告卡/方案库的「分享」改图片管线；`reportShare` 公开链接入口收敛。

### 5) 复盘保底额度 → 调整默认值 + admin 可配置
`REVIEW_GRACE_PER_DAY` 从硬编码 2 改为可配置（建议默认 **6**，覆盖"日复盘+军令生成+2-3 次追问"的正常动线）；配置落 FeatureFlag payload 或等价配置表，admin 配置面加输入项，改动即时生效（注意多实例缓存失效）。

### 6) 命理内容浓度规范 → 暂不做
P0-2 的三层开关照做，条件渲染范围 = 现有全部命理 UI/端点，不额外定义内容分级。

### 7) 生态（数字人等） → 纯跳转逻辑
数字人是已完成的独立应用。处方 `toolType='external'` 走跳转（小程序跳小程序 `navigateToMiniProgram` 或 H5，目标 appId/路径做成配置项）；品牌资产包不做推送式 export，由数字人应用在用户授权下拉取（按 `ECOSYSTEM_ACCOUNT_DESIGN.md` 蓝图，实施等对接排期）；WO-14 成果回流维持手工回填 v1。

---

## 对既有规格的覆盖声明

- `REDESIGN_EXEC_SPEC.md` WO-02 **作废**（产品决策：保留货架，走 D-1 多入口）。
- WO-04 军师收编验收**恢复有效**（D-2 选 A）。
- WO-12 漏斗验收从「单一处方漏斗」改为「多来源对比」（D-1）。
- WO-13 export 出口按 D-3-7 改为授权拉取模式，暂缓。
- AUDIT 中「五维健康度=伪量化」问题按 D-3-3 的约束框架解决，不再是砍除项。
