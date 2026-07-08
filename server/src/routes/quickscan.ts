// POST /quickscan（WO-06）：3 问速诊 → 初诊卡。替代「送你一卦」承担获客/裂变。
// 约束：每用户每日 3 次限流；token 轴 metered（ratio 低配）+ grace:'quickscan' 每日 1 次保底（额度耗尽不拦获客）；
//       速诊即建档——Profile.industry/stage/pain「空则回填、不覆盖」；打点见 recordAudit（UserJourney 待 WO-07）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { cacheGet, cacheSet } from '../services/cache.js';
import { reserveQuota, assertPlanActive, type QuotaReservation } from '../services/tokenQuota.js';
import { runQuickScan } from '../services/quickscan.js';
import { now } from '../services/clock.js';
import type { QuickScanRequest } from '../../../shared/contracts';

const DAILY_LIMIT = 3; // 每用户每日速诊次数
const RATIO = 0.3; // token 轴计费 ratio 低配（获客动作）
const EST_TOKENS = 800; // 速诊调用的估算 token（structured() 暂不回传真实用量，走保守估算；精确计量待「计量中间件」重构）
const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(): string {
  const d = now();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// 速诊即建档：三字段「空则填、不覆盖已有值」。revenueBand → Profile.stage（营收阶段口径）。
async function backfillProfile(tenantId: string, f: { industry: string; stage: string; pain: string }): Promise<void> {
  const existing = await prisma.profile.findFirst({ where: { tenantId }, orderBy: { updatedAt: 'desc' } });
  const keep = (cur: string | null | undefined, next: string) => (cur && cur.trim() ? cur : next);
  const data = {
    industry: keep(existing?.industry, f.industry),
    stage: keep(existing?.stage, f.stage),
    pain: keep(existing?.pain, f.pain),
  };
  if (existing) await prisma.profile.update({ where: { id: existing.id }, data });
  else await prisma.profile.create({ data: { ...data, tenantId } });
}

export async function quickscanRoutes(app: FastifyInstance) {
  app.post<{ Body: QuickScanRequest }>('/quickscan', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const industry = req.body?.industry?.trim();
    const revenueBand = req.body?.revenueBand?.trim();
    const pain = req.body?.pain?.trim();
    if (!industry || !revenueBand || !pain) {
      return reply.code(400).send({ code: 'BAD_REQUEST', error: '请完整填写行业、年营收段和最痛的一件事' });
    }

    // 1) 限流 3/日（先于额度：超限的请求不应消耗 grace 名额）
    const rlKey = `quickscan:rl:${user.id}:${dayKey()}`;
    const used = (await cacheGet<number>(rlKey)) ?? 0;
    if (used >= DAILY_LIMIT) {
      return reply.code(429).send({ code: 'RATE_LIMITED', error: '今天的速诊次数已用完，明天再来' });
    }

    // 2) 门禁 + 额度预留（grace:'quickscan' 每日 1 次保底：额度耗尽仍放行第一次，第二次 402）
    await assertPlanActive(user.id);
    let reservation: QuotaReservation | undefined;
    try {
      reservation = await reserveQuota(user.id, RATIO, { grace: 'quickscan' });
      const { result, billable } = await runQuickScan({ industry, revenueBand, pain });
      await reservation.settle(billable ? EST_TOKENS : 0, RATIO);
      // 3) 速诊即建档（空则回填）
      await backfillProfile(user.tenantId, { industry, stage: revenueBand, pain });
      // 4) 计一次限流（仅成功后）
      await cacheSet(rlKey, used + 1, DAY_MS);
      // TODO(WO-07)：UserJourney.quickScanAt 打点 —— 待 UserJourney 模型落地
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.quickscan', payload: { industry, revenueBand } });
      return result;
    } catch (err) {
      if (reservation) await reservation.refund().catch(() => {});
      throw err;
    }
  });
}
