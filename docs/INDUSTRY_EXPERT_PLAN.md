# 行业专家身份 / 自动路由方案（Plan）

> 状态：方案（plan-only，未实现）· 作者：协同 · 日期：2026-06-25
> 目标：根据客户画像，让「军师」具备行业领域身份；主 agent 识别到行业专属问题时，路由 / 拉起行业专家能力。

---

## 0. 核心判断：行业是一个「镜片层（Lens）」，不是第 15 个 agent

现状里 agent 是**并列注册表**（`general` + 战略体检 / 增长 / 融资 … 共 14 个 deliverable agent，由 `KEY2AGENT` 精确串匹配选择，无意图分类）。若把「SaaS 专家」「餐饮专家」也做成并列 agent，会有两个致命问题：

1. **维度爆炸**：14 个职能 × N 个行业 = 笛卡尔积；且无法表达「战略体检 + SaaS 视角」这种叠加。
2. **重复造身份**：每个行业 agent 都要重抄一遍商业边界 / 方法论 / V6.0。

✅ **正确建模：行业 = 一个正交的「镜片层」**，可叠加在任何 agent（general 或任一 deliverable agent）之上。它只往系统提示词注入「行业人格 + 行业知识包」，不替换原 agent。这样 `SaaS × 战略体检`、`餐饮 × 增长方案` 都是「职能 agent + 行业镜片」的组合，零爆炸。

> 关键：现有代码**已留好注入缝**——`server/src/llm/schema.ts` 的 `{行业基准}` 占位符现指向硬编码 `INDUSTRY_BENCHMARK`（`seedConfig.ts:96`，只有 SaaS 一句）。把它升级成「按行业 code 查表注入」就是整套方案的地基。

---

## 1. 三种实现模式（取舍 + 推荐）

| 模式 | 做法 | 成本 | 适合 |
|---|---|---|---|
| **A. 人格注入（Persona Lens）** | 不建新 agent。一个军师，按画像 / 检测到的行业，往 prompt 动态注入「行业人格 + 知识包」 | 低（复用注入通道） | 起步、全行业覆盖 |
| **B. 路由 + 专家 agent** | 主 agent 做意图分类 → 命中行业则切到独立行业 agent（自带 prompt / 知识 / 产出） | 高（需分类器 + handoff） | 少数高价值垂类深耕 |
| **C. Agent 工厂（自动建 agent）** | 行业 agent 按「基座 + 行业包」模板运行时物化成一行 Agent | 中高（版本 / 治理） | 行业专家进智库、可计费、沉淀行业记忆 |

**推荐：分阶段混合**
- **P0**：A（人格镜片，画像驱动，零路由风险）
- **P1**：加轻量意图分类，区分「通用 vs 行业问题」并升级镜片强度
- **P2**：对极少数高价值垂类做 C（参数化物化 agent）/ 工具路由

---

## 2. 「自动建 agent」：用虚拟人格，不要真建一堆行

| 路线 | 说明 | 结论 |
|---|---|---|
| ❌ 物化路线 | 每识别一个行业就 `INSERT` 一行 Agent | agent 泛滥、版本难治理、谁来策展 |
| ✅ 参数化路线 | 只有**一个**「行业专家」虚拟身份，行业 code 是**运行时参数**（存 session/context），系统提示词模板用 `{行业专家包}` 按 code 拉对应行业包 | 「一个 agent，N 个人格」，复用单 agent 的计费 / 版本 / 记忆 |

**默认虚拟，按需物化**：只有当某垂类需要独立产出模板 + 独立定价 + 进智库售卖时，才把它「提升」为一行物化 agent（走现有 `resolveEffectiveAgent` / `publishedVersionId`）。

---

## 3. 四块地基（任何模式都要）

1. **行业编码表（taxonomy）**：把自由文本枚举 `['SaaS/软件','消费/零售','制造','服务/咨询','其他']` 升级为 `{ code, label, aliases[], synonyms[] }`。`code` 是后续查表 / 打标 / 路由的主键。先覆盖问卷 4+1 项，可扩。

2. **行业知识包（Industry Pack）**——真正的「专家含量」，是内容活不是代码活。每个 code 一份结构化包：
   - 人格框架（这个行业军师怎么说话 / 关注什么）
   - 核心框架与指标（SaaS：NRR / CAC 回收 / Magic Number；餐饮：翻台率 / 坪效 / 食材成本率）
   - 行业基准（替换孤立的 `INDUSTRY_BENCHMARK`，改为按 code 查）
   - 术语表 + 常见误区 + 典型增长杠杆
   - 存储：先放配置 / DB 表；后期可把每条挂成带 `industry` 标签的 KnowledgeItem 走 RAG。

