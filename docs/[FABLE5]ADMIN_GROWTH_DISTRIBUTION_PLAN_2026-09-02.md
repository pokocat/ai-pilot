# 运营后台「增长」组：邀请关系 / 邀请链 / 代理分销（2026-09-02 · Fable 规划，Opus 执行）

> 起因：军师小程序 2026-08-18 起全站可分享、注册即绑邀请关系（`Referral` 三级物化 + `ReferralAttribution` 全留痕），
> 运营后台只有一页只读的「邀请增长」分析（Schema / 树 / 风控）。本文把邀请体系的**运营面**补齐：
> 查关系、看链路、补绑、做代理分销与佣金结算。前端按用户要求用 shadcn 建一套新组件层。
> 执行代理照此实现，不再自行设计；本文里没写的口径以 `AGENTS.md` §7.6 / §9.1 / §10 / §13 为准。

## 0. 结论与边界

1. **新开导航组 `growth 增长`**（第 8 组），四个分区：`invites 邀请关系`、`chain 邀请链`、`distribution 代理分销`、
   `referral 邀请增长`（现有页原样搬入本组，不重写）。`revenue 经营` 组回到 4 项。
2. **代理分销的合规定位**：代理 = 运营在后台登记的**签约渠道合作方**（B2B），佣金在服务端按已支付订单计提、
   由运营在后台生成结算单、**线下打款后回填打款凭证号**。小程序端本期**零暴露**（没有「我的佣金 / 提现」），
   不触碰「小程序内现金裂变返利」这条审核红线；普通用户的邀请激励仍按 §13 ① 后定，两套机制互不混用。
3. **佣金只发给代理，不发给普通邀请人**：一笔订单沿买家的 `Referral.lv1/lv2/lv3` 上溯，只有当某一级祖先是
   `status=active` 的代理、且其等级在该层级有 `rateBp>0` 的启用规则时才计提。三级是上限（与物化路径同深），
   每一级比例归运营配置；**代码不带任何默认比例、不 seed 等级与规则**——空规则 = 不计提。
4. **关系不可变更公理不破**：本期开放「运营补绑」（仅给**尚无推荐人**的用户建边，`source='manual'`），
   不提供改绑/解绑。补绑前必须先落 §13 那条 TOCTOU 锁（有序 advisory lock），否则并发互邀会建出环。
5. **shadcn 只进新模块**：Tailwind v4 + shadcn（new-york 风格、`stone` 基色、radius 0.625rem）**只作用于
   `admin/src/growth/**` 与 `admin/src/components/ui/**`**，色板全部映射到 `admin.css` 既有 token
   （纸 / 墨 / 金），旧页面一行不改、`lint:ui` 对旧目录规则不变。理由见 §4。

## 1. 现状事实（已核，执行代理不必重查）

- 表：`Referral(userId PK, referrerId, lv1/lv2/lv3, inviteCode, source, boundAt, tenantId)`、
  `ReferralAttribution(outcome ×8, clientIp, userAgent, newUserId?, referrerId?, tenantId)`、`InviteActivationOutbox`、
  `ActivationEvent(source='invite')`、`User.inviteCode`。**没有**任何代理 / 佣金 / 结算表。
- 服务：`services/referral.ts`（`bindOnRegister` 递归查环、`referralSummary`、`scrubUserReferralPii`）、
  `services/activation.ts`（outbox 模式：`enqueueInviteActivation` 在支付事务内 upsert 一行，提交后异步处理，
  `scanInviteActivationOutbox` 由 scheduler `pay-reconcile-sweep` 续扫）。
- 支付：`services/wechatPay.ts` `markPaidAndApply`（真金入账唯一收口；`enqueueInviteActivation` 两处调用点 ≈ L724 / L816）、
  `refundWechatOrder`（≈ L1163 置 `refunded`）、`markRefundNotified`（≈ L1234 置 `refunded`）、`sweepPendingRefunds`。
