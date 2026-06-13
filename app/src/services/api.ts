import Taro from '@tarojs/taro';
import { IS_MOCK, BASE_URL } from './config';
import { getToken, setToken, clearToken } from './token';
import { mock } from './mock';
import type {
  Me, Agent, SurveyQuestion, SessionItem, SessionDetail,
  GenResult, GenRequest, LibItem, LoginResult, Profile, TodaySaying, SaveLibRequest,
  ProjectItem, ProjectDetail, CreateProjectRequest, UpdateProjectRequest,
  ReportItem, ReportDetail, ReportVersionContent, ReportDiff, SaveReportRequest, SaveReportResult,
  KnowledgeItemT, KnowledgeHit, CreateKnowledgeRequest, SummarizeResult, MessageRef,
  Plan, PlanPurchaseResult, AgentPurchaseResult, AliasSuggestionResult,
} from '../../../shared/contracts';

// 数据模型统一来自 SSOT（shared/contracts）。下面按旧名再导出，保证调用方零改动。
export type {
  Me, Agent, SessionItem, SessionDetail, Deliverable, GenResult, LibItem, LoginResult, Profile,
} from '../../../shared/contracts';
export type { SurveyQuestion as SurveyQ } from '../../../shared/contracts';
export type { DeliverableSection as Section } from '../../../shared/contracts';
export type { ChatReply as ChatReplyT } from '../../../shared/contracts';
// 新能力类型再导出（项目 / 报告 / 知识 / 引用）
export type {
  ProjectItem, ProjectDetail, CreateProjectRequest, UpdateProjectRequest,
  ReportItem, ReportDetail, ReportVersionItem, ReportVersionContent, ReportDiff, SectionDiff,
  KnowledgeItemT, KnowledgeHit, SummarizeResult, MessageRef, RefKind,
  Plan, PlanPurchaseResult, AgentPurchaseResult, AgentBilling,
  ClientUnderstanding, ClientUnderstandingSection, UnderstandingMaturity, AliasSuggestionResult,
} from '../../../shared/contracts';

// token 助手（兼容旧导出名）
export { getToken as getUserId, setToken as setUserId, clearToken as clearUserId } from './token';
export { BASE_URL };

