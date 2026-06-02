// 运营可配的预设：每日献策 / 建档问卷 / 套餐算力
// 事实来源对齐原型 scripts/app.js 与 运营后台.html。

export const SAYINGS: { text: string; enabled: boolean }[] = [
  { text: '先把自己<em>立于不败</em>，再等对手露出破绽。', enabled: true },
  { text: '现金流不是结果，是你每个<em>决策的回声</em>。', enabled: true },
  { text: '增长的尽头，是你能<em>服务好</em>的那群人。', enabled: true },
  { text: '战略是<em>选择不做什么</em>，比做什么更难。', enabled: true },
  { text: '没有<em>壁垒</em>的增长是负债；先有护城河，再谈规模。', enabled: true },
  { text: '别在<em>非共识</em>里随大流，机会藏在少数人对的地方。', enabled: true },
  { text: '组织的上限，往往是<em>创始人认知</em>的上限。', enabled: false },
  { text: '做难而正确的事，<em>时间</em>会成为你的朋友。', enabled: true },
];

export const SURVEY: { key: string; title: string; options: string[] }[] = [
  { key: 'industry', title: '你的行业？', options: ['SaaS / 软件', '消费 / 零售', '制造', '服务 / 咨询', '其他'] },
  { key: 'stage', title: '当前阶段？', options: ['起步 / 验证', 'A 轮前后', '规模化', '稳定盈利'] },
  { key: 'pain', title: '最头疼的事？', options: ['增长乏力', '现金流', '融资', '组织 / 团队', '定位 / 竞争'] },
];

export const PLANS: {
  name: string;
  price: number; // 分
  period: string;
  creditsPerMonth: number;
  agentCount: number;
  features: string[];
  highlighted: boolean;
}[] = [
  {
    name: '体验版',
    price: 0,
    period: 'month',
    creditsPerMonth: 10,
    agentCount: 3,
    features: ['10 次军师算力 / 月', '内置顾问 3 位', '不含方案库导出'],
    highlighted: false,
  },
  {
    name: '决策版',
    price: 198000,
    period: 'year',
    creditsPerMonth: 68,
    agentCount: 8,
    features: ['不限量对话', '68 次深度产出 / 月', '内置顾问 8 位', '方案库 + 导出'],
    highlighted: true,
  },
  {
    name: '企业版 · 私有化',
    price: -1, // 面议
    period: 'year',
    creditsPerMonth: -1,
    agentCount: 14,
    features: ['私有化部署', '接入内部系统', '专属训练', '数据不出内网'],
    highlighted: false,
  },
];

// 行业基准库（RAG 占位；生产替换为向量检索）
export const INDUSTRY_BENCHMARK =
  'SaaS / 软件行业 A 轮前后典型基准：净收入留存 100–110%、毛利率 70%+、获客回收 12–18 个月、经常性收入占比目标 25%+。';
