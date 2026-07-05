import type { FastifyInstance, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { resolveUser, buildGenContext } from '../services/context.js';
import { resolveEffectiveAgent } from '../services/agentVersions.js';
import { generateDeliverable, chatComplete, chatCompleteStream } from '../llm/gateway.js';
import { learnFromConversation } from '../services/memory.js';
import { ingestKnowledge } from '../services/knowledge.js';
import { summarizeSession } from '../services/summarize.js';
import { reserveCredits, type CreditReservation } from '../services/credits.js';
import { reserveQuota, assertPlanActive, ensureQuota, type QuotaReservation } from '../services/tokenQuota.js';
import { assertAgentAccess } from '../services/entitlements.js';
import { recordAudit } from '../services/audit.js';
import { KEY2AGENT } from '../data/agents.js';
import type { MessageRef, Deliverable, ChatReply } from '../llm/schema.js';
import { extractAndRecordProphecies } from '../services/prophecyLog.js';
import { resolveMode } from '../services/intent.js';
import { recordReview } from '../services/reviewLog.js';
import { webviewSafeReportUrl } from '../services/reportHtml.js';
import { notifyReportReady } from '../services/wechatSubscribe.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 预言收割（M2 PR-9）：总军师输出后异步抽取「具体、可验证、有期限」的天势判断落账。
// 真实模型不可用时抽取器返回空（不产生伪预言）；失败静默，绝不影响回复主流程。
function harvestProphecies(user: { tenantId: string; id: string }, agentKey: string, text: string | null | undefined): void {
  if (agentKey !== 'general' || !text) return;
  void extractAndRecordProphecies({ tenantId: user.tenantId, userId: user.id, text }).catch(() => {});
}
function harvestText(d: Deliverable): string {
  return `${d.title}\n${d.sections.map((s) => `${s.h} ${s.b ?? ''} ${(s.list ?? []).join(' ')}`).join('\n')}`;
}
function notifySessionReport(user: { tenantId: string; id: string }, deliverable: Deliverable): void {
  notifyReportReady({ tenantId: user.tenantId, userId: user.id, title: deliverable.title || '报告已生成' });
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
    return sessions.map((s) => {
      const last = s.messages[0];
      let snippet = '新对话';
      if (last) {
        const c = last.contentJson as { text?: string; title?: string };
        snippet = c.text || (c.title ? `已产出《${c.title}》` : '已回复');
      }
      return {
        id: s.id,
        agentKey: s.agentKey,
        agentName: s.agent.name,
        agentIcon: s.agent.icon,
        title: s.title,
        snippet,
        updatedAt: s.updatedAt,
        projectId: s.projectId,
      };
    });
  });

  // 会话详情（还原全部历史消息）
  app.get<{ Params: { id: string } }>('/sessions/:id', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const s = await prisma.session.findFirst({
      where: { id: req.params.id, userId: user.id },
      include: { messages: { orderBy: { createdAt: 'asc' } }, agent: true },
    });
    if (!s) return reply.code(404).send({ error: 'session not found' });
    // P1-A5：会话头的 greet/chips/memText/learnText 与 /agents 列表同口径——取已发布版本，旧版本相应列为 null 则回退 Agent 行。
    const pub = s.agent.publishedVersionId ? await prisma.agentVersion.findUnique({ where: { id: s.agent.publishedVersionId } }) : null;
    return {
      id: s.id,
      agentKey: s.agentKey,
      agent: { key: s.agent.key, name: s.agent.name, role: s.agent.role, icon: s.agent.icon, greet: pub?.greet ?? s.agent.greet, chips: (pub?.chipsJson ?? s.agent.chipsJson), memText: pub?.memText ?? s.agent.memText, learnText: pub?.learnText ?? s.agent.learnText },
      title: s.title,
      projectId: s.projectId,
      messages: s.messages.map((m) => ({ id: m.id, role: m.role, content: m.contentJson, at: m.createdAt, refs: (m.refsJson as MessageRef[] | null) ?? undefined })),
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
      if (effective && !isImage) quotaReservation = await reserveQuota(user.id, ratio, reviewIntent ? { grace: 'review' } : undefined);  // P0-2：锁内预留额度（并发透支有界）
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
    } else {
      const patch: { title?: string; projectId?: string } = {};
      if (session.title === '新对话') patch.title = text.slice(0, 18);
      if (!session.projectId && projectId) patch.projectId = projectId;
      if (Object.keys(patch).length) await prisma.session.update({ where: { id: session.id }, data: patch });
    }
    const userMsg = await prisma.message.create({ data: { sessionId: session.id, role: 'user', contentJson: { text }, refsJson: refs ? (refs as unknown as Prisma.InputJsonValue) : undefined } });
    // M3 PR-11：意图路由——本轮检测优先、检测不出沿用会话粘性模式；复盘意图自动落对应层复盘账
    const { intent, persist: modePersist } = resolveMode(text, session.mode);
    if (modePersist !== undefined) await prisma.session.update({ where: { id: session.id }, data: { mode: modePersist } });
    if (intent.mode === 'review' && intent.reviewLayer) {
      void recordReview({ tenantId: user.tenantId, userId: user.id, layer: intent.reviewLayer }).catch(() => {});
    }
    const sessionMode = modePersist !== undefined ? modePersist : session.mode;

    const history = await loadHistory(session.id, userMsg.id);
    await recordAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'user.generate',
      payload: { mode: 'sync', sessionId: session.id, agentKey, projectId, diamondCost, ratio, refs: refs?.length ?? 0 },
    });

    const agent = session.agent;
    const isDeliverable = !!effective?.deliverableKey; // 是否产出 = 已发布版本的 deliverableKey
    // 按需产出：deliverableKey 已配 + skillsConfig.deliverableMode='on-demand' → 模型自行决定本轮出报告还是对话。
    const onDemand = isDeliverable && (effective?.skillsConfig as { deliverableMode?: string } | null)?.deliverableMode === 'on-demand';
    const { ctx, memoryConfig, knowledgeUsed } = await buildGenContext({
      userId: user.id, tenantId: user.tenantId, agentKey, userMessage: text, projectId, refs,
      sessionId: session.id, difyConversationId: session.difyConversationId,
      effective: effective ?? undefined, history,
      sessionMode,
      });

    try {
      if (onDemand) {
        const learn = async () => (agentKey === 'general'
          ? false
          : learnFromConversation({ tenantId: user.tenantId, userId: user.id, agentKey, cfg: memoryConfig, userText: text, projectId }));
        if (!wantsDeliverableRequest(text)) {
          const { result: replyChat, usage } = await chatComplete(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
          const msg = await prisma.message.create({ data: { sessionId: session.id, role: 'assistant', contentJson: replyChat as object } });
          harvestProphecies(user, agentKey, replyChat.text);
          await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
          const learned = await learn();
          const creditBalance = creditReservation?.balance ?? 0;
          const tokenQuota = quotaReservation ? await quotaReservation.settle(usage.inputTokens + usage.outputTokens, ratio) : null;
          return {
            sessionId: session.id, created, agentKey, kind: 'chat', messageId: msg.id, reply: replyChat,
            memory: learned ? { learned: true, agentName: agent.name } : null, knowledgeUsed, creditBalance, tokenQuota,
          };
        }
        const { result: deliverable, usage } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
        const msg = await prisma.message.create({ data: { sessionId: session.id, role: 'report', contentJson: deliverable as object } });
        harvestProphecies(user, agentKey, harvestText(deliverable));
        notifySessionReport(user, deliverable);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        const learned = await learn();
        const creditBalance = creditReservation?.balance ?? 0;
        const tokenQuota = quotaReservation ? await quotaReservation.settle(deliverable.degraded ? 0 : usage.inputTokens + usage.outputTokens, ratio) : null;
        return {
          sessionId: session.id, created, agentKey, kind: 'report', messageId: msg.id, deliverable,
          memory: learned ? { learned: true, agentName: agent.name } : null, knowledgeUsed, creditBalance, tokenQuota,
        };
      }
      if (isDeliverable) {
        const { result: deliverable, usage } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
        // 网页版可分享报告改为「按需生成」——见 POST /sessions/:id/messages/:mid/report；产出时不再每次强制渲染存库。
        const msg = await prisma.message.create({
          data: { sessionId: session.id, role: 'report', contentJson: deliverable as object },
        });
        notifySessionReport(user, deliverable);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        let learned = false;
        if (agentKey !== 'general') {
          learned = await learnFromConversation({
            tenantId: user.tenantId, userId: user.id, agentKey, cfg: memoryConfig, userText: text, projectId,
            assistantText: `${deliverable.title}：${deliverable.sections.map((s) => s.h).filter(Boolean).join('、')}`,
          });
        }
        const creditBalance = creditReservation?.balance ?? 0;
        // P0-4：降级（真实模型没出结构化成果、回退模板）不向用户计费——settle(0) 全额退回预留；我们仍在 gateway 侧按真实 token 记账。
        const tokenQuota = quotaReservation ? await quotaReservation.settle(deliverable.degraded ? 0 : usage.inputTokens + usage.outputTokens, ratio) : null;
        return {
          sessionId: session.id, created, agentKey, kind: 'report',
          messageId: msg.id, deliverable,
          memory: learned ? { learned: true, agentName: agent.name } : null,
          knowledgeUsed, creditBalance, tokenQuota,
        };
      }
      const { result: replyChat, usage } = await chatComplete(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
      const msg = await prisma.message.create({
        data: { sessionId: session.id, role: 'assistant', contentJson: replyChat as object },
      });
      harvestProphecies(user, agentKey, replyChat.text);
      await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
      const creditBalance = creditReservation?.balance ?? 0;
      const tokenQuota = quotaReservation ? await quotaReservation.settle(usage.inputTokens + usage.outputTokens, ratio) : null;
      return { sessionId: session.id, created, agentKey, kind: 'chat', messageId: msg.id, reply: replyChat, knowledgeUsed, creditBalance, tokenQuota };
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
      const e = err as Error & { code?: string; statusCode?: number };
      return reply.code(e.statusCode ?? (e.code === 'MODERATION_BLOCK' ? 422 : 500)).send({ error: e.message, code: e.code });
    }
  });

  // 把整段会话汇总为「对话纪要」：版本化报告 + 沉淀进知识库
  app.post<{ Params: { id: string } }>('/sessions/:id/summarize', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      await assertPlanActive(user.id); // 过期只读锁定（D4）：会话汇总是 AI 产出 → 到期拦 PLAN_EXPIRED(403)
      // 汇总同样会触发真实模型（summarizePoints），须与 /generate* 一样受月度额度门禁，
      // 否则配额耗尽后仍可无限次触发真实模型调用（额度系统被完全绕过）。
      await ensureQuota(user.id);
      const res = await summarizeSession({ tenantId: user.tenantId, userId: user.id, sessionId: req.params.id });
      await recordAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'user.session.summarize',
        payload: { sessionId: req.params.id, reportId: res.reportId, version: res.version, knowledgeAdded: res.knowledgeAdded },
      });
      return res;
    } catch (err) {
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
      if (effective && !isImage) quotaReservation = await reserveQuota(user.id, ratio, reviewIntent ? { grace: 'review' } : undefined);
      creditReservation = await reserveCredits(user.tenantId, user.id, diamondCost, `产出预扣 · ${effective?.name ?? agentKey}`);
    } catch (e) {
      if (quotaReservation) await quotaReservation.refund().catch(() => {});
      const err = e as Error & { statusCode?: number; code?: string };
      return reply.code(err.statusCode ?? 402).send({ error: err.message, code: err.code });
    }

    setupSSE(reply);
    const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    try {
      if (!session) {
        session = await prisma.session.create({
          data: { tenantId: user.tenantId, userId: user.id, agentKey, projectId, title: text.slice(0, 18) },
          include: { agent: true },
        });
        send('session', { id: session.id, agentKey, title: session.title, projectId });
      } else {
        const patch: { title?: string; projectId?: string } = {};
        if (session.title === '新对话') patch.title = text.slice(0, 18);
        if (!session.projectId && projectId) patch.projectId = projectId;
        if (Object.keys(patch).length) await prisma.session.update({ where: { id: session.id }, data: patch });
      }

      // 持久化用户消息（含引用）
      const userMsg = await prisma.message.create({ data: { sessionId: session.id, role: 'user', contentJson: { text }, refsJson: refs ? (refs as unknown as Prisma.InputJsonValue) : undefined } });
    // M3 PR-11：意图路由——本轮检测优先、检测不出沿用会话粘性模式；复盘意图自动落对应层复盘账
    const { intent, persist: modePersist } = resolveMode(text, session.mode);
    if (modePersist !== undefined) await prisma.session.update({ where: { id: session.id }, data: { mode: modePersist } });
    if (intent.mode === 'review' && intent.reviewLayer) {
      void recordReview({ tenantId: user.tenantId, userId: user.id, layer: intent.reviewLayer }).catch(() => {});
    }
    const sessionMode = modePersist !== undefined ? modePersist : session.mode;

      const history = await loadHistory(session.id, userMsg.id);
      await recordAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'user.generate',
        payload: { mode: 'sse', sessionId: session.id, agentKey, projectId, diamondCost, ratio, refs: refs?.length ?? 0 },
      });

      const agent = session.agent;
      const isDeliverable = !!effective?.deliverableKey; // 顾问/创作智能体 → 结构化成果（按已发布版本）
      const onDemand = isDeliverable && (effective?.skillsConfig as { deliverableMode?: string } | null)?.deliverableMode === 'on-demand';
      const { ctx, memoryConfig } = await buildGenContext({
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
        sessionMode,
      });

      const learnSse = async () => {
        if (agentKey === 'general') return;
        const learned = await learnFromConversation({ tenantId: user.tenantId, userId: user.id, agentKey, cfg: memoryConfig, userText: text, projectId });
        if (learned) send('memory', { learned: true, agentName: agent.name });
      };
      if (onDemand && !wantsDeliverableRequest(text)) {
        send('meta', { kind: 'chat' });
        let reply2: ChatReply | null = null;
        let usage = { inputTokens: 0, outputTokens: 0 };
        for await (const ev of chatCompleteStream(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio })) {
          if (ev.type === 'delta') send('token', { text: ev.text });
          else { reply2 = ev.result; usage = ev.usage; }
        }
        send('chat', reply2);
        const msg = await prisma.message.create({ data: { sessionId: session.id, role: 'assistant', contentJson: reply2 as object } });
        harvestProphecies(user, agentKey, reply2?.text);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        await learnSse();
        const creditBalance = creditReservation?.balance ?? 0;
        const tokenQuota = quotaReservation ? await quotaReservation.settle(usage.inputTokens + usage.outputTokens, ratio) : null;
        send('credit', { balance: creditBalance, tokenQuota });
        send('done', { messageId: msg.id });
      } else if (onDemand) {
        send('meta', { kind: 'report' });
        const { result: deliverable, usage } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
        send('begin', { title: deliverable.title, icon: deliverable.icon, meta: deliverable.meta });
        for (let i = 0; i < deliverable.sections.length; i++) { await sleep(520); send('section', { index: i, ...deliverable.sections[i] }); }
        await sleep(300);
        send('footer', { trust: deliverable.trust, actions: deliverable.actions });
        const msg = await prisma.message.create({ data: { sessionId: session.id, role: 'report', contentJson: deliverable as object } });
        harvestProphecies(user, agentKey, harvestText(deliverable));
        notifySessionReport(user, deliverable);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        await learnSse();
        const creditBalance = creditReservation?.balance ?? 0;
        const tokenQuota = quotaReservation ? await quotaReservation.settle(deliverable.degraded ? 0 : usage.inputTokens + usage.outputTokens, ratio) : null;
        send('credit', { balance: creditBalance, tokenQuota });
        send('done', { messageId: msg.id });
      } else if (isDeliverable) {
        send('meta', { kind: 'report' });
        const { result: deliverable, usage } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
        send('begin', { title: deliverable.title, icon: deliverable.icon, meta: deliverable.meta });
        // 渐进式呈现：按 section 逐段下发（保留原型骨架→渐显动效）
        for (let i = 0; i < deliverable.sections.length; i++) {
          await sleep(520);
          send('section', { index: i, ...deliverable.sections[i] });
        }
        await sleep(300);
        send('footer', { trust: deliverable.trust, actions: deliverable.actions });

        const msg = await prisma.message.create({
          data: { sessionId: session.id, role: 'report', contentJson: deliverable as object },
        });
        notifySessionReport(user, deliverable);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });

        // 记忆学习（非通用智能体）
        if (agentKey !== 'general') {
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
        const creditBalance = creditReservation?.balance ?? 0;
        // P0-4：降级不向用户计费（settle(0) 退回预留）；真实 token 仍在 gateway 侧记账。
        const tokenQuota = quotaReservation ? await quotaReservation.settle(deliverable.degraded ? 0 : usage.inputTokens + usage.outputTokens, ratio) : null;
        send('credit', { balance: creditBalance, tokenQuota });
        send('done', { messageId: msg.id });
      } else {
        send('meta', { kind: 'chat' });
        // 普通聊天优先走 provider 原生 token 流；只在输入侧先审核，输出完成后记账/trace。
        let reply2: ChatReply | null = null;
        let usage = { inputTokens: 0, outputTokens: 0 };
        for await (const ev of chatCompleteStream(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio })) {
          if (ev.type === 'delta') send('token', { text: ev.text });
          else { reply2 = ev.result; usage = ev.usage; }
        }
        send('chat', reply2); // 完整回复（含 points/acts）兜底，兼容不消费 token 流的客户端
        const msg = await prisma.message.create({
          data: { sessionId: session.id, role: 'assistant', contentJson: reply2 as object },
        });
        harvestProphecies(user, agentKey, reply2?.text);
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        const creditBalance = creditReservation?.balance ?? 0;
        const tokenQuota = quotaReservation ? await quotaReservation.settle(usage.inputTokens + usage.outputTokens, ratio) : null;
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
      const e = err as Error & { code?: string };
      send('error', { message: e.message, code: e.code ?? 'INTERNAL' });
    } finally {
      reply.raw.end();
    }
  });
}

