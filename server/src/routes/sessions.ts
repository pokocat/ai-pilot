import type { FastifyInstance, FastifyReply } from 'fastify';
import { billableOf } from '../services/usage.js';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { resolveUser, buildGenContext, isBriefInterviewRequest } from '../services/context.js';
import { bumpDiagRound } from '../services/strategicProfile.js';
import { resolveEffectiveAgent } from '../services/agentVersions.js';
import { generateDeliverable, chatComplete, chatCompleteStream, hasLiveProvider } from '../llm/gateway.js';
import { learnFromConversation } from '../services/memory.js';
import { ingestKnowledge } from '../services/knowledge.js';
import { summarizeSession } from '../services/summarize.js';
import { refineSessionTitle } from '../services/sessionTitle.js';
import { reserveCredits, type CreditReservation } from '../services/credits.js';
import {
  reserveQuota,
  generationQuotaReserveTokens,
  assertPlanActive,
  RESERVE_TOKENS,
  type QuotaReservation,
} from '../services/tokenQuota.js';
import { assertAgentAccess } from '../services/entitlements.js';
import { recordAudit } from '../services/audit.js';
import { KEY2AGENT } from '../data/agents.js';
import type { MessageRef, Deliverable, ChatReply } from '../llm/schema.js';
import { type Usage, scrubSectionJson, healDeliverableSections } from '../llm/schema.js';
import { extractAndRecordProphecies } from '../services/prophecyLog.js';
import { resolveMode } from '../services/intent.js';
import { recordReview } from '../services/reviewLog.js';
import { webviewSafeReportUrl } from '../services/reportHtml.js';
import { notifyReportReady } from '../services/wechatSubscribe.js';
import { isRecallIntent, sessionRecallScore } from '../services/recallIntent.js';
import { isSessionGenerating, trackSessionGeneration } from '../services/sessionGeneration.js';
import { cardSection } from '../services/deliverableSection.js';
import { updateSessionDigest, readSessionDigest, type SessionDigestItem } from '../services/sessionDigest.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 降级结算（真实模型没出结构化成果、回退 mock 模板 = deliverable.degraded）：token 额度侧已 settle(0) 退回，
// 钻石预留也必须一并退回——否则图片类 agent 拿到废模板还照扣钻石（两轴计费不对齐的资损，见售卖前体检 P1）。
// 非降级或未实扣（文本 agent diamondCost=0）时按原余额返回，不动。
// 注：这里退过之后，若紧随的 quotaReservation.settle 抛错，下面 catch 块会照着 `charged` 再退一次；
// 不叠成双退靠 CreditReservation.refund 自身幂等（credits.ts），此处无需再加标志位。
async function settleCreditForDeliverable(res: CreditReservation | null, degraded: boolean | undefined): Promise<number> {
  const bal = res?.balance ?? 0;
  if (!degraded || !res?.charged) return bal;
  try {
    return await res.refund('降级未出结构化成果 · 退回钻石');
  } catch (e) {
    console.error('[sessions] degraded credit refund failed:', (e as Error).message);
    return bal;
  }
}

// 预言收割（M2 PR-9）：总军师输出后异步抽取「具体、可验证、有期限」的天势判断落账。
// 真实模型不可用时抽取器返回空（不产生伪预言）；失败静默，绝不影响回复主流程。
function harvestProphecies(user: { tenantId: string; id: string }, agentKey: string, text: string | null | undefined): void {
  if (agentKey !== 'general' || !text) return;
  void extractAndRecordProphecies({ tenantId: user.tenantId, userId: user.id, text }).catch(() => {});
}
// 2026-07-22 例行 QA 修复：d.sections 是报告 V2 类型化 section，quote/letter 没有 h、
// stats/roster/table/phases/timeline 的实际内容在 items/people/rows 等专属字段——直接读
// s.h/s.b/s.list 会让预言账本系统性漏采这些类型里的具体预测（quote/letter 甚至会把
// "undefined" 当文本喂进去）。先过一遍与 casefile.ts 同口径的 cardSection 归一化。
function harvestText(d: Deliverable): string {
  return `${d.title}\n${d.sections.map(cardSection).map((s) => `${s.h} ${s.b ?? ''} ${(s.list ?? []).join(' ')}`).join('\n')}`;
}
function notifySessionReport(user: { tenantId: string; id: string }, deliverable: Deliverable): void {
  notifyReportReady({ tenantId: user.tenantId, userId: user.id, title: deliverable.title || '报告已生成' });
}

// 报告轮「同步补齐」的墙钟预算。
// 为什么必须有：updateSessionDigest 全链路没有 deadline——每批 structured 最坏 2 轮 × 端点池 3 个端点
// × 20s ≈ 120s，3 批就是 6 分钟，还可能排在上一轮 bumpSessionDigest（5 批）的会话锁后面；
// 而 /generate-sync 整个 handler 必须在 nginx proxy_read_timeout(180s) 内跑完。摘要是增强层，
// 绝不允许它把主流程拖超时。超时**不打断**后台那次更新——会话锁会让它自然跑完，下一轮直接受益。
const DIGEST_SYNC_BUDGET_MS = 25_000;
const DIGEST_BUDGET_EXCEEDED = Symbol('digest-budget-exceeded');

// 会话既往脉络（批次 3）：普通轮只带最近 16 条原文，早期确认过的事实/约束/决策会掉出窗口。
// 快照层把它们索引下来（每条可溯源到消息 id），在这里取出来注入本轮上下文。
//
// 取数分两档，因为「现抽」要跑一次辅助模型（有延迟）而「读快照」不用：
//   · 报告轮（本轮真会出成果）：同步补齐，最多 3 批 + 墙钟预算——报告最吃早期脉络，值这点延迟。
//   · 普通聊天轮：纯读，零延迟；本轮的内容由收尾的即发即忘更新补进去，供下一轮使用。
// 首条消息的新会话没有历史可摘，直接跳过。任何失败一律降级为 null——摘要是增强层，不是主流程依赖。
export async function loadTurnDigest(p: {
  tenantId: string; userId: string; sessionId: string; isNewSession: boolean; willDeliver: boolean;
  budgetMs?: number;
}): Promise<{ items: SessionDigestItem[]; caughtUp: boolean } | null> {
  if (p.isNewSession) return null;
  // caughtUp 只用于报告轮收窄历史窗；纯读路径恒为 false（读到的快照未必已追平，宁可不收窄）。
  const readOnly = async () => {
    const read = await readSessionDigest(p.sessionId, p.userId).catch(() => null);
    return read ? { items: read.items, caughtUp: false } : null;
  };
  if (!p.willDeliver) return readOnly();

  const pending = updateSessionDigest({
    tenantId: p.tenantId, userId: p.userId, sessionId: p.sessionId, maxBatches: 3,
  }).catch(() => null);
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<typeof DIGEST_BUDGET_EXCEEDED>((resolve) => {
    timer = setTimeout(() => resolve(DIGEST_BUDGET_EXCEEDED), p.budgetMs ?? DIGEST_SYNC_BUDGET_MS);
  });
  try {
    const winner = await Promise.race([pending, budget]);
    if (winner !== DIGEST_BUDGET_EXCEEDED) return winner;
  } finally {
    clearTimeout(timer);
  }
  // 超预算：本轮退回「现状快照」（可能含刚落库的前几批，per-batch upsert 的好处），
  // 并按未追平处理——历史窗不收窄，16 条原文照旧带上，宁可多带原文也不能既没摘要又砍了原文。
  return readOnly();
}

