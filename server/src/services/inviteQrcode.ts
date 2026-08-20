// 邀请小程序码（静态传播链）。
//
// **为什么单开一个而不是直接用 `wechat.ts` 的 `miniCodeDataUri`**：那个是给 B 级卡片页脚用的，
// scene 写的是来源标识（`card=daily`）、且刻意不传 `page`（落主页，对老版本/体验版都安全）。
// 邀请码这条链有两点不同：
//   ① 要带 `page`：扫码的人是**陌生游客**，直接落问策 tab（公开内容、不撞登录门），
//      落主页再自己找一遍会掉转化；
//   ② 必须缓存：`getwxacodeunlimit` 有调用频率限制，而「我的邀请」页是会被反复打开的，
//      每次都打微信接口既慢又可能被限流。同一个 (code, slot) 的码是**恒定**的，缓存天然安全。
//
// 铁律沿用：测试环境 / 凭据未配 / 接口失败一律返回 null —— 页面降级成「只显示邀请码大字 +
// 可手输」，绝不给一张裂图，也绝不让邀请页因为外部依赖打不开。
import { getAccessToken, WXACODE_UNLIMIT_URL } from './wechat.js';
import { cacheGet, cacheSet } from './cache.js';

/** 扫码落地页：问策 tab。陌生人扫进来第一屏必须是公开内容，不能是登录门或空态。 */
const LANDING_PAGE = 'pages/sessions/index';

/** 缓存 12 小时。码本身恒定，TTL 只是为了让「运营换了落地页」这类改动最终会生效。 */
const TTL_MS = 12 * 60 * 60 * 1000;

/**
 * 物料位：同一个人可以有多张码，扫码后能回答「这个客户是从哪块物料来的」。
 * 转发通道给不了这个信息，这是静态链独有的价值。
 *
 * **scene 上限 32 字符**（微信硬限制），所以位标识只留短码：
 * `ic:JS2K7P:card` = 14 字符，余量充足。
 */
export const QR_SLOTS = ['default', 'card', 'store', 'deck', 'event'] as const;
export type QrSlot = (typeof QR_SLOTS)[number];

export function parseSlot(raw: unknown): QrSlot {
  return typeof raw === 'string' && (QR_SLOTS as readonly string[]).includes(raw) ? (raw as QrSlot) : 'default';
}

/** scene 形状：`ic:<码>` 或 `ic:<码>:<位>`。端上 invite.js 只认 `ic:` 前缀，与 query 通道同一套归因。 */
export function sceneFor(inviteCode: string, slot: QrSlot): string {
  const base = `ic:${inviteCode}`;
  const scene = slot === 'default' ? base : `${base}:${slot}`;
  // **运行时守卫**（2026-08-20 codex 审出）：32 是微信硬限制，早先只靠注释和固定样例的测试兜。
  // 当前最长 `ic:JS2K7P:event`（14 字符）安全，但邀请码规则一旦变长（比如加到 24 位），
  // `ic:<24>:event` 就是 33 字符——微信直接拒绝，端上表现为「码一直生成不出来」，
  // 而单元测试若仍用短样例会保持假绿。这里显式抛错，让它在生成时就暴露而不是静默降级。
  if (scene.length > 32) {
    throw Object.assign(
      new Error(`邀请码 scene 超微信 32 字符上限（${scene.length}）：${scene}。邀请码或物料位变长时必须同步收缩。`),
      { statusCode: 500, code: 'INVITE_SCENE_TOO_LONG' },
    );
  }
  return scene;
}

/**
 * 取邀请小程序码（data URI）。失败返回 null，由调用方降级。
 *
 * 不把失败缓存下来：微信侧的失败多是限流或凭据临时问题，缓存 null 会把一次抖动放大成 12 小时无码。
 */
/**
 * 失败原因限频日志（2026-08-20 codex 审出：外部失败此前完全不可观测）。
 *
 * 这个服务把 token / HTTP / content-type / 超时全部吞成 `null` 好让页面降级，
 * 代价是**再发生 45009 限流或微信改接口时，服务端一点痕迹都没有**——
 * 只有用户看到「二维码取不到」，运维无从知道原因。
 *
 * 限频而不是每次都打：码页会被反复打开，真出故障时每秒能刷出几十条同样的日志。
 * 同一 reason 5 分钟一条，够定位又不淹没日志。
 */
const REASON_LOG_TTL_MS = 5 * 60 * 1000;
const reasonLoggedAt = new Map<string, number>();

function noteFailure(reason: string, detail?: string): void {
  const now = Date.now();
  const last = reasonLoggedAt.get(reason) ?? 0;
  if (now - last < REASON_LOG_TTL_MS) return;
  reasonLoggedAt.set(reason, now);
  console.warn(`[invite-qr] 生成失败 reason=${reason}${detail ? ` detail=${detail}` : ''}（限频 5 分钟一条）`);
}

export async function inviteQrcode(inviteCode: string, slot: QrSlot): Promise<string | null> {
  if (process.env.NODE_ENV === 'test') return null;
  const scene = sceneFor(inviteCode, slot);
  const key = `invite-qr:${scene}`;

  const hit = await cacheGet<string>(key).catch(() => null);
  if (hit) return hit;

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    noteFailure('access_token', (err as Error)?.message);
    return null; // 凭据未配 / 取 token 失败：降级无码
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${WXACODE_UNLIMIT_URL}?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scene,                     // 已在 sceneFor 里保证 ≤32
        page: LANDING_PAGE,
        // check_path:false —— 不校验 page 是否已发布。审核期/体验版下该页在线上还不存在，
        // 开着校验会直接报 41030 让整条链哑掉。
        check_path: false,
        width: 430,               // 印在物料上要够清晰；280 在名片尺寸下扫不动
        auto_color: false,
        line_color: { r: 22, g: 25, b: 29 },  // 墨色 #16191D，与品牌一致（默认黑偏冷）
      }),
      signal: controller.signal,
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('image')) {
      // 微信出错时返回 JSON（41030 page 未发布 / 45009 限流 / 40001 token 失效…）。
      // 把 errcode 读出来——这是唯一能区分「限流」和「接口变更」的线索。
      let code = '';
      try { code = String(((await res.json()) as { errcode?: unknown })?.errcode ?? ''); } catch { /* 非 JSON */ }
      noteFailure(`wx_${code || res.status}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100) { noteFailure('empty_body', `${buf.length}B`); return null; }
    const uri = `data:image/png;base64,${buf.toString('base64')}`;
    await cacheSet(key, uri, TTL_MS).catch(() => {}); // 缓存写失败不影响本次返回
    return uri;
  } catch (err) {
    // AbortError = 8s 超时；其余多是网络层问题
    noteFailure((err as Error)?.name === 'AbortError' ? 'timeout' : 'network', (err as Error)?.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
