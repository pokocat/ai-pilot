// 升级折算（D5）+ 反套利。把老套餐「未消耗有效期」的时间价值抵到新单现金里，只折时间、不退现、不碰用量。
//
// 反套利规则（钉死）：
//   1) 折算基准用**老套餐自己的日单价**（绝不用新套餐单价换算）→ 防「低买高折」。
//   2) 剩余价值只抵现金，**不退现**；V > P_new 的溢出作废（chargeAmount 夹 0，不退差）。
//   3) 已发 credits / 已用 token **不回收、不参与**折算（用量不 proration），只折未消耗有效期时间价值。
//   4) 不限量/企业版（price≤0）不参与折算。
//   5) 仅「真升级」触发（老套餐付费、未过期、非同一套餐），两种形态：
//        a) 老=月付(period=month) → 新=年付(period=year)；
//        b) 同周期向上升级：老/新同为 month 或同为 year，且 **新价 > 老价**（如入门版¥68/月 → 决策版¥198/月）。
//      降级（新价 < 老价）、同价平级横切、同一套餐续费一律不折算 → 返回 base（由 routes/plans.ts 的降级守卫继续 409）。
//      同周期升级为何同样安全（不构成套利）：抵扣只按**老套餐自己的日单价**折未消耗天数，且双重封顶
//      min(新单原价, 老套餐实付价) —— 用户最多拿回「自己为这段未消耗时间付过的钱」，且只抵现金不退现，
//      故折出的价值恒 ≤ 已付金额，不可能套出超过已付的价值；用量（credits/token）本就不参与折算。
//
// ⚠️ 本函数是「升级放行」的唯一判定源：routes/plans.ts 的降级守卫直接读 applies（曾各写一份、必然漂移）。
import { prisma } from '../db.js';
import { now } from './clock.js';
import { isExpired, periodNominalDays, daysRemaining } from './planTime.js';

export interface ProrationResult {
  applies: boolean; // 是否触发折算
  fullPrice: number; // 新套餐原价（分）
  remainingDays: number; // 老套餐剩余天数
  remainingValue: number; // 折算抵扣（分）
  chargeAmount: number; // 实际应付（分）= max(0, fullPrice − remainingValue)
  fromPlanId: string | null; // 老套餐 id
  fromPlanName: string | null;
}

/** 计算把 user 升级到 newPlan 时应实付的金额（月→年 或 同周期向上升级触发折算）。只读，不写库。 */
export async function computeUpgradeProration(
  user: { id: string },
  newPlan: { id: string; price: number; period: string; planFamilyKey?: string | null; tierRank?: number | null },
): Promise<ProrationResult> {
  const fullPrice = newPlan.price;
  const base: ProrationResult = {
    applies: false, fullPrice, remainingDays: 0, remainingValue: 0,
    chargeAmount: fullPrice, fromPlanId: null, fromPlanName: null,
  };
  // 目标必须是付费档：免费(0)/企业版面议(<0) 不参与折算
  if (fullPrice <= 0) return base;

  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: { planId: true, planExpiresAt: true, plan: { select: { id: true, name: true, price: true, period: true, planFamilyKey: true, tierRank: true } } },
  });
  const old = u?.plan;
  const at = now();
  // 老套餐须为：付费、未过期、且不是同一个套餐（升级而非续费）
  if (!old || old.price <= 0 || old.id === newPlan.id) return base;
  if (isExpired(u?.planExpiresAt, at)) return base;
  // 只放开「升级」（规则 5）：月付→年付，或同周期涨价。降级/同价横切一律不折算。
  // tierRank 是唯一商业档位真相源；迁移期字段为空才回退价格（回填完成后删除兜底）。
  const oldTier = old.tierRank ?? old.price;
  const newTier = newPlan.tierRank ?? newPlan.price;
  const sameFamily = (old.planFamilyKey || old.id) === (newPlan.planFamilyKey || newPlan.id);
  const monthToYear = old.period === 'month' && newPlan.period === 'year' && newTier >= oldTier;
  const sameCycleUpgrade = old.period === newPlan.period && newTier > oldTier;
  // 同档月转年必须属于同一 family；跨 family 的同价横切仍由降档守卫拦截。
  if (monthToYear && newTier === oldTier && !sameFamily) return base;
  if (!monthToYear && !sameCycleUpgrade) return base;

  const remainingDays = daysRemaining(u?.planExpiresAt, at) ?? 0;
  if (remainingDays <= 0) return base;

  const oldDayRate = old.price / periodNominalDays(old.period); // 老套餐日单价（月付→/30、年付→/365）
  // 抵扣双重封顶（反套利）：① 不超过新单原价（不退现）；② 不超过老套餐实付价 old.price
  // —— 否则 31 天月 + ceil 剩余天数会算出 > 老套餐实付的抵扣（如 ¥198/30×31=¥204.6 > ¥198），形成「未消耗价值 > 已付」的泄漏。
  const remainingValue = Math.min(fullPrice, old.price, Math.round(oldDayRate * remainingDays));
  const chargeAmount = Math.max(0, fullPrice - remainingValue);
  return {
    applies: true, fullPrice, remainingDays, remainingValue, chargeAmount,
    fromPlanId: old.id, fromPlanName: old.name,
  };
}
