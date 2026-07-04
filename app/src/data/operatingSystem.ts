// 军师操作系统 · 静态目录（模块市场 / Skill 市场 / 知识分类 / 数据源 / 对话引导）。
// 这些是产品能力目录与引导态文案，不是用户业务数据；用户真实数据一律走 api（会话/报告/知识/项目/档案）。
// 费用展示遵循全局口径：💎xN（一次启用）、💎xN/次（按次产出），不写「消耗 N 点」等促销口吻。

export type ModuleTier = 'free' | 'power' | 'plan' | 'single';

export interface ModuleItem {
  id: string;
  icon: string;
  category: string;
  title: string;
  desc: string;
  status: string;      // 已启用 / 基础可用 / 可添加 / 待绑定
  tier: ModuleTier;
  price: string;       // 基础版 / 💎xN / 方案权益 / 💎xN/次
  depth: string;       // 深度版说明
  placement: string;   // 出现在哪些页面
  agentKey?: string;   // 点击后由哪位军师承接
  prompt?: string;     // 承接的对话开场
}

export const MODULE_MARKET: ModuleItem[] = [
  {
    id: 'strategic-goals',
    icon: 'target',
    category: '战略目标',
    title: '3-5 年目标体系',
    desc: '把长期愿景拆成年度目标、季度战役、月度里程碑和本周动作。',
    status: '基础可用',
    tier: 'power',
    price: '💎x80',
    depth: '深度推演按次产出',
    placement: '战局 / 执行',
    agentKey: 'strat',
    prompt: '帮我把 3-5 年目标拆成年度目标、季度战役、月度里程碑和本周动作。',
  },
  {
    id: 'daily-command',
    icon: 'check',
    category: '执行拆解',
    title: '每日军令与周计划',
    desc: '认可方案自动拆解为每日任务、提醒、复盘与数据记录。',
    status: '已启用',
    tier: 'free',
    price: '基础版',
    depth: '自动排程属方案权益',
    placement: '执行',
    agentKey: 'general',
    prompt: '基于我们最近认可的方案，生成今天的军令和本周计划。',
  },
  {
    id: 'ip-os',
    icon: 'image',
    category: 'IP 增长',
    title: '创始人 IP 打造',
    desc: '定位、内容日历、选题库、AI 创作与发布复盘一体化。',
    status: '基础可用',
    tier: 'power',
    price: '💎x60',
    depth: 'AI 创作发布按次产出',
    placement: '执行 / 智库',
    agentKey: 'ip',
    prompt: '帮我做一份创始人个人 IP 打造方案，从定位到选题库和发布日历。',
  },
  {
    id: 'study-map',
    icon: 'crown',
    category: '个人成长',
    title: '年度学习与读书计划',
    desc: '围绕事业阶段生成学习主题、书单、训练任务和认知复盘。',
    status: '可添加',
    tier: 'single',
    price: '💎x39/次',
    depth: '细化到每日训练需开通',
    placement: '执行 / 我的',
    agentKey: 'general',
    prompt: '围绕我当前的事业阶段，帮我生成一份年度学习与读书计划。',
  },
  {
    id: 'enterprise-growth',
    icon: 'trend',
    category: '企业经营',
    title: '企业增长执行图',
    desc: '围绕获客、转化、复购、客单价和组织协作生成增长动作。',
    status: '基础可用',
    tier: 'plan',
    price: '方案权益',
    depth: '绑定经营数据后增强',
    placement: '战局 / 执行',
    agentKey: 'growth',
    prompt: '帮我生成一份企业增长执行图，覆盖获客、转化、复购和客单价。',
  },
  {
    id: 'org-management',
    icon: 'layers',
    category: '组织管理',
    title: '组织与人才盘点',
    desc: '识别组织瓶颈、关键岗位、协作机制和管理节奏。',
    status: '可添加',
    tier: 'power',
    price: '💎x90',
    depth: '深度组织诊断按次产出',
    placement: '战局',
    agentKey: 'org',
    prompt: '帮我做一次组织与人才盘点，找出组织瓶颈和关键岗位缺口。',
  },
  {
    id: 'knowledge-base',
    icon: 'doc',
    category: '知识资产',
    title: '客户知识库',
    desc: '上传资料后由军师自动参考，判断更贴近真实业务。',
    status: '已启用',
    tier: 'free',
    price: '基础版',
    depth: '多资料交叉分析按次产出',
    placement: '智库',
  },
  {
    id: 'data-bindings',
    icon: 'attach',
    category: '数据增强',
    title: '数据源绑定',
    desc: '绑定企业、店铺、内容账号、财务表和 CRM，让诊断从事实出发。',
    status: '待绑定',
    tier: 'single',
    price: '按数据源',
    depth: '部分数据源需单独开通',
    placement: '智库 / 我的',
  },
];

