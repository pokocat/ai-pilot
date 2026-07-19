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
  KnowledgeDocRow, KnowledgeDetail, AnalyzeResult,
  Plan, PlanPurchaseResult, AgentPurchaseResult, AliasSuggestionResult, MyCreditsView, SmsSendResult,
  BindPhoneResult, WechatOrderResult, WechatSubscribeTemplatesResult, WechatSubscribeChoice, WechatSubscribeRecordResult,
  FateCardContent, MemoryLibraryView, DossierView, DossierReport,
  DecisionLedger, DecisionView, DecisionStats, ProphecyLedger, ProphecyView, ProphecyStats,
  QuickScanRequest, QuickScanResult, JourneyView, PrescriptionListView, BrandKitView,
  SkuView, SkuOrderResult, PayOrderStatus, PayOrderListResult, PayRepayResult, BattleForce, BattleCommitResult,
  DataSourcesView, ModulesView, ModuleView, ReminderView, WorkbenchView, SearchResult,
  KnowledgePipelineView, OrganizeResult, ConfirmResult, StagedUploadResult,
} from '../../../shared/contracts';

// 数据模型统一来自 SSOT（shared/contracts）。下面按旧名再导出，保证调用方零改动。
export type {
  Me, Agent, SessionItem, SessionDetail, Deliverable, GenResult, LibItem, LoginResult, Profile,
} from '../../../shared/contracts';
export type { SurveyQuestion as SurveyQ } from '../../../shared/contracts';
export type { DeliverableSection as Section } from '../../../shared/contracts';
export type { ChatReply as ChatReplyT } from '../../../shared/contracts';
export type { MemoryCandidate, MemoryLibraryView, MemoryLibraryGroup, MemoryLibraryEntry, MemoryCategoryKey, MemoryFillLevel } from '../../../shared/contracts';
export type { DossierView, DossierReport, DossierSection, DossierBlock } from '../../../shared/contracts';
export type { DecisionLedger, DecisionView, DecisionStats, ProphecyLedger, ProphecyView, ProphecyStats } from '../../../shared/contracts';
export type { FateCardContent } from '../../../shared/contracts';
export type { QuickScanRequest, QuickScanResult } from '../../../shared/contracts';
export type { JourneyView, JourneyStage, JourneyNextStep } from '../../../shared/contracts';
export type { PrescriptionView, PrescriptionListView, DeliverablePrescription } from '../../../shared/contracts';
export type { BrandKitView, BrandKitPersona, BrandKitVoice, BrandKitTheme } from '../../../shared/contracts';
export type { SkuView, SkuOrderResult, SkuKind, WechatPayParams, PayOrderStatus, PayOrderListItem, PayOrderListResult, PayRepayResult } from '../../../shared/contracts';
export type {
  BattleForce, BattleCommitResult, ForceKind, ForceLevel, ForceTone,
  DataSourceView, DataSourcesView, DataSourceStatus,
  ModuleView, ModulesView, ModuleTier, ModuleGroup, ModuleDetail, ModulePrice,
  ReminderView, ReminderItem, GoalLadder, OrderActionType, OrderMetric, OrderStructuredFields,
  ServiceAssignmentView, WorkbenchView, WorkbenchSection, WorkbenchMissing,
  SearchHit, SearchResult, KnowledgeStage, KnowledgePipelineView,
  KnowledgePipelineFolder, KnowledgeBatch, KnowledgeBatchFile, OrganizeResult, OrganizeItem, ConfirmResult, StagedUploadResult,
} from '../../../shared/contracts';
// 新能力类型再导出（项目 / 报告 / 知识 / 引用）
export type {
  ProjectItem, ProjectDetail, CreateProjectRequest, UpdateProjectRequest,
  ReportItem, ReportDetail, ReportVersionItem, ReportVersionContent, ReportDiff, SectionDiff,
  KnowledgeItemT, KnowledgeHit, SummarizeResult, MessageRef, RefKind,
  KnowledgeDocRow, KnowledgeDetail, KnowledgeChunkRow, AnalyzeResult,
  Plan, PlanPurchaseResult, AgentPurchaseResult, AgentBilling,
  ClientUnderstanding, ClientUnderstandingSection, UnderstandingMaturity, AliasSuggestionResult,
  TokenQuotaView, MyCreditItem, MyCreditsView,
  WechatSubscribeScene, WechatSubscribeStatus, WechatSubscribeTemplate, WechatSubscribeTemplatesResult,
  WechatSubscribeChoice, WechatSubscribeRecordResult,
} from '../../../shared/contracts';

