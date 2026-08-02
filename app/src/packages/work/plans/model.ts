import type { PlanOption, PlanOptionsResult } from '../../../services/api';

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

export function isPlanExpired(expiresAt?: string | null, at = Date.now()): boolean {
  return !!expiresAt && new Date(expiresAt).getTime() <= at;
}

export function canStartPurchase(option: PlanOption): boolean {
  return option.canPurchase && !['remind', 'contact', 'wait_applied'].includes(option.action);
}

export function publicFeatures(features: string[]): string[] {
  return features.filter((value) => !/(token|\d+\s*点\s*[\/]?\s*月|每月\s*(?:约\s*)?\d+\s*(?:点|次)|\d+\s*(位|个).*顾问|顾问.*\d+\s*位)/i.test(value)).slice(0, 4);
}
