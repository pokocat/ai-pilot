import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { PlanPromotion, PlanQuote, PlanRelation } from '../../../shared/contracts';
import { prisma } from '../db.js';
import { now } from './clock.js';
import { computeExpiry, daysRemaining, isExpired, renewExpiry } from './planTime.js';
import { planFamilyKey, planTierRank, publicUsageLabel, publicUsageLevel, type PlanRuleFields } from './planRules.js';
import { withEffectivePrice, type PlanPricingFields } from './planPricing.js';

/** 传进来的 plan **必须已过 withEffectivePrice()**：这里的 price 一律按「此刻的成交价」参与
 *  报价、条款哈希与账本快照。挂牌价不进钱的链路，否则优惠期会按原价折抵/记账。 */
export interface CommercialPlan extends PlanRuleFields, PlanPricingFields {
  name: string;
  creditsPerMonth: number;
  tokenQuotaPerMonth: number;
  agentCount: number;
  featuresJson: unknown;
  highlighted: boolean;
  /** withEffectivePrice() 算好的折扣展示对象，原样透传给用户侧——**不要在下游重算**：
   *  这里的 price 已是成交价，再算一次会判成「无优惠」。 */
  promotion?: PlanPromotion | null;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashTerms(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export function commercialTerms(plan: CommercialPlan) {
  return {
    id: plan.id, name: plan.name, price: plan.price, period: plan.period,
    planFamilyKey: planFamilyKey(plan), tierRank: planTierRank(plan),
    usageLevel: publicUsageLevel(plan), usageLabel: publicUsageLabel(plan),
    creditsPerMonth: plan.creditsPerMonth, tokenQuotaPerMonth: plan.tokenQuotaPerMonth,
    agentCount: plan.agentCount,
    featuresJson: Array.isArray(plan.featuresJson) ? plan.featuresJson.map(String) : [],
  };
}

function publicPlan(plan: CommercialPlan) {
  return { ...commercialTerms(plan), highlighted: plan.highlighted, autoRenewAvailable: false, promotion: plan.promotion ?? null };
}

function relationOf(current: CommercialPlan | null, target: CommercialPlan, active: boolean): PlanRelation {
  // 隐藏 1 分支付测试档仅对白名单可达；保持历史语义，不让真实在册套餐把内部链路验证拦成降档。
  if (target.hidden && target.price > 0) return 'available';
  if (target.price < 0) return 'enterprise';
  if (!current || !active) return current?.id === target.id ? 'current' : 'available';
  if (current.id === target.id) return 'renew';
  const oldTier = planTierRank(current);
  const newTier = planTierRank(target);
  if (planFamilyKey(current) === planFamilyKey(target) && oldTier === newTier && current.period === 'month' && target.period === 'year') return 'billing_change';
  if (newTier > oldTier) return 'upgrade';
  return 'downgrade';
}

function ledgerRemainingValue(rows: { listPrice: number; creditedAmount: number; startsAt: Date; expiresAt: Date | null }[], at: Date): number {
  return rows.reduce((sum, row) => {
    const available = Math.max(0, row.listPrice - row.creditedAmount);
    if (available <= 0 || !row.expiresAt || row.expiresAt <= at) return sum;
    if (row.startsAt >= at) return sum + available;
    const totalMs = row.expiresAt.getTime() - row.startsAt.getTime();
    if (totalMs <= 0) return sum;
    return sum + Math.round(available * Math.min(1, (row.expiresAt.getTime() - at.getTime()) / totalMs));
  }, 0);
}

export async function quotePlanChange(userId: string, target: CommercialPlan): Promise<PlanQuote> {
  const at = now();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { planActivatedAt: true, planExpiresAt: true, plan: true },
  });
  // 在册档同样按此刻的成交价解析：升级折抵、月付转年付的差价都要用同一把尺子。
  const current = user?.plan ? withEffectivePrice(user.plan, at) : null;
  const active = !!current && !isExpired(user?.planExpiresAt, at);
  const relation = relationOf(current, target, active);
  if (relation === 'downgrade' || relation === 'enterprise') {
    throw Object.assign(new Error(relation === 'enterprise' ? '企业方案请联系顾问' : '当前方案到期后可购买'), { code: 'PLAN_SWITCH_BLOCKED', statusCode: 409 });
  }