- 后台：`routes/adminReferral.ts` 四个 GET（自挂 `requireAdmin`）；`routes/admin.ts` 的 `FEATURE_FLAG_CATALOG`
  （`referral-window` / `referral-risk` 两个 number flag）、`requireSuper`、`sendErr`；`services/audit.ts` `recordAudit`。
- 鉴权：`AdminActor` = master | account(owner/operator) | legacyUser；`isSuperActor`；写操作 `requireSuper` + 审计。
- 注销：`services/accountDeletion.ts` `ACCOUNT_DELETION_POLICY` 由测试遍历 DMMF 强制校验——**任何新增带 userId/tenantId 的表必须登记**。
- 测试：`server/test/helpers.ts`（`getApp/seedBaseline/cleanBusiness/api/login/uniquePhone`），`prisma/resetBusinessData.ts`
  显式列出要清的业务表；`payMockSuccess.test.ts` 是「真实建单 → `/pay/mock/pay` → paid+applied」的现成夹具；
  `adminReferralViews.test.ts` 是后台只读聚合测试的范本。
- 前端：admin 依赖只有 react/react-dom，Vite 5 + 手写 hash 路由 + `nav.ts` SSOT + `useResource/ViewState` 三态 +
  `scripts/audit-admin-ui.mjs` 合规扫描（class 必须在 admin.css 里有定义、inline 不许 hex、空 catch 阻断）。
- 契约：`shared/contracts.d.ts` 是 SSOT；本文对应的新增类型**已由 Fable 写入**（`AdminInvite*` / `AdminChain*` /
  `AdminDistribution*` 段），执行代理**照契约实现，不改字段**；确需改动先在契约里改并在完成报告里点明。

## 2. 数据模型（Prisma，`db push`）

```prisma
/// 代理（签约渠道合作方）。一人最多一条。status: pending 待审 | active 生效 | suspended 暂停计提 | terminated 终止
model Distributor {
  id           String    @id @default(cuid())
  userId       String    @unique
  tenantId     String
  tierId       String?
  status       String    @default("active")
  displayName  String?          // 对外名称（公司/个人），PII → 注销时置 null
  contactPhone String?          // 联系手机（可与账号手机不同），PII → 注销时置 null；响应一律 maskAuditPhone
  remark       String?   @db.Text
  approvedBy   String?          // 操作者（AdminActor 摘要），审计同源
  approvedAt   DateTime?
  suspendedAt  DateTime?
  terminatedAt DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  tier DistributorTier? @relation(fields: [tierId], references: [id])
  @@index([tenantId, status]) @@index([tierId]) @@map("distributor")
}

/// 代理等级（运营目录，不 seed；空目录合法）。
model DistributorTier {
  id        String   @id @default(cuid())
  name      String   @unique
  sort      Int      @default(0)
  enabled   Boolean  @default(true)
  note      String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  distributors Distributor[]
  rules        DistributionRule[]
  @@map("distributor_tier")
}

/// 分销比例：等级 × 层级(1..3) × 商品类型(plan|sku|all)。rateBp 万分比 0..10000。itemType 精确匹配优先于 all。
model DistributionRule {
  id        String   @id @default(cuid())
  tierId    String
  level     Int
  itemType  String
  rateBp    Int
  enabled   Boolean  @default(true)
  updatedAt DateTime @updatedAt
  tier DistributorTier @relation(fields: [tierId], references: [id], onDelete: Cascade)
  @@unique([tierId, level, itemType]) @@map("distribution_rule")
}

/// 佣金流水（不可变账本：只追加、只改 status/settlementId/reversedAt）。
/// kind: accrual 计提（amount>0）| clawback 追回（amount<0，已结算后退款时另落一行）
/// status: pending 冻结期 | confirmed 可结算 | settled 已结算 | reversed 已冲销（结算前退款）
model CommissionEntry {
  id                String    @id @default(cuid())
  tenantId          String            // 买家租户
  outTradeNo        String
  orderId           String
  buyerUserId       String
  beneficiaryUserId String
  distributorId     String
  level             Int
  itemType          String            // plan | sku
  itemKey           String
  baseAmount        Int               // 订单实付（分）
  rateBp            Int
  amount            Int               // 分；clawback 为负
  kind              String  @default("accrual")
  status            String  @default("pending")
  holdUntil         DateTime
  settlementId      String?
  reversedAt        DateTime?
  ruleSnapshotJson  Json?             // { tierName, tierId, ruleId, rateBp, holdDays }
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@unique([outTradeNo, beneficiaryUserId, level, kind])
  @@index([distributorId, status, createdAt]) @@index([status, holdUntil]) @@index([settlementId]) @@index([buyerUserId])
  @@map("commission_entry")
}

/// 结算单：draft 草稿 → approved 已核 → paid 已打款（回填 paidRef）；void 作废（仅 draft/approved 可作废，解绑流水）。
model CommissionSettlement {
  id            String    @id @default(cuid())
  distributorId String
  periodStart   DateTime
  periodEnd     DateTime
  entryCount    Int
  totalAmount   Int               // 分；可为负（追回多于计提时）
  status        String   @default("draft")
  approvedBy    String?
  approvedAt    DateTime?
  paidBy        String?
  paidAt        DateTime?
  paidRef       String?           // 线下打款凭证号
  note          String?  @db.Text
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([distributorId, status]) @@map("commission_settlement")
}

/// 佣金事件 outbox（与 InviteActivationOutbox 同一套路：支付/退款事务内 upsert，提交后异步处理，scheduler 续扫）。
model CommissionOutbox {
  outTradeNo    String
  kind          String            // paid | refunded
  attempts      Int       @default(0)
  nextAttemptAt DateTime  @default(now())
  lastError     String?   @db.Text
  completedAt   DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  @@id([outTradeNo, kind]) @@index([completedAt, nextAttemptAt]) @@map("commission_outbox")
}
```

