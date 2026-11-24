// 外部渠道代售军师套餐 → 军师到账（2026-11-23，声量AI 卖军师套餐）。
//
// 调用方：声量AI 后端（只此一家），`POST /api/s2s/plan-grants`。鉴权是「军师 → 声量AI」的镜像：
// 声量AI 后端用自己的机密客户端向账号中心换 client_credentials 机器令牌，军师验
// 签名 / iss / exp / aud（恰好一项）/ azp / scope / 机器令牌形态（sub=azp、无 amr）。
// 不认共享固定密钥，也不认用户令牌。
//
// 防重：`(source, orderNo)` 唯一。同一订单重复通知返回第一次的结果、绝不重复发额度；
// 同一订单号但内容（uid / planId / amount）不同 → 409 GRANT_ORDER_CONFLICT。
//
// 用户在军师还没有账号（账号中心 uid 未落到任何 User）：存 `pending`，返回 202。
// 军师账号键是手机号（User.phone NOT NULL），只有 uid 建不了号；他第一次带账号中心令牌进军师
// （attachIdentityUser 建档/绑定）或网页拉状态时，`claimPendingPlanGrants` 把挂着的订单逐笔开通。
//
// 会缩短现有权益的开通（目标档位低于当前有效档位、或当前不限期而目标限期）不自动执行：
// 记 `blocked`（同订单重试返回同一结论），交人工处理。升级/同档转换按运营后台手动开通同口径结转剩余天数。
//
// 退款：**暂不自动回收**。渠道退款后不会通知军师、军师也不撤销已发套餐与额度，走线下对账处理。
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../db.js';
import { now } from './clock.js';
import { applyPlanPurchase } from './purchase.js';
import { withEffectivePrice } from './planPricing.js';
import { planTierRank } from './planRules.js';
import { daysRemaining, isExpired } from './planTime.js';
import { bustPlanGate } from './planGate.js';
import { getQuotaState } from './tokenQuota.js';
import { lockIdentityUid } from './identityState.js';
import { bearerOf, verifyMachineToken } from './identity.js';

export const GRANT_SOURCES = ['studio'] as const;
export const PLAN_GRANT_SCOPE = 'junshi:plan.grant';

export class PlanGrantError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) { super(message); }
}

/** 机器令牌期望值。三项都必须配（或用默认），任何一项为空 → 整体关闭（fail-closed，503）。 */
export function planGrantCaller() {
  return {
    enabled: process.env.JUNSHI_PLAN_GRANT_ENABLED === 'true',
    audience: (process.env.JUNSHI_PLAN_GRANT_AUDIENCE ?? 'junshi-plan-grant').trim(),
    clientId: (process.env.JUNSHI_PLAN_GRANT_CLIENT_ID ?? 'aistar-junshi-grant').trim(),
    scope: PLAN_GRANT_SCOPE,
  };
}

/** 校验调用方；失败抛 PlanGrantError（401 未带/无效令牌，503 未开启）。 */
export async function authorizePlanGrantCaller(headers: Record<string, unknown>) {
  const caller = planGrantCaller();
  if (!caller.enabled || !caller.audience || !caller.clientId) {
    throw new PlanGrantError('套餐开通接口未开启', 503, 'PLAN_GRANT_DISABLED');
  }
  const bearer = bearerOf(headers);
  if (!bearer) throw new PlanGrantError('缺少服务令牌', 401, 'UNAUTHORIZED');
  const claims = await verifyMachineToken(bearer, caller);
  if (!claims) throw new PlanGrantError('服务令牌无效或权限不足', 401, 'UNAUTHORIZED');
  return claims;
}

export const grantRequestSchema = z.object({
  orderNo: z.string().trim().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'orderNo 只能是 1-64 位字母、数字或 _ . : -'),
  identityUid: z.string().trim().min(1).max(128),
  planId: z.string().trim().min(1).max(64),
  source: z.enum(GRANT_SOURCES),
  amount: z.number().int().min(0).max(100_000_000),
});
export type GrantRequest = z.infer<typeof grantRequestSchema>;

export function grantRequestHash(input: GrantRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([input.source, input.orderNo, input.identityUid, input.planId, input.amount]))
    .digest('hex');
}

type GrantRow = Prisma.ExternalPlanGrantGetPayload<object>;

interface AppliedFacts {
  planId: string; planName: string; period: string;
  planExpiresAt: string | null; grantedCredits: number; grantedTokens: number;
  carriedDays: number; renewal: boolean;
  /** 先挂起（用户当时还没有军师账号）、后到账。老记录没有这个字段按 false。 */
  pendingFirst?: boolean;
}
interface BlockedFacts { code: string; message: string; currentPlanId?: string | null; currentPlanName?: string | null }

