// V7-08：能力/模块中心 · 服务端唯一目录真相源（自 app/src/data/operatingSystem.ts + 新版设计 §8 迁移）。
// 这些是产品能力目录（tier / 定价 / 使用详情 / 承接军师），不是用户业务数据；用户启用状态走 UserModule 表。
// moduleKey 必须与 SKU 目录（seedConfig.ts SKUS.grantsModuleKey）对齐，付费启用才能落到同一条 UserModule 行。
// 定价后续可由 admin 覆盖（预留 admin:sync-content 模式，v1 代码目录即真相）。
import type { ModuleGroup, ModuleTier, ModulePrice, ModuleDetail } from '../../../shared/contracts';

/** 目录条目（不含用户态：enabled/hidden/sortOrder 由 UserModule 合并后产出 ModuleView）。 */
export interface ModuleCatalogItem {
  key: string;
  label: string;
  desc: string;
  iconChar: string;
  group: ModuleGroup; // free 免费 / deep 深度 / member 会员
  tier: ModuleTier; // free 直启 / sku 单次付费 / credits 算力 / member 会员权益
  price?: ModulePrice; // skuKey / priceFen / credits / planRequired
  stateLabel: string; // 未启用时的目录态文案（启用后统一显示「已启用」）
  detail: ModuleDetail; // 能力详情屏：使用场景 + 输入/产出/消耗 + 回写位置
  agentKey?: string; // 免费能力「立即调用」承接的军师 key
}

// 10 个模块（设计 §8.2–8.4），顺序即目录默认排序（sortOrder 未设时按此序）。
export const MODULES: ModuleCatalogItem[] = [
  // ── 免费 Skill（group=free）：先判断，不消耗算力 ──
  {
    key: 'trend',
    label: '三势初判',
    desc: '天势 / 市势 / 人势，先给基础判断',
    iconChar: '势',
    group: 'free',
    tier: 'free',
    stateLabel: '默认启用',
    agentKey: 'general',
    detail: {
      scene: '把案卷里的行业、竞争和资源信息合成天势、市势、人势的基础判断，先定局再落子。',
      input: '案卷资料',
      output: '三势判断',
      cost: '免费',
      writeback: '战局页',
    },
  },
  {
    key: 'conflict',
    label: '矛盾初筛',
    desc: '识别当前最卡住增长的主线问题',
    iconChar: '矛',
    group: 'free',
    tier: 'free',
    stateLabel: '可直接调用',
    agentKey: 'general',
    detail: {
      scene: '从对话和案卷里识别当前最卡住增长的主线问题，先锁定主要矛盾再谈阶段打法。',
      input: '对话 + 案卷',
      output: '主要矛盾',
      cost: '免费',
      writeback: '战局页',
    },
  },

  // ── 深度 Skill（group=deep）：付费 / 算力 / 会员 ──
  {
    key: 'deep-contradiction',
    label: '深度矛盾分析',
    desc: '输出阶段打法、风险边界和不可做清单',
    iconChar: '深',
    group: 'deep',
    tier: 'sku',
    price: { skuKey: 'deep-contradiction', priceFen: 2900 },
    stateLabel: '¥29 启用',
    detail: {
      scene: '围绕主要矛盾做一次深度拆解，输出阶段打法、风险边界和明确的不可做清单。',
      input: '完整案卷',
      output: '深度诊断',
      cost: '¥29',
      writeback: '报告库',
    },
  },
  {
    key: 'growth',
    label: '增长漏斗诊断',
    desc: '结合店铺、私域和内容数据做深度推演',
    iconChar: '漏',
    group: 'deep',
    tier: 'credits',
    price: { credits: 80 },
    stateLabel: '消耗 80 算力',
    agentKey: 'growth',
    detail: {
      scene: '结合店铺、私域和内容数据推演线索、咨询、成交的转化断点，重排本周任务优先级。',
      input: '成交漏斗表',
      output: '转化断点',
      cost: '80 算力',
      writeback: '执行页',
    },
  },
  {
    key: 'ip-engine',
    label: 'IP 内容引擎',
    desc: '定位、选题、脚本、发布计划一体生成',
    iconChar: 'IP',
    group: 'deep',
    tier: 'member',
    price: { planRequired: true },
    stateLabel: '会员可用',
    agentKey: 'ip',
    detail: {
      scene: '从定位出发一体生成选题、脚本和发布计划，把判断转成可执行的内容动作。',
      input: 'IP 资料',
      output: '选题脚本',
      cost: '会员',
      writeback: '执行页',
    },
  },
  {
    key: 'finance',
    label: '财务经营体检',
    desc: '现金流、成本结构、利润风险初步拆解',
    iconChar: '财',
    group: 'deep',
    tier: 'sku',
    price: { skuKey: 'fin-checkup', priceFen: 4900 },
    stateLabel: '¥49 启用',
    detail: {
      scene: '对现金流、成本结构和利润风险做一次系统体检，判断增长动作是否值得投入。',
      input: '财务表',
      output: '经营体检',
      cost: '¥49',
      writeback: '报告库',
    },
  },

  // ── 会员模块（group=member）：承接执行和复盘 ──
  {
    key: 'daily-command',
    label: '每日军令',
    desc: '任务、提醒、复盘，承接认可后的方案',
    iconChar: '令',
    group: 'member',
    tier: 'free',
    stateLabel: '基础版免费',
    detail: {
      scene: '把认可后的方案拆成每日任务、提醒和复盘，承接执行闭环并回写案卷。',
      input: '认可判断',
      output: '每日军令',
      cost: '免费',
      writeback: '执行页',
    },
  },
  {
    key: 'topic-bank',
    label: 'IP 选题库高级版',
    desc: '按人设、产品和渠道生成长期选题池',
    iconChar: '题',
    group: 'member',
    tier: 'sku',
    price: { skuKey: 'ip-topics-pro', priceFen: 9900 },
    stateLabel: '¥99 单独购买',
    detail: {
      scene: '按人设、产品和渠道生成可持续运营的长期选题池，支撑内容执行。',
      input: '人设产品',
      output: '长期选题',
      cost: '¥99',
      writeback: '知识库',
    },
  },
  {
    key: 'shop-board',
    label: '店铺数据看板',
    desc: '曝光、点击、转化、复购持续追踪',
    iconChar: '店',
    group: 'member',
    tier: 'sku',
    price: { skuKey: 'shop-dashboard', priceFen: 19900 },
    stateLabel: '¥199 单独购买',
    detail: {
      scene: '接入店铺授权后持续追踪曝光、点击、转化和复购，按周复盘核心经营指标。',
      input: '店铺授权',
      output: '数据看板',
      cost: '¥199',
      writeback: '数据源',
    },
  },
  {
    key: 'weekly-review',
    label: '周复盘增强',
    desc: '自动汇总执行、数据和下一周军令',
    iconChar: '复',
    group: 'member',
    tier: 'member',
    price: { planRequired: true },
    stateLabel: '会员解锁',
    detail: {
      scene: '自动汇总本周执行、数据和复盘信号，生成下一周军令建议。',
      input: '本周执行',
      output: '周复盘',
      cost: '会员',
      writeback: '报告库',
    },
  },
];

/** 目录索引（catalog order），用于 sortOrder 未设时的稳定排序。 */
export const MODULE_INDEX: Map<string, number> = new Map(MODULES.map((m, i) => [m.key, i]));

/** 按 key 取目录条目（未知 key → undefined，路由据此 404）。 */
export function getModule(key: string): ModuleCatalogItem | undefined {
  return MODULES.find((m) => m.key === key);
}
