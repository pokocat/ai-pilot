import type { FastifyInstance, FastifyReply } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { resolveUser, buildGenContext } from '../services/context.js';
import { generateDeliverable, chatComplete } from '../llm/gateway.js';
import { learnFromConversation } from '../services/memory.js';
import { ingestKnowledge } from '../services/knowledge.js';
import { summarizeSession } from '../services/summarize.js';
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

    const agent = session.agent;
    const isDeliverable = !!agent.deliverableKey;
    const { ctx, memoryConfig, knowledgeUsed } = await buildGenContext({
      userId: user.id, tenantId: user.tenantId, agentKey, userMessage: text, projectId, refs,
    });

    try {
      if (isDeliverable) {
        const deliverable = await generateDeliverable(ctx);
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
        return {
          sessionId: session.id, created, agentKey, kind: 'report',
          messageId: msg.id, deliverable,
          memory: learned ? { learned: true, agentName: agent.name } : null,
          knowledgeUsed,
        };
      }
      const replyChat = await chatComplete(ctx);
      const msg = await prisma.message.create({
        data: { sessionId: session.id, role: 'assistant', contentJson: replyChat as object },
      });
      await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
      return { sessionId: session.id, created, agentKey, kind: 'chat', messageId: msg.id, reply: replyChat, knowledgeUsed };
    } catch (err) {
      const e = err as Error & { code?: string };
      return reply.code(e.code === 'MODERATION_BLOCK' ? 422 : 500).send({ error: e.message, code: e.code });
    }
  });

  // 把整段会话汇总为「对话纪要」：版本化报告 + 沉淀进知识库
  app.post<{ Params: { id: string } }>('/sessions/:id/summarize', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    try {
      const res = await summarizeSession({ tenantId: user.tenantId, userId: user.id, sessionId: req.params.id });
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
        const deliverable = await generateDeliverable(ctx);
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
        send('done', { messageId: msg.id });
      } else {
        send('meta', { kind: 'chat' });
        const reply2 = await chatComplete(ctx);
        await sleep(700);
        send('chat', reply2);
        const msg = await prisma.message.create({
          data: { sessionId: session.id, role: 'assistant', contentJson: reply2 as object },
        });
        await prisma.session.update({ where: { id: session.id }, data: { updatedAt: new Date() } });
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
