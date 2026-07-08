// 预言账本路由（M2 PR-9）：列表/显式记录/验证。命中率只由服务端算；按 userId 行级隔离。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { disputeProphecy, listProphecies, prophecyStats, recordProphecy, verifyProphecy } from '../services/prophecyLog.js';

export async function prophecyRoutes(app: FastifyInstance) {
  app.get('/prophecies', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const [items, stats] = await Promise.all([listProphecies(user.id), prophecyStats(user.id)]);
    return { items, stats };
  });

  // 显式记录（复盘/对话中军师给出预言时的落账入口）
  app.post<{ Body: { prophecy: string; basis?: string; verifyStandard?: string; dueDate?: string } }>(
    '/prophecies',
    async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      if (!String(req.body?.prophecy ?? '').trim()) return reply.code(400).send({ error: '预言内容不能为空' });
      const p = await recordProphecy({
        tenantId: user.tenantId,
        userId: user.id,
        prophecy: req.body.prophecy,
        basis: req.body.basis,
        verifyStandard: req.body.verifyStandard,
        dueDate: req.body.dueDate ?? null,
      });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.prophecy.create', payload: { seq: p.seq } });
      return { prophecy: p };
    },
  );

  // 对账验证（月复盘天机验证入口）：hit / miss + 事实记录
  app.post<{ Params: { id: string }; Body: { outcome: 'hit' | 'miss'; note?: string } }>(
    '/prophecies/:id/verify',
    async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const outcome = req.body?.outcome;
      if (outcome !== 'hit' && outcome !== 'miss') return reply.code(400).send({ error: 'outcome 必须是 hit 或 miss' });
      const p = await verifyProphecy({ userId: user.id, prophecyId: req.params.id, outcome, note: req.body?.note });
      if (!p) return reply.code(404).send({ error: '预言不存在' });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.prophecy.verify', payload: { seq: p.seq, outcome } });
      return { prophecy: p, stats: await prophecyStats(user.id) };
    },
  );

  // WO-11：对某预言提异议（不改状态，复盘时军师带出确认）
  app.patch<{ Params: { id: string }; Body: { dispute?: string } }>('/prophecies/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const note = String(req.body?.dispute ?? '').trim();
    if (!note) return reply.code(400).send({ error: '异议内容不能为空' });
    const ok = await disputeProphecy(user.id, req.params.id, note);
    if (!ok) return reply.code(404).send({ error: '预言不存在' });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.prophecy.dispute', payload: { id: req.params.id } });
    return { ok: true };
  });
}
