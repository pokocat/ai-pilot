import Taro from '@tarojs/taro';
import type {
  Agent, Me, LoginResult, SurveyQuestion, Profile, TodaySaying,
  SessionItem, SessionDetail, SessionMessage, GenRequest, GenResult,
  Deliverable, DeliverableSection, LibItem, SaveLibRequest,
  ProjectItem, ProjectDetail, CreateProjectRequest, UpdateProjectRequest,
  ReportItem, ReportDetail, ReportVersionContent, ReportDiff, SectionDiff, SaveReportRequest, SaveReportResult,
  KnowledgeItemT, KnowledgeHit, CreateKnowledgeRequest, SummarizeResult, MessageRef, MemoryCandidate,
  Plan, PlanPurchaseResult, AgentPurchaseResult, ClientUnderstanding, AliasSuggestionResult,
  MyCreditItem, MyCreditsView, TokenQuotaView, SmsSendResult,
} from '../../../shared/contracts';
import type { ChartSummary } from './api';
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
        return { id: s.id, agentKey: s.agentKey, agentName: ag.name, agentIcon: ag.icon, title: s.title, snippet, updatedAt: s.updatedAt, projectId: s.projectId };
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
