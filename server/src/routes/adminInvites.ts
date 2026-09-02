// 运营后台「增长」组：邀请关系账本 / 归因日志 / CSV 导出 / 运营补绑 / 邀请链（2026-09-02）。
//
// 方案见 docs/[FABLE5]ADMIN_GROWTH_DISTRIBUTION_PLAN_2026-09-02.md §3.2。
// 与 `routes/adminReferral.ts`（那三个只读投影）的分工：那边回答「整体形状如何」，
// 这边回答「这一条关系是怎么来的」「这个人的上下游是谁」，并且**有一个写操作**（补绑）。
//
// 五个端点（自挂同一把 `requireAdmin`，与 admin.ts / adminReferral.ts 同口径）：
//   GET  /admin/invites               关系账本分页（两侧姓名+掩码手机、码、来源、开通状态、首笔付费）
//   GET  /admin/invites/attributions  归因日志分页（八种 outcome 全留痕，含失败的补绑尝试）
//   GET  /admin/invites/export        CSV 导出（super）
//   POST /admin/invites/manual-bind   运营补绑（super）——本文件唯一的写操作
//   GET  /admin/invites/chain/:userId 以人为中心：上溯链 / 三级下钻 / 三级团队统计 / 代理档案
//
// ── 三条贯穿口径（与契约段首、adminReferral.ts 同源，不在这里另行发明）────────────────
// ① **隐私**：手机号一律 `maskAuditPhone`（与审计日志同一把掩码），**任何响应都不下发
//    userAgent**。归因日志**下发 clientIp**——那是风控原料，运营排查「同 IP 批量注册」时
//    要能看见；设备指纹不是，摊给每个后台账号没有对价。
// ② **读失败不伪装成空**：本文件不写任何兜底空数组的 try/catch。DB 抖动就让它 5xx，
//    前端 `useResource` 渲染成「加载失败 + 重试」，而不是「你还没有邀请关系」。
// ③ **金额一律分、时间一律 ISO 串、分页一律 { items, total, page, pageSize }**。
//
// ── 为什么列表走原生 SQL 而不是 Prisma findMany ────────────────────────────────
// 两个筛选做不到「只用 Prisma 且不撒谎」：
//   · `q` 要同时匹配**两侧**的姓名/手机/邀请码/userId，而 `Referral` 在 schema 里**没有**到
//     `User` 的 relation（它是一张只按 id 记账的账本），所以没有 nested where 可用；
//   · `inviteeStatus` 是 planGate 口径（`planId` 存在且未到期），条件挂在被邀人的 user 行上。
// 退而求其次的写法是「先查一批 user id 再 `userId: { in: ids }`」——那必须给 id 列表设上限，
// 于是**筛选结果与 total 双双静默不全**（运营看到 total=200 而库里有 3000）。一条 LEFT JOIN
// 把过滤和分页都留在 SQL 里，`total` 才是真的 total。
// **LEFT JOIN 而不是 JOIN**：注销用户的 `app_user` 行会被删、`Referral` 行按政策保留（关系是
// 第三方的账本，A 邀请了 B，B 注销跟 A 的业绩无关）。用 INNER JOIN 会让这些边从账本里消失。
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma, utcTimestamp } from '../db.js';
import { requireAdmin, actorOf, isSuperActor, type AdminActor } from '../services/adminAuth.js';
import { maskAuditPhone, recordAudit, isoSecond } from '../services/audit.js';
import { now } from '../services/clock.js';
import { bindManually, ReferralUserNotFound } from '../services/referral.js';
import {
  buildReferralSubtrees, referralEdgeStats, riskThreshold, clampDays, tenantOf, planStatus,
} from './adminReferral.js';
import type {
  AdminInviteEdge, AdminInviteList, AdminInviteAttribution, AdminInviteAttributionList,
  AdminManualBindResult, AdminChainView, AdminChainAncestor, AdminChainLevelStat,
  AdminDistributorBrief, AdminPersonRef, AdminPlanActivation, ReferralSource,
  ReferralBindingOutcome,
} from '../../../shared/contracts';

const DAY_MS = 86_400_000;
/** 上溯 hop 上限：与 `services/referral.ts` 的 `MAX_HOPS` 同值（那里是查环预算，这里是展示预算）。 */
const MAX_UPLINE_HOPS = 64;
/** CSV 一次导出的行数上限（与 `/admin/payments/export` 同值）。 */
const EXPORT_ROW_CAP = 5000;

