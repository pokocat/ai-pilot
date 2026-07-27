import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

// 测试环境自足性：`@prisma/client` 在「模块 import」与「每次 new PrismaClient()」两个时机都会
// 无条件加载 `server/.env`（生成产物里烤死了它的绝对路径，与 cwd 无关；Prisma 5.22 没有 opt-out
// 开关），把开发机的真实配置注进测试进程 —— 构造时机就在上一行，所以抹除只能在这里做。
// 钩子由测试预载模块 `test/hermeticEnv.mjs` 挂到 globalThis，非测试进程没有它 → 整句是 no-op
// （生产/开发照旧由 `src/env.ts` 的 dotenv 加载 `.env`）。来龙去脉见该预载模块顶部注释。
(globalThis as { __hermeticEnv?: { scrub?: () => void } }).__hermeticEnv?.scrub?.();