// token 助手（兼容旧导出名）
export { getToken as getUserId, setToken as setUserId, clearToken as clearUserId } from './token';

// 登录态失效的全局回调：request()/上传 收到 401 时**无条件**触发（由 store 注册）。
// 目的：即便调用方 .catch 吞掉了错误，也一定会走到「重新登录」流程——绝不让用户滞留在失效界面看旧缓存。
// 见 AGENTS.md「登录态失效必须显式打断」铁律。
let onAuthLost: (() => void) | null = null;
export function setAuthLostHandler(fn: () => void) { onAuthLost = fn; }
export { BASE_URL };

// D-1 开通来源归因：随解锁/下单请求带入的位子来源（与 UserAgent.source 正交）。
// source=prescription 时 refId=处方 id；catalog=货架/锦囊直接购买；market=生态市场常规浏览。
export type ActivationSource = 'prescription' | 'catalog' | 'market';
export interface ActivationAttribution { source?: ActivationSource; refId?: string }

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

// WO-10 经营周报：模板（按行业返回可报指标）/ 周序列（最近 N 周）。字段由行业决定，前端动态渲染。
export interface BizMetricTemplateItem { metricKey: string; metricName: string; unit: string; }
export interface BizMetricWeek { weekStart: string; metrics: Record<string, number>; }

export interface ChartSummary {
  engineVersion: string;
  hourKnown: boolean;
  pillars: { year: { ganZhi: string }; month: { ganZhi: string }; day: { ganZhi: string }; time: { ganZhi: string } | null };
  dayMaster: { gan: string; element: string; strength: string };
  pattern: { name: string; traits: string; suits: string[]; avoid: string[] };
  ziwei: { soulMajorStars: string[]; bodyMajorStars: string[] } | null;
  monthlyOutlook: { year: number; months: { month: number; phase: string; turning: boolean }[] };
}

