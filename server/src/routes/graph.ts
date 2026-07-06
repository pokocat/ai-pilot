// 时序知识图谱路由：手动抽取入图 / 实体列表 / as-of 关系查询。
// 抽取依赖真实模型（mock 时返回空，不误造关系）。租户级隔离。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { ingestTextToGraph, upsertTriples, queryRelations, listEntities, type Triple } from '../services/knowledgeGraph.js';
import { assertPlanActive, reserveQuota, RESERVE_TOKENS, type QuotaReservation } from '../services/tokenQuota.js';
import { hasLiveProvider } from '../llm/gateway.js';

export async function graphRoutes(app: FastifyInstance) {
  // 从文本抽取并入图（运营/对话汇总可调）。也可直接传 triples 手工录入。
  app.post<{ Body: { text?: string; projectId?: string; triples?: Triple[]; source?: string } }>(
    '/graph/extract',
    async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const b = req.body ?? {};
      if (b.triples?.length) {
        const r = await upsertTriples(user.tenantId, b.projectId ?? null, b.triples, { source: b.source ?? 'manual' });
        return r;
      }
      const text = (b.text ?? '').trim();
      if (!text) return reply.code(400).send({ error: '缺少 text 或 triples', code: 'TEXT_REQUIRED' });
      // text 分支会触发真实模型抽取，须与 /generate* 同口径受套餐到期锁 + 月度额度门禁 + 实际扣减；
      // 手工 triples 分支不涉及模型调用，不受此限。
      // extractGraphTriples 走 rawJson，不回传真实 token 用量，故不能只 ensureQuota(仅判断放行、从不扣减)——
      // 那样只要余额一次性 >0 就能无限次触发真实模型调用，额度系统形同虚设。改用与 /generate* 一致的
      // reserveQuota 预留 + 按 RESERVE_TOKENS 定额结算（成功=全额扣留，失败=退回）。
      let quotaReservation: QuotaReservation | null = null;
      try {
        await assertPlanActive(user.id);
        quotaReservation = await reserveQuota(user.id, 1);
      } catch (e) {
        const err = e as Error & { statusCode?: number; code?: string };
        return reply.code(err.statusCode ?? 402).send({ error: err.message, code: err.code });
      }
      try {
        // mock/demo（未配置真实模型）下 extractGraphTriples 直接短路返回空、无真实成本 → 全额退回预留，
        // 与 /generate* 的 mock 路径（usage=ZERO_USAGE → settle(0) 全退）同一口径，避免误扣。
        const live = await hasLiveProvider();
        const r = await ingestTextToGraph(user.tenantId, b.projectId ?? null, text, { source: b.source ?? 'conversation' });
        await quotaReservation.settle(live ? RESERVE_TOKENS : 0, 1);
        return r;
      } catch (err) {
        await quotaReservation.refund().catch(() => {});
        throw err;
      }
    },
  );

  // 实体列表
  app.get<{ Querystring: { projectId?: string; limit?: string } }>('/graph/entities', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return listEntities(user.tenantId, req.query.projectId, Number(req.query.limit ?? 100));
  });

  // as-of 关系查询：?entity=&predicate=&asOf=ISO&projectId= 。不传 asOf=当前有效。
  app.get<{ Querystring: { entity?: string; predicate?: string; asOf?: string; projectId?: string; limit?: string } }>(
    '/graph/relations',
    async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      let asOf: Date | undefined;
      if (req.query.asOf) {
        asOf = new Date(req.query.asOf);
        if (Number.isNaN(asOf.getTime())) return reply.code(400).send({ error: 'asOf 时间格式非法', code: 'BAD_AS_OF' });
      }
      return queryRelations(user.tenantId, {
        entity: req.query.entity, predicate: req.query.predicate, asOf,
        projectId: req.query.projectId, limit: Number(req.query.limit ?? 100),
      });
    },
  );
}
