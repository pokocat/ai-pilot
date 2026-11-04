# 军师 · 工程说明分册 · §5 SSOT：全栈数据契约

> 本文是 `AGENTS.md` 对应章节的**完整正文与历史约束账本**，2026-09-09 从 `AGENTS.md` 原样拆出（章节号与小节号保持不变，代码/文档里写的「AGENTS.md §5」即指本文）。
> `AGENTS.md` 只保留该章节的摘要、铁律与入口；**改动本领域的代码时，先读本文对应小节，再动手；改完把新约束写回本文（不是写回 AGENTS.md），并在 `docs/CHANGELOG.md` 顶部记一条。** 维护规则以 `AGENTS.md` §0 为准。

---
## 5. ★ SSOT：全栈数据契约 `shared/contracts.d.ts`

**唯一数据口径**，前端 / 后端 / 运营端共用。

- 形式是 **`.d.ts` 纯类型声明**：编译期类型检查、**运行时被擦除**，各端只 `import type` 引用——不引入运行时依赖、不改打包产物、无需配三套 alias，并绕开后端 `tsc` 的 `rootDir` 限制。
- 三端引用方式（均按各自旧名再导出，**调用方零改动**）：
  - 前端 `app/src/services/api.ts`（`SurveyQuestion→SurveyQ`、`DeliverableSection→Section`、`ChatReply→ChatReplyT`）
  - 后端 `server/src/llm/schema.ts`（`Deliverable / DeliverableSection / ChatReply`）
  - 运营端 `admin/src/api.ts`（`Overview / AdminAgent / AgentDetail / Plan / AdminSaying→Saying / SurveyAdmin→SurveyQ`）
