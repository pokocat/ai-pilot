// 主动军师 · 入帐对话（Chat-First 重构 · WO-S，取代 Picker 弹层建档）。
// 服务端确定性状态机（不走 LLM——快、稳、文案可雕琢），文案逐字取规格 §3.3（军师语声，禁 AI 腔）。
// 状态机：GREET → ASK_INDUSTRY → ASK_STAGE → ASK_PAIN → ASK_BAZI → ASK_COLOR → FORGE → DONE。
// 答案实时落库（upsertProfileFields / saveUserBazi / User.benmingColor）；全部往来消息落库为 general
// 会话真实 Message，后续 LLM 把入帐问答当正史读。收官异步生成《初见断语》，GET /result 轮询。

import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { resolveUser } from '../services/context.js';
import { recordAudit } from '../services/audit.js';
import { upsertProfileFields, saveUserBazi, type BaziBody } from '../services/profileWrites.js';
import { buildGenContext } from '../services/context.js';
import { generateDeliverable } from '../llm/gateway.js';
import { mockDeliverable } from '../llm/providers/mock.js';
import { saveReportVersion } from '../services/reports.js';
import { notifyReportReady } from '../services/wechatSubscribe.js';
import { loadChart } from '../services/paipan.js';
import type { Deliverable } from '../llm/schema.js';

// —— 类型 ——
type Stage = 'ASK_INDUSTRY' | 'ASK_STAGE' | 'ASK_PAIN' | 'ASK_BAZI' | 'ASK_COLOR' | 'FORGE' | 'DONE';
interface OnboardingMsg {
  text: string;
  choices?: { label: string; value: string }[];
  widget?: 'bazi-form' | 'color-pick';
}
interface OnboardingMarker {
  stage: Stage;
  done?: boolean;
  generating?: boolean;
  reportMessageId?: string;
}

// —— 兜底选项（抄自 app Picker 的 DEFAULT_SURVEY，禁改该文件）——
const DEFAULT_INDUSTRY = ['SaaS / 软件', '电商 / 跨境', '餐饮 / 食品', '美业 / 医美', '大健康 / 养生', '教育 / 培训', '医疗 / 医药', '制造 / 工业', '专业服务 / 咨询', '本地生活服务', '文旅 / 酒店', '房产 / 家居', '消费 / 零售', '其他'];
const DEFAULT_PAIN = ['增长乏力', '现金流', '融资', '组织 / 团队', '定位 / 竞争'];
const STAGE_CHOICES = ['尚在筹备', '刚开张，未见利', '有进项，起伏不定', '站稳了，想再上一层'];
const COLOR_LABELS: Record<string, string> = { green: '墨绿', gold: '财金', red: '朱砂', blue: '黛蓝', purple: '绛紫', iron: '玄铁' };

async function surveyOptions(key: 'industry' | 'pain', fallback: string[]): Promise<string[]> {
  const q = await prisma.surveyQuestion.findFirst({ where: { key, enabled: true } });
  const opts = Array.isArray(q?.optionsJson) ? (q!.optionsJson as unknown[]).filter((v): v is string => typeof v === 'string') : [];
  return opts.length ? opts : fallback;
}

// —— 文案（规格 §3.3，逐字）——
const GREET_1 = (name: string) => `${name}，坐。既入此帐，往后你的局，我与你一同看。`;
const GREET_2 = '开局不必长谈——答我几问，我便知该如何辅佐你。';
const TXT: Record<Exclude<Stage, 'DONE'>, string> = {
  ASK_INDUSTRY: '先说营生。你如今做的，是哪一路生意？',
  ASK_STAGE: '知道了。这一路走到哪一步了？',
  ASK_PAIN: '最要紧的一问：眼下最让你夜里睡不安稳的，是哪一桩？',
  ASK_BAZI: '还有一问，答不答随你。留个生辰，我能多看一层天时——何时宜攻，何时宜守。不信这一套，也不碍事。',
  ASK_COLOR: '最后一桩。择一色，作你的帅旗——往后帐中器物，皆随此色。',
  FORGE: '够了。情报虽薄，已可落笔。容我片刻，为你写下第一道《初见断语》——你我初见，我眼中你的局。',
};
const DONE_TEXT = '断语在此，收好。往后你每多告诉我一分，我便多看准一分。有事直说；无事，我也会寻你。';

