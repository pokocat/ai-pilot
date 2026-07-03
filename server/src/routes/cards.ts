// B 级卡片路由（M4 PR-15 第一批）：每日战报 / 天时日历 / 天命速写（送你一卦）。
// 返回可分享 htmlUrl（OSS 或后端 /api/r/:id 兜底）；卡上数字全部来自服务端账本。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { publishCard, type CardKind } from '../services/cardHtml.js';
import type { PaipanInput } from '../services/paipan.js';

const KINDS: CardKind[] = ['daily', 'calendar', 'fate'];

export async function cardRoutes(app: FastifyInstance) {
  app.post<{
    Params: { kind: string };
    Body: { friendName?: string; friendBazi?: PaipanInput } | undefined;
  }>('/cards/:kind', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const kind = req.params.kind as CardKind;
    if (!KINDS.includes(kind)) return reply.code(400).send({ error: '未知卡片类型' });
    try {
      // 谶语（若已在战略档案存档）随天时日历带出
      let verse: string | null = null;
      if (kind === 'calendar') {
        const { loadStrategicProfile } = await import('../services/strategicProfile.js');
        verse = (await loadStrategicProfile(user.id))?.verse ?? null;
      }
      const htmlUrl = await publishCard({
        tenantId: user.tenantId,
        userId: user.id,
        kind,
        ownerLabel: user.name || '主理人',
        friendName: req.body?.friendName ? String(req.body.friendName).slice(0, 20) : undefined,
        friendBazi: req.body?.friendBazi,
        verse,
      });
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.card.publish', payload: { kind } });
      return { htmlUrl };
    } catch (e) {
      const err = e as Error & { statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message, code: err.code });
    }
  });
}
