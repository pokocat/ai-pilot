import Taro from '@tarojs/taro';
import { IS_MOCK, BASE_URL } from './config';
import { getToken, setToken, clearToken } from './token';
import { mock } from './mock';
import type {
  Me, Agent, SurveyQuestion, SessionItem, SessionDetail,
  GenResult, GenRequest, LibItem, LoginResult, Profile, TodaySaying, SaveLibRequest,
  ProjectItem, ProjectDetail, CreateProjectRequest, UpdateProjectRequest,
  ReportItem, ReportDetail, ReportVersionContent, ReportDiff, SaveReportRequest, SaveReportResult,
  KnowledgeItemT, KnowledgeHit, CreateKnowledgeRequest, SummarizeResult, MessageRef, MemoryCandidate,
  KnowledgeDocRow, KnowledgeDetail,
  Plan, PlanPurchaseResult, AgentPurchaseResult, AliasSuggestionResult, MyCreditsView, SmsSendResult,
  BindPhoneResult, WechatOrderResult,
} from '../../../shared/contracts';

// 数据模型统一来自 SSOT（shared/contracts）。下面按旧名再导出，保证调用方零改动。
export type {
  Me, Agent, SessionItem, SessionDetail, Deliverable, GenResult, LibItem, LoginResult, Profile,
} from '../../../shared/contracts';
export type { SurveyQuestion as SurveyQ } from '../../../shared/contracts';
export type { DeliverableSection as Section } from '../../../shared/contracts';
export type { ChatReply as ChatReplyT } from '../../../shared/contracts';
export type { MemoryCandidate } from '../../../shared/contracts';
// 新能力类型再导出（项目 / 报告 / 知识 / 引用）
export type {
  ProjectItem, ProjectDetail, CreateProjectRequest, UpdateProjectRequest,
  ReportItem, ReportDetail, ReportVersionItem, ReportVersionContent, ReportDiff, SectionDiff,
  KnowledgeItemT, KnowledgeHit, SummarizeResult, MessageRef, RefKind,
  KnowledgeDocRow, KnowledgeDetail, KnowledgeChunkRow,
  Plan, PlanPurchaseResult, AgentPurchaseResult, AgentBilling,
  ClientUnderstanding, ClientUnderstandingSection, UnderstandingMaturity, AliasSuggestionResult,
  TokenQuotaView, MyCreditItem, MyCreditsView,
} from '../../../shared/contracts';

// token 助手（兼容旧导出名）
export { getToken as getUserId, setToken as setUserId, clearToken as clearUserId } from './token';
export { BASE_URL };

// 八字采集入参 / 命盘摘要（服务端 ChartView 的宽松视图，前端只读展示）
export interface BaziBody {
  calendar?: 'solar' | 'lunar';
  year?: number; month?: number; day?: number;
  hour?: number | null; minute?: number;
  gender?: 'male' | 'female';
  birthPlace?: string; longitude?: number;
  believe?: boolean;
}
export interface ProgressView {
  rank: string;
  usageDays: number;
  streak: number;
  decisionAccuracy: number | null;
  prophecyHitRate: number | null;
  milestones: Record<string, string>;
  nextRank: { rank: string; requirement: string } | null;
}

export interface ChartSummary {
  engineVersion: string;
  hourKnown: boolean;
  pillars: { year: { ganZhi: string }; month: { ganZhi: string }; day: { ganZhi: string }; time: { ganZhi: string } | null };
  dayMaster: { gan: string; element: string; strength: string };
  pattern: { name: string; traits: string; suits: string[]; avoid: string[] };
  ziwei: { soulMajorStars: string[]; bodyMajorStars: string[] } | null;
  monthlyOutlook: { year: number; months: { month: number; phase: string; turning: boolean }[] };
}

type NetworkReason = 'timeout' | 'offline' | 'domain' | 'ssl' | 'dns' | 'unreachable' | 'cancelled' | 'network';

