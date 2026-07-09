// V7-12：单次付费商品（SKU）路由。下单复用 wechatPay JSAPI + PaymentOrder 幂等底座（订单挂 skuKey），
// 支付回调 markPaidAndApply 按 skuKey 分流发放权益（模块启用/一次性服务/空间加档）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { payConfigured, createJsapiOrder } from '../services/wechatPay.js';
import { sandboxEnabled } from '../services/sandbox.js';
import type { SkuView, SkuOrderResult } from '../../../shared/contracts';

function publicSku(s: { key: string; name: string; desc: string; priceFen: number; kind: string; grantsModuleKey: string | null }): SkuView {
  return { key: s.key, name: s.name, desc: s.desc, priceFen: s.priceFen, kind: s.kind as SkuView['kind'], grantsModuleKey: s.grantsModuleKey };
}

export async function skuRoutes(app: FastifyInstance) {
  app.get('/skus', async (): Promise<SkuView[]> => {
    const skus = await prisma.sku.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } });
    return skus.map(publicSku);
  });

  // 单次付费下单：与 /plans/:id/order 同口径，订单挂 skuKey。需配齐支付或开启沙箱。
  app.post<{ Params: { key: string }; Body: { openid?: string } }>('/skus/:key/order', async (req, reply): Promise<SkuOrderResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const sku = await prisma.sku.findUnique({ where: { key: req.params.key } });
    if (!sku || !sku.enabled) return reply.code(404).send({ error: '商品不存在', code: 'SKU_NOT_FOUND' });
    if (!payConfigured() && !sandboxEnabled()) return reply.code(501).send({ error: '微信支付未配置', code: 'PAYMENT_NOT_CONFIGURED' });
    if (sku.priceFen <= 0) return reply.code(400).send({ error: '免费商品无需支付', code: 'SKU_FREE' });
    const openid = (req.body?.openid || (user as { wechatOpenId?: string | null }).wechatOpenId || '').trim();
    if (!openid) return reply.code(400).send({ error: '缺少支付用户 openid', code: 'OPENID_REQUIRED' });
    try {
      const r = await createJsapiOrder({ user, sku: { key: sku.key, name: sku.name, priceFen: sku.priceFen }, openid });
      return { orderId: r.outTradeNo, payParams: r.pay };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? '下单失败', code: err.code ?? 'WECHAT_PAY_CREATE_FAILED' });
    }
  });
}
