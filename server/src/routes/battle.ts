// V7-04：战局三势刷新 + 「认可判断 → 生成军令与报告」一键动线。
// /battle/commit 串既有能力：buildGenContext → generateDeliverable → acceptDeliverable(建案卷/拆军令) →
// saveReportVersion(桥接版本化报告)；额度门禁与 /generate-sync 同口径；5 分钟内幂等返回上次结果。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { now } from '../services/clock.js';
import { buildGenContext } from '../services/context.js';
import { resolveEffectiveAgent } from '../services/agentVersions.js';
import { generateDeliverable } from '../llm/gateway.js';
import { acceptDeliverable, casefileView, todayStr, type DeliverableInput } from '../services/casefile.js';
import { extractStrategicFacts, upsertStrategicProfile } from '../services/strategicProfile.js';
import { saveReportVersion } from '../services/reports.js';
import { assertPlanActive, reserveQuota } from '../services/tokenQuota.js';
import { generateForces, loadBattleForces } from '../services/forces.js';
import { cacheGet, cacheSet } from '../services/cache.js';
import type { BattleCommitResult } from '../../../shared/contracts';

const FORCES_REFRESH_LIMIT = 3; // 每日刷新上限

export async function battleRoutes(app: FastifyInstance) {
  // 手动刷新三势（限频每日 3 次，走额度预扣）。
  app.post('/forces/refresh', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const dayStart = new Date(now()); dayStart.setHours(0, 0, 0, 0);
    const used = await prisma.auditLog.count({ where: { userId: user.id, action: 'user.forces.refresh', createdAt: { gte: dayStart } } });
    if (used >= FORCES_REFRESH_LIMIT) return reply.code(429).send({ error: '今日三势刷新次数已用完，明天再来', code: 'FORCES_RATE_LIMIT' });
    let reservation: Awaited<ReturnType<typeof reserveQuota>> | null = null;
    try {
      await assertPlanActive(user.id);
      reservation = await reserveQuota(user.id, 1);
    } catch (e) {
      if (reservation) await (reservation as { refund: () => Promise<void> }).refund().catch(() => {});
      const err = e as Error & { statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 402).send({ error: err.message, code: err.code });
    }
    try {
      const forces = await generateForces({ tenantId: user.tenantId, userId: user.id });
      await reservation.settle(0, 1); // 结构化研判轻量，按 0 结算（不重复扣 token 额度）
      // P0-3：零档案/LLM 失败 → forces=null（未落库）。不计一次刷新（不消耗每日名额），前端走空态引导卡「先与军师聊清现状」。
      if (!forces) return { forces: [] };
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.forces.refresh', payload: { count: forces.length } });
      return { forces };
    } catch (e) {
      await reservation.refund().catch(() => {});
      const err = e as Error & { statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 500).send({ error: err.message, code: err.code });
    }
  });

  // 认可判断 → 一键生成军令与报告。
  app.post('/battle/commit', async (req, reply): Promise<BattleCommitResult | void> => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const cacheKey = `battle:commit:${user.id}:${todayStr()}`;
    const cached = await cacheGet<BattleCommitResult>(cacheKey);
    if (cached) return { ...cached, alreadyDone: true };

    let reservation: Awaited<ReturnType<typeof reserveQuota>> | null = null;
    try {
      await assertPlanActive(user.id);
      reservation = await reserveQuota(user.id, 1);
    } catch (e) {
      if (reservation) await (reservation as { refund: () => Promise<void> }).refund().catch(() => {});
      const err = e as Error & { statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 402).send({ error: err.message, code: err.code });
    }

    try {
      const cf = await prisma.casefile.findFirst({ where: { userId: user.id, status: 'active' }, orderBy: { updatedAt: 'desc' }, select: { judgment: true, title: true } });
      const userMessage = cf?.judgment
        ? `请基于当前案卷判断「${cf.judgment}」，认可这一判断，并把它拆成本周可执行的军令与一份战略报告（含核心判断、三势结论、下一步动作、现在不能做）。`
        : '请基于我的档案与战局判断，认可主要矛盾，并生成本周可执行的军令与一份战略报告。';
      const effective = await resolveEffectiveAgent('general');
      const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage, effective: effective ?? undefined });
      const { result, usage } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, agentKey: 'general', ratio: 1 });

      // 建案卷 + 拆军令（复用认可动线），并回写战略档案。
      const accepted = await acceptDeliverable({ tenantId: user.tenantId, userId: user.id, deliverable: result as DeliverableInput, agentName: '总军师' });
      await upsertStrategicProfile({ tenantId: user.tenantId, userId: user.id, patch: extractStrategicFacts(result as DeliverableInput) }).catch(() => {});
      await import('../services/journey.js').then((m) => m.applyJourneyEvent(user.id, user.tenantId, 'plan.accept')).catch(() => {});

      // 桥接版本化报告（战局军令与报告，V7-09 报告面板消费）。
      const saved = await saveReportVersion({
        tenantId: user.tenantId, userId: user.id,
        title: (result as { title?: string }).title || '战局军令与报告',
        type: '战略方案', agentKey: 'general', authorKind: 'agent',
        content: result as object,
      });

      const settled = usage ? await reservation.settle((result as { degraded?: boolean }).degraded ? 0 : (usage.inputTokens + usage.outputTokens), 1) : null;
      void settled;

      const out: BattleCommitResult = {
        reportId: saved.reportId, reportSlug: '', version: saved.version,
        libraryId: null, newOrders: accepted.newOrders, alreadyDone: false,
      };
      await cacheSet(cacheKey, out, 5 * 60_000);
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.battle.commit', payload: { reportId: saved.reportId, newOrders: accepted.newOrders } });
      return out;
    } catch (e) {
      await reservation.refund().catch(() => {});
      const err = e as Error & { statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? (err.code === 'MODERATION_BLOCK' ? 422 : 500)).send({ error: err.message, code: err.code });
    }
  });
}

// 供 understanding 视图装配调用（把结构化三势带进 /me.understanding）。
export { loadBattleForces };
