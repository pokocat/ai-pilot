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
//   增长   → 谁带来的人、链路长什么样、代理怎么结账（邀请关系 / 邀请链 / 代理分销 / 邀请增长）
//   智能体 → 内容调教（顾问 / 技能 / 知识 / 检索）
//   观测   → 只读的「发生过什么」（调用诊断 / 内容审核 / 审计日志）
//   商品   → 卖什么（套餐 / 单次付费 / 生态工具）
//   配置   → 平台级可写项（模型 / 开关 / 基准 / 内容池 / 账户）
//
// 历史教训：初版把「模型配置」放进「稳定性」，理由是端点池冷却算健康信号——但那是次要属性，
// 该页主体是写操作（换模型 / 填 key / 配单价 / 池权重 / 嵌入重排）。把唯一的写屏塞进三个
// 只读观测屏里，正是运营找不到东西的根因。同时初版「配置」堆到 8 项（商品+开关+内容+权限
// 混装），已顶到本文件下方与 DESIGN.md 都写着的「超 8 项就拆组」上限。故按看/改重排为 7 组。
//
// 2026-09-02 加第 8 组「增长」：邀请体系原来只有一页只读的「邀请增长」寄在「经营」组里，
// 而本轮补齐的是**运营面**——查关系账本、看一个人的上下游链路、登记代理与结算佣金，三页里
// 两页带写操作。按「主导动词决定归属」，它们既不属于只读的「经营」，也不属于平台级的「配置」
// （代理与佣金是业务对象，不是平台参数），故另立一组，并把只读的「邀请增长」一并搬进来——
// 运营查邀请的动线本来就该收在一处。搬完「经营」回到 4 项，「增长」4 项，两组都在 8 项以内。

/** 32 个目的地的稳定 key，同时是 hash 路由的第一段（`#/payments`）。改名会断已分享的链接。 */
export type SectionKey =
  | 'home' | 'users' | 'usage' | 'payments' | 'funnel' | 'tokens' | 'sessions' | 'trace' | 'agent'
  | 'skilllib' | 'knowledge' | 'retrieval' | 'audit' | 'moderation' | 'model' | 'say'
  | 'form' | 'plan' | 'sku' | 'eco' | 'benchmark' | 'account' | 'flags' | 'creative' | 'wence'
  | 'referral' | 'invites' | 'chain' | 'distribution' | 'products' | 'clone' | 'clipops';

/** 与服务端 services/products.ts 的 PRODUCT 同一套取值。 */
export type ProductCode = 'junshi' | 'quickreel';
/** 后台当前的产品视角。`all` = 跨产品总览。 */
export type ProductScope = 'all' | ProductCode;

export const PRODUCT_LABEL: Record<string, string> = {
  junshi: '军师',
  quickreel: '爱速拍',
  unattributed: '未归属',
};
export const productLabel = (code: string): string => PRODUCT_LABEL[code] ?? code;