  let remainingValue = 0;
  let remaining = 0;
  let sourceVersion: unknown = null;
  if ((relation === 'upgrade' || relation === 'billing_change') && current) {
    const rows = await prisma.planEntitlement.findMany({
      where: { userId, status: 'active', planId: current.id, OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
      orderBy: { startsAt: 'asc' },
    });
    if (rows.length) {
      remainingValue = ledgerRemainingValue(rows, at);
      sourceVersion = rows.map((row) => ({ id: row.id, updatedAt: row.updatedAt.toISOString(), available: row.listPrice - row.creditedAmount }));
    } else {
      // 存量用户尚无账本时只在迁移窗口回退一次旧口径；首笔新订单落账后不再使用价格猜测。
      // （这条路径按「当前成交价」猜历史付款额，只对账本上线前的存量用户生效；带优惠的档
      //  一定是新建档、每笔购买都有账本行，走不到这里。）
      const days = daysRemaining(user?.planExpiresAt, at) ?? 0;
      const nominal = current.period === 'year' ? 365 : 30;
      remainingValue = Math.min(current.price, Math.round((current.price / nominal) * days));
      sourceVersion = { legacyPlanId: current.id, price: current.price, expiresAt: user?.planExpiresAt?.toISOString() ?? null };
    }
    remaining = daysRemaining(user?.planExpiresAt, at) ?? 0;
  }
  remainingValue = Math.min(Math.max(0, remainingValue), Math.max(0, target.price));
  const chargeAmount = Math.max(0, target.price - remainingValue);
  const newExpiresAt = relation === 'renew' && user?.planExpiresAt
    ? renewExpiry(user.planActivatedAt ?? at, user.planExpiresAt, target.period)
    : target.price <= 0 ? null : computeExpiry(at, target.period);
  const targetTerms = commercialTerms(target);
  const fingerprintPayload = {
    userId, relation, targetTerms, sourceVersion,
    fullPrice: target.price, remainingValue, chargeAmount,
  };
  const quoteFingerprint = hashTerms(fingerprintPayload);
  // 报价短时有效；下单仍会完整重算，因此这是 UX 过期时间，不是安全边界。
  const expiresAt = new Date(at.getTime() + 10 * 60_000);
  return {
    allowed: true,
    currentPlan: current ? publicPlan(current) : null,
    targetPlan: publicPlan(target), relation,
    fullPrice: target.price, remainingDays: remaining, remainingValue, chargeAmount,
    effectiveAt: at.toISOString(), newExpiresAt: newExpiresAt?.toISOString() ?? null,
    expiresAt: expiresAt.toISOString(), quoteFingerprint,
  };
}

export interface EntitlementOrderSource {
  id: string;
  outTradeNo: string;
  amount: number;
  termsHash: string | null;
  quote?: { remainingValue?: number } | null;
}

/** 在发放权益的同一事务里写账本，并把被升级替代的来源行关联到本订单。 */
export async function recordPlanEntitlement(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string; userId: string; plan: CommercialPlan;
    startsAt: Date; expiresAt: Date | null; anchorAt: Date;
    previousPlanId?: string | null; order?: EntitlementOrderSource;
  },
): Promise<void> {
  if (args.order && args.previousPlanId && args.previousPlanId !== args.plan.id) {
    const prior = await tx.planEntitlement.findMany({ where: { userId: args.userId, planId: args.previousPlanId, status: 'active' } });
    let creditLeft = Math.max(0, args.order.quote?.remainingValue ?? 0);
    for (const row of prior) {
      const applied = Math.min(Math.max(0, row.listPrice - row.creditedAmount), creditLeft);
      creditLeft -= applied;
      await tx.planEntitlement.update({
        where: { id: row.id },
        data: { status: 'superseded', supersededByOrderId: args.order.id, creditedAmount: row.creditedAmount + applied },
      });
    }
  }
  const terms = commercialTerms(args.plan);
  const termsHash = args.order?.termsHash || hashTerms(terms);
  const data = {
    tenantId: args.tenantId, userId: args.userId, planId: args.plan.id,
    sourceOrderId: args.order?.id, sourceOutTradeNo: args.order?.outTradeNo,
    planFamilyKey: planFamilyKey(args.plan), tierRank: planTierRank(args.plan), period: args.plan.period,
    // listPrice = 购买时的**成交价**快照（优惠期内就是优惠价），不是挂牌价：
    // ledgerRemainingValue 按它折算升级抵扣，写挂牌价会让 ¥3980 买的档抵掉 ¥39800。
    listPrice: args.plan.price, paidAmount: args.order?.amount ?? 0,
    startsAt: args.startsAt, expiresAt: args.expiresAt, anchorAt: args.anchorAt,
    termsHash,
  };
  if (args.order) {
    await tx.planEntitlement.upsert({ where: { sourceOrderId: args.order.id }, update: {}, create: data });
  } else {
    await tx.planEntitlement.create({ data });
  }
}

