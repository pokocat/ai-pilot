import Taro from '@tarojs/taro';
import type {
  Agent, Me, LoginResult, SurveyQuestion, Profile, TodaySaying,
  SessionItem, SessionDetail, SessionMessage, GenRequest, GenResult,
  Deliverable, DeliverableSection, LibItem, SaveLibRequest,
  ProjectItem, ProjectDetail, CreateProjectRequest, UpdateProjectRequest,
  ReportItem, ReportDetail, ReportVersionContent, ReportDiff, SectionDiff, SaveReportRequest, SaveReportResult,
  KnowledgeItemT, KnowledgeHit, CreateKnowledgeRequest, SummarizeResult, MessageRef, MemoryCandidate,
  MemoryLibraryView, MemoryLibraryGroup, MemoryLibraryEntry, MemoryCategoryKey, MemoryFillLevel,
  DossierView, DossierReport, DossierSection, DossierBlock,
  Plan, PlanPurchaseResult, AgentPurchaseResult, ClientUnderstanding, AliasSuggestionResult,
  MyCreditItem, MyCreditsView, TokenQuotaView, SmsSendResult,
  DecisionView, DecisionStats, DecisionLedger, ProphecyView, ProphecyStats, ProphecyLedger,
  QuickScanRequest, QuickScanResult, JourneyView, PrescriptionListView, BrandKitView,
  SkuView, SkuOrderResult, BattleForce, BattleCommitResult,
  DataSourcesView, DataSourceView, DataSourceStatus, ModulesView, ModuleView,
  ReminderView, WorkbenchView, ServiceAssignmentView, SearchHit, SearchResult,
  KnowledgeStage, KnowledgePipelineView, KnowledgePipelineFolder, OrganizeResult, OrganizeItem, StagedUploadResult, ConfirmResult,
  KnowledgeBatch, KnowledgeBatchFile,
  KnowledgeDocRow, KnowledgeDetail, AnalyzeResult,
} from '../../../shared/contracts';
import type { ChartSummary, ProgressView, BizMetricTemplateItem, BizMetricWeek } from './api';
import { DEFAULT_AGENTS } from '../data/agents';
import { DELIVERABLES, REPLIES, TRUST_NOTE } from '../data/deliverables';
import { agentForText } from '../data/intents';
import { getToken } from './token';

// ── mock 静态数据源（与后端 seed 对齐） ──
// 行业选项真相源在服务端 industryPacks.ts 的 industryOptionLabels()；此处为离线 mock 兜底，需同步维护。
const SURVEY: SurveyQuestion[] = [
  { key: 'industry', title: '你的行业？', options: ['SaaS / 软件', '电商 / 跨境', '餐饮 / 食品', '美业 / 医美', '教育 / 培训', '医疗 / 医药', '制造 / 工业', '专业服务 / 咨询', '本地生活服务', '文旅 / 酒店', '房产 / 家居', '消费 / 零售', '其他'] },
  { key: 'stage', title: '当前阶段？', options: ['起步 / 验证', 'A 轮前后', '规模化', '稳定盈利'] },
  { key: 'pain', title: '最头疼的事？', options: ['增长乏力', '现金流', '融资', '组织 / 团队', '定位 / 竞争'] },
];
const SAYINGS = [
  '先把自己<em>立于不败</em>，再等对手露出破绽。',
  '组织的上限，往往是<em>创始人认知</em>的上限。',
  '现金流是<em>呼吸</em>，利润才是<em>体格</em>。',
  '战略的本质，是学会<em>放弃</em>。',
];
const ALIAS_NAMES = ['楚霸王', '魏武王', '孙伯符', '汉高祖', '唐太宗', '秦武安', '赵武灵王', '霍骠姚', '李卫公', '岳武穆', '郭汾阳', '韩淮阴', '李存孝', '李元霸', '宇文成都', '关云长', '赵子龙', '吕奉先'];
const PLANS: Plan[] = [
  {
    id: 'mock-plan-free',
    name: '体验版',
    price: 0,
    period: 'month',
    creditsPerMonth: 10,
    tokenQuotaPerMonth: 100000,
    agentCount: 3,
    featuresJson: ['10 点 / 月', '基础顾问 3 位', '适合轻量试用'],
    highlighted: false,
  },
  {
    id: 'mock-plan-decision-monthly',
    name: '决策版 · 月付',
    price: 19800,
    period: 'month',
    creditsPerMonth: 68,
    tokenQuotaPerMonth: 1000000,
    agentCount: 8,
    featuresJson: ['不限量对话', '68 点 / 月', '顾问助手 8 位', '方案库 + 导出', '按月付费 · 随时升年付'],
    highlighted: false,
  },
  {
    id: 'mock-plan-decision',
    name: '决策版',
    price: 198000,
    period: 'year',
    creditsPerMonth: 68,
    tokenQuotaPerMonth: 1000000,
    agentCount: 8,
    featuresJson: ['年付立省 2 个月（约 ¥396）', '不限量对话', '68 点 / 月', '顾问助手 8 位', '方案库 + 导出'],
    highlighted: true,
  },
  {
    id: 'mock-plan-enterprise',
    name: '企业版 · 私有化',
    price: -1,
    period: 'year',
    creditsPerMonth: -1,
    tokenQuotaPerMonth: -1,
    agentCount: 14,
    featuresJson: ['私有化部署', '接入内部系统', '专属助手配置', '数据不出内网'],
    highlighted: false,
  },
];

// V7-12：单次付费商品目录（前端离线兜底，与服务端 seedConfig.SKUS 同口径）。
const SKUS: { key: string; name: string; desc: string; priceFen: number; kind: 'module' | 'service' | 'storage'; grantsModuleKey?: string }[] = [
  { key: 'deep-organize', name: '深度整理', desc: '军师对上传资料做深度去重、提炼与补标，整理成可直接调用的知识。', priceFen: 3900, kind: 'service' },
  { key: 'storage-2g', name: '资料空间包', desc: '为资料库扩容约 2GB，容纳更多经营材料。', priceFen: 1900, kind: 'storage' },
  { key: 'deep-contradiction', name: '深度矛盾分析', desc: '围绕主要矛盾做一次深度拆解，给出结构化打法与验证标准。', priceFen: 2900, kind: 'module', grantsModuleKey: 'deep-contradiction' },
  { key: 'fin-checkup', name: '财务经营体检', desc: '对经营与财务数据做一次系统体检，定位现金与利润风险。', priceFen: 4900, kind: 'module', grantsModuleKey: 'fin-checkup' },
  { key: 'ip-topics-pro', name: 'IP 选题库 · 高级版', desc: '按你的定位批量产出可执行的内容选题库。', priceFen: 9900, kind: 'module', grantsModuleKey: 'ip-topics-pro' },
  { key: 'shop-dashboard', name: '店铺数据看板', desc: '搭建店铺经营数据看板，按周复盘核心经营指标。', priceFen: 19900, kind: 'module', grantsModuleKey: 'shop-dashboard' },
];

// V7-04：结构化三势确定性兜底（对齐效果图默认三势）。
const DEFAULT_BATTLE_FORCES: BattleForce[] = [
  { kind: 'sky', level: 'strong', conclusion: '行业上行', tactic: '可以借势', tacticTone: 'ok', note: '少追热点，多沉淀判断框架。', strength: 75 },
  { kind: 'market', level: 'mid', conclusion: '对手抢位', tactic: '不能扩量', tacticTone: 'warn', note: '老板要少误判，不缺泛内容。', strength: 45 },
  { kind: 'people', level: 'weak', conclusion: '团队待整', tactic: '轻资产验证', tacticTone: 'danger', note: '先用内容和私域跑小闭环。', strength: 35 },
];

// V7-07 数据源目录（前端离线兜底，对齐 server data/dataSources.ts）。
const MOCK_DATA_SOURCES: { key: string; label: string; desc: string; icon: string; scope: string[]; tier: 'basic' | 'advanced' }[] = [
  { key: 'content-account', label: '内容账号数据', desc: '小红书 / 抖音 / 视频号 / 公众号：阅读、互动、私信', icon: '内', scope: ['阅读·播放', '互动·评论', '私信关键词', '内容选题表现'], tier: 'basic' },
  { key: 'private', label: '客户与私域数据', desc: '企微、微信群、私聊记录、客户标签、咨询记录', icon: '客', scope: ['客户标签', '跟进状态', '咨询关键词', '成交回写'], tier: 'basic' },
  { key: 'shop', label: '店铺经营数据', desc: '曝光、点击、成交、复购、退款、客单价', icon: '店', scope: ['曝光·点击', '成交·退款', '复购·客单价', '投放花费'], tier: 'basic' },
  { key: 'funnel', label: '成交漏斗数据', desc: '线索、咨询、报价、成交、流失原因、复购', icon: '漏', scope: ['线索数', '咨询数', '报价数', '成交·流失原因'], tier: 'basic' },
  { key: 'finance', label: '财务经营数据', desc: '营收、成本、利润、预算、投放花费、现金流', icon: '财', scope: ['营收', '成本', '利润', '预算·现金流'], tier: 'basic' },
  { key: 'service', label: '服务交付数据', desc: '服务进度、客户反馈、好评截图、售后问题、案例结果', icon: '服', scope: ['服务进度', '客户反馈', '案例结果', '售后问题'], tier: 'basic' },
  { key: 'crm', label: '企业微信 / CRM 授权', desc: '长期追踪客户标签、跟进状态和成交回写。', icon: '企', scope: ['客户标签', '跟进状态', '咨询关键词', '成交回写'], tier: 'advanced' },
  { key: 'ads', label: '广告与店铺后台授权', desc: '持续读取投放、店铺和订单变化，自动刷新复盘。', icon: '广', scope: ['曝光·点击', '成交·退款', '复购·客单价', '投放花费'], tier: 'advanced' },
];
function dsLabel(status: DataSourceStatus, tier: 'basic' | 'advanced'): string {
  return status === 'bound' ? '已绑定' : status === 'uploaded' ? '待上传' : status === 'auth_requested' ? '待授权' : tier === 'advanced' ? '高级' : '上传即可';
}

// V7-08 能力目录（前端离线兜底，对齐 server data/modules.ts；detail 简版）。
type ModuleGroupM = 'free' | 'deep' | 'member';
type ModuleTierM = 'free' | 'sku' | 'credits' | 'member';
const MOCK_MODULES: Omit<ModuleView, 'enabled' | 'hidden' | 'sortOrder'>[] = [
  { key: 'trend', label: '三势初判', desc: '天势 / 市势 / 人势，先给基础判断', iconChar: '势', group: 'free', tier: 'free', stateLabel: '默认启用', agentKey: 'general', detail: { scene: '案卷资料齐了先跑一遍三势', input: '案卷资料', output: '三势判断', cost: '免费', writeback: '战局页' } },
  { key: 'conflict', label: '矛盾初筛', desc: '识别当前最卡住增长的主线问题', iconChar: '矛', group: 'free', tier: 'free', stateLabel: '可直接调用', agentKey: 'general', detail: { scene: '拿不准最该解决什么时用', input: '对话 + 案卷', output: '主要矛盾', cost: '免费', writeback: '战局页' } },
  { key: 'deep-contradiction', label: '深度矛盾分析', desc: '输出阶段打法、风险边界和不可做清单', iconChar: '深', group: 'deep', tier: 'sku', price: { skuKey: 'deep-contradiction', priceFen: 2900 }, stateLabel: '¥29 启用', detail: { scene: '主要矛盾已明确，要深挖打法', input: '完整案卷', output: '深度诊断', cost: '¥29', writeback: '方案库' } },
  { key: 'growth', label: '增长漏斗诊断', desc: '结合店铺、私域和内容数据做深度推演', iconChar: '漏', group: 'deep', tier: 'credits', price: { credits: 80 }, stateLabel: '消耗 80 算力', agentKey: 'growth', detail: { scene: '有成交漏斗数据后重算损耗', input: '成交漏斗表', output: '转化断点', cost: '80 算力', writeback: '执行页' } },
  { key: 'ip-engine', label: 'IP 内容引擎', desc: '定位、选题、脚本、发布计划一体生成', iconChar: 'IP', group: 'deep', tier: 'member', price: { planRequired: true }, stateLabel: '会员可用', agentKey: 'ip', detail: { scene: '要批量产出可执行内容', input: 'IP 资料', output: '选题脚本', cost: '会员', writeback: '执行页' } },
  { key: 'finance', label: '财务经营体检', desc: '现金流、成本结构、利润风险初步拆解', iconChar: '财', group: 'deep', tier: 'sku', price: { skuKey: 'fin-checkup', priceFen: 4900 }, stateLabel: '¥49 启用', detail: { scene: '担心现金和利润风险时', input: '财务表', output: '经营体检', cost: '¥49', writeback: '方案库' } },
  { key: 'daily-command', label: '每日军令', desc: '任务、提醒、复盘，承接认可后的方案', iconChar: '令', group: 'member', tier: 'free', stateLabel: '基础版免费', detail: { scene: '认可判断后自动承接执行', input: '认可判断', output: '每日军令', cost: '免费', writeback: '执行页' } },
  { key: 'topic-bank', label: 'IP 选题库高级版', desc: '按人设、产品和渠道生成长期选题池', iconChar: '题', group: 'member', tier: 'sku', price: { skuKey: 'ip-topics-pro', priceFen: 9900 }, stateLabel: '¥99 单独购买', detail: { scene: '需要长期内容选题储备', input: '人设产品', output: '长期选题', cost: '¥99', writeback: '知识库' } },
  { key: 'shop-board', label: '店铺数据看板', desc: '曝光、点击、转化、复购持续追踪', iconChar: '店', group: 'member', tier: 'sku', price: { skuKey: 'shop-dashboard', priceFen: 19900 }, stateLabel: '¥199 单独购买', detail: { scene: '要持续盯店铺经营指标', input: '店铺授权', output: '数据看板', cost: '¥199', writeback: '数据源' } },
  { key: 'weekly-review', label: '周复盘增强', desc: '自动汇总执行、数据和下一周军令', iconChar: '复', group: 'member', tier: 'member', price: { planRequired: true }, stateLabel: '会员解锁', detail: { scene: '每周要系统复盘并排下周军令', input: '本周执行', output: '周复盘', cost: '会员', writeback: '方案库' } },
];
const MOCK_SKU_MODULE_KEY: Record<string, string> = { 'deep-contradiction': 'deep-contradiction', finance: 'fin-checkup', 'topic-bank': 'ip-topics-pro', 'shop-board': 'shop-dashboard' };

