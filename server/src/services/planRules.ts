import type { PublicUsageView, UsageLevel, UsageStatus } from '../../../shared/contracts';

export interface PlanRuleFields {
  id: string;
  price: number;
  period: string;
  planFamilyKey?: string | null;
  tierRank?: number | null;
  usageLevel?: string | null;
  usageLabel?: string | null;
  usageNormalPercent?: number | null;
  usageNearPercent?: number | null;
  hidden?: boolean;
}

const LEVELS = new Set<UsageLevel>(['standard', '5x', '20x', 'custom']);
export const MAX_TIER_RANK = 2_147_483_647;

/** 迁移期兼容读取。回填完成后 family/tier 的兜底应删除，避免形成第二套长期档位规则。 */
export function planFamilyKey(plan: PlanRuleFields): string {
  return plan.planFamilyKey?.trim() || plan.id;
}

export function planTierRank(plan: PlanRuleFields): number {
  if (typeof plan.tierRank === 'number' && Number.isFinite(plan.tierRank)) return Math.round(plan.tierRank);
  if (plan.price < 0) return MAX_TIER_RANK;
  return Math.min(MAX_TIER_RANK, Math.max(0, Math.round(plan.price)));
}

export function publicUsageLevel(plan: PlanRuleFields): UsageLevel {
  return LEVELS.has(plan.usageLevel as UsageLevel) ? plan.usageLevel as UsageLevel : 'custom';
}

export function publicUsageLabel(plan: PlanRuleFields): string {
  const configured = plan.usageLabel?.trim();
  if (configured) return configured;
  return plan.price < 0 ? '专属用量' : '方案用量';
}

export function sameCommercialTier(a: PlanRuleFields, b: PlanRuleFields): boolean {
  return planFamilyKey(a) === planFamilyKey(b) && planTierRank(a) === planTierRank(b);
}

export function usageView(
  quota: { quota: number; used: number; unlimited: boolean },
  resetsAt: string,
  plan?: PlanRuleFields | null,
): PublicUsageView {
  if (quota.unlimited || quota.quota < 0) {
    return { usagePercent: 0, usageStatus: 'sufficient', resetsAt, unlimited: true };
  }
  const percent = quota.quota > 0 ? Math.min(100, Math.max(0, Math.round((quota.used / quota.quota) * 100))) : 100;
  const normal = Math.min(79, Math.max(1, Math.round(plan?.usageNormalPercent ?? 50)));
  const near = Math.min(99, Math.max(normal + 1, Math.round(plan?.usageNearPercent ?? 80)));
  let usageStatus: UsageStatus = 'sufficient';
  if (percent >= 100) usageStatus = 'exhausted';
  else if (percent >= near) usageStatus = 'near_limit';
  else if (percent >= normal) usageStatus = 'normal';
  return { usagePercent: percent, usageStatus, resetsAt, unlimited: false };
}