// 每轮收尾即发即忘更新快照（写法参照同文件的 refineSessionTitle）：让下一轮聊天纯读就能读到含本轮的脉络。
// 只挂在成功路径上——失败的一轮没有可信内容可摘。失败静默，绝不回头影响已经完成的这一轮。
function bumpSessionDigest(user: { tenantId: string; id: string }, sessionId: string): void {
  void updateSessionDigest({ tenantId: user.tenantId, userId: user.id, sessionId }).catch(() => {});
}

type GenerationError = Error & { code?: string; statusCode?: number };

/**
 * 流式聊天收尾守卫：流跑完却没拿到最终结果（provider 流静默结束，只来过 delta 或一个事件都没来）。
 * 此前这里会 `send('chat', null)` —— 端上收到后把 null 整体替换进气泡，下一帧读 `m.reply.text`
 * 立刻抛错、整页白屏（小程序无红屏）；而紧随其后的 message.create 又因 contentJson 是必填 Json
 * 列而拒绝 null，本来也落不了库。既然这一轮确实没有回复，就按失败抛出：交给外层 catch 退预留 +
 * send('error')，端上走既有的错误气泡 + ↻ 重试，而不是「看起来成功、内容为空」。
 */
function assertStreamReply(reply: ChatReply | null): asserts reply is ChatReply {
  if (!reply) {
    throw Object.assign(new Error('AI 服务暂时不可用，请稍后重试'), { code: 'AI_UNAVAILABLE' });
  }
}

function publicGenerationError(err: GenerationError): { message: string; code: string } {
  const code = err.code ?? 'INTERNAL';
  if (code === 'MODERATION_BLOCK') {
    return { message: err.message || '这条内容暂时无法处理，请换一种说法。', code };
  }
  if (err.statusCode === 408 || err.statusCode === 504) {
    return { message: '军师这次思考时间有点久，请稍后重试。', code };
  }
  if (err.statusCode === 429) {
    return { message: '军师现在有点忙，请过一会儿再试。', code };
  }
  if (code === 'AI_UNAVAILABLE') {
    // aiUnavailable() 已生成用户安全文案（区分「响应超时」与「暂时不可用」）；直接透传，
    // 让用户知道这次是超时还是服务不可用，而不是笼统的「没能完成」（此前一律吞成通用文案）。
    return { message: err.message || 'AI 服务暂时不可用，请稍后重试', code };
  }
  if (code === 'AI_OUTPUT_TRUNCATED') {
    return { message: '这次内容比较长，军师还没完整写完。请重试，或让军师分段继续。', code };
  }
  return { message: '军师暂时没能完成这次回答，请稍后重试。', code };
}

function logGenerationError(scope: 'sync' | 'stream', err: GenerationError, meta: { userId: string; sessionId?: string; agentKey: string }): void {
  console.error(`[sessions] ${scope} generation failed`, {
    ...meta,
    code: err.code ?? 'INTERNAL',
    statusCode: err.statusCode,
    error: err.stack || err.message,
  });
}

