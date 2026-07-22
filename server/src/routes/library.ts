import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { recordFeedback } from '../services/memory.js';
import { saveReportVersion, hashContent } from '../services/reports.js';
import { recordAudit } from '../services/audit.js';
import type { MemoryConfig } from '../data/agents.js';

export async function libraryRoutes(app: FastifyInstance) {
  // 方案库列表（带版本化报告桥接信息）
  app.get('/library', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const items = await prisma.deliverable.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { agent: true },
    });
    // 取桥接报告的当前版本号，便于方案库直接展示「vN」并跳转看变更
    const reportIds = [...new Set(items.map((d) => d.reportId).filter(Boolean))] as string[];
    const docs = reportIds.length
      ? await prisma.reportDoc.findMany({ where: { id: { in: reportIds } }, select: { id: true, currentVersion: true } })
      : [];
    const verOf = new Map(docs.map((d) => [d.id, d.currentVersion]));
    return items.map((d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      agentKey: d.agentKey,
      agentName: d.agent.name,
      sessionId: d.sessionId,
      content: d.contentJson,
      at: d.createdAt,
      reportId: d.reportId,
      version: d.reportId ? verOf.get(d.reportId) : undefined,
      projectId: d.projectId,
    }));
  });

  // 存入方案库（同时桥接成「版本化报告」的新一版）
  // auto=true：报告收尾后的自动存入（非用户主动采纳）——跳过 adopt 反馈信号。
  app.post<{ Body: { title: string; type: string; agentKey: string; sessionId?: string; content: object; projectId?: string; auto?: boolean } }>(
    '/library',
    async (req) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const auto = req.body.auto === true;
      // 项目归属：优先入参，否则跟随会话
      let projectId = req.body.projectId ?? null;
      if (!projectId && req.body.sessionId) {
        const s = await prisma.session.findFirst({ where: { id: req.body.sessionId, userId: user.id }, select: { projectId: true } });
        projectId = s?.projectId ?? null;
      }
      // 1) 桥接：写一版版本化报告（同名归一、同内容去重、自动变更摘要）
      const saved = await saveReportVersion({
        tenantId: user.tenantId, userId: user.id, projectId,
        title: req.body.title, type: req.body.type, agentKey: req.body.agentKey,
        content: req.body.content, authorKind: 'user', sessionId: req.body.sessionId ?? null,
      });
      // 幂等去重：同一用户 + 同一 reportId + 同一内容（deliverable 表无 version/messageId 字段，按 contentJson 哈希比对——
      // 自动存入与随后手动「存入」内容一致即命中）。命中则直接返回已有条目，不重复 create / 不重复 recordFeedback / 不重复审计。
      const contentHash = hashContent(req.body.content);
      const existingSame = (await prisma.deliverable.findMany({
        where: { userId: user.id, reportId: saved.reportId },
        select: { id: true, createdAt: true, contentJson: true },
      })).find((row) => hashContent(row.contentJson as object) === contentHash);
      if (existingSame) {
        await recordAudit({
          tenantId: user.tenantId,
          userId: user.id,
          action: 'user.library.dedupe',
          payload: { deliverableId: existingSame.id, reportId: saved.reportId, version: saved.version, agentKey: req.body.agentKey, projectId, auto },
        });
        return { id: existingSame.id, at: existingSame.createdAt, reportId: saved.reportId, version: saved.version };
      }
      // 2) 方案库条目（保留原有平铺体验，并记录桥接的 reportId）
      const d = await prisma.deliverable.create({
        data: {
          tenantId: user.tenantId,
          userId: user.id,
          sessionId: req.body.sessionId ?? null,
          projectId,
          reportId: saved.reportId,
          agentKey: req.body.agentKey,
          title: req.body.title,
          type: req.body.type,
          contentJson: req.body.content,
          status: 'ready',
        },
      });
      // 反馈回流：手动存入 = 采纳信号；自动存入不算用户采纳，跳过 adopt。
      if (!auto) {
        const agent = await prisma.agent.findUnique({ where: { key: req.body.agentKey } });
        if (agent) {
          await recordFeedback({
            tenantId: user.tenantId,
            userId: user.id,
            agentKey: req.body.agentKey,
            cfg: agent.memoryConfig as unknown as MemoryConfig,
            signal: 'adopt',
            title: req.body.title,
          });
        }
      }
      await recordAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'user.library.create',
        payload: { deliverableId: d.id, reportId: saved.reportId, version: saved.version, agentKey: req.body.agentKey, projectId, auto },
      });
      return { id: d.id, at: d.createdAt, reportId: saved.reportId, version: saved.version };
    },
  );

  app.delete<{ Params: { id: string } }>('/library/:id', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await prisma.deliverable.deleteMany({ where: { id: req.params.id, userId: user.id } });
    await recordAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'user.library.delete',
      payload: { deliverableId: req.params.id },
    });
    return { ok: true };
  });
}
