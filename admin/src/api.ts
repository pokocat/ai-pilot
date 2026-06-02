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

export interface Overview {
  stats: { v: string; l: string; d: string; trend: string }[];
  live: Record<string, number>;
  feed: { icon: string; t: string; m: string; v: string }[];
}
export interface Saying { id: string; text: string; enabled: boolean; pushedDate: string | null; }
export interface AdminAgent { key: string; name: string; role: string; icon: string; type: string; gift: boolean; enabled: boolean; deliverableKey: string | null; }
export interface MemoryConfig { longTerm: boolean; autoLearn: boolean; intensity: string; retentionDays: number; sources: string[]; }
export interface AgentDetail { key: string; name: string; role: string; icon: string; type: string; enabled: boolean; systemPrompt: string; memoryConfig: MemoryConfig; deliverableKey: string | null; }
export interface SurveyQ { id: string; key: string; title: string; optionsJson: string[]; enabled: boolean; }
export interface Plan { id: string; name: string; price: number; period: string; creditsPerMonth: number; agentCount: number; featuresJson: string[]; highlighted: boolean; }

export const api = {
  overview: () => req<Overview>('/admin/overview'),
  sayings: () => req<Saying[]>('/admin/sayings'),
  addSaying: (text: string) => req<Saying>('/admin/sayings', 'POST', { text }),
  toggleSaying: (id: string, enabled: boolean) => req<Saying>(`/admin/sayings/${id}`, 'PATCH', { enabled }),
  delSaying: (id: string) => req(`/admin/sayings/${id}`, 'DELETE'),
  agents: () => req<AdminAgent[]>('/admin/agents'),
  agent: (key: string) => req<AgentDetail>(`/admin/agents/${key}`),
  saveAgent: (key: string, body: { systemPrompt?: string; memoryConfig?: object; enabled?: boolean }) =>
    req<{ ok: boolean }>(`/admin/agents/${key}`, 'PATCH', body),
  survey: () => req<SurveyQ[]>('/admin/survey'),
  plans: () => req<Plan[]>('/admin/plans'),
};