function networkErrorInfo(errMsg: string, origin: string): { reason: NetworkReason; message: string; technicalMessage: string } {
  const msg = errMsg.toLowerCase();
  if (/timeout|timed out|超时/.test(msg)) {
    return {
      reason: 'timeout',
      message: '军师响应超时了，请稍后重试。',
      technicalMessage: `请求超时：${errMsg || 'Taro.request timeout'}。API：${origin}`,
    };
  }
  if (/abort|cancel|canceled|cancelled|取消/.test(msg)) {
    return {
      reason: 'cancelled',
      message: '请求已取消。',
      technicalMessage: `请求被取消：${errMsg || 'request aborted'}。API：${origin}`,
    };
  }
  if (/domain|合法域名|url not in domain|not in domain list/.test(msg)) {
    return {
      reason: 'domain',
      message: '服务连接配置还没生效，请稍后再试。',
      technicalMessage: `小程序请求被合法域名拦截，请在微信后台 request 合法域名配置 ${origin} 后重新打开小程序。原始错误：${errMsg}`,
    };
  }
  if (/ssl|certificate|cert|handshake|证书/.test(msg)) {
    return {
      reason: 'ssl',
      message: '服务安全连接异常，请稍后再试。',
      technicalMessage: `HTTPS/证书连接失败：${errMsg || 'SSL error'}。API：${origin}`,
    };
  }
  if (/dns|name not resolved|resolve host|unknown host|域名解析/.test(msg)) {
    return {
      reason: 'dns',
      message: '暂时解析不到军师服务，请稍后重试。',
      technicalMessage: `DNS/域名解析失败：${errMsg || 'DNS error'}。API：${origin}`,
    };
  }
  if (/offline|internet disconnected|network unavailable|fail -2|断网|无网络/.test(msg)) {
    return {
      reason: 'offline',
      message: '当前网络不可用，请检查网络后重试。',
      technicalMessage: `设备网络不可用：${errMsg || 'offline'}。API：${origin}`,
    };
  }
  if (/connection refused|connection reset|econnreset|econnrefused|failed to connect|无法连接/.test(msg)) {
    return {
      reason: 'unreachable',
      message: '暂时连不上军师服务，请稍后重试。',
      technicalMessage: `服务不可达：${errMsg || 'connection failed'}。API：${origin}`,
    };
  }
  return {
    reason: 'network',
    message: '当前网络有点不稳，请稍后重试。',
    technicalMessage: `网络请求失败：${errMsg || 'unknown request failure'}。API：${origin}`,
  };
}

function httpErrorInfo(statusCode: number, data: unknown): { message: string; code?: string } {
  const body = (data || {}) as { error?: string; code?: string };
  if (statusCode === 408 || statusCode === 504) return { message: '军师响应超时了，请稍后重试。', code: body.code };
  if (statusCode === 429) return { message: '请求有点频繁，请稍后再试。', code: body.code };
  if (statusCode >= 500) return { message: body.error || '军师服务暂时不可用，请稍后重试。', code: body.code };
  return { message: body.error || `HTTP ${statusCode}`, code: body.code };
}

// 导出给领域服务复用（如 services/dossier 案卷闭环）；页面代码仍应走 api.* 方法。
export async function request<T>(path: string, method: keyof typeof Taro.request | any = 'GET', data?: object): Promise<T> {
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
    const info = networkErrorInfo(errMsg, origin);
    throw Object.assign(new Error(info.message), { code: 'NETWORK_ERROR', reason: info.reason, errMsg, url, origin, technicalMessage: info.technicalMessage });
  }
  if (res.statusCode === 401) {
    clearToken(); // token 失效：清掉，下次进首页回到登录
    throw Object.assign(new Error((res.data as any)?.error || '未登录'), { code: 'UNAUTHORIZED', data: res.data });
  }
  if (res.statusCode >= 400) {
    const info = httpErrorInfo(res.statusCode, res.data);
    throw Object.assign(new Error(info.message), { code: info.code, statusCode: res.statusCode, data: res.data });
  }
  return res.data as T;
}

// 文档上传：Taro.uploadFile 走 multipart（request() 只发 JSON，文件需单独上传）。仅 weapp 有文件可选。
async function uploadKnowledgeFile(filePath: string, projectId?: string): Promise<{ id: string; status: string }> {
  const url = `${BASE_URL}/knowledge/upload${projectId ? `?projectId=${projectId}` : ''}`;
  const res = await Taro.uploadFile({ url, filePath, name: 'file', header: { 'x-user-id': getToken() } });
  if (res.statusCode === 401) { clearToken(); throw Object.assign(new Error('未登录'), { code: 'UNAUTHORIZED' }); }
  if (res.statusCode >= 400) {
    let msg = `HTTP ${res.statusCode}`;
    try { msg = (JSON.parse(res.data) as { error?: string }).error || msg; } catch { /* 非 JSON 响应 */ }
    throw new Error(msg);
  }
  try { return JSON.parse(res.data) as { id: string; status: string }; } catch { return { id: '', status: 'parsing' }; }
}