/** 对外视图。`tokenQuota` 是**此刻**的对话额度（读时现算），其余是开通那一刻冻结的事实。 */
export async function grantView(row: GrantRow) {
  const facts = (row.resultJson ?? null) as (AppliedFacts & BlockedFacts) | null;
  const base = {
    grantId: row.id,
    source: row.source,
    orderNo: row.orderNo,
    identityUid: row.identityUid,
    planId: row.planId,
    amount: row.amount,
    status: row.status as 'pending' | 'applied' | 'blocked',
    createdAt: row.createdAt.toISOString(),
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
  };
  if (row.status === 'applied' && facts && row.userId) {
    const quota = await getQuotaState(row.userId);
    return {
      ...base,
      plan: { id: facts.planId, name: facts.planName, period: facts.period },
      planExpiresAt: facts.planExpiresAt,
      grantedCredits: facts.grantedCredits,
      grantedTokens: facts.grantedTokens,
      carriedDays: facts.carriedDays,
      renewal: facts.renewal,
      tokenQuota: { limit: quota.quota, remaining: quota.balance, used: quota.used, unlimited: quota.unlimited, packRemaining: quota.packBalance },
    };
  }
  if (row.status === 'blocked' && facts) {
    return { ...base, blocked: { code: facts.code, message: facts.message, currentPlanId: facts.currentPlanId ?? null, currentPlanName: facts.currentPlanName ?? null } };
  }
  return base;
}

async function loadSellablePlan(tx: Prisma.TransactionClient, planId: string) {
  const plan = await tx.plan.findUnique({ where: { id: planId } });
  // 只卖正价限期档：免费层（price=0）不需要代售，面议/私有化（price<0）不允许自助开通。
  if (!plan || plan.price <= 0) throw new PlanGrantError('套餐不存在或不可代售', 422, 'PLAN_NOT_SELLABLE');
  return withEffectivePrice(plan);
}

/**
 * 在已持有 `identity:<uid>` 锁的事务里，把一笔 grant 落到用户身上。返回最新行。
 * 会缩短现有权益 → 记 blocked，不改用户。
 */
async function applyGrantInTx(
  tx: Prisma.TransactionClient,
  grant: GrantRow,
  user: { id: string; tenantId: string },
  pendingFirst = false,
): Promise<GrantRow> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entitlement:${user.id}`}))`;
  const plan = await loadSellablePlan(tx, grant.planId);
  const current = await tx.user.findUnique({
    where: { id: user.id },
    select: { planId: true, planExpiresAt: true, plan: { select: { id: true, name: true, price: true, period: true, planFamilyKey: true, tierRank: true } } },
  });
  const at = now();
  const cur = current?.plan ?? null;
  // 与运营后台 POST /admin/users/:id/plan 同口径（admin.ts）：只有「付费未过期的另一档」才需要保护。
  const protectable = !!cur && cur.price !== 0 && !isExpired(current!.planExpiresAt, at) && cur.id !== plan.id;
  const remaining = daysRemaining(current?.planExpiresAt, at);
  const shortens = protectable && (planTierRank(plan) < planTierRank(cur!) || remaining === null);
  if (shortens) {
    const facts: BlockedFacts = {
      code: 'PLAN_CHANGE_SHORTENS',
      message: remaining === null
        ? `用户当前是不限期方案「${cur!.name}」，开通「${plan.name}」会变成限期方案，需人工处理`
        : `用户当前「${cur!.name}」档位高于「${plan.name}」，开通会损失剩余 ${remaining} 天，需人工处理`,
      currentPlanId: cur!.id, currentPlanName: cur!.name,
    };
    return tx.externalPlanGrant.update({
      where: { id: grant.id },
      data: { status: 'blocked', userId: user.id, tenantId: user.tenantId, resultJson: facts as unknown as Prisma.InputJsonValue },
    });
  }
  const carriedDays = protectable && remaining !== null && remaining > 0 ? remaining : 0;
  const purchase = await applyPlanPurchase(user, plan, {
    reason: `${plan.name} · 声量AI 开通`,
    source: `external_${grant.source}`,
    // 权益账本用 grant.id 作来源单号：与微信支付订单分属两套号段，`studio:` 前缀防撞。
    order: { id: grant.id, outTradeNo: `${grant.source}:${grant.orderNo}`, amount: grant.amount, termsHash: null },
  }, tx);
  let expiresAt = purchase.expiresAt;
  if (carriedDays > 0 && expiresAt) {
    expiresAt = new Date(expiresAt.getTime() + carriedDays * 864e5);
    await tx.user.update({ where: { id: user.id }, data: { planExpiresAt: expiresAt } });
  }
  const facts: AppliedFacts = {
    planId: plan.id, planName: plan.name, period: plan.period,
    planExpiresAt: expiresAt ? expiresAt.toISOString() : null,
    grantedCredits: purchase.grantedCredits, grantedTokens: purchase.grantedTokens,
    carriedDays, renewal: !!cur && cur.id === plan.id && !isExpired(current!.planExpiresAt, at),
    pendingFirst,
  };
  await tx.auditLog.create({
    data: {
      tenantId: user.tenantId, userId: user.id, action: 'external.plan.grant',
      payloadJson: { source: grant.source, orderNo: grant.orderNo, grantId: grant.id, amount: grant.amount, ...facts } as unknown as Prisma.InputJsonValue,
    },
  });
  return tx.externalPlanGrant.update({
    where: { id: grant.id },
    data: { status: 'applied', userId: user.id, tenantId: user.tenantId, appliedAt: at, resultJson: facts as unknown as Prisma.InputJsonValue },
  });
}

