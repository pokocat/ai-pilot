// 会话标题自动总结：首轮硬截断占位 → 异步轻量模型提炼短标题覆盖。
// 安全性质：测试/mock 下无真实 provider → summarizeSessionTitle 返回 null、refineSessionTitle 不改动标题（保留占位）。
// 并锁定 updateMany 竞态守卫语义（where.title=占位才覆盖）——refineSessionTitle 依赖它避免误覆盖用户改名/后续消息。
//   cd server && node --env-file=.env.test --import tsx --test test/sessionTitle.test.ts
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { summarizeSessionTitle } from '../src/llm/gateway.js';
import { refineSessionTitle } from '../src/services/sessionTitle.js';
import { prisma } from '../src/db.js';

describe('会话标题自动总结', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('无 live provider（测试/mock）→ summarizeSessionTitle 返回 null；空串直接 null', async () => {
    // NODE_ENV=test → isAiTestMode() → liveProvider 返回 null → 绝不生造标题（保留硬截断兜底）。
    assert.equal(await summarizeSessionTitle('我想请教一下今年餐饮门店该不该继续扩张再开三家分店'), null);
    assert.equal(await summarizeSessionTitle(''), null);
    assert.equal(await summarizeSessionTitle('   '), null);
  });

  test('新会话落硬截断占位标题；refineSessionTitle 无模型时不改动（保留占位）', async () => {
    const token = await login(uniquePhone(), '标题用户');
    const longText = '我想请教一下今年餐饮门店到底该不该继续扩张再开三家分店';
    const gen = await api('POST', '/api/generate-sync', { token, body: { text: longText, agentKey: 'general' } });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    const sessionId: string = gen.body.sessionId;
    const placeholder = longText.slice(0, 18);

    const s0 = await prisma.session.findUnique({ where: { id: sessionId } });
    assert.equal(s0?.title, placeholder, '首轮标题应为硬截断占位');

    // 即发即忘的 refine 在无 live provider 下是 no-op：不抛错、标题保持占位。
    await refineSessionTitle(sessionId, longText, placeholder);
    const s1 = await prisma.session.findUnique({ where: { id: sessionId } });
    assert.equal(s1?.title, placeholder, 'refine 无模型时不改动标题');
  });

  test('updateMany 竞态守卫：占位不匹配则零行更新（refineSessionTitle 依赖的写入语义）', async () => {
    const token = await login(uniquePhone(), '标题用户2');
    const gen = await api('POST', '/api/generate-sync', { token, body: { text: '现金流很紧张怎么办', agentKey: 'general' } });
    const sessionId: string = gen.body.sessionId;
    const current = (await prisma.session.findUnique({ where: { id: sessionId } }))!.title;

    // 占位值与库中标题不符 → 命中 0 行（守卫：只在标题仍是本次占位时才覆盖，避免误覆盖用户改名/后续消息）。
    const miss = await prisma.session.updateMany({ where: { id: sessionId, title: current + '·不一致' }, data: { title: '不该写入' } });
    assert.equal(miss.count, 0);
    // 占位值匹配 → 命中 1 行并覆盖。
    const hit = await prisma.session.updateMany({ where: { id: sessionId, title: current }, data: { title: '总结后的短标题' } });
    assert.equal(hit.count, 1);
    const s = await prisma.session.findUnique({ where: { id: sessionId } });
    assert.equal(s?.title, '总结后的短标题');
  });
});
