// 套餐权益发放（被「演示购买」与「微信支付回调」共用，保证两条路径口径一致）。
// 发放 = 切换套餐 + 叠加钻石(点)流水 + 覆盖式授予当月 token 额度。
import { prisma } from '../db.js';
import { setQuota } from './tokenQuota.js';
import type { Prisma } from '@prisma/client';

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
  db?: Prisma.TransactionClient,
): Promise<GrantResult> {
  const client = db ?? prisma;
  const last = await client.creditLedger.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
  const before = last?.balance ?? 0;
  const unlimited = plan.creditsPerMonth < 0;
  const grantedCredits = unlimited ? 0 : plan.creditsPerMonth;
  const creditBalance = unlimited ? -1 : (before < 0 ? grantedCredits : before + grantedCredits);

  const apply = async (tx: Prisma.TransactionClient) => {
    await tx.user.update({ where: { id: user.id }, data: { planId: plan.id } });
    await tx.creditLedger.create({
      data: { tenantId: user.tenantId, userId: user.id, delta: grantedCredits, reason: opts.reason, balance: creditBalance },
    });
    await setQuota(user.tenantId, user.id, plan.tokenQuotaPerMonth, tx);
    await tx.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'user.plan.purchase',
        payloadJson: { planId: plan.id, planName: plan.name, grantedCredits, creditBalance, grantedTokens: plan.tokenQuotaPerMonth, source: opts.source },
      },
    }).catch(() => {});
  };
  if (db) await apply(db);
  else await prisma.$transaction((tx) => apply(tx));
  return { creditBalance, grantedCredits, grantedTokens: plan.tokenQuotaPerMonth };
}
