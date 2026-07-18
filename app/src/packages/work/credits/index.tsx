import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow, usePullDownRefresh } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import AsyncState from '../../../components/AsyncState';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { api, type MyCreditItem, type PayOrderListItem } from '../../../services/api';
import { awaitPaymentApplied, payAppliedToast, ensurePayableEnv, requestWechatPayment } from '../../../services/pay';
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

// 算力明细：余额 + 本月算力（token 池，只看 %）+ 消耗流水 + 支付订单（P1：状态/继续支付）。
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

  const load = (done?: () => void) => {
    Promise.all([
      api.myCredits().then((r) => setItems(r.items)),
      api.myOrders().then((r) => setOrders(r.items)).catch(() => {}), // 订单列表失败不阻塞算力明细
    ]).catch((e) => s.handleApiError(e)).finally(() => { setLoading(false); done?.(); });
  };

  // 继续支付（P1）：对未过支付时限的待支付单重签调起参数 → 到账确认与四个支付触点同口径。
  const repay = async (o: PayOrderListItem) => {
    if (repaying) return;
    if (!ensurePayableEnv()) return;
    setRepaying(o.outTradeNo);
    try {
      const r = await api.orderPayParams(o.outTradeNo);
      await requestWechatPayment(r.pay);
      const applied = await awaitPaymentApplied(o.outTradeNo);
      await store.loadMe().catch(() => {});
      Taro.showToast(payAppliedToast(applied, '支付成功，权益已更新'));
      load();
    } catch (e: any) {
      if (e?.errMsg && /cancel/i.test(e.errMsg)) Taro.showToast({ title: '已取消支付', icon: 'none' });
      else if ((e?.code || e?.data?.code) === 'ORDER_EXPIRED' || (e?.code || e?.data?.code) === 'ORDER_NOT_PAYABLE') {
        Taro.showToast({ title: '订单已过支付时限，请重新下单', icon: 'none' });
        load();
      } else s.handleApiError(e, { fallbackTitle: '支付失败，请重试' });
    } finally {
      setRepaying('');
    }
  };
  useDidShow(() => load());
  // API 单次返回最近 50 条、无分页参数 → 只做下拉刷新（工单：不支持分页则仅下拉刷新）。
  usePullDownRefresh(() => load(() => Taro.stopPullDownRefresh()));

  return (
    <View className={`page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="算力明细" onBack={() => Taro.navigateBack()} />

      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="cd-hero">
          <Text className="cd-k">算力 · 解锁专项顾问</Text>
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
              <Text className="cd-qv serif">{quotaLabel(me?.tokenQuota)}</Text>
            </View>
            <View className="cd-track">
              <View className="cd-fill" style={{ width: `${quotaPct(me?.tokenQuota)}%`, background: accent }} />
            </View>
          </View>
        </View>

        <Text className="cd-sech serif">算力消耗明细</Text>
        <Text className="cd-secs">解锁顾问 / 图片产出 / 充值赠送</Text>

        {loading && items.length === 0 ? (
          <AsyncState loading skeletonRows={3} />
        ) : items.length === 0 ? (
          <Text className="cd-empty">暂无算力流水。解锁专项顾问或充值后会显示在这里。</Text>
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
                    <Text className="cd-rat">
                      {ORDER_STATUS_LABEL[o.status] ?? o.status} · {fmtAt(o.paidAt ?? o.createdAt)} · 单号 …{o.outTradeNo.slice(-6)}
                    </Text>
                  </View>
                  <View className="cd-ord-r">
                    <Text className={`cd-rd serif ${o.status === 'refunded' || o.status === 'failed' ? 'neg' : 'pos'}`}>¥{(o.amount / 100).toFixed(2)}</Text>
                    {o.payable && (
                      <View className="cd-repay" style={{ background: accent }} onClick={() => repay(o)}>
                        <Text>{repaying === o.outTradeNo ? '拉起中…' : '继续支付'}</Text>
                      </View>
                    )}
                  </View>
                </View>
              ))}
            </View>
          </>
        )}
      </View>
    </View>
  );
}

// 本月算力（客户端只看 %，不显示 token 数）。limit<0=不限量；limit=0=未开通（无额度）。
// 整数百分比、向上取整：有消耗即至少 1%（避免大额度下小用量被抹成 0%）。
function quotaLabel(q?: { limit: number; used: number; unlimited: boolean }): string {
  if (!q) return '—';
  if (q.unlimited || q.limit < 0) return '不限量';
  if (q.limit === 0) return '未开通'; // 无额度：与「已用 0%」区分，避免误以为额度充足
  if (q.used <= 0) return '本月已用 0%';
  return `本月已用 ${pctOf(q.used, q.limit)}%`;
}
function quotaPct(q?: { limit: number; used: number; unlimited: boolean }): number {
  if (!q || q.limit < 0) return q?.unlimited ? 100 : 0;
  if (q.limit <= 0 || q.used <= 0) return 0;
  return pctOf(q.used, q.limit);
}
// 向上取整的整数百分比，限定 [1, 100]（已有消耗）。
function pctOf(used: number, limit: number): number {
  return Math.min(100, Math.max(1, Math.ceil((used / limit) * 100)));
}
// ISO → MM-DD HH:mm
function fmtAt(iso: string): string {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso.slice(0, 16);
}