登记：
- `ACCOUNT_DELETION_POLICY`：`Distributor` → retain（置空 displayName/contactPhone/remark，保留行与佣金归属）；
  `CommissionEntry` / `CommissionSettlement` → retain（财务账本，去标识不删）；`CommissionOutbox` 无 userId 不需登记（按测试实际要求处理）。
  `DistributorTier` / `DistributionRule` 无 userId。
- `prisma/resetBusinessData.ts`：加 `commissionOutbox / commissionEntry / commissionSettlement / distributor`；
  **不加** `distributorTier / distributionRule`（运营目录，与 `WenceTemplate` 同一理由）。测试自己清目录。
- 功能开关（`FEATURE_FLAG_CATALOG`）：`distribution`（toggle，`defaultEnabled:false`，label「代理分销计提」，
  关闭时 outbox 直接完成、不计提；开启后不追溯历史订单，desc 里写明）、`distribution-hold`（number，payloadKey `days`，
  def 7，min 0，max 90，unit 天：退款冻结期，过期后 pending→confirmed）。常量从 `services/commission.ts` 导出供 catalog 引用。

## 3. 服务端

### 3.1 佣金服务 `services/commission.ts`
- `enqueueCommission(tx, outTradeNo, kind: 'paid'|'refunded')`：upsert outbox 行（幂等）。调用点：
  `markPaidAndApply` 里 **与 `enqueueInviteActivation` 相同的两处**（已发放的重复通知那处也补，保证历史单有行）；
  `refundWechatOrder` 的 `finalSuccess` 分支与 `markRefundNotified` 置 `refunded` 处（各一次，在同一事务内）。
- `processCommissionOutbox(outTradeNo, kind)`：事务提交后立即调一次（照 `processInviteActivationOutbox` 的写法），
  失败不抛给支付响应，留给 scheduler。