export async function sessionRoutes(app: FastifyInstance) {
  // 会话列表（按更新时间倒序，带最后一条摘要）
  app.get('/sessions', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const sessions = await prisma.session.findMany({
      where: { userId: user.id },
      orderBy: { updatedAt: 'desc' },
      include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 }, agent: true },
    });
    const EPOCH = new Date(0);
    // V7-15 未读数强化：unreadCount = 自 lastReadAt 起的 assistant 消息计数（服务端算；user/report/system 不计）。
    // 每会话一条 count（会话数远小于消息数，且计数下推到 SQL），均经 session 关系按 userId 收窄——严格 user 域内。
    return Promise.all(
      sessions.map(async (s) => {
        const last = s.messages[0];
        const generating = isSessionGenerating(s.id);
        let snippet = '新对话';
        if (last) {
          const c = last.contentJson as { text?: string; title?: string };
          snippet = c.text || (c.title ? `已产出《${c.title}》` : '已回复');
        }
        const unreadCount = await prisma.message.count({
          where: { session: { id: s.id, userId: user.id }, role: 'assistant', createdAt: { gt: s.lastReadAt ?? EPOCH } },
        });
        return {
          id: s.id,
          agentKey: s.agentKey,
          agentName: s.agent.name,
          agentIcon: s.agent.icon,
          title: s.title,
          snippet: generating ? '军师正在思考…' : snippet,
          updatedAt: s.updatedAt,
          projectId: s.projectId,
          generating,
          unreadCount,
          // 未读红点（保留兼容既有消费者）：有未读 assistant（=unreadCount>0），或尾条为未读 report
          //（后台产出即置——列表红点提示，见 generate* 的 role='report' 落库）。
          hasUnread: unreadCount > 0 || (!!last && last.role === 'report' && (!s.lastReadAt || last.createdAt > s.lastReadAt)),
        };
      }),
    );
  });

  // 会话详情（还原全部历史消息）
  app.get<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const s = await prisma.session.findFirst({
      where: { id: req.params.id, userId: user.id },
      include: { messages: { orderBy: { createdAt: 'asc' } }, agent: true },
    });
    if (!s) return reply.code(404).send({ error: 'session not found' });
    // 打开会话即标记已读（消除列表未读红点）。必须 await：此前 fire-and-forget（void + 不等待）
    // 与紧随其后的 GET /sessions 之间存在竞态——客户端拿到本次响应后立刻刷新列表时，
    // lastReadAt 的写入可能还没落库，导致未读红点没有如实清除（已由测试复现）。
    // 这是一次按主键的单行 UPDATE，代价极小，不值得为省这点延迟牺牲「打开即已读」的确定性。
    await prisma.session.update({ where: { id: s.id }, data: { lastReadAt: new Date() } }).catch(() => {});
    // P1-A5：会话头的 greet/chips/memText/learnText 与 /agents 列表同口径——取已发布版本，旧版本相应列为 null 则回退 Agent 行。
    const pub = s.agent.publishedVersionId ? await prisma.agentVersion.findUnique({ where: { id: s.agent.publishedVersionId } }) : null;
    return {
      id: s.id,
      agentKey: s.agentKey,
      agent: { key: s.agent.key, name: s.agent.name, role: s.agent.role, icon: s.agent.icon, greet: pub?.greet ?? s.agent.greet, chips: (pub?.chipsJson ?? s.agent.chipsJson), memText: pub?.memText ?? s.agent.memText, learnText: pub?.learnText ?? s.agent.learnText },
      title: s.title,
      projectId: s.projectId,
      generating: isSessionGenerating(s.id),
      messages: s.messages.map((m) => ({ id: m.id, role: m.role, content: presentMessageContent(m.role, m.contentJson), at: m.createdAt, refs: (m.refsJson as MessageRef[] | null) ?? undefined })),
    };
  });

  app.delete<{ Params: { id: string } }>('/sessions/:id', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    await prisma.message.deleteMany({ where: { session: { id: req.params.id, userId: user.id } } });
    await prisma.session.deleteMany({ where: { id: req.params.id, userId: user.id } });
    return { ok: true };
  });

  // 按需运行该成果的「产出处理」技能(kind=output)——HTML 网页报告就是技能库里的 render_report。
  // 产出时不强制渲染；用户要分享/导出时才调用。默认跑 render_report，并叠加该 agent 勾选的其它 output 技能。幂等：已生成则复用。
  app.post<{ Params: { id: string; mid: string } }>('/sessions/:id/messages/:mid/report', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const msg = await prisma.message.findFirst({
      where: { id: req.params.mid, role: 'report', session: { id: req.params.id, userId: user.id } },
      include: { session: { include: { agent: true } } },
    });
    if (!msg) return reply.code(404).send({ error: 'report not found' });
    const deliverable = msg.contentJson as unknown as Deliverable;
    if (deliverable?.htmlUrl) {
      const htmlUrl = webviewSafeReportUrl(deliverable.htmlUrl);
      if (htmlUrl && htmlUrl !== deliverable.htmlUrl) {
        const patch = { htmlUrl, cdnUrl: deliverable.cdnUrl ?? deliverable.htmlUrl } as Partial<Deliverable>;
        await prisma.message.update({
          where: { id: msg.id },
          data: { contentJson: { ...(deliverable as object), ...patch } as Prisma.InputJsonValue },
        });
        return patch;
      }
      return { htmlUrl: deliverable.htmlUrl, cdnUrl: deliverable.cdnUrl }; // 已生成过：幂等返回
    }

    const enabled = (msg.session.agent.skillsConfig as { tools?: string[] } | null)?.tools ?? [];
    const { resolveOutputSkills } = await import('../llm/tools/registry.js');
    const outputs = resolveOutputSkills(['render_report', ...enabled]); // 本接口默认含网页报告
    try {
      let patch: Partial<Deliverable> = {};
      const octx = { tenantId: user.tenantId, userId: user.id, agentKey: msg.session.agentKey };
      for (const sk of outputs) patch = { ...patch, ...(await sk.run({ ...deliverable, ...patch }, octx)) };
      await prisma.message.update({
        where: { id: msg.id },
        data: { contentJson: { ...(deliverable as object), ...patch } as Prisma.InputJsonValue },
      });
      notifySessionReport(user, deliverable);
      return patch; // { htmlUrl, ... }
    } catch (err) {
      console.error('[sessions] output skill failed:', (err as Error).message);
      return reply.code(500).send({ error: '报告生成失败', code: 'REPORT_RENDER_FAILED' });
    }
  });

  // 同步产出（跨端：H5 + 微信小程序均可用；前端做客户端渐进式呈现）。
  // 空会话不预先落库——首条消息时创建会话。
  app.post<{ Body: { agentKey?: string; sessionId?: string; text: string; projectId?: string; refs?: MessageRef[] } }>('/generate-sync', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const text = (req.body.text || '').trim();
    if (!text) return reply.code(400).send({ error: 'empty text' });
    const refs = req.body.refs;

    let session = req.body.sessionId
      ? await prisma.session.findFirst({ where: { id: req.body.sessionId, userId: user.id }, include: { agent: true } })
      : null;
    const agentKey = session?.agentKey ?? req.body.agentKey ?? KEY2AGENT[text] ?? 'general';
    // 项目归属：新建用入参；已存在但未归属则补挂
    const projectId = await resolveProjectId(user.tenantId, req.body.projectId, session?.projectId);

    // 双轴校验（早于建会话/落消息）：unlock 未解锁→403；图片类按张校验钻石→402；文本类校验本月 token 额度→402。
    // 计费/接入一律以「已发布版本」为准（resolveEffectiveAgent）——运营改草稿/调倍率不影响 C 端，直到发布。
    const effective = await resolveEffectiveAgent(agentKey);
    const isImage = effective?.meterUnit === 'image';
    const ratio = effective?.billingRatio ?? 1;
    const diamondCost = effective && isImage ? effective.price : 0; // 文本类不扣钻石（走 token 额度）
    let creditReservation: CreditReservation | null = null;
    let quotaReservation: QuotaReservation | null = null;
    try {
      await assertPlanActive(user.id); // 过期只读锁定（D4）：到期后拦一切 AI 交互（产出+对话+图片）→ PLAN_EXPIRED(403)
      if (effective) await assertAgentAccess(user.id, { key: effective.key, billing: effective.billing });
      // 复盘保底（M2 PR-6）：复盘类调用（buildReviewPrompt 的确定性前缀）额度耗尽仍每日限次放行
      const reviewIntent = /^帮我做 \d{4}-\d{2}-\d{2} 的执行复盘/.test(text);
      if (effective && !isImage) {
        const reserveTokens = await generationQuotaReserveTokens({
          forceLive: effective.providerMode === 'openai',
          model: effective.providerMode === 'openai' ? effective.apiModel : null,
        });
        quotaReservation = await reserveQuota(user.id, ratio, {
          reserveTokens,
          ...(reviewIntent ? { grace: 'review' as const } : {}),
        });
      }
      creditReservation = await reserveCredits(user.tenantId, user.id, diamondCost, `产出预扣 · ${effective?.name ?? agentKey}`);
    } catch (e) {
      if (quotaReservation) await quotaReservation.refund().catch(() => {});
      const err = e as Error & { statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 402).send({ error: err.message, code: err.code });
    }

    let created = false;
    if (!session) {
      session = await prisma.session.create({
        data: { tenantId: user.tenantId, userId: user.id, agentKey, projectId, title: text.slice(0, 18) },
        include: { agent: true },
      });
      created = true;
      // 会话标题自动总结：首轮硬截断占位后，异步用轻量模型提炼短标题覆盖（即发即忘，不影响主流程）。
      void refineSessionTitle(session.id, text, session.title).catch(() => {});
    } else {
      const patch: { title?: string; projectId?: string } = {};
      if (session.title === '新对话') patch.title = text.slice(0, 18);
      if (!session.projectId && projectId) patch.projectId = projectId;
      if (Object.keys(patch).length) await prisma.session.update({ where: { id: session.id }, data: patch });
      if (patch.title) void refineSessionTitle(session.id, text, patch.title).catch(() => {});
    }
    const finishGeneration = trackSessionGeneration(session.id);
    try {
    const userMsg = await prisma.message.create({ data: { sessionId: session.id, role: 'user', contentJson: { text }, refsJson: refs ? (refs as unknown as Prisma.InputJsonValue) : undefined } });
    // M3 PR-11：意图路由——本轮检测优先、检测不出沿用会话粘性模式；复盘意图自动落对应层复盘账
    const { intent, persist: modePersist } = resolveMode(text, session.mode);
    if (modePersist !== undefined) await prisma.session.update({ where: { id: session.id }, data: { mode: modePersist } });
    if (intent.mode === 'review' && intent.reviewLayer) {
      void recordReview({ tenantId: user.tenantId, userId: user.id, layer: intent.reviewLayer }).catch(() => {});
    }
    // F-5：总军师战略一问一答开始即推进诊断轮次（用户级持久化，换/删会话不清零）。await 保证本轮 buildGenContext 读到新值。
    if (agentKey === 'general' && intent.mode === 'strategy' && !isBriefInterviewRequest(text)) {
      await bumpDiagRound({ tenantId: user.tenantId, userId: user.id, sessionId: session.id });
    }
    const sessionMode = modePersist !== undefined ? modePersist : session.mode;

    const agent = session.agent;
    const isDeliverable = !!effective?.deliverableKey; // 是否产出 = 已发布版本的 deliverableKey
    // 按需产出：deliverableKey 已配 + skillsConfig.deliverableMode='on-demand' → 模型自行决定本轮出报告还是对话。
    const onDemand = isDeliverable && (effective?.skillsConfig as { deliverableMode?: string } | null)?.deliverableMode === 'on-demand';
    const willDeliver = onDemand ? wantsDeliverableRequest(text) : isDeliverable;
    const digest = await loadTurnDigest({
      tenantId: user.tenantId, userId: user.id, sessionId: session.id, isNewSession: created, willDeliver,
    });

    const conversation = await loadConversationHistory(session.id, userMsg.id, text, deliverableRecentLimit(willDeliver, digest));
    const history = conversation.history;
    await recordAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'user.generate',
      payload: { mode: 'sync', sessionId: session.id, agentKey, projectId, diamondCost, ratio, refs: refs?.length ?? 0 },
    });

    const { ctx, memoryConfig, knowledgeUsed, refNotices } = await buildGenContext({
      userId: user.id, tenantId: user.tenantId, agentKey, userMessage: text, projectId, refs,
      sessionId: session.id, difyConversationId: session.difyConversationId,
      effective: effective ?? undefined, history,
      historyTrace: conversation.trace,
      sessionMode,
      digestItems: digest?.items ?? null,
      });

    try {
      if (onDemand) {
        // A-3：总军师也写记忆（用户级共享事实池）。
        const learn = async () => learnFromConversation({ tenantId: user.tenantId, userId: user.id, agentKey, cfg: memoryConfig, userText: text, projectId });
        if (!wantsDeliverableRequest(text)) {
          const { result: replyChat, usage } = await chatComplete(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
          const msg = await prisma.message.create({ data: { sessionId: session.id, role: 'assistant', contentJson: replyChat as object } });
          harvestProphecies(user, agentKey, replyChat.text);
          bumpSessionDigest(user, session.id);
          await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
          const learned = await learn();
          const creditBalance = creditReservation?.balance ?? 0;
          const tokenQuota = quotaReservation ? await quotaReservation.settle(billableOf(usage), ratio) : null;
          return {
            sessionId: session.id, created, agentKey, kind: 'chat', messageId: msg.id, reply: replyChat,
            memory: learned ? { learned: true, agentName: agent.name } : null, knowledgeUsed, refNotices, creditBalance, tokenQuota,
          };
        }
        const { result: deliverable, usage } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
        const msg = await prisma.message.create({ data: { sessionId: session.id, role: 'report', contentJson: deliverable as object } });
        harvestProphecies(user, agentKey, harvestText(deliverable));
        notifySessionReport(user, deliverable);
        bumpSessionDigest(user, session.id);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        const learned = await learn();
        const creditBalance = await settleCreditForDeliverable(creditReservation, deliverable.degraded);
        const tokenQuota = quotaReservation ? await quotaReservation.settle(deliverable.degraded ? 0 : billableOf(usage), ratio) : null;
        return {
          sessionId: session.id, created, agentKey, kind: 'report', messageId: msg.id, deliverable,
          memory: learned ? { learned: true, agentName: agent.name } : null, knowledgeUsed, refNotices, creditBalance, tokenQuota,
        };
      }
      if (isDeliverable) {
        const { result: deliverable, usage } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
        // 网页版可分享报告改为「按需生成」——见 POST /sessions/:id/messages/:mid/report；产出时不再每次强制渲染存库。
        const msg = await prisma.message.create({
          data: { sessionId: session.id, role: 'report', contentJson: deliverable as object },
        });
        notifySessionReport(user, deliverable);
        bumpSessionDigest(user, session.id);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        // A-3：总军师也写记忆（含产出结论）。
        const learned = await learnFromConversation({
          tenantId: user.tenantId, userId: user.id, agentKey, cfg: memoryConfig, userText: text, projectId,
          assistantText: `${deliverable.title}：${deliverable.sections.map((s) => s.h).filter(Boolean).join('、')}`,
        });
        // P0-4：降级（真实模型没出结构化成果、回退模板）不向用户计费——token settle(0) 退回、钻石也退回；真实 token 仍在 gateway 侧记账。
        const creditBalance = await settleCreditForDeliverable(creditReservation, deliverable.degraded);
        const tokenQuota = quotaReservation ? await quotaReservation.settle(deliverable.degraded ? 0 : billableOf(usage), ratio) : null;
        return {
          sessionId: session.id, created, agentKey, kind: 'report',
          messageId: msg.id, deliverable,
          memory: learned ? { learned: true, agentName: agent.name } : null,
          knowledgeUsed, refNotices, creditBalance, tokenQuota,
        };
      }
      const { result: replyChat, usage } = await chatComplete(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
      const msg = await prisma.message.create({
        data: { sessionId: session.id, role: 'assistant', contentJson: replyChat as object },
      });
      harvestProphecies(user, agentKey, replyChat.text);
      bumpSessionDigest(user, session.id);
      await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
      const creditBalance = creditReservation?.balance ?? 0;
      const tokenQuota = quotaReservation ? await quotaReservation.settle(billableOf(usage), ratio) : null;
      return { sessionId: session.id, created, agentKey, kind: 'chat', messageId: msg.id, reply: replyChat, knowledgeUsed, refNotices, creditBalance, tokenQuota };
    } catch (err) {
      if (creditReservation?.charged) {
        await creditReservation.refund().catch((refundErr) => {
          console.error('[sessions] credit refund failed:', (refundErr as Error).message);
        });
      }
      if (quotaReservation) {
        await quotaReservation.refund().catch((refundErr) => {
          console.error('[sessions] quota refund failed:', (refundErr as Error).message);
        });
      }
      const e = err as GenerationError;
      logGenerationError('sync', e, { userId: user.id, sessionId: session.id, agentKey });
      const publicError = publicGenerationError(e);
      return reply
        .code(e.statusCode ?? (e.code === 'MODERATION_BLOCK' ? 422 : 500))
        .send({ error: publicError.message, code: publicError.code });
    }
    } finally {
      finishGeneration();
    }
  });

  // 把整段会话汇总为「对话纪要」：版本化报告 + 沉淀进知识库
  app.post<{ Params: { id: string } }>('/sessions/:id/summarize', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    // 汇总同样会触发真实模型（summarizePoints），须与 /generate* 一样受月度额度门禁 + 实际扣减。
    // summarizePoints 走 rawJson，不回传真实 token 用量，故不能只 ensureQuota(仅判断放行、从不扣减)——
    // 那样只要余额一次性 >0 就能无限次触发真实模型调用，额度系统形同虚设。改用与 /generate* 一致的
    // reserveQuota 预留 + 按 RESERVE_TOKENS 定额结算（成功=全额扣留，失败=退回）。
    let quotaReservation: QuotaReservation | null = null;
    try {
      await assertPlanActive(user.id); // 过期只读锁定（D4）：会话汇总是 AI 产出 → 到期拦 PLAN_EXPIRED(403)
      quotaReservation = await reserveQuota(user.id, 1);
    } catch (e) {
      const err = e as Error & { statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 402).send({ error: err.message, code: err.code });
    }
    try {
      // mock/demo（未配置真实模型）下 summarizePoints 直接短路返回 null、无真实成本 → 全额退回预留，
      // 与 /generate* 的 mock 路径（usage=ZERO_USAGE → settle(0) 全退）同一口径，避免误扣。
      const live = await hasLiveProvider();
      const res = await summarizeSession({ tenantId: user.tenantId, userId: user.id, sessionId: req.params.id });
      await quotaReservation.settle(live ? RESERVE_TOKENS : 0, 1);
      await recordAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'user.session.summarize',
        payload: { sessionId: req.params.id, reportId: res.reportId, version: res.version, knowledgeAdded: res.knowledgeAdded },
      });
      return res;
    } catch (err) {
      await quotaReservation.refund().catch(() => {});
      const e = err as Error & { statusCode?: number; code?: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message, code: e.code });
    }
  });

  // 发送消息并流式产出（SSE；H5 ReadableStream / weapp chunk）。空会话不预先落库——首条消息时创建会话。
  app.post<{ Body: { agentKey?: string; sessionId?: string; text: string; projectId?: string; refs?: MessageRef[] } }>('/generate', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const text = (req.body.text || '').trim();
    if (!text) return reply.code(400).send({ error: 'empty text' });
    const refs = req.body.refs;

    // 确定会话与智能体
    let session = req.body.sessionId
      ? await prisma.session.findFirst({ where: { id: req.body.sessionId, userId: user.id }, include: { agent: true } })
      : null;
    const agentKey = session?.agentKey ?? req.body.agentKey ?? KEY2AGENT[text] ?? 'general';
    const projectId = await resolveProjectId(user.tenantId, req.body.projectId, session?.projectId);

    // 双轴校验（起流前，未解锁→403 / 不足→402，正常 JSON 而非 SSE）：图片按张校验钻石，文本校验本月 token 额度。
    // 计费/接入以「已发布版本」为准，与同步产出一致。
    const effective = await resolveEffectiveAgent(agentKey);
    const isImage = effective?.meterUnit === 'image';
    const ratio = effective?.billingRatio ?? 1;
    const diamondCost = effective && isImage ? effective.price : 0;
    let creditReservation: CreditReservation | null = null;
    let quotaReservation: QuotaReservation | null = null;
    try {
      await assertPlanActive(user.id); // 过期只读锁定（D4）：到期后拦一切 AI 交互（产出+对话+图片）→ PLAN_EXPIRED(403)
      if (effective) await assertAgentAccess(user.id, { key: effective.key, billing: effective.billing });
      const reviewIntent = /^帮我做 \d{4}-\d{2}-\d{2} 的执行复盘/.test(text); // 复盘保底（M2 PR-6）
      if (effective && !isImage) {
        const reserveTokens = await generationQuotaReserveTokens({
          forceLive: effective.providerMode === 'openai',
          model: effective.providerMode === 'openai' ? effective.apiModel : null,
        });
        quotaReservation = await reserveQuota(user.id, ratio, {
          reserveTokens,
          ...(reviewIntent ? { grace: 'review' as const } : {}),
        });
      }
      creditReservation = await reserveCredits(user.tenantId, user.id, diamondCost, `产出预扣 · ${effective?.name ?? agentKey}`);
    } catch (e) {
      if (quotaReservation) await quotaReservation.refund().catch(() => {});
      const err = e as Error & { statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 402).send({ error: err.message, code: err.code });
    }

    setupSSE(reply);
    // 客户端断开感知：移动端切后台/断网是常态。断连后 break 掉流式循环 → 触发异步生成器 .return()，
    // 把取消透传到 provider 流、停止继续烧 token；对话路径并退还预留（不为没人看的输出计费，见售卖前体检 P0-8）。
    let clientGone = false;
    reply.raw.on('close', () => { clientGone = true; });
    const refundReservations = async () => {
      if (creditReservation?.charged) await creditReservation.refund('客户端断开 · 退回').catch(() => {});
      if (quotaReservation) await quotaReservation.refund().catch(() => {});
    };
    // 客户端断开后不再往死 socket 写（防 write-after-end 抛错中断生成/落库）。
    const send = (event: string, data: unknown) => {
      if (reply.raw.writableEnded || reply.raw.destroyed) return;
      try { reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* socket 已关，忽略 */ }
    };

    let finishGeneration: (() => void) | null = null;
    let createdSession = false;
    try {
      if (!session) {
        createdSession = true;
        session = await prisma.session.create({
          data: { tenantId: user.tenantId, userId: user.id, agentKey, projectId, title: text.slice(0, 18) },
          include: { agent: true },
        });
        send('session', { id: session.id, agentKey, title: session.title, projectId });
        // 会话标题自动总结：首轮硬截断占位后，异步用轻量模型提炼短标题覆盖（即发即忘，不影响主流程）。
        void refineSessionTitle(session.id, text, session.title).catch(() => {});
      } else {
        const patch: { title?: string; projectId?: string } = {};
        if (session.title === '新对话') patch.title = text.slice(0, 18);
        if (!session.projectId && projectId) patch.projectId = projectId;
        if (Object.keys(patch).length) await prisma.session.update({ where: { id: session.id }, data: patch });
        if (patch.title) void refineSessionTitle(session.id, text, patch.title).catch(() => {});
      }

      finishGeneration = trackSessionGeneration(session.id);
      // 持久化用户消息（含引用）
      const userMsg = await prisma.message.create({ data: { sessionId: session.id, role: 'user', contentJson: { text }, refsJson: refs ? (refs as unknown as Prisma.InputJsonValue) : undefined } });
    // M3 PR-11：意图路由——本轮检测优先、检测不出沿用会话粘性模式；复盘意图自动落对应层复盘账
    const { intent, persist: modePersist } = resolveMode(text, session.mode);
    if (modePersist !== undefined) await prisma.session.update({ where: { id: session.id }, data: { mode: modePersist } });
    if (intent.mode === 'review' && intent.reviewLayer) {
      void recordReview({ tenantId: user.tenantId, userId: user.id, layer: intent.reviewLayer }).catch(() => {});
    }
    // F-5：总军师战略一问一答开始即推进诊断轮次（用户级持久化，换/删会话不清零）。await 保证本轮 buildGenContext 读到新值。
    if (agentKey === 'general' && intent.mode === 'strategy' && !isBriefInterviewRequest(text)) {
      await bumpDiagRound({ tenantId: user.tenantId, userId: user.id, sessionId: session.id });
    }
    const sessionMode = modePersist !== undefined ? modePersist : session.mode;

      const agent = session.agent;
      const isDeliverable = !!effective?.deliverableKey; // 顾问/创作智能体 → 结构化成果（按已发布版本）
      const onDemand = isDeliverable && (effective?.skillsConfig as { deliverableMode?: string } | null)?.deliverableMode === 'on-demand';
      const willDeliver = onDemand ? wantsDeliverableRequest(text) : isDeliverable;
      const digest = await loadTurnDigest({
        tenantId: user.tenantId, userId: user.id, sessionId: session.id, isNewSession: createdSession, willDeliver,
      });

      const conversation = await loadConversationHistory(session.id, userMsg.id, text, deliverableRecentLimit(willDeliver, digest));
      const history = conversation.history;
      await recordAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'user.generate',
        payload: { mode: 'sse', sessionId: session.id, agentKey, projectId, diamondCost, ratio, refs: refs?.length ?? 0 },
      });

      const { ctx, memoryConfig, refNotices } = await buildGenContext({
        userId: user.id,
        tenantId: user.tenantId,
        agentKey,
        userMessage: text,
        projectId,
        refs,
        sessionId: session.id,
        difyConversationId: session.difyConversationId,
        effective: effective ?? undefined,
        history,
        historyTrace: conversation.trace,
        sessionMode,
        digestItems: digest?.items ?? null,
      });

      const learnSse = async () => {
        // A-3：总军师也写记忆（用户级共享事实池）。
        const learned = await learnFromConversation({ tenantId: user.tenantId, userId: user.id, agentKey, cfg: memoryConfig, userText: text, projectId });
        if (learned) send('memory', { learned: true, agentName: agent.name });
      };
      if (onDemand && !wantsDeliverableRequest(text)) {
        send('meta', { kind: 'chat', refNotices });
        let reply2: ChatReply | null = null;
        // 显式标 Usage：初值只是占位，done 事件会整体替换成 gateway 那个（已带 billableTokens）。
        // 若沿用推断出的窄类型，billableTokens 会在类型上消失，额度就悄悄退回旧口径。
        let usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInput: 0 };
        for await (const ev of chatCompleteStream(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio })) {
          if (ev.type === 'delta') send('token', { text: ev.text });
          else { reply2 = ev.result; usage = ev.usage; }
          if (clientGone) break; // 断连：停消费(取消 provider 流)，退预留、不持久化残缺回复
        }
        if (clientGone) { await refundReservations(); return; }
        assertStreamReply(reply2);
        send('chat', reply2);
        const msg = await prisma.message.create({ data: { sessionId: session.id, role: 'assistant', contentJson: reply2 as object } });
        harvestProphecies(user, agentKey, reply2?.text);
        bumpSessionDigest(user, session.id);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        await learnSse();
        const creditBalance = creditReservation?.balance ?? 0;
        const tokenQuota = quotaReservation ? await quotaReservation.settle(billableOf(usage), ratio) : null;
        send('credit', { balance: creditBalance, tokenQuota });
        send('done', { messageId: msg.id });
      } else if (onDemand) {
        send('meta', { kind: 'report', refNotices });
        const { result: deliverable, usage } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
        send('begin', { title: deliverable.title, icon: deliverable.icon, meta: deliverable.meta });
        for (let i = 0; i < deliverable.sections.length; i++) { if (clientGone) break; await sleep(520); send('section', { index: i, ...deliverable.sections[i] }); }
        await sleep(300);
        send('footer', { trust: deliverable.trust, actions: deliverable.actions });
        const msg = await prisma.message.create({ data: { sessionId: session.id, role: 'report', contentJson: deliverable as object } });
        harvestProphecies(user, agentKey, harvestText(deliverable));
        notifySessionReport(user, deliverable);
        bumpSessionDigest(user, session.id);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        await learnSse();
        const creditBalance = await settleCreditForDeliverable(creditReservation, deliverable.degraded);
        const tokenQuota = quotaReservation ? await quotaReservation.settle(deliverable.degraded ? 0 : billableOf(usage), ratio) : null;
        send('credit', { balance: creditBalance, tokenQuota });
        send('done', { messageId: msg.id });
      } else if (isDeliverable) {
        send('meta', { kind: 'report', refNotices });
        const { result: deliverable, usage } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
        send('begin', { title: deliverable.title, icon: deliverable.icon, meta: deliverable.meta });
        // 渐进式呈现：按 section 逐段下发（保留原型骨架→渐显动效）；断连即停送（报告已生成、落库可回看）。
        for (let i = 0; i < deliverable.sections.length; i++) {
          if (clientGone) break;
          await sleep(520);
          send('section', { index: i, ...deliverable.sections[i] });
        }
        await sleep(300);
        send('footer', { trust: deliverable.trust, actions: deliverable.actions });

        const msg = await prisma.message.create({
          data: { sessionId: session.id, role: 'report', contentJson: deliverable as object },
        });
        notifySessionReport(user, deliverable);
        bumpSessionDigest(user, session.id);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });

        // A-3：记忆学习（含总军师；用户级共享事实池）。
        {
          const learned = await learnFromConversation({
            tenantId: user.tenantId,
            userId: user.id,
            agentKey,
            cfg: memoryConfig,
            userText: text,
            projectId,
            assistantText: `${deliverable.title}：${deliverable.sections.map((s) => s.h).filter(Boolean).join('、')}`,
          });
          if (learned) send('memory', { learned: true, agentName: agent.name });
        }
        // P0-4：降级不向用户计费——token settle(0) 退回、钻石也退回；真实 token 仍在 gateway 侧记账。
        const creditBalance = await settleCreditForDeliverable(creditReservation, deliverable.degraded);
        const tokenQuota = quotaReservation ? await quotaReservation.settle(deliverable.degraded ? 0 : billableOf(usage), ratio) : null;
        send('credit', { balance: creditBalance, tokenQuota });
        send('done', { messageId: msg.id });
      } else {
        send('meta', { kind: 'chat', refNotices });
        // 普通聊天优先走 provider 原生 token 流；只在输入侧先审核，输出完成后记账/trace。
        let reply2: ChatReply | null = null;
        // 显式标 Usage：初值只是占位，done 事件会整体替换成 gateway 那个（已带 billableTokens）。
        // 若沿用推断出的窄类型，billableTokens 会在类型上消失，额度就悄悄退回旧口径。
        let usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInput: 0 };
        for await (const ev of chatCompleteStream(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio })) {
          if (ev.type === 'delta') send('token', { text: ev.text });
          else { reply2 = ev.result; usage = ev.usage; }
          if (clientGone) break; // 断连：停消费(取消 provider 流)，退预留、不持久化残缺回复
        }
        if (clientGone) { await refundReservations(); return; }
        assertStreamReply(reply2);
        send('chat', reply2); // 完整回复（含 points/acts）兜底，兼容不消费 token 流的客户端
        const msg = await prisma.message.create({
          data: { sessionId: session.id, role: 'assistant', contentJson: reply2 as object },
        });
        harvestProphecies(user, agentKey, reply2?.text);
        bumpSessionDigest(user, session.id);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        const creditBalance = creditReservation?.balance ?? 0;
        const tokenQuota = quotaReservation ? await quotaReservation.settle(billableOf(usage), ratio) : null;
        send('credit', { balance: creditBalance, tokenQuota });
        send('done', { messageId: msg.id });
      }
    } catch (err) {
      if (creditReservation?.charged) {
        await creditReservation.refund().catch((refundErr) => {
          console.error('[sessions] credit refund failed:', (refundErr as Error).message);
        });
      }
      if (quotaReservation) {
        await quotaReservation.refund().catch((refundErr) => {
          console.error('[sessions] quota refund failed:', (refundErr as Error).message);
        });
      }
      const e = err as GenerationError;
      logGenerationError('stream', e, { userId: user.id, sessionId: session?.id, agentKey });
      send('error', publicGenerationError(e));
    } finally {
      finishGeneration?.();
      reply.raw.end();
    }
  });
}

