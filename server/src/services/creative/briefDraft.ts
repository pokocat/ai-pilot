// GET /creative/posters/brief-draft 的实现：从「海报设计师」的成果消息 + 已确认 BrandKit 预填 PosterBrief 草稿。
//
// 为什么要预填：让用户在确认页只做增删改，而不是对着空表单从零手填（方案 §5.3）。
// 三层兜底，任一层失败都还能给出可用草稿：
//   ① LLM 结构化抽取（zod 约束）→ 拿到文案 + templateKey + templateReason；
//   ② 提示词里让设计师直出的「成品图版式推荐：xxx（key）—— 理由」行 → 正则兜住 templateKey/理由；
//   ③ 全失败：headline=成果标题、scene 按 agent 推断、templateKey 按 scene 默认。
// BrandKit 只在 approvedAt 非空时合并（与 BrandKit 现有口径一致：生态产品只读 approved 的资产包）。
import { z } from 'zod';
import { prisma } from '../../db.js';
import { structured } from '../../llm/gateway.js';
import { getBrandKit } from '../brandKit.js';
import { TEMPLATE_KEYS, type TemplateKey } from './config.js';
import { SCENE_DEFAULT_TEMPLATE, LIMITS } from './schema.js';
import { CreativeError } from './jobs.js';
import type { Deliverable, PosterBrief, PosterBriefDraft, PosterScene, BrandKitView } from '../../../../shared/contracts';

/** agentKey → 默认场景（成果来自哪个顾问，海报大概是干什么用的）。 */
const AGENT_SCENE: Record<string, PosterScene> = {
  poster: 'personal_brand',
  ip: 'personal_brand',
  promo: 'event',
  copy: 'service',
  shortvideo: 'personal_brand',
};

const DraftSchema = z.object({
  scene: z.enum(['personal_brand', 'event', 'service', 'product']).optional().catch(undefined),
  goal: z.string().catch('').default(''),
  audience: z.string().catch('').default(''),
  headline: z.string().catch('').default(''),
  subheadline: z.string().catch('').default(''),
  proofPoints: z.array(z.string()).catch([]).default([]),
  cta: z.string().catch('').default(''),
  visualDirection: z.string().catch('').default(''),
  templateKey: z.string().catch('').default(''),
  templateReason: z.string().catch('').default(''),
});

const DRAFT_SYS = [
  '你是「军师参谋部」的海报需求整理助手。读一份海报设计方案，抽出可直接填进「成品图需求单」的字段。',
  '三个版式的语义：',
  '- person_hero（人物主视觉）：人物占主要画面，适合创始人/专家做个人品牌与信任背书；',
  '- editorial（编辑杂志）：大留白、强标题，适合观点、定位、专业服务这类需要克制质感的内容；',
  '- business_launch（商业发布）：信息明确、层级清楚，适合活动、课程、发布会、咨询服务报名。',
  '',
  '规则：',
  `- headline 不超过 ${LIMITS.headline} 字，subheadline 不超过 ${LIMITS.subheadline} 字；`,
  `- proofPoints 最多 ${LIMITS.proofPoints} 条、每条不超过 ${LIMITS.proofPoint} 字；`,
  `- cta 不超过 ${LIMITS.cta} 字；visualDirection 不超过 ${LIMITS.visualDirection} 字，只写画面属性`,
  '  （结构/色彩/材质/光线/构图），不指名任何在世创作者；',
  '- 方案里若已有「成品图版式推荐」，原样采纳它的 key 与理由；没有则你自己判断并写一句给客户看的理由',
  '  （不出现参数、模型、渲染、模板 key 之类技术说法）；',
  '- 抽不出的字段留空字符串，不要编造。',
  '',
  '只输出 JSON：{"scene":"","goal":"","audience":"","headline":"","subheadline":"","proofPoints":[],"cta":"","visualDirection":"","templateKey":"","templateReason":""}',
].join('\n');

function isTemplateKey(v: unknown): v is TemplateKey {
  return typeof v === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(v);
}

/** 兜底解析设计师直出的「成品图版式推荐：人物主视觉（person_hero）—— 理由」行。 */
export function parseTemplateRecommendation(text: string): { templateKey: TemplateKey | null; reason: string } {
  const line = text.split(/\r?\n/).find((l) => l.includes('成品图版式推荐'));
  if (!line) return { templateKey: null, reason: '' };
  const keyMatch = line.match(/\(([a-z_]+)\)|（([a-z_]+)）/);
  const key = (keyMatch?.[1] ?? keyMatch?.[2] ?? '').trim();
  const reason = (line.split(/——|--|—/).slice(1).join('—') || '').trim();
  return { templateKey: isTemplateKey(key) ? key : null, reason };
}