async function request<T>(path: string, method: keyof typeof Taro.request | any = 'GET', data?: object): Promise<T> {
  const url = `${BASE_URL}${path}`;
  let res: Taro.request.SuccessCallbackResult;
  try {
    res = await Taro.request({
      url,
      method: method as any,
      data,
      header: { 'Content-Type': 'application/json', 'x-user-id': getToken() },
    });
  } catch (e) {
    const errMsg = String((e as any)?.errMsg || (e as any)?.message || '');
    const origin = BASE_URL.replace(/\/api\/?$/, '').replace(/\/$/, '');
    const message = errMsg.includes('domain') || errMsg.includes('合法域名')
      ? `小程序请求被合法域名拦截，请在微信后台 request 合法域名配置 ${origin} 后重新打开小程序。`
      : `网络请求失败，请确认已配置 request 合法域名 ${origin}，并重新打开小程序。`;
    throw Object.assign(new Error(message), { code: 'NETWORK_ERROR', errMsg, url });
  }
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
  suggestAlias: () =>
    IS_MOCK ? mock.suggestAlias() : request<AliasSuggestionResult>('/auth/suggest-name'),
  login: (phone: string, name?: string) =>
    IS_MOCK ? mock.login(phone, name) : request<LoginResult>('/auth/login', 'POST', { phone, name }),
  wechatLogin: (code: string, nickname?: string) =>
    IS_MOCK ? mock.wechatLogin(code, nickname) : request<LoginResult>('/auth/wechat-login', 'POST', { code, nickname }),
  me: () => (IS_MOCK ? mock.me() : request<Me>('/me')),
  plans: () => (IS_MOCK ? mock.plans() : request<Plan[]>('/plans')),
  purchasePlan: (id: string) =>
    IS_MOCK ? mock.purchasePlan(id) : request<PlanPurchaseResult>(`/plans/${id}/purchase`, 'POST', {}),
  setColor: (color: string) =>
    IS_MOCK ? mock.setColor(color) : request<{ ok: boolean }>('/me/color', 'PUT', { color }),
  updateIdentity: (body: { name?: string; company?: string }) =>
    IS_MOCK ? mock.updateIdentity(body) : request<{ ok: boolean; name?: string; company?: string }>('/me', 'PUT', body),
  deleteAccount: () =>
    IS_MOCK ? mock.deleteAccount() : request<{ ok: boolean }>('/me', 'DELETE'),
  agents: () => (IS_MOCK ? mock.agents() : request<Agent[]>('/agents')),
  purchaseAgent: (key: string) =>
    IS_MOCK ? mock.purchaseAgent(key) : request<AgentPurchaseResult>(`/agents/${key}/purchase`, 'POST', {}),
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
    IS_MOCK ? mock.saveToLibrary(body) : request<{ id: string; at: string; reportId?: string; version?: number }>('/library', 'POST', body),

  // —— 项目（企业事务主线） ——
  projects: () => (IS_MOCK ? mock.projects() : request<ProjectItem[]>('/projects')),
  project: (id: string) => (IS_MOCK ? mock.project(id) : request<ProjectDetail>(`/projects/${id}`)),
  createProject: (body: CreateProjectRequest) =>
    IS_MOCK ? mock.createProject(body) : request<{ id: string; name: string; slug: string }>('/projects', 'POST', body),
  updateProject: (id: string, body: UpdateProjectRequest) =>
    IS_MOCK ? mock.updateProject(id, body) : request<{ ok: boolean }>(`/projects/${id}`, 'PUT', body),
  deleteProject: (id: string) =>
    IS_MOCK ? mock.deleteProject(id) : request<{ ok: boolean }>(`/projects/${id}`, 'DELETE'),

  // —— 版本化报告 ——
  reports: (projectId?: string) =>
    IS_MOCK ? mock.reports(projectId) : request<ReportItem[]>(`/reports${projectId ? `?projectId=${projectId}` : ''}`),
  report: (id: string) => (IS_MOCK ? mock.report(id) : request<ReportDetail>(`/reports/${id}`)),
  reportVersion: (id: string, v?: number) =>
    IS_MOCK ? mock.reportVersion(id, v) : request<ReportVersionContent>(`/reports/${id}/version${v ? `?v=${v}` : ''}`),
  reportDiff: (id: string, from: number, to: number) =>
    IS_MOCK ? mock.reportDiff(id, from, to) : request<ReportDiff>(`/reports/${id}/diff?from=${from}&to=${to}`),
  saveReport: (body: SaveReportRequest) =>
    IS_MOCK ? mock.saveReport(body) : request<SaveReportResult>('/reports', 'POST', body),

  // —— 知识库 ——
  knowledge: (projectId?: string, kind?: string) =>
    IS_MOCK ? mock.knowledge(projectId, kind)
      : request<KnowledgeItemT[]>(`/knowledge${projectId || kind ? `?${projectId ? `projectId=${projectId}` : ''}${projectId && kind ? '&' : ''}${kind ? `kind=${kind}` : ''}` : ''}`),
  knowledgeSearch: (q: string, projectId?: string) =>
    IS_MOCK ? mock.knowledgeSearch(q, projectId)
      : request<KnowledgeHit[]>(`/knowledge/search?q=${encodeURIComponent(q)}${projectId ? `&projectId=${projectId}` : ''}`),
  createKnowledge: (body: CreateKnowledgeRequest) =>
    IS_MOCK ? mock.createKnowledge(body) : request<KnowledgeItemT>('/knowledge', 'POST', body),
  deleteKnowledge: (id: string) =>
    IS_MOCK ? mock.deleteKnowledge(id) : request<{ ok: boolean }>(`/knowledge/${id}`, 'DELETE'),

  // —— 对话汇总（→ 版本化报告 + 知识库） ——
  summarize: (sessionId: string) =>
    IS_MOCK ? mock.summarize(sessionId) : request<SummarizeResult>(`/sessions/${sessionId}/summarize`, 'POST', {}),
};

export type { GenRequest, SaveLibRequest, MessageRef as Ref };