- `accrueForOrder(order)`：flag `distribution` 关 → 完成不计提。读买家 `Referral`；对 lv1..lv3 各查
  `Distributor(userId=ancestor, status='active')` + `DistributionRule(tierId, level, itemType ∈ {精确, 'all'}, enabled, rateBp>0)`，
  精确优先；`amount = floor(baseAmount × rateBp / 10000)`，`holdUntil = paidAt + holdDays`；
  `createMany({ skipDuplicates: true })` 或逐条 upsert，靠唯一键幂等。买家自己不会是祖先（公理）。
  `suspended` 代理**不计提**（不是延后计提），desc 写明。
- `reverseForOrder(order)`：该单 `kind='accrual'` 的行：`pending|confirmed` → `reversed`（`reversedAt`，若已挂 draft
  结算单则同时清 `settlementId` 并重算那张单的 `entryCount/totalAmount`）；`settled` → 另落 `kind='clawback'`、
  `amount=-原额`、`status='confirmed'`、`holdUntil=now`，供下一张结算单净额。
- `confirmMatured(limit)`：`status='pending' AND holdUntil <= now AND 订单未退款` → `confirmed`。scheduler 新增
  `commission-mature`（30 min）+ `scanCommissionOutbox` 并入 `pay-reconcile-sweep`。
- 全部时间走 `clock.now()`；涉及原生 SQL 的时间边界经 `utcTimestamp`（见 memory「Prisma raw SQL Date 参数时区偏移」）。

### 3.2 邀请关系 / 邀请链 `routes/adminInvites.ts`（自挂 `requireAdmin`，`prefix:'/api'`，在 `app.ts` 注册）
| 方法 路径 | 说明 | 权限 |
|---|---|---|
| `GET /admin/invites?q&source&status&tenantId&days&page&pageSize` | 关系账本分页：被邀人/邀请人（姓名 + 掩码手机 + 短 id）、码、来源、绑定时间、被邀人开通状态（`planGate` 口径）、首笔付费（金额/时间，无则 null）。`q` 匹配任一侧姓名/手机/邀请码/userId；`days` 筛 `boundAt`，缺省全量 | admin |
| `GET /admin/invites/attributions?q&outcome&source&tenantId&days&page&pageSize` | 归因日志分页（掩码手机，**不下发 userAgent**，下发 clientIp） | admin |
| `GET /admin/invites/export?同 invites 筛选` | CSV（与 `payments/export` 同套路），掩码手机 | super |
| `POST /admin/invites/manual-bind` `{ userId, inviteCode, reason }` | 运营补绑：仅目标用户**尚无 Referral 行**；沿用 `bindOnRegister` 的判定（self/cycle/unknown_code/already_bound 原样返回 outcome，**不受归因窗口限制**），`source='manual'`，落 `ReferralAttribution`（clientIp 取运营请求 IP）。**必须先加锁**：按 `[userId, referrerId]` 排序后依次 `pg_advisory_xact_lock(hashtext('referral:'+id))`，再在同事务内做递归查环与建边。审计 `admin.invite.manual_bind` 带 reason/outcome | super |
| `GET /admin/invites/chain/:userId?days` | 以人为中心：`upline`（沿 `referrerId` 递归到根，hop 上限 64，每级带姓名/掩码手机/开通状态/是否代理）、`downline`（三级子树，复用 `adminReferral.ts` 的子树构建——把 node 构建抽成可复用函数，两处共用，红环口径同源）、`team`（各级人数 / 已开通数 / 已支付 GMV 分 / 若本人是代理则各级佣金合计）、`distributor`（本人代理档案摘要或 null） | admin |

`services/referral.ts` 需要抽出一个 `bindManually(...)` 或给 `bindOnRegister` 加 `{ skipWindow, lock }` 选项——**二选一，不复制查环逻辑**。

