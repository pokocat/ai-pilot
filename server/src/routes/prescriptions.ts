// 处方（WO-12）：列表 + 转化埋点。处方产生走「认可方案」确定性落库（services/prescription），此处只读+推进状态。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { listPrescriptions, advancePrescription, RX_ACTIONS } from '../services/prescription.js';

export async function prescriptionRoutes(app: FastifyInstance) {
  app.get('/prescriptions', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return { items: await listPrescriptions(user.id) };
  });

  // 转化埋点：seen（曝光）/ clicked（点击）/ activated（开通）。
  app.post<{ Params: { id: string; action: string } }>('/prescriptions/:id/:action', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const { id, action } = req.params;
    if (!RX_ACTIONS.includes(action)) return reply.code(400).send({ code: 'BAD_REQUEST', error: '未知处方动作' });
    const ok = await advancePrescription(user.id, id, action);
    if (!ok) return reply.code(404).send({ code: 'NOT_FOUND', error: '处方不存在' });
    return { ok: true };
  });
}
