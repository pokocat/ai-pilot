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
    desc: '方案定了，自动拆成每日任务、提醒、复盘和数据记录。',
    status: '已启用',
    tier: 'free',
    price: '基础版',
    depth: '自动排程属方案权益',
    placement: '执行',
    agentKey: 'general',
    prompt: '按我们最近定的方案，出今天的军令和本周计划。',
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
  { id: 'ip-content', icon: 'pen', title: 'IP 内容引擎', desc: '从定位生成选题、脚本、发布计划和复盘。', status: '可用', tier: 'single', cost: '💎x29/次', prompt: '用 IP 内容引擎：从我的定位出发生成选题、脚本和发布计划。' },
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
  { icon: 'upload', label: '上传资料到资料库', url: '/packages/work/knowledge/index', hint: '让军师先读懂你的公司、产品、财务和历史方案' },
  { icon: 'attach', label: '绑定店铺/账号数据', url: '/packages/work/bindings/index', hint: '让增长、IP、经营军师基于真实数据判断' },
  { icon: 'grid', label: '打开模块市场', url: '/packages/work/market/index', hint: '把定下的方案拆成能挪、能加减的模块' },
];

// 智库页「军师的方法底座」：判断背后的方法论目录（静态框架，不含用户业务结论）。
export const DOCTRINES = [
  { name: '矛盾分析', point: '抓主要矛盾', use: '所有建议先围绕你最痛的一个问题，不平均用力。' },
  { name: '结构拆解', point: 'MECE 分层', use: '把问题拆成定位、人群、产品、转化、复盘等可执行层。' },
  { name: '三势合参', point: '天势 · 市势 · 人势', use: '每个方案都判断该攻、该守、该等还是该撤。' },
  { name: '数据复盘', point: '以事实修正判断', use: '执行数据记录后，下一轮判断和动作会跟着更新。' },
];

// 战局页「三势判断」方法框架：静态说明 + 发起真实判断的入口（结论必须来自对话，不预置）。
// 市势/人势各有**独立研判开场**（不再共用同一条指令），产出以「市势研判 / 人势研判」为题；
// 存入方案库后战局卡即可反查该势方案并直接预览（match=标题/类型匹配关键词）。
export interface ForceItem {
  key: string;
  icon: string;
  desc: string;
  agentKey?: string; // 承接研判的军师（三势属核心能力，走免费的战略诊断官 strat，避免解锁墙）
  prompt?: string;   // 该势独立的研判开场
  match?: string;    // 已存方案库报告的匹配关键词（标题/类型含此词=该势的研判方案）
}
export const THREE_FORCES: ForceItem[] = [
  { key: '天势', icon: 'spark', desc: '宏观时机与行业节奏：现在适合进攻、蓄力还是等待。' },
  {
    key: '市势', icon: 'chart', desc: '市场与竞争格局：客户要什么、对手在做什么、缺口在哪。',
    agentKey: 'strat', match: '市势',
    prompt: '帮我做一次「市势研判」：只聚焦市场与竞争格局——我的客户到底要什么、主要对手在做什么、市场缺口和机会窗口在哪，最后给出在市场端该攻、该守还是该等的结论与两三条具体动作。请以「市势研判」为标题产出一份结构化方案。',
  },
  {
    key: '人势', icon: 'user', desc: '资源与组织承载力：现有人、钱、精力能撑住哪种打法。',
    agentKey: 'strat', match: '人势',
    prompt: '帮我做一次「人势研判」：只聚焦资源与组织承载力——现有的人、钱、精力和团队能撑住哪种打法，关键短板在哪、该补人还是该练兵、现在扛不扛得起扩张，最后给出结论与优先动作。请以「人势研判」为标题产出一份结构化方案。',
  },
];

// 社群入群三步（服务关系引导，分班与服务老师由运营侧分配后展示）。
export const COMMUNITY_STEPS = [
  ['添加服务老师', '分班完成后这里会出现服务老师微信与班级二维码。'],
  ['发送注册信息', '发送称呼和注册手机号，服务老师确认后邀请入群。'],
  ['进入班级群', '入群后接收班级任务、军师提醒和复盘通知。'],
];

/* ────────────── 以下三块对应新设计稿新增的三个业务面（我的页菜单 / 账户权益格入口） ──────────────
   共同口径：这三面都还没有后端建模，所以页面只写**产品口径与边界**（这些是真事实），
   一律不写用户侧的进度数字、主体数量、人脉条数和价格——那些要么来自后端，要么归运营后台。 */

