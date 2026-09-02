// 运营后台「增长 · 代理分销」（2026-09-02，规划见
// docs/[FABLE5]ADMIN_GROWTH_DISTRIBUTION_PLAN_2026-09-02.md §3.3）。
//
// 这块屏管四件事：代理名册（登记/停发/终止）、分销规则（等级 × 层级 × 商品类型的比例矩阵）、
// 佣金流水（只读账本）、结算单（生成 → 核准 → 线下打款回填凭证号 → 必要时作废）。
// 计提逻辑一行都不在这里——全在 services/commission.ts，本文件只做「读投影 + 状态机写」。
//
// ── 与 adminReferral.ts 完全同一套约定（没有新发明）─────────────────────────
// · 独立插件、自挂 `requireAdmin`（`app.addHook('preHandler', requireAdmin)`）：无凭证 401、
//   已登录非管理员 403。理由同 adminReferral.ts 头注释——admin.ts 已 3000+ 行。
// · **写操作一律 `requireSuper` + `recordAudit`**（action 前缀 `admin.distribution.*`，
//   payload 带 before/after 与 by=操作者摘要）。分销是资金动作，与改价同级。
// · **手机号一律 `maskAuditPhone`**（与审计日志同一把掩码，不另写规则）：这块屏会把
//   「谁带来了谁 + 谁能拿到钱」放在一起，是天然的关联面。
// · **读失败不许伪装成空**：这里不写任何 try/catch 兜底空数组。DB 抖动就让它 5xx，
//   前端渲染「加载失败 + 重试」，而不是「还没有代理」。
// · 分页统一 `{ items, total, page, pageSize }`，`pageSize` 夹 1..200、`page` 从 1 起。
// · 列表统计一律 **groupBy 批量**，禁 N+1（一页 200 个代理不许打 600 次查询）。
//
// ── 对外数据归运营 ────────────────────────────────────────────────────────
// 等级目录与比例**没有任何默认值、没有 seed**。空目录/空规则是合法状态，意味着不计提。
// 总开关与冻结期归「功能开关」页（`distribution` / `distribution-hold`），本页只**显示**
// 当前值并把 flag id 下发给前端做跳转——同一个数字不该有两个能改它的入口。
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma, utcTimestamp } from '../db.js';
import { requireAdmin, actorOf, isSuperActor, type AdminActor } from '../services/adminAuth.js';
import { maskAuditPhone, recordAudit } from '../services/audit.js';
import { now } from '../services/clock.js';
import { MAX_COMMISSION_LEVEL, distributionConfig, recomputeSettlement } from '../services/commission.js';
import type {
  AdminChainLevelStat, AdminCommissionEntry, AdminCommissionList, AdminDistributionConfig,
  AdminDistributionRule, AdminDistributorBrief, AdminDistributorDetail, AdminDistributorItem,
  AdminDistributorList, AdminDistributorTier, AdminPersonRef, AdminSettlement, AdminSettlementList,
  AdminSettlementGenerateResult, CommissionKind, CommissionStatus, DistributionItemType,
  DistributorStatus, SettlementStatus,
} from '../../../shared/contracts';

const DAY_MS = 86_400_000;
const PAGE_MAX = 200;
/** 佣金比例上限 = 100%（万分比）。运营真配 10000 是他的决定，代码只拦区间外。 */
const RATE_BP_MAX = 10_000;
const ITEM_TYPES: DistributionItemType[] = ['plan', 'sku', 'all'];
/** 代理详情里每一级团队展开的成员上限：后台单人详情，越过这个量级说明该走导出而不是一屏。 */
const TEAM_ID_CAP = 20_000;
/** 代理详情里的「最近佣金」条数（契约写的是 20 条）。 */
const RECENT_COMMISSIONS = 20;
/** 结算单列表在详情里的条数上限。 */
const DETAIL_SETTLEMENTS = 50;
/** 佣金柱图默认窗口（天）。 */
const DAILY_DEF_DAYS = 30;

/* ── 通用小工具 ─────────────────────────────────────────────────────────── */

// 把 service 抛出的 {statusCode, code} 错误统一回成 HTTP 响应（形状与 admin.ts 的 sendErr 一致）。
function sendErr(reply: FastifyReply, e: unknown, fallback = 400) {
  const err = e as { statusCode?: number; code?: string; message?: string };
  return reply.code(err.statusCode ?? fallback).send({ error: err.message ?? '操作失败', code: err.code });
}

function fail(message: string, statusCode = 400, code?: string): never {
  throw Object.assign(new Error(message), { statusCode, code });
}

/** 仅 owner/master/legacy 超管可写（与 admin.ts 的 requireSuper 同一判定，同一错误码）。 */
function requireSuper(actor: AdminActor): void {
  if (!isSuperActor(actor)) throw Object.assign(new Error('需要 owner 权限'), { statusCode: 403, code: 'OWNER_ONLY' });
}

/** 操作者展示名（写进审计 payload.by 与 approvedBy/paidBy，便于多运营溯源）。 */
function actorName(actor: AdminActor): string {
  return actor.kind === 'account' ? actor.username : actor.kind === 'master' ? '主密钥' : '管理员';
}

interface Paging { page: number; pageSize: number; skip: number }
function paging(q: { page?: string | number; pageSize?: string | number }): Paging {
  const page = Math.max(1, Math.floor(Number(q.page) || 1));
  const pageSize = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(q.pageSize) || 20)));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

function text(raw: unknown, max = 200): string | null {
  const v = typeof raw === 'string' ? raw.trim() : '';
  return v ? v.slice(0, max) : null;
}

/** 可选天数窗口：缺省 = 不筛（账本是永久的，不该被一个默认窗口悄悄吃掉）。 */
function optionalDays(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(365, Math.floor(n)) : null;
}

type UserRow = { id: string; name: string | null; phone: string | null; tenantId: string };

/** 界面上的「一个人」：手机号已掩码，姓名可空，带完整 userId（前端自取尾 6 位做短 id）。 */
function personOf(u: UserRow | undefined, fallbackId: string): AdminPersonRef {
  return {
    userId: u?.id ?? fallbackId,
    name: u?.name ?? null,
    phone: maskAuditPhone(u?.phone),
    tenantId: u?.tenantId ?? '',
  };
}

