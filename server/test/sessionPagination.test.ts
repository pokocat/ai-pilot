import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.js';
import { enqueueDurableGeneration } from '../src/services/generationRequest.js';
import { tickGenerationWorker } from '../src/services/generationWorker.js';

describe('会话详情消息分页', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('默认回最后 100 条，复合游标可无重无漏地翻到会话开头', async () => {
    const token = await login(uniquePhone(), '分页用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: token } });
    const session = await prisma.session.create({
      data: { tenantId: user.tenantId, userId: user.id, agentKey: 'general', title: '205 条长会话' },
    });
    const at = new Date('2026-08-01T00:00:00.000Z');
    await prisma.message.createMany({
      data: Array.from({ length: 205 }, (_, i) => ({
        id: `pg${String(i).padStart(4, '0')}`,
        sessionId: session.id,
        role: i % 2 ? 'assistant' : 'user',
        contentJson: { text: `消息 ${i}` },
        createdAt: at, // 故意全部同毫秒，验证 id 是真实复合游标而非注释里的摆设
      })),
    });

    const first = await api('GET', `/api/sessions/${session.id}`, { token });
    assert.equal(first.status, 200);
    assert.equal(first.body.messages.length, 100);
    assert.equal(first.body.messages[0].id, 'pg0105');
    assert.equal(first.body.messages.at(-1).id, 'pg0204');
    assert.equal(first.body.messagePage.hasMore, true);

    const second = await api('GET', `/api/sessions/${session.id}?before=${encodeURIComponent(first.body.messagePage.nextCursor)}`, { token });
    assert.equal(second.body.messages.length, 100);
    assert.equal(second.body.messages[0].id, 'pg0005');
    assert.equal(second.body.messages.at(-1).id, 'pg0104');

    const third = await api('GET', `/api/sessions/${session.id}?before=${encodeURIComponent(second.body.messagePage.nextCursor)}`, { token });
    assert.deepEqual(third.body.messages.map((m: { id: string }) => m.id), ['pg0000', 'pg0001', 'pg0002', 'pg0003', 'pg0004']);
    assert.deepEqual(third.body.messagePage, { hasMore: false, nextCursor: null, limit: 100 });

    const ids = [...third.body.messages, ...second.body.messages, ...first.body.messages].map((m: { id: string }) => m.id);
    assert.equal(ids.length, 205);
    assert.equal(new Set(ids).size, 205, '跨页不得重复消息');
  });

  test('伪造或损坏的游标明确 400，不静默回到尾页', async () => {
    const token = await login(uniquePhone(), '坏游标用户');
    const list = await api('GET', '/api/sessions', { token });
    const id = list.body[0]?.id;
    if (!id) {
      const user = await prisma.user.findUniqueOrThrow({ where: { id: token } });
      const created = await prisma.session.create({ data: { tenantId: user.tenantId, userId: user.id, agentKey: 'general' } });
      const bad = await api('GET', `/api/sessions/${created.id}?before=not-a-cursor`, { token });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.code, 'INVALID_MESSAGE_CURSOR');
      return;
    }
    const bad = await api('GET', `/api/sessions/${id}?before=not-a-cursor`, { token });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_MESSAGE_CURSOR');
  });

  test('跨 24 小时章节由服务端按上一条真实消息冻结并写入 trace', async () => {
    const token = await login(uniquePhone(), '章节用户');
    const user = await prisma.user.findUniqueOrThrow({ where: { id: token } });
    const session = await prisma.session.create({
      data: { tenantId: user.tenantId, userId: user.id, agentKey: 'general', title: '连续主线', lineageId: 'lineage-chapter' },
    });
    await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'assistant',
        contentJson: { text: '上一次谈到单店模型。' },
        createdAt: new Date(Date.now() - 25 * 3_600_000),
      },
    });
    const created = await enqueueDurableGeneration(user, {
      sessionId: session.id,
      text: '我们接着聊',
      agentKey: 'general',
      clientRequestId: 'chapter-gap-frozen',
    });
    const request = created.job.requestJson as { newChapter?: boolean; chapterGapHours?: number };
    assert.equal(request.newChapter, true);
    assert.ok((request.chapterGapHours ?? 0) >= 24);
    await tickGenerationWorker();
    const done = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });
    const frozen = done.contextJson as { ctx?: { contextTrace?: { continuity?: Record<string, unknown> } } };
    assert.deepEqual(frozen.ctx?.contextTrace?.continuity, {
      sessionId: session.id,
      lineageId: 'lineage-chapter',
      continuationOf: null,
      sourceSessionId: null,
      newChapter: true,
      chapterGapHours: request.chapterGapHours,
      inheritedChars: 0,
    });
  });
});
