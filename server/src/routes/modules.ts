// V7-08：能力/模块中心路由。GET 目录×用户态；POST 启用（tier 分流）；PATCH 隐藏/排序（我的页模块管理）。
// resolveUser 行级鉴权在前；未知 key → 404；领域错误（SKU_REQUIRED 402 / INSUFFICIENT_CREDITS 402 / PLAN_EXPIRED 403）
// 在处理器边界转 { error, code } 原样下发（sku 额外带 skuKey 供前端跳转支付）。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { getModule } from '../data/modules.js';
import { listForUser, enable, patchModule } from '../services/modules.js';

export async function moduleRoutes(app: FastifyInstance) {
  // 能力面板：目录 + 用户启用态 + 推荐位
  app.get('/modules', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return listForUser({ tenantId: user.tenantId, userId: user.id });
  });

  // 启用能力（free 直启 / credits 扣算力 / sku 校验已购 / member 校验套餐）
  app.post<{ Params: { key: string } }>('/modules/:key/enable', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const { key } = req.params;
    if (!getModule(key)) return reply.code(404).send({ error: '能力不存在', code: 'MODULE_NOT_FOUND' });
    try {
      const module = await enable({ tenantId: user.tenantId, userId: user.id, moduleKey: key });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.module.enable', payload: { moduleKey: key, tier: module.tier } });
      return { module };
    } catch (e) {
      const err = e as Error & { statusCode?: number; code?: string; skuKey?: string };
      return reply.code(err.statusCode ?? 402).send({ error: err.message, code: err.code, skuKey: err.skuKey });
    }
  });

  // 隐藏 / 排序（我的页模块管理）
  app.patch<{ Params: { key: string }; Body: { hidden?: boolean; sortOrder?: number } }>('/modules/:key', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const { key } = req.params;
    if (!getModule(key)) return reply.code(404).send({ error: '能力不存在', code: 'MODULE_NOT_FOUND' });
    const module = await patchModule({
      tenantId: user.tenantId,
      userId: user.id,
      moduleKey: key,
      hidden: req.body?.hidden,
      sortOrder: req.body?.sortOrder,
    });
    return { module };
  });
}
