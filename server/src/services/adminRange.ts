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
 * 滚动预设窗口的查询上界要略微越过「现在」。
 *
 * 滚动窗口的语义是「截至此刻」——不存在未来数据，上界只是个开口而非筛选条件。
 * 但 `lt` 是严格小于：上界取到 `now` 的毫秒时，**同一毫秒内刚写入的行会被整整排除掉**。
 * 而 `createdAt` 走 schema 的 `@default(now())`，由数据库生成；实测（本机同宿主机）
 * 数据库与 Node 墙钟中位差 0ms，因此热进程里「写入 → 立刻查」几乎总落在同一毫秒，
 * 偶尔还会因 Postgres 亚毫秒精度进位而比 Node 的 `new Date()` 快 1ms。
 *
 * 症状不只是测试红：运营刷「调用诊断」时，刚刚发生的那次调用会短暂查不到。
 *
 * 自定义日期区间**不加**这个余量——运营选「截至昨天」，就不能把今天的行捞进来；
 * 且自定义上界本就是次日 00:00（未来），天然不受此影响。
 */
const ROLLING_UPPER_BOUND_SLACK_MS = 60_000;

/**
 * 后台所有时间筛选共用同一解析器：预设天数与自定义日期最终都变成 [from, toExclusive)。
 * 自定义日期按北京时间自然日解释，避免运营选 8 月 20 日却因 UTC 少看 8 小时。
 *
 * 注意 `toExclusive` 是**查询上界**，滚动预设下会比「现在」多 ROLLING_UPPER_BOUND_SLACK_MS；
 * 对外展示与天数一律以 `view` 为准，`view` 不会出现未来时间。
 */
export function parseAdminRange(query: AdminRangeQuery, defaultDays: number, maxDays = 3660): ParsedAdminRange {
  const now = new Date();
  let from: Date;
  let toExclusive: Date;
  let fromDate: string;
  let toDate: string;
  /** 对外展示的区间末端（闭区间右端）。滚动预设下是「现在」，不含查询余量。 */
  let viewEnd: Date;
  /** 对外展示的天数。滚动预设直接用请求值，绝不从加了余量的跨度反算。 */
  let viewDays: number;

  if (query.from || query.to) {
    if (!query.from || !query.to) badRange('自定义时间必须同时填写开始日期和结束日期');
    if (!DATE_RE.test(query.from) || !DATE_RE.test(query.to)) badRange('日期格式必须为 YYYY-MM-DD');
    from = startOfShanghaiDate(query.from);
    toExclusive = new Date(startOfShanghaiDate(query.to).getTime() + DAY_MS);
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(toExclusive.getTime())) badRange('日期无效');
    if (shanghaiDate(from) !== query.from || shanghaiDate(new Date(toExclusive.getTime() - DAY_MS)) !== query.to) badRange('日期无效');
    if (from >= toExclusive) badRange('开始日期不能晚于结束日期');
    fromDate = query.from;
    toDate = query.to;
    viewEnd = toExclusive;
    viewDays = Math.max(1, Math.ceil((toExclusive.getTime() - from.getTime()) / DAY_MS));
    if (viewDays > maxDays) badRange(`自定义时间范围不能超过 ${maxDays} 天`);
  } else {
    const days = Math.floor(Number(query.days ?? defaultDays));
    if (!Number.isFinite(days) || days < 1 || days > maxDays) badRange(`时间范围需为 1-${maxDays} 天`);
    // 查询上界越过「现在」一点，好让同一毫秒内刚落库的行也能被捞到（见上方常量注释）。
    toExclusive = new Date(now.getTime() + ROLLING_UPPER_BOUND_SLACK_MS);
    from = new Date(now.getTime() - days * DAY_MS);
    fromDate = shanghaiDate(from);
    viewEnd = now;
    toDate = shanghaiDate(new Date(viewEnd.getTime() - 1));
    viewDays = days;
  }

  return {
    from,
    toExclusive,
    view: {
      from: from.toISOString(),
      to: new Date(viewEnd.getTime() - 1).toISOString(),
      fromDate,
      toDate,
      days: viewDays,
      timeZone: TZ,
    },
  };
}
