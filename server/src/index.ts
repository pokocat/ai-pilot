import Fastify from 'fastify';
import cors from '@fastify/cors';
import { env } from './env.js';
import { authRoutes } from './routes/auth.js';
import { metaRoutes } from './routes/meta.js';
import { agentRoutes } from './routes/agents.js';
import { profileRoutes } from './routes/profile.js';
import { sayingRoutes } from './routes/sayings.js';
import { sessionRoutes } from './routes/sessions.js';
import { libraryRoutes } from './routes/library.js';
import { adminRoutes } from './routes/admin.js';

const app = Fastify({ logger: { level: 'info' } });

await app.register(cors, { origin: true });

await app.register(authRoutes, { prefix: '/api' });
await app.register(metaRoutes, { prefix: '/api' });
await app.register(agentRoutes, { prefix: '/api' });
await app.register(profileRoutes, { prefix: '/api' });
await app.register(sayingRoutes, { prefix: '/api' });
await app.register(sessionRoutes, { prefix: '/api' });
await app.register(libraryRoutes, { prefix: '/api' });
await app.register(adminRoutes, { prefix: '/api' });

try {
  await app.listen({ port: env.port, host: '0.0.0.0' });
  app.log.info(`军师 API ready · provider=${env.aiProvider} · http://localhost:${env.port}/api`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
