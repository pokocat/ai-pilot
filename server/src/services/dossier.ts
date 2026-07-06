// 完整履历（P3）：把老板的真实资料蒸馏成一份专业、商务风的「创始人战略档案」。
// 生成即缓存（StrategicProfile.dossierJson）；LLM 产出结构化 DossierReport，无 live provider 时确定性兜底。
// 语气：专业咨询师水准、可用行业术语，按真实数据缩放、不过度拔高；数字只用老板亲述/回填，不推算。

import { prisma } from '../db.js';
import { loadStrategicProfile } from './strategicProfile.js';
import { buildMemoryLibrary } from './memoryLibrary.js';
import { loadChart } from './paipan.js';
import { llmJson } from '../llm/gateway.js';
import type { DossierReport, DossierSection, DossierBlock } from '../../../shared/contracts';

interface DossierInput {
  name: string;
  company: string;
  industry: string | null;
  stage: string | null;
  pain: string | null;
  believe: boolean;
  strategic: Awaited<ReturnType<typeof loadStrategicProfile>>;
  lib: Awaited<ReturnType<typeof buildMemoryLibrary>>;
  projects: { name: string; summary: string | null }[];
  chart: Awaited<ReturnType<typeof loadChart>>;
}

async function gather(userId: string, tenantId: string): Promise<DossierInput> {
  const [user, tenant, profile, strategic, lib, projects] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, industry: true, stage: true } }),
    prisma.profile.findFirst({ where: { tenantId }, orderBy: { updatedAt: 'desc' } }),
    loadStrategicProfile(userId).catch(() => null),
    buildMemoryLibrary(userId),
    prisma.project.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, take: 6, select: { name: true, summary: true } }),
  ]);
  const believe = ((profile?.extraJson as { bazi?: { believe?: boolean } } | null)?.bazi?.believe) !== false;
  const chart = believe ? await loadChart(userId).catch(() => null) : null;
  return {
    name: user?.name?.trim() || '',
    company: tenant?.name?.trim() || '',
    industry: profile?.industry || tenant?.industry || null,
    stage: profile?.stage || tenant?.stage || null,
    pain: profile?.pain || null,
    believe,
    strategic,
    lib,
    projects,
    chart,
  };
}

const CAT_ENTRIES = (input: DossierInput, key: string): string[] =>
  (input.lib.groups.find((g) => g.category === key)?.entries ?? []).map((e) => e.text);

