# 军师 · 工程说明分册 · §10 数据库（Prisma）· 含「✦ 企业事务操作系统（工程摘要）」

> 本文是 `AGENTS.md` 对应章节的**完整正文与历史约束账本**，2026-09-09 从 `AGENTS.md` 原样拆出（章节号与小节号保持不变，代码/文档里写的「AGENTS.md §10」即指本文）。
> `AGENTS.md` 只保留该章节的摘要、铁律与入口；**改动本领域的代码时，先读本文对应小节，再动手；改完把新约束写回本文（不是写回 AGENTS.md），并在 `docs/CHANGELOG.md` 顶部记一条。** 维护规则以 `AGENTS.md` §0 为准。

---
## 10. 数据库（Prisma · `server/prisma/schema.prisma`）

租户 `Tenant` / 用户 `User`(phone 唯一；`wechatOpenId/wechatUnionId` 可选唯一绑定微信账号；`identityUid` 可选唯一 = 统一账号中心 uid，见 §6；`role=owner|member|admin`) / 档案 `Profile` / 智能体 `Agent`（`billing/price/gift/enabled` 定义权益与价格）/ 用户智能体权益 `UserAgent` / 会话 `Session` / 消息 `Message` / 成果 `Deliverable` / 记忆 `Memory` / 献策 `Saying` / 问卷 `SurveyQuestion` / 套餐 `Plan` / 算力流水 `CreditLedger` / 审计 `AuditLog` / 审核 `ModerationLog`。业务表均含 `tenantId` 行级隔离。

