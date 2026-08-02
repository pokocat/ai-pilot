import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Plan, PlanOption, PlanOptionsResult } from './api';
import { ACTION_LABEL, canStartPurchase, currentPlanOption, isPlanExpired, publicFeatures, visiblePlanOptions } from '../packages/work/plans/model';

function plan(id: string, period: 'month' | 'year' = 'month', price = 6_800): Plan {
  return {
    id, name: id, price, period, creditsPerMonth: 10, tokenQuotaPerMonth: 100_000,
    agentCount: 3, featuresJson: [], highlighted: false, planFamilyKey: id.split('-')[0],
    tierRank: 10, usageLevel: price < 0 ? 'custom' : 'standard', usageLabel: price < 0 ? '专属用量' : '标准用量',
  };
}

function option(value: Plan, overrides: Partial<PlanOption> = {}): PlanOption {
  return { plan: value, relation: 'available', action: 'buy', canPurchase: true, ...overrides };
}

function result(options: PlanOption[], currentPlanId: string | null): PlanOptionsResult {
  return {
    currentPlanId,
    usage: { usagePercent: 35, usageStatus: 'normal', resetsAt: '2026-09-01T00:00:00.000Z', unlimited: false },
    options,
  };
}

test('方案状态：当前方案只按稳定 id 匹配，改名与到期都不会让当前卡消失', () => {
  const current = option({ ...plan('decision-month'), name: '运营改名后的决策方案' }, {
    relation: 'renew', action: 'renew', expiresAt: '2026-08-01T00:00:00.000Z',
  });
  const data = result([option(plan('starter-month')), current], 'decision-month');
  assert.equal(currentPlanOption(data), current);
  assert.equal(isPlanExpired(current.expiresAt, Date.parse('2026-08-01T00:00:00.000Z')), true);
  assert.equal(currentPlanOption({ ...data, currentPlanId: 'missing-id' }), null);
});

test('方案状态：周期筛选排除当前方案，企业面议档在月付/年付视图都保留', () => {
  const current = option(plan('starter-month'));
  const month = option(plan('decision-month'));
  const year = option(plan('decision-year', 'year', 68_000));
  const enterprise = option(plan('enterprise', 'year', -1), { relation: 'enterprise', action: 'contact', canPurchase: false });
  const data = result([current, month, year, enterprise], current.plan.id);
  assert.deepEqual(visiblePlanOptions(data, 'month').map((item) => item.plan.id), ['decision-month', 'enterprise']);
  assert.deepEqual(visiblePlanOptions(data, 'year').map((item) => item.plan.id), ['decision-year', 'enterprise']);
});

test('方案状态：只有可购买动作能发起下单，降档/企业/到账处理中均只读', () => {
  for (const action of ['buy', 'renew', 'upgrade', 'change_billing', 'continue_payment'] as const) {
    assert.equal(canStartPurchase(option(plan(action), { action })), true, action);
    assert.ok(ACTION_LABEL[action]);
  }
  for (const action of ['remind', 'contact', 'wait_applied'] as const) {
    assert.equal(canStartPurchase(option(plan(action), { action, canPurchase: action === 'remind' })), false, action);
    assert.ok(ACTION_LABEL[action]);
  }
  assert.equal(canStartPurchase(option(plan('disabled'), { action: 'buy', canPurchase: false })), false);
});

test('方案状态：到期边界与长期有效语义明确', () => {
  const at = Date.parse('2026-08-02T12:00:00.000Z');
  assert.equal(isPlanExpired(null, at), false);
  assert.equal(isPlanExpired('2026-08-02T12:00:00.001Z', at), false);
  assert.equal(isPlanExpired('2026-08-02T12:00:00.000Z', at), true);
  assert.equal(isPlanExpired('2026-08-02T11:59:59.999Z', at), true);
});

test('方案文案：隐藏内部原始额度/顾问数量，只保留最多四条用户权益', () => {
  assert.deepEqual(publicFeatures([
    '100000 token/月', '每月 500 点', '每月约 20 次', '8 位顾问', '顾问共 8 位',
    '经营资料整理', '方案版本管理', '跨项目检索', '优先响应', '第五条不展示',
  ]), ['经营资料整理', '方案版本管理', '跨项目检索', '优先响应']);
});
