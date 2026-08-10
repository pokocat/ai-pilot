import type { PcTab } from '../state';
import type { Region } from './types';
import { platform } from '../../services/platform';
import SessionsListBody from './sessions';
import SessionsMain, { useChatBar } from './chat';
import SandMain, { SAND_REFRESH_EVENT } from './sand';
import ExecMain, { EXEC_EXPORT_EVENT } from './exec';
import LordMain from './lord';
import ThinkAssets from './thinkAssets';
import ThinkData from './thinkData';
import ThinkModules from './thinkModules';
import ThinkReports from './thinkReports';

// 五个区的注册表。Phase 0 只有导航骨架，主工作区是占位；
// 后续每落地一个区，就把这里的 Main 换成真实实现（Shell 不用改）。

const sessions: Region = {
  head: { glyph: '策', kicker: '有 事 问 军 师', title: '问策' },
  useBar: useChatBar,
  ListBody: SessionsListBody,
  Main: SessionsMain,
};

const sand: Region = {
  head: { glyph: '盘', kicker: '看 今 日 判 断', title: '沙盘' },
  useGroups: (st) => [
    {
      label: '战 局',
      rows: [
        { key: 'business', ic: '经', t: '经营战局', s: '主要矛盾 · 三势 · 依据', on: st.view === 'business', go: () => st.setView('business') },
        { key: 'timing', ic: '时', t: '时运策', s: '本月攻守 · 全年拐点', on: st.view === 'timing', go: () => st.setView('timing') },
        { key: 'destiny', ic: '命', t: '命盘分析', s: '四柱 · 日主 · 格局', on: st.view === 'destiny', go: () => st.setView('destiny') },
      ],
    },
  ],
  useBar: (st) => ({
    business: { title: '经营战局', sub: '判断随案卷与数据变化，随变而调', actions: [{ t: '刷新判断', ghost: true, go: () => window.dispatchEvent(new CustomEvent(SAND_REFRESH_EVENT)) }] },
    timing: { title: '时运策', sub: '本月攻守 · 全年拐点', actions: [{ t: '天时日历', go: () => platform.navigate('/packages/work/calendar/index') }] },
    destiny: { title: '命盘分析', sub: '四柱 · 日主 · 格局', actions: [{ t: '完整命盘', go: () => platform.navigate('/packages/work/mingpan/index') }] },
  }[st.view] || { title: '沙盘' }),
  Main: SandMain,
};

const exec: Region = {
  head: { glyph: '兵', kicker: '做 今 天 的 事', title: '点兵' },
  useGroups: (st) => [
    {
      label: '执 行',
      rows: [
        { key: 'today', ic: '今', t: '今日军令', s: '待执行 · 已办', on: st.view === 'today', go: () => st.setView('today') },
        { key: 'week', ic: '周', t: '周计划', s: '按天保留执行记录', on: st.view === 'week', go: () => st.setView('week') },
        { key: 'review', ic: '复', t: '复盘', s: '三势检查 · 决策验证', on: st.view === 'review', go: () => st.setView('review') },
      ],
    },
  ],
  useBar: (st) => ({
    today: { title: '今日军令', sub: '完成度与复盘节奏', actions: [{ t: '导出今日军令', go: () => window.dispatchEvent(new CustomEvent(EXEC_EXPORT_EVENT)) }, { t: '开始复盘', primary: true, go: () => st.setView('review') }] },
    week: { title: '周计划', sub: '按天保留执行记录' },
    review: { title: '复盘', sub: '三势检查 · 决策验证', actions: [{ t: '返回今日军令', go: () => st.setView('today') }] },
  }[st.view] || { title: '点兵' }),
  Main: ExecMain,
};

const think: Region = {
  head: { glyph: '囊', kicker: '存 你 的 家 底', title: '锦囊' },
  useGroups: (st) => [
    {
      label: '分 区',
      rows: [
        { key: 'assets', ic: '案', t: '案卷资产', s: '资料上传 · 整理 · 入库', on: st.view === 'assets', go: () => st.setView('assets') },
        { key: 'data', ic: '数', t: '账号与数据', s: '授权来源 · 持续记忆', on: st.view === 'data', go: () => st.setView('data') },
        { key: 'modules', ic: '能', t: '能力', s: '免费 · 深度 · 会员模块', on: st.view === 'modules', go: () => st.setView('modules') },
        { key: 'reports', ic: '方', t: '方案', s: '方案库 · 历史版本', on: st.view === 'reports', go: () => st.setView('reports') },
      ],
    },
  ],
  useBar: (st) => ({
    assets: { title: '案卷资产', sub: '这些资料我都读过了，做判断时会用上' },
    data: { title: '账号与数据', sub: '每个来源独立授权，也可以随时暂停和删除' },
    modules: { title: '能力', sub: '免费能力先判断，深度能力做推演，会员模块负责长期执行' },
    reports: { title: '方案', sub: '对话里出的方案，存一次就留一版' },
  }[st.view] || { title: '锦囊' }),
  // 四个子区各是一个组件：换子区就是换组件类型，React 自然卸载重挂，
  // 各自的 hook 表互不相干（外壳侧的同类陷阱见 App.tsx 的 RegionBar 说明）。
  Main: ({ st }) => {
    const View = { assets: ThinkAssets, data: ThinkData, modules: ThinkModules, reports: ThinkReports }[st.view]
      || ThinkAssets;
    return <View st={st} />;
  },
};

const lord: Region = {
  head: { glyph: '公', kicker: '你 自 己', title: '主公' },
  useGroups: (st) => [
    {
      label: '账 户',
      rows: [
        { key: 'overview', ic: '总', t: '总览', s: '会员 · 谶语 · 统计', on: st.view === 'overview', go: () => st.setView('overview') },
        { key: 'plans', ic: '权', t: '方案与权益', s: '当前方案 · 可选档位', on: st.view === 'plans', go: () => st.setView('plans') },
        { key: 'credits', ic: '算', t: '算力账本', s: '余额 · 变动明细', on: st.view === 'credits', go: () => st.setView('credits') },
      ],
    },
  ],
  useBar: (st) => ({
    overview: { title: '主公', sub: '账户 · 权益 · 战略档案', actions: [{ t: '设置', go: () => platform.navigate('/packages/main/settings/index') }] },
    plans: { title: '方案与权益', sub: '当前方案 · 可选档位' },
    credits: { title: '算力账本', sub: '余额 · 变动明细' },
  }[st.view] || { title: '主公' }),
  Main: LordMain,
};

export const REGIONS: Record<PcTab, Region> = { sessions, sand, exec, think, lord };
