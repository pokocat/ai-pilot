// 军师 · 全栈数据契约（SSOT）
// 前端(app) / 后端(server) / 运营端(admin) 的统一数据口径，唯一事实来源。
// 这是纯类型声明（.d.ts）：编译期类型、运行时擦除，各端只用 `import type` 引用，
// 不引入任何运行时依赖，也不会改变任何一端的打包产物。

/* ────────────── 智能体 ────────────── */
export type AgentType = 'general' | 'advisory' | 'creative' | 'custom';
/** 计费模式：free 免费 | unlock 一次性解锁（算力购买/后台开通） | metered 按次计费 */
export type AgentBilling = 'free' | 'unlock' | 'metered';
export type MemoryIntensity = 'conservative' | 'balanced' | 'aggressive';
export type MemorySource = 'conversation' | 'document' | 'deliverable_feedback';

export interface MemoryConfig {
  longTerm: boolean;
  autoLearn: boolean;
  intensity: MemoryIntensity;
  retentionDays: number; // 30 | 180 | -1(永久)
  sources: MemorySource[];
}

/** 智能体运行时接入方式：跟随全局模型 / 自定义 OpenAI 兼容端点 / 绑定 Dify 应用 */
export type AgentProviderMode = 'inherit' | 'openai' | 'dify';

/** 自定义 HTTP 工具定义（Phase 2 defer，仅占位） */
export interface CustomToolDef {
  name: string;
  description: string;
  httpUrl?: string;
  inputSchema: Record<string, unknown>;
}

/** 自建技能（工具调用）配置：providerMode=openai 时生效 */
export interface SkillsConfig {
  enabled: boolean;
  tools: string[];              // 勾选的内置工具名，如 ['search_knowledge','recall_memory']
  customTools?: CustomToolDef[]; // 预留
  // 产出模式：'always'(默认)=每轮强制结构化成果(report)；'on-demand'=对话优先，模型自行决定何时产出报告/卡片。
  deliverableMode?: 'always' | 'on-demand';
}

/** 运营端读取的智能体接入配置（apiKey 脱敏为 has*，不回明文） */
export interface AgentRuntimeView {
  providerMode: AgentProviderMode;
  apiBaseUrl: string;   // 自定义 OpenAI 兼容 baseUrl，如 https://api.deepseek.com/v1
  apiModel: string;     // 自定义模型名，如 deepseek-chat
  apiTemperature: number | null; // P2-7：per-agent 温度（null=跟随全局）
  hasApiKey: boolean;   // 自定义端点是否已配置 key
  difyBaseUrl: string;  // Dify 应用 baseUrl，如 http://ai.aibuzz.cn/v1
  hasDifyKey: boolean;  // Dify 应用是否已配置 key
  difyInputs: Record<string, string>; // { Dify输入变量名: "{企业档案}" } 本地上下文按占位符映射
  skills: SkillsConfig; // 自建技能配置（关闭时 enabled=false）
}

/** 运营端更新智能体接入配置（key 仅在显式传入非空时更新；空串=清空） */
export interface AgentRuntimeUpdate {
  providerMode?: AgentProviderMode;
  apiBaseUrl?: string;
  apiModel?: string;
  apiTemperature?: number | null; // P2-7
  apiKey?: string;
  difyBaseUrl?: string;
  difyApiKey?: string;
  difyInputs?: Record<string, string>;
  skills?: SkillsConfig;
}

/** agent 可勾选的工具元信息（GET /admin/skill-tools）：内置 + 启用的自定义工具 */
export interface SkillToolMeta {
  name: string;        // 技能 key（= skillsConfig.tools 里存的值）
  description: string;
  builtin: boolean;    // true=代码内置（search_knowledge / render_report…），false=运营自建 HTTP
  kind: 'tool' | 'output'; // tool=模型主动调用 | output=产出后处理（如 render_report 网页报告）
}

/** 自定义 HTTP 工具：后台读取视图（鉴权头脱敏为 headerKeys/hasHeaders） */
// P2-10：后台单工具试跑结果
export interface AgentToolDryRunResult { ok: boolean; output?: string; error?: string; ms: number }
// P2-10：per-tool 运行观测（成功率/错误率/延迟）
export interface ToolStatItem { tool: string; calls: number; errors: number; errorRate: number; avgMs: number }
export interface ToolStatsView { sinceDays: number; stats: ToolStatItem[] }
export interface SkillToolDef {
  id: string;
  key: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  httpMethod: 'GET' | 'POST';
  httpUrl: string;
  argsLocation: 'body' | 'query';
  enabled: boolean;
  headerKeys: string[];   // 已配置的请求头名（值不回显）
  hasHeaders: boolean;
  createdAt: string;
}

/** 自定义 HTTP 工具：后台新增/更新入参（headers 省略=保留现有，传入=整体替换） */
export interface SkillToolUpsert {
  key: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  httpMethod?: 'GET' | 'POST';
  httpUrl: string;
  argsLocation?: 'body' | 'query';
  enabled?: boolean;
  headers?: Record<string, string>;
}

/** 对话/前端消费的公开智能体字段（GET /agents） */
export interface Agent {
  key: string;
  name: string;
  role: string;
  icon: string;
  type: AgentType;
  gift: boolean;
  billing: AgentBilling; // 计费模式
  price: number;         // 钻石(点)价：unlock=解锁消耗；metered+image=每张消耗；free=0
  billingRatio: number;  // 文本类 token 计费比例：扣额=ceil(真实token×ratio)
  meterUnit: 'text' | 'image'; // text=产出扣月度 token 额度 | image=按张扣钻石
  owned: boolean;        // 当前用户是否已开通（free/metered 恒为可用，owned 仅对 unlock 有意义）
  enabled: boolean;
  greet: string;
  chips: [string, string][]; // [icon, label]
  memText: string;
  learnText: string;
  deliverableKey: string | null;
}

/** 购买/解锁智能体结果（POST /agents/:key/purchase） */
export interface AgentPurchaseResult {
  ok: true;
  agentKey: string;
  pricePaid: number;     // 本次消耗算力
  creditBalance: number; // 解锁后余额（<0=不限量）
  alreadyOwned: boolean; // 幂等：已开通则为 true、不重复扣费
}

/** 运营端列表项（GET /admin/agents） */
export interface AdminAgent {
  key: string; name: string; role: string; icon: string; type: AgentType;
  gift: boolean; billing: AgentBilling; price: number; billingRatio?: number; meterUnit?: 'text' | 'image'; enabled: boolean; deliverableKey: string | null;
  ownerCount?: number; sessionCount?: number; deliverableCount?: number; updatedAt?: string;
  // 版本化（P0+）
  publishedVersionId?: string | null; // null=尚未发布，C 端走草稿回退
  publishedVersion?: number | null;   // 已发布版本号
  draftDirty?: boolean;               // 草稿有未发布改动
  canEdit?: boolean;                  // 当前操作者可否编辑（多运营按 agent 授权）
}

/** 运营端详情（含 System 提示词 + Agent Memory + 计费配置） */
export interface AgentDetail {
  key: string; name: string; role: string; icon: string; type: AgentType;
  gift: boolean; billing: AgentBilling; price: number; billingRatio: number; meterUnit: 'text' | 'image';
  enabled: boolean; systemPrompt: string; memoryConfig: MemoryConfig; deliverableKey: string | null;
  greet?: string;
  runtime: AgentRuntimeView; // 接入方式（跟随全局 / 自定义端点 / Dify 应用）
  // 版本化（P0+）：本详情 = 草稿态；C 端实际跑 publishedVersionId 指向的快照
  publishedVersionId?: string | null;
  publishedVersion?: number | null;
  draftDirty?: boolean;
  canEdit?: boolean;
}

/** 运营端新增智能体入参（POST /admin/agents） */
export interface AdminAgentCreate {
  key: string; name: string; role: string; icon?: string; type?: AgentType;
  gift?: boolean; billing?: AgentBilling; price?: number; billingRatio?: number; meterUnit?: 'text' | 'image'; enabled?: boolean;
  greet?: string; deliverableKey?: string | null; systemPrompt?: string;
}
/** 运营端更新智能体入参（PATCH /admin/agents/:key） */
export interface AdminAgentUpdate {
  name?: string; role?: string; icon?: string; type?: AgentType;
  gift?: boolean; billing?: AgentBilling; price?: number; billingRatio?: number; meterUnit?: 'text' | 'image'; enabled?: boolean;
  greet?: string; deliverableKey?: string | null;
  systemPrompt?: string; memoryConfig?: MemoryConfig;
  runtime?: AgentRuntimeUpdate; // 接入方式配置
}