// 长会话上下文：常规轮带最近 16 条；用户明确问“之前说过/你忘了吗”时，再从较早 160 条中
// 按业务词重合度挑 6 条原始摘录，作为“较早内容回顾”前置。两段都有字符预算，避免为了记得更多挤爆模型窗口。
const RECENT_HISTORY_MESSAGES = 16;
// 报告轮专用的收窄窗口（批次 3）：只有在快照已追平且非空时才用——早期脉络已由摘要块兜住，
// 原文只留最近 8 条，把省下的窗口让给摘要与知识召回。**聊天轮永远 16 条，不受此影响。**
const DELIVERABLE_HISTORY_MESSAGES = 8;
const RECALL_HISTORY_SCAN = 160;
const RECALL_HISTORY_MATCHES = 6;
const RECENT_HISTORY_CHAR_BUDGET = 12_000;
const CARRYOVER_CHAR_BUDGET = 4_500;

export interface ConversationHistoryTrace {
  recallIntent: boolean;
  recentMessages: number;
  carryoverMessages: number;
  totalChars: number;
}

type HistoryRow = Awaited<ReturnType<typeof prisma.message.findMany>>[number];

function historyMessage(row: HistoryRow): { role: string; text: string } | null {
  const c = row.contentJson as { text?: string; title?: string; sections?: { h?: string }[] };
  if (row.role === 'report') {
    const heads = (c.sections ?? []).map((s) => s.h).filter(Boolean).join('、');
    return { role: 'assistant', text: `（已为你产出《${c.title ?? '成果'}》${heads ? '：' + heads : ''}）` };
  }
  const raw = (c.text ?? '').trim();
  if (!raw) return null;
  const role = row.role === 'user' ? 'user' : 'assistant';
  // 历史脱敏：assistant 旧回复若泄漏过类型化 section JSON（完整/残缺），擦成占位句再进历史，
  // 否则脏输出会作为「示例」反哺模型、自我强化。user 原文不动。
  const text = role === 'assistant' ? scrubSectionJson(raw) : raw;
  return { role, text };
}

