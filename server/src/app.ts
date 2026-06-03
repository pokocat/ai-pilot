// 应用工厂：构建并注册所有路由的 Fastify 实例（不监听端口）。
// index.ts 用它来 listen；集成测试用它来 app.inject(...) 免端口直测。
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { authRoutes } from './routes/auth.js';
import { metaRoutes } from './routes/meta.js';
import { agentRoutes } from './routes/agents.js';
import { profileRoutes } from './routes/profile.js';
import { sayingRoutes } from './routes/sayings.js';
import { sessionRoutes } from './routes/sessions.js';
import { libraryRoutes } from './routes/library.js';
import { projectRoutes } from './routes/projects.js';
import { reportRoutes } from './routes/reports.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { adminRoutes } from './routes/admin.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false });
  await app.register(cors, { origin: true });

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(metaRoutes, { prefix: '/api' });
  await app.register(agentRoutes, { prefix: '/api' });
  await app.register(profileRoutes, { prefix: '/api' });
  await app.register(sayingRoutes, { prefix: '/api' });
  await app.register(sessionRoutes, { prefix: '/api' });
  await app.register(libraryRoutes, { prefix: '/api' });
  await app.register(projectRoutes, { prefix: '/api' });
  await app.register(reportRoutes, { prefix: '/api' });
  await app.register(knowledgeRoutes, { prefix: '/api' });
  await app.register(adminRoutes, { prefix: '/api' });

  await app.ready();
  return app;
}
