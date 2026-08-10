import { after, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { UserFactStatus } from '@prisma/client';
import { prisma } from '../src/db.js';
import { buildGenContext } from '../src/services/context.js';
import { enqueueDurableGeneration } from '../src/services/generationRequest.js';
import { tickGenerationWorker } from '../src/services/generationWorker.js';
import {
  activeUserFactsBlock,
  captureAssistantFactCandidates,
  captureDocumentFactCandidates,
  captureDirectUserFacts,
  pendingDocumentFactCard,
} from '../src/services/userFacts.js';
import { cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
});
after(async () => closeApp());

async function fixture() {
  const token = await login(uniquePhone(), '事实测试老板');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { id: true, tenantId: true } });
  const session = await prisma.session.create({
    data: { tenantId: user.tenantId, userId: user.id, agentKey: 'general', title: '事实测试', lineageId: 'lineage-facts' },
  });
  const message = await prisma.message.create({ data: { sessionId: session.id, role: 'user', contentJson: { text: '测试' } } });
  return { token, user, session, message };
}

describe('客户硬事实：来源、替代链与自然语言主权', () => {
  test('用户直接说 5 家店不弹卡；改成 6 家后旧事实 superseded', async () => {
    const f = await fixture();
    const first = await captureDirectUserFacts({
      tenantId: f.user.tenantId, userId: f.user.id, sessionId: f.session.id,
      userMessageId: f.message.id, text: '我们目前有5家店，先帮我看增长问题',
    });
    assert.equal(first.length, 1);
    assert.equal(first[0].status, UserFactStatus.asserted);
    assert.equal(first[0].valueText, '目前有5家门店');

    const correction = await prisma.message.create({ data: { sessionId: f.session.id, role: 'user', contentJson: { text: '不是5家店，是6家店' } } });
    const second = await captureDirectUserFacts({
      tenantId: f.user.tenantId, userId: f.user.id, sessionId: f.session.id,
      userMessageId: correction.id, text: '不是5家店，是6家店',
    });
    assert.equal(second.length, 1);
    assert.equal(second[0].valueText, '目前有6家门店');
    assert.equal(second[0].supersedesId, first[0].id);
    const old = await prisma.userFact.findUniqueOrThrow({ where: { id: first[0].id } });
    assert.equal(old.status, UserFactStatus.superseded);
    const block = await activeUserFactsBlock(f.user.id);
    assert.match(block ?? '', /6家门店/);
    assert.doesNotMatch(block ?? '', /5家门店/);
  });

  test('“帮我记住”进入 asserted，“这条别记”可撤回且不再注入', async () => {
    const f = await fixture();
    const remembered = await captureDirectUserFacts({
      tenantId: f.user.tenantId, userId: f.user.id, sessionId: f.session.id,
      userMessageId: f.message.id, text: '帮我记住，我们周五不排重要会议',
    });
    assert.equal(remembered.length, 1);
    assert.equal(remembered[0].status, UserFactStatus.asserted);
    const forget = await prisma.message.create({ data: { sessionId: f.session.id, role: 'user', contentJson: { text: '这条别记' } } });
    await captureDirectUserFacts({
      tenantId: f.user.tenantId, userId: f.user.id, sessionId: f.session.id,
      userMessageId: forget.id, text: '这条别记',
    });
    const row = await prisma.userFact.findUniqueOrThrow({ where: { id: remembered[0].id } });
    assert.equal(row.status, UserFactStatus.rejected);
    assert.equal(await activeUserFactsBlock(f.user.id), null);
  });
});

