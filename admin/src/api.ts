const BASE = '/api';

async function req<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// 数据模型统一来自 SSOT（shared/contracts），与前端/后端同口径；按运营端旧名再导出。
export type { Overview, AdminAgent, AgentDetail, MemoryConfig, MemoryIntensity, MemorySource, Plan } from '../../shared/contracts';
export type { AdminSaying as Saying } from '../../shared/contracts';
export type { SurveyAdmin as SurveyQ } from '../../shared/contracts';

import type { Overview, AdminAgent, AgentDetail, SurveyAdmin, Plan, AdminSaying } from '../../shared/contracts';

export const api = {
  overview: () => req<Overview>('/admin/overview'),
  sayings: () => req<AdminSaying[]>('/admin/sayings'),
  addSaying: (text: string) => req<AdminSaying>('/admin/sayings', 'POST', { text }),
  toggleSaying: (id: string, enabled: boolean) => req<AdminSaying>(`/admin/sayings/${id}`, 'PATCH', { enabled }),
  delSaying: (id: string) => req(`/admin/sayings/${id}`, 'DELETE'),
  agents: () => req<AdminAgent[]>('/admin/agents'),
  agent: (key: string) => req<AgentDetail>(`/admin/agents/${key}`),
  saveAgent: (key: string, body: { systemPrompt?: string; memoryConfig?: object; enabled?: boolean }) =>
    req<{ ok: boolean }>(`/admin/agents/${key}`, 'PATCH', body),
  survey: () => req<SurveyAdmin[]>('/admin/survey'),
  plans: () => req<Plan[]>('/admin/plans'),
};
