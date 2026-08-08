// 运营后台导航模型（SSOT）——按「运营做什么事」分组，而不是按后端模块平铺。
//
// 改版背景：旧版把 22 个目的地平铺进一条 56px 宽、横向滚动的底部 tab 条，运营找「行业基准」
// 要横滑到第 22 格，且桌面端整块视口被浪费。现在收敛成 6 个运营场景组，组内再分区，
// 组数固定 → 底栏不再横滚；组内分区走页头 segmented，且每个 section 都有 hash 路由可直达。
//
// 分组依据是真实值班动线，且守一条可自证的原则：**只读的归观测，可写的归配置**。
//   今日   → 上班第一眼：待处理 + 概览
//   用户   → 客服排查主战场（找人 → 看额度/订单 → 处置）
//   经营   → 对账与转化，只读（订单 / 漏斗 / 钻石消耗 / Token 成本）
//   智能体 → 内容调教（顾问 / 技能 / 知识 / 检索）
//   观测   → 只读的「发生过什么」（调用诊断 / 内容审核 / 审计日志）
//   商品   → 卖什么（套餐 / 单次付费 / 生态工具）
//   配置   → 平台级可写项（模型 / 开关 / 基准 / 内容池 / 账户）
//
// 历史教训：初版把「模型配置」放进「稳定性」，理由是端点池冷却算健康信号——但那是次要属性，
// 该页主体是写操作（换模型 / 填 key / 配单价 / 池权重 / 嵌入重排）。把唯一的写屏塞进三个
// 只读观测屏里，正是运营找不到东西的根因。同时初版「配置」堆到 8 项（商品+开关+内容+权限
// 混装），已顶到本文件下方与 DESIGN.md 都写着的「超 8 项就拆组」上限。故按看/改重排为 7 组。

/** 24 个目的地的稳定 key，同时是 hash 路由的第一段（`#/payments`）。改名会断已分享的链接。 */
export type SectionKey =
  | 'home' | 'users' | 'usage' | 'payments' | 'funnel' | 'tokens' | 'trace' | 'agent'
  | 'skilllib' | 'knowledge' | 'retrieval' | 'audit' | 'moderation' | 'model' | 'say'
  | 'form' | 'plan' | 'sku' | 'eco' | 'benchmark' | 'account' | 'flags' | 'creative' | 'wence';

export type GroupKey = 'today' | 'people' | 'revenue' | 'studio' | 'observe' | 'catalog' | 'settings';

export interface NavSection {
  key: SectionKey;
  /** 页头与导航里的短标签 */
  label: string;
  /** 页头副标题：一句话说明这屏能干什么（运营不必猜） */
  hint: string;
  icon: string;
  group: GroupKey;
  /** 仅 owner/master 可见 */
  ownerOnly?: boolean;
  /** 命令面板搜索用的别名（运营嘴里的叫法、英文名、同义词） */
  aliases?: string[];
}

export interface NavGroup {
  key: GroupKey;
  label: string;
  icon: string;
}

// 组图标 = 该组「头牌分区」的图标，读起来像「这组主要干这个」。
export const NAV_GROUPS: NavGroup[] = [
  { key: 'today', label: '今日', icon: 'chart' },
  { key: 'people', label: '用户', icon: 'user' },
  { key: 'revenue', label: '经营', icon: 'crown' },
  { key: 'studio', label: '智能体', icon: 'agent' },
  { key: 'observe', label: '观测', icon: 'insight' },
  { key: 'catalog', label: '商品', icon: 'layers' },
  { key: 'settings', label: '配置', icon: 'shield' },
];

