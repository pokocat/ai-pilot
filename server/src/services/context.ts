import { prisma } from '../db.js';
import { isAiTestMode } from '../env.js';
import { decryptSecretSafe } from './secretBox.js';
import { verifyUserToken } from './userToken.js';
import { resolveIndustryPack } from '../data/industryPacks.js';
import { recallMemories } from './memory.js';
import { hybridSearch, resolveReferences } from './retrieval.js';
import { buildClientUnderstanding, meaningfulCustomerLabel, understandingContextLines } from './understanding.js';
import { loadChart, chartBriefing, TIANSHI_OPTOUT_LINE } from './paipan.js';
import { loadStrategicProfile, strategicBlock, getDiagRound } from './strategicProfile.js';
import { goalsInjectionLine } from './casefile.js';
import { dataSourcesBlock } from './dataSources.js';
import { decisionBriefing } from './decisionLog.js';
import { reviewBriefing } from './reviewLog.js';
import { prophecyBriefing } from './prophecyLog.js';
import { prescriptionEffectBlock, pendingFollowupTools, toolMenu } from './prescription.js';
import { progressBriefing } from './progress.js';
import { resolveMode, modeDirective, detectInnerState, roleDirective, stageDirective } from './intent.js';
import { yearOf } from './clock.js';
import { isFeatureEnabled } from './featureFlag.js';
import { benchmarkBlock } from './benchmark.js';
import { bizMetricBlock } from './bizMetric.js';
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

