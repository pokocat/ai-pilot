// WO-07 journey 状态机测试：deriveNextStep 纯函数全分支（无 DB） + 端到端进程（注册→速诊→认可）。
//   cd server && DATABASE_URL=... NODE_ENV=test node --import tsx --test --test-concurrency=1 test/journey.test.ts
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { deriveNextStep } from '../src/services/journey.ts';

const base = { diagRound: 0, todayOrdersTotal: 0, todayOrdersDone: 0, todayReviewed: false, hour: 10 };

describe('deriveNextStep（纯函数，全分支）', () => {
  test('new → 速诊', () => assert.equal(deriveNextStep({ ...base, stage: 'new' })?.key, 'quickscan'));
  test('scanned → 进参谋室', () => assert.equal(deriveNextStep({ ...base, stage: 'scanned' })?.key, 'continue_diagnosis'));
  test('diagnosing → 继续第 N+1 轮（含轮次）', () => {
    const ns = deriveNextStep({ ...base, stage: 'diagnosing', diagRound: 3 });
    assert.equal(ns?.key, 'continue_diagnosis');
    assert.match(ns!.title, /第 4 轮/);
  });
  test('plan_ready → 认可方案', () => assert.equal(deriveNextStep({ ...base, stage: 'plan_ready' })?.key, 'accept_plan'));
  test('executing 有未完成军令 → 去做军令（含进度）', () => {
    const ns = deriveNextStep({ ...base, stage: 'executing', todayOrdersTotal: 3, todayOrdersDone: 1 });
    assert.equal(ns?.key, 'do_orders');
    assert.match(ns!.title, /1\/3/);
  });
  test('executing 军令全完成 + 晚间未复盘 → 去复盘', () => {
    const ns = deriveNextStep({ ...base, stage: 'executing', todayOrdersTotal: 2, todayOrdersDone: 2, hour: 20 });
    assert.equal(ns?.key, 'do_review');
  });
  test('executing 白天无军令 → 录战果（不催复盘）', () => {
    assert.equal(deriveNextStep({ ...base, stage: 'executing', hour: 10 })?.key, 'do_orders');
  });
  test('reviewing 已复盘 → 回执行', () => {
    assert.equal(deriveNextStep({ ...base, stage: 'reviewing', todayReviewed: true, hour: 21 })?.key, 'do_orders');
  });
});

describe('journey 端到端进程', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await closeApp(); });

  test('注册→new；速诊→scanned + 下一步=继续诊断', async () => {
    const token = await login(uniquePhone(), 'journey用户');
    const j0 = await api('GET', '/api/journey', { token });
    assert.equal(j0.status, 200, JSON.stringify(j0.body));
    assert.equal(j0.body.stage, 'new');
    assert.equal(j0.body.nextStep?.key, 'quickscan');

    await api('POST', '/api/quickscan', { token, body: { industry: '美业', revenueBand: '100-500万', pain: '获客越来越贵' } });
    const j1 = await api('GET', '/api/journey', { token });
    assert.equal(j1.body.stage, 'scanned');
    assert.equal(j1.body.nextStep?.key, 'continue_diagnosis');
  });
});
