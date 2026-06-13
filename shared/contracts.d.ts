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

/** 对话/前端消费的公开智能体字段（GET /agents） */
export interface Agent {
  key: string;
  name: string;
  role: string;
  icon: string;
  type: AgentType;
  gift: boolean;
  billing: AgentBilling; // 计费模式
  price: number;         // 价格（算力次数）：unlock=解锁消耗；metered=每次产出消耗；free=0
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
  gift: boolean; billing: AgentBilling; price: number; enabled: boolean; deliverableKey: string | null;
  ownerCount?: number; sessionCount?: number; deliverableCount?: number; updatedAt?: string;
}

/** 运营端详情（含 System 提示词 + Agent Memory + 计费配置） */
export interface AgentDetail {
  key: string; name: string; role: string; icon: string; type: AgentType;
  gift: boolean; billing: AgentBilling; price: number;
  enabled: boolean; systemPrompt: string; memoryConfig: MemoryConfig; deliverableKey: string | null;
}

/** 运营端新增智能体入参（POST /admin/agents） */
export interface AdminAgentCreate {
  key: string; name: string; role: string; icon?: string; type?: AgentType;
  gift?: boolean; billing?: AgentBilling; price?: number; enabled?: boolean;
  greet?: string; deliverableKey?: string | null; systemPrompt?: string;
}
/** 运营端更新智能体入参（PATCH /admin/agents/:key） */
export interface AdminAgentUpdate {
  name?: string; role?: string; icon?: string; type?: AgentType;
  gift?: boolean; billing?: AgentBilling; price?: number; enabled?: boolean;
  greet?: string; deliverableKey?: string | null;
  systemPrompt?: string; memoryConfig?: MemoryConfig;
}

/* ────────────── 账号 / 用户 ────────────── */
export interface AiInfo { provider: string; model: string; ready?: boolean; claudeReady?: boolean; }

export type UnderstandingMaturity = 'empty' | 'forming' | 'ready';
export interface ClientUnderstandingSection {
  key: string;
  title: string;
  items: string[];
  emptyText?: string;
}
/** 前台「经营底稿」：把真实档案、记忆、项目和知识沉淀整理成客户可读的咨询理解 */
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

export interface Me {
  user: { id: string; name: string; role: string; benmingColor: string };
  tenant: { id: string; name: string; industry?: string | null; stage?: string | null };
  plan: { name: string; creditsPerMonth: number } | null;
  creditBalance: number;
  onboarded?: boolean;
  ai: AiInfo;
  understanding?: ClientUnderstanding;
}

export interface LoginRequest { phone: string; name?: string; code?: string; }
export interface AliasSuggestionResult { name: string; source: string; }
/** 更新身份（称呼 + 公司/品牌名）：首登建档 / 设置页 */
export interface UpdateIdentityRequest { name?: string; company?: string; }
export interface WechatLoginRequest { code: string; nickname?: string; avatarUrl?: string; }
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
  creditBalance?: number;   // 扣费后的算力余额（<0 表示不限量套餐；产出后回填，前端可即时刷新）
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
  updatedAt?: string;
}
/** 更新入参（apiKey 仅在传入时更新；留空表示不改） */
export interface AiConfigUpdate {
  provider?: AiProvider; label?: string; baseUrl?: string; model?: string;
  apiKey?: string; embeddingModel?: string; temperature?: number;
}
/** 预设：一键填好某家大模型的 baseUrl/model */
export interface AiPreset {
  id: string; label: string; provider: AiProvider;
  baseUrl: string; model: string; embeddingModel?: string; note?: string;
}
export interface AiConfigView { config: AiConfig; presets: AiPreset[]; }
export interface AiTestResult { ok: boolean; latencyMs?: number; sample?: string; error?: string; provider?: string; model?: string; }

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
  creditsPerMonth: number; agentCount: number; featuresJson: string[]; highlighted: boolean;
}
export interface PlanPurchaseResult {
  ok: true;
  plan: Plan;
  creditBalance: number;
  grantedCredits: number;
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