async function liveUserByUid(tx: Prisma.TransactionClient, uid: string) {
  return tx.user.findUnique({ where: { identityUid: uid }, select: { id: true, tenantId: true, deletedAt: true } });
}

function isUniqueConflict(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * 开通（或重放）一笔外部订单。返回 `{ row, created }`；`row.status` 决定 HTTP 码（applied 200 / pending 202 / blocked 409）。
 */
export async function createOrReplayPlanGrant(input: GrantRequest): Promise<{ row: GrantRow; replay: boolean }> {
  const requestHash = grantRequestHash(input);
  const run = () => prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`extgrant:${input.source}:${input.orderNo}`}))`;
    const existing = await tx.externalPlanGrant.findUnique({ where: { source_orderNo: { source: input.source, orderNo: input.orderNo } } });
    if (existing && existing.requestHash !== requestHash) {
      throw new PlanGrantError('同一订单号已用不同内容开通过', 409, 'GRANT_ORDER_CONFLICT');
    }
    await lockIdentityUid(tx, input.identityUid);
    // 账号中心已停用/合并的 uid：不开通、不落库（渠道应走退款），与登录侧同一判定。
    const subject = await tx.identitySubject.findUnique({ where: { uid: input.identityUid } });
    if (subject && subject.status !== 'ACTIVE') throw new PlanGrantError('该账号已停用', 422, 'IDENTITY_ACCOUNT_DISABLED');
    if (existing) {
      if (existing.status !== 'pending') return { row: existing, replay: true };
      const user = await liveUserByUid(tx, input.identityUid);
      return { row: user && !user.deletedAt ? await applyGrantInTx(tx, existing, user, true) : existing, replay: true };
    }
    // 订单号之外再挡一次「未开通前就打来的不可售套餐」，免得先落一条永远领不走的 pending。
    await loadSellablePlan(tx, input.planId);
    const user = await liveUserByUid(tx, input.identityUid);
    if (user?.deletedAt) throw new PlanGrantError('该用户已注销军师账号', 422, 'USER_DELETED');
    const row = await tx.externalPlanGrant.create({
      data: { ...input, requestHash, status: 'pending' },
    });
    return { row: user ? await applyGrantInTx(tx, row, user) : row, replay: false };
  });
  let result: { row: GrantRow; replay: boolean };
  try {
    result = await run();
  } catch (error) {
    // 极端并发下 advisory 锁之外的唯一键兜底：重读一次按重放处理。
    if (!isUniqueConflict(error)) throw error;
    result = await run();
  }
  if (result.row.userId) bustPlanGate(result.row.userId);
  return result;
}

export async function findPlanGrant(source: string, orderNo: string) {
  return prisma.externalPlanGrant.findUnique({ where: { source_orderNo: { source, orderNo } } });
}

/**
 * 领取挂在 uid 上的 pending 订单（建档/绑定之后、网页拉状态时调用）。best-effort：调用方吞错。
 * 返回本次新开通的笔数。
 */
export async function claimPendingPlanGrants(uid: string): Promise<number> {
  const pending = await prisma.externalPlanGrant.findMany({
    where: { identityUid: uid, status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { id: true },
  });
  let applied = 0;
  for (const { id } of pending) {
    const row = await prisma.$transaction(async (tx) => {
      await lockIdentityUid(tx, uid);
      const grant = await tx.externalPlanGrant.findUnique({ where: { id } });
      if (!grant || grant.status !== 'pending') return null;
      const user = await liveUserByUid(tx, uid);
      if (!user || user.deletedAt) return null;
      return applyGrantInTx(tx, grant, user, true);
    });
    if (row?.userId) bustPlanGate(row.userId);
    if (row?.status === 'applied') applied += 1;
  }
  return applied;
}

/** 有没有挂着的单（attachIdentityUser 每个 Bearer 请求问一次，走 (identityUid,status) 索引）。 */
export async function hasPendingPlanGrant(uid: string): Promise<boolean> {
  return !!await prisma.externalPlanGrant.findFirst({ where: { identityUid: uid, status: 'pending' }, select: { id: true } });
}
