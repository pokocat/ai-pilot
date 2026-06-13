import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import Picker from '../../components/Picker';
import Plans from '../../components/Plans';
import { useStore } from '../../hooks/useStore';
import { api } from '../../services/api';
import './index.scss';

export default function Profile() {
  const s = useStore();
  const color = s.color();
  const accent = color.vars['--accent'];
  const me = s.me();
  const [libCount, setLibCount] = useState(0);
  const [projCount, setProjCount] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  const [showPlans, setShowPlans] = useState(false);

  useDidShow(() => {
    s.setTab(4);
    api.library().then((l) => setLibCount(l.length)).catch((e) => s.handleApiError(e));
    api.projects().then((p) => setProjCount(p.length)).catch((e) => s.handleApiError(e));
  });

  const rows = [
    { ic: 'grid', t: '项目工作台', s: projCount ? `${projCount} 个项目` : '按项目管理事务', onClick: () => Taro.navigateTo({ url: '/packages/work/projects/index' }) },
    { ic: 'layers', t: '我的方案库', s: `${libCount} 份成果`, onClick: () => Taro.navigateTo({ url: '/packages/work/library/index' }) },
    { ic: 'crown', t: '我的本命色', s: color.short, sw: true, onClick: () => setShowPicker(true) },
    { ic: 'doc', t: '方案与额度', s: me?.plan?.name ?? '决策版', onClick: () => setShowPlans(true) },
    { ic: 'insight', t: '设置', s: '', onClick: () => Taro.showToast({ title: '设置', icon: 'none' }) },
    {
      ic: 'lock', t: '退出登录', s: '',
      onClick: () =>
        Taro.showModal({ title: '退出登录', content: '确定退出当前账号？' }).then((r) => {
          if (r.confirm) { s.logout(); Taro.reLaunch({ url: '/pages/home/index' }); }
        }),
    },
  ];

  return (
    <Screen topInset>
      <View className="pad">
        <View className="me-card card">
          <View className="me-av serif" style={{ background: accent }}>{(me?.user.name ?? '王')[0]}</View>
          <View className="me-info">
            <Text className="me-name">{me?.user.name ?? '王总'}</Text>
            <Text className="me-org">{me?.tenant.name ?? '云栖科技'} · {me?.tenant.industry ?? 'SaaS / 软件'}</Text>
          </View>
          <View className="me-vip" style={{ background: 'var(--accent-soft)' }}>
            <Icon name="crown" size={12} color={accent} /><Text style={{ color: 'var(--accent-ink)' }}> {me?.plan?.name ?? '决策版'}</Text>
          </View>
        </View>

        <View className="credit card" style={{ background: '#1B1E22' }}>
          <View className="cr-l">
            <Text className="cr-k">本月产出额度</Text>
            <Text className="cr-v serif" style={{ color: 'var(--accent-bright)' }}>剩余 {me?.creditBalance ?? 68} 次</Text>
          </View>
          <View className="cr-btn" style={{ background: accent }} onClick={() => setShowPlans(true)}>
            <Text>管理</Text>
          </View>
        </View>

        <View className="rows card">
          {rows.map((r) => (
            <View key={r.t} className="row" onClick={r.onClick}>
              <View className="row-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={r.ic} size={16} color={accent} /></View>
              <Text className="row-t">{r.t}</Text>
              {r.sw ? <View className="row-sw" style={{ background: accent }} /> : null}
              <Text className="row-s">{r.s}</Text>
              <Text className="row-go">›</Text>
            </View>
          ))}
        </View>

        {/* 私有化部署 · 企业版 */}
        <View className="private card" style={{ background: '#1B1E22' }}>
          <View className="pv-top">
            <View className="pv-ic"><Icon name="lock" size={16} color="var(--accent-bright)" /></View>
            <View className="pv-badge" style={{ borderColor: 'var(--accent-bright)' }}><Text style={{ color: 'var(--accent-bright)' }}>企业版</Text></View>
          </View>
          <Text className="pv-t serif">私有化部署 · 深度经营诊断</Text>
          <Text className="pv-d">财务 / 合同 / 客户等机密数据不出内网，军师在你的服务器内运行，支撑更深的经营诊断。</Text>
          <View className="pv-cta" onClick={() => Taro.showToast({ title: '已记录企业版意向', icon: 'none' })}>
            <Text>预约了解 ›</Text>
          </View>
        </View>
      </View>

      <Picker open={showPicker} first={false} onClose={() => setShowPicker(false)} onConfirm={() => setShowPicker(false)} />
      <Plans open={showPlans} onClose={() => setShowPlans(false)} />
    </Screen>
  );
}
