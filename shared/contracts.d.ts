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
  displayName?: string; // 运营可读名称（如「知识库检索」）；缺省回退 name
  description: string;
  builtin: boolean;    // true=代码内置（search_knowledge / render_report…），false=运营自建 HTTP
  // tool=模型主动调用 | output=产出后处理（如 render_report 网页报告）
  // | artifact=异步任务产二进制交付物，不进模型循环（如 canvas_design 海报成品图）
  kind: 'tool' | 'output' | 'artifact';
  inputSchema?: Record<string, unknown>; // tool 入参；后台技能详情只读展示
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

/** 启用智能体结果（POST /agents/:key/purchase）。2026-08 起「确认即启用」，启用动作不收费 */
export interface AgentPurchaseResult {
  ok: true;
  agentKey: string;
  pricePaid: number;     // 本次消耗算力（启用不再收费，恒为 0；保留字段兼容旧端）
  creditBalance: number; // 启用后余额（<0=不限量），启用不会改变它
  alreadyOwned: boolean; // 幂等：已开通则为 true
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
  greet?: string; memText: string; learnText: string;
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
  greet?: string; memText?: string; learnText?: string; deliverableKey?: string | null;
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
  used: number;      // 本月已用（仅月度部分，不含增购包消耗）
  remaining: number; // 剩余（含增购包；可为负=已耗尽/透支）
  unlimited: boolean;
  packRemaining?: number; // 增购算力包剩余（永久有效直到用完；旧服务端缺省=0）
}
export type UsageStatus = 'sufficient' | 'normal' | 'near_limit' | 'exhausted';
export type UsageLevel = 'standard' | '5x' | '20x' | 'custom';
/** 用户侧只消费相对进度，不读取内部额度原值；旧版兼容期 TokenQuotaView 仍保留。 */
export interface PublicUsageView {
  usagePercent: number;   // 仅月度额度的进度；增购包不计入分母
  usageStatus: UsageStatus; // 月度用满但增购包有余量时不报 exhausted（仍可产出）
  resetsAt: string;
  unlimited: boolean;
  packRemaining?: number; // 增购算力包剩余 token 数（无包/旧服务端缺省=0）
}
/** 套餐有效期状态：驱动前端只读态 + 展示到期/剩余天数/下次额度重置日。 */
export interface PlanStatusView {
  active: boolean;            // 套餐有效（已开通且未过期）
  expired: boolean;          // 已开通但已过期 → 前端只读模式，引导续费
  // 从未开通（planId 为空）→ 前端引导开通，与 expired 互斥。
  // 缺了这个字段的话「无套餐」和「企业版不限期」在 /me 里长得一模一样（expiresAt=null、expired=false），
  // 前端只能等写操作吃到 403 PLAN_REQUIRED 才知道，用户白写一段话才被拦。
  none: boolean;
  expiresAt: string | null;  // 绝对到期时间（ISO）；null=不到期（企业/历史）或未开通
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
  plan: {
    id: string; name: string; creditsPerMonth: number; tokenQuotaPerMonth: number;
    planFamilyKey: string; tierRank: number; period: 'month' | 'year';
    usageLevel: UsageLevel; usageLabel: string; purchaseMode: 'manual';
  } | null;
  creditBalance: number; // 钻石(点)余额：解锁 / 图片按张
  tokenQuota: TokenQuotaView; // 本月 token 额度（文本产出消耗池）
  usage: PublicUsageView; // 新版客户端用量展示真相源（不公开原始额度）
  planStatus?: PlanStatusView; // 套餐有效期状态（过期 → 只读）
  onboarded?: boolean;
  ai: AiInfo;
  understanding?: ClientUnderstanding;
  inviteCode?: string;             // V7-13：邀请码（惰性生成）
  service?: ServiceAssignmentView | null; // V7-13：社群服务分配（无则 null）
  features: FeatureFlags;          // P0-2：功能开关（前端条件渲染的真相源）——fortune 关则隐藏全部命理入口
  capabilities?: { attachments: AttachmentCapabilities }; // 运行时权威上限；旧服务端缺失时客户端保守兜底
}

/**
 * 问策入口实验分组（问策入口改版 WP1）。服务端按 `wence_entry` 开关的 payload 权重对 userId 稳定分桶，
 * 客户端只读不猜：control=现状军师列表；dock=列表页 + 常驻输入坞；chat=对话即 tab。
 * 开关**关闭** → 一律 'control'（=零改动现状）；开关**开启**但权重未配/非法 → 按三臂均分兜底，
 * 不回 control（「开着却静默零分流」会让运营以为实验在收数据，失败得无声）。
 */
export type WenceForm = 'control' | 'dock' | 'chat';

