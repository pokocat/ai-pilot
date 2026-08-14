// 套餐权益发放（被「演示购买」与「微信支付回调」共用，保证两条路径口径一致）。
// 发放 = 切换套餐 + 写有效期(D1/D2) + 叠加钻石(点)流水 + 覆盖式授予当月 token 额度。
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import { grantCredits } from './credits.js';
import { setQuota, grantQuotaPack } from './tokenQuota.js';
import { now } from './clock.js';
import { computeExpiry, renewExpiry } from './planTime.js';
import { bustPlanGate } from './planGate.js';
import { periodKeyOf } from './planTime.js';
import { planFamilyKey, planTierRank, sameCommercialTier } from './planRules.js';
import { recordPlanEntitlement } from './planEntitlements.js';

export interface PlanLike {
  id: string; name: string; price: number; period: string; creditsPerMonth: number; tokenQuotaPerMonth: number;
  planFamilyKey?: string | null; tierRank?: number | null; usageLevel?: string | null; usageLabel?: string | null;
  usageNormalPercent?: number | null; usageNearPercent?: number | null;
  agentCount?: number; featuresJson?: unknown; highlighted?: boolean;
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
  opts: {
    reason: string; source: string;
    order?: { id: string; outTradeNo: string; amount: number; termsHash: string | null; quote?: { remainingValue?: number } | null };
  },
  db?: Prisma.TransactionClient,
): Promise<GrantResult> {
  const unlimited = plan.creditsPerMonth < 0;
  const at = now();

  const apply = async (tx: Prisma.TransactionClient): Promise<GrantResult> => {
    const noExpiry = plan.price <= 0; // 免费层 / 企业版私有化：不设到期
    const prev = await tx.user.findUnique({
      where: { id: user.id },
      select: {
        planId: true, planActivatedAt: true, planExpiresAt: true,
        plan: { select: { id: true, price: true, period: true, planFamilyKey: true, tierRank: true } },
      },
    });
    const isRenewal = !noExpiry && prev?.planId === plan.id && !!prev.planExpiresAt && prev.planExpiresAt.getTime() > at.getTime();
    const isBillingChange = !noExpiry && !!prev?.plan && prev.plan.id !== plan.id
      && !!prev.planExpiresAt && prev.planExpiresAt.getTime() > at.getTime()
      && sameCommercialTier(prev.plan, plan);
    // 防刷：免费/永久套餐(noExpiry)已在该套餐上时，重复"购买"不再发钻石（钻石是累加流水，且免费路径无支付幂等键兜底；
    // 付费套餐的重复发放由支付层 outTradeNo 幂等防住）。月度额度由锚点重置链单独发放，不依赖此处重复点击。
    const skipFreeRegrant = noExpiry && prev?.planId === plan.id;
    const skipCurrentPeriodRegrant = skipFreeRegrant || isRenewal || isBillingChange;
    // 实际发放额：保留负数=不限量语义（企业版）；防刷跳过时为 0（grantCredits 对 0 是无操作）。
    const creditGrantAmount = skipCurrentPeriodRegrant ? 0 : plan.creditsPerMonth;
    // 展示/审计额：不限量与跳过均记 0。
    const grantedCredits = unlimited || skipCurrentPeriodRegrant ? 0 : plan.creditsPerMonth;
    const activatedAt = isRenewal || isBillingChange ? (prev!.planActivatedAt ?? at) : at;
    // 续费：从激活锚点重派生到期（renewExpiry，防月末 clamp 漂移、与额度锚点链对齐）；新购/升级：from now。
    const expiresAt = noExpiry ? null : (isRenewal ? renewExpiry(activatedAt, prev!.planExpiresAt!, plan.period) : computeExpiry(at, plan.period));
    const entitlementStartsAt = isRenewal && prev?.planExpiresAt ? prev.planExpiresAt : at;

    await tx.user.update({
      where: { id: user.id },
      data: { planId: plan.id, planActivatedAt: activatedAt, planExpiresAt: expiresAt },
    });
    const creditBalance = await grantCredits(user.tenantId, user.id, creditGrantAmount, opts.reason, tx);
    // skipFreeRegrant 同样必须挡住 token 额度覆盖式授予：setQuota 是硬覆盖 balance=quota（见 tokenQuota.ts），
    // 与"月度额度由锚点重置链单独发放"这句注释描述的惰性重置是两条独立路径——不挡住这里会让重复点击
    // 免费套餐的"购买"把已用尽的 token 额度刷回满额，形成与钻石防刷同源但未被堵上的刷额度口子。
    if (!skipCurrentPeriodRegrant) await setQuota(user.tenantId, user.id, plan.tokenQuotaPerMonth, activatedAt, tx);
    // 初次购买/升级已经在这里发了当期钻石，写幂等锚点；续期/同档转年付不重复发当期权益。
    if (!skipCurrentPeriodRegrant && !unlimited && plan.creditsPerMonth > 0) {
      await tx.monthlyCreditGrant.upsert({
        where: { userId_periodKey: { userId: user.id, periodKey: periodKeyOf(activatedAt, at) } },
        update: {},
        create: {
          tenantId: user.tenantId, userId: user.id, periodKey: periodKeyOf(activatedAt, at), planId: plan.id,
          sourceOrderId: opts.order?.id, amount: plan.creditsPerMonth,
        },
      });
    }
    if (!skipFreeRegrant) {
      await recordPlanEntitlement(tx, {
        tenantId: user.tenantId, userId: user.id,
        plan: {
          ...plan,
          agentCount: plan.agentCount ?? 0,
          featuresJson: plan.featuresJson ?? [],
          highlighted: plan.highlighted ?? false,
        },
        startsAt: entitlementStartsAt, expiresAt, anchorAt: activatedAt,
        previousPlanId: prev?.planId, order: opts.order,
      });
    }
    await tx.auditLog.create({
      data: {
        tenantId: user.tenantId,
        userId: user.id,
        action: 'user.plan.purchase',
        payloadJson: {
          planId: plan.id, planName: plan.name, grantedCredits, creditBalance,
          grantedTokens: plan.tokenQuotaPerMonth, source: opts.source,
          renewal: isRenewal,
          billingChange: isBillingChange,
          planFamilyKey: planFamilyKey(plan),
          tierRank: planTierRank(plan),
          planActivatedAt: activatedAt.toISOString(),
          planExpiresAt: expiresAt ? expiresAt.toISOString() : null,
        },
      },
    }).catch(() => {});
    return { creditBalance, grantedCredits, grantedTokens: skipCurrentPeriodRegrant ? 0 : plan.tokenQuotaPerMonth, expiresAt };
  };
  const result = db ? await apply(db) : await prisma.$transaction((tx) => apply(tx));
  bustPlanGate(user.id); // 禁写闸缓存 30s：付完款/发放后必须立刻可写
  return result;
}

