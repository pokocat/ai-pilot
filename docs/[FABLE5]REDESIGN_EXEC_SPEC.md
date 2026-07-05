# 改造执行设计稿 · 加减法落地规格（供 coding agent 直接执行）

> **上游文档**：`docs/[FABLE5]AUDIT_V6_GLOBAL.md`（问题清单）→ `docs/AUDIT_V6_STRATEGY_ADD_SUBTRACT.md`（战略判断）→ **本篇（执行规格）**。
> 本篇把 16 项加减法建议拆成 **15 个 PR 级工单（WO-01 ~ WO-15）**，每个工单含：目标、数据模型、API 契约、前端/服务端/admin 改动点、prompt 变更、验收标准、依赖。文件路径均已对照真实代码库核实。
> 编写日期 2026-07-04

---

## 0. 全局执行约束（每个工单都必须遵守）

1. **SSOT 先行**：新增/修改任何接口字段，先改 `shared/contracts.d.ts`，再改三端（AGENTS.md §0 #4）。注意：现存 `ProgressView`/`BaziBody` 等类型定义在 `app/src/services/api.ts` 内，新类型一律进 contracts，存量顺手迁移的要保持前端旧名 re-export 兼容。
2. **mock 同口径**：`app/src/services/api.ts` 每个新方法必须有 `IS_MOCK` 分支，`app/src/services/mock.ts` 给出确定性假数据（AGENTS.md §4）。
3. **品牌红线**：一切新增文案/模板/prompt 用「军师参谋部」，禁用旧品牌标识（AGENTS.md §0 #10）。
4. **文档回写**：每个工单完成时更新 `AGENTS.md` 对应章节 + `docs/CHANGELOG.md` 顶部一条；里程碑级同步 Notion 变更日志页。
5. **测试**：服务端改动补 `server/test/` 集成测试（Fastify inject 风格，参照现有 casefiles/progress 测试）；外部服务（微信/短信/真模型）必须在 `NODE_ENV=test` 短路。
6. **admin UI**：凡改 `admin/`，颜色只用 token、组件类只用已定义的，提交前 `cd admin && npm run lint:ui` 全绿（AGENTS.md §0 #9）。
7. **小程序约束**：改 `app/` 页面/tabbar/弹层先对照 AGENTS.md §7.2 清单；全屏弹层记 `store.setOverlay(open)`。
8. **数字铁律**：任何展示给用户的统计数字（准确率/命中率/对齐率/基准分位）一律服务端计算后注入或下发，prompt 中明确禁止 AI 自算——新增数字类能力时同步在注入块写禁算口径（参照 DecisionLog 的做法）。
9. **不动生产**：本设计稿全部工单只落库到代码与本地/预发；生产部署仍走 `scripts/deploy-prod.sh` + 人工确认（memory：prod 非 git）。

**建议 PR 顺序与依赖图**：

```
批次一（减法，无互相依赖，可并行）: WO-01  WO-02  WO-03  WO-04  WO-05
批次二（地基）: WO-06 → WO-07（速诊是 journey 的第一态）
              WO-08（独立） WO-09（独立） WO-10（独立） WO-11（独立）
批次三（生态）: WO-12 ← 依赖 WO-07（journey）+ WO-02（货架撤除后处方是唯一销售位）
              WO-13 ← 依赖档案质量（无硬依赖，建议在 WO-06/07 后）
              WO-14 ← 依赖 WO-12（先有处方才有回流）
              WO-15 ← 纯设计文档，可随时写，实施在生态第二产品立项时
```

---

# 批次一：减法（先让主线露出来）

---

## WO-01 · IA 收敛：案卷单主线 + 名词统一

**对应**：L-4（项目/案卷双容器）、L-8（名词过载）。**规模**：M（纯前端 + 文案，不改数据模型）。

### 目标
用户侧只保留 **案卷 / 方案 / 军令 / 资料** 四个业务名词；「项目」作为独立入口从前台消失，Project 模型与路由保留不动（工程底座继续用）。

### 名词映射表（全前端文案 sweep 的依据）

| 旧词（界面上出现过的） | 新词 | 说明 |
|---|---|---|
| 项目 / 项目工作台 | 案卷 | Project 详情页内容并入案卷详情视图 |
| 报告 / 成果 / 交付物 | 方案 | ReportDoc/Deliverable 统一叫「方案」，版本叫「方案 v2」 |
| 卡片 / 战报卡 | 战报 | B 级卡统一口径 |
| 纪要 | 并入「方案」（类型标注：纪要） | summarize 产物 |
| 知识 / 资料 / 文档 | 资料 | KnowledgeItem 统一口径 |
| 记忆 / 专属理解 | 军师印象 | 用户可见处统一；后台术语不变 |
| 模块 / Skill / 能力 | 能力 | 见 WO-02 |

### 改动点
1. **前端页面**：
   - `app/src/packages/work/projects/index.tsx` + `project/index.tsx`：改造为「案卷列表 / 案卷详情」。案卷详情页 = 现 Casefile 视图（军令/回填/复盘）+ 原 Project 详情的会话列表、方案列表、资料段合并为页内 tab（`战况 | 方案 | 资料`）。数据源：现有 `/casefile` + `/projects/:id` 两个接口在页面层聚合，**不新增后端接口**；Casefile 与 Project 的关联在页面层用 `projectId`（Casefile 若无 projectId 字段，则以「用户唯一 active 案卷 + 项目列表」并列呈现，聚合逻辑写在页面 loader）。
   - `app/src/pages/profile/index.tsx` 菜单：「项目工作台」条目改「我的案卷」，指向改造后的列表页。
   - 全局文案 sweep：`grep -rn "项目\|报告\|成果\|纪要\|记忆" app/src --include="*.tsx"` 逐处按映射表替换（仅用户可见字符串，变量名/路由名不动）。
