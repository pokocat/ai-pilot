import { prisma } from '../db.js';
import { isAiTestMode } from '../env.js';
import { decryptSecretSafe } from './secretBox.js';
import { verifyUserToken } from './userToken.js';
import { INDUSTRY_BENCHMARK } from '../data/seedConfig.js';
import { recallMemories } from './memory.js';
import { hybridSearch, resolveReferences } from './retrieval.js';
import { buildClientUnderstanding, meaningfulCustomerLabel, understandingContextLines } from './understanding.js';
import type { GenContext, MessageRef, AgentRuntime } from '../llm/schema.js';
import type { MemoryConfig } from '../data/agents.js';
import { resolveEffectiveAgent, type EffectiveAgentConfig, type PreviewTarget } from './agentVersions.js';

// 把 Agent 的「接入方式」解析成运行时覆盖。inherit / 未配置完整 → null（走全局模型）。
function resolveAgentRuntime(
  agent: { providerMode: string; apiBaseUrl: string | null; apiModel: string | null; apiTemperature: number | null; apiKey: string | null; difyBaseUrl: string | null; difyApiKey: string | null; difyInputs: unknown; skillsConfig: unknown },
  opts: { userId: string; sessionId?: string | null; difyConversationId?: string | null },
): AgentRuntime | null {
  if (isAiTestMode()) return null; // 测试不走 per-agent 真实接入（openai/dify），回退全局 mock
  if (agent.providerMode === 'openai') {
    if (!agent.apiBaseUrl || !agent.apiKey) return null; // 配置不全则回退全局
    return {
      mode: 'openai',
      baseUrl: agent.apiBaseUrl,
      model: agent.apiModel ?? undefined,
      temperature: agent.apiTemperature ?? undefined, // P2-7
      apiKey: decryptSecretSafe(agent.apiKey),
      skills: (agent.skillsConfig as AgentRuntime['skills']) ?? null,
    };
  }
  if (agent.providerMode === 'dify') {
    if (!agent.difyBaseUrl || !agent.difyApiKey) return null; // 配置不全则回退全局
    return {
      mode: 'dify',
      difyBaseUrl: agent.difyBaseUrl,
      difyApiKey: decryptSecretSafe(agent.difyApiKey),
      difyInputs: (agent.difyInputs as Record<string, string> | null) ?? {},
      user: opts.userId,
      sessionId: opts.sessionId ?? null,
      conversationId: opts.difyConversationId ?? null,
    };
  }
  return null; // inherit
}

function unauthorized() {
  return Object.assign(new Error('未登录或登录已失效'), { statusCode: 401, code: 'UNAUTHORIZED' });
}

function isBriefInterviewRequest(text: string): boolean {
  return /(?:个人|军师)档案访谈模式|(?:补齐|完善|更新)(?:个人|军师)档案|让军师来问/.test(text);
}

/**
 * 解析当前用户：token（x-user-id 头，值为 userId）必须有效。
 * 不再回退 demo 用户——保证账号间数据隔离；无 token 或失效一律 401。
 */
export async function resolveUser(token?: string) {
  const id = verifyUserToken(token); // JWT→sub / 历史 token→userId 原样（见 userToken.ts）
  if (!id) throw unauthorized();
  const u = await prisma.user.findUnique({ where: { id }, include: { tenant: true } });
  if (!u) throw unauthorized();
  return u;
}