// 微信 wx.request 默认总超时约 60 秒；成果/报告生成服务端允许至少 120 秒完成
// （见 server DELIVERABLE_TIMEOUT_MS），且与 services/streaming.ts 的 WEAPP_STREAM_TIMEOUT_MS、
// deploy/nginx.conf.example 的 proxy_read_timeout 保持一致口径，避免慢模型仍在正常出片时被
// 客户端提前判定为超时。仅用于 /generate-sync 这类可能耗时较久的成果生成请求。
const SYNC_GENERATE_TIMEOUT_MS = 180_000;

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
export async function request<T>(path: string, method: keyof typeof Taro.request | any = 'GET', data?: object, opts?: { timeoutMs?: number }): Promise<T> {
  const url = `${BASE_URL}${path}`;
  let res: Taro.request.SuccessCallbackResult;
  try {
    res = await Taro.request({
      url,
      method: method as any,
      data,
      header: { 'Content-Type': 'application/json', 'x-user-id': getToken() },
      ...(opts?.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
  } catch (e) {
    const errMsg = String((e as any)?.errMsg || (e as any)?.message || '');
    const origin = BASE_URL.replace(/\/api\/?$/, '').replace(/\/$/, '');
    const info = networkErrorInfo(errMsg, origin);
    throw Object.assign(new Error(info.message), { code: 'NETWORK_ERROR', reason: info.reason, errMsg, url, origin, technicalMessage: info.technicalMessage });
  }
  if (res.statusCode === 401) {
    clearToken(); // token 失效：清掉
    onAuthLost?.(); // 无条件打断到重新登录，哪怕调用方吞掉下面这个 error
    throw Object.assign(new Error((res.data as any)?.error || '未登录'), { code: 'UNAUTHORIZED', data: res.data });
  }
  if (res.statusCode >= 400) {
    const info = httpErrorInfo(res.statusCode, res.data);
    throw Object.assign(new Error(info.message), { code: info.code, statusCode: res.statusCode, data: res.data });
  }
  return res.data as T;
}

// 上传钩子：透出真实进度与 UploadTask（可取消）。既有调用点不传 hooks 即维持原行为。
export interface UploadHooks {
  onProgress?: (percent: number) => void;         // 0–100
  onTask?: (task: Taro.UploadTask) => void;        // 拿到 task 后可 task.abort() 真中止
}

// 文档上传：Taro.uploadFile 走 multipart（request() 只发 JSON，文件需单独上传）。仅 weapp 有文件可选。
// originalName：随上传带上的「原始文件名」——微信 tempFilePath 是 tmp 名，服务端以此字段作展示名（缺省回退兼容）。
async function uploadKnowledgeFile(
  filePath: string,
  opts: { projectId?: string; staged?: boolean; batchId?: string; originalName?: string } = {},
  hooks?: UploadHooks,
): Promise<{ id: string; status: string; stage?: string; batchId?: string }> {
  const qs: string[] = [];
  if (opts.projectId) qs.push(`projectId=${opts.projectId}`);
  if (opts.staged) qs.push('staged=true');
  if (opts.batchId) qs.push(`batchId=${opts.batchId}`);
  const url = `${BASE_URL}/knowledge/upload${qs.length ? `?${qs.join('&')}` : ''}`;
  // Taro.uploadFile 返回 UploadTaskPromise：既是 Promise 又带 abort/onProgressUpdate，先拿 task 再 await 结果。
  const task = Taro.uploadFile({
    url,
    filePath,
    name: 'file',
    formData: opts.originalName ? { originalName: opts.originalName } : undefined,
    header: { 'x-user-id': getToken() },
  });
  if (hooks?.onProgress) task.onProgressUpdate?.((e) => hooks.onProgress!(e.progress));
  hooks?.onTask?.(task);
  const res = await task;
  if (res.statusCode === 401) { clearToken(); onAuthLost?.(); throw Object.assign(new Error('未登录'), { code: 'UNAUTHORIZED' }); }
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
  if (res.statusCode === 401) { clearToken(); onAuthLost?.(); throw Object.assign(new Error('未登录'), { code: 'UNAUTHORIZED' }); }
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
  // V7-12：单次付费商品（SKU）目录 + 下单。mock 走假支付成功流并本地发放权益。
  skus: () => (IS_MOCK ? mock.skus() : request<SkuView[]>('/skus')),
  // D-1 开通来源归因：下单带可选 source（'prescription'|'catalog'|'market'）+ refId（source=prescription 时的处方 id）。
  createSkuOrder: (key: string, openid?: string, attribution?: ActivationAttribution) =>
    IS_MOCK ? mock.createSkuOrder(key) : request<SkuOrderResult>(`/skus/${key}/order`, 'POST', { ...(openid ? { openid } : {}), ...attribution }),
  // 支付订单状态（仅本人订单）：requestPayment 成功后轮询，appliedAt 有值 = 权益到账；
  // 服务端在未发放时会先主动查单补账（回调丢失也能自愈）。统一走 services/pay.ts 的 awaitPaymentApplied。
  payOrderStatus: (outTradeNo: string) =>
    IS_MOCK ? mock.payOrderStatus(outTradeNo) : request<PayOrderStatus>(`/pay/orders/${outTradeNo}`),
  // 我的支付订单列表（订单明细页）+ 继续支付（对未过时限的待支付单重签调起参数）。
  myOrders: () => (IS_MOCK ? mock.myOrders() : request<PayOrderListResult>('/pay/orders')),
  orderPayParams: (outTradeNo: string) =>
    IS_MOCK ? mock.orderPayParams(outTradeNo) : request<PayRepayResult>(`/pay/orders/${outTradeNo}/pay-params`, 'POST', {}),
  wechatSubscribeTemplates: () =>
    IS_MOCK ? Promise.resolve({ scenes: [] } as WechatSubscribeTemplatesResult) : request<WechatSubscribeTemplatesResult>('/wechat/subscribe/templates'),
  recordWechatSubscription: (choices: WechatSubscribeChoice[]) =>
    IS_MOCK ? Promise.resolve({ ok: true, accepted: choices.filter((c) => c.status === 'accept').length } as WechatSubscribeRecordResult)
      : request<WechatSubscribeRecordResult>('/wechat/subscribe', 'POST', { choices }),
  setColor: (color: string) =>
    IS_MOCK ? mock.setColor(color) : request<{ ok: boolean }>('/me/color', 'PUT', { color }),
  updateIdentity: (body: { name?: string; company?: string; avatarUrl?: string }) =>
    IS_MOCK ? mock.updateIdentity(body) : request<{ ok: boolean; name?: string; company?: string; avatarUrl?: string }>('/me', 'PUT', body),
  uploadAvatar: (filePath: string) =>
    IS_MOCK ? mock.uploadAvatar(filePath) : uploadAvatarFile(filePath),
  deleteAccount: () =>
    IS_MOCK ? mock.deleteAccount() : request<{ ok: boolean }>('/me', 'DELETE'),
  agents: () => (IS_MOCK ? mock.agents() : request<Agent[]>('/agents')),
  // D-1 开通来源归因：解锁 agent 带可选 source/refId（缺省服务端按 catalog 记）。
  purchaseAgent: (key: string, attribution?: ActivationAttribution) =>
    IS_MOCK ? mock.purchaseAgent(key) : request<AgentPurchaseResult>(`/agents/${key}/purchase`, 'POST', { ...attribution }),
  survey: () => (IS_MOCK ? mock.survey() : request<SurveyQuestion[]>('/survey')),
  quickScan: (req: QuickScanRequest) =>
    IS_MOCK ? mock.quickScan(req) : request<QuickScanResult>('/quickscan', 'POST', req),
  journey: () => (IS_MOCK ? mock.journey() : request<JourneyView>('/journey')),
  // V7-04：三势刷新 + 认可判断一键生成军令与报告。
  refreshForces: () => (IS_MOCK ? mock.refreshForces() : request<{ forces: BattleForce[] }>('/forces/refresh', 'POST', {})),
  battleCommit: () => (IS_MOCK ? mock.battleCommit() : request<BattleCommitResult>('/battle/commit', 'POST', {})),
  prescriptions: () => (IS_MOCK ? mock.prescriptions() : request<PrescriptionListView>('/prescriptions')),
  prescriptionAction: (id: string, action: string) =>
    IS_MOCK ? mock.prescriptionAction(id, action) : request<{ ok: boolean }>(`/prescriptions/${id}/${action}`, 'POST'),
  brandKit: () => (IS_MOCK ? mock.brandKit() : request<BrandKitView | null>('/brand-kit')),
  generateBrandKit: () => (IS_MOCK ? mock.generateBrandKit() : request<BrandKitView>('/brand-kit/generate', 'POST')),
  approveBrandKit: () => (IS_MOCK ? mock.approveBrandKit() : request<{ ok: boolean }>('/brand-kit/approve', 'POST')),
  getProfile: () => (IS_MOCK ? mock.getProfile() : request<Profile | null>('/profile')),
  saveProfile: (p: Profile) => (IS_MOCK ? mock.saveProfile(p) : request<Profile>('/profile', 'PUT', p)),
  // 八字采集（M1 PR-2）：录入生辰 → 服务端排盘引擎落库；believe=false 表示不用命理视角
  saveBazi: (body: BaziBody) =>
    IS_MOCK ? mock.saveBazi(body) : request<{ believe: boolean; chart: ChartSummary | null }>('/profile/bazi', 'PUT', body),
  myChart: () =>
    IS_MOCK ? mock.myChart() : request<{ bazi: BaziBody | null; chart: ChartSummary | null }>('/profile/chart'),
  // 用户进度（段位/里程碑）与复盘账本（M4 PR-18 前端落位；mock 无账本返回空 → 界面隐藏对应区块）
  progress: () =>
    IS_MOCK ? mock.progress() : request<{ progress: ProgressView | null }>('/progress'),
  // 账本闭环（F-8/P-2）：决策账本 / 天机账本 + 用户点命中/未中验证
  decisions: () =>
    IS_MOCK ? mock.decisions() : request<DecisionLedger>('/decisions'),
  verifyDecision: (id: string, outcome: 'correct' | 'revise', note?: string) =>
    IS_MOCK ? mock.verifyDecision(id, outcome) : request<{ decision: DecisionView; stats: DecisionStats }>(`/decisions/${id}/verify`, 'POST', { outcome, note }),
  prophecies: () =>
    IS_MOCK ? mock.prophecies() : request<ProphecyLedger>('/prophecies'),
  verifyProphecy: (id: string, outcome: 'hit' | 'miss', note?: string) =>
    IS_MOCK ? mock.verifyProphecy(id, outcome) : request<{ prophecy: ProphecyView; stats: ProphecyStats }>(`/prophecies/${id}/verify`, 'POST', { outcome, note }),
  reviews: () =>
    IS_MOCK ? Promise.resolve({ items: [], streak: 0 }) : request<{ items: unknown[]; streak: number }>('/reviews'),
  // 账本异议（WO-11）：对某条决策/预言提交「有出入」→ 复盘时军师与用户对账
  disputeDecision: (id: string, dispute: string) =>
    IS_MOCK ? mock.disputeDecision(id, dispute) : request<{ ok: boolean }>(`/decisions/${id}`, 'PATCH', { dispute }),
  disputeProphecy: (id: string, dispute: string) =>
    IS_MOCK ? mock.disputeProphecy(id, dispute) : request<{ ok: boolean }>(`/prophecies/${id}`, 'PATCH', { dispute }),
  // WO-10 经营周报：模板（按行业）/ 最近 N 周序列 / 上报某周（weekStart=YYYY-MM-DD 周一，与服务端归一口径一致）
  bizMetricTemplate: () =>
    IS_MOCK ? mock.bizMetricTemplate() : request<{ items: BizMetricTemplateItem[] }>('/biz-metrics/template'),
  bizMetricSeries: (weeks = 8) =>
    IS_MOCK ? mock.bizMetricSeries(weeks) : request<{ items: BizMetricWeek[] }>(`/biz-metrics?weeks=${weeks}`),
  saveBizMetrics: (weekStart: string, metrics: Record<string, number>) =>
    IS_MOCK ? mock.saveBizMetrics(weekStart, metrics) : request<{ ok: boolean }>(`/biz-metrics/${weekStart}`, 'PUT', { metrics }),
  // B 级卡片（每日战报/天时日历）：返回可分享网页链接；mock 无渲染管道返回 null
  publishCard: (kind: 'daily' | 'calendar', body?: { friendName?: string; friendBazi?: BaziBody }) =>
    IS_MOCK ? Promise.resolve({ htmlUrl: null as string | null }) : request<{ htmlUrl: string | null }>(`/cards/${kind}`, 'POST', body ?? {}),
  // 送你一卦「天命速写」预览（合规打磨·P-4）：现算即返、不落库、无公开链接；前端 canvas 画卡导出图片分享
  fateCardPreview: (body: { friendName: string; friendBazi: BaziBody; consent: boolean }) =>
    IS_MOCK ? mock.fateCardPreview(body) : request<FateCardContent>('/cards/fate/preview', 'POST', body),
  todaySaying: () => (IS_MOCK ? mock.todaySaying() : request<TodaySaying>('/sayings/today')),
  sessions: () => (IS_MOCK ? mock.sessions() : request<SessionItem[]>('/sessions')),
  session: (id: string) => (IS_MOCK ? mock.session(id) : request<SessionDetail>(`/sessions/${id}`)),
  deleteSession: (id: string) =>
    IS_MOCK ? mock.deleteSession(id) : request(`/sessions/${id}`, 'DELETE'),
  generate: (body: GenRequest) =>
    IS_MOCK ? mock.generate(body) : request<GenResult>('/generate-sync', 'POST', body, { timeoutMs: SYNC_GENERATE_TIMEOUT_MS }),
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
  // 军师记忆库（P2）：主公档案页「军师记事」六类结构化
  memoryLibrary: () =>
    IS_MOCK ? mock.memoryLibrary() : request<MemoryLibraryView>('/me/memory-library'),
  // 完整履历（P3）：读缓存 / 生成
  dossier: () =>
    IS_MOCK ? mock.dossier() : request<DossierView>('/me/dossier'),
  generateDossier: () =>
    IS_MOCK ? mock.generateDossier() : request<{ report: DossierReport; generatedAt: string }>('/me/dossier/generate', 'POST'),
  deleteMemory: (id: string) =>
    IS_MOCK ? mock.deleteMemory() : request<{ ok: boolean }>(`/memories/${id}`, 'DELETE'),
  updateMemory: (id: string, text: string) =>
    IS_MOCK ? mock.deleteMemory() : request<{ ok: boolean }>(`/memories/${id}`, 'PATCH', { text }),
  // —— 我的资料库（文档视图 + 上传） ——
  knowledgeDocs: (projectId?: string) =>
    IS_MOCK ? mock.knowledgeDocs() : request<KnowledgeDocRow[]>(`/knowledge/docs${projectId ? `?projectId=${projectId}` : ''}`),
  knowledgeDetail: (id: string) =>
    IS_MOCK ? mock.knowledgeDetail(id) : request<KnowledgeDetail>(`/knowledge/${id}`),
  // WO-09 经营体检：对已解析的财务/经营表发起体检，产出报告（reportId → 报告详情页）。
  analyzeKnowledge: (id: string) =>
    IS_MOCK ? mock.analyzeKnowledge(id) : request<AnalyzeResult>(`/knowledge/${id}/analyze`, 'POST', {}),
  reembedKnowledge: (id: string) =>
    IS_MOCK ? Promise.resolve({ chunks: 0 }) : request<{ chunks: number }>(`/knowledge/${id}/reembed`, 'POST', {}),
  uploadKnowledge: (filePath: string, projectId?: string, staged?: boolean, batchId?: string, originalName?: string, hooks?: UploadHooks) =>
    IS_MOCK ? mock.uploadKnowledgeStaged(staged, batchId, originalName) : uploadKnowledgeFile(filePath, { projectId, staged, batchId, originalName }, hooks),

  // —— V7-06 智库三段式资料整理管道 ——
  knowledgePipeline: () => (IS_MOCK ? mock.knowledgePipeline() : request<KnowledgePipelineView>('/knowledge/pipeline')),
  organizeBatch: (batchId: string) =>
    IS_MOCK ? mock.organizeBatch(batchId) : request<OrganizeResult>('/knowledge/organize', 'POST', { batchId }),
  confirmKnowledge: (body: { ids?: string[]; batchId?: string }) =>
    IS_MOCK ? mock.confirmKnowledge(body) : request<ConfirmResult>('/knowledge/confirm', 'POST', body),
  deepOrganize: (batchId: string) =>
    IS_MOCK ? mock.deepOrganize(batchId) : request<OrganizeResult>('/knowledge/deep-organize', 'POST', { batchId }),

  // —— V7-07 数据源状态持久化 ——
  dataSources: () => (IS_MOCK ? mock.getDataSources() : request<DataSourcesView>('/data-sources')),
  uploadDataSource: (key: string, knowledgeId?: string) =>
    IS_MOCK ? mock.uploadDataSource(key) : request<DataSourcesView>(`/data-sources/${key}/upload`, 'POST', knowledgeId ? { knowledgeId } : {}),
  requestDataSourceAuth: (key: string) =>
    IS_MOCK ? mock.requestDataSourceAuth(key) : request<DataSourcesView>(`/data-sources/${key}/request-auth`, 'POST', {}),

  // —— V7-08 能力/模块中心 ——
  modules: () => (IS_MOCK ? mock.modules() : request<ModulesView>('/modules')),
  enableModule: (key: string) =>
    IS_MOCK ? mock.enableModule(key) : request<{ module: ModuleView }>(`/modules/${key}/enable`, 'POST', {}).then((r) => r.module),
  patchModule: (key: string, body: { hidden?: boolean; sortOrder?: number }) =>
    IS_MOCK ? mock.patchModule(key, body) : request<{ module: ModuleView }>(`/modules/${key}`, 'PATCH', body).then((r) => r.module),

  // —— V7-11 提醒日历 ——
  reminders: () => (IS_MOCK ? mock.reminders() : request<ReminderView>('/reminders')),

  // —— V7-13 档案工作台 ——
  workbench: () => (IS_MOCK ? mock.workbench() : request<WorkbenchView>('/me/workbench')),

  // —— V7-14 跨域搜索 ——
  search: (q: string) => (IS_MOCK ? mock.search(q) : request<SearchResult>(`/search?q=${encodeURIComponent(q)}`)),

  // —— 对话汇总（→ 版本化报告 + 知识库） ——
  summarize: (sessionId: string) =>
    IS_MOCK ? mock.summarize(sessionId) : request<SummarizeResult>(`/sessions/${sessionId}/summarize`, 'POST', {}),

  // —— 报告网页版（render_report → 自有域名 /api/r/:id）：产出后按需生成可分享链接 ——
  renderReport: (sessionId: string, messageId: string): Promise<{ htmlUrl?: string; cdnUrl?: string }> =>
    IS_MOCK ? Promise.resolve({}) : request<{ htmlUrl?: string; cdnUrl?: string }>(`/sessions/${sessionId}/messages/${messageId}/report`, 'POST'),
};

export type { GenRequest, SaveLibRequest, MessageRef as Ref };