/* ────────────── 运营后台账户（单一管理员 + 主密钥应急） ────────────── */
/** 后台登录态（GET /admin/auth/status，公开）：是否已初始化账户、主密钥是否启用 */
export interface AdminAuthStatus { initialized: boolean; masterKeyEnabled: boolean; }
/** 初始化账户（POST /admin/auth/init）：需主密钥；仅未初始化时可用 */
export interface AdminInitRequest { masterKey: string; username: string; password: string; }
/** 账号密码登录（POST /admin/auth/login） */
export interface AdminLoginRequest { username: string; password: string; }
/** 登录/初始化成功：下发会话 token（作为 x-admin-token 发送） */
export interface AdminAuthResult { token: string; username: string; }
/** 改密（POST /admin/auth/password，需登录）：主密钥可直接重置，否则需当前密码 */
export interface AdminChangePasswordRequest { currentPassword?: string; newPassword: string; masterKey?: string; }

/* ────────────── 账号 / 用户 ────────────── */
export interface AiInfo { provider: string; model: string; ready?: boolean; claudeReady?: boolean; }

export type UnderstandingMaturity = 'empty' | 'forming' | 'ready';
export interface ClientUnderstandingSection {
  key: string;
  title: string;
  items: string[];
  emptyText?: string;
}
/** L-6 三势真数据化：市势/人势的结构化研判结论（天势走命盘 monthlyOutlook，不入此结构）。 */
export type ForceVerdict = '攻' | '守' | '等' | '撤';
export interface ForceView { verdict: ForceVerdict; note: string; }
export interface ForcesView { shishi?: ForceView | null; renshi?: ForceView | null; }

/** 前台「个人档案」：把真实档案、记忆、项目和知识沉淀整理成客户可读的咨询理解 */
export interface ClientUnderstanding {
  title: string;
  subtitle: string;
  maturity: UnderstandingMaturity;
  summary: string;
  mainContradiction?: string | null; // 战略档案里的主要矛盾（战局 hero 优先展示真结论，而非通用摘要）
  positioning?: string | null;       // 战略定位（可选展示）
  forces?: ForcesView | null;        // L-6：市势/人势研判结论（军情页三势卡回显，保留兼容）
  battleForces?: BattleForce[] | null; // V7-04：结构化三势（天势/市势/人势，战局页三势卡真实渲染）
  battleForcesAt?: string | null;    // V7-04：三势最近生成时间
  sections: ClientUnderstandingSection[];
  nextQuestions: string[];
  evidenceCount: { profile: number; memories: number; projects: number; knowledge: number; sessions: number };
  updatedAt?: string | null;
}

/** 军师记忆库六类 key（其人/其业/其时/其志/其略/相与之道）；展示标签在 app 端映射。 */
export type MemoryCategoryKey = 'founder' | 'company' | 'status' | 'vision' | 'strategy' | 'rapport';
/** 充实度：待察 / 粗知 / 了然 / 已定（strategy 类有已确认战略事实时为 settled）。 */
export type MemoryFillLevel = 'unknown' | 'thin' | 'known' | 'settled';
export interface MemoryLibraryEntry {
  id: string;
  text: string;
  source: string; // conversation | deliverable_feedback | strategic
}
export interface MemoryLibraryGroup {
  category: MemoryCategoryKey;
  fill: MemoryFillLevel;
  entries: MemoryLibraryEntry[];
}
/** 军师记忆库：主公档案页「军师记事」按六类结构化呈现（详见 memoryLibrary.ts / P2）。 */
export interface MemoryLibraryView {
  total: number;                 // 已归档事实总条数
  groups: MemoryLibraryGroup[];  // 固定 6 组、固定顺序
  updatedAt: string | null;
}

// ——— 完整履历（P3：创始人战略档案，原生长页面，商务风）———
export type DossierBlock =
  | { type: 'para'; text: string }
  | { type: 'highlight'; title?: string; text: string; tone?: 'gold' | 'purple' | 'red' | 'blue' | 'green' }
  | { type: 'stats'; items: { value: string; label: string }[] }
  | { type: 'timeline'; items: { time: string; title: string; desc: string }[] }
  | { type: 'quote'; text: string };
export interface DossierSection {
  key: string;       // identity | story | company | status | strategy | vision | tianshi | letter
  no: string;        // 序号，如 "01"
  label: string;     // 中文小节名（身份定义 / 创业历程 …）
  eyebrow?: string;  // 英文小标（IDENTITY …），商务风点缀
  blocks: DossierBlock[];
}
export interface DossierReport {
  name: string;
  headline: string;      // 封面一句话定位
  verse?: string | null; // 谶语/slogan（命理开且命盘有值才给）
  sections: DossierSection[];
  generatedAt: string;
}
/** 完整履历的取用态：有缓存则返回 report，从未生成过 report=null。 */
export interface DossierView {
  report: DossierReport | null;
  generatedAt: string | null;
}

// —— 账本闭环（F-8/P-2）：决策账本 + 天机账本，App 可查可验证。服务端 decisionLog.ts/prophecyLog.ts 有同构镜像定义。——
export interface DecisionView {
  id: string; seq: number; scene: string; decision: string; reasons: string[];
  tianshiRef: string; expected: string; verifyStandard: string; verifyByDate: string | null;
  status: 'pending' | 'correct' | 'revise'; verifyNote: string; fast: boolean | null; createdAt: string;
  disputeNote?: string | null; disputedAt?: string | null; // WO-11：用户对判定的异议（复盘时军师带出确认）
}
export interface DecisionStats {
  total: number; pending: number; correct: number; revise: number;
  accuracy: number | null; fastAccuracy: number | null; slowAccuracy: number | null; // n<5 或无样本=null
}
export interface DecisionLedger { items: DecisionView[]; stats: DecisionStats; }
export interface ProphecyView {
  id: string; seq: number; prophecy: string; basis: string; verifyStandard: string;
  dueDate: string | null; status: 'pending' | 'hit' | 'miss'; verifyNote: string; createdAt: string;
  disputeNote?: string | null; disputedAt?: string | null; // WO-11：用户对判定的异议（复盘时军师带出确认）
}
export interface ProphecyStats { total: number; pending: number; hit: number; miss: number; hitRate: number | null; }
export interface ProphecyLedger { items: ProphecyView[]; stats: ProphecyStats; }

/** 本月 token 额度（客户端「钻石管理」只看进度 %）。limit/remaining<0=不限量 */
export interface TokenQuotaView {
  limit: number;     // 本月授予总额度，-1=不限量
  used: number;      // 本月已用
  remaining: number; // 剩余（可为负=已耗尽）
  unlimited: boolean;
}
/** 套餐有效期状态：驱动前端只读态 + 展示到期/剩余天数/下次额度重置日。 */
export interface PlanStatusView {
  active: boolean;            // 套餐有效（未过期）
  expired: boolean;          // 已过期 → 前端只读模式
  expiresAt: string | null;  // 绝对到期时间（ISO）；null=不到期（免费/企业/历史）
  daysRemaining: number | null; // 剩余天数；null=不到期
  nextResetAt: string;       // 下次月度额度重置时刻（ISO）
}
/** 钻石(点)消耗明细一条（GET /me/credits）：解锁 / 图片按张 / 充值 / 赠送 */
export interface MyCreditItem {
  at: string;      // ISO 时间
  reason: string;  // 事由，如「解锁智能体 · 竞品军师」「决策版 · 月度充值」
  delta: number;   // +充值/赠送  -消耗
  balance: number; // 该笔后的钻石余额
}
export interface MyCreditsView { items: MyCreditItem[]; }