/**
 * 「曾付费」的订单状态。**`refunded` 也算**：首笔付费回答的是「这个被邀人掏过钱吗」，
 * 退款是后来发生的事，把它剔掉会让「邀请带来过付费用户」这件事凭空消失。
 * 是否已退款由 `firstPaid.refunded` 单独告知，两件事分开表达，不合并成一个布尔。
 */
const EVER_PAID_STATUSES = ['paid', 'applied', 'refunded'];
/** GMV 口径：**已退款不计**（真金没留下）。与「曾付费」刻意不同源，别互相套用。 */
const GMV_STATUSES = ['paid', 'applied'];

/* ── 入参解析 ───────────────────────────────────────────────────────────── */

function pageOf(raw: { page?: string; pageSize?: string }): { page: number; pageSize: number; skip: number } {
  const page = Math.max(1, Math.floor(Number(raw.page) || 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(Number(raw.pageSize) || 20)));
  return { page, pageSize, skip: (page - 1) * pageSize };
}

/**
 * `days` 缺省 = **全量**，不是 30 天。
 *
 * 邀请关系是永久的（`boundAt` 只是建边时刻，关系本身不过期），这块屏是账本不是趋势图。
 * 默认套一个窗口的后果是运营打开页面看到的行数比库里少，而界面上没有任何地方说明为什么
 * ——他会以为关系丢了。要窗口就显式传。
 */
function daysOf(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(3650, Math.floor(n));
}

function textOf(raw: unknown, max = 64): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

/**
 * `q` 的匹配面：两侧姓名（contains）/ 手机（**精确或前缀**）/ 邀请码 / userId。
 *
 * 手机刻意**不用 contains**：`phone LIKE '%1234%'` 在归因表与用户表上都是全表扫，而运营
 * 手上的输入形态只有「完整号码」或「前几位」，前缀匹配走得动索引也够用。
 * LIKE 的通配符**转义**而不是剥掉（Prisma 已参数化、不存在注入，但用户敲进来的 `%` 不该
 * 变成「匹配所有人」——那会让一次手滑把整张表当成搜索结果；剥掉也不行，剥完 `%` 只剩一个
 * 空串，拼出来的 `'%%'` 照样匹配所有人）。转义后它按字面找名字里真有 `%` 的人。
 */
function qClauses(q: string, cols: { code: Prisma.Sql; ids: Prisma.Sql[]; users: Prisma.Sql[] }): Prisma.Sql {
  const upper = q.toUpperCase();
  const lit = q.replace(/[\\%_]/g, (m) => `\\${m}`); // Postgres LIKE 默认转义符就是反斜杠
  const digits = /^\d{3,11}$/.test(q);
  const parts: Prisma.Sql[] = [Prisma.sql`${cols.code} = ${upper}`];
  for (const id of cols.ids) parts.push(Prisma.sql`${id} = ${q}`);
  for (const u of cols.users) {
    parts.push(Prisma.sql`${u}."name" ILIKE ${`%${lit}%`}`);
    parts.push(Prisma.sql`${u}."inviteCode" = ${upper}`);
    if (digits) parts.push(Prisma.sql`${u}."phone" LIKE ${`${lit}%`}`);
  }
  return Prisma.sql`(${Prisma.join(parts, ' OR ')})`;
}

/**
 * planGate 口径的 SQL 版：**与 `planStatus()` 逐字等价**（有 planId 且未到期 = activated）。
 * `User.planId` 是指向 `Plan` 的外键，不会是空串，所以 `IS NOT NULL` 与 `!u.planId` 同义。
 * 时间走 `clock.now()`（沙箱 `x-test-now` 快进后要与套餐页、与树的着色是同一个答案），
 * 且必须经 `utcTimestamp` 渲染 —— 裸 Date 插进原生 SQL 会按会话时区变成本地 naive，
 * 与 UTC naive 列比出一个时区偏移（生产 8 小时，见 memory「Prisma raw SQL Date 参数时区偏移」）。
 */
function planStatusClause(alias: Prisma.Sql, status: AdminPlanActivation, at: Date): Prisma.Sql {
  const ts = utcTimestamp(at);
  return status === 'activated'
    ? Prisma.sql`(${alias}."planId" IS NOT NULL AND (${alias}."planExpiresAt" IS NULL OR ${alias}."planExpiresAt" > ${ts}))`
    : Prisma.sql`(${alias}."planId" IS NULL OR (${alias}."planExpiresAt" IS NOT NULL AND ${alias}."planExpiresAt" <= ${ts}))`;
}

function andAll(conds: Prisma.Sql[]): Prisma.Sql {
  return conds.length === 0 ? Prisma.sql`TRUE` : Prisma.join(conds, ' AND ');
}

