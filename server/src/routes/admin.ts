// 运营后台 API（《投产开发指导》§7）：概览看板 / 每日献策 / 智能体（提示词+记忆）/ 问卷 / 套餐。
// 演示环境未做 RBAC；生产需鉴权 + 操作审计（见 §7）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

export async function adminRoutes(app: FastifyInstance) {
  // —— 概览看板 ——
  app.get('/admin/overview', async () => {
    const [tenants, deliverables, sessions, agents] = await Promise.all([
      prisma.tenant.count(),
      prisma.deliverable.count(),
      prisma.session.count(),
      prisma.agent.count({ where: { enabled: true } }),
    ]);
    return {
      stats: [
        { v: '1,284', l: '付费企业', d: '本周 +36', trend: 'up' },
        { v: '842', l: '今日活跃', d: '+8.2%', trend: 'up' },
        { v: String(deliverables || 3170), l: '累计产出成果', d: '+12%', trend: 'up' },
        { v: '68%', l: '算力消耗', d: '需关注', trend: 'down' },
      ],
      live: { tenants, deliverables, sessions, agents },
      feed: [
        { icon: 'spark', t: '今日献策已推送', m: '「先把自己立于不败…」· 触达 842 人', v: '08:00' },
        { icon: 'agent', t: '新增内置顾问待审核', m: '法务合规官 · 等待上线', v: '2h' },
        { icon: 'crown', t: '3 家企业升级企业版', m: '私有化部署线索 +3', v: '今天' },
        { icon: 'alert', t: '算力到达 68% 阈值', m: '建议检查高消耗智能体', v: '今天' },
      ],
    };
  });

  // —— 每日献策库 ——
  app.get('/admin/sayings', async () => {
    return prisma.saying.findMany({ orderBy: { sort: 'asc' } });
  });
  app.post<{ Body: { text: string } }>('/admin/sayings', async (req) => {
    const count = await prisma.saying.count();
    return prisma.saying.create({ data: { text: req.body.text, enabled: true, sort: count } });
  });
  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; text?: string } }>(
    '/admin/sayings/:id',
    async (req) => {
      return prisma.saying.update({ where: { id: req.params.id }, data: req.body });
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/sayings/:id', async (req) => {
    await prisma.saying.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // —— 智能体配置（含 System 提示词 + Agent Memory） ——
  app.get('/admin/agents', async () => {
    const agents = await prisma.agent.findMany({ orderBy: { sort: 'asc' } });
    return agents.map((a) => ({
      key: a.key, name: a.name, role: a.role, icon: a.icon, type: a.type,
      gift: a.gift, enabled: a.enabled, deliverableKey: a.deliverableKey,
    }));
  });
  app.get<{ Params: { key: string } }>('/admin/agents/:key', async (req, reply) => {
    const a = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!a) return reply.code(404).send({ error: 'not found' });
    return {
      key: a.key, name: a.name, role: a.role, icon: a.icon, type: a.type,
      enabled: a.enabled, systemPrompt: a.systemPrompt, memoryConfig: a.memoryConfig,
      deliverableKey: a.deliverableKey,
    };
  });
  app.patch<{ Params: { key: string }; Body: { systemPrompt?: string; memoryConfig?: object; enabled?: boolean } }>(
    '/admin/agents/:key',
    async (req) => {
      const a = await prisma.agent.update({
        where: { key: req.params.key },
        data: {
          systemPrompt: req.body.systemPrompt,
          memoryConfig: req.body.memoryConfig,
          enabled: req.body.enabled,
        },
      });
      // 操作审计（§7）
      await prisma.auditLog.create({
        data: { action: 'admin.agent.update', payloadJson: { key: a.key } },
      }).catch(() => {});
      return { ok: true, key: a.key };
    },
  );

  // —— 建档问卷 ——
  app.get('/admin/survey', async () => prisma.surveyQuestion.findMany({ orderBy: { sort: 'asc' } }));
  app.patch<{ Params: { id: string }; Body: { title?: string; optionsJson?: string[]; enabled?: boolean } }>(
    '/admin/survey/:id',
    async (req) => prisma.surveyQuestion.update({ where: { id: req.params.id }, data: req.body }),
  );

  // —— 套餐 ——
  app.get('/admin/plans', async () => prisma.plan.findMany({ orderBy: { sort: 'asc' } }));
  app.patch<{ Params: { id: string }; Body: { name?: string; price?: number; creditsPerMonth?: number; agentCount?: number; featuresJson?: string[]; highlighted?: boolean } }>(
    '/admin/plans/:id',
    async (req) => prisma.plan.update({ where: { id: req.params.id }, data: req.body }),
  );
}
