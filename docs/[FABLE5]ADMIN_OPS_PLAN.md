# Admin 后台运营能力改造设计（2026-07-12 · Fable 规划，Opus 执行）

> 起因：用户反馈「用户 tab 看不到实际用量、数据感觉假、没有运营动作」。两个只读调查代理已完成 server（admin.ts 1439 行全端点 + 计费底账）与 admin 前端（21 个 tab）盘点，本文基于事实清单做设计。执行代理照此实现，不再自行设计。

## 0. 评审结论（三条抱怨的定性）

1. **「看不到实际用量」= 属实，是接线缺口不是底账缺口。** LLM 逐次流水 `TokenUsage`（userId/agentKey/model/token 分项/costMicros，带 `[userId,createdAt]` 索引）与月度额度账户 `TokenWallet`（quota/balance/periodKey）数据齐备，但 admin 从未 join 进用户列表/详情；token 看板只有全局 Top8，不能按用户下钻。
2. **「数据感觉假」= 部分属实，来源有三：**
   - `/admin/overview` 的 `trend` 箭头**后端硬编码 'up'**（admin.ts:380-385），无任何环比计算——唯一实质性假数据；
   - 用户 tab 的「已消耗 X 点」是**钻石（CreditLedger）口径**，不是用户直觉里的 LLM 用量，口径误导；
   - 概览卡副标签被挪用塞计数（「N 个租户」），配上箭头造成趋势错觉。
   - 其余（用户列表、消耗、token 看板、trace、漏斗）均为真实 DB 聚合。
3. **「没有运营动作」= 属实。** 对单用户现有写操作仅：开通/取消 agent、删记忆、知识库删/传/重嵌。额度重置、钻石补发、套餐延期、封禁、退款、订单可见性**从契约层就不存在**。但 `setQuota()`（tokenQuota.ts:238）、CreditLedger 写模型、`User.planExpiresAt`、`getPlanStatus()`（tokenQuota.ts:281）全部就绪——大部分动作只差 admin 写端点 + 审计 + 前端。

## 1. 决策记录（Fable 拍板，执行以此为准）

- **D-A1 v1 运营动作范围**：做「调整/重置月度 token 额度、补发/扣减钻石、延长套餐有效期」三件（底账就绪、纯接线、可审计）。**封禁与退款本轮不做**：封禁需 User 加 disabledAt 列 + 登录/请求双闸；退款需 PaymentOrder 加 refunded 态 + 微信退款 API 对接，均为 schema/外部依赖项，挂 backlog。
- **D-A2 换套餐（改 planId）本轮不做**：套餐系统是快照权益 + 锚点重置语义（plan-expiry 体系），admin 直改 planId 会绕过快照逻辑造成权益错账。v1 只做「延长有效期」（仅推 planExpiresAt，不动快照）。
- **D-A3 资金敏感动作 owner-only**：额度/钻石/套餐三个写端点走 `requireSuper`（现有 owner 判定），operator 不可见按钮。防运营账号误操作，审计日志记 before/after。
- **D-A4 概览趋势做真实环比**（不是删箭头）：4 张卡以近 7 天 vs 前 7 天真实计算 delta，无前期数据显示「—」，禁止再出现无数据来源的箭头。
- **D-A5 支付订单只读列表本轮做**（纯读零风险）：admin 新增订单页，运营终于能看到真实收入。退款操作不做（见 D-A1）。

## 2. 工程任务

### Agent-S（server + contracts，串行跑测试）

**S1 · per-user 用量聚合端点** `GET /admin/users/:id/usage?days=30`
返回（新契约 `AdminUserUsage`）：
- `quota`: TokenWallet 现状 —— `{ limit, used, remaining, unlimited, periodKey }`，复用 `getQuotaState()`；
- `plan`: `{ planName, expiresAt, daysLeft, status }`，复用 `getPlanStatus()`；
- `tokens`: 近 N 天聚合 `{ totalTokens, inputTokens, outputTokens, costMicros, calls }` + `byModel[]` + `byAgent[]` + `byDay[]`（sparkline 用）——全部 `TokenUsage where userId` SQL 聚合，禁止在应用层逐行累加；
- `credits`: 钻石流水最近 20 笔 `{ delta, reason, balance, at }`；
- `payments`: 该用户 PaymentOrder 最近 10 笔 `{ outTradeNo(脱敏尾6), amount, status, paidAt, attrSource }`；
- `activations`: ActivationEvent 最近 10 笔。