// —— 确定性兜底：从结构化数据直接拼出一份 grounded 履历（无 LLM 时 / 校验失败时） ——
function composeDeterministic(input: DossierInput): DossierReport {
  const sections: DossierSection[] = [];
  const who = [input.company && `${input.company}`, input.industry, input.stage].filter(Boolean).join(' · ');

  // 01 身份定义
  const idBlocks: DossierBlock[] = [];
  idBlocks.push({ type: 'para', text: who ? `${input.name || '这位创始人'}，${who}。` : `${input.name || '这位创始人'}的战略档案。` });
  if (input.strategic?.positioning) idBlocks.push({ type: 'highlight', title: '战略定位', text: input.strategic.positioning, tone: 'gold' });
  CAT_ENTRIES(input, 'founder').slice(0, 4).forEach((t) => idBlocks.push({ type: 'para', text: t }));
  sections.push({ key: 'identity', no: '01', label: '身份定义', eyebrow: 'IDENTITY', blocks: idBlocks });

  // 02 创业历程
  const storyBlocks: DossierBlock[] = [];
  if (input.strategic?.narrative) storyBlocks.push({ type: 'para', text: input.strategic.narrative });
  CAT_ENTRIES(input, 'founder').slice(4).forEach((t) => storyBlocks.push({ type: 'para', text: t }));
  if (storyBlocks.length) sections.push({ key: 'story', no: String(sections.length + 1).padStart(2, '0'), label: '创业历程', eyebrow: 'THE STORY', blocks: storyBlocks });

  // 03 企业全景
  const coBlocks: DossierBlock[] = [];
  CAT_ENTRIES(input, 'company').forEach((t) => coBlocks.push({ type: 'para', text: t }));
  if (input.projects.length) coBlocks.push({ type: 'timeline', items: input.projects.map((p) => ({ time: '在推进', title: p.name, desc: p.summary || '' })) });
  if (coBlocks.length) sections.push({ key: 'company', no: String(sections.length + 1).padStart(2, '0'), label: '企业全景', eyebrow: 'THE BUSINESS', blocks: coBlocks });

  // 04 现状与主要矛盾
  const stBlocks: DossierBlock[] = [];
  if (input.strategic?.mainContradiction) stBlocks.push({ type: 'highlight', title: '主要矛盾', text: input.strategic.mainContradiction, tone: 'red' });
  else if (input.pain) stBlocks.push({ type: 'highlight', title: '当前最卡', text: input.pain, tone: 'red' });
  CAT_ENTRIES(input, 'status').forEach((t) => stBlocks.push({ type: 'para', text: t }));
  if (stBlocks.length) sections.push({ key: 'status', no: String(sections.length + 1).padStart(2, '0'), label: '现状与主要矛盾', eyebrow: 'CURRENT STATE', blocks: stBlocks });

  // 05 战略打法
  const sgBlocks: DossierBlock[] = [];
  if (input.strategic?.track) sgBlocks.push({ type: 'para', text: `主攻赛道：${input.strategic.track}` });
  CAT_ENTRIES(input, 'strategy').filter((t) => !t.startsWith('主要矛盾')).forEach((t) => sgBlocks.push({ type: 'para', text: t }));
  if (sgBlocks.length) sections.push({ key: 'strategy', no: String(sections.length + 1).padStart(2, '0'), label: '战略打法', eyebrow: 'STRATEGY', blocks: sgBlocks });

  // 06 目标愿景
  const vsBlocks: DossierBlock[] = CAT_ENTRIES(input, 'vision').map((t) => ({ type: 'para', text: t }));
  if (vsBlocks.length) sections.push({ key: 'vision', no: String(sections.length + 1).padStart(2, '0'), label: '目标愿景', eyebrow: 'VISION', blocks: vsBlocks });

  // 07 天势档案（命盘开关）
  if (input.believe && input.chart) {
    const p = input.chart.pillars;
    const tsBlocks: DossierBlock[] = [
      { type: 'stats', items: [
        { value: p.year.ganZhi, label: '年柱' },
        { value: p.month.ganZhi, label: '月柱' },
        { value: p.day.ganZhi, label: '日柱' },
        { value: p.time?.ganZhi ?? '—', label: '时柱' },
      ] },
      { type: 'para', text: `日主${input.chart.dayMaster.gan}（${input.chart.dayMaster.element}）· ${input.chart.dayMaster.strength}；格局：${input.chart.pattern.name}。` },
    ];
    sections.push({ key: 'tianshi', no: String(sections.length + 1).padStart(2, '0'), label: '天势档案', eyebrow: 'CELESTIAL', blocks: tsBlocks });
  }

  // 08 军师寄语
  sections.push({
    key: 'letter', no: String(sections.length + 1).padStart(2, '0'), label: '军师寄语', eyebrow: 'A NOTE',
    blocks: [{ type: 'para', text: input.strategic?.mainContradiction
      ? `眼下先咬住一件事：${input.strategic.mainContradiction} 其余动作都围绕它排布，别分散兵力。`
      : '把最卡的那件事说透，军师帮你把打法定下来，再一步步往下走。' }],
  });

  return {
    name: input.name || '创始人',
    headline: input.strategic?.positioning || who || '创始人战略档案',
    verse: input.believe ? (input.strategic?.verse || null) : null,
    sections,
    generatedAt: new Date().toISOString(),
  };
}

// —— LLM 校验/收敛：把模型返回的 JSON 收敛成合法 DossierReport；不合法返回 null 走兜底 ——
const TONES = new Set(['gold', 'purple', 'red', 'blue', 'green']);
function coerceBlocks(raw: unknown): DossierBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: DossierBlock[] = [];
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue;
    const o = b as Record<string, unknown>;
    if (o.type === 'para' && typeof o.text === 'string') out.push({ type: 'para', text: o.text.slice(0, 600) });
    else if (o.type === 'quote' && typeof o.text === 'string') out.push({ type: 'quote', text: o.text.slice(0, 300) });
    else if (o.type === 'highlight' && typeof o.text === 'string') out.push({ type: 'highlight', title: typeof o.title === 'string' ? o.title.slice(0, 40) : undefined, text: o.text.slice(0, 600), tone: TONES.has(o.tone as string) ? (o.tone as 'gold' | 'purple' | 'red' | 'blue' | 'green') : undefined });
    else if (o.type === 'stats' && Array.isArray(o.items)) out.push({ type: 'stats', items: (o.items as unknown[]).filter((i): i is { value: string; label: string } => !!i && typeof (i as { value?: unknown }).value === 'string' && typeof (i as { label?: unknown }).label === 'string').slice(0, 6).map((i) => ({ value: String(i.value).slice(0, 20), label: String(i.label).slice(0, 12) })) });
    else if (o.type === 'timeline' && Array.isArray(o.items)) out.push({ type: 'timeline', items: (o.items as unknown[]).filter((i): i is Record<string, unknown> => !!i && typeof i === 'object').slice(0, 8).map((i) => ({ time: String((i as Record<string, unknown>).time ?? '').slice(0, 24), title: String((i as Record<string, unknown>).title ?? '').slice(0, 40), desc: String((i as Record<string, unknown>).desc ?? '').slice(0, 200) })) });
  }
  return out;
}
function coerceReport(raw: Record<string, unknown>, input: DossierInput): DossierReport | null {
  const rawSecs = raw.sections;
  if (!Array.isArray(rawSecs) || !rawSecs.length) return null;
  const sections: DossierSection[] = [];
  for (const s of rawSecs) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const blocks = coerceBlocks(o.blocks);
    if (!blocks.length || typeof o.label !== 'string') continue;
    // 命盘段：命理关（!believe）时丢弃，尊重开关
    if (o.key === 'tianshi' && !input.believe) continue;
    sections.push({
      key: typeof o.key === 'string' ? o.key.slice(0, 20) : `s${sections.length + 1}`,
      no: String(sections.length + 1).padStart(2, '0'),
      label: o.label.slice(0, 20),
      eyebrow: typeof o.eyebrow === 'string' ? o.eyebrow.slice(0, 24) : undefined,
      blocks,
    });
  }
  if (sections.length < 2) return null;
  return {
    name: input.name || (typeof raw.name === 'string' ? raw.name.slice(0, 20) : '创始人'),
    headline: typeof raw.headline === 'string' ? raw.headline.slice(0, 60) : (input.strategic?.positioning || '创始人战略档案'),
    verse: input.believe && typeof raw.verse === 'string' ? raw.verse.slice(0, 40) : null,
    sections,
    generatedAt: new Date().toISOString(),
  };
}