/**
 * 会话消息 contentJson 的读取端出口（GET /sessions/:id 唯一使用者）。
 *
 * 为什么读时治愈而不是刷库：小程序渲染期一旦解引用到脏形状就是**整页白屏**（无红屏、无堆栈），
 * 而端上防御要等发版审核才能到用户手里；读取端治愈只需部署服务端，线上现有版本立刻不再白屏。
 * 2026-07-29 实测：军师 tab 点「品牌营销官」进对话页白屏，根因是历史成果消息的 sections
 * 未过归一化（叶子是对象 → 端上 parseBlocks 的 `input.replace` 抛错）。方案库/版本化报告读取路径
 * 早就套了 healDeliverableSections，唯独会话详情这条最热的读取路径漏了——本函数补齐口径。
 *
 * 两类处理，都是纯内存变换、零额外 IO、对健康数据幂等：
 *  · report：healDeliverableSections —— 走一遍 normalizeDeliverableSections，
 *    保证 sections 是数组、每段是合法 typed/白卡、叶子是字符串（正常数据进出等价）；
 *  · assistant/system：擦除泄漏的 section JSON（原 scrubAssistantContent 行为），并**保证
 *    contentJson.text 一定是字符串** —— 缺 text 的存量消息会让端上 m.reply.text 落到
 *    parseBlocks(undefined) 抛错，同样白屏。
 */
