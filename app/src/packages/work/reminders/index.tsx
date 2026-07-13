import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import AsyncState from '../../../components/AsyncState';
import { useStore } from '../../../hooks/useStore';
import { api, type ReminderItem, type ReminderView } from '../../../services/api';
import { requestWechatSubscribe } from '../../../services/wechatSubscribe';
import './index.scss';

// V7-11 提醒与日历页（design §13.2）：按执行节奏推送——20:30 今日复盘 / 18:00 补咨询记录 / 周五 周复盘。
// 每条一次性订阅（微信订阅消息需逐次授权），模板未配置时回落为「已配置」状态。
export default function Reminders() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [view, setView] = useState<ReminderView | null>(null);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true); // D2：首屏加载与空态区分
  const [err, setErr] = useState(false); // D2：加载失败可重试（此前吞错静默 → 永远空态）

  const load = () => {
    setErr(false);
    api.reminders().then((v) => { setView(v); }).catch((e) => { s.handleApiError(e, { silent: true }); setView(null); setErr(true); }).finally(() => setLoading(false));
  };
  useDidShow(load);

  const subscribe = async (it: ReminderItem) => {
    if (busy) return;
    setBusy(it.key);
    try {
      // 复盘/周复盘 → review 模板；军令截止等 → report 模板。
      const scene: 'review' | 'report' = it.kind === 'review' || it.kind === 'weekly' ? 'review' : 'report';
      const ok = await requestWechatSubscribe(scene);
      if (ok) setView((v) => (v ? { ...v, items: v.items.map((x) => (x.key === it.key ? { ...x, subscribed: true } : x)) } : v));
    } catch {
      Taro.showToast({ title: '订阅失败，请稍后重试', icon: 'none' });
    } finally {
      setBusy('');
    }
  };

  const items = view?.items ?? [];
  const ready = view?.subscribeReady ?? false;

  return (
    <View className={`page reminders-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="提醒与日历" onBack={() => Taro.navigateBack()} />

      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="rm-hero">
          <Text className="rm-k">执 行 提 醒</Text>
          <Text className="rm-title serif">按执行节奏提醒</Text>
          <Text className="rm-desc">提醒不是个人中心里的杂项，而是当前执行闭环的一部分。军令、复盘与周计划按节奏推送。</Text>
        </View>

        {loading && !view ? (
          <AsyncState loading skeletonRows={3} />
        ) : err ? (
          <AsyncState error onRetry={load} />
        ) : items.length === 0 ? (
          <Text className="rm-empty">暂无提醒。生成军令与复盘后，提醒节奏会显示在这里。</Text>
        ) : (
          <View className="rm-list">
            {items.map((it) => (
              <View key={it.key} className="rm-row">
                <View className="rm-time"><Text className="rm-time-t serif">{it.time}</Text></View>
                <View className="rm-b">
                  <Text className="rm-t">{it.title}</Text>
                  <Text className="rm-s">{it.desc}</Text>
                </View>
                {it.subscribed ? (
                  <Text className="rm-state">已订阅</Text>
                ) : ready ? (
                  <Text className={`rm-sub ${busy === it.key ? 'busy' : ''}`} style={{ background: accent }} onClick={() => subscribe(it)}>{busy === it.key ? '…' : '订阅'}</Text>
                ) : (
                  <Text className="rm-state muted">暂不可订阅</Text>
                )}
              </View>
            ))}
          </View>
        )}

        <Text className="rm-foot">订阅后，微信会在对应时间推送一次提醒；每次推送需单独授权。</Text>
      </View>
    </View>
  );
}
