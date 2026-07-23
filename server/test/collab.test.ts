// V7-15 会话协同披露 + 未读数强化：
//  1) GET /sessions 的 unreadCount（自 lastReadAt 起 assistant 计数）+ 打开会话置读归零；
//  2) writeSystemMessage 落一条 role='system' 消息，出现在会话详情（sys-card 文案原样）；
//  3) system 消息不计入 unreadCount（仅 assistant 计）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { writeSystemMessage, SYNC_DISCLOSURE_PREFIX } from '../src/services/collab.ts';
import { trackSessionGeneration } from '../src/services/sessionGeneration.ts';

describe('V7-15 会话协同披露 + 未读数', () => {
  let token = '';
  let other = '';
  before(async () => {
    await getApp();
    await cleanBusiness();
    await seedBaseline();
    token = await login(uniquePhone(), '协同用户');
    other = await login(uniquePhone(), '隔壁用户');
  });
  after(async () => { await closeApp(); });

  // 每次 generate-sync 未带 sessionId → 新建会话；总军师 general(on-demand) + 非产出请求「你好」→ role='assistant'。
  async function newSessionWithAssistant(t: string): Promise<string> {
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '你好', agentKey: 'general' } });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    return gen.body.sessionId as string;
  }

  test('unreadCount：assistant 回复后为 1，打开会话置读后为 0', async () => {
    const sid = await newSessionWithAssistant(token);

    const list1 = await api('GET', '/api/sessions', { token });
    assert.equal(list1.status, 200);
    const s1 = list1.body.find((x: { id: string }) => x.id === sid);
    assert.ok(s1, '应有该会话');
    assert.equal(s1.unreadCount, 1, 'assistant 回复计 1 条未读');
    assert.equal(s1.hasUnread, true, 'unreadCount>0 → hasUnread=true');

    await api('GET', `/api/sessions/${sid}`, { token }); // 打开会话 → 标记已读（lastReadAt=now）
    const list2 = await api('GET', '/api/sessions', { token });
    const s2 = list2.body.find((x: { id: string }) => x.id === sid);
    assert.equal(s2.unreadCount, 0, '置读后 unreadCount 归零');
    assert.equal(s2.hasUnread, false, '置读后无未读');
  });

  test('writeSystemMessage：落一条 role=system 消息并出现在会话详情', async () => {
    const sid = await newSessionWithAssistant(token);
    const text = `${SYNC_DISCLOSURE_PREFIX}：IP 军师给出定位建议，增长军师补充转化路径。`;

    const mid = await writeSystemMessage({ sessionId: sid, text });
    assert.equal(typeof mid, 'string');
    assert.ok(mid.length > 0, '返回新消息 id');

    const detail = await api('GET', `/api/sessions/${sid}`, { token });
    assert.equal(detail.status, 200);
    const sys = detail.body.messages.find((m: { role: string }) => m.role === 'system');
    assert.ok(sys, '会话详情应含一条 system 消息');
    assert.equal(sys.content.text, text, 'sys-card 文案原样落库（contentJson.text）');
  });

  test('system 消息不计入 unreadCount（仅 assistant 计）', async () => {
    // 新会话（未打开，lastReadAt=null）：assistant 计 1
    const sid = await newSessionWithAssistant(token);
    // 写一条 system 消息——即便晚于 lastReadAt(=epoch)，也不应被计入未读
    await writeSystemMessage({ sessionId: sid, text: `${SYNC_DISCLOSURE_PREFIX}：内部协同摘要。` });

    const list = await api('GET', '/api/sessions', { token });
    const s = list.body.find((x: { id: string }) => x.id === sid);
    assert.ok(s, '应有该会话');
    assert.equal(s.unreadCount, 1, 'system 不计入，仍只数 assistant 的 1 条');
  });

  test('租户隔离：他人看不到本人会话（unreadCount 亦不泄漏）', async () => {
    const sid = await newSessionWithAssistant(token);
    const mine = await api('GET', '/api/sessions', { token });
    assert.ok(mine.body.some((x: { id: string }) => x.id === sid), '本人可见');

    const theirs = await api('GET', '/api/sessions', { token: other });
    assert.ok(!theirs.body.some((x: { id: string }) => x.id === sid), '他人列表不含本人会话');
    const detail = await api('GET', `/api/sessions/${sid}`, { token: other });
    assert.equal(detail.status, 404, '他人按 id 取详情 → 404');
  });

  test('生成中真值：列表与详情均披露 generating，结束后即时清除', async () => {
    const sid = await newSessionWithAssistant(token);
    const finish = trackSessionGeneration(sid);
    try {
      const list = await api('GET', '/api/sessions', { token });
      const item = list.body.find((x: { id: string }) => x.id === sid);
      assert.equal(item.generating, true);
      assert.equal(item.snippet, '军师正在思考…');

      const detail = await api('GET', `/api/sessions/${sid}`, { token });
      assert.equal(detail.body.generating, true);
    } finally {
      finish();
    }

    const settled = await api('GET', `/api/sessions/${sid}`, { token });
    assert.equal(settled.body.generating, false);
  });
});