export const NAV_SECTIONS: NavSection[] = [
  // —— 今日 ——
  { key: 'home', label: '概览', hint: '待处理事项 + 今日经营数据', icon: 'chart', group: 'today', aliases: ['首页', '待处理', 'dashboard', 'overview', '值班'] },

  // —— 用户 ——
  { key: 'users', label: '用户', hint: '按姓名 / 手机号找人，查额度订单并处置', icon: 'user', group: 'people', aliases: ['会员', '客户', '找人', 'user', '手机号', '客服', '排查'] },

  // —— 经营 ——
  { key: 'payments', label: '订单', hint: '实收 / 卡单查单补账 / 退款 / 导出', icon: 'doc', group: 'revenue', aliases: ['支付', '收入', '卡单', '退款', '对账', 'payment', '导出'] },
  { key: 'funnel', label: '处方漏斗', hint: '处方六态转化与开通来源归因', icon: 'target', group: 'revenue', aliases: ['转化', '漏斗', 'funnel', '处方', '归因'] },
  { key: 'usage', label: '钻石消耗', hint: '权益点发放与消耗汇总', icon: 'crown', group: 'revenue', aliases: ['权益点', '钻石', '积分', 'credit', '消耗'] },
  { key: 'tokens', label: 'Token 成本', hint: '按模型 / 用户看 token 与真实成本', icon: 'trend', group: 'revenue', aliases: ['成本', 'token', '用量', '模型成本'] },

  // —— 智能体 ——
  { key: 'agent', label: '顾问', hint: '上下架、定价、提示词调教与版本发布', icon: 'agent', group: 'studio', aliases: ['智能体', 'agent', '提示词', 'prompt', '上架', '定价', '调教'] },
  { key: 'skilllib', label: '技能库', hint: '内置技能 + 自建 HTTP 工具', icon: 'layers', group: 'studio', aliases: ['工具', 'tool', 'skill', 'http'] },
  { key: 'knowledge', label: '知识库', hint: '全局知识切片与重嵌', icon: 'doc', group: 'studio', aliases: ['知识', '文档', 'rag', 'embedding', '重嵌'] },
  { key: 'retrieval', label: '检索调试', hint: '模拟一次召回，看命中了什么', icon: 'target', group: 'studio', aliases: ['召回', '检索', 'retrieval', 'debug', '命中'] },

  // —— 观测（只读：发生过什么） ——
  { key: 'trace', label: '调用诊断', hint: '每次 LLM 调用的耗时 / 状态 / 报错', icon: 'insight', group: 'observe', aliases: ['trace', '报错', '失败', '延迟', '诊断', 'llm', '稳定性'] },
  { key: 'moderation', label: '内容审核', hint: '输入输出审核拦截记录', icon: 'shield', group: 'observe', aliases: ['审核', '拦截', '合规', 'moderation'] },
  { key: 'audit', label: '审计日志', hint: '用户 API 与后台操作留痕', icon: 'clock', group: 'observe', aliases: ['日志', 'audit', '留痕', '问责', 'log'] },

  // —— 商品（卖什么） ——
  { key: 'plan', label: '套餐', hint: '订阅档位价格与权益', icon: 'layers', group: 'catalog', aliases: ['订阅', 'plan', '定价', '档位'] },
  { key: 'sku', label: '单次付费', hint: '单次付费商品改价与启停', icon: 'layers', group: 'catalog', aliases: ['sku', '商品', '单次', '改价'] },
  { key: 'eco', label: '生态工具', hint: '可开方的外部工具注册表', icon: 'spark', group: 'catalog', aliases: ['生态', '外部工具', 'eco', '开方'] },

  // —— 配置（平台级可写项） ——
  // 模型配置归这里而不是「观测」：该页主体是写操作（换模型 / key / 单价 / 池权重 / 嵌入重排）。
  { key: 'model', label: '模型配置', hint: '切换模型、端点池分流与探活', icon: 'insight', group: 'settings', aliases: ['大模型', 'model', '端点', '池', 'api key', '切换', '嵌入', '重排'] },
  { key: 'flags', label: '功能开关', hint: '合规一键降级与数值配置', icon: 'shield', group: 'settings', aliases: ['开关', 'flag', '降级', '合规', '灰度', '告警', '阈值'] },
  // 海报成品图归「配置」而不是「观测」：本页主体是写操作（功能开关 / 改单价 / 填供应商 key / 模板启停），
  // 任务台只是这套配置的验收面（同「模型配置」——端点冷却是次要属性，不足以把唯一写屏塞进只读组）。
  { key: 'creative', label: '创作任务', hint: '海报成品图开关、单价、图片供应商与任务台', icon: 'image', group: 'settings', aliases: ['海报', '成品图', '出图', '创作', 'canvas', 'canvas_design', 'poster', '供应商', '图片', '任务台', '重试', '钻石单价'] },
  { key: 'benchmark', label: '行业基准', hint: '行业指标分位值维护与 CSV 导入', icon: 'trend', group: 'settings', aliases: ['基准', 'benchmark', '指标', 'csv', '分位'] },
  { key: 'say', label: '每日献策', hint: '每日 08:00 推送的献策池', icon: 'spark', group: 'settings', aliases: ['献策', '推送', 'saying', '每日'] },
  // 问策入口与「每日献策」同类：都是运营维护的**内容池**，故归「配置」而不是「智能体」——
  // 池里存的是固定文案，不参与提示词调教，也没有版本发布；另带一个灰度开关（平台级可写项）。
  // 单独成页而不塞进 settings.tsx 的开关段：两个池 + 权重编辑 + 用法说明，塞进去会把开关列表挤没。
  { key: 'wence', label: '问策入口', hint: '提示问题池 / 进场主动消息池 / 改版灰度权重', icon: 'chat', group: 'settings', aliases: ['问策', 'wence', '提示词', '提示问题', '主动消息', '开场白', 'proactive', 'hint', 'chips', '灰度', '实验', 'ab', 'a/b', '入口'] },
  { key: 'form', label: '问卷', hint: '开局问卷题目（只读）', icon: 'doc', group: 'settings', aliases: ['问卷', 'survey', '题目'] },
  { key: 'account', label: '运营账户', hint: '新增运营、按 agent 授权、停用', icon: 'user', group: 'settings', ownerOnly: true, aliases: ['账号', '权限', 'account', '运营', '密码'] },
];

const BY_KEY = new Map(NAV_SECTIONS.map((s) => [s.key, s]));

export function findSection(key: string): NavSection | undefined {
  return BY_KEY.get(key as SectionKey);
}

/** 某组下的可见分区（按当前登录者角色过滤）。 */
export function sectionsOf(group: GroupKey, isOwner: boolean): NavSection[] {
  return NAV_SECTIONS.filter((s) => s.group === group && (!s.ownerOnly || isOwner));
}

/** 可见分组（组内全部 ownerOnly 且非 owner 时整组隐藏）。 */
export function visibleGroups(isOwner: boolean): NavGroup[] {
  return NAV_GROUPS.filter((g) => sectionsOf(g.key, isOwner).length > 0);
}

/** 命令面板打分：命中 label 前缀 > label 包含 > 别名 > hint。返回 null 表示不匹配。 */
export function scoreSection(s: NavSection, q: string): number | null {
  const query = q.trim().toLowerCase();
  if (!query) return 0;
  const label = s.label.toLowerCase();
  if (label.startsWith(query)) return 100;
  if (label.includes(query)) return 80;
  if (s.key.toLowerCase().startsWith(query)) return 70;
  if (s.aliases?.some((a) => a.toLowerCase().startsWith(query))) return 60;
  if (s.aliases?.some((a) => a.toLowerCase().includes(query))) return 40;
  if (s.hint.toLowerCase().includes(query)) return 20;
  return null;
}