export interface SkuLike {
  key: string; name: string; kind: string; grantsModuleKey: string | null; metaJson: unknown;
}

/** 增购包数量（credits=钻石颗数 / quota=算力 token 数）。沿用 storage 用 metaJson.bytes 的先例，不加列。 */
export function skuPackAmount(metaJson: unknown): number {
  const raw = (metaJson as { amount?: unknown } | null | undefined)?.amount;
  const v = Number(raw ?? 0);
  return Number.isFinite(v) ? Math.floor(Math.max(0, v)) : 0;
}

/**
 * V7-12：发放单次付费商品（SKU）权益。由 markPaidAndApply 在幂等事务内调用（appliedAt 锚点保证恰好一次）。
 *   - module   → upsert UserModule(grantsModuleKey, source='purchase') 启用能力。
 *   - service  → 记一次性服务凭据 UserModule(moduleKey='sku:'+key)（如深度整理，后续核销）。
 *   - storage  → Profile.extraJson.storageBonus 累加 metaJson.bytes（免加列）。
 *   - credits  → 钻石增购包：**合池**进现有 CreditLedger（grantCredits，reason 标来源）。
 *   - quota    → 算力增购包：grantQuotaPack 写 TokenWallet.packBalance（永久有效直到用完）。
 * 另写一条 delta=0 的 CreditLedger 备注行，让订单流水页零改造即可见（方案 V7-12 §前端2）；
 * credits 包例外——它自己那条 +amount 流水本身就可见，再补备注行就成了双行。
 */
