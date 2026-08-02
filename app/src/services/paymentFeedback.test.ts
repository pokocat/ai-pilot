import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentErrorMessage } from './paymentFeedback';

test('支付反馈：用户取消单独识别，不冒充支付失败', () => {
  assert.equal(paymentErrorMessage({ errMsg: 'requestPayment:fail cancel' }, 'payment'), '已取消支付');
});

test('支付反馈：业务错误码使用可行动文案，兼容顶层与 data.code', () => {
  const cases: Array<[string, string]> = [
    ['PLAN_SWITCH_BLOCKED', '当前方案到期后可购买'],
    ['PLAN_EXPIRED', '当前方案已到期，请重新开通'],
    ['OPENID_REQUIRED', '请先使用微信账号登录后支付'],
    ['QUOTE_CHANGED', '方案价格或权益状态已变化，请重新确认'],
    ['ORDER_CREATING', '订单正在创建，请稍后刷新'],
    ['ORDER_ALREADY_PROCESSED', '这笔购买已处理，请刷新方案状态'],
    ['IDEMPOTENCY_CONFLICT', '购买内容已变化，请重新确认'],
    ['PENDING_ORDER_UNRESOLVED', '上一笔订单状态正在确认，请稍后再试'],
    ['ORDER_NOT_PAYABLE', '订单已过支付时限，请重新下单'],
    ['ORDER_EXPIRED', '订单已过支付时限，请重新下单'],
    ['PAYMENT_NOT_CONFIGURED', '支付暂未开放'],
    ['PAYMENT_COMING_SOON', '支付即将开通，敬请期待'],
    ['INSUFFICIENT_CREDITS', '权益点不足，请先调整方案'],
  ];
  for (const [code, expected] of cases) {
    assert.equal(paymentErrorMessage({ code }, 'payment'), expected, code);
    assert.equal(paymentErrorMessage({ data: { code } }, 'payment'), expected, `${code} nested`);
  }
});

test('支付反馈：未知错误按阶段区分，到账阶段明确禁止重复支付', () => {
  assert.equal(paymentErrorMessage({}, 'quote'), '暂时没能获取方案价格，请稍后再试');
  assert.equal(paymentErrorMessage({}, 'order'), '暂时没能创建订单，请稍后再试');
  assert.equal(paymentErrorMessage({}, 'payment'), '支付未完成，请检查后重试');
  assert.equal(paymentErrorMessage({}, 'apply'), '支付已完成，权益正在到账，请勿重复支付');
  assert.equal(paymentErrorMessage({}, 'entitlement'), '暂时没能启用，请稍后再试');
});
