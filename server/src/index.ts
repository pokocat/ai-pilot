import { env } from './env.js';
import { buildApp } from './app.js';

const app = await buildApp({ logger: true });

try {
  await app.listen({ port: env.port, host: '0.0.0.0' });
  app.log.info(`军师 API ready · provider=${env.aiProvider} · http://localhost:${env.port}/api`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
