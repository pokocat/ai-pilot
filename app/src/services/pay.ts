// 支付到账确认（P0 统一收口）：requestPayment 成功 ≠ 权益已到账（微信回调是异步的）。
// 本助手轮询 GET /pay/orders/:outTradeNo（服务端未发放时会先主动查单补账，回调丢失也能自愈）：
//   applied = appliedAt 有值，权益已发放，可如实提示「已到账」；
//   pending = 已支付但回调仍在路上（或网络抖动查不到状态）——支付本身成功，提示「到账中稍后生效」，
//             服务端定时对账 sweep 会兜底补账，绝不能向用户报「支付失败」；
//   failed  = 订单终态失败/关闭（正常支付成功后不应出现，出现按 pending 同口径提示并交由对账处理）。
// 所有支付触点（套餐 Plans / 通用 PaySheet / 智库深度整理 / 模块开通）统一走这里，不要各写一套重试。
import Taro from '@tarojs/taro';
import { api, type WechatPayParams } from './api';
import { IS_MOCK } from './config';

export type PayApplyState = 'applied' | 'pending' | 'failed';

// —— H5 守卫（P1）：wx.requestPayment 仅小程序可用。mock 模式不拦（下单会走演示通道，调不到 requestPayment）；
// server 模式跑在 H5 时，在「下单之前」拦下并给明确指引，避免创建一笔注定付不了的订单。
export function payEnvSupported(): boolean {
  return IS_MOCK || Taro.getEnv() === Taro.ENV_TYPE.WEAPP;
}

/** 支付入口统一前置检查：环境不支持时提示并返回 false（调用方直接 return）。 */
export function ensurePayableEnv(): boolean {
  if (payEnvSupported()) return true;
  Taro.showToast({ title: '请在微信小程序内完成支付', icon: 'none' });
  return false;
}

/** 统一调起微信支付：非小程序环境抛 H5_PAY_UNSUPPORTED（双保险，正常应先被 ensurePayableEnv 拦住）。 */
export async function requestWechatPayment(pay: WechatPayParams): Promise<void> {
  if (Taro.getEnv() !== Taro.ENV_TYPE.WEAPP) {
    throw Object.assign(new Error('请在微信小程序内完成支付'), { code: 'H5_PAY_UNSUPPORTED' });
  }
  await Taro.requestPayment({
    timeStamp: pay.timeStamp,
    nonceStr: pay.nonceStr,
    package: pay.package,
    signType: pay.signType as 'RSA',
    paySign: pay.paySign,
  });
}

export async function awaitPaymentApplied(
  outTradeNo: string | undefined,
  opts: { attempts?: number; intervalMs?: number } = {},
): Promise<PayApplyState> {
  if (!outTradeNo) return 'pending';
  const attempts = opts.attempts ?? 5;
  const intervalMs = opts.intervalMs ?? 1200;
  for (let i = 0; i < attempts; i++) {
    try {
      const st = await api.payOrderStatus(outTradeNo);
      if (st.appliedAt || st.status === 'applied') return 'applied';
      if (st.status === 'failed' || st.status === 'closed') return 'failed';
    } catch { /* 网络抖动：不打断确认流程，下一轮再查 */ }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return 'pending';
}

/** 到账确认后的统一提示文案：applied 才说「成功/已更新」，其余如实说「到账中」。 */
export function payAppliedToast(state: PayApplyState, appliedTitle: string): { title: string; icon: 'success' | 'none' } {
  return state === 'applied'
    ? { title: appliedTitle, icon: 'success' }
    : { title: '支付成功，权益到账中，稍后自动生效', icon: 'none' };
}
