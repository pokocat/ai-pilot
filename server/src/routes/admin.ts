// 运营后台 API（《投产开发指导》§7）：概览看板 / 每日献策 / 智能体（提示词+记忆）/ 问卷 / 套餐。
// 鉴权：本插件内所有 /admin/* 路由统一走 requireAdmin 前置校验（共享密钥 ADMIN_TOKEN 或 role=admin 账号）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { getAiConfig, setAiConfig, publicConfig, AI_PRESETS, type ResolvedAiConfig } from '../services/aiConfig.js';
import { pingModel, pingAgentRuntime } from '../llm/gateway.js';
import { requireAdmin } from '../services/adminAuth.js';
import { tokenUsageSummary } from '../services/usage.js';
import { isoSecond, recordAudit } from '../services/audit.js';
import type { AiConfigUpdate } from '../llm/schema.js';
import type {
  AdminAuditItem, AdminUserItem, AdminUsageView, AdminTokenUsageView,
  AdminAgentCreate, AdminAgentUpdate, AdminUserDetail, AdminUserAgentRow, AgentBilling,
  AgentProviderMode, AgentRuntimeUpdate, AgentRuntimeView, AiTestResult,
} from '../../../shared/contracts';
import type { Prisma } from '@prisma/client';

const BILLINGS: AgentBilling[] = ['free', 'unlock', 'metered'];
function normalizeBilling(b: unknown): AgentBilling {
  return BILLINGS.includes(b as AgentBilling) ? (b as AgentBilling) : 'free';
}

const PROVIDER_MODES: AgentProviderMode[] = ['inherit', 'openai', 'dify'];

// 库行 → 脱敏的接入视图（不回明文 key）。
function runtimeView(a: {
  providerMode: string; apiBaseUrl: string | null; apiModel: string | null; apiKey: string | null;
  difyBaseUrl: string | null; difyApiKey: string | null; difyInputs: unknown;
}): AgentRuntimeView {
  return {
    providerMode: (PROVIDER_MODES.includes(a.providerMode as AgentProviderMode) ? a.providerMode : 'inherit') as AgentProviderMode,
    apiBaseUrl: a.apiBaseUrl ?? '',
    apiModel: a.apiModel ?? '',
    hasApiKey: !!(a.apiKey && a.apiKey.trim()),
    difyBaseUrl: a.difyBaseUrl ?? '',
    hasDifyKey: !!(a.difyApiKey && a.difyApiKey.trim()),
    difyInputs: (a.difyInputs as Record<string, string> | null) ?? {},
  };
}

// 接入更新入参 → Prisma 写入字段。key 仅在显式传入时更新（空串=清空、undefined=不动，避免脱敏回显覆盖真实 key）。
function runtimeData(rt?: AgentRuntimeUpdate): Prisma.AgentUpdateInput {
  if (!rt) return {};
  const d: Prisma.AgentUpdateInput = {};
  if (rt.providerMode !== undefined) d.providerMode = PROVIDER_MODES.includes(rt.providerMode) ? rt.providerMode : 'inherit';
  if (rt.apiBaseUrl !== undefined) d.apiBaseUrl = rt.apiBaseUrl.trim() || null;
  if (rt.apiModel !== undefined) d.apiModel = rt.apiModel.trim() || null;
  if (rt.apiKey !== undefined) d.apiKey = rt.apiKey || null;
  if (rt.difyBaseUrl !== undefined) d.difyBaseUrl = rt.difyBaseUrl.trim() || null;
  if (rt.difyApiKey !== undefined) d.difyApiKey = rt.difyApiKey || null;
  if (rt.difyInputs !== undefined) d.difyInputs = (rt.difyInputs ?? {}) as Prisma.InputJsonValue;
  return d;
}

