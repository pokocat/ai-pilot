import { platform, type HttpResponse, type UploadHandle } from './platform';
import { BASE_URL, IMPERSONATION_BASE_URL } from './config';
import { getToken, setToken, clearToken } from './token';
import { getApiBaseUrl, useMockApi } from './runtimeMode';
import { mock } from './mock';
import { shouldInterruptForUnauthorized } from './authGate';
import { httpErrorInfo } from './apiError';
import type {
  Me, Agent, SurveyQuestion, SessionItem, SessionDetail,
  GenResult, GenRequest, LibItem, LoginResult, Profile, TodaySaying, SaveLibRequest,
  ProjectItem, ProjectDetail, CreateProjectRequest, UpdateProjectRequest,
  ReportItem, ReportDetail, ReportVersionContent, ReportDiff, SaveReportRequest, SaveReportResult,
  KnowledgeItemT, KnowledgeHit, CreateKnowledgeRequest, SummarizeResult, MessageRef, MemoryCandidate,
  KnowledgeDocRow, KnowledgeDetail, AnalyzeResult,
  Plan, PlanOptionsResult, PlanQuote, PlanPurchaseResult, AgentPurchaseResult, AliasSuggestionResult, MyCreditsView, SmsSendResult,
  BindPhoneResult, WechatOrderResult, WechatSubscribeTemplatesResult, WechatSubscribeChoice, WechatSubscribeRecordResult,
  FateCardContent, DailyBattleReportView, MemoryLibraryView, DossierView, DossierReport,
  DecisionLedger, DecisionView, DecisionStats, ProphecyLedger, ProphecyView, ProphecyStats,
  QuickScanRequest, QuickScanResult, JourneyView, PrescriptionListView, BrandKitView,
  SkuView, SkuOrderResult, PayOrderStatus, PayOrderListResult, PayRepayResult, PayMockPayResult, BattleForce, BattleCommitResult,
  DataSourcesView, ModulesView, ModuleView, ReminderView, WorkbenchView, SearchResult,
  KnowledgePipelineView, OrganizeResult, ConfirmResult, StagedUploadResult,
  StrategicProfile, ReviewLogItem, ReviewsResult,
  CreativeStatusResult, PosterBriefDraft, CreativeUploadResult, CreativeJobView,
  CreatePosterJobRequest, RevisePosterJobRequest, RegeneratePosterJobRequest,
  CreativePosterListResult,
  GenerationView,
  FactConfirmationRequest, FactConfirmationResult,
  AccountDeletionResult,
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
export type { DailyBattleReportView, DailyBattleOrder } from '../../../shared/contracts';
export type { QuickScanRequest, QuickScanResult } from '../../../shared/contracts';
export type { JourneyView, JourneyStage, JourneyNextStep } from '../../../shared/contracts';
export type { PrescriptionView, PrescriptionListView, DeliverablePrescription } from '../../../shared/contracts';
export type { BrandKitView, BrandKitPersona, BrandKitVoice, BrandKitTheme } from '../../../shared/contracts';
// 海报成品图（canvas_design）：确认页 / 详情页 / 成果卡入口 / 作品库共用的契约类型。
export type {
  PosterBrief, PosterBriefDraft, PosterScene, PosterRatio, PosterTier,
  PosterDirectionKey, PosterDirectionOption, PosterTemplateKey, PosterTemplateOption,
  CreativeStatusResult, CreativeUploadResult, CreativeJobView, CreativeAssetView,
  CreatePosterJobRequest, RevisePosterJobRequest, RegeneratePosterJobRequest,
  CreativePosterListItem, CreativePosterListResult,
} from '../../../shared/contracts';
export type { SkuView, SkuOrderResult, SkuKind, WechatPayParams, PayOrderStatus, PayOrderListItem, PayOrderListResult, PayRepayResult, PayMockPayResult } from '../../../shared/contracts';
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
  Plan, PlanOptionsResult, PlanOption, PlanQuote, PlanRelation, PlanAction, PlanPromotion, PublicUsageView, UsageLevel, UsageStatus,
  PlanPurchaseResult, AgentPurchaseResult, AgentBilling,
  ClientUnderstanding, ClientUnderstandingSection, UnderstandingMaturity, AliasSuggestionResult,
  TokenQuotaView, MyCreditItem, MyCreditsView,
  WechatSubscribeScene, WechatSubscribeStatus, WechatSubscribeTemplate, WechatSubscribeTemplatesResult,
  WechatSubscribeChoice, WechatSubscribeRecordResult,
} from '../../../shared/contracts';

// token 助手（兼容旧导出名）
export { getToken as getUserId, setToken as setUserId, clearToken as clearUserId } from './token';

// 登录态失效的全局回调：request()/上传在「请求发出时带有 token」且收到 401 时触发（由 store 注册）。
// 从未登录的游客访问鉴权接口只收到本地 UNAUTHORIZED，由动作级登录门承接；不能误报「登录态失效」。
// 已有 token 却失效时，即便调用方 .catch 吞掉错误，也一定会走到重新登录流程。
// 见 AGENTS.md「登录态失效必须显式打断」铁律。
let onAuthLost: (() => void) | null = null;
export function setAuthLostHandler(fn: () => void) { onAuthLost = fn; }
export { BASE_URL };

function throwUnauthorized(tokenAtRequest: string, data?: unknown, message = '未登录'): never {
  const hadToken = shouldInterruptForUnauthorized(tokenAtRequest);
  let authHandled = false;
  let staleAuth = false;
  if (hadToken) {
    // 多条并发请求可能一起拿到 401：只让仍对应当前会话的第一条执行全局退出。
    // 后到的旧响应不能重复 reLaunch，更不能清掉用户刚重新登录得到的新 token。
    if (getToken() === tokenAtRequest) {
      clearToken();
      authHandled = true;
      onAuthLost?.();
    } else {
      staleAuth = true;
    }
  }
  throw Object.assign(new Error((data as { error?: string } | undefined)?.error || message), {
    code: 'UNAUTHORIZED',
    data,
    hadToken,
    authHandled,
    staleAuth,
  });
}

/** 给 fetch/downloadFile 等不能走 request() 的旁路复用同一登录失效裁决。 */
export function throwUnauthorizedForRequest(tokenAtRequest: string, data?: unknown, message?: string): never {
  return throwUnauthorized(tokenAtRequest, data, message);
}

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
// 服务端已返回完整 StrategicProfile；前端仍宽松消费，兼容旧数据/旧包时不空屏。
export type StrategicProfileView = Partial<StrategicProfile>;
export type { ReviewLogItem, ReviewsResult };

