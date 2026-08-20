// 增购包（credits 钻石 / quota 算力）的目录与下单阶梯。
// 抽出来的原因：方案页与算力明细页都要卖同一批包，两边各写一份必然漂移
// （历史上 confirmText 超 4 字导致「点了没反应」就是在两处各栽了一次）。
const { api } = require('./api');

const PACK_KINDS = ['credits', 'quota'];

function fmtFen(fen) { const value = Number(fen) || 0; return `¥${(value / 100).toFixed(value % 100 ? 2 : 0)}`; }

// 包行文案。钻石包报颗数（对外货币口径），运营没填就不编数字、只留价格。
// **算力包一律不报 token 数**：价 ÷ token 就是每 token 售价，能反推成本与毛利，属商业机密
// （服务端 /skus 也已不下发算力包 amount）。只留运营写的价值描述，没填给通用兜底。
function mapPack(sku) {
  const amount = Number(sku.amount || 0);
  const desc = String(sku.desc || '').trim();
  const amountText = sku.kind === 'credits'
    ? [amount > 0 ? `+${amount} 钻石` : '数量以运营配置为准', desc].filter(Boolean).join(' · ')
    : (desc || '月度额度用尽后自动接着用，永久有效');
  return Object.assign({}, sku, { amountText, priceText: fmtFen(sku.priceFen) });
}

// 目录：公开接口，游客也拉（下单时才走登录门）。服务端已按 sort 排序，端上不重排。
function fetchPacks() {
  return api.skus().then((list) => (Array.isArray(list) ? list : []).filter((sku) => PACK_KINDS.includes(sku.kind)).map(mapPack));
}

// 钻石不限量（企业版哨兵 creditBalance<0）买钻石包没有意义，服务端下单口直接 409
// CREDITS_UNLIMITED，所以端上先隐藏这类包；算力包不受影响。
function visiblePacks(packs, creditsUnlimited) {
  return (packs || []).filter((sku) => !(creditsUnlimited && sku.kind === 'credits'));
}

function waitApplied(outTradeNo) {
  if (!outTradeNo) return Promise.resolve('pending');
  const step = async () => {
    for (let index = 0; index < 5; index += 1) {
      try {
        const status = await api.paymentStatus(outTradeNo);
        if (status.appliedAt || status.status === 'applied') return 'applied';
        if (['failed', 'closed', 'refunded'].includes(status.status)) return 'failed';
      } catch (_) { /* 网络抖动不冒充失败；重试完仍未知则返回 pending。 */ }
      if (index < 4) await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    return 'pending';
  };
  return step();
}

// 购买确认框。confirmText 微信硬限 4 个字符，超了 showModal 直接走 fail、弹窗根本不出现——
// 曾写成 `支付 ¥200`（7 字），加上 fail 被当成用户取消静默吞掉，表现就是「点了没反应」。
// 所以按钮文案固定 4 字，价格放 content；fail 也不再冒充取消。
function confirmPack(pack) {
  return new Promise((resolve) => wx.showModal({
    title: pack.name,
    content: `${pack.amountText}\n支付 ${pack.priceText}，到账后立即可用。`,
    confirmText: '确认支付',
    success: (result) => resolve(!!result.confirm),
    fail: (error) => {
      wx.showToast({ title: '确认框没能打开，请重试', icon: 'none' });
      console.error('[packs] showModal 失败', error && error.errMsg);
      resolve(false);
    },
  }));
}

// 下单阶梯：确认 → 下单 → 模拟支付/微信支付 → 轮询到账。返回终态供调用方决定提示与刷新。
// 'cancelled' 表示用户自己放弃（不提示）；抛错只发生在真失败，由调用方兜提示。
async function purchasePack(pack) {
  if (!(await confirmPack(pack))) return { state: 'cancelled', mock: false };
  const order = await api.createSkuOrder(pack.key, undefined, { source: 'catalog' });
  const outTradeNo = order.orderId || order.outTradeNo;
  if (order.mock && !order.appliedAt && outTradeNo) await api.payMock(outTradeNo);
  else if (order.payParams || order.pay) {
    await new Promise((resolve, reject) => wx.requestPayment(Object.assign({}, order.payParams || order.pay, { success: resolve, fail: reject })));
  }
  const state = order.appliedAt ? 'applied' : await waitApplied(outTradeNo);
  return { state, mock: !!order.mock };
}

// 到账提示：钱已扣的路径绝不能再说「支付失败」，只说结果待确认。
function purchaseToast(state, mock) {
  if (state === 'applied') return { title: mock ? '已到账（测试期模拟支付）' : '已到账，权益已更新', icon: mock ? 'none' : 'success' };
  if (state === 'failed') return { title: '订单未完成，请重新发起购买', icon: 'none' };
  return { title: '支付结果待确认，到账后可下拉刷新查看', icon: 'none' };
}

module.exports = { PACK_KINDS, mapPack, fetchPacks, visiblePacks, purchasePack, purchaseToast, waitApplied };
