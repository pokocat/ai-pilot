// 可注入时钟（D9 可测性预留）。业务侧一切「到期判断 / 月度锚点重置 / 剩余天数折算」都读这里的 now()，
// 不直接用 new Date()，以便沙箱下用 x-test-now 头快进时间、离线端到端验证有效期与降级。
//
// 实现：用 AsyncLocalStorage 把「本次请求的现在」挂在异步上下文里，默认回退真实时钟。
// 仅沙箱（sandboxEnabled）模式下，app.ts 的 onRequest hook 才会注入覆盖值；生产恒为真实时钟。
//
// 注意：微信 v3 请求签名 / paySign 的时间戳仍用真实 Date.now()（那是对外签名，不能被业务时钟篡改）——
// 本时钟只服务于「我方记账的有效期 / 重置」语义。

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<Date>();

/** 服务端可信「现在」（UTC 语义）。沙箱可覆盖；生产恒为真实时钟。 */
export function now(): Date {
  return store.getStore() ?? new Date();
}

/** 在固定时刻 at 内同步/异步执行 fn（脚本、测试构造时间用）。 */
export function runWithNow<T>(at: Date, fn: () => T): T {
  return store.run(at, fn);
}

/** 把「当前异步上下文（如一次 HTTP 请求）」的现在固定为 at。供 Fastify onRequest hook 注入。 */
export function enterNow(at: Date): void {
  store.enterWith(at);
}

// ============ 时区化日历派生（P1-4） ============
// 业务侧「今天 / 几点 / 星期 / 日历日键」一律走这里，用 Intl 固定 Asia/Shanghai 计算，
// 不再裸用 Date.getFullYear/getMonth/getDate/getHours/getDay —— 那些依赖进程 TZ，
// 裸机部署 TZ 不对会让连续天数、订阅提醒、限流 key、月度分桶整体偏移。
// now() 语义不变：时刻本身与时区无关，只有从时刻派生「日历字段」时才固定上海时区。
const TIMEZONE = 'Asia/Shanghai';
// Asia/Shanghai 自 1991 年起无夏令时，恒为 UTC+8。日/周/月起点需要「上海 00:00 对应的 UTC 瞬时」时用它换算。
const SHANGHAI_OFFSET_MS = 8 * 3600_000;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short',
});
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const pad2 = (n: number): string => String(n).padStart(2, '0');

export interface CalendarParts {
  year: number; month: number; day: number; // month 1-12
  hour: number; minute: number; second: number; // hour 0-23
  weekday: number; // 周日=0 … 周六=6（与 Date.getDay 同义）
}

/** 某时刻在 Asia/Shanghai 的日历字段。 */
export function calendarParts(at: Date = now()): CalendarParts {
  const o: Record<string, string> = {};
  for (const p of partsFmt.formatToParts(at)) if (p.type !== 'literal') o[p.type] = p.value;
  return {
    year: Number(o.year), month: Number(o.month), day: Number(o.day),
    hour: Number(o.hour), minute: Number(o.minute), second: Number(o.second),
    weekday: WEEKDAY_INDEX[o.weekday] ?? 0,
  };
}

/** 上海时区日历日键 'YYYY-MM-DD'。 */
export function dateKey(at: Date = now()): string {
  const p = calendarParts(at);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** 上海时区月键 'YYYY-MM'。 */
export function monthKey(at: Date = now()): string {
  const p = calendarParts(at);
  return `${p.year}-${pad2(p.month)}`;
}

/** 上海时区年份（命理流年等用）。 */
export function yearOf(at: Date = now()): number { return calendarParts(at).year; }

/** 上海时区小时 0-23。 */
export function hourOf(at: Date = now()): number { return calendarParts(at).hour; }

/** 上海时区星期（周日=0 … 周六=6）。 */
export function weekdayOf(at: Date = now()): number { return calendarParts(at).weekday; }

/** 上海时区「今天 HH:mm」。 */
export function hhmm(at: Date = now()): string {
  const p = calendarParts(at);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 上海时区月日中文 'M月D日'。 */
export function monthDayCn(at: Date = now()): string {
  const p = calendarParts(at);
  return `${p.month}月${p.day}日`;
}

/** 上海时区一年中的第几天（1 月 1 日 = 1；用于每日轮换选取）。 */
export function dayOfYear(at: Date = now()): number {
  const p = calendarParts(at);
  const start = Date.UTC(p.year, 0, 1);
  const cur = Date.UTC(p.year, p.month - 1, p.day);
  return Math.floor((cur - start) / 86400_000) + 1;
}

/** 该时刻所属「上海日历日」的 00:00 对应的 UTC 瞬时（供 createdAt gte 等区间查询/连续天数游标）。 */
export function dayStart(at: Date = now()): Date {
  const p = calendarParts(at);
  return new Date(Date.UTC(p.year, p.month - 1, p.day) - SHANGHAI_OFFSET_MS);
}

/** 该时刻所属「上海周（周一起）」的周一 00:00 对应的 UTC 瞬时。 */
export function weekStart(at: Date = now()): Date {
  const p = calendarParts(at);
  const back = (p.weekday + 6) % 7; // 周一=0 … 周日=6
  return new Date(Date.UTC(p.year, p.month - 1, p.day - back) - SHANGHAI_OFFSET_MS);
}

/** 该时刻所属「上海月」的 1 号 00:00 对应的 UTC 瞬时。 */
export function monthStartOf(at: Date = now()): Date {
  const p = calendarParts(at);
  return new Date(Date.UTC(p.year, p.month - 1, 1) - SHANGHAI_OFFSET_MS);
}
