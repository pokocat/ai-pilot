import type { PlanOption, PlanOptionsResult, PlanPromotion } from '../../../services/api';

export type PurchaseMode = 'manual' | 'auto';
export const DEFAULT_PURCHASE_MODE: PurchaseMode = 'manual';

/** 自动续费未开放时，即便端上残留了旧选择也必须回落单次购买。 */
export function effectivePurchaseMode(requested: PurchaseMode, autoRenewAvailable: boolean): PurchaseMode {
  return requested === 'auto' && autoRenewAvailable ? 'auto' : 'manual';
}

export const ACTION_LABEL: Record<PlanOption['action'], string> = {
  buy: '立即开通', renew: '续期', upgrade: '升级到此方案', change_billing: '转为年付',
  remind: '到期后可购买', contact: '联系顾问', continue_payment: '继续支付', wait_applied: '到账处理中',
};

export const STATUS_LABEL = {
  sufficient: '用量充足', normal: '正常使用', near_limit: '接近本周期上限', exhausted: '本周期用量已达上限',
} as const;

export function currentPlanOption(data: PlanOptionsResult | null): PlanOption | null {
  if (!data?.currentPlanId) return null;
  return data.options.find((item) => item.plan.id === data.currentPlanId) ?? null;
}

export function visiblePlanOptions(data: PlanOptionsResult | null, period: 'month' | 'year'): PlanOption[] {
  return (data?.options ?? []).filter((item) => item.plan.id !== data?.currentPlanId && (item.plan.price < 0 || item.plan.period === period));
}

export const PERIODS = ['month', 'year'] as const;
export type PlanPeriod = (typeof PERIODS)[number];
export const PERIOD_LABEL: Record<PlanPeriod, string> = { month: '月付', year: '年付' };

/**
 * 有货的周期才配拥有一个 tab。**判定必须复用真正的筛选器**（传 countFor），不能另写一套
 * 「有没有月付档」的规则——两套规则一旦漂移，就会出现「月付 tab 点得进去、里面空着」。
 * 运营只配了年付时返回 ['year']，页面据此把切换器整个收起来。
 */
export function availablePeriods(countFor: (period: PlanPeriod) => number): PlanPeriod[] {
  return PERIODS.filter((period) => countFor(period) > 0);
}

/** 当前选中的周期没货就落到第一个有货的周期；一个都没有时保持原样，交给页面走空态。 */
export function resolvePeriod(period: PlanPeriod, periods: PlanPeriod[]): PlanPeriod {
  return periods.length === 0 || periods.includes(period) ? period : periods[0];
}

export function isPlanExpired(expiresAt?: string | null, at = Date.now()): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() <= at;
}

export function canStartPurchase(option: PlanOption): boolean {
  return option.canPurchase && !['remind', 'contact', 'wait_applied'].includes(option.action);
}

// —— 折扣展示 ——
// 折扣率与生效时间窗一律由服务端算好（Plan.promotion）：端上再算一遍，迟早出现
// 「小程序显示 1 折、下单扣原价」。这几个函数只做文案拼装，不碰价格规则。

/** 价格上方的活动名。运营没填时给中性兜底，避免折扣角标旁边空一块。 */
export function promotionKicker(promotion: PlanPromotion | null | undefined): string {
  return promotion ? (promotion.label?.trim() || '限时优惠') : '';
}

/** 立省金额（省了多少比「打几折」更直观，两者并列才有促销感）。 */
export function promotionSave(promotion: PlanPromotion | null | undefined, money: (fen: number) => string): string {
  return promotion ? `立省 ${money(promotion.savedFen)}` : '';
}

/** 截止提示：配了结束时间才出，长期有效返回 ''——不写「长期有效」，那是噪音不是紧迫感。 */
export function promotionDeadline(
  promotion: PlanPromotion | null | undefined,
  date: (iso: string) => string,
): string {
  return promotion?.endsAt ? `优惠 ${date(promotion.endsAt)} 截止` : '';
}

export function publicFeatures(features: string[]): string[] {
  return features.filter((value) => !/(token|\d+\s*点\s*[\/]?\s*月|每月\s*(?:约\s*)?\d+\s*(?:点|次)|\d+\s*(位|个).*顾问|顾问.*\d+\s*位)/i.test(value)).slice(0, 4);
}
