import { useMemo, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import { useStore } from '../../hooks/useStore';
import { api, type ReportItem } from '../../services/api';
import './index.scss';

type Filter = 'all' | 'verdict' | 'plan' | 'minutes';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'verdict', label: '断语' },
  { key: 'plan', label: '方案' },
  { key: 'minutes', label: '纪要' },
];

function relTime(iso: string): string {
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 3600) return '刚刚';
  if (sec < 86400) return `${Math.floor(sec / 3600)} 小时前`;
  const d = Math.floor(sec / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}

// 报告类别归一：印章字（断/策/要）+ 过滤分类。拿不准统一「策」。
function categorize(type: string): { filter: Filter; stamp: string } {
  if (/断|研判|初见|诊断/.test(type)) return { filter: 'verdict', stamp: '断' };
  if (/纪要|复盘|会议/.test(type)) return { filter: 'minutes', stamp: '要' };
  return { filter: 'plan', stamp: '策' };
}

// 锦囊（tab1）—— 产出书架：全部报告纵向单流，一种卡片样式。
// 顶部两枚常设卷宗（完整履历 / 全年天时）；过滤 chips；报告流点开报告详情。
export default function Satchel() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [reports, setReports] = useState<ReportItem[]>([]);
  const [filter, setFilter] = useState<Filter>('all');

  useDidShow(() => {
    s.setTab(1);
    Taro.getCurrentInstance().page?.getTabBar?.();
    if (s.isAuthed()) {
      api.reports().then((list) => {
        setReports(list);
        // 进入锦囊即把「已看时间」推到最新报告时间并清朱砂点（list 按 updatedAt desc）
        s.markReportsSeen(list[0]?.updatedAt);
      }).catch((e) => { s.handleApiError(e, { silent: true }); setReports([]); s.markReportsSeen(); });
    } else {
      setReports([]);
      s.setSatchelDot(false);
    }
  });

  const decorated = useMemo(
    () => reports.map((r) => ({ ...r, ...categorize(r.type) })),
    [reports],
  );
  const shown = filter === 'all' ? decorated : decorated.filter((r) => r.filter === filter);

  const openReport = (id: string) => Taro.navigateTo({ url: `/packages/work/report/index?id=${id}` });
  const goDossier = () => Taro.navigateTo({ url: '/packages/work/dossier/index' });
  const goCalendar = () => Taro.navigateTo({ url: '/packages/work/calendar/index' });
  const goCounsel = () => Taro.switchTab({ url: '/pages/counsel/index' });

  return (
    <Screen topInset className="satchel">
      <View className="pad">
        <View className="satchel-head tab-page-head">
          <Text className="sh-title serif">锦囊</Text>
        </View>

        {/* 顶部两枚常设卷宗（唯一的横向并列） */}
        <View className="scroll-row">
          <View className="scroll-card card" onClick={goDossier}>
            <View className="sc-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={16} color={accent} /></View>
            <Text className="sc-t serif">完整履历</Text>
            <Text className="sc-d">军师执笔的创始人战略档案</Text>
          </View>
          <View className="scroll-card card" onClick={goCalendar}>
            <View className="sc-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="clock" size={16} color={accent} /></View>
            <Text className="sc-t serif">全年天时</Text>
            <Text className="sc-d">按命盘逐月推演，何时宜攻宜守</Text>
          </View>
        </View>

        {/* 过滤 chips */}
        <View className="chips satchel-filter">
          {FILTERS.map((f) => (
            <View key={f.key} className={`chip ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>
              <Text>{f.label}</Text>
            </View>
          ))}
        </View>

        {/* 报告流：一种卡片样式 */}
        {shown.length === 0 ? (
          <View className="satchel-empty">
            <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="pouch" size={22} color={accent} /></View>
            <Text className="et serif">{reports.length ? '此类暂无锦囊' : '帐中尚无锦囊'}</Text>
            <Text className="es">与军师聊过，锦囊自会出现。</Text>
            <Text className="es-link" style={{ color: accent }} onClick={goCounsel}>去问策 ›</Text>
          </View>
        ) : (
          shown.map((r) => (
            <View key={r.id} className="satchel-card card" onClick={() => openReport(r.id)}>
              <View className="sk-stamp serif" style={{ background: 'var(--accent-soft)', color: accent }}>{r.stamp}</View>
              <View className="sk-b">
                <Text className="sk-t serif">{r.title}</Text>
                <Text className="sk-sub">{r.type}{r.agentName ? ` · ${r.agentName}` : ''}</Text>
                <View className="sk-meta">
                  <Text className="sk-date">{relTime(r.updatedAt)}</Text>
                  <Text className="sk-ver">v{r.currentVersion}</Text>
                </View>
              </View>
              <Text className="sk-go">›</Text>
            </View>
          ))
        )}
      </View>
    </Screen>
  );
}
