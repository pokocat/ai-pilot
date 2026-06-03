// 知识库路由：列表 / 摄取（手动笔记 or 文档）/ 混合检索（供 @引用选择器与检索预览）/ 删除。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { ingestKnowledge, listKnowledge, deleteKnowledge } from '../services/knowledge.js';
import { hybridSearch } from '../services/retrieval.js';
import type { CreateKnowledgeRequest } from '../../../shared/contracts';

export async function knowledgeRoutes(app: FastifyInstance) {
  // 列表（可按项目/类型过滤）
  app.get<{ Querystring: { projectId?: string; kind?: string } }>('/knowledge', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return listKnowledge(user.tenantId, { projectId: req.query.projectId, kind: req.query.kind });
  });

  // 混合检索（向量 + 关键词），用于检索预览 / @引用候选
  app.get<{ Querystring: { q?: string; projectId?: string } }>('/knowledge/search', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const q = (req.query.q || '').trim();
    if (!q) return [];
    return hybridSearch({ tenantId: user.tenantId, projectId: req.query.projectId, query: q, topK: 8 });
  });

  // 摄取一条知识
  app.post<{ Body: CreateKnowledgeRequest }>('/knowledge', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const text = (req.body?.text || '').trim();
    if (!text) return reply.code(400).send({ error: '知识文本为空' });
    const item = await ingestKnowledge({
      tenantId: user.tenantId, userId: user.id, projectId: req.body.projectId ?? null,
      kind: req.body.kind ?? 'document', title: req.body.title ?? null, text,
      sourceType: (req.body.sourceType as 'manual') ?? 'manual', sourceId: req.body.sourceId ?? null,
      tags: req.body.tags ?? [],
    });
    return item;
  });

  app.delete<{ Params: { id: string } }>('/knowledge/:id', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await deleteKnowledge(user.tenantId, req.params.id);
    return { ok: true };
  });
}
