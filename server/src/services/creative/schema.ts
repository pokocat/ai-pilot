// PosterBrief 的服务端校验（SSOT 见 shared/contracts.d.ts 海报分区）。
//
// 原则：**客户端校验不算校验**。确认页会做长度提示，但服务端必须独立再判一遍——
// 长度超限直接 422（不静默截断，避免用户以为写进去了却被砍掉），白名单外的枚举一律回退默认。
// 资产归属（assetId 是否属本人）与 MIME 校验在 jobs 层做（要查库，schema 保持纯函数可单测）。
import { z } from 'zod';
import { TEMPLATE_KEYS, type TemplateKey } from './config.js';
import type { PosterBrief, PosterScene, PosterTier } from '../../../../shared/contracts';

/** 文案长度上限（与确认页提示口径一致；改这里必须同步改小程序提示文案）。 */
export const LIMITS = {
  headline: 20,
  subheadline: 30,
  proofPoint: 20,
  proofPoints: 3,
  cta: 15,
  visualDirection: 100,
  negativePrompt: 100,
  goal: 60,
  audience: 40,
} as const;

export const POSTER_SCENES = ['personal_brand', 'event', 'service', 'product'] as const;

/** scene → 默认模板。templateKey 缺失或不在白名单时按此回退（推荐是提示词的事，兜底是服务端的事）。 */
export const SCENE_DEFAULT_TEMPLATE: Record<PosterScene, TemplateKey> = {
  personal_brand: 'person_hero',
  event: 'business_launch',
  service: 'editorial',
  product: 'business_launch',
};

export class BriefInvalidError extends Error {
  statusCode = 422;
  code = 'BRIEF_INVALID';
  constructor(msg: string) { super(msg); }
}

const trimmed = (max: number, label: string) =>
  z.string().transform((s) => s.trim()).refine((s) => s.length <= max, { message: `${label}不超过 ${max} 个字` });

const cuidish = z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, { message: '素材 id 非法' });

/**
 * 入参 schema。注意 templateKey / ratio 故意**不在此处报错**：
 * templateKey 无效按 scene 回退（见 normalizePosterBrief），ratio 第一期只放行 '3:4'（其余 422，
 * 因为放行一个渲染器没有模板的比例只会产出错版式——这是「能力未就绪」而不是「可以兜底」）。
 */
const PosterBriefSchema = z.object({
  scene: z.enum(POSTER_SCENES),
  goal: trimmed(LIMITS.goal, '商业目标'),
  audience: trimmed(LIMITS.audience, '目标客群'),
  headline: trimmed(LIMITS.headline, '主标题').refine((s) => s.length > 0, { message: '主标题不能为空' }),
  subheadline: trimmed(LIMITS.subheadline, '副标题').optional(),
  proofPoints: z.array(z.string().transform((s) => s.trim()).refine((s) => s.length <= LIMITS.proofPoint, { message: `每条卖点不超过 ${LIMITS.proofPoint} 个字` }))
    .max(LIMITS.proofPoints, { message: `卖点最多 ${LIMITS.proofPoints} 条` })
    .default([]),
  cta: trimmed(LIMITS.cta, '行动号召').refine((s) => s.length > 0, { message: '行动号召不能为空' }),
  visualDirection: trimmed(LIMITS.visualDirection, '视觉方向').default(''),
  negativePrompt: trimmed(LIMITS.negativePrompt, '排除项').optional(),
  templateKey: z.string().trim().max(40).optional(),
  // tier 与 templateKey 同理：**不在 schema 报错**。非法值按标准档处理（老客户端不带这个字段
  // 也必须照常建单）；「选了高级但高级不可用」是**业务闸门**，由 assertTierAvailable 报 422，
  // 那里才拿得到运行时配置，也才说得出人话（"高级档暂不可用"而不是 "tier: invalid enum"）。
  tier: z.string().trim().max(20).optional(),
  ratio: z.string().trim().default('3:4'),
  portraitAssetId: cuidish.optional(),
  logoAssetId: cuidish.optional(),
  qrAssetId: cuidish.optional(),
  brandKitVersion: z.number().int().min(1).max(9999).optional(),
});

