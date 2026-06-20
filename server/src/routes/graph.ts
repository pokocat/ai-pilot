// 时序知识图谱路由：手动抽取入图 / 实体列表 / as-of 关系查询。
// 抽取依赖真实模型（mock 时返回空，不误造关系）。租户级隔离。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { ingestTextToGraph, upsertTriples, queryRelations, listEntities, type Triple } from '../services/knowledgeGraph.js';

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
      const r = await ingestTextToGraph(user.tenantId, b.projectId ?? null, text, { source: b.source ?? 'conversation' });
      return r;
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
