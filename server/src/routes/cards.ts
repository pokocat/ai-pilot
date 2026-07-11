// B 级卡片路由（M4 PR-15 第一批）：每日战报 / 天时日历 / 天命速写（送你一卦）。
// 返回可分享 htmlUrl（自有域名 /api/r/:id）；卡上数字全部来自服务端账本。
import type { FastifyInstance } from 'fastify';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { publishCard, fateCardContent, type CardKind } from '../services/cardHtml.js';
import { computeChart, validatePaipanInput, type PaipanInput } from '../services/paipan.js';
import { fortuneDisabledGuard } from '../services/featureFlag.js';
import { yearOf } from '../services/clock.js';

const KINDS: CardKind[] = ['daily', 'calendar', 'fate'];
// 命理卡（天时日历 / 送你一卦）受 fortune 开关约束；每日战报（daily）是战报非命理，不受约束。
const FORTUNE_KINDS = new Set<CardKind>(['calendar', 'fate']);

export async function cardRoutes(app: FastifyInstance) {
  // 送你一卦「天命速写」预览（合规打磨·AUDIT P-4）：校验朋友生辰 → 现算命盘 → 返回卡文本。
  // 第三人生辰**不落库、无公开链接**（旧 /cards/fate + friendBazi 会 reportHtml.create 永久公开，已封）；
  // 小程序端拿文本 canvas 画卡导出图片分享。需前端「已获对方同意」勾选（PIPL），此处只记审计不存生辰明文。
  app.post<{ Body: { friendName?: string; friendBazi?: PaipanInput; consent?: boolean } | undefined }>(
    '/cards/fate/preview',
    async (req, reply) => {
      if (await fortuneDisabledGuard(reply)) return reply; // P0-2：命理下线 → 403
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const body = req.body ?? {};
      if (body.consent !== true) return reply.code(400).send({ error: '请先确认已获对方同意使用其生辰', code: 'CONSENT_REQUIRED' });
      const v = validatePaipanInput(body.friendBazi, yearOf());
      if (!v.ok) return reply.code(400).send({ error: v.error });
      let chart;
      try {
        chart = computeChart(v.input, yearOf());
      } catch {
        return reply.code(400).send({ error: '生辰无法排盘，请检查日期是否存在（如农历大小月/闰月）' });
      }
      const friendName = body.friendName ? String(body.friendName).slice(0, 20) : undefined;
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.fate.preview', payload: { consent: true, hasName: !!friendName } });
      return fateCardContent(chart, friendName);
    },
  );

  app.post<{
    Params: { kind: string };
    Body: { friendName?: string; friendBazi?: PaipanInput } | undefined;
  }>('/cards/:kind', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const kind = req.params.kind as CardKind;
    if (!KINDS.includes(kind)) return reply.code(400).send({ error: '未知卡片类型' });
    if (FORTUNE_KINDS.has(kind) && (await fortuneDisabledGuard(reply))) return reply; // P0-2：命理卡下线 → 403
    // 封禁第三人生辰落库路径：fate + friendBazi 一律走 /cards/fate/preview（不落库）
    if (kind === 'fate' && req.body?.friendBazi) {
      return reply.code(400).send({ error: '送你一卦请使用 /cards/fate/preview（不落库）', code: 'USE_FATE_PREVIEW' });
    }
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