**S2 · 三个运营写端点**（全部 `requireSuper` + `recordAudit` 带 before/after + payload.by）
- `POST /admin/users/:id/token-quota` `{ mode: 'reset_to_plan' | 'set', quota? }`：复用 `setQuota()`；reset_to_plan 取用户当前 plan 的 tokenQuotaPerMonth；set 校验 quota ≥ 0 或 -1（不限量）。审计 action `admin.user.quota.set`。
- `POST /admin/users/:id/credits` `{ delta, reason }`：delta 非 0 整数，reason 必填（≤50 字）；负 delta 不得使余额 < 0（校验后拒绝，不 clamp）；走既有 credits 服务写 CreditLedger（reason 前缀 `admin:`），禁止手写裸 insert。审计 `admin.user.credits.adjust`。
- `POST /admin/users/:id/plan-extend` `{ days }`：1 ≤ days ≤ 366；planExpiresAt = max(now, 现值) + days；用户无套餐时 400。**只动 planExpiresAt**，不触碰快照/锚点/钱包。审计 `admin.user.plan.extend`。

**S3 · 口径与假数据修正**
- `/admin/overview`：4 张卡增加真实环比（近 7 天 vs 前 7 天，count 口径与主数值一致），契约 `Overview.stats[]` 改为 `{ v, deltaPct: number|null, sub }`，trend 字段删除；「累计消耗（点）」卡改名「钻石消耗」，新增第 5 卡「30 天 Token 成本(¥)」（TokenUsage.costMicros SUM）。
- `AdminUserItem` 增量字段：`tokenUsed30d`、`quotaRemaining`（-1=不限量，null=无钱包）——用两条 groupBy/批查实现，禁止 N+1。
- 用户列表/usage 页涉及钻石的文案在契约注释标明「钻石口径」（前端改文案见 Agent-A）。

**S4 · 支付订单只读端点** `GET /admin/payments?status=&days=30&q=`
分页列表（金额/状态/paidAt/用户名/归因）+ summary（期内 paid 总额、订单数、按日金额）。纯读。

**测试**：每个写端点至少覆盖——权限（operator 403）、参数校验、审计落库、幂等语义（quota set 重复调用）、credits 负 delta 越界拒绝、plan-extend 无套餐 400。基线 512 全绿之上跑全量。

### Agent-A（admin 前端，依赖 S 发布的契约）

**A1 · 用户详情「用量与额度」块**（抽屉最顶部，在付费智能体块之前）
- 月度额度 meter（used/limit/remaining，periodKey 标注「本月」，不限量显示「不限量」徽标）；
- 30 天 token/成本 KV + byAgent/byModel 前 3 行 + byDay 迷你条形（用现有 `meter`/`usage-num` class，不引图表库）；
- 钻石流水、支付订单、开通归因三个折叠列表；
- 运营动作按钮排（仅 owner 渲染，读现有 actor 角色）：「重置额度」「调整额度」「补发钻石」「延长套餐」——全部走确认弹窗（复用 `modal-scrim`），补发钻石必填 reason，成功后刷新详情。
- 用户列表行的「已消耗 X 点」改文案「钻石消耗 X」，新增「30 天 Token」列（tokenUsed30d 缩写显示，如 1.2M）。

**A2 · 概览页修正**：箭头只在 deltaPct 非 null 时渲染（正绿负红，显示 ±N%），无数据显示「—」；卡片文案随 S3 改名；接第 5 卡。

**A3 · 订单 tab**：新增「订单」tab（放「消耗」旁），状态筛选（bill-seg）+ 天数切换 + summary 4 格 + 列表（audit-table 词汇），空态诚实文案。

**A4 · Token tab 下钻**：Top 用户行点击 → 跳用户 tab 并打开该用户详情抽屉（现有 setState 切 tab 即可，无路由库）。

**设计红线**：DESIGN.md 全部约束生效（token 化颜色、既有 class 词汇、`npm run lint:ui` 门禁必须过）；不得模仿 ui.tsx/StudioSandbox 里的存量 hex 违规。

## 3. 波次与验收

单波双代理并行（server/ 与 admin/ 目录不相交；S 先定契约再开工 A，A 开工前读 shared/contracts.d.ts 最新版）。收尾：server 全量测试 + admin lint:ui/build，主模型 review diff 后提交。部署与上线单独向用户请授权。

## 4. 明确不做（backlog）

封禁/停用用户（需 User.disabledAt + 双闸）；退款流程（需 PaymentOrder.refunded 态 + 微信退款 API）；admin 直改用户 planId（快照语义冲突，需专门设计）；per-user 会话/成果明细浏览端点（观测诉求再议）；留存/活跃分桶分析（等数据量）；操作二次验证（如敏感动作输入密码，v2 视运营团队规模）。
