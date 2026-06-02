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
}
export interface SessionMessage { id: string; role: string; content: any; at: string; }
export interface SessionDetail {
  id: string; agentKey: string;
  agent: { key: string; name: string; role: string; icon: string; greet: string; chips: [string, string][]; memText: string; learnText: string };
  title: string;
  messages: SessionMessage[];
}

/* ────────────── 产出请求 / 结果 ────────────── */
export interface GenRequest { text: string; agentKey?: string; sessionId?: string; }
export interface GenResult {
  sessionId: string; created: boolean; agentKey: string;
  kind: 'report' | 'chat'; messageId: string;
  deliverable?: Deliverable; reply?: ChatReply;
  memory?: { learned: boolean; agentName: string } | null;
}

/* ────────────── 方案库 ────────────── */
export interface LibItem {
  id: string; title: string; type: string; agentKey: string; agentName: string;
  sessionId: string | null; content: Deliverable; at: string;
}
export interface SaveLibRequest { title: string; type: string; agentKey: string; sessionId?: string; content: object; }

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
