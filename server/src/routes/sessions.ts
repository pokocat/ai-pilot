import type { FastifyInstance, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { resolveUser, buildGenContext } from '../services/context.js';
import { generateDeliverable, chatComplete } from '../llm/gateway.js';
import { learnFromConversation } from '../services/memory.js';
import { ingestKnowledge } from '../services/knowledge.js';
import { summarizeSession } from '../services/summarize.js';
import { ensureCredits, chargeCredits } from '../services/credits.js';
import { ensureQuota, chargeQuota } from '../services/tokenQuota.js';
import { assertAgentAccess } from '../services/entitlements.js';
import { recordAudit } from '../services/audit.js';
import { KEY2AGENT } from '../data/agents.js';
import type { MessageRef } from '../llm/schema.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    return {
      id: s.id,
      agentKey: s.agentKey,
      agent: { key: s.agent.key, name: s.agent.name, role: s.agent.role, icon: s.agent.icon, greet: s.agent.greet, chips: s.agent.chipsJson, memText: s.agent.memText, learnText: s.agent.learnText },
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
    const agentRec = session?.agent ?? await prisma.agent.findUnique({ where: { key: agentKey } });
    const isImage = agentRec?.meterUnit === 'image';
    const ratio = agentRec?.billingRatio ?? 1;
    const diamondCost = agentRec && isImage ? agentRec.price : 0; // 文本类不扣钻石（走 token 额度）
    try {
      if (agentRec) await assertAgentAccess(user.id, agentRec);
      await ensureCredits(user.id, diamondCost);            // 图片按张校验钻石；文本 diamondCost=0 放行
      if (agentRec && !isImage) await ensureQuota(user.id);  // 文本校验本月 token 额度（余额>0 即放行）
    } catch (e) {
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
    await prisma.message.create({ data: { sessionId: session.id, role: 'user', contentJson: { text }, refsJson: refs ? (refs as unknown as Prisma.InputJsonValue) : undefined } });
    await recordAudit({
      tenantId: user.tenantId,
      userId: user.id,
      action: 'user.generate',
      payload: { mode: 'sync', sessionId: session.id, agentKey, projectId, diamondCost, ratio, refs: refs?.length ?? 0 },
    });

    const agent = session.agent;
    const isDeliverable = !!agent.deliverableKey;
    const { ctx, memoryConfig, knowledgeUsed } = await buildGenContext({
      userId: user.id, tenantId: user.tenantId, agentKey, userMessage: text, projectId, refs,
      sessionId: session.id, difyConversationId: session.difyConversationId,
    });

    try {
      if (isDeliverable) {
        const { result: deliverable, usage } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
        // 渲染可分享的网页版报告(失败不影响产出)
        try {
          const { publishReport } = await import('../services/reportHtml.js');
          deliverable.htmlUrl = await publishReport(user.tenantId, deliverable);
        } catch (err) {
          console.error('[sessions] publishReport failed:', (err as Error).message);
        }
        const msg = await prisma.message.create({
          data: { sessionId: session.id, role: 'report', contentJson: deliverable as object },
        });
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        let learned = false;
        if (agentKey !== 'general') {
          learned = await learnFromConversation({
            tenantId: user.tenantId, userId: user.id, agentKey, cfg: memoryConfig, userText: text, projectId,
          });
        }
        const creditBalance = await chargeCredits(user.tenantId, user.id, diamondCost, `深度产出 · ${agent.name}`);
        const tokenQuota = isImage ? null : await chargeQuota(user.id, usage.inputTokens + usage.outputTokens, ratio);
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
      await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
      const creditBalance = await chargeCredits(user.tenantId, user.id, diamondCost, `对话 · ${agent.name}`);
      const tokenQuota = isImage ? null : await chargeQuota(user.id, usage.inputTokens + usage.outputTokens, ratio);
      return { sessionId: session.id, created, agentKey, kind: 'chat', messageId: msg.id, reply: replyChat, knowledgeUsed, creditBalance, tokenQuota };
    } catch (err) {
      const e = err as Error & { code?: string; statusCode?: number };
      return reply.code(e.statusCode ?? (e.code === 'MODERATION_BLOCK' ? 422 : 500)).send({ error: e.message, code: e.code });
    }
  });

  // 把整段会话汇总为「对话纪要」：版本化报告 + 沉淀进知识库
  app.post<{ Params: { id: string } }>('/sessions/:id/summarize', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const res = await summarizeSession({ tenantId: user.tenantId, userId: user.id, sessionId: req.params.id });
      await recordAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'user.session.summarize',
        payload: { sessionId: req.params.id, reportId: res.reportId, version: res.version, knowledgeAdded: res.knowledgeAdded },
      });
      return res;
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      return reply.code(e.statusCode ?? 500).send({ error: e.message });
    }
  });

  // 发送消息并流式产出（SSE，仅 H5/Web）。空会话不预先落库——首条消息时创建会话。
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
    const agentRec = session?.agent ?? await prisma.agent.findUnique({ where: { key: agentKey } });
    const isImage = agentRec?.meterUnit === 'image';
    const ratio = agentRec?.billingRatio ?? 1;
    const diamondCost = agentRec && isImage ? agentRec.price : 0;
    try {
      if (agentRec) await assertAgentAccess(user.id, agentRec);
      await ensureCredits(user.id, diamondCost);
      if (agentRec && !isImage) await ensureQuota(user.id);
    } catch (e) {
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
      await prisma.message.create({ data: { sessionId: session.id, role: 'user', contentJson: { text }, refsJson: refs ? (refs as unknown as Prisma.InputJsonValue) : undefined } });
      await recordAudit({
        tenantId: user.tenantId,
        userId: user.id,
        action: 'user.generate',
        payload: { mode: 'sse', sessionId: session.id, agentKey, projectId, diamondCost, ratio, refs: refs?.length ?? 0 },
      });

      const agent = session.agent;
      const isDeliverable = !!agent.deliverableKey; // 顾问/创作智能体 → 结构化成果
      const { ctx, memoryConfig } = await buildGenContext({
        userId: user.id,
        tenantId: user.tenantId,
        agentKey,
        userMessage: text,
        projectId,
        refs,
      });

      if (isDeliverable) {
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
          });
          if (learned) send('memory', { learned: true, agentName: agent.name });
        }
        const creditBalance = await chargeCredits(user.tenantId, user.id, diamondCost, `产出 · ${agent.name}`);
        const tokenQuota = isImage ? null : await chargeQuota(user.id, usage.inputTokens + usage.outputTokens, ratio);
        send('credit', { balance: creditBalance, tokenQuota });
        send('done', { messageId: msg.id });
      } else {
        send('meta', { kind: 'chat' });
        const { result: reply2, usage } = await chatComplete(ctx, { tenantId: user.tenantId, userId: user.id, sessionId: session.id, agentKey, ratio });
        await sleep(700);
        send('chat', reply2);
        const msg = await prisma.message.create({
          data: { sessionId: session.id, role: 'assistant', contentJson: reply2 as object },
        });
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
        const creditBalance = await chargeCredits(user.tenantId, user.id, diamondCost, `产出 · ${agent.name}`);
        const tokenQuota = isImage ? null : await chargeQuota(user.id, usage.inputTokens + usage.outputTokens, ratio);
        send('credit', { balance: creditBalance, tokenQuota });
        send('done', { messageId: msg.id });
      }
    } catch (err) {
      const e = err as Error & { code?: string };
      send('error', { message: e.message, code: e.code ?? 'INTERNAL' });
    } finally {
      reply.raw.end();
    }
  });
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
