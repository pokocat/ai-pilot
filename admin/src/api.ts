import { getAdminToken, clearAdminToken } from './auth';
import type { AdminAuthStatus, AdminInitRequest, AdminLoginRequest, AdminAuthResult, AdminChangePasswordRequest } from '../../shared/contracts';

const BASE = '/api';

/* ────────────── 401 与 403 是两件事 ──────────────
   401 = 掉线（token 失效 / 被撤销）→ 清登录态 + 广播，App 切回登录页。
   403 = 登录态好着，只是这个账户没有这一步的权限（requireSuper 的 owner-only 接口、
         没被授权的 agent）→ **保留登录态**，抛带 code 的错误让调用方就地提示。

   历史坑（2026-07-29 修）：这里原先把 `401 || 403` 一起当「鉴权失效」处理，于是普通运营
   点任何 requireSuper 接口（支付退款、创作任务改价 /admin/creative/config、供应商 dry-run）
   都被直接踢回登录页——把「你没这个权限」说成「你掉线了」。运营会拿着这个现象去查登录/
   密钥，而真正该做的是找 owner 要授权。 */

/** 服务端只回了 code、没回文案时的兜底人话（正常情况下用服务端原文，它更具体）。 */
const FORBIDDEN_FALLBACK: Record<string, string> = {
  OWNER_ONLY: '这一步需要超级管理员（owner / master）权限，当前账户是普通运营',
  ADMIN_AGENT_FORBIDDEN: '你没有该智能体的操作权限，请联系 owner 分配',
  ADMIN_FORBIDDEN: '当前账号没有运营后台管理员权限',
};

function unauthorizedError(status: number): Error {
  clearAdminToken();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('admin:unauth'));
  return Object.assign(new Error('未授权访问运营后台'), { code: 'ADMIN_UNAUTHORIZED', status });
}

function forbiddenError(body: { error?: string; code?: string }): Error {
  const code = body.code || 'ADMIN_FORBIDDEN';
  return Object.assign(
    new Error(body.error || FORBIDDEN_FALLBACK[code] || '没有执行该操作的权限'),
    { code, status: 403 },
  );
}

/** 「权限不足」而不是「加载/操作失败」——视图据此换文案（提示找 owner 授权，而不是重试）。 */
export function isForbidden(e: unknown): boolean {
  return (e as { status?: number } | null)?.status === 403;
}

async function req<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': getAdminToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw unauthorizedError(res.status);
  if (res.status === 403) throw forbiddenError((await res.json().catch(() => ({}))) as { error?: string; code?: string });
  if (!res.ok) {
    // 带回服务端错误文案（如「订单已退款」），比裸 HTTP 状态码可读。
    // code 一并带上：调用方需要按机器可读的错误码分流（如 409 PLAN_CHANGE_SHORTENS → 弹二次确认）。
    const e = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
    throw Object.assign(new Error(e.error || `HTTP ${res.status}`), { status: res.status, code: e.code });
  }
  return res.json();
}

// 订单导出 CSV（仅 owner/master）：req() 只处理 JSON，CSV 走 blob 下载。
export async function downloadPaymentsCsv(q: { status?: string; days?: number; q?: string } = {}): Promise<void> {
  const p = new URLSearchParams();
  if (q.status) p.set('status', q.status);
  if (q.days) p.set('days', String(q.days));
  if (q.q) p.set('q', q.q);
  const qs = p.toString();
  const res = await fetch(`${BASE}/admin/payments/export${qs ? '?' + qs : ''}`, { headers: { 'x-admin-token': getAdminToken() } });
  if (res.status === 401) throw unauthorizedError(res.status);
  if (res.status === 403) throw forbiddenError((await res.json().catch(() => ({}))) as { error?: string; code?: string });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error || `导出失败 HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `payments-${q.days ?? 30}d.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// 后台代用户上传知识库文档（multipart）：req() 走 JSON，文件上传需单独用 FormData（浏览器自动带 boundary）。
export async function uploadUserKnowledge(userId: string, file: File): Promise<{ id: string; status: string }> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${BASE}/admin/users/${userId}/knowledge/upload`, {
    method: 'POST',
    headers: { 'x-admin-token': getAdminToken() }, // 不设 Content-Type，让浏览器带 multipart boundary
    body: fd,
  });
  if (res.status === 401) throw unauthorizedError(res.status);
  if (res.status === 403) throw forbiddenError((await res.json().catch(() => ({}))) as { error?: string; code?: string });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(e.error || `上传失败 HTTP ${res.status}`);
  }
  return res.json();
}

// 校验密钥是否有效（应急密钥登录用）：返回 true=有效。
export async function verifyAdminToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/admin/overview`, { headers: { 'x-admin-token': token } });
    return res.ok;
  } catch {
    return false;
  }
}

