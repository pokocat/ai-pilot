// V7-06 智库三段式资料整理管道路由：总览 / 粗分整理 / 确认入库 / 深度整理。
// 领域错误（{statusCode,code}）在处理器边界原样转发；每个处理器先 resolveUser（tenant+user 隔离）。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { buildPipeline, organizeBatch, confirmItems, deepOrganize } from '../services/knowledgePipeline.js';
import { reserveQuota, assertPlanActive, type QuotaReservation } from '../services/tokenQuota.js';
import { structuredBillTokens } from '../llm/gateway.js';

type DomainError = Error & { statusCode?: number; code?: string; skuKey?: string };

// 深度整理精炼摘要的 token 轴计费口径（对齐 quickscan/经营体检付费路径：ratio 0.3 + 保守结算 + 失败退款）。
const DEEP_RATIO = 0.3;
const DEEP_EST_TOKENS = 600; // 每轮精炼摘要估算 token（structured 暂不回传真实用量，走保守估算）

export async function knowledgePipelineRoutes(app: FastifyInstance) {
  // 管道总览：counts / quota / folders / batches（全部服务端计数）。
  app.get('/knowledge/pipeline', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return buildPipeline({ tenantId: user.tenantId, userId: user.id });
  });

  // 粗分整理：去重 + 归类 + 摘要 → 批次内条目置 optimized。
  app.post<{ Body: { batchId?: string } }>('/knowledge/organize', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const batchId = (req.body?.batchId || '').trim();
    if (!batchId) return reply.code(400).send({ error: '缺少 batchId' });
    try {
      const r = await organizeBatch({ tenantId: user.tenantId, userId: user.id, batchId });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.knowledge.organize', payload: { batchId, total: r.total, dedup: r.dedup } });
      return r;
    } catch (e) {
      const err = e as DomainError;
      return reply.code(err.statusCode ?? 500).send({ error: err.message, code: err.code });
    }
  });

  // 确认入库：optimized/staging → confirmed，此时才切片+嵌入（唯一嵌入发生点）。
  app.post<{ Body: { ids?: string[]; batchId?: string } }>('/knowledge/confirm', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const ids = Array.isArray(req.body?.ids) ? req.body!.ids : undefined;
    const batchId = (req.body?.batchId || '').trim() || undefined;
    try {
      const r = await confirmItems({ tenantId: user.tenantId, userId: user.id, ids, batchId });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.knowledge.confirm', payload: { count: r.count, ingested: r.ingested } });
      return r;
    } catch (e) {
      const err = e as DomainError;
      return reply.code(err.statusCode ?? 400).send({ error: err.message, code: err.code });
    }
  });

  // 深度整理：未购 SKU → 402 SKU_REQUIRED（前端接 PaySheet）；已购 → organize 加强版。
  app.post<{ Body: { batchId?: string } }>('/knowledge/deep-organize', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const batchId = (req.body?.batchId || '').trim();
    if (!batchId) return reply.code(400).send({ error: '缺少 batchId' });
    let reservation: QuotaReservation | undefined;
    try {
      // ¥39 SKU 核销在 service 内（原子、幂等）；此处仅对精炼摘要的 LLM 调用接 token 额度。
      await assertPlanActive(user.id); // 套餐过期 → PLAN_EXPIRED(403)
      reservation = await reserveQuota(user.id, DEEP_RATIO);
      const r = await deepOrganize({ tenantId: user.tenantId, userId: user.id, batchId });
      // 保守结算：校验通过按定额、真实调用但失败按轮次、mock（attempts=0）不实扣。
      await reservation.settle(structuredBillTokens({ ok: r.meterOk, attempts: r.meterAttempts, estTokens: DEEP_EST_TOKENS }), DEEP_RATIO);
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.knowledge.deepOrganize', payload: { batchId, reportId: r.reportId } });
      return r;
    } catch (e) {
      if (reservation) await reservation.refund().catch(() => {});
      const err = e as DomainError;
      return reply.code(err.statusCode ?? 402).send({ error: err.message, code: err.code, skuKey: err.skuKey });
    }
  });
}
