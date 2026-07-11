// 运营后台 API（《投产开发指导》§7）：概览看板 / 每日献策 / 智能体（提示词+记忆）/ 问卷 / 套餐。
// 鉴权：本插件内所有 /admin/* 路由统一走 requireAdmin 前置校验（共享密钥 ADMIN_TOKEN 或 role=admin 账号）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import {
  getAiConfig, setAiConfig, publicConfig, AI_PRESETS, effectiveProvider, type ResolvedAiConfig,
  listModels, addModel, updateModel, deleteModel, activateModel, mergedTestConfig,
} from '../services/aiConfig.js';
import { testEmbedding } from '../services/embedding.js';
import { testRerank } from '../services/rerank.js';
import { pingModel, pingAgentRuntime, generateDeliverable, chatComplete } from '../llm/gateway.js';
import { buildSandboxContext } from '../services/context.js';
import {
  requireAdmin, actorOf, isSuperActor, requireAgentAccess, actorAccountId, type AdminActor,
} from '../services/adminAuth.js';
import {
  createOperator, listAccounts, setAccountDisabled, setAccountRole, resetAccountPassword,
} from '../services/adminAccount.js';
import { recomputeDraftDirty, publishDraft, rollbackToVersion, listVersions, getVersionDetail } from '../services/agentVersions.js';
import { startEvalRun, suggestTier, PRICING_TIERS, latestEvalScore } from '../services/evals.js';
import { encryptSecret, decryptSecretSafe } from '../services/secretBox.js';
import { tokenUsageSummary } from '../services/usage.js';
import { listTraces, getTrace } from '../services/trace.js';
import { listModerationLogs } from '../services/moderation.js';
import { isoSecond, recordAudit } from '../services/audit.js';
import { setFeatureFlag, setFeatureFlagPayload, isComplianceFlag } from '../services/featureFlag.js';
import { REVIEW_GRACE_PER_DAY } from '../services/tokenQuota.js';
import { selectableMeta, listDefs, createTool, updateTool, deleteTool, dryRunTool } from '../services/skillTools.js';
import { aggregateToolStats } from '../services/toolStats.js';
import { knowledgeView, reembedAll } from '../services/knowledgeAdmin.js';
import { retrievalDebug } from '../services/retrievalDebug.js';
import { userContextView } from '../services/adminUserContext.js';
import { deleteUserMemory, listAgentMemories, deleteAgentMemory } from '../services/memory.js';
import { getKnowledgeDetail, deleteKnowledge, reembedItem, ingestUploadedFile } from '../services/knowledge.js';
import type { AiConfigUpdate, AiModelUpsert, AiModelTest } from '../llm/schema.js';
import type {
  AdminAuditItem, AdminUserItem, AdminUsageView, AdminTokenUsageView,
  AdminAgentCreate, AdminAgentUpdate, AdminUserDetail, AdminUserAgentRow, AgentBilling,
  AgentProviderMode, AgentRuntimeUpdate, AgentRuntimeView, AiTestResult, SkillsConfig, SkillToolMeta,
  AdminTraceListView, AdminTraceDetail, AdminModerationLogView, AdminAgentMemoryView, SkillToolDef, SkillToolUpsert, AgentToolDryRunResult, ToolStatsView,
  AdminAccountItem, CreateAdminAccountRequest, UpdateAdminAccountRequest,
  AgentVersionListView, AgentVersionItem, AgentVersionDetail, PublishAgentRequest, PublishAgentResult, RollbackAgentRequest,
  SandboxRequest, SandboxResult, SandboxTarget,
  EvalSetItem, EvalSetDetail, EvalCaseItem, UpsertEvalSetRequest, UpsertEvalCaseRequest,
  EvalRunItem, EvalRunDetail, EvalCaseResultItem, StartEvalRunRequest, PricingTier,
  AdminProjectItem, AdminReportItem,
} from '../../../shared/contracts';
import { Prisma } from '@prisma/client';

// 功能开关目录（P0-2 / D-10）：label/desc/compliance/kind 写死在代码；DB 存 enabled(toggle) 或 payload(number)。
// number 类：payloadKey=payload 里的字段名；def=默认值；min/max=校验区间；unit=单位标签。
type FlagDef = {
  id: string; label: string; desc: string; compliance: boolean;
  kind: 'toggle' | 'number'; payloadKey?: string; def?: number; min?: number; max?: number; unit?: string;
};
const FEATURE_FLAG_CATALOG: FlagDef[] = [
  { id: 'fortune', label: '命理能力', desc: '关闭即全产品下线八字/命盘/天时日历/送你一卦，对话不再引用命盘（合规一键降级）', compliance: isComplianceFlag('fortune'), kind: 'toggle' },
  // D-10 复盘保底额度：额度耗尽时复盘类调用每日仍放行的次数（覆盖「日复盘+军令生成+2-3 次追问」动线，默认 6）。
  { id: 'review-grace', label: '复盘保底额度', desc: '月度 token 额度耗尽时，复盘类对话每日仍放行的次数（保住留存动线）', compliance: false, kind: 'number', payloadKey: 'perDay', def: REVIEW_GRACE_PER_DAY, min: 0, max: 50, unit: '次/日' },
];

// 把 service 抛出的 {statusCode, code} 错误统一回成 HTTP 响应。
function sendErr(reply: import('fastify').FastifyReply, e: unknown, fallback = 400) {
  const err = e as { statusCode?: number; code?: string; message?: string };
  return reply.code(err.statusCode ?? fallback).send({ error: err.message ?? '操作失败', code: err.code });
}

// 操作者可见/可编辑的 agent → 角色映射；超管返回 null（=全部可编辑）。用于列表过滤与 canEdit。
async function agentRoleMap(actor: AdminActor): Promise<Map<string, string> | null> {
  if (isSuperActor(actor)) return null;
  const accId = actorAccountId(actor);
  if (!accId) return new Map();
  const rows = await prisma.agentCollaborator.findMany({ where: { accountId: accId }, select: { agentKey: true, role: true } });
  return new Map(rows.map((r) => [r.agentKey, r.role]));
}

// 仅 owner/master/legacy 超管可执行（账户管理、新建 agent）。
function requireSuper(actor: AdminActor): void {
  if (!isSuperActor(actor)) throw Object.assign(new Error('需要 owner 权限'), { statusCode: 403, code: 'OWNER_ONLY' });
}

// 操作者展示名（写进审计 payload.by，便于多运营溯源）。
function actorName(actor: AdminActor): string {
  return actor.kind === 'account' ? actor.username : actor.kind === 'master' ? '主密钥' : '管理员';
}

// 组装某 agent 的版本历史视图（解析 createdBy → username，标注当前已发布版本）。
async function versionListView(agentKey: string): Promise<AgentVersionListView> {
  const agent = await prisma.agent.findUnique({ where: { key: agentKey }, select: { publishedVersionId: true, draftDirty: true } });
  const versions = await listVersions(agentKey);
  const byIds = [...new Set(versions.map((v) => v.createdBy).filter((x): x is string => !!x))];
  const accounts = byIds.length ? await prisma.adminAccount.findMany({ where: { id: { in: byIds } }, select: { id: true, username: true } }) : [];
  const nameMap = new Map(accounts.map((a) => [a.id, a.username]));
  return {
    agentKey,
    publishedVersionId: agent?.publishedVersionId ?? null,
    draftDirty: agent?.draftDirty ?? false,
    versions: versions.map((v): AgentVersionItem => ({
      id: v.id, version: v.version, status: v.status as AgentVersionItem['status'],
      label: v.label, changeSummary: v.changeSummary,
      billing: v.billing as AgentVersionItem['billing'], price: v.price, billingRatio: v.billingRatio,
      isPublished: v.id === agent?.publishedVersionId,
      createdBy: v.createdBy ? nameMap.get(v.createdBy) ?? null : null,
      createdAt: isoSecond(v.createdAt),
      publishedAt: v.publishedAt ? isoSecond(v.publishedAt) : null,
    })),
  };
}