export interface ProgressView {
  rank: string;
  usageDays: number;
  streak: number;
  decisionAccuracy: number | null;
  prophecyHitRate: number | null;
  milestones: Record<string, string>;
  nextRank: { rank: string; requirement: string } | null;
}

// 海报成品图建单返回。注意：服务端 POST /creative/posters|revise|regenerate 回的是**轻量建单结果**
// （jobId/status/creditCost/reused），不是 CreativeJobView——拿到 jobId 后由详情页再查 GET /creative/jobs/:id。
// SSOT（shared/contracts）里只定义了请求体与 CreativeJobView，这个返回体按 api.ts 既有惯例在前端就地声明。
export interface CreatePosterJobResult {
  jobId: string;
  status: string;
  creditCost: number;
  /** true = 命中幂等键，返回的是既有任务（未重复扣费）。重复点击/断网重试都会走到这里。 */
  reused: boolean;
}
/** 源素材角色（服务端按 role 归类 CreativeAsset，仅用于审计与归属校验）。 */
export type CreativeUploadRole = 'portrait' | 'logo' | 'qr';

// WO-10 经营周报：模板（按行业返回可报指标）/ 周序列（最近 N 周）。字段由行业决定，前端动态渲染。
export interface BizMetricTemplateItem { metricKey: string; metricName: string; unit: string; }
export interface BizMetricWeek { weekStart: string; metrics: Record<string, number>; }

export interface ChartSummary {
  engineVersion: string;
  hourKnown: boolean;
  pillars: { year: { ganZhi: string }; month: { ganZhi: string }; day: { ganZhi: string }; time: { ganZhi: string } | null };
  // strength = 二分（身强/身弱，前端沿用）；strengthLevel = v2 五档；confidence = 置信度（v2 新增，旧命盘可能缺）
  dayMaster: { gan: string; element: string; strength: string; strengthLevel?: string; confidence?: string };
  favorableElements?: string[];                                  // 喜用五行（v2 起随命盘返回）
  tiaoHou?: { gods: string[]; elements: string[] };              // 调候用神（v2 新增）
  pattern: { name: string; traits: string; suits: string[]; avoid: string[]; basis?: string; confidence?: string };
  ziwei: { soulMajorStars: string[]; bodyMajorStars: string[] } | null;
  monthlyOutlook: { year: number; months: { month: number; phase: string; turning: boolean }[] };
}

// —— 命盘报告（八字 × 紫微综合印证）——
// 服务端算法层确定性计算（lunar-typescript + iztro + baziEnrich），零 LLM 参与。
// 本类型与 server 侧 MingpanReport 契约同构（见 docs/[FABLE5]MINGPAN_REPORT_SPEC.md §1.4）；
// 后端未就绪时前端按此契约容错渲染（needBazi / ziwei=null / yinzheng=null 三分支各有 UI）。
export type WuxingKey = '木' | '火' | '土' | '金' | '水';
export type HuaKey = '禄' | '权' | '科' | '忌';
export interface MpPillar {
  ganZhi: string;
  shiShenGan: string;    // 天干十神（日柱为「日主」）
  hideGan: string[];     // 地支藏干
  shiShenZhi: string[];  // 藏干十神
  naYin: string;
}
export interface MpMajorStar { name: string; brightness: string; mutagen: string | null }
export interface MpPalace {
  name: string; stem: string; branch: string;
  isSoul: boolean; isBody: boolean;
  majorStars: MpMajorStar[];
  minorStars: string[];
  adjectiveStars: string[];
  decadal: { start: number; end: number } | null;   // 大限虚岁区间
}
export interface MingpanReport {
  engineVersion: string;               // 当前新盘为 'paipan-v4'；存量快照可为 v1/v2/v3
  base: {
    solarDate: string; lunarDate: string; gender: '男' | '女';
    hourKnown: boolean; hourLabel: string | null;  // 时辰名（如「巳时」「子时（子初换日）」）；缺时辰为 null
    trueSolarApplied: boolean; birthPlace?: string | null;
  };
  bazi: {
    pillars: { year: MpPillar; month: MpPillar; day: MpPillar; time: MpPillar | null };
    dayMaster: {
      gan: string; element: string; strength: string;
      strengthLevel?: string; strengthScore?: number; confidence?: string; basis?: string;
    };
    favorableElements: string[];
    tiaoHou: { gods: string[]; elements: string[] };
    pattern: {
      name: string; monthShiShen?: string;
      traits: string; suits: string[]; avoid: string[];
      basis?: string; confidence?: string;
    };
    daYun: {
      direction: string; startAge: string; approximate: boolean;
      list: { ganZhi: string; startAge: number; startYear: number }[];
    };
    wuxingCount: { counts: Record<WuxingKey, number>; basis: string };
  };
  ziwei: null | {
    fiveElementsClass: string; soulStar: string; bodyStar: string;
    yinYang: string; soulBranch: string; bodyBranch: string;
    palaces: MpPalace[];
  };
  yinzheng: null | {
    baziAxis: { text: string; basis: string };
    ziweiAxis: { text: string; basis: string };
    elementCheck: { favorable: string[]; ju: string; juElement: string; aligned: boolean; note: string };
    timeline: Array<{
      years: string;             // '2008–2017'
      daYun: { ganZhi: string; startAge: string; startYear: number } | null;
      daXian: { palace: string; start: number; end: number } | null;
      isCurrent: boolean;
    }>;
    keyYears: Array<{ year: number; age: number; reason: string; overlap: boolean }>;
    sihua: Array<{ star: string; hua: HuaKey; palace: string }>;
  };
  disclaimer: string;            // 固定文案：仅供文化研究与参考…
}
export type MingpanReportResp = MingpanReport | { needBazi: true };

type NetworkReason = 'timeout' | 'offline' | 'domain' | 'ssl' | 'dns' | 'unreachable' | 'cancelled' | 'network';