function presentMessageContent(role: string, content: unknown): unknown {
  if (role === 'report') return presentReportContent(content);
  // assistant / system 才做文本清洗与形状保证；user 原文与未来新增角色一律原样透传。
  if (role === 'assistant' || role === 'system') return scrubAssistantContent(content);
  return content;
}

/**
 * 成果消息读取端自愈：sections 归一化 + 「sections 一定是数组」的形状保证。
 * healDeliverableSections 对「根本没有 sections 字段」的对象刻意原样返回（它是通用工具，不该给
 * 任意对象凭空加字段，见 reportV2.test.ts 的幂等断言），但端上 ReportCard 直接读 data.sections.length，
 * 缺字段就是整页白屏——所以这里在会话读取路径上把这一步补齐。健康数据走 heal 后原样返回，不额外分配。
 */
function presentReportContent(content: unknown): unknown {
  const healed = healDeliverableSections(content);
  if (!healed || typeof healed !== 'object' || Array.isArray(healed)) return { sections: [] };
  return 'sections' in healed ? healed : { ...(healed as object), sections: [] };
}

// 读取端展示清洗（存量自愈，不改库）：擦除 contentJson.text 里泄漏的 section JSON。
// 解析不出可读结构时统一用占位句；DB 数据保持原样，仅读时清洗。
// 另附形状保证：text 缺失/非字符串时补成空串（端上把它直接当字符串用，缺值即渲染期抛错→白屏）。
function scrubAssistantContent(content: unknown): unknown {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return { text: '' };
  const c = content as { text?: unknown };
  if (typeof c.text !== 'string') return { ...c, text: '' };
  if (!c.text) return content;
  const cleaned = scrubSectionJson(c.text);
  return cleaned === c.text ? content : { ...c, text: cleaned };
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function fitRecentBudget(messages: { role: string; text: string }[]): { role: string; text: string }[] {
  const kept: { role: string; text: string }[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = { ...messages[i], text: clipText(messages[i].text, 2_000) };
    if (kept.length && used + item.text.length > RECENT_HISTORY_CHAR_BUDGET) break;
    used += item.text.length;
    kept.push(item);
  }
  return kept.reverse();
}

function mergeHistory(messages: { role: string; text: string }[]): { role: string; text: string }[] {
  const merged: { role: string; text: string }[] = [];
  for (const m of messages) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.text += '\n' + m.text;
    else merged.push({ ...m });
  }
  return merged;
}