export function isBriefInterviewRequest(text: string): boolean {
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
  sessionMode?: string | null;     // 会话粘性模式（M3 PR-11，路由传入 Session.mode）
}): Promise<{ ctx: GenContext; memoryConfig: MemoryConfig; knowledgeUsed: string[]; effective: EffectiveAgentConfig }> {
  // C 端默认读 Agent.publishedVersionId 指向的已发布快照（resolveEffectiveAgent）；
  // 草稿/历史版本由 opts.preview 指定（沙盒、评测、AB）。调用方可传 opts.effective 复用。
  const effective = opts.effective ?? (await resolveEffectiveAgent(opts.agentKey, opts.preview));
  if (!effective) throw new Error(`未知智能体：${opts.agentKey}`);
  const memoryConfig = effective.memoryConfig as unknown as MemoryConfig;
  const briefInterview = isBriefInterviewRequest(opts.userMessage);

  // 本轮导引意图（M3 PR-11/12/14）：全部确定性、纯 CPU；先算出来以决定是否需要拉诊断轮次。
  const { intent } = resolveMode(opts.userMessage, opts.sessionMode);
  const innerState = detectInnerState(opts.userMessage);
  // F-5：诊断轮次改读用户级持久化 diagRound（换/删会话不清零），写侧在 routes/sessions.ts bumpDiagRound。
  const needDiagRound = opts.agentKey === 'general' && intent.mode === 'strategy' && !briefInterview;
  // WO-14：周复盘 modeLine 要效果话术——仅周复盘轮拉取「已打标待追踪」处方工具名。
  const needFollowupNudge = intent.mode === 'review' && intent.reviewLayer === 'week';

  // P1-6：context 注入链原先 20+ 次串行 DB round-trip → 每条消息 25-35 次。
  // 改造：无依赖的取数一次性并发发起（下面两批），取回后再按固定顺序拼装——
  // 只并发取数、顺序拼装，注入块的文本与顺序完全不变（防 prompt 回归）。
  // 批次 1：只依赖 opts / effective 的取数（含各账本 briefing、记忆召回、引用、检索、项目、诊断轮次）。
  const [
    profile, user, tenant,
    strategicRaw, goalsLine, dataSourceLine,
    decisionLine, reviewLine, prophecyLine, progressLine,
    fortuneOn, diagRound,
    memories, projRow, refsResult, hits,
    prescriptionEffectLine, toolMenuLine, followupTools,
  ] = await Promise.all([
    prisma.profile.findFirst({ where: { tenantId: opts.tenantId }, orderBy: { updatedAt: 'desc' } }),
    prisma.user.findUnique({ where: { id: opts.userId } }),
    prisma.tenant.findUnique({ where: { id: opts.tenantId }, select: { name: true } }),
    // 战略档案（M1 PR-3）：客户已确认的战略事实，注入优先级高于自动推断。
    loadStrategicProfile(opts.userId),
    // V7-10 目标阶梯 + V7-07 已接入数据源清单（宁缺勿假，无则不注入）。
    goalsInjectionLine(opts.userId).catch(() => null),
    dataSourcesBlock(opts.userId).catch(() => null),
    // 决策/复盘/天机/段位账本（M2 PR-7~10）：服务端计数，AI 只引用禁止自算。
    decisionBriefing(opts.userId),
    reviewBriefing(opts.userId),
    prophecyBriefing(opts.userId),
    progressBriefing(opts.userId),
    // WO-05 命理全局开关（合规直读 DB）。
    isFeatureEnabled('fortune'),
    needDiagRound ? getDiagRound(opts.userId) : Promise.resolve(null),
    // 长期记忆：按当前问题语义召回；后台关闭 longTerm 或档案访谈模式不注入。
    memoryConfig.longTerm && !briefInterview
      ? recallMemories(opts.userId, opts.agentKey, 5, opts.userMessage)
      : Promise.resolve<Awaited<ReturnType<typeof recallMemories>>>([]),
    // 项目背景
    opts.projectId && !briefInterview
      ? prisma.project.findFirst({ where: { id: opts.projectId, tenantId: opts.tenantId } })
      : Promise.resolve(null),
    // 显式引用（可溯源）+ 知识库混合检索（自动召回，项目内优先）
    briefInterview
      ? Promise.resolve({ lines: [] as string[], labels: [] as string[] })
      : resolveReferences(opts.tenantId, opts.userId, opts.refs),
    briefInterview
      ? Promise.resolve<Awaited<ReturnType<typeof hybridSearch>>>([])
      : hybridSearch({ tenantId: opts.tenantId, userId: opts.userId, projectId: opts.projectId ?? undefined, query: opts.userMessage, topK: 4 }),
    // WO-14 月战报【处方效果】块（有 outcome 才注入）；WO-12【可开方工具表】（仅方案生成轮由 buildSystemParts 采用）。
    prescriptionEffectBlock(opts.userId).catch(() => null),
    toolMenu().catch(() => null),
    needFollowupNudge ? pendingFollowupTools(opts.userId).catch(() => []) : Promise.resolve<string[]>([]),
  ]);

  // 批次 2：依赖批次 1 的 profile / user / fortune 结果。
  const believe = fortuneOn && (((profile?.extraJson as { bazi?: { believe?: boolean } } | null)?.bazi?.believe) !== false);
  const [understanding, benchmarkLine, bizMetricLine, chart] = await Promise.all([
    user ? buildClientUnderstanding({ id: user.id, tenantId: opts.tenantId, name: user.name }) : Promise.resolve(null),
    // 行业基准（WO-08）：DB 分位数块（宁缺勿假）。
    benchmarkBlock(profile?.industry),
    // 经营序列（WO-10）：本周实报 + 与基准差（服务端算）。无填报不注入。
    bizMetricBlock(opts.userId, profile?.industry),
    // 天势档案（M1 PR-2）：命盘算好存库，这里只组装简报；不信命理/开关关闭 → 走 opt-out，无命盘 → 不注入。
    believe ? loadChart(opts.userId) : Promise.resolve(null),
  ]);

  const strategicLine = strategicBlock(strategicRaw);

  // 本轮导引拼装（顺序不变：模式 → 角色语气 → 诊断轮次；识别不出不注入）。
  const directives: string[] = [];
  const md = modeDirective(intent);
  if (md) directives.push(md);
  const rd = roleDirective(innerState);
  if (rd) directives.push(rd);
  if (needDiagRound && diagRound !== null) {
    directives.push(`诊断进度：第 ${diagRound} 轮（六轮深度对话制；客户要求加速时切 3 轮快速通道并说明）。`);
  }
  // WO-14：周复盘且有已开通满 7 天待追踪的处方 → 点名工具要一句效果（军师语汇，别问空泛的「感觉如何」）。
  if (needFollowupNudge && followupTools.length) {
    directives.push(`本周复盘顺带追一句效果：客户已开通「${followupTools.join('、')}」有些时日了，主动问这几件兵器落地后的实打实进展（发帖量／线索／成交），要具体数字别问感受。`);
  }
  const modeLine = directives.length ? `【本轮导引（系统识别；执行但不要向客户复述本块）】\n${directives.join('\n')}` : null;
  // 阶段适配（M3 PR-13）：按档案营收阶段切深浅。
  const stageLine = stageDirective(profile?.stage);

  // WO-05：命理开关关闭或客户不信 → 天势降级为禁令（不带命盘，复用 opt-out 口径）。
  const tianshiLine: string | null = !believe ? TIANSHI_OPTOUT_LINE : (chart ? chartBriefing(chart, yearOf()) : null);

  const projectName: string | null = projRow?.name ?? null;
  const projectSummary: string | null = projRow?.summary ?? null;

  const { lines: refLines, labels: refLabels } = refsResult;
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
    benmingColor: user?.benmingColor ?? 'green',
    benchmark: resolveIndustryPack(profile?.industry).benchmark,
    tianshiLine,
    strategicLine,
    goalsLine,
    dataSourceLine,
    decisionLine,
    reviewLine,
    prophecyLine,
    progressLine,
    benchmarkLine,
    bizMetricLine,
    prescriptionEffectLine,
    toolMenuLine,
    modeLine,
    stageLine,
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
    benmingColor: 'green',
    benchmark: resolveIndustryPack(p?.industry).benchmark,
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
