// V7-12：单次付费商品（SKU）路由。下单复用 wechatPay JSAPI + PaymentOrder 幂等底座（订单挂 skuKey），
// 支付回调 markPaidAndApply 按 skuKey 分流发放权益（模块启用/一次性服务/空间加档）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { payConfigured, createJsapiOrder, payMockSuccessEnabled, resolvePayerOpenid } from '../services/wechatPay.js';
import { sandboxEnabled } from '../services/sandbox.js';
import { parseAttribution } from '../services/activation.js';
import { skuPackAmount } from '../services/purchase.js';
import { getBalance } from '../services/credits.js';
import type { SkuView, SkuOrderResult } from '../../../shared/contracts';

function publicSku(s: { key: string; name: string; desc: string; priceFen: number; kind: string; grantsModuleKey: string | null; metaJson: unknown }): SkuView {
  // 钻石增购包把颗数带给端上（钻石是对外货币口径，端上到处显示颗数）。
  // **算力增购包不下发 amount**：token 数是成本口径，价格一除就是每 token 售价，据此可反推
  // 供应商成本与毛利——属商业机密。端上文案藏了但公开接口照给，等于没藏（curl /skus 即可见）。
  // 发放侧不受影响：markPaidAndApply 读库里的 metaJson.amount，从不信端上回传的数量。
  const isCreditsPack = s.kind === 'credits';
  return {
    key: s.key, name: s.name, desc: s.desc, priceFen: s.priceFen,
    kind: s.kind as SkuView['kind'], grantsModuleKey: s.grantsModuleKey,
    ...(isCreditsPack ? { amount: skuPackAmount(s.metaJson) } : {}),
  };
}

export async function skuRoutes(app: FastifyInstance) {
  app.get('/skus', async (): Promise<SkuView[]> => {
    const skus = await prisma.sku.findMany({ where: { enabled: true }, orderBy: { sort: 'asc' } });
    return skus.map(publicSku);
  });

  // 单次付费下单：与 /plans/:id/order 同口径，订单挂 skuKey。需配齐支付或开启沙箱。
  app.post<{ Params: { key: string }; Body: { openid?: string; source?: string; refId?: string } }>('/skus/:key/order', async (req, reply): Promise<SkuOrderResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const sku = await prisma.sku.findUnique({ where: { key: req.params.key } });
    if (!sku || !sku.enabled) return reply.code(404).send({ error: '商品不存在', code: 'SKU_NOT_FOUND' });
    // PAY_MOCK_SUCCESS 一并放行（与 /plans/:id/order 同口径）：真实建单，只把「调微信」换成 /pay/mock/pay。
    if (!payConfigured() && !sandboxEnabled() && !payMockSuccessEnabled()) {
      return reply.code(501).send({ error: '微信支付未配置', code: 'PAYMENT_NOT_CONFIGURED' });
    }
    if (sku.priceFen <= 0) return reply.code(400).send({ error: '免费商品无需支付', code: 'SKU_FREE' });
    // 钻石不限量（企业版余额哨兵 -1）用户禁买钻石增购包：grantCredits 对不限量余额发放会把 -1
    // 写成有限值（isUnlimited(bal) ? amount）——收了钱还把权益降级。入账侧另有兜底（applySkuGrant）。
    if (sku.kind === 'credits' && (await getBalance(user.id)) < 0) {
      return reply.code(409).send({ error: '当前套餐钻石不限量，无需购买增购包', code: 'CREDITS_UNLIMITED' });
    }
    // openid 取值与 /plans/:id/order 同一函数（resolvePayerOpenid）：body 值只在等于调用者自己的
    // wechatOpenId 时被采纳，否则忽略 → 落到下面这行 OPENID_REQUIRED。理由见该函数注释。
    const openid = resolvePayerOpenid(user, req.body?.openid);
    if (!openid) return reply.code(400).send({ error: '缺少支付用户 openid', code: 'OPENID_REQUIRED' });
    // D-1 开通来源归因：下单时带入 source/refId，随订单落库，支付回调发放权益时写 ActivationEvent。
    const attribution = parseAttribution(req.body?.source, req.body?.refId);
    try {
      const r = await createJsapiOrder({ user, sku: { key: sku.key, name: sku.name, priceFen: sku.priceFen }, openid, attribution });
      return { orderId: r.outTradeNo, payParams: r.pay, ...(r.mock ? { mock: true as const } : {}) };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? '下单失败', code: err.code ?? 'WECHAT_PAY_CREATE_FAILED' });
    }
  });
}
