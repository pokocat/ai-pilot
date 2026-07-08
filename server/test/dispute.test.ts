// WO-11 异议流：用户对决策/预言提异议 → 不改状态、复盘账本块带出「用户有异议」；空 400、不存在 404。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { decisionBriefing } from '../src/services/decisionLog.ts';
import { prophecyBriefing } from '../src/services/prophecyLog.ts';

describe('WO-11 异议流', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('决策异议 → 账本块带出「用户有异议」；空 400、不存在 404', async () => {
    const token = await login(uniquePhone(), '异议用户');
    const d = await api('POST', '/api/decisions', { token, body: { decision: '砍掉低毛利产品线', verifyStandard: '毛利率回升' } });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    const id = d.body.decision.id;

    const patch = await api('PATCH', `/api/decisions/${id}`, { token, body: { dispute: '这条我不同意，那条线客户还在' } });
    assert.equal(patch.status, 200);

    const b = await decisionBriefing(token);
    assert.match(b ?? '', /用户有异议/);
    assert.match(b ?? '', /这条我不同意/);

    assert.equal((await api('PATCH', `/api/decisions/${id}`, { token, body: { dispute: '' } })).status, 400);
    assert.equal((await api('PATCH', '/api/decisions/nope', { token, body: { dispute: 'x' } })).status, 404);
  });

  test('预言异议 → 天机账本块带出异议', async () => {
    const token = await login(uniquePhone(), '异议用户2');
    const p = await api('POST', '/api/prophecies', { token, body: { prophecy: '三个月内旺季客流翻倍', verifyStandard: '客流数据' } });
    const id = p.body.prophecy.id;
    assert.equal((await api('PATCH', `/api/prophecies/${id}`, { token, body: { dispute: '旺季还没到，先别下这个结论' } })).status, 200);
    const b = await prophecyBriefing(token);
    assert.match(b ?? '', /用户有异议/);
  });
});
