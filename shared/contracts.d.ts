// 军师 · 全栈数据契约（SSOT）
// 前端(app) / 后端(server) / 运营端(admin) 的统一数据口径，唯一事实来源。
// 这是纯类型声明（.d.ts）：编译期类型、运行时擦除，各端只用 `import type` 引用，
// 不引入任何运行时依赖，也不会改变任何一端的打包产物。

/* ────────────── 智能体 ────────────── */
export type AgentType = 'general' | 'advisory' | 'creative' | 'custom';
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
  enabled: boolean;
  greet: string;
  chips: [string, string][]; // [icon, label]
  memText: string;
  learnText: string;
  deliverableKey: string | null;
}

/** 运营端列表项（GET /admin/agents） */
export interface AdminAgent {
  key: string; name: string; role: string; icon: string; type: string;
  gift: boolean; enabled: boolean; deliverableKey: string | null;
}

/** 运营端详情（含 System 提示词 + Agent Memory） */
export interface AgentDetail {
  key: string; name: string; role: string; icon: string; type: string;
  enabled: boolean; systemPrompt: string; memoryConfig: MemoryConfig; deliverableKey: string | null;
}

/* ────────────── 账号 / 用户 ────────────── */
export interface AiInfo { provider: string; model: string; ready?: boolean; claudeReady?: boolean; }

export interface Me {
  user: { id: string; name: string; role: string; benmingColor: string };
  tenant: { id: string; name: string; industry?: string | null; stage?: string | null };
  plan: { name: string; creditsPerMonth: number } | null;
  creditBalance: number;
  onboarded?: boolean;
  ai: AiInfo;
}

export interface LoginRequest { phone: string; name?: string; code?: string; }
export interface LoginResult {
  token: string; isNew: boolean; onboarded: boolean;
  user: { id: string; name: string; phone: string; benmingColor: string };
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
