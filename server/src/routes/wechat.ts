// 微信开放平台/小程序后台「消息推送」回调。
// GET 用于后台填写 URL 时的 echostr 验签；POST 先验签再返回 success，后续可在此扩展客服/订阅消息事件处理。
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveUser } from '../services/context.js';
import { verifyWechatMessageSignature, wechatMessageToken } from '../services/wechat.js';
import { recordWechatSubscribeChoices, wechatSubscribeTemplates } from '../services/wechatSubscribe.js';
import type { WechatSubscribeChoice } from '../../../shared/contracts';

const verifyQuerySchema = z.object({
  signature: z.string().trim().min(1),
  timestamp: z.string().trim().min(1),
  nonce: z.string().trim().min(1),
  echostr: z.string().min(1).max(2048).optional(),
});
const subscribeSceneSchema = z.enum(['review', 'report']);
const subscribeStatusSchema = z.enum(['accept', 'reject', 'ban', 'filter']);
const subscribeRecordSchema = z.object({
  choices: z.array(z.object({
    scene: subscribeSceneSchema,
    templateId: z.string().trim().min(1).max(128),
    status: subscribeStatusSchema,
  })).min(1).max(5),
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

  // 小程序订阅消息模板配置：只返回已配置模板。Template ID 不是密钥，但仍要求登录，
  // 避免未登录态误弹订阅授权，也便于按用户记录一次性额度。
  app.get('/wechat/subscribe/templates', async (req) => {
    await resolveUser(req.headers['x-user-id'] as string | undefined);
    return wechatSubscribeTemplates();
  });

  // 前端 wx.requestSubscribeMessage 的结果回写：accept 才累计一次可发送额度；
  // reject/ban/filter 只记录状态，不把拒绝当成可触达。
  app.post<{ Body: { choices: WechatSubscribeChoice[] } }>('/wechat/subscribe', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const parsed = subscribeRecordSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '订阅结果格式不正确', code: 'BAD_SUBSCRIBE_RESULT' });
    const r = await recordWechatSubscribeChoices({
      tenantId: user.tenantId,
      userId: user.id,
      choices: parsed.data.choices,
    });
    return { ok: true, accepted: r.accepted };
  });

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
