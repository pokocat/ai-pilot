import { prisma } from '../db.js';
import type { ClientUnderstanding, ClientUnderstandingSection } from '../../../shared/contracts';

type UserForUnderstanding = {
  id: string;
  tenantId: string;
  name: string;
  tenant?: { name: string; industry?: string | null; stage?: string | null } | null;
};

const TITLE = '军师档案';
const SUBTITLE = '军师有多了解你的生意';

function clean(v: unknown, max = 120): string {
  return typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

export function isPlaceholderCustomerLabel(v: unknown): boolean {
  const s = clean(v, 40);
  if (!s) return true;
  if (/^(用户|企业|公司|租户)\d+$/.test(s)) return true;
  return ['用户', '企业', '公司', '微信用户', '匿名用户', '未命名', '测试用户', '测试企业'].includes(s);
}

export function meaningfulCustomerLabel(v: unknown, max = 120): string {
  const s = clean(v, max);
  return isPlaceholderCustomerLabel(s) ? '' : s;
}

function pushUnique(list: string[], value: unknown, max = 4) {
  const v = clean(value);
  if (v && !list.includes(v) && list.length < max) list.push(v);
}

function profileExtraLines(extra: unknown): string[] {
  if (!extra || typeof extra !== 'object') return [];
  const out: string[] = [];
  const aliases: Record<string, string> = {
    story: '创业经历',
    journey: '创业路径',
    path: '发展路径',
    founderStory: '创业故事',
    difficulty: '遇到困难',
    goal: '阶段目标',
    创业故事: '创业故事',
    创业路径: '创业路径',
    遇到困难: '遇到困难',
    阶段目标: '阶段目标',
  };
  const entries = Object.entries(extra as Record<string, unknown>);
  for (const [key, value] of entries) {
    const text = clean(value, 160);
    if (!text) continue;
    const label = aliases[key] ?? (/[a-zA-Z]/.test(key) ? '' : key);
    pushUnique(out, label ? `${label}：${text}` : text, 4);
  }
  return out;
}

function section(key: string, title: string, items: string[], emptyText: string): ClientUnderstandingSection {
  return { key, title, items, emptyText };
}

export async function buildClientUnderstanding(user: UserForUnderstanding): Promise<ClientUnderstanding> {
  const now = new Date();
  const tenantPromise = user.tenant
    ? Promise.resolve(user.tenant)
    : prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { name: true, industry: true, stage: true } });

  const [tenant, profile, memories, projects, knowledge, sessions, reports] = await Promise.all([
    tenantPromise,
    prisma.profile.findFirst({ where: { tenantId: user.tenantId }, orderBy: { updatedAt: 'desc' } }),
    prisma.memory.findMany({
      where: {
        tenantId: user.tenantId,
        userId: user.id,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ weight: 'desc' }, { createdAt: 'desc' }],
      take: 8,
    }),
    prisma.project.findMany({
      where: { tenantId: user.tenantId, userId: user.id, status: 'active' },
      orderBy: { updatedAt: 'desc' },
      take: 4,
    }),
    prisma.knowledgeItem.findMany({
      where: { tenantId: user.tenantId, userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 6,
    }),
    prisma.session.findMany({
      where: { tenantId: user.tenantId, userId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: 4,
    }),
    prisma.reportDoc.findMany({
      where: { tenantId: user.tenantId, userId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: 4,
    }),
  ]);

  const userName = meaningfulCustomerLabel(user.name);
  const tenantName = meaningfulCustomerLabel(tenant?.name);

  const identity: string[] = [];
  pushUnique(identity, userName ? `服务对象：${userName}` : '');
  pushUnique(identity, tenantName ? `企业/品牌：${tenantName}` : '');
  pushUnique(identity, profile?.industry || tenant?.industry ? `行业：${profile?.industry ?? tenant?.industry}` : '');
  pushUnique(identity, profile?.stage || tenant?.stage ? `阶段：${profile?.stage ?? tenant?.stage}` : '');

  const journey = profileExtraLines(profile?.extraJson);
  for (const p of projects) pushUnique(journey, p.summary ? `项目《${p.name}》：${p.summary}` : `项目《${p.name}》正在推进`, 5);
  for (const s of sessions) pushUnique(journey, `近期讨论：${s.title}`, 5);

  const difficulties: string[] = [];
  pushUnique(difficulties, profile?.pain ? `当前最关注：${profile.pain}` : '');
  for (const m of memories) {
    if (/(难|痛点|问题|压力|瓶颈|现金流|增长|融资|组织|竞争|客户|获客|转化|利润)/.test(m.text)) {
      pushUnique(difficulties, m.text, 5);
    }
  }
  for (const k of knowledge) {
    if (/(todo|decision|insight)/i.test(k.kind)) pushUnique(difficulties, k.title ? `${k.title}：${k.text}` : k.text, 5);
  }

  const materials: string[] = [];
  for (const m of memories) pushUnique(materials, m.text, 6);
  for (const k of knowledge) pushUnique(materials, k.title ? `资料《${k.title}》` : k.text, 6);
  for (const r of reports) pushUnique(materials, `报告《${r.title}》v${r.currentVersion}`, 6);

  const nextQuestions: string[] = [];
  if (!userName) nextQuestions.push('以后军师怎么称呼你？');
  if (!tenantName) nextQuestions.push('你的公司、门店或品牌叫什么？');
  if (!profile?.industry) nextQuestions.push('你现在主要做哪个行业或品类？');
  if (!profile?.stage) nextQuestions.push('业务处在起步、增长、规模化还是稳定经营阶段？');
  if (!profile?.pain) nextQuestions.push('这段时间最卡你的经营问题是什么？');
  if (!journey.length) nextQuestions.push('你是怎么开始这门生意的，中间经历过哪几个关键转折？');

  const evidenceCount = {
    profile: profile ? 1 : 0,
    memories: memories.length,
    projects: projects.length,
    knowledge: knowledge.length,
    sessions: sessions.length,
  };
  const evidenceTotal = evidenceCount.profile + evidenceCount.memories + evidenceCount.projects + evidenceCount.knowledge + evidenceCount.sessions;
  const maturity = evidenceTotal === 0 && !identity.length ? 'empty' : nextQuestions.length > 2 ? 'forming' : 'ready';
  const summary = maturity === 'empty'
    ? '军师还没有足够资料形成判断。补齐基本情况后，后续建议会优先依据你的真实业务来推演。'
    : maturity === 'forming'
      ? `军师已掌握 ${evidenceTotal} 条经营线索，能做初步判断；关键背景仍需继续补齐，避免替你假设业务事实。`
      : `军师已沉淀 ${evidenceTotal} 条经营线索，可作为后续咨询、复盘和方案产出的底稿。`;

  const updatedAtCandidates = [
    profile?.updatedAt,
    ...memories.map((m) => m.createdAt),
    ...projects.map((p) => p.updatedAt),
    ...knowledge.map((k) => k.createdAt),
    ...sessions.map((s) => s.updatedAt),
  ].filter(Boolean) as Date[];
  const updatedAt = updatedAtCandidates.length
    ? new Date(Math.max(...updatedAtCandidates.map((d) => d.getTime()))).toISOString()
    : null;

  return {
    title: TITLE,
    subtitle: SUBTITLE,
    maturity,
    summary,
    sections: [
      section('identity', '经营身份', identity, '还没记录你的称呼、公司、行业和阶段。'),
      section('journey', '创业路径', journey, '还没形成创业路径。可以告诉军师：你怎么开始、做过哪些转折、现在走到哪一步。'),
      section('difficulties', '当前难题', difficulties, '还没记录明确难题。后续咨询会先追问关键约束，再给建议。'),
      section('materials', '已沉淀资料', materials, '还没有长期线索。对话、项目、报告和知识库都会逐步沉淀到这里。'),
    ],
    nextQuestions: nextQuestions.slice(0, 4),
    evidenceCount,
    updatedAt,
  };
}

export function understandingContextLines(understanding: ClientUnderstanding): string[] {
  const lines = [`${understanding.title}：${understanding.summary}`];
  for (const s of understanding.sections) {
    if (s.items.length) lines.push(`${s.title}：${s.items.join('；')}`);
  }
  if (understanding.nextQuestions.length) lines.push(`待补问题：${understanding.nextQuestions.join('；')}`);
  return lines;
}