/** 前端可见的功能开关集合（合规硬需求：审核事故时一键全产品降级）。默认全开。 */
export interface FeatureFlags {
  fortune: boolean; // 命理（八字/命盘/天时日历/送你一卦）总开关；false = 全产品下线命理 UI/端点
  wenceForm?: WenceForm; // 问策入口 A/B 分组（服务端稳定分桶下发；旧客户端可忽略，按 control 渲染）
  conversationContinuity?: boolean; // 总军师跨 24h 仍续接同一 Session；false 时回退为新 Session + 交接包
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
/** 微信快捷登录（POST /auth/wechat-login）：只放行**已关联**手机号账号的 openid/unionid。
 *  纯 code 不再建号：未关联过任何账号 → 404 PHONE_LOGIN_REQUIRED，须先走手机号登录
 *  （/auth/wechat-phone 会把这次 openid 绑到手机号账号上），之后才能用它快捷复登。 */
export interface WechatLoginRequest { code: string; nickname?: string; avatarUrl?: string; }
/** 本机号一键登录（POST /auth/wechat-phone）：phoneCode=getPhoneNumber 的 code；loginCode=wx.login 的 code（可选，用于关联 openid）。 */
export interface WechatPhoneLoginRequest { phoneCode: string; loginCode?: string; name?: string; }
/**
 * 手机号快捷登录的身份解析结果。
 *
 * 账号归属真源仍是不可变的 User.id，但**登录身份解析只看手机号**：手机号是账号唯一的登录
 * 身份键，openid/unionid 只是附着其上的补充绑定。每次手机号快捷登录成功后，本次微信身份
 * 都会自动迁绑到该手机号账号上（原挂在别的账号则先解绑，账号原有的旧 openid 被覆盖，两边留审计）。
 * 账号自己的 phone 不会在登录动作里静默变更，唯一例外是历史 `wx_<openid>` 占位号首次升级为真实号。
 *
 * - matched：微信身份本来就在这个账号上、或首次关联，无迁移；
 * - placeholder_upgraded：历史纯微信占位账号首次补上真实手机号；
 * - wechat_relinked：微信身份发生了迁绑/覆盖，登录成功后的**非阻断**提醒（不再有冲突报错）。
 */
export interface LoginPhoneBinding {
  status: 'matched' | 'placeholder_upgraded' | 'wechat_relinked';
  accountPhoneMasked: string;
  observedPhoneMasked: string;
}
export interface LoginResult {
  token: string; isNew: boolean; onboarded: boolean;
  user: { id: string; name: string; phone: string; benmingColor: string; avatarUrl?: string | null; wechatLinked?: boolean };
  /** 仅手机号快捷登录需要；旧客户端忽略即可。wechat_relinked 是登录成功后的非阻断提醒。 */
  phoneBinding?: LoginPhoneBinding;
}

/* ────────────── 建档 ────────────── */
/** 公开问卷（GET /survey） */
export interface SurveyQuestion { key: string; title: string; options: string[]; }
/** 运营端问卷（GET /admin/survey） */
export interface SurveyAdmin { id: string; key: string; title: string; optionsJson: string[]; enabled: boolean; }
export interface Profile { industry?: string | null; stage?: string | null; pain?: string | null; extra?: unknown; }

/** 点谶记录（周期陪伴）：军师把某天的真事对到谶中某半句上。clause=1 前半句、2 后半句；note≤40 字白话。 */
export interface VerseMoment { at: string; clause: 1 | 2; note: string }

/** 已确认的战略档案（GET /profile/strategic）：谶语按 verseYear 盖章，一年一句。 */
export interface StrategicProfile {
  mainContradiction: string;
  positioning: string;
  track: string;
  stage: string;
  narrative: string;
  verse: string;
  verseYear: number | null;
  verseAt?: string | null; // 获谶时刻（ISO）：半验「满六个月」的锚点
  verseMoments?: VerseMoment[]; // 当年点谶记录（全年上限 12 条，换谶/跨年清空）
  updatedAt: string | null;
}
// verseYear/verseAt/verseMoments 都由服务端随谶语盖章与点谶维护，不接受外部传入。
export type StrategicProfilePatch = Partial<Omit<StrategicProfile, 'updatedAt' | 'verseYear' | 'verseAt' | 'verseMoments'>>;

/** 复盘账本（GET /reviews）：日期统一为上海时区 YYYY-MM-DD。 */
export interface ReviewLogItem {
  id?: string;
  layer?: string;
  date: string;
  ordersTotal?: number;
  ordersDone?: number;
  alignRate?: number | null;
  hasBackfill?: boolean;
  createdAt?: string;
}
export interface ReviewsResult { items: ReviewLogItem[]; streak: number }

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

/* ────────────── 可审计客户事实（独立于语义 Memory） ────────────── */
export type UserFactStatus = 'asserted' | 'pending' | 'confirmed' | 'rejected' | 'superseded';
export type UserFactSourceType = 'user_message' | 'document' | 'assistant_inference' | 'manual_edit';
export interface UserFactView {
  id: string;
  factKey: string;
  valueText: string;
  status: UserFactStatus;
  sourceType: UserFactSourceType;
  sourceMessageIds: string[];
  sourceSessionId?: string | null;
  sourceDocumentId?: string | null;
  supersedesId?: string | null;
  confidence?: number | null;
  assertedAt?: string | null;
  confirmedAt?: string | null;
  supersededAt?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface FactConfirmationItem {
  id: string;
  factKey: string;
  valueText: string;
  reason: 'assistant_inference' | 'document_extraction' | 'conflict' | 'high_impact';
}
/** 独立确认卡：按钮调用事实接口，不会伪造用户聊天消息，也不会再次触发模型。 */
export interface FactConfirmationCard {
  title: string;
  items: FactConfirmationItem[];
}
export type FactConfirmationAction = 'confirm' | 'edit' | 'session_only';
export interface FactConfirmationRequest { action: FactConfirmationAction; valueText?: string; }
export interface FactConfirmationResult {
  fact: UserFactView;
  resolution: 'confirmed' | 'edited' | 'session_only';
}

/** 服务端权威附件能力；客户端只用本地常量做旧服务端兜底。 */
export interface AttachmentCapabilities {
  maxAttachmentsPerMessage: number;
  maxImagesPerMessage: number;
  maxImagesPerBatch: number;
  maxImageBytes: number;
  maxImageBatchBytes: number;
  maxImageMessageBytes: number;
}

/* ────────────── 结构化成果 ────────────── */
// 报告 V2：类型化交付物。section 增加 `type` 判别字段；无 type = 旧版白卡（{h,b,list}），存量报告原样渲染。
// 兼容性设计：旧字段 h/b/list/sub 以「可选」形式挂在所有变体的公共基上——既保留判别联合语义（按 type 分发渲染），
// 又让存量读取 sec.h/sec.b/sec.list 的代码零改动通过类型检查。

/** 报告语义标签五色（callout tone）：机会(金)/风险(赭赤)/行动(朱)/布局(黛青)/时机(苍绿)。 */
export type DeliverableTone = '机会' | '风险' | '行动' | '布局' | '时机';
/** 对比表单元格：纯文本，或带涨跌语义标记（up=利好苍绿 / dn=风险赭赤）。 */
export type DeliverableTableCell = string | { text: string; trend?: 'up' | 'dn' };

/** 所有 section 变体共享的可选字段（向后兼容 + 章节标题）。 */
export interface DeliverableSectionCommon { h?: string; sub?: string; b?: string; list?: string[]; }

/** 旧版白卡段落（无 type）：向后兼容，存量报告原样渲染。 */
export interface DeliverableSectionBasic extends DeliverableSectionCommon { type?: undefined; }
/** hero 定调宣言（深绿满宽） */
export interface DeliverableSectionHero extends DeliverableSectionCommon { type: 'hero'; h: string; paras: string[]; }
/** callout 语义提示块 */
export interface DeliverableSectionCallout extends DeliverableSectionCommon { type: 'callout'; tone: DeliverableTone; h: string; b: string; }
/** stats 数据大字格 */
export interface DeliverableSectionStats extends DeliverableSectionCommon { type: 'stats'; items: { num: string; unit?: string; label: string }[]; }
/** roster 人物卡（intro=卡片前的引导语，可选） */
export interface DeliverableSectionRoster extends DeliverableSectionCommon { type: 'roster'; intro?: string; people: { name: string; role: string; desc: string }[]; }
/** table 对比表（rows 单元格支持 up/dn 语义标记） */
export interface DeliverableSectionTable extends DeliverableSectionCommon { type: 'table'; headers: string[]; rows: DeliverableTableCell[][]; }
/** phases 作战阶段卡（kpi 渲染为「军令状」线） */
export interface DeliverableSectionPhases extends DeliverableSectionCommon { type: 'phases'; items: { tab: string; when?: string; h: string; actions: string[]; kpi?: string }[]; }
/** timeline 时间轴（highlight=金色关键节点） */
export interface DeliverableSectionTimeline extends DeliverableSectionCommon { type: 'timeline'; items: { when: string; h: string; d: string; highlight?: boolean }[]; }
/** quote 居中金句（满宽，不套章节卡） */
export interface DeliverableSectionQuote extends DeliverableSectionCommon { type: 'quote'; text: string; cite?: string; }
/** letter 军师手书（满宽收尾，不套章节卡） */
export interface DeliverableSectionLetter extends DeliverableSectionCommon { type: 'letter'; salute?: string; paras: string[]; close: string; sign?: string; }
/** gauge 评分盘（体检/诊断章）：score 主盘（半环弧盘）+ items 分项横条 */
export interface DeliverableSectionGauge extends DeliverableSectionCommon { type: 'gauge'; score: number; verdict?: string; items?: { label: string; score: number; note?: string }[]; }
/** matrix 四象限（SWOT/优先级/风险格）：quads 恰 4 个，顺序左上→右上→左下→右下 */
export interface DeliverableSectionMatrix extends DeliverableSectionCommon { type: 'matrix'; xLabels?: [string, string]; yLabels?: [string, string]; quads: { title: string; tone?: DeliverableTone; items: string[] }[]; }
/** gantt 泳道条（作战地图/排期）：rows 按 from/to 定位色条（tone 走语义五色，默认深绿） */
export interface DeliverableSectionGantt extends DeliverableSectionCommon { type: 'gantt'; unit?: '周' | '旬' | '月'; total?: number; rows: { label: string; from: number; to: number; tone?: DeliverableTone; note?: string }[]; }

export type DeliverableSection =
  | DeliverableSectionBasic
  | DeliverableSectionHero
  | DeliverableSectionCallout
  | DeliverableSectionStats
  | DeliverableSectionRoster
  | DeliverableSectionTable
  | DeliverableSectionPhases
  | DeliverableSectionTimeline
  | DeliverableSectionQuote
  | DeliverableSectionLetter
  | DeliverableSectionGauge
  | DeliverableSectionMatrix
  | DeliverableSectionGantt;

/** 报告封面文案（AI 生成；badge/印章/meta 落款由模板固定）。无则用 Deliverable.title 兜底。 */
export interface DeliverableCover { title: string; subtitle?: string; motto?: string; }
/** 成果附带的二进制交付物（海报成品图等）。消息 contentJson 只存 id + 必要元数据，不存 base64。 */
export interface DeliverableAsset {
  id: string;
  kind: 'poster_png';
  mimeType: string;
  width?: number;
  height?: number;
  previewUrl?: string;  // 私有 OSS 签名预览链接（短时效，服务端每次下发时重签）
  downloadUrl?: string; // 私有 OSS 签名下载链接（短时效）
}
/** 用户本轮对交付形态的明确意图；unspecified 由智能体自身模式决定。 */
export type RequestedOutput = 'chat' | 'report' | 'unspecified';
/** 复杂度只决定一次交完还是分阶段，不能覆盖 requestedOutput。 */
export type DeliveryMode = 'single' | 'staged';
export type ComplexityDimensionKey = 'scope' | 'deliverables' | 'timeline' | 'objects' | 'dependencies';
export interface ComplexityDimensionScore { key: ComplexityDimensionKey; score: 0 | 1 | 2; reason: string }
export interface ComplexityAssessment {
  score: number;
  dimensions: ComplexityDimensionScore[];
  reasons: string[];
  source: 'rule' | 'model' | 'fallback';
}
export interface DeliveryStage {
  key: string;
  number: number;
  title: string;
  objective: string;
}
/** 报告随结果下发的阶段链；按钮只触发 nextStage，绝不自动连跑。 */
export interface StagedDeliveryView {
  generationId: string;
  deliveryPlanId: string;
  currentStageKey: string;
  currentStageNumber: number;
  totalStages: number;
  stages: DeliveryStage[];
  nextStage?: DeliveryStage | null;
  usageNotice: string;
}
export interface Deliverable {
  title: string; icon: string; meta: string;
  cover?: DeliverableCover; // 报告 V2：封面文案
  sections: DeliverableSection[]; trust: string; actions: string[];
  htmlUrl?: string; // 服务端渲染的可分享网页版报告链接（自有域名 /api/r/:id，便于小程序 web-view 打开）
  cdnUrl?: string; // 可选 OSS/CDN 镜像；不作为小程序内打开入口
  degraded?: boolean; // P0-4：真实模型未产出结构化成果、回退本地模板时为 true（前端提示可重试；用户不计费）
  prescriptions?: DeliverablePrescription[]; // WO-12：方案开出的处方（问题→打法→生态工具 key，最多 3 条）
  assets?: DeliverableAsset[]; // 海报成品图等二进制交付物（任务成功后按「成果补丁」路径回写，同 htmlUrl）
  creativeJobId?: string;      // 产出上述 assets 的创作任务 id（最近一次成功的；版本链见 CreativeJobView.parentJobId）
  delivery?: StagedDeliveryView; // 复杂方案的持久阶段链；无则为普通单次交付
  factConfirmation?: FactConfirmationCard; // 待核对事实；按钮不进入聊天消息流
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

/* ────────────── 海报成品图（canvas_design：产物型技能 kind='artifact'） ────────────── */
// 「海报设计师」短对话确认需求 → 用户选择生成路线与路线内创作方向 → 服务端异步出 PNG 成品图。
// 约束：图片模型只出 premium 的无文字主视觉；中文/Logo/二维码/AI 标识都在服务端排版层叠加。

/** 海报场景（决定默认模板与文案骨架）。 */
export type PosterScene = 'personal_brand' | 'event' | 'service' | 'product';
/**
 * 海报画幅。**只有 '3:4'**：服务端对其余值一律 422（schema.ts），三套模板画布也写死 540×720。
 * 曾写成 '3:4' | '9:16' | '1:1'「留扩展位」，结果契约在说一件服务端从不接受的事 ——
 * 前端照它做选择器就会做出一个必然 422 的入口。二期真放开比例时再连着模板一起加。
 */
export type PosterRatio = '3:4';
/**
 * 海报档位（2026-08-12）。**由用户在确认页选，不是运营的全局开关**——两档的产物形态与价格都不同。
 *
 * · `standard`（图形排版）：模型用 CSS/SVG 与用户上传素材写整张海报，
 *   **任何成功/回落路径都不得调图片生成模型**。
 * · `premium`（主视觉创作）：先由图片模型（Seedream / GPT Image）出一张**全幅无文字主视觉**，
 *   再由排版模型生成 HTML/CSS 叠层，服务端静态审计、Chromium 渲染并逐项量测。
 *
 * ⚠️ 高级档**不是**「让图片模型把整张海报连字一起画出来」。中文来自用户确认的 brief，
 * 排版由 LLM 生成、由服务端审计与量测，不得误称为「完全确定性排版」。
 * 原则不变：图片模型写出来的中文是不可校验的（量测器只能量自己排的字），
 * 一张主标题里有个错字的成品图是信任事故，而它恰恰是最难被自动发现的那类。
 */
export type PosterTier = 'standard' | 'premium';
/** 用户可理解的创作方向；key 同时决定正向 Art Direction，不是仅供展示的标签。 */
export type PosterDirectionKey =
  | 'graphic_bold_type'
  | 'graphic_symbol'
  | 'graphic_portrait'
  | 'photo_character'
  | 'photo_product'
  | 'photo_scene';
export interface PosterDirectionOption {
  key: PosterDirectionKey;
  tier: PosterTier;
  name: string;
  desc: string;
  /** 已发布的真实样例短签地址；未发布时不下发，前端显示中性占位。 */
  previewUrl?: string;
  /** 本人形象方向必须先上传肖像素材。 */
  requiresPortrait?: boolean;
  /** 例如「AI 演绎人物，不是本人」；必须与缩略图一起展示。 */
  note?: string;
}
/** 模板白名单（服务端 TEMPLATE_KEYS 同口径；启用中的清单由 GET /creative/status 下发）。 */
export type PosterTemplateKey =
  | 'person_hero' | 'manifesto_min' | 'quote_card'
  | 'editorial' | 'business_launch' | 'data_stat'
  | 'info_list' | 'agenda_event';
/**
 * 版式的信息密度：`airy` 一句主张 + 大留白 · `balanced` 标题 + 少量支撑 · `dense` 清单/议程式一屏说完。
 * 前端据它给选择器分组；老客户端读不到这个字段时按原样平铺即可（故为可选）。
 */
export type PosterTemplateDensity = 'airy' | 'balanced' | 'dense';
/** 一套可选版式（status 只下发**启用中的**，前端照它渲染选择器，不要再硬编码本地目录）。 */
export interface PosterTemplateOption {
  key: PosterTemplateKey;
  name: string;  // 中文名，如「人物主视觉」
  desc: string;  // 一句话说明，供确认页副标
  density?: PosterTemplateDensity;
}

/** 海报需求单：用户在确认页最终敲定的入参（服务端仍会再校验长度/归属/白名单）。 */
export interface PosterBrief {
  scene: PosterScene;
  goal: string;              // 商业目标（这张海报要促成什么）
  audience: string;          // 目标客群
  headline: string;          // 主标题（一张海报只讲一件事）
  subheadline?: string;      // 副标题
  proofPoints: string[];     // 证明点/卖点，最多 3 条
  cta: string;               // 行动号召
  visualDirection: string;   // 视觉方向（描述画面属性，不指名复刻在世创作者）
  negativePrompt?: string;   // 排除项（同样只写属性）
  templateKey?: string;      // 缺省或不在白名单 → 服务端按 scene 回退默认模板
  /**
   * 档位。缺省 / 非法值一律按 `'standard'`（老客户端不带这个字段时行为一字不变）。
   * 选 `'premium'` 而高级档当前不可用时，建单**返回 422 而不是静默降标准**：
   * 用户是为「顶级图片模型出主视觉」付的高级价，给他一张标准图就是货不对板
   * （与"显式请求了被停用的模板 → 422"同一条口径）。
   */
  tier?: PosterTier;
  /** 路线内的创作方向；缺省按 scene/素材选择兼容默认值。 */
  directionKey?: PosterDirectionKey;
  ratio: PosterRatio;
  portraitAssetId?: string;  // 人物照（kind='source' 的 CreativeAsset，须属本人）
  logoAssetId?: string;
  qrAssetId?: string;
  brandKitVersion?: number;  // 只允许引用已确认（approved）的品牌资产包版本
}
/** GET/POST brief-draft 返回：服务端按设计师成果 + 品牌资产包预填的草稿。 */
export interface PosterBriefDraft {
  brief: Partial<PosterBrief>;
  templateReason?: string; // 设计师给的「为什么这样设计」推荐理由，确认页原样展示
  /**
   * 设计说明（2026-08-13）：**确认页的主视图**。两三句话说清这张海报会长什么样——
   * 讲什么主题、画面上会放哪些内容、什么气质与配色、为什么用这个版式。
   *
   * 它存在的意义是把确认页从「填表格」变成「看一眼、认可就走」：用户刚跟设计师聊完，
   * 再让他对着一张空表把刚说过的话重打一遍，是把他找军师的理由原样退回给他。
   * 表单不删，收在「改一改」里——抽错一个字总得有地方改。
   * 抽取不出来（无 provider / 对话太短）时不下发，确认页退回表单打头。
   */
  designNote?: string;
  /**
   * 军师推荐的完整组合：确认页据此预选，用户可改。规则不默认推贵档。
   *
   * 为什么整组一起给（2026-08-16）：此前确认页逼用户做三次选择（方式 / 方向 / 版式），
   * 而这三项的差别用户根本感知不到——他刚说完需求，我们却让他替我们做技术选型。
   * 现在由 brief-draft 那**同一次**抽取顺带产出一套可直接下单的组合，零次必答。
   * 服务端永远兜底：LLM 不可用或给了非法值时按确定性规则合成，这个键因此恒在。
   */
  recommendation?: {
    tier: PosterTier;
    directionKey: PosterDirectionKey;
    templateKey: PosterTemplateKey;
    /** 一句话推荐理由（确认页原样展示，说清为什么这个方式/这张图靠什么立住）。≤60 字。 */
    reason: string;
  };
}

/** 创作任务产出的资产视图（url 为短时效签名链接，每次下发重签）。 */
export interface CreativeAssetView {
  id: string;
  kind: 'source' | 'visual' | 'poster_png';
  mimeType: string;
  width?: number;
  height?: number;
  previewUrl?: string;
  downloadUrl?: string;
}
/** 创作任务视图（前端轮询这个；状态以库为真源，进程内存不算）。 */
export interface CreativeJobView {
  id: string;
  kind: string;                 // 'poster'（本表通用，但目前只有海报一种消费方）
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress?: string;            // 用户可读阶段：philosophy | visual | render | upload
  creditCost: number;           // 名义价（钻石）；不限量用户仍记名义价，实扣为 0
  refunded: boolean;            // 已退款（失败/超限退回）
  errorMessage?: string;        // 面向用户的失败原因（克制口径，不透内部细节）
  createdAt: string;
  completedAt?: string;
  assets: CreativeAssetView[];
  parentJobId?: string;         // 版本链：revise/regenerate 产生的新任务指向来源任务
  /**
   * 本单路线（读 brief.tier）。**详情页的「换方向」必须按它显示价格**：
   * regenerate 继承父单档位、按 `priceForTier` 扣费，而那个面板此前写死标准价 ——
   * 高级单在那里显示 10、实扣 25，是在扣费那一刻说假话。
   * 档位上线前的老任务没有这个字段（按 standard 显示）。
   */
  tier?: PosterTier;
  /**
   * 本单建单时是否带了本人照片。**只下发这一个布尔事实，不下发 assetId，素材本体仍不进 assets**
   * （assets 只回成品与主视觉）。
   *
   * 用途只有一个：详情页「换方向」面板据它过滤 `requiresPortrait` 的方向。没有它时，那个面板
   * 只按 tier 过滤，于是给无照片的单也摆出「本人形象」—— 选中提交，服务端必 422
   * 「「本人形象」需要先上传本人照片」，而详情页压根没有上传入口，用户在那儿无路可走。
   */
  hasPortrait: boolean;
  /**
   * 本单实际选中的影像风格中文名（如「编辑部黑金」）。**只有真的走了影像路线才有值**：
   * 它读的是任务结果里的 styleKey（画面已经按这一档出过了），不是建单时的意图快照。
   * standard 单、以及影像路线失败的单，一律不带这个字段。
   *
   * 用途：详情页要能说清「这张是什么风格出的」——在此之前用户只看得到一张图，
   * 改稿时说不出哪里不对，客服也对不上账。
   */
  styleName?: string;
  /**
   * 成品里留了空白贴码位（用户没传二维码时，两条排版路径都会渲染浅色贴码区而不是不画）。
   * 读的是 resultJson.qrReserved（worker 按「真读回了二维码字节」写入），只在成功单上出现；
   * 前端据它在成品页提示「可保存后自行粘贴二维码」。绝不据此渲染假二维码。
   */
  qrReserved?: boolean;
  actions: Array<'revise' | 'regenerate' | 'cancel'>; // 当前状态下前端可展示的操作
}
/** 源素材上传返回（先传后建任务，故此时还没有 jobId）。 */
export interface CreativeUploadResult { assetId: string; }

/**
 * 作品库列表项（GET /creative/posters）。
 *
 * 刻意**不含** brief 全文、creditCost 与 actions：列表只回答「我那张图在哪」，
 * 点进详情页由 GET /creative/jobs/:id 给全量视图（改文字 / 换方向 / 版本链都在那边）。
 * 也不含 failed / cancelled —— 那些任务没有可看的成品，摆进作品库只是一格永久的破图。
 */
export interface CreativePosterListItem {
  jobId: string;
  /** 只有三种：制作中（pending / running）与已完成（succeeded）。 */
  status: 'pending' | 'running' | 'succeeded';
  createdAt: string;
  completedAt?: string;
  /** 列表标题 = 建单时定格的主标题（brief.headline）。历史行缺字段时为空串，由前端兜底文案。 */
  headline: string;
  /** 建单时定格的版式 key（前端只做展示，不据它渲染选择器——启用清单看 /creative/status）。 */
  templateKey?: string;
  /** 制作中项的阶段（同 CreativeJobView.progress）；已完成项没有。 */
  progress?: string;
  /**
   * 已完成项的成品图。**previewUrl/downloadUrl 是短时效签名链接（600 秒）**，
   * 服务端每次下发重签 → 整个响应不得进任何缓存层。制作中项没有这个字段。
   */
  poster?: CreativeAssetView;
  /** 版本链：revise/regenerate 出来的项指向来源任务（列表据此标「改版」）。 */
  parentJobId?: string;
}
/** 作品库分页结果（游标分页，createdAt 倒序）。 */
export interface CreativePosterListResult {
  items: CreativePosterListItem[];
  /** 还有下一页时给出游标；**不给 = 已到底**（不要用空串表达"还有"）。 */
  nextCursor?: string;
}
/**
 * 成品图能力状态（GET /creative/status，需登录）。小程序据此决定**是否显示出图入口**（方案 §16 降级口径）：
 * 关闭时前端不该露出按钮再让用户点到 403，而应整块隐藏。
 * enabled 的唯一真源 = 后台功能开关（FeatureFlag 行 'creative-poster'，行缺失视为关）。
 */
export interface CreativeStatusResult {
  enabled: boolean;
  pricePerPoster: number; // 创意排版单价（钻石），由运营价格表下发
  /**
   * 高级档单价（钻石）。**只在 `premiumAvailable` 为真时有展示意义**。
   */
  premiumPricePerPoster: number;
  /**
   * 高级档此刻能不能下单 = 图片供应商已配置且启用。
   * 前端据此决定**是否露出高级档这个选项**——同 `enabled` 的口径：不可用就整块隐藏，
   * 而不是让用户选了再撞 422。
   */
  premiumAvailable: boolean;
  /** 两条路线内可选的创作方向；顺序即前端展示顺序。 */
  directions: PosterDirectionOption[];
  /**
   * 当前**启用中**的版式清单（后台停用的不下发）。前端必须照这个列表渲染版式选择器：
   * 硬编码三套恒可选会让用户选到已停用的版式，而服务端对显式请求停用模板一律 422。
   * 功能关闭时为空数组。
   */
  templates: PosterTemplateOption[];
}
/** 创建任务请求（idempotencyKey 由客户端生成，按用户唯一 → 重复点击返回原任务）。 */
export interface CreatePosterJobRequest {
  brief: PosterBrief;
  sessionId?: string;
  messageId?: string;
  idempotencyKey: string;
}
/** 只改文案重排（不换版式、不重出主视觉 → 不再扣钻石）。字段留空 = 沿用父任务。 */
export interface RevisePosterJobRequest {
  headline?: string;
  subheadline?: string;
  proofPoints?: string[];
  cta?: string;
  idempotencyKey?: string;
}
/** 重出主视觉（重新扣费）。 */
export interface RegeneratePosterJobRequest {
  visualDirection?: string;
  negativePrompt?: string;
  templateKey?: string;
  /** 换方向属于重新创作，沿用 regenerate 的收费规则。 */
  directionKey?: PosterDirectionKey;
  idempotencyKey?: string;
}

/* ────────────── 海报成品图 · 运营后台（P2 服务端 / P3 页面） ────────────── */
/** 图片供应商接入点（apiKey 只写不读；读出只回 hasKey）。 */
export interface AdminCreativeVisualConfig {
  enabled: boolean;
  /**
   * 接口方言（2026-08-12）。**不是供应商品牌，是协议差异**——三家的 images 接口长得像但不一样，
   * 用一套请求体打所有家会稳定翻车：
   * · `'openai'`：通用 OpenAI images 兼容（原行为，缺省值）。带 `response_format: b64_json`。
   * · `'ark_seedream'`：火山方舟 Seedream。**必须显式 `watermark: false`**——方舟默认给图片加水印，
   *   而一张右下角印着供应商水印的付费海报是直接不能交付的。
   * · `'gpt_image'`：OpenAI gpt-image-1。**绝不能传 `response_format`**（该模型对这个参数直接 400），
   *   它恒定返回 b64。
   * 填错方言的症状是「dry-run 报 HTTP 400」，后台文案要把这三条差异写在选择器旁边。
   */
  dialect: 'openai' | 'ark_seedream' | 'gpt_image';
  baseUrl: string;
  model: string;
  size: string;              // 请求参数模板：图片尺寸（OpenAI images 兼容 size 字段）
  timeoutMs: number;
  extraParams: Record<string, unknown>; // 额外请求参数模板（原样合并进请求体）
  hasKey: boolean;           // 读出脱敏：是否已配置密钥
  apiKey?: string;           // 仅写入方向；GET 永不回传
}
/**
 * 海报功能的运行时配置（FeatureFlag 行 'creative-poster' 的 enabled + payload）。
 *
 * 三个字段是 2026-07-29 **删掉的**，不要再加回来：
 *   · `envEnabled`（部署级 CANVAS_DESIGN_ENABLED 的只读镜像）—— 合取双开关制造「后台开了却不生效」
 *     的静默失败，作熔断又比 DB 开关慢（要 SSH + 重启）。现在 enabled 就是唯一真源。
 *   · `maxConcurrency`（worker 并发槽）—— worker 是串行 await，渲染又被 reportPdf 单并发队列串起来，
 *     这个旋钮从来没有真正生效过，是个假承诺。worker 内部改用常量 TICK_BATCH_SIZE。
 *   · `imageModerationProvider`（none|http）—— http 形态是半成品（缺 URL 就静默退回放行且无审计），
 *     "已开审核"状态下全部放行比不开更危险。二期真接供应商时连着 Moderator 实现一起加。
 */
export interface AdminCreativeConfig {
  enabled: boolean;              // 功能总开关（唯一真源；行缺失视为关）
  pricePerPoster: number;        // 标准档单价（钻石/张）
  /**
   * 高级档单价（钻石/张，2026-08-12）。高级档每单要多跑一次图片大模型，成本结构与标准档不同，
   * 所以是**独立单价**而不是一个倍率——倍率会在改标准价时把高级价一起带偏。
   */
  premiumPricePerPoster: number;
  dailyLimit: number;            // 每用户每日任务数上限；**0 = 不限量**（紧急停量请用 enabled）
  timeoutMs: number;             // 单次渲染超时（只传给渲染器，不是端到端）；上限 480000，见 config.ts
  /**
   * 排版引擎（缺省 'ai'），只决定怎么排版，不决定是否调用图片模型：
   * · `'ai'`：模型自己写整张海报的 HTML/CSS（宣言 → 创作 → 量测 → 无条件打磨一轮），
   *   standard 任一步走不通可回落模板；premium 不降级交付。
   * · `'template'`：固定白名单版式。standard 仍零生图，premium 仍必须有主视觉。
   * · 后台文案建议：「AI 排版（模型自由创作，失败自动回落模板）」/「模板排版（固定三套版式）」。
   */
  layoutEngine: 'ai' | 'template';
  templates: Record<string, boolean>; // 模板启停（key = person_hero | editorial | business_launch）
  visual: AdminCreativeVisualConfig;
}
export interface AdminCreativeDirectionSample {
  id: string;
  directionKey: PosterDirectionKey;
  directionName: string;
  tier: PosterTier;
  status: 'draft' | 'published' | 'archived';
  sourceJobId: string;
  previewUrl: string;
  createdAt: string;
  updatedAt: string;
}
export interface CreateCreativeDirectionSampleRequest {
  directionKey: PosterDirectionKey;
  /** 必须是已显式归为 internal、且在该方向/路线下成功的运营任务；服务端复制成独立全局物料。 */
  sourceJobId: string;
}
export type AdminCreativeConfigUpdate = Partial<Omit<AdminCreativeConfig, 'visual'>> & {
  visual?: Partial<Omit<AdminCreativeVisualConfig, 'hasKey'>>;
};
/** 供应商连通性试跑结果（不回传响应原文，避免把上游内部信息带进后台）。 */
export interface AdminCreativeDryRunResult { ok: boolean; message: string; ms: number }
export interface AdminCreativeJobItem {
  id: string;
  /** user=进入本人作品库；internal=仅运营任务台可见，C 端列表/详情/改字/重出全部不可达。 */
  audience: 'user' | 'internal';
  /** 已被复制为全局方向样例的来源任务；此类任务必须保持 internal，不允许人工恢复进用户作品域。 */
  sampleSource: boolean;
  userLabel: string;         // 脱敏用户标识（昵称 + 手机号掩码）
  agentKey: string;
  kind: string;
  status: string;
  progress: string | null;
  templateKey: string | null;
  /**
   * 本单档位（读 brief.tier）：`'premium'` | `'standard'` | `null`（档位上线前的老任务）。
   * 任务台要显示它，否则「高级单的实际路线是不是真的走了影像」无从对账——
   * 高级档的钱正是为那次图片大模型调用付的。
   */
  tier: string | null;
  /**
   * `CreativeJob.engine` 列：**任务模型的实现引擎**，恒为 `'native'`（军师原生管线）。
   * 与排版引擎不是一回事，别混——排版引擎看下面的 `layoutEngine`。
   */
  engine: string;
  /**
   * 本单**实际**用的排版引擎（读 resultJson.engine）：
   * `'ai'`（模型创作成功）| `'template'`（配置就是模板路径）| `'template_fallback'`（AI 引擎失败后回落）
   * | `null`（老任务 / 未完成任务）。
   * **任务台必须显示它**：AI 引擎失败会静默回落成一张模板图，任务照样是绿的——不显示就等于
   * 「AI 排版在生产整天没生效」这件事只存在于日志里（这正是供应商降级 degraded 那次踩过的坑）。
   */
  layoutEngine: string | null;
  /** AI 引擎的 LLM 轮数（1=只创作，2=创作+打磨/修复，3=再修一轮）；非 AI 路径为 null。 */
  rounds: number | null;
  /**
   * 本单**实际**走的 AI 创作路线（读 resultJson.aiMode）：
   * `'photo'`（影像主导：生图模型出全幅主视觉 + 排版层叠字）| `'graphic'`（纯图形排印）
   * | `null`（模板路径 / 老任务 / 未完成）。
   * 这是历史字段名，现只表达实际结果；生成来源由 tier 权威决定。若结果与档位契约不一致，
   * 必须在任务台可见并作为异常排查，不能再把它当成可运营切换的意图配置。
   */
  aiMode: string | null;
  /** 影像路线用的风格档 key（如 mono_authority_portrait）；graphic / 模板路径为 null。 */
  styleKey: string | null;
  /** AI 引擎回落原因（layoutEngine='template_fallback' 时有值，运营排障用）。 */
  aiEngineError?: string;
  /**
   * 历史任务里影像路线尝试过但没走通的原因。tier 权威契约上线后，新任务不再跨档降级；
   * 字段仅保留兼容老数据与运营排障。
   */
  photoError?: string;
  /** 本单可能承担的图片供应商成本快照；standard 恒为 null，premium 新单配置齐时为 configured。 */
  provider: string | null;
  /**
   * 历史跨路线降级标记。tier 权威契约上线后新任务不再产生该形态；老任务无字段按 false。
   */
  degraded: boolean;
  creditCost: number;
  charged: boolean;
  refunded: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  assetCount: number;
  /** 视觉哲学快照（六维度 + note）。列表接口超 2000 字符截断并在尾部标注。 */
  promptSnapshot?: string;
  createdAt: string;
  completedAt: string | null;
}
export interface AdminCreativeJobAudienceRequest { audience: 'user' | 'internal'; }
export interface AdminCreativeJobAudienceResult { ok: true; jobId: string; audience: 'user' | 'internal'; }
export interface AdminCreativeJobsView {
  items: AdminCreativeJobItem[];
  total: number;
  page: number;
  pageSize: number;
  summary: { pending: number; running: number; succeeded: number; failed: number; cancelled: number; refunded: number };
}

/* ────────────── 自由对话回复 ────────────── */
// 军师反问的结构化提问：q 为问题原文，options 为 2-4 个推荐答案（前端渲染为可点选项 + 自动附「其他」）。
// 由模型在回复末尾以 ```ask 代码块产出，网关解析剥离后挂到 asks（见 server/llm/schema.extractAsks）。
export interface ChatAsk { q: string; options: string[]; }
export interface ChatReply {
  text: string; points?: string[]; acts?: [string, string][]; asks?: ChatAsk[];
  /** 模型主动撰写、允许向用户展示的简短思路摘要；不是供应商隐藏推理或 chain-of-thought。 */
  thoughtSummary?: string;
  factConfirmation?: FactConfirmationCard; // 独立确认卡，不复用 asks/chips
  /**
   * 正文撞了模型输出上限、**服务端自动续写后仍未写完**（正常情况看不到这个标记：
   * 撞上限会先自动续写，用户无感）。text 是可读的真实内容，不是错误——端上要按
   * 「还没写完」呈现并给「继续」入口，不能当失败气泡，也不能丢弃。
   */
  truncated?: boolean;
}
export interface ReplyTemplate { t: string; points: string[]; acts: [string, string][]; }

/* ────────────── 会话 ────────────── */
export interface SessionItem {
  id: string; agentKey: string; agentName: string; agentIcon: string;
  title: string; snippet: string; updatedAt: string;
  projectId?: string | null; // 归属项目（无则散落）
  generating?: boolean; // 当前会话是否仍有一轮回复在服务端生成（退出聊天页后仍可恢复思考态）
  activeGeneration?: GenerationSummary | null; // 持久生成事实；旧客户端可继续只读 generating
  hasUnread?: boolean; // 有未读 AI 回复（列表红点；退出后台生成完即置 true，打开会话即清）
  unreadCount?: number; // V7-15：未读 assistant 消息数（自 lastReadAt 起，服务端算；hasUnread 保留兼容）
  lineageId?: string; // 同一主线会谈的稳定标识
  continuationOf?: string | null; // 显式新会谈继承自哪一条 Session
}
export interface SessionMessage {
  id: string; role: string; content: any; at: string;
  refs?: MessageRef[]; // 本条消息引用的 项目/报告/知识/记忆
  /**
   * 快捷回应（问策入口改版 WP1）：服务端从 `Message.contentJson.chips` 原样透出。
   * 当前唯一写入方是进场主动消息（POST /sessions/proactive）；点一下 = 以 chip 文案代用户发送。
   * 无 chips 的消息不带该字段——端上据此决定渲不渲染这一排。
   */
  chips?: string[];
}
export interface SessionMessagePage {
  hasMore: boolean;
  /** 向前翻页的不透明游标；null 表示已经到会话开头。 */
  nextCursor: string | null;
  limit: number;
}

/* ────────────── 问策入口（WP1：提示词池 / 主动消息 / 埋点） ────────────── */
/** 提示问题 pill 的一条词（GET /wence/hints）。id 用于 hint_tap 埋点回溯是哪条词促成了首发。 */
export interface WenceHint { id: string; text: string }
/**
 * GET /wence/hints 返回体。空池是合法状态（运营后台未录入），端上回退本地兜底池。
 *
 * `guestForm` 是**游客**（没有 /me、也就没有 userId 可分桶）的问策入口形态：
 * 开关关 → 'control'（零改动现状）；开关开且 chat 臂权重 > 0 → 'chat'。
 * 游客没有稳定身份，分桶没有意义也无法归因，所以这里只回答「chat 这条臂到底开没开」，
 * 而不是把游客也塞进三臂分流；登录后一律改用 `/me.features.wenceForm` 的正式分桶。
 * 'dock' 不下发给游客——那一臂仍是列表形态，与 control 同属现状渲染路径。
 */
export interface WenceHintsResult { hints: WenceHint[]; guestForm: 'control' | 'chat' }
/**
 * POST /sessions/proactive 结果。injected=false 的三种原因都不是错误，端上一律静默降级为 greet-only：
 * exists=该用户已有 general 会话（同时就是「每用户至多注入一次」的频控幂等）；
 * empty-pool=运营未录入 proactive 模板（不建空会话）；disabled=`wence_entry` 开关关闭。
 */
export type ProactiveResult =
  | { injected: true; sessionId: string }
  | { injected: false; reason: 'exists' | 'empty-pool' | 'disabled' };

/** 客户端埋点事件名白名单（POST /events）。非白名单一律 400——防止字段爆炸和脏事件污染漏斗。 */
export type ClientEventName =
  | 'wence_enter' | 'proactive_show' | 'chip_tap' | 'hint_tap'
  | 'first_message_send' | 'drawer_open' | 'attach_open' | 'tab_switch'
  | 'execution_enter' | 'order_complete' | 'backfill_save' | 'review_start'
  | 'pouch_entry_view' | 'pouch_entry_click' | 'weapon_click';
/** POST /events 请求体：鉴权可选（游客也上报，userId 空）。props 序列化后限 2KB，超限截断。 */
export interface ClientEventRequest { name: ClientEventName; props?: Record<string, unknown> }
export interface ClientEventResult { ok: true }

/** 运营后台：问策模板池（提示词 + 主动消息），空池合法，禁止 seed。 */
export type WenceTemplateKind = 'hint' | 'proactive';
export interface AdminWenceTemplate {
  id: string; kind: WenceTemplateKind; text: string;
  chips?: string[] | null; // 仅 proactive 用：随主动消息下发的快捷回应
  enabled: boolean; sort: number; createdAt: string; updatedAt: string;
}
export interface AdminWenceTemplateCreate { kind: WenceTemplateKind; text: string; chips?: string[] | null; enabled?: boolean; sort?: number }
export interface AdminWenceTemplateUpdate { kind?: WenceTemplateKind; text?: string; chips?: string[] | null; enabled?: boolean; sort?: number }
// 会话上下文快照（批次 3）：长会话只带最近 N 条原文，早期确认过的事实/约束/决策会掉出窗口。
// 系统按时间增量抽取成结构化条目做「索引 + 压缩层」；原始消息始终是事实源，故每条必须能溯源回消息 id。
// 只追加不改写：前后矛盾的两条都留着（按 at 升序），谁作数交给模型按时间判断，系统不替客户裁决。
export type SessionDigestKind = 'fact' | 'goal' | 'constraint' | 'metric' | 'decision' | 'advice' | 'open_question' | 'action_item' | 'quote' | 'deliverable_ref';
export type SessionDigestStatus = 'caught_up' | 'pending' | 'capped' | 'cooldown' | 'failed' | 'unknown';
export interface SessionDigestItem {
  kind: SessionDigestKind;
  text: string;               // 一句话，含具体数字/名词，≤160 字符
  sourceMessageIds: string[]; // 溯源：本条摘要来自哪些原始消息（1-8 个）
  at: string;                 // ISO 时间：最早来源消息的 createdAt
}
export interface SessionDetail {
  id: string; agentKey: string;
  agent: { key: string; name: string; role: string; icon: string; greet: string; chips: [string, string][]; memText: string; learnText: string };
  title: string;
  projectId?: string | null;
  generating?: boolean; // 服务端仍在处理本会话的回复；客户端重进后据此续显思考态并刷新结果
  activeGeneration?: GenerationSummary | null;
  messages: SessionMessage[];
  messagePage?: SessionMessagePage; // 新服务端恒有；可选仅用于旧 mock/滚动发布兼容
  lineageId?: string;
  continuationOf?: string | null;
}

/* ────────────── 产出请求 / 结果 ────────────── */
export type GenerationStatus = 'queued' | 'running' | 'completed' | 'truncated' | 'failed' | 'cancelled';
export type GenerationPhase = 'queue' | 'context' | 'provider' | 'finalize';
export type GenerationKind = 'chat' | 'report';
export type GenerationUsageSource = 'provider' | 'estimated' | 'mixed';
export interface GenerationSummary {
  id: string;
  sessionId: string;
  status: GenerationStatus;
  phase: GenerationPhase;
  kind: GenerationKind;
  requestedOutput: RequestedOutput;
  deliveryMode: DeliveryMode;
  complexity?: ComplexityAssessment | null;
  delivery?: StagedDeliveryView | null;
  snapshotVersion: number;
  cancelRequested: boolean;
  resultMessageId?: string | null;
  imageProgress?: ImageGenerationProgress | null;
}
export interface ImageObservationView {
  batchKey: string;
  batchNumber: number;
  imageIndexes: number[];
  observation: string;
}
export interface ImageGenerationProgress {
  totalImages: number;
  totalBatches: number;
  completedBatches: number;
  skippedImageIndexes: number[];
  phase: 'reading' | 'synthesizing' | 'done';
}
export interface GenerationView extends GenerationSummary {
  partialText: string;
  thoughtSummary?: string; // durable 生成的用户可见思路摘要快照；不是 provider hidden reasoning
  reply?: ChatReply;
  deliverable?: Deliverable;
  usage?: { inputTokens: number; outputTokens: number; cachedInput?: number; billableTokens: number } | null;
  usageSource?: GenerationUsageSource | null;
  terminationReason?: string | null;
  createdAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
  refNotices?: string[];
  knowledgeUsed?: string[];
  // 仅 status=queued 时出现；ahead=按调度顺序排在前面的排队任务数。
  // 注意口径：不含在跑/待接管恢复的单，所以 ahead=0 ≠「下一个必然是你」，文案别承诺「即将开始」。
  queue?: { ahead: number } | null;
}
export interface GenerationSnapshotEvent {
  generationId: string;
  version: number;
  text: string;
  replace: true;
  status: GenerationStatus;
  phase: GenerationPhase;
}
export interface GenRequest {
  text: string; agentKey?: string; sessionId?: string;
  clientRequestId?: string;  // 同一次用户发送在网络重试中保持不变；服务端据此幂等
  parentGenerationId?: string; // 用户点「继续写完」时关联上一终态任务
  projectId?: string;       // 本次对话归属的项目（产出/记忆/知识会落到该项目）
  refs?: MessageRef[];      // 显式引用的资料（注入上下文，可溯源）
}
export interface GenResult {
  sessionId: string; created: boolean; agentKey: string;
  kind: 'report' | 'chat'; messageId?: string; // 202 仅返回在途 generation 时可空
  generationId?: string; status?: GenerationStatus; snapshotVersion?: number;
  deliverable?: Deliverable; reply?: ChatReply;
  memory?: { learned: boolean; agentName: string } | null;
  knowledgeUsed?: string[]; // 本次自动召回/显式引用所用到的知识摘要（用于「参考了哪些资料」提示）
  refNotices?: string[];    // 引用未能全带上的实情（超过 9 份被丢下 / 仍在拆读 / 读不出）——不静默丢弃，回传给用户
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
  auto?: boolean; // 报告收尾后的自动存入（非用户主动采纳）：后端跳过 adopt 反馈信号
}

/* ════════════════════════════════════════════════════════════
 *  以下为「项目 / 知识库 / 版本化报告 / 引用」能力（企业事务操作系统）
 * ════════════════════════════════════════════════════════════ */

/* ────────────── 引用（@ 项目/报告/知识/记忆） ────────────── */
export type RefKind = 'project' | 'report' | 'knowledge' | 'memory' | 'image';
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
/** Claude 思考模式：关闭 / 固定预算 / 模型自适应。 */
export type AiThinkingMode = 'disabled' | 'enabled' | 'adaptive';
/** 能力三态。unknown=没探测过（不拦截）；no=已被探测或运营证伪（校验器据此拦截） */
export type AiCapState = 'unknown' | 'yes' | 'no';
/** 端点能力标记。来源优先级：运营显式覆盖 > 探活回填 > 厂商预设声明 */
export interface AiEndpointCaps {
  thinking?: AiCapState; tools?: AiCapState; streaming?: AiCapState; vision?: AiCapState;
  maxOutputTokens?: number;
  /** 运营手动锁定的能力项，探活回填时不覆盖 */
  locked?: string[];
}
/** 协议方言目录项（代码常量，运营只选不改）。协议决定请求形状，方言决定同协议下的细节写法 */
export interface AiDialectMeta {
  id: string; label: string;
  protocol: 'anthropic' | 'openai_chat' | 'dify' | 'mock';
  /** 关闭思考的写法。四种都真实存在：
   *  omit=省略整个字段（Anthropic 官方）；explicit=显式发 disabled（第三方 Anthropic 网关）；
   *  explicit_when_configured=仅当运营开过思考时才显式发（OpenAI 协议下 thinking 是网关私有扩展，
   *  没开过就完全省略，开过则说明网关认它、工具与成果请求必须显式按下去）；
   *  unsupported=该方言压根没有这个字段 */
  thinkingOff: 'omit' | 'explicit' | 'explicit_when_configured' | 'unsupported';
  /** 开启思考时 budget_tokens 是否真被上游采纳（DeepSeek 的 Anthropic 端点为 false） */
  budgetHonored: boolean;
  /** 嵌入/重排能否与对话端点同源（Anthropic 协议为 false：/embeddings 路径不存在） */
  auxEndpointsSameOrigin: boolean;
  note?: string;
}
/** 配置互斥校验的一条结论。error=拒绝保存；warn=可保存但后台常驻黄标；info=提示 */
export interface AiConfigIssue {
  level: 'error' | 'warn' | 'info';
  code: string;
  field?: string;
  message: string;
}
/** 单项探活结果 */
export interface AiProbeItem {
  kind: string; ok: boolean; at: string;
  latencyMs?: number; error?: string;
  detail?: Record<string, unknown>;
}
/** 一次探活的完整回执 */
export interface AiProbeReport {
  endpointId?: string;
  ok: boolean;
  results: AiProbeItem[];
  /** 本次探活顺带回填的能力标记（后台可据此刷新展示） */
  caps?: AiEndpointCaps;
}
/* ── 归一化接入配置（三期）：后台直接读写四张表的视图 ────────────────────────
 * 旧的 AiModel/AiConfig 那套是「一个全局配置 + 拷贝式生效」，这套是
 * 凭证 → 端点 → 路由(用途) 三层。「生效」＝ AiRouteMember.primary 一个指针，没有拷贝。 */

/** 凭证：一把上游 Key。**换 key 改这一条，它下面所有端点一起生效**（旧结构要改 N 行）。 */
export interface AiCredentialView {
  id: string; label: string; vendor: string;
  hasKey: boolean;
  /** 迁移时接入商没判出来，标黄待运营确认（只标黄不阻断） */
  needsReview: boolean;
  /** 有多少个端点在用它——这个数 > 1 就是「一把 key 喂多个端点」在生效 */
  endpointCount: number;
}

/** 后台可确认的厂商目录；凭证只存 id，展示名由这张代码常量表提供。 */
export interface AiVendorOption { id: string; label: string }

/** 用途级请求预算。留空即沿用运行时默认；null 用于清空整份覆盖。 */
export interface AiRouteBudget {
  timeoutMs?: number;
  bodyMaxTokens?: number;
  temperature?: number;
}

/** 端点：一次可用外呼的最小单位 = 凭证 × 方言 × baseUrl × 模型 × 请求参数。 */
export interface AiEndpointView {
  id: string; label: string;
  credentialId: string; credentialLabel: string;
  provider: AiProvider;
  /** 显式固化的方言；null = 还没固化 */
  dialect: string | null;
  /** 实际生效的方言（显式值或推断值） */
  resolvedDialect: string;
  baseUrl: string; model: string;
  temperature: number;
  thinkingMode: AiThinkingMode; thinkingBudget: number;
  caps: AiEndpointCaps;
  hasKey: boolean;
  priceInput: number; priceOutput: number; priceCachedInput: number; priceCacheWrite: number;
  lastProbeAt: string | null; lastProbeOk: boolean | null;
  /** 被哪些用途引用——删之前必须看得见「删了会影响谁」 */
  usedByPurposes: string[];
}

/** 路由：某个用途怎么用一组端点。 */
export interface AiRouteView {
  purpose: string;
  /** false = 这个用途还没配（前端据此显示「未配置」而不是空池） */
  exists: boolean;
  mode: 'single' | 'pool';
  sticky: boolean;
  enabled: boolean;
  budget: AiRouteBudget;
  members: {
    endpointId: string;
    /** single 模式下唯一生效的那一个；「设为生效」改的就是它 */
    primary: boolean;
    weight: number; tier: number; maxConcurrency: number; enabled: boolean;
  }[];
}

export interface AiV2View {
  credentials: AiCredentialView[];
  endpoints: AiEndpointView[];
  routes: AiRouteView[];
  /** 接入商预设（厂商 × 协议）。代码常量，随视图一起下发，省一次往返 */
  presets: AiPreset[];
  /** 协议方言目录。代码常量，运营只选不改 */
  dialects: AiDialectMeta[];
  /** 厂商目录。迁移标黄的凭证靠它完成显式确认 */
  vendors: AiVendorOption[];
}

/** 端点新增/编辑入参（apiKey 留空＝不改；填了就按 key 找或建凭证）。 */
export interface AiEndpointUpsert {
  label: string; provider: AiProvider;
  baseUrl?: string; model?: string; dialect?: string | null;
  apiKey?: string; credentialId?: string;
  temperature?: number; thinkingMode?: AiThinkingMode; thinkingBudget?: number;
  priceInput?: number; priceOutput?: number; priceCachedInput?: number; priceCacheWrite?: number;
}

/** 测试一个接入点；endpointId 传入且 apiKey 留空时复用该端点凭证。 */
export interface AiEndpointTest extends AiEndpointUpsert { endpointId?: string }

/** 路由保存入参。members 传了就是全量重放。 */
export interface AiRouteUpsert {
  mode?: 'single' | 'pool';
  sticky?: boolean;
  enabled?: boolean;
  budget?: AiRouteBudget | null;
  members?: { endpointId: string; primary?: boolean; weight?: number; tier?: number; maxConcurrency?: number; enabled?: boolean }[];
}

/** 归一化接入配置（三期）的就绪状态。切 AI_CONFIG_V2 之前先看这里：ready=false 时切过去＝把 AI 关掉 */
export interface AiV2Status {
  /** 读路径是否已切到归一化表（AI_CONFIG_V2） */
  enabled: boolean;
  /** chat 路由是否有可用端点——这是「能不能切」的最低门槛 */
  ready: boolean;
  routes: { purpose: string; mode: string; members: number; primary: string | null }[];
  /** 迁移时 vendor 推断不出、被标黄待确认的凭证（只标黄不阻断，但必须看得见） */
  credentialsNeedingReview: { id: string; label: string }[];
}
/** 内置接入商预设：选择后一键填好某家大模型的 baseUrl/model（添加模型向导用） */
export interface AiPreset {
  id: string; label: string; provider: AiProvider;
  baseUrl: string; model: string; embeddingModel?: string; note?: string;
}
/** 端点池实时状态（含每个端点的冷却态，供后台展示「谁在被限流」） */
export interface AiRoutingStatus extends AiRouting {
  endpoints: {
    id: string; label: string; model: string;
    weight: number; tier: number; maxConcurrency: number;
    cooling: boolean; coolingUntil: string | null; coolingReason: string | null;
  }[];
}
/** 端点池路由设置 */
export interface AiRouting {
  /** single=只用 activeModelId 指向的那一个（旧行为，默认）；pool=按池分流 + 故障转移 */
  mode: 'single' | 'pool';
  /** 会话粘性：同一会话固定落同一端点，保住上游提示词缓存。关掉会显著降低缓存命中率 */
  sticky: boolean;
}
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
/** 套餐折扣展示口径（挂牌价 → 实际价）。**折扣率由服务端按生效时间窗算好再下发**，
 *  端上只负责渲染——客户端复制折扣规则就会出现「小程序显示 1 折、下单扣原价」这类不一致。
 *  仅当挂牌价 > 实际价且当前时刻落在生效窗口内时才有值，否则为 null（原价售卖）。 */
export interface PlanPromotion {
  /** 挂牌价（划线原价，分） */
  listPrice: number;
  /** 实际价（当前生效成交价，分）——与 Plan.price 相同 */
  price: number;
  /** 立省金额（分）= listPrice - price */
  savedFen: number;
  /** 折扣费率（中式「折」）：实际价 ÷ 挂牌价 × 10，保留一位小数。1 = 一折，8.5 = 八五折 */
  discountRate: number;
  /** 可直接展示的折扣文案，如「1折」「8.5折」 */
  discountLabel: string;
  /** 运营填的活动名（如「首发价」）；未填为 null */
  label: string | null;
  /** 优惠结束时间（ISO）；null = 长期有效 */
  endsAt: string | null;
}
export interface Plan {
  /** ⚠️ **当前实际生效价（用户要付的钱）**：优惠生效时即优惠价，否则等于挂牌价。
   *  挂牌价只在 promotion.listPrice 里出现，用于划线与折扣率展示。 */
  id: string; name: string; price: number; period: string;
  creditsPerMonth: number; tokenQuotaPerMonth: number; agentCount: number; featuresJson: string[]; highlighted: boolean;
  planFamilyKey: string; tierRank: number; usageLevel: UsageLevel; usageLabel: string;
  /** 权限、V2 密钥、模板和套餐开关均齐全时才为 true；false 时前端只展示单次购买。 */
  autoRenewAvailable: boolean;
  /** 折扣中则有值；null = 按 price 原价售卖。 */
  promotion: PlanPromotion | null;
}
/** 运营后台的套餐行（GET /admin/plans）：**线上套餐目录的唯一真相源**——代码侧不再有同步脚本，
 *  seedConfig.DEV_PLANS 只是本地/测试夹具。比公开 Plan 多出 hidden（停售/白名单档）与 sort（展示序）。 */
export interface AdminPlan extends Plan {
  /** ⚠️ 与公开 `Plan.price` 语义不同：后台这一栏是**挂牌价**（运营填的标价，也是 PATCH 回写的字段）。
   *  用户当前实际付的钱见 `effectivePrice`；两者只在优惠生效期内不同。 */
  price: number;
  /** 优惠价（分）；null = 未配置优惠 */
  promoPrice: number | null;
  /** 优惠生效时间（ISO）；null = 立即生效 */
  promoStartsAt: string | null;
  /** 优惠结束时间（ISO）；null = 长期有效 */
  promoEndsAt: string | null;
  /** 活动名（仅展示，如「首发价」） */
  promoLabel: string | null;
  /** 当前时刻优惠是否生效（服务端按生效窗口判定） */
  promoActive: boolean;
  /** 当前实际成交价（= promoActive ? promoPrice : price），只读，供后台核对用户侧看到的价 */
  effectivePrice: number;
  hidden: boolean; sort: number; usageNormalPercent: number; usageNearPercent: number;
  autoRenewEnabled: boolean; wechatContractPlanId: string | null; autoRenewMode: 'delay_24h';
}
/** 新建套餐（POST /admin/plans，requireSuper）。period 只认 month/year；price 为分，-1=面议。 */
export interface AdminPlanCreate {
  /** 挂牌价（分）。-1=面议；优惠期内实际成交价见 promoPrice。 */
  name: string; price: number; period?: 'month' | 'year';
  planFamilyKey: string; tierRank: number; usageLevel: UsageLevel; usageLabel?: string;
  usageNormalPercent?: number; usageNearPercent?: number;
  creditsPerMonth?: number; tokenQuotaPerMonth?: number; agentCount?: number;
  featuresJson?: string[]; highlighted?: boolean; hidden?: boolean; sort?: number;
  autoRenewEnabled?: boolean; wechatContractPlanId?: string | null; autoRenewMode?: 'delay_24h';
  /** 优惠价（分）。null / 省略 = 取消优惠；必须 1 ≤ promoPrice < price，且只能配在正价档上。 */
  promoPrice?: number | null;
  /** 优惠生效时间（ISO）；null = 立即生效。可预配未来生效的调价。 */
  promoStartsAt?: string | null;
  /** 优惠结束时间（ISO）；null = 长期有效。到点自动回到挂牌价，无需人工操作。 */
  promoEndsAt?: string | null;
  /** 活动名（≤20 字，仅展示） */
  promoLabel?: string | null;
  /** 编辑同一商业档的月付/年付时，原子同步月度权益与公开用量配置。 */
  syncFamilyBenefits?: boolean;
}
/** 改档（PATCH /admin/plans/:id，requireSuper）：全字段可选，只改传入的。 */
export type AdminPlanUpdate = Partial<AdminPlanCreate>;
export interface AdminQuotaAdjustment {
  id: string; delta: number; reason: string; operatorId: string | null;
  startsAt: string; expiresAt: string | null; revokedAt: string | null;
}
export interface AdminUserQuotaView {
  userId: string; planId: string | null; planName: string | null;
  quota: number; used: number; remaining: number; periodKey: string;
  adjustments: AdminQuotaAdjustment[];
}
export interface AdminQuotaAdjustRequest { delta: number; reason: string; expiresAt?: string | null; }
export type PlanRelation = 'available' | 'current' | 'renew' | 'upgrade' | 'billing_change' | 'downgrade' | 'enterprise';
export type PlanAction = 'buy' | 'renew' | 'upgrade' | 'change_billing' | 'remind' | 'contact' | 'continue_payment' | 'wait_applied';
export interface PlanOption {
  plan: Plan;
  relation: PlanRelation;
  action: PlanAction;
  canPurchase: boolean;
  reason?: string;
  expiresAt?: string | null;
  resetsAt?: string;
  pendingOrder?: PayOrderListItem;
  recommended?: boolean;
}
export interface PlanOptionsResult {
  currentPlanId: string | null;
  usage: PublicUsageView;
  options: PlanOption[];
  subscription: AutoRenewSubscriptionView | null;
}
export type AutoRenewSubscriptionStatus = 'pending' | 'active' | 'cancel_pending' | 'cancelled' | 'failed';
export interface AutoRenewSubscriptionView {
  id: string; planId: string; planName: string; status: AutoRenewSubscriptionStatus;
  nextBillingAt: string | null; cancelledAt: string | null;
}
export interface AutoRenewCancelResult { ok: true; subscription: AutoRenewSubscriptionView; }
export interface PlanQuote {
  allowed: true;
  currentPlan: Plan | null;
  targetPlan: Plan;
  relation: PlanRelation;
  fullPrice: number;
  remainingDays: number;
  remainingValue: number;
  chargeAmount: number;
  effectiveAt: string;
  newExpiresAt: string | null;
  expiresAt: string;
  quoteFingerprint: string;
}
export type PlanFunnelEvent = 'page_open' | 'current_view' | 'renew_click' | 'upgrade_click' | 'billing_change_click'
  | 'downgrade_remind_click' | 'quote_success' | 'quote_failure' | 'quote_confirm' | 'payment_cancel'
  | 'payment_failure' | 'payment_success' | 'payment_pending' | 'entitlement_applied' | 'order_view' | 'order_continue'
  | 'auto_renew_select' | 'auto_renew_signed' | 'auto_renew_cancel';
export interface PlanPurchaseResult {
  ok: true;
  plan: Plan;
  creditBalance: number;
  grantedCredits: number;
  grantedTokens?: number; // 本次授予/重置的月度 token 额度
}
/** 小程序调起 wx.requestPayment 的参数（server 侧 RSA 签名产出）。 */
export interface WechatPayParams { timeStamp: string; nonceStr: string; package: string; signType: 'RSA' | 'MD5' | 'HMAC-SHA256'; paySign: string; }

/* ────────────── V7-12：单次付费商品（SKU） ────────────── */
// 2026-08-13 增购包：kind 扩 credits(钻石增购包)/quota(算力增购包)，数量在 metaJson.amount，
// 档位由运营后台自建（POST /admin/skus），不走 seedConfig 同步（对外定价归运营不归代码）。
export type SkuKind = 'module' | 'service' | 'storage' | 'credits' | 'quota';
/** 单次付费商品（GET /skus，公开）。kind=module 启用能力 | service 一次性服务 | storage 空间包
 *  | credits 钻石增购包 | quota 算力增购包（永久有效直到用完）。 */
export interface SkuView {
  key: string; name: string; desc: string; priceFen: number;
  kind: SkuKind; grantsModuleKey?: string | null;
  amount?: number; // 增购包数量：credits=钻石颗数；quota=算力 token 数（其余 kind 不带）
}
/** 下单结果（POST /skus/:key/order）。payParams 走 wx.requestPayment；demo=演示发放（未配支付时）；
 *  mock=测试期模拟支付单（PAY_MOCK_SUCCESS）：payParams 是占位值，端上必须跳过 wx.requestPayment，
 *  改调 POST /pay/mock/pay 触发到账，再复用 awaitPaymentApplied 轮询确认。 */
export interface SkuOrderResult { orderId: string; payParams?: WechatPayParams; demo?: boolean; mock?: true; }
/** 运营端 SKU 行（GET /admin/skus）。amount 仅增购包（credits/quota）非空 */
export interface AdminSku { id: string; key: string; name: string; desc: string; priceFen: number; kind: SkuKind; grantsModuleKey: string | null; amount?: number | null; enabled: boolean; sort: number; }
/** 运营端更新 SKU（PATCH /admin/skus/:key）：改价/启停/展示；amount 仅增购包可改（改动只影响新订单，已下单走快照）。
 *  key 与 kind/grantsModuleKey 不在此改（module/service/storage 走代码目录；增购包 kind 建档时定死）。 */
export interface AdminSkuUpdate { name?: string; desc?: string; priceFen?: number; amount?: number; enabled?: boolean; sort?: number; }
/** 运营端新建增购包（POST /admin/skus）：仅 credits/quota 两种 kind；key 服务端生成。
 *  amount：credits=钻石颗数；quota=算力 token 数。priceFen>0（免费发放走用户运营写口，不建 0 元商品）。 */
export interface AdminSkuCreate { kind: 'credits' | 'quota'; name: string; desc?: string; priceFen: number; amount: number; enabled?: boolean; sort?: number; }

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
  pay: WechatPayParams;
  // 月→年升级折算明细（applies=true 时前端可展示「已抵扣 ¥X」）。
  proration?: { applies: boolean; fullPrice: number; remainingDays: number; remainingValue: number; chargeAmount: number };
  /** 测试期模拟支付单（PAY_MOCK_SUCCESS）：pay 是占位值，端上跳过 wx.requestPayment，改调 POST /pay/mock/pay。 */
  mock?: true;
  /** true 表示本单使用官方「支付中签约」；微信支付页仍由用户主动选择是否开通，不能默认勾选。 */
  autoRenewRequested?: true;
}
/** 支付订单状态（GET /pay/orders/:outTradeNo）：requestPayment 成功后前端轮询用；
 *  未发放且已配支付时服务端会先主动查单补账，消除回调竞态。 */
export interface PayOrderStatus {
  outTradeNo: string;
  status: 'created' | 'paid' | 'applied' | 'failed' | 'closed' | 'refunded';
  amount: number; // 应付金额（分）
  planId?: string; // 套餐订单
  skuKey?: string; // SKU 订单
  paidAt?: string;
  appliedAt?: string; // 有值 = 权益已发放，前端可停止轮询
  refundStatus?: 'refund_requested' | 'refund_processing' | 'refund_closed' | 'refund_abnormal' | 'refunded' | null;
  payableUntil?: string;
}
/** 我的支付订单列表（GET /pay/orders）：订单明细页展示 + 继续支付入口。 */
export interface PayOrderListItem extends PayOrderStatus {
  itemName: string; // 下单时快照的套餐/SKU 名（历史无快照单为兜底文案）
  createdAt: string;
  refundedAt?: string;
  payable: boolean; // created 且未过支付时限 → 可调 POST /pay/orders/:outTradeNo/pay-params 继续支付
  mock?: true; // 测试期模拟支付单（PAY_MOCK_SUCCESS）：未实际付款，前台需明示
}
export interface PayOrderListResult { items: PayOrderListItem[] }
/** 继续支付（POST /pay/orders/:outTradeNo/pay-params）：重签 wx.requestPayment 调起参数。
 *  mock=true 时 pay 是占位值，改调 POST /pay/mock/pay。 */
export interface PayRepayResult { ok: true; outTradeNo: string; pay: WechatPayParams; mock?: true }
/** 测试期模拟支付（POST /pay/mock/pay，仅 PAY_MOCK_SUCCESS 且未配真凭据时可用）：
 *  等价于「用户点了支付且微信回调成功」，走真实 markPaidAndApply 发放权益。applied=false + reason
 *  多为幂等重复调用（already_applied），端上仍应按成功处理并轮询订单状态。 */
export interface PayMockPayResult { ok: boolean; applied: boolean; reason?: string; status: string }

export type WechatSubscribeScene = 'review' | 'report' | 'payment' | 'avatar' | 'poster';
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
/** 附身登录（impersonation）签发结果（POST /admin/users/:id/impersonate；仅 owner/master）。 */
export interface AdminImpersonateResult {
  token: string;            // 目标用户的登录态 token（配 APP_JWT_SECRET → 2h JWT；否则 = 明文 userId）
  expiresAt: string | null; // ISO 失效时间；未配 APP_JWT_SECRET 时为 null（明文 token 不过期）
  warning?: string;         // 未配 APP_JWT_SECRET 时的安全提示
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
export interface AdminUserPlanStatus {
  planName: string | null; expiresAt: string | null; daysLeft: number | null; status: string;
  subscription: { id: string; status: AutoRenewSubscriptionStatus; nextBillingAt: string | null; planName: string } | null;
}
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
export interface AdminPaymentItem {
  orderNo: string; // 尾 6 位（列表紧凑展示）
  outTradeNo: string; // 完整商户单号（微信商户平台查单/对账用）
  userName: string; amount: number; status: string; attrSource: string | null; paidAt: string | null; createdAt: string;
  mock: boolean; // 测试期模拟支付单（PAY_MOCK_SUCCESS）：无真实资金，已从 summary 营收金额里排除
}
/** 需要运营关注的异常单：paid_unapplied=收钱未发权益（资损，可一键查单补账）；created_stale=超时未支付（等 sweep 关单或人工核实）。 */
export interface AdminPaymentStuckItem {
  outTradeNo: string; userName: string; amount: number; status: string;
  kind: 'paid_unapplied' | 'created_stale';
  provider: string; planId: string; skuKey: string | null;
  paidAt: string | null; createdAt: string;
  mock: boolean; // 测试期模拟支付单：不是资损，也不需要查单补账
}
export interface AdminPaymentsView {
  // paidAmount / paidCount / byDay 只统计真实微信收款（provider='wechat'）——
  // 模拟支付单与沙箱单不进营收金额，否则测试期的假钱会污染经营看板。
  summary: { paidAmount: number; paidCount: number; byDay: { day: string; amount: number }[] }
  items: AdminPaymentItem[]
  stuck: AdminPaymentStuckItem[]
  total: number; // 当前筛选（days/status/q）下的订单总数（items 为其中一页）
  page: number;
  pageSize: number;
}
/** POST /admin/payments/:outTradeNo/reconcile 手动查单补账结果 */
export interface AdminPayReconcileResult { ok: boolean; applied: boolean; reason?: string; tradeState?: string; status: string }
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
  userId: string;
  userName: string | null;
  userPhone: string | null;
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
  agentName: string | null;
  versionId?: string | null; // P1-A1：产出所用版本，便于按版本归因质量回归
  userId: string | null;
  userName: string | null;
  userPhone: string | null;
  tenantId: string | null;
  tenantName: string | null;
  sessionId: string | null;