function person(userId: string, name: string | null, phone: string | null, tenantId: string): AdminPersonRef {
  // 掩码在这里发生，而不是在前端：响应里一旦有完整号码，它就已经进了每个后台账号的浏览器
  // 与所有中间日志，前端「不显示」拦不住任何东西。
  return { userId, name: name ?? null, phone: maskAuditPhone(phone), tenantId };
}

/* ── 代理字段（读 S1 建的 Distributor / CommissionEntry，本包不写这两张表）─────────
   `AdminInviteEdge.inviterIsDistributor`、`AdminChainAncestor.isDistributor`、
   `AdminChainLevelStat.commission`、`AdminChainView.distributor` 四处的取数收在这一段里，
   调用点只认这三个函数的返回值。代理与佣金的**写入**全在 `routes/adminDistribution.ts`
   与 `services/commission.ts`（工作包 S1），本文件一行不写。 */

/**
 * 「生效中的代理」= `status='active'`。
 *
 * **`suspended` 不算**：暂停计提的代理在这块屏上打代理徽标会让运营以为这条边还在产生佣金。
 * 代理的完整状态机（active↔suspended、→terminated 终态）在代理分销页看，这里只回一个
 * 「此刻是否在计提」的布尔。
 */
async function activeDistributorIds(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await prisma.distributor.findMany({
    where: { userId: { in: userIds }, status: 'active' },
    select: { userId: true },
  });
  return new Set(rows.map((r) => r.userId));
}

/** 本人代理档案摘要（含等级名）；非代理回 null。**不含 contactPhone/remark** —— 邀请链这块屏不需要。 */
async function distributorBrief(userId: string): Promise<AdminDistributorBrief | null> {
  const d = await prisma.distributor.findUnique({
    where: { userId },
    select: { id: true, userId: true, status: true, displayName: true, tier: { select: { id: true, name: true } } },
  });
  if (!d) return null;
  return {
    id: d.id,
    userId: d.userId,
    status: d.status as AdminDistributorBrief['status'],
    tier: d.tier ? { id: d.tier.id, name: d.tier.name } : null,
    displayName: d.displayName,
  };
}

/**
 * 本人为代理时各级佣金净额（分，含负的 clawback）。
 *
 * 口径：`CommissionEntry` 里 `beneficiaryUserId = 本人` 按 `level` 求 `amount` **净额**
 * ——`accrual` 正、`clawback` 负，一次 groupBy 求和天然就是净额，不必分 kind 再相减。
 * `reversed`（结算前退款冲销）**要剔掉**：那笔计提已经作废，留在净额里会让团队页显示一份
 * 永远不会打款的佣金。
 * **非代理必须回 null 而不是空 Map**：`AdminChainLevelStat.commission` 的 null 表示
 * 「这个人不是代理，这一栏不适用」，0 表示「是代理但这一级还没产生佣金」，界面上不许混。
 */
async function commissionByLevel(userId: string): Promise<Map<number, number> | null> {
  const d = await prisma.distributor.findUnique({ where: { userId }, select: { id: true } });
  if (!d) return null;
  const rows = await prisma.commissionEntry.groupBy({
    by: ['level'],
    where: { beneficiaryUserId: userId, status: { not: 'reversed' } },
    _sum: { amount: true },
  });
  return new Map(rows.map((r) => [r.level, r._sum.amount ?? 0]));
}

/* ── 关系账本的取数与成形 ───────────────────────────────────────────────── */

interface EdgeRow {
  userId: string;
  referrerId: string;
  inviteCode: string;
  source: string;
  boundAt: Date;
  tenantId: string;
  inviteeName: string | null;
  inviteePhone: string | null;
  inviteePlanId: string | null;
  inviteePlanExpiresAt: Date | null;
  inviterName: string | null;
  inviterPhone: string | null;
  inviterTenantId: string | null;
}

const EDGE_FROM = Prisma.sql`
  FROM referral r
  LEFT JOIN app_user u ON u.id = r."userId"
  LEFT JOIN app_user iu ON iu.id = r."referrerId"`;

async function edgeCount(where: Prisma.Sql): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: bigint | number }[]>(
    Prisma.sql`SELECT COUNT(*) AS n ${EDGE_FROM} WHERE ${where}`,
  );
  return Number(rows[0]?.n ?? 0);
}

