// 声量AI 网页「扫码回手机小程序接着聊」用的小程序码（2026-11-23）。
//
// · 复用 wechat.ts 的 miniCodeDataUri（getwxacodeunlimit，不传 page → 落小程序主页 = app.json 第一页
//   `pages/sessions/index` 问策）。scene 固定 `web=chat`，与用户无关，所以全站一张码、按 scene 缓存。
// · 小程序端只有 services/invite.js 读 scene，它只认 `JS` 开头的邀请码形状，`web=chat` 不会被算成邀请；
//   绝不能复用 /invite/qrcode（那张码带邀请码，扫码会被归因成邀请渠道）。
// · 失败一律回 null（口径同 /invite/qrcode），失败结果只缓存 60 秒，免得一次抖动让码消失半天，
//   又不至于在微信持续报错时每个请求都去打 getwxacodeunlimit（有频率限制）。
// · 不记录 access_token 与图片内容。
import { cacheGet, cacheSet } from './cache.js';
import { miniCodeDataUri } from './wechat.js';

export const WEB_CHAT_SCENE = 'web=chat';
/** 不传 page 时微信落小程序主页；这里只是告诉网页落在哪一页，必须与 app.json 第一页一致。 */
export const WEB_CHAT_PAGE = 'pages/sessions/index';
export const WEB_MINI_CODE_TTL_MS = 12 * 60 * 60 * 1000;
export const WEB_MINI_CODE_FAIL_TTL_MS = 60 * 1000;

const KEY = `wxacode:web:${WEB_CHAT_SCENE}`;
let inflight: Promise<string | null> | null = null;

/** gen 仅供测试注入；默认走真实微信接口（NODE_ENV=test 时 miniCodeDataUri 恒为 null）。 */
export async function webChatMiniCode(gen: (scene: string) => Promise<string | null> = miniCodeDataUri): Promise<string | null> {
  const cached = await cacheGet<{ v: string | null }>(KEY);
  if (cached) return cached.v;
  // 同进程并发只打一次微信；多实例各自最多一次，结果落 Redis 后共享。
  inflight ??= (async () => {
    let value: string | null = null;
    try { value = await gen(WEB_CHAT_SCENE); } catch { value = null; }
    await cacheSet(KEY, { v: value }, value ? WEB_MINI_CODE_TTL_MS : WEB_MINI_CODE_FAIL_TTL_MS).catch(() => {});
    return value;
  })().finally(() => { inflight = null; });
  return inflight;
}
