// 套餐「挂牌价 → 实际价」解析（2026-08-08）。
//
// 数据模型：`Plan.price` 是**挂牌价**（运营填的标价），`Plan.promoPrice` + `promoStartsAt/promoEndsAt`
// 是一段有生效时间窗的**优惠价**。用户当前该付多少钱 = withEffectivePrice() 的结果，而不是裸读 price。
//
// 为什么统一在读取处包一层，而不是在每个用到价格的分支里各判一次：
//   报价（quotePlanChange）、条款哈希（commercialTerms）、权益账本快照（PlanEntitlement.listPrice）、
//   委托代扣的续费金额（SubscriptionContract.renewalAmount）读的都是同一个 plan.price。漏掉任何一处，
//   就会出现「小程序显示 ¥3980、实际扣 ¥39800」或「按挂牌价给升级折抵」这类真金白银的偏差。
//   包一层之后，下游拿到的 plan.price 恒等于「此刻的成交价」，原有逻辑一行不用改也不会错。
//
// 硬约束（validatePlanPromotion 在写入口把关，本文件在读出口再兜一次底）：
//   1 ≤ promoPrice < price，且只允许配在正价档（price > 0）上。
//   → 生效价恒为正，`price <= 0`（免费层不设到期）与 `price < 0`（面议档禁止自助购买、tierRank 置顶）
//     这些**语义分支不会被优惠翻转**，所以调用方无需为优惠再加判断。
//
// 折扣率一律服务端算：端上复制一份折扣规则，迟早会出现「小程序显示 1 折、下单扣原价」的不一致。

import type { PlanPromotion } from '../../../shared/contracts';
import { now } from './clock.js';
import { planTierRank, type PlanRuleFields } from './planRules.js';

export interface PlanPricingFields {
  /** 挂牌价（分）。-1=面议、0=免费层。 */
  price: number;
  promoPrice?: number | null;
  promoStartsAt?: Date | null;
  promoEndsAt?: Date | null;
  promoLabel?: string | null;
}

/** 优惠此刻是否生效。库里存了越界值（历史数据 / 直连 SQL）一律按「不生效」处理。 */
export function promoActive(plan: PlanPricingFields, at: Date = now()): boolean {
  const promo = plan.promoPrice;
  if (typeof promo !== 'number' || !Number.isFinite(promo)) return false;
  if (plan.price <= 0) return false; // 面议 / 免费档不做优惠：会翻转到期与自助购买语义
  if (promo < 1 || promo >= plan.price) return false;
  if (plan.promoStartsAt && plan.promoStartsAt.getTime() > at.getTime()) return false;
  if (plan.promoEndsAt && plan.promoEndsAt.getTime() <= at.getTime()) return false;
  return true;
}

/** 此刻的实际成交价（分）。优惠未生效时等于挂牌价。 */
export function effectivePrice(plan: PlanPricingFields, at: Date = now()): number {
  return promoActive(plan, at) ? plan.promoPrice as number : plan.price;
}

/** 折扣费率（中式「折」）：实际价 ÷ 挂牌价 × 10，保留一位小数。1 = 一折。 */
export function discountRate(price: number, listPrice: number): number {
  if (listPrice <= 0 || price >= listPrice) return 10;
  // 下限 0.1 折：¥0.01 的支付链路验证档配上高挂牌价时会算出 0.0x 折，展示成「0折」像是免费。
  return Math.max(0.1, Math.round((price / listPrice) * 100) / 10);
}

/** 可直接展示的折扣文案。折得太浅（四舍五入到 10 折）时不写死数字，避免出现「10折优惠」。 */
export function discountLabel(price: number, listPrice: number): string {
  const rate = discountRate(price, listPrice);
  return rate >= 10 ? '限时优惠' : `${rate}折`;
}

/** 用户侧折扣展示对象；未在优惠期内返回 null（原价售卖）。 */
export function planPromotion(plan: PlanPricingFields, at: Date = now()): PlanPromotion | null {
  if (!promoActive(plan, at)) return null;
  const price = plan.promoPrice as number;
  return {
    listPrice: plan.price,
    price,
    savedFen: plan.price - price,
    discountRate: discountRate(price, plan.price),
    discountLabel: discountLabel(price, plan.price),
    label: plan.promoLabel?.trim() || null,
    endsAt: plan.promoEndsAt?.toISOString() ?? null,
  };
}

/**
 * 把一行套餐解析成「此刻的成交条件」：`price` 变成实际成交价，`listPrice` 保留挂牌价，
 * `promotion` 是算好的折扣展示对象。**所有会进入报价 / 下单 / 账本 / 代扣的 plan 都要先过这里。**
 *
 * tierRank 顺带固化：planTierRank() 在 tierRank 为空的存量档上会回退到 price，若不固化，
 * 优惠一开一停就会让同一个档的商业档位跳变，把升级判成降档而拦住用户下单。
 */
export function withEffectivePrice<T extends PlanPricingFields & PlanRuleFields>(
  plan: T,
  at: Date = now(),
): T & { price: number; listPrice: number; promotion: PlanPromotion | null } {
  // 幂等：解析过的对象里 price 已是成交价，再解析一次会因为 promoPrice >= price 而判成「无优惠」
  // 并把 promotion 抹成 null。链路长（路由 → 报价 → 账本）时重复包一层是很容易发生的，直接挡掉。
  if ('promotion' in plan) return plan as T & { price: number; listPrice: number; promotion: PlanPromotion | null };
  return {
    ...plan,
    price: effectivePrice(plan, at),
    listPrice: plan.price,
    tierRank: planTierRank(plan),
    promotion: planPromotion(plan, at),
  };
}