export interface Me {
  user: { id: string; name: string; role: string; benmingColor: string; avatarUrl?: string | null; phone?: string; wechatLinked?: boolean };
  tenant: { id: string; name: string; industry?: string | null; stage?: string | null };
  plan: { name: string; creditsPerMonth: number; tokenQuotaPerMonth: number } | null;
  creditBalance: number; // 钻石(点)余额：解锁 / 图片按张
  tokenQuota: TokenQuotaView; // 本月 token 额度（文本产出消耗池）
  planStatus?: PlanStatusView; // 套餐有效期状态（过期 → 只读）
  onboarded?: boolean;
  ai: AiInfo;
  understanding?: ClientUnderstanding;
  inviteCode?: string;             // V7-13：邀请码（惰性生成）
  service?: ServiceAssignmentView | null; // V7-13：社群服务分配（无则 null）
  features: FeatureFlags;          // P0-2：功能开关（前端条件渲染的真相源）——fortune 关则隐藏全部命理入口
}

/** 前端可见的功能开关集合（合规硬需求：审核事故时一键全产品降级）。默认全开。 */
export interface FeatureFlags {
  fortune: boolean; // 命理（八字/命盘/天时日历/送你一卦）总开关；false = 全产品下线命理 UI/端点
}

export interface LoginRequest { phone: string; name?: string; code?: string; }
export interface AliasSuggestionResult { name: string; source: string; }
/** 更新身份（称呼 + 公司/品牌名 + 头像）：首登建档 / 完善资料 / 设置页 */
export interface UpdateIdentityRequest { name?: string; company?: string; avatarUrl?: string; }
/** 发送短信验证码（POST /auth/sms/send）。scene：login=登录；bind=微信账号绑定手机号。 */
export interface SmsSendRequest { phone: string; scene?: 'login' | 'bind'; }
/** 绑定手机号（POST /auth/bind-phone，需登录态）：微信账号补绑真实手机号。
 *  二选一：phoneCode=微信一键(getPhoneNumber 的 code)；或 phone+code=短信验证码兜底。 */
export interface BindPhoneRequest { phoneCode?: string; phone?: string; code?: string; }
export interface BindPhoneResult { ok: boolean; phone: string; wechatLinked: boolean; }
/** 发送结果：cooldownSec 倒计时、expiresInSec 有效期；devCode 仅演示口径回传，便于自动回填。 */
export interface SmsSendResult { cooldownSec: number; expiresInSec: number; devCode?: string; }
export interface WechatLoginRequest { code: string; nickname?: string; avatarUrl?: string; }
/** 本机号一键登录（POST /auth/wechat-phone）：phoneCode=getPhoneNumber 的 code；loginCode=wx.login 的 code（可选，用于关联 openid）。 */
export interface WechatPhoneLoginRequest { phoneCode: string; loginCode?: string; name?: string; }
export interface LoginResult {
  token: string; isNew: boolean; onboarded: boolean;
  user: { id: string; name: string; phone: string; benmingColor: string; avatarUrl?: string | null; wechatLinked?: boolean };
}

/* ────────────── 建档 ────────────── */
/** 公开问卷（GET /survey） */
export interface SurveyQuestion { key: string; title: string; options: string[]; }
/** 运营端问卷（GET /admin/survey） */
export interface SurveyAdmin { id: string; key: string; title: string; optionsJson: string[]; enabled: boolean; }
export interface Profile { industry?: string | null; stage?: string | null; pain?: string | null; extra?: unknown; }

/* ────────────── 3 问速诊（WO-06：行业 + 年营收段 + 最痛的一件事 → 初诊卡） ────────────── */
export interface QuickScanRequest { industry: string; revenueBand: string; pain: string; }
export interface QuickScanResult {
  contradiction: string;  // 主要矛盾假设（1 句）
  judgement: string;      // 军师判断（2-3 句）
  firstMove: string;      // 今天就能做的一件事（1 条）
  cardUrl: string | null; // 分享卡 HTML 链接（PR-B2 生成，暂 null）
}

/* ────────────── 用户 journey 状态机（WO-07：全 tab「下一步」卡数据源） ────────────── */
export type JourneyStage = 'new' | 'scanned' | 'diagnosing' | 'plan_ready' | 'executing' | 'reviewing';
export interface JourneyNextStep { key: string; title: string; desc: string; route: string; }
export interface JourneyView {
  stage: JourneyStage;
  diagRound: number;
  nextStep: JourneyNextStep | null; // 服务端派生，前端只渲染
}

/* ────────────── 结构化成果 ────────────── */
export interface DeliverableSection { h: string; b?: string; list?: string[]; }
export interface Deliverable {
  title: string; icon: string; meta: string;
  sections: DeliverableSection[]; trust: string; actions: string[];
  htmlUrl?: string; // 服务端渲染的可分享网页版报告链接（自有域名 /api/r/:id，便于小程序 web-view 打开）
  cdnUrl?: string; // 可选 OSS/CDN 镜像；不作为小程序内打开入口
  degraded?: boolean; // P0-4：真实模型未产出结构化成果、回退本地模板时为 true（前端提示可重试；用户不计费）
  prescriptions?: DeliverablePrescription[]; // WO-12：方案开出的处方（问题→打法→生态工具 key，最多 3 条）
}
/** 成果模板（mock 提供方 / few-shot 结构约束消费） */
export interface DeliverableTemplate { icon: string; title: string; sections: DeliverableSection[]; }

/* ────────────── 处方引擎（WO-12：诊断结论 → 生态工具的结构化桥） ────────────── */
export interface DeliverablePrescription { problem: string; playbook: string; toolKey: string; }
export interface PrescriptionView {
  id: string; problem: string; playbook: string; toolKey: string;
  toolType: string; externalUrl: string | null; status: string; proposedAt: string;
  // D-3-7：toolType='external' 时的目标小程序跳转参数（实时取自 EcoTool；内部 agent 处方为 null）。
  appId?: string | null; path?: string | null;
}
export interface PrescriptionListView { items: PrescriptionView[]; }

/* ────────────── 品牌资产包（WO-13：档案 → 数字人/短剧的预填输入） ────────────── */
export interface BrandKitPersona { name: string; tagline: string; tone: string; story: string; doNots: string[]; }
export interface BrandKitVoice { hooks: string[]; openers: string[]; ctas: string[]; taboos: string[]; }
export interface BrandKitTheme { keywords: string[]; colorHint: string; styleRefs: string[]; }
export interface BrandKitView {
  persona: BrandKitPersona; voice: BrandKitVoice; theme: BrandKitTheme;
  version: number; approved: boolean; generatedAt: string;
}

/* ────────────── 自由对话回复 ────────────── */
// 军师反问的结构化提问：q 为问题原文，options 为 2-4 个推荐答案（前端渲染为可点选项 + 自动附「其他」）。
// 由模型在回复末尾以 ```ask 代码块产出，网关解析剥离后挂到 asks（见 server/llm/schema.extractAsks）。
export interface ChatAsk { q: string; options: string[]; }
export interface ChatReply { text: string; points?: string[]; acts?: [string, string][]; asks?: ChatAsk[]; }
export interface ReplyTemplate { t: string; points: string[]; acts: [string, string][]; }

/* ────────────── 会话 ────────────── */
export interface SessionItem {
  id: string; agentKey: string; agentName: string; agentIcon: string;
  title: string; snippet: string; updatedAt: string;
  projectId?: string | null; // 归属项目（无则散落）
  hasUnread?: boolean; // 有未读 AI 回复（列表红点；退出后台生成完即置 true，打开会话即清）
  unreadCount?: number; // V7-15：未读 assistant 消息数（自 lastReadAt 起，服务端算；hasUnread 保留兼容）
}
export interface SessionMessage {
  id: string; role: string; content: any; at: string;
  refs?: MessageRef[]; // 本条消息引用的 项目/报告/知识/记忆
}
export interface SessionDetail {
  id: string; agentKey: string;
  agent: { key: string; name: string; role: string; icon: string; greet: string; chips: [string, string][]; memText: string; learnText: string };
  title: string;
  projectId?: string | null;
  messages: SessionMessage[];
}