### 3.3 代理分销 `routes/adminDistribution.ts`（自挂 `requireAdmin`）
| 方法 路径 | 说明 | 权限 |
|---|---|---|
| `GET /admin/distribution/config` | `{ enabled, holdDays, configured, flagKeys }`（`fresh:true` 读） | admin |
| `GET/POST/PATCH/DELETE /admin/distribution/tiers[/:id]` | 等级目录；DELETE 仅在无代理挂靠时允许（否则 409） | 写 super |
| `PUT /admin/distribution/tiers/:id/rules` `{ rules: [{level,itemType,rateBp,enabled}] }` | 整体替换该等级规则（事务内 deleteMany+createMany），校验 level 1..3 / itemType / 0..10000 | super |
| `GET /admin/distribution/distributors?q&status&tierId&page&pageSize` | 名册 + 每人 lv1/lv2/lv3 人数、累计计提/待结/已结（分）——**groupBy 批量，禁 N+1** | admin |
| `POST /admin/distribution/distributors` `{ userId, tierId?, displayName?, contactPhone?, remark? }` | 登记代理（运营登记即 `active`）；用户不存在 404、已是代理 409 | super |
| `GET /admin/distribution/distributors/:id` | 详情：档案 + 团队统计 + 最近 20 条佣金 + 结算单列表 | admin |
| `PATCH /admin/distribution/distributors/:id` `{ tierId?, status?, displayName?, contactPhone?, remark? }` | 状态机：active↔suspended，→terminated 终态；写时间戳与 `approvedBy` | super |
| `GET /admin/distribution/commissions?distributorId&status&kind&days&page&pageSize` | 流水 + `summary`（按 status 求和/计数） | admin |
| `GET /admin/distribution/settlements?distributorId&status&page&pageSize` | 结算单列表 | admin |
| `POST /admin/distribution/settlements/generate` `{ distributorId?, periodStart, periodEnd }` | 为一个或全部 active/suspended 代理生成 draft：纳入 `status='confirmed' AND settlementId IS NULL AND createdAt ∈ [start,end)` 的行（含 clawback）；零行不生成；返回生成的单 | super |
| `POST /admin/distribution/settlements/:id/approve` | draft→approved | super |
| `POST /admin/distribution/settlements/:id/paid` `{ paidRef, note? }` | approved→paid，同事务把关联行 `confirmed→settled`；`paidRef` 必填 | super |
| `POST /admin/distribution/settlements/:id/void` `{ reason }` | draft/approved→void，解绑行（`settlementId=null`） | super |

所有写操作 `recordAudit`（action 前缀 `admin.distribution.*`，payload 带 before/after 与 `by`）；错误统一 `sendErr`；
所有手机号 `maskAuditPhone`。分页 `pageSize` 夹 1..200，`page` 从 1 起，响应带 `total`。

### 3.4 测试（`server/test/`，各自独立进程；并行代理各用自己的库，见 §6）
- `adminInvites.test.ts`：列表筛选/分页/掩码；attributions 不含 userAgent；export operator 403 + super 200 且是 CSV；
  manual-bind：目标已绑 → `already_bound`、自邀 → `self`、成环 → `cycle`、码不存在 → `unknown_code`、成功 → `bound` 且
  `source='manual'`、审计有行、**并发互邀（两个未绑用户同时互相补绑）只允许一条成功**；chain 的 upline 深度 > 3 仍能回到根、
  downline 与 `/admin/referral/tree` 的节点口径一致。
- `commission.test.ts`：flag 关不计提；开后按规则计提（精确 itemType 优先 all、多级各自比例、非代理祖先不计提、
  suspended 不计提）；重复处理 outbox 幂等；holdDays 走配置、到期 `confirmMatured` 转 confirmed；退款：结算前 reversed、
  结算后 clawback 负行；结算单 generate/approve/paid/void 全生命周期与行状态联动、paid 缺 `paidRef` 400；
  operator 对全部写端点 403；审计行存在；`ACCOUNT_DELETION_POLICY` 覆盖测试通过。
- 基线：`npm test` 全绿（当前主检出可能红 1 条 gateway 用例，属 `.env` 真 key 所致，与本改动无关——见 memory）。

## 4. 前端（admin）

