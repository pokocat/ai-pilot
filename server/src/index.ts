import { env } from './env.js';
import { buildApp } from './app.js';

const app = await buildApp({ logger: true });

try {
  await app.listen({ port: env.port, host: '0.0.0.0' });
  app.log.info(`军师 API ready · provider=${env.aiProvider} · http://localhost:${env.port}/api`);
  // P0-5：生产环境若未硬化鉴权，醒目告警（账号接管风险）。代码已就绪，缺的是这几个 env。
  if (process.env.NODE_ENV === 'production') {
    const warns: string[] = [];
    if (!(process.env.APP_JWT_SECRET ?? '').trim()) warns.push('APP_JWT_SECRET 未设置：登录态=明文 userId，可被冒充接管账号');
    else if ((process.env.APP_JWT_REQUIRED ?? 'false') !== 'true') warns.push('APP_JWT_REQUIRED!=true：历史裸 userId token 仍被接受');
    if ((process.env.SMS_REQUIRE_CODE ?? 'false') !== 'true') warns.push('SMS_REQUIRE_CODE!=true：登录免验证码，任意手机号可登录');
    if (warns.length) app.log.warn(`[安全告警] 生产鉴权未硬化(P0-5)：\n  - ${warns.join('\n  - ')}\n  设置对应 env 并重启即可关闭。`);
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
