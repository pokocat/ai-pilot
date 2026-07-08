// 决策日志路由（M2 PR-7）：列表/手动记录/验证/统计。按 userId 行级隔离；准确率只由服务端算。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { decisionStats, disputeDecision, listDecisions, recordDecision, verifyDecision } from '../services/decisionLog.js';

export async function decisionRoutes(app: FastifyInstance) {
  // 决策列表 + 统计（战局/我的页数据源）
  app.get('/decisions', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const [items, stats] = await Promise.all([listDecisions(user.id, 50), decisionStats(user.id)]);
    return { items, stats };
  });

  // 手动记一条决策
  app.post<{ Body: { decision: string; scene?: string; reasons?: string[]; expected?: string; verifyStandard?: string; verifyByDate?: string; fast?: boolean } }>(
    '/decisions',
    async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      if (!String(req.body?.decision ?? '').trim()) return reply.code(400).send({ error: '决策内容不能为空' });
      const d = await recordDecision({
        tenantId: user.tenantId,
        userId: user.id,
        scene: req.body.scene || '手动',
        decision: req.body.decision,
        reasons: Array.isArray(req.body.reasons) ? req.body.reasons : [],
        expected: req.body.expected,
        verifyStandard: req.body.verifyStandard,
        verifyByDate: req.body.verifyByDate ?? null,
        fast: typeof req.body.fast === 'boolean' ? req.body.fast : null,
      });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.decision.create', payload: { seq: d.seq, scene: d.scene } });
      return { decision: d };
    },
  );

  // 验证决策（月复盘对账入口）：correct / revise + 事实记录
  app.post<{ Params: { id: string }; Body: { outcome: 'correct' | 'revise'; note?: string } }>(
    '/decisions/:id/verify',
    async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const outcome = req.body?.outcome;
      if (outcome !== 'correct' && outcome !== 'revise') return reply.code(400).send({ error: 'outcome 必须是 correct 或 revise' });
      const d = await verifyDecision({ userId: user.id, decisionId: req.params.id, outcome, note: req.body?.note });
      if (!d) return reply.code(404).send({ error: '决策不存在' });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.decision.verify', payload: { seq: d.seq, outcome } });
      return { decision: d, stats: await decisionStats(user.id) };
    },
  );

  // WO-11：对某决策提异议（不改状态，复盘时军师带出确认）
  app.patch<{ Params: { id: string }; Body: { dispute?: string } }>('/decisions/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const note = String(req.body?.dispute ?? '').trim();
    if (!note) return reply.code(400).send({ error: '异议内容不能为空' });
    const ok = await disputeDecision(user.id, req.params.id, note);
    if (!ok) return reply.code(404).send({ error: '决策不存在' });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.decision.dispute', payload: { id: req.params.id } });
    return { ok: true };
  });
}
