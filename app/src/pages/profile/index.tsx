import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import Picker from '../../components/Picker';
import Plans from '../../components/Plans';
import { useStore } from '../../hooks/useStore';
import { api, type MyCreditItem } from '../../services/api';
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
  const [showCredits, setShowCredits] = useState(false);
  const [creditItems, setCreditItems] = useState<MyCreditItem[]>([]);

  useDidShow(() => {
    s.setTab(4);
    api.library().then((l) => setLibCount(l.length)).catch((e) => s.handleApiError(e));
    api.projects().then((p) => setProjCount(p.length)).catch((e) => s.handleApiError(e));
    api.myCredits().then((r) => setCreditItems(r.items)).catch(() => {});
  });

  const rows = [
    { ic: 'insight', t: '军师档案', s: briefLine(me?.understanding), onClick: () => Taro.navigateTo({ url: '/pages/brief/index' }) },
    { ic: 'grid', t: '项目工作台', s: projCount ? `${projCount} 个项目` : '按项目管理事务', onClick: () => Taro.navigateTo({ url: '/packages/work/projects/index' }) },
    { ic: 'layers', t: '我的方案库', s: `${libCount} 份成果`, onClick: () => Taro.navigateTo({ url: '/packages/work/library/index' }) },
    { ic: 'crown', t: '我的本命色', s: color.short, sw: true, onClick: () => setShowPicker(true) },
    { ic: 'doc', t: '套餐与额度', s: me?.plan?.name ?? '', onClick: () => setShowPlans(true) },
    { ic: 'layers', t: '钻石消耗明细', s: '', onClick: () => setShowCredits(true) },
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
            <Text className="cr-k">钻石 · 解锁专项顾问</Text>
            <View className="cr-vrow">
              <Icon name="diamond" size={16} color={color.vars['--accent-bright']} />
              <Text className="cr-v serif" style={{ color: 'var(--accent-bright)' }}>
                {me ? (me.creditBalance < 0 ? ' 不限量' : ` ${me.creditBalance}`) : ' —'}
              </Text>
            </View>
          </View>
          <View className="cr-btn" style={{ background: accent }} onClick={() => setShowPlans(true)}>
            <Text>管理</Text>
          </View>
        </View>

        {/* 本月产出额度（token 消耗池）进度 —— 客户端只看 % */}
        <View className="card" style={{ background: '#1B1E22', padding: '16px 18px' }}>
          <View style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <Text style={{ fontSize: 13, color: 'rgba(255,255,255,.6)' }}>本月产出额度</Text>
            <Text className="serif" style={{ fontSize: 15, color: 'var(--accent-bright)' }}>{quotaLabel(me?.tokenQuota)}</Text>
          </View>
          <View style={{ height: 7, borderRadius: 4, background: 'rgba(255,255,255,.12)', overflow: 'hidden' }}>
            <View style={{ height: '100%', width: `${quotaPct(me?.tokenQuota)}%`, background: accent, borderRadius: 4 }} />
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
      {showCredits && (
        <View style={{ position: 'fixed', left: 0, right: 0, top: 0, bottom: 0, background: 'rgba(0,0,0,.45)', zIndex: 60, display: 'flex', alignItems: 'flex-end' }} onClick={() => setShowCredits(false)}>
          <View style={{ width: '100%', maxHeight: '70vh', background: '#fff', borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: '20px 18px', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
            <Text style={{ fontSize: 16, fontWeight: 600, display: 'block', marginBottom: 4 }}>钻石消耗明细</Text>
            <Text style={{ fontSize: 12, color: '#aaa', display: 'block', marginBottom: 14 }}>解锁顾问 / 图片产出 / 充值赠送</Text>
            {creditItems.length === 0 ? (
              <Text style={{ color: '#999', fontSize: 13 }}>暂无钻石流水。解锁专项顾问或充值后会显示在这里。</Text>
            ) : creditItems.map((it, i) => (
              <View key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '11px 0', borderBottom: '1px solid #f0f0f0' }}>
                <View style={{ flex: 1, paddingRight: 12 }}>
                  <Text style={{ fontSize: 14, color: '#222', display: 'block' }}>{it.reason}</Text>
                  <Text style={{ fontSize: 11, color: '#aaa' }}>{fmtAt(it.at)}</Text>
                </View>
                <Text className="serif" style={{ fontSize: 16, color: it.delta >= 0 ? '#3A8A55' : '#9C4A38' }}>{it.delta >= 0 ? `+${it.delta}` : it.delta}</Text>
              </View>
            ))}
          </View>
        </View>
      )}
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
