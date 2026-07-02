// 战略案卷路由（PR-EX 执行闭环落库）：认可方案建案卷、军令打卡、数据回填、本地案卷导入。
// 所有读写按 userId 行级隔离；页面契约与原前端本地版一致（见 services/casefile.ts CasefileView）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import {
  acceptDeliverable, activeCasefile, casefileView, importLocalDossier, todayStr,
  type DeliverableInput,
} from '../services/casefile.js';
import { extractStrategicFacts, upsertStrategicProfile } from '../services/strategicProfile.js';

export async function casefileRoutes(app: FastifyInstance) {
  // 当前活跃案卷（战局/执行页数据源）；没有则 { casefile: null }
  app.get('/casefile', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    return { casefile: await casefileView(user.id) };
  });

  // 认可方案 → 生成/更新案卷 + 拆今日军令
  app.post<{ Body: { deliverable: DeliverableInput; agentName?: string } }>('/casefile/accept', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const { deliverable, agentName } = req.body ?? {};
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
    await recordAudit({
      tenantId: user.tenantId, userId: user.id,
      action: 'user.casefile.accept',
      payload: { casefileId: r.casefileId, newOrders: r.newOrders },
    });
    return { ...r, casefile: await casefileView(user.id) };
  });

  // 手动补一条今日军令
  app.post<{ Body: { text: string } }>('/casefile/orders', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const text = String(req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: '军令内容不能为空' });
    const cf = await activeCasefile(user.id);
    if (!cf) return reply.code(409).send({ error: '还没有案卷，先认可一份军师方案', code: 'NO_CASEFILE' });
    await prisma.casefileOrder.create({
      data: {
        tenantId: user.tenantId, userId: user.id, casefileId: cf.id,
        date: todayStr(), text: text.slice(0, 500), fromAgent: '我', tag: '军令 · 自定',
      },
    });
    await prisma.casefile.update({ where: { id: cf.id }, data: { updatedAt: new Date() } });
    return { casefile: await casefileView(user.id) };
  });

  // 打卡 / 取消打卡
  app.patch<{ Params: { id: string }; Body: { done?: boolean } }>('/casefile/orders/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const order = await prisma.casefileOrder.findFirst({ where: { id: req.params.id, userId: user.id } });
    if (!order) return reply.code(404).send({ error: '军令不存在' });
    const done = typeof req.body?.done === 'boolean' ? req.body.done : !order.done;
    await prisma.casefileOrder.update({
      where: { id: order.id },
      data: { done, doneAt: done ? new Date() : null },
    });
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