function choicesOf(options: string[], freeLabel: string): { label: string; value: string }[] {
  return [...options.map((o) => ({ label: o, value: o })), { label: freeLabel, value: '__free__' }];
}

// 给定 stage 生成待显示的军师消息（ASK_INDUSTRY 前置 GREET 两条）。
async function messagesFor(stage: Stage, name: string): Promise<OnboardingMsg[]> {
  switch (stage) {
    case 'ASK_INDUSTRY': {
      const opts = await surveyOptions('industry', DEFAULT_INDUSTRY);
      return [
        { text: GREET_1(name) },
        { text: GREET_2 },
        { text: TXT.ASK_INDUSTRY, choices: choicesOf(opts, '其他，我自己说') },
      ];
    }
    case 'ASK_STAGE':
      return [{ text: TXT.ASK_STAGE, choices: STAGE_CHOICES.map((o) => ({ label: o, value: o })) }];
    case 'ASK_PAIN': {
      const opts = await surveyOptions('pain', DEFAULT_PAIN);
      return [{ text: TXT.ASK_PAIN, choices: choicesOf(opts, '一言难尽，我自己说') }];
    }
    case 'ASK_BAZI':
      return [{ text: TXT.ASK_BAZI, widget: 'bazi-form', choices: [{ label: '不看这层', value: '__skip__' }] }];
    case 'ASK_COLOR':
      return [{ text: TXT.ASK_COLOR, widget: 'color-pick' }];
    case 'FORGE':
      return [{ text: TXT.FORGE }];
    case 'DONE':
      return [];
  }
}

// —— 进度标记（存 Profile.extraJson.onboarding，与 bazi 等并存，不覆盖）——
function readMarker(extraJson: unknown): OnboardingMarker | null {
  if (!extraJson || typeof extraJson !== 'object') return null;
  const o = (extraJson as Record<string, unknown>).onboarding;
  if (!o || typeof o !== 'object') return null;
  const stage = (o as OnboardingMarker).stage;
  if (typeof stage !== 'string') return null;
  return o as OnboardingMarker;
}

async function writeMarker(tenantId: string, patch: OnboardingMarker): Promise<void> {
  const p = await prisma.profile.findFirst({ where: { tenantId } });
  if (!p) return; // 无 Profile 行时无处可存（industry 未答）——此前不写标记，靠「无 Profile → ASK_INDUSTRY」推断
  const extra = { ...((p.extraJson as object) ?? {}), onboarding: patch };
  await prisma.profile.update({ where: { id: p.id }, data: { extraJson: extra as unknown as Prisma.InputJsonValue } });
}

// 断点续答：由 Profile 行 + 标记推断当前待答 stage。
async function resolveStage(tenantId: string): Promise<Stage> {
  const p = await prisma.profile.findFirst({ where: { tenantId } });
  if (!p) return 'ASK_INDUSTRY';                 // 全新用户
  const m = readMarker(p.extraJson);
  if (!m) return 'DONE';                          // 老用户走过旧 Picker（有 Profile 无入帐标记）→ 不再入帐
  if (m.done) return 'DONE';
  return m.stage;
}

