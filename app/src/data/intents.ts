// 产出意图 → 智能体 key（对齐原型 KEY2AGENT），用于首页自由文本/快捷入口路由。
export const KEY2AGENT: Record<string, string> = {
  战略体检: 'strat',
  增长方案: 'growth',
  融资准备: 'fund',
  竞品洞察: 'intel',
  商业模式画布: 'model',
  组织优化建议: 'org',
  营销内容: 'brand',
  经营分析: 'ops',
  企业IP打造: 'ip',
  企业宣传片: 'promo',
  海报设计: 'poster',
  短视频策划: 'shortvideo',
  营销文案: 'copy',
};

export function agentForText(text: string): string {
  return KEY2AGENT[text] ?? 'general';
}
