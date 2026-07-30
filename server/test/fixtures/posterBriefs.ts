// 海报 brief 固定输入（测试专用）。
//
// 为什么把这一份钉成 fixture：2026-07-29 真机出的那张「效果差」的图就是这单出的（酒店 OTA 获客场景），
// 它是 AI 排版引擎立项的直接动因。refine 闭环的 stub 测试一律用它作输入，
// 这样「同一份 brief 在引擎变更前后表现如何」在测试里是可比的，而不是每个用例各编一份 brief。
// 真图对比只能在生产做（本地无模型 key），所以本地能钉住的只有「输入固定 + 闭环行为固定」。
import { normalizePosterBrief, type NormalizedPosterBrief } from '../../src/services/creative/schema.js';
import type { PosterBrief } from '../../../shared/contracts';

/** 原始形态（长度均在 schema 上限内：主标题 ≤20 / 副标 ≤30 / 卖点 ≤20 / CTA ≤15）。 */
export const HOTEL_OTA_BRIEF_RAW: PosterBrief = {
  scene: 'service',
  goal: '让本地酒店老板来聊直客运营',
  audience: '单体酒店与民宿老板',
  headline: '不再靠 OTA 活着',
  subheadline: '直客占比从 12% 做到 45%',
  proofPoints: ['服务 60 家单体酒店', '平均降佣 9 个点', '90 天见首批复购'],
  cta: '扫码领诊断',
  visualDirection: '克制的深色背景，纸感与金属点缀',
  ratio: '3:4',
};

/** 规整后的 brief（templateKey 已按 scene 落到 editorial）。 */
export function hotelOtaBrief(over: Partial<PosterBrief> = {}): NormalizedPosterBrief {
  return normalizePosterBrief({ ...HOTEL_OTA_BRIEF_RAW, ...over });
}
