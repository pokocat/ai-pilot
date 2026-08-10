import type { FastifyInstance } from 'fastify';
import type { FactConfirmationRequest, UserFactView } from '../../../shared/contracts';
import { prisma } from '../db.js';
import { recordAudit } from '../services/audit.js';
import { resolveUser } from '../services/context.js';
import { resolveFactConfirmation, userFactView } from '../services/userFacts.js';

export async function factRoutes(app: FastifyInstance) {
  app.get('/facts', async (req): Promise<{ items: UserFactView[] }> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const rows = await prisma.userFact.findMany({
      where: { tenantId: user.tenantId, userId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
    return { items: rows.map(userFactView) };
  });

  app.post<{ Params: { id: string }; Body: FactConfirmationRequest }>('/facts/:id/confirm', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const action = req.body?.action;
    if (!['confirm', 'edit', 'session_only'].includes(action)) {
      return reply.code(400).send({ error: '未知确认动作', code: 'INVALID_FACT_ACTION' });
    }
    try {
      const result = await resolveFactConfirmation({
        tenantId: user.tenantId,
        userId: user.id,
        factId: req.params.id,
        request: req.body,
      });
      if (!result) return reply.code(409).send({ error: '这条事实已经处理过', code: 'FACT_ALREADY_RESOLVED' });
      await recordAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: `user.fact.${result.resolution}`,
        payload: { factId: req.params.id, factKey: result.fact.factKey },
      });
      return result;
    } catch (error) {
      const detail = error as Error & { statusCode?: number; code?: string };
      return reply.code(detail.statusCode ?? 500).send({ error: detail.message, code: detail.code ?? 'FACT_CONFIRM_FAILED' });
    }
  });
}