### 4.1 shadcn 接入（只进新模块）
- 依赖：`tailwindcss@^4.1` + `@tailwindcss/vite`、`class-variance-authority`、`clsx`、`tailwind-merge`、`lucide-react`、
  按需 `@radix-ui/*`（由 `npx shadcn@latest add` 拉），`recharts`（仅佣金趋势一张图；shadcn `chart` 组件）。
- `components.json`：style `new-york`，`tailwind.baseColor: stone`，`cssVariables: true`，`tsx: true`，
  css 指向 `admin/src/styles/shadcn.css`，aliases `@/components`、`@/lib/utils`、`@/components/ui`。
  `tsconfig.json` 加 `baseUrl` + `paths {"@/*": ["./src/*"]}`，`vite.config.ts` 加 `resolve.alias` 与 `tailwindcss()` 插件。
- **主题选型 = shadcn `stone` 基色、radius 0.625rem，色板全部映射到 admin.css 既有 token**（不是照抄 stone 的灰）：
  ```css
  /* admin/src/styles/shadcn.css —— 只引 theme + utilities，**不引 preflight**（会重置旧页面的 button/h1/表格） */
  @import "tailwindcss/theme.css" layer(theme);
  @import "tailwindcss/utilities.css" layer(utilities) source(none);
  @source "../growth"; @source "../components/ui"; @source "../lib";   /* 只扫新模块，旧页面的 block/full 等词不生成工具类 */
  :root {
    --sc-background: var(--paper); --sc-foreground: var(--ink);
    --sc-card: var(--surface); --sc-card-foreground: var(--ink);
    --sc-popover: var(--surface); --sc-popover-foreground: var(--ink);
    --sc-primary: var(--accent-deep); --sc-primary-foreground: #fff;
    --sc-secondary: var(--surface-2); --sc-secondary-foreground: var(--ink);
    --sc-muted: var(--surface-2); --sc-muted-foreground: var(--ink-3);
    --sc-accent: var(--accent-soft); --sc-accent-foreground: var(--accent-ink);
    --sc-destructive: var(--danger); --sc-border: var(--line); --sc-input: var(--line); --sc-ring: var(--accent);
    --sc-chart-1: var(--accent); --sc-chart-2: var(--ink-2); --sc-chart-3: var(--success); --sc-chart-4: var(--warning); --sc-chart-5: var(--danger);
    --sc-radius: 0.625rem;
  }
  @theme inline {
    --color-background: var(--sc-background); --color-foreground: var(--sc-foreground); /* …逐一映射 */
    --color-accent: var(--sc-accent);  /* 注意：admin.css 已占用 --accent（金色），shadcn 原始变量一律加 sc- 前缀，只在 @theme 里映射 */
    --font-sans: var(--sans); --font-mono: var(--mono);
    --radius-sm: calc(var(--sc-radius) - 4px); /* …按 shadcn 模板 */
  }
  .sc { @apply bg-background text-foreground; }
  .sc *, .sc *::before, .sc *::after, [data-sc-portal] * { border-color: var(--sc-border); }  /* 代替 preflight 的 border-color 默认 */
  ```
  Radix portal 内容（Dialog/Select/Popover/Tooltip）渲染在 body 下、不在 `.sc` 里，所以 **token 放 `:root`**，
  组件类里颜色都是显式 `bg-popover` 之类，不依赖 `.sc` 作用域；portal 容器加 `data-sc-portal`（或用 `container` prop 指到
  `.sc` 内的挂载点，二选一，选后者更稳）。
- 新模块根节点 `<div className="sc">`；shadcn 生成的组件放 `admin/src/components/ui/`，`cn()` 放 `admin/src/lib/utils.ts`。
- **`scripts/audit-admin-ui.mjs` 改动只有一条**：对 `admin/src/growth/**`、`admin/src/components/ui/**`、`admin/src/lib/**`
  **跳过规则 1（class 必须在 admin.css 里定义）**，其余规则（inline hex、`<button style>`、`div.sw`、空 catch）照旧；
  在脚本顶部注释里写清「shadcn 目录的 class 由 Tailwind 生成，规则 1 不适用」。`admin.css` 本身不改。