// V7-06 业务类目（前端离线兜底，对齐 server data/bizCategories.ts）。
const BIZ_LABEL: Record<string, string> = { founder: '老板档案', company: '企业档案', finance: '财务经营', content: '内容IP', growth: '增长资料', customer: '客户问答', proof: '案例证明', unknown: '待识别' };
function classifyMock(text: string): string {
  const t = text || '';
  if (/老板|创始|个人|IP档案/.test(t)) return 'founder';
  if (/企业|公司|组织|团队/.test(t)) return 'company';
  if (/财务|营收|成本|利润|现金/.test(t)) return 'finance';
  if (/内容|选题|脚本|视频/.test(t)) return 'content';
  if (/增长|漏斗|转化|线索/.test(t)) return 'growth';
  if (/客户|问答|咨询|反馈/.test(t)) return 'customer';
  if (/案例|证明|评价|结果/.test(t)) return 'proof';
  return 'unknown';
}
// V7-06：整理后一句摘要（mock 确定性，按类目生成）。
const BIZ_SUMMARY: Record<string, string> = {
  founder: '老板个人背景与定位要点', company: '企业组织与业务概况',
  finance: '收入成本与现金流关键数字', content: '内容选题与脚本素材',
  growth: '获客漏斗与转化线索', customer: '客户问答与常见反馈',
  proof: '成交案例与结果佐证', unknown: '待进一步识别归类',
};
function mockSummary(cat: string): string { return BIZ_SUMMARY[cat] || BIZ_SUMMARY.unknown; }

// ── 每账号(token)隔离、落 Taro storage 的内存库 ──
interface SessionRec {
  id: string; agentKey: string; title: string;
  projectId?: string | null;
  createdAt: string; updatedAt: string;
  messages: SessionMessage[];
}
interface ReportVersionRec {
  id: string; version: number; title: string; content: Deliverable; contentHash: string;
  changeSummary: string | null; authorKind: string; sessionId: string | null; at: string;
}
interface ReportDocRec {
  id: string; title: string; slug: string; type: string; agentKey: string | null;
  projectId: string | null; currentVersion: number; updatedAt: string; versions: ReportVersionRec[];
}
interface KnowledgeRec {
  id: string; projectId: string | null; kind: string; title: string | null; text: string;
  sourceType: string; sourceId: string | null; tags: string[]; at: string;
  stage?: KnowledgeStage; bizCategory?: string; batchId?: string; fileType?: string; fileSize?: number; dupOfId?: string; // V7-06
  status?: string; summary?: string; // V7-06：单份解析状态（ready/parsing/failed）+ 整理后一句摘要
}
interface ProjectRec {
  id: string; name: string; slug: string; icon: string; summary: string | null;
  status: 'active' | 'archived'; createdAt: string; updatedAt: string;
}
interface UserData {
  name: string; company: string; phone: string; benmingColor: string; onboarded: boolean;
  avatarUrl?: string; wechatLinked?: boolean;
  planId: string; creditBalance: number; tokenUsed: number; ownedAgents: string[];
  creditLog: MyCreditItem[];
  profile: Profile | null; sessions: SessionRec[]; library: LibItem[];
  projects: ProjectRec[]; reports: ReportDocRec[]; knowledge: KnowledgeRec[];
  ownedModules?: string[]; // V7-08/V7-12：已启用能力 key（免费直启 / credits / sku 购买）
  skuServices?: string[]; // V7-12：已购一次性服务 key（如 deep-organize）
  battleForces?: BattleForce[]; // V7-04：结构化三势（刷新后覆盖默认）
  battleCommittedDate?: string; // V7-04：今日已 commit 日期（幂等）
  dataSourceStatus?: Record<string, DataSourceStatus>; // V7-07
  moduleState?: Record<string, { hidden?: boolean; sortOrder?: number }>; // V7-08
  knowledgeSeeded?: boolean; // V7-06：演示待整理批次已注入（仅注入一次）
}

const uid = (p = '') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const now = () => new Date().toISOString();
const dataKey = (token: string) => `mock.data.${token}`;
// 演示用：记录每个手机号最近一条短信验证码（仅内存，刷新即清）。
const mockSmsCodes: Record<string, string> = {};

function load(token: string): UserData {
  try {
    const raw = Taro.getStorageSync(dataKey(token));
    if (raw) {
      const d = (typeof raw === 'string' ? JSON.parse(raw) : raw) as UserData;
      // 兼容旧存档：补齐新增集合
      d.projects ??= []; d.reports ??= []; d.knowledge ??= [];
      d.planId ??= 'mock-plan-decision';
      d.creditBalance ??= 68;
      d.tokenUsed ??= 0;
      d.creditLog ??= [];
      d.ownedAgents ??= ['intel', 'brand']; // 演示：默认已启用两个专项智能体
      d.ownedModules ??= [];
      d.skuServices ??= [];
      d.dataSourceStatus ??= { 'content-account': 'bound', private: 'bound' };
      d.moduleState ??= {};
      d.company ??= '';
      d.name ??= '';
      return d;
    }
  } catch { /* noop */ }
  const phone = token.replace(/^(mock-|local-)/, '');
  return {
    name: '', // 不编造随机名；首登建档采集真实称呼
    company: '',
    phone,
    benmingColor: 'green',
    onboarded: false,
    planId: 'mock-plan-decision',
    creditBalance: 68,
    tokenUsed: 0,
    creditLog: [],
    ownedAgents: ['intel', 'brand'],
    profile: null,
    sessions: [],
    library: [],
    projects: [],
    reports: [],
    knowledge: [],
  };
}
function save(token: string, d: UserData) {
  try { Taro.setStorageSync(dataKey(token), JSON.stringify(d)); } catch { /* noop */ }
}
function current(): { token: string; d: UserData } {
  const token = getToken();
  return { token, d: load(token) };
}

const agentOf = (key: string): Agent =>
  DEFAULT_AGENTS.find((a) => a.key === key) || DEFAULT_AGENTS.find((a) => a.key === 'general')!;

// 确定性样例命盘（mock 专用 UI 预览假数据，结构对齐 ChartSummary；非真排盘）
function sampleChartM(): ChartSummary {
  const yr = new Date().getFullYear();
  const PHASES = ['进攻', '平稳', '防守', '进攻', '平稳', '进攻', '防守', '平稳', '进攻', '平稳', '防守', '平稳'];
  const TURN = new Set([3, 7, 11]);
  return {
    engineVersion: 'paipan-v1',
    hourKnown: true,
    pillars: { year: { ganZhi: '庚午' }, month: { ganZhi: '壬午' }, day: { ganZhi: '戊子' }, time: { ganZhi: '甲寅' } },
    dayMaster: { gan: '戊', element: '土', strength: '身强' },
    pattern: { name: '正财格', traits: '务实稳健、重信守诺，善守成不喜冒进', suits: ['稳扎稳打、深耕存量'], avoid: ['盲目扩张'] },
    ziwei: { soulMajorStars: ['紫微', '天府'], bodyMajorStars: ['武曲'] },
    monthlyOutlook: { year: yr, months: PHASES.map((phase, i) => ({ month: i + 1, phase, turning: TURN.has(i + 1) })) },
  };
}

// —— 双轴计费 mock 辅助：钻石(creditBalance) 管解锁；月度 token 额度按 tokenUsed/limit 计 ——
function planOf(d: UserData): Plan { return PLANS.find((p) => p.id === d.planId) ?? PLANS[1]; }
function mockQuota(d: UserData): TokenQuotaView {
  const limit = planOf(d).tokenQuotaPerMonth;
  if (limit < 0) return { limit: -1, used: 0, remaining: -1, unlimited: true };
  const used = d.tokenUsed ?? 0;
  return { limit, used, remaining: limit - used, unlimited: false };
}
function ensureMockQuota(d: UserData): void {
  const limit = planOf(d).tokenQuotaPerMonth;
  if (limit >= 0 && (d.tokenUsed ?? 0) >= limit) {
    throw Object.assign(new Error('本月 token 额度已用尽，请升级套餐或下月再用'), { code: 'INSUFFICIENT_QUOTA', data: { code: 'INSUFFICIENT_QUOTA' } });
  }
}
function chargeMockQuota(d: UserData, ratio: number, inputLen: number, outputLen: number): TokenQuotaView {
  if (planOf(d).tokenQuotaPerMonth >= 0) {
    const pseudo = Math.max(80, Math.round((inputLen + outputLen) / 3));
    d.tokenUsed = (d.tokenUsed ?? 0) + Math.ceil(pseudo * (ratio > 0 ? ratio : 1));
  }
  return mockQuota(d);
}

function metaOf(d: UserData): string {
  const parts = [meaningfulM(d.company), d.profile?.industry].filter(Boolean) as string[];
  return parts.length ? parts.join(' · ') : '经营快照';
}

function buildDeliverable(deliverableKey: string, d: UserData): Deliverable {
  const tpl = DELIVERABLES[deliverableKey] ?? DELIVERABLES['战略体检'];
  const pain = d.profile?.pain || '当前经营问题';
  return {
    title: tpl.title,
    icon: tpl.icon,
    meta: metaOf(d),
    sections: tpl.sections.map((s) => ({ h: s.h, b: s.b ? s.b.replaceAll('{PAIN}', pain) : undefined, list: s.list })),
    trust: TRUST_NOTE,
    actions: ['save_to_library', 'export_pdf'],
  };
}

const delay = <T>(v: T, ms = 280): Promise<T> => new Promise((r) => setTimeout(() => r(v), ms));
const cleanM = (v: unknown, max = 120): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
function isPlaceholderM(v: unknown): boolean {
  const s = cleanM(v, 40);
  if (!s) return true;
  if (/^(用户|企业|公司|租户)\d+$/.test(s)) return true;
  return ['用户', '企业', '公司', '微信用户', '匿名用户', '未命名', '测试用户', '测试企业'].includes(s);
}
function meaningfulM(v: unknown, max = 120): string {
  const s = cleanM(v, max);
  return isPlaceholderM(s) ? '' : s;
}
function pushUniqueM(list: string[], value: unknown, max = 4) {
  const v = cleanM(value);
  if (v && !list.includes(v) && list.length < max) list.push(v);
}
function extraLinesM(extra: unknown): string[] {
  if (!extra || typeof extra !== 'object') return [];
  const out: string[] = [];
  Object.entries(extra as Record<string, unknown>).forEach(([k, v]) => {
    const text = cleanM(v, 160);
    if (!text) return;
    const label = /[a-zA-Z]/.test(k) ? '' : k;
    pushUniqueM(out, label ? `${label}：${text}` : text, 4);
  });
  return out;
}
function buildUnderstandingM(d: UserData): ClientUnderstanding {
  const userName = meaningfulM(d.name);
  const companyName = meaningfulM(d.company);
  const identity: string[] = [];
  pushUniqueM(identity, userName ? `服务对象：${userName}` : '');
  pushUniqueM(identity, companyName ? `企业/品牌：${companyName}` : '');
  pushUniqueM(identity, d.profile?.industry ? `行业：${d.profile.industry}` : '');
  pushUniqueM(identity, d.profile?.stage ? `阶段：${d.profile.stage}` : '');

  const journey = extraLinesM(d.profile?.extra);
  d.projects.slice(0, 4).forEach((p) => pushUniqueM(journey, p.summary ? `案卷《${p.name}》：${p.summary}` : `案卷《${p.name}》正在推进`, 5));
  d.sessions.slice(0, 4).forEach((s) => pushUniqueM(journey, `近期讨论：${s.title}`, 5));

  const difficulties: string[] = [];
  pushUniqueM(difficulties, d.profile?.pain ? `当前最关注：${d.profile.pain}` : '');
  d.knowledge.slice(0, 5).forEach((k) => {
    if (/(insight|decision|todo)/i.test(k.kind)) pushUniqueM(difficulties, k.title ? `${k.title}：${k.text}` : k.text, 5);
  });

  const materials: string[] = [];
  d.knowledge.slice(0, 4).forEach((k) => pushUniqueM(materials, k.title ? `资料《${k.title}》` : k.text, 6));
  d.reports.slice(0, 4).forEach((r) => pushUniqueM(materials, `报告《${r.title}》v${r.currentVersion}`, 6));

  const nextQuestions: string[] = [];
  if (!userName) nextQuestions.push('以后军师怎么称呼你？');
  if (!companyName) nextQuestions.push('你的公司、门店或品牌叫什么？');
  if (!d.profile?.industry) nextQuestions.push('你现在主要做哪个行业或品类？');
  if (!d.profile?.stage) nextQuestions.push('业务处在起步、增长、规模化还是稳定经营阶段？');
  if (!d.profile?.pain) nextQuestions.push('这段时间最卡你的经营问题是什么？');
  if (!journey.length) nextQuestions.push('你是怎么开始这门生意的，中间经历过哪几个关键转折？');

  const evidenceCount = { profile: d.profile ? 1 : 0, memories: 0, projects: d.projects.length, knowledge: d.knowledge.length, sessions: d.sessions.length };
  const evidenceTotal = evidenceCount.profile + evidenceCount.projects + evidenceCount.knowledge + evidenceCount.sessions;
  const maturity = evidenceTotal === 0 && !identity.length ? 'empty' : nextQuestions.length > 2 ? 'forming' : 'ready';
  const summary = maturity === 'empty'
    ? '军师还没有足够资料形成判断。补齐基本情况后，后续建议会优先依据你的真实业务来推演。'
    : maturity === 'forming'
      ? `军师已掌握 ${evidenceTotal} 条经营线索，能做初步判断；关键背景仍需继续补齐，避免替你假设业务事实。`
      : `军师已沉淀 ${evidenceTotal} 条经营线索，可作为后续咨询、复盘和方案产出的底稿。`;

  return {
    title: '个人档案',
    subtitle: '军师有多了解你的生意',
    maturity,
    summary,
    // 主要矛盾（mock：有痛点时给一句真结论，让战局 hero 走查真数据态）
    mainContradiction: d.profile?.pain ? `主要矛盾集中在「${d.profile.pain}」——先解决它，其余动作都围绕它排布。` : null,
    positioning: null,
    // L-6 三势：mock 给确定性研判结论，军情页市势/人势卡走真数据态
    forces: d.profile?.pain ? { shishi: { verdict: '守', note: '先守住复购，别急着抢新客' }, renshi: { verdict: '等', note: '人手紧，先练兵不硬扩' } } : null,
    // V7-04 结构化三势：无资料时为空（战局页走 force-empty 空态引导对话，不预置结论）；
    // 有痛点/已刷新（refreshForces 写入 d.battleForces）时才给三势，两态均可走查（P0-3）。
    battleForces: d.battleForces ?? (d.profile?.pain ? DEFAULT_BATTLE_FORCES : []),
    battleForcesAt: null,
    sections: [
      { key: 'identity', title: '经营身份', items: identity, emptyText: '还没记录你的称呼、公司、行业和阶段。' },
      { key: 'journey', title: '创业路径', items: journey, emptyText: '还没形成创业路径。可以告诉军师：你怎么开始、做过哪些转折、现在走到哪一步。' },
      { key: 'difficulties', title: '当前难题', items: difficulties, emptyText: '还没记录明确难题。后续咨询会先追问关键约束，再给建议。' },
      { key: 'materials', title: '已沉淀资料', items: materials, emptyText: '还没有长期线索。对话、案卷、方案和资料库都会逐步沉淀到这里。' },
    ],
    nextQuestions: nextQuestions.slice(0, 4),
    evidenceCount,
    updatedAt: null,
  };
}

