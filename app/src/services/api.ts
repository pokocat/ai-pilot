import Taro from '@tarojs/taro';

// 后端基址：H5 走本机后端；微信小程序需在后台配置合法域名后替换为线上域名。
// 可通过环境变量 TARO_APP_API 覆盖。
export const BASE_URL =
  (typeof process !== 'undefined' && process.env.TARO_APP_API) || 'http://localhost:4000/api';

const USER_KEY = 'junshi.userId';

export function getUserId(): string {
  try {
    return Taro.getStorageSync(USER_KEY) || '';
  } catch {
    return '';
  }
}
export function setUserId(id: string) {
  Taro.setStorageSync(USER_KEY, id);
}
export function clearUserId() {
  try { Taro.removeStorageSync(USER_KEY); } catch { /* noop */ }
}

async function request<T>(path: string, method: keyof typeof Taro.request | any = 'GET', data?: object): Promise<T> {
  const res = await Taro.request({
    url: `${BASE_URL}${path}`,
    method: method as any,
    data,
    header: { 'Content-Type': 'application/json', 'x-user-id': getUserId() },
  });
  if (res.statusCode === 401) {
    clearUserId(); // token 失效：清掉，下次进首页回到登录
    throw Object.assign(new Error((res.data as any)?.error || '未登录'), { code: 'UNAUTHORIZED', data: res.data });
  }
  if (res.statusCode >= 400) {
    throw Object.assign(new Error((res.data as any)?.error || `HTTP ${res.statusCode}`), { data: res.data });
  }
  return res.data as T;
}

// —— 类型 ——
export interface Me {
  user: { id: string; name: string; role: string; benmingColor: string };
  tenant: { id: string; name: string; industry?: string; stage?: string };
  plan: { name: string; creditsPerMonth: number } | null;
  creditBalance: number;
  onboarded?: boolean;
  ai: { provider: string; model: string; ready?: boolean; claudeReady: boolean };
}
export interface LoginResult {
  token: string;
  isNew: boolean;
  onboarded: boolean;
  user: { id: string; name: string; phone: string; benmingColor: string };
}
export interface Agent {
  key: string; name: string; role: string; icon: string; type: string;
  gift: boolean; enabled: boolean; greet: string; chips: [string, string][];
  memText: string; learnText: string; deliverableKey: string | null;
}
export interface SurveyQ { key: string; title: string; options: string[]; }
export interface SessionItem {
  id: string; agentKey: string; agentName: string; agentIcon: string;
  title: string; snippet: string; updatedAt: string;
}
export interface Section { h: string; b?: string; list?: string[]; }
export interface Deliverable {
  title: string; icon: string; meta: string; sections: Section[]; trust: string; actions: string[];
}
export interface ChatReplyT { text: string; points?: string[]; acts?: [string, string][]; }
export interface GenResult {
  sessionId: string; created: boolean; agentKey: string;
  kind: 'report' | 'chat'; messageId: string;
  deliverable?: Deliverable; reply?: ChatReplyT;
  memory?: { learned: boolean; agentName: string } | null;
}
export interface SessionDetail {
  id: string; agentKey: string;
  agent: { key: string; name: string; role: string; icon: string; greet: string; chips: [string, string][]; memText: string; learnText: string };
  title: string;
  messages: { id: string; role: string; content: any; at: string }[];
}
export interface LibItem {
  id: string; title: string; type: string; agentKey: string; agentName: string;
  sessionId: string | null; content: Deliverable; at: string;
}

// —— API ——
export const api = {
  login: (phone: string, name?: string) => request<LoginResult>('/auth/login', 'POST', { phone, name }),
  me: () => request<Me>('/me'),
  setColor: (color: string) => request<{ ok: boolean }>('/me/color', 'PUT', { color }),
  agents: () => request<Agent[]>('/agents'),
  survey: () => request<SurveyQ[]>('/survey'),
  getProfile: () => request<{ industry?: string; stage?: string; pain?: string } | null>('/profile'),
  saveProfile: (p: { industry?: string; stage?: string; pain?: string }) => request('/profile', 'PUT', p),
  todaySaying: () => request<{ text: string; date: string }>('/sayings/today'),
  sessions: () => request<SessionItem[]>('/sessions'),
  session: (id: string) => request<SessionDetail>(`/sessions/${id}`),
  deleteSession: (id: string) => request(`/sessions/${id}`, 'DELETE'),
  generate: (body: { text: string; agentKey?: string; sessionId?: string }) =>
    request<GenResult>('/generate-sync', 'POST', body),
  library: () => request<LibItem[]>('/library'),
  saveToLibrary: (body: { title: string; type: string; agentKey: string; sessionId?: string; content: object }) =>
    request<{ id: string; at: string }>('/library', 'POST', body),
};