// P0-3：取该会话最近 N 轮（排除刚落库的当前用户消息）作为对话历史注入模型——此前完全未注入，
// 模型每轮无状态，追问「第二点展开/那定价呢」全失忆。report 折叠成一句摘要；合并连续同角色避免非交替报错。
const HISTORY_TURNS = 8;
export async function loadHistory(sessionId: string, excludeId: string): Promise<{ role: string; text: string }[]> {
  const rows = await prisma.message.findMany({
    where: { sessionId, id: { not: excludeId }, role: { in: ['user', 'assistant', 'report'] } },
    orderBy: { createdAt: 'desc' },
    take: HISTORY_TURNS,
  });
  const mapped = rows.reverse().map((m) => {
    const c = m.contentJson as { text?: string; title?: string; sections?: { h?: string }[] };
    if (m.role === 'report') {
      const heads = (c.sections ?? []).map((s) => s.h).filter(Boolean).join('、');
      return { role: 'assistant', text: `（已为你产出《${c.title ?? '成果'}》${heads ? '：' + heads : ''}）` };
    }
    return { role: m.role === 'user' ? 'user' : 'assistant', text: (c.text ?? '').trim() };
  }).filter((m) => m.text);
  const merged: { role: string; text: string }[] = [];
  for (const m of mapped) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === m.role) prev.text += '\n' + m.text;
    else merged.push({ ...m });
  }
  return merged;
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
  });
}

function wantsDeliverableRequest(text: string): boolean {
  return /(生成|输出|整理|做一份|出一份|给我一份|形成).{0,8}(方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报)|(?:重新)?出.{0,4}(方案|报告|成果|卡片|纪要|计划|军令|文案|脚本|海报)|战略体检|转成军令|生成纪要/.test(text);
}