2. **不做**：数据模型合并、路由重命名、admin 端改名（后台保留工程术语）。

### 验收
- [ ] 前台任何页面不再出现「项目」二字（`grep -rn "项目" app/src --include="*.tsx"` 只允许命中注释/变量名）。
- [ ] 案卷详情页三个 tab 可用，方案列表点击进入现有 report 页，资料列表点击进入现有 knowledge 详情。
- [ ] mock 模式下全流程可走通（mock.ts 无需新接口，仅聚合）。

---

## WO-02 · 智库 tab 改造：市场目录 → 能力管理页

**对应**：L-5、E-6（撤货架）、L-6（撤三势空卡）。**规模**：M。

### 目标
智库 tab 从「逛集市」改为「我的军备库」：只展示**已开通能力**与**资料库/方案库**；未开通能力不再有浏览目录，唯一获得渠道是处方（WO-12）与军师对话推荐。

### 改动点
1. `app/src/pages/thinktank/index.tsx` 重构为三段：
   - **我的能力**：已开通 agent/能力卡（数据源：现有 `me`/agents 接口过滤 `owned=true` 或 `billing='free'`），每卡两个动作「去使用（跳对话）」「用量（跳 credits 页）」。
   - **资料库**：保留现有资产区（上传/分类/优化入口不变）。
   - **方案库**：保留版本化报告入口不变。
2. `app/src/packages/work/market/index.tsx`：**保留文件与路由**（处方跳转的落地页），但删除从 tab/菜单进入的所有入口；页面顶部加来源上下文（「军师为你开出的能力」，读 query 参数 `from=prescription&pid=xxx`，为 WO-12 预留）。
3. `app/src/pages/home/index.tsx`：撤下三势判断静态框架卡（保留天势卡→天时日历的直达，因为它有真实数据；市势/人势两张纯引导卡删除）。相应区域替换为 WO-07 的「下一步」卡占位。
4. 「送你一卦」入口从 profile 菜单**移除**（合规 P-4 + 被 WO-06 速诊卡替代）；`packages/work/gift` 文件保留不删（回滚余地），仅摘入口。

### 验收
- [ ] 智库 tab 无任何「未开通/价格/💎」元素露出（未开通能力全部不可见）。
- [ ] market 页面无 tab 级入口可达，直接输入路由仍可打开（供处方跳转）。
- [ ] 战局页无市势/人势静态卡；天势→日历链路不受影响。
- [ ] profile 菜单无「送你一卦」。

---

## WO-03 · 冷启动体验：段位/账本延迟曝光 + 空态导流

**对应**：L-7、F-7（3/5 tab 空态）、P-1 的前端部分。**规模**：S。

### 改动点
1. `app/src/pages/profile/index.tsx` 战略段位卡（rank-card，约 L111-124）：渲染条件改为 `prog && (prog.streak >= 3 || prog.usageDays >= 14)`；不满足时整卡不渲染（不要渲染灰态）。
2. 战局页/执行页空态重写（无判断/无案卷时）：
   - 战局页空态 = 一张全宽引导卡：「军师还没为你建档 · 3 个问题，10 分钟拿到你的初诊」→ 按钮跳 WO-06 速诊（速诊未上线前先跳对话 tab 并预填开场语）。
   - 执行页空态 = 「还没有作战方案 · 先去参谋室聊一次」→ 跳对话。
   - 空态文案统一放 `app/src/data/` 新文件 `emptyStates.ts`，禁止散落在页面内。
3. 军师注入侧：`server/src/services/context.ts` 中【段位·里程碑】块的注入条件已是"新用户零记录不注入"——补一条同口径规则：`streak < 3` 时注入块中**不含具体百分比字段**（避免军师念出"准确率 null%"类话术），只含天数。

### 验收
- [ ] 新注册 mock 账号：profile 无段位卡，战局/执行页显示导流空态且按钮可跳转。
- [ ] 老账号（mock 数据造 streak≥3）：段位卡正常显示。
- [ ] server 测试：新用户 buildGenContext 产物不含「准确率」字样。

---

## WO-04 · 复盘收敛三层 + 军师科室收编

**对应**：C-7、C-8，顺带修上游审计 A-4 的 week/month 账本缺失。**规模**：M。

### 目标
复盘对用户只有三层：**日打卡 / 周复盘 / 月战报**。季=3 个月聚合视图（不单独复盘）、年=12 个月聚合（M 后续）、团队复盘下架。专业军师收敛为 4 个处方科室。

### 改动点
1. **服务端**：
   - `services/scheduler.ts` / `resolveMode`：季/年/团队触发词降级——识别到时不再进入独立模式，军师话术引导到月度线（modeLine 注入一句：「季度和年度看法我在月度战报里滚动给你」）。
   - **week/month 落库**（修 A-4）：`routes/sessions.ts` 完成一次 `review:week` / `review:month` 模式对话后，upsert `ReviewLog(layer='week'|'month', date=周一|当月1号)`，快照字段：本周期 `CasefileMetric` 聚合（leads/consults/deals 求和）+ 军令完成/对齐计数。写入位置参照 day 层现有实现（`services/reviewLog.ts`）。
   - 月战报注入块新增【本月数据】：从 CasefileMetric 聚合 30 天序列（周环比、月累计），禁 AI 自算口径同 DecisionLog。