3. **行业检测（两路信号）**：
   - **声明式**：`Profile.industry`（问卷已采，`understanding` 的「经营身份」段已含行业）→ 用户级默认镜片，0 成本。
   - **推断式**：对当轮消息分类，判断「通用商业问题 vs 某行业专属问题」+ 置信度。

4. **注入与缓存**：行业人格放进 `buildSystemParts` 的 **stable 段**（同一行业可命中 prompt 缓存，省钱）；行业动态基准 / 召回放 dynamic 段。复用现成 stable/dynamic 切分。

---

## 4. 检测 / 路由设计（主 agent 识别 → 拉起行业专家）

三种触发器，按成本递增：

1. **画像默认镜片（声明式，0 延迟）**：`Profile.industry` 有值 → 该用户对话默认挂行业镜片。多数场景够用，无额外 LLM 调用。

2. **路由前置分类（推断式，+1 次廉价调用）**：generate 前跑一次便宜小模型分类器，输出 `{ kind: generic | industry:<code>, confidence }`。命中且过阈值 → 升级强行业镜片 / 切专家。落点：现有 `KEY2AGENT[text] ?? 'general'` 的 fallback 之前（`sessions.ts:116 / 276`），把「精确串匹配」扩成「匹配不上时问分类器」。

3. **Agent 自决 + 工具调用（最 agentic）**：给主军师一个工具 `consult_industry_expert(industry, question)`。主 agent 自判「需要行业深度」就调用，工具内用行业包跑子提示词、把专家意见揉回主回答。天然贴合「主 agent 识别到 → 拉起行业 agent」，且可在 UI 呈现可见 handoff。需 tool-use 管线（现无，P2）。

**护栏**：
- 置信度阈值之下一律回退通用，不瞎认行业；
- 检测结果按 **session 缓存**，不每轮重判；
- 给用户一键「我不是这个行业 / 切回通用」纠正入口；
- 行业镜片只补「视角与基准」，**不放宽商业边界 guard**。

---

## 5. UX：行业身份要不要可见

倾向**可见**（用户说「让军师具备一个行业领域的身份」）：
- 顶部 agent 名 / 徽标动态加行业后缀，如 `战略参谋 · SaaS`，或「SaaS 行业视角」小标签；
- 走工具路由时，给一条轻提示气泡「已接入 SaaS 行业专家视角」（类似现有「记忆已更新」mem-learned 条）；
- 用户可点徽标切换 / 关闭行业镜片。

---

## 6. 分阶段落地（映射代码缝，便于排期）

### P0 · 画像驱动人格镜片（1 个迭代，纯增量）
- 建 taxonomy + 4 个行业包（内容活）
- `{行业基准}` / 新增 `{行业专家包}` 占位符改为按 `code` 查表（`schema.ts:contextValues`、`seedConfig.ts:INDUSTRY_BENCHMARK`）
- 行业 code 取自 `Profile.industry`，`understanding` 已在传，注入点现成
- 行业人格进 `buildSystemParts` stable 段（缓存友好）
- UI 加行业徽标

### P1 · 意图分类升级（区分通用 vs 行业问题）
- 加廉价分类器，落在 `sessions.ts` agentKey 决议处
- session 级缓存检测结果 + 置信度护栏 + 用户纠正入口
- 知识检索加 `industry` 标签加权（`retrieval.ts`，KnowledgeItem 已有 `tagsJson`）

### P2 · 深垂类专家（按需）
- 高价值垂类物化成 agent 行（复用 `resolveEffectiveAgent` / 版本 / 计费）或上 tool-use handoff
- 行业级长期记忆沉淀

---

## 7. 涉及的关键代码缝（现状索引）

