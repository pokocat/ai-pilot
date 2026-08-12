// AI 排版引擎的**路线归一**：把「后台配置 + 门禁事实 + 模型自选」收成一个确定的结论。
//
// 纯函数、无 IO —— 路线选择的全部规则集中在这里，worker 只负责执行结论。
// 这样做的原因：门禁规则是这条功能里最容易「实现了但从没生效」的部分（供应商没配却选了 photo、
// 用户传了本人照片却去生成一张别人的脸），而它们全都可以在单测里钉死。
//
// ── 三条门禁（任一不满足即降 graphic）──
//
//   ① **图片供应商必须已配置**（visualProviderConfigured）。不满足时连宣言提示词里都不给 photo 选项
//      （省 token，也免得模型选了个走不通的路线）—— 所以本模块导出 photoRouteAllowed 供 worker 在
//      调宣言**之前**先判一次。
//
//   ② **用户上传了本人照片（portraitAssetId）→ 强制 graphic**。这是刻意规则，不是没做完：
//      photo 路线生成的是**模型画出来的人**，和用户自己的照片放在同一张海报上必然打架
//      （两张脸、两种光、两种年龄）。v1 **不做真人融合**（那需要 image-to-image / 换脸能力与
//      一整套肖像合规口径：授权、可撤回、未成年人判定）。等真要做时，这里会变成第三条路线，
//      而不是在 photo 路线里偷偷把用户的脸贴上去。
//
//   ③ **subject 必须非空**。photo 路线的 prompt 骨架里有一个 `{SUBJECT}` 槽，没有主体描述就拼不出
//      一条成立的 prompt（拼出来会是 "Full-bleed editorial photograph of , wearing…"）。
//      即使后台把 aiMode 强制成 'photo' 也一样降级 —— 强制的是「优先走影像」，不是「不管拼不拼得出来」。
import { visualProviderConfigured, type AiMode, type CreativeRuntimeConfig } from './config.js';
import { normalizeStyleKey, posterStyle, type PosterStyle, type PosterStyleKey } from './styleLibrary.js';
import { sanitizeSubject } from './imagePrompt.js';
import type { NormalizedPosterBrief } from './schema.js';

export type PosterAiMode = 'graphic' | 'photo';

/**
 * photo 路线是否**可能**成立（不看模型自选，只看后台配置与素材事实）。
 * worker 在调宣言前先问这一句：为假就不给模型 photo 选项。
 */
export function photoRouteAllowed(o: {
  aiMode: AiMode;
  visualConfigured: boolean;
  hasPortraitAsset: boolean;
}): boolean {
  if (o.aiMode === 'graphic') return false;
  if (!o.visualConfigured) return false;
  if (o.hasPortraitAsset) return false;
  return true;
}

/**
 * 高级档（2026-08-12）**强制影像路线**，不再让模型自选 —— 用户买的就是那次图片大模型调用。
 *
 * 门禁仍然全部有效（供应商没配 / 传了本人照片 / 拼不出 subject 一样降级），但对高级单来说
 * 「降级」的语义不同：标准单降级只是换条路，高级单降级等于**没交付它承诺的东西**。
 * 所以 worker 对高级单的处理是「photo 走不通 → 整单失败 + 全额退款」，而不是悄悄给一张 graphic
 * 再照常收高级价。这条判断在 worker.runAiEngine 里，本模块只负责把路线定死。
 */
export function isPremiumTier(brief: NormalizedPosterBrief): boolean {
  return brief.tier === 'premium';
}

/** 便捷重载：直接吃运行时配置 + brief。 */
export function photoRouteAllowedFor(cfg: CreativeRuntimeConfig, brief: NormalizedPosterBrief): boolean {
  return photoRouteAllowed({
    aiMode: cfg.aiMode,
    visualConfigured: visualProviderConfigured(cfg),
    hasPortraitAsset: !!brief.portraitAssetId,
  });
}

export interface ResolvedPosterRoute {
  mode: PosterAiMode;
  /** 恒有值（graphic 时也归一好，便于留痕与将来切换）；photo 时它就是拼 prompt 用的那一档。 */
  styleKey: PosterStyleKey;
  style: PosterStyle;
  /** 已过卫生的英文主体描述（graphic 时可能是空串）。 */
  subject: string;
  /** 为什么是这条路线（进日志与 resultJson，运营排障的唯一入口）。 */
  reason: string;
}

/**
 * 归一路线。
 *
 * @param modelMode    模型自选的 mode（'photo' | 'graphic' | 任意脏值）。aiMode='auto' 时才被采纳。
 * @param modelStyleKey 模型选的风格档 key；白名单外按 brief.scene 回退默认档（不作废整条路线）。
 * @param modelSubject 模型写的英文主体描述（不可信文本，这里过一遍卫生）。
 */
export function resolvePosterRoute(o: {
  aiMode: AiMode;
  visualConfigured: boolean;
  brief: NormalizedPosterBrief;
  modelMode?: unknown;
  modelStyleKey?: unknown;
  modelSubject?: unknown;
}): ResolvedPosterRoute {
  const styleKey = normalizeStyleKey(o.modelStyleKey, o.brief.scene);
  const style = posterStyle(styleKey, o.brief.scene);
  // 卫生在这里先跑一次，只为拿到「清理后还剩不剩东西」这个判断；正式拼装时 assembleImagePrompt
  // 会以骨架的景别为准再跑一遍（那时才知道是哪一档的骨架）。
  const subject = sanitizeSubject(o.modelSubject).subject;
  const graphic = (reason: string): ResolvedPosterRoute => ({ mode: 'graphic', styleKey, style, subject, reason });

  if (o.aiMode === 'graphic') return graphic('后台配置强制纯图形路线（aiMode=graphic）');
  if (!o.visualConfigured) return graphic('未配置图片供应商，影像路线不可用');
  if (o.brief.portraitAssetId) return graphic('用户上传了本人照片：v1 不做真人融合，强制纯图形路线');
  if (!subject) return graphic('模型未给出可用的影像主体描述（subject 为空）');
  // 高级档：路线由**用户付的钱**定，不由模型自选。放在三条门禁之后 —— 门禁说的是「走不通」，
  // 那种情况下 worker 会让整单失败并全额退款，而不是在这里假装还能走 photo。
  if (isPremiumTier(o.brief)) {
    return { mode: 'photo', styleKey, style, subject, reason: `高级档强制影像路线 · ${style.name}` };
  }
  if (o.aiMode === 'photo') {
    return { mode: 'photo', styleKey, style, subject, reason: `后台配置强制影像路线（aiMode=photo）· ${style.name}` };
  }
  if (String(o.modelMode ?? '') === 'photo') {
    return { mode: 'photo', styleKey, style, subject, reason: `模型自选影像路线 · ${style.name}` };
  }
  return graphic('模型自选纯图形路线');
}

/** 便捷重载：吃运行时配置。 */
export function resolvePosterRouteFor(
  cfg: CreativeRuntimeConfig,
  brief: NormalizedPosterBrief,
  model: { mode?: unknown; styleKey?: unknown; subject?: unknown },
): ResolvedPosterRoute {
  return resolvePosterRoute({
    aiMode: cfg.aiMode,
    visualConfigured: visualProviderConfigured(cfg),
    brief,
    modelMode: model.mode,
    modelStyleKey: model.styleKey,
    modelSubject: model.subject,
  });
}