async function usersByIds(ids: string[]): Promise<Map<string, UserRow>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (uniq.length === 0) return new Map();
  const rows = await prisma.user.findMany({
    where: { id: { in: uniq } },
    select: { id: true, name: true, phone: true, tenantId: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/* ── 代理名册的批量统计（禁 N+1）────────────────────────────────────────── */

/**
 * 一页代理的三级团队人数。三次 groupBy（各一次全表索引扫），不是每人三次查询。
 * 口径与邀请树一致：`Referral.lv1/lv2/lv3` 物化路径命中即算这一级。
 */
async function teamCounts(userIds: string[]): Promise<Map<string, { lv1: number; lv2: number; lv3: number }>> {
  const out = new Map<string, { lv1: number; lv2: number; lv3: number }>();
  for (const id of userIds) out.set(id, { lv1: 0, lv2: 0, lv3: 0 });
  if (userIds.length === 0) return out;
  const [l1, l2, l3] = await Promise.all([
    prisma.referral.groupBy({ by: ['lv1'], where: { lv1: { in: userIds } }, _count: { _all: true } }),
    prisma.referral.groupBy({ by: ['lv2'], where: { lv2: { in: userIds } }, _count: { _all: true } }),
    prisma.referral.groupBy({ by: ['lv3'], where: { lv3: { in: userIds } }, _count: { _all: true } }),
  ]);
  for (const r of l1) { const e = out.get(r.lv1); if (e) e.lv1 = r._count._all; }
  for (const r of l2) { const e = r.lv2 ? out.get(r.lv2) : undefined; if (e) e.lv2 = r._count._all; }
  for (const r of l3) { const e = r.lv3 ? out.get(r.lv3) : undefined; if (e) e.lv3 = r._count._all; }
  return out;
}

/**
 * 一页代理的佣金汇总。一次 groupBy(distributorId, status, kind) 全部算完。
 *
 * 三个数的口径（前端三列就是这三个，别在别处再算一遍）：
 * · `accrued` 累计计提 = 所有 **kind='accrual' 且未冲销** 行之和。**reversed 不计**——
 *   那笔佣金因为退款从来没有真正成立过，算进「累计计提」会让代理看到一个永远兑不出的数。
 * · `pending` 待结 = `pending + confirmed` 的**净额**（含负的 clawback：追回还没进结算单时
 *   就该先在待结里扣掉，否则运营会照着一个虚高的应付去打款）。
 * · `settled` 已结 = `settled` 的净额。
 */
async function commissionSums(distributorIds: string[]): Promise<Map<string, { accrued: number; pending: number; settled: number }>> {
  const out = new Map<string, { accrued: number; pending: number; settled: number }>();
  for (const id of distributorIds) out.set(id, { accrued: 0, pending: 0, settled: 0 });
  if (distributorIds.length === 0) return out;
  const rows = await prisma.commissionEntry.groupBy({
    by: ['distributorId', 'status', 'kind'],
    where: { distributorId: { in: distributorIds } },
    _sum: { amount: true },
  });
  for (const r of rows) {
    const e = out.get(r.distributorId);
    if (!e) continue;
    const amount = r._sum.amount ?? 0;
    if (r.kind === 'accrual' && r.status !== 'reversed') e.accrued += amount;
    if (r.status === 'pending' || r.status === 'confirmed') e.pending += amount;
    if (r.status === 'settled') e.settled += amount;
  }
  return out;
}

type DistributorRow = Prisma.DistributorGetPayload<{ include: { tier: { select: { id: true; name: true } } } }>;

function briefOf(d: DistributorRow): AdminDistributorBrief {
  return {
    id: d.id,
    userId: d.userId,
    status: d.status as DistributorStatus,
    tier: d.tier ? { id: d.tier.id, name: d.tier.name } : null,
    displayName: d.displayName,
  };
}

function itemOf(
  d: DistributorRow,
  user: UserRow | undefined,
  team: { lv1: number; lv2: number; lv3: number },
  commission: { accrued: number; pending: number; settled: number },
): AdminDistributorItem {
  return {
    ...briefOf(d),
    user: personOf(user, d.userId),
    // 联系手机与账号手机是两个字段，但下发口径同一把掩码——不因为「运营自己填的」就放宽。
    contactPhone: maskAuditPhone(d.contactPhone),
    remark: d.remark,
    team,
    commission,
    approvedBy: d.approvedBy,
    approvedAt: iso(d.approvedAt),
    suspendedAt: iso(d.suspendedAt),
    terminatedAt: iso(d.terminatedAt),
    createdAt: d.createdAt.toISOString(),
  };
}

async function loadItem(id: string): Promise<AdminDistributorItem> {
  const d = await prisma.distributor.findUnique({ where: { id }, include: { tier: { select: { id: true, name: true } } } });
  if (!d) fail('代理不存在', 404, 'DISTRIBUTOR_NOT_FOUND');
  const [users, team, sums] = await Promise.all([
    usersByIds([d!.userId]), teamCounts([d!.userId]), commissionSums([d!.id]),
  ]);
  return itemOf(
    d!, users.get(d!.userId),
    team.get(d!.userId) ?? { lv1: 0, lv2: 0, lv3: 0 },
    sums.get(d!.id) ?? { accrued: 0, pending: 0, settled: 0 },
  );
}

/* ── 佣金流水与结算单的成形 ─────────────────────────────────────────────── */

type EntryRow = Prisma.CommissionEntryGetPayload<Record<string, never>>;

function entryOf(row: EntryRow, users: Map<string, UserRow>): AdminCommissionEntry {
  const snap = (row.ruleSnapshotJson ?? null) as AdminCommissionEntry['ruleSnapshot'];
  return {
    id: row.id,
    outTradeNo: row.outTradeNo,
    buyer: personOf(users.get(row.buyerUserId), row.buyerUserId),
    beneficiary: personOf(users.get(row.beneficiaryUserId), row.beneficiaryUserId),
    distributorId: row.distributorId,
    level: row.level as 1 | 2 | 3,
    itemType: row.itemType === 'sku' ? 'sku' : 'plan',
    itemKey: row.itemKey,
    baseAmount: row.baseAmount,
    rateBp: row.rateBp,
    amount: row.amount,
    kind: row.kind as CommissionKind,
    status: row.status as CommissionStatus,
    holdUntil: row.holdUntil.toISOString(),
    settlementId: row.settlementId,
    reversedAt: iso(row.reversedAt),
    ruleSnapshot: snap ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/* ── 等级目录的成形（唯一一处）───────────────────────────────────────────
   契约声明 `POST /tiers`、`PATCH /tiers/:id`、`PUT /tiers/:id/rules` 都回**完整的**
   `AdminDistributorTier`（含 `rules` 与 `distributorCount`），不是 `{ok:true}`：前端那张
   3 层 × 3 类型的比例矩阵保存后直接拿返回值刷新，少一个字段它就得再打一次 GET，
   两次请求之间的窗口还会让「刚保存的值」和「屏上显示的值」短暂不一致。
   所以列表与三个写端点共用下面这一个成形函数——**不复制**。 */

/** `distributorCount` 一次 groupBy 批量算（DELETE 的前置条件也读它，两处同源）。 */
async function tierViews(id?: string): Promise<AdminDistributorTier[]> {
  const [tiers, counts] = await Promise.all([
    prisma.distributorTier.findMany({
      ...(id ? { where: { id } } : {}),
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      include: { rules: { orderBy: [{ level: 'asc' }, { itemType: 'asc' }] } },
    }),
    prisma.distributor.groupBy({
      by: ['tierId'],
      ...(id ? { where: { tierId: id } } : {}),
      _count: { _all: true },
    }),
  ]);
  const countByTier = new Map(counts.filter((c) => c.tierId).map((c) => [c.tierId!, c._count._all]));
  return tiers.map((t) => ({
    id: t.id,
    name: t.name,
    sort: t.sort,
    enabled: t.enabled,
    note: t.note,
    distributorCount: countByTier.get(t.id) ?? 0,
    rules: t.rules.map((r): AdminDistributionRule => ({
      id: r.id, level: r.level as 1 | 2 | 3, itemType: r.itemType as DistributionItemType,
      rateBp: r.rateBp, enabled: r.enabled,
    })),
    updatedAt: t.updatedAt.toISOString(),
  }));
}

/** 写完之后重读一遍（返回形状与 GET /tiers 逐字相同）。 */
async function tierView(id: string): Promise<AdminDistributorTier> {
  const [view] = await tierViews(id);
  if (!view) fail('等级不存在', 404, 'TIER_NOT_FOUND');
  return view!;
}

type SettlementRow = Prisma.CommissionSettlementGetPayload<Record<string, never>>;

function settlementOf(row: SettlementRow, brief: AdminDistributorBrief): AdminSettlement {
  return {
    id: row.id,
    distributor: brief,
    periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(),
    entryCount: row.entryCount,
    totalAmount: row.totalAmount,
    status: row.status as SettlementStatus,
    approvedBy: row.approvedBy,
    approvedAt: iso(row.approvedAt),
    paidBy: row.paidBy,
    paidAt: iso(row.paidAt),
    paidRef: row.paidRef,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 一批结算单要用的代理摘要：一次 findMany，不按单逐个查。 */
async function briefsByIds(ids: string[]): Promise<Map<string, AdminDistributorBrief>> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return new Map();
  const rows = await prisma.distributor.findMany({
    where: { id: { in: uniq } }, include: { tier: { select: { id: true, name: true } } },
  });
  return new Map(rows.map((r) => [r.id, briefOf(r)]));
}

function briefFallback(id: string): AdminDistributorBrief {
  // 代理档案被清理但结算单仍在（财务账本 retain）：如实显示成一个没有档案的 id，不要静默丢单。
  return { id, userId: '', status: 'terminated', tier: null, displayName: null };
}

/**
 * 按日的计提/追回（供一张柱图）。**日期按北京时间自然日**，与后台其它「今天」口径一致。
 *
 * 两处必须小心：
 * ① `createdAt` 是 UTC naive 列，所以要 `AT TIME ZONE 'UTC'` 先当成 timestamptz，再
 *    `AT TIME ZONE 'Asia/Shanghai'` 落成上海本地日历——只写一次 AT TIME ZONE 会把方向搞反，
 *    整张图偏 8 小时（跨日的那几笔会画到隔天）。
 * ② 窗口边界过 `utcTimestamp`（见 memory「Prisma raw SQL Date 参数时区偏移」）：同一个 Date
 *    直接插进原生 SQL 会按会话时区渲染成本地 naive，与列的 UTC naive 语义差一个时区。
 * clawback 之和是**负数**，原样下发：柱图把它画在 0 轴下方，一眼看得出哪天在追回。
 */
async function dailySeries(days: number, distributorId: string | null): Promise<{ date: string; accrued: number; clawback: number }[]> {
  const since = new Date(now().getTime() - days * DAY_MS);
  const rows = await prisma.$queryRaw<{ d: string; accrued: bigint | number; clawback: bigint | number }[]>(Prisma.sql`
    SELECT to_char(("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD') AS d,
           COALESCE(SUM(CASE WHEN "kind" = 'accrual'  THEN "amount" ELSE 0 END), 0) AS accrued,
           COALESCE(SUM(CASE WHEN "kind" = 'clawback' THEN "amount" ELSE 0 END), 0) AS clawback
    FROM commission_entry
    WHERE "createdAt" >= ${utcTimestamp(since)}
      AND "status" <> 'reversed'
      ${distributorId ? Prisma.sql`AND "distributorId" = ${distributorId}` : Prisma.empty}
    GROUP BY d
    ORDER BY d ASC`);
  return rows.map((r) => ({ date: r.d, accrued: Number(r.accrued), clawback: Number(r.clawback) }));
}

/** 团队分级统计（代理详情用；单人一屏，成员 id 有上限，理由见 TEAM_ID_CAP）。 */
async function levelStats(userId: string, distributorId: string | null): Promise<AdminChainLevelStat[]> {
  const at = now();
  const out: AdminChainLevelStat[] = [];
  for (const level of [1, 2, 3] as const) {
    const where: Prisma.ReferralWhereInput = level === 1 ? { lv1: userId } : level === 2 ? { lv2: userId } : { lv3: userId };
    const [users, rows] = await Promise.all([
      prisma.referral.count({ where }),
      prisma.referral.findMany({ where, select: { userId: true }, take: TEAM_ID_CAP }),
    ]);
    const ids = rows.map((r) => r.userId);
    const [activated, gmv, commission] = await Promise.all([
      ids.length === 0 ? Promise.resolve(0) : prisma.user.count({
        // 与 planGate 同一判定：无 planId = 未开通；有 planId 且未到期 = 已开通（null 到期日 = 不到期）。
        where: { id: { in: ids }, planId: { not: null }, OR: [{ planExpiresAt: null }, { planExpiresAt: { gt: at } }] },
      }),
      ids.length === 0 ? Promise.resolve({ _sum: { amount: null } }) : prisma.paymentOrder.aggregate({
        _sum: { amount: true },
        where: { userId: { in: ids }, status: { in: ['paid', 'applied'] }, refundedAt: null },
      }),
      distributorId === null ? Promise.resolve(null) : prisma.commissionEntry.aggregate({
        _sum: { amount: true },
        // 净额：含负的 clawback，排除 reversed（从未成立的那些）。
        where: { distributorId, level, status: { in: ['pending', 'confirmed', 'settled'] } },
      }),
    ]);
    out.push({
      level,
      users,
      activated,
      paidGmv: gmv._sum.amount ?? 0,
      commission: commission === null ? null : (commission._sum.amount ?? 0),
    });
  }
  return out;
}

/* ── 路由 ───────────────────────────────────────────────────────────────── */

export async function adminDistributionRoutes(app: FastifyInstance) {
  // 与 routes/admin.ts 同一把闸：本插件内所有 /admin/distribution/* 都要过 requireAdmin。
  app.addHook('preHandler', requireAdmin);

  /* ── 配置：只读 ────────────────────────────────────────────────────────
     总开关与冻结期归「功能开关」页改，这里只显示当前生效值 + flag id（前端据此跳转）。
     `holdConfigured=false` 必须如实透出——否则运营会以为 7 天是他核定过的。 */
  app.get('/admin/distribution/config', async (): Promise<AdminDistributionConfig> => distributionConfig());

  /* ── 等级目录（成形见 tierViews；列表与三个写端点共用同一份）── */
  app.get('/admin/distribution/tiers', async (): Promise<AdminDistributorTier[]> => tierViews());

  app.post<{ Body: { name?: string; sort?: number; enabled?: boolean; note?: string | null } }>(
    '/admin/distribution/tiers',
    async (req, reply) => {
      try {
        const actor = actorOf(req);
        requireSuper(actor);
        const name = text(req.body?.name, 40);
        if (!name) fail('等级名称必填', 400, 'TIER_NAME_REQUIRED');
        const exists = await prisma.distributorTier.findUnique({ where: { name } });
        if (exists) fail('同名等级已存在', 409, 'TIER_NAME_TAKEN');
        const created = await prisma.distributorTier.create({
          data: {
            name,
            sort: Number.isFinite(Number(req.body?.sort)) ? Math.floor(Number(req.body?.sort)) : 0,
            enabled: req.body?.enabled !== false,
            note: text(req.body?.note, 200),
          },
        });
        await recordAudit({
          action: 'admin.distribution.tier.create',
          payload: { by: actorName(actor), before: null, after: { id: created.id, name: created.name, sort: created.sort, enabled: created.enabled } },
        });
        return reply.code(201).send(await tierView(created.id));
      } catch (e) { return sendErr(reply, e); }
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; sort?: number; enabled?: boolean; note?: string | null } }>(
    '/admin/distribution/tiers/:id',
    async (req, reply) => {
      try {
        const actor = actorOf(req);
        requireSuper(actor);
        const before = await prisma.distributorTier.findUnique({ where: { id: req.params.id } });
        if (!before) fail('等级不存在', 404, 'TIER_NOT_FOUND');
        const data: Prisma.DistributorTierUpdateInput = {};
        if (req.body?.name !== undefined) {
          const name = text(req.body.name, 40);
          if (!name) fail('等级名称必填', 400, 'TIER_NAME_REQUIRED');
          const dup = await prisma.distributorTier.findUnique({ where: { name } });
          if (dup && dup.id !== before!.id) fail('同名等级已存在', 409, 'TIER_NAME_TAKEN');
          data.name = name;
        }
        if (req.body?.sort !== undefined && Number.isFinite(Number(req.body.sort))) data.sort = Math.floor(Number(req.body.sort));
        if (req.body?.enabled !== undefined) data.enabled = !!req.body.enabled;
        if (req.body?.note !== undefined) data.note = text(req.body.note, 200);
        const after = await prisma.distributorTier.update({ where: { id: before!.id }, data });
        await recordAudit({
          action: 'admin.distribution.tier.update',
          payload: {
            by: actorName(actor),
            before: { name: before!.name, sort: before!.sort, enabled: before!.enabled, note: before!.note },
            after: { name: after.name, sort: after.sort, enabled: after.enabled, note: after.note },
          },
        });
        return await tierView(after.id);
      } catch (e) { return sendErr(reply, e); }
    },
  );

  /** 删等级：**仅在无代理挂靠时允许**（否则那些代理会静默失去全部比例，等于悄悄停发）。规则随 cascade 一起删。 */
  app.delete<{ Params: { id: string } }>('/admin/distribution/tiers/:id', async (req, reply) => {
    try {
      const actor = actorOf(req);
      requireSuper(actor);
      const tier = await prisma.distributorTier.findUnique({ where: { id: req.params.id } });
      if (!tier) fail('等级不存在', 404, 'TIER_NOT_FOUND');
      const attached = await prisma.distributor.count({ where: { tierId: tier!.id } });
      if (attached > 0) fail(`仍有 ${attached} 位代理挂在该等级，先改挂或终止后再删`, 409, 'TIER_IN_USE');
      await prisma.distributorTier.delete({ where: { id: tier!.id } });
      await recordAudit({
        action: 'admin.distribution.tier.delete',
        payload: { by: actorName(actor), before: { id: tier!.id, name: tier!.name }, after: null },
      });
      return { ok: true };
    } catch (e) { return sendErr(reply, e); }
  });

  /**
   * 整体替换某等级的比例矩阵（事务内 deleteMany + createMany）。
   * **整体替换而不是逐条 patch**：前端那张 3 层 × 3 类型的矩阵一次保存就是一个完整意图，
   * 「不在列表里的组合视为删除」写在契约里；逐条 patch 会让「把某格清空」变成没有表达方式。
   */
  app.put<{ Params: { id: string }; Body: { rules?: { level?: number; itemType?: string; rateBp?: number; enabled?: boolean }[] } }>(
    '/admin/distribution/tiers/:id/rules',
    async (req, reply) => {
      try {
        const actor = actorOf(req);
        requireSuper(actor);
        const tier = await prisma.distributorTier.findUnique({ where: { id: req.params.id }, include: { rules: true } });
        if (!tier) fail('等级不存在', 404, 'TIER_NOT_FOUND');
        const raw = Array.isArray(req.body?.rules) ? req.body!.rules! : fail('rules 必须是数组', 400, 'RULES_INVALID');
        const seen = new Set<string>();
        const rules = raw.map((r) => {
          const level = Math.floor(Number(r?.level));
          if (!Number.isFinite(level) || level < 1 || level > MAX_COMMISSION_LEVEL) {
            fail(`层级只能是 1..${MAX_COMMISSION_LEVEL}（与邀请关系的三级物化路径同深）`, 400, 'RULE_LEVEL_INVALID');
          }
          const itemType = String(r?.itemType ?? '');
          if (!ITEM_TYPES.includes(itemType as DistributionItemType)) fail(`商品类型只能是 ${ITEM_TYPES.join(' / ')}`, 400, 'RULE_ITEM_TYPE_INVALID');
          const rateBp = Math.floor(Number(r?.rateBp));
          if (!Number.isFinite(rateBp) || rateBp < 0 || rateBp > RATE_BP_MAX) fail(`比例必须在 0..${RATE_BP_MAX} 万分比之间`, 400, 'RULE_RATE_INVALID');
          const key = `${level}:${itemType}`;
          if (seen.has(key)) fail(`同一层级同一商品类型只能配一条（重复：${key}）`, 400, 'RULE_DUPLICATE');
          seen.add(key);
          return { tierId: tier!.id, level, itemType, rateBp, enabled: r?.enabled !== false };
        });
        await prisma.$transaction(async (tx) => {
          await tx.distributionRule.deleteMany({ where: { tierId: tier!.id } });
          if (rules.length > 0) await tx.distributionRule.createMany({ data: rules });
        });
        await recordAudit({
          action: 'admin.distribution.rules.replace',
          payload: {
            by: actorName(actor), tierId: tier!.id, tierName: tier!.name,
            before: tier!.rules.map((r) => ({ level: r.level, itemType: r.itemType, rateBp: r.rateBp, enabled: r.enabled })),
            after: rules.map((r) => ({ level: r.level, itemType: r.itemType, rateBp: r.rateBp, enabled: r.enabled })),
          },
        });
        // 重读而不是拿刚拼好的 rules 回：id 是库里生成的，运营下一步要用它，拼出来的没有 id。
        return await tierView(tier!.id);
      } catch (e) { return sendErr(reply, e); }
    },
  );

  /* ── 代理名册 ─────────────────────────────────────────────────────────
     `q` 匹配代理对外名称 / 联系手机 / 账号姓名 / 账号手机 / userId。
     姓名与手机在 User 表上，所以先按 q 找候选用户 id，再并进 where 的 OR ——
     一次子查询换掉「先取全量代理再在内存里过滤」（那种写法在放量后必然要重写）。 */
  app.get<{ Querystring: { q?: string; status?: string; tierId?: string; page?: string; pageSize?: string } }>(
    '/admin/distribution/distributors',
    async (req): Promise<AdminDistributorList> => {
      const { page, pageSize, skip } = paging(req.query);
      const q = text(req.query.q, 60);
      const where: Prisma.DistributorWhereInput = {};
      if (req.query.status) where.status = String(req.query.status);
      if (req.query.tierId) where.tierId = String(req.query.tierId);
      if (q) {
        const matched = await prisma.user.findMany({
          where: { OR: [{ name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }, { id: q }] },
          select: { id: true }, take: 500,
        });
        where.OR = [
          { displayName: { contains: q, mode: 'insensitive' } },
          { contactPhone: { contains: q } },
          { userId: { in: matched.map((m) => m.id) } },
        ];
      }
      const [total, rows] = await Promise.all([
        prisma.distributor.count({ where }),
        prisma.distributor.findMany({
          where, include: { tier: { select: { id: true, name: true } } },
          orderBy: [{ createdAt: 'desc' }], skip, take: pageSize,
        }),
      ]);
      const [users, team, sums] = await Promise.all([
        usersByIds(rows.map((r) => r.userId)),
        teamCounts(rows.map((r) => r.userId)),
        commissionSums(rows.map((r) => r.id)),
      ]);
      return {
        items: rows.map((d) => itemOf(
          d, users.get(d.userId),
          team.get(d.userId) ?? { lv1: 0, lv2: 0, lv3: 0 },
          sums.get(d.id) ?? { accrued: 0, pending: 0, settled: 0 },
        )),
        total, page, pageSize,
      };
    },
  );

  /**
   * 登记代理。**运营登记即 `active`**（`pending` 那档留给将来的自助申请流程，本期没有入口）。
   * 用户不存在 404、已是代理 409（一人一条，schema 上的唯一键也兜着）。
   */
  app.post<{ Body: { userId?: string; tierId?: string | null; displayName?: string | null; contactPhone?: string | null; remark?: string | null } }>(
    '/admin/distribution/distributors',
    async (req, reply) => {
      try {
        const actor = actorOf(req);
        requireSuper(actor);
        const userId = text(req.body?.userId, 64);
        if (!userId) fail('userId 必填', 400, 'USER_ID_REQUIRED');
        const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, tenantId: true, name: true, phone: true } });
        if (!user) fail('用户不存在', 404, 'USER_NOT_FOUND');
        const exists = await prisma.distributor.findUnique({ where: { userId } });
        if (exists) fail('该用户已是代理', 409, 'DISTRIBUTOR_EXISTS');
        const tierId = text(req.body?.tierId, 64);
        if (tierId) {
          const tier = await prisma.distributorTier.findUnique({ where: { id: tierId } });
          if (!tier) fail('等级不存在', 404, 'TIER_NOT_FOUND');
        }
        const at = now();
        const created = await prisma.distributor.create({
          data: {
            userId, tenantId: user.tenantId, tierId,
            status: 'active',
            displayName: text(req.body?.displayName, 60),
            contactPhone: text(req.body?.contactPhone, 20),
            remark: text(req.body?.remark, 500),
            approvedBy: actorName(actor), approvedAt: at,
          },
        });
        await recordAudit({
          tenantId: user.tenantId, userId: user.id,
          action: 'admin.distribution.distributor.create',
          payload: {
            by: actorName(actor), before: null,
            // 手机号进审计同样掩码（summarizeForAudit 也会按键名兜一层，这里显式再走一次不吃亏）。
            after: { id: created.id, userId, tierId, status: created.status, displayName: created.displayName, contactPhone: maskAuditPhone(created.contactPhone) },
          },
        });
        return reply.code(201).send(await loadItem(created.id));
      } catch (e) { return sendErr(reply, e); }
    },
  );

  app.get<{ Params: { id: string } }>('/admin/distribution/distributors/:id', async (req, reply): Promise<AdminDistributorDetail | undefined> => {
    try {
      const item = await loadItem(req.params.id);
      const [team, entries, settlements] = await Promise.all([
        levelStats(item.userId, item.id),
        prisma.commissionEntry.findMany({ where: { distributorId: item.id }, orderBy: { createdAt: 'desc' }, take: RECENT_COMMISSIONS }),
        prisma.commissionSettlement.findMany({ where: { distributorId: item.id }, orderBy: { createdAt: 'desc' }, take: DETAIL_SETTLEMENTS }),
      ]);
      const users = await usersByIds(entries.flatMap((e) => [e.buyerUserId, e.beneficiaryUserId]));
      const brief: AdminDistributorBrief = {
        id: item.id, userId: item.userId, status: item.status, tier: item.tier, displayName: item.displayName,
      };
      return {
        distributor: item,
        team,
        recentCommissions: entries.map((e) => entryOf(e, users)),
        settlements: settlements.map((s) => settlementOf(s, brief)),
      };
    } catch (e) { sendErr(reply, e); return undefined; }
  });

  /**
   * 改代理档案 / 走状态机。
   *
   * 状态机：`active ↔ suspended`；`→ terminated` 是**终态**（之后只读，连改名都不行——
   * 终止后的档案就是历史凭据）。`pending` 不接受（契约里已排除）。
   * `suspended` 的语义是**暂停计提**，不是延后：暂停期间的成交永久不产生佣金行，
   * 解除暂停也不会补算（services/commission.ts 的 accrueForOrder 口径 ③）。
   */
  app.patch<{ Params: { id: string }; Body: { tierId?: string | null; status?: string; displayName?: string | null; contactPhone?: string | null; remark?: string | null } }>(
    '/admin/distribution/distributors/:id',
    async (req, reply) => {
      try {
        const actor = actorOf(req);
        requireSuper(actor);
        const before = await prisma.distributor.findUnique({ where: { id: req.params.id } });
        if (!before) fail('代理不存在', 404, 'DISTRIBUTOR_NOT_FOUND');
        if (before!.status === 'terminated') fail('该代理已终止，档案只读', 409, 'DISTRIBUTOR_TERMINATED');
        const at = now();
        const data: Prisma.DistributorUpdateInput = {};
        if (req.body?.status !== undefined) {
          const next = String(req.body.status);
          if (!['active', 'suspended', 'terminated'].includes(next)) fail('状态只能是 active / suspended / terminated', 400, 'STATUS_INVALID');
          if (next !== before!.status) {
            data.status = next;
            if (next === 'active') { data.suspendedAt = null; data.approvedBy = actorName(actor); data.approvedAt = at; }
            if (next === 'suspended') data.suspendedAt = at;
            if (next === 'terminated') data.terminatedAt = at;
          }
        }
        if (req.body?.tierId !== undefined) {
          const tierId = text(req.body.tierId, 64);
          if (tierId) {
            const tier = await prisma.distributorTier.findUnique({ where: { id: tierId } });
            if (!tier) fail('等级不存在', 404, 'TIER_NOT_FOUND');
          }
          data.tier = tierId ? { connect: { id: tierId } } : { disconnect: true };
        }
        if (req.body?.displayName !== undefined) data.displayName = text(req.body.displayName, 60);
        if (req.body?.contactPhone !== undefined) data.contactPhone = text(req.body.contactPhone, 20);
        if (req.body?.remark !== undefined) data.remark = text(req.body.remark, 500);
        const after = await prisma.distributor.update({ where: { id: before!.id }, data });
        await recordAudit({
          tenantId: before!.tenantId, userId: before!.userId,
          action: 'admin.distribution.distributor.update',
          payload: {
            by: actorName(actor),
            before: { status: before!.status, tierId: before!.tierId, displayName: before!.displayName, contactPhone: maskAuditPhone(before!.contactPhone), remark: before!.remark },
            after: { status: after.status, tierId: after.tierId, displayName: after.displayName, contactPhone: maskAuditPhone(after.contactPhone), remark: after.remark },
          },
        });
        return await loadItem(after.id);
      } catch (e) { return sendErr(reply, e); }
    },
  );

  /* ── 佣金流水（只读账本）───────────────────────────────────────────────
     `summary` 与 `items` 吃**同一个 where**（除分页），否则汇总和明细会各说一套。
     `daily` 刻意只跟 distributorId 走、不吃 status/kind 筛选——那张图本身就是按 kind 分列的，
     再叠一层 kind 筛选画出来的柱子没有意义。 */
  app.get<{ Querystring: { distributorId?: string; status?: string; kind?: string; days?: string; page?: string; pageSize?: string } }>(
    '/admin/distribution/commissions',
    async (req): Promise<AdminCommissionList> => {
      const { page, pageSize, skip } = paging(req.query);
      const days = optionalDays(req.query.days);
      const distributorId = text(req.query.distributorId, 64);
      const where: Prisma.CommissionEntryWhereInput = {};
      if (distributorId) where.distributorId = distributorId;
      if (req.query.status) where.status = String(req.query.status);
      if (req.query.kind) where.kind = String(req.query.kind);
      if (days !== null) where.createdAt = { gte: new Date(now().getTime() - days * DAY_MS) };

      const [total, rows, grouped, daily] = await Promise.all([
        prisma.commissionEntry.count({ where }),
        prisma.commissionEntry.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
        prisma.commissionEntry.groupBy({ by: ['status'], where, _sum: { amount: true }, _count: { _all: true } }),
        dailySeries(days ?? DAILY_DEF_DAYS, distributorId),
      ]);
      const users = await usersByIds(rows.flatMap((r) => [r.buyerUserId, r.beneficiaryUserId]));
      return {
        items: rows.map((r) => entryOf(r, users)),
        total, page, pageSize,
        summary: grouped.map((g) => ({
          status: g.status as CommissionStatus, amount: g._sum.amount ?? 0, count: g._count._all,
        })).sort((a, b) => a.status.localeCompare(b.status)),
        daily,
      };
    },
  );

  /* ── 结算单 ───────────────────────────────────────────────────────────── */

  app.get<{ Querystring: { distributorId?: string; status?: string; page?: string; pageSize?: string } }>(
    '/admin/distribution/settlements',
    async (req): Promise<AdminSettlementList> => {
      const { page, pageSize, skip } = paging(req.query);
      const where: Prisma.CommissionSettlementWhereInput = {};
      const distributorId = text(req.query.distributorId, 64);
      if (distributorId) where.distributorId = distributorId;
      if (req.query.status) where.status = String(req.query.status);
      const [total, rows] = await Promise.all([
        prisma.commissionSettlement.count({ where }),
        prisma.commissionSettlement.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: pageSize }),
      ]);
      const briefs = await briefsByIds(rows.map((r) => r.distributorId));
      return {
        items: rows.map((r) => settlementOf(r, briefs.get(r.distributorId) ?? briefFallback(r.distributorId))),
        total, page, pageSize,
      };
    },
  );

  /**
   * 生成 draft 结算单。
   *
   * 纳入条件：`status='confirmed' AND settlementId IS NULL AND createdAt ∈ [periodStart, periodEnd)`
   * ——**含 clawback**（负额），所以一张单的净额可能是负的；那正是「上期多结了、这期抵扣」
   * 该有的样子，零行才不生成。
   *
   * 三处刻意的选择：
   * ① 每个代理**先拿 advisory lock 再挑行**：两个运营同时点生成会各自挑到同一批 confirmed 行，
   *    不串行化就会出两张单都挂着（后写的赢）——而先出的那张单金额已经打印给财务了。
   * ② 挂行的 `updateMany` 仍带 `settlementId: null` 条件，然后**按流水重算**单据金额：
   *    锁只保护同一进程/同一库的并发，重算保证「单上的数字永远等于挂在它下面的流水之和」。
   * ③ 缺省（不传 distributorId）只给 `active` / `suspended` 出单：suspended 是暂停计提、
   *    不是拒付已成立的佣金，欠人家的钱照结。显式指定 distributorId 时不限状态——
   *    terminated 的代理也可能还有一笔没结完的账。
   */
  app.post<{ Body: { distributorId?: string; periodStart?: string; periodEnd?: string } }>(
    '/admin/distribution/settlements/generate',
    async (req, reply) => {
      try {
        const actor = actorOf(req);
        requireSuper(actor);
        const start = new Date(String(req.body?.periodStart ?? ''));
        const end = new Date(String(req.body?.periodEnd ?? ''));
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) fail('periodStart / periodEnd 必须是合法时间', 400, 'PERIOD_INVALID');
        if (end.getTime() <= start.getTime()) fail('周期结束必须晚于开始', 400, 'PERIOD_INVALID');

        const only = text(req.body?.distributorId, 64);
        let targets: { id: string }[];
        if (only) {
          const d = await prisma.distributor.findUnique({ where: { id: only }, select: { id: true } });
          if (!d) fail('代理不存在', 404, 'DISTRIBUTOR_NOT_FOUND');
          targets = [d!];
        } else {
          targets = await prisma.distributor.findMany({ where: { status: { in: ['active', 'suspended'] } }, select: { id: true } });
        }

        const created: SettlementRow[] = [];
        let skipped = 0;
        for (const t of targets) {
          const made = await prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`commission:settle:${t.id}`}))`;
            const rows = await tx.commissionEntry.findMany({
              where: { distributorId: t.id, status: 'confirmed', settlementId: null, createdAt: { gte: start, lt: end } },
              select: { id: true },
            });
            if (rows.length === 0) return null;
            const settlement = await tx.commissionSettlement.create({
              data: { distributorId: t.id, periodStart: start, periodEnd: end, entryCount: 0, totalAmount: 0, status: 'draft' },
            });
            await tx.commissionEntry.updateMany({
              where: { id: { in: rows.map((r) => r.id) }, status: 'confirmed', settlementId: null },
              data: { settlementId: settlement.id },
            });
            await recomputeSettlement(tx, settlement.id);
            const fresh = await tx.commissionSettlement.findUniqueOrThrow({ where: { id: settlement.id } });
            // 并发下别人抢走了全部行 → 这张单是空的，删掉而不是留一张 0 元单给运营去猜。
            if (fresh.entryCount === 0) {
              await tx.commissionSettlement.delete({ where: { id: settlement.id } });
              return null;
            }
            return fresh;
          });
          if (made) created.push(made);
          else skipped += 1;
        }

        const briefs = await briefsByIds(created.map((c) => c.distributorId));
        await recordAudit({
          action: 'admin.distribution.settlement.generate',
          payload: {
            by: actorName(actor), before: null,
            after: {
              periodStart: start.toISOString(), periodEnd: end.toISOString(),
              distributorId: only, createdCount: created.length, skippedDistributors: skipped,
              settlements: created.map((c) => ({ id: c.id, distributorId: c.distributorId, entryCount: c.entryCount, totalAmount: c.totalAmount })),
            },
          },
        });
        const result: AdminSettlementGenerateResult = {
          created: created.map((c) => settlementOf(c, briefs.get(c.distributorId) ?? briefFallback(c.distributorId))),
          skippedDistributors: skipped,
        };
        return result;
      } catch (e) { return sendErr(reply, e); }
    },
  );

  /** draft → approved（已核）。核准只是「金额我看过了」，钱还没动，所以不碰流水状态。 */
  app.post<{ Params: { id: string } }>('/admin/distribution/settlements/:id/approve', async (req, reply) => {
    try {
      const actor = actorOf(req);
      requireSuper(actor);
      const before = await prisma.commissionSettlement.findUnique({ where: { id: req.params.id } });
      if (!before) fail('结算单不存在', 404, 'SETTLEMENT_NOT_FOUND');
      if (before!.status !== 'draft') fail(`只有草稿可核准（当前 ${before!.status}）`, 409, 'SETTLEMENT_STATUS_INVALID');
      const after = await prisma.commissionSettlement.update({
        where: { id: before!.id },
        data: { status: 'approved', approvedBy: actorName(actor), approvedAt: now() },
      });
      await recordAudit({
        action: 'admin.distribution.settlement.approve',
        payload: { by: actorName(actor), before: { id: before!.id, status: before!.status }, after: { status: after.status, entryCount: after.entryCount, totalAmount: after.totalAmount } },
      });
      const briefs = await briefsByIds([after.distributorId]);
      return settlementOf(after, briefs.get(after.distributorId) ?? briefFallback(after.distributorId));
    } catch (e) { return sendErr(reply, e); }
  });

  /**
   * approved → paid，**同事务**把挂在这张单上的 `confirmed` 流水推成 `settled`。
   * `paidRef`（线下打款凭证号）必填——这张单是「钱已经出去了」的唯一凭据，没有凭证号的
   * 已打款单事后无从对账。银行账户等打款资料不入库（线下财务保管），后台只记这一个号。
   */
  app.post<{ Params: { id: string }; Body: { paidRef?: string; note?: string | null } }>(
    '/admin/distribution/settlements/:id/paid',
    async (req, reply) => {
      try {
        const actor = actorOf(req);
        requireSuper(actor);
        const paidRef = text(req.body?.paidRef, 80);
        if (!paidRef) fail('打款凭证号必填', 400, 'PAID_REF_REQUIRED');
        const before = await prisma.commissionSettlement.findUnique({ where: { id: req.params.id } });
        if (!before) fail('结算单不存在', 404, 'SETTLEMENT_NOT_FOUND');
        if (before!.status !== 'approved') fail(`只有已核准的单可标记打款（当前 ${before!.status}）`, 409, 'SETTLEMENT_STATUS_INVALID');
        const at = now();
        const after = await prisma.$transaction(async (tx) => {
          await tx.commissionEntry.updateMany({
            where: { settlementId: before!.id, status: 'confirmed' },
            data: { status: 'settled' },
          });
          return tx.commissionSettlement.update({
            where: { id: before!.id },
            data: { status: 'paid', paidBy: actorName(actor), paidAt: at, paidRef, note: text(req.body?.note, 500) ?? before!.note },
          });
        });
        await recordAudit({
          action: 'admin.distribution.settlement.paid',
          payload: {
            by: actorName(actor),
            before: { id: before!.id, status: before!.status },
            after: { status: after.status, paidRef, entryCount: after.entryCount, totalAmount: after.totalAmount },
          },
        });
        const briefs = await briefsByIds([after.distributorId]);
        return settlementOf(after, briefs.get(after.distributorId) ?? briefFallback(after.distributorId));
      } catch (e) { return sendErr(reply, e); }
    },
  );

  /**
   * draft / approved → void（作废），并把关联流水 `settlementId` 解绑放回待结池。
   *
   * **已打款（paid）的单不可作废**：钱已经出去了，要冲要走追回（退款侧的 clawback）或下一张
   * 单的负额，不是把凭据抹掉。作废单上的 `entryCount/totalAmount` **刻意保留原值**——
   * 它是「这张单当初包含了什么」的凭据，解绑后重算成 0 就再也说不清作废了多少。
   */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/admin/distribution/settlements/:id/void',
    async (req, reply) => {
      try {
        const actor = actorOf(req);
        requireSuper(actor);
        const reason = text(req.body?.reason, 200);
        if (!reason) fail('作废原因必填', 400, 'VOID_REASON_REQUIRED');
        const before = await prisma.commissionSettlement.findUnique({ where: { id: req.params.id } });
        if (!before) fail('结算单不存在', 404, 'SETTLEMENT_NOT_FOUND');
        if (before!.status !== 'draft' && before!.status !== 'approved') {
          fail(`只有草稿/已核准的单可作废（当前 ${before!.status}）`, 409, 'SETTLEMENT_STATUS_INVALID');
        }
        const at = now();
        const after = await prisma.$transaction(async (tx) => {
          await tx.commissionEntry.updateMany({ where: { settlementId: before!.id }, data: { settlementId: null } });
          return tx.commissionSettlement.update({
            where: { id: before!.id },
            data: { status: 'void', note: `${before!.note ? `${before!.note}\n` : ''}[作废 ${at.toISOString()} by ${actorName(actor)}] ${reason}` },
          });
        });
        await recordAudit({
          action: 'admin.distribution.settlement.void',
          payload: {
            by: actorName(actor), reason,
            before: { id: before!.id, status: before!.status, entryCount: before!.entryCount, totalAmount: before!.totalAmount },
            after: { status: after.status },
          },
        });
        const briefs = await briefsByIds([after.distributorId]);
        return settlementOf(after, briefs.get(after.distributorId) ?? briefFallback(after.distributorId));
      } catch (e) { return sendErr(reply, e); }
    },
  );
}
