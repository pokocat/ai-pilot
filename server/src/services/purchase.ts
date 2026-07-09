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
  const at = now();

  const apply = async (tx: Prisma.TransactionClient): Promise<GrantResult> => {
    const noExpiry = plan.price <= 0; // 免费层 / 企业版私有化：不设到期
    const prev = await tx.user.findUnique({
      where: { id: user.id },
      select: { planId: true, planActivatedAt: true, planExpiresAt: true },
    });
    const isRenewal = !noExpiry && prev?.planId === plan.id && !!prev.planExpiresAt && prev.planExpiresAt.getTime() > at.getTime();
    // 防刷：免费/永久套餐(noExpiry)已在该套餐上时，重复"购买"不再发钻石（钻石是累加流水，且免费路径无支付幂等键兜底；
    // 付费套餐的重复发放由支付层 outTradeNo 幂等防住）。月度额度由锚点重置链单独发放，不依赖此处重复点击。
    const skipFreeRegrant = noExpiry && prev?.planId === plan.id;
    // 实际发放额：保留负数=不限量语义（企业版）；防刷跳过时为 0（grantCredits 对 0 是无操作）。
    const creditGrantAmount = skipFreeRegrant ? 0 : plan.creditsPerMonth;
    // 展示/审计额：不限量与跳过均记 0。
    const grantedCredits = unlimited || skipFreeRegrant ? 0 : plan.creditsPerMonth;
    const activatedAt = isRenewal ? (prev!.planActivatedAt ?? at) : at;
    // 续费：从激活锚点重派生到期（renewExpiry，防月末 clamp 漂移、与额度锚点链对齐）；新购/升级：from now。
    const expiresAt = noExpiry ? null : (isRenewal ? renewExpiry(activatedAt, prev!.planExpiresAt!, plan.period) : computeExpiry(at, plan.period));

    await tx.user.update({
      where: { id: user.id },
      data: { planId: plan.id, planActivatedAt: activatedAt, planExpiresAt: expiresAt },
    });
    const creditBalance = await grantCredits(user.tenantId, user.id, creditGrantAmount, opts.reason, tx);
    // skipFreeRegrant 同样必须挡住 token 额度覆盖式授予：setQuota 是硬覆盖 balance=quota（见 tokenQuota.ts），
    // 与"月度额度由锚点重置链单独发放"这句注释描述的惰性重置是两条独立路径——不挡住这里会让重复点击
    // 免费套餐的"购买"把已用尽的 token 额度刷回满额，形成与钻石防刷同源但未被堵上的刷额度口子。
    if (!skipFreeRegrant) await setQuota(user.tenantId, user.id, plan.tokenQuotaPerMonth, activatedAt, tx);
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

export interface SkuLike {
  key: string; name: string; kind: string; grantsModuleKey: string | null; metaJson: unknown;
}

/**
 * V7-12：发放单次付费商品（SKU）权益。由 markPaidAndApply 在幂等事务内调用（appliedAt 锚点保证恰好一次）。
 *   - module   → upsert UserModule(grantsModuleKey, source='purchase') 启用能力。
 *   - service  → 记一次性服务凭据 UserModule(moduleKey='sku:'+key)（如深度整理，后续核销）。
 *   - storage  → Profile.extraJson.storageBonus 累加 metaJson.bytes（免加列）。
 * 另写一条 delta=0 的 CreditLedger 备注行，让订单流水页零改造即可见（方案 V7-12 §前端2）。
 */
export async function applySkuGrant(
  user: { id: string; tenantId: string },
  sku: SkuLike,
  opts: { reason: string; source: string },
  tx: Prisma.TransactionClient,
): Promise<void> {
  if (sku.kind === 'module' && sku.grantsModuleKey) {
    await tx.userModule.upsert({
      where: { userId_moduleKey: { userId: user.id, moduleKey: sku.grantsModuleKey } },
      update: { enabled: true, hidden: false, source: 'purchase' },
      create: { tenantId: user.tenantId, userId: user.id, moduleKey: sku.grantsModuleKey, enabled: true, source: 'purchase' },
    });
  } else if (sku.kind === 'storage') {
    const bytes = Number((sku.metaJson as { bytes?: number } | null)?.bytes ?? 0);
    const profile = await tx.profile.findFirst({ where: { tenantId: user.tenantId }, orderBy: { updatedAt: 'desc' } });
    const extra = (profile?.extraJson as Record<string, unknown> | null) ?? {};
    const bonus = Number(extra.storageBonus ?? 0) + bytes;
    if (profile) await tx.profile.update({ where: { id: profile.id }, data: { extraJson: { ...extra, storageBonus: bonus } as Prisma.InputJsonValue } });
    else await tx.profile.create({ data: { tenantId: user.tenantId, extraJson: { storageBonus: bonus } as Prisma.InputJsonValue } });
  } else {
    // service（一次性服务，如深度整理）：记已购凭据，后续 organize 核销。
    await tx.userModule.upsert({
      where: { userId_moduleKey: { userId: user.id, moduleKey: `sku:${sku.key}` } },
      update: { enabled: true, source: 'purchase' },
      create: { tenantId: user.tenantId, userId: user.id, moduleKey: `sku:${sku.key}`, enabled: true, source: 'purchase' },
    });
  }
  // 备注型 0 额流水（订单流水页复用 CreditLedger，不加新端点）。
  const last = await tx.creditLedger.findFirst({ where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  await tx.creditLedger.create({
    data: { tenantId: user.tenantId, userId: user.id, delta: 0, reason: opts.reason, balance: last?.balance ?? 0 },
  }).catch(() => {});
  await tx.auditLog.create({
    data: { tenantId: user.tenantId, userId: user.id, action: 'user.sku.purchase', payloadJson: { skuKey: sku.key, kind: sku.kind, grantsModuleKey: sku.grantsModuleKey, source: opts.source } },
  }).catch(() => {});
}