/* ────────────── 产出请求 / 结果 ────────────── */
export interface GenRequest {
  text: string; agentKey?: string; sessionId?: string;
  projectId?: string;       // 本次对话归属的项目（产出/记忆/知识会落到该项目）
  refs?: MessageRef[];      // 显式引用的资料（注入上下文，可溯源）
}
export interface GenResult {
  sessionId: string; created: boolean; agentKey: string;
  kind: 'report' | 'chat'; messageId: string;
  deliverable?: Deliverable; reply?: ChatReply;
  memory?: { learned: boolean; agentName: string } | null;
  knowledgeUsed?: string[]; // 本次自动召回/显式引用所用到的知识摘要（用于「参考了哪些资料」提示）
  creditBalance?: number;   // 扣费后的钻石余额（<0=不限量；图片类按张扣后回填）
  tokenQuota?: TokenQuotaView | null; // 文本产出后回填本月额度（即时刷新进度 %；图片类为 null）
}

/* ────────────── 方案库 ────────────── */
export interface LibItem {
  id: string; title: string; type: string; agentKey: string; agentName: string;
  sessionId: string | null; content: Deliverable; at: string;
  // 桥接到「版本化报告」：存库即写一版报告，方便从方案库直接看变更
  reportId?: string | null; version?: number; projectId?: string | null;
}
export interface SaveLibRequest {
  title: string; type: string; agentKey: string; sessionId?: string; content: object;
  projectId?: string; // 归属项目
}

/* ════════════════════════════════════════════════════════════
 *  以下为「项目 / 知识库 / 版本化报告 / 引用」能力（企业事务操作系统）
 * ════════════════════════════════════════════════════════════ */

/* ────────────── 引用（@ 项目/报告/知识/记忆） ────────────── */
export type RefKind = 'project' | 'report' | 'knowledge' | 'memory';
/** @引用选择器「记忆」分组候选（GET /memories） */
export interface MemoryCandidate {
  id: string;
  text: string;
  kind: string;          // fact | preference | feedback
  agentKey: string;
  agentName?: string | null;
  projectId?: string | null;
  createdAt: string;
}
export interface MessageRef {
  kind: RefKind;
  id: string;
  versionId?: string;  // report：引用某个具体版本（缺省=最新）
  version?: number;    // 展示用版本号
  label: string;       // 展示名（如「报告《战略诊断》v2」）
}

/* ────────────── 项目（企业事务主线） ────────────── */
export type ProjectStatus = 'active' | 'archived';
export interface ProjectItem {
  id: string; name: string; slug: string; icon: string;
  summary: string | null; status: ProjectStatus;
  counts: { sessions: number; reports: number; knowledge: number };
  updatedAt: string;
}
export interface ProjectDetail extends ProjectItem {
  sessions: SessionItem[];
  reports: ReportItem[];
  knowledge: KnowledgeItemT[];
}
export interface CreateProjectRequest { name: string; icon?: string; summary?: string; }
export interface UpdateProjectRequest { name?: string; icon?: string; summary?: string; status?: ProjectStatus; }

/* ────────────── 版本化报告 ────────────── */
export interface ReportItem {
  id: string; title: string; slug: string; type: string;
  agentKey: string | null; agentName?: string;
  projectId: string | null; currentVersion: number; updatedAt: string;
}
export interface ReportVersionItem {
  id: string; version: number; title: string;
  changeSummary: string | null; authorKind: string; sessionId: string | null; at: string;
}
export interface ReportDetail extends ReportItem {
  versions: ReportVersionItem[];
}
export interface ReportVersionContent {
  reportId: string; version: number; title: string; content: Deliverable; at: string;
}
export interface SaveReportRequest {
  title: string; type: string; agentKey?: string; projectId?: string;
  sessionId?: string; content: object; authorKind?: 'agent' | 'user';
}
export interface SaveReportResult { reportId: string; version: number; created: boolean; changed: boolean; }

/* 报告版本差异（section 级，匹配 deliverable 结构） */
export type SectionChange = 'added' | 'removed' | 'changed' | 'unchanged';
/** 词级 diff 片段：eq=未变 add=新增 del=删除 */
export interface WordOp { t: 'eq' | 'add' | 'del'; s: string; }
export interface SectionDiff {
  change: SectionChange; h: string;
  before?: DeliverableSection; after?: DeliverableSection;
  words?: WordOp[]; // change=changed 时给出句内词级高亮
}
export interface ReportDiff {
  reportId: string; from: number; to: number;
  title: { before: string; after: string };
  sections: SectionDiff[];
  summary: string; // 「新增 2 段 · 修改 1 段 · 删除 0 段」
}

/* ────────────── 知识库 ────────────── */
export type KnowledgeKind = 'insight' | 'document' | 'decision' | 'todo' | 'report_ref';
export interface KnowledgeItemT {
  id: string; projectId: string | null; kind: KnowledgeKind;
  title: string | null; text: string; sourceType: string; sourceId: string | null;
  tags: string[]; at: string;
}
export interface CreateKnowledgeRequest {
  kind?: KnowledgeKind; title?: string; text: string;
  projectId?: string; tags?: string[]; sourceType?: string; sourceId?: string;
}
export interface KnowledgeHit { item: KnowledgeItemT; score: number; snippet: string; }