/** 退款成功后只撤对应来源订单，并从剩余未退款账本重算当前方案与有效期。 */
export async function revokePlanEntitlement(
  tx: Prisma.TransactionClient,
  args: { orderId: string; userId: string },
): Promise<{ handled: boolean; creditsToRevoke: number }> {
  const entitlement = await tx.planEntitlement.findUnique({ where: { sourceOrderId: args.orderId } });
  if (!entitlement) return { handled: false, creditsToRevoke: 0 };
  await tx.planEntitlement.update({
    where: { id: entitlement.id },
    data: { status: 'refunded', refundedAt: now() },
  });
  await tx.planEntitlement.updateMany({
    where: { userId: args.userId, supersededByOrderId: args.orderId, status: 'superseded' },
    data: { status: 'active', supersededByOrderId: null, creditedAmount: 0 },
  });
  const at = now();
  const active = await tx.planEntitlement.findMany({
    where: { userId: args.userId, status: 'active', OR: [{ expiresAt: null }, { expiresAt: { gt: at } }] },
    orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }],
  });
  const current = active.find((row) => row.startsAt <= at) ?? active[0] ?? null;
  if (!current) {
    await tx.user.update({ where: { id: args.userId }, data: { planId: null, planActivatedAt: null, planExpiresAt: at } });
    await tx.tokenWallet.updateMany({ where: { userId: args.userId }, data: { quota: 0, balance: 0 } });
  } else {
    const samePlan = active.filter((row) => row.planId === current.planId);
    const expiresAt = samePlan.some((row) => row.expiresAt === null)
      ? null
      : samePlan.reduce<Date | null>((max, row) => !max || (row.expiresAt && row.expiresAt > max) ? row.expiresAt : max, null);
    await tx.user.update({ where: { id: args.userId }, data: { planId: current.planId, planActivatedAt: current.anchorAt, planExpiresAt: expiresAt } });
    const plan = await tx.plan.findUnique({ where: { id: current.planId }, select: { tokenQuotaPerMonth: true } });
    const wallet = await tx.tokenWallet.findUnique({ where: { userId: args.userId } });
    if (plan && wallet) {
      const used = wallet.quota < 0 ? 0 : Math.max(0, wallet.quota - wallet.balance);
      const quota = plan.tokenQuotaPerMonth;
      await tx.tokenWallet.update({ where: { userId: args.userId }, data: { quota, balance: quota < 0 ? -1 : quota - used } });
    }
  }
  const grants = await tx.monthlyCreditGrant.findMany({ where: { userId: args.userId, sourceOrderId: args.orderId } });
  return { handled: true, creditsToRevoke: grants.reduce((sum, row) => sum + Math.max(0, row.amount), 0) };
}
