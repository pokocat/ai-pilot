import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import AsyncState from '../../../components/AsyncState';
import Login from '../../../components/Login';
import PaySheet from '../../../components/PaySheet';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { api, type MyCreditItem, type PayOrderListItem, type SkuView } from '../../../services/api';
import { awaitPaymentApplied, payAppliedToast, ensurePayableEnv, payOrder } from '../../../services/pay';
import { paymentErrorMessage } from '../../../services/paymentFeedback';
import './index.scss';

// 支付订单状态 → 用户可读标签（refunded/failed 走 danger 色）。
const ORDER_STATUS_LABEL: Record<PayOrderListItem['status'], string> = {
  created: '待支付',
  paid: '已支付 · 权益发放中',
  applied: '已完成',
  failed: '支付失败',
  closed: '已关闭',
  refunded: '已退款',
};
const REFUND_STATUS_LABEL: Record<NonNullable<PayOrderListItem['refundStatus']>, string> = {
  refund_requested: '退款已申请', refund_processing: '退款处理中', refund_closed: '退款已关闭',
  refund_abnormal: '退款异常', refunded: '已退款',
};

// 增购包（kind=credits 钻石 / quota 算力）：只认这两类，其余 SKU 归能力目录，不进本页。
const PACK_KINDS: SkuView['kind'][] = ['credits', 'quota'];
type PackState = 'loading' | 'ready' | 'failed';

