import { useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Icon from '../../components/Icon';
import SafeHeader from '../../components/SafeHeader';
import { useStore } from '../../hooks/useStore';
import { api, type ProjectItem } from '../../services/api';
import './index.scss';

// 项目工作台：企业事务主线。每个项目串起 会话 / 报告 / 知识。
export default function Projects() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [items, setItems] = useState<ProjectItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');

  const load = () => api.projects().then(setItems).catch(() => setItems([]));
  useDidShow(load);

  const create = async () => {
    const v = name.trim();
    if (!v) return;
    setName('');
    setCreating(false);
    const r = await api.createProject({ name: v }).catch(() => null);
    await load();
    if (r) Taro.navigateTo({ url: `/pages/project/index?id=${r.id}` });
  };

  return (
    <View className={`page projects ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader
        title="项目工作台"
        onBack={() => Taro.navigateBack()}
        titleClassName="pj-title"
        right={<View className="safe-hbtn" onClick={() => setCreating((c) => !c)}><Text className="plus" style={{ color: accent }}>＋</Text></View>}
      />

      {creating && (
        <View className="pj-new">
          <Input className="pj-new-input" value={name} placeholder="新建项目名，如「2026 融资冲刺」" confirmType="done" onInput={(e) => setName(e.detail.value)} onConfirm={create} focus />
          <View className="pj-new-btn" style={{ background: accent }} onClick={create}><Text>创建</Text></View>
        </View>
      )}

      <View className="pad" style={{ paddingTop: '12px' }}>
        {items.length === 0 ? (
          <View className="pj-empty">
            <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="layers" size={22} color={accent} /></View>
            <Text className="et">还没有项目</Text>
            <Text className="es">把一次融资、一个新品上市、一次组织调整建成「项目」，对话、报告、知识都会有序归拢到这里。</Text>
            <View className="es-btn" style={{ background: accent }} onClick={() => setCreating(true)}><Text>新建第一个项目</Text></View>
          </View>
        ) : (
          <View className="pj-list">
            {items.map((p) => (
              <View key={p.id} className="pj-item card" onClick={() => Taro.navigateTo({ url: `/pages/project/index?id=${p.id}` })}>
                <View className="pj-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={p.icon || 'layers'} size={20} color={accent} /></View>
                <View className="pj-b">
                  <Text className="pj-n">{p.name}</Text>
                  {p.summary ? <Text className="pj-s">{p.summary}</Text> : null}
                  <View className="pj-counts">
                    <Text className="pj-c"><Text className="num" style={{ color: accent }}>{p.counts.sessions}</Text> 对话</Text>
                    <Text className="pj-c"><Text className="num" style={{ color: accent }}>{p.counts.reports}</Text> 报告</Text>
                    <Text className="pj-c"><Text className="num" style={{ color: accent }}>{p.counts.knowledge}</Text> 知识</Text>
                  </View>
                </View>
                <Text className="pj-go">›</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}
