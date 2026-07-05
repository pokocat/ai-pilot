import { useState } from 'react';
import { View, Text, Image } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import Picker from '../../components/Picker';
import Plans from '../../components/Plans';
import { useStore } from '../../hooks/useStore';
import { api, type ProgressView } from '../../services/api';
import './index.scss';

// 我的页 —— 对齐设计稿 page-profile：居中标题 / 深绿用户卡 / 统计与额度 / 菜单 / 老师卡 / 深度能力卡。
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
  const [prog, setProg] = useState<ProgressView | null>(null);

  useDidShow(() => {
    s.setTab(4);
    api.library().then((l) => setLibCount(l.length)).catch((e) => s.handleApiError(e));
    api.projects().then((p) => setProjCount(p.length)).catch((e) => s.handleApiError(e));
    api.reports().then((r) => setReportCount(r.length)).catch(() => {});
    api.progress().then((r) => setProg(r.progress)).catch(() => setProg(null));
  });

  const rows = [
    { ic: 'insight', t: '个人 / 企业档案', s: briefLine(me?.understanding), onClick: () => Taro.navigateTo({ url: '/pages/brief/index' }) },
    { ic: 'grid', t: '我的案卷', s: projCount ? `${projCount}` : '', onClick: () => Taro.navigateTo({ url: '/packages/work/projects/index' }) },
    { ic: 'layers', t: '方案库', s: `${libCount + reportCount}`, onClick: () => Taro.navigateTo({ url: '/packages/work/library/index' }) },
    { ic: 'attach', t: '我的资料库', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/knowledge/index' }) },
    { ic: 'chart', t: '数据授权与数据源', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/bindings/index' }) },
    { ic: 'grid', t: '模块管理 · 添加 / 隐藏', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/market/index' }) },
    { ic: 'doc', t: '订单支付 / 钻石明细', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/credits/index' }) },
    { ic: 'spark', t: '送你一卦 · 给朋友出速写卡', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/gift/index' }) },
    { ic: 'clock', t: '提醒与日历', s: '即将开放', onClick: () => Taro.showToast({ title: '军令与复盘订阅提醒即将开放', icon: 'none' }) },
    { ic: 'crown', t: '我的本命色', s: color.short, sw: true, onClick: () => setShowPicker(true) },
    { ic: 'shield', t: '私有化部署 · 企业版', s: '预约', onClick: () => Taro.showToast({ title: '已记录企业版意向', icon: 'none' }) },
    {
      ic: 'lock', t: '退出登录', s: '',
      onClick: () =>
        Taro.showModal({ title: '退出登录', content: '确定退出当前账号？' }).then((r) => {
          if (r.confirm) { s.logout(); Taro.reLaunch({ url: '/pages/sessions/index' }); }
        }),
    },
  ];

  return (
    <Screen topInset>
      <View className="pad account">
        {/* 页头：居中「我的军师系统」· 右「设置」 */}
        <View className="account-nav">
          <Text className="an-title serif">我的军师系统</Text>
          <Text className="an-side serif" onClick={() => Taro.navigateTo({ url: '/pages/settings/index' })}>设置</Text>
        </View>

        {/* 用户卡（深绿） */}
        <View className="account-user-card" onClick={() => Taro.navigateTo({ url: '/pages/settings/index' })}>
          {me?.user.avatarUrl ? (
            <Image className="au-av" src={me.user.avatarUrl} mode="aspectFill" />
          ) : (
            <View className="au-av au-av-ph serif">
              {me?.user.name ? me.user.name[0] : <Icon name="user" size={20} color="#fff" />}
            </View>
          )}
          <View className="au-b">
            <Text className="au-name serif">{me?.user.name || '完善你的资料 ›'}</Text>
            <Text className="au-sub">{orgLine(me) || '点此设置称呼与公司，让产出更贴合你'}</Text>
          </View>
          {me?.plan?.name ? <Text className="au-vip">{me.plan.name}</Text> : null}
        </View>

        {/* 经营统计（account-statline）：案卷 / 方案 / 资料（真实计数，四名词统一） */}
        <View className="account-statline">
          <View className="account-stat card" onClick={() => Taro.navigateTo({ url: '/packages/work/projects/index' })}>
            <Text className="as-n serif">{projCount}</Text>
            <Text className="as-l">案卷</Text>
          </View>
          <View className="account-stat card" onClick={() => Taro.navigateTo({ url: '/packages/work/library/index' })}>
            <Text className="as-n serif">{libCount + reportCount}</Text>
            <Text className="as-l">方案</Text>
          </View>
          <View className="account-stat card" onClick={() => Taro.navigateTo({ url: '/packages/work/knowledge/index' })}>
            <Text className="as-n serif">{me?.understanding?.evidenceCount.knowledge ?? 0}</Text>
            <Text className="as-l">资料</Text>
          </View>
        </View>

        {/* 权益额度（account-quota）：钻石 / 本月额度 / 套餐 */}
        <View className="account-quota">
          <View className="account-quota-item card" onClick={() => setShowPlans(true)}>
            <Text className="aq-v">{me ? (me.creditBalance < 0 ? '不限量' : `钻石 ${me.creditBalance}`) : '钻石 —'}</Text>
            <Text className="aq-l">解锁与消耗</Text>
          </View>
          <View className="account-quota-item card" onClick={() => setShowPlans(true)}>
            <Text className="aq-v">{quotaShort(me)}</Text>
            <Text className="aq-l">本月产出额度</Text>
          </View>
          <View className="account-quota-item card" onClick={() => setShowPlans(true)}>
            <Text className="aq-v">{me?.plan?.name || '未开通'}</Text>
            <Text className="aq-l">套餐权益</Text>
          </View>
        </View>

        {/* 战略段位（M4 PR-18）：全部真实计数——连续复盘/使用天数/准确率由服务端算 */}
        {prog ? (
          <View className="rank-card card">
            <View className="rk-badge"><Text className="serif">{prog.rank}</Text></View>
            <View className="rk-b">
              <Text className="rk-t serif">战略段位 · {prog.rank}</Text>
              <Text className="rk-s">
                连续复盘 {prog.streak} 天 · 使用第 {prog.usageDays} 天
                {prog.decisionAccuracy !== null ? ` · 决策准确率 ${prog.decisionAccuracy}%` : ''}
              </Text>
              {prog.nextRank ? <Text className="rk-next">下一段位 {prog.nextRank.rank}：{prog.nextRank.requirement}</Text> : null}
            </View>
          </View>
        ) : null}

        {/* 菜单（design menu：左侧色块图标 + 右值） */}
        <View className="menu card">
          {rows.map((r) => (
            <View key={r.t} className="menu-row" onClick={r.onClick}>
              <View className="menu-ic"><Icon name={r.ic} size={14} color={accent} /></View>
              <Text className="menu-t">{r.t}</Text>
              {r.sw ? <View className="menu-sw" style={{ background: accent }} /> : null}
              <Text className="menu-s">{r.s}</Text>
              <Text className="menu-go">›</Text>
            </View>
          ))}
        </View>

        {/* 服务老师 / 军师社群（account-teacher 暖金卡） */}
        <View className="account-teacher" onClick={() => Taro.navigateTo({ url: '/packages/work/community/index' })}>
          <View className="at-b">
            <Text className="at-t">军师社群 · 服务老师</Text>
            <Text className="at-s">分班与入群任务 · 服务老师带你把军师用起来</Text>
          </View>
          <Text className="at-em">进入</Text>
        </View>

        {/* 深度能力解锁（account-depth 绿卡） */}
        <View className="account-depth" onClick={() => setShowPlans(true)}>
          <View className="ad-b">
            <Text className="ad-t">深度能力解锁</Text>
            <Text className="ad-s">更高产出额度、进阶锦囊、数据增强与长期监控</Text>
          </View>
          <Text className="ad-em">管理</Text>
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

// 本月产出额度（短版）：不限量 / 已用百分比 / 未开通
function quotaShort(me: { tokenQuota?: { limit: number; used: number; unlimited: boolean } } | null): string {
  const q = me?.tokenQuota;
  if (!q) return '—';
  if (q.unlimited || q.limit < 0) return '不限量';
  if (!q.limit) return '未开通';
  const pct = Math.min(100, Math.round((q.used / q.limit) * 100));
  return `已用 ${pct}%`;
}

function briefLine(understanding?: { maturity: string; evidenceCount: { memories: number; projects: number; knowledge: number; sessions: number } }): string {
  if (!understanding) return '';
  if (understanding.maturity === 'ready') return '可用于咨询';
  const count = understanding.evidenceCount.memories + understanding.evidenceCount.projects + understanding.evidenceCount.knowledge + understanding.evidenceCount.sessions;
  return count ? `${count} 条线索` : '待补资料';
}
