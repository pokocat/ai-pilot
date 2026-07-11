// WO-12 处方引擎测试：认可方案 → 白名单内处方落库、表外丢弃；转化埋点推进；动作校验。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';

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

  test('生成端：军师出方案时携带处方（mock，白名单工具 growth）', async () => {
    const token = await login(uniquePhone(), '生成处方用户');
    await api('PUT', '/api/profile', { token, body: { industry: '美业', stage: '规模化', pain: '获客越来越贵' } });
    const r = await api('POST', '/api/generate-sync', { token, body: { text: '给我出个增长方案', agentKey: 'general' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, 'report');
    assert.ok(Array.isArray(r.body.deliverable?.prescriptions) && r.body.deliverable.prescriptions.length > 0, '方案携带处方');
    assert.equal(r.body.deliverable.prescriptions[0].toolKey, 'growth');
  });

  test('P0-4 状态机单调化：verified 后上报 seen 不回退；乱序埋点最终态正确', async () => {
    const token = await login(uniquePhone(), '单调用户');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith([{ problem: '获客', playbook: '短视频', toolKey: 'growth' }]) } });
    const id = (await api('GET', '/api/prescriptions', { token })).body.items[0].id;
    const statusOf = async () => (await api('GET', '/api/prescriptions', { token })).body.items.find((i: { id: string }) => i.id === id)?.status;

    // 乱序：clicked 先到 → clicked；随后 seen 到 → 不回退（仍 clicked）
    assert.equal((await api('POST', `/api/prescriptions/${id}/clicked`, { token })).status, 200);
    assert.equal(await statusOf(), 'clicked');
    assert.equal((await api('POST', `/api/prescriptions/${id}/seen`, { token })).status, 200, 'seen 幂等成功（存在即 200）');
    assert.equal(await statusOf(), 'clicked', 'seen 不把 clicked 打回');

    // 推到 verified（两期正指标），再上报 seen → 不回退
    await api('POST', `/api/prescriptions/${id}/outcome`, { token, body: { period: 'w1', metrics: { leads: 3 } } });
    await api('POST', `/api/prescriptions/${id}/outcome`, { token, body: { period: 'w2', metrics: { leads: 5 } } });
    assert.equal(await statusOf(), 'verified');
    assert.equal((await api('POST', `/api/prescriptions/${id}/seen`, { token })).status, 200);
    assert.equal(await statusOf(), 'verified', 'verified 后重复上报 seen 不回退');

    // verified 后再补一期无正指标的 outcome → 仍 verified（recordOutcome 不降级）
    await api('POST', `/api/prescriptions/${id}/outcome`, { token, body: { period: 'w3', metrics: {} } });
    assert.equal(await statusOf(), 'verified', 'outcome 单调：不把 verified 降回 used');
  });

  test('P0-4 dismissed 规则：proposed/seen 可作废并从列表消失；靠后状态不可作废', async () => {
    const token = await login(uniquePhone(), '作废用户');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith([
      { problem: '获客', playbook: '短视频', toolKey: 'growth' },
      { problem: '调性', playbook: '搭品牌', toolKey: 'brand' },
    ]) } });
    const items = (await api('GET', '/api/prescriptions', { token })).body.items;
    const a = items.find((i: { toolKey: string }) => i.toolKey === 'growth');
    const b = items.find((i: { toolKey: string }) => i.toolKey === 'brand');

    // a：proposed → dismissed，成功且从列表消失（软删）
    assert.equal((await api('POST', `/api/prescriptions/${a.id}/dismissed`, { token })).status, 200);
    const afterA = (await api('GET', '/api/prescriptions', { token })).body.items;
    assert.ok(!afterA.some((i: { id: string }) => i.id === a.id), '已作废处方从列表消失');
    const rowA = await prisma.prescription.findUnique({ where: { id: a.id } });
    assert.equal(rowA?.status, 'dismissed', '软删为 dismissed 而非物理删除');

    // b：先 activated（靠后状态），再 dismissed → 拒绝作废（保持 activated）
    await api('POST', `/api/prescriptions/${b.id}/activated`, { token });
    assert.equal((await api('POST', `/api/prescriptions/${b.id}/dismissed`, { token })).status, 200, '存在即 200（幂等 no-op）');
    const rowB = await prisma.prescription.findUnique({ where: { id: b.id } });
    assert.equal(rowB?.status, 'activated', 'activated 不可被作废回退');
  });

  test('无处方的方案 → 不落库；未知动作 400；不存在处方 404', async () => {
    const token = await login(uniquePhone(), '处方用户2');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: deliverableWith(undefined) } });
    assert.equal((await api('GET', '/api/prescriptions', { token })).body.items.length, 0);
    assert.equal((await api('POST', '/api/prescriptions/x/frobnicate', { token })).status, 400);
    assert.equal((await api('POST', '/api/prescriptions/nope/clicked', { token })).status, 404);
  });
});
