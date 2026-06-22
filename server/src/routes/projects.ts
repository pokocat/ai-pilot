// 项目（企业事务主线）路由：CRUD + 项目详情（聚合会话/报告/知识）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { slugify } from '../services/reports.js';
import type {
  ProjectItem, ProjectDetail, CreateProjectRequest, UpdateProjectRequest,
  SessionItem, ReportItem, KnowledgeItemT,
} from '../../../shared/contracts';

function isUniqueConflict(e: unknown): boolean {
  return (e as { code?: string }).code === 'P2002';
}

function slugCandidate(base: string, attempt: number): string {
  if (attempt === 0) return base;
  return `${base}-${Date.now().toString(36).slice(-4)}-${attempt}`;
}

async function counts(projectId: string) {
  const [sessions, reports, knowledge] = await Promise.all([
    prisma.session.count({ where: { projectId } }),
    prisma.reportDoc.count({ where: { projectId } }),
    prisma.knowledgeItem.count({ where: { projectId } }),
  ]);
  return { sessions, reports, knowledge };
}

export async function projectRoutes(app: FastifyInstance) {
  // 列表（带各项计数）
  app.get('/projects', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const rows = await prisma.project.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { updatedAt: 'desc' },
    });
    const out: ProjectItem[] = [];
    for (const p of rows) {
      out.push({
        id: p.id, name: p.name, slug: p.slug, icon: p.icon,
        summary: p.summary, status: p.status as ProjectItem['status'],
        counts: await counts(p.id), updatedAt: p.updatedAt.toISOString(),
      });
    }
    return out;
  });

  // 新建
  app.post<{ Body: CreateProjectRequest }>('/projects', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const name = (req.body.name || '').trim();
    if (!name) return reply.code(400).send({ error: '项目名不能为空' });
    const baseSlug = slugify(name);
    for (let attempt = 0; attempt < 5; attempt++) {
      const slug = slugCandidate(baseSlug, attempt);
      try {
        const p = await prisma.project.create({
          data: {
            tenantId: user.tenantId, userId: user.id, name, slug,
            icon: req.body.icon || 'layers', summary: req.body.summary ?? null,
          },
        });
        return { id: p.id, name: p.name, slug: p.slug };
      } catch (e) {
        if (isUniqueConflict(e)) continue;
        throw e;
      }
    }
    return reply.code(409).send({ error: '项目名冲突，请换一个名称', code: 'PROJECT_SLUG_CONFLICT' });
  });

  // 详情（聚合会话 / 报告 / 知识）
  app.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const p = await prisma.project.findFirst({ where: { id: req.params.id, tenantId: user.tenantId } });
    if (!p) return reply.code(404).send({ error: 'project not found' });

    const [sessionsRaw, reportsRaw, knowledgeRaw] = await Promise.all([
      prisma.session.findMany({ where: { projectId: p.id }, orderBy: { updatedAt: 'desc' }, include: { agent: true, messages: { orderBy: { createdAt: 'desc' }, take: 1 } } }),
      prisma.reportDoc.findMany({ where: { projectId: p.id }, orderBy: { updatedAt: 'desc' }, include: { agent: true } }),
      prisma.knowledgeItem.findMany({ where: { projectId: p.id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    ]);

    const sessions: SessionItem[] = sessionsRaw.map((s) => {
      const last = s.messages[0];
      let snippet = '新对话';
      if (last) { const c = last.contentJson as { text?: string; title?: string }; snippet = c.text || (c.title ? `已产出《${c.title}》` : '已回复'); }
      return { id: s.id, agentKey: s.agentKey, agentName: s.agent.name, agentIcon: s.agent.icon, title: s.title, snippet, updatedAt: s.updatedAt.toISOString(), projectId: s.projectId };
    });
    const reports: ReportItem[] = reportsRaw.map((d) => ({
      id: d.id, title: d.title, slug: d.slug, type: d.type, agentKey: d.agentKey,
      agentName: d.agent?.name, projectId: d.projectId, currentVersion: d.currentVersion, updatedAt: d.updatedAt.toISOString(),
    }));
    const knowledge: KnowledgeItemT[] = knowledgeRaw.map((k) => ({
      id: k.id, projectId: k.projectId, kind: k.kind as KnowledgeItemT['kind'], title: k.title,
      text: k.text, sourceType: k.sourceType, sourceId: k.sourceId,
      tags: Array.isArray(k.tagsJson) ? (k.tagsJson as string[]) : [], at: k.createdAt.toISOString(),
    }));

    const detail: ProjectDetail = {
      id: p.id, name: p.name, slug: p.slug, icon: p.icon, summary: p.summary,
      status: p.status as ProjectDetail['status'], counts: await counts(p.id),
      updatedAt: p.updatedAt.toISOString(), sessions, reports, knowledge,
    };
    return detail;
  });

  // 更新（改名/摘要/归档）
  app.put<{ Params: { id: string }; Body: UpdateProjectRequest }>('/projects/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const p = await prisma.project.findFirst({ where: { id: req.params.id, tenantId: user.tenantId } });
    if (!p) return reply.code(404).send({ error: 'project not found' });
    let updated;
    try {
      updated = await prisma.project.update({
        where: { id: p.id },
        data: {
          ...(req.body.name ? { name: req.body.name, slug: slugify(req.body.name) } : {}),
          ...(req.body.icon ? { icon: req.body.icon } : {}),
          ...(req.body.summary !== undefined ? { summary: req.body.summary } : {}),
          ...(req.body.status ? { status: req.body.status } : {}),
        },
      });
    } catch (e) {
      if (isUniqueConflict(e)) {
        return reply.code(409).send({ error: '项目名已存在，请换一个名称', code: 'PROJECT_SLUG_CONFLICT' });
      }
      throw e;
    }
    return { ok: true, updatedAt: updated.updatedAt.toISOString() };
  });

  // 删除（解绑其下会话/报告/知识的归属，不级联删数据，避免误删用户资产）
  app.delete<{ Params: { id: string } }>('/projects/:id', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const p = await prisma.project.findFirst({ where: { id: req.params.id, tenantId: user.tenantId } });
    if (!p) return { ok: true };
    await prisma.$transaction([
      prisma.session.updateMany({ where: { projectId: p.id }, data: { projectId: null } }),
      prisma.reportDoc.updateMany({ where: { projectId: p.id }, data: { projectId: null } }),
      prisma.knowledgeItem.updateMany({ where: { projectId: p.id }, data: { projectId: null } }),
      prisma.memory.updateMany({ where: { projectId: p.id }, data: { projectId: null } }),
      prisma.project.delete({ where: { id: p.id } }),
    ]);
    return { ok: true };
  });
}
