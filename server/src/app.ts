// 应用工厂：构建并注册所有路由的 Fastify 实例（不监听端口）。
// index.ts 用它来 listen；集成测试用它来 app.inject(...) 免端口直测。
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { authRoutes } from './routes/auth.js';
import { metaRoutes } from './routes/meta.js';
import { agentRoutes } from './routes/agents.js';
import { profileRoutes } from './routes/profile.js';
import { sayingRoutes } from './routes/sayings.js';
import { sessionRoutes } from './routes/sessions.js';
import { libraryRoutes } from './routes/library.js';
import { projectRoutes } from './routes/projects.js';
import { reportRoutes } from './routes/reports.js';
import { reportShareRoutes } from './routes/reportShare.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { memoryRoutes } from './routes/memories.js';
import { graphRoutes } from './routes/graph.js';
import { planRoutes } from './routes/plans.js';
import { payRoutes } from './routes/pay.js';
import { adminRoutes } from './routes/admin.js';
import { adminAccountRoutes } from './routes/adminAccount.js';
import { registerHttpAudit } from './services/audit.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false });

  // 兼容「Content-Type: application/json 但 body 为空」的 POST（如无 body 的 activate / 报告渲染等接口）。
  // fastify 5.x 默认对空 JSON body 抛 FST_ERR_CTP_EMPTY_JSON_BODY(400)；而前端/小程序的请求封装会无条件带
  // application/json 头，无 body 的 POST 就被拒。这里把空 body 解析成 {}，非空仍正常解析(非法 JSON → 400)。
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    // 保留原文供支付回调等需要验签的路由读取（req.rawBody）。
    (req as typeof req & { rawBody?: string }).rawBody = body as string;
    const s = (body as string).trim();
    if (!s) return done(null, {});
    try { done(null, JSON.parse(s)); }
    catch (err) { (err as Error & { statusCode?: number }).statusCode = 400; done(err as Error, undefined); }
  });

  await app.register(cors, { origin: true });
  // 知识库文档上传：单文件、≤20MB（解析器在 docParse 按需动态加载）。
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 5 } });
  registerHttpAudit(app);

  await app.register(authRoutes, { prefix: '/api' });
  await app.register(metaRoutes, { prefix: '/api' });
  await app.register(agentRoutes, { prefix: '/api' });
  await app.register(profileRoutes, { prefix: '/api' });
  await app.register(sayingRoutes, { prefix: '/api' });
  await app.register(sessionRoutes, { prefix: '/api' });
  await app.register(libraryRoutes, { prefix: '/api' });
  await app.register(projectRoutes, { prefix: '/api' });
  await app.register(reportRoutes, { prefix: '/api' });
  await app.register(reportShareRoutes, { prefix: '/api' }); // 公开报告页(无鉴权,凭 id 分享)
  await app.register(knowledgeRoutes, { prefix: '/api' });
  await app.register(memoryRoutes, { prefix: '/api' });
  await app.register(graphRoutes, { prefix: '/api' });
  await app.register(planRoutes, { prefix: '/api' });
  await app.register(payRoutes, { prefix: '/api' }); // 支付回调（封装插件含原文 JSON 解析器，验签用）
  await app.register(adminAccountRoutes, { prefix: '/api' }); // 后台账户登录（公开 + 自证），不挂全局 requireAdmin
  await app.register(adminRoutes, { prefix: '/api' });

  await app.ready();
  return app;
}