export type GroupKey = 'today' | 'people' | 'revenue' | 'growth' | 'studio' | 'observe' | 'catalog' | 'settings';

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
  /**
   * 这屏属于哪些产品。**省略 = 公共面**，切到哪个产品视角都看得见。
   *
   * 默认公共是故意的：标错成「某产品专属」会把一屏从别人眼前藏掉，
   * 而漏标只是少过滤一屏。两种错的代价不对称，所以拿不准就别标。
   *
   * 这只是**视图过滤**，不是权限。谁能看哪个产品由服务端的 requireProductAccess 决定，
   * 前端切视角改不了任何一次请求的鉴权结果。
   */
  products?: ProductCode[];
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
  // 组名保持 2 字：移动底栏 8 组 flex 均分，375px / 8 ≈ 46px 一格，3 字就会挤（见 DESIGN.md）。
  { key: 'growth', label: '增长', icon: 'target' },
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
  { key: 'funnel', products: ['junshi'], label: '处方漏斗', hint: '处方六态转化与开通来源归因', icon: 'target', group: 'revenue', aliases: ['转化', '漏斗', 'funnel', '处方', '归因'] },
  { key: 'usage', label: '钻石消耗', hint: '权益点发放与消耗汇总', icon: 'crown', group: 'revenue', aliases: ['权益点', '钻石', '积分', 'credit', '消耗'] },
  { key: 'tokens', label: 'Token 成本', hint: '按模型 / 用户看 token 与真实成本', icon: 'trend', group: 'revenue', aliases: ['成本', 'token', '用量', '模型成本'] },
  // 爱速拍的钱在哪卡住了。与同组「订单」同形制：主体是只读的账，外加一个落审计的修复动作，
  // 所以归「经营」而不是「配置」。放在「产品」前面 —— 值班时先看有没有钱悬着，再看分产品的账。
  { key: 'clipops', products: ['quickreel'], label: '出片对账', hint: '悬挂的钻石 · 卡住的出片单 · 向上游查单', icon: 'doc', group: 'revenue', aliases: ['出片', '对账', '卡单', '悬挂', '退款', '结算', 'hold', 'clip', '爱速拍', '视频', '任务'] },
  // 多产品：后台是一个、按产品分区。这一屏是那条分区键（productCode）的落地面 ——
  // 分产品的账 + 谁能管哪个产品。归「经营」而不是「商品」：它回答「哪个产品在挣钱」，
  // 不是「卖什么」；爱速拍自己的可写面（克隆定价）在「配置 · 功能开关」里。
  { key: 'products', label: '产品', hint: '分产品的钻石账 · 运营的产品授权', icon: 'grid', group: 'revenue', aliases: ['产品', '爱速拍', '军师', '分产品', '归属', '授权', 'product', 'quickreel', 'junshi'] },

  // —— 增长（邀请体系的运营面 + 只读分析） ——
  // 顺序即动线：先查一条关系（谁邀了谁）→ 再看一个人的整条链（上溯 + 团队 + 下钻）→
  // 再管代理与结算 → 最后才是全局分析图。把只读的「邀请增长」放最后，因为它回答的是
  // 「整体长什么样」，值班时用得最少。
  { key: 'invites', products: ['junshi'], label: '邀请关系', hint: '关系账本与归因日志，可补绑尚无推荐人的用户', icon: 'user', group: 'growth', aliases: ['邀请', '关系', '账本', '归因', '邀请码', '补绑', '绑定', '推荐人', '被邀人', 'invite', 'referral', '拉新'] },
  { key: 'chain', products: ['junshi'], label: '邀请链', hint: '以人为中心：上溯到根、三级团队统计与下钻', icon: 'layers', group: 'growth', aliases: ['链', '关系链', '上级', '下级', '上溯', '下钻', '团队', '直邀', '祖先', 'chain', 'upline', 'downline'] },
  { key: 'distribution', products: ['junshi'], label: '代理分销', hint: '代理名册 / 分销比例 / 佣金流水 / 结算单', icon: 'crown', group: 'growth', aliases: ['代理', '分销', '渠道', '佣金', '提成', '计提', '结算', '结算单', '打款', '凭证', '等级', '比例', '追回', '冻结期', 'distribution', 'commission', 'settlement'] },
  { key: 'referral', products: ['junshi'], label: '邀请增长', hint: '本体 Schema / 邀请关系树 / IP 风控关联（只读）', icon: 'target', group: 'growth', aliases: ['邀请', '裂变', '关系链', '推荐', '风控', '邀请码', '邀请树', 'referral', 'invite', '拉新', '刷号', 'ip'] },

  // —— 智能体 ——
  { key: 'agent', products: ['junshi'], label: '顾问', hint: '上下架、定价、提示词调教与版本发布', icon: 'agent', group: 'studio', aliases: ['智能体', 'agent', '提示词', 'prompt', '上架', '定价', '调教'] },
  { key: 'skilllib', products: ['junshi'], label: '技能库', hint: '内置技能 + 自建 HTTP 工具', icon: 'layers', group: 'studio', aliases: ['工具', 'tool', 'skill', 'http'] },
  { key: 'knowledge', products: ['junshi'], label: '知识库', hint: '全局知识切片与重嵌', icon: 'doc', group: 'studio', aliases: ['知识', '文档', 'rag', 'embedding', '重嵌'] },
  { key: 'retrieval', products: ['junshi'], label: '检索调试', hint: '模拟一次召回，看命中了什么', icon: 'target', group: 'studio', aliases: ['召回', '检索', 'retrieval', 'debug', '命中'] },

  // —— 观测（只读：发生过什么） ——
  { key: 'sessions', products: ['junshi'], label: '会话工作台', hint: '跨用户检索消息、生成任务与关联调用', icon: 'chat', group: 'observe', aliases: ['会话', '对话', '消息', 'session', 'conversation', '生成任务', '客服排查'] },
  { key: 'trace', label: '调用诊断', hint: '每次 LLM 调用的耗时 / 状态 / 报错', icon: 'insight', group: 'observe', aliases: ['trace', '报错', '失败', '延迟', '诊断', 'llm', '稳定性'] },
  { key: 'moderation', label: '内容审核', hint: '输入输出审核拦截记录', icon: 'shield', group: 'observe', aliases: ['审核', '拦截', '合规', 'moderation'] },
  { key: 'audit', label: '审计日志', hint: '用户 API 与后台操作留痕', icon: 'clock', group: 'observe', aliases: ['日志', 'audit', '留痕', '问责', 'log'] },

  // —— 商品（卖什么） ——
  { key: 'plan', label: '套餐', hint: '订阅档位价格与权益', icon: 'layers', group: 'catalog', aliases: ['订阅', 'plan', '定价', '档位'] },
  { key: 'sku', label: '单次付费', hint: '单次付费商品改价与启停', icon: 'layers', group: 'catalog', aliases: ['sku', '商品', '单次', '改价'] },
  // 爱速拍唯一的产品专属可写面。原来它是「配置 · 功能开关」页尾的第三段 ——
  // 军师的合规降级开关、告警阈值、飞书 webhook 下面，突然接四个数字人训练单价。
  // 那正是「两个产品混在一起」最具体的一处：爱速拍的运营改个价，得先滚过军师一整页开关。
  //
  // 归「商品」而不是「配置」：整页只回答一件事 —— **这个能力卖多少**。
  // 与同组的「单次付费」是同一个动词作用在同一类对象上（给用户要买的东西定价）。
  // 「创作任务」里也有钻石单价却归了配置，那是因为那页主体是开关 / 供应商 key / 任务台，
  // 定价只是其中一段；这页只有定价。
  //
  // 当初不单开一项的理由是「配置组已 8 项，顶到 DESIGN.md 的拆组上限」——
  // 挪到商品组之后这条不再是问题（配置仍 8 项，商品 4 项）。加了产品视角后规则也要重述：
  // 要守的是**每个视角下**一组不超 8 项，不是所有视角叠加后的总数（见 nav.test.ts）。
  { key: 'clone', products: ['quickreel'], label: '克隆定价', hint: '数字人形象与声音的训练单价（钻石）', icon: 'crown', group: 'catalog', aliases: ['克隆', '克隆定价', '数字人', '形象', '声音', '音色', '训练价格', '钻石单价', '爱速拍', 'clone', 'pricing', 'avatar', 'voice'] },
  { key: 'eco', products: ['junshi'], label: '生态工具', hint: '可开方的外部工具注册表', icon: 'spark', group: 'catalog', aliases: ['生态', '外部工具', 'eco', '开方'] },

  // —— 配置（平台级可写项） ——
  // 模型配置归这里而不是「观测」：该页主体是写操作（换模型 / key / 单价 / 池权重 / 嵌入重排）。
  { key: 'model', label: '模型配置', hint: '切换模型、端点池分流与探活', icon: 'insight', group: 'settings', aliases: ['大模型', 'model', '端点', '池', 'api key', '切换', '嵌入', '重排'] },
  { key: 'flags', label: '功能开关', hint: '合规一键降级、数值配置与告警阈值', icon: 'shield', group: 'settings', aliases: ['开关', 'flag', '降级', '合规', '灰度', '告警', '阈值', '飞书', 'webhook'] },
  // 海报成品图归「配置」而不是「观测」：本页主体是写操作（功能开关 / 改单价 / 填供应商 key / 模板启停），
  // 任务台只是这套配置的验收面（同「模型配置」——端点冷却是次要属性，不足以把唯一写屏塞进只读组）。
  { key: 'creative', products: ['junshi'], label: '创作任务', hint: '海报成品图开关、单价、图片供应商与任务台', icon: 'image', group: 'settings', aliases: ['海报', '成品图', '出图', '创作', 'canvas', 'canvas_design', 'poster', '供应商', '图片', '任务台', '重试', '钻石单价'] },
  { key: 'benchmark', products: ['junshi'], label: '行业基准', hint: '行业指标分位值维护与 CSV 导入', icon: 'trend', group: 'settings', aliases: ['基准', 'benchmark', '指标', 'csv', '分位'] },
  { key: 'say', products: ['junshi'], label: '每日献策', hint: '每日 08:00 推送的献策池', icon: 'spark', group: 'settings', aliases: ['献策', '推送', 'saying', '每日'] },
  // 问策入口与「每日献策」同类：都是运营维护的**内容池**，故归「配置」而不是「智能体」——
  // 池里存的是固定文案，不参与提示词调教，也没有版本发布；另带一个灰度开关（平台级可写项）。
  // 单独成页而不塞进 settings.tsx 的开关段：两个池 + 权重编辑 + 用法说明，塞进去会把开关列表挤没。
  { key: 'wence', products: ['junshi'], label: '问策入口', hint: '提示问题池 / 进场主动消息池 / 改版灰度权重', icon: 'chat', group: 'settings', aliases: ['问策', 'wence', '提示词', '提示问题', '主动消息', '开场白', 'proactive', 'hint', 'chips', '灰度', '实验', 'ab', 'a/b', '入口'] },
  { key: 'form', products: ['junshi'], label: '问卷', hint: '开局问卷题目（只读）', icon: 'doc', group: 'settings', aliases: ['问卷', 'survey', '题目'] },
  { key: 'account', label: '运营账户', hint: '新增运营、按 agent 授权、停用', icon: 'user', group: 'settings', ownerOnly: true, aliases: ['账号', '权限', 'account', '运营', '密码'] },
];