/** 知识库「文档视图」一行（用户资料库 / 运营端某用户知识）：解析状态 + 文件元信息 + 切片数。 */
export interface KnowledgeDocRow {
  id: string;
  kind: string;
  title: string | null;
  sourceType: string;        // conversation | upload | deliverable | manual
  status: string;            // ready | parsing | embedding | failed（staged 解析失败如实为 failed）
  stage: string;             // staging 待整理 | optimized 已优化 | confirmed 知识库（前端标注，不过滤）
  fileName: string | null;
  fileType: string | null;   // pdf | docx | xlsx | csv | md | txt
  fileSize: number | null;   // 字节
  chunkCount: number;
  summary: string;           // 正文首段摘要（≤48 字，解析中/失败为空串）——列表信息密度用
  projectId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface KnowledgeChunkRow { id: string; ord: number; text: string; dim: number; }
/** 知识项详情：含切片正文 + 每片向量维度（排查嵌入用）。 */
export interface KnowledgeDetail {
  id: string;
  kind: string;
  title: string | null;
  sourceType: string;
  status: string;
  fileName: string | null;
  fileType: string | null;
  fileSize: number | null;
  projectId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  textPreview: string;       // 正文前 2000 字
  chunks: KnowledgeChunkRow[];
  canAnalyze: boolean;       // WO-09：是否可发起「经营体检」（解析完成 + 内容为财务/表格类）；前端据此显示体检入口
}
/** 上传响应：item id + 初始状态（parsing）。前端轮询 detail 看 ready/failed。 */
export interface KnowledgeUploadResult { id: string; status: string; }
/** WO-09 经营体检产出：命中的报告 id + 版本号（前端据此跳报告详情）。 */
export interface AnalyzeResult { reportId: string; version: number; }

/* ────────────── 对话汇总 ────────────── */
export interface SummarizeResult {
  reportId: string; version: number; title: string;
  knowledgeAdded: number; // 提炼进知识库的条数
}

/* ────────────── AI 模型配置（运营后台可随时切换大模型） ────────────── */
export type AiProvider = 'mock' | 'claude' | 'openai';
/** 对外暴露的当前配置（不含明文 key） */
export interface AiConfig {
  provider: AiProvider;
  label: string;          // 展示名，如「Agnes 2.0 Flash」
  baseUrl: string;        // openai 兼容网关地址（带 /v1）
  model: string;          // 文本模型 id
  embeddingModel: string; // 嵌入模型 id（留空=本地确定性嵌入）
  temperature: number;
  hasKey: boolean;        // 是否已配置 key（不回传明文）
  ready: boolean;         // 当前是否就绪（provider+key 有效，否则降级 mock）
  effectiveProvider: AiProvider; // 实际生效（未就绪时为 mock）
  // 向量嵌入接入（开关 + 独立凭证；baseUrl/key 留空回退对话模型）。
  embeddingEnabled: boolean;
  embeddingBaseUrl: string;
  hasEmbeddingKey: boolean; // 是否已配置独立嵌入 key
  // 重排接入（开关 + 独立凭证）。
  rerankEnabled: boolean;
  rerankModel: string;
  rerankBaseUrl: string;
  hasRerankKey: boolean;    // 是否已配置独立 rerank key
  updatedAt?: string;
}
/** 更新入参（各 apiKey 仅在传入非空时更新；留空表示不改） */
export interface AiConfigUpdate {
  provider?: AiProvider; label?: string; baseUrl?: string; model?: string;
  apiKey?: string; embeddingModel?: string; temperature?: number;
  embeddingEnabled?: boolean; embeddingBaseUrl?: string; embeddingApiKey?: string;
  rerankEnabled?: boolean; rerankModel?: string; rerankBaseUrl?: string; rerankApiKey?: string;
}
/** 内置接入商预设：选择后一键填好某家大模型的 baseUrl/model（添加模型向导用） */
export interface AiPreset {
  id: string; label: string; provider: AiProvider;
  baseUrl: string; model: string; embeddingModel?: string; note?: string;
}
/** 一个已添加的模型接入点（运营可添加多个，快速切换其一生效；不回传明文 key） */
export interface AiModel {
  id: string;
  provider: AiProvider;
  label: string;          // 展示名，如「Agnes 2.0 Flash」
  baseUrl: string;        // openai 兼容网关地址（带 /v1）；claude/mock 可空
  model: string;          // 文本模型 id
  embeddingModel: string; // 嵌入模型 id（可空）
  temperature: number;
  hasKey: boolean;        // 是否已配置 key（不回传明文）
  preset?: string | null; // 来源内置接入商 id（自定义/自主定义则空）
  active: boolean;        // 是否当前生效（= AiSetting.activeModelId 指向本行）
  priceInput: number;       // 内部成本核算：元 / 1M 输入 token（0=未配置，回退内置价表）
  priceOutput: number;      // 元 / 1M 输出 token
  priceCachedInput: number; // 元 / 1M 命中缓存输入 token（0=按 priceInput 计）
  updatedAt?: string;
}
/** 添加/编辑模型入参（apiKey 仅在传入非空时更新；留空表示不改） */
export interface AiModelUpsert {
  provider: AiProvider; label: string; baseUrl?: string; model: string;
  apiKey?: string; embeddingModel?: string; temperature?: number; preset?: string | null;
  priceInput?: number; priceOutput?: number; priceCachedInput?: number;
}
/** 测试某个模型入参（连接探活；modelId 传入时，apiKey 留空则取该模型已存 key） */
export interface AiModelTest extends AiModelUpsert { modelId?: string; }
export interface AiConfigView { config: AiConfig; presets: AiPreset[]; models: AiModel[]; }
export interface AiTestResult {
  ok: boolean; latencyMs?: number; sample?: string; error?: string; provider?: string; model?: string; missingInputs?: string[];
  // 可选子项：测试连接时若开启嵌入/重排，一并探活回传。
  embedding?: { ok: boolean; dim?: number; error?: string };
  rerank?: { ok: boolean; error?: string };
}

/* ────────────── 每日献策 ────────────── */
export interface TodaySaying { text: string; date: string; }

/* ────────────── 运营端看板 ────────────── */
export interface Overview {
  // t=标题 v=主数值(已格式化) deltaPct=近7天 vs 前7天真实环比(null=无前期数据) sub=副标签
  stats: { t: string; v: string; deltaPct: number | null; sub: string }[];
  live: Record<string, number>;
  feed: { icon: string; t: string; m: string; v: string }[];
}
export interface AdminSaying { id: string; text: string; enabled: boolean; pushedDate: string | null; }
export interface Plan {
  id: string; name: string; price: number; period: string;
  creditsPerMonth: number; tokenQuotaPerMonth: number; agentCount: number; featuresJson: string[]; highlighted: boolean;
}
export interface PlanPurchaseResult {
  ok: true;
  plan: Plan;
  creditBalance: number;
  grantedCredits: number;
  grantedTokens?: number; // 本次授予/重置的月度 token 额度
}
/** 小程序调起 wx.requestPayment 的参数（server 侧 RSA 签名产出）。 */
export interface WechatPayParams { timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string; }

/* ────────────── V7-12：单次付费商品（SKU） ────────────── */
export type SkuKind = 'module' | 'service' | 'storage';
/** 单次付费商品（GET /skus，公开）。kind=module 启用能力 | service 一次性服务 | storage 空间包。 */
export interface SkuView {
  key: string; name: string; desc: string; priceFen: number;
  kind: SkuKind; grantsModuleKey?: string | null;
}
/** 下单结果（POST /skus/:key/order）。payParams 走 wx.requestPayment；demo=演示发放（未配支付时）。 */
export interface SkuOrderResult { orderId: string; payParams?: WechatPayParams; demo?: boolean; }
/** 运营端 SKU 行（GET /admin/skus） */
export interface AdminSku { id: string; key: string; name: string; desc: string; priceFen: number; kind: SkuKind; grantsModuleKey: string | null; enabled: boolean; sort: number; }
/** 运营端更新 SKU（PATCH /admin/skus/:key）：改价/启停/展示（key 与 kind/grantsModuleKey 走代码目录，不在此改） */
export interface AdminSkuUpdate { name?: string; desc?: string; priceFen?: number; enabled?: boolean; sort?: number; }

/* ────────────── D-3-7：生态工具注册表（运营 CRUD） ────────────── */
/** 生态工具行（GET /admin/eco-tools）。id=toolKey，enabled 控制是否可开方。 */
export interface AdminEcoTool { id: string; name: string; desc: string; appId: string; path: string; enabled: boolean; sort: number; updatedAt: string; }
/** 新增生态工具（POST /admin/eco-tools）：id 唯一、小写；appId 空则不可 enabled（无法跳转）。 */
export interface AdminEcoToolCreate { id: string; name: string; desc?: string; appId?: string; path?: string; enabled?: boolean; sort?: number; }
/** 更新生态工具（PATCH /admin/eco-tools/:id）：id 不可改。 */
export interface AdminEcoToolUpdate { name?: string; desc?: string; appId?: string; path?: string; enabled?: boolean; sort?: number; }

/* ────────────── WO-08：行业基准库（运营 CRUD + CSV 批量导入） ────────────── */
/** 基准行（GET /admin/benchmarks）。p50 为空 → 注入层不引用（宁缺勿假）。 */
export interface AdminBenchmark {
  id: string;
  industry: string;
  revenueBand: string;
  metricKey: string;
  metricName: string;
  unit: string;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  note: string | null;
  source: string | null;
  enabled: boolean;
  updatedAt: string;
}
/** upsert 基准行（POST /admin/benchmarks）：(industry,revenueBand,metricKey) 唯一，命中即更新。CSV 逐行导入亦走此结构。 */
export interface AdminBenchmarkUpsert {
  industry: string;
  revenueBand?: string;
  metricKey: string;
  metricName: string;
  unit: string;
  p25?: number | null;
  p50?: number | null;
  p75?: number | null;
  note?: string | null;
  source?: string | null;
  enabled?: boolean;
}

/* ────────────── D-1 / WO-12：处方多来源漏斗报表（GET /admin/prescriptions/funnel） ────────────── */
/** 处方六态时间戳聚合（按 toolKey 分组，proposed→…→verified 为累计到达数，dismissed 独立终态）。 */
export interface AdminPrescriptionFunnelRow {
  toolKey: string; toolType: string;
  proposed: number; seen: number; clicked: number; activated: number; used: number; verified: number; dismissed: number;
}
/** 开通侧：ActivationEvent 按来源分组计数（prescription | catalog | market）。 */
export interface AdminActivationSourceRow { source: string; count: number; }
/** 漏斗响应：处方侧六态聚合 + 开通侧来源计数，一次返回两块。 */
export interface AdminPrescriptionFunnel {
  days: number;
  prescriptions: AdminPrescriptionFunnelRow[];
  activations: AdminActivationSourceRow[];
}

/** 微信支付下单结果（POST /plans/:id/order）：小程序据 pay 调起 wx.requestPayment */
export interface WechatOrderResult {
  ok: true;
  outTradeNo: string;
  amount: number; // 实付金额（分）。月→年升级时 = 折后差价
  pay: { timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string };
  // 月→年升级折算明细（applies=true 时前端可展示「已抵扣 ¥X」）。
  proration?: { applies: boolean; fullPrice: number; remainingDays: number; remainingValue: number; chargeAmount: number };
}
export type WechatSubscribeScene = 'review' | 'report';
export type WechatSubscribeStatus = 'accept' | 'reject' | 'ban' | 'filter';
export interface WechatSubscribeTemplate {
  scene: WechatSubscribeScene;
  templateId: string;
  title: string;
  description: string;
}
export interface WechatSubscribeTemplatesResult {
  scenes: WechatSubscribeTemplate[];
}
export interface WechatSubscribeChoice {
  scene: WechatSubscribeScene;
  templateId: string;
  status: WechatSubscribeStatus;
}
export interface WechatSubscribeRecordResult {
  ok: boolean;
  accepted: number;
}
/** 运营端单用户详情 + 智能体开通管理（GET /admin/users/:id） */
export interface AdminUserAgentRow {
  key: string; name: string; role: string; icon: string;
  billing: AgentBilling; price: number;
  owned: boolean;          // 该用户是否已开通
  source: string | null;   // gift | purchase | admin_grant | null
  grantedAt: string | null;
}
export interface AdminUserDetail {
  user: AdminUserItem;
  agents: AdminUserAgentRow[]; // 全部需开通(unlock)的智能体 + 开通状态
}
/** 只读看板：项目（GET /admin/projects） */
export interface AdminProjectItem { id: string; name: string; tenantName: string; status: string; sessions: number; reports: number; knowledge: number; updatedAt: string; }
/** 只读看板：报告（GET /admin/reports） */
export interface AdminReportItem { id: string; title: string; type: string; tenantName: string; agentName: string | null; currentVersion: number; updatedAt: string; }
export interface AdminUserItem {
  id: string;
  name: string;
  phone: string;
  role: string;
  tenantId: string;
  tenantName: string;
  planName: string | null;
  benmingColor: string;
  wechatLinked: boolean;
  createdAt: string;
  lastSessionAt: string | null;
  sessionCount: number;
  deliverableCount: number;
  creditBalance: number;
  totalGranted: number;
  totalSpent: number;
  tokenUsed30d: number;            // 近 30 天 TokenUsage.totalTokens 之和
  quotaRemaining: number | null;   // 月度额度剩余（-1 = 不限量；null = 无钱包）
}
export interface AdminUsageSummary {
  registeredUsers: number;
  activeUsers: number;
  totalGranted: number;
  totalSpent: number;
  currentBalanceTotal: number;
  unlimitedUsers: number;
  reportCount: number;
  creditEvents: number;
}
export interface AdminUsageView {
  summary: AdminUsageSummary;
  users: AdminUserItem[];
}
// —— per-user 用量下钻（GET /admin/users/:id/usage?days=30） ——
export interface AdminUserQuota { limit: number; used: number; remaining: number; unlimited: boolean; periodKey: string | null }
export interface AdminUserPlanStatus { planName: string | null; expiresAt: string | null; daysLeft: number | null; status: string }
export interface AdminTokenAgg { key: string; totalTokens: number; costMicros: number; calls: number }
export interface AdminUserUsage {
  quota: AdminUserQuota | null            // null = 无钱包
  plan: AdminUserPlanStatus
  tokens: {
    totalTokens: number; inputTokens: number; outputTokens: number
    costMicros: number; calls: number
    byModel: AdminTokenAgg[]; byAgent: AdminTokenAgg[]
    byDay: { day: string; totalTokens: number }[]   // day = Asia/Shanghai dateKey
  }
  credits: { delta: number; reason: string; balance: number; at: string }[]      // 钻石口径，最近 20
  payments: { orderNo: string; amount: number; status: string; paidAt: string | null; attrSource: string | null }[]  // 最近 10，orderNo 只回尾 6 位
  activations: { itemType: string; itemKey: string; source: string; at: string }[] // 最近 10
}
// 写端点请求体：
//   POST /admin/users/:id/token-quota → { mode: 'reset_to_plan' | 'set'; quota?: number }
//   POST /admin/users/:id/credits     → { delta: number; reason: string }
//   POST /admin/users/:id/plan-extend → { days: number }
export interface AdminPaymentItem { orderNo: string; userName: string; amount: number; status: string; attrSource: string | null; paidAt: string | null; createdAt: string }
export interface AdminPaymentsView {
  summary: { paidAmount: number; paidCount: number; byDay: { day: string; amount: number }[] }
  items: AdminPaymentItem[]
}
// —— Token 用量看板（计费 P1：旁路统计，不参与按次扣费）。成本 costMicros 单位 = 1e-6 元（微元）。 ——
export interface TokenUsageTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costMicros: number;
}
export interface TokenUsageModelStat {
  model: string;
  calls: number;
  totalTokens: number;
  costMicros: number;
  calibrated: boolean; // false = 该模型单价未入价表，成本为兜底估算（看板标「待校准」）
}
export interface TokenUsageDayStat {
  day: string; // YYYY-MM-DD（UTC）
  totalTokens: number;
  costMicros: number;
}
export interface TokenUsageUserStat {
  userId: string;
  name: string | null;
  totalTokens: number;
  costMicros: number;
}
/** 运营端「知识库」视图：看到用户知识库被切片/嵌入加工的状态 + 维度体检。 */
export interface AdminKnowledgeItemRow {
  id: string;
  title: string;
  kind: string;            // insight | document | decision | todo | report_ref
  tenantId: string;
  tenantName: string | null;
  chunks: number;          // 切片数
  dims: number[];          // 该项各切片的去重嵌入维度（正常应只有一个 = 当前维度）
  stale: boolean;          // 有切片维度 ≠ 当前嵌入维度（向量召回静默失效，需重嵌）
  createdAt: string;
}
export interface AdminKnowledgeView {
  embedDim: number;        // 当前 embed() 维度（256=本地确定性 / 1024=bge-m3 等远程）
  embedRemote: boolean;    // 远程嵌入是否生效
  embedModel: string;      // 当前嵌入模型名（远程）/「本地确定性嵌入」
  totals: { items: number; chunks: number; staleChunks: number; memories: number; staleMemories: number };
  items: AdminKnowledgeItemRow[];
}
export interface ReembedResult { ok: true; chunks: number; memories: number; dim: number; }

