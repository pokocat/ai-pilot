// 套餐时间纯函数（无 prisma / 无副作用）：月度锚点子周期、到期判定、剩余天数、月末漂移 clamp。
// 被 tokenQuota（额度重置）/ purchase（到期计算）/ proration（折算）/ meta（/me 展示）复用。
// 全部以 UTC 计算，配合可注入时钟 clock.now() 做离线快进验证。

const MS_PER_DAY = 86_400_000;

/**
 * 在 UTC 上加 months 个月，月末漂移 clamp：
 *   1/31 + 1月 → 2/28(或闰年 2/29)；激活日 31 号、目标小月 → 取当月最后一天。
 * months 可为负（不会用到，但保持纯函数完备）。
 */
export function addMonthsClamped(d: Date, months: number): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + months;
  const day = d.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(); // 目标月最后一天（Date.UTC 自动规整月溢出）
  return new Date(Date.UTC(year, month, Math.min(day, lastDay), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
}

/** 到期判定：有 expiresAt 且 now ≥ expiresAt（null = 不到期，免费/企业/历史用户）。 */
export function isExpired(expiresAt: Date | null | undefined, at: Date): boolean {
  return !!expiresAt && at.getTime() >= expiresAt.getTime();
}

/** 当前所处的月度锚点子周期序号 k：activatedAt + k 月 ≤ at < activatedAt + (k+1) 月。 */
export function subPeriodIndex(activatedAt: Date, at: Date): number {
  let k = (at.getUTCFullYear() - activatedAt.getUTCFullYear()) * 12 + (at.getUTCMonth() - activatedAt.getUTCMonth());
  if (k < 0) k = 0;
  while (k > 0 && addMonthsClamped(activatedAt, k).getTime() > at.getTime()) k--;
  while (addMonthsClamped(activatedAt, k + 1).getTime() <= at.getTime()) k++;
  return k;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * 月度额度重置锚点键。
 * - 有 activatedAt（付费用户）：当前锚点子周期的起始日 `YYYY-MM-DD`（按激活日对齐，堵免费续杯/月中白享）。
 * - 无 activatedAt（免费层 / 历史用户）：自然月 `YYYY-MM`（长度 7 vs 锚点键 10，天然不冲突 → 平滑迁移）。
 */
export function periodKeyOf(activatedAt: Date | null | undefined, at: Date): string {
  if (!activatedAt) return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}`;
  const start = addMonthsClamped(activatedAt, subPeriodIndex(activatedAt, at));
  return `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;
}

/** 下次月度额度重置时刻。免费层=下月 1 号 UTC；付费=下一锚点子周期起点。 */
export function nextResetAt(activatedAt: Date | null | undefined, at: Date): Date {
  if (!activatedAt) return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return addMonthsClamped(activatedAt, subPeriodIndex(activatedAt, at) + 1);
}

/** 套餐一个计费周期的「绝对到期时间」：年付 +12 月、月付 +1 月（月末漂移 clamp）。 */
export function computeExpiry(base: Date, period: string): Date {
  return addMonthsClamped(base, period === 'year' ? 12 : 1);
}

/**
 * 续费叠加到期：从激活锚点 activatedAt 重新派生，而非在已 clamp 的 prevExpiresAt 上再加（否则 31 号锚点每轮被
 * clamp 成 28/30，永久漂移、且与月度额度锚点子周期链脱钩）。= activatedAt + (已覆盖月数 + 本期月数)。
 */
export function renewExpiry(activatedAt: Date, prevExpiresAt: Date, period: string): Date {
  const months = period === 'year' ? 12 : 1;
  return addMonthsClamped(activatedAt, subPeriodIndex(activatedAt, prevExpiresAt) + months);
}

/** 计费周期的名义天数（折算日单价用：日单价 = price / 名义天数）。 */
export function periodNominalDays(period: string): number {
  return period === 'year' ? 365 : 30;
}

/** 向上取整的剩余天数（≥0）；expiresAt 为 null（不到期）→ null。 */
export function daysRemaining(expiresAt: Date | null | undefined, at: Date): number | null {
  if (!expiresAt) return null;
  return Math.max(0, Math.ceil((expiresAt.getTime() - at.getTime()) / MS_PER_DAY));
}
