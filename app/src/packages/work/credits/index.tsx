import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api, type MyCreditItem } from '../../../services/api';
import './index.scss';

// 钻石明细：余额 + 本月产出额度（token 池，只看 %）+ 消耗流水。
// 从「我的」独立成页，避免底部 tab 栏遮挡弹层。
export default function Credits() {
  const s = useStore();
  const color = s.color();
  const accent = color.vars['--accent'];
  const me = s.me();
  const [items, setItems] = useState<MyCreditItem[]>([]);

  useDidShow(() => {
    api.myCredits().then((r) => setItems(r.items)).catch((e) => s.handleApiError(e));
  });

  return (
    <View className={`page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="钻石明细" onBack={() => Taro.navigateBack()} />

      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="cd-hero">
          <Text className="cd-k">钻石 · 解锁专项顾问</Text>
          <View className="cd-vrow">
            <Icon name="diamond" size={20} color={color.vars['--accent-bright']} />
            <Text className="cd-v serif" style={{ color: 'var(--accent-bright)' }}>
              {me ? (me.creditBalance < 0 ? ' 不限量' : ` ${me.creditBalance}`) : ' —'}
            </Text>
          </View>

          {/* 本月产出额度（token 消耗池）—— 客户端只看 % */}
          <View className="cd-quota">
            <View className="cd-qhead">
              <Text className="cd-ql">本月产出额度</Text>
              <Text className="cd-qv serif">{quotaLabel(me?.tokenQuota)}</Text>
            </View>
            <View className="cd-track">
              <View className="cd-fill" style={{ width: `${quotaPct(me?.tokenQuota)}%`, background: accent }} />
            </View>
          </View>
        </View>

        <Text className="cd-sech serif">钻石消耗明细</Text>
        <Text className="cd-secs">解锁顾问 / 图片产出 / 充值赠送</Text>

        {items.length === 0 ? (
          <Text className="cd-empty">暂无钻石流水。解锁专项顾问或充值后会显示在这里。</Text>
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
      </View>
    </View>
  );
}

// 本月 token 额度（客户端只看 %，不显示 token 数）。limit<0=不限量。
function quotaLabel(q?: { limit: number; used: number; unlimited: boolean }): string {
  if (!q) return '—';
  if (q.unlimited || q.limit < 0) return '不限量';
  const pct = q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
  return `本月已用 ${pct}%`;
}
function quotaPct(q?: { limit: number; used: number; unlimited: boolean }): number {
  if (!q || q.limit < 0) return q?.unlimited ? 100 : 0;
  return q.limit > 0 ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
}
// ISO → MM-DD HH:mm
function fmtAt(iso: string): string {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? `${m[2]}-${m[3]} ${m[4]}:${m[5]}` : iso.slice(0, 16);
}