// 企业服务办理（设计稿 service-record / enterpriseServiceItems）：军师诊断后触发的企业基础服务。
// 边界很重要：军师只做诊断、资料清单、路径建议和进度管理，实际办理由专业服务方承接。
export interface EnterpriseService {
  key: string;
  title: string;
  desc: string;
  trigger: string;      // 什么诊断结果会触发这项服务
  steps: string[];      // 办理路径（静态路径，不是用户当前进度）
  materials: string[];  // 需要准备的资料清单
  handoff: string;      // 服务商交接边界
  archive: string;      // 办理结果回写到哪里
}
export const ENTERPRISE_SERVICES: EnterpriseService[] = [
  {
    key: 'register', title: '注册公司',
    desc: '确认主体用途后，补齐股东、注册地址、经营范围和负责人资料。',
    trigger: '战略报告识别到需要独立主体承接新事业或新收入。',
    steps: ['诊断触发', '资料待补', '服务商报价', '办理回写'],
    materials: ['股东与出资比例', '注册地址证明', '经营范围草案', '法定代表人信息'],
    handoff: '服务老师整理资料后对接工商服务商，实际办理结果以主管机关审核为准。',
    archive: '营业执照、章程、登记信息和服务合同写入资料库的企业资产目录。',
  },
  {
    key: 'trademark', title: '商标申请',
    desc: '承接取名问策结果，先做风险初筛，再确认核心类别和防御类别。',
    trigger: '品牌名、产品名或 IP 名确定后，需要先占类别再放大传播。',
    steps: ['名称确认', '类别建议', '代理检索', '申请入云'],
    materials: ['主推品牌名', '商品 / 服务范围', '营业主体信息', '备用名称'],
    handoff: '正式检索和申请由商标代理或专业机构承接，不承诺商标一定注册成功。',
    archive: '申请号、回执、驳回复审记录和商标证书写入企业资产目录。',
  },
  {
    key: 'tax', title: '财税代账',
    desc: '公司成立或经营后，按票据量、开票需求和申报周期匹配代账方案。',
    trigger: '主体开始开票、发薪或有对公流水，需要稳定的记账与申报节奏。',
    steps: ['需求确认', '票据预估', '报价方案', '申报提醒'],
    materials: ['营业执照', '银行与发票情况', '月票据量预估', '历史收支表'],
    handoff: '记账、申报和财税意见由会计、代账机构或税务专业人员承接，不提供避税承诺。',
    archive: '代账资料、申报记录、服务合同和经营摘要写入企业资产目录。',
  },
  {
    key: 'copyright', title: '版权登记',
    desc: '脚本、传记、视觉素材、课程文档和软著先形成确权清单。',
    trigger: '内容资产开始对外分发或授权他人二创。',
    steps: ['作品归集', '权属确认', '资料提交', '证书入云'],
    materials: ['作品文件', '创作过程记录', '作者 / 权利人信息', '首次发表证明'],
    handoff: '登记路径和法律意见由专业机构或律师承接，结果以登记机关或专业意见为准。',
    archive: '登记证书、软著、授权记录和可二创范围写入企业资产目录。',
  },
  {
    key: 'contract', title: '合同授权',
    desc: '代理、经销商、二创和素材分发前，先明确授权范围和审核机制。',
    trigger: '出现代理裂变、经销商分销或素材对外授权的执行动作。',
    steps: ['场景确认', '授权边界', '合同复核', '执行回流'],
    materials: ['代理名单', '可授权素材', '禁用表达', '分发与分佣规则'],
    handoff: '合同文本和法律效力建议由律师或专业服务方复核。',
    archive: '代理合同、素材授权、二创审核记录和分发数据写入企业资产目录。',
  },
  {
    key: 'qualification', title: '行业资质',
    desc: '涉及健康、教育、食品、电商和本地生活时，先列出可能需要的资质。',
    trigger: '经营范围或销售渠道进入受监管行业。',
    steps: ['行业识别', '资质提示', '专业咨询', '证照归档'],
    materials: ['行业与产品说明', '销售渠道', '经营范围', '线下门店情况'],
    handoff: '具体资质办理和合规意见以主管机关、律师或专业服务方意见为准。',
    archive: '许可证、备案、资质提醒和有效期记录写入企业资产目录。',
  },
];