const BY_KEY = new Map(NAV_SECTIONS.map((s) => [s.key, s]));

export function findSection(key: string): NavSection | undefined {
  return BY_KEY.get(key as SectionKey);
}

/** 这屏在某个产品视角下看不看得见。无 products = 公共面，永远可见。 */
export function inScope(s: NavSection, scope: ProductScope): boolean {
  return scope === 'all' || !s.products || s.products.includes(scope);
}

/** 某组下的可见分区（按角色 + 产品视角过滤）。 */
export function sectionsOf(group: GroupKey, isOwner: boolean, scope: ProductScope = 'all'): NavSection[] {
  return NAV_SECTIONS.filter((s) => s.group === group && (!s.ownerOnly || isOwner) && inScope(s, scope));
}

/** 可见分组（组内一项都不剩就整组隐藏 —— 角色过滤和产品视角都可能把一组清空）。 */
export function visibleGroups(isOwner: boolean, scope: ProductScope = 'all'): NavGroup[] {
  return NAV_GROUPS.filter((g) => sectionsOf(g.key, isOwner, scope).length > 0);
}

/**
 * 可选的产品视角。
 *
 * 只被授权一个产品的运营不给「全部」和别人的产品 —— 给了也是摆设：
 * 切过去每一屏都会 403，看起来像后台坏了。超管拿全部。
 * 再说一遍：这是**视图**，不是权限；服务端该拦的照拦。
 */
export function scopeOptions(accessible: string[], isOwner: boolean): ProductScope[] {
  const mine = accessible.filter((c): c is ProductCode => c === 'junshi' || c === 'quickreel');
  if (isOwner || mine.length > 1) return ['all', ...mine];
  return mine.length === 1 ? mine : ['all'];
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