function networkErrorInfo(errMsg: string, origin: string): { reason: NetworkReason; message: string; technicalMessage: string } {
  const msg = errMsg.toLowerCase();
  if (/timeout|timed out|超时/.test(msg)) {
    return {
      reason: 'timeout',
      message: '军师响应超时了，请稍后重试。',
      technicalMessage: `请求超时：${errMsg || 'request timeout'}。API：${origin}`,
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

// 导出给领域服务复用（如 services/dossier 案卷闭环）；页面代码仍应走 api.* 方法。
export async function request<T>(path: string, method = 'GET', data?: object): Promise<T> {
  const apiBaseUrl = getApiBaseUrl();
  const url = `${apiBaseUrl}${path}`;
  const tokenAtRequest = getToken();
  let res: HttpResponse;
  try {
    res = await platform.request({
      url,
      method,
      data,
      header: { 'Content-Type': 'application/json', 'x-user-id': tokenAtRequest },
      // 微信默认约 60s；同步生成只是旧环境兜底，必须至少覆盖服务端 150s 对话预算。
      // brief-draft 同样是「等模型」的接口：服务端 structured() 最多跑两轮（首轮 + 纠错轮），
      // 每轮吃满 OPENAI_TIMEOUT_MS(60s) 就是 120s 才回落到确定性预填。端上若按默认 30s 放手，
      // 用户看到的是「军师响应超时」，而服务端其实马上就会给出一份可用草稿。
      ...(path.startsWith('/generate-sync') || path.startsWith('/creative/posters/brief-draft')
        ? { timeout: 180_000 }
        : {}),
    });
  } catch (e) {
    const errMsg = String((e as any)?.errMsg || (e as any)?.message || '');
    const origin = apiBaseUrl.replace(/\/api\/?$/, '').replace(/\/$/, '');
    const info = networkErrorInfo(errMsg, origin);
    throw Object.assign(new Error(info.message), { code: 'NETWORK_ERROR', reason: info.reason, errMsg, url, origin, technicalMessage: info.technicalMessage });
  }
  if (res.statusCode === 401) {
    throwUnauthorized(tokenAtRequest, res.data);
  }
  if (res.statusCode >= 400) {
    const info = httpErrorInfo(res.statusCode, res.data);
    throw Object.assign(new Error(info.message), {
      code: info.code,
      statusCode: res.statusCode,
      data: res.data,
      technicalMessage: info.technicalMessage,
    });
  }
  return res.data as T;
}

// 附身令牌校验专用：用「传入的 token」（而非 storage 里的当前登录态）发只读请求。
// 与 request() 的关键区别：401 只抛错，**绝不** clearToken / 触发 onAuthLost。
// 原因：校验阶段还没落地新身份，若走 request() 的全局登出会误清当前登录态并把用户 reLaunch 回登录页。
// 校验通过后再由调用方 store.afterLogin(token) 正式落地。
async function requestWithToken<T>(path: string, token: string): Promise<T> {
  // 附身 token 是真实后端签发的运维凭证。这里不能跟随普通业务的 mock 数据源，
  // 否则 mock 包会用当前本地账号调用 mock.me()，未登录时必然误报「令牌无效」。
  const url = `${IMPERSONATION_BASE_URL}${path}`;
  let res: HttpResponse;
  try {
    res = await platform.request({
      url,
      method: 'GET',
      header: { 'Content-Type': 'application/json', 'x-user-id': token },
    });
  } catch (e) {
    const errMsg = String((e as any)?.errMsg || (e as any)?.message || '');
    const origin = IMPERSONATION_BASE_URL.replace(/\/api\/?$/, '').replace(/\/$/, '');
    const info = networkErrorInfo(errMsg, origin);
    throw Object.assign(new Error(info.message), { code: 'NETWORK_ERROR', reason: info.reason });
  }
  if (res.statusCode === 401) throw Object.assign(new Error('令牌无效或已失效'), { code: 'UNAUTHORIZED' });
  if (res.statusCode >= 400) {
    const info = httpErrorInfo(res.statusCode, res.data);
    throw Object.assign(new Error(info.message), { code: info.code, statusCode: res.statusCode });
  }
  return res.data as T;
}

// 上传钩子：透出真实进度与 UploadTask（可取消）。既有调用点不传 hooks 即维持原行为。
export interface UploadHooks {
  onProgress?: (percent: number) => void;         // 0–100
  onTask?: (task: UploadHandle) => void;           // 拿到 handle 后可 abort() 真中止
}

/** 上传的文件载体：Web 是 File/Blob，小程序是临时文件路径。 */
export type UploadSource = File | Blob | string;

/** 上传响应体：platform 已尽力解析 JSON，拿到字符串说明不是 JSON（或空体）。 */
function uploadJson<T>(data: unknown, fallback: T): T {
  if (data && typeof data === 'object') return data as T;
  if (typeof data === 'string' && data) {
    try { return JSON.parse(data) as T; } catch { return fallback; }
  }
  return fallback;
}

function uploadResponseError(statusCode: number, raw: unknown, noun = '上传'): Error {
  const data = uploadJson<Record<string, unknown>>(raw, {});
  const info = httpErrorInfo(statusCode, data, noun);
  return Object.assign(new Error(info.message), {
    code: info.code || `HTTP_${statusCode}`,
    statusCode,
    data,
    technicalMessage: info.technicalMessage || (typeof raw === 'string' && raw ? raw : `HTTP ${statusCode}`),
  });
}

// 文档上传：走 multipart（request() 只发 JSON，文件需单独上传）。file：小程序传临时路径，PC/Web 传 File。
// originalName：随上传带上的「原始文件名」——微信 tempFilePath 是 tmp 名，服务端以此字段作展示名（缺省回退兼容）。
async function uploadKnowledgeFile(
  file: UploadSource,
  opts: { projectId?: string; staged?: boolean; batchId?: string; originalName?: string } = {},
  hooks?: UploadHooks,
): Promise<{ id: string; status: string; stage?: string; batchId?: string }> {
  const qs: string[] = [];
  if (opts.projectId) qs.push(`projectId=${opts.projectId}`);
  if (opts.staged) qs.push('staged=true');
  if (opts.batchId) qs.push(`batchId=${opts.batchId}`);
  const url = `${getApiBaseUrl()}/knowledge/upload${qs.length ? `?${qs.join('&')}` : ''}`;
  const tokenAtRequest = getToken();
  const task = platform.upload({
    url,
    file,
    name: 'file',
    formData: opts.originalName ? { originalName: opts.originalName } : undefined,
    header: { 'x-user-id': tokenAtRequest },
  });
  if (hooks?.onProgress) task.onProgress(hooks.onProgress);
  hooks?.onTask?.(task);
  const res = await task.promise;
  if (res.statusCode === 401) throwUnauthorized(tokenAtRequest);
  if (res.statusCode >= 400) throw uploadResponseError(res.statusCode, res.data);
  return uploadJson<{ id: string; status: string }>(res.data, { id: '', status: 'parsing' });
}

// 聊天图片上传：走 multipart → 后端存 OSS 私有 + 建 image 条目，返回 { id }。
// 带真进度与可取消（复用 UploadHooks，与文档上传同款进度条 UI）。仅 weapp 有图可选。
async function uploadChatImageFile(
  file: UploadSource,
  opts: { projectId?: string; originalName?: string } = {},
  hooks?: UploadHooks,
): Promise<{ id: string }> {
  const qs = opts.projectId ? `?projectId=${opts.projectId}` : '';
  const tokenAtRequest = getToken();
  const task = platform.upload({
    url: `${getApiBaseUrl()}/chat/image-upload${qs}`,
    file,
    name: 'file',
    formData: opts.originalName ? { originalName: opts.originalName } : undefined,
    header: { 'x-user-id': tokenAtRequest },
  });
  if (hooks?.onProgress) task.onProgress(hooks.onProgress);
  hooks?.onTask?.(task);
  const res = await task.promise;
  if (res.statusCode === 401) throwUnauthorized(tokenAtRequest);
  if (res.statusCode >= 400) throw uploadResponseError(res.statusCode, res.data);
  return uploadJson<{ id: string }>(res.data, { id: '' });
}

// 海报源素材上传（人像 / Logo / 二维码）：multipart 单文件 → 私有 OSS + CreativeAsset(kind='source')。
// 服务端约束：仅 png/jpg/gif/webp、单张 ≤10MB；越限回 413/415，这里把 error 原样透出（服务端文案已面向用户）。
async function uploadCreativeAssetFile(file: UploadSource, role: CreativeUploadRole): Promise<CreativeUploadResult> {
  const tokenAtRequest = getToken();
  const res = await platform.upload({
    url: `${getApiBaseUrl()}/creative/uploads?role=${role}`,
    file,
    name: 'file',
    header: { 'x-user-id': tokenAtRequest },
  }).promise;
  if (res.statusCode === 401) throwUnauthorized(tokenAtRequest);
  if (res.statusCode >= 400) throw uploadResponseError(res.statusCode, res.data);
  return uploadJson<CreativeUploadResult>(res.data, {} as CreativeUploadResult);
}

// 头像上传：multipart 单文件 → 后端存 OSS → 落库 user.avatarUrl，返回公网链接。
async function uploadAvatarFile(file: UploadSource): Promise<{ ok: boolean; avatarUrl: string }> {
  const tokenAtRequest = getToken();
  const res = await platform.upload({ url: `${getApiBaseUrl()}/me/avatar`, file, name: 'file', header: { 'x-user-id': tokenAtRequest } }).promise;
  if (res.statusCode === 401) throwUnauthorized(tokenAtRequest);
  if (res.statusCode >= 400) throw uploadResponseError(res.statusCode, res.data);
  return uploadJson<{ ok: boolean; avatarUrl: string }>(res.data, { ok: false, avatarUrl: '' });
}

// —— API：mock 模式走本地数据源，server 模式连真实后端，口径完全一致 ——
export const api = {
  suggestAlias: () =>
    useMockApi() ? mock.suggestAlias() : request<AliasSuggestionResult>('/auth/suggest-name'),
  sendSmsCode: (phone: string, scene?: 'login' | 'bind') =>
    useMockApi() ? mock.sendSmsCode(phone, scene) : request<SmsSendResult>('/auth/sms/send', 'POST', { phone, scene }),
  login: (phone: string, name?: string, code?: string) =>
    useMockApi() ? mock.login(phone, name, code) : request<LoginResult>('/auth/login', 'POST', { phone, name, code }),
  wechatLogin: (code: string, nickname?: string, avatarUrl?: string) =>
    useMockApi() ? mock.wechatLogin(code, nickname, avatarUrl) : request<LoginResult>('/auth/wechat-login', 'POST', { code, nickname, avatarUrl }),
  // 绑定手机号（微信登录后强制）：需登录态。①微信一键 phoneCode；②短信 phone+code 兜底。
  bindPhone: (phone: string, code: string) =>
    useMockApi() ? mock.bindPhone(phone, code) : request<BindPhoneResult>('/auth/bind-phone', 'POST', { phone, code }),
  bindPhoneByWechat: (phoneCode: string) =>
    useMockApi() ? mock.bindPhone(undefined, undefined, phoneCode) : request<BindPhoneResult>('/auth/bind-phone', 'POST', { phoneCode }),
  // 本机号一键登录：phoneCode=getPhoneNumber 的 code，loginCode=wx.login 的 code（用于关联 openid）。
  wechatPhoneLogin: (phoneCode: string, loginCode?: string, name?: string) =>
    useMockApi() ? mock.wechatPhoneLogin(phoneCode, name) : request<LoginResult>('/auth/wechat-phone', 'POST', { phoneCode, loginCode, name }),
  me: () => (useMockApi() ? mock.me() : request<Me>('/me')),
  // 附身令牌校验（运营排查）：用传入 token 直连 /me 验证有效性；有效返回目标用户 Me，无效抛错。
  // 全程不落 storage、不触发全局登出——由调用方在校验通过后再 store.afterLogin(token) 正式落地。
  verifyImpersonation: (token: string) =>
    requestWithToken<Me>('/me', token),
  myCredits: () => (useMockApi() ? mock.myCredits() : request<MyCreditsView>('/me/credits')),
  plans: () => (useMockApi() ? mock.plans() : request<Plan[]>('/plans')),
  planOptions: () => (useMockApi() ? mock.planOptions() : request<PlanOptionsResult>('/plans/options')),
  planEvent: (body: { event: import('../../../shared/contracts').PlanFunnelEvent; planId?: string; relation?: string; orderNo?: string; code?: string }) =>
    useMockApi() ? Promise.resolve({ ok: true }) : request<{ ok: true }>('/plans/events', 'POST', body),
  quotePlan: (id: string) => (useMockApi() ? mock.quotePlan(id) : request<PlanQuote>(`/plans/${id}/quote`, 'POST', {})),
  purchasePlan: (id: string) =>
    useMockApi() ? mock.purchasePlan(id) : request<PlanPurchaseResult>(`/plans/${id}/purchase`, 'POST', {}),
  // 微信支付下单（小程序 JSAPI）：返回 wx.requestPayment 调起参数 + 升级折算明细（月→年 / 同周期升档）。
  createOrder: (id: string, opts?: { openid?: string; clientRequestId?: string; quoteFingerprint?: string; expectedChargeAmount?: number }) =>
    useMockApi() ? mock.createOrder(id) : request<WechatOrderResult>(`/plans/${id}/order`, 'POST', opts ?? {}),
  createContractOrder: (id: string, opts: { clientRequestId: string; quoteFingerprint: string; expectedChargeAmount: number }) =>
    request<WechatOrderResult>(`/plans/${id}/contract-order`, 'POST', opts),
  cancelPlanSubscription: (id: string) =>
    request<import('../../../shared/contracts').AutoRenewCancelResult>(`/plans/subscriptions/${id}/cancel`, 'POST', {}),
  // V7-12：单次付费商品（SKU）目录 + 下单。mock 走假支付成功流并本地发放权益。
  skus: () => (useMockApi() ? mock.skus() : request<SkuView[]>('/skus')),
  // D-1 开通来源归因：下单带可选 source（'prescription'|'catalog'|'market'）+ refId（source=prescription 时的处方 id）。
  createSkuOrder: (key: string, openid?: string, attribution?: ActivationAttribution) =>
    useMockApi() ? mock.createSkuOrder(key) : request<SkuOrderResult>(`/skus/${key}/order`, 'POST', { ...(openid ? { openid } : {}), ...attribution }),
  // 支付订单状态（仅本人订单）：requestPayment 成功后轮询，appliedAt 有值 = 权益到账；
  // 服务端在未发放时会先主动查单补账（回调丢失也能自愈）。统一走 services/pay.ts 的 awaitPaymentApplied。
  payOrderStatus: (outTradeNo: string) =>
    useMockApi() ? mock.payOrderStatus(outTradeNo) : request<PayOrderStatus>(`/pay/orders/${outTradeNo}`),
  // 测试期模拟支付（服务端 PAY_MOCK_SUCCESS）：下单返回 mock:true 时代替 wx.requestPayment，
  // 服务端走真实 markPaidAndApply 发放权益；随后仍用 awaitPaymentApplied 轮询确认到账。
  payMock: (outTradeNo: string) =>
    useMockApi() ? mock.payMock(outTradeNo) : request<PayMockPayResult>('/pay/mock/pay', 'POST', { outTradeNo }),
  // 我的支付订单列表（订单明细页）+ 继续支付（对未过时限的待支付单重签调起参数）。
  myOrders: () => (useMockApi() ? mock.myOrders() : request<PayOrderListResult>('/pay/orders')),
  orderPayParams: (outTradeNo: string) =>
    useMockApi() ? mock.orderPayParams(outTradeNo) : request<PayRepayResult>(`/pay/orders/${outTradeNo}/pay-params`, 'POST', {}),
  wechatSubscribeTemplates: () =>
    useMockApi() ? Promise.resolve({ scenes: [] } as WechatSubscribeTemplatesResult) : request<WechatSubscribeTemplatesResult>('/wechat/subscribe/templates'),
  recordWechatSubscription: (choices: WechatSubscribeChoice[]) =>
    useMockApi() ? Promise.resolve({ ok: true, accepted: choices.filter((c) => c.status === 'accept').length } as WechatSubscribeRecordResult)
      : request<WechatSubscribeRecordResult>('/wechat/subscribe', 'POST', { choices }),
  setColor: (color: string) =>
    useMockApi() ? mock.setColor(color) : request<{ ok: boolean }>('/me/color', 'PUT', { color }),
  updateIdentity: (body: { name?: string; company?: string; avatarUrl?: string }) =>
    useMockApi() ? mock.updateIdentity(body) : request<{ ok: boolean; name?: string; company?: string; avatarUrl?: string }>('/me', 'PUT', body),
  uploadAvatar: (file: UploadSource) =>
    useMockApi() ? mock.uploadAvatar(file) : uploadAvatarFile(file),
  deleteAccount: () =>
    useMockApi() ? mock.deleteAccount() : request<AccountDeletionResult>('/me', 'DELETE'),
  agents: () => (useMockApi() ? mock.agents() : request<Agent[]>('/agents')),
  // D-1 开通来源归因：解锁 agent 带可选 source/refId（缺省服务端按 catalog 记）。
  purchaseAgent: (key: string, attribution?: ActivationAttribution) =>
    useMockApi() ? mock.purchaseAgent(key) : request<AgentPurchaseResult>(`/agents/${key}/purchase`, 'POST', { ...attribution }),
  survey: () => (useMockApi() ? mock.survey() : request<SurveyQuestion[]>('/survey')),
  quickScan: (req: QuickScanRequest) =>
    useMockApi() ? mock.quickScan(req) : request<QuickScanResult>('/quickscan', 'POST', req),
  journey: () => (useMockApi() ? mock.journey() : request<JourneyView>('/journey')),
  // V7-04：三势刷新 + 认可判断一键生成军令与报告。
  refreshForces: () => (useMockApi() ? mock.refreshForces() : request<{ forces: BattleForce[] }>('/forces/refresh', 'POST', {})),
  battleCommit: () => (useMockApi() ? mock.battleCommit() : request<BattleCommitResult>('/battle/commit', 'POST', {})),
  prescriptions: () => (useMockApi() ? mock.prescriptions() : request<PrescriptionListView>('/prescriptions')),
  prescriptionAction: (id: string, action: string) =>
    useMockApi() ? mock.prescriptionAction(id, action) : request<{ ok: boolean }>(`/prescriptions/${id}/${action}`, 'POST'),
  brandKit: () => (useMockApi() ? mock.brandKit() : request<BrandKitView | null>('/brand-kit')),
  generateBrandKit: () => (useMockApi() ? mock.generateBrandKit() : request<BrandKitView>('/brand-kit/generate', 'POST')),
  approveBrandKit: () => (useMockApi() ? mock.approveBrandKit() : request<{ ok: boolean }>('/brand-kit/approve', 'POST')),
  getProfile: () => (useMockApi() ? mock.getProfile() : request<Profile | null>('/profile')),
  saveProfile: (p: Profile) => (useMockApi() ? mock.saveProfile(p) : request<Profile>('/profile', 'PUT', p)),
  // 八字采集（M1 PR-2）：录入生辰 → 服务端排盘引擎落库；believe=false 表示不用命理视角。
  // matchedCity：出生地命中的城市名（未命中/未填 = null）——前端据此回执「已按杭州校正」
  // 或「未识别，按北京时间排盘」，不让「填了但没生效」这种事悄悄发生。
  saveBazi: (body: BaziBody) =>
    useMockApi() ? mock.saveBazi(body) : request<{ believe: boolean; chart: ChartSummary | null; matchedCity?: string | null }>('/profile/bazi', 'PUT', body),
  myChart: () =>
    useMockApi() ? mock.myChart() : request<{ bazi: BaziBody | null; chart: ChartSummary | null }>('/profile/chart'),
  // 命盘报告（八字 × 紫微综合印证）：无生辰 → { needBazi:true }；有生辰 → 按需现算 MingpanReport（不落库）
  myChartReport: () =>
    useMockApi() ? mock.myChartReport() : request<MingpanReportResp>('/profile/chart/report'),
  // 战略档案（年度谶语卡）：mock 按「有八字才有谶」镜像真实端两态；真实端出谶在 GET /profile/strategic 内补齐
  strategicProfile: () =>
    useMockApi() ? mock.strategicProfile() : request<{ strategic: StrategicProfileView | null }>('/profile/strategic'),
  // 用户进度（段位/里程碑）与复盘账本（M4 PR-18 前端落位；mock 无账本返回空 → 界面隐藏对应区块）
  progress: () =>
    useMockApi() ? mock.progress() : request<{ progress: ProgressView | null }>('/progress'),
  // 账本闭环（F-8/P-2）：决策账本 / 天机账本 + 用户点命中/未中验证
  decisions: () =>
    useMockApi() ? mock.decisions() : request<DecisionLedger>('/decisions'),
  verifyDecision: (id: string, outcome: 'correct' | 'revise', note?: string) =>
    useMockApi() ? mock.verifyDecision(id, outcome) : request<{ decision: DecisionView; stats: DecisionStats }>(`/decisions/${id}/verify`, 'POST', { outcome, note }),
  prophecies: () =>
    useMockApi() ? mock.prophecies() : request<ProphecyLedger>('/prophecies'),
  verifyProphecy: (id: string, outcome: 'hit' | 'miss', note?: string) =>
    useMockApi() ? mock.verifyProphecy(id, outcome) : request<{ prophecy: ProphecyView; stats: ProphecyStats }>(`/prophecies/${id}/verify`, 'POST', { outcome, note }),
  reviews: () =>
    useMockApi() ? Promise.resolve({ items: [], streak: 0 } as ReviewsResult) : request<ReviewsResult>('/reviews'),
  // 账本异议（WO-11）：对某条决策/预言提交「有出入」→ 复盘时军师与用户对账
  disputeDecision: (id: string, dispute: string) =>
    useMockApi() ? mock.disputeDecision(id, dispute) : request<{ ok: boolean }>(`/decisions/${id}`, 'PATCH', { dispute }),
  disputeProphecy: (id: string, dispute: string) =>
    useMockApi() ? mock.disputeProphecy(id, dispute) : request<{ ok: boolean }>(`/prophecies/${id}`, 'PATCH', { dispute }),
  // WO-10 经营周报：模板（按行业）/ 最近 N 周序列 / 上报某周（weekStart=YYYY-MM-DD 周一，与服务端归一口径一致）
  bizMetricTemplate: () =>
    useMockApi() ? mock.bizMetricTemplate() : request<{ items: BizMetricTemplateItem[] }>('/biz-metrics/template'),
  bizMetricSeries: (weeks = 8) =>
    useMockApi() ? mock.bizMetricSeries(weeks) : request<{ items: BizMetricWeek[] }>(`/biz-metrics?weeks=${weeks}`),
  saveBizMetrics: (weekStart: string, metrics: Record<string, number>) =>
    useMockApi() ? mock.saveBizMetrics(weekStart, metrics) : request<{ ok: boolean }>(`/biz-metrics/${weekStart}`, 'PUT', { metrics }),
  // 每日战报：鉴权内嵌页实时取当前用户账本，不生成 /api/r/:id 公开链接。
  dailyBattleReport: () =>
    useMockApi() ? mock.dailyBattleReport() : request<DailyBattleReportView>('/cards/daily'),
  // 其他公开卡的旧 publishCard 调用已从前端移除；天时日历仍在端上 canvas 出图。
  // 送你一卦「天命速写」预览（合规打磨·P-4）：现算即返、不落库、无公开链接；前端 canvas 画卡导出图片分享
  fateCardPreview: (body: { friendName: string; friendBazi: BaziBody; consent: boolean }) =>
    useMockApi() ? mock.fateCardPreview(body) : request<FateCardContent>('/cards/fate/preview', 'POST', body),
  todaySaying: () => (useMockApi() ? mock.todaySaying() : request<TodaySaying>('/sayings/today')),
  sessions: () => (useMockApi() ? mock.sessions() : request<SessionItem[]>('/sessions')),
  session: (id: string, before?: string | null) => (useMockApi()
    ? mock.session(id, before || undefined)
    : request<SessionDetail>(`/sessions/${id}${before ? `?before=${encodeURIComponent(before)}` : ''}`)),
  deleteSession: (id: string) =>
    useMockApi() ? mock.deleteSession(id) : request(`/sessions/${id}`, 'DELETE'),
  generate: (body: GenRequest) =>
    useMockApi() ? mock.generate(body) : request<GenResult>('/generate-sync', 'POST', body),
  generation: (id: string) => request<GenerationView>(`/generations/${id}`),
  nextDeliveryStage: (id: string) => request<GenResult>(`/generations/${id}/next-stage`, 'POST', {}),
  confirmFact: (id: string, body: FactConfirmationRequest) =>
    request<FactConfirmationResult>(`/facts/${id}/confirm`, 'POST', body),
  cancelGeneration: (id: string) => request<GenerationView>(`/generations/${id}/cancel`, 'POST', {}),
  library: () => (useMockApi() ? mock.library() : request<LibItem[]>('/library')),
  saveToLibrary: (body: SaveLibRequest) =>
    useMockApi() ? mock.saveToLibrary(body) : request<{ id: string; at: string; reportId?: string; version?: number }>('/library', 'POST', body),

  // —— 项目（企业事务主线） ——
  projects: () => (useMockApi() ? mock.projects() : request<ProjectItem[]>('/projects')),
  project: (id: string) => (useMockApi() ? mock.project(id) : request<ProjectDetail>(`/projects/${id}`)),
  createProject: (body: CreateProjectRequest) =>
    useMockApi() ? mock.createProject(body) : request<{ id: string; name: string; slug: string }>('/projects', 'POST', body),
  updateProject: (id: string, body: UpdateProjectRequest) =>
    useMockApi() ? mock.updateProject(id, body) : request<{ ok: boolean }>(`/projects/${id}`, 'PUT', body),
  deleteProject: (id: string) =>
    useMockApi() ? mock.deleteProject(id) : request<{ ok: boolean }>(`/projects/${id}`, 'DELETE'),

  // —— 版本化报告 ——
  reports: (projectId?: string) =>
    useMockApi() ? mock.reports(projectId) : request<ReportItem[]>(`/reports${projectId ? `?projectId=${projectId}` : ''}`),
  report: (id: string) => (useMockApi() ? mock.report(id) : request<ReportDetail>(`/reports/${id}`)),
  reportVersion: (id: string, v?: number) =>
    useMockApi() ? mock.reportVersion(id, v) : request<ReportVersionContent>(`/reports/${id}/version${v ? `?v=${v}` : ''}`),
  reportDiff: (id: string, from: number, to: number) =>
    useMockApi() ? mock.reportDiff(id, from, to) : request<ReportDiff>(`/reports/${id}/diff?from=${from}&to=${to}`),
  saveReport: (body: SaveReportRequest) =>
    useMockApi() ? mock.saveReport(body) : request<SaveReportResult>('/reports', 'POST', body),

  // —— 知识库 ——
  knowledge: (projectId?: string, kind?: string) =>
    useMockApi() ? mock.knowledge(projectId, kind)
      : request<KnowledgeItemT[]>(`/knowledge${projectId || kind ? `?${projectId ? `projectId=${projectId}` : ''}${projectId && kind ? '&' : ''}${kind ? `kind=${kind}` : ''}` : ''}`),
  knowledgeSearch: (q: string, projectId?: string) =>
    useMockApi() ? mock.knowledgeSearch(q, projectId)
      : request<KnowledgeHit[]>(`/knowledge/search?q=${encodeURIComponent(q)}${projectId ? `&projectId=${projectId}` : ''}`),
  createKnowledge: (body: CreateKnowledgeRequest) =>
    useMockApi() ? mock.createKnowledge(body) : request<KnowledgeItemT>('/knowledge', 'POST', body),
  deleteKnowledge: (id: string) =>
    useMockApi() ? mock.deleteKnowledge(id) : request<{ ok: boolean }>(`/knowledge/${id}`, 'DELETE'),
  // —— 长期记忆（@引用候选 P1-C3 + 记忆中心 P1-C2）——
  memories: (agentKey?: string, q?: string) =>
    useMockApi() ? mock.memories()
      : request<MemoryCandidate[]>(`/memories${agentKey || q ? `?${agentKey ? `agentKey=${agentKey}` : ''}${agentKey && q ? '&' : ''}${q ? `q=${encodeURIComponent(q)}` : ''}` : ''}`),
  // 军师记忆库（P2）：主公档案页「军师记事」六类结构化
  memoryLibrary: () =>
    useMockApi() ? mock.memoryLibrary() : request<MemoryLibraryView>('/me/memory-library'),
  // 完整履历（P3）：读缓存 / 生成
  dossier: () =>
    useMockApi() ? mock.dossier() : request<DossierView>('/me/dossier'),
  generateDossier: () =>
    useMockApi() ? mock.generateDossier() : request<{ report: DossierReport; generatedAt: string }>('/me/dossier/generate', 'POST'),
  deleteMemory: (id: string) =>
    useMockApi() ? mock.deleteMemory() : request<{ ok: boolean }>(`/memories/${id}`, 'DELETE'),
  updateMemory: (id: string, text: string) =>
    useMockApi() ? mock.deleteMemory() : request<{ ok: boolean }>(`/memories/${id}`, 'PATCH', { text }),
  // —— 我的资料库（文档视图 + 上传） ——
  knowledgeDocs: (projectId?: string) =>
    useMockApi() ? mock.knowledgeDocs() : request<KnowledgeDocRow[]>(`/knowledge/docs${projectId ? `?projectId=${projectId}` : ''}`),
  knowledgeDetail: (id: string) =>
    useMockApi() ? mock.knowledgeDetail(id) : request<KnowledgeDetail>(`/knowledge/${id}`),
  // WO-09 经营体检：对已解析的财务/经营表发起体检，产出报告（reportId → 报告详情页）。
  analyzeKnowledge: (id: string) =>
    useMockApi() ? mock.analyzeKnowledge(id) : request<AnalyzeResult>(`/knowledge/${id}/analyze`, 'POST', {}),
  reembedKnowledge: (id: string) =>
    useMockApi() ? Promise.resolve({ chunks: 0 }) : request<{ chunks: number }>(`/knowledge/${id}/reembed`, 'POST', {}),
  uploadKnowledge: (file: UploadSource, projectId?: string, staged?: boolean, batchId?: string, originalName?: string, hooks?: UploadHooks) =>
    useMockApi() ? mock.uploadKnowledgeStaged(staged, batchId, originalName) : uploadKnowledgeFile(file, { projectId, staged, batchId, originalName }, hooks),
  // 聊天图片上传（多模态阅图）：存 OSS 私有 + 建 image 条目，返回 { id }。
  uploadChatImage: (file: UploadSource, projectId?: string, originalName?: string, hooks?: UploadHooks) =>
    useMockApi() ? Promise.resolve({ id: `mock-img-${Date.now()}` }) : uploadChatImageFile(file, { projectId, originalName }, hooks),
  // 图片有时限签名预览 URL（复用 knowledge 原件预览端点）：渲染缩略图 / 点开大图用。
  chatImageUrl: (id: string) =>
    useMockApi() ? Promise.resolve({ url: '' }) : request<{ url: string }>(`/knowledge/${id}/preview`),

  // —— V7-06 智库三段式资料整理管道 ——
  knowledgePipeline: () => (useMockApi() ? mock.knowledgePipeline() : request<KnowledgePipelineView>('/knowledge/pipeline')),
  organizeBatch: (batchId: string) =>
    useMockApi() ? mock.organizeBatch(batchId) : request<OrganizeResult>('/knowledge/organize', 'POST', { batchId }),
  confirmKnowledge: (body: { ids?: string[]; batchId?: string }) =>
    useMockApi() ? mock.confirmKnowledge(body) : request<ConfirmResult>('/knowledge/confirm', 'POST', body),
  deepOrganize: (batchId: string) =>
    useMockApi() ? mock.deepOrganize(batchId) : request<OrganizeResult>('/knowledge/deep-organize', 'POST', { batchId }),

  // —— V7-07 数据源状态持久化 ——
  dataSources: () => (useMockApi() ? mock.getDataSources() : request<DataSourcesView>('/data-sources')),
  uploadDataSource: (key: string, knowledgeId?: string) =>
    useMockApi() ? mock.uploadDataSource(key) : request<DataSourcesView>(`/data-sources/${key}/upload`, 'POST', knowledgeId ? { knowledgeId } : {}),
  requestDataSourceAuth: (key: string) =>
    useMockApi() ? mock.requestDataSourceAuth(key) : request<DataSourcesView>(`/data-sources/${key}/request-auth`, 'POST', {}),

  // —— V7-08 能力/模块中心 ——
  modules: () => (useMockApi() ? mock.modules() : request<ModulesView>('/modules')),
  enableModule: (key: string) =>
    useMockApi() ? mock.enableModule(key) : request<{ module: ModuleView }>(`/modules/${key}/enable`, 'POST', {}).then((r) => r.module),
  patchModule: (key: string, body: { hidden?: boolean; sortOrder?: number }) =>
    useMockApi() ? mock.patchModule(key, body) : request<{ module: ModuleView }>(`/modules/${key}`, 'PATCH', body).then((r) => r.module),

  // —— V7-11 提醒日历 ——
  reminders: () => (useMockApi() ? mock.reminders() : request<ReminderView>('/reminders')),

  // —— V7-13 档案工作台 ——
  workbench: () => (useMockApi() ? mock.workbench() : request<WorkbenchView>('/me/workbench')),

  // —— V7-14 跨域搜索 ——
  search: (q: string) => (useMockApi() ? mock.search(q) : request<SearchResult>(`/search?q=${encodeURIComponent(q)}`)),

  // —— 对话汇总（→ 版本化报告 + 知识库） ——
  summarize: (sessionId: string) =>
    useMockApi() ? mock.summarize(sessionId) : request<SummarizeResult>(`/sessions/${sessionId}/summarize`, 'POST', {}),

  // —— 报告网页版（render_report → 自有域名 /api/r/:id）：产出后按需生成可分享链接 ——
  renderReport: (sessionId: string, messageId: string): Promise<{ htmlUrl?: string; cdnUrl?: string }> =>
    useMockApi() ? Promise.resolve({}) : request<{ htmlUrl?: string; cdnUrl?: string }>(`/sessions/${sessionId}/messages/${messageId}/report`, 'POST'),

  // —— 海报成品图（canvas_design）——
  // 能力状态：enabled=false 时前端**整块隐藏**出图入口（不露按钮再让用户点到 403）。缓存见 services/creative.ts。
  creativeStatus: () =>
    useMockApi() ? mock.creativeStatus() : request<CreativeStatusResult>('/creative/status'),
  // 需求单草稿：按设计师成果 + 已确认品牌资产包预填，templateReason 是给用户看的推荐理由。
  posterBriefDraft: (sessionId?: string, messageId?: string) => {
    if (useMockApi()) return mock.posterBriefDraft(sessionId, messageId);
    const qs: string[] = [];
    if (sessionId) qs.push(`sessionId=${encodeURIComponent(sessionId)}`);
    if (messageId) qs.push(`messageId=${encodeURIComponent(messageId)}`);
    return request<PosterBriefDraft>(`/creative/posters/brief-draft${qs.length ? `?${qs.join('&')}` : ''}`);
  },
  uploadCreativeAsset: (file: UploadSource, role: CreativeUploadRole) =>
    useMockApi() ? mock.uploadCreativeAsset(role) : uploadCreativeAssetFile(file, role),
  // 建任务（幂等键按用户唯一 → 重复点击拿回原任务，reused=true 且不重复扣费）。
  createPosterJob: (body: CreatePosterJobRequest) =>
    useMockApi() ? mock.createPosterJob(body) : request<CreatePosterJobResult>('/creative/posters', 'POST', body),
  // 任务详情（轮询这个；签名 URL 每次下发重签，**不要缓存 URL**）。
  creativeJob: (id: string) =>
    useMockApi() ? mock.creativeJob(id) : request<CreativeJobView>(`/creative/jobs/${id}`),
  // 改文案重排：不再扣钻石，产出新任务（parentJobId 指向来源）。
  reviseJob: (id: string, body: RevisePosterJobRequest) =>
    useMockApi() ? mock.reviseJob(id, body) : request<CreatePosterJobResult>(`/creative/jobs/${id}/revise`, 'POST', body),
  // 重出主视觉：再扣一次钻石，产出新任务。
  regenerateJob: (id: string, body: RegeneratePosterJobRequest) =>
    useMockApi() ? mock.regenerateJob(id, body) : request<CreatePosterJobResult>(`/creative/jobs/${id}/regenerate`, 'POST', body),
  cancelJob: (id: string) =>
    useMockApi() ? mock.cancelJob(id) : request<CreativeJobView>(`/creative/jobs/${id}/cancel`, 'POST', {}),
  // 作品库：本人历史成品图（倒序 + 游标分页）。每项的预览链接同样是短签名，**不要缓存**。
  creativePosters: (opts: { cursor?: string; limit?: number } = {}) => {
    if (useMockApi()) return mock.creativePosters(opts);
    const qs: string[] = [];
    if (opts.cursor) qs.push(`cursor=${encodeURIComponent(opts.cursor)}`);
    if (opts.limit) qs.push(`limit=${opts.limit}`);
    return request<CreativePosterListResult>(`/creative/posters${qs.length ? `?${qs.join('&')}` : ''}`);
  },
};

/** 由网页版链接（/api/r/:id）推导同一报告的 PDF 下载地址（/api/r/:id/pdf）。取不到则返回 null。 */
export function reportPdfUrl(htmlUrl?: string | null): string | null {
  if (!htmlUrl) return null;
  const m = htmlUrl.match(/\/api\/r\/([A-Za-z0-9_-]+)(?=$|[?#])/);
  if (!m) return null;
  return htmlUrl.replace(/(\/api\/r\/[A-Za-z0-9_-]+)(?=$|[?#])/, '$1/pdf');
}

export type { GenRequest, SaveLibRequest, MessageRef as Ref };