export async function buildGenContext(opts: {
  userId: string;
  tenantId: string;
  agentKey: string;
  userMessage: string;
  history?: { role: string; text: string }[];
  projectId?: string | null;       // 归属项目 → 注入项目背景 + 项目内知识召回
  refs?: MessageRef[];             // 显式 @ 引用 → 高优先注入、可溯源
  sessionId?: string | null;       // Dify 多轮回写所需
  difyConversationId?: string | null; // 已存在的 Dify 会话 id（多轮续接）
  preview?: PreviewTarget;         // 沙盒/评测：用草稿或指定版本（默认走已发布版本）
  effective?: EffectiveAgentConfig; // 调用方已解析好的有效配置（避免重复解析、保证与计费一致）
}): Promise<{ ctx: GenContext; memoryConfig: MemoryConfig; knowledgeUsed: string[]; effective: EffectiveAgentConfig }> {
  // C 端默认读 Agent.publishedVersionId 指向的已发布快照（resolveEffectiveAgent）；
  // 草稿/历史版本由 opts.preview 指定（沙盒、评测、AB）。调用方可传 opts.effective 复用。
  const effective = opts.effective ?? (await resolveEffectiveAgent(opts.agentKey, opts.preview));
  if (!effective) throw new Error(`未知智能体：${opts.agentKey}`);
  const profile = await prisma.profile.findFirst({ where: { tenantId: opts.tenantId }, orderBy: { updatedAt: 'desc' } });
  const user = await prisma.user.findUnique({ where: { id: opts.userId } });
  const tenant = await prisma.tenant.findUnique({ where: { id: opts.tenantId }, select: { name: true } });
  const understanding = user
    ? await buildClientUnderstanding({ id: user.id, tenantId: opts.tenantId, name: user.name })
    : null;

  const memoryConfig = effective.memoryConfig as unknown as MemoryConfig;
  const briefInterview = isBriefInterviewRequest(opts.userMessage);
  // 长期记忆：按当前问题做语义召回；后台关闭 longTerm 后不再注入既有记忆。
  const memories = memoryConfig.longTerm && !briefInterview
    ? await recallMemories(opts.userId, opts.agentKey, 5, opts.userMessage)
    : [];

  // 项目背景
  let projectName: string | null = null;
  let projectSummary: string | null = null;
  if (opts.projectId && !briefInterview) {
    const proj = await prisma.project.findFirst({ where: { id: opts.projectId, tenantId: opts.tenantId } });
    if (proj) { projectName = proj.name; projectSummary = proj.summary ?? null; }
  }

  // 显式引用（可溯源）+ 知识库混合检索（自动召回，项目内优先）
  const { lines: refLines, labels: refLabels } = briefInterview
    ? { lines: [], labels: [] }
    : await resolveReferences(opts.tenantId, opts.userId, opts.refs);
  const hits = briefInterview
    ? []
    : await hybridSearch({ tenantId: opts.tenantId, userId: opts.userId, projectId: opts.projectId ?? undefined, query: opts.userMessage, topK: 4 });
  const knowledge = hits.map((h) => `【知识：${h.item.title ?? h.item.kind}】${h.snippet}`);
  const knowledgeUsed = [...refLabels, ...hits.map((h) => h.item.title ?? h.snippet.slice(0, 20))];

  const ctx: GenContext = {
    agentKey: effective.key,
    versionId: effective.versionId,
    agentName: effective.name,
    systemPrompt: effective.systemPrompt,
    deliverableKey: effective.deliverableKey,
    companyName: meaningfulCustomerLabel(tenant?.name) || null,
    profile: profile ? { industry: profile.industry, stage: profile.stage, pain: profile.pain } : null,
    memories,
    benmingColor: user?.benmingColor ?? 'gold',
    benchmark: INDUSTRY_BENCHMARK,
    userMessage: opts.userMessage,
    history: opts.history,
    references: refLines,
    knowledge,
    projectName,
    projectSummary,
    understanding: understanding ? understandingContextLines(understanding) : [],
    understandingQuestions: understanding?.nextQuestions ?? [],
    understandingMaturity: understanding?.maturity ?? 'empty',
    briefInterview,
    tenantId: opts.tenantId,
    userId: opts.userId,
    projectId: opts.projectId ?? null,
    // 技能与接入方式解耦：所有 agent（含 inherit/全局模型）都带上自建技能配置（按已发布版本/草稿解析）
    skills: (effective.skillsConfig as GenContext['skills']) ?? null,
    runtime: resolveAgentRuntime(effective, { userId: opts.userId, sessionId: opts.sessionId, difyConversationId: opts.difyConversationId }),
  };
  return { ctx, memoryConfig, knowledgeUsed, effective };
}

/**
 * 运营调教沙盒上下文：用草稿/指定版本 + 模拟客户档案，构建一个「干净」的 GenContext
 * （不拉真实用户的记忆/知识/项目），让运营聚焦测「提示词 + 配置」本身的行为，结果可复现。
 */
export async function buildSandboxContext(opts: {
  agentKey: string;
  userMessage: string;
  target?: PreviewTarget; // 默认已发布版本；沙盒通常传 'draft'
  profile?: { companyName?: string; industry?: string; stage?: string; pain?: string };
}): Promise<{ ctx: GenContext; effective: EffectiveAgentConfig } | null> {
  const effective = await resolveEffectiveAgent(opts.agentKey, opts.target);
  if (!effective) return null;
  const p = opts.profile;
  const hasProfile = !!(p && (p.industry || p.stage || p.pain));
  const ctx: GenContext = {
    agentKey: effective.key,
    versionId: effective.versionId,
    agentName: effective.name,
    systemPrompt: effective.systemPrompt,
    deliverableKey: effective.deliverableKey,
    companyName: p?.companyName || null,
    profile: hasProfile ? { industry: p?.industry ?? null, stage: p?.stage ?? null, pain: p?.pain ?? null } : null,
    memories: [],
    benmingColor: 'gold',
    benchmark: INDUSTRY_BENCHMARK,
    userMessage: opts.userMessage,
    references: [],
    knowledge: [],
    understanding: [],
    understandingQuestions: [],
    understandingMaturity: 'empty',
    briefInterview: false,
    tenantId: null,
    userId: null,
    projectId: null,
    runtime: resolveAgentRuntime(effective, { userId: 'sandbox', sessionId: null, difyConversationId: null }),
  };
  return { ctx, effective };
}
