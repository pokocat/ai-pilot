import { env } from './env.js';
import { prisma } from './db.js';
import { buildApp } from './app.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';
import { assertProductionAuthSafe } from './services/authConfig.js';

assertProductionAuthSafe();
const app = await buildApp({ logger: true });

// 全局错误兜底：未处理 rejection / uncaughtException 后进程状态不可再信任，必须有期限地优雅退出，
// 由 systemd Restart=always 拉起干净实例。注册 handler 后 Node 不会再默认退出，不能只写日志。
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, '[fatal] unhandledRejection（未处理的 Promise 拒绝）');
  void gracefulShutdown('unhandledRejection', 1);
});
process.on('uncaughtException', (err) => {
  app.log.error({ err }, '[fatal] uncaughtException（未捕获异常）');
  void gracefulShutdown('uncaughtException', 1);
});

// 优雅停机：systemd/部署重启发 SIGTERM 时，先停定时器 → app.close()（触发既有 onClose 关 Chromium、
// 排空在途请求）→ 断开 DB，再退出。避免硬杀掐断在途 SSE、漏 Chromium 清理、漏结算预留。
let shuttingDown = false;
async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`[shutdown] 收到 ${signal}，开始优雅停机…`);
  const watchdog = setTimeout(() => {
    app.log.error(`[shutdown] ${signal} 超过 15 秒仍未完成，强制退出。`);
    process.exit(exitCode || 1);
  }, 15_000);
  watchdog.unref();
  try {
    stopScheduler();
    await app.close(); // 停止接新请求 + 排空在途 + 触发 onClose（关 Chromium 等）
    await prisma.$disconnect();
    clearTimeout(watchdog);
    app.log.info(`[shutdown] 完成，以状态 ${exitCode} 退出。`);
    process.exit(exitCode);
  } catch (err) {
    clearTimeout(watchdog);
    app.log.error({ err }, '[shutdown] 优雅停机出错，强制退出。');
    process.exit(1);
  }
}
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { void gracefulShutdown(sig); });
}

try {
  await app.listen({ port: env.port, host: '0.0.0.0' });
  startScheduler(); // 定时任务（M1 PR-4）：启动即按周期扫描（test 环境内部直接返回）
  app.log.info(`军师 API ready · provider=${env.aiProvider} · http://localhost:${env.port}/api`);
  if (process.env.NODE_ENV === 'production') {
    // 容量告警（2026-07 压测 P0-3）：DATABASE_URL 未显式设 connection_limit 时，Prisma 按
    // 「容器看到的 CPU 数 × 2 + 1」推导 —— 同一镜像在 4C 机器是 9、8C 是 17、ACK 2C Pod 是 5，
    // 横向扩容时数据库连接总量完全不可预算，扩到一定实例数就会撞 max_connections。
    // 这类问题不会报错、只会在扩容当天炸，所以只能靠启动告警发现。
    if (!/[?&]connection_limit=/.test(process.env.DATABASE_URL ?? '')) {
      app.log.warn('[容量告警] DATABASE_URL 未设 connection_limit：Prisma 将按容器 CPU 数推导连接池，扩容时连接总量不可预算。建议显式设 connection_limit（每实例 10–20）与 pool_timeout，见 deploy/docker-compose.yml 注释。');
    }
    // 例行 QA 2026-07-08：今日军令/复盘归档/段位晋升/夜间复盘推送等「今天几点」判断都基于
    // 进程本地时区（clock.ts 的 now() 是裸 new Date()）。裸机部署若未按 docs/DEPLOYMENT.md
    // §4 A0 设置宿主时区，这些判断会整体错开（UTC vs 北京时间 8 小时），且不会有任何报错，
    // 只能靠这条启动告警发现。
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz !== 'Asia/Shanghai') {
      app.log.warn(`[时区告警] 进程时区=${tz}（非 Asia/Shanghai）：今日军令/复盘归档/段位晋升/夜间复盘推送等日期判断会按此时区计算，与产品预期的北京时间不符。裸机部署请 timedatectl set-timezone Asia/Shanghai；Docker/systemd 部署请确认 TZ=Asia/Shanghai 环境变量生效（见 docs/DEPLOYMENT.md §4 A0）。`);
    }
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