- `admin/DESIGN.md` 增「§ shadcn 模块（增长组）」小节：允许范围、主题映射、禁止事项（旧页面不得 import `@/components/ui`；
  新模块不得引用 admin.css 的组件类，`PageHead/ViewState/useResource` 这三个**逻辑**组件可以共用——`PageHead` 输出的是旧类名，
  在 `.sc` 内照常生效，因为 admin.css 无作用域）。**One Command Color 不变**：primary=金，绿/红/赭只表状态。

### 4.2 导航与路由
- `nav.ts`：`GroupKey` 加 `'growth'`，`NAV_GROUPS` 在 `revenue` 后插 `{ key:'growth', label:'增长', icon:'target' }`；
  `SectionKey` 加 `'invites' | 'chain' | 'distribution'`；`referral` 的 `group` 改为 `growth`（key 不变，旧链接 `#/referral` 照常）。
  顺序：邀请关系 → 邀请链 → 代理分销 → 邀请增长。别名要能让命令面板搜到「代理 / 分销 / 佣金 / 结算 / 补绑 / 上级 / 下级 / 团队」。
- `App.tsx` 只加三行挂载 + `chain` 支持 `#/chain/<userId>`（`route.id`），`distribution` 支持 `#/distribution/<distributorId>`；
  用户详情面板里加一个「查邀请链」跳转 `navigate('chain', userId)`（`views/users.tsx` 一处按钮，用旧类 `mini-btn`）。
- 移动端底栏 8 组：在 375px 宽下确认组名不换行、不横滚（`botnav` flex 均分）。

### 4.3 三个视图（`admin/src/growth/`）
- `InvitesView.tsx`：顶部 shadcn `Tabs`（关系账本 / 归因日志）；筛选条（`Input` 搜索、`Select` 来源/结果/状态、天数 `ToggleGroup`、
  租户 `Select` 复用 `api.referralTenants()`）；`Table` + 分页；行内动作「查链」→ `#/chain/<userId>`；
  super 才显示「导出 CSV」与「运营补绑」`Dialog`（userId/邀请码/原因，提交后回显 outcome 人话，`already_bound` 等按 warning 展示）。
  空态与读失败**分开**（沿用 `useResource` + 自写 shadcn 版 `ViewState` 皮肤，或直接复用旧 `ViewState`——两者都可，但错误必须带服务端原文与重试）。
- `ChainView.tsx`：搜索框（复用 `api.users()` 或 `#/users?q` 的接口按姓名/手机找人，选中后写 hash）→ 三块：
  ① 上溯链（垂直 `Breadcrumb`/时间线，从根到本人，标注代理徽标）；② 团队统计 `Card` ×4（lv1/lv2/lv3 人数、开通、GMV、佣金）；
  ③ 下钻三级 `Collapsible` 树（节点：姓名+掩码+短 id、开通 `Badge`、风控红点、绑定时间/来源）。
- `DistributionView.tsx`：`Tabs`：**代理名册**（表 + 登记 `Dialog` + 行内状态切换 `DropdownMenu`，terminated 需 `AlertDialog` 手打确认词）、
  **分销规则**（等级列表 + 每个等级一张 3 层 × 3 类型的比例矩阵编辑，保存走 PUT；总开关与冻结期只**显示**并链接到
  `#/flags`，不在此页改）、**佣金流水**（筛选 + 表 + 按状态汇总 `Card`；一张近 30 天计提/追回柱图用 shadcn `chart`）、
  **结算单**（生成 `Dialog` 选代理+周期；列表行动作 approve / paid（`Dialog` 必填凭证号，回显代理/金额/条数）/ void（手打确认））。
  非 super：写按钮**不渲染**并在页头写「只读」；写操作 `catch` 必须透出 `e.message`。
- 金额一律 `fmtYuan(fen)`（`format.tsx`），比例显示 `rateBp/100` 保留两位 + `%`。
- 契约类型从 `../../shared/contracts` 引；API 函数追加到 `admin/src/api.ts`（沿用 `req`），不另起 fetch 层。

