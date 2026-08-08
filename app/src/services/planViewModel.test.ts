import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Plan, PlanOption, PlanOptionsResult } from './api';
import { ACTION_LABEL, DEFAULT_PURCHASE_MODE, availablePeriods, canStartPurchase, currentPlanOption, effectivePurchaseMode, isPlanExpired, promotionDeadline, promotionKicker, promotionSave, publicFeatures, resolvePeriod, visiblePlanOptions } from '../packages/work/plans/model';

function plan(id: string, period: 'month' | 'year' = 'month', price = 6_800): Plan {
  return {
    id, name: id, price, period, creditsPerMonth: 10, tokenQuotaPerMonth: 100_000,
    agentCount: 3, featuresJson: [], highlighted: false, planFamilyKey: id.split('-')[0],
    tierRank: 10, usageLevel: price < 0 ? 'custom' : 'standard', usageLabel: price < 0 ? '专属用量' : '标准用量',
    autoRenewAvailable: false, promotion: null,
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
    subscription: null,
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

test('周期 tab：只按实际配出来的档展示，只配年付时月付 tab 不出现', () => {
  const year = option(plan('premier-year', 'year', 398_000));
  const month = option(plan('starter-month', 'month', 9_900));
  const onlyYear = result([year], null);
  const both = result([year, month], null);

  assert.deepEqual(availablePeriods((p) => visiblePlanOptions(onlyYear, p).length), ['year'], '没有月付档就不该有月付 tab');
  assert.deepEqual(availablePeriods((p) => visiblePlanOptions(both, p).length), ['month', 'year']);
  assert.deepEqual(availablePeriods(() => 0), [], '一档都没有时不出切换器，交给空态');

  // 默认停在 month，但库里只有年付 —— 必须落到年付，否则用户开屏就是「暂无这一周期的方案」
  assert.equal(resolvePeriod('month', ['year']), 'year');
  assert.equal(resolvePeriod('month', ['month', 'year']), 'month', '有货就不动用户的选择');
  assert.equal(resolvePeriod('year', []), 'year', '一个都没货时保持原样，页面走空态');
});

test('周期 tab：面议档在两个周期都算有货（它本来就在每个 tab 里展示）', () => {
  // 判定复用 visiblePlanOptions，所以「哪个 tab 有货」和「tab 里实际显示什么」永远一致，
  // 不会出现「月付 tab 点得进去、里面空着」。
  const enterprise = option(plan('enterprise', 'year', -1), { relation: 'enterprise', action: 'contact', canPurchase: false });
  assert.deepEqual(availablePeriods((p) => visiblePlanOptions(result([enterprise], null), p).length), ['month', 'year']);
});

test('折扣展示：文案只拼装服务端下发的口径，端上不按价格自己算', () => {
  // savedFen 故意与 listPrice-price 不一致：端上必须原样用服务端给的数，
  // 任何一天这里开始自己减，就会出现「显示立省 X、实际扣款按另一个数」。
  const money = (fen: number) => `¥${fen / 100}`;
  const date = (iso: string) => iso.slice(0, 10);
  const promotion = { listPrice: 3_980_000, price: 398_000, savedFen: 3_582_000, discountRate: 1, discountLabel: '1折', label: null, endsAt: null };
  assert.equal(promotionKicker(promotion), '限时优惠', '运营没填活动名时给中性兜底，不留空');
  assert.equal(promotionKicker({ ...promotion, label: '  首发价  ' }), '首发价');
  assert.equal(promotionSave(promotion, money), '立省 ¥35820');
  assert.equal(promotionDeadline(promotion, date), '', '长期有效不写「长期有效」，那是噪音不是紧迫感');
  assert.equal(promotionDeadline({ ...promotion, endsAt: '2026-09-30T15:59:59.000Z' }, date), '优惠 2026-09-30 截止');
});

test('折扣展示：没有折扣的档不产出任何促销文案（原价档不该多出一行空标签）', () => {
  const money = (fen: number) => `¥${fen / 100}`;
  assert.equal(promotionKicker(null), '');
  assert.equal(promotionSave(null, money), '');
  assert.equal(promotionDeadline(null, (iso) => iso), '');
  assert.equal(promotionKicker(plan('starter').promotion), '');
});

test('购买方式：默认永远单次购买，自动续费不可用时强制回落单次', () => {
  assert.equal(DEFAULT_PURCHASE_MODE, 'manual');
  assert.equal(effectivePurchaseMode('manual', true), 'manual');
  assert.equal(effectivePurchaseMode('auto', true), 'auto');
  assert.equal(effectivePurchaseMode('auto', false), 'manual');
});
