import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import { useStore } from '../../hooks/useStore';
import { api, type LibItem } from '../../services/api';
import './index.scss';

function fmt(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 方案库：存"成果"。点开回到产出它的会话继续深化。
export default function Library() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [items, setItems] = useState<LibItem[]>([]);

  useDidShow(() => {
    api.library().then(setItems).catch(() => setItems([]));
  });

  const open = (it: LibItem) => {
    // 有版本化报告 → 进报告页看版本与变更；否则回到产出它的会话继续深化
    if (it.reportId) Taro.navigateTo({ url: `/pages/report/index?id=${it.reportId}` });
    else if (it.sessionId) Taro.navigateTo({ url: `/pages/chat/index?sessionId=${it.sessionId}` });
    else Taro.navigateTo({ url: `/pages/chat/index?agentKey=${it.agentKey}&continue=1` });
  };

  return (
    <View className={`page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <View className="lib-head">
        <View className="hbtn" onClick={() => Taro.navigateBack()}><Text className="back-arrow">‹</Text></View>
        <Text className="lib-title serif">我的方案库</Text>
        <View style={{ width: '36px' }} />
      </View>

      <View className="pad" style={{ paddingTop: '12px' }}>
        {items.length === 0 ? (
          <View className="lib-empty">
            <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="layers" size={22} color={accent} /></View>
            <Text className="et">方案库还是空的</Text>
            <Text className="es">在对话里让顾问产出成果后，点「存入方案库」即可在此查看与回溯。</Text>
            <View className="es-btn" style={{ background: accent }} onClick={() => Taro.switchTab({ url: '/pages/thinktank/index' })}>
              <Text>去智库产出第一份成果</Text>
            </View>
          </View>
        ) : (
          <View className="lib-list">
            {items.map((it) => (
              <View key={it.id} className="lib-item card" onClick={() => open(it)}>
                <View className="li-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={(it.content as any).icon || 'doc'} size={18} color={accent} /></View>
                <View className="li-b">
                  <Text className="li-t">{it.title}</Text>
                  <Text className="li-m">{it.agentName} · {fmt(it.at)}</Text>
                </View>
                {it.reportId && it.version ? <View className="li-ver" style={{ borderColor: accent, color: accent }}><Text>v{it.version}</Text></View> : null}
                <Text className="li-go">›</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}