// 登录/初始化用：不触发全局「鉴权失效」广播（401 是预期反馈，要在表单内提示，而非踢回登录页）。
export interface RawResult<T> { status: number; ok: boolean; data: (T & { error?: string; code?: string }) | { error?: string; code?: string } | null; }
async function rawPost<T>(path: string, body: object): Promise<RawResult<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': getAdminToken() },
      body: JSON.stringify(body),
    });
    let data: any = null;
    try { data = await res.json(); } catch { /* 无 body */ }
    return { status: res.status, ok: res.ok, data };
  } catch {
    return { status: 0, ok: false, data: { error: '网络异常' } };
  }
}

// 运营后台账户：状态 / 初始化 / 登录 / 退出 / 改密。
export const adminAuth = {
  status: async (): Promise<AdminAuthStatus> => {
    try {
      const res = await fetch(`${BASE}/admin/auth/status`);
      if (res.ok) return res.json();
    } catch { /* 默认未初始化 */ }
    return { initialized: false, masterKeyEnabled: true };
  },
  init: (body: AdminInitRequest) => rawPost<AdminAuthResult>('/admin/auth/init', body),
  login: (body: AdminLoginRequest) => rawPost<AdminAuthResult>('/admin/auth/login', body),
  logout: () => req<{ ok: boolean }>('/admin/auth/logout', 'POST').catch(() => ({ ok: false })),
  changePassword: (body: AdminChangePasswordRequest) => rawPost<{ ok: boolean }>('/admin/auth/password', body),
};

// 数据模型统一来自 SSOT（shared/contracts），与前端/后端同口径；按运营端旧名再导出。
export type { Overview, AdminAgent, AgentDetail, AgentType, AgentBilling, AdminAgentCreate, AdminAgentUpdate, MemoryConfig, MemoryIntensity, MemorySource, Plan, AdminPlan, AdminPlanCreate, AdminPlanUpdate, AdminUserItem, AdminUserDetail, AdminUserAgentRow, AdminUsageView, AdminTokenUsageView, AdminAuditItem, AdminTraceListView, AdminTraceItem, AdminTraceDetail, AdminModerationLogView, AdminAgentMemoryView, AdminAgentMemoryItem } from '../../shared/contracts';
export type { AgentProviderMode, AgentRuntimeView, AgentRuntimeUpdate, SkillsConfig, SkillToolMeta, SkillToolDef, SkillToolUpsert, ToolStatItem } from '../../shared/contracts';
export type { AdminAuthStatus, AdminInitRequest, AdminLoginRequest, AdminAuthResult, AdminChangePasswordRequest } from '../../shared/contracts';
export type { AdminSaying as Saying } from '../../shared/contracts';
export type { SurveyAdmin as SurveyQ } from '../../shared/contracts';
export type { AdminSku, AdminSkuUpdate, SkuKind, ServiceAssignmentView, ServiceAssignmentUpdate } from '../../shared/contracts';
export type { AiPreset, AiTestResult, AiProvider, AiThinkingMode, AiRouting, AiRoutingStatus, AiDialectMeta, AiEndpointCaps, AiConfigIssue, AiProbeReport, AiProbeItem, AiV2Status, AiV2View, AiEndpointView, AiCredentialView, AiRouteView, AiEndpointUpsert, AiEndpointTest, AiRouteUpsert, AiRouteBudget, AiVendorOption } from '../../shared/contracts';
export type { AdminKnowledgeView, AdminKnowledgeItemRow, ReembedResult, AdminRetrievalDebug, RetrievalDebugCand } from '../../shared/contracts';
export type { AdminUserContext, AdminUserMemory, KnowledgeDocRow, KnowledgeDetail, KnowledgeChunkRow } from '../../shared/contracts';
// —— 版本化 / 多运营 / 沙盒 / 评测（运营端调优发布） ——
export type {
  AgentVersionItem, AgentVersionListView, AgentVersionDetail, PublishAgentResult, AgentVersionStatus,
  AdminAccountItem, AdminMe, SandboxRequest, SandboxResult, SandboxTrace, SandboxTarget, SandboxProfile,
  EvalSetItem, EvalSetDetail, EvalCaseItem, EvalRunItem, EvalRunDetail, EvalCaseResultItem,
  PricingTier, SuggestedTier,
} from '../../shared/contracts';

