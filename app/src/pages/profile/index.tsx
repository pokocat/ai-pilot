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
    { ic: 'insight', t: '军师档案', s: briefLine(me?.understanding), onClick: () => Taro.navigateTo({ url: '/pages/brief/index' }) },
    { ic: 'grid', t: '项目工作台', s: projCount ? `${projCount} 个项目` : '按项目管理事务', onClick: () => Taro.navigateTo({ url: '/packages/work/projects/index' }) },
    { ic: 'layers', t: '我的方案库', s: `${libCount} 份成果`, onClick: () => Taro.navigateTo({ url: '/packages/work/library/index' }) },
    { ic: 'crown', t: '我的本命色', s: color.short, sw: true, onClick: () => setShowPicker(true) },
    { ic: 'doc', t: '方案与权益点', s: me?.plan?.name ?? '', onClick: () => setShowPlans(true) },
    { ic: 'insight', t: '设置', s: '', onClick: () => Taro.navigateTo({ url: '/pages/settings/index' }) },
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
        <View className="me-card card" onClick={() => Taro.navigateTo({ url: '/pages/settings/index' })}>
          <View className="me-av serif" style={{ background: accent }}>
            {me?.user.name ? me.user.name[0] : <Icon name="user" size={20} color="#fff" />}
          </View>
          <View className="me-info">
            <Text className="me-name">{me?.user.name || '完善你的资料 ›'}</Text>
            <Text className="me-org">{orgLine(me) || '点此设置称呼与公司，让产出更贴合你'}</Text>
          </View>
          {me?.plan?.name ? (
            <View className="me-vip" style={{ background: 'var(--accent-soft)' }}>
              <Icon name="crown" size={12} color={accent} /><Text style={{ color: 'var(--accent-ink)' }}> {me.plan.name}</Text>
            </View>
          ) : null}
        </View>

        <View className="credit card" style={{ background: '#1B1E22' }}>
          <View className="cr-l">
            <Text className="cr-k">本月权益点</Text>
            <View className="cr-vrow">
              <Icon name="diamond" size={16} color={color.vars['--accent-bright']} />
              <Text className="cr-v serif" style={{ color: 'var(--accent-bright)' }}>
                {me ? (me.creditBalance < 0 ? ' 不限量' : ` ${me.creditBalance} 点`) : ' —'}
              </Text>
            </View>
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
            <View className="pv-ic"><Icon name="shield" size={18} color={color.vars['--accent-bright']} /></View>
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

// 企业行：公司 · 行业，缺失项自动省略；都没有则返回空（由调用方走「完善资料」提示）。
function orgLine(me: { tenant: { name?: string | null; industry?: string | null } } | null): string {
  if (!me) return '';
  return [me.tenant.name, me.tenant.industry].filter(Boolean).join(' · ');
}

function briefLine(understanding?: { maturity: string; evidenceCount: { memories: number; projects: number; knowledge: number; sessions: number } }): string {
  if (!understanding) return '军师有多了解你的生意';
  if (understanding.maturity === 'ready') return '可用于咨询';
  const count = understanding.evidenceCount.memories + understanding.evidenceCount.projects + understanding.evidenceCount.knowledge + understanding.evidenceCount.sessions;
  return count ? `已沉淀 ${count} 条线索` : '待补资料';
}
