// 微信开放平台/小程序后台「消息推送」回调。
// GET 用于后台填写 URL 时的 echostr 验签；POST 先验签再返回 success，后续可在此扩展客服/订阅消息事件处理。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifyWechatMessageSignature, wechatMessageToken } from '../services/wechat.js';

const verifyQuerySchema = z.object({
  signature: z.string().trim().min(1),
  timestamp: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  echostr: z.string().min(1).max(2048).optional(),
});

function registerXmlBodyParser(app: FastifyInstance) {
  const parseXml = (req: FastifyRequest, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) => {
    const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    (req as typeof req & { rawBody?: string }).rawBody = raw;
    done(null, raw);
  };
  app.addContentTypeParser(/^text\/xml(?:;.*)?$/i, { parseAs: 'string' }, parseXml);
  app.addContentTypeParser(/^application\/xml(?:;.*)?$/i, { parseAs: 'string' }, parseXml);
}

export async function wechatRoutes(app: FastifyInstance) {
  registerXmlBodyParser(app);

  app.get('/wechat/message', async (req, reply) => {
    const parsed = verifyQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).type('text/plain').send('bad request');
    if (!wechatMessageToken()) return reply.code(500).type('text/plain').send('wechat message token not configured');
    const ok = verifyWechatMessageSignature(parsed.data);
    if (!ok) return reply.code(401).type('text/plain').send('invalid signature');
    return reply.type('text/plain').send(parsed.data.echostr ?? '');
  });

  app.post('/wechat/message', async (req, reply) => {
    const parsed = verifyQuerySchema.omit({ echostr: true }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).type('text/plain').send('bad request');
    if (!wechatMessageToken()) return reply.code(500).type('text/plain').send('wechat message token not configured');
    const ok = verifyWechatMessageSignature(parsed.data);
    if (!ok) return reply.code(401).type('text/plain').send('invalid signature');
    // 当前只完成可信接收握手；正式事件业务可在验签后读取 req.rawBody / req.body 继续处理。
    return reply.type('text/plain').send('success');
  });
}
