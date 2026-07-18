// V7-07 数据源目录（唯一真相源）：6 基础 + 2 高级，共 8 类。
// 文案/字段对齐设计规格 §7.1（label/desc）/§7.3（高级 desc）/§7.4 dataAuthProfile（scope 读取范围四项）。
// 本文件只描述「目录事实」；用户侧展示状态由 services/dataSources.ts 合并 UserDataSource 行派生。

export type DataSourceTier = 'basic' | 'advanced';

export interface DataSourceCatalogItem {
  key: string;
  label: string;
  desc: string;
  icon: string; // 单个汉字
  scope: string[]; // 读取范围 chips（4 项）
  tier: DataSourceTier;
}

export const DATA_SOURCES: DataSourceCatalogItem[] = [
  // —— 基础 6 类（上传即可接入）——
  {
    key: 'content-account',
    label: '内容账号数据',
    desc: '小红书 / 抖音 / 视频号 / 公众号：阅读、互动、私信',
    icon: '内',
    scope: ['阅读·播放', '互动·评论', '私信关键词', '内容选题表现'],
    tier: 'basic',
  },
  {
    key: 'private',
    label: '客户与私域数据',
    desc: '企微、微信群、私聊记录、客户标签、咨询记录',
    icon: '客',
    scope: ['客户标签', '跟进状态', '咨询关键词', '成交回写'],
    tier: 'basic',
  },
  {
    key: 'shop',
    label: '店铺经营数据',
    desc: '曝光、点击、成交、复购、退款、客单价',
    icon: '店',
    scope: ['曝光·点击', '成交·退款', '复购·客单价', '投放花费'],
    tier: 'basic',
  },
  {
    key: 'funnel',
    label: '成交漏斗数据',
    desc: '线索、咨询、报价、成交、流失原因、复购',
    icon: '漏',
    scope: ['线索数', '咨询数', '报价数', '成交·流失原因'],
    tier: 'basic',
  },
  {
    key: 'finance',
    label: '财务经营数据',
    desc: '营收、成本、利润、预算、投放花费、现金流',
    icon: '财',
    scope: ['营收', '成本', '利润', '预算·现金流'],
    tier: 'basic',
  },
  {
    key: 'service',
    label: '服务交付数据',
    desc: '服务进度、客户反馈、好评截图、售后问题、案例结果',
    icon: '服',
    scope: ['服务进度', '客户反馈', '案例结果', '售后问题'],
    tier: 'basic',
  },
  // —— 高级 2 类（需后台授权，v1 仅登记预约，见 V7-07 D-6）——
  {
    key: 'crm',
    label: '企业微信 / CRM 授权',
    desc: '长期追踪客户标签、跟进状态和成交回写。',
    icon: '企',
    scope: ['客户标签', '跟进状态', '咨询关键词', '成交回写'],
    tier: 'advanced',
  },
  {
    key: 'ads',
    label: '广告与店铺后台授权',
    desc: '持续读取投放、店铺和订单变化，自动刷新复盘。',
    icon: '广',
    scope: ['曝光·点击', '成交·退款', '复购·客单价', '投放花费'],
    tier: 'advanced',
  },
];

/** 目录里是否存在该 sourceKey（路由校验用）。 */
export function isKnownDataSource(key: string): boolean {
  return DATA_SOURCES.some((s) => s.key === key);
}