2. **前端**：`app/src/pages/studio/index.tsx` 复盘区加「月战报」入口（每月 1 日后可生成上月战报，按钮发预定义 prompt `生成上月战报`——走触发词但由按钮保证命中率，绕开 A-2 的路由脆弱性）。
3. **军师收编**（`server/src/data/agents.ts` + admin 下架操作说明）：
   - 保留：`strat`（战略诊断）、`growth`（增长/获客——影响力处方的科室）、`ops`（经营参谋——数据/复盘深聊）、`brand`（品牌/IP——数字人短剧处方的科室）。
   - 下架（enabled=false，不删数据）：其余 advisory agent。seed 不重跑，写幂等 UPDATE 脚本 `server/scripts/`（参照 prod-plan-quota-reseed 教训：db push 不带 seed）。
   - 已购用户保护：`UserAgent` 存量权益保留，已解锁的下架 agent 对该用户仍可见可用（`assertAgentAccess` 加一条：owned 则忽略 enabled=false）。
4. **prompt**：general 的 V6.0 prompt 中六层复盘章节改三层（与 WO-05 的 prompt 手术合并为同一次编辑，见 WO-05）。

### 验收
- [ ] 完成一次周复盘对话后 `ReviewLog` 出现 week 行，快照数字与 CasefileMetric 聚合一致（集成测试断言）。
- [ ] 月战报注入块数字=服务端聚合值（测试中 mock 模型 echo 上下文验证）。
- [ ] 未购用户 agent 列表只见 4 科室 + general；已购下架 agent 的用户仍可进入其会话。
- [ ] 触发「团队复盘」话术时军师引导语出现且不产生 ReviewLog team 行。

---

## WO-05 · 命理模块全局开关 + prompt 去机制化手术

**对应**：C-6、上游审计 P-3（合规）与 A-1（prompt 手术），三件事一次做完因为都动同一份 prompt。**规模**：L，**优先级最高（合规前置）**。

### 目标
三层开关（UI / 注入 / 路由）让命理可一键降级为「经营节奏」话术；同时对 41KB prompt 做外科手术：剥离账本生产指令与已服务端化的机制。

### 数据模型
```prisma
model FeatureFlag {
  id        String   @id            // flag key，如 'fortune'
  enabled   Boolean  @default(true)
  payload   Json?                   // 预留分级参数
  updatedAt DateTime @updatedAt
}
```
服务 `server/src/services/featureFlag.ts`：`isEnabled(key)` 带 60s 内存缓存；admin 路由 `PATCH /admin/flags/:id`（复用 admin 鉴权），admin 前端「配置」页加开关行。

### 三层开关行为（flag `fortune` = false 时）
| 层 | 行为 |
|---|---|
| 路由 | `routes/cards.ts` 的 fate/calendar 卡、`routes/profile.ts` 排盘相关端点返回 `403 {code:'FEATURE_DISABLED'}` |
| 注入 | `services/context.ts`：命盘块不注入，改注入一句「命理模块关闭：一切节奏判断使用行业周期与经营数据语言，禁止出现八字/命格/流月术语」 |
| 前端 | `Me` 契约加 `features: { fortune: boolean }`（contracts.d.ts + /me 下发）；天时日历入口、八字表单、报告内命理板块按 flag 条件渲染；mock 默认 true |

### prompt 手术（`server/prompts/strat.v6.md` → 新文件 `strat.v7.md`）
逐章处置清单（保留原文件不动，新文件入库走 agent_version 草稿→发布流）：

| V6.0 章节 | 处置 | 理由 |
|---|---|---|
| 一（势哲学）、二（角色）、十七（语气）、十八（语录） | **保留** | 人设资产 |
| 三（路由表） | **删** | resolveMode 服务端已接管；保留一句「模式由系统标注在上下文中」 |
| 四（天势系统） | **保留表达层，删推演层**：4.7 术语翻译表保留；4.2 推演引擎、4.5 择时步骤、4.6 团队匹配、称骨紫微细则删除，改为「命盘结论以上下文【命盘】块为准，你只做白话翻译，禁止自行推算任何干支/格局/吉凶」 | 排盘已服务端化（paipan.ts），LLM 自算=伪命理 |
| 4.8 预言验证、九（决策日志/战略档案） | **删格式与记录指令**，改为「预言与决策由系统记账，账本数据见【天机账本】【决策账本】块，禁止编造账本条目与命中率」 | 防伪账本（A-1 核心） |
| 五（十二问）、六（六轮对话）、七（阶段自适应）、八（行业库→删，见 WO-08）、十四（思想武器）、十六（防呆） | **保留**，六层复盘改三层（WO-04） | 方法论主体 |
| 十一（上瘾机制） | 悬念钩子**降级**：「只允许埋不带具体时间承诺的开放式钩子」（修 F-2 的止血版）；里程碑/段位话术改为「以【段位·里程碑】块为准，块中没有就不提」 | 防失约 |
| 十二（仪式感）、十三（看板）、十五（自检） | 仪式保留；看板章删除（数字全部来自注入块）；自检保留 | |
| 全篇 | 旧品牌名→「军师参谋部」；谶语保留但删「事后看觉得神准」的自我要求 | 红线 + P-2 |

