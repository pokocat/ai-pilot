// 能力直达打标（Chat-First 重构 v1.3 §五）：军令文本命中创作能力关键词 → 打上对应创作 agent 的 key，
// 前端据此在军令行渲染「直达」入口（外跳配置位在 app 侧，本表不含 external 字段）。
// label 与 data/agents.ts 的创作智能体名号一致；keywords 为确定性子串匹配，首个命中即打标。

export interface Capability {
  key: string;      // 创作 agent key（与 agents.ts 一致）
  label: string;    // 名号（与 agents.ts name 一致）
  agentKey: string; // 直达的智能体 key
  keywords: string[];
}

export const CAPABILITIES: Capability[] = [
  { key: 'ip', label: '企业IP打造官', agentKey: 'ip', keywords: ['IP', '人设', '个人品牌'] },
  { key: 'promo', label: '企业宣传片导演', agentKey: 'promo', keywords: ['宣传片', '短片', '视频片', '品牌片'] },
  { key: 'poster', label: '海报设计师', agentKey: 'poster', keywords: ['海报', '主视觉', '物料'] },
  { key: 'shortvideo', label: '短视频策划', agentKey: 'shortvideo', keywords: ['短视频', '抖音', '视频号'] },
  { key: 'copy', label: '商业文案官', agentKey: 'copy', keywords: ['文案', 'slogan', '推文', '软文'] },
];

/** 军令文本 → 能力 key（首个命中即返回；未命中 null）。大小写不敏感（slogan/IP 等英文词）。 */
export function matchCapability(text: string): string | null {
  const t = text.toLowerCase();
  for (const c of CAPABILITIES) {
    if (c.keywords.some((k) => t.includes(k.toLowerCase()))) return c.key;
  }
  return null;
}
