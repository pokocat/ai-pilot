// 运营后台 API（《投产开发指导》§7）：概览看板 / 每日献策 / 智能体（提示词+记忆）/ 问卷 / 套餐。
// 演示环境未做 RBAC；生产需鉴权 + 操作审计（见 §7）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { getAiConfig, setAiConfig, publicConfig, AI_PRESETS, type ResolvedAiConfig } from '../services/aiConfig.js';
import { pingModel } from '../llm/gateway.js';
import { isoSecond, recordAudit } from '../services/audit.js';
import type { AiConfigUpdate } from '../llm/schema.js';
import type { AdminAuditItem, AdminUserItem, AdminUsageView } from '../../../shared/contracts';

export async function adminRoutes(app: FastifyInstance) {
  // —— 大模型配置（运营后台可随时切换；默认 Agnes 2.0 Flash） ——
  app.get('/admin/ai-config', async () => {
    const cfg = await getAiConfig(true);
    return { config: publicConfig(cfg), presets: AI_PRESETS };
  });
  app.put<{ Body: AiConfigUpdate }>('/admin/ai-config', async (req) => {
    const cfg = await setAiConfig(req.body ?? {});
    await recordAudit({ action: 'admin.ai.update', payload: { provider: cfg.provider, model: cfg.model } });
    return { config: publicConfig(cfg), presets: AI_PRESETS };
  });
  // 测试连接：用「当前保存配置」叠加本次未保存的改动（apiKey 留空则用已存 key）。
  app.post<{ Body: AiConfigUpdate }>('/admin/ai-config/test', async (req) => {
    const saved = await getAiConfig(true);
    const b = req.body ?? {};
    const merged: ResolvedAiConfig = {
      ...saved,
      provider: b.provider ?? saved.provider,
      baseUrl: b.baseUrl ?? saved.baseUrl,
      model: b.model ?? saved.model,
      apiKey: b.apiKey && b.apiKey.length ? b.apiKey : saved.apiKey,
      embeddingModel: b.embeddingModel ?? saved.embeddingModel,
      temperature: b.temperature ?? saved.temperature,
    };
    return pingModel(merged);
  });

  // —— 概览看板 ——
  app.get('/admin/overview', async () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const [tenants, users, deliverables, sessions, agents, activeToday, ledgers, recentAudits] = await Promise.all([
      prisma.tenant.count(),
      prisma.user.count(),
      prisma.deliverable.count(),
      prisma.session.count(),
      prisma.agent.count({ where: { enabled: true } }),
      prisma.session.findMany({ where: { updatedAt: { gte: today } }, select: { userId: true }, distinct: ['userId'] }),
      prisma.creditLedger.findMany({ select: { delta: true } }),
      prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 4 }),
    ]);
    const spent = ledgers.reduce((sum, l) => sum + (l.delta < 0 ? Math.abs(l.delta) : 0), 0);
    return {
      stats: [
        { v: String(users), l: '注册用户', d: `${tenants} 个租户`, trend: 'up' },
        { v: String(activeToday.length), l: '今日活跃用户', d: `${sessions} 个会话`, trend: 'up' },
        { v: String(deliverables), l: '累计产出成果', d: `${agents} 个功能上架`, trend: 'up' },
        { v: String(spent), l: '累计算力消耗', d: '按流水统计', trend: spent > 0 ? 'down' : 'up' },
      ],
      live: { tenants, deliverables, sessions, agents },
      feed: recentAudits.length
        ? recentAudits.map((a) => ({ icon: auditIcon(a.action), t: auditLabel(a.action), m: String(a.action), v: isoSecond(a.createdAt).replace('T', ' ').replace('Z', '') }))
        : [{ icon: 'alert', t: '暂无审计事件', m: '用户产生操作后会自动写入审计日志', v: '-' }],
    };
  });

  // —— 用户管理：小程序注册用户、账号来源、会话/成果/算力概览 ——
  app.get('/admin/users', async (): Promise<AdminUserItem[]> => {
    return buildAdminUsers();
  });

  // —— 消耗管理：按用户汇总算力赠送、消耗与余额 ——
  app.get('/admin/usage', async (): Promise<AdminUsageView> => {
    const users = await buildAdminUsers();
    const activeSince = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [reportCount, creditEvents] = await Promise.all([
      prisma.deliverable.count(),
      prisma.creditLedger.count(),
    ]);
    return {
      summary: {
        registeredUsers: users.length,
        activeUsers: users.filter((u) => u.lastSessionAt && new Date(u.lastSessionAt) >= activeSince).length,
        totalGranted: users.reduce((sum, u) => sum + u.totalGranted, 0),
        totalSpent: users.reduce((sum, u) => sum + u.totalSpent, 0),
        currentBalanceTotal: users.reduce((sum, u) => sum + (u.creditBalance > 0 ? u.creditBalance : 0), 0),
        unlimitedUsers: users.filter((u) => u.creditBalance < 0).length,
        reportCount,
        creditEvents,
      },
      users: [...users].sort((a, b) => b.totalSpent - a.totalSpent),
    };
  });

  // —— 审计日志：所有带 x-user-id 的小程序 API 行为 + 关键业务/后台操作 ——
  app.get<{ Querystring: { limit?: string; userId?: string; action?: string } }>(
    '/admin/audit-logs',
    async (req): Promise<AdminAuditItem[]> => {
      const take = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 200);
      const logs = await prisma.auditLog.findMany({
        where: {
          ...(req.query.userId ? { userId: req.query.userId } : {}),
          ...(req.query.action ? { action: req.query.action } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
      });
      const userIds = [...new Set(logs.map((l) => l.userId).filter(Boolean))] as string[];
      const tenantIds = [...new Set(logs.map((l) => l.tenantId).filter(Boolean))] as string[];
      const [users, tenants] = await Promise.all([
        userIds.length
          ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, phone: true, tenantId: true } })
          : [],
        tenantIds.length
          ? prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
          : [],
      ]);
      const userMap = new Map(users.map((u) => [u.id, u]));
      const tenantMap = new Map(tenants.map((t) => [t.id, t.name]));
      return logs.map((l) => {
        const u = l.userId ? userMap.get(l.userId) : null;
        return {
          id: l.id,
          action: l.action,
          userId: l.userId,
          userName: u?.name ?? null,
          userPhone: u ? displayPhone(u.phone) : null,
          tenantId: l.tenantId,
          tenantName: l.tenantId ? tenantMap.get(l.tenantId) ?? null : null,
          payload: l.payloadJson,
          at: isoSecond(l.createdAt),
        };
      });
    },
  );

  // —— 每日献策库 ——
  app.get('/admin/sayings', async () => {
    return prisma.saying.findMany({ orderBy: { sort: 'asc' } });
  });
  app.post<{ Body: { text: string } }>('/admin/sayings', async (req) => {
    const count = await prisma.saying.count();
    const saying = await prisma.saying.create({ data: { text: req.body.text, enabled: true, sort: count } });
    await recordAudit({ action: 'admin.saying.create', payload: { id: saying.id } });
    return saying;
  });
  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; text?: string } }>(
    '/admin/sayings/:id',
    async (req) => {
      const saying = await prisma.saying.update({ where: { id: req.params.id }, data: req.body });
      await recordAudit({ action: 'admin.saying.update', payload: { id: saying.id, enabled: saying.enabled } });
      return saying;
    },
  );
  app.delete<{ Params: { id: string } }>('/admin/sayings/:id', async (req) => {
    await prisma.saying.delete({ where: { id: req.params.id } });
    await recordAudit({ action: 'admin.saying.delete', payload: { id: req.params.id } });
    return { ok: true };
  });

  // —— 智能体配置（含 System 提示词 + Agent Memory） ——
  app.get('/admin/agents', async () => {
    const [agents, sessionGroups, deliverableGroups] = await Promise.all([
      prisma.agent.findMany({ orderBy: { sort: 'asc' } }),
      prisma.session.groupBy({ by: ['agentKey'], _count: { _all: true } }),
      prisma.deliverable.groupBy({ by: ['agentKey'], _count: { _all: true } }),
    ]);
    const sessions = new Map(sessionGroups.map((g) => [g.agentKey, g._count._all]));
    const deliverables = new Map(deliverableGroups.map((g) => [g.agentKey, g._count._all]));
    return agents.map((a) => ({
      key: a.key, name: a.name, role: a.role, icon: a.icon, type: a.type,
      gift: a.gift, enabled: a.enabled, deliverableKey: a.deliverableKey,
      sessionCount: sessions.get(a.key) ?? 0,
      deliverableCount: deliverables.get(a.key) ?? 0,
      updatedAt: isoSecond(a.updatedAt),
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
      const before = await prisma.agent.findUnique({ where: { key: req.params.key }, select: { enabled: true } });
      const a = await prisma.agent.update({
        where: { key: req.params.key },
        data: {
          systemPrompt: req.body.systemPrompt,
          memoryConfig: req.body.memoryConfig,
          enabled: req.body.enabled,
        },
      });
      const enabledChanged = typeof req.body.enabled === 'boolean' && before?.enabled !== req.body.enabled;
      await recordAudit({
        action: enabledChanged ? (a.enabled ? 'admin.agent.publish' : 'admin.agent.unpublish') : 'admin.agent.update',
        payload: {
          key: a.key,
          name: a.name,
          enabled: a.enabled,
          systemPromptChanged: typeof req.body.systemPrompt === 'string',
          memoryConfigChanged: !!req.body.memoryConfig,
        },
      });
      return { ok: true, key: a.key };
    },
  );

  // —— 建档问卷 ——
  app.get('/admin/survey', async () => prisma.surveyQuestion.findMany({ orderBy: { sort: 'asc' } }));
  app.patch<{ Params: { id: string }; Body: { title?: string; optionsJson?: string[]; enabled?: boolean } }>(
    '/admin/survey/:id',
    async (req) => {
      const q = await prisma.surveyQuestion.update({ where: { id: req.params.id }, data: req.body });
      await recordAudit({ action: 'admin.survey.update', payload: { id: q.id, key: q.key, enabled: q.enabled } });
      return q;
    },
  );

  // —— 套餐 ——
  app.get('/admin/plans', async () => prisma.plan.findMany({ orderBy: { sort: 'asc' } }));
  app.patch<{ Params: { id: string }; Body: { name?: string; price?: number; creditsPerMonth?: number; agentCount?: number; featuresJson?: string[]; highlighted?: boolean } }>(
    '/admin/plans/:id',
    async (req) => {
      const plan = await prisma.plan.update({ where: { id: req.params.id }, data: req.body });
      await recordAudit({ action: 'admin.plan.update', payload: { id: plan.id, name: plan.name } });
      return plan;
    },
  );
}

async function buildAdminUsers(): Promise<AdminUserItem[]> {
  const [users, sessions, deliverables, ledgers] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { tenant: true, plan: true },
    }),
    prisma.session.groupBy({ by: ['userId'], _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.deliverable.groupBy({ by: ['userId'], _count: { _all: true } }),
    prisma.creditLedger.findMany({ orderBy: { createdAt: 'asc' } }),
  ]);
  const sessionMap = new Map(sessions.map((s) => [s.userId, { count: s._count._all, lastAt: s._max.updatedAt }]));
  const deliverableMap = new Map(deliverables.map((d) => [d.userId, d._count._all]));
  const creditMap = new Map<string, { balance: number; granted: number; spent: number }>();
  for (const l of ledgers) {
    const s = creditMap.get(l.userId) ?? { balance: 0, granted: 0, spent: 0 };
    s.balance = l.balance;
    if (l.delta > 0) s.granted += l.delta;
    if (l.delta < 0) s.spent += Math.abs(l.delta);
    creditMap.set(l.userId, s);
  }
  return users.map((u) => {
    const sess = sessionMap.get(u.id);
    const credit = creditMap.get(u.id) ?? { balance: 0, granted: 0, spent: 0 };
    return {
      id: u.id,
      name: u.name,
      phone: displayPhone(u.phone),
      role: u.role,
      tenantId: u.tenantId,
      tenantName: u.tenant.name,
      planName: u.plan?.name ?? null,
      benmingColor: u.benmingColor,
      wechatLinked: !!u.wechatOpenId,
      createdAt: isoSecond(u.createdAt),
      lastSessionAt: sess?.lastAt ? isoSecond(sess.lastAt) : null,
      sessionCount: sess?.count ?? 0,
      deliverableCount: deliverableMap.get(u.id) ?? 0,
      creditBalance: credit.balance,
      totalGranted: credit.granted,
      totalSpent: credit.spent,
    };
  });
}

function displayPhone(phone: string): string {
  if (phone.startsWith('wx_')) return '微信账号';
  return phone;
}

function auditIcon(action: string): string {
  if (action.includes('agent')) return 'agent';
  if (action.includes('auth')) return 'user';
  if (action.includes('credit') || action.includes('generate') || action.includes('plan')) return 'crown';
  if (action.includes('http')) return 'clock';
  if (action.includes('ai')) return 'insight';
  return 'alert';
}

function auditLabel(action: string): string {
  const labels: Record<string, string> = {
    'auth.register': '手机号注册',
    'auth.wechat_register': '微信注册',
    'admin.agent.publish': '功能上架',
    'admin.agent.unpublish': '功能下架',
    'admin.agent.update': '智能体配置变更',
    'admin.ai.update': '模型配置变更',
    'user.plan.purchase': '用户购买套餐',
    'user.http': '用户 API 行为',
    'user.generate': '用户发起产出',
    'user.library.create': '用户存入方案库',
    'user.library.delete': '用户删除方案',
    'user.session.summarize': '用户生成纪要',
  };
  return labels[action] ?? action;
}
