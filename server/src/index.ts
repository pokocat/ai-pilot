import { env } from './env.js';
import { buildApp } from './app.js';
import { startScheduler } from './services/scheduler.js';

const app = await buildApp({ logger: true });

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
