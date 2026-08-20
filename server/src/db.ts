import { PrismaClient, Prisma } from '@prisma/client';

export const prisma = new PrismaClient();

/**
 * 把 JS Date 绑成「UTC naive 时间戳」字面量，供原生 SQL 与 timestamp(3) 列比较。
 *
 * 为什么不能直接写 `"createdAt" >= ${'${since}'}`：Prisma 的类型化写入把 DateTime 列存成
 * **UTC naive**，而原生 SQL 里的 JS Date 参数会被按**会话时区**渲染成本地 naive。生产库时区是
 * Asia/Shanghai，参数就比列值快整整 8 小时（生产实测 +480 分钟；本地 dev 库 America/Los_Angeles
 * 则慢 7 小时）。于是同一个 `since` 在 Prisma where 与原生 SQL 里其实是**两个窗口**——后台那些
 * 「表头总量走 Prisma 聚合、按天曲线走原生 SQL」的屏，两个数字对不上，就是这么来的。
 *
 * 只需要「当前时刻」时不必用它，库端 `now() AT TIME ZONE 'UTC'` 更直接（见 generationJobs 的
 * 租约判断）；本函数是给「边界已在 JS 算好，且要与 Prisma where 共用同一个 Date」的场景，
 * 包一层之后两边恒等。
 */
export function utcTimestamp(at: Date): Prisma.Sql {
  return Prisma.sql`${at.toISOString().slice(0, 23)}::timestamp`;
}

// 测试环境自足性：`@prisma/client` 在「模块 import」与「每次 new PrismaClient()」两个时机都会
// 无条件加载 `server/.env`（生成产物里烤死了它的绝对路径，与 cwd 无关；Prisma 5.22 没有 opt-out
// 开关），把开发机的真实配置注进测试进程 —— 构造时机就在上一行，所以抹除只能在这里做。
// 钩子由测试预载模块 `test/hermeticEnv.mjs` 挂到 globalThis，非测试进程没有它 → 整句是 no-op
// （生产/开发照旧由 `src/env.ts` 的 dotenv 加载 `.env`）。来龙去脉见该预载模块顶部注释。
(globalThis as { __hermeticEnv?: { scrub?: () => void } }).__hermeticEnv?.scrub?.();
