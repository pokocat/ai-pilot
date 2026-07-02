import { useState } from 'react';
import { View, Text, Image } from '@tarojs/components';
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
  const [reportCount, setReportCount] = useState(0);
  const [showPicker, setShowPicker] = useState(false);
  const [showPlans, setShowPlans] = useState(false);

  useDidShow(() => {
    s.setTab(4);
    api.library().then((l) => setLibCount(l.length)).catch((e) => s.handleApiError(e));
    api.projects().then((p) => setProjCount(p.length)).catch((e) => s.handleApiError(e));
    api.reports().then((r) => setReportCount(r.length)).catch(() => {});
  });

  const rows = [
    { ic: 'insight', t: '个人档案', s: briefLine(me?.understanding), onClick: () => Taro.navigateTo({ url: '/pages/brief/index' }) },
    { ic: 'grid', t: '项目工作台', s: projCount ? `${projCount} 个项目` : '按项目管理事务', onClick: () => Taro.navigateTo({ url: '/packages/work/projects/index' }) },
    { ic: 'layers', t: '我的方案库', s: `${libCount} 份成果`, onClick: () => Taro.navigateTo({ url: '/packages/work/library/index' }) },
    { ic: 'attach', t: '我的资料库', s: '上传资料，军师咨询时参考', onClick: () => Taro.navigateTo({ url: '/packages/work/knowledge/index' }) },
    { ic: 'chart', t: '数据源绑定', s: '店铺、账号、财务等经营数据', onClick: () => Taro.navigateTo({ url: '/packages/work/bindings/index' }) },
    { ic: 'grid', t: '模块与 Skill', s: '军师方案的功能化承接', onClick: () => Taro.navigateTo({ url: '/packages/work/market/index' }) },
    { ic: 'user', t: '军师社群 · 服务关系', s: '分班与服务老师', onClick: () => Taro.navigateTo({ url: '/packages/work/community/index' }) },
    { ic: 'crown', t: '我的本命色', s: color.short, sw: true, onClick: () => setShowPicker(true) },
    { ic: 'doc', t: '套餐与额度', s: me?.plan?.name ?? '', onClick: () => setShowPlans(true) },
    { ic: 'layers', t: '钻石消耗明细', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/credits/index' }) },
    { ic: 'clock', t: '提醒与日历', s: '订阅提醒 · 即将开放', onClick: () => Taro.showToast({ title: '军令与复盘订阅提醒即将开放', icon: 'none' }) },
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
          {me?.user.avatarUrl ? (
            <Image className="me-av" src={me.user.avatarUrl} mode="aspectFill" />
          ) : (
            <View className="me-av serif" style={{ background: accent }}>
              {me?.user.name ? me.user.name[0] : <Icon name="user" size={20} color="#fff" />}
            </View>
          )}
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

        {/* 经营统计：案卷 / 报告 / 方案（真实计数，直达对应页面） */}
        <View className="statline">
          <View className="statbox card" onClick={() => Taro.navigateTo({ url: '/packages/work/projects/index' })}>
            <Text className="stat-n serif" style={{ color: accent }}>{projCount}</Text>
            <Text className="stat-l">战略案卷</Text>
          </View>
          <View className="statbox card" onClick={() => Taro.switchTab({ url: '/pages/thinktank/index' })}>
            <Text className="stat-n serif" style={{ color: accent }}>{reportCount}</Text>
            <Text className="stat-l">报告</Text>
          </View>
          <View className="statbox card" onClick={() => Taro.navigateTo({ url: '/packages/work/library/index' })}>
            <Text className="stat-n serif" style={{ color: accent }}>{libCount}</Text>
            <Text className="stat-l">方案</Text>
          </View>
        </View>

        <View className="credit card">
          <View className="cr-l">
            <Text className="cr-k">钻石 · 解锁专项顾问</Text>
            <View className="cr-vrow">
              <Icon name="diamond" size={16} color={color.vars['--accent-bright']} />
              <Text className="cr-v serif" style={{ color: 'var(--accent-bright)' }}>
                {me ? (me.creditBalance < 0 ? ' 不限量' : ` ${me.creditBalance}`) : ' —'}
              </Text>
            </View>
            <Text className="cr-quota">{quotaLine(me)}</Text>
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

// 本月产出额度行：真实 tokenQuota（不限量 / 已用百分比 / 未登录占位）
function quotaLine(me: { tokenQuota?: { limit: number; used: number; unlimited: boolean } } | null): string {
  const q = me?.tokenQuota;
  if (!q) return '本月产出额度 · —';
  if (q.unlimited || q.limit < 0) return '本月产出额度 · 不限量';
  if (!q.limit) return '本月产出额度 · 未开通';
  const pct = Math.min(100, Math.round((q.used / q.limit) * 100));
  return `本月产出额度 · 已用 ${pct}%`;
}

function briefLine(understanding?: { maturity: string; evidenceCount: { memories: number; projects: number; knowledge: number; sessions: number } }): string {
  if (!understanding) return '军师有多了解你的生意';
  if (understanding.maturity === 'ready') return '可用于咨询';
  const count = understanding.evidenceCount.memories + understanding.evidenceCount.projects + understanding.evidenceCount.knowledge + understanding.evidenceCount.sessions;
  return count ? `已沉淀 ${count} 条线索` : '待补资料';
}