/** 已规整的 brief：templateKey 必定是白名单值，ratio 必定是 '3:4'，tier 必定是两档之一。 */
export type NormalizedPosterBrief = PosterBrief & {
  templateKey: TemplateKey; ratio: '3:4'; tier: PosterTier;
};

/** 档位归一：只认 'premium'，其余（含缺省、脏值、老客户端不带）一律标准档。 */
export function normalizeTier(v: unknown): PosterTier {
  return v === 'premium' ? 'premium' : 'standard';
}

function isTemplateKey(v: unknown): v is TemplateKey {
  return typeof v === 'string' && (TEMPLATE_KEYS as readonly string[]).includes(v);
}

/** 模板停用时的统一文案（显式请求了停用模板、以及场景默认模板也被停用两种情形共用）。 */
const TEMPLATE_OFF_MESSAGE = '该版式暂时不可用，请稍后再试';

/**
 * 校验 + 规整 brief。
 * @param enabledTemplates 模板启停 map（后台可停用某套模板）。分两种情形：
 *        · **显式请求了一套被停用的模板 → 422**。不静默换版：用户在确认页明确选了它，
 *          悄悄换成别的版式再照常扣 10 钻，是"拿了钱交付了别的东西"（GET /creative/status
 *          只下发启用中的清单，正常前端根本选不到停用项 —— 走到这里说明清单已过期或有人直连接口）。
 *        · 未指定 templateKey（或值不在白名单）→ 按 scene 回退默认；默认模板本身也被停用时同样 422。
 */
export function normalizePosterBrief(
  raw: unknown,
  enabledTemplates?: Record<string, boolean>,
): NormalizedPosterBrief {
  const parsed = PosterBriefSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    throw new BriefInvalidError(first?.message ? String(first.message) : '需求单填写不完整');
  }
  const b = parsed.data;
  if (b.ratio !== '3:4') throw new BriefInvalidError('当前只支持 3:4 竖版海报');

  const isOn = (k: TemplateKey) => !enabledTemplates || enabledTemplates[k] !== false;
  const requested = isTemplateKey(b.templateKey) ? b.templateKey : null;
  if (requested && !isOn(requested)) throw new BriefInvalidError(TEMPLATE_OFF_MESSAGE);
  const templateKey = requested ?? SCENE_DEFAULT_TEMPLATE[b.scene];
  if (!isOn(templateKey)) throw new BriefInvalidError(TEMPLATE_OFF_MESSAGE);

  // 空字符串卖点在校验后剔除（用户删了一行的常见形态），保序去重。
  const seen = new Set<string>();
  const proofPoints = b.proofPoints.filter((p) => {
    if (!p || seen.has(p)) return false;
    seen.add(p);
    return true;
  });

  return {
    scene: b.scene,
    goal: b.goal,
    audience: b.audience,
    headline: b.headline,
    ...(b.subheadline ? { subheadline: b.subheadline } : {}),
    proofPoints,
    cta: b.cta,
    visualDirection: b.visualDirection,
    ...(b.negativePrompt ? { negativePrompt: b.negativePrompt } : {}),
    templateKey,
    tier: normalizeTier(b.tier),
    ratio: '3:4',
    ...(b.portraitAssetId ? { portraitAssetId: b.portraitAssetId } : {}),
    ...(b.logoAssetId ? { logoAssetId: b.logoAssetId } : {}),
    ...(b.qrAssetId ? { qrAssetId: b.qrAssetId } : {}),
    ...(b.brandKitVersion ? { brandKitVersion: b.brandKitVersion } : {}),
  };
}

/** 送审文本：把 brief 里所有用户可控文案拼一条，供 moderate('input', ...)。 */
export function briefModerationText(b: NormalizedPosterBrief): string {
  return [b.headline, b.subheadline ?? '', ...b.proofPoints, b.cta, b.goal, b.audience, b.visualDirection, b.negativePrompt ?? '']
    .filter(Boolean)
    .join('\n');
}
