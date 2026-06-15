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
}

/** 运营端读取的智能体接入配置（apiKey 脱敏为 has*，不回明文） */
export interface AgentRuntimeView {
  providerMode: AgentProviderMode;
  apiBaseUrl: string;   // 自定义 OpenAI 兼容 baseUrl，如 https://api.deepseek.com/v1
  apiModel: string;     // 自定义模型名，如 deepseek-chat
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
  apiKey?: string;
  difyBaseUrl?: string;
  difyApiKey?: string;
  difyInputs?: Record<string, string>;
  skills?: SkillsConfig;
}

/** agent 可勾选的工具元信息（GET /admin/skill-tools）：内置 + 启用的自定义工具 */
export interface SkillToolMeta {
  name: string;        // 工具 key（= skillsConfig.tools 里存的值）
  description: string;
  builtin: boolean;    // true=内置（search_knowledge…），false=运营自建
}

/** 自定义 HTTP 工具：后台读取视图（鉴权头脱敏为 headerKeys/hasHeaders） */
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
}

/** 运营端详情（含 System 提示词 + Agent Memory + 计费配置） */
export interface AgentDetail {
  key: string; name: string; role: string; icon: string; type: AgentType;
  gift: boolean; billing: AgentBilling; price: number; billingRatio: number; meterUnit: 'text' | 'image';
  enabled: boolean; systemPrompt: string; memoryConfig: MemoryConfig; deliverableKey: string | null;
  runtime: AgentRuntimeView; // 接入方式（跟随全局 / 自定义端点 / Dify 应用）
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
/** 前台「军师档案」：把真实档案、记忆、项目和知识沉淀整理成客户可读的咨询理解 */
export interface ClientUnderstanding {
  title: string;
  subtitle: string;
  maturity: UnderstandingMaturity;
  summary: string;
  sections: ClientUnderstandingSection[];
  nextQuestions: string[];
  evidenceCount: { profile: number; memories: number; projects: number; knowledge: number; sessions: number };
  updatedAt?: string | null;
}

/** 本月 token 额度（客户端「钻石管理」只看进度 %）。limit/remaining<0=不限量 */
export interface TokenQuotaView {
  limit: number;     // 本月授予总额度，-1=不限量
  used: number;      // 本月已用
  remaining: number; // 剩余（可为负=已耗尽）
  unlimited: boolean;
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
  user: { id: string; name: string; role: string; benmingColor: string };
  tenant: { id: string; name: string; industry?: string | null; stage?: string | null };
  plan: { name: string; creditsPerMonth: number; tokenQuotaPerMonth: number } | null;
  creditBalance: number; // 钻石(点)余额：解锁 / 图片按张
  tokenQuota: TokenQuotaView; // 本月 token 额度（文本产出消耗池）
  onboarded?: boolean;
  ai: AiInfo;
  understanding?: ClientUnderstanding;
}

export interface LoginRequest { phone: string; name?: string; code?: string; }
export interface AliasSuggestionResult { name: string; source: string; }
/** 更新身份（称呼 + 公司/品牌名）：首登建档 / 设置页 */
export interface UpdateIdentityRequest { name?: string; company?: string; }
/** 发送短信验证码（POST /auth/sms/send） */
export interface SmsSendRequest { phone: string; }
/** 发送结果：cooldownSec 倒计时、expiresInSec 有效期；devCode 仅演示口径回传，便于自动回填。 */
export interface SmsSendResult { cooldownSec: number; expiresInSec: number; devCode?: string; }
export interface WechatLoginRequest { code: string; nickname?: string; avatarUrl?: string; }
/** 本机号一键登录（POST /auth/wechat-phone）：phoneCode=getPhoneNumber 的 code；loginCode=wx.login 的 code（可选，用于关联 openid）。 */
export interface WechatPhoneLoginRequest { phoneCode: string; loginCode?: string; name?: string; }
export interface LoginResult {
  token: string; isNew: boolean; onboarded: boolean;
  user: { id: string; name: string; phone: string; benmingColor: string; wechatLinked?: boolean };
}

/* ────────────── 建档 ────────────── */
/** 公开问卷（GET /survey） */
export interface SurveyQuestion { key: string; title: string; options: string[]; }
/** 运营端问卷（GET /admin/survey） */
export interface SurveyAdmin { id: string; key: string; title: string; optionsJson: string[]; enabled: boolean; }
export interface Profile { industry?: string | null; stage?: string | null; pain?: string | null; extra?: unknown; }

/* ────────────── 结构化成果 ────────────── */
export interface DeliverableSection { h: string; b?: string; list?: string[]; }
export interface Deliverable {
  title: string; icon: string; meta: string;
  sections: DeliverableSection[]; trust: string; actions: string[];
  htmlUrl?: string; // 服务端渲染的可分享网页版报告链接（产出时生成）
}
/** 成果模板（mock 提供方 / few-shot 结构约束消费） */
export interface DeliverableTemplate { icon: string; title: string; sections: DeliverableSection[]; }

/* ────────────── 自由对话回复 ────────────── */
export interface ChatReply { text: string; points?: string[]; acts?: [string, string][]; }
export interface ReplyTemplate { t: string; points: string[]; acts: [string, string][]; }

/* ────────────── 会话 ────────────── */
export interface SessionItem {
  id: string; agentKey: string; agentName: string; agentIcon: string;
  title: string; snippet: string; updatedAt: string;
  projectId?: string | null; // 归属项目（无则散落）
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
  updatedAt?: string;
}
/** 添加/编辑模型入参（apiKey 仅在传入非空时更新；留空表示不改） */
export interface AiModelUpsert {
  provider: AiProvider; label: string; baseUrl?: string; model: string;
  apiKey?: string; embeddingModel?: string; temperature?: number; preset?: string | null;
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
  stats: { v: string; l: string; d: string; trend: string }[];
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
export interface AdminTokenUsageView {
  windowDays: number;
  totals: TokenUsageTotals;
  byModel: TokenUsageModelStat[];
  byDay: TokenUsageDayStat[];
  topUsers: TokenUsageUserStat[];
}
export interface AdminAuditItem {
  id: string;
  action: string;
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
