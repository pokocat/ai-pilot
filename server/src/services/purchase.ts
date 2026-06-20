// 套餐权益发放（被「演示购买」与「微信支付回调」共用，保证两条路径口径一致）。
// 发放 = 切换套餐 + 叠加钻石(点)流水 + 覆盖式授予当月 token 额度。
import { prisma } from '../db.js';
import { getBalance } from './credits.js';
import { setQuota } from './tokenQuota.js';
import { recordAudit } from './audit.js';

export interface PlanLike {
  id: string; name: string; creditsPerMonth: number; tokenQuotaPerMonth: number;
}

export interface GrantResult { creditBalance: number; grantedCredits: number; grantedTokens: number; }

/**
 * 发放某套餐权益给用户。reason 进流水/审计；source 标记来源（demo_purchase | wechat_pay）。
 * 计算与原 /plans/:id/purchase 完全一致：不限量(creditsPerMonth<0) → 余额记 -1、不叠加。
 */
export async function applyPlanPurchase(
  user: { id: string; tenantId: string },
  plan: PlanLike,
  opts: { reason: string; source: string },
): Promise<GrantResult> {
  const before = await getBalance(user.id);
  const unlimited = plan.creditsPerMonth < 0;
  const grantedCredits = unlimited ? 0 : plan.creditsPerMonth;
  const creditBalance = unlimited ? -1 : (before < 0 ? grantedCredits : before + grantedCredits);

  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { planId: plan.id } }),
    prisma.creditLedger.create({
      data: { tenantId: user.tenantId, userId: user.id, delta: grantedCredits, reason: opts.reason, balance: creditBalance },
    }),
  ]);
  await setQuota(user.tenantId, user.id, plan.tokenQuotaPerMonth);
  await recordAudit({
    tenantId: user.tenantId,
    userId: user.id,
    action: 'user.plan.purchase',
    payload: { planId: plan.id, planName: plan.name, grantedCredits, creditBalance, grantedTokens: plan.tokenQuotaPerMonth, source: opts.source },
  });
  return { creditBalance, grantedCredits, grantedTokens: plan.tokenQuotaPerMonth };
}