// operator 的 agent 归属 = AgentCollaborator(role=editor) 集合。整体替换为给定 agentKeys。
async function syncCollaborators(accountId: string, agentKeys: string[]): Promise<void> {
  const keys = [...new Set((agentKeys ?? []).filter((k) => typeof k === 'string' && k.trim()))];
  const existing = keys.length ? await prisma.agent.findMany({ where: { key: { in: keys } }, select: { key: true } }) : [];
  const valid = existing.map((e) => e.key);
  await prisma.$transaction([
    prisma.agentCollaborator.deleteMany({ where: { accountId } }),
    ...valid.map((key) => prisma.agentCollaborator.create({ data: { accountId, agentKey: key, role: 'editor' } })),
  ]);
}

// 列出某账户负责的 agentKeys（用于账户列表回显）。
async function collaboratorKeysByAccount(): Promise<Map<string, string[]>> {
  const rows = await prisma.agentCollaborator.findMany({ select: { accountId: true, agentKey: true } });
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const arr = map.get(r.accountId) ?? [];
    arr.push(r.agentKey);
    map.set(r.accountId, arr);
  }
  return map;
}

// 沙盒被测目标：'draft'=草稿 | {versionId}=某历史版本 | 其它（'published'/未传）=已发布版本。
function sandboxTarget(t?: SandboxTarget): 'draft' | { versionId: string } | undefined {
  if (t === 'draft') return 'draft';
  if (t && typeof t === 'object' && t.versionId) return { versionId: t.versionId };
  return undefined;
}

// 沙盒展示用的 provider/model（近似运行时实际路由）。
async function sandboxProviderInfo(eff: {
  providerMode: string; apiBaseUrl: string | null; apiKey: string | null; apiModel: string | null; difyBaseUrl: string | null; difyApiKey: string | null;
}): Promise<{ provider: string; model: string }> {
  if (eff.providerMode === 'dify' && eff.difyBaseUrl && eff.difyApiKey) return { provider: 'dify', model: 'dify' };
  if (eff.providerMode === 'openai' && eff.apiBaseUrl && eff.apiKey) {
    const cfg = await getAiConfig();
    return { provider: 'openai', model: eff.apiModel || cfg.model };
  }
  const cfg = await getAiConfig();
  const ep = effectiveProvider(cfg);
  return { provider: ep, model: ep === 'mock' ? 'template' : cfg.model };
}

// 评测：从 set/case/run 反查 agentKey（用于无 :key 路由的按 agent 授权）。
async function agentKeyOfSet(setId: string): Promise<string | null> {
  const s = await prisma.evalSet.findUnique({ where: { id: setId }, select: { agentKey: true } });
  return s?.agentKey ?? null;
}
async function agentKeyOfCase(caseId: string): Promise<string | null> {
  const c = await prisma.evalCase.findUnique({ where: { id: caseId }, select: { set: { select: { agentKey: true } } } });
  return c?.set.agentKey ?? null;
}
// StartEvalRun 的 target → PreviewTarget + 展示标签。
async function evalTargetAndLabel(t?: SandboxTarget): Promise<{ target?: 'draft' | { versionId: string }; label: string }> {
  if (t === 'draft') return { target: 'draft', label: '草稿' };
  if (t && typeof t === 'object' && t.versionId) {
    const v = await prisma.agentVersion.findUnique({ where: { id: t.versionId }, select: { version: true } });
    return { target: { versionId: t.versionId }, label: v ? `v${v.version}` : '指定版本' };
  }
  return { target: undefined, label: '已发布' };
}

const BILLINGS: AgentBilling[] = ['free', 'unlock', 'metered'];
function normalizeBilling(b: unknown): AgentBilling {
  return BILLINGS.includes(b as AgentBilling) ? (b as AgentBilling) : 'free';
}

const PROVIDER_MODES: AgentProviderMode[] = ['inherit', 'openai', 'dify'];

// 库 skillsConfig → 规范化 SkillsConfig。tools 保留所有非空字符串（内置名或自定义工具 key）；
// 失效/已删的 key 运行时解析自动跳过，不在此处硬卡（解耦 DB）。
function normalizeSkills(raw: unknown): SkillsConfig {
  const s = (raw as Partial<SkillsConfig> | null) ?? null;
  const tools = Array.isArray(s?.tools) ? [...new Set(s!.tools.filter((t): t is string => typeof t === 'string' && !!t.trim()))] : [];
  return { enabled: !!s?.enabled, tools };
}

// 库行 → 脱敏的接入视图（不回明文 key）。
function runtimeView(a: {
  providerMode: string; apiBaseUrl: string | null; apiModel: string | null; apiTemperature: number | null; apiKey: string | null;
  difyBaseUrl: string | null; difyApiKey: string | null; difyInputs: unknown; skillsConfig: unknown;
}): AgentRuntimeView {
  return {
    providerMode: (PROVIDER_MODES.includes(a.providerMode as AgentProviderMode) ? a.providerMode : 'inherit') as AgentProviderMode,
    apiBaseUrl: a.apiBaseUrl ?? '',
    apiModel: a.apiModel ?? '',
    apiTemperature: a.apiTemperature ?? null,
    hasApiKey: !!(a.apiKey && a.apiKey.trim()),
    difyBaseUrl: a.difyBaseUrl ?? '',
    hasDifyKey: !!(a.difyApiKey && a.difyApiKey.trim()),
    difyInputs: (a.difyInputs as Record<string, string> | null) ?? {},
    skills: normalizeSkills(a.skillsConfig),
  };
}

// 接入更新入参 → Prisma 写入字段。key 仅在显式传入时更新（空串=清空、undefined=不动，避免脱敏回显覆盖真实 key）。
function runtimeData(rt?: AgentRuntimeUpdate): Prisma.AgentUpdateInput {
  if (!rt) return {};
  const d: Prisma.AgentUpdateInput = {};
  if (rt.providerMode !== undefined) d.providerMode = PROVIDER_MODES.includes(rt.providerMode) ? rt.providerMode : 'inherit';
  if (rt.apiBaseUrl !== undefined) d.apiBaseUrl = rt.apiBaseUrl.trim() || null;
  if (rt.apiModel !== undefined) d.apiModel = rt.apiModel.trim() || null;
  if (rt.apiTemperature !== undefined) d.apiTemperature = rt.apiTemperature; // P2-7：null=清空（跟随全局）
  if (rt.apiKey !== undefined) d.apiKey = rt.apiKey ? encryptSecret(rt.apiKey) : null;
  if (rt.difyBaseUrl !== undefined) d.difyBaseUrl = rt.difyBaseUrl.trim() || null;
  if (rt.difyApiKey !== undefined) d.difyApiKey = rt.difyApiKey ? encryptSecret(rt.difyApiKey) : null;
  if (rt.difyInputs !== undefined) d.difyInputs = (rt.difyInputs ?? {}) as Prisma.InputJsonValue;
  if (rt.skills !== undefined) d.skillsConfig = normalizeSkills(rt.skills) as unknown as Prisma.InputJsonValue;
  return d;
}

