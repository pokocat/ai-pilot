// WO-04 复盘周/月账本聚合（修 A-4）：月复盘聚合当月 CasefileMetric（线索/咨询/成交求和）→ 落 month 行 + 注入月报块。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { recordReview, reviewBriefing } from '../src/services/reviewLog.ts';
import { todayStr } from '../src/services/casefile.ts';

describe('WO-04 复盘周/月账本聚合', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('月复盘聚合当月线索/咨询/成交求和 → 落 month 行 + 注入月报', async () => {
    const token = await login(uniquePhone(), '月报用户');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;
    const acc = await api('POST', '/api/casefile/accept', { token, body: { deliverable: { title: '方案', icon: 'spark', meta: '', trust: '', actions: [], sections: [{ h: '打法', b: 'x', list: ['做A'] }] } } });
    const cfId = acc.body.casefileId as string;
    assert.ok(cfId, JSON.stringify(acc.body));

    const today = todayStr();
    const first = `${today.slice(0, 7)}-01`;
    const rows = [{ tenantId: user.tenantId, userId: user.id, casefileId: cfId, date: first, leads: 10, consults: 4, deals: 2 }];
    if (first !== today) rows.push({ tenantId: user.tenantId, userId: user.id, casefileId: cfId, date: today, leads: 6, consults: 3, deals: 1 });
    await prisma.casefileMetric.createMany({ data: rows });
    const expected = first !== today ? { leads: 16, consults: 7, deals: 3 } : { leads: 10, consults: 4, deals: 2 };

    const rv = await recordReview({ tenantId: user.tenantId, userId: user.id, layer: 'month' });
    assert.equal(rv.layer, 'month');
    assert.equal(rv.date, first, 'month 行 date=当月 1 号');

    const row = await prisma.reviewLog.findFirst({ where: { userId: user.id, layer: 'month' } });
    assert.deepEqual(row!.metricsJson, expected, '当月线索/咨询/成交求和（系统算，非 LLM 现编）');

    const b = await reviewBriefing(user.id);
    assert.match(b ?? '', /最近月报/);
    assert.match(b ?? '', new RegExp(`线索 ${expected.leads}`));
  });
});
