import Taro from '@tarojs/taro';
import { IS_MOCK, BASE_URL } from './config';
import { getToken, setToken, clearToken } from './token';
import { mock } from './mock';
import type {
  Me, Agent, SurveyQuestion, SessionItem, SessionDetail,
  GenResult, GenRequest, LibItem, LoginResult, Profile, TodaySaying, SaveLibRequest,
} from '../../../shared/contracts';

// 数据模型统一来自 SSOT（shared/contracts）。下面按旧名再导出，保证调用方零改动。
export type {
  Me, Agent, SessionItem, SessionDetail, Deliverable, GenResult, LibItem, LoginResult, Profile,
} from '../../../shared/contracts';
export type { SurveyQuestion as SurveyQ } from '../../../shared/contracts';
export type { DeliverableSection as Section } from '../../../shared/contracts';
export type { ChatReply as ChatReplyT } from '../../../shared/contracts';

// token 助手（兼容旧导出名）
export { getToken as getUserId, setToken as setUserId, clearToken as clearUserId } from './token';
export { BASE_URL };

async function request<T>(path: string, method: keyof typeof Taro.request | any = 'GET', data?: object): Promise<T> {
  const res = await Taro.request({
    url: `${BASE_URL}${path}`,
    method: method as any,
    data,
    header: { 'Content-Type': 'application/json', 'x-user-id': getToken() },
  });
  if (res.statusCode === 401) {
    clearToken(); // token 失效：清掉，下次进首页回到登录
    throw Object.assign(new Error((res.data as any)?.error || '未登录'), { code: 'UNAUTHORIZED', data: res.data });
  }
  if (res.statusCode >= 400) {
    throw Object.assign(new Error((res.data as any)?.error || `HTTP ${res.statusCode}`), { data: res.data });
  }
  return res.data as T;
}

// —— API：mock 模式走本地数据源，server 模式连真实后端，口径完全一致 ——
export const api = {
  login: (phone: string, name?: string) =>
    IS_MOCK ? mock.login(phone, name) : request<LoginResult>('/auth/login', 'POST', { phone, name }),
  me: () => (IS_MOCK ? mock.me() : request<Me>('/me')),
  setColor: (color: string) =>
    IS_MOCK ? mock.setColor(color) : request<{ ok: boolean }>('/me/color', 'PUT', { color }),
  agents: () => (IS_MOCK ? mock.agents() : request<Agent[]>('/agents')),
  survey: () => (IS_MOCK ? mock.survey() : request<SurveyQuestion[]>('/survey')),
  getProfile: () => (IS_MOCK ? mock.getProfile() : request<Profile | null>('/profile')),
  saveProfile: (p: Profile) => (IS_MOCK ? mock.saveProfile(p) : request<Profile>('/profile', 'PUT', p)),
  todaySaying: () => (IS_MOCK ? mock.todaySaying() : request<TodaySaying>('/sayings/today')),
  sessions: () => (IS_MOCK ? mock.sessions() : request<SessionItem[]>('/sessions')),
  session: (id: string) => (IS_MOCK ? mock.session(id) : request<SessionDetail>(`/sessions/${id}`)),
  deleteSession: (id: string) =>
    IS_MOCK ? mock.deleteSession(id) : request(`/sessions/${id}`, 'DELETE'),
  generate: (body: GenRequest) =>
    IS_MOCK ? mock.generate(body) : request<GenResult>('/generate-sync', 'POST', body),
  library: () => (IS_MOCK ? mock.library() : request<LibItem[]>('/library')),
  saveToLibrary: (body: SaveLibRequest) =>
    IS_MOCK ? mock.saveToLibrary(body) : request<{ id: string; at: string }>('/library', 'POST', body),
};
