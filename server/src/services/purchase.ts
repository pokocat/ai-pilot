// 套餐权益发放（被「演示购买」与「微信支付回调」共用，保证两条路径口径一致）。
// 发放 = 切换套餐 + 写有效期(D1/D2) + 叠加钻石(点)流水 + 覆盖式授予当月 token 额度。
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { grantCredits } from './credits.js';
import { setQuota } from './tokenQuota.js';
import { now } from './clock.js';
import { computeExpiry, renewExpiry } from './planTime.js';

export interface PlanLike {
  id: string; name: string; price: number; period: string; creditsPerMonth: number; tokenQuotaPerMonth: number;
}

export interface GrantResult { creditBalance: number; grantedCredits: number; grantedTokens: number; expiresAt: Date | null; }

/**
 * 发放某套餐权益给用户。reason 进流水/审计；source 标记来源（demo_purchase | wechat_pay | wechat_pay_sandbox）。
 * 有效期（D1/D2）：
 *   - noExpiry = 免费层(price=0) / 企业版私有化(price<0) → planExpiresAt=null（永久/合约，不自动到期）。
 *   - 续费（同套餐且未过期）→ 叠加时长、保留原锚点 activatedAt；其余（新购/升级/过期重购）→ 锚点重置到现在。
 *   - planExpiresAt 用月历加法 + 月末漂移 clamp（computeExpiry）；不限量/已用量不参与（用量不 proration）。
 * setQuota 传入 activatedAt 对齐月度额度的锚点子周期键，保证额度重置日与套餐锚点一致。
 */
export async function applyPlanPurchase(
  user: { id: string; tenantId: string },
  plan: PlanLike,
  opts: { reason: string; source: string },
  db?: Prisma.TransactionClient,
): Promise<GrantResult> {
  const unlimited = plan.creditsPerMonth < 0;
  const grantedCredits = unlimited ? 0 : plan.creditsPerMonth;
  const at = now();

  const apply = async (tx: Prisma.TransactionClient): Promise<GrantResult> => {
    const noExpiry = plan.price <= 0; // 免费层 / 企业版私有化：不设到期
    const prev = await tx.user.findUnique({
      where: { id: user.id },
      select: { planId: true, planActivatedAt: true, planExpiresAt: true },
    });
    const isRenewal = !noExpiry && prev?.planId === plan.id && !!prev.planExpiresAt && prev.planExpiresAt.getTime() > at.getTime();
    const activatedAt = isRenewal ? (prev!.planActivatedAt ?? at) : at;
    // 续费：从激活锚点重派生到期（renewExpiry，防月末 clamp 漂移、与额度锚点链对齐）；新购/升级：from now。
    const expiresAt = noExpiry ? null : (isRenewal ? renewExpiry(activatedAt, prev!.planExpiresAt!, plan.period) : computeExpiry(at, plan.period));

    await tx.user.update({
      where: { id: user.id },
      data: { planId: plan.id, planActivatedAt: activatedAt, planExpiresAt: expiresAt },
    });
    const creditBalance = await grantCredits(user.tenantId, user.id, plan.creditsPerMonth, opts.reason, tx);
    await setQuota(user.tenantId, user.id, plan.tokenQuotaPerMonth, activatedAt, tx);
    await tx.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'user.plan.purchase',
        payloadJson: {
          planId: plan.id, planName: plan.name, grantedCredits, creditBalance,
          grantedTokens: plan.tokenQuotaPerMonth, source: opts.source,
          renewal: isRenewal,
          planActivatedAt: activatedAt.toISOString(),
          planExpiresAt: expiresAt ? expiresAt.toISOString() : null,
        },
      },
    }).catch(() => {});
    return { creditBalance, grantedCredits, grantedTokens: plan.tokenQuotaPerMonth, expiresAt };
  };
  return db ? apply(db) : prisma.$transaction((tx) => apply(tx));
}