// 头像上传：multipart 单文件 → 后端存 OSS → 落库 user.avatarUrl，返回公网链接。
async function uploadAvatarFile(filePath: string): Promise<{ ok: boolean; avatarUrl: string }> {
  const res = await Taro.uploadFile({ url: `${BASE_URL}/me/avatar`, filePath, name: 'file', header: { 'x-user-id': getToken() } });
  if (res.statusCode === 401) { clearToken(); throw Object.assign(new Error('未登录'), { code: 'UNAUTHORIZED' }); }
  if (res.statusCode >= 400) {
    let msg = `HTTP ${res.statusCode}`; let code: string | undefined;
    try { const j = JSON.parse(res.data) as { error?: string; code?: string }; msg = j.error || msg; code = j.code; } catch { /* 非 JSON */ }
    throw Object.assign(new Error(msg), { code });
  }
  return JSON.parse(res.data) as { ok: boolean; avatarUrl: string };
}

// —— API：mock 模式走本地数据源，server 模式连真实后端，口径完全一致 ——
export const api = {
  suggestAlias: () =>
    IS_MOCK ? mock.suggestAlias() : request<AliasSuggestionResult>('/auth/suggest-name'),
  sendSmsCode: (phone: string, scene?: 'login' | 'bind') =>
    IS_MOCK ? mock.sendSmsCode(phone, scene) : request<SmsSendResult>('/auth/sms/send', 'POST', { phone, scene }),
  login: (phone: string, name?: string, code?: string) =>
    IS_MOCK ? mock.login(phone, name, code) : request<LoginResult>('/auth/login', 'POST', { phone, name, code }),
  wechatLogin: (code: string, nickname?: string, avatarUrl?: string) =>
    IS_MOCK ? mock.wechatLogin(code, nickname, avatarUrl) : request<LoginResult>('/auth/wechat-login', 'POST', { code, nickname, avatarUrl }),
  // 绑定手机号（微信登录后强制）：需登录态。①微信一键 phoneCode；②短信 phone+code 兜底。
  bindPhone: (phone: string, code: string) =>
    IS_MOCK ? mock.bindPhone(phone, code) : request<BindPhoneResult>('/auth/bind-phone', 'POST', { phone, code }),
  bindPhoneByWechat: (phoneCode: string) =>
    IS_MOCK ? mock.bindPhone(undefined, undefined, phoneCode) : request<BindPhoneResult>('/auth/bind-phone', 'POST', { phoneCode }),
  // 本机号一键登录：phoneCode=getPhoneNumber 的 code，loginCode=wx.login 的 code（用于关联 openid）。
  wechatPhoneLogin: (phoneCode: string, loginCode?: string, name?: string) =>
    IS_MOCK ? mock.wechatPhoneLogin(phoneCode, name) : request<LoginResult>('/auth/wechat-phone', 'POST', { phoneCode, loginCode, name }),
  me: () => (IS_MOCK ? mock.me() : request<Me>('/me')),
  myCredits: () => (IS_MOCK ? mock.myCredits() : request<MyCreditsView>('/me/credits')),
  plans: () => (IS_MOCK ? mock.plans() : request<Plan[]>('/plans')),
  purchasePlan: (id: string) =>
    IS_MOCK ? mock.purchasePlan(id) : request<PlanPurchaseResult>(`/plans/${id}/purchase`, 'POST', {}),
  // 微信支付下单（小程序 JSAPI）：返回 wx.requestPayment 调起参数 + 月→年折算明细。
  createOrder: (id: string, openid?: string) =>
    IS_MOCK ? mock.createOrder(id) : request<WechatOrderResult>(`/plans/${id}/order`, 'POST', openid ? { openid } : {}),
  setColor: (color: string) =>
    IS_MOCK ? mock.setColor(color) : request<{ ok: boolean }>('/me/color', 'PUT', { color }),
  updateIdentity: (body: { name?: string; company?: string; avatarUrl?: string }) =>
    IS_MOCK ? mock.updateIdentity(body) : request<{ ok: boolean; name?: string; company?: string; avatarUrl?: string }>('/me', 'PUT', body),
  uploadAvatar: (filePath: string) =>
    IS_MOCK ? mock.uploadAvatar(filePath) : uploadAvatarFile(filePath),
  deleteAccount: () =>
    IS_MOCK ? mock.deleteAccount() : request<{ ok: boolean }>('/me', 'DELETE'),
  agents: () => (IS_MOCK ? mock.agents() : request<Agent[]>('/agents')),
  purchaseAgent: (key: string) =>
    IS_MOCK ? mock.purchaseAgent(key) : request<AgentPurchaseResult>(`/agents/${key}/purchase`, 'POST', {}),
  survey: () => (IS_MOCK ? mock.survey() : request<SurveyQuestion[]>('/survey')),
  getProfile: () => (IS_MOCK ? mock.getProfile() : request<Profile | null>('/profile')),
  saveProfile: (p: Profile) => (IS_MOCK ? mock.saveProfile(p) : request<Profile>('/profile', 'PUT', p)),
  // 八字采集（M1 PR-2）：录入生辰 → 服务端排盘引擎落库；believe=false 表示不用命理视角
  saveBazi: (body: BaziBody) =>
    IS_MOCK ? mock.saveBazi(body) : request<{ believe: boolean; chart: ChartSummary | null }>('/profile/bazi', 'PUT', body),
  myChart: () =>
    IS_MOCK ? mock.myChart() : request<{ bazi: BaziBody | null; chart: ChartSummary | null }>('/profile/chart'),
  // 用户进度（段位/里程碑）与复盘账本（M4 PR-18 前端落位；mock 无账本返回空 → 界面隐藏对应区块）
  progress: () =>
    IS_MOCK ? Promise.resolve({ progress: null as ProgressView | null }) : request<{ progress: ProgressView | null }>('/progress'),
  reviews: () =>
    IS_MOCK ? Promise.resolve({ items: [], streak: 0 }) : request<{ items: unknown[]; streak: number }>('/reviews'),
  // B 级卡片（每日战报/天时日历/天命速写）：返回可分享网页链接；mock 无渲染管道返回 null
  publishCard: (kind: 'daily' | 'calendar' | 'fate', body?: { friendName?: string; friendBazi?: BaziBody }) =>
    IS_MOCK ? Promise.resolve({ htmlUrl: null as string | null }) : request<{ htmlUrl: string | null }>(`/cards/${kind}`, 'POST', body ?? {}),
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
  // —— 长期记忆（@引用候选 P1-C3 + 记忆中心 P1-C2）——
  memories: (agentKey?: string, q?: string) =>
    IS_MOCK ? mock.memories()
      : request<MemoryCandidate[]>(`/memories${agentKey || q ? `?${agentKey ? `agentKey=${agentKey}` : ''}${agentKey && q ? '&' : ''}${q ? `q=${encodeURIComponent(q)}` : ''}` : ''}`),
  deleteMemory: (id: string) =>
    IS_MOCK ? mock.deleteMemory() : request<{ ok: boolean }>(`/memories/${id}`, 'DELETE'),
  updateMemory: (id: string, text: string) =>
    IS_MOCK ? mock.deleteMemory() : request<{ ok: boolean }>(`/memories/${id}`, 'PATCH', { text }),
  // —— 我的资料库（文档视图 + 上传） ——
  knowledgeDocs: (projectId?: string) =>
    IS_MOCK ? Promise.resolve([] as KnowledgeDocRow[]) : request<KnowledgeDocRow[]>(`/knowledge/docs${projectId ? `?projectId=${projectId}` : ''}`),
  knowledgeDetail: (id: string) =>
    IS_MOCK ? Promise.reject(new Error('mock 模式无文档详情')) : request<KnowledgeDetail>(`/knowledge/${id}`),
  reembedKnowledge: (id: string) =>
    IS_MOCK ? Promise.resolve({ chunks: 0 }) : request<{ chunks: number }>(`/knowledge/${id}/reembed`, 'POST', {}),
  uploadKnowledge: (filePath: string, projectId?: string) =>
    IS_MOCK ? Promise.resolve({ id: 'mock', status: 'ready' }) : uploadKnowledgeFile(filePath, projectId),

  // —— 对话汇总（→ 版本化报告 + 知识库） ——
  summarize: (sessionId: string) =>
    IS_MOCK ? mock.summarize(sessionId) : request<SummarizeResult>(`/sessions/${sessionId}/summarize`, 'POST', {}),

  // —— 报告网页版（render_report → OSS 托管）：产出后按需生成可分享链接 ——
  renderReport: (sessionId: string, messageId: string): Promise<{ htmlUrl?: string }> =>
    IS_MOCK ? Promise.resolve({}) : request<{ htmlUrl?: string }>(`/sessions/${sessionId}/messages/${messageId}/report`, 'POST'),
};

export type { GenRequest, SaveLibRequest, MessageRef as Ref };
