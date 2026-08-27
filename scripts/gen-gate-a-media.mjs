#!/usr/bin/env node
/**
 * 生成闸门 A 的对齐标记片（协议 docs/KUAICHUPIAN_GATE_PROTOCOL_2026-08-24.md §2.2）。
 *
 * 产出：
 *   audio.m4a            一条连续音轨，每 15 秒一个 40ms 的 1kHz 正弦标记
 *   seg-01.mp4 … seg-22.mp4   按 ct_shiti 真实段边界切的 22 段，画面带绝对时间码，
 *                             标记时刻插 1 帧纯白
 *   manifest.json        段边界表，直接喂给 packages/video/gatea/manifest.js
 *
 * 为什么要这条片子：漂移没法靠肉眼判。有了白帧和正弦峰，录屏之后用 ffmpeg
 * 把两边的时刻各找出来，相减就是漂移，逐个标记算就得到漂移随时间的曲线。
 *
 * ⚠️ 这是**测量夹具**，不是协议 §2.1 要求的真实素材。
 *    它能测出切换间隙、黑场、漂移这些机制指标；测不出真实素材在低端机上的解码压力
 *    （码率、分辨率、编码档次都不一样）。§2.1 那套必须另跑。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || path.join(process.cwd(), 'gate-a-media');
const W = 720, H = 1280, FPS = 30;
const MARKER_EVERY = 15;      // 秒
const MARKER_MS = 40;         // 正弦时长
const FONT = ['/System/Library/Fonts/Supplemental/Arial.ttf', '/System/Library/Fonts/Helvetica.ttc']
  .find((p) => existsSync(p));

/** ct_shiti 的真实段边界（由 catalog.js + model.summarize 推出，不是等分）。 */
const SEGMENTS = JSON.parse(process.env.GATE_A_SEGMENTS || '[]');
if (!SEGMENTS.length) {
  console.error('缺段边界表。先跑：\n  node -e "..." > segments.json\n然后 GATE_A_SEGMENTS=$(cat segments.json) node scripts/gen-gate-a-media.mjs');
  process.exit(1);
}
const TOTAL = SEGMENTS.reduce((a, s) => a + s.durationSec, 0);

mkdirSync(OUT, { recursive: true });
const ff = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });

// ── 音轨：低幅粉噪打底（听得出在放），每 15 秒叠一个 40ms 的 1kHz ──────────────
// 门控写在 volume 的表达式里，eval=frame 才能按帧求值；lt(mod(t,15),0.04) 就是每 15 秒开 40ms。
const gate = `lt(mod(t\\,${MARKER_EVERY})\\,${MARKER_MS / 1000})`;
ff([
  '-f', 'lavfi', '-i', `anoisesrc=d=${TOTAL}:c=pink:a=0.04:r=44100`,
  '-f', 'lavfi', '-i', `sine=frequency=1000:duration=${TOTAL}:sample_rate=44100`,
  '-filter_complex',
  `[1:a]volume='if(${gate},1,0)':eval=frame[m];[0:a][m]amix=inputs=2:duration=first:normalize=0[a]`,
  '-map', '[a]', '-c:a', 'aac', '-b:a', '128k', path.join(OUT, 'audio.m4a'),
]);
console.log('✓ audio.m4a  ' + TOTAL + 's，标记 ' + Math.floor(TOTAL / MARKER_EVERY + 1) + ' 个');

// ── 视频段：绝对时间码 + 段号；标记时刻 1 帧纯白 ──────────────────────────────
for (const s of SEGMENTS) {
  const S = s.startSec, D = s.durationSec;
  // 本段内落了哪几个标记 → 每个标记在段内的相对时刻开一帧白
  const marks = [];
  for (let mkr = 0; mkr <= TOTAL; mkr += MARKER_EVERY) {
    if (mkr >= S && mkr < S + D) marks.push(Math.round((mkr - S) * 1000) / 1000);
  }
  const white = marks.map((r) =>
    // 半帧窗：between 的右端点用整帧会同时命中 t=r 和 t=r+1/FPS，出两帧白。
    // 协议 §2.2 要的是 1 帧，多一帧会让 YAVG 找出成对的峰，配对时容易错配。
    `drawbox=x=0:y=0:w=iw:h=ih:color=white@1:t=fill:enable='between(t\\,${r}\\,${r + 0.5 / FPS})'`).join(',');

  const tint = s.role === 'avatar' ? '0x2A1810' : (s.role === 'tail' ? '0x101418' : '0x14181A');

  // 这个 ffmpeg 没编 drawtext，改用 drawbox 画**二进制时间码**：顶部一排格子，
  // 亮=1 暗=0，编的是绝对帧号（13 位够 8192 帧 / 273 秒）。
  // 录屏之后不用 OCR，按格子亮暗直接读出这一帧是第几帧 —— 比认数字更准。
  const BITS = 13, BW = 48, BH = 56;
  const tc = [];
  for (let k = 0; k < BITS; k++) {
    const x = 8 + (BITS - 1 - k) * (BW + 4);
    tc.push(`drawbox=x=${x}:y=8:w=${BW}:h=${BH}:color=0x202020@1:t=fill`);
    tc.push(`drawbox=x=${x}:y=8:w=${BW}:h=${BH}:color=white@1:t=fill:` +
      `enable='gte(mod(floor((${S}+t)*${FPS}/pow(2\\,${k}))\\,2)\\,1)'`);
  }
  // 段号另编一排 5 位，放时间码下面，切错段一眼看得出
  const sb = [];
  for (let k = 0; k < 5; k++) {
    const x = 8 + (4 - k) * (BW + 4);
    sb.push(`drawbox=x=${x}:y=${8 + BH + 6}:w=${BW}:h=28:color=0x202020@1:t=fill`);
    if ((s.no >> k) & 1) sb.push(`drawbox=x=${x}:y=${8 + BH + 6}:w=${BW}:h=28:color=0xF06435@1:t=fill`);
  }

  const vf = [
    ...tc, ...sb,
    // 每帧走一格的方块：掉帧时它会跳格，肉眼就能看出来
    `drawbox=x='mod(t*${FPS}\\,20)*36':y=h-120:w=36:h=36:color=0x8ED6A6@1:t=fill`,
    white,   // 标记帧：整帧纯白，协议 §2.2 靠 YAVG 突变找它
  ].filter(Boolean).join(',');

  const file = path.join(OUT, `seg-${String(s.no).padStart(2, '0')}.mp4`);
  ff([
    '-f', 'lavfi', '-i', `color=c=${tint}:s=${W}x${H}:r=${FPS}:d=${D}`,
    '-vf', vf, '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-g', String(FPS), '-keyint_min', String(FPS),   // 每秒一个关键帧，seek 才跟得上
    file,
  ]);
  process.stdout.write(`\r✓ seg-${String(s.no).padStart(2, '0')}  ${S}→${Math.round((S + D) * 100) / 100}s  白帧 ${marks.length} 个   `);
}
console.log('\n✓ 22 段完成');

writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  id: 'gate_a_marker', label: '对齐标记片（测量夹具，非 §2.1 真实素材）',
  totalSec: TOTAL, markerEverySec: MARKER_EVERY,
  audioUrl: 'audio.m4a',
  segments: SEGMENTS.map((s) => ({ ...s, url: `seg-${String(s.no).padStart(2, '0')}.mp4` })),
  cues: SEGMENTS.map((s) => ({ startSec: s.startSec, endSec: s.startSec + s.durationSec, text: `第 ${s.no} 段 · ${s.role} · ${s.durationSec}s` })),
}, null, 2));
console.log('✓ manifest.json → ' + OUT);