import type {
  Overview, AdminAgent, AgentDetail, AdminAgentCreate, AdminAgentUpdate, SurveyAdmin, AdminPlan, AdminPlanCreate, AdminPlanUpdate, AdminSaying,
  AiTestResult, AdminUserItem, AdminUserDetail, AdminUsageView, AdminTokenUsageView, AdminAuditItem,
  AgentRuntimeUpdate, SkillToolMeta, AdminTraceListView, AdminTraceDetail, AdminModerationLogView, AdminAgentMemoryView, SkillToolDef, SkillToolUpsert, AgentToolDryRunResult, ToolStatsView, ToolStatItem,
  AiEndpointTest, AiRoutingStatus, AiProbeReport, AiV2Status,
  AiV2View, AiEndpointUpsert, AiRouteUpsert, AiConfigIssue, AdminKnowledgeView, ReembedResult, AdminRetrievalDebug,
  AdminUserContext, KnowledgeDetail,
  AgentVersionListView, AgentVersionDetail, PublishAgentResult, AdminAccountItem, AdminMe, CreateAdminAccountRequest, UpdateAdminAccountRequest,
  SandboxRequest, SandboxResult, EvalSetItem, EvalSetDetail, EvalCaseItem, UpsertEvalCaseRequest,
  EvalRunItem, EvalRunDetail, StartEvalRunRequest, PricingTier,
  AdminSku, AdminSkuUpdate, ServiceAssignmentView, ServiceAssignmentUpdate,
  AdminFeatureFlag, AdminMonitorNotify,
  AdminWenceTemplate, AdminWenceTemplateCreate, AdminWenceTemplateUpdate, WenceTemplateKind,
  AdminEcoTool, AdminEcoToolCreate, AdminEcoToolUpdate, AdminPrescriptionFunnel,
  AdminBenchmark, AdminBenchmarkUpsert,
  AdminUserUsage, AdminPaymentsView, AdminPayReconcileResult,
  AdminUserQuotaView, AdminQuotaAdjustRequest,
  AdminCreativeConfig, AdminCreativeConfigUpdate, AdminCreativeDryRunResult, AdminCreativeJobsView,
} from '../../shared/contracts';
export type { AdminFeatureFlag, AdminMonitorNotify } from '../../shared/contracts';
// —— 问策入口（WP1）：提示问题池 / 进场主动消息池 ——
export type { AdminWenceTemplate, AdminWenceTemplateCreate, AdminWenceTemplateUpdate, WenceTemplateKind } from '../../shared/contracts';
export type { AdminEcoTool, AdminEcoToolCreate, AdminEcoToolUpdate, AdminPrescriptionFunnel } from '../../shared/contracts';
export type { AdminBenchmark, AdminBenchmarkUpsert } from '../../shared/contracts';
// —— per-user 用量下钻 + 支付订单只读 ——
export type { AdminUserUsage, AdminUserQuota, AdminUserPlanStatus, AdminTokenAgg, AdminPaymentsView, AdminPaymentItem, AdminPaymentStuckItem, AdminPayReconcileResult, AdminUserQuotaView, AdminQuotaAdjustRequest } from '../../shared/contracts';
// —— 海报成品图（canvas_design）配置与任务台（P3 页面消费）——
export type {
  AdminCreativeConfig, AdminCreativeConfigUpdate, AdminCreativeVisualConfig,
  AdminCreativeDryRunResult, AdminCreativeJobsView, AdminCreativeJobItem,
} from '../../shared/contracts';
// —— 附身登录（impersonation，owner-only）——
export type { AdminImpersonateResult } from '../../shared/contracts';
import type { AdminImpersonateResult } from '../../shared/contracts';