function needsInputM(d: UserData, text: string, refs?: MessageRef[], projectId?: string | null): boolean {
  const hasContext = !!meaningfulM(d.company) || !!d.profile || d.knowledge.length > 0 || d.projects.length > 0 || !!refs?.length || !!projectId;
  return !hasContext && text.trim().length < 24;
}

function inputQuestionsM(d: UserData): string[] {
  return buildUnderstandingM(d).nextQuestions.slice(0, 3);
}

function wantsBriefInterviewM(text: string): boolean {
  return /个人档案访谈模式|补齐个人档案|完善个人档案|更新个人档案|让军师来问/.test(text);
}

// ── 版本化报告 / 知识 / 引用 的本地实现（与后端同口径，纯前端、零依赖） ──
function slugify(title: string): string {
  return (title || '未命名报告').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\w一-鿿-]/g, '').slice(0, 80) || 'report';
}
function canonical(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  const o = obj as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}
const sectionsOf = (c: unknown): DeliverableSection[] => (c as { sections?: DeliverableSection[] } | null)?.sections ?? [];

// 词级 diff（LCS），与后端 reports.ts 同口径
function tokenizeM(s: string): string[] { return s.match(/[a-z0-9]+|[一-鿿]|[^\sa-z0-9一-鿿]+|\s+/gi) ?? []; }
function wordDiffM(before: string, after: string): { t: 'eq' | 'add' | 'del'; s: string }[] {
  const a = tokenizeM(before), b = tokenizeM(after), n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops: { t: 'eq' | 'add' | 'del'; s: string }[] = [];
  const push = (t: 'eq' | 'add' | 'del', s: string) => { const l = ops[ops.length - 1]; if (l && l.t === t) l.s += s; else ops.push({ t, s }); };
  let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { push('eq', a[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; } else { push('add', b[j]); j++; } }
  while (i < n) { push('del', a[i++]); } while (j < m) { push('add', b[j++]); }
  return ops;
}
const secTextM = (sec?: DeliverableSection): string => sec ? [sec.b, ...(sec.list ?? [])].filter(Boolean).join('\n') : '';

function diffSections(before: object, after: object): { sections: SectionDiff[]; summary: string; titleBefore: string; titleAfter: string } {
  const bs = sectionsOf(before), as = sectionsOf(after);
  const bMap = new Map(bs.map((s) => [s.h, s])), aMap = new Map(as.map((s) => [s.h, s]));
  const out: SectionDiff[] = [];
  let added = 0, removed = 0, changed = 0;
  for (const s of as) {
    const prev = bMap.get(s.h);
    if (!prev) { out.push({ change: 'added', h: s.h, after: s }); added++; }
    else if (canonical(prev) !== canonical(s)) { out.push({ change: 'changed', h: s.h, before: prev, after: s, words: wordDiffM(secTextM(prev), secTextM(s)) }); changed++; }
    else out.push({ change: 'unchanged', h: s.h, before: prev, after: s });
  }
  for (const s of bs) if (!aMap.has(s.h)) { out.push({ change: 'removed', h: s.h, before: s }); removed++; }
  const titleBefore = (before as { title?: string }).title ?? '', titleAfter = (after as { title?: string }).title ?? '';
  const parts = [`新增 ${added} 段`, `修改 ${changed} 段`, `删除 ${removed} 段`];
  if (titleBefore && titleAfter && titleBefore !== titleAfter) parts.unshift('标题有变');
  return { sections: out, summary: parts.join(' · '), titleBefore, titleAfter };
}

function keywordScore(q: string, text: string): number {
  const terms = [...(q.toLowerCase().match(/[a-z0-9]+/g) ?? []), ...(q.match(/[一-鿿]{2,}/g) ?? [])];
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  let hit = 0; for (const t of terms) if (lower.includes(t)) hit++;
  return hit / terms.length;
}

// 把显式引用解析成「标签 + 注入行」，并附带知识库召回，给 mock 产出体现「引用生效」
function resolveRefs(d: UserData, refs: MessageRef[] | undefined, query: string, projectId?: string | null): { labels: string[]; notes: string[] } {
  const labels: string[] = [], notes: string[] = [];
  for (const r of (refs ?? []).slice(0, 6)) {
    if (r.kind === 'project') { const p = d.projects.find((x) => x.id === r.id); if (p) { labels.push(`案卷《${p.name}》`); notes.push(p.summary || p.name); } }
    else if (r.kind === 'report') { const rep = d.reports.find((x) => x.id === r.id); if (rep) { const v = rep.versions[rep.versions.length - 1]; labels.push(`方案《${rep.title}》v${rep.currentVersion}`); notes.push(v ? sectionsOf(v.content).map((s) => s.h).join('、') : rep.title); } }
    else if (r.kind === 'knowledge') { const k = d.knowledge.find((x) => x.id === r.id); if (k) { labels.push(`知识「${k.title ?? k.text.slice(0, 12)}」`); notes.push(k.text); } }
  }
  // 自动召回：知识库关键词命中
  const hits = d.knowledge.filter((k) => !projectId || k.projectId === projectId)
    .map((k) => ({ k, s: keywordScore(query, `${k.title ?? ''} ${k.text}`) }))
    .filter((x) => x.s > 0.1).sort((a, b) => b.s - a.s).slice(0, 2);
  for (const h of hits) { labels.push(h.k.title ?? h.k.text.slice(0, 12)); notes.push(h.k.text); }
  return { labels, notes };
}

// 本地保存一版报告：同名归一、同内容去重、自动变更摘要
function saveReportVersionLocal(d: UserData, opts: { title: string; type: string; agentKey?: string | null; projectId?: string | null; content: Deliverable; authorKind?: string; sessionId?: string | null }): SaveReportResult & { reportId: string } {
  const slug = slugify(opts.title);
  const hash = canonical(opts.content);
  let doc = d.reports.find((r) => r.slug === slug);
  let created = false;
  if (!doc) {
    doc = { id: uid('r-'), title: opts.title, slug, type: opts.type, agentKey: opts.agentKey ?? null, projectId: opts.projectId ?? null, currentVersion: 0, updatedAt: now(), versions: [] };
    d.reports.push(doc); created = true;
  }
  const latest = doc.versions[doc.versions.length - 1];
  if (latest && latest.contentHash === hash) return { reportId: doc.id, version: latest.version, created, changed: false };
  const changeSummary = created ? '首个版本' : diffSections(latest!.content as object, opts.content as object).summary;
  const version = doc.currentVersion + 1;
  doc.versions.push({ id: uid('v-'), version, title: opts.title, content: opts.content, contentHash: hash, changeSummary, authorKind: opts.authorKind ?? 'agent', sessionId: opts.sessionId ?? null, at: now() });
  doc.currentVersion = version; doc.title = opts.title; doc.type = opts.type; doc.updatedAt = now();
  if (opts.projectId) doc.projectId = opts.projectId;
  if (opts.agentKey) doc.agentKey = opts.agentKey;
  return { reportId: doc.id, version, created, changed: true };
}

function ingestKnowledgeLocal(d: UserData, opts: { kind: string; title?: string | null; text: string; projectId?: string | null; sourceType: string; sourceId?: string | null; tags?: string[] }): KnowledgeRec {
  const rec: KnowledgeRec = { id: uid('k-'), projectId: opts.projectId ?? null, kind: opts.kind, title: opts.title ?? null, text: opts.text, sourceType: opts.sourceType, sourceId: opts.sourceId ?? null, tags: opts.tags ?? [], at: now() };
  d.knowledge.unshift(rec); return rec;
}

const projItem = (d: UserData, p: ProjectRec): ProjectItem => ({
  id: p.id, name: p.name, slug: p.slug, icon: p.icon, summary: p.summary, status: p.status,
  counts: { sessions: d.sessions.filter((s) => s.projectId === p.id).length, reports: d.reports.filter((r) => r.projectId === p.id).length, knowledge: d.knowledge.filter((k) => k.projectId === p.id).length },
  updatedAt: p.updatedAt,
});
const reportItem = (r: ReportDocRec): ReportItem => ({ id: r.id, title: r.title, slug: r.slug, type: r.type, agentKey: r.agentKey, agentName: r.agentKey ? agentOf(r.agentKey).name : undefined, projectId: r.projectId, currentVersion: r.currentVersion, updatedAt: r.updatedAt });
const knItem = (k: KnowledgeRec): KnowledgeItemT => ({ id: k.id, projectId: k.projectId, kind: k.kind as KnowledgeItemT['kind'], title: k.title, text: k.text, sourceType: k.sourceType, sourceId: k.sourceId, tags: k.tags, at: k.at });

// —— 账本闭环 mock（决策账本/天机账本，与后端同口径：n<5 不出比率）——
type LedgerM = { decisions: DecisionView[]; prophecies: ProphecyView[] };
function seedLedgerM(): LedgerM {
  const day = new Date().toISOString().slice(0, 10);
  const dec = (seq: number, decision: string, status: DecisionView['status'], fast: boolean | null, scene = '战略规划'): DecisionView =>
    ({ id: `d${seq}`, seq, scene, decision, reasons: [], tianshiRef: '', expected: '', verifyStandard: '', verifyByDate: day, status, verifyNote: '', fast, createdAt: `${day} 10:0${seq}` });
  const pro = (seq: number, prophecy: string, status: ProphecyView['status']): ProphecyView =>
    ({ id: `p${seq}`, seq, prophecy, basis: '流月', verifyStandard: '', dueDate: day, status, verifyNote: '', createdAt: `${day} 10:0${seq}` });
  return {
    decisions: [
      dec(1, '先收缩到复购最好的两家店，砍掉拖后腿的第4家', 'correct', false),
      dec(2, '把9800年卡改成体验—复购分层，先拉复购率', 'correct', false),
      dec(3, '暂缓加盟扩张，先把直营模型跑透', 'revise', true, '紧急战况'),
      dec(4, '上私域内容获客，替代高价投放', 'pending', null),
      dec(5, '把技师提成和复购挂钩', 'pending', null),
      dec(6, '开一条轻医美高毛利线试水', 'pending', null),
    ],
    prophecies: [
      pro(1, '3月忌神当令，现金流会有压力', 'hit'),
      pro(2, '4月偏财得力，有意外进账', 'hit'),
      pro(3, '5月官星受克，团队可能有波动', 'miss'),
      pro(4, '下半年适合签长约、落白纸黑字', 'pending'),
      pro(5, '秋后有一次扩张窗口', 'pending'),
    ],
  };
}
function loadLedgerM(token: string): LedgerM {
  try { const raw = Taro.getStorageSync(`mock.ledger.${token}`); if (raw) return (typeof raw === 'string' ? JSON.parse(raw) : raw) as LedgerM; } catch { /* noop */ }
  return seedLedgerM();
}
function saveLedgerM(token: string, l: LedgerM) { try { Taro.setStorageSync(`mock.ledger.${token}`, JSON.stringify(l)); } catch { /* noop */ } }
const accM = (c: number, r: number) => (c + r >= 5 ? Math.round((c / (c + r)) * 100) : null);
function decStatsM(items: DecisionView[]): DecisionStats {
  const correct = items.filter((i) => i.status === 'correct').length;
  const revise = items.filter((i) => i.status === 'revise').length;
  const fast = items.filter((i) => i.fast === true), slow = items.filter((i) => i.fast === false);
  return {
    total: items.length, pending: items.length - correct - revise, correct, revise,
    accuracy: accM(correct, revise),
    fastAccuracy: accM(fast.filter((i) => i.status === 'correct').length, fast.filter((i) => i.status === 'revise').length),
    slowAccuracy: accM(slow.filter((i) => i.status === 'correct').length, slow.filter((i) => i.status === 'revise').length),
  };
}
function proStatsM(items: ProphecyView[]): ProphecyStats {
  const hit = items.filter((i) => i.status === 'hit').length, miss = items.filter((i) => i.status === 'miss').length;
  return { total: items.length, pending: items.length - hit - miss, hit, miss, hitRate: hit + miss >= 5 ? Math.round((hit / (hit + miss)) * 100) : null };
}

// —— WO-10 经营周报 mock：美业样例模板 + 周序列（本地持久化，确定性种子） ——
// 模板字段与服务端 IndustryBenchmark（美业启用项）口径对齐；离线兜底，需同步维护。
const BIZ_TEMPLATE_BEAUTY: BizMetricTemplateItem[] = [
  { metricKey: 'monthly_revenue', metricName: '月营收', unit: '万元' },
  { metricKey: 'customer_price', metricName: '客单价', unit: '元' },
  { metricKey: 'repurchase_rate', metricName: '复购率', unit: '%' },
  { metricKey: 'store_conversion', metricName: '到店转化率', unit: '%' },
  { metricKey: 'new_customers', metricName: '新客数', unit: '人' },
];
function pad2M(n: number): string { return String(n).padStart(2, '0'); }
function ymdM(d: Date): string { return `${d.getFullYear()}-${pad2M(d.getMonth() + 1)}-${pad2M(d.getDate())}`; }
// 本周一（与服务端归一口径一致）；offset 周为负数取过去的周一。
function mondayOfM(offsetWeeks = 0): string {
  const d = new Date();
  const dow = (d.getDay() + 6) % 7; // 0=周一
  d.setDate(d.getDate() - dow + offsetWeeks * 7);
  return ymdM(d);
}
function seedBizSeriesM(): BizMetricWeek[] {
  // 上上周 + 上周两条确定性历史，本周留空待用户上报。
  return [
    { weekStart: mondayOfM(-2), metrics: { monthly_revenue: 18, customer_price: 620, repurchase_rate: 34, store_conversion: 41, new_customers: 52 } },
    { weekStart: mondayOfM(-1), metrics: { monthly_revenue: 21, customer_price: 660, repurchase_rate: 37, store_conversion: 44, new_customers: 58 } },
  ];
}
function loadBizSeriesM(token: string): BizMetricWeek[] {
  try { const raw = Taro.getStorageSync(`mock.bizmetrics.${token}`); if (raw) return (typeof raw === 'string' ? JSON.parse(raw) : raw) as BizMetricWeek[]; } catch { /* noop */ }
  return seedBizSeriesM();
}
function saveBizSeriesM(token: string, s: BizMetricWeek[]) { try { Taro.setStorageSync(`mock.bizmetrics.${token}`, JSON.stringify(s)); } catch { /* noop */ } }

// ── mock api（与后端同口径） ──
export const mock = {
  async suggestAlias(): Promise<AliasSuggestionResult> {
    const name = ALIAS_NAMES[Math.floor(Math.random() * ALIAS_NAMES.length)] ?? '楚霸王';
    return delay({ name, source: '古典武侠/军事花名' }, 120);
  },

  // 演示短信：固定回填 888888，按手机号记下最近一条便于 login/bind 校验「错码」路径。
  async sendSmsCode(phone: string, _scene?: 'login' | 'bind'): Promise<SmsSendResult> {
    mockSmsCodes[phone] = '888888';
    return delay({ cooldownSec: 60, expiresInSec: 300, devCode: '888888' }, 200);
  },

  async login(phone: string, name?: string, code?: string): Promise<LoginResult> {
    // 传了验证码就在本地比对（演示「错码」拦截）；未传则放行（兼容免码演示）。
    if (code !== undefined) {
      const expect = mockSmsCodes[phone] ?? '888888';
      if (code !== expect) throw Object.assign(new Error('验证码错误或已过期'), { code: 'SMS_CODE_INVALID' });
      delete mockSmsCodes[phone];
    }
    const token = `mock-${phone}`;
    const existed = !!Taro.getStorageSync(dataKey(token));
    const d = load(token);
    if (name) d.name = name;
    save(token, d);
    return delay({
      token, isNew: !existed, onboarded: d.onboarded,
      user: { id: token, name: d.name, phone, benmingColor: d.benmingColor },
    });
  },

  // 本机号一键登录（演示）：用 phoneCode 派生一个稳定手机号，复用手机号建号逻辑。
  async wechatPhoneLogin(phoneCode: string, name?: string): Promise<LoginResult> {
    let h = 0;
    for (let i = 0; i < phoneCode.length; i++) h = (h * 31 + phoneCode.charCodeAt(i)) >>> 0;
    const phone = ('1' + String(3_900_000_000 + (h % 90_000_000)).padStart(10, '0')).slice(0, 11);
    const token = `mock-${phone}`;
    const existed = !!Taro.getStorageSync(dataKey(token));
    const d = load(token);
    if (name) d.name = name;
    save(token, d);
    return delay({
      token, isNew: !existed, onboarded: d.onboarded,
      user: { id: token, name: d.name, phone, benmingColor: d.benmingColor, wechatLinked: true },
    });
  },

  async wechatLogin(code: string, nickname?: string, avatarUrl?: string): Promise<LoginResult> {
    const key = code.replace(/[^\w-]/g, '').slice(0, 40) || 'dev';
    const token = `mock-wx-${key}`;
    const existed = !!Taro.getStorageSync(dataKey(token));
    const d = load(token);
    if (nickname) d.name = nickname;
    if (avatarUrl) d.avatarUrl = avatarUrl;
    d.wechatLinked = true;
    save(token, d);
    return delay({
      token, isNew: !existed, onboarded: d.onboarded,
      user: { id: token, name: d.name, phone: '', benmingColor: d.benmingColor, avatarUrl: d.avatarUrl ?? null, wechatLinked: true },
    });
  },

  // 绑定手机号（演示）：①微信一键 phoneCode → 派生稳定手机号；②短信 phone+code 校验。
  async bindPhone(phone?: string, code?: string, phoneCode?: string): Promise<{ ok: boolean; phone: string; wechatLinked: boolean }> {
    const { token, d } = current();
    let finalPhone: string;
    if (phoneCode) {
      let h = 0;
      for (let i = 0; i < phoneCode.length; i++) h = (h * 31 + phoneCode.charCodeAt(i)) >>> 0;
      finalPhone = ('1' + String(3_900_000_000 + (h % 90_000_000)).padStart(10, '0')).slice(0, 11);
    } else {
      if (!phone || !code) throw Object.assign(new Error('请提供手机号与验证码'), { code: 'BIND_PARAMS_MISSING' });
      const expect = mockSmsCodes[phone] ?? '888888';
      if (code !== expect) throw Object.assign(new Error('验证码错误或已过期'), { code: 'SMS_CODE_INVALID' });
      delete mockSmsCodes[phone];
      finalPhone = phone;
    }
    d.phone = finalPhone;
    save(token, d);
    return delay({ ok: true, phone: finalPhone, wechatLinked: !!d.wechatLinked });
  },

  // 上传头像（演示）：无 OSS，直接把传入的本地路径当作头像链接回显。
  async uploadAvatar(filePath: string): Promise<{ ok: boolean; avatarUrl: string }> {
    const { token, d } = current();
    d.avatarUrl = filePath;
    save(token, d);
    return delay({ ok: true, avatarUrl: filePath });
  },

  async me(): Promise<Me> {
    const { d } = current();
    const plan = PLANS.find((p) => p.id === d.planId) ?? PLANS[1];
    return delay({
      user: { id: getToken(), name: d.name, role: 'owner', benmingColor: d.benmingColor, avatarUrl: d.avatarUrl ?? null, phone: /^1\d{10}$/.test(d.phone) ? d.phone : '', wechatLinked: !!d.wechatLinked },
      tenant: { id: `t-${d.phone}`, name: d.company, industry: d.profile?.industry ?? null, stage: d.profile?.stage ?? null },
      plan: plan ? { name: plan.name, creditsPerMonth: plan.creditsPerMonth, tokenQuotaPerMonth: plan.tokenQuotaPerMonth } : null,
      creditBalance: d.creditBalance,
      tokenQuota: mockQuota(d),
      planStatus: { active: true, expired: false, expiresAt: null, daysRemaining: null, nextResetAt: new Date(Date.now() + 30 * 86400000).toISOString() },
      onboarded: d.onboarded,
      ai: { provider: 'mock', model: 'template', ready: false, claudeReady: false },
      understanding: buildUnderstandingM(d),
      inviteCode: 'JS2026',
      service: { teacherName: '林老师', teacherWechat: 'lin_junshi_03', className: '上海 3 班', groupQrUrl: '', taskDone: 4, taskTotal: 6, note: '负责资料确认和入群任务' },
      features: { fortune: true }, // P0-2：mock 默认开命理，本地/H5 可完整走查
    });
  },

  async updateIdentity(body: { name?: string; company?: string; avatarUrl?: string }): Promise<{ ok: boolean; name?: string; company?: string; avatarUrl?: string }> {
    const { token, d } = current();
    if (typeof body.name === 'string') d.name = body.name.trim().slice(0, 20);
    if (typeof body.company === 'string') d.company = body.company.trim().slice(0, 40);
    if (typeof body.avatarUrl === 'string') d.avatarUrl = body.avatarUrl.trim().slice(0, 500);
    save(token, d);
    return delay({ ok: true, name: d.name, company: d.company, avatarUrl: d.avatarUrl });
  },

  async deleteAccount(): Promise<{ ok: boolean }> {
    const { token } = current();
    try { Taro.removeStorageSync(dataKey(token)); } catch { /* noop */ }
    return delay({ ok: true });
  },

  async plans(): Promise<Plan[]> { return delay(PLANS); },

  // mock 模式无真实微信支付：抛 PAYMENT_NOT_CONFIGURED 让前端回退演示发放（purchasePlan）。
  async createOrder(_id: string): Promise<never> {
    await delay(null);
    throw Object.assign(new Error('微信支付未配置（mock）'), { code: 'PAYMENT_NOT_CONFIGURED' });
  },

  async myCredits(): Promise<MyCreditsView> {
    const { d } = current();
    return delay({ items: [...(d.creditLog ?? [])].reverse() });
  },

  async purchasePlan(id: string): Promise<PlanPurchaseResult> {
    const { token, d } = current();
    const plan = PLANS.find((p) => p.id === id);
    if (!plan) throw Object.assign(new Error('套餐不存在'), { code: 'PLAN_NOT_FOUND' });
    const grantedCredits = plan.creditsPerMonth < 0 ? 0 : plan.creditsPerMonth;
    d.planId = plan.id;
    d.creditBalance = plan.creditsPerMonth < 0 ? -1 : (d.creditBalance < 0 ? grantedCredits : d.creditBalance + grantedCredits);
    d.tokenUsed = 0; // 套餐授予/重置当月 token 额度
    (d.creditLog ??= []).push({ at: now(), reason: `${plan.name} · 套餐购买`, delta: grantedCredits, balance: d.creditBalance });
    save(token, d);
    return delay({ ok: true, plan, creditBalance: d.creditBalance, grantedCredits, grantedTokens: plan.tokenQuotaPerMonth });
  },

  // V7-12：单次付费商品目录 + 假支付成功流（mock 直接发放权益并记备注流水）。
  async skus(): Promise<SkuView[]> {
    return delay(SKUS.map((s) => ({ key: s.key, name: s.name, desc: s.desc, priceFen: s.priceFen, kind: s.kind, grantsModuleKey: s.grantsModuleKey ?? null })));
  },
  async createSkuOrder(key: string): Promise<SkuOrderResult> {
    const { token, d } = current();
    const sku = SKUS.find((s) => s.key === key);
    if (!sku) throw Object.assign(new Error('商品不存在'), { code: 'SKU_NOT_FOUND' });
    if (sku.kind === 'module' && sku.grantsModuleKey) {
      d.ownedModules ??= [];
      if (!d.ownedModules.includes(sku.grantsModuleKey)) d.ownedModules.push(sku.grantsModuleKey);
    } else if (sku.kind === 'service') {
      d.skuServices ??= [];
      if (!d.skuServices.includes(sku.key)) d.skuServices.push(sku.key);
    }
    (d.creditLog ??= []).push({ at: now(), reason: `${sku.name} · 微信支付`, delta: 0, balance: d.creditBalance });
    save(token, d);
    return delay({ orderId: uid('sku-'), demo: true });
  },

  // V7-04：三势刷新 + 认可判断一键生成（mock 确定性）。
  async refreshForces(): Promise<{ forces: BattleForce[] }> {
    const { token, d } = current();
    d.battleForces = DEFAULT_BATTLE_FORCES;
    save(token, d);
    return delay({ forces: DEFAULT_BATTLE_FORCES });
  },
  async battleCommit(): Promise<BattleCommitResult> {
    const { token, d } = current();
    const today = now().slice(0, 10);
    const already = d.battleCommittedDate === today;
    d.battleCommittedDate = today;
    save(token, d);
    return delay({ reportId: 'mock-battle-report', reportSlug: 'battle', version: 1, libraryId: null, newOrders: already ? 0 : 3, alreadyDone: already });
  },

  // V7-07 数据源
  async getDataSources(): Promise<DataSourcesView> {
    const { d } = current();
    const st = d.dataSourceStatus ?? {};
    const sources: DataSourceView[] = MOCK_DATA_SOURCES.map((s) => {
      const status = (st[s.key] ?? 'unbound') as DataSourceStatus;
      return { key: s.key, label: s.label, desc: s.desc, icon: s.icon, scope: s.scope, tier: s.tier, status, statusLabel: dsLabel(status, s.tier) };
    });
    const bound = sources.filter((s) => s.status === 'bound').length;
    const needed = sources.filter((s) => s.status === 'unbound' && s.tier === 'basic').length;
    return delay({ bound, needed, total: MOCK_DATA_SOURCES.length, sources });
  },
  async uploadDataSource(key: string): Promise<DataSourcesView> {
    const { token, d } = current();
    (d.dataSourceStatus ??= {})[key] = 'uploaded'; save(token, d);
    return this.getDataSources();
  },
  async requestDataSourceAuth(key: string): Promise<DataSourcesView> {
    const { token, d } = current();
    (d.dataSourceStatus ??= {})[key] = 'auth_requested'; save(token, d);
    return this.getDataSources();
  },

  // V7-08 模块
  async modules(): Promise<ModulesView> {
    const { d } = current();
    const owned = new Set(d.ownedModules ?? []);
    const state = d.moduleState ?? {};
    const build = (m: Omit<ModuleView, 'enabled' | 'hidden' | 'sortOrder'>, i: number): ModuleView => ({
      ...m, enabled: m.tier === 'free' || owned.has(m.key), hidden: !!state[m.key]?.hidden,
      sortOrder: state[m.key]?.sortOrder ?? i,
      stateLabel: (m.tier === 'free' || owned.has(m.key)) ? '已启用' : m.stateLabel,
    });
    const modules = MOCK_MODULES.map(build).sort((a, b) => a.sortOrder - b.sortOrder);
    const rec = MOCK_MODULES.find((m) => m.key === 'growth');
    return delay({ recommended: rec ? build(rec, 3) : null, modules });
  },
  async enableModule(key: string): Promise<ModuleView> {
    const { token, d } = current();
    const m = MOCK_MODULES.find((x) => x.key === key);
    if (!m) throw Object.assign(new Error('能力不存在'), { code: 'MODULE_NOT_FOUND' });
    d.ownedModules ??= [];
    if (m.tier === 'credits') {
      const cost = m.price?.credits ?? 0;
      if (d.creditBalance >= 0 && d.creditBalance < cost) throw Object.assign(new Error('算力不足'), { code: 'INSUFFICIENT_CREDITS', data: { code: 'INSUFFICIENT_CREDITS' } });
      if (d.creditBalance >= 0) d.creditBalance -= cost;
    } else if (m.tier === 'sku') {
      const skuKey = MOCK_SKU_MODULE_KEY[key] ?? key;
      // 已购判定接受：模块自身 key / grantsModuleKey（createSkuOrder 发放的即 grantsModuleKey）/ 一次性服务凭据。
      const purchased = d.ownedModules.includes(key) || d.ownedModules.includes(skuKey) || (d.skuServices ?? []).includes(skuKey);
      if (!purchased) throw Object.assign(new Error('需先购买'), { code: 'SKU_REQUIRED', data: { code: 'SKU_REQUIRED', skuKey } });
    }
    if (!d.ownedModules.includes(key)) d.ownedModules.push(key);
    save(token, d);
    const list = await this.modules();
    return list.modules.find((x) => x.key === key)!;
  },
  async patchModule(key: string, body: { hidden?: boolean; sortOrder?: number }): Promise<ModuleView> {
    const { token, d } = current();
    (d.moduleState ??= {})[key] = { ...(d.moduleState[key] ?? {}), ...body }; save(token, d);
    const list = await this.modules();
    return list.modules.find((x) => x.key === key)!;
  },

  // V7-11 提醒
  reminders(): Promise<ReminderView> {
    return Promise.resolve({
      items: [
        { key: 'order', time: '18:00', title: '今日军令截止', desc: '18:00 前补充高意向咨询记录。', kind: 'order', subscribed: false },
        { key: 'review', time: '21:30', title: '今日复盘', desc: '21:30 生成今日复盘。', kind: 'review', subscribed: false },
        { key: 'weekly', time: '周五', title: '周复盘', desc: '本周五检查成交漏斗和内容表现。', kind: 'weekly', subscribed: false },
      ],
      subscribeReady: false,
    });
  },

  // V7-13 档案工作台
  async workbench(): Promise<WorkbenchView> {
    const und = buildUnderstandingM(current().d);
    const done = und.maturity === 'ready' ? 85 : und.maturity === 'forming' ? 55 : 20;
    return delay({
      completeness: done,
      sections: [
        { key: 'founder', label: '老板档案', hint: '目标、优势、表达风格', count: 7, ready: true },
        { key: 'company', label: '企业档案', hint: '组织结构、发展历程、核心产品', count: 8, ready: true },
        { key: 'product', label: '产品服务', hint: '价格体系、交付流程、客户画像', count: 0, ready: false },
        { key: 'finance', label: '财务经营', hint: '预算表、现金流、利润估算', count: 0, ready: false },
      ],
      missing: (und.nextQuestions.length ? und.nextQuestions.slice(0, 3).map((q, i) => ({ key: `q${i}`, title: q, desc: '补齐后会刷新战局判断。' })) : [
        { key: 'pricing', title: '产品价格体系', desc: '影响方案报价、成交判断和复购建议。' },
        { key: 'funnel', title: '近 30 天成交漏斗表', desc: '战局页会用它判断卡点和优先级。' },
        { key: 'proof', title: '案例结果与客户反馈', desc: '用于生成信任证明和内容选题。' },
      ]),
    });
  },

  // V7-14 跨域搜索
  async search(q: string): Promise<SearchResult> {
    const query = q.trim(); if (!query) return delay({ q: '', hits: [] });
    const ql = query.toLowerCase();
    const { d } = current();
    const hits: SearchHit[] = [];
    DEFAULT_AGENTS.filter((a) => a.name.toLowerCase().includes(ql) || a.role.toLowerCase().includes(ql)).slice(0, 5)
      .forEach((a) => hits.push({ kind: 'agent', id: a.key, title: a.name, snippet: a.role, route: `/packages/main/chat/index?agentKey=${a.key}&fresh=1` }));
    d.sessions.filter((s) => s.title.toLowerCase().includes(ql)).slice(0, 5)
      .forEach((s) => hits.push({ kind: 'session', id: s.id, title: s.title, snippet: s.title, route: `/packages/main/chat/index?sessionId=${s.id}` }));
    d.reports.filter((r) => r.title.toLowerCase().includes(ql)).slice(0, 5)
      .forEach((r) => hits.push({ kind: 'report', id: r.id, title: r.title, snippet: r.type, route: `/packages/work/report/index?id=${r.id}` }));
    d.knowledge.filter((k) => (k.stage ?? 'confirmed') === 'confirmed' && (k.title ?? k.text ?? '').toLowerCase().includes(ql)).slice(0, 5)
      .forEach((k) => hits.push({ kind: 'knowledge', id: k.id, title: k.title || k.kind, snippet: (k.text || '').slice(0, 120), route: '/pages/thinktank/index' }));
    return delay({ q: query, hits });
  },

  // V7-06 智库三段式资料整理管道（mock，本地 storage）。
  async uploadKnowledgeStaged(staged?: boolean, batchId?: string): Promise<StagedUploadResult> {
    const { token, d } = current();
    const id = uid('kn-'); const bid = batchId || uid('batch-');
    const stage: KnowledgeStage = staged ? 'staging' : 'confirmed';
    const types = ['表', 'PDF', '图', '文'];
    (d.knowledge ??= []).unshift({ id, projectId: null, kind: 'document', title: `上传资料 ${d.knowledge.length + 1}`, text: '（mock 待整理资料）', sourceType: 'upload', sourceId: null, tags: [], at: now(), stage, batchId: staged ? bid : undefined, fileType: types[d.knowledge.length % types.length], fileSize: 120000, status: staged ? 'ready' : 'ready' });
    save(token, d);
    return delay({ id, status: staged ? 'staging' : 'ready', stage, batchId: staged ? bid : undefined });
  },
  // —— WO-09 经营体检（资料库文档视图 + 详情 + 体检）——
  // 走查用确定性样例：k-fin-demo=财务表(canAnalyze) / k-doc-demo=非财务(无体检入口)。
  async knowledgeDocs(): Promise<KnowledgeDocRow[]> {
    return delay([
      { id: 'k-fin-demo', kind: 'document', title: '3 月经营流水表', sourceType: 'upload', status: 'ready', stage: 'confirmed', fileName: '流水表.xlsx', fileType: 'xlsx', fileSize: 128000, chunkCount: 4, projectId: null, error: null, createdAt: now(), updatedAt: now() },
      { id: 'k-doc-demo', kind: 'document', title: '产品介绍', sourceType: 'upload', status: 'ready', stage: 'confirmed', fileName: '产品介绍.pdf', fileType: 'pdf', fileSize: 96000, chunkCount: 3, projectId: null, error: null, createdAt: now(), updatedAt: now() },
      { id: 'k-staging-demo', kind: 'document', title: '客户名单', sourceType: 'upload', status: 'parsing', stage: 'staging', fileName: '客户名单.csv', fileType: 'csv', fileSize: 24000, chunkCount: 0, projectId: null, error: null, createdAt: now(), updatedAt: now() },
    ]);
  },
  // F7：mock 从 reject 改为返回可用空壳；id 含 'fin' 视作财务/经营表 → canAnalyze=true。
  async knowledgeDetail(id: string): Promise<KnowledgeDetail> {
    const financial = /fin/i.test(id);
    const preview = financial
      ? '月份,收入,成本,毛利\n1月,128000,86000,42000\n2月,143500,92000,51500\n3月,161200,98400,62800'
      : '（示例）本资料为产品介绍/说明类内容，非财务经营表，不参与经营体检。';
    return delay({
      id,
      kind: 'document',
      title: financial ? '3 月经营流水表' : '产品介绍',
      sourceType: 'upload',
      status: 'ready',
      fileName: financial ? '流水表.xlsx' : '产品介绍.pdf',
      fileType: financial ? 'xlsx' : 'pdf',
      fileSize: financial ? 128000 : 96000,
      projectId: null,
      error: null,
      createdAt: now(),
      updatedAt: now(),
      textPreview: preview,
      chunks: preview.split('\n').map((t, i) => ({ id: `${id}-c${i}`, ord: i, text: t, dim: 1024 })),
      canAnalyze: financial,
    });
  },
  // 确定性体检：本地生成/归一一份「经营体检」报告，返回 reportId 供报告详情页解析（可反复调用不重复建版）。
  async analyzeKnowledge(_id: string): Promise<AnalyzeResult> {
    const { token, d } = current();
    const content: Deliverable = {
      title: '经营体检 · 3 月流水',
      icon: 'chart',
      meta: '军师财务复盘',
      trust: '毛利率企稳在 38% 上下、现金流为正，但获客成本正在吃掉利润，一个月内要把复购拉起来。',
      sections: [
        { h: '账面判断', b: '3 个月收入稳步上行（12.8w → 16.1w），毛利率 33% → 39%，定价与成本控制在改善。' },
        { h: '三个隐患', list: ['获客成本占收入 18%，偏高', '现金回款周期 45 天，压流动性', '单一大客户贡献四成收入，集中度风险'] },
        { h: '军师给的三条军令', list: ['把回款周期压到 30 天内（预收/账期条款）', '开 2 个新获客渠道，摊薄获客成本', '给腰部客户做复购方案，降集中度'] },
      ],
      actions: ['同步为军令'],
    };
    const saved = saveReportVersionLocal(d, { title: content.title, type: '经营体检', agentKey: 'general', projectId: null, content, authorKind: 'agent' });
    save(token, d);
    return delay({ reportId: saved.reportId, version: saved.version });
  },
  async knowledgePipeline(): Promise<KnowledgePipelineView> {
    const { token, d } = current();
    // 演示：首次进入注入一个待整理批次（3 份，含 1 份 failed + 1 份重复），保证全动线可走查。
    if (!d.knowledgeSeeded) {
      d.knowledgeSeeded = true;
      const bid = 'batch-demo';
      const mk = (title: string, size: number, status: string, text: string): KnowledgeRec => ({
        id: uid('kn-'), projectId: null, kind: 'document', title, text, sourceType: 'upload', sourceId: null,
        tags: [], at: now(), stage: 'staging', batchId: bid, fileType: (title.split('.').pop() || '文'), fileSize: size, status,
      });
      (d.knowledge ??= []).unshift(
        mk('月度经营流水.xlsx', 128000, 'ready', '财务 营收 成本 现金 流水'),
        mk('月度经营流水.xlsx', 128000, 'ready', '财务 营收 成本 现金 流水'),
        mk('损坏的扫描件.pdf', 90000, 'failed', '扫描件'),
      );
      save(token, d);
    }
    const items = d.knowledge ?? [];
    const by = (st: KnowledgeStage) => items.filter((k) => (k.stage ?? 'confirmed') === st);
    const confirmed = by('confirmed');
    const confirmedFolders: KnowledgePipelineFolder[] = Object.keys(BIZ_LABEL)
      .map((key) => ({ key, label: BIZ_LABEL[key], count: confirmed.filter((k) => k.bizCategory === key).length, stage: 'confirmed' as KnowledgeStage }))
      .filter((f) => f.count > 0);
    const optimized = by('optimized');
    const optimizedFolders: KnowledgePipelineFolder[] = [...new Set(optimized.map((k) => k.bizCategory || 'unknown'))]
      .map((key) => ({ key, label: BIZ_LABEL[key] || key, count: optimized.filter((k) => (k.bizCategory || 'unknown') === key).length, stage: 'optimized' as KnowledgeStage }));
    const optimizedItems: OrganizeItem[] = optimized.map((k) => ({
      id: k.id, fileName: k.title || '未命名', category: BIZ_LABEL[k.bizCategory || 'unknown'] || '待识别',
      summary: k.summary || mockSummary(k.bizCategory || 'unknown'), isDup: !!k.dupOfId,
    }));
    const staging = by('staging');
    const batchMap = new Map<string, KnowledgeRec[]>();
    staging.forEach((k) => { const b = k.batchId || 'default'; batchMap.set(b, [...(batchMap.get(b) ?? []), k]); });
    const batches: KnowledgeBatch[] = [...batchMap.entries()].map(([id, ks]) => {
      const tm = new Map<string, number>(); ks.forEach((k) => tm.set(k.fileType || '文', (tm.get(k.fileType || '文') ?? 0) + 1));
      const files: KnowledgeBatchFile[] = ks.map((k) => ({ id: k.id, fileName: k.title || '未命名', status: k.status || 'ready', fileSize: k.fileSize ?? null }));
      return { id, count: ks.length, status: 'uploaded' as const, typeStats: [...tm.entries()].map(([label, count]) => ({ label, count })), files };
    });
    const usedBytes = items.reduce((sum, k) => sum + (k.fileSize ?? 0), 0);
    return delay({
      counts: { staging: staging.length, optimized: optimized.length, confirmed: confirmed.length },
      quota: { usedDocs: staging.length + confirmed.length, freeDocs: 30, usedBytes, freeBytes: 200 * 1024 * 1024 },
      folders: [...confirmedFolders, ...optimizedFolders], batches, optimizedItems,
    });
  },
  async organizeBatch(batchId: string): Promise<OrganizeResult> {
    const { token, d } = current();
    // 解析失败的文件不参与整理（留在待整理区，提示删除重传）。
    const items = (d.knowledge ?? []).filter((k) => k.batchId === batchId && (k.stage ?? 'confirmed') === 'staging' && k.status !== 'failed');
    let dedup = 0; const seen = new Map<string, string>();
    items.forEach((k) => {
      const key = `${k.title}|${k.fileSize}`;
      if (seen.has(key)) { k.dupOfId = seen.get(key)!; dedup++; } else seen.set(key, k.title || k.id);
      k.bizCategory = classifyMock(k.title || k.text); k.summary = mockSummary(k.bizCategory); k.stage = 'optimized';
    });
    save(token, d);
    const folders: KnowledgePipelineFolder[] = [...new Set(items.map((k) => k.bizCategory!))]
      .map((key) => ({ key, label: BIZ_LABEL[key] || key, count: items.filter((k) => k.bizCategory === key).length, stage: 'optimized' as KnowledgeStage }));
    const orgItems: OrganizeItem[] = items.map((k) => ({
      id: k.id, fileName: k.title || '未命名', category: BIZ_LABEL[k.bizCategory || 'unknown'] || '待识别',
      summary: k.summary || mockSummary(k.bizCategory || 'unknown'), isDup: !!k.dupOfId,
    }));
    return delay({ batchId, status: 'organized', total: items.length, dedup, folders, items: orgItems });
  },
  async confirmKnowledge(body: { ids?: string[]; batchId?: string }): Promise<ConfirmResult> {
    const { token, d } = current();
    const items = (d.knowledge ?? []).filter((k) => (body.ids ? body.ids.includes(k.id) : k.batchId === body.batchId) && (k.stage === 'staging' || k.stage === 'optimized'));
    items.forEach((k) => { k.stage = 'confirmed'; });
    save(token, d);
    return delay({ count: items.length, ingested: items.length, ids: items.map((k) => k.id) });
  },
  async deepOrganize(batchId: string): Promise<OrganizeResult> {
    const { d } = current();
    if (!(d.skuServices ?? []).includes('deep-organize')) throw Object.assign(new Error('需购买深度整理'), { code: 'SKU_REQUIRED', data: { code: 'SKU_REQUIRED', skuKey: 'deep-organize' } });
    const r = await this.organizeBatch(batchId);
    // 深度整理额外产出一份《资料整理报告》，回传 reportId 供前端跳方案详情。
    const { token, d: d2 } = current();
    const content: Deliverable = {
      title: '资料整理报告', icon: 'doc', meta: '军师深度整理',
      trust: `本批共 ${r.total} 份，去重 ${r.dedup} 份，已按经营口径归类并提炼要点。`,
      sections: [
        { h: '归类结果', list: r.items.map((it) => `${it.fileName} → ${it.category}${it.isDup ? '（重复已合并）' : ''}`) },
        { h: '提炼要点', list: r.items.filter((it) => !it.isDup).map((it) => `${it.fileName}：${it.summary}`) },
        { h: '下一步', b: '确认入库后，这批资料即可被战局、方案与后续对话直接调用。' },
      ],
      actions: ['确认入库'],
    };
    const saved = saveReportVersionLocal(d2, { title: content.title, type: '资料整理', agentKey: 'general', projectId: null, content, authorKind: 'agent' });
    save(token, d2);
    return { ...r, deep: true, reportId: saved.reportId, reportVersion: saved.version };
  },

  async setColor(color: string) {
    const { token, d } = current();
    d.benmingColor = color; save(token, d);
    return delay({ ok: true });
  },

  async agents(): Promise<Agent[]> {
    const owned = new Set(current().d.ownedAgents ?? []);
    return delay(DEFAULT_AGENTS.map((a) => ({ ...a, owned: a.billing !== 'unlock' || owned.has(a.key) })));
  },

  async purchaseAgent(key: string): Promise<AgentPurchaseResult> {
    const { token, d } = current();
    const agent = DEFAULT_AGENTS.find((a) => a.key === key);
    if (!agent) throw Object.assign(new Error('智能体不存在'), { code: 'AGENT_NOT_FOUND' });
    if (agent.billing !== 'unlock') throw Object.assign(new Error('该智能体无需额外启用'), { code: 'AGENT_NOT_PURCHASABLE' });
    d.ownedAgents ??= [];
    if (d.ownedAgents.includes(key)) {
      return delay({ ok: true, agentKey: key, pricePaid: 0, creditBalance: d.creditBalance, alreadyOwned: true });
    }
    const unlimited = d.creditBalance < 0;
    if (!unlimited && d.creditBalance < agent.price) {
      throw Object.assign(new Error('权益点不足，无法启用该智能体'), { code: 'INSUFFICIENT_CREDITS', data: { code: 'INSUFFICIENT_CREDITS' } });
    }
    d.ownedAgents.push(key);
    if (!unlimited) {
      d.creditBalance -= agent.price;
      (d.creditLog ??= []).push({ at: now(), reason: `解锁智能体 · ${agent.name}`, delta: -agent.price, balance: d.creditBalance });
    }
    save(token, d);
    return delay({ ok: true, agentKey: key, pricePaid: unlimited ? 0 : agent.price, creditBalance: d.creditBalance, alreadyOwned: false });
  },
  async survey(): Promise<SurveyQuestion[]> { return delay(SURVEY); },

  // WO-07：journey 视图（mock 按档案是否建档给出 new / diagnosing 的确定性下一步）。
  async journey(): Promise<JourneyView> {
    const { d } = current();
    if (!d.profile?.industry) {
      return delay({ stage: 'new', diagRound: 0, nextStep: { key: 'quickscan', title: '先做个 3 问速诊', desc: '10 分钟拿到主要矛盾与今天能做的一件事。', route: '/packages/work/quickscan/index' } });
    }
    return delay({ stage: 'diagnosing', diagRound: 2, nextStep: { key: 'continue_diagnosis', title: '继续第 3 轮诊断', desc: '把打法聊定，认可后自动拆成军令。', route: 'chat' } });
  },

  // WO-12：处方样例（军令页展示「军师配了工具」）。
  async prescriptions(): Promise<PrescriptionListView> {
    return delay({ items: [{ id: 'rx1', problem: '获客越来越贵', playbook: '做影响力短视频获客', toolKey: 'brand', toolType: 'agent', externalUrl: null, status: 'proposed', proposedAt: '2026-07-08 10:00' }] });
  },
  async prescriptionAction(_id: string, _action: string): Promise<{ ok: boolean }> { return delay({ ok: true }); },

  // WO-13：品牌资产包（mock 确定性样例；generate 返回一份，approve 置已确认）。
  async brandKit(): Promise<BrandKitView | null> { return delay(null); },
  async generateBrandKit(): Promise<BrandKitView> {
    return delay({
      persona: { name: '老张', tagline: '美业里最懂一线的操盘手', tone: '实在、有分寸、不画饼', story: '从一线做起，靠口碑把生意做扎实。', doNots: ['不吹牛', '不承诺做不到的效果'] },
      voice: { hooks: ['同行不会告诉你的一件事', '我踩过的那个坑'], openers: ['先说结论', '今天只讲一件事'], ctas: ['想聊聊就扣 1', '私信「诊断」'], taboos: ['低俗', '攻击同行'] },
      theme: { keywords: ['务实', '专业', '接地气'], colorHint: '深绿 + 暖金', styleRefs: ['纪实口播', '干货白板'] },
      version: 1, approved: false, generatedAt: '2026-07-08 10:00',
    });
  },
  async approveBrandKit(): Promise<{ ok: boolean }> { return delay({ ok: true }); },

  // 速诊（WO-06）：确定性初诊卡 + 速诊即建档（空则回填 industry/stage/pain，同服务端口径）。
  async quickScan(req: QuickScanRequest): Promise<QuickScanResult> {
    const { token, d } = current();
    d.profile = {
      ...d.profile,
      industry: d.profile?.industry || req.industry,
      stage: d.profile?.stage || req.revenueBand,
      pain: d.profile?.pain || req.pain,
    };
    d.onboarded = true; save(token, d);
    const pain = (req.pain || '').trim().slice(0, 40) || '增长乏力';
    return delay({
      contradiction: `你把力气压在「${pain}」的表象上，真正卡住的是获客与复购的结构没打通。`,
      judgement: `${req.industry}·${req.revenueBand}这个体量，"${pain}"多半是结果不是原因。先把「谁来、为什么复购、一单挣多少」三笔账摊开，矛盾会自己浮出来。`,
      firstMove: '今天挑近 30 天成交的 10 位客户，逐个打电话问「为什么选你、还会不会再来」，记成一页纸。',
      cardUrl: null,
    });
  },

  async getProfile(): Promise<Profile | null> { return delay(current().d.profile); },
  async saveProfile(p: Profile): Promise<Profile> {
    const { token, d } = current();
    d.profile = { ...d.profile, ...p }; d.onboarded = true; save(token, d);
    return delay(d.profile);
  },

  // 八字采集（mock）：存偏好 + 返回一份**确定性样例命盘**（固定假数据，非真排盘——真排盘是服务端引擎的职责）。
  // 有样例盘后，天时日历/战局天势卡/送你一卦等命理 UI 在本地 mock/H5 下可完整走查（修 review 铁律③「mock 命盘恒空」）。
  async saveBazi(body: object): Promise<{ believe: boolean; chart: ChartSummary | null }> {
    const { token, d } = current();
    (d as { bazi?: object }).bazi = body; save(token, d);
    const believe = (body as { believe?: boolean }).believe !== false;
    return delay({ believe, chart: believe ? sampleChartM() : null });
  },
  async myChart(): Promise<{ bazi: object | null; chart: ChartSummary | null }> {
    const bazi = (current().d as { bazi?: { believe?: boolean } }).bazi ?? null;
    const chart = bazi && bazi.believe !== false ? sampleChartM() : null;
    return delay({ bazi, chart });
  },
  // 送你一卦预览（mock：给确定性样例卡文本，不排盘不落库——让画卡/分享链路可本地走查）
  async fateCardPreview(body: { friendName?: string; consent?: boolean }): Promise<{ friendName: string; subtitle: string; sketch: string; trend: string; advice: string }> {
    const name = (body.friendName || '').trim();
    const yr = new Date().getFullYear();
    return delay({
      friendName: name,
      subtitle: `${name ? `赠与 ${name}` : '命鉴'} · 1990-06-18 生`,
      sketch: '正财格——务实稳健、重信守诺，善守成不喜冒进。命宫 紫微、天府。',
      trend: `今年${yr}：3月、6月、9月是你的进攻窗口；7月、11月记得收着打。`,
      advice: '你的打法在「稳扎稳打、深耕存量」，别碰「盲目扩张」。',
    });
  },

  async todaySaying(): Promise<TodaySaying> {
    const n = new Date();
    const doy = Math.floor((n.getTime() - new Date(n.getFullYear(), 0, 0).getTime()) / 86400000);
    return delay({ text: SAYINGS[doy % SAYINGS.length], date: `${n.getMonth() + 1}月${n.getDate()}日` });
  },

  async sessions(): Promise<SessionItem[]> {
    const { d } = current();
    return delay(
      [...d.sessions].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((s) => {
        const last = s.messages[s.messages.length - 1];
        let snippet = '新对话';
        if (last) { const c = last.content as any; snippet = c.text || (c.title ? `已产出《${c.title}》` : '已回复'); }
        const ag = agentOf(s.agentKey);
        const unreadCount = s.messages.filter((m) => m.role === 'assistant').length; // V7-15：mock 无读态，按 assistant 消息数派生
        return { id: s.id, agentKey: s.agentKey, agentName: ag.name, agentIcon: ag.icon, title: s.title, snippet, updatedAt: s.updatedAt, projectId: s.projectId, unreadCount, hasUnread: unreadCount > 0 };
      }),
    );
  },

  async session(id: string): Promise<SessionDetail> {
    const { d } = current();
    const s = d.sessions.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error('session not found'), { code: 'NOT_FOUND' });
    const ag = agentOf(s.agentKey);
    return delay({
      id: s.id, agentKey: s.agentKey,
      agent: { key: ag.key, name: ag.name, role: ag.role, icon: ag.icon, greet: ag.greet, chips: ag.chips, memText: ag.memText, learnText: ag.learnText },
      title: s.title, projectId: s.projectId, messages: s.messages,
    });
  },

  async deleteSession(id: string) {
    const { token, d } = current();
    d.sessions = d.sessions.filter((s) => s.id !== id); save(token, d);
    return delay({ ok: true });
  },

  async generate(body: GenRequest): Promise<GenResult> {
    const { token, d } = current();
    const text = (body.text || '').trim();
    let session = body.sessionId ? d.sessions.find((s) => s.id === body.sessionId) : undefined;
    const agentKey = session?.agentKey ?? body.agentKey ?? agentForText(text);
    const ag = agentOf(agentKey);
    // 项目归属：已有会话优先，否则用入参（校验存在）
    const projectId = session?.projectId ?? (body.projectId && d.projects.some((p) => p.id === body.projectId) ? body.projectId : null);

    let created = false;
    if (!session) {
      session = { id: uid('s-'), agentKey: ag.key, projectId, title: text.slice(0, 18) || '新对话', createdAt: now(), updatedAt: now(), messages: [] };
      d.sessions.push(session); created = true;
    } else {
      if (session.title === '新对话') session.title = text.slice(0, 18);
      if (!session.projectId && projectId) session.projectId = projectId;
    }
    session.messages.push({ id: uid('m-'), role: 'user', content: { text }, at: now(), refs: body.refs });

    // 引用解析 + 知识召回（让 mock 也能体现「引用生效」）
    const { labels, notes } = resolveRefs(d, body.refs, text, projectId);
    const refSec = notes.slice(0, 4).map((n) => n.replace(/^【[^】]*】/, '').slice(0, 60));
    const projName = projectId ? d.projects.find((p) => p.id === projectId)?.name : undefined;

    let res: GenResult;
    if (wantsBriefInterviewM(text) || needsInputM(d, text, body.refs, projectId)) {
      const reply = {
        text: '好，我先问清楚，再给判断。你不用写长文，按下面几个问题简单答就行。',
        points: inputQuestionsM(d),
        acts: [['spark', '开始补档案']] as [string, string][],
      };
      const msg: SessionMessage = { id: uid('m-'), role: 'assistant', content: reply, at: now() };
      session.messages.push(msg);
      res = { sessionId: session.id, created, agentKey: ag.key, kind: 'chat', messageId: msg.id, reply, knowledgeUsed: labels, creditBalance: d.creditBalance };
    } else if (ag.deliverableKey) {
      ensureMockQuota(d); // 文本产出：本月 token 额度足够才放行
      const deliverable = buildDeliverable(ag.deliverableKey, d);
      if (projName) deliverable.meta = `${deliverable.meta} · ${projName}`;
      if (refSec.length) deliverable.sections.push({ h: '参考依据', list: refSec });
      const msg: SessionMessage = { id: uid('m-'), role: 'report', content: deliverable, at: now() };
      session.messages.push(msg);
      res = {
        sessionId: session.id, created, agentKey: ag.key, kind: 'report', messageId: msg.id,
        deliverable, memory: ag.key !== 'general' ? { learned: true, agentName: ag.name } : null,
        knowledgeUsed: labels,
      };
      res.tokenQuota = chargeMockQuota(d, ag.billingRatio, text.length, JSON.stringify(deliverable).length);
      res.creditBalance = d.creditBalance;
    } else {
      ensureMockQuota(d); // 对话也走 token 额度
      const r = REPLIES['默认'];
      const points = refSec.length ? [...r.points, `已参考：${refSec.join('；')}`] : r.points;
      const reply = { text: r.t, points, acts: r.acts };
      const msg: SessionMessage = { id: uid('m-'), role: 'assistant', content: reply, at: now() };
      session.messages.push(msg);
      res = { sessionId: session.id, created, agentKey: ag.key, kind: 'chat', messageId: msg.id, reply, knowledgeUsed: labels };
      res.tokenQuota = chargeMockQuota(d, ag.billingRatio, text.length, JSON.stringify(reply).length);
      res.creditBalance = d.creditBalance;
    }
    session.updatedAt = now();
    save(token, d);
    return delay(res, 420);
  },

  async library(): Promise<LibItem[]> {
    const { d } = current();
    return delay([...d.library].sort((a, b) => (a.at < b.at ? 1 : -1)));
  },

  async saveToLibrary(body: SaveLibRequest): Promise<{ id: string; at: string; reportId?: string; version?: number }> {
    const { token, d } = current();
    const ag = agentOf(body.agentKey);
    const sess = body.sessionId ? d.sessions.find((s) => s.id === body.sessionId) : undefined;
    const projectId = body.projectId ?? sess?.projectId ?? null;
    // 桥接：存库即写一版版本化报告
    const saved = saveReportVersionLocal(d, {
      title: body.title, type: body.type, agentKey: body.agentKey, projectId,
      content: body.content as Deliverable, authorKind: 'user', sessionId: body.sessionId ?? null,
    });
    const item: LibItem = {
      id: uid('d-'), title: body.title, type: body.type, agentKey: body.agentKey, agentName: ag.name,
      sessionId: body.sessionId ?? null, content: body.content as Deliverable, at: now(),
      reportId: saved.reportId, version: saved.version, projectId,
    };
    d.library.unshift(item); save(token, d);
    return delay({ id: item.id, at: item.at, reportId: saved.reportId, version: saved.version });
  },

  // —— 项目 ——
  async projects(): Promise<ProjectItem[]> {
    const { d } = current();
    return delay([...d.projects].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((p) => projItem(d, p)));
  },
  async project(id: string): Promise<ProjectDetail> {
    const { d } = current();
    const p = d.projects.find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('project not found'), { code: 'NOT_FOUND' });
    const sessions: SessionItem[] = d.sessions.filter((s) => s.projectId === id).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map((s) => {
      const last = s.messages[s.messages.length - 1]; let snippet = '新对话';
      if (last) { const c = last.content as any; snippet = c.text || (c.title ? `已产出《${c.title}》` : '已回复'); }
      const a = agentOf(s.agentKey);
      return { id: s.id, agentKey: s.agentKey, agentName: a.name, agentIcon: a.icon, title: s.title, snippet, updatedAt: s.updatedAt, projectId: s.projectId };
    });
    return delay({
      ...projItem(d, p),
      sessions,
      reports: d.reports.filter((r) => r.projectId === id).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map(reportItem),
      knowledge: d.knowledge.filter((k) => k.projectId === id).map(knItem),
    });
  },
  async createProject(body: CreateProjectRequest): Promise<{ id: string; name: string; slug: string }> {
    const { token, d } = current();
    let slug = slugify(body.name);
    if (d.projects.some((p) => p.slug === slug)) slug = `${slug}-${Date.now().toString(36).slice(-4)}`;
    const p: ProjectRec = { id: uid('p-'), name: body.name, slug, icon: body.icon || 'layers', summary: body.summary ?? null, status: 'active', createdAt: now(), updatedAt: now() };
    d.projects.unshift(p); save(token, d);
    return delay({ id: p.id, name: p.name, slug: p.slug });
  },
  async updateProject(id: string, body: UpdateProjectRequest): Promise<{ ok: boolean }> {
    const { token, d } = current();
    const p = d.projects.find((x) => x.id === id);
    if (p) {
      if (body.name) { p.name = body.name; p.slug = slugify(body.name); }
      if (body.icon) p.icon = body.icon;
      if (body.summary !== undefined) p.summary = body.summary;
      if (body.status) p.status = body.status;
      p.updatedAt = now(); save(token, d);
    }
    return delay({ ok: true });
  },
  async deleteProject(id: string): Promise<{ ok: boolean }> {
    const { token, d } = current();
    d.projects = d.projects.filter((p) => p.id !== id);
    d.sessions.forEach((s) => { if (s.projectId === id) s.projectId = null; });
    d.reports.forEach((r) => { if (r.projectId === id) r.projectId = null; });
    d.knowledge.forEach((k) => { if (k.projectId === id) k.projectId = null; });
    save(token, d);
    return delay({ ok: true });
  },

  // —— 版本化报告 ——
  async reports(projectId?: string): Promise<ReportItem[]> {
    const { d } = current();
    return delay(d.reports.filter((r) => !projectId || r.projectId === projectId).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).map(reportItem));
  },
  async report(id: string): Promise<ReportDetail> {
    const { d } = current();
    const r = d.reports.find((x) => x.id === id);
    if (!r) throw Object.assign(new Error('report not found'), { code: 'NOT_FOUND' });
    return delay({
      ...reportItem(r),
      versions: [...r.versions].sort((a, b) => b.version - a.version).map((v) => ({ id: v.id, version: v.version, title: v.title, changeSummary: v.changeSummary, authorKind: v.authorKind, sessionId: v.sessionId, at: v.at })),
    });
  },
  async reportVersion(id: string, v?: number): Promise<ReportVersionContent> {
    const { d } = current();
    const r = d.reports.find((x) => x.id === id);
    if (!r) throw Object.assign(new Error('report not found'), { code: 'NOT_FOUND' });
    const ver = v ? r.versions.find((x) => x.version === v) : r.versions[r.versions.length - 1];
    if (!ver) throw Object.assign(new Error('version not found'), { code: 'NOT_FOUND' });
    return delay({ reportId: r.id, version: ver.version, title: ver.title, content: ver.content, at: ver.at });
  },
  async reportDiff(id: string, from: number, to: number): Promise<ReportDiff> {
    const { d } = current();
    const r = d.reports.find((x) => x.id === id);
    if (!r) throw Object.assign(new Error('report not found'), { code: 'NOT_FOUND' });
    const vFrom = r.versions.find((x) => x.version === from), vTo = r.versions.find((x) => x.version === to);
    if (!vFrom || !vTo) throw Object.assign(new Error('version not found'), { code: 'NOT_FOUND' });
    const dd = diffSections(vFrom.content as object, vTo.content as object);
    return delay({ reportId: id, from, to, title: { before: dd.titleBefore, after: dd.titleAfter }, sections: dd.sections, summary: dd.summary });
  },
  async saveReport(body: SaveReportRequest): Promise<SaveReportResult> {
    const { token, d } = current();
    const saved = saveReportVersionLocal(d, { title: body.title, type: body.type || '成果', agentKey: body.agentKey ?? null, projectId: body.projectId ?? null, content: body.content as Deliverable, authorKind: body.authorKind ?? 'user', sessionId: body.sessionId ?? null });
    save(token, d);
    return delay({ reportId: saved.reportId, version: saved.version, created: saved.created, changed: saved.changed });
  },

  // —— 知识库 ——
  async knowledge(projectId?: string, kind?: string): Promise<KnowledgeItemT[]> {
    const { d } = current();
    return delay(d.knowledge.filter((k) => (!projectId || k.projectId === projectId) && (!kind || k.kind === kind)).map(knItem));
  },
  // P1-C3：mock 不维护长期记忆，返回空列表（@记忆 候选在 mock 下为空，server 模式走真实 /memories）。
  async memories(): Promise<MemoryCandidate[]> {
    return delay([]);
  },
  async deleteMemory(): Promise<{ ok: boolean }> {
    return delay({ ok: true });
  },
  // —— 账本闭环（F-8/P-2）——
  async progress(): Promise<{ progress: ProgressView | null }> {
    const { token } = current();
    const l = loadLedgerM(token);
    const ds = decStatsM(l.decisions), ps = proStatsM(l.prophecies);
    return delay({
      progress: {
        rank: '尉官', usageDays: 16, streak: 15,
        decisionAccuracy: ds.accuracy, prophecyHitRate: ps.hitRate,
        milestones: { '7': '2026-07-01', '14': '2026-07-08' },
        nextRank: { rank: '校官', requirement: '连续复盘 30 天 + 完成首次月度战报' },
      },
    });
  },
  async decisions(): Promise<DecisionLedger> {
    const { token } = current(); const l = loadLedgerM(token); saveLedgerM(token, l);
    return delay({ items: l.decisions, stats: decStatsM(l.decisions) });
  },
  async verifyDecision(id: string, outcome: 'correct' | 'revise'): Promise<{ decision: DecisionView; stats: DecisionStats }> {
    const { token } = current(); const l = loadLedgerM(token);
    const it = l.decisions.find((x) => x.id === id); if (it) it.status = outcome;
    saveLedgerM(token, l);
    return delay({ decision: it ?? l.decisions[0], stats: decStatsM(l.decisions) });
  },
  async prophecies(): Promise<ProphecyLedger> {
    const { token } = current(); const l = loadLedgerM(token); saveLedgerM(token, l);
    return delay({ items: l.prophecies, stats: proStatsM(l.prophecies) });
  },
  async verifyProphecy(id: string, outcome: 'hit' | 'miss'): Promise<{ prophecy: ProphecyView; stats: ProphecyStats }> {
    const { token } = current(); const l = loadLedgerM(token);
    const it = l.prophecies.find((x) => x.id === id); if (it) it.status = outcome;
    saveLedgerM(token, l);
    return delay({ prophecy: it ?? l.prophecies[0], stats: proStatsM(l.prophecies) });
  },
  // WO-11 账本异议：把用户「有出入」的反馈落到条目（复盘时军师据此对账）。
  async disputeDecision(id: string, dispute: string): Promise<{ ok: boolean }> {
    const { token } = current(); const l = loadLedgerM(token);
    const it = l.decisions.find((x) => x.id === id); if (it) (it as DecisionView & { disputeNote?: string }).disputeNote = dispute.trim().slice(0, 500);
    saveLedgerM(token, l);
    return delay({ ok: !!it });
  },
  async disputeProphecy(id: string, dispute: string): Promise<{ ok: boolean }> {
    const { token } = current(); const l = loadLedgerM(token);
    const it = l.prophecies.find((x) => x.id === id); if (it) (it as ProphecyView & { disputeNote?: string }).disputeNote = dispute.trim().slice(0, 500);
    saveLedgerM(token, l);
    return delay({ ok: !!it });
  },
  // WO-10 经营周报：模板 / 序列 / 上报某周。mock 固定美业模板，序列本地持久化。
  async bizMetricTemplate(): Promise<{ items: BizMetricTemplateItem[] }> {
    return delay({ items: BIZ_TEMPLATE_BEAUTY });
  },
  async bizMetricSeries(weeks = 8): Promise<{ items: BizMetricWeek[] }> {
    const { token } = current();
    const all = loadBizSeriesM(token).slice().sort((a, b) => a.weekStart.localeCompare(b.weekStart));
    return delay({ items: all.slice(-weeks) });
  },
  async saveBizMetrics(weekStart: string, metrics: Record<string, number>): Promise<{ ok: boolean }> {
    const { token } = current();
    const all = loadBizSeriesM(token);
    const idx = all.findIndex((w) => w.weekStart === weekStart);
    if (idx >= 0) all[idx] = { weekStart, metrics };
    else all.push({ weekStart, metrics });
    saveBizSeriesM(token, all);
    return delay({ ok: true });
  },
  // 军师记忆库（P2）：从 mock 用户数据合成六类结构化记忆，让档案页「军师记事」本地可走查。
  async memoryLibrary(): Promise<MemoryLibraryView> {
    const { d } = current();
    const mk = (id: string, text: string, source = 'conversation'): MemoryLibraryEntry => ({ id, text, source });
    const founder: MemoryLibraryEntry[] = [];
    const company: MemoryLibraryEntry[] = [];
    const status: MemoryLibraryEntry[] = [];
    const vision: MemoryLibraryEntry[] = [];
    const strategy: MemoryLibraryEntry[] = [];
    const rapport: MemoryLibraryEntry[] = [];
    if (meaningfulM(d.name)) founder.push(mk('mk-name', `你的称呼：${d.name}`));
    extraLinesM(d.profile?.extra).slice(0, 3).forEach((l, i) => founder.push(mk(`mk-ex${i}`, l)));
    if (meaningfulM(d.company)) company.push(mk('mk-co', `公司/品牌：${d.company}`));
    if (d.profile?.industry) company.push(mk('mk-ind', `行业：${d.profile.industry}`));
    if (d.profile?.stage) company.push(mk('mk-stage', `发展阶段：${d.profile.stage}`));
    d.projects.slice(0, 2).forEach((p, i) => company.push(mk(`mk-pj${i}`, p.summary ? `项目《${p.name}》：${p.summary}` : `项目《${p.name}》推进中`)));
    if (d.profile?.pain) status.push(mk('mk-pain', `当前最卡：${d.profile.pain}`));
    const und = buildUnderstandingM(d);
    if (und.mainContradiction) strategy.push({ id: 'sp-mc', text: und.mainContradiction, source: 'strategic' });
    if (und.positioning) strategy.push({ id: 'sp-pos', text: `战略定位：${und.positioning}`, source: 'strategic' });
    const raw: Record<MemoryCategoryKey, MemoryLibraryEntry[]> = { founder, company, status, vision, strategy, rapport };
    const fillOf = (n: number, settled: boolean): MemoryFillLevel => (settled ? 'settled' : n === 0 ? 'unknown' : n >= 3 ? 'known' : 'thin');
    const order: MemoryCategoryKey[] = ['founder', 'company', 'status', 'vision', 'strategy', 'rapport'];
    const groups: MemoryLibraryGroup[] = order.map((c) => ({
      category: c,
      entries: raw[c],
      fill: fillOf(raw[c].length, c === 'strategy' && raw[c].some((e) => e.source === 'strategic')),
    }));
    const total = order.reduce((s, c) => s + raw[c].length, 0);
    return delay({ total, groups, updatedAt: new Date().toISOString() });
  },
  // 完整履历（P3）：读缓存（未生成 → null）
  async dossier(): Promise<DossierView> {
    const { token } = current();
    try {
      const raw = Taro.getStorageSync(`mock.dossier.${token}`);
      if (raw) { const r = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DossierReport; return delay({ report: r, generatedAt: r.generatedAt }); }
    } catch { /* noop */ }
    return delay({ report: null, generatedAt: null });
  },
  // 完整履历（P3）：生成一份 grounded、专业咨询风的示例档案并缓存
  async generateDossier(): Promise<{ report: DossierReport; generatedAt: string }> {
    const { token, d } = current();
    const name = meaningfulM(d.name) || '创始人';
    const co = meaningfulM(d.company) || '你的公司';
    const ind = d.profile?.industry || '所在行业';
    const stage = d.profile?.stage || '当前阶段';
    const pain = d.profile?.pain || '获客成本高、复购上不去';
    const sec = (key: string, no: string, label: string, eyebrow: string, blocks: DossierBlock[]): DossierSection => ({ key, no, label, eyebrow, blocks });
    const sections: DossierSection[] = [
      sec('identity', '01', '身份定义', 'IDENTITY', [
        { type: 'para', text: `${name}，${co}创始人，深耕${ind}，企业处于${stage}。` },
        { type: 'highlight', title: '一句话定位', text: `扎在社区、靠复购立身的${ind}品牌——不打价格战，打信任和回头率。`, tone: 'gold' },
        { type: 'para', text: '从一线做起，懂手艺也懂人心；决策偏快、重情义，扩张期需要有人替你踩刹车。' },
      ]),
      sec('story', '02', '创业历程', 'THE STORY', [
        { type: 'para', text: `2015 年从一名技师起步，第一家店开在社区里，靠口碑和回头客一步步站稳。` },
        { type: 'timeline', items: [
          { time: '2015', title: '单店起家', desc: '一家社区店，手艺+口碑立身' },
          { time: '2021', title: '三店连锁', desc: '直营模式跑通，团队扩到 18 人' },
          { time: '2023', title: '试水加盟', desc: '一年开 5 家又收回 2 家，认识到标准化是命门' },
        ] },
      ]),
      sec('company', '03', '企业全景', 'THE BUSINESS', [
        { type: 'para', text: `${co}：${ind}，${stage}，3 家直营、团队 18 人。营收结构以到店服务为主，办卡+复购为利润引擎。` },
        { type: 'stats', items: [
          { value: '3 家', label: '直营门店' },
          { value: '18 人', label: '团队规模' },
          { value: '≈60万', label: '月流水(自报)' },
        ] },
        { type: 'para', text: '优势在服务体验与私域粘性；短板在获客过度依赖投放、复购缺乏系统化运营。' },
      ]),
      sec('status', '04', '现状与主要矛盾', 'CURRENT STATE', [
        { type: 'highlight', title: '主要矛盾', text: pain + '——先把复购做起来，再谈开疆。', tone: 'red' },
        { type: 'para', text: '获客成本一年涨约四成，新客拉来却留不住；问题不在前端流量，在后端的客户经营与复购设计。' },
      ]),
      sec('strategy', '05', '战略打法', 'STRATEGY', [
        { type: 'para', text: '打法一句话：收缩战线、做深复购。把有限的营销预算从"拉新"挪一半到"养客"。' },
        { type: 'para', text: '主攻赛道：社区高复购的轻医美小店，用会员分层 + 私域运营把 LTV 拉起来。' },
        { type: 'quote', text: '不打价格战，打信任战。' },
      ]),
      sec('vision', '06', '目标愿景', 'VISION', [
        { type: 'para', text: '想做成「街坊最放心的那一家」——这条愿景还需要与军师聊透，落成可执行的三年目标。' },
      ]),
    ];
    const believe = true; // mock 演示恒显天势段；真实端由 believe 开关 + 命理总开关(P-3) 决定
    if (believe) sections.push(sec('tianshi', String(sections.length + 1).padStart(2, '0'), '天势档案', 'CELESTIAL', [
      { type: 'stats', items: [ { value: '乙丑', label: '年柱' }, { value: '戊寅', label: '月柱' }, { value: '辛未', label: '日柱' }, { value: '己亥', label: '时柱' } ] },
      { type: 'para', text: '日主辛金、身弱见印——适合精细化、口碑型经营，不宜粗放烧钱扩张。今年宜守中求进、把根基做扎实。' },
    ]));
    sections.push(sec('letter', String(sections.length + 1).padStart(2, '0'), '军师寄语', 'A NOTE', [
      { type: 'para', text: `${name}，你缺的从来不是客源，是把客留住的系统。先咬住复购这一件事，其余动作都围绕它排布。别急着开第四家店，先让现有三家的老客活跃起来。` },
    ]));
    const report: DossierReport = {
      name,
      headline: `扎在社区、靠复购立身的${ind}品牌`,
      verse: '守得客心三尺暖，何愁门前客不还',
      sections,
      generatedAt: new Date().toISOString(),
    };
    try { Taro.setStorageSync(`mock.dossier.${token}`, JSON.stringify(report)); } catch { /* noop */ }
    return delay({ report, generatedAt: report.generatedAt });
  },
  async knowledgeSearch(q: string, projectId?: string): Promise<KnowledgeHit[]> {
    const { d } = current();
    if (!q.trim()) return delay([]);
    return delay(
      d.knowledge.filter((k) => !projectId || k.projectId === projectId)
        .map((k) => ({ item: knItem(k), score: Number(keywordScore(q, `${k.title ?? ''} ${k.text}`).toFixed(4)), snippet: k.text.slice(0, 120) }))
        .filter((h) => h.score > 0).sort((a, b) => b.score - a.score).slice(0, 8),
    );
  },
  async createKnowledge(body: CreateKnowledgeRequest): Promise<KnowledgeItemT> {
    const { token, d } = current();
    const rec = ingestKnowledgeLocal(d, { kind: body.kind ?? 'document', title: body.title ?? null, text: body.text, projectId: body.projectId ?? null, sourceType: body.sourceType ?? 'manual', sourceId: body.sourceId ?? null, tags: body.tags ?? [] });
    save(token, d);
    return delay(knItem(rec));
  },
  async deleteKnowledge(id: string): Promise<{ ok: boolean }> {
    const { token, d } = current();
    d.knowledge = d.knowledge.filter((k) => k.id !== id); save(token, d);
    return delay({ ok: true });
  },

  // —— 对话汇总 ——
  async summarize(sessionId: string): Promise<SummarizeResult> {
    const { token, d } = current();
    const s = d.sessions.find((x) => x.id === sessionId);
    if (!s) throw Object.assign(new Error('session not found'), { code: 'NOT_FOUND' });
    const ag = agentOf(s.agentKey);
    const userPoints: string[] = [], reportTitles: string[] = [], replyPoints: string[] = [];
    for (const m of s.messages) {
      const c = m.content as any;
      if (m.role === 'user' && c.text) userPoints.push(String(c.text).slice(0, 60));
      else if (m.role === 'report' && c.title) reportTitles.push(c.title);
      else if (m.role === 'assistant') { if (c.text) replyPoints.push(String(c.text).slice(0, 60)); (c.points ?? []).forEach((p: string) => replyPoints.push(p)); }
    }
    const sections: DeliverableSection[] = [{ h: '讨论要点', list: (userPoints.length ? userPoints : ['（本次对话内容较少）']).slice(0, 6) }];
    if (reportTitles.length) sections.push({ h: '本次产出', list: reportTitles.map((t) => `已产出《${t}》`).slice(0, 6) });
    sections.push({ h: '关键结论', list: (replyPoints.length ? replyPoints : ['顾问已给出阶段性判断，详见对话原文。']).slice(0, 6) });
    sections.push({ h: '待办与决策', b: '将上述结论中需要跟进的事项纳入案卷推进；重大决策请结合专业意见。' });
    const deliverable: Deliverable = { title: `《${s.title}》对话纪要`, icon: 'doc', meta: `${ag.name} · 对话汇总`, sections, trust: TRUST_NOTE, actions: ['save_to_library', 'export_pdf'] };
    const saved = saveReportVersionLocal(d, { title: deliverable.title, type: '对话纪要', agentKey: s.agentKey, projectId: s.projectId ?? null, content: deliverable, authorKind: 'agent', sessionId: s.id });
    const insight = sections.flatMap((x) => (x.list ?? []).concat(x.b ? [x.b] : [])).join('；').slice(0, 1000);
    if (insight) ingestKnowledgeLocal(d, { kind: 'insight', title: deliverable.title, text: insight, projectId: s.projectId ?? null, sourceType: 'conversation', sourceId: s.id, tags: [ag.name, '对话纪要'] });
    save(token, d);
    return delay({ reportId: saved.reportId, version: saved.version, title: deliverable.title, knowledgeAdded: insight ? 1 : 0 });
  },
};