发布流程：新 prompt 走 admin 的 agent_version 草稿 → 评测（`services/evals.ts` 若有基线用例则跑）→ 发布快照；**同时 UPDATE agent 行与 agent_version 两处**（AGENTS.md §13 #3 的教训）。

### 验收
- [ ] flag 关闭时：/me 返回 fortune=false；前端无命理入口；对话中命盘块不注入且注入禁令生效（测试断言上下文含禁令句）；fate 卡接口 403。
- [ ] 新 prompt 字节数 < 25KB（手术减重目标 ~40%）。
- [ ] 回归：mock 对话/成果生成/复盘全链路测试绿。

---

# 批次二：咨询地基

---

## WO-06 · 3 问速诊 + 初诊卡（新入口产品）

**对应**：L-2，替代「送你一卦」承担裂变。**规模**：M。

### 用户流程
登录后（或战局/执行空态点入）→ 速诊页：3 个结构化问题（①行业：复用 12 行业 survey 选项；②年营收段：四档，复用 survey；③最痛的一件事：单行文本）→ 提交 → 15 秒内出「初诊卡」：主要矛盾假设（1 句）+ 军师判断（2-3 句）+ 今天就能做的一件事（1 条）+ 「想要完整作战方案？进参谋室聊 6 轮」CTA → 卡片可分享（publishCard 链路）。

### 契约（contracts.d.ts 新增）
```ts
export interface QuickScanRequest { industry: string; revenueBand: string; pain: string; }
export interface QuickScanResult {
  contradiction: string;   // 主要矛盾假设
  judgement: string;       // 军师判断
  firstMove: string;       // 今天就能做的一件事
  cardUrl: string | null;  // 分享卡 HTML 链接
}
```

### 服务端
- 路由 `POST /quickscan`（`routes/profile.ts` 或新 `routes/quickscan.ts`）：
  1. 限流：每用户每日 3 次（内存/Redis via `services/cache.ts`）。
  2. 调 gateway：专用小 prompt（≤2KB，不加载 V6.0 全文），JSON schema 强约束三字段输出；mock provider 返回确定性模板。
  3. 副作用：`Profile.industry/stage/pain` 若为空则回填（速诊即建档）；`UserJourney.quickScanAt` 打点（WO-07）。
  4. 计费：走 token 轴 metered、ratio 低配（如 0.3）；额度不足**不拦**（速诊是获客动作，走 grace 逻辑，`reserveQuota` 加 `grace:'quickscan'` 类别，每日 1 次保底）。
- 卡片模板：`services/cardHtml.ts` 新增 `quickscan` 模板（视觉沿用现有三张卡的深绿金体系；底部裂变位文案「你的同行也在打仗？把这张卡转给他」+ 小程序码位预留）。
- `routes/cards.ts` publishCard 支持 kind='quickscan'。

### 前端
- 新分包页 `app/src/packages/work/quickscan/index.tsx`：3 问表单（选项数据复用 survey 接口）→ 结果卡展示 → 分享（useShareAppMessage）+「进参谋室」跳对话 tab。
- 入口：WO-03 的两个空态卡 + 对话 tab 顶部常驻小入口（新用户 7 天内展示）。
- `api.ts` 加 `quickScan(req)`；mock 返回固定样例。

### 验收
- [ ] mock 模式 3 问提交→出卡→分享链路通。
- [ ] server 测试：quickscan 后 Profile 三字段回填；重复提交不覆盖已有值；日限流 4 次时 429。
- [ ] 额度为 0 的测试用户当日第 1 次速诊成功、第 2 次被拦。

---

## WO-07 · 用户级 Journey 状态机 + 全 tab「下一步」卡

**对应**：L-1、L-3，顺带修上游 F-5（诊断轮次会话级丢失）。**规模**：L（核心工单）。

### 数据模型
```prisma
model UserJourney {
  id             String    @id @default(cuid())
  tenantId       String
  userId         String    @unique
  stage          String    @default("new")
  // new → scanned → diagnosing → plan_ready → executing → reviewing
  diagRound      Int       @default(0)   // 已完成诊断轮次（用户级，修 F-5）
  diagSessionId  String?                 // 当前诊断承载会话
  quickScanAt    DateTime?
  planAcceptedAt DateTime?
  firstReviewAt  DateTime?
  updatedAt      DateTime  @updatedAt
  @@index([tenantId])
}
```

### 状态迁移（全部服务端触发，禁止前端直写 stage）
| 事件 | 代码位置（挂钩点） | 迁移 |
|---|---|---|
| 注册 | auth 路由 | → new |
| 速诊完成 | WO-06 路由 | new → scanned |
| general 会话完成一轮（strategy 模式下一问一答收尾） | `routes/sessions.ts` 消息落库后 | diagRound+1；new/scanned → diagnosing |
| 认可方案（casefile accept） | `routes/casefiles.ts` | → plan_ready → executing（同一事件双跳，plan_ready 是瞬时态用于埋点） |
| 首次 day 复盘 | `services/reviewLog.ts` | executing → reviewing（终态，长期停留） |

**轮次口径变更**：`services/context.ts` 的「诊断进度：本会话第 N 轮」改为读 `UserJourney.diagRound`（用户级），会话切换/误删不再清零；`diagSessionId` 变化时轮次**不重置**，军师话术自然接续（「我们上次聊到第 3 轮」）。