export async function applySkuGrant(
  user: { id: string; tenantId: string },
  sku: SkuLike,
  opts: { reason: string; source: string; orderId?: string },
  tx: Prisma.TransactionClient,
): Promise<void> {
  const isPack = sku.kind === 'credits' || sku.kind === 'quota';
  const packAmount = isPack ? skuPackAmount(sku.metaJson) : 0;
  // credits 包自己写了 +amount 流水 → 跳过末尾的 delta=0 备注行（否则订单流水页出双行）。
  let skipNoteLedger = false;
  // 不限量余额用户的 credits 包：发放被跳过（防降级），审计里必须留痕供运营处置（退款/解释）。
  let creditsSkippedUnlimited = false;
  // 权益账本记「实际发放量」：跳过发放时为 0，退款按它回收（revokeOrderGrant），
  // 否则「没发出去的 50 颗」会在用户日后变回有限余额时被退款追扣一次。
  let grantedPackAmount = packAmount;
  if (sku.kind === 'module' && sku.grantsModuleKey) {
    await tx.userModule.upsert({
      where: { userId_moduleKey: { userId: user.id, moduleKey: sku.grantsModuleKey } },
      update: { enabled: true, hidden: false, source: 'purchase' },
      create: { tenantId: user.tenantId, userId: user.id, moduleKey: sku.grantsModuleKey, enabled: true, source: 'purchase' },
    });
  } else if (sku.kind === 'storage') {
    // 与 credits.ts lockCreditAccount / tokenQuota.ts lockQuota 同一模式：按用户加事务级 advisory lock，
    // 防止两笔并发到账（连续购买 / 支付回调重投递不同订单号）各自读到同一份旧 storageBonus 导致其中一次丢失。
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`storage:${user.id}`}))`;
    const bytes = Number((sku.metaJson as { bytes?: number } | null)?.bytes ?? 0);
    const profile = await tx.profile.findFirst({ where: { tenantId: user.tenantId }, orderBy: { updatedAt: 'desc' } });
    const extra = (profile?.extraJson as Record<string, unknown> | null) ?? {};
    const bonus = Number(extra.storageBonus ?? 0) + bytes;
    if (profile) await tx.profile.update({ where: { id: profile.id }, data: { extraJson: { ...extra, storageBonus: bonus } as Prisma.InputJsonValue } });
    else await tx.profile.create({ data: { tenantId: user.tenantId, extraJson: { storageBonus: bonus } as Prisma.InputJsonValue } });
  } else if (sku.kind === 'credits') {
    // 钻石增购包：与套餐赠送**合池**（同一个 CreditLedger 余额），只在流水 reason 上标出来源。
    // grantCredits 自带 `credit:` advisory lock，并发到账不会互相冲掉余额。
    // 不限量余额（企业版哨兵 -1）兜底：grantCredits 会把 -1 写成有限值（isUnlimited(bal) ? amount），
    // 等于收了钱还把权益降级。正常路径已在 /skus/:key/order 下单时拦住（CREDITS_UNLIMITED），
    // 这里兜「下单后才被运营改成不限量」的竞态：跳过发放、保留 delta=0 备注行与审计标记，退款仍可走。
    if (packAmount > 0) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit:${user.id}`}))`;
      const bal = await tx.creditLedger.findFirst({ where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { balance: true } });
      if ((bal?.balance ?? 0) < 0) {
        creditsSkippedUnlimited = true;
        grantedPackAmount = 0;
      } else {
        await grantCredits(user.tenantId, user.id, packAmount, opts.reason, tx);
        skipNoteLedger = true;
      }
    }
  } else if (sku.kind === 'quota') {
    // 算力增购包：进 TokenWallet.packBalance（永久有效直到用完，跨周期/续费/过期都不清零）。
    await grantQuotaPack(tx, user, packAmount);
  } else {
    // service（一次性服务，如深度整理）：记已购凭据，后续 organize 核销。
    await tx.userModule.upsert({
      where: { userId_moduleKey: { userId: user.id, moduleKey: `sku:${sku.key}` } },
      update: { enabled: true, source: 'purchase' },
      create: { tenantId: user.tenantId, userId: user.id, moduleKey: `sku:${sku.key}`, enabled: true, source: 'purchase' },
    });
  }
  if (opts.orderId) {
    const entitlementKey = sku.kind === 'module' && sku.grantsModuleKey ? sku.grantsModuleKey : `sku:${sku.key}`;
    await tx.skuEntitlement.upsert({
      where: { sourceOrderId: opts.orderId }, update: {},
      // 增购包把**实际发放量**记进 quantity（跳过发放=0，必须显式写掉默认值 1）：
      // 退款回收以 entitlement 量为准（revokeOrderGrant），快照量只作缺行兜底。
      create: {
        tenantId: user.tenantId, userId: user.id, skuKey: sku.key, sourceOrderId: opts.orderId, entitlementKey, kind: sku.kind,
        ...(isPack ? { quantity: grantedPackAmount } : {}),
      },
    });
  }
  // 备注型 0 额流水（订单流水页复用 CreditLedger，不加新端点）。
  // 必须持 credit advisory lock（与 credits.ts appendCreditDelta / lockCreditAccount 同锁同命名空间 `credit:`）：
  // 这条流水 read last.balance + create 若不加锁，会与并发 chargeCredits 竞态——扣费先读到 balance=B 尚未提交、
  // 本处也读到陈旧 B 后写 balance=B/delta=0，等扣费提交后最新行仍是 B，冲掉扣减、破坏 Σdelta==balance 不变式。
  // 上面 storage 分支拿的是 `storage:` 锁（不同命名空间，保护不了 credit 写），故此处单独补 `credit:` 锁；
  // 与外层 markPaidAndApply 的 outTradeNo 锁彼此独立，同一事务内叠加安全。
  if (!skipNoteLedger) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit:${user.id}`}))`;
    const last = await tx.creditLedger.findFirst({ where: { userId: user.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    await tx.creditLedger.create({
      data: { tenantId: user.tenantId, userId: user.id, delta: 0, reason: opts.reason, balance: last?.balance ?? 0 },
    }).catch(() => {});
  }
  await tx.auditLog.create({
    data: {
      tenantId: user.tenantId, userId: user.id, action: 'user.sku.purchase',
      payloadJson: {
        skuKey: sku.key, kind: sku.kind, grantsModuleKey: sku.grantsModuleKey, source: opts.source,
        ...(isPack ? { amount: packAmount } : {}),
        ...(creditsSkippedUnlimited ? { skippedUnlimited: true } : {}),
      },
    },
  }).catch(() => {});
}