export const api = {
  overview: () => req<Overview>('/admin/overview'),
  users: () => req<AdminUserItem[]>('/admin/users'),
  userDetail: (id: string) => req<AdminUserDetail>(`/admin/users/${id}`),
  grantAgent: (id: string, agentKey: string) => req<{ ok: boolean }>(`/admin/users/${id}/agents`, 'POST', { agentKey }),
  revokeAgent: (id: string, agentKey: string) => req<{ ok: boolean }>(`/admin/users/${id}/agents/${agentKey}`, 'DELETE'),
  // 附身登录：为目标用户签发短时 token（owner-only；后端 requireSuper + 审计）。
  impersonate: (id: string) => req<AdminImpersonateResult>(`/admin/users/${id}/impersonate`, 'POST'),
  // —— 用户上下文中心：个人档案 + 长期记忆 + 知识库 ——
  userContext: (id: string) => req<AdminUserContext>(`/admin/users/${id}/context`),
  delUserMemory: (id: string, mid: string) => req<{ ok: boolean }>(`/admin/users/${id}/memories/${mid}`, 'DELETE'),
  userKnowledgeDetail: (id: string, kid: string) => req<KnowledgeDetail>(`/admin/users/${id}/knowledge/${kid}`),
  delUserKnowledge: (id: string, kid: string) => req<{ ok: boolean }>(`/admin/users/${id}/knowledge/${kid}`, 'DELETE'),
  reembedUserKnowledge: (id: string, kid: string) => req<{ chunks: number }>(`/admin/users/${id}/knowledge/${kid}/reembed`, 'POST'),
  usage: () => req<AdminUsageView>('/admin/usage'),
  tokenUsage: (days = 30) => req<AdminTokenUsageView>(`/admin/token-usage?days=${days}`),
  knowledge: () => req<AdminKnowledgeView>('/admin/knowledge'),
  reembedKnowledge: () => req<ReembedResult>('/admin/knowledge/reembed', 'POST'),
  retrievalTest: (body: { userId: string; query: string; agentKey?: string }) => req<AdminRetrievalDebug>('/admin/retrieval-test', 'POST', body),
  traces: (q: { days?: number; status?: string; agentKey?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.days) p.set('days', String(q.days));
    if (q.status) p.set('status', q.status);
    if (q.agentKey) p.set('agentKey', q.agentKey);
    const qs = p.toString();
    return req<AdminTraceListView>(`/admin/observability${qs ? '?' + qs : ''}`);
  },
  trace: (id: string) => req<AdminTraceDetail>(`/admin/observability/${id}`),
  moderationLogs: (q: { verdict?: string; refType?: string; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.verdict) p.set('verdict', q.verdict);
    if (q.refType) p.set('refType', q.refType);
    if (q.limit) p.set('limit', String(q.limit));
    const qs = p.toString();
    return req<AdminModerationLogView>(`/admin/moderation-logs${qs ? '?' + qs : ''}`);
  },
  agentMemories: (key: string) => req<AdminAgentMemoryView>(`/admin/agents/${key}/memories`),
  deleteAgentMemory: (key: string, mid: string) => req<{ ok: boolean }>(`/admin/agents/${key}/memories/${mid}`, 'DELETE'),
  customSkillTools: () => req<SkillToolDef[]>('/admin/skill-tools/custom'),
  createSkillTool: (body: SkillToolUpsert) => req<SkillToolDef>('/admin/skill-tools/custom', 'POST', body),
  updateSkillTool: (id: string, body: SkillToolUpsert) => req<SkillToolDef>(`/admin/skill-tools/custom/${id}`, 'PATCH', body),
  delSkillTool: (id: string) => req<{ ok: boolean }>(`/admin/skill-tools/custom/${id}`, 'DELETE'),
  auditLogs: (q: { includeAdmin?: boolean; includeMetrics?: boolean; action?: string; userId?: string } = {}) => {
    const p = new URLSearchParams();
    if (q.includeAdmin) p.set('includeAdmin', 'true');
    if (q.includeMetrics) p.set('includeMetrics', 'true');
    if (q.action) p.set('action', q.action);
    if (q.userId) p.set('userId', q.userId);
    const qs = p.toString();
    return req<AdminAuditItem[]>(`/admin/audit-logs${qs ? '?' + qs : ''}`);
  },
  sayings: () => req<AdminSaying[]>('/admin/sayings'),
  addSaying: (text: string) => req<AdminSaying>('/admin/sayings', 'POST', { text }),
  toggleSaying: (id: string, enabled: boolean) => req<AdminSaying>(`/admin/sayings/${id}`, 'PATCH', { enabled }),
  delSaying: (id: string) => req(`/admin/sayings/${id}`, 'DELETE'),
  agents: () => req<AdminAgent[]>('/admin/agents'),
  agent: (key: string) => req<AgentDetail>(`/admin/agents/${key}`),
  saveAgent: (key: string, body: AdminAgentUpdate) =>
    req<{ ok: boolean }>(`/admin/agents/${key}`, 'PATCH', body),
  testAgent: (key: string, runtime: AgentRuntimeUpdate) =>
    req<AiTestResult>(`/admin/agents/${key}/test`, 'POST', runtime),
  dryRunTool: (key: string, name: string, args: Record<string, unknown>) =>
    req<AgentToolDryRunResult>(`/admin/agents/${key}/tools/${encodeURIComponent(name)}/dry-run`, 'POST', { args }),
  toolStats: (agentKey?: string, days = 7) =>
    req<ToolStatsView>(`/admin/tool-stats?agentKey=${encodeURIComponent(agentKey ?? '')}&days=${days}`),
  skillTools: () => req<SkillToolMeta[]>('/admin/skill-tools'),
  createAgent: (body: AdminAgentCreate) => req<{ ok: boolean; key: string }>('/admin/agents', 'POST', body),
  survey: () => req<SurveyAdmin[]>('/admin/survey'),
  // —— 功能开关（P0-2）：命理等合规开关一键降级 ——
  flags: () => req<AdminFeatureFlag[]>('/admin/flags'),
  setFlag: (id: string, enabled: boolean) => req<AdminFeatureFlag>(`/admin/flags/${id}`, 'PATCH', { enabled }),
  setFlagValue: (id: string, value: number) => req<AdminFeatureFlag>(`/admin/flags/${id}`, 'PATCH', { value }),
  // A/B 实验开关的分桶权重：与 enabled 是两件独立的事，可以单独提交（服务端只改 payload.arms，
  // 不动 enabled）。未知臂名 / 全 0 / 单臂超 100 由服务端 400 挡下，文案原样透出给运营。
  setFlagArms: (id: string, arms: Record<string, number>) => req<AdminFeatureFlag>(`/admin/flags/${id}`, 'PATCH', { arms }),
  // —— 问策模板池（WP1）：hint = 输入框上方提示问题；proactive = 进场主动消息（含 chips）——
  // 空池是合法状态（端上分别回退本地兜底词 / 不注入），所以这里不做「至少一条」的前端强校验。
  wenceTemplates: (kind?: WenceTemplateKind) => req<AdminWenceTemplate[]>(`/admin/wence-templates${kind ? `?kind=${kind}` : ''}`),
  createWenceTemplate: (body: AdminWenceTemplateCreate) => req<AdminWenceTemplate>('/admin/wence-templates', 'POST', body),
  // chips 显式传 [] / null 才是「清空这一排」；不传该字段 = 不动（与服务端 PATCH 口径一致）。
  updateWenceTemplate: (id: string, body: AdminWenceTemplateUpdate) => req<AdminWenceTemplate>(`/admin/wence-templates/${id}`, 'PATCH', body),
  deleteWenceTemplate: (id: string) => req<{ ok: boolean }>(`/admin/wence-templates/${id}`, 'DELETE'),
  // —— 告警通知（监控大盘二期）：飞书群机器人 webhook，仅 owner/master 可写 ——
  monitorNotify: () => req<AdminMonitorNotify>('/admin/monitor-notify'),
  saveMonitorNotify: (url: string, secret: string) => req<AdminMonitorNotify>('/admin/monitor-notify', 'PUT', { url, secret }),
  testMonitorNotify: () => req<{ sent: boolean }>('/admin/monitor-notify/test', 'POST'),
  // —— 套餐：**线上目录的唯一入口**（代码侧已无同步脚本，改价/建档/停售全在这里）——
  plans: () => req<AdminPlan[]>('/admin/plans'),
  savePlan: (id: string, body: AdminPlanUpdate) => req<AdminPlan>(`/admin/plans/${id}`, 'PATCH', body),
  createPlan: (body: AdminPlanCreate) => req<AdminPlan>('/admin/plans', 'POST', body),
  // 删除仅限「无用户在册」的档（后端 409 PLAN_IN_USE 兜底）；停售请用 hidden。
  deletePlan: (id: string) => req<{ ok: boolean }>(`/admin/plans/${id}`, 'DELETE'),
  // —— 单次付费 SKU：改价 / 启停 / 展示（key、kind、解锁模块走代码目录，不在此改）——
  adminSkus: () => req<AdminSku[]>('/admin/skus'),
  updateSku: (key: string, body: AdminSkuUpdate) => req<AdminSku>(`/admin/skus/${key}`, 'PATCH', body),
  // —— D-1/WO-12 处方多来源漏斗（六态聚合 + 开通来源计数）——
  prescriptionFunnel: (days = 30) => req<AdminPrescriptionFunnel>(`/admin/prescriptions/funnel?days=${days}`),
  // —— D-3-7 生态工具注册表 CRUD（enabled 控制可开方）——
  ecoTools: () => req<AdminEcoTool[]>('/admin/eco-tools'),
  createEcoTool: (body: AdminEcoToolCreate) => req<AdminEcoTool>('/admin/eco-tools', 'POST', body),
  updateEcoTool: (id: string, body: AdminEcoToolUpdate) => req<AdminEcoTool>(`/admin/eco-tools/${id}`, 'PATCH', body),
  deleteEcoTool: (id: string) => req<{ ok: boolean }>(`/admin/eco-tools/${id}`, 'DELETE'),
  // —— WO-08 行业基准库 CRUD（列表带行业筛选 / upsert / 删除；CSV 前端逐行 upsert）——
  benchmarks: (industry?: string) => req<AdminBenchmark[]>(`/admin/benchmarks${industry ? `?industry=${encodeURIComponent(industry)}` : ''}`),
  upsertBenchmark: (body: AdminBenchmarkUpsert) => req<AdminBenchmark>('/admin/benchmarks', 'POST', body),
  deleteBenchmark: (id: string) => req<{ ok: boolean }>(`/admin/benchmarks/${id}`, 'DELETE'),
  // —— 社群服务分配（按用户）——
  userService: (id: string) => req<{ service: ServiceAssignmentView | null }>(`/admin/users/${id}/service`),
  setUserService: (id: string, body: ServiceAssignmentUpdate) => req<{ service: ServiceAssignmentView | null }>(`/admin/users/${id}/service`, 'PUT', body),
  // —— per-user 用量下钻（额度 / 30 天 token / 钻石流水 / 支付 / 开通归因）——
  userUsage: (id: string, days = 30) => req<AdminUserUsage>(`/admin/users/${id}/usage?days=${days}`),
  userQuotaDetail: (id: string) => req<AdminUserQuotaView>(`/admin/users/${id}/token-quota-detail`),
  adjustUserQuota: (id: string, body: AdminQuotaAdjustRequest) => req<{ ok: boolean; id: string }>(`/admin/users/${id}/token-quota-adjustments`, 'POST', body),
  restoreUserQuota: (id: string) => req<{ ok: boolean }>(`/admin/users/${id}/token-quota/restore-plan`, 'POST', {}),
  // —— 运营动作（owner-only；后端 requireSuper + 审计带 before/after）——
  setUserQuota: (id: string, body: { mode: 'reset_to_plan' | 'set'; quota?: number }) => req<{ ok: boolean }>(`/admin/users/${id}/token-quota`, 'POST', body),
  adjustUserCredits: (id: string, body: { delta: number; reason: string }) => req<{ ok: boolean }>(`/admin/users/${id}/credits`, 'POST', body),
  extendUserPlan: (id: string, body: { days: number }) => req<{ ok: boolean }>(`/admin/users/${id}/plan-extend`, 'POST', body),
  // —— 支付订单列表（状态筛选 + 天数 + 搜索 + 分页 + 卡单清单）——
  payments: (q: { status?: string; days?: number; q?: string; page?: number; pageSize?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.status) p.set('status', q.status);
    if (q.days) p.set('days', String(q.days));
    if (q.q) p.set('q', q.q);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return req<AdminPaymentsView>(`/admin/payments${qs ? '?' + qs : ''}`);
  },
  // 手动查单补账（卡单处置）：向微信查单并幂等入账，不会重复发放。
  reconcilePayment: (outTradeNo: string) => req<AdminPayReconcileResult>(`/admin/payments/${encodeURIComponent(outTradeNo)}/reconcile`, 'POST', {}),
  // 全额退款（仅 owner/master）：原路退回 + 幂等权益回收。
  refundPayment: (outTradeNo: string, reason: string) => req<{ ok: boolean; refundId: string; wechatStatus: string }>(`/admin/payments/${encodeURIComponent(outTradeNo)}/refund`, 'POST', { reason }),
  // —— 海报成品图（canvas_design 创作任务）：配置 / 供应商试跑 / 任务台 ——
  // 配置存 FeatureFlag 单行（id='creative-poster'）：enabled 是运行时开关，payload 承载价格/限额/供应商。
  // enabled 是**唯一**真源（行缺失视为关）：2026-07 删掉了部署级 CANVAS_DESIGN_ENABLED，不再有「双开才算开」。
  creativeConfig: () => req<AdminCreativeConfig>('/admin/creative/config'),
  // 图片供应商 apiKey：不传=不动、传空串=清空、传值=secretBox 加密写入；读回永远只有 hasKey。
  // 注意历史 AiSetting/AiModel 凭证按产品决策明文存库；当前归一化凭证同样只回 hasKey。
  saveCreativeConfig: (body: AdminCreativeConfigUpdate) => req<AdminCreativeConfig>('/admin/creative/config', 'PUT', body),
  // 连通性试跑（仅 owner/master）：真发一次最小请求，只回通/不通 + 耗时，不落资产。
  creativeProviderDryRun: () => req<AdminCreativeDryRunResult>('/admin/creative/provider/dry-run', 'POST', {}),
  creativeJobs: (q: { status?: string; page?: number; pageSize?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.status) p.set('status', q.status);
    if (q.page) p.set('page', String(q.page));
    if (q.pageSize) p.set('pageSize', String(q.pageSize));
    const qs = p.toString();
    return req<AdminCreativeJobsView>(`/admin/creative/jobs${qs ? '?' + qs : ''}`);
  },
  // 重试失败任务（仅 owner/master）：failed → pending、attempts 清零，不重复扣费。
  retryCreativeJob: (id: string) => req<{ ok: boolean; jobId: string; status: string }>(`/admin/creative/jobs/${encodeURIComponent(id)}/retry`, 'POST', {}),
  // 手动开通套餐 / 发放·收回模块（仅 owner/master）。
  // force：改档会缩短用户有效期时（降级 / 不限期→限期）服务端回 409 PLAN_CHANGE_SHORTENS，
  // 运营看清损失天数后带 force=true 重试才执行。升级/同档会自动结转剩余天数（carriedDays）。
  grantUserPlan: (userId: string, planId: string, force = false) =>
    req<{ ok: boolean; planName: string; expiresAt: string | null; grantedCredits: number; carriedDays: number }>(`/admin/users/${userId}/plan`, 'POST', { planId, ...(force ? { force: true } : {}) }),
  grantUserModule: (userId: string, moduleKey: string) => req<{ ok: boolean }>(`/admin/users/${userId}/modules`, 'POST', { moduleKey }),
  revokeUserModule: (userId: string, moduleKey: string) => req<{ ok: boolean }>(`/admin/users/${userId}/modules/${encodeURIComponent(moduleKey)}`, 'DELETE'),
  /* —— 归一化接入配置（三期）：后台直接读写四张表 ——
   * 旧版这里是 aiConfig / aiModels / aiRouting 三组接口，写的是 AiSetting + AiModel。
   * 那套下面「生效」＝拷 8 个字段、换 key 要改 N 行、辅助档只能改 env。现在统一到这一组。 */
  aiV2: () => req<AiV2View>('/admin/ai-v2'),
  aiV2Status: () => req<AiV2Status>('/admin/ai-v2-status'),
  /** 端点池实时冷却态（只读）：谁在被限流、几点恢复。 */
  aiRouting: () => req<AiRoutingStatus>('/admin/ai-routing'),

  addAiEndpoint: (body: AiEndpointUpsert) => req<{ id: string; issues: AiConfigIssue[] }>('/admin/ai-endpoints', 'POST', body),
  updateAiEndpoint: (id: string, body: Partial<AiEndpointUpsert>) =>
    req<{ ok: boolean; issues: AiConfigIssue[] }>(`/admin/ai-endpoints/${id}`, 'PATCH', body),
  delAiEndpoint: (id: string) => req<{ ok: boolean }>(`/admin/ai-endpoints/${id}`, 'DELETE'),
  /** 探活：用表单字段直测。endpointId 传入且 key 留空则取该端点凭证的 key。 */
  testAiEndpoint: (body: AiEndpointTest) => req<AiTestResult>('/admin/ai-endpoints/test', 'POST', body),
  /** 深度检测：结果直接写端点表并回填能力标记。 */
  probeAiEndpoint: (id: string, kinds: string[]) => req<AiProbeReport>(`/admin/ai-endpoints/${id}/probe`, 'POST', { kinds }),
  /** 入池 / 出池 ＝ chat 路由的成员增删。 */
  setAiEndpointPool: (id: string, inPool: boolean) => req<{ ok: boolean }>(`/admin/ai-endpoints/${id}/pool`, 'POST', { inPool }),

  /** 换 key 的唯一入口：改这一条，它下面所有端点一起生效。 */
  updateAiCredential: (id: string, body: { label?: string; vendor?: string; apiKey?: string }) =>
    req<{ ok: boolean }>(`/admin/ai-credentials/${id}`, 'PATCH', body),

  saveAiRoute: (purpose: string, body: AiRouteUpsert) =>
    req<{ ok: boolean; issues: AiConfigIssue[] }>(`/admin/ai-routes/${purpose}`, 'PUT', body),
  /** 「设为生效」＝把某用途的 primary 指针指过去，没有任何字段拷贝。 */
  setAiRoutePrimary: (purpose: string, endpointId: string) =>
    req<{ ok: boolean }>(`/admin/ai-routes/${purpose}/primary/${endpointId}`, 'POST'),

  // —— 当前登录者（按角色显隐账户管理 / 过滤 agent）——
  me: () => req<AdminMe>('/admin/auth/me'),

  // —— 版本化：历史 / 发布 / 回滚 ——
  agentVersions: (key: string) => req<AgentVersionListView>(`/admin/agents/${key}/versions`),
  agentVersion: (key: string, vid: string) => req<AgentVersionDetail>(`/admin/agents/${key}/versions/${vid}`),
  publishAgent: (key: string, label?: string) => req<PublishAgentResult>(`/admin/agents/${key}/publish`, 'POST', { label }),
  rollbackAgent: (key: string, versionId: string) => req<{ ok: boolean; version: number }>(`/admin/agents/${key}/rollback`, 'POST', { versionId }),

  // —— 调教沙盒：用草稿/某版本即时试跑 ——
  sandbox: (key: string, body: SandboxRequest) => req<SandboxResult>(`/admin/agents/${key}/sandbox`, 'POST', body),

  // —— 多运营账户管理（owner）——
  accounts: () => req<AdminAccountItem[]>('/admin/accounts'),
  createAccount: (body: CreateAdminAccountRequest) => req<AdminAccountItem>('/admin/accounts', 'POST', body),
  updateAccount: (id: string, body: UpdateAdminAccountRequest) => req<AdminAccountItem>(`/admin/accounts/${id}`, 'PATCH', body),

  // —— 评测：黄金测试集 + 跑分 ——
  pricingTiers: () => req<PricingTier[]>('/admin/pricing-tiers'),
  evalSets: (key: string) => req<EvalSetItem[]>(`/admin/agents/${key}/eval-sets`),
  createEvalSet: (key: string, name: string) => req<EvalSetItem>(`/admin/agents/${key}/eval-sets`, 'POST', { name }),
  evalSet: (id: string) => req<EvalSetDetail>(`/admin/eval-sets/${id}`),
  renameEvalSet: (id: string, name: string) => req<{ ok: boolean }>(`/admin/eval-sets/${id}`, 'PATCH', { name }),
  delEvalSet: (id: string) => req<{ ok: boolean }>(`/admin/eval-sets/${id}`, 'DELETE'),
  addEvalCase: (setId: string, body: UpsertEvalCaseRequest) => req<EvalCaseItem>(`/admin/eval-sets/${setId}/cases`, 'POST', body),
  updateEvalCase: (id: string, body: UpsertEvalCaseRequest) => req<{ ok: boolean }>(`/admin/eval-cases/${id}`, 'PATCH', body),
  delEvalCase: (id: string) => req<{ ok: boolean }>(`/admin/eval-cases/${id}`, 'DELETE'),
  startEvalRun: (key: string, body: StartEvalRunRequest) => req<{ runId: string }>(`/admin/agents/${key}/eval-runs`, 'POST', body),
  evalRuns: (key: string) => req<EvalRunItem[]>(`/admin/agents/${key}/eval-runs`),
  evalRun: (id: string) => req<EvalRunDetail>(`/admin/eval-runs/${id}`),
};
