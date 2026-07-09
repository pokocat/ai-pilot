// V7-06 业务分类目录（唯一真相源）：智库三段式整理管道「AI 粗分」把每份待整理资料归到这 8 类之一。
// key 落到 KnowledgeItem.bizCategory；label 供前端文件夹网格展示；hint 是给分类模型的「提示词」，
// 也是无真实模型（mock/测试）时确定性关键词兜底的语义依据。
// 本文件只描述「目录事实」；具体归类逻辑 + 关键词兜底在 services/knowledgePipeline.ts。

export interface BizCategory {
  key: string;
  label: string;
  hint: string; // 简短提示词：这类文件夹应该装什么
}

// 8 类，顺序即文件夹默认展示顺序；末位 unknown 为「待识别」兜底类。
export const BIZ_CATEGORIES = [
  { key: 'founder', label: '老板档案', hint: '创始人本人的目标、优势、经历、个人定位与风格' },
  { key: 'company', label: '企业档案', hint: '公司介绍、组织结构、团队、产品服务、发展历程' },
  { key: 'finance', label: '财务经营', hint: '营收、成本、利润、现金流、预算、经营报表与数据' },
  { key: 'content', label: '内容IP', hint: '内容选题、脚本、文案、视频、同行参考与 IP 素材' },
  { key: 'growth', label: '增长资料', hint: '流量、线索、转化漏斗、投放、私域与增长打法' },
  { key: 'customer', label: '客户问答', hint: '客户咨询、私聊记录、问答、服务记录与转化反馈' },
  { key: 'proof', label: '案例证明', hint: '成交案例、客户评价、结果截图、证据链与信任素材' },
  { key: 'unknown', label: '待识别', hint: '命名不清或用途不明，建议人工确认后再归类' },
] as const satisfies readonly BizCategory[];

export type BizCategoryKey = (typeof BIZ_CATEGORIES)[number]['key'];

export const BIZ_CATEGORY_KEYS = BIZ_CATEGORIES.map((c) => c.key) as [BizCategoryKey, ...BizCategoryKey[]];

const BIZ_KEY_SET = new Set<string>(BIZ_CATEGORY_KEYS);

/** 是否是合法业务类目 key。 */
export function isBizCategory(k: string | null | undefined): k is BizCategoryKey {
  return !!k && BIZ_KEY_SET.has(k);
}

/** 取类目 label（未知 key 兜底为「待识别」）。 */
export function bizCategoryLabel(key: string | null | undefined): string {
  const found = BIZ_CATEGORIES.find((c) => c.key === key);
  return found ? found.label : '待识别';
}