async function edgeRows(where: Prisma.Sql, limit: number, offset: number): Promise<EdgeRow[]> {
  return prisma.$queryRaw<EdgeRow[]>(Prisma.sql`
    SELECT r."userId", r."referrerId", r."inviteCode", r."source", r."boundAt", r."tenantId",
           u."name"          AS "inviteeName",
           u."phone"         AS "inviteePhone",
           u."planId"        AS "inviteePlanId",
           u."planExpiresAt" AS "inviteePlanExpiresAt",
           iu."name"         AS "inviterName",
           iu."phone"        AS "inviterPhone",
           iu."tenantId"     AS "inviterTenantId"
    ${EDGE_FROM}
    WHERE ${where}
    ORDER BY r."boundAt" DESC, r."userId" ASC
    LIMIT ${limit} OFFSET ${offset}`);
}

/**
 * 被邀人的**首笔付费**：一条 `DISTINCT ON` 批量取回，杜绝按行查的 N+1。
 *
 * 「首笔」按 `paidAt` 最早，而不是 `createdAt`——下单顺序与实际付款顺序会不一致（挂着不付
 * 的旧单、补账追认的老单），运营问的是「他第一次真的掏钱是什么时候」。
 */
async function firstPaidOf(userIds: string[]): Promise<Map<string, { outTradeNo: string; amount: number; paidAt: Date; status: string }>> {
  if (userIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ userId: string; outTradeNo: string; amount: number; paidAt: Date; status: string }[]>(Prisma.sql`
    SELECT DISTINCT ON ("userId") "userId", "outTradeNo", "amount", "paidAt", "status"
    FROM payment_order
    WHERE "userId" IN (${Prisma.join(userIds)})
      AND "status" IN (${Prisma.join(EVER_PAID_STATUSES)})
      AND "paidAt" IS NOT NULL
    ORDER BY "userId", "paidAt" ASC`);
  return new Map(rows.map((r) => [r.userId, r]));
}

async function toEdges(rows: EdgeRow[], at: Date): Promise<AdminInviteEdge[]> {
  const inviteeIds = [...new Set(rows.map((r) => r.userId))];
  const inviterIds = [...new Set(rows.map((r) => r.referrerId))];
  const [firstPaid, distributors] = await Promise.all([
    firstPaidOf(inviteeIds),
    activeDistributorIds(inviterIds),
  ]);
  return rows.map((r): AdminInviteEdge => {
    const paid = firstPaid.get(r.userId);
    return {
      invitee: person(r.userId, r.inviteeName, r.inviteePhone, r.tenantId),
      // 邀请人的 user 行可能已注销（关系边按政策保留）：租户回落到边自己的 tenantId，
      // 姓名/手机为 null —— 前端据此显示短 id，而不是显示成一个空白的人。
      inviter: person(r.referrerId, r.inviterName, r.inviterPhone, r.inviterTenantId ?? r.tenantId),
      inviteCode: r.inviteCode,
      source: r.source as ReferralSource,
      boundAt: r.boundAt.toISOString(),
      inviteeStatus: planStatus({ planId: r.inviteePlanId, planExpiresAt: r.inviteePlanExpiresAt }, at),
      firstPaid: paid
        ? {
          outTradeNo: paid.outTradeNo,
          amount: paid.amount,
          paidAt: paid.paidAt.toISOString(),
          refunded: paid.status === 'refunded',
        }
        : null,
      inviterIsDistributor: distributors.has(r.referrerId),
    };
  });
}

/** 关系账本的筛选条件（列表与 CSV 导出共用同一份——导出与屏上所见必须是同一批行）。 */
function edgeWhere(query: {
  q?: string; source?: string; status?: string; tenantId?: string; days?: string;
}, at: Date): { where: Prisma.Sql; days: number | null } {
  const q = textOf(query.q);
  const source = textOf(query.source, 32);
  const status = textOf(query.status, 16);
  const tenantId = tenantOf(query.tenantId);
  const days = daysOf(query.days);
  const conds: Prisma.Sql[] = [];
  if (source) conds.push(Prisma.sql`r."source" = ${source}`);
  if (tenantId) conds.push(Prisma.sql`r."tenantId" = ${tenantId}`);
  if (days) conds.push(Prisma.sql`r."boundAt" >= ${utcTimestamp(new Date(at.getTime() - days * DAY_MS))}`);
  if (status === 'activated' || status === 'registered') {
    conds.push(planStatusClause(Prisma.raw('u'), status, at));
  }
  if (q) {
    conds.push(qClauses(q, {
      code: Prisma.raw('r."inviteCode"'),
      ids: [Prisma.raw('r."userId"'), Prisma.raw('r."referrerId"')],
      users: [Prisma.raw('u'), Prisma.raw('iu')],
    }));
  }
  return { where: andAll(conds), days };
}