/** 本轮该带几条原文：仅「报告轮 + 快照已追平且非空」三条件同时成立才收窄到 8 条，其余一律沿用 16 条。 */
export function deliverableRecentLimit(
  willDeliver: boolean,
  digest: { items: SessionDigestItem[]; caughtUp: boolean } | null,
): number | undefined {
  return willDeliver && digest?.caughtUp && digest.items.length > 0 ? DELIVERABLE_HISTORY_MESSAGES : undefined;
}

export async function loadConversationHistory(
  sessionId: string,
  excludeId: string,
  currentText = '',
  recentLimit?: number,
): Promise<{ history: { role: string; text: string }[]; trace: ConversationHistoryTrace }> {
  const recallIntent = isRecallIntent(currentText);
  const recentRows = await prisma.message.findMany({
    where: { sessionId, id: { not: excludeId }, role: { in: ['user', 'assistant', 'report'] } },
    orderBy: { createdAt: 'desc' },
    take: recentLimit ?? RECENT_HISTORY_MESSAGES,
  });
  const recent = fitRecentBudget(recentRows.reverse().map(historyMessage).filter((m): m is { role: string; text: string } => !!m));

  let carryoverMessages = 0;
  let carryover: { role: string; text: string }[] = [];
  if (recallIntent && recentRows.length) {
    const older = await prisma.message.findMany({
      where: {
        sessionId,
        id: { notIn: [excludeId, ...recentRows.map((r) => r.id)] },
        role: { in: ['user', 'assistant', 'report'] },
      },
      orderBy: { createdAt: 'desc' },
      take: RECALL_HISTORY_SCAN,
    });
    const selected = older
      .map((row) => ({ row, message: historyMessage(row) }))
      .filter((x): x is { row: HistoryRow; message: { role: string; text: string } } => !!x.message)
      .map((x) => ({ ...x, score: sessionRecallScore(currentText, x.message.text) }))
      .filter((x) => x.score >= 0.035)
      .sort((a, b) => b.score - a.score || b.row.createdAt.getTime() - a.row.createdAt.getTime())
      .slice(0, RECALL_HISTORY_MATCHES)
      .sort((a, b) => a.row.createdAt.getTime() - b.row.createdAt.getTime());
    carryoverMessages = selected.length;
    if (selected.length) {
      let used = 0;
      const lines: string[] = [];
      for (const x of selected) {
        const line = `${x.message.role === 'user' ? '客户' : '军师'}：${clipText(x.message.text, 900)}`;
        if (lines.length && used + line.length > CARRYOVER_CHAR_BUDGET) break;
        lines.push(line);
        used += line.length;
      }
      carryoverMessages = lines.length;
      carryover = [{
        role: 'assistant',
        text: `【同一会话较早内容回顾（原始对话摘录，不是新结论）】\n${lines.join('\n')}`,
      }];
    }
  }

  const history = mergeHistory([...carryover, ...recent]);
  return {
    history,
    trace: {
      recallIntent,
      recentMessages: recent.length,
      carryoverMessages,
      totalChars: history.reduce((sum, item) => sum + item.text.length, 0),
    },
  };
}

