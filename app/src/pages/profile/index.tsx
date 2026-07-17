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

// 主公页（tab3）—— 瘦身：用户卡 → 钱粮卡（合并权益三格）→ 细线菜单（≤10 行）→ 社群卡。
// 删除：经营统计三宫格、深度能力解锁卡、方案库/完整履历/模块管理行、「提醒与日历」「私有化部署」toast 假入口。
export default function Profile() {
  const s = useStore();
  const color = s.color();
  const accent = color.vars['--accent'];
  const me = s.me();
  const [showPicker, setShowPicker] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const [prog, setProg] = useState<ProgressView | null>(null);

  useDidShow(() => {
    s.setTab(3);
    Taro.getCurrentInstance().page?.getTabBar?.();
    api.progress().then((r) => setProg(r.progress)).catch(() => setProg(null));
  });

  // 战略账本：有数据才显示（连续复盘或使用天数攒起来之前不亮空账本）
  const showLedger = !!prog && (prog.streak >= 3 || prog.usageDays >= 14);

  const rows = [
    { ic: 'insight', t: '个人档案', s: briefLine(me?.understanding), onClick: () => Taro.navigateTo({ url: '/pages/brief/index' }) },
    { ic: 'grid', t: '我的案卷', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/projects/index' }) },
    { ic: 'attach', t: '资料库', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/knowledge/index' }) },
    { ic: 'chart', t: '数据源', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/bindings/index' }) },
    { ic: 'doc', t: '钱粮明细', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/credits/index' }) },
    ...(showLedger ? [{ ic: 'layers', t: '战略账本', s: prog?.rank || '', onClick: () => Taro.navigateTo({ url: '/packages/work/ledger/index' }) }] : []),
    { ic: 'spark', t: '送你一卦', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/gift/index' }) },
    { ic: 'user', t: '军师社群', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/community/index' }) },
    { ic: 'crown', t: '本命色', s: color.short, sw: true, onClick: () => setShowPicker(true) },
    { ic: 'shield', t: '设置', s: '', onClick: () => Taro.navigateTo({ url: '/pages/settings/index' }) },
  ];

  return (
    <Screen topInset>
      <View className="pad account">
        {/* 页头：居中「主公」· 右「设置」 */}
        <View className="account-nav tab-page-head">
          <Text className="an-title serif">主公</Text>
          <Text className="an-side serif" onClick={() => Taro.navigateTo({ url: '/pages/settings/index' })}>设置</Text>
        </View>

        {/* 用户卡 */}
        <View className="account-user-card ink-in" onClick={() => Taro.navigateTo({ url: '/pages/settings/index' })}>
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
          {me?.plan?.name ? <Text className="au-vip pill">{me.plan.name}</Text> : null}
        </View>

        {/* 钱粮卡（合并权益三格，行式 kv，点开方案弹层） */}
        <View className="grain-card card ink-in ink-in-1" onClick={() => setShowPlans(true)}>
          <View className="gc-row">
            <Text className="gc-k t-body">钻石</Text>
            <Text className="gc-v serif">{me ? (me.creditBalance < 0 ? '不限量' : `${me.creditBalance}`) : '—'}</Text>
          </View>
          <View className="gc-row">
            <Text className="gc-k t-body">本月产出额度</Text>
            <Text className="gc-v serif">{quotaShort(me)}</Text>
          </View>
          <View className="gc-row">
            <Text className="gc-k t-body">套餐</Text>
            <Text className="gc-v serif">{me?.plan?.name || '未开通'}</Text>
          </View>
          <View className="gc-foot">
            <Text className="gc-more">方案与额度 ›</Text>
          </View>
        </View>

        {/* 细线菜单（非卡片堆） */}
        <View className="menu-lines ink-in ink-in-2">
          {rows.map((r) => (
            <View key={r.t} className="menu-line" onClick={r.onClick}>
              <View className="ml-ic"><Icon name={r.ic} size={14} color={accent} /></View>
              <Text className="ml-t t-body">{r.t}</Text>
              {r.sw ? <View className="ml-sw" style={{ background: accent }} /> : null}
              <Text className="ml-s t-mark">{r.s}</Text>
              <Text className="ml-go">›</Text>
            </View>
          ))}
        </View>

        {/* 军师社群 · 服务老师（主题卡） */}
        <View className="account-teacher ink-in ink-in-3" onClick={() => Taro.navigateTo({ url: '/packages/work/community/index' })}>
          <View className="at-b">
            <Text className="at-t">军师社群 · 服务老师</Text>
            <Text className="at-s">分班与入群任务 · 服务老师带你把军师用起来</Text>
          </View>
          <Text className="at-em">进入</Text>
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
