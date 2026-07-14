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
import { prescriptionFunnel } from '../services/prescription.js';
import { activationSourceCounts } from '../services/activation.js';
import { setFeatureFlag, setFeatureFlagPayload, isComplianceFlag } from '../services/featureFlag.js';
import { REVIEW_GRACE_PER_DAY, getQuotaState, getPlanStatus, setQuota } from '../services/tokenQuota.js';
import { getBalance, grantCredits, chargeCredits } from '../services/credits.js';
import { now, dayStart } from '../services/clock.js';
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
  AdminEcoTool, AdminEcoToolCreate, AdminEcoToolUpdate, AdminPrescriptionFunnel,
  AdminBenchmark, AdminBenchmarkUpsert,
  AdminUserUsage, AdminTokenAgg, AdminPaymentsView, AdminPaymentItem, AdminPaymentStuckItem, AdminPayReconcileResult,
} from '../../../shared/contracts';
import { reconcileOrder, refundWechatOrder } from '../services/wechatPay.js';
import { applyPlanPurchase } from '../services/purchase.js';
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
    const at = now();
    const today = dayStart(at); // Asia/Shanghai 当日 00:00 对应的 UTC 瞬时
    const d7 = new Date(at.getTime() - 7 * 864e5);
    const d14 = new Date(at.getTime() - 14 * 864e5);
    const d30 = new Date(at.getTime() - 30 * 864e5);
    // 环比：近 7 天 vs 前 7 天真实计数；前期为 0 或无数据 → null（前端显示「—」，绝不硬编码箭头）。
    const pct = (a: number, b: number): number | null => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
    const sumSpent = (r: { _sum: { delta: number | null } }) => Math.abs(r._sum.delta ?? 0); // delta<0 的绝对值和
    const [
      tenants, users, deliverables, sessions, agents, activeToday, recentAudits,
      usersL7, usersP7, delivL7, delivP7, spentTotal, spentL7, spentP7,
      activeL7, activeP7, cost30, costL7, costP7,
    ] = await Promise.all([
      prisma.tenant.count(),
      prisma.user.count(),
      prisma.deliverable.count(),
      prisma.session.count(),
      prisma.agent.count({ where: { enabled: true } }),
      prisma.session.findMany({ where: { updatedAt: { gte: today } }, select: { userId: true }, distinct: ['userId'] }),
      prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 4 }),
      prisma.user.count({ where: { createdAt: { gte: d7 } } }),
      prisma.user.count({ where: { createdAt: { gte: d14, lt: d7 } } }),
      prisma.deliverable.count({ where: { createdAt: { gte: d7 } } }),
      prisma.deliverable.count({ where: { createdAt: { gte: d14, lt: d7 } } }),
      prisma.creditLedger.aggregate({ where: { delta: { lt: 0 } }, _sum: { delta: true } }),
      prisma.creditLedger.aggregate({ where: { delta: { lt: 0 }, createdAt: { gte: d7 } }, _sum: { delta: true } }),
      prisma.creditLedger.aggregate({ where: { delta: { lt: 0 }, createdAt: { gte: d14, lt: d7 } }, _sum: { delta: true } }),
      prisma.session.findMany({ where: { updatedAt: { gte: d7 } }, select: { userId: true }, distinct: ['userId'] }),
      prisma.session.findMany({ where: { updatedAt: { gte: d14, lt: d7 } }, select: { userId: true }, distinct: ['userId'] }),
      prisma.tokenUsage.aggregate({ where: { createdAt: { gte: d30 } }, _sum: { costMicros: true } }),
      prisma.tokenUsage.aggregate({ where: { createdAt: { gte: d7 } }, _sum: { costMicros: true } }),
      prisma.tokenUsage.aggregate({ where: { createdAt: { gte: d14, lt: d7 } }, _sum: { costMicros: true } }),
    ]);
    const spent = sumSpent(spentTotal);
    const cost30Micros = cost30._sum.costMicros ?? 0;
    return {
      stats: [
        { t: '注册用户', v: String(users), deltaPct: pct(usersL7, usersP7), sub: `${tenants} 个租户` },
        { t: '今日活跃用户', v: String(activeToday.length), deltaPct: pct(activeL7.length, activeP7.length), sub: `${sessions} 个会话` },
        { t: '累计产出成果', v: String(deliverables), deltaPct: pct(delivL7, delivP7), sub: `${agents} 个功能上架` },
        { t: '钻石消耗', v: String(spent), deltaPct: pct(sumSpent(spentL7), sumSpent(spentP7)), sub: '按流水统计' },
        { t: '30 天 Token 成本', v: (cost30Micros / 1e6).toFixed(2), deltaPct: pct(costL7._sum.costMicros ?? 0, costP7._sum.costMicros ?? 0), sub: '近 30 天 · 元' },
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

  // —— S1：单用户用量下钻（额度 / 套餐 / token 聚合 / 钻石 / 支付 / 开通归因）纯读 ——
  app.get<{ Params: { id: string }; Querystring: { days?: string } }>('/admin/users/:id/usage', async (req, reply): Promise<AdminUserUsage | void> => {
    const userId = req.params.id;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { plan: { select: { name: true } } } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const days = Math.min(365, Math.max(1, Math.floor(Number(req.query.days ?? 30)) || 30));
    const since = new Date(now().getTime() - days * 864e5);

    // 额度：先判钱包是否存在（null=无钱包），存在才复用 getQuotaState（会做惰性月度重置）。
    const wallet0 = await prisma.tokenWallet.findUnique({ where: { userId }, select: { periodKey: true } });
    let quota: AdminUserUsage['quota'] = null;
    if (wallet0) {
      const st = await getQuotaState(userId);
      const w1 = await prisma.tokenWallet.findUnique({ where: { userId }, select: { periodKey: true } });
      quota = { limit: st.quota, used: st.used, remaining: st.balance, unlimited: st.unlimited, periodKey: w1?.periodKey ?? wallet0.periodKey };
    }

    const ps = await getPlanStatus(userId);
    const plan: AdminUserUsage['plan'] = {
      planName: user.plan?.name ?? null,
      expiresAt: ps.expiresAt,
      daysLeft: ps.daysRemaining,
      status: !user.plan ? 'none' : ps.expired ? 'expired' : 'active',
    };

    const tokenWhere = { userId, createdAt: { gte: since } };
    const [totalAgg, modelGroups, agentGroups, dayRows, credits, payments, activations] = await Promise.all([
      prisma.tokenUsage.aggregate({ where: tokenWhere, _sum: { inputTokens: true, outputTokens: true, totalTokens: true, costMicros: true }, _count: { _all: true } }),
      prisma.tokenUsage.groupBy({ by: ['model'], where: tokenWhere, _sum: { totalTokens: true, costMicros: true }, _count: { _all: true }, orderBy: { _sum: { totalTokens: 'desc' } }, take: 20 }),
      prisma.tokenUsage.groupBy({ by: ['agentKey'], where: tokenWhere, _sum: { totalTokens: true, costMicros: true }, _count: { _all: true }, orderBy: { _sum: { totalTokens: 'desc' } }, take: 20 }),
      // byDay：Asia/Shanghai 日历日键（列为 UTC naive → 先按 UTC 解释再转上海，与 clock.dateKey 一致）。
      prisma.$queryRaw<{ day: string; total: bigint | number }[]>`
        SELECT to_char((("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day,
               COALESCE(SUM("totalTokens"), 0) AS total
        FROM token_usage
        WHERE "userId" = ${userId} AND "createdAt" >= ${since}
        GROUP BY 1 ORDER BY 1`,
      prisma.creditLedger.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 }),
      prisma.paymentOrder.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10, select: { outTradeNo: true, amount: true, status: true, paidAt: true, attrSource: true } }),
      prisma.activationEvent.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 10, select: { itemType: true, itemKey: true, source: true, createdAt: true } }),
    ]);
    const toAgg = (key: string, g: { _sum: { totalTokens: number | null; costMicros: number | null }; _count: { _all: number } }): AdminTokenAgg =>
      ({ key, totalTokens: g._sum.totalTokens ?? 0, costMicros: g._sum.costMicros ?? 0, calls: g._count._all });
    return {
      quota,
      plan,
      tokens: {
        totalTokens: totalAgg._sum.totalTokens ?? 0,
        inputTokens: totalAgg._sum.inputTokens ?? 0,
        outputTokens: totalAgg._sum.outputTokens ?? 0,
        costMicros: totalAgg._sum.costMicros ?? 0,
        calls: totalAgg._count._all,
        byModel: modelGroups.map((g) => toAgg(g.model, g)),
        byAgent: agentGroups.map((g) => toAgg(g.agentKey ?? '未标注', g)),
        byDay: dayRows.map((r) => ({ day: r.day, totalTokens: Number(r.total) })),
      },
      credits: credits.map((c) => ({ delta: c.delta, reason: c.reason, balance: c.balance, at: isoSecond(c.createdAt) })),
      payments: payments.map((p) => ({ orderNo: tail6(p.outTradeNo), amount: p.amount, status: p.status, paidAt: p.paidAt ? isoSecond(p.paidAt) : null, attrSource: p.attrSource })),
      activations: activations.map((a) => ({ itemType: a.itemType, itemKey: a.itemKey, source: a.source, at: isoSecond(a.createdAt) })),
    };
  });

  // —— S2：三个资金/额度运营写端点（owner-only + 审计 before/after）——
  // 调整/重置月度 token 额度。mode=reset_to_plan 取用户当前套餐额度；mode=set 直接设定（-1=不限量）。
  app.post<{ Params: { id: string }; Body: { mode?: string; quota?: number } }>('/admin/users/:id/token-quota', async (req, reply) => {
    const actor = actorOf(req);
    try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
    const userId = req.params.id;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true, planActivatedAt: true, plan: { select: { tokenQuotaPerMonth: true } } } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const mode = req.body?.mode;
    let target: number;
    if (mode === 'reset_to_plan') {
      if (!user.plan) return reply.code(400).send({ error: '用户当前无套餐，无法按套餐重置额度', code: 'NO_PLAN' });
      target = user.plan.tokenQuotaPerMonth;
    } else if (mode === 'set') {
      const q = req.body?.quota;
      if (typeof q !== 'number' || !Number.isInteger(q) || (q < 0 && q !== -1)) {
        return reply.code(400).send({ error: 'quota 需为 -1（不限量）或 ≥0 的整数', code: 'BAD_QUOTA' });
      }
      target = q;
    } else {
      return reply.code(400).send({ error: 'mode 需为 reset_to_plan 或 set', code: 'BAD_MODE' });
    }
    const before = await getQuotaState(userId);
    await setQuota(user.tenantId, userId, target, user.planActivatedAt);
    const after = await getQuotaState(userId);
    const snap = (s: typeof before) => ({ quota: s.quota, balance: s.balance, used: s.used, unlimited: s.unlimited });
    await recordAudit({ tenantId: user.tenantId, userId, action: 'admin.user.quota.set', payload: { by: actorName(actor), mode, quota: target, before: snap(before), after: snap(after) } });
    return { ok: true, quota: after };
  });

  // 补发/扣减钻石（CreditLedger）。走 credits 服务的入账函数，reason 存成 admin:{reason}；负 delta 越界 400。
  app.post<{ Params: { id: string }; Body: { delta?: number; reason?: string } }>('/admin/users/:id/credits', async (req, reply) => {
    const actor = actorOf(req);
    try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
    const userId = req.params.id;
    const delta = req.body?.delta;
    const reason = (req.body?.reason ?? '').trim();
    if (typeof delta !== 'number' || !Number.isInteger(delta) || delta === 0) {
      return reply.code(400).send({ error: 'delta 需为非 0 整数', code: 'BAD_DELTA' });
    }
    if (!reason || reason.length > 50) {
      return reply.code(400).send({ error: 'reason 必填且不超过 50 字', code: 'BAD_REASON' });
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const before = await getBalance(userId);
    // 越界拒绝（不 clamp）：有限余额下扣减不得使余额 < 0。
    if (delta < 0 && before >= 0 && before + delta < 0) {
      return reply.code(400).send({ error: '扣减后余额将为负，已拒绝', code: 'BALANCE_UNDERFLOW' });
    }
    const stored = `admin:${reason}`;
    if (delta > 0) await grantCredits(user.tenantId, userId, delta, stored);
    else await chargeCredits(user.tenantId, userId, -delta, stored);
    const after = await getBalance(userId);
    await recordAudit({ tenantId: user.tenantId, userId, action: 'admin.user.credits.adjust', payload: { by: actorName(actor), delta, reason: stored, before, after } });
    return { ok: true, balance: after };
  });

  // 延长套餐有效期（仅推 planExpiresAt = max(now, 现值) + days，不触碰权益快照/锚点/钱包）。
  app.post<{ Params: { id: string }; Body: { days?: number } }>('/admin/users/:id/plan-extend', async (req, reply) => {
    const actor = actorOf(req);
    try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
    const userId = req.params.id;
    const days = req.body?.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > 366) {
      return reply.code(400).send({ error: 'days 需为 1~366 的整数', code: 'BAD_DAYS' });
    }
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { tenantId: true, planId: true, planExpiresAt: true } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    if (!user.planId) return reply.code(400).send({ error: '用户当前无套餐，无法延长有效期', code: 'NO_PLAN' });
    const at = now();
    const baseMs = Math.max(at.getTime(), user.planExpiresAt ? user.planExpiresAt.getTime() : at.getTime());
    const next = new Date(baseMs + days * 864e5);
    await prisma.user.update({ where: { id: userId }, data: { planExpiresAt: next } });
    await recordAudit({ tenantId: user.tenantId, userId, action: 'admin.user.plan.extend', payload: { by: actorName(actor), days, before: user.planExpiresAt ? isoSecond(user.planExpiresAt) : null, after: isoSecond(next) } });
    return { ok: true, planExpiresAt: next.toISOString() };
  });

  // 订单筛选条件（列表/导出共用）：时间窗 + 状态 + q 搜索（单号包含 / 用户名 / 手机号）。
  async function paymentListWhere(args: { since: Date; status: string; q: string }): Promise<Prisma.PaymentOrderWhereInput> {
    const base: Prisma.PaymentOrderWhereInput = { createdAt: { gte: args.since }, ...(args.status ? { status: args.status } : {}) };
    if (!args.q) return base;
    const users = await prisma.user.findMany({
      where: { OR: [{ name: { contains: args.q } }, { phone: { contains: args.q } }] },
      select: { id: true },
      take: 200,
    });
    return { ...base, OR: [{ outTradeNo: { contains: args.q } }, { userId: { in: users.map((u) => u.id) } }] };
  }

  // —— S4：支付订单列表 + 汇总（读）+ 搜索/分页（P2）——
  app.get<{ Querystring: { status?: string; days?: string; q?: string; page?: string; pageSize?: string } }>('/admin/payments', async (req): Promise<AdminPaymentsView> => {
    const days = Math.min(365, Math.max(1, Math.floor(Number(req.query.days ?? 30)) || 30));
    const since = new Date(now().getTime() - days * 864e5);
    const status = (req.query.status ?? '').trim();
    const q = (req.query.q ?? '').trim().slice(0, 64);
    const page = Math.max(1, Math.floor(Number(req.query.page ?? 1)) || 1);
    const pageSize = Math.min(100, Math.max(1, Math.floor(Number(req.query.pageSize ?? 20)) || 20));
    const PAID = ['paid', 'applied']; // 已支付口径：paid 及其后继终态 applied
    const listWhere = await paymentListWhere({ since, status, q });
    const [orders, total, paidAgg, dayRows] = await Promise.all([
      prisma.paymentOrder.findMany({ where: listWhere, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
      prisma.paymentOrder.count({ where: listWhere }),
      prisma.paymentOrder.aggregate({ where: { paidAt: { gte: since }, status: { in: PAID } }, _sum: { amount: true }, _count: { _all: true } }),
      prisma.$queryRaw<{ day: string; amount: bigint | number }[]>`
        SELECT to_char((("paidAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS day,
               COALESCE(SUM("amount"), 0) AS amount
        FROM payment_order
        WHERE "paidAt" >= ${since} AND "status" IN ('paid', 'applied')
        GROUP BY 1 ORDER BY 1`,
    ]);
    // 卡单清单（P0）：paid 未 applied = 收钱未发权益（资损，最高优先）；created 超 30 分钟 = 回调可能丢失/用户未支付。
    // 近 30 天窗口、各取 50 条；带完整单号供微信商户平台查单与手动补账。
    const stuckSince = new Date(now().getTime() - 30 * 864e5);
    const stuckRows = await prisma.paymentOrder.findMany({
      where: {
        createdAt: { gte: stuckSince },
        appliedAt: null,
        OR: [
          { status: 'paid' },
          { status: 'created', createdAt: { lt: new Date(now().getTime() - 30 * 60_000) } },
        ],
      },
      orderBy: [{ status: 'desc' }, { createdAt: 'desc' }], // paid 排前（资损优先）
      take: 100,
    });
    const userIds = [...new Set([...orders, ...stuckRows].map((o) => o.userId))];
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [];
    const nameMap = new Map(users.map((u) => [u.id, u.name]));
    const items: AdminPaymentItem[] = orders.map((o) => ({
      orderNo: tail6(o.outTradeNo),
      outTradeNo: o.outTradeNo,
      userName: nameMap.get(o.userId) ?? '—',
      amount: o.amount,
      status: o.status,
      attrSource: o.attrSource,
      paidAt: o.paidAt ? isoSecond(o.paidAt) : null,
      createdAt: isoSecond(o.createdAt),
    }));
    const stuck: AdminPaymentStuckItem[] = stuckRows.map((o) => ({
      outTradeNo: o.outTradeNo,
      userName: nameMap.get(o.userId) ?? '—',
      amount: o.amount,
      status: o.status,
      kind: o.status === 'paid' ? 'paid_unapplied' : 'created_stale',
      provider: o.provider,
      planId: o.planId,
      skuKey: o.skuKey,
      paidAt: o.paidAt ? isoSecond(o.paidAt) : null,
      createdAt: isoSecond(o.createdAt),
    }));
    return {
      summary: {
        paidAmount: paidAgg._sum.amount ?? 0,
        paidCount: paidAgg._count._all,
        byDay: dayRows.map((r) => ({ day: r.day, amount: Number(r.amount) })),
      },
      items,
      stuck,
      total,
      page,
      pageSize,
    };
  });

  // 订单导出 CSV（P2，仅 owner/master——含手机号）：与列表同一套筛选（days/status/q），上限 5000 行，审计留痕。
  app.get<{ Querystring: { status?: string; days?: string; q?: string } }>('/admin/payments/export', async (req, reply) => {
    const actor = actorOf(req);
    try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
    const days = Math.min(365, Math.max(1, Math.floor(Number(req.query.days ?? 30)) || 30));
    const since = new Date(now().getTime() - days * 864e5);
    const status = (req.query.status ?? '').trim();
    const q = (req.query.q ?? '').trim().slice(0, 64);
    const listWhere = await paymentListWhere({ since, status, q });
    const orders = await prisma.paymentOrder.findMany({ where: listWhere, orderBy: { createdAt: 'desc' }, take: 5000 });
    const userIds = [...new Set(orders.map((o) => o.userId))];
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, phone: true } }) : [];
    const userMap = new Map(users.map((u) => [u.id, u]));
    // 例行 QA 安全修复：CSV/公式注入防护。用户昵称（u?.name）是最长 20 字的自由文本
    // （见 routes/meta.ts PUT /me），若以 = + - @ 开头，Excel/Numbers/Sheets 打开本 CSV
    // 时会把该字段当公式执行（如恶意昵称 `=HYPERLINK("http://evil","x")`），造成运营
    // 打开导出文件时被动执行任意公式（数据外泄等）。加一个前导单引号中和，Excel 按纯
    // 文本渲染，不影响正常内容可读性。
    const esc = (v: unknown) => {
      let s = String(v ?? '');
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const itemName = (o: { snapshotJson: unknown; skuKey: string | null; planId: string }) => {
      const snap = (o.snapshotJson ?? null) as { plan?: { name?: string }; sku?: { name?: string } } | null;
      return snap?.plan?.name ?? snap?.sku?.name ?? (o.skuKey ?? o.planId);
    };
    const header = ['商户单号', '用户', '手机号', '商品', '金额(元)', '状态', '归因', '下单时间', '支付时间', '退款时间'];
    const lines = orders.map((o) => {
      const u = userMap.get(o.userId);
      return [
        o.outTradeNo, u?.name ?? '', u?.phone ?? '', itemName(o), (o.amount / 100).toFixed(2), o.status,
        o.attrSource ?? '', isoSecond(o.createdAt), o.paidAt ? isoSecond(o.paidAt) : '', o.refundedAt ? isoSecond(o.refundedAt) : '',
      ].map(esc).join(',');
    });
    await recordAudit({ action: 'admin.pay.export', payload: { by: actorName(actor), days, status: status || null, q: q || null, rows: orders.length } });
    // BOM 前缀让 Excel 正确识别 UTF-8 中文。
    const csv = '﻿' + [header.map(esc).join(','), ...lines].join('\r\n');
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="payments-${days}d.csv"`)
      .send(csv);
  });

  // 手动查单补账（P0）：对单笔订单主动向微信查单并幂等入账（与回调/轮询共用 markPaidAndApply 底座，
  // 不会重复发放）。供运营处置卡单：微信说已付 → 补发权益；终态失败 → 标 failed；未支付 → 保持不动。
  app.post<{ Params: { outTradeNo: string } }>('/admin/payments/:outTradeNo/reconcile', async (req, reply): Promise<AdminPayReconcileResult | void> => {
    const actor = actorOf(req);
    const outTradeNo = req.params.outTradeNo.trim();
    const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    if (!order) return reply.code(404).send({ error: '订单不存在', code: 'ORDER_NOT_FOUND' });
    let r: { applied: boolean; reason?: string; tradeState?: string };
    try {
      r = await reconcileOrder(outTradeNo);
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode === 404 ? 409 : 502).send({
        error: err.code === 'WECHAT_PAY_ORDER_NOT_EXIST' ? '微信侧不存在该交易（用户未调起支付或单已转历史）' : (err.message ?? '查单失败'),
        code: err.code ?? 'WECHAT_PAY_QUERY_FAILED',
      });
    }
    const after = await prisma.paymentOrder.findUnique({ where: { outTradeNo }, select: { status: true } });
    await recordAudit({
      tenantId: order.tenantId, userId: order.userId, action: 'admin.pay.reconcile',
      payload: { by: actorName(actor), outTradeNo, applied: r.applied, reason: r.reason ?? null, tradeState: r.tradeState ?? null, statusBefore: order.status, statusAfter: after?.status ?? order.status },
    });
    return { ok: true, applied: r.applied, reason: r.reason, tradeState: r.tradeState, status: after?.status ?? order.status };
  });

  // 退款（P1，仅 owner/master）：全额原路退回 + 幂等权益回收（模块停用/凭据收回/套餐立即到期+追回未消耗算力）。
  // 服务层已写 user.pay.refund 审计；此处再落 admin.pay.refund 记操作人。UI 后续补，先提供端点。
  app.post<{ Params: { outTradeNo: string }; Body: { reason?: string } }>('/admin/payments/:outTradeNo/refund', async (req, reply) => {
    const actor = actorOf(req);
    try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
    const outTradeNo = req.params.outTradeNo.trim();
    const reason = (req.body?.reason ?? '').trim();
    const order = await prisma.paymentOrder.findUnique({ where: { outTradeNo } });
    if (!order) return reply.code(404).send({ error: '订单不存在', code: 'ORDER_NOT_FOUND' });
    try {
      const r = await refundWechatOrder(outTradeNo, { reason, by: actorName(actor) });
      await recordAudit({
        tenantId: order.tenantId, userId: order.userId, action: 'admin.pay.refund',
        payload: { by: actorName(actor), outTradeNo, amount: order.amount, reason: reason || null, refundId: r.refundId, wechatStatus: r.wechatStatus },
      });
      return { ok: true, refundId: r.refundId, wechatStatus: r.wechatStatus };
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 502).send({ error: err.message ?? '退款失败', code: err.code ?? 'WECHAT_PAY_REFUND_FAILED' });
    }
  });

  // 手动开通套餐（P2，仅 owner/master）：给任意用户直接发放套餐权益（含无套餐用户，补齐 plan-extend 的 NO_PLAN 缺口）。
  // 复用 applyPlanPurchase（与支付/演示同一发放口径），source='admin_grant'。
  app.post<{ Params: { id: string }; Body: { planId?: string } }>('/admin/users/:id/plan', async (req, reply) => {
    const actor = actorOf(req);
    try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, tenantId: true, planId: true, planExpiresAt: true } });
    if (!user) return reply.code(404).send({ error: '用户不存在', code: 'USER_NOT_FOUND' });
    const planId = (req.body?.planId ?? '').trim();
    if (!planId) return reply.code(400).send({ error: '缺少 planId', code: 'PLAN_ID_REQUIRED' });
    const plan = await prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });
    const r = await applyPlanPurchase({ id: user.id, tenantId: user.tenantId }, plan, { reason: `${plan.name} · 运营开通`, source: 'admin_grant' });
    await recordAudit({
      tenantId: user.tenantId, userId: user.id, action: 'admin.user.plan.grant',
      payload: { by: actorName(actor), planId: plan.id, planName: plan.name, beforePlanId: user.planId, beforeExpiresAt: user.planExpiresAt ? isoSecond(user.planExpiresAt) : null, expiresAt: r.expiresAt ? isoSecond(r.expiresAt) : null, grantedCredits: r.grantedCredits },
    });
    return { ok: true, planId: plan.id, planName: plan.name, expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null, grantedCredits: r.grantedCredits };
  });

  // 手动发放/收回模块（P2，仅 owner/master）：UserModule source='admin'（与购买发放 source='purchase' 区分）。
  app.post<{ Params: { id: string }; Body: { moduleKey?: string } }>('/admin/users/:id/modules', async (req, reply) => {
    const actor = actorOf(req);
    try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, tenantId: true } });
    if (!user) return reply.code(404).send({ error: '用户不存在', code: 'USER_NOT_FOUND' });
    const moduleKey = (req.body?.moduleKey ?? '').trim();
    if (!moduleKey) return reply.code(400).send({ error: '缺少 moduleKey', code: 'MODULE_KEY_REQUIRED' });
    await prisma.userModule.upsert({
      where: { userId_moduleKey: { userId: user.id, moduleKey } },
      update: { enabled: true, hidden: false, source: 'admin' },
      create: { tenantId: user.tenantId, userId: user.id, moduleKey, enabled: true, source: 'admin' },
    });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'admin.user.module.grant', payload: { by: actorName(actor), moduleKey } });
    return { ok: true, moduleKey, enabled: true };
  });
  app.delete<{ Params: { id: string; key: string } }>('/admin/users/:id/modules/:key', async (req, reply) => {
    const actor = actorOf(req);
    try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
    const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, tenantId: true } });
    if (!user) return reply.code(404).send({ error: '用户不存在', code: 'USER_NOT_FOUND' });
    const r = await prisma.userModule.updateMany({ where: { userId: user.id, moduleKey: req.params.key }, data: { enabled: false } });
    await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'admin.user.module.revoke', payload: { by: actorName(actor), moduleKey: req.params.key, found: r.count > 0 } });
    return { ok: true, moduleKey: req.params.key, enabled: false };
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
  app.get<{ Params: { key: string }; Querystring: { limit?: string; tenantId?: string } }>('/admin/agents/:key/memories', async (req): Promise<AdminAgentMemoryView> => {
    // tenantId 可选：传入则限定单租户作用域（治理时聚焦某企业），不传 = 平台级全量。
    const tenantId = req.query.tenantId?.trim() || undefined;
    return { items: await listAgentMemories(req.params.key, Number(req.query.limit) || 200, tenantId) };
  });
  app.delete<{ Params: { key: string; mid: string }; Querystring: { tenantId?: string } }>('/admin/agents/:key/memories/:mid', async (req, reply) => {
    const tenantId = req.query.tenantId?.trim() || undefined;
    const ok = await deleteAgentMemory(req.params.key, req.params.mid, tenantId);
    if (!ok) return reply.code(404).send({ error: 'not found' });
    await recordAudit({ tenantId, action: 'admin.agent.memory.delete', payload: { agentKey: req.params.key, memoryId: req.params.mid, tenantScoped: !!tenantId } });
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
  // 改价直接影响营收：仅 owner/master（requireSuper，与资金三写同级）；字段白名单 + 数值校验
  //（此前 data: req.body 直透 prisma 属 mass-assignment 隐患）；审计带操作人与改前/改后快照。
  app.patch<{ Params: { id: string }; Body: { name?: string; price?: number; creditsPerMonth?: number; tokenQuotaPerMonth?: number; agentCount?: number; featuresJson?: string[]; highlighted?: boolean } }>(
    '/admin/plans/:id',
    async (req, reply) => {
      const actor = actorOf(req);
      try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
      const before = await prisma.plan.findUnique({ where: { id: req.params.id } });
      if (!before) return reply.code(404).send({ error: '套餐不存在', code: 'PLAN_NOT_FOUND' });
      const b = req.body ?? {};
      const data: Prisma.PlanUpdateInput = {};
      if (typeof b.name === 'string' && b.name.trim()) data.name = b.name.trim().slice(0, 60);
      // price：分；-1=面议（admin 前端约定），其余须 ≥0
      if (typeof b.price === 'number' && Number.isFinite(b.price) && (b.price >= 0 || Math.round(b.price) === -1)) data.price = Math.round(b.price);
      // creditsPerMonth：负数=企业版不限量语义，放行任意整数
      if (typeof b.creditsPerMonth === 'number' && Number.isFinite(b.creditsPerMonth)) data.creditsPerMonth = Math.round(b.creditsPerMonth);
      if (typeof b.tokenQuotaPerMonth === 'number' && Number.isFinite(b.tokenQuotaPerMonth) && b.tokenQuotaPerMonth >= 0) data.tokenQuotaPerMonth = Math.round(b.tokenQuotaPerMonth);
      if (typeof b.agentCount === 'number' && Number.isFinite(b.agentCount) && b.agentCount >= 0) data.agentCount = Math.round(b.agentCount);
      if (Array.isArray(b.featuresJson)) data.featuresJson = b.featuresJson.map(String).slice(0, 20);
      if (typeof b.highlighted === 'boolean') data.highlighted = b.highlighted;
      const plan = await prisma.plan.update({ where: { id: req.params.id }, data });
      await recordAudit({
        action: 'admin.plan.update',
        payload: {
          by: actorName(actor), id: plan.id, name: plan.name,
          before: { price: before.price, creditsPerMonth: before.creditsPerMonth, tokenQuotaPerMonth: before.tokenQuotaPerMonth, agentCount: before.agentCount },
          after: { price: plan.price, creditsPerMonth: plan.creditsPerMonth, tokenQuotaPerMonth: plan.tokenQuotaPerMonth, agentCount: plan.agentCount },
        },
      });
      return plan;
    },
  );

  // V7-12：单次付费商品（SKU）目录——运营可改价/启停（key、kind、grantsModuleKey 走代码目录 admin:sync-content，不在此改）。
  app.get('/admin/skus', async () => prisma.sku.findMany({ orderBy: { sort: 'asc' } }));
  app.patch<{ Params: { key: string }; Body: { name?: string; desc?: string; priceFen?: number; enabled?: boolean; sort?: number } }>(
    '/admin/skus/:key',
    async (req, reply) => {
      // 改价/启停直接影响营收：仅 owner/master（与套餐改价、资金三写同级），审计带操作人与前后快照。
      const actor = actorOf(req);
      try { requireSuper(actor); } catch (e) { return sendErr(reply, e, 403); }
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
      await recordAudit({
        action: 'admin.sku.update',
        payload: {
          by: actorName(actor), key: sku.key,
          before: { priceFen: existing.priceFen, enabled: existing.enabled },
          after: { priceFen: sku.priceFen, enabled: sku.enabled },
        },
      });
      return sku;
    },
  );

  // ===== D-1 / WO-12：处方多来源漏斗报表（处方六态聚合 + 开通来源计数，一次两块） =====
  app.get<{ Querystring: { days?: string } }>('/admin/prescriptions/funnel', async (req): Promise<AdminPrescriptionFunnel> => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const [prescriptions, activations] = await Promise.all([
      prescriptionFunnel(days),
      activationSourceCounts(days),
    ]);
    return { days, prescriptions, activations };
  });

  // ===== D-3-7：生态工具注册表（CRUD；enabled 控制是否可开方，appId 空则拒绝启用） =====
  const ecoView = (e: { id: string; name: string; desc: string; appId: string; path: string; enabled: boolean; sort: number; updatedAt: Date }): AdminEcoTool =>
    ({ id: e.id, name: e.name, desc: e.desc, appId: e.appId, path: e.path, enabled: e.enabled, sort: e.sort, updatedAt: isoSecond(e.updatedAt) });

  app.get('/admin/eco-tools', async (): Promise<AdminEcoTool[]> => {
    const rows = await prisma.ecoTool.findMany({ orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }] });
    return rows.map(ecoView);
  });

  app.post<{ Body: AdminEcoToolCreate }>('/admin/eco-tools', async (req, reply): Promise<AdminEcoTool | void> => {
    const b = req.body ?? ({} as AdminEcoToolCreate);
    const id = String(b.id ?? '').trim();
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(id)) return reply.code(400).send({ error: 'toolKey 需小写字母开头（可含数字与连字符）', code: 'ECO_KEY_INVALID' });
    if (!String(b.name ?? '').trim()) return reply.code(400).send({ error: '请填写名称', code: 'ECO_NAME_REQUIRED' });
    const exists = await prisma.ecoTool.findUnique({ where: { id } });
    if (exists) return reply.code(409).send({ error: 'toolKey 已存在', code: 'ECO_KEY_EXISTS' });
    const appId = String(b.appId ?? '').trim();
    const enabled = b.enabled === true;
    // 启用前必须有 appId（否则前端 navigateToMiniProgram 无目标）。
    if (enabled && !appId) return reply.code(400).send({ error: '启用前需先填目标小程序 appId', code: 'ECO_APPID_REQUIRED' });
    const row = await prisma.ecoTool.create({
      data: {
        id, name: String(b.name).trim().slice(0, 40), desc: String(b.desc ?? '').trim().slice(0, 300),
        appId, path: String(b.path ?? '').trim().slice(0, 200), enabled, sort: Number(b.sort) || 0,
      },
    });
    await recordAudit({ action: 'admin.ecoTool.create', payload: { id: row.id, enabled: row.enabled } });
    return ecoView(row);
  });

  app.patch<{ Params: { id: string }; Body: AdminEcoToolUpdate }>('/admin/eco-tools/:id', async (req, reply): Promise<AdminEcoTool | void> => {
    const existing = await prisma.ecoTool.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: '生态工具不存在', code: 'ECO_NOT_FOUND' });
    const b = req.body ?? {};
    const data: Record<string, unknown> = {};
    if (typeof b.name === 'string') data.name = b.name.trim().slice(0, 40);
    if (typeof b.desc === 'string') data.desc = b.desc.trim().slice(0, 300);
    if (typeof b.appId === 'string') data.appId = b.appId.trim().slice(0, 64);
    if (typeof b.path === 'string') data.path = b.path.trim().slice(0, 200);
    if (typeof b.sort === 'number') data.sort = Math.round(b.sort);
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    // 启用（本次或维持）时必须有 appId：以「更新后的 appId」判定，防启用了却无跳转目标。
    const nextAppId = (data.appId as string | undefined) ?? existing.appId;
    const nextEnabled = (data.enabled as boolean | undefined) ?? existing.enabled;
    if (nextEnabled && !nextAppId) return reply.code(400).send({ error: '启用前需先填目标小程序 appId', code: 'ECO_APPID_REQUIRED' });
    const row = await prisma.ecoTool.update({ where: { id: req.params.id }, data });
    await recordAudit({ action: 'admin.ecoTool.update', payload: { id: row.id, enabled: row.enabled } });
    return ecoView(row);
  });

  app.delete<{ Params: { id: string } }>('/admin/eco-tools/:id', async (req, reply): Promise<{ ok: boolean } | void> => {
    const existing = await prisma.ecoTool.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: '生态工具不存在', code: 'ECO_NOT_FOUND' });
    await prisma.ecoTool.delete({ where: { id: req.params.id } });
    await recordAudit({ action: 'admin.ecoTool.delete', payload: { id: req.params.id } });
    return { ok: true };
  });

  // —— WO-08：行业基准库运营维护（列表带行业筛选 / upsert / 删除；CSV 由前端逐行拆成 upsert）——
  const bmView = (b: {
    id: string; industry: string; revenueBand: string; metricKey: string; metricName: string; unit: string;
    p25: number | null; p50: number | null; p75: number | null; note: string | null; source: string | null; enabled: boolean; updatedAt: Date;
  }): AdminBenchmark => ({
    id: b.id, industry: b.industry, revenueBand: b.revenueBand, metricKey: b.metricKey, metricName: b.metricName, unit: b.unit,
    p25: b.p25, p50: b.p50, p75: b.p75, note: b.note, source: b.source, enabled: b.enabled, updatedAt: isoSecond(b.updatedAt),
  });
  const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  app.get<{ Querystring: { industry?: string } }>('/admin/benchmarks', async (req): Promise<AdminBenchmark[]> => {
    const industry = req.query.industry?.trim();
    const rows = await prisma.industryBenchmark.findMany({
      where: industry ? { industry } : undefined,
      orderBy: [{ industry: 'asc' }, { revenueBand: 'asc' }, { metricKey: 'asc' }],
    });
    return rows.map(bmView);
  });

  app.post<{ Body: AdminBenchmarkUpsert }>('/admin/benchmarks', async (req, reply): Promise<AdminBenchmark | void> => {
    const b = req.body ?? ({} as AdminBenchmarkUpsert);
    const industry = String(b.industry ?? '').trim();
    const metricKey = String(b.metricKey ?? '').trim();
    const metricName = String(b.metricName ?? '').trim();
    const unit = String(b.unit ?? '').trim();
    const revenueBand = String(b.revenueBand ?? '*').trim() || '*';
    if (!industry) return reply.code(400).send({ error: '请填写行业', code: 'BM_INDUSTRY_REQUIRED' });
    if (!metricKey) return reply.code(400).send({ error: '请填写指标 key', code: 'BM_KEY_REQUIRED' });
    if (!metricName) return reply.code(400).send({ error: '请填写指标名', code: 'BM_NAME_REQUIRED' });
    if (!unit) return reply.code(400).send({ error: '请填写单位', code: 'BM_UNIT_REQUIRED' });
    const data = {
      metricName: metricName.slice(0, 40), unit: unit.slice(0, 16),
      p25: numOrNull(b.p25), p50: numOrNull(b.p50), p75: numOrNull(b.p75),
      note: b.note != null ? String(b.note).trim().slice(0, 200) || null : null,
      source: b.source != null ? String(b.source).trim().slice(0, 200) || null : null,
      enabled: b.enabled !== false, // 缺省启用
    };
    // (industry,revenueBand,metricKey) 唯一 → upsert：命中即更新，未命中即建（CSV 重复导入幂等）。
    const row = await prisma.industryBenchmark.upsert({
      where: { industry_revenueBand_metricKey: { industry, revenueBand, metricKey } },
      update: data,
      create: { industry, revenueBand, metricKey, ...data },
    });
    await recordAudit({ action: 'admin.benchmark.upsert', payload: { id: row.id, industry, metricKey, hasP50: row.p50 != null } });
    return bmView(row);
  });

  app.delete<{ Params: { id: string } }>('/admin/benchmarks/:id', async (req, reply): Promise<{ ok: boolean } | void> => {
    const existing = await prisma.industryBenchmark.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.code(404).send({ error: '基准行不存在', code: 'BM_NOT_FOUND' });
    await prisma.industryBenchmark.delete({ where: { id: req.params.id } });
    await recordAudit({ action: 'admin.benchmark.delete', payload: { id: req.params.id, industry: existing.industry, metricKey: existing.metricKey } });
    return { ok: true };
  });
}

async function buildAdminUsers(): Promise<AdminUserItem[]> {
  const since30 = new Date(now().getTime() - 30 * 864e5);
  const [users, sessions, deliverables, ledgers, tokenAgg, wallets] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 300,
      include: { tenant: true, plan: true },
    }),
    prisma.session.groupBy({ by: ['userId'], _count: { _all: true }, _max: { updatedAt: true } }),
    prisma.deliverable.groupBy({ by: ['userId'], _count: { _all: true } }),
    prisma.creditLedger.findMany({ orderBy: { createdAt: 'asc' } }),
    // 近 30 天 token 用量：一次 groupBy（[userId,createdAt] 索引），避免 per-user N+1。
    prisma.tokenUsage.groupBy({ by: ['userId'], where: { userId: { not: null }, createdAt: { gte: since30 } }, _sum: { totalTokens: true } }),
    // 月度额度剩余：一次 findMany 取齐所有钱包（不触发 per-user 惰性重置，列表展示用原值）。
    prisma.tokenWallet.findMany({ select: { userId: true, quota: true, balance: true } }),
  ]);
  const sessionMap = new Map(sessions.map((s) => [s.userId, { count: s._count._all, lastAt: s._max.updatedAt }]));
  const deliverableMap = new Map(deliverables.map((d) => [d.userId, d._count._all]));
  const tokenMap = new Map(tokenAgg.map((t) => [t.userId as string, t._sum.totalTokens ?? 0]));
  const walletMap = new Map(wallets.map((w) => [w.userId, w.quota < 0 ? -1 : w.balance])); // -1=不限量
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
      tokenUsed30d: tokenMap.get(u.id) ?? 0,
      quotaRemaining: walletMap.has(u.id) ? (walletMap.get(u.id) as number) : null,
    };
  });
}

function displayPhone(phone: string): string {
  if (phone.startsWith('wx_')) return '微信账号';
  return phone;
}

// 订单号脱敏：只回尾 6 位（避免运营端泄露完整商户订单号）。
function tail6(s: string): string {
  return s.length <= 6 ? s : s.slice(-6);
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