export interface SkillItem {
  id: string;
  icon: string;
  title: string;
  desc: string;
  status: string;
  tier: ModuleTier;
  cost: string;
  prompt: string;
}

export const SKILL_MARKET: SkillItem[] = [
  { id: 'mino', icon: 'flow', title: '三势初判', desc: '天势、市势、人势合参，先定局再落子。', status: '默认启用', tier: 'free', cost: '基础诊断', prompt: '用三势判断（天势、市势、人势）帮我重新看一遍当前局势。' },
  { id: 'contradiction', icon: 'shield', title: '矛盾初筛', desc: '识别主要矛盾、次要矛盾和阶段打法。', status: '默认启用', tier: 'free', cost: '基础诊断', prompt: '帮我做一次矛盾分析：现在的主要矛盾是什么，阶段打法应该是什么？' },
  { id: 'mckinsey', icon: 'grid', title: '结构化拆解', desc: 'MECE 拆问题、定指标、排优先级。', status: '基础可用', tier: 'free', cost: '基础版', prompt: '用结构化拆解（MECE）把我当前的问题拆成指标和优先级。' },
  { id: 'trend', icon: 'spark', title: '趋势参照', desc: '用时机、变化、进退辅助做阶段判断。', status: '方案权益', tier: 'plan', cost: '方案权益', prompt: '结合当前时机和趋势，帮我判断该进攻、收缩还是等待。' },
  { id: 'founder-rhythm', icon: 'crown', title: '创始人节奏', desc: '辅助判断创始人优势、压力点和决策节奏。', status: '需补充档案', tier: 'plan', cost: '方案权益', prompt: '基于我的档案，帮我分析我的决策节奏、优势和压力点。' },
  { id: 'shop-funnel', icon: 'chart', title: '增长漏斗诊断', desc: '分析曝光、点击、转化、复购和客单价。', status: '建议绑定数据', tier: 'power', cost: '💎x80', prompt: '帮我做一次增长漏斗诊断：曝光、点击、转化、复购、客单价，问题出在哪一层？' },
  { id: 'ip-content', icon: 'pen', title: 'IP 内容引擎', desc: '从定位生成选题、脚本、发布计划和复盘。', status: '可调用', tier: 'single', cost: '💎x29/次', prompt: '调用 IP 内容引擎：从我的定位出发生成选题、脚本和发布计划。' },
  { id: 'finance-health', icon: 'lock', title: '经营财务体检', desc: '看现金流、利润结构、成本和风险边界。', status: '需上传资料', tier: 'single', cost: '💎x49/次', prompt: '帮我做一次经营财务体检，看现金流、利润结构和风险边界。' },
];

// 知识库资料分类：AI 分类文件夹的目录框架（真实份数以资料库为准，不写占位数字）。
export const KNOWLEDGE_FOLDERS = [
  { id: 'company', icon: 'doc', title: '企业档案', desc: '公司介绍、股权结构、发展历程、组织架构' },
  { id: 'founder', icon: 'user', title: '老板档案', desc: '个人目标、优势短板、精力节奏、过往决策' },
  { id: 'product', icon: 'layers', title: '产品服务', desc: '产品说明、价格体系、交付流程、客户案例' },
  { id: 'market', icon: 'target', title: '客户市场', desc: '目标客户、竞品、渠道、转化链路' },
  { id: 'finance', icon: 'chart', title: '财务经营', desc: '收入、成本、利润、现金流和预算表' },
  { id: 'content', icon: 'image', title: '内容 IP', desc: '账号定位、历史内容、爆款样本、选题库' },
  { id: 'stores', icon: 'grid', title: '店铺渠道', desc: '店铺数据、商品结构、活动记录、用户反馈' },
  { id: 'reports', icon: 'shield', title: '历史方案', desc: '军师报告、会议纪要、执行复盘和决策记录' },
];

