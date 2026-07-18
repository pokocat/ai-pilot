// WO-13 品牌资产包测试：未到执行阶段 → 生成 403；认可方案进 executing → 生成三段齐全；确认 → approved。
// P0-1 计费与门禁：套餐过期 → 403 PLAN_EXPIRED；额度耗尽 → 402（真实模型调用前拦住，防资损）；
//        生成失败（未进执行阶段，reserve 之后抛错）→ 预留全额退回、余额不变。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';

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

  test('P0-1 套餐过期 → 生成 403 PLAN_EXPIRED（早于生成，防资损）', async () => {
    const token = await login(uniquePhone(), '过期用户');
    // 先认可方案进执行阶段（证明拦截的是「过期」而非「未到执行」）
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: DELIVERABLE } });
    await prisma.user.update({ where: { id: token }, data: { planExpiresAt: new Date(Date.now() - 86_400_000) } });

    const r = await api('POST', '/api/brand-kit/generate', { token });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'PLAN_EXPIRED');
  });

  test('P0-1 额度耗尽 → 生成 402（真实模型调用前拦住）', async () => {
    const token = await login(uniquePhone(), '零额度用户');
    await api('POST', '/api/casefile/accept', { token, body: { deliverable: DELIVERABLE } });
    // 首次生成创建钱包（有套餐额度，放行），再清零余额模拟额度耗尽
    const ok = await api('POST', '/api/brand-kit/generate', { token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    await prisma.tokenWallet.update({ where: { userId: token }, data: { balance: 0 } });

    const r = await api('POST', '/api/brand-kit/generate', { token });
    assert.equal(r.status, 402, '额度耗尽 → 402（品牌资产包无 grace 保底）');
    assert.equal(r.body.code, 'INSUFFICIENT_QUOTA');
  });

  test('P0-1 生成失败（未进执行阶段）→ 预留全额退回、余额不变', async () => {
    const token = await login(uniquePhone(), '退款用户');
    // 未认可方案 → journey=new → generateBrandKit 在 reserve 之后抛 BRANDKIT_LOCKED
    const r = await api('POST', '/api/brand-kit/generate', { token });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'BRANDKIT_LOCKED');
    // reserve 已扣一份预留、catch 里 refund 全额退回 → 余额回到初始 quota（净扣 0）
    const w = await prisma.tokenWallet.findUnique({ where: { userId: token } });
    assert.ok(w, '失败路径也已惰性建钱包');
    assert.equal(w!.balance, w!.quota, '失败 → 预留全额退回，余额不被吞');
  });
});