// 算力明细：余额 + 本月算力（token 池，只看 %）+ 增购包 + 消耗流水 + 支付订单（P1：状态/继续支付）。
// 从「我的」独立成页，避免底部 tab 栏遮挡弹层。
export default function Credits() {
  const s = useStore();
  const color = s.color();
  const accent = color.vars['--accent'];
  const me = s.me();
  const [items, setItems] = useState<MyCreditItem[]>([]);
  const [orders, setOrders] = useState<PayOrderListItem[]>([]);
  const [loading, setLoading] = useState(true); // D2：首屏加载与空态区分
  const [repaying, setRepaying] = useState('');
  // 增购区块自成一态：GET /skus 是公开目录，与个人流水成败互不影响，
  // 拉失败必须显式说「没取到 + 重试」，绝不能退化成「暂无增购包」（那是运营没配的意思）。
  const [packs, setPacks] = useState<SkuView[]>([]);
  const [packState, setPackState] = useState<PackState>('loading');
  const [payPack, setPayPack] = useState<SkuView | null>(null);
  const [showLogin, setShowLogin] = useState(false);

  // 增购包目录：服务端 /skus 已按 sort 排序（SkuView 不带 sort 字段），端上保持返回顺序不重排。
  const loadPacks = () => {
    setPackState((prev) => (prev === 'failed' ? 'loading' : prev));
    return api.skus()
      .then((list) => { setPacks(list.filter((sku) => PACK_KINDS.includes(sku.kind))); setPackState('ready'); })
      .catch(() => setPackState('failed'));
  };

  const load = (done?: () => void) => {
    void loadPacks();
    Promise.all([
      api.myCredits().then((r) => setItems(r.items)),
      api.myOrders().then((r) => setOrders(r.items)).catch(() => {}), // 订单列表失败不阻塞算力明细
    ]).catch((e) => s.handleApiError(e)).finally(() => { setLoading(false); done?.(); });
  };

  // 点增购：游客走动作级登录门（不清状态、不跳路由），已登录才开 PaySheet 下单。
  const openPack = (sku: SkuView) => {
    if (!s.isAuthed()) { setShowLogin(true); return; }
    setPayPack(sku);
  };

  // 继续支付（P1）：对未过支付时限的待支付单重签调起参数 → 到账确认与四个支付触点同口径。
  const repay = async (o: PayOrderListItem) => {
    if (repaying) return;
    // 测试期模拟支付单不需要 wx.requestPayment，所以也不受「必须在小程序内」的环境限制。
    if (!o.mock && !ensurePayableEnv()) return;
    setRepaying(o.outTradeNo);
    try {
      const r = await api.orderPayParams(o.outTradeNo);
      const mocked = await payOrder({ outTradeNo: o.outTradeNo, pay: r.pay, mock: r.mock });
      const applied = await awaitPaymentApplied(o.outTradeNo);
      await store.loadMe().catch(() => {});
      Taro.showToast(payAppliedToast(applied, '支付成功，权益已更新', { mock: mocked }));
      load();
    } catch (e: any) {
      Taro.showToast({ title: paymentErrorMessage(e, 'payment'), icon: 'none' });
      if ((e?.code || e?.data?.code) === 'ORDER_EXPIRED' || (e?.code || e?.data?.code) === 'ORDER_NOT_PAYABLE') load();
    } finally {
      setRepaying('');
    }
  };
  useDidShow(() => load());
  // API 单次返回最近 50 条、无分页参数 → 只做下拉刷新（工单：不支持分页则仅下拉刷新）。
  usePullDownRefresh(() => load(() => Taro.stopPullDownRefresh()));

  // 增购算力剩余：usage 与 tokenQuota 同义，取任一有值的（旧服务端两处都缺 → 0 → 不展示）。
  const packRemaining = me?.usage.packRemaining ?? me?.tokenQuota.packRemaining ?? 0;
  // 钻石不限量（企业版哨兵 creditBalance<0）买钻石包没有意义，服务端下单口直接 409 CREDITS_UNLIMITED，
  // 所以端上先隐藏这类包，别把一个必然失败的按钮摆在用户面前；算力包不受影响。
  const creditsUnlimited = (me?.creditBalance ?? 0) < 0;
  const visiblePacks = creditsUnlimited ? packs.filter((sku) => sku.kind !== 'credits') : packs;

  return (
    <View className={`page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="算力明细" onBack={() => Taro.navigateBack()} />

      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="cd-hero">
          <Text className="cd-k">算力 · 启用专项顾问</Text>
          <View className="cd-vrow">
            <Icon name="diamond" size={20} color={color.vars['--accent-bright']} />
            <Text className="cd-v serif" style={{ color: 'var(--accent-bright)' }}>
              {me ? (me.creditBalance < 0 ? ' 不限量' : ` ${me.creditBalance}`) : ' —'}
            </Text>
          </View>

          {/* 本月算力（token 消耗池）—— 客户端只看 % */}
          <View className="cd-quota">
            <View className="cd-qhead">
              <Text className="cd-ql">本月算力</Text>
              <Text className="cd-qv serif">{usageLabel(me?.usage)}</Text>
            </View>
            <View className="cd-track">
              <View className="cd-fill" style={{ width: `${me?.usage.unlimited ? 100 : (me?.usage.usagePercent ?? 0)}%`, background: accent }} />
            </View>
            {/* 增购算力永久有效、不进月度进度条的分母，所以单独一行标注（无包/旧服务端=0 时隐藏）。
                只说「还有」不说「多少」：余量就是刚买那笔的量级，报数等于把包的 token 数贴脸上。 */}
            {packRemaining > 0 && (
              <View className="cd-pack-left">
                <Text className="cd-ql">增购算力</Text>
                <Text className="cd-pv serif">仍有余量</Text>
              </View>
            )}
          </View>
        </View>

        {packState !== 'ready' || visiblePacks.length > 0 ? (
          <>
            <Text className="cd-sech serif">增购</Text>
            <Text className="cd-secs">{creditsUnlimited ? '算力包永久有效，用完为止' : '算力包永久有效，用完为止 · 钻石包到账即可启用顾问'}</Text>
            {packState === 'loading' ? (
              <AsyncState loading skeletonRows={2} />
            ) : packState === 'failed' ? (
              <AsyncState error onRetry={() => loadPacks()} />
            ) : (
              <View className="cd-list">
                {visiblePacks.map((sku) => (
                  <View key={sku.key} className="cd-row cd-pack" onClick={() => openPack(sku)}>
                    <View className="cd-rl">
                      <Text className="cd-rt">{sku.name}</Text>
                      <Text className="cd-rat">{packDetailLabel(sku)}</Text>
                    </View>
                    <View className="cd-buy" style={{ background: accent }}><Text>{fmtFen(sku.priceFen)}</Text></View>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : null}

        <Text className="cd-sech serif">算力消耗明细</Text>
        <Text className="cd-secs">启用顾问 / 出图 / 充值赠送</Text>

        {loading && items.length === 0 ? (
          <AsyncState loading skeletonRows={3} />
        ) : items.length === 0 ? (
          <Text className="cd-empty">还没有算力记录。启用顾问或充值后就有了。</Text>
        ) : (
          <View className="cd-list">
            {items.map((it, i) => (
              <View key={i} className="cd-row">
                <View className="cd-rl">
                  <Text className="cd-rt">{it.reason}</Text>
                  <Text className="cd-rat">{fmtAt(it.at)}</Text>
                </View>
                <Text className={`cd-rd serif ${it.delta >= 0 ? 'pos' : 'neg'}`}>{it.delta >= 0 ? `+${it.delta}` : it.delta}</Text>
              </View>
            ))}
          </View>
        )}

        {orders.length > 0 && (
          <>
            <Text className="cd-sech serif">支付订单</Text>
            <Text className="cd-secs">微信支付记录 · 待支付订单可在时限内继续支付</Text>
            <View className="cd-list">
              {orders.map((o) => (
                <View key={o.outTradeNo} className="cd-row">
                  <View className="cd-rl">
                    <Text className="cd-rt">{o.itemName}</Text>
                    {/* 测试期模拟支付单必须如实标注：不能让用户以为这笔真的付过钱 */}
                    <Text className="cd-rat">
                      {o.refundStatus ? REFUND_STATUS_LABEL[o.refundStatus] : (ORDER_STATUS_LABEL[o.status] ?? o.status)}{o.mock ? ' · 测试期模拟支付' : ''} · {fmtAt(o.paidAt ?? o.createdAt)} · 单号 …{o.outTradeNo.slice(-6)}
                      {o.payable && o.payableUntil ? ` · 可支付至 ${fmtAt(o.payableUntil)}` : ''}
                    </Text>
                  </View>
                  <View className="cd-ord-r">
                    <Text className={`cd-rd serif ${o.status === 'refunded' || o.status === 'failed' ? 'neg' : 'pos'}`}>¥{(o.amount / 100).toFixed(2)}</Text>
                    {o.payable && (
                      <View className="cd-repay" style={{ background: accent }} onClick={() => repay(o)}>
                        <Text>{repaying === o.outTradeNo ? '拉起中…' : o.mock ? '模拟支付' : '继续支付'}</Text>
                      </View>
                    )}
                  </View>
                </View>
              ))}
            </View>
          </>
        )}
      </View>

      {/* 增购确认：PaySheet mode='sku' 自带「下单 → 微信支付/模拟支付 → 重拉 /me」阶梯，本页只补账本文案。
          关闭即重拉本页（成功后要出新流水与订单行；取消时多一次幂等重拉，不会写坏任何状态）。 */}
      <PaySheet
        open={!!payPack}
        mode="sku"
        skuKey={payPack?.key}
        title={payPack?.name || '增购'}
        desc={payPack?.desc}
        costValue={payPack ? fmtFen(payPack.priceFen) : undefined}
        balanceValue={payPack ? packBalanceLabel(payPack, me?.creditBalance, packRemaining) : undefined}
        afterValue={payPack ? packAfterLabel(payPack, me?.creditBalance, packRemaining) : undefined}
        result={payPack?.kind === 'quota' ? '增购算力永久有效，用完为止；月度额度用尽后自动接着用。' : '钻石到账后可直接用于启用顾问与出图。'}
        confirmText="确认购买"
        onClose={() => { setPayPack(null); load(); }}
      />

      <Login open={showLogin} reason="purchase" onClose={() => setShowLogin(false)} onLoggedIn={() => { setShowLogin(false); setLoading(true); load(); }} />
    </View>
  );
}

// 本月算力（客户端只看 %，不显示 token 数）。limit<0=不限量；limit=0=未开通（无额度）。
// 整数百分比、向上取整：有消耗即至少 1%（避免大额度下小用量被抹成 0%）。
function usageLabel(usage?: { usagePercent: number; unlimited: boolean }): string {
  if (!usage) return '—';
  return usage.unlimited ? '不限量' : `本月已用 ${usage.usagePercent}%`;
}
// 分 → ¥xx / ¥xx.xx（整元不拖两位小数）
function fmtFen(fen: number): string {
  return `¥${(fen / 100).toFixed(fen % 100 ? 2 : 0)}`;
}
// 增购包行文案。钻石包报颗数（对外货币口径），运营没填就不编数字、只留价格。
// **算力包一律不报 token 数**：价 ÷ token 就是每 token 售价，能反推成本与毛利，属商业机密
// （服务端 /skus 也已不下发算力包 amount）。只留运营写的价值描述，没填给通用兜底。
function packDetailLabel(sku: SkuView): string {
  const desc = (sku.desc ?? '').trim();
  if (sku.kind !== 'credits') return desc || '月度额度用尽后自动接着用，永久有效';
  const amount = Number(sku.amount ?? 0);
  return [amount > 0 ? `+${amount} 钻石` : '数量以运营配置为准', desc].filter(Boolean).join(' · ');
}
// PaySheet「当前余额」：钻石包看钻石余额；算力包只说有没有余量，不报数（同上，机密口径）。
function packBalanceLabel(sku: SkuView, creditBalance: number | undefined, packRemaining: number): string {
  if (sku.kind === 'credits') return creditBalance == null ? '—' : creditBalance < 0 ? '不限量' : `${creditBalance} 钻石`;
  return packRemaining > 0 ? '增购算力 · 仍有余量' : '增购算力 · 已用尽';
}
// PaySheet「扣后状态」：钻石包报到账后的余额；算力包只承诺「接着用」，同样不报数。
function packAfterLabel(sku: SkuView, creditBalance: number | undefined, _packRemaining: number): string {
  if (sku.kind !== 'credits') return '到账后月度额度用尽可接着用';
  const amount = Number(sku.amount ?? 0);
  if (!(amount > 0)) return '到账后按运营配置发放';
  if (creditBalance == null) return `到账 +${amount} 钻石`;
  return creditBalance < 0 ? '不限量' : `${creditBalance + amount} 钻石`;
}
// ISO → MM-DD HH:mm
function fmtAt(iso: string): string {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso.slice(0, 16);
}