  kind: string;        // deliverable | chat
  provider: string;    // openai | claude | mock | dify
  model: string;       // 本次实际命中端点的 model（不是全局激活配置的占位值）
  endpointId: string | null;
  endpointLabel: string | null; // 调用时快照；端点后续改名/删除也不影响历史排障
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
export interface LlmContextTrace {
  recallIntent: boolean;
  continuity?: {
    sessionId: string;
    lineageId: string | null;
    continuationOf: string | null;
    sourceSessionId: string | null;
    newChapter: boolean;
    chapterGapHours: number | null;
    inheritedChars: number;
  };
  history: {
    recentMessages: number;
    carryoverMessages: number;
    totalChars: number;
  };
  memories: Array<{
    id: string;
    source: string;
    score: number;
    createdAt: string;
  }>;
  // 会话摘要注入（批次 3）：本轮快照条目数与实际注入字符数（超 cap 丢类后的真实值），排障用；未注入则缺省。
  digest?: {
    items: number;
    injectedChars: number;
    status: SessionDigestStatus;
    coveredThroughMessageId: string | null;
    coveredThroughAt: string | null;
    pendingMessages: number;
  };
  routing?: {
    requestedOutput: RequestedOutput;
    deliveryMode: DeliveryMode;
    complexityScore: number | null;
    complexityReasons: string[];
    deliveryPlanId: string | null;
    stageKey: string | null;
    stageNumber: number;
  };
  images?: {
    imageCount: number;
    batchCount: number;
    completedBatches: number;
    skippedImageIndexes: number[];
    totalBytes: number;
  };
}
export interface AdminTraceDetail extends AdminTraceItem {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  promptText: string | null;
  responseText: string | null;
  context: LlmContextTrace | null;
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
  // A/B 实验开关（如 wence_entry）：kind 仍是 toggle，另在 payload.arms 存各臂权重。
  // 该类开关**未落库时默认关**（不能因为「行还没建」就把全量用户扔进实验），其余开关仍默认开。
  arms?: Record<string, number>;
}
/** 改开关（PATCH /admin/flags/:id）：toggle 传 enabled；number 传 value；实验开关可单独传 arms（只改 enabled 不清权重）。 */
export interface AdminFeatureFlagUpdate { enabled?: boolean; value?: number; arms?: Record<string, number> }

/** 告警通知渠道状态（GET/PUT /admin/monitor-notify）。webhook 加密落库，只回掩码，绝不回明文。 */
export interface AdminMonitorNotify {
  configured: boolean;        // 是否已配置飞书群机器人
  urlMasked: string | null;   // 掩码后的 webhook（…/bot/v2/hook/***xxxxxx）
  hasSecret: boolean;         // 是否启用了签名校验
}

/* ────────────── 调教沙盒（用草稿/某版本即时试跑，返回产出 + 诊断 trace） ────────────── */
export type SandboxTarget = 'draft' | 'published' | { versionId: string };
export interface SandboxProfile { companyName?: string; industry?: string; stage?: string; pain?: string }
export interface EvalConversationTurn { role: 'user' | 'assistant'; text: string }
/** 评测用例可模拟一段真实客户关系，而不只是四个档案字段。 */
export interface EvalCaseContext extends SandboxProfile {
  history?: EvalConversationTurn[];
  memories?: string[];
  understanding?: string[];
  digestItems?: SessionDigestItem[];
}
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
export interface EvalCaseItem { id: string; input: string; rubric: string | null; weight: number; sort: number; context?: EvalCaseContext | null }
export interface EvalSetItem { id: string; agentKey: string; name: string; caseCount: number; createdAt: string }
export interface EvalSetDetail extends EvalSetItem { cases: EvalCaseItem[] }
export interface UpsertEvalSetRequest { name: string }
export interface UpsertEvalCaseRequest { input: string; rubric?: string; weight?: number; sort?: number; context?: EvalCaseContext | null }
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

/** 每日战报内嵌页（GET /cards/daily）：只向当前登录用户返回当天经营账本，
 *  不生成 ReportHtml、不返回公开链接，也不提供分享态。 */
export interface DailyBattleOrder {
  id: string;
  text: string;
  done: boolean;
  aligned: boolean | null;
}
export interface DailyBattleReportView {
  date: string;
  casefileTitle: string | null;
  rank: string;
  streak: number;
  orders: DailyBattleOrder[];
  done: number;
  total: number;
  aligned: number;
  alignRate: number | null;
  backfill: { leads: number; consults: number; deals: number } | null;
  quote: string;
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

/**
 * 军令上的「兵器」（2026-08-12）：这条军令能由哪个工具承接。
 *
 * 产生方式：拆军令的那一次 LLM 调用顺带从【可开方工具表】里选一个 toolKey——**同一次调用既写出军令
 * 文案又选工具，绑定天生 1:1**，不靠事后按下标或按位置对齐（此前端上是按位置拼的，属展示层凑数）。
 * 展示物料（name/line/跳转方式）一律由服务端读运营目录填充，模型只发 key：文案与定价口径归运营，
 * 且工具停用后立刻不再下发（resolve 不到就是 null，端上自然不渲染）。
 */
export interface OrderWeapon {
  /** 运营目录里的 key：启用的 Agent.key 或启用的 EcoTool.id。端上只用于埋点，不据它决定文案。 */
  key: string;
  /** 展示名，服务端从目录取。 */
  name: string;
  /** 一句「能替你干什么」。 */
  line: string;
  /** agent = 进这位军师的对话；external = 跳外部小程序（appId/path）。 */
  kind: 'agent' | 'external';
  appId?: string | null;
  path?: string | null;
}
export interface OrderMetric { label: string; value: string; }
export interface OrderStructuredFields {
  ownerName?: string | null;
  dueAt?: string | null;
  etaMinutes?: number | null;
  sourceQuote?: string | null;
  steps?: string[];
  metrics?: OrderMetric[];
  actionType?: OrderActionType;
  /** 完成回填：用户打卡后录入的完成情况（如「邀约发出 30 条 / 到店 12 人」），复盘与后续建议据此分析。 */
  resultNote?: string | null;
  /** 这条军令配的兵器；没配、或配的工具已停用则为 null（端上不渲染兵器条）。 */
  weapon?: OrderWeapon | null;
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
  scene: WechatSubscribeScene;  // 该提醒实际走的订阅模板场景（服务端唯一口径，前端不再自行映射）
  canSubscribe: boolean;        // 该场景模板已配置 → 可引导授权
}
export interface ReminderView {
  items: ReminderItem[];
  subscribeReady: boolean; // 是否至少一条提醒可订阅（= items.some(canSubscribe)）
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

/* ────────────── 快出片视频子应用（军师 BFF ↔ aidrama clip） ────────────── */
export type ClipSegmentRole = 'avatar' | 'broll' | 'tail';
export interface ClipSegment {
  no: number;
  text: string;
  role: ClipSegmentRole;
  hint?: string | null;
  durationSec?: number;
  actualDurationSec?: number;
  assetId?: string | null;
  assetLabel?: string | null;
  brollSource?: 'user' | 'preset' | null;
  replaceable?: boolean;
}
/** 文案仍按句编辑；镜头只记录一段连续句子的画面安排，避免“一句话切一次画面”。 */
export interface ClipShot {
  id: string;
  startNo: number;
  endNo: number;
  role: ClipSegmentRole;
  assetId?: string | null;
  assetLabel?: string | null;
  brollSource?: 'user' | 'preset' | null;
  hint?: string | null;
}
export interface ClipScriptMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  at?: string;
  applied?: boolean;
}
export interface ClipSubtitleStyle {
  /** 成片右上角“AI 生成”可见水印；缺省与 false 均表示关闭。 */
  aiWatermark?: boolean;
  [key: string]: unknown;
}
/**
 * 成片封面：一张 720x1280 的图，拼在成片最前面当第一帧，供抖音等平台抓取做缩略图。
 * 只占 1~2 帧，不影响视频内容与时长。可选步骤 ——
 * enabled 非 true，或四个文本槽位全空，出片时就不加封面。
 * 文案字数上限与 AIStar 的 ClipCoverTemplate 槽位一致，服务端会再截一次。
 */
export interface ClipCoverConfig {
  enabled?: boolean;
  /** 版式模板 id；未知值回落主模板 cover_shiti。 */
  templateId?: string;
  /** 顶部书法大字关键词，2 字。 */
  keyword?: string;
  /** 白底黑字账号名标签。 */
  handle?: string;
  /** 居中两行标语，白色粗体 + 黑描边。 */
  sloganLines?: string[];
  /** 落款金句，金色渐变粗体，比标语更大。 */
  signature?: string;
  /** 自传底图素材 id；留空则从成片抽一帧。 */
  backgroundAssetId?: string | null;
  /** 底图取自哪一句（segment.no）；0 表示服务端挑形象出镜段。 */
  backgroundSourceNo?: number;
  [key: string]: unknown;
}
export interface ClipTemplate {
  id: string; name: string; industry: string; themeKey: string; description: string;
  estDurationSec: number; avatarSecHint: number; creditHint?: number | null; segmentCount: number;
  coverTone?: string | null; scriptSkeleton?: { segments: ClipSegment[]; variables?: Array<{ key: string; label: string; placeholder?: string; required?: boolean }> };
  tailLabel?: string | null; tailDurationSec?: number; tailAssetId?: string | null;
  tailPreviewUrl?: string | null; tailVideoUrl?: string | null;
}
export interface ClipProject {
  id: string; templateId: string; templateName?: string; title: string;
  status: 'draft' | 'generating' | 'done' | 'failed';
  variables: Record<string, string>; segments: ClipSegment[];
  shots?: ClipShot[]; scriptChat?: ClipScriptMessage[];
  avatarId?: string | null; voiceId?: string | null; step?: number; updatedAt?: string | number;
  subtitleStyle?: ClipSubtitleStyle | null;
  cover?: ClipCoverConfig | null;
}
export interface ClipScriptChatResult { reply: string; applied: boolean; project: ClipProject; }
export interface ClipEstimateItem { key: string; label: string; credits: number; freeText?: string; }
export interface ClipEstimate {
  items: ClipEstimateItem[];
  total: number;
  summary: { totalSec: number; avatarSec: number; tailSec: number; avatarCount: number; brollCount: number; tailCount: number; chars: number };
}
export interface ClipRenderRequest {
  clientRequestId: string;
  /** 用户在确认页实际看见并确认的服务端报价；BFF 重算不一致时拒绝扣费。 */
  expectedCredits: number;
}
export interface ClipRenderResult { jobId: string; projectId: string; status: string; creditsHeld: number; reused?: boolean; }
export interface ClipJobView {
  id: string; status: 'queued' | 'generating' | 'assembling' | 'succeeded' | 'failed' | 'cancelled';
  stage?: string; progress?: number; workId?: string | null; errorMessage?: string | null;
}
/** 素材库存储占用（GET /video/assets/storage）。预置素材由平台提供，不计入用户配额。 */
export interface ClipAssetStorage { usedBytes: number; limitBytes: number; count: number; }
/**
 * 端上看到的存储视图。limitBytes 已经把用户买过的扩容包算进去了。
 *
 * 口径：**素材与作品共用一份额度**，已用量按总量向上取整到整 MB
 * （不按单文件取整——那会让一堆小图凭空吃掉半个额度）。
 */
export interface ClipStorageView extends ClipAssetStorage {
  /** 默认额度（不含扩容），用于告诉用户「基础空间有多大」 */
  baseBytes: number;
  /** 已购扩容合计字节 */
  purchasedBytes: number;
  /** 已购包数 / 上限 */
  packs: number;
  maxPacks: number;
  /** 一个扩容包给多少字节、扣多少钻石 */
  packBytes: number;
  packCredits: number;
  /** 定价是否经运营核定。false = 当前是代码兜底价 */
  configured: boolean;
}
export interface ClipAsset {
  id: string; label: string; tag?: string | null; kind: 'video' | 'image' | 'bgm'; durationSec?: number; usedCount?: number;
  /** 文件字节数；素材列表的大小标签与容量条都读它。上游恒发（Java 侧是 long），本地 mock 不发。 */
  bytes?: number;
  /**
   * 像素宽高。**字段缺失 = 未知**（历史素材，或服务端 ffprobe 读不出）。
   * 上传视频的分辨率决定成片分辨率，所以这是用户要看见的画质凭据。
   * 消费方必须把「缺字段」渲染成不显示，**不得回退成 0** —— 「0×0」是把「没测到」说成「0 像素」。
   */
  width?: number | null; height?: number | null;
  /** 列表封面：图片原图或视频抽帧 JPEG。 */
  previewUrl?: string | null;
  /** 用户主动点开预览时才使用的原始媒体签名地址。 */
  contentUrl?: string | null;
}
/**
 * 克隆类动作的钻石单价（GET /video/clone-pricing）。真源是运营后台的 FeatureFlag 行
 * 'video-clone-pricing'，端上**只显示不计算**，更不许自带一份常量。
 * 服务端形状定义在 server/src/services/video/pricing.ts 的 ClonePricing。
 */
export interface ClipClonePricing {
  /** 新训练一条专属声音。供应商侧最贵的单次动作。 */
  voiceCreate: number;
  /** 重训已有声音；供应商免费不等于我方免费，按低价收。 */
  voiceRetrain: number;
  /** 上传视频训练数字人。 */
  avatarVideo: number;
  /** 单张图片训练数字人（低成本入口）。 */
  avatarImage: number;
  /** 四档是否都由运营配过。false = 当前用的是代码兜底价，端上口径要说软一点。 */
  configured: boolean;
}
/**
 * 运营后台读到的克隆定价（GET /admin/video/clone-pricing）。
 *
 * **与 C 端视图同形，这是有意的**：定价没有需要脱敏的字段 —— 不像 AdminCreativeConfig 要把
 * 供应商 apiKey 压成 hasKey。后台和端上看到的必须是同一组数字，否则「后台显示 200、端上扣 60」
 * 这种事没人能第一时间发现。真要分家时再拆成独立 interface，别为了对称先拆。
 *
 * `configured=false` 在后台的含义比端上更重：它表示这四个数字还是 pricing.ts 里
 * `TODO(定价待运营核定)` 的兜底价，没有任何商务结论背书。后台必须把这件事显式写在页面上。
 */
export type AdminClonePricing = ClipClonePricing;
/**
 * 后台写入形状（PUT /admin/video/clone-pricing，仅 owner/master）。
 *
 * 去掉 `configured`：它是**派生**的（= 四档在库里都有合法值），不是可写字段。若允许运营直接置位，
 * 「运营核定过」这个唯一凭据就会与实际库内容脱钩。
 *
 * 虽然类型上四档都可选（PATCH 语义：未给的保持原值），但服务端有一条额外约束：
 * **首次配置（当前 configured=false）必须四档一起给**。原因见 pricing.ts —— 只改一档会把另外
 * 三档没人核定过的兜底价一并升格成「运营配过的价」，等于用一次改价给三个占位数字盖了章。
 */
export type AdminClonePricingUpdate = Partial<Omit<ClipClonePricing, 'configured'>>;
export interface ClipWork {
  id: string; projectId?: string | null; title: string; status: 'generating' | 'done' | 'published';
  durationSec: number; avatarSec: number; credits?: number; videoUrl?: string | null; thumbnailUrl?: string | null;
  /** 本次生成任务创建时间；生成中的作品据此显示开始时间。 */
  createdAt: string;
  /** 成片实际完成时间；生成中为空，历史兼容数据可由服务端用最后更新时间补齐。 */
  generatedAt?: string | null;
  aiWatermark?: boolean;
}
export interface ClipWorkDeleteResult { ok: boolean; cancelledJobIds: string[]; }
export interface ClipAvatarView {
  id: string; name: string;
  imageStatus: 'none' | 'training' | 'ready' | 'failed'; voiceStatus: 'none' | 'training' | 'ready' | 'failed';
  /** video=形象视频原声生成的基础声音；dedicated=用户主动补录的专属声音。 */
  voiceSource?: 'video' | 'dedicated' | null;
  /** 用户上传/拍摄的形象视频抽帧；用于确认当前训练的是哪一个本人形象。 */
  imagePreviewUrl?: string | null;
  imageTrainedText?: string | null; voiceTrainedText?: string | null;
  imageProgress: number; voiceProgress: number;
  imageMessage?: string | null; voiceMessage?: string | null;
  engine?: string | null; presetAvailable?: boolean;
  linkedVoiceId?: string | null; linkedVoiceName?: string | null;
}
export interface ClipVoiceView {
  id: string; name: string; status: 'none' | 'training' | 'ready' | 'failed';
  source?: 'video' | 'dedicated' | null; trainedText?: string | null; progress: number;
}
export interface ClipCaptureRule {
  kind: 'consent' | 'avatar' | 'voice';
  vendorMinDurationSec: number; vendorMaxDurationSec: number; minDurationSec: number;
  recommendedMinDurationSec: number; recommendedMaxDurationSec: number; maxDurationSec: number;
  vendorMaxBytes: number; maxBytes: number; vendorFormats: string[]; formats: string[];
  codec?: string | null; minShortSidePx?: number | null; maxLongSidePx?: number | null;
  sampleRateHz?: number | null; channels?: number | null; guidance: string[];
}
export interface ClipCaptureRequirements {
  /** 石榴 authId 是可选校验项；当前直传创建链路不要求另录授权视频。 */
  authorizationVideoRequired: boolean;
  consentText: string; agreementTitle: string; officialDocsLastReviewed: string; officialDocs: string[];
  consent: ClipCaptureRule; avatar: ClipCaptureRule; voice: ClipCaptureRule; pollIntervalMs: number;
}
export interface ClipConsentResult { id: string; status: 'submitted' | 'verified' | 'rejected'; accepted: boolean; verified: boolean; }
export interface ClipAuditEntry { id: string; createdAt?: string; createdText?: string; scope?: string; action?: string; status: string; }