**新增模型（企业事务操作系统）**：
- `UserAgent`（用户已开通的智能体，`(userId,agentKey)` 唯一；`source=gift|purchase|admin_grant`，用于 `unlock` 权益校验和后台开通管理）。
- `Project`（项目主线，租户级，`(tenantId,slug)` 唯一）；`Session.projectId` / `Memory.projectId` / `Deliverable.projectId` 归属项目。
- `ReportDoc`（逻辑报告，`(tenantId,slug)` 唯一，`currentVersion`）+ `ReportVersion`（不可变快照，`contentHash` 去重，`changeSummary` 变更摘要，`(reportId,version)` 唯一）。`Deliverable.reportId` 桥接。
- `KnowledgeItem`（知识条目，可挂项目）+ `KnowledgeChunk`（切片 + `embedding`）。
- `Message.refsJson`（本条消息引用的 项目/报告/知识/记忆）。
- 大模型真源为 `AiCredential` / `AiEndpoint` / `AiRoute` / `AiRouteMember`；旧 `AiSetting` / `AiModel` 只用于一次性迁移和 `AI_CONFIG_V2=false` 应急历史快照。pgvector 开启时 `knowledge_chunk` / `memory` 另有 `embedding_vec vector(N)` 列（由 `prisma/pgvector.sql` 建，非 Prisma 管理）。
- `Referral`（邀请关系，`userId` 主键 = **单推荐人公理**，绑定后不可变更）+ `ReferralAttribution`（**每次带码进线都落一行，成功与失败都留痕**，含 `clientIp`/`userAgent` 作风控原料）。物化路径 `lv1/lv2/lv3` **从第一天就写全**（运营侧邀请树要看完整链路），但对用户呈现与将来的激励口径**只看一级**。判环**必须沿 `referrerId` 递归上溯**（物化只到三级，A→B→C→D 这种链上只比 lv1/lv2/lv3 会漏判并建出环），带 hop 上限兜底。`outcome ∈ bound|self|cycle|unknown_code|expired|already_bound|config_unavailable|no_timestamp`（后三个是复核时补的：`cycle` 与 `self` 分开是因为运营看到 `self` 会以为用户在拿自己的码、排查方向不同；`config_unavailable` / `no_timestamp` 都表示「判不了就不建这条改不回来的关系」）。
- `Casefile` + `CasefileOrder`（军令，`aligned` 对齐性标注）+ `CasefileMetric`（每日回填，`(casefileId,date)` 唯一）——执行闭环（M0 PR-EX），用户级 active 案卷唯一。
- `NatalChart`（命盘，`userId` 唯一、重排覆盖；`engineVersion` 支持按版本批量复算；`chartJson`=ChartView 全量结构）——排盘引擎（M1 PR-1）。生辰输入与「不信命理」偏好存 `Profile.extraJson.bazi`。
- `ReviewLog`（复盘日志，`(userId,layer,date)` 唯一）——M2 PR-8：六层复盘事件账本；day 层由执行页发起复盘时落库（快照当日军令完成/对齐/回填事实）；**对齐率=对齐军令÷总军令、连续复盘天数由服务端从行计算**（今天未复盘不打断，从昨天起算）；scheduler 挂断档提醒（`review-gap-reminder`）。注入【复盘账本】块。
- `WechatSubscription` + `WechatNotificationLog`：订阅消息一次性授权额度与发送日志。`(userId,scene,templateId)` 唯一；`accept` 增额度，发送成功扣额度；日志记录 `sent/failed/skipped` 便于排查复盘提醒、报告生成触达。
- `PlanEntitlement` + `SkuEntitlement` + `MonthlyCreditGrant` + `TokenQuotaAdjustment`：套餐/SKU 权益来源账本、年付月度钻石幂等锚点、运营临时额度增量；报价/退款按来源订单重算，重复购买同一模块时退款一单不撤其它来源，临时调整不覆盖已用量。增购包（credits/quota）的 `SkuEntitlement.quantity` 记**实际发放量**（不限量兜底跳过发放时显式写 0，盖掉默认值 1），退款回收以 entitlement 量为准、下单快照量只作缺行兜底——防「没发出去的量被退款追扣」。
- `ProphecyLog`（预言账本，`(userId,seq)` 唯一）——M2 PR-9：预言/依据/验证标准/到期时间/状态（pending|hit|miss）；**写入源=真实模型结构化抽取（gateway.extractProphecies，测试/mock 返回空→绝不产生伪预言）+ 显式接口**；总军师输出后 sessions 路由异步收割（有命盘用户才抽）；`prophecy-due-scan` 到期登记对账候选（行级 `dueNotifiedAt` 幂等）；命中率服务端算、无样本 null。注入【天机账本】块。
- `UserProgress`（用户进度，`userId` 唯一）——M2 PR-10：战略段位（新兵→尉官14天→校官30天+月复盘→将军90天+准确率>60%→元帅180天+>70%+命中率>50%；**只升不降**，null 指标视为不达标不放水）+ 里程碑（使用天数 7/30/90/180/365 解锁，记首次解锁日期）；晋升记审计 `user.rank.promoted`（晋升卡素材）；`syncProgress` 无变化不写库。注入【段位·里程碑】块（新用户零记录不注入）。
- **复盘保底（M2 PR-6）**：`reserveQuota(userId, ratio, {grace:'review'})`——余额≤0 时复盘类调用（`buildReviewPrompt` 确定性前缀识别）每日最多 `REVIEW_GRACE_PER_DAY`(2) 次放行（透支记账+`system.quota.grace` 审计）；套餐到期锁定不受影响。**复盘动线归属总军师 general（免费），ops 经营参谋保留为可解锁深聊**——复盘是留存生命线，不设解锁墙。
- `DecisionLog`（决策日志，`(userId,seq)` 唯一自增序号）——M2 PR-7：决策/理由/天势参考/验证标准/验证期/状态（pending|correct|revise）/快慢标注；写入源=认可方案自动记账 + 手动接口（AI 工具位与 LLM 抽取随 PR-9 共建）；**准确率（含快/慢分开）一律服务端从状态行统计，无已验证样本返回 null 不编 0%**；注入【决策账本】块（近 5 条 + 准确率 + 禁止 AI 自算口径）。
- `WenceTemplate` + `ClientEvent`（问策入口 WP1）：前者是运营模板池（`kind='hint'` 提示词 / `'proactive'` 进场主动消息，带 `chipsJson/enabled/sort`）——**禁止 seed，空池合法**，与定价权益同一「对外内容归运营」原则，故它作为运营目录**不进** `prisma/resetBusinessData.ts`（进了就会在预发 seed 时被清掉运营录入的内容）；后者是埋点原始事实表，`userId/tenantId` 可空且**无外键**（游客上报），因此必须像 `CreativeJob` 那样显式写进 `resetBusinessData`，否则跨用例累积。
- `StrategicProfile`（战略档案，`userId` 唯一）——统一状态层（M1 PR-3）：只存**客户已确认**的战略事实（主要矛盾/定位/赛道/阶段 + 预留 十二问/KPI/extra）；回写触发=认可方案（`/casefile/accept` 按分节标题确定性提取）+ 手动校准；注入为【战略档案】块、置于推断型【客户档案】之前。与 `understanding`（证据自动推断）分工明确，不重复。

