// 运营可配的预设：每日献策 / 建档问卷 / 方案额度
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
  { text: '真正的战略，不是多做一件事，而是<em>少犯一个大错</em>。', enabled: true },
  { text: '利润不是财务表里的数字，是商业模式<em>被市场验证</em>后的结果。', enabled: true },
  { text: '先找到<em>最小可赢市场</em>，再谈全国复制。', enabled: true },
  { text: '客户愿意复购，才说明你的增长不是<em>一次性买量</em>。', enabled: true },
  { text: '不要用热闹证明增长，要用<em>留存和毛利</em>证明价值。', enabled: true },
  { text: '一家公司的护城河，常常长在<em>交付细节</em>里。', enabled: true },
  { text: '好的融资故事，必须经得起<em>单位经济模型</em>追问。', enabled: true },
  { text: '组织问题很少只在组织里，更多藏在<em>战略不清</em>里。', enabled: true },
  { text: '定价不是报一个数，是选择你要服务的<em>客户层级</em>。', enabled: true },
  { text: '现金流紧时，先砍低确定性动作，再保留<em>高信号实验</em>。', enabled: true },
  { text: '竞品最值得看的，不是他们说什么，而是他们<em>持续投入什么</em>。', enabled: true },
  { text: '把复杂问题拆到<em>可验证假设</em>，焦虑就会变成行动。', enabled: true },
  { text: '增长先问渠道，再问转化，最后必须回到<em>复购</em>。', enabled: true },
  { text: '品牌不是漂亮话，是客户在关键时刻<em>想起你的理由</em>。', enabled: true },
  { text: '老板最重要的工作，是把资源押到<em>少数关键战场</em>。', enabled: true },
  { text: '如果指标不能指导动作，它只是<em>漂亮报表</em>。', enabled: true },
  { text: '先让一个细分客群离不开你，再让更多客群<em>看见你</em>。', enabled: true },
  { text: '商业判断要先问一句：这件事会不会改善<em>现金、利润或壁垒</em>？', enabled: true },
  { text: '真正的机会窗口，通常出现在对手<em>路径依赖</em>最强的时候。', enabled: true },
  { text: '越是早期公司，越要把每次试错变成<em>可复用知识</em>。', enabled: true },
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
    features: ['10 点 / 月', '基础顾问 3 位', '适合轻量试用'],
    highlighted: false,
  },
  {
    name: '决策版',
    price: 198000,
    period: 'year',
    creditsPerMonth: 68,
    agentCount: 8,
    features: ['不限量对话', '68 点 / 月', '顾问助手 8 位', '方案库 + 导出'],
    highlighted: true,
  },
  {
    name: '企业版 · 私有化',
    price: -1, // 面议
    period: 'year',
    creditsPerMonth: -1,
    agentCount: 14,
    features: ['私有化部署', '接入内部系统', '专属助手配置', '数据不出内网'],
    highlighted: false,
  },
];

// 行业基准库（RAG 占位；生产替换为向量检索）
export const INDUSTRY_BENCHMARK =
  'SaaS / 软件行业 A 轮前后典型基准：净收入留存 100–110%、毛利率 70%+、获客回收 12–18 个月、经常性收入占比目标 25%+。';
