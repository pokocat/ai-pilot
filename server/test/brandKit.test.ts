// WO-13 品牌资产包测试：未到执行阶段 → 生成 403；认可方案进 executing → 生成三段齐全；确认 → approved。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';

const DELIVERABLE = {
  title: '增长方案', icon: 'spark', meta: '', trust: '', actions: [],
  sections: [{ h: '打法', b: '聚焦影响力获客', list: ['每周 3 条口播', '私域承接'] }],
};

describe('WO-13 品牌资产包', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('未进执行阶段 → 生成 403；认可方案后 → 三段齐全；确认 → approved', async () => {
    const token = await login(uniquePhone(), '品牌用户');

    const locked = await api('POST', '/api/brand-kit/generate', { token });
    assert.equal(locked.status, 403, '没方案不给生成');
    assert.equal(locked.body.code, 'BRANDKIT_LOCKED');

    // 认可一份方案 → journey 进 executing（生成门槛）
    const acc = await api('POST', '/api/casefile/accept', { token, body: { deliverable: DELIVERABLE } });
    assert.equal(acc.status, 200, JSON.stringify(acc.body));

    const gen = await api('POST', '/api/brand-kit/generate', { token });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    assert.ok(gen.body.persona?.name, 'persona 有 name');
    assert.ok(Array.isArray(gen.body.voice?.hooks) && gen.body.voice.hooks.length > 0, 'voice 有 hooks');
    assert.ok(Array.isArray(gen.body.theme?.keywords), 'theme 有 keywords');
    assert.equal(gen.body.version, 1);
    assert.equal(gen.body.approved, false);

    const appr = await api('POST', '/api/brand-kit/approve', { token });
    assert.equal(appr.status, 200);
    const got = await api('GET', '/api/brand-kit', { token });
    assert.equal(got.body.approved, true, '确认后 approved=true');

    // 重生成 → version+1 且 approved 归零
    const gen2 = await api('POST', '/api/brand-kit/generate', { token });
    assert.equal(gen2.body.version, 2);
    assert.equal(gen2.body.approved, false, '重生成清掉旧确认');
  });
});
