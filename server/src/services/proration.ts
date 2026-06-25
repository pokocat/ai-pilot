// 月→年 升级折算（D5）+ 反套利。把老套餐「未消耗有效期」的时间价值抵到新单现金里，只折时间、不退现、不碰用量。
//
// 反套利规则（钉死）：
//   1) 折算基准用**老套餐自己的日单价**（绝不用新套餐单价换算）→ 防「低买高折」。
//   2) 剩余价值只抵现金，**不退现**；V > P_new 的溢出作废（chargeAmount 夹 0，不退差）。
//   3) 已发 credits / 已用 token **不回收、不参与**折算（用量不 proration），只折未消耗有效期时间价值。
//   4) 不限量/企业版（price≤0）不参与折算。
//   5) 仅「老=月付(period=month, 未过期) → 新=年付(period=year)」触发；其余一律全价。
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

/** 计算把 user 升级到 newPlan 时应实付的金额（含月→年折算）。只读，不写库。 */
export async function computeUpgradeProration(
  user: { id: string },
  newPlan: { id: string; price: number; period: string },
): Promise<ProrationResult> {
  const fullPrice = newPlan.price;
  const base: ProrationResult = {
    applies: false, fullPrice, remainingDays: 0, remainingValue: 0,
    chargeAmount: fullPrice, fromPlanId: null, fromPlanName: null,
  };
  // 仅升级到「付费年付」才可能折算
  if (newPlan.period !== 'year' || fullPrice <= 0) return base;

  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: { planId: true, planExpiresAt: true, plan: { select: { id: true, name: true, price: true, period: true } } },
  });
  const old = u?.plan;
  const at = now();
  // 老套餐须为：付费月付、未过期、且不是同一个套餐（升级而非续费）
  if (!old || old.price <= 0 || old.period !== 'month' || old.id === newPlan.id) return base;
  if (isExpired(u?.planExpiresAt, at)) return base;

  const remainingDays = daysRemaining(u?.planExpiresAt, at) ?? 0;
  if (remainingDays <= 0) return base;

  const oldDayRate = old.price / periodNominalDays(old.period); // 老套餐日单价（月付→/30）
  // 抵扣双重封顶（反套利）：① 不超过新单原价（不退现）；② 不超过老套餐实付价 old.price
  // —— 否则 31 天月 + ceil 剩余天数会算出 > 老套餐实付的抵扣（如 ¥198/30×31=¥204.6 > ¥198），形成「未消耗价值 > 已付」的泄漏。
  const remainingValue = Math.min(fullPrice, old.price, Math.round(oldDayRate * remainingDays));
  const chargeAmount = Math.max(0, fullPrice - remainingValue);
  return {
    applies: true, fullPrice, remainingDays, remainingValue, chargeAmount,
    fromPlanId: old.id, fromPlanName: old.name,
  };
}