// 公司与事业架构（设计稿 architecture）：多主体经营的长期版图管理。
// 设计稿口径：这不是默认功能——总军师在诊断中识别到多主体、新事业承接和权责关系需要长期管理时才建议建立。
export const ARCHITECTURE_TRIGGERS = [
  '多个公司与事业同时推进，创始人很难持续记住各主体的真实用途。',
  '登记股权、实际权益、代持安排和职权责可能不完全一致。',
  '财税代办、账号资产、官网和品牌账号分散在不同人员手中。',
];
export const ARCHITECTURE_SCOPE = [
  ['事业与主体', '事业项目与法律主体的承接关系。'],
  ['权属与控制', '股权、实际控制、代持、董事监事与关键授权。'],
  ['财务与服务', '财务负责人、代账服务、税务状态和经营账号资产。'],
  ['筹建进度', '新公司筹建、取名、注册代办和财税服务进度。'],
];
export const ARCHITECTURE_PATHS = [
  ['整理已有公司', '证照、股权、代持、职权责、财税与账号资产逐项归位。'],
  ['筹建新公司 / 新事业', '先确认战略必要性，再决定取名、注册和财税服务。'],
];

// 人脉圈与持续记忆（设计稿 relationships / memorySourceProfile）：把每天真实发生的事变成可用的档案。
// 价格一律不写死在代码里——开通与计价走方案与权益页（运营后台是定价唯一真相源）。
export interface MemorySource {
  key: string;
  title: string;
  desc: string;
  values: [string, string][]; // 开通后产出什么
  scopes: [string, string][]; // 读取范围（授权边界）
}
export const MEMORY_SOURCES: MemorySource[] = [
  {
    key: 'wechat', title: '个人微信记忆', desc: '导入你主动选中的微信资料，先生成一版待你校对的记忆。',
    values: [['人脉档案', '关系、角色、最近互动'], ['每日日志', '事实、承诺、风险'], ['朋友圈档案', '表达、项目、身份变化'], ['战略校准', '确认后回写战局']],
    scopes: [['好友与群聊', '联系人、组织、关系来源'], ['聊天记录', '决定、承诺、项目、问题'], ['朋友圈资料', '表达、项目动态、线索'], ['附件与链接', '只整理你选中的资料']],
  },
  {
    key: 'wecom', title: '企业微信人脉', desc: '整理客户关系、承诺和跟进断点。',
    values: [['客户分层', '识别关系阶段和需求'], ['会话结论', '提取顾虑与承诺'], ['跟进提醒', '形成下一步动作'], ['成交复盘', '回写咨询和成交断点']],
    scopes: [['客户资料', '读取授权范围内的客户字段'], ['会话内容', '按企业配置和同意状态读取'], ['客户标签', '识别分层和跟进状态'], ['成交回写', '只生成复盘，不改原后台']],
  },
  {
    key: 'meeting', title: '会议记忆', desc: '整理会议结论、负责人和截止时间。',
    values: [['会议结论', '提炼决定与未决问题'], ['行动事项', '识别负责人和截止时间'], ['关系动态', '更新合作人与项目关系'], ['战略校准', '对照军令判断是否偏航']],
    scopes: [['会议信息', '主题、时间与参与成员'], ['录音与纪要', '只处理你授权的会议内容'], ['决定与待办', '提取责任人和截止日期'], ['关联案卷', '写入指定案卷，不混入其他公司']],
  },
  {
    key: 'calendar', title: '日历与任务', desc: '让计划、提醒和完成情况进入执行线。',
    values: [['日程', '识别关键会议和时间投入'], ['任务', '归集待办与截止时间'], ['兑现率', '比较计划与实际完成'], ['复盘', '生成次日优先级']],
    scopes: [['日历标题', '读取业务日程名称'], ['参与人与时间', '识别协作关系和投入'], ['任务状态', '读取完成与延期'], ['提醒', '按军令生成新的提醒建议']],
  },
  {
    key: 'moments', title: '朋友圈档案', desc: '整理表达主题、项目进展和个人品牌变化。',
    values: [['表达主题', '归纳长期观点与阶段重点'], ['项目线索', '记录发布过的产品和合作'], ['关系互动', '识别重要互动与跟进机会'], ['IP 资产', '沉淀可复用的观点和故事']],
    scopes: [['朋友圈正文', '整理文字内容与发布时间'], ['图片说明', '只识别你主动导入的图片'], ['互动备注', '由你选择是否提供'], ['IP 档案', '确认后写入个人品牌资料']],
  },
];