describe('推断确认卡：不污染聊天、不确认不注入', () => {
  test('军师推断经营十年只进 pending；点击确认不新增消息', async () => {
    const f = await fixture();
    const assistant = await prisma.message.create({ data: { sessionId: f.session.id, role: 'assistant', contentJson: { text: '你们已经经营十年。' } } });
    const card = await captureAssistantFactCandidates({
      tenantId: f.user.tenantId, userId: f.user.id, sessionId: f.session.id,
      userMessageId: f.message.id, assistantMessageId: assistant.id,
      assistantText: '你们已经经营十年。',
    });
    assert.equal(card?.items.length, 1);
    const factId = card!.items[0].id;
    const pending = await prisma.userFact.findUniqueOrThrow({ where: { id: factId } });
    assert.equal(pending.status, UserFactStatus.pending);
    assert.equal(await activeUserFactsBlock(f.user.id), null, 'pending 不能冒充硬事实注入');

    const app = await getApp();
    const before = await prisma.message.count({ where: { sessionId: f.session.id } });
    const response = await app.inject({
      method: 'POST', url: `/api/facts/${factId}/confirm`,
      headers: { 'x-user-id': f.token }, payload: { action: 'confirm' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(await prisma.message.count({ where: { sessionId: f.session.id } }), before, '确认按钮不能伪造聊天消息');
    assert.match(await activeUserFactsBlock(f.user.id) ?? '', /已经营10年/);
  });

  test('手动修正创建 confirmed 替代项；仅本次参考把 pending 排除', async () => {
    const f = await fixture();
    const assistant = await prisma.message.create({ data: { sessionId: f.session.id, role: 'assistant', contentJson: { text: '我推测已经营十年。' } } });
    const card = await captureAssistantFactCandidates({
      tenantId: f.user.tenantId, userId: f.user.id, sessionId: f.session.id,
      userMessageId: f.message.id, assistantMessageId: assistant.id, assistantText: '我推测已经营十年。',
    });
    const app = await getApp();
    const edited = await app.inject({
      method: 'POST', url: `/api/facts/${card!.items[0].id}/confirm`, headers: { 'x-user-id': f.token },
      payload: { action: 'edit', valueText: '已经营7年' },
    });
    assert.equal(edited.statusCode, 200, edited.body);
    assert.equal(edited.json().resolution, 'edited');
    assert.match(await activeUserFactsBlock(f.user.id) ?? '', /已经营7年/);

    const assistant2 = await prisma.message.create({ data: { sessionId: f.session.id, role: 'assistant', contentJson: { text: '我判断团队现在有30人。' } } });
    const card2 = await captureAssistantFactCandidates({
      tenantId: f.user.tenantId, userId: f.user.id, sessionId: f.session.id,
      userMessageId: f.message.id, assistantMessageId: assistant2.id, assistantText: '我判断团队现在有30人。',
    });
    const once = await app.inject({
      method: 'POST', url: `/api/facts/${card2!.items[0].id}/confirm`, headers: { 'x-user-id': f.token },
      payload: { action: 'session_only' },
    });
    assert.equal(once.statusCode, 200, once.body);
    assert.equal(once.json().resolution, 'session_only');
    assert.doesNotMatch(await activeUserFactsBlock(f.user.id) ?? '', /30人/);
  });

  test('资料抽取事实只进 pending，并在下一轮以独立确认卡出现', async () => {
    const f = await fixture();
    const document = await prisma.knowledgeItem.create({
      data: {
        tenantId: f.user.tenantId,
        userId: f.user.id,
        kind: 'document',
        text: '公司目前有8家门店，团队现在有42人。',
        sourceType: 'upload',
        stage: 'confirmed',
        status: 'ready',
        tagsJson: [],
      },
    });
    const facts = await captureDocumentFactCandidates({
      tenantId: f.user.tenantId,
      userId: f.user.id,
      documentId: document.id,
      text: document.text,
    });
    assert.equal(facts.length, 2);
    assert.ok(facts.every((fact) => fact.status === UserFactStatus.pending && fact.sourceDocumentId === document.id));
    assert.equal(await activeUserFactsBlock(f.user.id), null, '资料抽取未经确认不能注入硬事实');
    const card = await pendingDocumentFactCard(f.user.id);
    assert.equal(card?.items.length, 2);
    assert.ok(card?.items.every((item) => item.reason === 'document_extraction'));
  });
});

describe('显式新会谈：血缘和交接包', () => {
  test('新 Session 继承 lineage、事实和上一段脉络，但不复制旧消息', async () => {
    const token = await login(uniquePhone(), '交接测试老板');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { id: true, tenantId: true } });
    const first = await enqueueDurableGeneration(user, {
      agentKey: 'general', text: '我们目前有5家店，下一步先把单店模型跑通', clientRequestId: 'handoff-first',
    });
    await tickGenerationWorker();
    await prisma.sessionContextSnapshot.upsert({
      where: { sessionId: first.session.id },
      create: {
        sessionId: first.session.id, tenantId: user.tenantId, userId: user.id, lastMessageId: first.job.userMessageId,
        itemsJson: {
          schemaVersion: 2,
          activeItems: [
            { kind: 'decision', text: '先把单店模型跑通', sourceMessageIds: [first.job.userMessageId], at: new Date().toISOString() },
            { kind: 'action_item', text: '下一步核算单店获客成本', sourceMessageIds: [first.job.userMessageId], at: new Date().toISOString() },
          ],
          segmentItems: [], segment: 0,
        },
      },
      update: {},
    });

    const second = await enqueueDurableGeneration(user, {
      agentKey: 'general', text: '我们开个新对话，接着往下聊', clientRequestId: 'handoff-second',
    });
    assert.notEqual(second.session.id, first.session.id);
    assert.equal(second.session.continuationOf, first.session.id);
    assert.equal(second.session.lineageId, first.session.lineageId);
    assert.equal(await prisma.message.count({ where: { sessionId: second.session.id } }), 1, '新会谈只落本轮用户消息，不复制旧消息');
    const handoff = await prisma.sessionHandoff.findUniqueOrThrow({ where: { sessionId: second.session.id } });
    assert.equal(handoff.sourceSessionId, first.session.id);
    assert.match(JSON.stringify(handoff.factsJson), /5家门店/);
    assert.match(JSON.stringify(handoff.decisionsJson), /单店模型/);

    const built = await buildGenContext({
      userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '接着聊', sessionId: second.session.id,
    });
    assert.match(built.ctx.factsLine ?? '', /5家门店/);
    assert.match(built.ctx.handoffLine ?? '', /先把单店模型跑通/);
    assert.match(built.ctx.handoffLine ?? '', /下一步核算单店获客成本/);
  });
});