/* ── 归因日志 ───────────────────────────────────────────────────────────── */

interface AttrRow {
  id: string;
  inviteCode: string;
  source: string;
  outcome: string;
  newUserId: string | null;
  referrerId: string | null;
  clientIp: string | null;
  tenantId: string;
  createdAt: Date;
  newName: string | null;
  newPhone: string | null;
  newTenantId: string | null;
  refName: string | null;
  refPhone: string | null;
  refTenantId: string | null;
}

const ATTR_FROM = Prisma.sql`
  FROM referral_attribution a
  LEFT JOIN app_user nu ON nu.id = a."newUserId"
  LEFT JOIN app_user ru ON ru.id = a."referrerId"`;

/* ── 错误回响 ───────────────────────────────────────────────────────────── */

function sendErr(reply: FastifyReply, e: unknown, fallback = 400) {
  const err = e as { statusCode?: number; code?: string; message?: string };
  return reply.code(err.statusCode ?? fallback).send({ error: err.message ?? '操作失败', code: err.code });
}

/** 仅 owner/master/legacy 超管（导出与补绑）。口径照 admin.ts 的 requireSuper，不另发明。 */
function requireSuper(actor: AdminActor): void {
  if (!isSuperActor(actor)) throw Object.assign(new Error('需要 owner 权限'), { statusCode: 403, code: 'OWNER_ONLY' });
}

function actorName(actor: AdminActor): string {
  return actor.kind === 'account' ? actor.username : actor.kind === 'master' ? '主密钥' : '管理员';
}

/** 只取 Fastify 按可信代理链解析出的 IP；绝不直接读客户端可伪造的 XFF 首段（同 auth.ts）。 */
function clientIp(req: FastifyRequest): string {
  return req.ip;
}

/* ── 路由 ───────────────────────────────────────────────────────────────── */