// 保留原导出给既有测试/内部调用；新生成链路使用 loadConversationHistory 以带上查询与可观测元数据。
export async function loadHistory(sessionId: string, excludeId: string): Promise<{ role: string; text: string }[]> {
  return (await loadConversationHistory(sessionId, excludeId)).history;
}

// 解析本次对话归属项目：已有会话归属优先；否则校验入参项目属于该租户。
async function resolveProjectId(
  tenantId: string, bodyProjectId?: string, sessionProjectId?: string | null,
): Promise<string | null> {
  if (sessionProjectId) return sessionProjectId;
  if (!bodyProjectId) return null;
  const p = await prisma.project.findFirst({ where: { id: bodyProjectId, tenantId }, select: { id: true } });
  return p?.id ?? null;
}

function setupSSE(reply: FastifyReply) {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    // 让反代不要缓冲这条流。当前生产 Nginx 站点配了 proxy_buffering off 所以看不出问题，
    // 但一旦换 ALB、或中间再加一层网关（压测报告建议的双实例 + ALB 就是这个形态），
    // 缺这个头会让事件被憋在缓冲区里，表现为「问完很久没反应然后一次性刷出来」。
    'X-Accel-Buffering': 'no',
  });
}

function wantsDeliverableRequest(text: string): boolean {
  return /(生成|输出|整理|做一份|出一份|给我一份|形成).{0,8}(方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报)|(?:重新)?出.{0,4}(方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报)|战略体检|转成军令|生成纪要/.test(text);
}