- **改数据模型只改这一处**，三端类型同步。
- **智能体权益契约**：`AgentBilling`（`free|unlock|metered`）、`Agent.billing/price/owned`、`AgentPurchaseResult`、`AdminAgentCreate/AdminAgentUpdate`、`AdminUserDetail/AdminUserAgentRow`，驱动前台解锁、后台定价与指定用户开通。
- **新增能力的契约**（项目/报告/知识/引用）：`ProjectItem/ProjectDetail`、`ReportItem/ReportDetail/ReportVersionItem/ReportVersionContent/ReportDiff/SectionDiff`、`KnowledgeItemT/KnowledgeHit`、`MessageRef`、`SummarizeResult`，以及 `GenRequest.projectId/refs`、`GenResult.knowledgeUsed`、`SessionItem/SessionDetail.projectId`、`SessionMessage.refs`、`LibItem.reportId/version/projectId`。智库整理的 `OrganizeItem` 同时返回 `fileName/fileType/nameSource/preview`，供用户在确认入库前核对源名来源和解析正文。
- **军师档案契约**：`ClientUnderstanding` / `ClientUnderstandingSection` / `UnderstandingMaturity` 挂在 `/me.understanding`，只整理真实档案、长期记忆、项目、知识、报告与会话线索；`AliasSuggestionResult` 驱动注册花名接口。
- **登录身份契约（2026-08-15 手机号唯一身份）**：`LoginResult.phoneBinding?: LoginPhoneBinding` 只由手机号快捷登录返回，区分 `matched / placeholder_upgraded / wechat_relinked`（`mismatch` 已删除）。`wechat_relinked` 表示登录已按本次授权手机号进入对应账号，而本次快捷登录的第三方身份此前挂在另一个账号上、已自动迁绑过来：客户端只做非阻断说明并告诉用户原账号可用原手机号验证码登录，不得据此改写账号归属。两个手机号字段均为脱敏展示值。
- **邀请归因与关系链契约（2026-08-18，2026-08-19 可信捕获修复）**：`LoginAttribution` 的 `inviteCode?` / `referralToken?` 挂在三条**建号**通道的请求体上（`/auth/login`、`/auth/wechat-phone`、`/auth/carrier-onetap`）；`referralToken` 只能由游客落地时调用公开 `POST /auth/referral-capture` 获取，时间与来源由服务端签名，登录链**绝不再信客户端自报的 `inviteCodeAt`**（旧字段即使伪造成未来一年也被丢弃）。任何脏值不得让登录失败：带码但 token 缺失/损坏/码不一致，乃至生产签名密钥暂缺时，验签都 fail-closed 为 `no_timestamp` 且不建边；签发接口本身在生产缺密钥时返回 503。首次注册因此失败或配置暂不可用时，响应 `referralOutcome`，客户端保留凭证，后续仅允许“同账号 + 同一码 + 已有 `no_timestamp|config_unavailable` 留痕”恢复，普通老账号仍禁止追认。IP 只取 Fastify 按可信代理链解析的 `req.ip`，禁止直接读 XFF 首段；来源按 `src=friend|timeline` / scene 固化成 `share_friend|share_timeline|poster_qr`。归因窗口天数归运营配置 `referral-window`（读取时新键优先、回退旧 `referral.window`，缺省 30 天）。注销时只删本人边与直接指向本人的失效边，后代仍有效的直邀边保留并重算 lv2/lv3，独占/多人租户两条分支同口径。`ReferralSummary` 挂 `/me.referral`：`directCount` / `activatedCount` 只数直接下级；整个字段为 `null` 表示本次没读到，与确实为 0 必须区分。
- **问策入口契约（WP1）**：`WenceForm = 'control'|'dock'|'chat'` 是问策入口 A/B 分组，挂在 `FeatureFlags.wenceForm`（`/me.features`）——**服务端按 userId 稳定分桶后下发，客户端不猜**。开关**关**一律 `control`（零改动现状）；开关**开**但权重未配/非法按三臂均分兜底，不回 control。`SessionMessage.chips?: string[]` 是主动消息的快捷回应，服务端从 `Message.contentJson.chips` 原样透出（当前唯一写入方是 `POST /sessions/proactive`）。另有 `WenceHint/WenceHintsResult`、`ProactiveResult`、`ClientEventName/ClientEventRequest`、`AdminWenceTemplate*`。`WenceHintsResult.guestForm: 'control'|'chat'` 是**游客**的形态（游客没有 `/me`，也没有稳定 userId 可分桶，所以只回答「chat 这条臂开没开」，不把游客塞进三臂分流；`'dock'` 不下发，它与 control 同属列表渲染路径）。登录后端上必须改读 `/me.features.wenceForm`。
- **问策入口预发基线（2026-08-11）**：预发库 `feature_flag.wence_entry` 已显式设置为 `enabled=true`、`payload.arms={control:0,dock:0,chat:100}`，游客与登录用户均全量进入新版“对话即 Tab”，不再参与旧列表 A/B；`GET /api_preprod/wence/hints` 已验证 `guestForm=chat`，`junshi-api-preprod` active、`NRestarts=0`。原生 server 包 `9078b02` 已指向 `https://wxapi.aibuzz.cn/api_preprod` auto-preview 到 AppID `wx810ebe6dfef8e75f`。
- **连续会话与渐进交付契约（2026-08-10）**：`SessionDetail.page` / `SessionMessage.at` 支撑尾页 100 条与复合游标向上分页、可重算视觉分章；`FeatureFlags.conversationContinuity` 是跨 24h 同 Session 的逃生开关（默认开，关后走新 Session + handoff）。`UserFact*` / `FactConfirmation*` 承载可审计事实状态和独立确认卡；`RequestedOutput` / `DeliveryMode` / `ComplexityAssessment` / `DeliveryStage` 将“要不要成果”与“一次还是分阶段”解耦；`GenerationView.imageProgress/refNotices` 和 `AttachmentCapabilities` 承载 9 图进度、失败序号及服务端权威限制。

> 约定：任何新增/修改的接口字段，先改 `shared/contracts.d.ts`，再改实现。
