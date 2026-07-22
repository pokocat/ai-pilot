// 战略案卷路由（PR-EX 执行闭环落库）：认可方案建案卷、军令打卡、数据回填、本地案卷导入。
// 所有读写按 userId 行级隔离；页面契约与原前端本地版一致（见 services/casefile.ts CasefileView）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { now } from '../services/clock.js';
import {
  acceptDeliverable, activeCasefile, casefileView, importLocalDossier, todayStr,
  type DeliverableInput,
} from '../services/casefile.js';
import type { GoalLadder } from '../../../shared/contracts';
import { extractStrategicFacts, upsertStrategicProfile, extractForceVerdict, upsertForce } from '../services/strategicProfile.js';
import { recordDecisionFromAccept } from '../services/decisionLog.js';
import { listReviews, recordReview, reviewStreak, type ReviewLayer } from '../services/reviewLog.js';
import { syncProgress } from '../services/progress.js';

export async function casefileRoutes(app: FastifyInstance) {
  // 当前活跃案卷（战局/执行页数据源）；没有则 { casefile: null }
  app.get('/casefile', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return { casefile: await casefileView(user.id) };
  });

  // 认可方案 → 生成/更新案卷 + 拆今日军令
  app.post<{ Body: { deliverable: DeliverableInput; agentName?: string; force?: string } }>('/casefile/accept', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const { deliverable, agentName, force } = req.body ?? {};
    if (!deliverable || typeof deliverable !== 'object') {
      return reply.code(400).send({ error: '缺少方案内容' });
    }
    const r = await acceptDeliverable({
      tenantId: user.tenantId,
      userId: user.id,
      deliverable,
      agentName: String(agentName || '军师').slice(0, 40),
    });
    // 战略档案回写（PR-3）：认可 = 用户确认的战略事实，提取 主要矛盾/定位/赛道/阶段 落档案
    await upsertStrategicProfile({
      tenantId: user.tenantId,
      userId: user.id,
      patch: extractStrategicFacts(deliverable),
    }).catch(() => {});
    // L-6 三势真数据化：认可的是「市势/人势研判」→ 提炼 攻/守/等/撤 结论回写，军情页三势卡回显真结论
    if (force === '市势' || force === '人势') {
      void extractForceVerdict(force, deliverable)
        .then((v) => v && upsertForce({ tenantId: user.tenantId, userId: user.id, forceLabel: force, force: v }))
        .catch(() => {});
    }
    // 决策日志（M2 PR-7）：认可 = 一次战略决策，自动记账（30 天验证期，月复盘对账）
    await recordDecisionFromAccept({
      tenantId: user.tenantId,
      userId: user.id,
      deliverable,
      agentName: String(agentName || '军师').slice(0, 40),
    }).catch(() => {});
    // WO-07：认可方案 = 拿到作战计划 → journey → executing（plan.accept）
    await import('../services/journey.js').then((m) => m.applyJourneyEvent(user.id, user.tenantId, 'plan.accept')).catch(() => {});
    // WO-12：认可 = 开方落库（白名单过滤 + 挂案卷；fire-safe，绝不阻断认可）
    await import('../services/prescription.js')
      .then((m) => m.persistPrescriptions({ tenantId: user.tenantId, userId: user.id, casefileId: r.casefileId, prescriptions: (deliverable as { prescriptions?: unknown }).prescriptions }))
      .catch(() => {});
    await recordAudit({
      tenantId: user.tenantId, userId: user.id,
      action: 'user.casefile.accept',
      payload: { casefileId: r.casefileId, newOrders: r.newOrders, skippedOrders: r.skippedOrders },
    });
    return { ...r, casefile: await casefileView(user.id) };
  });

  // 手动补一条今日军令
  app.post<{ Body: { text: string } }>('/casefile/orders', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const text = String(req.body?.text ?? '').trim().replace(/\s+/g, ' ');
    if (!text) return reply.code(400).send({ error: '军令内容不能为空' });
    const cf = await activeCasefile(user.id);
    if (!cf) return reply.code(409).send({ error: '还没有案卷，先认可一份军师方案', code: 'NO_CASEFILE' });
    const date = todayStr();
    const existing = await prisma.casefileOrder.findMany({
      where: { casefileId: cf.id, date },
      select: { text: true },
    });
    if (existing.some((o) => o.text.trim().replace(/\s+/g, ' ') === text)) {
      return { casefile: await casefileView(user.id), duplicate: true };
    }
    await prisma.casefileOrder.create({
      data: {
        tenantId: user.tenantId, userId: user.id, casefileId: cf.id,
        date, text: text.slice(0, 500), fromAgent: '我', tag: '军令 · 自定',
      },
    });
    await prisma.casefile.update({ where: { id: cf.id }, data: { updatedAt: new Date() } });
    return { casefile: await casefileView(user.id) };
  });

  // 打卡 / 取消打卡
  app.patch<{ Params: { id: string }; Body: { done?: boolean; resultNote?: string } }>('/casefile/orders/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const order = await prisma.casefileOrder.findFirst({ where: { id: req.params.id, userId: user.id } });
    if (!order) return reply.code(404).send({ error: '军令不存在' });
    const body = req.body ?? {};
    const data: { done?: boolean; doneAt?: Date | null; resultNote?: string | null } = {};
    if (typeof body.done === 'boolean') {
      data.done = body.done; data.doneAt = body.done ? new Date() : null;
    } else if (typeof body.resultNote !== 'string') {
      // 空 body = 纯打卡切换（沿用原行为）；带 resultNote 的请求不顺带翻转完成态
      data.done = !order.done; data.doneAt = !order.done ? new Date() : null;
    }
    if (typeof body.resultNote === 'string') data.resultNote = body.resultNote.trim().slice(0, 200) || null;
    await prisma.casefileOrder.update({ where: { id: order.id }, data });
    return { casefile: await casefileView(user.id) };
  });

  // 删除军令
  app.delete<{ Params: { id: string } }>('/casefile/orders/:id', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await prisma.casefileOrder.deleteMany({ where: { id: req.params.id, userId: user.id } });
    return { casefile: await casefileView(user.id) };
  });

  // 今日数据回填（每天一条，重复提交覆盖）
  app.put<{ Body: { leads?: string | number; consults?: string | number; deals?: string | number } }>(
    '/casefile/backfill',
    async (req, reply) => {
      const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
      const cf = await activeCasefile(user.id);
      if (!cf) return reply.code(409).send({ error: '还没有案卷，先认可一份军师方案', code: 'NO_CASEFILE' });
      const toInt = (v: unknown) => {
        const n = parseInt(String(v ?? ''), 10);
        return Number.isFinite(n) && n >= 0 ? Math.min(n, 1_000_000) : 0;
      };
      const date = todayStr();
      const data = { leads: toInt(req.body?.leads), consults: toInt(req.body?.consults), deals: toInt(req.body?.deals), savedAt: new Date() };
      await prisma.casefileMetric.upsert({
        where: { casefileId_date: { casefileId: cf.id, date } },
        update: data,
        create: { tenantId: user.tenantId, userId: user.id, casefileId: cf.id, date, ...data },
      });
      await prisma.casefile.update({ where: { id: cf.id }, data: { updatedAt: new Date() } });
      return { casefile: await casefileView(user.id) };
    },
  );

  // V7-10：目标阶梯局部更新（3-5年/年度/季度/本周，手动编辑）。
  app.put<{ Body: Partial<GoalLadder> }>('/casefile/goals', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const cf = await activeCasefile(user.id);
    if (!cf) return reply.code(409).send({ error: '还没有案卷，先认可一份军师方案', code: 'NO_CASEFILE' });
    const body = req.body ?? {};
    const existing = (cf.goalsJson as GoalLadder | null) ?? {};
    const pick = (k: keyof GoalLadder): string | null =>
      k in body ? (String((body as Record<string, unknown>)[k] ?? '').trim().slice(0, 60) || null) : ((existing[k] as string | null) ?? null);
    const merged: GoalLadder = {
      longTerm: pick('longTerm'), annual: pick('annual'), quarterly: pick('quarterly'), weekly: pick('weekly'),
      updatedAt: now().toISOString(),
    };
    await prisma.casefile.update({ where: { id: cf.id }, data: { goalsJson: merged as object } });
    return { casefile: await casefileView(user.id) };
  });

  // 发起复盘（M2 PR-8）：前端在打开复盘对话时调用，落一条复盘账（day 层快照当日军令/回填事实）。
  // 同层同日 upsert（一天多次只算一次）；返回连续复盘天数供前端展示。
  app.post<{ Body: { layer?: string; note?: string } }>('/casefile/review', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const review = await recordReview({
      tenantId: user.tenantId,
      userId: user.id,
      layer: req.body?.layer as ReviewLayer | undefined,
      note: req.body?.note,
    });
    const streak = await reviewStreak(user.id);
    // 复盘是段位/里程碑的心跳：同步进度（晋升/解锁在响应里带回，前端可承接晋升提示）
    const progress = await syncProgress(user.id);
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.review.start', payload: { layer: review.layer, date: review.date, streak } });
    return { review, streak, progress };
  });

  // 用户进度（段位/里程碑，「我的」页数据源）
  app.get('/progress', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return { progress: await syncProgress(user.id) };
  });

  // 复盘账本（战局/我的页数据源）
  app.get('/reviews', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const [items, streak] = await Promise.all([listReviews(user.id), reviewStreak(user.id)]);
    return { items, streak };
  });

  // 本地案卷一次性导入（前端 storage 迁移；服务端已有活跃案卷则跳过 → 幂等）
  app.post<{ Body: { dossier: Parameters<typeof importLocalDossier>[0]['dossier'] } }>('/casefile/import', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const r = await importLocalDossier({ tenantId: user.tenantId, userId: user.id, dossier: req.body?.dossier });
    if (r.imported) {
      await recordAudit({
        tenantId: user.tenantId, userId: user.id,
        action: 'user.casefile.import',
        payload: { casefileId: r.casefileId },
      });
    }
    return { ...r, casefile: await casefileView(user.id) };
  });
}