/** 把成果消息压成可喂模型的纯文本（不含 htmlUrl 之类工程字段）。 */
function deliverableText(d: Deliverable): string {
  const parts: string[] = [`标题：${d.title ?? ''}`];
  if (d.meta) parts.push(`摘要：${d.meta}`);
  if (d.cover?.subtitle) parts.push(`副标：${d.cover.subtitle}`);
  for (const s of d.sections ?? []) {
    const sec = s as { h?: string; sub?: string; b?: string; list?: string[]; paras?: string[] };
    const chunk = [sec.h, sec.sub, sec.b, ...(sec.list ?? []), ...(sec.paras ?? [])].filter(Boolean).join('\n');
    if (chunk) parts.push(chunk);
  }
  if (d.actions?.length) parts.push(`建议行动：${d.actions.join('；')}`);
  return parts.join('\n').slice(0, 6000);
}

function clip(s: string, max: number): string {
  const t = (s ?? '').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** BrandKit 合并（只在 approved 时调用）：tagline→副标候选、theme→视觉方向、taboos→排除项。 */
function mergeBrandKit(brief: Partial<PosterBrief>, kit: BrandKitView): Partial<PosterBrief> {
  const out = { ...brief };
  if (!out.subheadline && kit.persona?.tagline) out.subheadline = clip(kit.persona.tagline, LIMITS.subheadline);
  if (!out.visualDirection) {
    const hint = [...(kit.theme?.keywords ?? []), kit.theme?.colorHint ?? ''].filter(Boolean).join('、');
    if (hint) out.visualDirection = clip(hint, LIMITS.visualDirection);
  }
  if (!out.negativePrompt && (kit.voice?.taboos ?? []).length) {
    out.negativePrompt = clip(kit.voice!.taboos.join('、'), LIMITS.negativePrompt);
  }
  if (kit.version) out.brandKitVersion = kit.version;
  return out;
}

/**
 * 生成需求单草稿。
 * @throws CreativeError(404) 成果消息不存在或不属该用户。
 */
export async function buildPosterBriefDraft(opts: {
  userId: string;
  sessionId?: string | null;
  messageId?: string | null;
}): Promise<PosterBriefDraft> {
  if (!opts.messageId) throw new CreativeError('缺少成果消息 id', 'MESSAGE_ID_REQUIRED', 422);
  const msg = await prisma.message.findFirst({
    where: {
      id: opts.messageId,
      role: 'report',
      session: { userId: opts.userId, ...(opts.sessionId ? { id: opts.sessionId } : {}) },
    },
    select: { id: true, contentJson: true, session: { select: { agentKey: true } } },
  });
  if (!msg) throw new CreativeError('成果不存在', 'MESSAGE_NOT_FOUND', 404);

  const deliverable = (msg.contentJson ?? {}) as unknown as Deliverable;
  const text = deliverableText(deliverable);
  const agentKey = msg.session.agentKey;
  const fallbackScene = AGENT_SCENE[agentKey] ?? 'personal_brand';

  // 兜底层 ②：先从原文抓设计师直出的推荐行（LLM 不可用时也能给出带理由的推荐）。
  const rec = parseTemplateRecommendation(text);

  let ai: z.infer<typeof DraftSchema> | null = null;
  try {
    ai = await structured(DraftSchema, { system: DRAFT_SYS, user: text, maxChars: 1200 });
  } catch (e) {
    console.warn('[creative] brief 草稿抽取失败，回退确定性预填：', (e as Error).message);
  }

  const scene: PosterScene = ai?.scene ?? fallbackScene;
  const aiKey = isTemplateKey(ai?.templateKey) ? (ai!.templateKey as TemplateKey) : null;
  const templateKey: TemplateKey = aiKey ?? rec.templateKey ?? SCENE_DEFAULT_TEMPLATE[scene];
  const templateReason = clip(ai?.templateReason || rec.reason, 80);

  let brief: Partial<PosterBrief> = {
    scene,
    goal: clip(ai?.goal ?? '', LIMITS.goal),
    audience: clip(ai?.audience ?? '', LIMITS.audience),
    // headline 兜底 = 成果标题（用户一定认得出这是他刚才那份方案）。
    headline: clip(ai?.headline || deliverable.title || '', LIMITS.headline),
    ...(ai?.subheadline ? { subheadline: clip(ai.subheadline, LIMITS.subheadline) } : {}),
    proofPoints: (ai?.proofPoints ?? [])
      .map((p) => clip(p, LIMITS.proofPoint))
      .filter(Boolean)
      .slice(0, LIMITS.proofPoints),
    cta: clip(ai?.cta ?? '', LIMITS.cta),
    visualDirection: clip(ai?.visualDirection ?? '', LIMITS.visualDirection),
    templateKey,
    ratio: '3:4',
  };

  // 只用已确认（approvedAt 非空）的品牌资产包。
  const kitRow = await prisma.brandKit.findUnique({ where: { userId: opts.userId }, select: { approvedAt: true } });
  if (kitRow?.approvedAt) {
    const kit = await getBrandKit(opts.userId);
    if (kit) brief = mergeBrandKit(brief, kit);
  }

  return { brief, ...(templateReason ? { templateReason } : {}) };
}
