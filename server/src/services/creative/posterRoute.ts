// AI 排版引擎的路线归一：把「tier 商品契约 + 门禁事实」收成确定结论。
//
// tier 是主视觉来源的唯一真源：
//   · standard = graphic，所有成功/回落路径都不调图片生成供应商；
//   · premium = photo，图片生成失败就失败退款，不得静默降为 standard。
//
// premium 仍有三条执行门禁：供应商已配置、没上传本人照片、subject 非空。
// 任一不满足都表示「用户买的路线走不通」，worker 必须失败收口，
// 不能再把标准产物当作高级产物交付。
import { visualProviderConfigured, type CreativeRuntimeConfig } from './config.js';
import { isPosterStyleKey, normalizeStyleKey, posterStyle, type PosterStyle, type PosterStyleKey } from './styleLibrary.js';
import { directionFor } from './directions.js';
import { sanitizeSubject } from './imagePrompt.js';
import type { NormalizedPosterBrief } from './schema.js';

export type PosterAiMode = 'graphic' | 'photo';

export function isPremiumTier(brief: NormalizedPosterBrief): boolean {
  return brief.tier === 'premium';
}

/**
 * premium photo 路线是否可以在调宣言前开放。
 * standard 恒 false：模型根本看不到 photo 选项，从源头避免路线/成本漂移。
 */
export function photoRouteAllowed(o: {
  premium: boolean;
  visualConfigured: boolean;
  hasPortraitAsset: boolean;
}): boolean {
  if (!o.premium) return false;
  if (!o.visualConfigured) return false;
  if (o.hasPortraitAsset) return false;
  return true;
}

export function photoRouteAllowedFor(cfg: CreativeRuntimeConfig, brief: NormalizedPosterBrief): boolean {
  return photoRouteAllowed({
    premium: isPremiumTier(brief),
    visualConfigured: visualProviderConfigured(cfg),
    hasPortraitAsset: !!brief.portraitAssetId,
  });
}

export interface ResolvedPosterRoute {
  mode: PosterAiMode;
  /** graphic 也归一好，便于历史 photo 资产复用与排障。 */
  styleKey: PosterStyleKey;
  style: PosterStyle;
  /** 已过卫生的英文主体描述（graphic 时可为空）。 */
  subject: string;
  reason: string;
}

/**
 * 免费 revise 已经有一张通过审核的主视觉，不再受供应商当前可用性影响。
 * 这里仅恢复当时的叠层风格上下文；旧资产缺字段时按 scene 归一到安全默认档。
 */
export function resolveReusedPhotoRoute(
  brief: NormalizedPosterBrief,
  pinned: { styleKey?: unknown; subject?: unknown },
): ResolvedPosterRoute {
  const styleKey = normalizeStyleKey(pinned.styleKey, brief.scene);
  const style = posterStyle(styleKey, brief.scene);
  const subject = sanitizeSubject(pinned.subject).subject;
  return {
    mode: 'photo',
    styleKey,
    style,
    subject,
    reason: `免费改字复用原主视觉 · ${style.name}`,
  };
}

/** 路线只由 tier 决定；模型只能在 premium 内选风格与主体，不再选价格路线。 */
export function resolvePosterRoute(o: {
  visualConfigured: boolean;
  brief: NormalizedPosterBrief;
  modelStyleKey?: unknown;
  modelSubject?: unknown;
}): ResolvedPosterRoute {
  const allowed = directionFor(o.brief.directionKey).styleKeys;
  const modelStyleKey = isPosterStyleKey(o.modelStyleKey) && (!allowed || allowed.includes(o.modelStyleKey))
    ? o.modelStyleKey
    : allowed?.[0];
  const styleKey = normalizeStyleKey(modelStyleKey, o.brief.scene);
  const style = posterStyle(styleKey, o.brief.scene);
  const subject = sanitizeSubject(o.modelSubject).subject;
  const graphic = (reason: string): ResolvedPosterRoute => ({ mode: 'graphic', styleKey, style, subject, reason });

  if (!isPremiumTier(o.brief)) {
    return graphic('标准档契约：纯图形排印，不调图片生成模型');
  }
  if (!o.visualConfigured) return graphic('未配置图片供应商，高级路线不可用');
  if (o.brief.portraitAssetId) return graphic('高级档与本人照片互斥：v1 不做真人融合');
  if (!subject) return graphic('模型未给出可用的影像主体描述（subject 为空）');
  return { mode: 'photo', styleKey, style, subject, reason: `高级档契约：影像主导 · ${style.name}` };
}

export function resolvePosterRouteFor(
  cfg: CreativeRuntimeConfig,
  brief: NormalizedPosterBrief,
  model: { styleKey?: unknown; subject?: unknown },
): ResolvedPosterRoute {
  return resolvePosterRoute({
    visualConfigured: visualProviderConfigured(cfg),
    brief,
    modelStyleKey: model.styleKey,
    modelSubject: model.subject,
  });
}
