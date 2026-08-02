type PaymentStage = 'quote' | 'order' | 'payment' | 'apply' | 'entitlement';

const SAFE_MESSAGES: Record<string, string> = {
  PLAN_SWITCH_BLOCKED: '当前方案到期后可购买',
  PLAN_EXPIRED: '当前方案已到期，请重新开通',
  OPENID_REQUIRED: '请先使用微信账号登录后支付',
  QUOTE_CHANGED: '方案价格或权益状态已变化，请重新确认',
  ORDER_CREATING: '订单正在创建，请稍后刷新',
  ORDER_ALREADY_PROCESSED: '这笔购买已处理，请刷新方案状态',
  IDEMPOTENCY_CONFLICT: '购买内容已变化，请重新确认',
  PENDING_ORDER_UNRESOLVED: '上一笔订单状态正在确认，请稍后再试',
  ORDER_NOT_PAYABLE: '订单已过支付时限，请重新下单',
  ORDER_EXPIRED: '订单已过支付时限，请重新下单',
  PAYMENT_NOT_CONFIGURED: '支付暂未开放',
  PAYMENT_COMING_SOON: '支付即将开通，敬请期待',
  INSUFFICIENT_CREDITS: '权益点不足，请先调整方案',
};

export function paymentErrorMessage(error: unknown, stage: PaymentStage): string {
  const e = error as { code?: string; data?: { code?: string }; errMsg?: string };
  const code = e?.code || e?.data?.code || '';
  if (e?.errMsg && /cancel/i.test(e.errMsg)) return '已取消支付';
  if (SAFE_MESSAGES[code]) return SAFE_MESSAGES[code];
  if (stage === 'quote') return '暂时没能获取方案价格，请稍后再试';
  if (stage === 'order') return '暂时没能创建订单，请稍后再试';
  if (stage === 'apply') return '支付已完成，权益正在到账，请勿重复支付';
  if (stage === 'entitlement') return '暂时没能启用，请稍后再试';
  return '支付未完成，请检查后重试';
}