export async function adminRoutes(app: FastifyInstance) {
  // 鉴权：拦截本插件内全部 /admin/* 路由（adminRoutes 为独立封装上下文，不影响其它路由）。
  app.addHook('preHandler', requireAdmin);

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
        { v: String(spent), l: '累计消耗（点）', d: '按流水统计', trend: spent > 0 ? 'down' : 'up' },
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

  // 单用户详情 + 智能体开通管理（运营决定「给哪个用户开通哪个智能体」）
  app.get<{ Params: { id: string } }>('/admin/users/:id', async (req, reply): Promise<AdminUserDetail | void> => {
    const users = await buildAdminUsers();
    const user = users.find((u) => u.id === req.params.id);
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const [agents, owned] = await Promise.all([
      prisma.agent.findMany({ where: { billing: 'unlock' }, orderBy: { sort: 'asc' } }),
      prisma.userAgent.findMany({ where: { userId: req.params.id } }),
    ]);
    const ownedMap = new Map(owned.map((o) => [o.agentKey, o]));
    const rows: AdminUserAgentRow[] = agents.map((a) => {
      const row = ownedMap.get(a.key);
      return {
        key: a.key, name: a.name, role: a.role, icon: a.icon,
        billing: a.billing as AgentBilling, price: a.price,
        owned: !!row, source: row?.source ?? null,
        grantedAt: row ? isoSecond(row.createdAt) : null,
      };
    });
    return { user, agents: rows };
  });

  // 后台为用户开通智能体（免费开通，记 admin_grant）
  app.post<{ Params: { id: string }; Body: { agentKey: string } }>('/admin/users/:id/agents', async (req, reply) => {
    const agentKey = (req.body?.agentKey ?? '').trim();
    const [user, agent] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.params.id } }),
      agentKey ? prisma.agent.findUnique({ where: { key: agentKey } }) : null,
    ]);
    if (!user) return reply.code(404).send({ error: 'user not found' });
    if (!agent) return reply.code(404).send({ error: 'agent not found' });
    await prisma.userAgent.upsert({
      where: { userId_agentKey: { userId: user.id, agentKey } },
      update: {},
      create: { userId: user.id, agentKey, source: 'admin_grant', pricePaid: 0 },
    });
    await recordAudit({
      tenantId: user.tenantId, userId: user.id,
      action: 'admin.user.agent.grant', payload: { agentKey, agentName: agent.name },
    });
    return { ok: true };
  });

  // 后台取消用户的智能体开通
  app.delete<{ Params: { id: string; key: string } }>('/admin/users/:id/agents/:key', async (req) => {
    await prisma.userAgent.deleteMany({ where: { userId: req.params.id, agentKey: req.params.key } });
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { tenantId: true } });
    await recordAudit({
      tenantId: user?.tenantId ?? undefined, userId: req.params.id,
      action: 'admin.user.agent.revoke', payload: { agentKey: req.params.key },
    });
    return { ok: true };
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

  // —— Token 用量看板（计费 P1·旁路统计，不参与按次扣费）：近 N 天 token 与估算成本，按模型/天/Top 用户 ——
  app.get<{ Querystring: { days?: string } }>('/admin/token-usage', async (req): Promise<AdminTokenUsageView> => {
    const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 90);
    return tokenUsageSummary(days);
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

  // —— 智能体配置（含 计费/价格 + System 提示词 + Agent Memory） ——
  app.get('/admin/agents', async () => {
    const [agents, sessionGroups, deliverableGroups, ownerGroups] = await Promise.all([
      prisma.agent.findMany({ orderBy: { sort: 'asc' } }),
      prisma.session.groupBy({ by: ['agentKey'], _count: { _all: true } }),
      prisma.deliverable.groupBy({ by: ['agentKey'], _count: { _all: true } }),
      prisma.userAgent.groupBy({ by: ['agentKey'], _count: { _all: true } }),
    ]);
    const sessions = new Map(sessionGroups.map((g) => [g.agentKey, g._count._all]));
    const deliverables = new Map(deliverableGroups.map((g) => [g.agentKey, g._count._all]));
    const owners = new Map(ownerGroups.map((g) => [g.agentKey, g._count._all]));
    return agents.map((a) => ({
      key: a.key, name: a.name, role: a.role, icon: a.icon, type: a.type,
      gift: a.gift, billing: a.billing, price: a.price, billingRatio: a.billingRatio, meterUnit: a.meterUnit, enabled: a.enabled, deliverableKey: a.deliverableKey,
      ownerCount: owners.get(a.key) ?? 0,
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
      gift: a.gift, billing: a.billing, price: a.price, billingRatio: a.billingRatio, meterUnit: a.meterUnit,
      enabled: a.enabled, systemPrompt: a.systemPrompt, memoryConfig: a.memoryConfig,
      deliverableKey: a.deliverableKey,
      runtime: runtimeView(a),
    };
  });
  // 新增智能体（后台可上架更多智能体）。key 唯一；缺省字段给安全默认值。
  app.post<{ Body: AdminAgentCreate }>('/admin/agents', async (req, reply) => {
    const b = req.body ?? ({} as AdminAgentCreate);
    const key = (b.key ?? '').trim();
    const name = (b.name ?? '').trim();
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(key)) {
      return reply.code(400).send({ error: 'key 仅限小写字母/数字/下划线，且字母开头', code: 'BAD_KEY' });
    }
    if (!name) return reply.code(400).send({ error: '名称不能为空', code: 'BAD_NAME' });
    if (await prisma.agent.findUnique({ where: { key } })) {
      return reply.code(409).send({ error: 'key 已存在', code: 'KEY_EXISTS' });
    }
    const billing = normalizeBilling(b.billing);
    const maxSort = await prisma.agent.aggregate({ _max: { sort: true } });
    const a = await prisma.agent.create({
      data: {
        key,
        name,
        role: (b.role ?? '').trim() || '自定义智能体',
        icon: b.icon || 'spark',
        type: b.type ?? 'custom',
        gift: billing === 'free',
        billing,
        price: billing === 'free' ? 0 : Math.max(0, Math.trunc(b.price ?? 0)),
        billingRatio: typeof b.billingRatio === 'number' && b.billingRatio > 0 ? b.billingRatio : 1,
        meterUnit: b.meterUnit === 'image' ? 'image' : 'text',
        enabled: b.enabled ?? false,
        greet: b.greet || `你好，我是${name}。`,
        chipsJson: [],
        memText: '',
        learnText: '记忆已更新',
        systemPrompt: b.systemPrompt || `你是「${name}」，请专注于商业场景，给出可执行的建议与产出。`,
        deliverableKey: b.deliverableKey ?? null,
        memoryConfig: { longTerm: true, autoLearn: true, intensity: 'balanced', retentionDays: 180, sources: ['conversation', 'document'] },
        sort: (maxSort._max.sort ?? 0) + 1,
      },
    });
    await recordAudit({ action: 'admin.agent.create', payload: { key: a.key, name: a.name, billing: a.billing, price: a.price } });
    return { ok: true, key: a.key };
  });
  app.patch<{ Params: { key: string }; Body: AdminAgentUpdate }>(
    '/admin/agents/:key',
    async (req, reply) => {
      const before = await prisma.agent.findUnique({ where: { key: req.params.key } });
      if (!before) return reply.code(404).send({ error: 'not found' });
      const b = req.body ?? {};
      const billing = b.billing !== undefined ? normalizeBilling(b.billing) : undefined;
      const targetBilling = billing ?? (before.billing as AgentBilling);
      const a = await prisma.agent.update({
        where: { key: req.params.key },
        data: {
          name: b.name?.trim() || undefined,
          role: b.role?.trim() || undefined,
          icon: b.icon || undefined,
          type: b.type || undefined,
          gift: targetBilling === 'free',
          billing,
          // free 计费价格强制归零；否则按入参（非负整数）
          price: billing === 'free' ? 0 : (typeof b.price === 'number' ? Math.max(0, Math.trunc(b.price)) : undefined),
          billingRatio: typeof b.billingRatio === 'number' && b.billingRatio > 0 ? b.billingRatio : undefined,
          meterUnit: b.meterUnit === 'text' || b.meterUnit === 'image' ? b.meterUnit : undefined,
          greet: typeof b.greet === 'string' && b.greet.trim() ? b.greet : undefined,
          deliverableKey: b.deliverableKey === undefined ? undefined : (b.deliverableKey || null),
          systemPrompt: b.systemPrompt,
          memoryConfig: b.memoryConfig as object | undefined,
          enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
          ...runtimeData(b.runtime), // 接入方式（跟随全局 / 自定义端点 / Dify 应用）
        },
      });
      const enabledChanged = typeof b.enabled === 'boolean' && before.enabled !== b.enabled;
      await recordAudit({
        action: enabledChanged ? (a.enabled ? 'admin.agent.publish' : 'admin.agent.unpublish') : 'admin.agent.update',
        payload: {
          key: a.key,
          name: a.name,
          enabled: a.enabled,
          billing: a.billing,
          price: a.price,
          systemPromptChanged: typeof b.systemPrompt === 'string',
          memoryConfigChanged: !!b.memoryConfig,
          providerMode: a.providerMode,
          runtimeChanged: !!b.runtime,
        },
      });
      return { ok: true, key: a.key };
    },
  );

  // 测试某个智能体的接入连接（提交未保存的改动；key 留空则用已存 key）。
  app.post<{ Params: { key: string }; Body: AgentRuntimeUpdate }>(
    '/admin/agents/:key/test',
    async (req, reply): Promise<AiTestResult | void> => {
      const a = await prisma.agent.findUnique({ where: { key: req.params.key } });
      if (!a) return reply.code(404).send({ error: 'not found' });
      const rt = req.body ?? {};
      const mode = (rt.providerMode ?? a.providerMode) as AgentProviderMode;
      if (mode === 'dify') {
        return pingAgentRuntime({
          mode: 'dify',
          difyBaseUrl: rt.difyBaseUrl ?? a.difyBaseUrl ?? undefined,
          difyApiKey: (rt.difyApiKey && rt.difyApiKey.length ? rt.difyApiKey : a.difyApiKey) ?? undefined,
          difyInputs: rt.difyInputs ?? (a.difyInputs as Record<string, string> | null) ?? undefined,
        });
      }
      if (mode === 'openai') {
        return pingAgentRuntime({
          mode: 'openai',
          baseUrl: rt.apiBaseUrl ?? a.apiBaseUrl ?? undefined,
          model: rt.apiModel ?? a.apiModel ?? undefined,
          apiKey: (rt.apiKey && rt.apiKey.length ? rt.apiKey : a.apiKey) ?? undefined,
        });
      }
      return { ok: false, provider: 'inherit', error: '当前为「跟随全局模型」，请到「模型配置」页测试连接' };
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
  app.patch<{ Params: { id: string }; Body: { name?: string; price?: number; creditsPerMonth?: number; tokenQuotaPerMonth?: number; agentCount?: number; featuresJson?: string[]; highlighted?: boolean } }>(
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
    'admin.agent.create': '新增智能体',
    'admin.user.agent.grant': '后台开通智能体',
    'admin.user.agent.revoke': '取消智能体开通',
    'user.agent.purchase': '用户解锁智能体',
    'admin.ai.update': '模型配置变更',
    'admin.account.init': '初始化后台账户',
    'admin.account.login': '后台账户登录',
    'admin.account.password': '修改后台密码',
    'user.plan.purchase': '用户购买套餐',
    'user.http': '用户 API 行为',
    'user.generate': '用户发起产出',
    'user.library.create': '用户存入方案库',
    'user.library.delete': '用户删除方案',
    'user.session.summarize': '用户生成纪要',
  };
  return labels[action] ?? action;
}