export async function adminRoutes(app: FastifyInstance) {
  // 鉴权：拦截本插件内全部 /admin/* 路由（adminRoutes 为独立封装上下文，不影响其它路由）。
  app.addHook('preHandler', requireAdmin);

  // —— 知识库视图 + 存量维度体检/重嵌（嵌入来源变更后存量会维度不匹配、向量召回静默失效）——
  app.get('/admin/knowledge', async () => knowledgeView());
  app.post('/admin/knowledge/reembed', async () => {
    const r = await reembedAll();
    await recordAudit({ action: 'admin.knowledge.reembed', payload: { chunks: r.chunks, memories: r.memories, dim: r.dim } });
    return r;
  });

  // —— 检索调试台：对某用户跑真实检索，看命中 / 融合分 / rerank 前后 / 记忆召回 / 最终注入上下文 ——
  app.post<{ Body: { userId?: string; query?: string; agentKey?: string } }>('/admin/retrieval-test', async (req, reply) => {
    const userId = (req.body?.userId || '').trim();
    const query = (req.body?.query || '').trim();
    if (!userId || !query) return reply.code(400).send({ error: '缺少 userId 或 query' });
    const result = await retrievalDebug(userId, query, (req.body?.agentKey || '').trim() || undefined);
    if (!result) return reply.code(404).send({ error: '用户不存在' });
    return result;
  });

  // —— 大模型配置（运营后台可随时切换；默认 Agnes 2.0 Flash） ——
  // config=当前生效配置；presets=内置接入商目录（添加向导用）；models=已添加模型（快速切换源）。
  app.get('/admin/ai-config', async () => {
    const cfg = await getAiConfig(true);
    return { config: publicConfig(cfg), presets: AI_PRESETS, models: await listModels() };
  });
  app.put<{ Body: AiConfigUpdate }>('/admin/ai-config', async (req) => {
    const cfg = await setAiConfig(req.body ?? {});
    await recordAudit({ action: 'admin.ai.update', payload: { provider: cfg.provider, model: cfg.model } });
    return { config: publicConfig(cfg), presets: AI_PRESETS, models: await listModels() };
  });

  // —— 已添加模型：增删改 + 快速切换（生效）+ 探活 ——
  app.post<{ Body: AiModelUpsert }>('/admin/ai-models', async (req, reply) => {
    const b = req.body;
    if (!b || !b.label?.trim() || !b.provider) return reply.code(400).send({ error: '缺少展示名或协议' });
    const m = await addModel(b);
    await recordAudit({ action: 'admin.ai.model.add', payload: { id: m.id, provider: m.provider, model: m.model } });
    return m;
  });
  app.patch<{ Params: { id: string }; Body: AiModelUpsert }>('/admin/ai-models/:id', async (req, reply) => {
    const m = await updateModel(req.params.id, req.body ?? ({} as AiModelUpsert));
    if (!m) return reply.code(404).send({ error: '模型不存在' });
    await recordAudit({ action: 'admin.ai.model.update', payload: { id: m.id, provider: m.provider, model: m.model } });
    return m;
  });
  app.delete<{ Params: { id: string } }>('/admin/ai-models/:id', async (req, reply) => {
    const r = await deleteModel(req.params.id);
    if (!r.ok) return reply.code(409).send({ error: r.reason || '删除失败' });
    await recordAudit({ action: 'admin.ai.model.delete', payload: { id: req.params.id } });
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/admin/ai-models/:id/activate', async (req, reply) => {
    try {
      const cfg = await activateModel(req.params.id);
      await recordAudit({ action: 'admin.ai.model.activate', payload: { id: req.params.id, provider: cfg.provider, model: cfg.model } });
      return { config: publicConfig(cfg), presets: AI_PRESETS, models: await listModels() };
    } catch (err) {
      return reply.code(404).send({ error: (err as Error).message });
    }
  });
  // 探活：用「添加/编辑表单」字段直测（modelId 传入且 key 空则取该模型已存 key）。
  app.post<{ Body: AiModelTest }>('/admin/ai-models/test', async (req) => {
    return pingModel(await mergedTestConfig(req.body ?? ({} as AiModelTest)));
  });
  // 测试连接：用「当前保存配置」叠加本次未保存的改动（各 key 留空则用已存 key）。
  // 对话模型必测；嵌入/重排若开启则一并探活回传。
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
      embeddingEnabled: b.embeddingEnabled ?? saved.embeddingEnabled,
      embeddingBaseUrl: b.embeddingBaseUrl ?? saved.embeddingBaseUrl,
      embeddingApiKey: b.embeddingApiKey && b.embeddingApiKey.length ? b.embeddingApiKey : saved.embeddingApiKey,
      rerankEnabled: b.rerankEnabled ?? saved.rerankEnabled,
      rerankModel: b.rerankModel ?? saved.rerankModel,
      rerankBaseUrl: b.rerankBaseUrl ?? saved.rerankBaseUrl,
      rerankApiKey: b.rerankApiKey && b.rerankApiKey.length ? b.rerankApiKey : saved.rerankApiKey,
    };
    const result: AiTestResult = await pingModel(merged);
    if (merged.embeddingEnabled) result.embedding = await testEmbedding(merged);
    if (merged.rerankEnabled) result.rerank = await testRerank(merged);
    return result;
  });

  // agent 可勾选的工具（内置 + 启用的自定义工具）。
  app.get('/admin/skill-tools', async (): Promise<SkillToolMeta[]> => selectableMeta());

  // P2-10：per-tool 运行观测（成功率/错误率/延迟），可选按 agentKey + 天数过滤。
  app.get<{ Querystring: { agentKey?: string; days?: string } }>('/admin/tool-stats', async (req): Promise<ToolStatsView> => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const stats = await aggregateToolStats({ agentKey: req.query.agentKey, days });
    return { sinceDays: days, stats };
  });

  // P2-10：单工具试跑（运营配置后验证工具真能执行）。
  app.post<{ Params: { key: string; name: string }; Body: { args?: Record<string, unknown> } }>('/admin/agents/:key/tools/:name/dry-run', async (req, reply): Promise<AgentToolDryRunResult | void> => {
    try { await requireAgentAccess(actorOf(req), req.params.key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    return dryRunTool(req.params.key, req.params.name, req.body?.args ?? {});
  });

  // —— 技能库：运营自助管理的自定义 HTTP 工具 CRUD ——
  app.get('/admin/skill-tools/custom', async (): Promise<SkillToolDef[]> => listDefs());
  app.post<{ Body: SkillToolUpsert }>('/admin/skill-tools/custom', async (req, reply): Promise<SkillToolDef | void> => {
    try {
      const def = await createTool(req.body ?? ({} as SkillToolUpsert));
      await recordAudit({ action: 'admin.skilltool.create', payload: { key: def.key } });
      return def;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.patch<{ Params: { id: string }; Body: SkillToolUpsert }>('/admin/skill-tools/custom/:id', async (req, reply): Promise<SkillToolDef | void> => {
    try {
      const def = await updateTool(req.params.id, req.body ?? ({} as SkillToolUpsert));
      if (!def) return reply.code(404).send({ error: 'not found' });
      await recordAudit({ action: 'admin.skilltool.update', payload: { id: req.params.id, key: def.key } });
      return def;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.delete<{ Params: { id: string } }>('/admin/skill-tools/custom/:id', async (req, reply): Promise<{ ok: boolean } | void> => {
    const ok = await deleteTool(req.params.id);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    await recordAudit({ action: 'admin.skilltool.delete', payload: { id: req.params.id } });
    return { ok: true };
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

  // —— 只读看板：项目 / 报告（跨租户运营视图，纯读不改；知识库看板见 /admin/knowledge）——
  app.get<{ Querystring: { limit?: string } }>('/admin/projects', async (req): Promise<AdminProjectItem[]> => {
    const take = Math.min(200, Math.max(1, Number(req.query.limit ?? 100)));
    const rows = await prisma.project.findMany({
      orderBy: { updatedAt: 'desc' }, take,
      include: { tenant: { select: { name: true } }, _count: { select: { sessions: true, reports: true, knowledge: true } } },
    });
    return rows.map((p) => ({
      id: p.id, name: p.name, tenantName: p.tenant?.name ?? '', status: p.status,
      sessions: p._count.sessions, reports: p._count.reports, knowledge: p._count.knowledge,
      updatedAt: p.updatedAt.toISOString(),
    }));
  });

  app.get<{ Querystring: { limit?: string } }>('/admin/reports', async (req): Promise<AdminReportItem[]> => {
    const take = Math.min(200, Math.max(1, Number(req.query.limit ?? 100)));
    const rows = await prisma.reportDoc.findMany({
      orderBy: { updatedAt: 'desc' }, take,
      include: { tenant: { select: { name: true } }, agent: { select: { name: true } } },
    });
    return rows.map((r) => ({
      id: r.id, title: r.title, type: r.type, tenantName: r.tenant?.name ?? '',
      agentName: r.agent?.name ?? null, currentVersion: r.currentVersion, updatedAt: r.updatedAt.toISOString(),
    }));
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

  // —— 用户上下文中心：个人档案 + 长期记忆（按顾问）+ 知识库文档（观测与纠偏） ——
  app.get<{ Params: { id: string } }>('/admin/users/:id/context', async (req, reply) => {
    const view = await userContextView(req.params.id);
    if (!view) return reply.code(404).send({ error: 'user not found' });
    return view;
  });

  // 删除某用户的一条长期记忆（纠正脏记忆 / 隐私删除）
  app.delete<{ Params: { id: string; mid: string } }>('/admin/users/:id/memories/:mid', async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { tenantId: true } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    await deleteUserMemory(user.tenantId, req.params.id, req.params.mid);
    await recordAudit({ tenantId: user.tenantId, userId: req.params.id, action: 'admin.user.memory.delete', payload: { memoryId: req.params.mid } });
    return { ok: true };
  });

  // —— P1-C4：按 agent 跨用户浏览/纠正记忆（治理 auto-learn 写入的脏记忆，此前后台只能按单用户查删）——
  app.get<{ Params: { key: string }; Querystring: { limit?: string } }>('/admin/agents/:key/memories', async (req): Promise<AdminAgentMemoryView> => {
    return { items: await listAgentMemories(req.params.key, Number(req.query.limit) || 200) };
  });
  app.delete<{ Params: { key: string; mid: string } }>('/admin/agents/:key/memories/:mid', async (req, reply) => {
    const ok = await deleteAgentMemory(req.params.key, req.params.mid);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    await recordAudit({ action: 'admin.agent.memory.delete', payload: { agentKey: req.params.key, memoryId: req.params.mid } });
    return { ok: true };
  });

  // 某用户知识项详情（切片钻入 + 每片向量维度）
  app.get<{ Params: { id: string; kid: string } }>('/admin/users/:id/knowledge/:kid', async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { tenantId: true } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const detail = await getKnowledgeDetail(user.tenantId, req.params.kid);
    if (!detail) return reply.code(404).send({ error: 'knowledge not found' });
    return detail;
  });

  // 删除某用户知识项（含 OSS 原件）
  app.delete<{ Params: { id: string; kid: string } }>('/admin/users/:id/knowledge/:kid', async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { tenantId: true } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    await deleteKnowledge(user.tenantId, req.params.kid);
    await recordAudit({ tenantId: user.tenantId, userId: req.params.id, action: 'admin.user.knowledge.delete', payload: { itemId: req.params.kid } });
    return { ok: true };
  });

  // 重嵌某用户知识项（从已存正文重新切片+向量化）
  app.post<{ Params: { id: string; kid: string } }>('/admin/users/:id/knowledge/:kid/reembed', async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { tenantId: true } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const r = await reembedItem(user.tenantId, req.params.kid);
    await recordAudit({ tenantId: user.tenantId, userId: req.params.id, action: 'admin.user.knowledge.reembed', payload: { itemId: req.params.kid, chunks: r.chunks } });
    return r;
  });

  // 后台代用户上传文档（multipart 单文件）
  app.post<{ Params: { id: string } }>('/admin/users/:id/knowledge/upload', async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.params.id } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    let data;
    try { data = await req.file(); } catch { return reply.code(413).send({ error: '文件过大（上限 20MB）' }); }
    if (!data) return reply.code(400).send({ error: '未收到文件' });
    let buf: Buffer;
    try { buf = await data.toBuffer(); } catch { return reply.code(413).send({ error: '文件过大（上限 20MB）' }); }
    if (data.file.truncated) return reply.code(413).send({ error: '文件过大（上限 20MB）' });
    if (!buf.length) return reply.code(400).send({ error: '空文件' });
    const r = await ingestUploadedFile({ tenantId: user.tenantId, userId: user.id, fileName: data.filename || '未命名文件', mime: data.mimetype, buf });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'admin.user.knowledge.upload', payload: { itemId: r.id, fileName: data.filename } });
    return r;
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

  // —— 可观测（调用诊断）：每次 LLM 调用的耗时/状态/错误/工具调用，含错误与 mock ——
  app.get<{ Querystring: { days?: string; status?: string; agentKey?: string } }>('/admin/observability', async (req): Promise<AdminTraceListView> => {
    return listTraces({ days: Number(req.query.days) || 7, status: req.query.status, agentKey: req.query.agentKey });
  });
  app.get<{ Params: { id: string } }>('/admin/observability/:id', async (req, reply): Promise<AdminTraceDetail | void> => {
    const t = await getTrace(req.params.id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    return t;
  });

  // —— P1-B5：审核日志（此前 moderation_log 写完无读取入口，运营看不到拦了什么）——
  app.get<{ Querystring: { verdict?: string; refType?: string; limit?: string } }>('/admin/moderation-logs', async (req): Promise<AdminModerationLogView> => {
    return { items: await listModerationLogs({ verdict: req.query.verdict, refType: req.query.refType, limit: Number(req.query.limit) || 100 }) };
  });

  // —— 审计日志：默认看用户 API / 登录尝试；后台自身行为可用 includeAdmin=true 显式查看 ——
  app.get<{ Querystring: { limit?: string; userId?: string; action?: string; includeAdmin?: string } }>(
    '/admin/audit-logs',
    async (req): Promise<AdminAuditItem[]> => {
      const take = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 200);
      const includeAdmin = req.query.includeAdmin === 'true' || req.query.includeAdmin === '1';
      const where: Prisma.AuditLogWhereInput = {
        ...(req.query.userId ? { userId: req.query.userId } : {}),
        ...(req.query.action ? { action: req.query.action } : {}),
        ...(!includeAdmin && !req.query.action ? { NOT: { action: { startsWith: 'admin.' } } } : {}),
      };
      const logs = await prisma.auditLog.findMany({
        where,
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
        const payload = auditPayload(l.payloadJson);
        return {
          id: l.id,
          action: l.action,
          summary: auditSummary(l.action, payload),
          method: stringOrNull(payload.method),
          path: stringOrNull(payload.path),
          statusCode: numberOrNull(payload.statusCode),
          ip: stringOrNull(nested(payload, 'request', 'ip')),
          userAgent: stringOrNull(nested(payload, 'request', 'userAgent')),
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

  // —— 智能体配置（含 计费/价格 + System 提示词 + Agent Memory + 版本化） ——
  // 多运营：operator 仅见自己负责的 agent；owner/master 见全部。
  app.get('/admin/agents', async (req) => {
    const roles = await agentRoleMap(actorOf(req)); // null = 超管（全部可编辑）
    const [agents, sessionGroups, deliverableGroups, ownerGroups] = await Promise.all([
      prisma.agent.findMany({ orderBy: { sort: 'asc' } }),
      prisma.session.groupBy({ by: ['agentKey'], _count: { _all: true } }),
      prisma.deliverable.groupBy({ by: ['agentKey'], _count: { _all: true } }),
      prisma.userAgent.groupBy({ by: ['agentKey'], _count: { _all: true } }),
    ]);
    const sessions = new Map(sessionGroups.map((g) => [g.agentKey, g._count._all]));
    const deliverables = new Map(deliverableGroups.map((g) => [g.agentKey, g._count._all]));
    const owners = new Map(ownerGroups.map((g) => [g.agentKey, g._count._all]));
    const visible = roles ? agents.filter((a) => roles.has(a.key)) : agents;
    // 已发布版本号
    const pubIds = visible.map((a) => a.publishedVersionId).filter((x): x is string => !!x);
    const pubVers = pubIds.length
      ? await prisma.agentVersion.findMany({ where: { id: { in: pubIds } }, select: { id: true, version: true } })
      : [];
    const verMap = new Map(pubVers.map((v) => [v.id, v.version]));
    return visible.map((a) => ({
      key: a.key, name: a.name, role: a.role, icon: a.icon, type: a.type,
      gift: a.gift, billing: a.billing, price: a.price, billingRatio: a.billingRatio, meterUnit: a.meterUnit, enabled: a.enabled, deliverableKey: a.deliverableKey,
      ownerCount: owners.get(a.key) ?? 0,
      sessionCount: sessions.get(a.key) ?? 0,
      deliverableCount: deliverables.get(a.key) ?? 0,
      updatedAt: isoSecond(a.updatedAt),
      publishedVersionId: a.publishedVersionId,
      publishedVersion: a.publishedVersionId ? verMap.get(a.publishedVersionId) ?? null : null,
      draftDirty: a.draftDirty,
      canEdit: roles ? roles.get(a.key) === 'editor' : true,
    }));
  });
  app.get<{ Params: { key: string } }>('/admin/agents/:key', async (req, reply) => {
    try { await requireAgentAccess(actorOf(req), req.params.key, 'viewer'); } catch (e) { return sendErr(reply, e, 403); }
    const a = await prisma.agent.findUnique({ where: { key: req.params.key } });
    if (!a) return reply.code(404).send({ error: 'not found' });
    const pub = a.publishedVersionId ? await prisma.agentVersion.findUnique({ where: { id: a.publishedVersionId }, select: { version: true } }) : null;
    const roles = await agentRoleMap(actorOf(req));
    return {
      key: a.key, name: a.name, role: a.role, icon: a.icon, type: a.type,
      gift: a.gift, billing: a.billing, price: a.price, billingRatio: a.billingRatio, meterUnit: a.meterUnit,
      enabled: a.enabled, systemPrompt: a.systemPrompt, memoryConfig: a.memoryConfig,
      deliverableKey: a.deliverableKey, greet: a.greet,
      runtime: runtimeView(a),
      publishedVersionId: a.publishedVersionId,
      publishedVersion: pub?.version ?? null,
      draftDirty: a.draftDirty,
      canEdit: roles ? roles.get(a.key) === 'editor' : true,
    };
  });
  // 新增智能体（仅 owner/超管可上架更多智能体）。key 唯一；缺省字段给安全默认值。
  app.post<{ Body: AdminAgentCreate }>('/admin/agents', async (req, reply) => {
    try { requireSuper(actorOf(req)); } catch (e) { return sendErr(reply, e, 403); }
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
      const actor = actorOf(req);
      try { await requireAgentAccess(actor, req.params.key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
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
      const draftDirty = await recomputeDraftDirty(a.key); // 编辑草稿后按 草稿 vs 已发布 精确重算
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
          draftDirty,
          by: actorName(actor),
        },
      });
      return { ok: true, key: a.key, draftDirty };
    },
  );

  // 测试某个智能体的接入连接（提交未保存的改动；key 留空则用已存 key）。
  app.post<{ Params: { key: string }; Body: AgentRuntimeUpdate }>(
    '/admin/agents/:key/test',
    async (req, reply): Promise<AiTestResult | void> => {
      try { await requireAgentAccess(actorOf(req), req.params.key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
      const a = await prisma.agent.findUnique({ where: { key: req.params.key } });
      if (!a) return reply.code(404).send({ error: 'not found' });
      const rt = req.body ?? {};
      const mode = (rt.providerMode ?? a.providerMode) as AgentProviderMode;
      if (mode === 'dify') {
        return pingAgentRuntime({
          mode: 'dify',
          difyBaseUrl: rt.difyBaseUrl ?? a.difyBaseUrl ?? undefined,
          difyApiKey: (rt.difyApiKey && rt.difyApiKey.length ? rt.difyApiKey : decryptSecretSafe(a.difyApiKey)) || undefined,
          difyInputs: rt.difyInputs ?? (a.difyInputs as Record<string, string> | null) ?? undefined,
        });
      }
      if (mode === 'openai') {
        return pingAgentRuntime({
          mode: 'openai',
          baseUrl: rt.apiBaseUrl ?? a.apiBaseUrl ?? undefined,
          model: rt.apiModel ?? a.apiModel ?? undefined,
          apiKey: (rt.apiKey && rt.apiKey.length ? rt.apiKey : decryptSecretSafe(a.apiKey)) || undefined,
        });
      }
      return { ok: false, provider: 'inherit', error: '当前为「跟随全局模型」，请到「模型配置」页测试连接' };
    },
  );

  // —— 版本化：历史 / 发布 / 回滚 ——
  app.get<{ Params: { key: string } }>('/admin/agents/:key/versions', async (req, reply): Promise<AgentVersionListView | void> => {
    try { await requireAgentAccess(actorOf(req), req.params.key, 'viewer'); } catch (e) { return sendErr(reply, e, 403); }
    const a = await prisma.agent.findUnique({ where: { key: req.params.key }, select: { key: true } });
    if (!a) return reply.code(404).send({ error: 'not found' });
    return versionListView(req.params.key);
  });

  // P1-A6：查看单个版本完整内容（回滚前可审，不再「盲滚」）。
  app.get<{ Params: { key: string; vid: string } }>('/admin/agents/:key/versions/:vid', async (req, reply): Promise<AgentVersionDetail | void> => {
    try { await requireAgentAccess(actorOf(req), req.params.key, 'viewer'); } catch (e) { return sendErr(reply, e, 403); }
    const d = await getVersionDetail(req.params.key, req.params.vid);
    if (!d) return reply.code(404).send({ error: 'not found' });
    return d;
  });

  // 发布：把当前草稿冻结成新版本并指向它（C 端立即切到新版本）。
  app.post<{ Params: { key: string }; Body: PublishAgentRequest }>('/admin/agents/:key/publish', async (req, reply): Promise<PublishAgentResult | void> => {
    const actor = actorOf(req);
    try { await requireAgentAccess(actor, req.params.key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    try {
      const r = await publishDraft(req.params.key, { accountId: actorAccountId(actor), label: req.body?.label });
      // P1-A2：发布软门（opt-in）。设 EVAL_GATE_MIN>0 后，最近评测分低于阈值仅警示、不拦截（block vs warn 属产品策略，默认 warn）。
      let warning: string | null = null;
      const gateMin = Number(process.env.EVAL_GATE_MIN);
      if (Number.isFinite(gateMin) && gateMin > 0) {
        const score = await latestEvalScore(req.params.key);
        if (score == null) warning = '尚无评测分，建议先跑一次评测再发布。';
        else if (score < gateMin) warning = `最近评测分 ${score.toFixed(1)} 低于阈值 ${gateMin}，建议先调教/复评再发布。`;
      }
      await recordAudit({ action: 'admin.agentversion.publish', payload: { key: req.params.key, version: r.version, changed: r.changed, by: actorName(actor), warning } });
      return { ok: true, ...r, warning };
    } catch (e) { return sendErr(reply, e); }
  });

  // 回滚：把已发布指针重指到某历史版本（不动草稿）。
  app.post<{ Params: { key: string }; Body: RollbackAgentRequest }>('/admin/agents/:key/rollback', async (req, reply) => {
    const actor = actorOf(req);
    try { await requireAgentAccess(actor, req.params.key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    const versionId = (req.body?.versionId ?? '').trim();
    if (!versionId) return reply.code(400).send({ error: '缺少 versionId', code: 'BAD_VERSION' });
    try {
      const r = await rollbackToVersion(req.params.key, versionId);
      await recordAudit({ action: 'admin.agentversion.rollback', payload: { key: req.params.key, version: r.version, by: actorName(actor) } });
      return { ok: true, version: r.version };
    } catch (e) { return sendErr(reply, e); }
  });

  // —— 调教沙盒：用草稿/某版本即时试跑，返回产出 + 诊断指标（不真扣额度、不污染计费统计）——
  app.post<{ Params: { key: string }; Body: SandboxRequest }>('/admin/agents/:key/sandbox', async (req, reply): Promise<SandboxResult | void> => {
    try { await requireAgentAccess(actorOf(req), req.params.key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    const b = req.body ?? ({} as SandboxRequest);
    const text = (b.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: '请输入测试消息', code: 'EMPTY_TEXT' });
    const built = await buildSandboxContext({ agentKey: req.params.key, userMessage: text, target: sandboxTarget(b.target), profile: b.profile });
    if (!built) return reply.code(404).send({ error: 'agent not found' });
    const { ctx, effective } = built;
    const t0 = Date.now();
    const total = (u: { inputTokens: number; outputTokens: number }) => Math.max(0, u.inputTokens) + Math.max(0, u.outputTokens);
    const ratio = effective.billingRatio > 0 ? effective.billingRatio : 1;
    try {
      const { provider, model } = await sandboxProviderInfo(effective);
      const base = {
        source: effective.source, versionId: effective.versionId, versionNumber: effective.versionNumber,
        billingRatio: effective.billingRatio,
      };
      if (effective.deliverableKey) {
        const { result: deliverable, usage } = await generateDeliverable(ctx, { agentKey: effective.key, sandbox: true });
        const tt = total(usage);
        return {
          ...base, kind: 'report', deliverable, charged: Math.ceil(tt * ratio),
          trace: { provider, model, status: 'ok', latencyMs: Date.now() - t0, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInput: usage.cachedInput, totalTokens: tt, toolCalls: 0, iterations: 0, errorMessage: null },
        };
      }
      const { result: replyChat, usage } = await chatComplete(ctx, { agentKey: effective.key, sandbox: true });
      const tt = total(usage);
      return {
        ...base, kind: 'chat', reply: replyChat, charged: Math.ceil(tt * ratio),
        trace: { provider, model, status: 'ok', latencyMs: Date.now() - t0, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInput: usage.cachedInput, totalTokens: tt, toolCalls: 0, iterations: 0, errorMessage: null },
      };
    } catch (e) {
      const err = e as Error & { code?: string; statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message, code: err.code });
    }
  });

  // —— 评测：黄金测试集 CRUD + 跑分 + 建议定价档位 ——
  app.get('/admin/pricing-tiers', async (): Promise<PricingTier[]> => PRICING_TIERS);

  app.get<{ Params: { key: string } }>('/admin/agents/:key/eval-sets', async (req, reply): Promise<EvalSetItem[] | void> => {
    try { await requireAgentAccess(actorOf(req), req.params.key, 'viewer'); } catch (e) { return sendErr(reply, e, 403); }
    const sets = await prisma.evalSet.findMany({ where: { agentKey: req.params.key }, orderBy: { createdAt: 'desc' }, include: { _count: { select: { cases: true } } } });
    return sets.map((s) => ({ id: s.id, agentKey: s.agentKey, name: s.name, caseCount: s._count.cases, createdAt: isoSecond(s.createdAt) }));
  });
  app.post<{ Params: { key: string }; Body: UpsertEvalSetRequest }>('/admin/agents/:key/eval-sets', async (req, reply): Promise<EvalSetItem | void> => {
    const actor = actorOf(req);
    try { await requireAgentAccess(actor, req.params.key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    const name = (req.body?.name ?? '').trim() || '未命名评测集';
    const s = await prisma.evalSet.create({ data: { agentKey: req.params.key, name, createdBy: actorAccountId(actor) } });
    return { id: s.id, agentKey: s.agentKey, name: s.name, caseCount: 0, createdAt: isoSecond(s.createdAt) };
  });
  app.get<{ Params: { id: string } }>('/admin/eval-sets/:id', async (req, reply): Promise<EvalSetDetail | void> => {
    const key = await agentKeyOfSet(req.params.id);
    if (!key) return reply.code(404).send({ error: 'not found' });
    try { await requireAgentAccess(actorOf(req), key, 'viewer'); } catch (e) { return sendErr(reply, e, 403); }
    const s = await prisma.evalSet.findUnique({ where: { id: req.params.id }, include: { cases: { orderBy: { sort: 'asc' } } } });
    if (!s) return reply.code(404).send({ error: 'not found' });
    return {
      id: s.id, agentKey: s.agentKey, name: s.name, caseCount: s.cases.length, createdAt: isoSecond(s.createdAt),
      cases: s.cases.map((c): EvalCaseItem => ({ id: c.id, input: c.input, rubric: c.rubric, weight: c.weight, sort: c.sort, context: (c.contextJson as Record<string, unknown> | null) ?? null })),
    };
  });
  app.patch<{ Params: { id: string }; Body: UpsertEvalSetRequest }>('/admin/eval-sets/:id', async (req, reply) => {
    const key = await agentKeyOfSet(req.params.id);
    if (!key) return reply.code(404).send({ error: 'not found' });
    try { await requireAgentAccess(actorOf(req), key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    await prisma.evalSet.update({ where: { id: req.params.id }, data: { name: (req.body?.name ?? '').trim() || undefined } });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/admin/eval-sets/:id', async (req, reply) => {
    const key = await agentKeyOfSet(req.params.id);
    if (!key) return reply.code(404).send({ error: 'not found' });
    try { await requireAgentAccess(actorOf(req), key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    await prisma.evalSet.delete({ where: { id: req.params.id } });
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: UpsertEvalCaseRequest }>('/admin/eval-sets/:id/cases', async (req, reply): Promise<EvalCaseItem | void> => {
    const key = await agentKeyOfSet(req.params.id);
    if (!key) return reply.code(404).send({ error: 'not found' });
    try { await requireAgentAccess(actorOf(req), key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    const b = req.body ?? ({} as UpsertEvalCaseRequest);
    const input = (b.input ?? '').trim();
    if (!input) return reply.code(400).send({ error: '用例输入不能为空', code: 'EMPTY_INPUT' });
    const maxSort = await prisma.evalCase.aggregate({ where: { setId: req.params.id }, _max: { sort: true } });
    const c = await prisma.evalCase.create({
      data: {
        setId: req.params.id, input, rubric: b.rubric?.trim() || null,
        weight: typeof b.weight === 'number' && b.weight > 0 ? b.weight : 1,
        sort: (maxSort._max.sort ?? 0) + 1,
        contextJson: (b.context ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    return { id: c.id, input: c.input, rubric: c.rubric, weight: c.weight, sort: c.sort, context: (c.contextJson as Record<string, unknown> | null) ?? null };
  });
  app.patch<{ Params: { id: string }; Body: UpsertEvalCaseRequest }>('/admin/eval-cases/:id', async (req, reply) => {
    const key = await agentKeyOfCase(req.params.id);
    if (!key) return reply.code(404).send({ error: 'not found' });
    try { await requireAgentAccess(actorOf(req), key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    const b = req.body ?? {};
    await prisma.evalCase.update({
      where: { id: req.params.id },
      data: {
        input: typeof b.input === 'string' && b.input.trim() ? b.input.trim() : undefined,
        rubric: b.rubric === undefined ? undefined : (b.rubric.trim() || null),
        weight: typeof b.weight === 'number' && b.weight > 0 ? b.weight : undefined,
        sort: typeof b.sort === 'number' ? b.sort : undefined,
        contextJson: b.context === undefined ? undefined : ((b.context ?? Prisma.JsonNull) as Prisma.InputJsonValue),
      },
    });
    return { ok: true };
  });
  app.delete<{ Params: { id: string } }>('/admin/eval-cases/:id', async (req, reply) => {
    const key = await agentKeyOfCase(req.params.id);
    if (!key) return reply.code(404).send({ error: 'not found' });
    try { await requireAgentAccess(actorOf(req), key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    await prisma.evalCase.delete({ where: { id: req.params.id } });
    return { ok: true };
  });

  // 跑分（后台异步，前端轮询 run 状态）
  app.post<{ Params: { key: string }; Body: StartEvalRunRequest }>('/admin/agents/:key/eval-runs', async (req, reply): Promise<{ runId: string } | void> => {
    const actor = actorOf(req);
    try { await requireAgentAccess(actor, req.params.key, 'editor'); } catch (e) { return sendErr(reply, e, 403); }
    const setId = (req.body?.setId ?? '').trim();
    if (!setId) return reply.code(400).send({ error: '缺少 setId', code: 'BAD_SET' });
    try {
      const { target, label } = await evalTargetAndLabel(req.body?.target);
      const runId = await startEvalRun({ agentKey: req.params.key, setId, target, targetLabel: label, accountId: actorAccountId(actor) });
      await recordAudit({ action: 'admin.eval.run', payload: { key: req.params.key, setId, target: label, by: actorName(actor) } });
      return { runId };
    } catch (e) { return sendErr(reply, e); }
  });
  app.get<{ Params: { key: string } }>('/admin/agents/:key/eval-runs', async (req, reply): Promise<EvalRunItem[] | void> => {
    try { await requireAgentAccess(actorOf(req), req.params.key, 'viewer'); } catch (e) { return sendErr(reply, e, 403); }
    const runs = await prisma.evalRun.findMany({ where: { agentKey: req.params.key }, orderBy: { createdAt: 'desc' }, take: 30, include: { _count: { select: { results: true } } } });
    return runs.map((r): EvalRunItem => ({
      id: r.id, agentKey: r.agentKey, setId: r.setId, targetRef: r.targetRef, targetLabel: r.targetLabel,
      status: r.status, score: r.score, judgeModel: r.judgeModel, note: r.note, caseCount: r._count.results, createdAt: isoSecond(r.createdAt),
    }));
  });
  app.get<{ Params: { id: string } }>('/admin/eval-runs/:id', async (req, reply): Promise<EvalRunDetail | void> => {
    const run = await prisma.evalRun.findUnique({ where: { id: req.params.id }, include: { results: { orderBy: { createdAt: 'asc' } } } });
    if (!run) return reply.code(404).send({ error: 'not found' });
    try { await requireAgentAccess(actorOf(req), run.agentKey, 'viewer'); } catch (e) { return sendErr(reply, e, 403); }
    return {
      id: run.id, agentKey: run.agentKey, setId: run.setId, targetRef: run.targetRef, targetLabel: run.targetLabel,
      status: run.status, score: run.score, judgeModel: run.judgeModel, note: run.note, caseCount: run.results.length, createdAt: isoSecond(run.createdAt),
      results: run.results.map((r): EvalCaseResultItem => ({
        id: r.id, caseId: r.caseId, input: r.input, output: r.output, judgeScore: r.judgeScore, judgeNote: r.judgeNote,
        inputTokens: r.inputTokens, outputTokens: r.outputTokens, latencyMs: r.latencyMs,
      })),
      suggested: run.status === 'done' ? suggestTier(run.score) : null,
    };
  });

  // —— 多运营账户管理（仅 owner/超管）——
  app.get('/admin/accounts', async (req, reply): Promise<AdminAccountItem[] | void> => {
    try { requireSuper(actorOf(req)); } catch (e) { return sendErr(reply, e, 403); }
    const [rows, keyMap] = await Promise.all([listAccounts(), collaboratorKeysByAccount()]);
    return rows.map((r) => ({ ...r, agentKeys: r.role === 'owner' ? [] : keyMap.get(r.id) ?? [] }));
  });
  app.post<{ Body: CreateAdminAccountRequest }>('/admin/accounts', async (req, reply): Promise<AdminAccountItem | void> => {
    const actor = actorOf(req);
    try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
    const b = req.body ?? ({} as CreateAdminAccountRequest);
    try {
      const acc = await createOperator(b.username, b.password, b.role);
      if (acc.role !== 'owner' && Array.isArray(b.agentKeys)) await syncCollaborators(acc.id, b.agentKeys);
      await recordAudit({ action: 'admin.account.create', payload: { username: acc.username, role: acc.role, by: actorName(actor) } });
      const keyMap = await collaboratorKeysByAccount();
      return { ...acc, agentKeys: acc.role === 'owner' ? [] : keyMap.get(acc.id) ?? [] };
    } catch (e) { return sendErr(reply, e); }
  });
  app.patch<{ Params: { id: string }; Body: UpdateAdminAccountRequest }>('/admin/accounts/:id', async (req, reply): Promise<AdminAccountItem | void> => {
    const actor = actorOf(req);
    try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
    const b = req.body ?? {};
    try {
      let row = (await listAccounts()).find((a) => a.id === req.params.id);
      if (!row) return reply.code(404).send({ error: '账户不存在', code: 'NOT_FOUND' });
      if (typeof b.role === 'string') row = await setAccountRole(req.params.id, b.role);
      if (typeof b.disabled === 'boolean') row = await setAccountDisabled(req.params.id, b.disabled);
      if (typeof b.password === 'string' && b.password) await resetAccountPassword(req.params.id, b.password);
      if (Array.isArray(b.agentKeys) && row.role !== 'owner') await syncCollaborators(req.params.id, b.agentKeys);
      await recordAudit({ action: 'admin.account.update', payload: { id: req.params.id, username: row.username, by: actorName(actor) } });
      const keyMap = await collaboratorKeysByAccount();
      return { ...row, agentKeys: row.role === 'owner' ? [] : keyMap.get(row.id) ?? [] };
    } catch (e) { return sendErr(reply, e); }
  });

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

  // —— 功能开关（P0-2）：命理等合规开关一键降级。fortune 关 → 全产品命理端点 403 + 前端隐藏 ——
  // 开关目录写死在代码（label/desc/compliance），DB 只存 enabled；未落库的开关按默认开呈现。
  // 把 catalog 定义 + DB 行组装成对外的 AdminFeatureFlag（toggle 带 enabled；number 带 value/min/max/unit）。
  const shapeFlag = (f: FlagDef, row?: { enabled: boolean; payload: unknown } | null) => {
    const base = { id: f.id, label: f.label, desc: f.desc, compliance: f.compliance, kind: f.kind, enabled: row?.enabled ?? true };
    if (f.kind === 'number') {
      const payload = (row?.payload ?? null) as Record<string, unknown> | null;
      const raw = payload && f.payloadKey ? payload[f.payloadKey] : undefined;
      const value = typeof raw === 'number' ? raw : (f.def ?? 0);
      return { ...base, value, min: f.min, max: f.max, unit: f.unit };
    }
    return base;
  };

  app.get('/admin/flags', async () => {
    const rows = await prisma.featureFlag.findMany();
    const byId = new Map(rows.map((r) => [r.id, r]));
    return FEATURE_FLAG_CATALOG.map((f) => shapeFlag(f, byId.get(f.id)));
  });
  app.patch<{ Params: { id: string }; Body: { enabled?: boolean; value?: number } }>('/admin/flags/:id', async (req, reply) => {
    const def = FEATURE_FLAG_CATALOG.find((f) => f.id === req.params.id);
    if (!def) return reply.code(404).send({ error: '未知功能开关', code: 'FLAG_NOT_FOUND' });
    if (def.kind === 'number') {
      // D-10：数值配置（复盘保底 perDay），改动即时生效（普通 flag payload 60s 缓存内收敛）。
      const value = Number(req.body?.value);
      const min = def.min ?? 0;
      const max = def.max ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isFinite(value) || value < min || value > max) {
        return reply.code(400).send({ error: `数值需在 ${min}-${max} 之间`, code: 'BAD_VALUE' });
      }
      const v = Math.floor(value);
      await setFeatureFlagPayload(def.id, { [def.payloadKey!]: v });
      await recordAudit({ action: 'admin.flag.update', payload: { id: def.id, value: v } });
      const row = await prisma.featureFlag.findUnique({ where: { id: def.id } });
      return shapeFlag(def, row);
    }
    if (typeof req.body?.enabled !== 'boolean') return reply.code(400).send({ error: 'enabled 必须是布尔' });
    await setFeatureFlag(def.id, req.body.enabled); // 立即清缓存（合规开关本就直读 DB）
    await recordAudit({ action: 'admin.flag.update', payload: { id: def.id, enabled: req.body.enabled } });
    return shapeFlag(def, { enabled: req.body.enabled, payload: null });
  });

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

  // V7-12：单次付费商品（SKU）目录——运营可改价/启停（key、kind、grantsModuleKey 走代码目录 admin:sync-content，不在此改）。
  app.get('/admin/skus', async () => prisma.sku.findMany({ orderBy: { sort: 'asc' } }));
  app.patch<{ Params: { key: string }; Body: { name?: string; desc?: string; priceFen?: number; enabled?: boolean; sort?: number } }>(
    '/admin/skus/:key',
    async (req, reply) => {
      const existing = await prisma.sku.findUnique({ where: { key: req.params.key } });
      if (!existing) return reply.code(404).send({ error: 'SKU 不存在', code: 'SKU_NOT_FOUND' });
      const b = req.body ?? {};
      const data: Record<string, unknown> = {};
      if (typeof b.name === 'string') data.name = b.name.trim().slice(0, 60);
      if (typeof b.desc === 'string') data.desc = b.desc.trim().slice(0, 500);
      if (typeof b.priceFen === 'number' && b.priceFen >= 0) data.priceFen = Math.round(b.priceFen);
      if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
      if (typeof b.sort === 'number') data.sort = Math.round(b.sort);
      const sku = await prisma.sku.update({ where: { key: req.params.key }, data });
      await recordAudit({ action: 'admin.sku.update', payload: { key: sku.key, priceFen: sku.priceFen, enabled: sku.enabled } });
      return sku;
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

function auditPayload(payload: Prisma.JsonValue | null): Record<string, unknown> {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
}

function nested(obj: Record<string, unknown>, ...keys: string[]): unknown {
  let cur: unknown = obj;
  for (const key of keys) {
    if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur ?? null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function shortText(value: unknown, max = 80): string | null {
  const text = stringOrNull(value);
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function auditSummary(action: string, payload: Record<string, unknown>): string | null {
  const method = stringOrNull(payload.method);
  const path = stringOrNull(payload.path);
  const statusCode = numberOrNull(payload.statusCode);
  const ok = typeof payload.ok === 'boolean' ? payload.ok : null;
  const code = shortText(payload.code) ?? shortText(payload.errorCode);
  const error = shortText(payload.error);
  const phone = stringOrNull(payload.phoneMasked);
  const duration = numberOrNull(payload.durationMs);
  const result = ok === true ? '成功' : ok === false ? '失败' : statusCode && statusCode >= 400 ? '失败' : null;
  const target = method && path ? `${method} ${path}` : auditLabel(action);
  const parts = [
    result,
    target,
    statusCode ? `HTTP ${statusCode}` : null,
    duration !== null ? `${duration}ms` : null,
    phone ? `手机号 ${phone}` : null,
    code,
    error,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
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
    'auth.http': '登录 API 行为',
    'admin.http': '后台 API 行为',
    'auth.register': '手机号注册',
    'auth.login': '手机号登录',
    'auth.sms.send_attempt': '短信验证码尝试',
    'auth.login.attempt': '手机号登录尝试',
    'auth.wechat_register': '微信注册',
    'auth.wechat_login': '微信登录',
    'auth.wechat_login.attempt': '微信登录尝试',
    'auth.wechat_phone.attempt': '本机号登录尝试',
    'auth.carrier_onetap.attempt': '运营商一键登录尝试',
    'auth.onetap_register': '一键登录注册',
    'auth.onetap_login': '一键登录',
    'admin.agent.publish': '功能上架',
    'admin.agent.unpublish': '功能下架',
    'admin.agent.update': '智能体配置变更',
    'admin.agent.create': '新增智能体',
    'admin.user.agent.grant': '后台开通智能体',
    'admin.user.agent.revoke': '取消智能体开通',
    'user.agent.purchase': '用户解锁智能体',
    'admin.ai.update': '模型配置变更',
    'admin.account.init': '初始化后台账户',
    'admin.account.init_attempt': '后台初始化尝试',
    'admin.account.login': '后台账户登录',
    'admin.account.login_attempt': '后台登录尝试',
    'admin.account.password': '修改后台密码',
    'admin.account.password_attempt': '后台改密尝试',
    'user.plan.purchase': '用户购买套餐',
    'user.http': '用户 API 行为',
    'user.generate': '用户发起产出',
    'user.library.create': '用户存入方案库',
    'user.library.delete': '用户删除方案',
    'user.session.summarize': '用户生成纪要',
  };
  return labels[action] ?? action;
}