/** 检索调试台：对某用户跑真实检索，看命中 / 融合分 / rerank 前后 / 记忆召回 / 最终注入上下文。 */
export interface RetrievalDebugCand {
  itemId: string;
  title: string | null;
  kind: string;
  projectId: string | null;
  snippet: string;
  semScore: number;            // 向量余弦
  kwScore: number;             // 关键词命中
  fusionScore: number;         // 融合分（含当前项目加权）
  rerankScore: number | null;  // rerank 相关性分（未生效 = null）
  rerankRank: number | null;   // rerank 后名次（未进入 rerank 取数 = null）
}
export interface AdminRetrievalDebug {
  query: string;
  agentKey: string;
  embedDim: number;
  embedModel: string;
  embedRemote: boolean;
  rerankEnabled: boolean;
  rerankModel: string;
  rerankApplied: boolean;          // rerank 实际生效（启用 + 返回有效排序）
  candidates: RetrievalDebugCand[]; // 按融合分降序
  memories: string[];              // 该用户×该顾问语义召回的记忆
  contextKnowledge: string[];      // buildGenContext 实际注入的「知识」行
  understanding: string[];         // 实际注入的「个人档案」行
}

/** 运营端「用户上下文中心」：某用户的个人档案 + 长期记忆（按顾问）+ 知识库文档，集中观测与纠偏。 */
export interface AdminUserMemory {
  id: string;
  agentKey: string;
  kind: string;        // fact | preference | feedback
  text: string;
  weight: number;
  source: string;      // conversation | document | deliverable_feedback
  createdAt: string;
  expiresAt: string | null;
}
// P1-C4：按 agent 跨用户浏览记忆（治理自动学习写入的脏记忆）
export interface AdminAgentMemoryItem {
  id: string;
  tenantId: string;
  userId: string;
  kind: string;
  text: string;
  weight: number;
  source: string;
  createdAt: string;
  expiresAt: string | null;
}
export interface AdminAgentMemoryView { items: AdminAgentMemoryItem[] }
export interface AdminUserContext {
  understanding: ClientUnderstanding;
  memories: AdminUserMemory[];
  knowledge: KnowledgeDocRow[];
}

