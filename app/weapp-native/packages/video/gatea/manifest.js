/**
 * 闸门 A 的测试素材清单。
 *
 * 协议（docs/KUAICHUPIAN_GATE_PROTOCOL_2026-08-24.md §2.1）要求测试内容全部用真的：
 * 真实生成的整条 TTS、真实数字人成片切片、真实上传的 b-roll、真实尾片。
 * 这个文件就是把那批素材的地址填进来的地方。
 *
 * ⚠️ 下面 PLACEHOLDER 那一份是**占位**，用来验证机制能不能跑通，
 *    不是合法的闸门数据。用占位跑出来的数字不得写进报告。
 *
 * 换成真素材要满足（§2.1）：
 *   - audioUrl：一条完整的 163 秒 TTS + BGM 混音，不是分段音频、不是占位音
 *   - segments：22 段，与 catalog.js 的 ct_shiti 段边界一一对应
 *     第 1/7/13/21 段是数字人段（从已有真实数字人成片切等时长片段，不为闸门新生成）
 *     其余 17 段 b-roll 里至少 3 条竖屏手机拍摄、至少 2 条需要裁剪的横屏
 *     第 22 段是真实固定尾片
 *   - cues：真实逐句时间窗，不是静态贴图
 *   - 冷缓存跑测时给每个 URL 挂唯一签名 query（§1.3），本文件的 runId 参数会自动追加
 */

/** 段边界按 catalog.js 的 ct_shiti 运行时真值：22 段、163 秒、数字人在 1/7/13/21。 */
const AVATAR_SEGMENT_NOS = [1, 7, 13, 21];

/**
 * 占位清单：22 段等分 163 秒，素材用同一条公共测试视频。
 * 机制验证用 —— 它能回答「双缓冲切换有没有黑场、漂移会不会累积」，
 * 但回答不了「真实素材在低端机上解码扛不扛得住」，那个必须换真素材。
 */
const PLACEHOLDER = {
  id: 'placeholder',
  label: '占位素材（机制验证用，数据不得进报告）',
  totalSec: 163,
  audioUrl: '',
  segments: buildEvenSegments(163, 22),
  cues: [],
};

function buildEvenSegments(totalSec, count) {
  const per = totalSec / count;
  const out = [];
  let acc = 0;
  for (let i = 1; i <= count; i++) {
    const dur = i === count ? totalSec - acc : Math.round(per * 10) / 10;
    out.push({
      no: i,
      role: AVATAR_SEGMENT_NOS.indexOf(i) >= 0 ? 'avatar' : (i === count ? 'tail' : 'broll'),
      startSec: Math.round(acc * 10) / 10,
      durationSec: dur,
      url: '',
    });
    acc = Math.round((acc + dur) * 10) / 10;
  }
  return out;
}

/**
 * 真实素材清单填这里。segments 的 startSec 必须是累计起点，
 * 由真实段时长累加得到，不要沿用占位的等分值。
 */
/**
 * 真实素材清单填这里。填法两种：
 *   1) 协议 §2.1 的真实素材 —— 判定用的就是这一份
 *   2) 测量夹具（对齐标记片）—— 先跑 scripts/gen-gate-a-media.mjs，
 *      它会输出 manifest.json，把里面的 audioUrl / segments 换成可访问的地址填进来
 * segments 的 startSec 必须是真实段时长累加出来的累计起点。
 */
const REAL = {
  id: 'ct_shiti_real',
  label: 'ct_shiti 真实素材',
  totalSec: 0,
  audioUrl: '',
  segments: [],
  cues: [],
};






/** 冷缓存要求三层缓存都没见过这批 URL（§1.3），跑测前给每个地址挂上本次 runId。 */
function withRunId(manifest, runId) {
  if (!runId) return manifest;
  const tag = (u) => (u ? u + (u.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(runId) : u);
  return Object.assign({}, manifest, {
    audioUrl: tag(manifest.audioUrl),
    segments: manifest.segments.map((s) => Object.assign({}, s, { url: tag(s.url) })),
  });
}

function isRunnable(m) {
  return !!(m && m.audioUrl && m.segments && m.segments.length && m.segments.every((s) => !!s.url));
}

module.exports = { PLACEHOLDER, REAL, withRunId, isRunnable, AVATAR_SEGMENT_NOS };