// —— general 会话（入帐问答落库处）——
async function ensureGeneralSession(user: { id: string; tenantId: string }): Promise<{ id: string }> {
  const existing = await prisma.session.findFirst({
    where: { userId: user.id, agentKey: 'general' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (existing) return existing;
  return prisma.session.create({
    data: { tenantId: user.tenantId, userId: user.id, agentKey: 'general', title: '入帐' },
    select: { id: true },
  });
}

// 幂等落库某 stage 的军师消息（按 onbStage 去重，避免重复 GET/advance 造成重复消息）。
async function deliverStage(sessionId: string, stage: Stage, name: string): Promise<void> {
  const already = await prisma.message.count({
    where: { sessionId, role: 'assistant', contentJson: { path: ['onbStage'], equals: stage } },
  });
  if (already > 0) return;
  const msgs = await messagesFor(stage, name);
  for (const m of msgs) {
    await prisma.message.create({
      data: { sessionId, role: 'assistant', contentJson: { ...m, onbStage: stage } as Prisma.InputJsonValue },
    });
  }
}

async function recordUserAnswer(sessionId: string, text: string): Promise<void> {
  if (!text.trim()) return;
  await prisma.message.create({ data: { sessionId, role: 'user', contentJson: { text } as Prisma.InputJsonValue } });
}

// —— FORGE：异步生成《初见断语》——
const forging = new Set<string>(); // 进程内 in-flight 去重

async function runForge(user: { id: string; tenantId: string; name: string }, sessionId: string): Promise<void> {
  if (forging.has(user.id)) return;
  forging.add(user.id);
  try {
    let deliverable: Deliverable;
    const { ctx } = await buildGenContext({
      userId: user.id,
      tenantId: user.tenantId,
      agentKey: 'general',
      userMessage: '出一份《初见断语》',
      sessionId,
    });
    ctx.deliverableKey = 'first-read';
    try {
      const { result } = await generateDeliverable(ctx, { tenantId: user.tenantId, userId: user.id, sessionId, agentKey: 'general', ratio: 1 });
      deliverable = result;
    } catch (err) {
      console.error('[onboarding] forge deliverable fallback to deterministic:', (err as Error).message);
      deliverable = mockDeliverable(ctx); // 确定性兜底：用已采集档案拼一份
    }

    // 天势一眼：无盘 / 不信命理 → 去掉该段（规格 §3.4）
    const profile = await prisma.profile.findFirst({ where: { tenantId: user.tenantId }, orderBy: { updatedAt: 'desc' } });
    const believe = ((profile?.extraJson as { bazi?: { believe?: boolean } } | null)?.bazi?.believe) !== false;
    const chart = believe ? await loadChart(user.id).catch(() => null) : null;
    if (!believe || !chart) {
      deliverable = { ...deliverable, sections: deliverable.sections.filter((s) => !/天势/.test(s.h)) };
    }

    // 照抄 sessions.ts 落库模式：report Message + saveReportVersion + notifyReportReady
    const msg = await prisma.message.create({ data: { sessionId, role: 'report', contentJson: deliverable as unknown as Prisma.InputJsonValue } });
    await saveReportVersion({
      tenantId: user.tenantId, userId: user.id, projectId: null,
      title: deliverable.title, type: '初见断语', agentKey: 'general',
      content: deliverable as object, authorKind: 'agent', sessionId,
    }).catch((e) => console.error('[onboarding] saveReportVersion failed:', (e as Error).message));
    notifyReportReady({ tenantId: user.tenantId, userId: user.id, title: deliverable.title });

    // 报告卡出现后追一条 DONE 收束
    await prisma.message.create({ data: { sessionId, role: 'assistant', contentJson: { text: DONE_TEXT, onbStage: 'DONE' } as Prisma.InputJsonValue } });
    await prisma.session.update({ where: { id: sessionId }, data: { updatedAt: new Date() } });
    await writeMarker(user.tenantId, { stage: 'DONE', done: true, reportMessageId: msg.id });
  } catch (err) {
    console.error('[onboarding] forge failed:', (err as Error).message);
    await writeMarker(user.tenantId, { stage: 'FORGE', generating: false }).catch(() => {});
  } finally {
    forging.delete(user.id);
  }
}

export async function onboardingRoutes(app: FastifyInstance) {
  // 断点续答：返回当前 stage 应显示的军师消息（纯读，不落库）。
  app.get('/onboarding/state', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const stage = await resolveStage(user.tenantId);
    const name = user.name?.trim() || '主公';
    return { stage, messages: await messagesFor(stage, name) };
  });

  // 推进状态机：落库军师问句 + 用户答案，写入档案，返回下一问；收官触发异步生成《初见断语》。
  app.post<{ Body: { answer?: string; bazi?: BaziBody; color?: string; skip?: boolean } }>('/onboarding/advance', async (req, reply) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const name = user.name?.trim() || '主公';
    const body = req.body ?? {};
    const current = await resolveStage(user.tenantId);
    if (current === 'FORGE' || current === 'DONE') {
      return { messages: await messagesFor(current, name), stage: current, done: current === 'DONE' };
    }
    const session = await ensureGeneralSession(user);

    // 先把当前问句（含 GREET）幂等落库，保证答案前有问句
    await deliverStage(session.id, current, name);

    let next: Stage;
    const answer = (body.answer ?? '').trim();
    switch (current) {
      case 'ASK_INDUSTRY':
        if (!answer) return reply.code(400).send({ error: '请先说说你做的是哪一路生意' });
        await recordUserAnswer(session.id, answer);
        await upsertProfileFields(user.tenantId, { industry: answer });
        next = 'ASK_STAGE';
        break;
      case 'ASK_STAGE':
        if (!answer) return reply.code(400).send({ error: '请选一个当前所处的阶段' });
        await recordUserAnswer(session.id, answer);
        await upsertProfileFields(user.tenantId, { stage: answer });
        next = 'ASK_PAIN';
        break;
      case 'ASK_PAIN':
        if (!answer) return reply.code(400).send({ error: '请说说眼下最要紧的那一桩' });
        await recordUserAnswer(session.id, answer);
        await upsertProfileFields(user.tenantId, { pain: answer });
        next = 'ASK_BAZI';
        break;
      case 'ASK_BAZI':
        if (body.skip || !body.bazi) {
          await recordUserAnswer(session.id, '（这层先不看）');
        } else {
          const res = await saveUserBazi(user, body.bazi);
          if (!res.ok) return reply.code(400).send({ error: res.error });
          await recordUserAnswer(session.id, '（已留生辰）');
        }
        next = 'ASK_COLOR';
        break;
      case 'ASK_COLOR': {
        const color = (body.color ?? '').trim();
        if (!color) return reply.code(400).send({ error: '请择一色作你的帅旗' });
        await recordUserAnswer(session.id, `帅旗定为${COLOR_LABELS[color] ?? color}`);
        await prisma.user.update({ where: { id: user.id }, data: { benmingColor: color } });
        next = 'FORGE';
        break;
      }
      default:
        next = 'DONE';
    }

    if (next === 'FORGE') {
      await writeMarker(user.tenantId, { stage: 'FORGE', generating: true });
      await deliverStage(session.id, 'FORGE', name);
      await recordAudit({ tenantId: user.tenantId, userId: user.id, action: 'user.onboarding.forge', payload: {} });
      void runForge({ id: user.id, tenantId: user.tenantId, name }, session.id);
      return { messages: await messagesFor('FORGE', name), stage: 'FORGE', done: false };
    }

    await writeMarker(user.tenantId, { stage: next });
    await deliverStage(session.id, next, name);
    return { messages: await messagesFor(next, name), stage: next, done: false };
  });

  // 轮询《初见断语》生成结果（FORGE 后前端等待用）。
  app.get('/onboarding/result', async (req) => {
    const user = await resolveUser(req.headers['x-user-id'] as string | undefined);
    const p = await prisma.profile.findFirst({ where: { tenantId: user.tenantId } });
    const m = readMarker(p?.extraJson);
    const reportMessageId = m?.reportMessageId;
    return { ready: !!reportMessageId, ...(reportMessageId ? { reportMessageId } : {}) };
  });
}
