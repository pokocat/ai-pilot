import type { AdminDateRange } from '../../../shared/contracts';

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = 'Asia/Shanghai' as const;

export interface AdminRangeQuery {
  days?: string | number;
  from?: string;
  to?: string;
}

export interface ParsedAdminRange {
  from: Date;
  toExclusive: Date;
  view: AdminDateRange;
}

function shanghaiDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

function startOfShanghaiDate(date: string): Date {
  return new Date(`${date}T00:00:00+08:00`);
}

function badRange(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400, code: 'ADMIN_RANGE_INVALID' });
}

/**
 * 后台所有时间筛选共用同一解析器：预设天数与自定义日期最终都变成 [from, toExclusive)。
 * 自定义日期按北京时间自然日解释，避免运营选 8 月 20 日却因 UTC 少看 8 小时。
 */
export function parseAdminRange(query: AdminRangeQuery, defaultDays: number, maxDays = 3660): ParsedAdminRange {
  const now = new Date();
  let from: Date;
  let toExclusive: Date;
  let fromDate: string;
  let toDate: string;

  if (query.from || query.to) {
    if (!query.from || !query.to) badRange('自定义时间必须同时填写开始日期和结束日期');
    if (!DATE_RE.test(query.from) || !DATE_RE.test(query.to)) badRange('日期格式必须为 YYYY-MM-DD');
    from = startOfShanghaiDate(query.from);
    toExclusive = new Date(startOfShanghaiDate(query.to).getTime() + DAY_MS);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(toExclusive.getTime())) badRange('日期无效');
    if (from >= toExclusive) badRange('开始日期不能晚于结束日期');
    fromDate = query.from;
    toDate = query.to;
  } else {
    const days = Math.floor(Number(query.days ?? defaultDays));
    if (!Number.isFinite(days) || days < 1 || days > maxDays) badRange(`时间范围需为 1-${maxDays} 天`);
    toExclusive = now;
    from = new Date(now.getTime() - days * DAY_MS);
    fromDate = shanghaiDate(from);
    toDate = shanghaiDate(new Date(toExclusive.getTime() - 1));
  }

  const days = Math.max(1, Math.ceil((toExclusive.getTime() - from.getTime()) / DAY_MS));
  if (days > maxDays) badRange(`自定义时间范围不能超过 ${maxDays} 天`);
  return {
    from,
    toExclusive,
    view: {
      from: from.toISOString(),
      to: new Date(toExclusive.getTime() - 1).toISOString(),
      fromDate,
      toDate,
      days,
      timeZone: TZ,
    },
  };
}

