import { env } from './env.js';
import { prisma } from './db.js';
import { buildApp } from './app.js';
import { startScheduler, stopScheduler } from './services/scheduler.js';

const app = await buildApp({ logger: true });

// 全局错误兜底：未捕获的 rejection/exception 至少落 error 级日志（供告警），不静默吞掉、也不轻易退出
// （避免单个偶发异常误杀整个进程；真正致命的 uncaughtException 由 Node 决定，这里只保证有记录）。
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, '[fatal] unhandledRejection（未处理的 Promise 拒绝）');
});
process.on('uncaughtException', (err) => {
  app.log.error({ err }, '[fatal] uncaughtException（未捕获异常）');
});

// 优雅停机：systemd/部署重启发 SIGTERM 时，先停定时器 → app.close()（触发既有 onClose 关 Chromium、
// 排空在途请求）→ 断开 DB，再退出。避免硬杀掐断在途 SSE、漏 Chromium 清理、漏结算预留。
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`[shutdown] 收到 ${signal}，开始优雅停机…`);
  try {
    stopScheduler();
    await app.close(); // 停止接新请求 + 排空在途 + 触发 onClose（关 Chromium 等）
    await prisma.$disconnect();
    app.log.info('[shutdown] 完成，退出。');
    process.exit(0);
  } catch (err) {
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
  // P0-5：生产环境若未硬化鉴权，醒目告警（账号接管风险）。代码已就绪，缺的是这几个 env。
  if (process.env.NODE_ENV === 'production') {
    const warns: string[] = [];
    if (!(process.env.APP_JWT_SECRET ?? '').trim()) warns.push('APP_JWT_SECRET 未设置：登录态=明文 userId，可被冒充接管账号');
    else if ((process.env.APP_JWT_REQUIRED ?? 'false') !== 'true') warns.push('APP_JWT_REQUIRED!=true：历史裸 userId token 仍被接受');
    if ((process.env.SMS_REQUIRE_CODE ?? 'false') !== 'true') warns.push('SMS_REQUIRE_CODE!=true：登录免验证码，任意手机号可登录');
    if (warns.length) app.log.warn(`[安全告警] 生产鉴权未硬化(P0-5)：\n  - ${warns.join('\n  - ')}\n  设置对应 env 并重启即可关闭。`);
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
