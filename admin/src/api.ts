import { getAdminToken, clearAdminToken } from './auth';
import type { AdminAuthStatus, AdminInitRequest, AdminLoginRequest, AdminAuthResult, AdminChangePasswordRequest } from '../../shared/contracts';

const BASE = '/api';

async function req<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': getAdminToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  // 鉴权失效：清登录态并广播，App 切回登录页
  if (res.status === 401 || res.status === 403) {
    clearAdminToken();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('admin:unauth'));
    throw Object.assign(new Error('未授权访问运营后台'), { code: 'ADMIN_UNAUTHORIZED', status: res.status });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
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
  if (res.status === 401 || res.status === 403) {
    clearAdminToken();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('admin:unauth'));
    throw new Error('未授权访问运营后台');
  }
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
export type { Overview, AdminAgent, AgentDetail, AgentBilling, AdminAgentCreate, AdminAgentUpdate, MemoryConfig, MemoryIntensity, MemorySource, Plan, AdminUserItem, AdminUserDetail, AdminUserAgentRow, AdminUsageView, AdminTokenUsageView, AdminAuditItem, AdminTraceListView, AdminTraceItem, AdminTraceDetail } from '../../shared/contracts';
export type { AgentProviderMode, AgentRuntimeView, AgentRuntimeUpdate, SkillsConfig, SkillToolMeta, SkillToolDef, SkillToolUpsert } from '../../shared/contracts';
export type { AdminAuthStatus, AdminInitRequest, AdminLoginRequest, AdminAuthResult, AdminChangePasswordRequest } from '../../shared/contracts';
export type { AdminSaying as Saying } from '../../shared/contracts';
export type { SurveyAdmin as SurveyQ } from '../../shared/contracts';
export type { AiConfig, AiConfigView, AiPreset, AiTestResult, AiConfigUpdate, AiProvider, AiModel, AiModelUpsert, AiModelTest } from '../../shared/contracts';
export type { AdminKnowledgeView, AdminKnowledgeItemRow, ReembedResult, AdminRetrievalDebug, RetrievalDebugCand } from '../../shared/contracts';
export type { AdminUserContext, AdminUserMemory, KnowledgeDocRow, KnowledgeDetail, KnowledgeChunkRow } from '../../shared/contracts';
// —— 版本化 / 多运营 / 沙盒 / 评测（运营端调优发布） ——
export type {
  AgentVersionItem, AgentVersionListView, PublishAgentResult, AgentVersionStatus,
  AdminAccountItem, AdminMe, SandboxRequest, SandboxResult, SandboxTrace, SandboxTarget, SandboxProfile,
  EvalSetItem, EvalSetDetail, EvalCaseItem, EvalRunItem, EvalRunDetail, EvalCaseResultItem,
  PricingTier, SuggestedTier,
} from '../../shared/contracts';

import type {
  Overview, AdminAgent, AgentDetail, AdminAgentCreate, AdminAgentUpdate, SurveyAdmin, Plan, AdminSaying,
  AiConfigView, AiConfigUpdate, AiTestResult, AdminUserItem, AdminUserDetail, AdminUsageView, AdminTokenUsageView, AdminAuditItem,
  AgentRuntimeUpdate, SkillToolMeta, AdminTraceListView, AdminTraceDetail, SkillToolDef, SkillToolUpsert,
  AiModel, AiModelUpsert, AiModelTest, AdminKnowledgeView, ReembedResult, AdminRetrievalDebug,
  AdminUserContext, KnowledgeDetail,
  AgentVersionListView, PublishAgentResult, AdminAccountItem, AdminMe, CreateAdminAccountRequest, UpdateAdminAccountRequest,
  SandboxRequest, SandboxResult, EvalSetItem, EvalSetDetail, EvalCaseItem, UpsertEvalCaseRequest,
  EvalRunItem, EvalRunDetail, StartEvalRunRequest, PricingTier,
} from '../../shared/contracts';

export const api = {
  overview: () => req<Overview>('/admin/overview'),
  users: () => req<AdminUserItem[]>('/admin/users'),
  userDetail: (id: string) => req<AdminUserDetail>(`/admin/users/${id}`),
  grantAgent: (id: string, agentKey: string) => req<{ ok: boolean }>(`/admin/users/${id}/agents`, 'POST', { agentKey }),
  revokeAgent: (id: string, agentKey: string) => req<{ ok: boolean }>(`/admin/users/${id}/agents/${agentKey}`, 'DELETE'),
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
  customSkillTools: () => req<SkillToolDef[]>('/admin/skill-tools/custom'),
  createSkillTool: (body: SkillToolUpsert) => req<SkillToolDef>('/admin/skill-tools/custom', 'POST', body),
  updateSkillTool: (id: string, body: SkillToolUpsert) => req<SkillToolDef>(`/admin/skill-tools/custom/${id}`, 'PATCH', body),
  delSkillTool: (id: string) => req<{ ok: boolean }>(`/admin/skill-tools/custom/${id}`, 'DELETE'),
  auditLogs: () => req<AdminAuditItem[]>('/admin/audit-logs'),
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
  skillTools: () => req<SkillToolMeta[]>('/admin/skill-tools'),
  createAgent: (body: AdminAgentCreate) => req<{ ok: boolean; key: string }>('/admin/agents', 'POST', body),
  survey: () => req<SurveyAdmin[]>('/admin/survey'),
  plans: () => req<Plan[]>('/admin/plans'),
  savePlan: (id: string, body: Partial<Pick<Plan, 'name' | 'price' | 'creditsPerMonth' | 'tokenQuotaPerMonth' | 'agentCount' | 'featuresJson' | 'highlighted'>>) =>
    req<Plan>(`/admin/plans/${id}`, 'PATCH', body),
  // —— 大模型配置（可随时切换） ——
  aiConfig: () => req<AiConfigView>('/admin/ai-config'),
  saveAiConfig: (body: AiConfigUpdate) => req<AiConfigView>('/admin/ai-config', 'PUT', body),
  testAiConfig: (body: AiConfigUpdate) => req<AiTestResult>('/admin/ai-config/test', 'POST', body),
  // —— 已添加模型：增删改 + 快速切换 + 探活 ——
  addAiModel: (body: AiModelUpsert) => req<AiModel>('/admin/ai-models', 'POST', body),
  updateAiModel: (id: string, body: AiModelUpsert) => req<AiModel>(`/admin/ai-models/${id}`, 'PATCH', body),
  delAiModel: (id: string) => req<{ ok: boolean }>(`/admin/ai-models/${id}`, 'DELETE'),
  activateAiModel: (id: string) => req<AiConfigView>(`/admin/ai-models/${id}/activate`, 'POST'),
  testAiModel: (body: AiModelTest) => req<AiTestResult>('/admin/ai-models/test', 'POST', body),

  // —— 当前登录者（按角色显隐账户管理 / 过滤 agent）——
  me: () => req<AdminMe>('/admin/auth/me'),

  // —— 版本化：历史 / 发布 / 回滚 ——
  agentVersions: (key: string) => req<AgentVersionListView>(`/admin/agents/${key}/versions`),
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
