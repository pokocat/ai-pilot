import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from '@tarojs/components';
import Taro from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import AsyncState from '../../../components/AsyncState';
import { useStore } from '../../../hooks/useStore';
import { api, type DailyBattleReportView } from '../../../services/api';
import './index.scss';

function dateLabel(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(month)}月${Number(day)}日`;
}

export default function DailyBattlePage() {
  const store = useStore();
  const [data, setData] = useState<DailyBattleReportView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = () => {
    setLoading(true);
    setError(false);
    api.dailyBattleReport()
      .then(setData)
      .catch((err) => {
        store.handleApiError(err, { silent: true });
        setError(true);
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  return (
    <View className="page daily-page">
      <SafeHeader title="每日战报" onBack={() => Taro.navigateBack()} />
      <ScrollView scrollY className="daily-scroll">
        <AsyncState loading={loading && !data} error={error && !data} onRetry={load} skeletonRows={4}>
          {data ? (
            <>
              <View className="daily-hero">
                <Text className="daily-kicker">军师参谋部 · 当日经营账本</Text>
                <Text className="daily-title serif">每日战报</Text>
                <Text className="daily-date">{dateLabel(data.date)}{data.casefileTitle ? ` · 案卷《${data.casefileTitle}》` : ''}</Text>
                <Text className="daily-rank">{data.rank} · 连续复盘第 {data.streak} 天</Text>
              </View>

              <View className="daily-private">
                <Text className="daily-private-dot">●</Text>
                <Text>仅当前登录账号可见，经营数据不会生成公开链接</Text>
              </View>

              <View className="daily-scores">
                <View className="daily-score card"><Text className="daily-score-v serif">{data.done}/{data.total}</Text><Text className="daily-score-k">军令完成</Text></View>
                <View className="daily-score card"><Text className="daily-score-v gold serif">{data.alignRate === null ? '—' : `${data.alignRate}%`}</Text><Text className="daily-score-k">主线对齐</Text></View>
                <View className="daily-score card"><Text className="daily-score-v small serif">{data.backfill ? '已回填' : '未回填'}</Text><Text className="daily-score-k">今日数据</Text></View>
              </View>

              <View className="daily-section card">
                <Text className="daily-section-k">今 日 军 令</Text>
                {data.orders.length ? data.orders.map((order) => (
                  <View key={order.id} className="daily-order">
                    <Text className={`daily-order-state ${order.done ? 'done' : ''}`}>{order.done ? '✓' : '·'}</Text>
                    <View className="daily-order-copy">
                      <Text className={`daily-order-text ${order.done ? 'done' : ''}`}>{order.text}</Text>
                      {order.aligned !== null ? <Text className="daily-order-align">{order.aligned ? '对齐主要矛盾' : '需复盘校准'}</Text> : null}
                    </View>
                  </View>
                )) : <Text className="daily-empty">今天还没有军令，先让军师帮你定下最重要的事。</Text>}
              </View>

              {data.backfill ? (
                <View className="daily-section card">
                  <Text className="daily-section-k">经 营 回 填</Text>
                  <View className="daily-metrics">
                    <View><Text className="daily-metric-v serif">{data.backfill.leads}</Text><Text className="daily-metric-k">线索</Text></View>
                    <View><Text className="daily-metric-v serif">{data.backfill.consults}</Text><Text className="daily-metric-k">咨询</Text></View>
                    <View><Text className="daily-metric-v serif">{data.backfill.deals}</Text><Text className="daily-metric-k">成交</Text></View>
                  </View>
                </View>
              ) : null}

              <View className="daily-quote"><Text>「{data.quote}」</Text></View>
              <View className="daily-foot"><Text className="serif">军师参谋部</Text><Text>今日账本随数据实时更新</Text></View>
            </>
          ) : null}
        </AsyncState>
        <View className="daily-bottom" />
      </ScrollView>
    </View>
  );
}
