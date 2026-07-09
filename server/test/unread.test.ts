// 会话未读（QA-③）：AI 回复落库后列表 hasUnread=true；打开会话（GET /sessions/:id）标记已读后清除。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';

describe('会话未读信号', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('AI 回复后 hasUnread=true；打开会话后 hasUnread=false', async () => {
    const token = await login(uniquePhone(), '未读用户');
    const gen = await api('POST', '/api/generate-sync', { token, body: { text: '你好', agentKey: 'general' } });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));

    const list1 = await api('GET', '/api/sessions', { token });
    assert.equal(list1.status, 200);
    const s1 = list1.body[0];
    assert.ok(s1, '应有一个会话');
    assert.equal(s1.hasUnread, true, 'AI 回复落库后为未读');

    await api('GET', `/api/sessions/${s1.id}`, { token }); // 打开会话 → 标记已读
    const list2 = await api('GET', '/api/sessions', { token });
    assert.equal(list2.body.find((x: { id: string }) => x.id === s1.id).hasUnread, false, '打开后清除未读');
  });
});