/** 检索基建（嵌入 / 重排）token 消耗，与「用户产出」用量分开统计。 */
export interface TokenUsageKindStat {
  kind: string;   // embedding | rerank
  model: string;
  calls: number;
  totalTokens: number;
  costMicros: number;
}
export interface AdminTokenUsageView {
  windowDays: number;
  totals: TokenUsageTotals;       // 用户产出（chat + deliverable）
  byModel: TokenUsageModelStat[]; // 用户产出
  byDay: TokenUsageDayStat[];     // 用户产出
  topUsers: TokenUsageUserStat[]; // 用户产出
  infra: TokenUsageKindStat[];    // 检索基建（embedding / rerank），与用户用量区分
}
export interface AdminAuditItem {
  id: string;
  action: string;
  summary: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  userId: string | null;
  userName: string | null;
  userPhone: string | null;
  tenantId: string | null;
  tenantName: string | null;
  payload: unknown;
  at: string;
}

/** LLM 调用诊断 trace（可观测） */
export interface AdminTraceItem {
  id: string;
  at: string;
  agentKey: string | null;
  versionId?: string | null; // P1-A1：产出所用版本，便于按版本归因质量回归

  kind: string;        // deliverable | chat
  provider: string;    // openai | claude | mock | dify
  model: string;
  status: 'ok' | 'error';
  latencyMs: number;
  toolCalls: number;
  totalTokens: number;
  cachedInput: number; // 命中提示缓存的输入 token（>0 即缓存生效）
  errorMessage: string | null;
}
export interface AdminTraceListView {
  windowDays: number;
  totals: { calls: number; errors: number; avgLatencyMs: number };
  items: AdminTraceItem[];
}
export interface AdminTraceDetail extends AdminTraceItem {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  promptText: string | null;
  responseText: string | null;
}
// P1-B5：审核日志（运营可查，此前 write-only）
export interface AdminModerationLogItem {
  id: string;
  at: string;
  refType: string; // input | output
  verdict: 'pass' | 'block';
  userId: string | null;
  sessionId: string | null;
  detail: Record<string, unknown> | null;
}
export interface AdminModerationLogView { items: AdminModerationLogItem[] }

/* ════════════════════════════════════════════════════════════
 *  运营端「提示词/知识迭代调优 + 版本化发布」（P0–P5）
 * ════════════════════════════════════════════════════════════ */

/* ────────────── 版本化（草稿 / 发布 / 历史 / 回滚） ────────────── */
export type AgentVersionStatus = 'draft' | 'published' | 'archived';
/** 版本历史一行（GET /admin/agents/:key/versions） */
export interface AgentVersionItem {
  id: string;
  version: number;
  status: AgentVersionStatus;
  label: string | null;
  changeSummary: string | null;
  billing: AgentBilling;
  price: number;
  billingRatio: number;       // 该版本的 token 消耗倍率（随版本走）
  isPublished: boolean;       // 是否为 C 端当前使用的版本
  createdBy: string | null;   // 操作者展示名（已解析 username）
  createdAt: string;
  publishedAt: string | null;
}
export interface AgentVersionListView {
  agentKey: string;
  publishedVersionId: string | null;
  draftDirty: boolean;        // 草稿 vs 已发布是否有差异
  versions: AgentVersionItem[];
}
// P1-A6：单个版本的完整内容（回滚前可查看，不再「盲滚」）
export interface AgentVersionDetail {
  id: string; version: number; status: AgentVersionStatus; label: string | null;
  systemPrompt: string; greet: string; deliverableKey: string | null;
  billing: AgentBilling; price: number; billingRatio: number; meterUnit: string; providerMode: string;
  memText: string | null; learnText: string | null;
  createdAt: string;
}
export interface PublishAgentRequest { label?: string }
export interface PublishAgentResult { ok: true; version: number; versionId: string; changed: boolean; changeSummary: string; warning?: string | null } // P1-A2：发布软门警示（opt-in，不拦截）
export interface RollbackAgentRequest { versionId: string }

/* ────────────── 多运营账户（owner 管理 operator + agent 归属） ────────────── */
export interface AdminAccountItem {
  id: string; username: string; role: string; // owner | operator
  disabled: boolean; lastLoginAt: string | null; createdAt: string;
  agentKeys: string[]; // 该 operator 负责的 agent（owner 隐式全部，返回空数组）
}
export interface CreateAdminAccountRequest { username: string; password: string; role?: string; agentKeys?: string[] }
export interface UpdateAdminAccountRequest { disabled?: boolean; role?: string; password?: string; agentKeys?: string[] }
/** 当前登录者（GET /admin/auth/me）：前端按角色显隐账户管理、按范围过滤 agent */
export interface AdminMe { kind: 'master' | 'account' | 'legacyUser'; username: string | null; role: string; isSuper: boolean }

/** 运营端功能开关行（GET /admin/flags）。compliance=合规开关（命理等），关闭即时全产品生效。 */
export interface AdminFeatureFlag {
  id: string;          // 开关 key（如 'fortune'）
  label: string;       // 中文名（运营可读）
  desc: string;        // 一句话说明关闭影响
  enabled: boolean;    // 当前态（默认开）
  compliance: boolean; // 合规开关标记（直读 DB、审核事故一键降级）
  kind: 'toggle' | 'number'; // toggle=开关；number=数值配置（如复盘保底额度 D-10）
  value?: number;      // number 类：当前数值
  min?: number;        // number 类：允许下限
  max?: number;        // number 类：允许上限
  unit?: string;       // number 类：单位标签（如「次/日」）
}
/** 改开关（PATCH /admin/flags/:id）：toggle 传 enabled；number 传 value。 */
export interface AdminFeatureFlagUpdate { enabled?: boolean; value?: number }

/* ────────────── 调教沙盒（用草稿/某版本即时试跑，返回产出 + 诊断 trace） ────────────── */
export type SandboxTarget = 'draft' | 'published' | { versionId: string };
export interface SandboxProfile { companyName?: string; industry?: string; stage?: string; pain?: string }
export interface SandboxRequest {
  text: string;
  target?: SandboxTarget;     // 默认 draft（沙盒就是试草稿）
  profile?: SandboxProfile;   // 模拟 C 端客户上下文
}
export interface SandboxTrace {
  provider: string; model: string; status: 'ok' | 'error';
  latencyMs: number; inputTokens: number; outputTokens: number; cachedInput: number; totalTokens: number;
  toolCalls: number; iterations: number; errorMessage: string | null;
}
export interface SandboxResult {
  kind: 'report' | 'chat';
  source: 'draft' | 'published' | 'version';
  versionId: string | null; versionNumber: number | null;
  billingRatio: number;
  deliverable?: Deliverable; reply?: ChatReply;
  charged: number;            // 模拟扣额 = ceil(totalTokens × ratio)（沙盒不真扣，仅展示）
  trace: SandboxTrace;
}

/* ────────────── 评测（黄金测试集 + LLM 评委打分 → 建议定价档位） ────────────── */
export interface EvalCaseItem { id: string; input: string; rubric: string | null; weight: number; sort: number; context?: Record<string, unknown> | null }
export interface EvalSetItem { id: string; agentKey: string; name: string; caseCount: number; createdAt: string }
export interface EvalSetDetail extends EvalSetItem { cases: EvalCaseItem[] }
export interface UpsertEvalSetRequest { name: string }
export interface UpsertEvalCaseRequest { input: string; rubric?: string; weight?: number; sort?: number; context?: Record<string, unknown> | null }
export interface EvalRunItem {
  id: string; agentKey: string; setId: string; setName?: string;
  targetRef: string; targetLabel: string | null;
  status: string; score: number | null; judgeModel: string | null; note: string | null;
  caseCount: number; createdAt: string;
}
export interface EvalCaseResultItem {
  id: string; caseId: string; input: string; output: string;
  judgeScore: number | null; judgeNote: string | null;
  inputTokens: number; outputTokens: number; latencyMs: number;
}
export interface EvalRunDetail extends EvalRunItem { results: EvalCaseResultItem[]; suggested?: SuggestedTier | null }
export interface StartEvalRunRequest { setId: string; target?: SandboxTarget }
/** 评分 → 建议定价档位（旗舰/进阶/标准） */
export interface PricingTier { id: string; label: string; billingRatio: number; minScore: number }
export interface SuggestedTier { score: number | null; tier: PricingTier | null } // P1-A2：score 为空（未配模型/全部失败）时不给定价建议

