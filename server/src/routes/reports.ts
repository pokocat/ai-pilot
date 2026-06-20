// 版本化报告路由：列表 / 版本历史 / 某版本内容 / 两版差异 / 新存一版。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { saveReportVersion, getReportDiff, deliverableFrom } from '../services/reports.js';
import type {
  ReportItem, ReportDetail, ReportVersionItem, ReportVersionContent, SaveReportRequest,
} from '../../../shared/contracts';

export async function reportRoutes(app: FastifyInstance) {
  // 报告列表（可按项目过滤）
  app.get<{ Querystring: { projectId?: string } }>('/reports', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const rows = await prisma.reportDoc.findMany({
      where: { tenantId: user.tenantId, ...(req.query.projectId ? { projectId: req.query.projectId } : {}) },
      orderBy: { updatedAt: 'desc' },
      include: { agent: true },
    });
    const out: ReportItem[] = rows.map((d) => ({
      id: d.id, title: d.title, slug: d.slug, type: d.type, agentKey: d.agentKey,
      agentName: d.agent?.name, projectId: d.projectId, currentVersion: d.currentVersion,
      updatedAt: d.updatedAt.toISOString(),
    }));
    return out;
  });

  // 报告详情 + 版本历史
  app.get<{ Params: { id: string } }>('/reports/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const d = await prisma.reportDoc.findFirst({
      where: { id: req.params.id, tenantId: user.tenantId },
      include: { agent: true, versions: { orderBy: { version: 'desc' } } },
    });
    if (!d) return reply.code(404).send({ error: 'report not found' });
    const versions: ReportVersionItem[] = d.versions.map((v) => ({
      id: v.id, version: v.version, title: v.title, changeSummary: v.changeSummary,
      authorKind: v.authorKind, sessionId: v.sessionId, at: v.createdAt.toISOString(),
    }));
    const detail: ReportDetail = {
      id: d.id, title: d.title, slug: d.slug, type: d.type, agentKey: d.agentKey,
      agentName: d.agent?.name, projectId: d.projectId, currentVersion: d.currentVersion,
      updatedAt: d.updatedAt.toISOString(), versions,
    };
    return detail;
  });

  // 某个版本的完整内容（缺省取最新）
  app.get<{ Params: { id: string }; Querystring: { v?: string } }>('/reports/:id/version', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const d = await prisma.reportDoc.findFirst({ where: { id: req.params.id, tenantId: user.tenantId } });
    if (!d) return reply.code(404).send({ error: 'report not found' });
    const ver = req.query.v
      ? await prisma.reportVersion.findFirst({ where: { reportId: d.id, version: Number(req.query.v) } })
      : await prisma.reportVersion.findFirst({ where: { reportId: d.id }, orderBy: { version: 'desc' } });
    if (!ver) return reply.code(404).send({ error: 'version not found' });
    const out: ReportVersionContent = {
      reportId: d.id, version: ver.version, title: ver.title,
      content: deliverableFrom(ver.contentJson), at: ver.createdAt.toISOString(),
    };
    return out;
  });

  // 两版差异（read 时实时计算）
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/reports/:id/diff', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const d = await prisma.reportDoc.findFirst({ where: { id: req.params.id, tenantId: user.tenantId } });
    if (!d) return reply.code(404).send({ error: 'report not found' });
    const to = Number(req.query.to ?? d.currentVersion);
    const from = Number(req.query.from ?? Math.max(1, to - 1));
    const diff = await getReportDiff(user.tenantId, d.id, from, to);
    if (!diff) return reply.code(404).send({ error: 'version not found' });
    return diff;
  });

  // 新存一版（同名归一、同内容去重、自动变更摘要）
  app.post<{ Body: SaveReportRequest }>('/reports', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    if (!req.body?.title || !req.body?.content) return reply.code(400).send({ error: '缺少 title / content' });
    const saved = await saveReportVersion({
      tenantId: user.tenantId, userId: user.id, projectId: req.body.projectId ?? null,
      title: req.body.title, type: req.body.type || '成果', agentKey: req.body.agentKey ?? null,
      content: req.body.content, authorKind: req.body.authorKind ?? 'user', sessionId: req.body.sessionId ?? null,
    });
    return saved;
  });

  // 重命名报告（仅改展示名，不动 slug 归一键，避免影响版本归组）
  app.patch<{ Params: { id: string }; Body: { title?: string } }>('/reports/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const title = (req.body?.title ?? '').trim();
    if (!title) return reply.code(400).send({ error: '缺少 title', code: 'TITLE_REQUIRED' });
    const r = await prisma.reportDoc.updateMany({ where: { id: req.params.id, tenantId: user.tenantId }, data: { title } });
    if (r.count === 0) return reply.code(404).send({ error: 'report not found' });
    return { ok: true, title };
  });

  app.delete<{ Params: { id: string } }>('/reports/:id', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await prisma.reportDoc.deleteMany({ where: { id: req.params.id, tenantId: user.tenantId } });
    return { ok: true };
  });
}