### 4.4 前端验收门
`cd admin && npm run lint:ui && npx tsc --noEmit && npm run build`；`npm run dev` 走查：旧页面（概览/用户/订单/邀请增长/功能开关）
外观与改动前逐像素一致（重点：按钮、表格、h1、链接下划线、input 边框——这些正是 preflight 会动的东西）；新模块三页在 375px 与 1280px 各截一张图。

## 5. 工作包与并行

| 包 | 执行者 | 内容 | 依赖 |
|---|---|---|---|
| **S1 分销** | Opus | §2 全部模型 + `services/commission.ts` + 支付/退款挂点 + scheduler + flags + `routes/adminDistribution.ts` + `commission.test.ts` + 注销政策/reset 登记 | 契约（已就绪） |
| **S2 邀请** | Opus | `routes/adminInvites.ts` + `bindManually`（加锁）+ CSV + chain（抽 `adminReferral.ts` 子树函数）+ `adminInvites.test.ts` | 契约；chain 的 `distributor` 字段读 S1 建的表——S2 先按 `prisma.distributor` 可空处理，S1 未落时该字段恒 null（S2 不改 schema） |
| **F1 前端** | Opus | §4 全部 | 契约；后端就位前先对着契约做完 UI，最后接真接口走查 |
| **验收** | Fable | diff 审阅、三门（server test / admin build / lint）、走查截图、AGENTS.md/DESIGN.md 落笔核对 | S1 S2 F1 |

三包同时在 worktree `.claude/worktrees/admin-growth`（分支 `feat/admin-growth-distribution`）工作。
文件边界：S1 独占 `schema.prisma / services/commission.ts / routes/adminDistribution.ts / wechatPay.ts 挂点 / scheduler.ts`；
S2 独占 `routes/adminInvites.ts / services/referral.ts / routes/adminReferral.ts（仅抽函数）`；
两者都要碰 `app.ts`（各加一行注册）、`resetBusinessData.ts`（S1）、`accountDeletion.ts`（S1）；F1 独占 `admin/**`。
`AGENTS.md`：S1 写 §8.1 表 + §10 模型；S2 写 §8.1 表 + §13 删 TOCTOU 项；F1 写 §9.0 导航与 shadcn 段。各自只追加自己的段落。

## 6. 并行测试隔离
两台服务端代理各用自己的测试库（已建好）：
```bash
DATABASE_URL="postgresql://donis@localhost:5432/junshi_test_s1?schema=public" npm test          # S1
DATABASE_URL="postgresql://donis@localhost:5432/junshi_test_s2?schema=public" npm test          # S2
```
显式环境变量优先于 `--env-file=.env.test`，`pretest` 的 `db push` 也随之落到各自的库。跑单文件用同样前缀 +
`node --env-file=.env.test --import ./test/hermeticEnv.mjs --import tsx --test test/<file>.test.ts`。

## 7. 明确不做（本期）
- 小程序端任何佣金/提现/代理申请界面；普通用户邀请奖励（§13 ①）；现金形态奖励。
- 改绑/解绑；`ClientEvent` 漏斗聚合（§13 ③，另立）；旧「邀请增长」页 shadcn 化。
- 银行账户等打款资料入库（线下财务保管，后台只记凭证号）。

## 8. 决策待用户确认（不阻塞动工，按默认值实现）
1. 代理是否允许 lv2/lv3 计提——**默认允许配置、不预设比例**；若合规要求只一级，运营把 2/3 级比例留 0 即可，代码不需改。
2. 冻结期默认 7 天、结算周期由运营在生成结算单时自选起止——若要固定月结，后续加一个 scheduler 自动出 draft 即可。
3. shadcn 主题取 `stone` 基色映射到金/纸/墨——若想要更明显的「新皮肤」区隔，可改 `primary` 为 `--accent`（亮金）而非 `--accent-deep`。