/** 送你一卦「天命速写」卡内容（合规打磨·AUDIT P-4）：服务端由命盘确定性派生的卡文本，
 *  经 POST /cards/fate/preview 返回——现算即返、不落库、无公开链接；小程序端 canvas 画卡导出图片分享。
 *  三段文本全部来自排盘引擎结果（非 AI 现编，守数字铁律）。 */
export interface FateCardContent {
  friendName: string;
  subtitle: string; // 「赠与 X · YYYY-MM-DD 生」
  sketch: string;   // 命格速写
  trend: string;    // 今年大势
  advice: string;   // 一条核心建议
}

/* ════════════════════════════════════════════════════════════
 *  V7 · 新版效果图对齐（战局三势 / 军令结构化 / 智库管道 / 数据源 / 模块 / 目标 / 提醒 / 社群 / 搜索）
 * ════════════════════════════════════════════════════════════ */

/* ── V7-04：三势结构化 + 战局「认可判断」一键生成 ── */
export type ForceKind = 'sky' | 'market' | 'people';       // 天势 / 市势 / 人势
export type ForceLevel = 'strong' | 'mid' | 'weak';
export type ForceTone = 'ok' | 'warn' | 'danger';
/** 单条势（战局三势卡）。strength 由服务端按 level+基准映射，前端只渲染进度条（禁止 AI 自算百分比）。 */
export interface BattleForce {
  kind: ForceKind;
  level: ForceLevel;
  conclusion: string;   // 一句结论，如「行业上行」
  tactic: string;       // 打法，如「可以借势」
  tacticTone: ForceTone;
  note: string;         // 一句说明
  strength: number;     // 0-100
}
/** 战局「认可判断 → 生成军令与报告」一键结果。 */
export interface BattleCommitResult {
  reportId: string; reportSlug: string; version: number;
  libraryId: string | null;
  newOrders: number;
  alreadyDone: boolean; // 今日已 commit → 幂等返回上次
}

/* ── V7-05：军令结构化字段（挂 DossierOrder / 服务端军令视图，全部可选，缺省不渲染） ── */
export type OrderActionType = 'upload' | 'backfill' | 'review' | 'topics' | 'none';
export interface OrderMetric { label: string; value: string; }
export interface OrderStructuredFields {
  ownerName?: string | null;
  dueAt?: string | null;
  etaMinutes?: number | null;
  sourceQuote?: string | null;
  steps?: string[];
  metrics?: OrderMetric[];
  actionType?: OrderActionType;
}

/* ── V7-06：智库三段式资料整理管道 ── */
export type KnowledgeStage = 'staging' | 'optimized' | 'confirmed';
export interface KnowledgePipelineFolder { key: string; label: string; count: number; stage: KnowledgeStage; }
export interface KnowledgeBatchTypeStat { label: string; count: number; }
/** 批次内单份文件（前端「未整理批次」逐份清单）。 */
export interface KnowledgeBatchFile { id: string; fileName: string; status: string; fileSize: number | null; }
export interface KnowledgeBatch {
  id: string; count: number;
  status: 'uploaded' | 'organizing' | 'organized';
  typeStats: KnowledgeBatchTypeStat[];
  files: KnowledgeBatchFile[]; // 逐份清单（id/文件名/解析状态/字节）
}
/** 整理后逐份归类结果（含确认前正文预览；源名丢失时明确标注内容推断/兜底）。 */
export interface OrganizeItem {
  id: string;
  fileName: string;
  fileType: string | null;
  nameSource: 'original' | 'content' | 'fallback';
  category: string;
  summary: string;
  preview: string;
  isDup: boolean;
}
export interface KnowledgePipelineView {
  counts: { staging: number; optimized: number; confirmed: number };
  quota: { usedDocs: number; freeDocs: number; usedBytes: number; freeBytes: number };
  folders: KnowledgePipelineFolder[]; // 含 confirmed + optimized 两阶段（按 stage 区分）
  batches: KnowledgeBatch[];
  optimizedItems: OrganizeItem[]; // 已优化区持久数据源（从库内 tagsJson 重建，刷新后仍在）
}
/** POST /knowledge/organize 结果（AI 粗分 + 去重）。 */
export interface OrganizeResult {
  batchId: string; status: 'organized' | 'organizing'; total: number; dedup: number;
  folders: KnowledgePipelineFolder[];
  items: OrganizeItem[]; // 逐份归类（分类 + 摘要 + 去重标记）
  deep?: boolean;
  reportId?: string;      // 深度整理产出的《资料整理报告》id（前端跳方案详情）
  reportVersion?: number; // 该报告版本号
}
/** POST /knowledge/confirm 结果（optimized/staging → confirmed 并嵌入）。 */
export interface ConfirmResult { count: number; ingested: number; ids: string[]; }
/** 智库上传（staged=true 走待整理区）返回。 */
export interface StagedUploadResult { id: string; status: string; stage?: KnowledgeStage; batchId?: string; }

/* ── V7-07：数据源状态持久化 ── */
export type DataSourceStatus = 'unbound' | 'auth_requested' | 'uploaded' | 'bound';
export interface DataSourceView {
  key: string; label: string; desc: string; icon: string;
  scope: string[];                   // 读取范围 chips
  tier: 'basic' | 'advanced';
  status: DataSourceStatus; statusLabel: string; updatedAt?: string;
}
export interface DataSourcesView {
  bound: number; needed: number; total: number; // hero 三指标（服务端算）
  sources: DataSourceView[];
}

/* ── V7-08：能力/模块中心 ── */
export type ModuleTier = 'free' | 'sku' | 'credits' | 'member';
export type ModuleGroup = 'free' | 'deep' | 'member';
export interface ModuleDetail { scene: string; input: string; output: string; cost: string; writeback: string; }
export interface ModulePrice { skuKey?: string; priceFen?: number; credits?: number; planRequired?: boolean; }
export interface ModuleView {
  key: string; label: string; desc: string; iconChar: string;
  group: ModuleGroup;
  tier: ModuleTier;
  price?: ModulePrice;
  stateLabel: string;                // 「默认启用 / ¥29 启用 / 消耗 80 算力 / 会员可用 / 已启用」
  enabled: boolean; hidden: boolean; sortOrder: number;
  detail: ModuleDetail;
  agentKey?: string | null;          // 免费能力「立即调用」承接军师
}
export interface ModulesView { recommended: ModuleView | null; modules: ModuleView[]; }

/* ── V7-10：目标阶梯 ── */
export interface GoalLadder {
  longTerm?: string | null;   // 3-5 年
  annual?: string | null;     // 年度
  quarterly?: string | null;  // 季度
  weekly?: string | null;     // 本周
  updatedAt?: string | null;
}

/* ── V7-11：提醒体系 ── */
export type ReminderKind = 'order' | 'review' | 'weekly' | 'custom';
export interface ReminderItem {
  key: string; time: string; title: string; desc: string;
  kind: ReminderKind; subscribed: boolean;
}
export interface ReminderView {
  items: ReminderItem[];
  subscribeReady: boolean; // 是否已配置订阅模板
}

/* ── V7-13：社群服务分配 + 档案工作台 ── */
export interface ServiceAssignmentView {
  teacherName: string; teacherWechat: string; className: string;
  groupQrUrl: string; taskDone: number; taskTotal: number; note: string;
}
export interface WorkbenchSection { key: string; label: string; hint: string; count: number; ready: boolean; }
export interface WorkbenchMissing { key: string; title: string; desc: string; }
export interface WorkbenchView {
  completeness: number;              // 案卷完整度 %
  sections: WorkbenchSection[];      // 4 分区（份数=bizCategory 真实计数）
  missing: WorkbenchMissing[];       // 当前最该补（understanding.nextQuestions 派生）
}
/** 运营端设置社群服务（PUT /admin/users/:id/service） */
export interface ServiceAssignmentUpdate {
  teacherName?: string; teacherWechat?: string; className?: string;
  groupQrUrl?: string; taskDone?: number; taskTotal?: number; note?: string;
}

/* ── V7-14：跨域搜索 ── */
export type SearchHitKind = 'agent' | 'session' | 'report' | 'knowledge';
export interface SearchHit { kind: SearchHitKind; id: string; title: string; snippet: string; route: string; }
export interface SearchResult { q: string; hits: SearchHit[]; }