| 关注点 | 文件 | 行 | 作用 |
|---|---|---|---|
| agent 注册 / 字段 | `server/src/data/agents.ts` | 15–35, 67–392 | AgentSeed / AGENTS[] |
| 通用军师 | `server/src/data/agents.ts` | 68–90 | key=`general`，deliverableKey=null |
| 当前唯一路由 | `server/src/data/agents.ts` | 398–416 | `KEY2AGENT` 精确串匹配 |
| agentKey 决议点 | `server/src/routes/sessions.ts` | 116, 276 | `... ?? KEY2AGENT[text] ?? 'general'` |
| context 组装 | `server/src/services/context.ts` | 65–143 | buildGenContext |
| understanding 构建 | `server/src/services/understanding.ts` | 69–195 | 已含行业「经营身份」段 |
| prompt stable/dynamic | `server/src/llm/schema.ts` | 182–210 | buildSystemParts |
| 占位符映射 | `server/src/llm/schema.ts` | 147–167 | contextValues（`{行业基准}` 在此）|
| 行业基准（待升级）| `server/src/data/seedConfig.ts` | 96–98 | 单条硬编码 INDUSTRY_BENCHMARK |
| Profile 模型 | `server/prisma/schema.prisma` | 104–117 | industry / stage / pain / extraJson |
| 画像问卷 | `server/src/data/seedConfig.ts` | 35–39 | SURVEY（已问 industry）|
| 知识检索 scope | `server/src/services/retrieval.ts` | 43–53 | tenant 硬隔离 / user 硬隔离 / project 软加权；**无 industry 维度** |
| 知识标签 | `server/prisma/schema.prisma` | 414–443 | KnowledgeItem.tagsJson（可承载行业标签）|

---

## 8. 待拍板的开放问题

1. **首批做哪几个行业**？建议先做问卷 4 个（SaaS / 消费零售 / 制造 / 服务咨询），还是聚焦最赚钱的 1–2 个深做？
2. **行业身份「可见徽标 + 可切换」还是「静默变聪明」**？
3. **行业包内容谁来产**？可先定结构化模板 + 填 1 个 SaaS 样板，其余按模板扩（见附录）。
4. **检测触发**：P0 先只用画像声明（省钱稳），还是一上来就 per-message 分类？

---

## 附录 A · 行业包（Industry Pack）结构化模板

> 每个行业 code 一份。P0 先以配置 / DB 存；字段供 `{行业专家包}` 占位符按 code 注入。

```yaml
code: saas                      # 行业主键
label: SaaS / 软件
aliases: [软件, 订阅制软件, B2B 软件, 云服务]
synonyms: [ARR, MRR, 续费, 客户成功]     # 用于推断式检测的弱信号词

persona: |                      # 人格框架（进 stable 段）
  你此刻是深耕 SaaS 的增长 / 经营军师。默认以「可持续的经常性收入」为北极星，
  关注单位经济模型与留存复利，回答先点行业要害再给通用方法论。

frameworks:                     # 核心框架
  - 单位经济：CAC、LTV、LTV/CAC、CAC 回收周期
  - 留存复利：NRR / GRR、逻辑留存 vs 收入留存、扩张收入
  - 增长效率：Magic Number、Rule of 40、销售效率
  - 漏斗：PQL / SQL、试用转化、PLG vs SLG

kpis:                           # 关键指标 + 健康区间
  - NRR: 优秀 >110%，健康 100–110%，告警 <100%
  - 毛利率: 健康 70%+
  - CAC 回收: 健康 12–18 个月
  - 经常性收入占比: 目标 25%+（早期）

benchmark: |                    # 替换孤立 INDUSTRY_BENCHMARK
  SaaS A 轮前后典型：NRR 100–110%、毛利率 70%+、获客回收 12–18 个月、经常性收入占比目标 25%+。

pitfalls:                       # 常见误区（让回答更「行家」）
  - 用 GMV / 流水掩盖低毛利与高流失
  - 只看新签不看 NRR，增长靠烧钱续命
  - 过早自建销售团队，破坏 PLG 单位经济

levers:                         # 典型增长杠杆
  - 降流失（onboarding、客户成功、按价值定价）
  - 扩张收入（增购 / 升档 / 多产品）
  - 渠道效率（PLG 自助 + 销售辅助分层）

glossary:                       # 术语表（统一口径）
  ARR: 年度经常性收入
  NRR: 净收入留存率
  PQL: 产品合格线索
```

## 附录 B · 其余三个首批行业包（待按模板填充）

| code | label | 北极星 | 标志性指标（示例） |
|---|---|---|---|
| `retail` | 消费 / 零售 | 复购与坪效驱动的健康现金流 | 复购率、客单价、动销率、库存周转 |
| `manufacturing` | 制造 | 产能利用与交付下的毛利 | 产能利用率、良率、订单交付周期、应收账期 |
| `services` | 服务 / 咨询 | 人效与可复用资产 | 人均产值、项目毛利、利用率（billable）、回款周期 |

> `other`（兜底）：不注入行业镜片，走通用军师。

---

## 附录 C · 一句话总结

把「行业」做成**可叠加的镜片层**而非新 agent：P0 用画像把军师「变成行业专家」（复用现成 `{行业基准}` 注入缝），P1 加意图分类区分通用 / 行业问题并智能升级，P2 才对高价值垂类物化专家 agent。**默认虚拟人格、按需物化**，避免 agent 维度爆炸。
