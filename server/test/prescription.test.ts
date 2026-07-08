// WO-12 处方引擎测试：认可方案 → 白名单内处方落库、表外丢弃；转化埋点推进；动作校验。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';

const deliverableWith = (prescriptions: unknown) => ({
  title: '增长方案', icon: 'spark', meta: '', trust: '', actions: [],
  sections: [{ h: '打法', b: '聚焦影响力获客', list: ['每周 3 条口播', '私域承接'] }],
  prescriptions,
});

describe('WO-12 处方引擎', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('认可方案 → 白名单内落库、表外丢弃；点击埋点推进状态', async () => {
    const token = await login(uniquePhone(), '处方用户');
    const deliverable = deliverableWith([
      { problem: '获客越来越贵', playbook: '做影响力短视频', toolKey: 'growth' },
      { problem: '没有人设', playbook: '起个 IP', toolKey: 'ghost' }, // 白名单外 → 丢弃
      { problem: '内容调性乱', playbook: '搭品牌调性', toolKey: 'brand' },
    ]);
    const acc = await api('POST', '/api/casefile/accept', { token, body: { deliverable } });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));

    const list = await api('GET', '/api/prescriptions', { token });
    assert.equal(list.status, 200);
    const keys = list.body.items.map((i: { toolKey: string }) => i.toolKey).sort();
    assert.deepEqual(keys, ['brand', 'growth'], '白名单外 ghost 被丢弃');
    assert.ok(list.body.items.every((i: { status: string }) => i.status === 'proposed'));

    const first = list.body.items[0];
    const click = await api('POST', `/api/prescriptions/${first.id}/clicked`, { token });
    assert.equal(click.status, 200);
    const after2 = await api('GET', '/api/prescriptions', { token });
    assert.equal(after2.body.items.find((i: { id: string }) => i.id === first.id).status, 'clicked');
  });

  test('WO-14 成果回填：首期→used、连续两期有正指标→verified；不存在 404', async () => {
    const token = await login(uniquePhone(), '回流用户');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith([{ problem: '获客', playbook: '短视频', toolKey: 'growth' }]) } });
    const id = (await api('GET', '/api/prescriptions', { token })).body.items[0].id;

    const o1 = await api('POST', `/api/prescriptions/${id}/outcome`, { token, body: { period: 'week', metrics: { leads: 5 } } });
    assert.equal(o1.status, 200);
    assert.equal((await api('GET', '/api/prescriptions', { token })).body.items.find((i: { id: string }) => i.id === id).status, 'used');

    await api('POST', `/api/prescriptions/${id}/outcome`, { token, body: { period: 'week', metrics: { leads: 8 } } });
    assert.equal((await api('GET', '/api/prescriptions', { token })).body.items.find((i: { id: string }) => i.id === id).status, 'verified', '连续两期正指标 → verified');

    assert.equal((await api('POST', '/api/prescriptions/nope/outcome', { token, body: {} })).status, 404);
  });

  test('无处方的方案 → 不落库；未知动作 400；不存在处方 404', async () => {
    const token = await login(uniquePhone(), '处方用户2');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith(undefined) } });
    assert.equal((await api('GET', '/api/prescriptions', { token })).body.items.length, 0);
    assert.equal((await api('POST', '/api/prescriptions/x/frobnicate', { token })).status, 400);
    assert.equal((await api('POST', '/api/prescriptions/nope/clicked', { token })).status, 404);
  });
});