export async function adminInvitesRoutes(app: FastifyInstance) {
  // 与 admin.ts / adminReferral.ts 同一把闸：本插件内所有 /admin/invites/* 都要过 requireAdmin。
  app.addHook('preHandler', requireAdmin);

  /* ── ① 关系账本 ───────────────────────────────────────────────────────── */
  app.get<{ Querystring: { q?: string; source?: string; status?: string; tenantId?: string; days?: string; page?: string; pageSize?: string } }>(
    '/admin/invites',
    async (req): Promise<AdminInviteList> => {
      const at = now();
      const { page, pageSize, skip } = pageOf(req.query);
      const { where } = edgeWhere(req.query, at);
      const [total, rows] = await Promise.all([edgeCount(where), edgeRows(where, pageSize, skip)]);
      return { items: await toEdges(rows, at), total, page, pageSize };
    },
  );

  /* ── ② 归因日志 ───────────────────────────────────────────────────────── */
  app.get<{ Querystring: { q?: string; outcome?: string; source?: string; tenantId?: string; days?: string; page?: string; pageSize?: string } }>(
    '/admin/invites/attributions',
    async (req): Promise<AdminInviteAttributionList> => {
      const at = now();
      const { page, pageSize, skip } = pageOf(req.query);
      const q = textOf(req.query.q);
      const outcome = textOf(req.query.outcome, 32);
      const source = textOf(req.query.source, 32);
      const tenantId = tenantOf(req.query.tenantId);
      const days = daysOf(req.query.days);

      const conds: Prisma.Sql[] = [];
      if (outcome) conds.push(Prisma.sql`a."outcome" = ${outcome}`);
      if (source) conds.push(Prisma.sql`a."source" = ${source}`);
      if (tenantId) conds.push(Prisma.sql`a."tenantId" = ${tenantId}`);
      if (days) conds.push(Prisma.sql`a."createdAt" >= ${utcTimestamp(new Date(at.getTime() - days * DAY_MS))}`);
      if (q) {
        conds.push(qClauses(q, {
          code: Prisma.raw('a."inviteCode"'),
          ids: [Prisma.raw('a."newUserId"'), Prisma.raw('a."referrerId"')],
          users: [Prisma.raw('nu'), Prisma.raw('ru')],
        }));
      }
      const where = andAll(conds);

      const [countRows, rows] = await Promise.all([
        prisma.$queryRaw<{ n: bigint | number }[]>(Prisma.sql`SELECT COUNT(*) AS n ${ATTR_FROM} WHERE ${where}`),
        // **`a."userAgent"` 不在 SELECT 里，这是有意的**：设备指纹一旦下发就进了每个后台账号
        // 的浏览器。风控视图需要的是 IP 聚集，UA 从未被任何一屏使用过。
        prisma.$queryRaw<AttrRow[]>(Prisma.sql`
          SELECT a."id", a."inviteCode", a."source", a."outcome", a."newUserId", a."referrerId",
                 a."clientIp", a."tenantId", a."createdAt",
                 nu."name" AS "newName", nu."phone" AS "newPhone", nu."tenantId" AS "newTenantId",
                 ru."name" AS "refName", ru."phone" AS "refPhone", ru."tenantId" AS "refTenantId"
          ${ATTR_FROM}
          WHERE ${where}
          ORDER BY a."createdAt" DESC, a."id" DESC
          LIMIT ${pageSize} OFFSET ${skip}`),
      ]);

      return {
        items: rows.map((r): AdminInviteAttribution => ({
          id: r.id,
          inviteCode: r.inviteCode,
          source: r.source,
          outcome: r.outcome as ReferralBindingOutcome,
          newUser: r.newUserId ? person(r.newUserId, r.newName, r.newPhone, r.newTenantId ?? r.tenantId) : null,
          referrer: r.referrerId ? person(r.referrerId, r.refName, r.refPhone, r.refTenantId ?? r.tenantId) : null,
          clientIp: r.clientIp,
          tenantId: r.tenantId,
          createdAt: r.createdAt.toISOString(),
        })),
        total: Number(countRows[0]?.n ?? 0),
        page,
        pageSize,
      };
    },
  );

  /* ── ③ CSV 导出（super）────────────────────────────────────────────────
     筛选条件与列表**共用 `edgeWhere`**：导出与屏上所见必须是同一批行，否则运营拿导出去
     对账、发现比页面上多/少一批，就无法判断哪一边是真的。 */
  app.get<{ Querystring: { q?: string; source?: string; status?: string; tenantId?: string; days?: string } }>(
    '/admin/invites/export',
    async (req, reply) => {
      const actor = actorOf(req);
      try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
      const at = now();
      const { where, days } = edgeWhere(req.query, at);
      const rows = await edgeRows(where, EXPORT_ROW_CAP, 0);
      const edges = await toEdges(rows, at);

      // CSV/公式注入防护（照 /admin/payments/export）：用户昵称是自由文本，以 = + - @ 开头时
      // Excel/Numbers/Sheets 会把该格当公式执行。加一个前导单引号中和。
      const esc = (v: unknown) => {
        let s = String(v ?? '');
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return `"${s.replace(/"/g, '""')}"`;
      };
      const header = [
        '被邀人', '被邀人手机', '被邀人ID', '邀请人', '邀请人手机', '邀请人ID',
        '邀请码', '来源', '绑定时间', '开通状态', '首笔付费单号', '首笔付费(元)', '首笔付费时间', '首笔已退款', '邀请人是代理',
      ];
      const lines = edges.map((e) => [
        e.invitee.name ?? '', e.invitee.phone ?? '', e.invitee.userId,
        e.inviter.name ?? '', e.inviter.phone ?? '', e.inviter.userId,
        e.inviteCode, e.source, isoSecond(new Date(e.boundAt)),
        e.inviteeStatus === 'activated' ? '已开通' : '仅注册',
        e.firstPaid?.outTradeNo ?? '',
        e.firstPaid ? (e.firstPaid.amount / 100).toFixed(2) : '',
        e.firstPaid ? isoSecond(new Date(e.firstPaid.paidAt)) : '',
        e.firstPaid?.refunded ? '已退款' : '',
        e.inviterIsDistributor ? '是' : '',
      ].map(esc).join(','));

      await recordAudit({
        action: 'admin.invite.export',
        payload: { by: actorName(actor), days: days ?? null, rows: edges.length },
      });
      // BOM 前缀让 Excel 正确识别 UTF-8 中文。
      const csv = '﻿' + [header.map(esc).join(','), ...lines].join('\r\n');
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="invites-${days ?? 'all'}.csv"`)
        .send(csv);
    },
  );

  /* ── ④ 运营补绑（super）────────────────────────────────────────────────
     **关系不可变更公理不破**：只给尚无推荐人的用户建边，不提供改绑/解绑。
     判定与加锁全在 `services/referral.ts` 的 `bindManually`（同一份查环 + 同一把有序
     advisory lock），本处理器只做入参校验、回显与错误映射。 */
  app.post<{ Body: { userId?: unknown; inviteCode?: unknown; reason?: unknown } }>(
    '/admin/invites/manual-bind',
    async (req, reply): Promise<AdminManualBindResult | void> => {
      const actor = actorOf(req);
      try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
      const userId = textOf(req.body?.userId, 64);
      const inviteCode = textOf(req.body?.inviteCode, 64).toUpperCase();
      const reason = textOf(req.body?.reason, 200);
      if (!userId) return reply.code(400).send({ error: '缺少用户 id', code: 'USER_ID_REQUIRED' });
      // 原因必填：补绑是唯一能凭人工意志改动关系账本的动作，审计里没有「为什么」
      // 这条记录事后就无法判断它是修复还是操作失误。
      if (!reason) return reply.code(400).send({ error: '请填写补绑原因', code: 'REASON_REQUIRED' });
      // 码形状不合法照样走下去（`bindManually` 会落一条 unknown_code 留痕）——运营敲错码
      // 也应该在归因日志里看得见，静默 400 掉等于这次尝试没发生过。
      if (!inviteCode) return reply.code(400).send({ error: '缺少邀请码', code: 'INVITE_CODE_REQUIRED' });

      let result: { outcome: ReferralBindingOutcome; referrerId: string | null };
      try {
        result = await bindManually({
          userId, inviteCode, reason,
          operator: actorName(actor),
          clientIp: clientIp(req),
        });
      } catch (e) {
        if (e instanceof ReferralUserNotFound) return sendErr(reply, e, 404);
        throw e;
      }

      // bound 才回边；其余 outcome 的 edge 为 null，前端按人话展示 outcome（already_bound
      // 等按 warning，不是 error —— 那是业务结论，不是请求失败）。
      let edge: AdminInviteEdge | null = null;
      if (result.outcome === 'bound') {
        const rows = await edgeRows(Prisma.sql`r."userId" = ${userId}`, 1, 0);
        edge = (await toEdges(rows, now()))[0] ?? null;
      }
      return { outcome: result.outcome, edge };
    },
  );

  /* ── ⑤ 邀请链（以人为中心）──────────────────────────────────────────────
     三块内容各自回答一个问题：`upline` 这个人是被谁带进来的（沿 referrerId 递归到根，
     **不止三级**——物化路径只存三级，但运营排查一条链要看到顶）；`downline` 他带来了谁
     （三级子树，与 `/admin/referral/tree` **同一个构建函数**）；`team` 三级团队的量。 */
  app.get<{ Params: { userId: string }; Querystring: { days?: string } }>(
    '/admin/invites/chain/:userId',
    async (req, reply): Promise<AdminChainView | void> => {
      const userId = req.params.userId.trim();
      const at = now();
      const me = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, phone: true, tenantId: true, planId: true, planExpiresAt: true, inviteCode: true, createdAt: true },
      });
      // 用户不存在 → 404。**不回一个空链**：空链的意思是「这个人是根、没有下级」，
      // 与「你查的这个 id 不存在」是两件完全不同的事，混掉会让运营去排查一个不存在的人。
      if (!me) return reply.code(404).send({ error: '用户不存在', code: 'USER_NOT_FOUND' });

      const riskDays = clampDays(req.query.days);

      /* upline：沿 referrerId 一路向上。每跳一次一条主键 findUnique，hop 上限 64 —— 与
         `services/referral.ts` 的查环预算同值。撞到上限说明链异常长或**有环**（脏数据/
         历史补绑造成），此时 `uplineTruncated: true` 必须如实透出：这块屏是排查环的地方，
         悄悄截断等于把要找的东西藏起来。 */
      const hops: { userId: string; boundAt: Date; source: string }[] = [];
      let cursor: string | null = userId;
      let uplineTruncated = false;
      for (let hop = 0; hop < MAX_UPLINE_HOPS; hop++) {
        const row: { referrerId: string; boundAt: Date; source: string } | null = await prisma.referral.findUnique({
          where: { userId: cursor },
          select: { referrerId: true, boundAt: true, source: true },
        });
        if (!row) { cursor = null; break; }
        hops.push({ userId: row.referrerId, boundAt: row.boundAt, source: row.source });
        cursor = row.referrerId;
        // 环的自我保护：上溯撞回起点就停，别绕着环跑满 64 跳。
        if (cursor === userId) { uplineTruncated = true; cursor = null; break; }
      }
      if (cursor !== null) uplineTruncated = true;

      /* team：三级成员一次捞齐（`lv1/lv2/lv3` 各有索引），再各一次批量查开通状态与 GMV。
         逐级三次查询 ×（人数 / 开通 / GMV）= 9 次是 N+1 的另一种形态，这里压到 3 次。 */
      const memberRows = await prisma.referral.findMany({
        where: { OR: [{ lv1: userId }, { lv2: userId }, { lv3: userId }] },
        select: { userId: true, lv1: true, lv2: true, lv3: true },
      });
      const levelOf = (r: { lv1: string; lv2: string | null; lv3: string | null }): 1 | 2 | 3 | null => (
        r.lv1 === userId ? 1 : r.lv2 === userId ? 2 : r.lv3 === userId ? 3 : null
      );
      const membersByLevel = new Map<1 | 2 | 3, string[]>([[1, []], [2, []], [3, []]]);
      for (const r of memberRows) {
        const lv = levelOf(r);
        if (lv) membersByLevel.get(lv)!.push(r.userId);
      }
      const allMembers = [...new Set(memberRows.map((r) => r.userId))];

      const [memberUsers, gmvRows, edgeStats, { threshold }, brief, commission] = await Promise.all([
        allMembers.length === 0 ? Promise.resolve([]) : prisma.user.findMany({
          where: { id: { in: allMembers } },
          select: { id: true, planId: true, planExpiresAt: true },
        }),
        allMembers.length === 0 ? Promise.resolve([]) : prisma.paymentOrder.groupBy({
          by: ['userId'],
          // 已退款不计：GMV 问的是真金留下了多少。`refundedAt` 也判一次——退款流程中的单
          // 状态可能仍是 paid/applied 而 refundedAt 已落。
          where: { userId: { in: allMembers }, status: { in: GMV_STATUSES }, refundedAt: null },
          _sum: { amount: true },
        }),
        referralEdgeStats(null),
        riskThreshold(),
        distributorBrief(userId),
        commissionByLevel(userId),
      ]);
      const statusOf = new Map(memberUsers.map((u) => [u.id, planStatus(u, at)]));
      const gmvOf = new Map(gmvRows.map((r) => [r.userId, r._sum.amount ?? 0]));

      const team: AdminChainLevelStat[] = ([1, 2, 3] as const).map((level) => {
        const ids = membersByLevel.get(level) ?? [];
        return {
          level,
          users: ids.length,
          activated: ids.filter((id) => statusOf.get(id) === 'activated').length,
          paidGmv: ids.reduce((a, id) => a + (gmvOf.get(id) ?? 0), 0),
          // 非代理为 null（不适用），代理缺该级流水为 0。
          commission: commission ? (commission.get(level) ?? 0) : null,
        };
      });

      /* downline：与 `/admin/referral/tree` 共用 `buildReferralSubtrees`（roots=[本人]、
         rootLimit=1）。`days` 在这里同样**只管红环、不筛关系边**——关系永久，若让 days
         筛边，运营切到「7 天」时下钻树会几乎清空。tenantId 不筛：这是以人为中心的视图，
         他的下级本就都在他自己的租户树里。 */
      const { roots, truncated } = await buildReferralSubtrees({
        rootIds: [userId], tenantId: null, riskDays, threshold,
        directCountOf: edgeStats.directCountOf, at,
      });

      const uplineUsers = hops.length === 0 ? [] : await prisma.user.findMany({
        where: { id: { in: [...new Set(hops.map((h) => h.userId))] } },
        select: { id: true, name: true, phone: true, tenantId: true, planId: true, planExpiresAt: true },
      });
      const uplineById = new Map(uplineUsers.map((u) => [u.id, u]));
      const uplineDistributors = await activeDistributorIds(hops.map((h) => h.userId));

      return {
        user: {
          ...person(me.id, me.name, me.phone, me.tenantId),
          status: planStatus(me, at),
          inviteCode: me.inviteCode ?? null,
          createdAt: me.createdAt.toISOString(),
        },
        upline: hops.map((h, i): AdminChainAncestor => {
          const u = uplineById.get(h.userId);
          return {
            ...person(h.userId, u?.name ?? null, u?.phone ?? null, u?.tenantId ?? me.tenantId),
            depth: i + 1,
            status: planStatus(u, at),
            isDistributor: uplineDistributors.has(h.userId),
            boundAt: h.boundAt.toISOString(),
            source: h.source as ReferralSource,
          };
        }),
        uplineTruncated,
        downline: {
          tenantId: null,
          rootLimit: 1,
          inviterTotal: edgeStats.inviterTotal,
          edgeTotal: edgeStats.edgeTotal,
          riskWindowDays: riskDays,
          truncated,
          roots,
        },
        team,
        distributor: brief,
      };
    },
  );
}