### 契约与接口
```ts
export interface JourneyView {
  stage: 'new'|'scanned'|'diagnosing'|'plan_ready'|'executing'|'reviewing';
  diagRound: number;            // 0-6
  nextStep: {                   // 服务端派生，前端只渲染
    key: string;                // 'quickscan'|'continue_diagnosis'|'accept_plan'|'do_orders'|'backfill'|'do_review'|'monthly_report'
    title: string;              // 「继续第 4 轮诊断」
    desc: string;
    route: string;              // 前端跳转 path（含参数）
  } | null;
}
```
`GET /journey` 返回上述；`nextStep` 派生规则写在 `services/journey.ts` 单一函数 `deriveNextStep(journey, casefile, todayReview)`（纯函数，单测覆盖全部分支）：
- new → 速诊；scanned → 进参谋室（继续诊断）；diagnosing → 「继续第 N+1 轮」；executing 且今日军令未完成 → 军令；军令完成未回填 → 回填；已回填未复盘且时间 >19:00 → 复盘；月初 1-3 日且上月未生成 → 月战报。

### 前端
- 新组件 `app/src/components/NextStepCard/index.tsx`：一张全宽卡（标题/描述/按钮），数据 `api.journey()`。
- 挂载位置：战局页顶部（替换 WO-02 撤掉的区域）、执行页顶部、对话 tab 会话列表顶部。三处同一组件同一数据。
- 案卷详情页（WO-01）军令卡显示血缘：「来自《方案名》第 N 节」（数据已有 source 标签，补方案反向统计：方案详情页显示「已拆 X 条军令 · 完成 Y 条」，接口在 `/casefile` 现有数据上聚合，不新增模型）。

### 验收
- [ ] 单测：deriveNextStep 全分支（≥8 个 case）。
- [ ] 集成：注册→速诊→3 轮对话→认可→打卡→复盘，`GET /journey` 的 stage/diagRound/nextStep 全程断言正确。
- [ ] 会话删除后 diagRound 不变（修 F-5 的回归测试）。
- [ ] 三个 tab 顶部渲染同一「下一步」内容。

---

## WO-08 · 行业基准库（benchmark 数据资产 + 注入）

**对应**：C-2，替代 prompt 内 6 行业静态模板。**规模**：M（工程）+ 持续（运营内容）。

### 数据模型
```prisma
model IndustryBenchmark {
  id          String   @id @default(cuid())
  industry    String                  // 与 survey 行业口径一致（12 行业）
  revenueBand String   @default("*")  // 营收段，'*'=不分段
  metricKey   String                  // 'repurchase_rate' | 'cac' | ...
  metricName  String                  // 展示名「复购率」
  unit        String                  // '%' | '元' | '天'
  p25         Float?
  p50         Float?
  p75         Float?
  note        String?                 // 口径说明
  source      String?                 // 数据来源
  enabled     Boolean  @default(true)
  updatedAt   DateTime @updatedAt
  @@unique([industry, revenueBand, metricKey])
}
```
无 tenantId（全局内容资产）。

### admin
- 「内容」区新增「行业基准」tab：表格 CRUD + CSV 批量导入（前端解析后逐行 upsert）+ 按行业筛选。契约 `AdminBenchmarkRow` / upsert 请求进 contracts。
- 种子数据：`server/prisma/seedBenchmarks.ts` 先放美业/大健康、餐饮、电商三行业 × 6 指标的占位行（p50 留空、note 写「待运营核实」——**宁缺勿假**，空分位不注入）。

### 注入与 prompt
- `services/context.ts` 新增【行业基准】块：取用户 `Profile.industry` + 阶段映射 revenueBand，查 enabled 且 p50 非空的行，格式化为「复购率：行业中位 45%（P25 30% / P75 60%）」。块尾禁算口径：「基准数字以本块为准，块中没有的指标不得引用行业数据」。
- prompt（WO-05 的 v7 文件）：第八部分行业知识库**整章删除**，替换为「行业认知以【行业基准】块与追问三问为准」；追问三问保留。
- 军师复盘/诊断话术即可自然产生「你的 X 在行业什么位置」——依赖 WO-10 的用户侧指标才能对比，两个工单联动但不互相阻塞（基准块先上，无用户数据时军师只引用基准不做对比）。

### 验收
- [ ] admin CRUD + CSV 导入可用，lint:ui 绿。
- [ ] 美业测试用户上下文含【行业基准】块且只含 p50 非空指标；无行业用户不注入。
- [ ] prompt v7 无任何行业客单价/公司名硬编码（grep 断言：榕树家/瑞斯 不出现）。

---

## WO-09 · 知识库分析产品化：财务表 → 经营体检报告

**对应**：C-3。**规模**：L。

### 用户流程
资料库上传 Excel/CSV 财务表（已有 OSS+docParse 管道）→ 解析完成后资料卡出现「生成经营体检」按钮 → 点击 → 产出「经营体检」方案（走 deliverable 体系，自动入方案库成版本）→ 战局页经营数据区引用最新体检结论。

### 服务端
1. **模板**：`server/src/data/deliverables.ts` 新增「经营体检」模板，sections 骨架：
   `收入结构｜成本与毛利｜费用异动｜现金流信号｜三个最该动手的地方`。
2. **结构化抽取**：`services/docParse.ts` 后接新函数 `services/finParse.ts`：
   - 输入：解析出的表格文本（现有 chunk）；
   - gateway 调用（JSON schema）：抽 `periods[]`（月份）、`revenue[]`、`cogs[]`、`expenses[{name, values[]}]`、`cash[]`——**允许部分字段缺失**，抽不出的置 null 并在报告中写明「表内未见」；mock 返回固定样例；
   - 派生指标（纯代码算，不给 LLM）：毛利率序列、费用率环比、单月现金净流——存入 `KnowledgeItem` 新字段 `analysisJson Json?`。
