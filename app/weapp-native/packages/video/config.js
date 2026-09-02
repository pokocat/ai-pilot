// 「快出片」分包配置 —— 后端接入模式在这里收口。
//
// 分包只访问军师自己的 BFF；BFF 再用独立 service token + externalOwnerId 调 aidrama。
// 军师用户 token 绝不下发到 aidrama，也不在端上维护第二套积分账本。
//
//   'mock'   端内假数据，不发网络请求。本机构建默认使用。
//   'bff'    打军师后端 /api/video/*，由军师 server 内部转 aidrama。推荐的生产形态。

let buildEnv = { APP_MODE: 'mock' };
try {
  // 源码里 `config/env.js` 是有的（默认 mock），构建器会在产物里用真实构建模式覆盖它。
  // catch 只是兜底：抽成插件/独立小程序后目录结构可能变，读不到就稳定回落 mock，
  // 绝不能因为读不到配置而让分包整个起不来。
  buildEnv = require('../../config/env');
} catch (_) { /* 读不到就用上面的 mock 默认值 */ }

const BACKEND_MODE = buildEnv.APP_MODE === 'server' ? 'bff' : 'mock';

/** BFF 模式下军师后端的 clip 前缀。军师 server 需新增 server/src/routes/video.ts。 */
const BFF_PREFIX = '/video';

/* ── 出片参数（与后端 PlatformConfig 的 clip.* 键对齐；端上这份只用于「下单前预估」）──
   真实计费一律以服务端 /estimate 返回为准，端上估算只为了让价格条能实时跳数字。
   两者不一致时以服务端为准并提示用户 —— 绝不能用端上估算去扣费。 */
const PRICING = {
  /** 中文口播约 4 字/秒（方案 §2.1 的一级精度，试听后用真实 TTS 时长回填）。 */
  charsPerSecond: 4,
  /** 数字人出镜：按秒计价。 */
  creditPerAvatarSecond: 1,
  /** TTS：按千字符计价。 */
  creditPerKChar: 5,
  /** 总装固定费。 */
  creditAssemble: 0,
  /* 注意：**没有 b-roll 这一项**。服务端权威报价（ClipEstimateService）的 total 只有
     tts + avatar + assemble，ClipProperties 里连 b-roll 的价键都不存在。端上以前多算一档，
     确认页首屏会先显示一个偏高的价、拿到服务端报价后当着用户面跳一下。
     真要对配画面收费，走运营后台新增价格，不在端上补常量。 */
};

/** 单个出镜段的产品保护上限（秒）。超过要提示用户拆句 —— 对应错误码 CLIP_SEGMENT_TOO_LONG。
 *  上游石榴硬上限仍须在 M0 测试 key 到位后实测，不得用本值冒充供应商契约。 */
const MAX_AVATAR_SEGMENT_SEC = 30;

/** 成片规格。 */
const OUTPUT = { width: 720, height: 1280, ratio: '9:16' };

/** b-roll 素材上限，与后端 MixcutAssetService 的白名单对齐。 */
const ASSET_LIMITS = {
  maxBytes: 100 * 1024 * 1024,
  videoExt: ['mp4', 'mov', 'm4v'],
  imageExt: ['jpg', 'jpeg', 'png', 'heic'],
};

/** 轮询出片进度的间隔（毫秒）。石榴与 aidrama 都是纯轮询，无回调（方案 §3.1）。 */
const POLL_INTERVAL_MS = 3000;

module.exports = {
  BACKEND_MODE, BFF_PREFIX,
  PRICING, MAX_AVATAR_SEGMENT_SEC, OUTPUT, ASSET_LIMITS, POLL_INTERVAL_MS,
};
