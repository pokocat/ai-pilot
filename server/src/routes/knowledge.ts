// 知识库路由：列表 / 文档上传 / 摄取（手动笔记）/ 详情(切片) / 重嵌 / 原件预览 / 混合检索 / 删除。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import {
  ingestKnowledge,
  listKnowledge,
  listKnowledgeDocs,
  getKnowledgeDetail,
  ingestUploadedFile,
  reembedItem,
  knowledgePreviewUrl,
  deleteKnowledge,
} from '../services/knowledge.js';
import { hybridSearch } from '../services/retrieval.js';
import type { CreateKnowledgeRequest } from '../../../shared/contracts';

export async function knowledgeRoutes(app: FastifyInstance) {
  // 列表（KnowledgeItemT，租户级，可按项目/类型过滤）——供 @引用候选等既有用途。
  app.get<{ Querystring: { projectId?: string; kind?: string } }>('/knowledge', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return listKnowledge(user.tenantId, { projectId: req.query.projectId, kind: req.query.kind });
  });

  // 文档视图（用户级：状态 + 文件元信息 + 切片数）——「我的资料库」用。
  app.get<{ Querystring: { projectId?: string } }>('/knowledge/docs', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return listKnowledgeDocs(user.tenantId, user.id, { projectId: req.query.projectId });
  });

  // 混合检索（向量 + 关键词），用于检索预览 / @引用候选
  app.get<{ Querystring: { q?: string; projectId?: string } }>('/knowledge/search', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const q = (req.query.q || '').trim();
    if (!q) return [];
    return hybridSearch({ tenantId: user.tenantId, userId: user.id, query: q, topK: 8 });
  });

  // 上传文档（multipart 单文件）→ 存原件 + 建 parsing item，立即返回 { id, status }，解析异步。
  app.post<{ Querystring: { projectId?: string } }>('/knowledge/upload', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    let data;
    try {
      data = await req.file();
    } catch {
      return reply.code(413).send({ error: '文件过大（上限 20MB）' });
    }
    if (!data) return reply.code(400).send({ error: '未收到文件' });
    let buf: Buffer;
    try {
      buf = await data.toBuffer();
    } catch {
      return reply.code(413).send({ error: '文件过大（上限 20MB）' });
    }
    if (data.file.truncated) return reply.code(413).send({ error: '文件过大（上限 20MB）' });
    if (!buf.length) return reply.code(400).send({ error: '空文件' });
    return ingestUploadedFile({
      tenantId: user.tenantId,
      userId: user.id,
      projectId: req.query.projectId ?? null,
      fileName: data.filename || '未命名文件',
      mime: data.mimetype,
      buf,
    });
  });

  // 摄取一条知识（手动笔记 / 文本）
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

  // 详情（含切片正文 + 每片向量维度）
  app.get<{ Params: { id: string } }>('/knowledge/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const detail = await getKnowledgeDetail(user.tenantId, req.params.id);
    if (!detail) return reply.code(404).send({ error: '知识项不存在' });
    return detail;
  });

  // 重嵌（从已存正文重新切片+向量化）
  app.post<{ Params: { id: string } }>('/knowledge/:id/reembed', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const detail = await getKnowledgeDetail(user.tenantId, req.params.id);
    if (!detail) return reply.code(404).send({ error: '知识项不存在' });
    return reembedItem(user.tenantId, req.params.id);
  });

  // 原件预览（有时限签名 URL）
  app.get<{ Params: { id: string } }>('/knowledge/:id/preview', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const url = await knowledgePreviewUrl(user.tenantId, req.params.id);
    if (!url) return reply.code(404).send({ error: '无原件可预览' });
    return { url };
  });

  app.delete<{ Params: { id: string } }>('/knowledge/:id', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await deleteKnowledge(user.tenantId, req.params.id);
    return { ok: true };
  });
}