3. **生成**：`POST /knowledge/:id/analyze` → 组装上下文（analysisJson 数字 + 行业基准块）→ 走现有 `/generate` 内部管线产出 deliverable（agentKey=ops，deliverableKey='经营体检'）→ 自动 `saveReport` 成版。计费：正常 metered。
4. **约束**：报告正文数字必须来自 analysisJson（prompt 内写明「所有数字引用【财务摘要】块，禁止推算新数字」）。

### 前端
- `packages/work/knowledge`（资料详情）：解析完成且检测为表格类时显示「生成经营体检」按钮 → loading → 完成后跳方案详情。
- 战局页经营数据区：若存在经营体检方案，尾部加一行「最新体检：三个该动手的地方 →」链接。
- 契约：`KnowledgeDetail` 加 `canAnalyze: boolean`、`AnalyzeResult { reportId, version }`。

### 验收
- [ ] 上传样例 CSV（`server/test/fixtures/finance-sample.csv` 新建）→ analyze → 方案库出现「经营体检 v1」，sections 齐 5 节。
- [ ] analysisJson 派生指标单测（毛利率/环比计算）。
- [ ] 同表重复 analyze → 版本去重（contentHash 机制生效）或 v2 带变更摘要。
- [ ] mock 模式全流程通。

---

## WO-10 · 结构化经营周报数（真实数据接入 v1）

**对应**：C-1 的降级起步版。**规模**：M。

### 设计
不动 OAuth 接入（另立项），先把「手工报数」升级为**行业模板化的结构化周报**：字段由行业决定、与基准库 metricKey 对齐，形成连续序列供军师对比。

### 数据模型
```prisma
model BizMetricWeekly {
  id         String   @id @default(cuid())
  tenantId   String
  userId     String
  weekStart  String                    // YYYY-MM-DD（周一）
  metricsJson Json                     // { metricKey: number } 与 IndustryBenchmark.metricKey 同口径
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@unique([userId, weekStart])
}
```
（日粒度三数仍走 CasefileMetric 不动；周报是补充维度。）

### 服务端
- `GET /biz-metrics/template`：按用户行业返回该行业启用的 metricKey 列表（数据源=IndustryBenchmark 行业下的指标集，保证「报什么就能对比什么」）。
- `PUT /biz-metrics/:weekStart` upsert；`GET /biz-metrics?weeks=8` 序列。
- 注入：周/月复盘模式下新增【经营序列】块——最近 8 周各指标值 + 与行业 p50 的差（**服务端算好差值**，格式「复购率 31%，低于行业中位 14 个百分点，连续 3 周下行」）。
- 提醒钩子：周五周复盘的前置检查（复盘时本周未报数→军师第一句先要数，话术在 modeLine 注入）。

### 前端
- 执行页周复盘区上方加「本周经营数据」表单（字段动态渲染 template 接口）；已填显示只读+改按钮。
- 契约：`BizMetricTemplate`、`BizMetricWeek` 进 contracts；mock 给美业样例。

### 验收
- [ ] 美业用户 template 返回美业指标集；填报后 8 周序列接口正确。
- [ ] 周复盘上下文含【经营序列】块，差值与手算一致（测试断言）。
- [ ] 未填报时周复盘 modeLine 含要数指令。

---

## WO-11 · 账本用户可见：决策/天机账本页 + 修正流

**对应**：C-5、上游 F-8。**规模**：M。

### 服务端（大部分已有，补齐缺口）
- `routes/decisions.ts` / `routes/prophecies.ts` 已存在：核对并补齐 ① 分页列表（含状态过滤）② 用户侧统计接口（准确率/命中率+样本量 n）③ **修正接口**：
  - `PATCH /decisions/:id` body `{dispute: string}` → 状态置 `revise` 待复核？**不对**——用户异议不直接改状态，新增字段 `disputeNote String?` + `disputedAt`，军师下次复盘时带出（注入块中标注「用户有异议：…」），由对话确认后走既有状态更新。预言同理。
  - 最小样本保护（修 P-2 一部分）：统计接口在 `n < 5` 时返回 `rate: null, sampleTooSmall: true`；注入块同规则（progress.ts 同步）。
- Prisma：DecisionLog/ProphecyLog 各加 `disputeNote/disputedAt` 两字段。

### 前端
- 新分包页 `app/src/packages/work/ledger/index.tsx`：双 tab「决策账本｜天机账本」。
  - 决策条目：#seq · 日期 · 决策一句话 · 状态徽章（待验证/正确/需修正）· 展开见理由/验证标准/天势参考 · 「有出入？」→ 输入异议提交。
  - 天机条目：#seq · 预言 · 到期日 · 状态（待验/命中/未中）· 异议入口同上。
  - 顶部统计条：`n≥5` 才显示百分比，否则显示「样本还不够，先打满 5 个验证再看数」。
- 入口：profile 段位卡点击进入（段位卡隐藏期入口也隐藏，与 WO-03 一致）；月战报卡内「查看账本」链接。
- 契约：`LedgerDecisionItem/LedgerProphecyItem/LedgerStats` 进 contracts；mock 造 6 条样例。

### 验收
- [ ] 列表/分页/异议提交全链路（mock + server 测试）。
- [ ] n=3 时统计接口 rate=null；n=6 时返回数值——注入块与页面同口径（双处断言）。
- [ ] 异议后下次复盘上下文含「用户有异议」标注。

