import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { request } from 'node:http';
import { registerOverloadGate } from '../src/services/overloadGate.js';
import { __resetMetrics, gateInFlightNow } from '../src/services/metrics.js';

let app: FastifyInstance | null = null;
afterEach(async () => { if (app) await app.close(); app = null; __resetMetrics(); });

test('客户端中途断连只释放一次过载槽位，后续请求不被永久 503', async () => {
  __resetMetrics();
  app = Fastify();
  registerOverloadGate(app, 1, () => false);
  let entered!: () => void;
  const routeEntered = new Promise<void>((resolve) => { entered = resolve; });
  app.get('/slow', async () => {
    entered();
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { ok: true };
  });
  app.get('/fast', async () => ({ ok: true }));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');

  const req = request({ host: '127.0.0.1', port: address.port, path: '/slow' });
  req.on('error', () => undefined);
  req.end();
  await routeEntered;
  assert.equal(gateInFlightNow(), 1);
  req.destroy();

  const deadline = Date.now() + 1000;
  while (gateInFlightNow() !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(gateInFlightNow(), 0, 'onRequestAbort 必须归还槽位');
  const result = await fetch(`http://127.0.0.1:${address.port}/fast`);
  assert.equal(result.status, 200, '断连后下一条请求应正常进入');
  await new Promise((resolve) => setTimeout(resolve, 140));
  assert.equal(gateInFlightNow(), 0, '迟到的 onResponse 不得二次释放成负数');
});
