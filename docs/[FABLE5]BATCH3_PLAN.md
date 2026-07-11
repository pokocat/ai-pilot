# 批次三执行设计（2026-07-11 · Fable 规划，Opus 执行）

> 范围 = `[FABLE5]REVIEW_2026-07-11.md` 剩余项 + `[FABLE5]DECISIONS_2026-07-11.md` 未落地决策。两波执行，每波 server+app 双代理并行（server 侧串行跑测试）。基线：main @ c1df0e5，服务端 485/485。

## 关键设计定型（执行代理照此实现，不再自行设计）

### 1) D-1 开通来源归因 · ActivationEvent 模型
不复用/不污染 `UserAgent.source`（语义是 gift|purchase|admin_grant）。新增轻量事件表：
```prisma
model ActivationEvent {
  id        String   @id @default(cuid())
  tenantId  String
  userId    String
  itemType  String   // 'agent' | 'sku'
  itemKey   String   // agentKey 或 skuKey
  source    String   // 'prescription' | 'catalog' | 'market'
  refId     String?  // source=prescription 时的 prescriptionId
  createdAt DateTime @default(now())
  @@index([tenantId, itemType, itemKey])
  @@index([source, createdAt])
}
```
- 写入点：agent 解锁购买、SKU 购买两条路径；`source` 由前端请求体传入（缺省 `catalog`），处方落地页（market 读 pid）传 `prescription`+refId。
- admin 漏斗报表 `GET /admin/prescriptions/funnel?days=30`：处方侧 = Prescription 状态时间戳聚合（proposed→seen→clicked→activated→used→verified）；开通侧 = ActivationEvent 按 source 分组计数。一张多来源对比表。
- 删除代码内「处方是唯一销售位」注释表述（PrescriptionStrip 等）。

### 2) D-3-3 健康度估测框架
- **触发**：month 层 ReviewLog 落库成功后（sessions 路由月复盘收尾处），每月幂等一次（同月已有估测则跳过）。
- **输入**（全部服务端算好再喂）：近 30 天 CasefileMetric 聚合、BizMetricWeekly 序列与基准差、reviewStreak/alignRate、decision/prophecy 服务端统计。任一维度输入为空 → 该维度不让 LLM 评。
- **调用**：`structuredMetered`，schema：`{ dims: [{ key: 'revenue'|'customer'|'product'|'team'|'brand', level: 'high'|'mid'|'low'|'na', rationale: ≤40字 }] }`；无输入的维度强制 na。计费：随月复盘对话的既有额度（不单独 reserve，一月一次成本可控；在代码注释注明该取舍）。
- **落库**：`StrategicProfile.kpiJson.health = { dims, at, source:'estimate' }`。
- **消费**：月战报注入块【健康度·军师估测】只读落库值；`level` 文案 高/中/低 水位（禁止百分比）；na → 「暂无法评估（缺X数据）」。禁算口径写入块尾。
- **红线**：对话中 LLM 不得现场评估健康度——prompt 侧无需改（V1.0 已删看板章），注入块自带「以本块为准」。

### 3) D-3-7 生态跳转 · EcoTool 注册表
```prisma
model EcoTool {
  id      String  @id            // toolKey，如 'digital-human'
  name    String                 // 「数字人代播」
  desc    String                 // 开方场景一句话（供【可开方工具表】注入）
  appId   String                 // 目标小程序 appId
  path    String  @default("")   // 目标页面路径（可带占位参数）
  enabled Boolean @default(false)
  updatedAt DateTime @updatedAt
}
```
- 处方白名单 = enabled agents ∪ enabled EcoTool（`toolWhitelist()` 扩展）；Prescription 增加 `toolType`（'agent'|'external'，落库时按 key 归属判定）。
- admin「功能开关」旁新增「生态工具」管理（CRUD，enabled 控制是否可开方）。
- 前端 PrescriptionStrip：toolType=external → `Taro.navigateToMiniProgram({ appId, path })`，失败（未关联/用户取消）toast 降级；埋点仍走 click。
- 【可开方工具表】注入块（WO-12 遗留）：方案生成上下文注入 enabled agents+EcoTool 的 key/名称/desc，prompt 指令「只准从表中开方，最多 3 条」。
- 运维前提（写入 §13）：目标小程序需与本小程序同一微信开放平台主体关联，方可 navigateToMiniProgram。

### 4) D-3-4 报告分享转图片
- app 侧：报告卡/方案库详情的对外分享动作改为生成分享图（复用天时日历/送你一卦的共享 canvas 出图工具）：内容=报告标题+2-3 条核心结论+「完整方案在军师参谋部」落款，**不含全文与敏感数字明细**；保存相册/转发。
- 「网页版」webview 入口保留（本人自用）；移除「复制链接」类对外分享入口。server reportShare 端点不动。

## 波次与任务分配

### 第一波
**Agent-S1（server+admin，生态/处方域）**：D-1 全套（ActivationEvent+写入点+admin 多来源漏斗）；D-3-7 server（EcoTool+白名单并入+admin 管理面+契约）；WO-14 收尾（scheduler `prescription-followup-scan`：activated≥7 天打标幂等 + 周复盘 modeLine 要效果话术 + 月战报【处方效果】注入块，占比服务端算）；【可开方工具表】注入块。
**Agent-A1（app）**：WO-10 周报填报表单（执行页周复盘区，字段动态读 template 接口）+ 未填报时周复盘要数提示；WO-11 账本「有出入?」异议提交入口（PATCH 已就绪）；文案 sweep（thinktank 标题智库→锦囊、报告→方案统一、dossier「项目」、studio「AI 创作发布」、F15 假数据兜底改真空态、ledger 天机空态在 fortune 关闭时的中性措辞）。

### 第二波
**Agent-S2（server+admin，数据资产域）**：WO-08 基准库 admin CRUD+CSV 导入+三行业种子（p50 留空写「待运营核实」，空分位不注入的既有行为保持）；D-3-3 健康度估测框架（按上文定型）；WO-03 服务端 `progressBriefing` streak<3 不含百分比；卫生项（bizmetric 填报校验 key∈模板+weekStart 归一周一、journey applyEvent 条件 updateMany、memory 治理接口补 tenantId、prescription recordOutcome 注释与实现对齐）。
**Agent-A2（app）**：D-3-4 报告分享转图片；D-3-7 前端 external 跳转 + 处方落地页/开通请求带 source 归因参数；主包瘦身（chat/brief/settings 迁分包，全量修 navigateTo 路径，构建后核对主包体积）。

### 收尾
主模型逐波 review+提交；两波后全量回归（server 全量 + app tsc/build + admin lint/build）、CHANGELOG/§13 回写；部署与 weapp 发版单独向用户确认。

## 明确不做（继续挂 backlog）
quickscan cardHtml 分享卡（原生分享已覆盖）；`/casefile/review` 层 clamp（无 UI 入口）；F6 遗留类型迁 contracts（纯整洁，避免本轮 contracts 三方冲突）；悬念钩子登记表完整闭环（prompt 止血已生效）；限流落 Redis/DB（等多实例前置）；NatalChart 历史数据物理清除（等合规要求明确）。