---

# 批次三：生态引擎

---

## WO-12 · 处方引擎：诊断结论 → 生态能力的结构化桥 + 转化漏斗

**对应**：E-1、E-5。**规模**：L（生态化的核心工单）。**依赖**：WO-07（journey）、WO-02（货架已撤）。

### 概念模型
处方 = 军师在方案/军令/复盘中开出的「问题→打法→工具」三元组，带完整转化状态机。

```prisma
model Prescription {
  id           String    @id @default(cuid())
  tenantId     String
  userId       String
  casefileId   String?
  deliverableId String?                 // 出自哪份方案
  orderId      String?                  // 挂载到哪条军令（CasefileOrder）
  problem      String                   // 针对的问题（一句话）
  playbook     String                   // 打法（一句话）
  toolKey      String                   // 生态能力 key（= Agent.key 或未来外部产品 key）
  toolType     String    @default("agent") // 'agent' | 'external'（数字人/短剧等站外产品）
  externalUrl  String?                  // toolType=external 时的跳转（小程序 appId/path 或 H5）
  status       String    @default("proposed")
  // proposed → seen → clicked → activated → used → verified | dismissed
  proposedAt   DateTime  @default(now())
  seenAt       DateTime?
  clickedAt    DateTime?
  activatedAt  DateTime?                // 完成解锁/开通
  firstUsedAt  DateTime?
  outcomeJson  Json?                    // WO-14 回流数据
  dismissedAt  DateTime?
  @@index([userId, status])
}
```

### 处方产生（两个来源，都是服务端确定性写入，不靠 LLM 自由发挥）
1. **方案认可时**：`routes/casefiles.ts` accept 流程中，扫描 deliverable sections——新增结构化约定：deliverable schema（`shared/contracts.d.ts` 的 `Deliverable`）加可选字段
   ```ts
   export interface DeliverablePrescription { problem: string; playbook: string; toolKey: string; }
   export interface Deliverable { /* 现有字段 */ prescriptions?: DeliverablePrescription[]; }
   ```
   gateway 生成方案时 schema 内带该数组（prompt 指令：「若打法需要工具承接，从【可开方工具表】中选择 toolKey，最多 3 条；表中没有的不得开」）。**【可开方工具表】注入块**：服务端把 enabled 生态能力（key/名称/一句话能力/适用问题）注入上下文——工具白名单在服务端，LLM 只能从白名单点菜，解决「计费冲突→调度白名单」的历史遗留（memory 已标记）。
   accept 时把 `prescriptions[]` 落库并挂到对应军令（按 section 顺序对齐）。
2. **手动开方**：admin/运营侧暂不做；对话中军师推荐能力时前端识别 acts 跳转（现有 acts 机制），不落 Prescription（避免噪声）。

### 前端呈现（处方是唯一销售位）
- **军令卡挂载**：`studio/index.tsx` 军令条目若关联处方：卡底部一行「⚡ 军师配了工具：{名称}」→ 点击 = `POST /prescriptions/:id/click` 埋点 + 跳转（agent → market 页带 `from=prescription&pid=`；external → 小程序跳转/webview）。
- market 页（WO-02 保留的落地页）：读 pid 显示处方上下文（「为『{problem}』开出」），开通成功回调 `POST /prescriptions/:id/activate`。
- 方案详情页：处方汇总区（本方案开出 N 张处方 · 已启用 M）。
- 状态埋点：列表曝光时批量 `POST /prescriptions/seen`；dismissed = 用户在军令卡上长按「不需要」。

### 漏斗报表（admin）
- `GET /admin/prescriptions/funnel?days=30`：按 toolKey 聚合 proposed→clicked→activated→used 各级计数与转化率。admin「消耗」区加一个漏斗表格页。

### 验收
- [ ] 生成含 prescriptions 的方案（mock schema 样例）→ accept → Prescription 行落库且挂到军令。
- [ ] toolKey 不在白名单 → 服务端过滤丢弃并审计（不入库不报错）。
- [ ] click/activate/seen 埋点时间戳落库；漏斗接口聚合正确（造 3 用户数据断言）。
- [ ] 军令卡→market→开通→回军令卡的完整前端动线（mock）。

---

## WO-13 · 品牌资产包（Brand Kit）：档案 → 生态产品的预填输入

**对应**：E-2。**规模**：M。

### 数据模型
```prisma
model BrandKit {
  id          String   @id @default(cuid())
  tenantId    String
  userId      String   @unique
  personaJson Json     // IP 人设卡：{ name, tagline, tone, story, doNots[] }
  voiceJson   Json     // 话术库：{ hooks[], openers[], ctas[], taboos[] }
  themeJson   Json     // 视觉调性：{ keywords[], colorHint, styleRefs[] }
  version     Int      @default(1)
  generatedAt DateTime @default(now())
  approvedAt  DateTime?               // 用户确认过才可被生态读取
}
```

### 生成（`services/brandKit.ts`）
- 输入拼装：StrategicProfile（定位/赛道/矛盾）+ Profile（行业/阶段/故事 extraJson）+ understanding 摘要 +（fortune 开启时）命盘性格段。
- gateway JSON schema 强约束三段输出；mock 确定性样例。生成条件：journey ≥ plan_ready（没方案就没定位，不给生成）。
- `POST /brand-kit/generate`（重生成 version+1）、`GET /brand-kit`、`POST /brand-kit/approve`。

