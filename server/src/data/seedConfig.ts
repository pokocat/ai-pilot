// 运营可配的预设：每日献策 / 建档问卷 / 方案额度
// 事实来源对齐原型 scripts/app.js 与 运营后台.html。

import { industryOptionLabels } from './industryPacks.js';

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
  // 行业选项从行业包（data/industryPacks.ts）派生 —— 单一真相源：新增行业包，选项自动跟上。
  { key: 'industry', title: '你的行业？', options: industryOptionLabels() },
  // M3 PR-13：阶段改营收区间（V6.0 §7 阶段自适应的判定输入）；旧标签在 stageOf() 里保持兼容。
  { key: 'stage', title: '年营收大概在？', options: ['100 万以下', '100-500 万', '500 万-5000 万', '5000 万以上'] },
  { key: 'pain', title: '最头疼的事？', options: ['增长乏力', '现金流', '融资', '组织 / 团队', '定位 / 竞争'] },
];

export const PLANS: {
  name: string;
  price: number; // 分
  period: string;
  creditsPerMonth: number;
  tokenQuotaPerMonth: number;
  agentCount: number;
  features: string[];
  highlighted: boolean;
}[] = [
  {
    name: '体验版',
    price: 0,
    period: 'month',
    creditsPerMonth: 10,
    tokenQuotaPerMonth: 200000,
    agentCount: 3,
    features: ['10 点 / 月', '基础顾问 3 位', '适合轻量试用'],
    highlighted: false,
  },
  // 决策版·月付（D11 新增付费月付 SKU）：与年付同档月度权益（68 点/月、100 万 token/月、8 助手），
  // 仅计费周期不同 → 使「月→年升级折算」实际生效（业界 SaaS 通行的月/年同权益、年付更省）。
  {
    name: '决策版 · 月付',
    price: 19800, // ¥198/月（年付 ¥1980 ≈ 10 个月月付价 → 年付立省 2 个月）
    period: 'month',
    creditsPerMonth: 68,
    tokenQuotaPerMonth: 1000000,
    agentCount: 8,
    features: ['不限量对话', '68 点 / 月', '顾问助手 8 位', '方案库 + 导出', '按月付费 · 随时升年付'],
    highlighted: false,
  },
  // 决策版（年付）：旗舰主推（highlighted）。保持名称「决策版」不带后缀 = 头牌方案，亦兼容既有用例/演示数据。
  {
    name: '决策版',
    price: 198000,
    period: 'year',
    creditsPerMonth: 68,
    tokenQuotaPerMonth: 1000000,
    agentCount: 8,
    features: ['年付立省 2 个月（约 ¥396）', '不限量对话', '68 点 / 月', '顾问助手 8 位', '方案库 + 导出'],
    highlighted: true,
  },
  {
    name: '企业版 · 私有化',
    price: -1, // 面议
    period: 'year',
    creditsPerMonth: -1,
    tokenQuotaPerMonth: -1,
    agentCount: 14,
    features: ['私有化部署', '接入内部系统', '专属助手配置', '数据不出内网'],
    highlighted: false,
  },
];

// 注：行业基准已迁入 data/industryPacks.ts（按行业取，不再是单一写死串）。SaaS 基准 = saas 包的 benchmark。

// V7-12：单次付费商品目录（SKU）。定价对齐效果图/方案 D-5；代码即真相源，admin:sync-content 幂等 upsert。
// kind=module → 支付后 upsert UserModule(grantsModuleKey) 启用能力；service → 一次性服务凭据；storage → 空间加档(metaBytes)。
// grantsModuleKey 必须与 data/modules.ts 的 moduleKey 对齐。
export const SKUS: {
  key: string; name: string; desc: string; priceFen: number;
  kind: 'module' | 'service' | 'storage'; grantsModuleKey?: string; metaBytes?: number;
}[] = [
  { key: 'deep-organize', name: '深度整理', desc: '军师对上传资料做深度去重、提炼与补标，整理成可直接调用的知识。', priceFen: 3900, kind: 'service' },
  { key: 'storage-2g', name: '资料空间包', desc: '为资料库扩容约 2GB，容纳更多经营材料。', priceFen: 1900, kind: 'storage', metaBytes: 2 * 1024 * 1024 * 1024 },
  { key: 'deep-contradiction', name: '深度矛盾分析', desc: '围绕主要矛盾做一次深度拆解，给出结构化打法与验证标准。', priceFen: 2900, kind: 'module', grantsModuleKey: 'deep-contradiction' },
  { key: 'fin-checkup', name: '财务经营体检', desc: '对经营与财务数据做一次系统体检，定位现金与利润风险。', priceFen: 4900, kind: 'module', grantsModuleKey: 'fin-checkup' },
  { key: 'ip-topics-pro', name: 'IP 选题库 · 高级版', desc: '按你的定位批量产出可执行的内容选题库。', priceFen: 9900, kind: 'module', grantsModuleKey: 'ip-topics-pro' },
  { key: 'shop-dashboard', name: '店铺数据看板', desc: '搭建店铺经营数据看板，按周复盘核心经营指标。', priceFen: 19900, kind: 'module', grantsModuleKey: 'shop-dashboard' },
];
