// Prometheus 指标端点。数据源见 services/metrics.ts。
//
// 鉴权：**必须配 METRICS_TOKEN 才开放**，未配则整个端点返回 404。
//
// 为什么不能退化成「只允许内网 IP」：生产 Nginx 是反代，且 app.ts 按 P0-0 开了 trustProxy，
// 于是 ① req.ip 取自 X-Forwarded-For，客户端可以随手伪造；② 真实 TCP 对端恒为 127.0.0.1
// （Nginx 自己），public 流量与本机 curl 完全无法区分。所以 IP 白名单在这个拓扑下形同虚设，
// 只有共享密钥是真的门。另外建议在 Nginx 侧也不要把 /api/metrics 暴露到公网（双保险）。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { renderMetrics } from '../services/metrics.js';

export function bearerOf(req: FastifyRequest): string {
  const raw = req.headers.authorization;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return (v ?? '').replace(/^Bearer\s+/i, '').trim();
}

// routes/alerts.ts 的告警回传端点也用同一把 METRICS_TOKEN（同属监控栈信任域，不加第二个密钥）。
export function tokenMatches(provided: string, configured: string): boolean {
  if (!provided || !configured) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function metricsRoutes(app: FastifyInstance) {
  // rateLimit:false —— 指标恰恰在出事时最有用，不能被限流吃掉。
  app.get('/metrics', { config: { rateLimit: false } }, async (req, reply) => {
    const configured = (process.env.METRICS_TOKEN ?? '').trim();
    if (!configured) {
      return reply.code(404).send({ error: '未配置 METRICS_TOKEN，指标端点已关闭', code: 'METRICS_DISABLED' });
    }
    if (!tokenMatches(bearerOf(req), configured)) {
      return reply.code(401).send({ error: '指标端点鉴权失败', code: 'METRICS_UNAUTHORIZED' });
    }
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    return renderMetrics();
  });
}
