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
export type { Overview, AdminAgent, AgentDetail, AgentBilling, AdminAgentCreate, AdminAgentUpdate, MemoryConfig, MemoryIntensity, MemorySource, Plan, AdminUserItem, AdminUserDetail, AdminUserAgentRow, AdminUsageView, AdminTokenUsageView, AdminAuditItem } from '../../shared/contracts';
export type { AgentProviderMode, AgentRuntimeView, AgentRuntimeUpdate } from '../../shared/contracts';
export type { AdminAuthStatus, AdminInitRequest, AdminLoginRequest, AdminAuthResult, AdminChangePasswordRequest } from '../../shared/contracts';
export type { AdminSaying as Saying } from '../../shared/contracts';
export type { SurveyAdmin as SurveyQ } from '../../shared/contracts';
export type { AiConfig, AiConfigView, AiPreset, AiTestResult, AiConfigUpdate, AiProvider } from '../../shared/contracts';

import type {
  Overview, AdminAgent, AgentDetail, AdminAgentCreate, AdminAgentUpdate, SurveyAdmin, Plan, AdminSaying,
  AiConfigView, AiConfigUpdate, AiTestResult, AdminUserItem, AdminUserDetail, AdminUsageView, AdminTokenUsageView, AdminAuditItem,
  AgentRuntimeUpdate,
} from '../../shared/contracts';

export const api = {
  overview: () => req<Overview>('/admin/overview'),
  users: () => req<AdminUserItem[]>('/admin/users'),
  userDetail: (id: string) => req<AdminUserDetail>(`/admin/users/${id}`),
  grantAgent: (id: string, agentKey: string) => req<{ ok: boolean }>(`/admin/users/${id}/agents`, 'POST', { agentKey }),
  revokeAgent: (id: string, agentKey: string) => req<{ ok: boolean }>(`/admin/users/${id}/agents/${agentKey}`, 'DELETE'),
  usage: () => req<AdminUsageView>('/admin/usage'),
  tokenUsage: (days = 30) => req<AdminTokenUsageView>(`/admin/token-usage?days=${days}`),
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
  createAgent: (body: AdminAgentCreate) => req<{ ok: boolean; key: string }>('/admin/agents', 'POST', body),
  survey: () => req<SurveyAdmin[]>('/admin/survey'),
  plans: () => req<Plan[]>('/admin/plans'),
  savePlan: (id: string, body: Partial<Pick<Plan, 'name' | 'price' | 'creditsPerMonth' | 'agentCount' | 'featuresJson' | 'highlighted'>>) =>
    req<Plan>(`/admin/plans/${id}`, 'PATCH', body),
  // —— 大模型配置（可随时切换） ——
  aiConfig: () => req<AiConfigView>('/admin/ai-config'),
  saveAiConfig: (body: AiConfigUpdate) => req<AiConfigView>('/admin/ai-config', 'PUT', body),
  testAiConfig: (body: AiConfigUpdate) => req<AiTestResult>('/admin/ai-config/test', 'POST', body),
};