- **代理分销六表（2026-09-02）**：`Distributor` + `DistributorTier` + `DistributionRule` + `CommissionEntry` + `CommissionSettlement` + `CommissionOutbox`。
  代理 = **运营在后台登记的签约渠道合作方（B2B）**，佣金线下打款、后台只回填凭证号；小程序端本期零暴露（不触碰「小程序内现金裂变返利」这条审核红线）。**佣金只发代理、不发普通邀请人**——一笔订单沿买家 `Referral.lv1/lv2/lv3` 上溯，某一级祖先是 `status='active'` 的代理且其等级在该层级有 `rateBp>0` 的启用规则才计提；三级是上限（与物化路径同深，不是另定规则）。
  · `Distributor.status`：`pending` 待审（留给将来的自助申请，本期无入口）→ `active` 生效 ↔ `suspended` **暂停计提** → `terminated` 终止（**终态，档案只读**）。**`suspended` 不是延后计提**：暂停期间成交的订单永久不产生佣金行，解除暂停也不补算——否则运营一解除就会冒出一批没人核过的对外负债。
  · `DistributorTier` / `DistributionRule` 是**运营目录**：**禁止 seed，空目录/空规则合法且等于不计提**（代码里没有任何默认比例）。因此二者**不进** `prisma/resetBusinessData.ts`（同 `WenceTemplate` 的理由：进了就会在预发 seed 时清掉运营录入的比例），测试自己建自己清。规则维度 = 等级 × 层级(1..3) × 商品类型(`plan|sku|all`)，**精确 itemType 优先于 `all`**，`enabled=false` 与 `rateBp=0` 都等于没配。
  · `CommissionEntry` 是**不可变账本**：只追加，落行后只改 `status`/`settlementId`/`reversedAt`。`kind`：`accrual` 计提（正额）| `clawback` 追回（负额，**已结算后才退款**时另落一行，绝不改写已打款的那行）。`status`：`pending` 冻结期内 → `confirmed` 可结算 → `settled` 已随结算单打款；`reversed` = **结算前**退款作废（不进任何结算单）。**幂等键 `(outTradeNo, beneficiaryUserId, level, kind)`**——outbox 重试、微信重复回调、scheduler 续扫全靠它兜住（层级进 key 不是因为同一人可能占两级，而是幂等键不该依赖别处的无环公理成立）。`ruleSnapshotJson` 存等级名/规则 id/比例/冻结期，运营改规则历史行不漂。
  · `CommissionSettlement`：`draft` → `approved` → `paid`（必填 `paidRef` 线下凭证号，同事务把关联行 `confirmed→settled`）；`void` 仅 draft/approved 可作废（解绑行放回待结池，**单上 `entryCount/totalAmount` 保留原值作凭据**）。净额可为负（同期追回多于计提），这种单照样走流程 = 下期抵扣的凭据。银行账户资料**不入库**，线下财务保管。
  · `CommissionOutbox(outTradeNo, kind)`：与 `InviteActivationOutbox` 同一套路、同一理由——支付/退款**事务内** upsert 一行（意图随真金一起提交），提交后异步派发一次，失败由 scheduler `pay-reconcile-sweep` 的 `scanCommissionOutbox` 续扫。**绝不 await、绝不往支付响应上抛错**：把「查 Referral + 查代理 + 查规则」塞进支付事务，等于让一次查询抖动回滚已经算成功的入账。挂点就在 `markPaidAndApply` 里 `enqueueInviteActivation` 的**同样两处** + `refundWechatOrder`/`markRefundNotified` 置 `refunded` 的两处。
  · 冻结期归运营（功能开关 `distribution-hold.days`，兜底 7 天、区间 0..90）：`holdUntil = 支付时刻 + days`，scheduler 新增 `commission-mature`（30 min）调 `confirmMatured()`——`pending` 且到期且**订单未退款**才转 `confirmed`。总开关 `distribution` **默认关**，且**开启后不追溯历史订单**（不计提的 outbox 行照常置完成，一次开关操作不该凭空产生一笔没人核过的负债）。
  · 注销政策：`Distributor` / `CommissionEntry` / `CommissionSettlement` 全归 **retain**（财务与签约凭据，去标识保留）；purge 时只抹 `Distributor` 的 `displayName`/`contactPhone`/`remark`，**不动 userId 与状态**（改了 userId 就再也说不清那些已结算的钱是给谁的；终止合同是商务动作，不该由注销替运营决定）。`CommissionOutbox` 无 userId/tenantId，不需登记。


> 生产：`Memory.embedding` 与 `KnowledgeChunk.embedding` 应用 **pgvector** 的 `vector` 类型 + HNSW 索引；本地降级为 `Json(float[])` + 内存余弦相似度（与 schema 注释一致）。详见「✦ 升级路径」。

---

## ✦ 企业事务操作系统（工程摘要）

完整产品说明见 `PRODUCT.md`。工程上只需记住这些边界：

- 项目、报告、知识、记忆、引用都必须按 `tenantId` 隔离；新增可被引用/召回的数据类型时，补跨用户不可见断言。
- `buildGenContext` 是上下文注入总入口：企业档案、本命色、军师档案、项目背景、显式引用、知识库召回、长期记忆都从这里进模型；回忆意图统一由 `services/recallIntent.ts` 判断，命中时扩大长期记忆召回并由 `routes/sessions.ts` 补同会话较早相关原文；新增客户事实来源必须先接入这里，不能只做前台展示。
- 报告版本由 `services/reports.ts` 管：slug 归一、内容哈希去重、section/word diff；不要在页面层自己拼版本逻辑。
- 知识与记忆检索走 `services/retrieval.ts` / `services/memory.ts`；默认本地向量 + 内存余弦，`PGVECTOR_ENABLED=true` 后走 `services/vectorStore.ts`。
- 升级方向和产品口径看 `PRODUCT.md`；未完成项仍以 §13 TODO 为准。