function buildPrompt(input: DossierInput): { system: string; user: string } {
  const system =
    '你是资深战略咨询顾问（军师参谋部），为一位企业老板撰写一份「创始人战略档案」。' +
    '要求：专业、有洞察、有分量，可用行业术语；**按老板真实资料如实缩放，不夸大不拔高**；' +
    '数字只用资料里出现过的（老板亲述/回填），绝不自行推算或编造任何数据/百分比；避免机械、程序化、AI 腔的表达。\n' +
    '输出 JSON：{"name","headline"(一句话定位),"verse"(可选，仅当提供了命盘),"sections":[{"key","label","eyebrow"(英文小标),' +
    '"blocks":[{"type":"para","text"} | {"type":"highlight","title","text","tone":"gold|red|purple|blue|green"} | ' +
    '{"type":"stats","items":[{"value","label"}]} | {"type":"timeline","items":[{"time","title","desc"}]} | {"type":"quote","text"}]}]}。\n' +
    '建议小节顺序：身份定义 / 创业历程 / 企业全景 / 现状与主要矛盾 / 战略打法 / 目标愿景' +
    (input.believe && input.chart ? ' / 天势档案(key=tianshi，用提供的四柱与格局，措辞含蓄合规)' : '') +
    ' / 军师寄语。资料不足的小节可省略，不要硬编。';
  const lines: string[] = [];
  lines.push(`老板：${input.name || '（未提供）'}｜企业：${input.company || '（未提供）'}｜行业：${input.industry || '（未知）'}｜阶段：${input.stage || '（未知）'}`);
  if (input.pain) lines.push(`当前最卡：${input.pain}`);
  if (input.strategic) {
    if (input.strategic.mainContradiction) lines.push(`主要矛盾（已确认）：${input.strategic.mainContradiction}`);
    if (input.strategic.positioning) lines.push(`战略定位：${input.strategic.positioning}`);
    if (input.strategic.track) lines.push(`聚焦赛道：${input.strategic.track}`);
    if (input.strategic.narrative) lines.push(`命运叙事线：${input.strategic.narrative}`);
  }
  for (const g of input.lib.groups) {
    const es = g.entries.map((e) => e.text);
    if (es.length) lines.push(`【${g.category}】${es.join('；')}`);
  }
  if (input.projects.length) lines.push(`项目：${input.projects.map((p) => `${p.name}${p.summary ? `（${p.summary}）` : ''}`).join('；')}`);
  if (input.believe && input.chart) {
    const p = input.chart.pillars;
    lines.push(`命盘四柱：${p.year.ganZhi} ${p.month.ganZhi} ${p.day.ganZhi} ${p.time?.ganZhi ?? '缺时'}；日主${input.chart.dayMaster.gan}(${input.chart.dayMaster.element})${input.chart.dayMaster.strength}；格局${input.chart.pattern.name}`);
  }
  return { system, user: lines.join('\n') };
}

/** 读缓存履历（从未生成过 report=null）。 */
export async function loadDossier(userId: string): Promise<{ report: DossierReport | null; generatedAt: string | null }> {
  const row = await prisma.strategicProfile.findUnique({ where: { userId }, select: { dossierJson: true, dossierAt: true } });
  return { report: (row?.dossierJson as unknown as DossierReport) ?? null, generatedAt: row?.dossierAt?.toISOString() ?? null };
}

/** 生成并缓存履历（LLM 优先、确定性兜底）。 */
export async function generateDossier(userId: string, tenantId: string): Promise<DossierReport> {
  const input = await gather(userId, tenantId);
  const { system, user } = buildPrompt(input);
  const raw = await llmJson(system, user);
  const report = (raw && coerceReport(raw, input)) || composeDeterministic(input);
  await prisma.strategicProfile.upsert({
    where: { userId },
    update: { dossierJson: report as unknown as object, dossierAt: new Date() },
    create: { tenantId, userId, dossierJson: report as unknown as object, dossierAt: new Date() },
  });
  return report;
}
