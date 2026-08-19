import type { FastifyInstance, FastifyRequest } from 'fastify';
import { gateEnter, gateInFlightNow, gateLeave, noteOverloadRejected } from './metrics.js';

type CountedRequest = FastifyRequest & { __overloadCounted?: boolean };

/** 注册快接口过载闸；响应、异常、客户端断连共用同一个幂等 release。 */
export function registerOverloadGate(
  app: FastifyInstance,
  maxInFlight: number,
  excluded: (url: string) => boolean,
): void {
  app.addHook('onRequest', async (req, reply) => {
    if (excluded(req.url)) return;
    if (gateInFlightNow() >= maxInFlight) {
      noteOverloadRejected();
      reply.header('Retry-After', '1');
      return reply.code(503).send({ error: '服务繁忙，请稍后重试', code: 'SERVER_BUSY' });
    }
    gateEnter();
    (req as CountedRequest).__overloadCounted = true;
  });
  const release = (req: CountedRequest) => {
    if (!req.__overloadCounted) return;
    req.__overloadCounted = false;
    gateLeave();
  };
  app.addHook('onResponse', async (req) => release(req as CountedRequest));
  app.addHook('onError', async (req) => release(req as CountedRequest));
  app.addHook('onRequestAbort', async (req) => release(req as CountedRequest));
}