### 前端
- 新分包页 `packages/work/brandkit/index.tsx`：三段卡片展示（人设/话术/调性）+「有偏差？告诉军师」（跳对话预填修正语，重生成走对话确认后触发）+「确认无误」按钮（approve）。
- 入口：profile 菜单「我的品牌资产」+ 处方跳转 external 产品前的中间页（「已为你备好人设包」）。

### 对生态产品的出口
- `GET /brand-kit/export?token=`：签名 token（复用 reportShare 的不可猜 id 思路 + **加 TTL 1h**），返回 approved 的三段 JSON——数字人/短剧产品用它预填人设。未 approve 返回 403。token 签发接口需登录态，生态产品经由 WO-15 的统一账号体系换取。

### 验收
- [ ] plan_ready 前生成接口 403；之后生成三段齐全。
- [ ] approve 前 export 403；approve 后 token 1h 内有效、过期 401。
- [ ] 命理 flag 关闭时 personaJson 不含命格字样（测试断言）。

---

## WO-14 · 成果回流 v1：处方效果回填 → 复盘引用

**对应**：E-3。**规模**：S（v1 手工版）。**依赖**：WO-12。

### 设计
v1 不做产品间 API 回传，先做**结构化手工回填 + 军师追问闭环**：
1. Prescription status=activated 超过 7 天 → scheduler 新 job `prescription-followup-scan`（复用现有 job 骨架与幂等模式）标记待追踪。
2. 周复盘 modeLine 注入：「用户开通的 {工具名} 已用一周，先问效果（发了几条/带来多少线索），把数字要到」。
3. 回填接口 `POST /prescriptions/:id/outcome` body `{period: 'week', metrics: {posts?: number, leads?: number, gmv?: number}, note?: string}`——两个写入口：① 执行页处方卡「填效果」小表单；② 对话中军师要到数字后**不自动写**（防 LLM 误写），前端在复盘完成页提示确认写入。
4. 注入：月战报上下文加【处方效果】块——「数字人代播：4 周累计 23 线索，占新增线索 40%（对比来源=CasefileMetric.leads 求和，服务端算）」。status → used（首次 outcome）→ verified（连续 2 期 outcome 且指标>0）。

### 验收
- [ ] activated 7 天后 scan 打标（clock 可注入的测试时间，参照 planTime 测试手法）。
- [ ] outcome 两期后 status=verified；月战报块含占比且与手算一致。
- [ ] 无 outcome 时块不注入、军师不得引用处方效果数字（禁算口径）。

---

## WO-15 · 生态统一账户与跨产品结算（设计先行，暂不编码）

**对应**：E-4。**产出物**：`docs/ECOSYSTEM_ACCOUNT_DESIGN.md`（本工单交付的是设计文档，不是代码）。

设计文档必须回答（写给生态第二产品立项时用）：
1. **身份**：以手机号 + 微信 unionid 为主键的中心身份服务；小程序现有 `loginOrRegisterByPhone` 抽象为可复用 SDK 还是独立 auth 服务（建议：现阶段单库多产品共用 User 表 + `product` 维度的会话隔离，成本最低；拆服务留到第三个产品）。
2. **钱包**：钻石/token 两轴钱包升为「用户级、跨产品」——`CreditLedger` 加 `product` 字段即可起步；跨产品扣费走同库事务，暂不需要分布式结算。
3. **权益互通**：军师侧套餐是否附赠生态产品额度（增长杠杆）；处方开通（WO-12 activate）跨产品下单的回调路径（复用 PaymentOrder 幂等模式）。
4. **数据互通授权**：BrandKit export（WO-13）与 outcome 回传（WO-14 v2 的 API 版）的鉴权模型——产品间 service token + 用户级授权记录表。
5. **风险**：单库多产品的 schema 耦合边界；unionid 依赖同一微信开放平台主体。

---

## 附：工单速查表

| 工单 | 一句话 | 规模 | 依赖 | 关键新模型 |
|---|---|---|---|---|
| WO-01 | 案卷单主线+名词统一 | M | — | 无 |
| WO-02 | 智库改能力管理、撤货架撤空卡 | M | — | 无 |
| WO-03 | 冷启动隐藏段位+空态导流 | S | — | 无 |
| WO-04 | 复盘三层+军师 4 科室+周月落账本 | M | — | 无（ReviewLog 补写入） |
| WO-05 | 命理开关+prompt v7 手术 | L | — | FeatureFlag |
| WO-06 | 3 问速诊+初诊卡 | M | — | 无（复用 Profile/cardHtml） |
| WO-07 | Journey 状态机+下一步卡 | L | WO-06 | UserJourney |
| WO-08 | 行业基准库 | M | — | IndustryBenchmark |
| WO-09 | 财务表→经营体检 | L | WO-08（弱） | KnowledgeItem.analysisJson |
| WO-10 | 结构化周报数 | M | WO-08 | BizMetricWeekly |
| WO-11 | 账本用户可见+异议流 | M | — | dispute 字段 ×2 |
| WO-12 | 处方引擎+漏斗 | L | WO-02/07 | Prescription |
| WO-13 | 品牌资产包 | M | WO-07（弱） | BrandKit |
| WO-14 | 成果回流 v1 | S | WO-12 | 无（outcomeJson） |
| WO-15 | 生态账户设计文档 | S | — | 无 |

**执行建议**：批次一 5 个工单并行（互不依赖）；批次二先 WO-06→07 串行、08/09/10/11 并行；批次三按依赖串。每个工单独立成 PR、独立可回滚；WO-05 因含合规项建议最先合入。