export const DATA_BINDINGS = [
  {
    id: 'qcc',
    icon: 'shield',
    title: '企业工商数据',
    provider: '企查查类企业档案',
    status: '可开通',
    price: '单独开通',
    desc: '同步工商、股东、风险、司法、知识产权等外部事实。',
  },
  {
    id: 'shop',
    icon: 'grid',
    title: '店铺经营数据',
    provider: '淘宝 / 抖店 / 小红书店铺',
    status: '待绑定',
    price: '数据增强',
    desc: '分析流量、转化、客单价、复购、商品和活动表现。',
  },
  {
    id: 'content',
    icon: 'image',
    title: '内容账号数据',
    provider: '视频号 / 公众号 / 小红书',
    status: '待绑定',
    price: '基础可绑',
    desc: '同步内容表现、粉丝画像、发布时间和互动质量。',
  },
  {
    id: 'wechat',
    icon: 'chat',
    title: '企业微信与客户池',
    provider: '企业微信 / 私域 CRM',
    status: '可开通',
    price: '方案权益',
    desc: '辅助判断客户分层、私域活跃、转化跟进和服务节奏。',
  },
  {
    id: 'finance',
    icon: 'chart',
    title: '财务与经营表',
    provider: 'Excel / 飞书表格 / 财务系统',
    status: '上传即可',
    price: '深度分析按次产出',
    desc: '上传收入、成本、利润和现金流表，生成经营体检。',
  },
];

// 对话页「补充上下文」引导：把军师判断所需的资料、数据、模块入口带进对话。
export const CHAT_GUIDES = [
  { icon: 'upload', label: '上传资料到知识库', url: '/packages/work/knowledge/index', hint: '让军师先读懂你的公司、产品、财务和历史方案' },
  { icon: 'attach', label: '绑定店铺/账号数据', url: '/packages/work/bindings/index', hint: '让增长、IP、经营军师基于真实数据判断' },
  { icon: 'grid', label: '打开模块市场', url: '/packages/work/market/index', hint: '把认可的方案拆成可移动、可增减的模块' },
];

// 智库页「军师的方法底座」：判断背后的方法论目录（静态框架，不含用户业务结论）。
export const DOCTRINES = [
  { name: '矛盾分析', point: '抓主要矛盾', use: '所有建议先围绕你最痛的一个问题，不平均用力。' },
  { name: '结构拆解', point: 'MECE 分层', use: '把问题拆成定位、人群、产品、转化、复盘等可执行层。' },
  { name: '三势合参', point: '天势 · 市势 · 人势', use: '每个方案都判断该攻、该守、该等还是该撤。' },
  { name: '数据复盘', point: '以事实修正判断', use: '执行数据记录后，军师会更新下一轮判断和动作。' },
];

// 战局页「三势判断」方法框架：静态说明 + 发起真实判断的入口（结论必须来自对话，不预置）。
export const THREE_FORCES = [
  { key: '天势', icon: 'spark', desc: '宏观时机与行业节奏：现在适合进攻、蓄力还是等待。' },
  { key: '市势', icon: 'chart', desc: '市场与竞争格局：客户要什么、对手在做什么、缺口在哪。' },
  { key: '人势', icon: 'user', desc: '资源与组织承载力：现有人、钱、精力能撑住哪种打法。' },
];

// 社群入群三步（服务关系引导，分班与服务老师由运营侧分配后展示）。
export const COMMUNITY_STEPS = [
  ['添加服务老师', '分班完成后这里会出现服务老师微信与班级二维码。'],
  ['发送注册信息', '发送称呼和注册手机号，服务老师确认后邀请入群。'],
  ['进入班级群', '入群后接收班级任务、军师提醒和复盘通知。'],
];
