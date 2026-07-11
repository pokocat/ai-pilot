// 知识库路由：列表 / 文档上传 / 摄取（手动笔记）/ 详情(切片) / 重嵌 / 原件预览 / 混合检索 / 经营体检 / 删除。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
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
import { ingestStagedFile, newBatchId } from '../services/knowledgePipeline.js';
import { looksFinancial } from '../services/finParse.js';
import { runFinCheckup } from '../services/finCheckup.js';
import { isModuleEnabled } from '../services/modules.js';
import { reserveQuota, assertPlanActive, type QuotaReservation } from '../services/tokenQuota.js';
import { structuredBillTokens } from '../llm/gateway.js';
import { cacheGet, cacheSet } from '../services/cache.js';
import { now } from '../services/clock.js';
import type { AnalyzeResult, CreateKnowledgeRequest } from '../../../shared/contracts';

// WO-09 经营体检门禁/计费（吸取 P0-1 教训，对齐 quickscan/brandKit 口径）。
const FIN_DAILY_LIMIT = 3;   // 每用户每日体检次数（真实模型调用 + 成版，防资损）
const FIN_RATIO = 0.3;       // token 轴计费 ratio 低配（对齐 quickscan）
const FIN_EST_TOKENS = 1500; // 体检调用估算 token（structured() 暂不回传真实用量，走保守估算）
const DAY_MS = 24 * 60 * 60 * 1000;
function finDayKey(): string {
  const d = now();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

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
  // V7-06：staged=true 时走「待整理」通道——建 stage='staging' 条目 + docParse 存文本，**不切片不嵌入**
  //（对检索天然不可见），并挂 batchId（可由 query 传入以聚合「同批上传」；否则逐请求生成）；受本月免费额度门禁。
  // 非 staged（默认，如对话内上传）维持原行为：直入库 + 异步解析嵌入，既有动线不破坏。
  app.post<{ Querystring: { projectId?: string; staged?: string; batchId?: string } }>('/knowledge/upload', async (req, reply) => {
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

    const staged = req.query.staged === 'true' || req.query.staged === '1';
    if (staged) {
      try {
        return await ingestStagedFile({
          tenantId: user.tenantId,
          userId: user.id,
          projectId: req.query.projectId ?? null,
          fileName: data.filename || '未命名文件',
          mime: data.mimetype,
          buf,
          batchId: (req.query.batchId || '').trim() || newBatchId(),
        });
      } catch (e) {
        const err = e as Error & { statusCode?: number; code?: string };
        return reply.code(err.statusCode ?? 402).send({ error: err.message, code: err.code });
      }
    }

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

  // 经营体检（WO-09）：财务/表格类知识条目 → 结构化派生指标 → 5 段体检报告成版。
  // 门禁：finance 模块（fin-checkup SKU）已购（未购 402 SKU_REQUIRED）；套餐未过期（assertPlanActive）。
  // 计费：reserveQuota(0.3) 预留 → 结构化调用按 P1-3 口径保守结算 → 失败 refund；每日 3 次限流。
  app.post<{ Params: { id: string } }>('/knowledge/:id/analyze', async (req, reply): Promise<AnalyzeResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);

    const item = await prisma.knowledgeItem.findFirst({
      where: { id: req.params.id, tenantId: user.tenantId },
      select: { id: true, text: true, title: true, fileName: true, status: true, projectId: true },
    });
    if (!item) return reply.code(404).send({ error: '知识项不存在', code: 'NOT_FOUND' });
    if (item.status !== 'ready' || !looksFinancial(item.text)) {
      return reply.code(422).send({ error: '该资料不是可体检的财务/经营表', code: 'NOT_ANALYZABLE' });
    }

    // 门禁：fin-checkup 是「购买后解锁、可反复用」的 module 类 SKU（非一次性核销）——查 finance 模块是否已购。
    if (!(await isModuleEnabled(user.tenantId, user.id, 'finance'))) {
      return reply.code(402).send({ error: '经营体检需先购买', code: 'SKU_REQUIRED', skuKey: 'fin-checkup' });
    }

    // 限流 3/日（先于额度：超限的请求不应消耗额度/触发真实调用）。
    const rlKey = `fincheckup:rl:${user.id}:${finDayKey()}`;
    const used = (await cacheGet<number>(rlKey)) ?? 0;
    if (used >= FIN_DAILY_LIMIT) {
      return reply.code(429).send({ error: '今天的经营体检次数已用完，明天再来', code: 'RATE_LIMITED' });
    }

    await assertPlanActive(user.id); // 套餐过期 → PLAN_EXPIRED(403)
    let reservation: QuotaReservation | undefined;
    try {
      reservation = await reserveQuota(user.id, FIN_RATIO);
      const profile = await prisma.profile.findFirst({ where: { tenantId: user.tenantId }, orderBy: { updatedAt: 'desc' }, select: { industry: true } });
      const { reportId, version, ok, attempts } = await runFinCheckup({
        tenantId: user.tenantId,
        userId: user.id,
        itemId: item.id,
        projectId: item.projectId,
        title: `经营体检 · ${(item.title || item.fileName || '上传资料').slice(0, 40)}`,
        text: item.text,
        fileName: item.fileName,
        industry: profile?.industry ?? null,
      });
      // P1-3：校验失败但已真实调用（attempts>0）时按轮次保守结算，不因 mock 兜底而全额退。
      await reservation.settle(structuredBillTokens({ ok, attempts, estTokens: FIN_EST_TOKENS }), FIN_RATIO);
      await cacheSet(rlKey, used + 1, DAY_MS); // 仅成功后计一次限流
      return { reportId, version };
    } catch (err) {
      if (reservation) await reservation.refund().catch(() => {});
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>('/knowledge/:id', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await deleteKnowledge(user.tenantId, req.params.id);
    return { ok: true };
  });
}
