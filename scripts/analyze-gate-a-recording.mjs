#!/usr/bin/env node
/**
 * 闸门 A 录屏分析（协议 docs/KUAICHUPIAN_GATE_PROTOCOL_2026-08-24.md §2.2 / §2.3）。
 *
 *   node scripts/analyze-gate-a-recording.mjs 录屏.mp4
 *
 * 这是**判定用的第一证据线**。端上埋点（gatea 页那份 JSON）只是第二线，
 * 两者冲突以本脚本为准（§1.6）—— 埋点看得见「下了播放指令、播放事件回来了」，
 * 看不见「这一帧真的上屏了」。
 *
 * 输出：
 *   漂移曲线（每个标记一行）、45 秒与 163 秒累计漂移、任意 15 秒滑窗漂移
 *   黑场段落（YAVG < 16 且覆盖 ≥90%，按 §2.3 的定义）
 *   按 §2.4 的线逐条给过/不过
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import metrics from '../app/weapp-native/packages/video/gatea/metrics.js';

const input = process.argv[2];
if (!input) { console.error('用法: node scripts/analyze-gate-a-recording.mjs <录屏.mp4>'); process.exit(1); }
const MARKER_EVERY = Number(process.env.MARKER_EVERY || 15);
const WHITE_MIN = 200;   // 纯白标记帧
const BLACK_MAX = 16;    // §2.3 黑帧定义

const tmpY = '/tmp/.gatea-y.log', tmpA = '/tmp/.gatea-a.log';
run(['-i', input, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], tmpY);
run(['-i', input, '-af', 'bandpass=f=1000:width_type=h:w=50,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level', '-f', 'null', '-'], tmpA);

/** ffmpeg 把 metadata 打在 stderr，所以重定向 stderr 收结果，退出码不管。 */
function run(args, out) {
  const r = spawnSync('ffmpeg', ['-hide_banner', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
  writeFileSync(out, r.stderr || Buffer.alloc(0));
}

function parse(file, key) {
  const out = []; let t = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const mt = line.match(/pts_time:([\d.]+)/); if (mt) t = parseFloat(mt[1]);
    const mv = line.match(new RegExp(key.replace(/\./g, '\\.') + '=(-?[\\d.]+|-?inf)'));
    if (mv && t !== null) { const v = parseFloat(mv[1]); if (isFinite(v)) out.push({ t, v }); }
  }
  return out;
}

const y = parse(tmpY, 'lavfi.signalstats.YAVG');
const a = parse(tmpA, 'lavfi.astats.Overall.RMS_level');
if (!y.length) { console.error('没解析到画面亮度数据，确认录屏有视频轨'); process.exit(1); }

// 白帧：聚成组，一组算一个标记（防止一个标记被拍成连续两帧）
const white = group(y.filter((p) => p.v > WHITE_MIN).map((p) => p.t), 0.2);
// 1kHz 峰：高出中位数 20dB
const vals = a.map((p) => p.v).sort((x, z) => x - z);
const base = vals.length ? vals[Math.floor(vals.length / 2)] : -60;
const peaks = group(a.filter((p) => p.v > base + 20).map((p) => p.t), 1);

function group(times, gap) {
  const out = [];
  for (const t of times) if (!out.length || t - out[out.length - 1] > gap) out.push(t);
  return out;
}

// 漂移 = 音频峰时刻 − 白帧时刻（正数为音频滞后）
const series = [];
for (const w of white) {
  if (!peaks.length) break;
  const p = peaks.reduce((b, x) => (Math.abs(x - w) < Math.abs(b - w) ? x : b), peaks[0]);
  if (Math.abs(p - w) < MARKER_EVERY / 2) series.push({ t: Math.round(w * 100) / 100, d: Math.round((p - w) * 10000) / 10 });
}

// 黑场：连续 YAVG < 16 的段落
const blacks = [];
let run0 = null;
for (const p of y) {
  if (p.v < BLACK_MAX) { if (!run0) run0 = { from: p.t, to: p.t }; else run0.to = p.t; }
  else if (run0) { blacks.push((run0.to - run0.from) * 1000); run0 = null; }
}
if (run0) blacks.push((run0.to - run0.from) * 1000);

console.log(`\n素材 ${input}`);
console.log(`白帧标记 ${white.length} 个 · 1kHz 峰 ${peaks.length} 个 · 配上 ${series.length} 对\n`);
console.log('时刻(s)   漂移(ms)');
for (const s of series) console.log(String(s.t).padStart(7) + '   ' + (s.d > 0 ? '+' : '') + s.d);

const d45 = metrics.driftAt(series, 45), d163 = metrics.driftAt(series, 163);
const swing = metrics.maxWindowSwing(series, 15);
console.log('\n—— 按协议 §2.4 判定 ——');
line('45 秒累计漂移', d45 === null ? null : Math.abs(d45), 200, 'ms');
line('黑场 P95', metrics.percentile(blacks, 95), 33, 'ms');
line('黑场 max', metrics.maxOf(blacks), 100, 'ms');
console.log('\n—— §2.5 修订建议，未拍板，不参与判定 ——');
line('163 秒累计漂移', d163 === null ? null : Math.abs(d163), 400, 'ms');
line('任意 15 秒滑窗漂移', swing, 125, 'ms');
console.log('\n注：切换间隙与首帧起播需要逐帧判读切换点，本脚本只给黑场与漂移；');
console.log('    间隙请配合端上埋点的 JSON 与 60fps 录屏逐帧核对（§1.6 双证据）。\n');

function line(name, v, lim, unit) {
  if (v === null || v === undefined) { console.log(name.padEnd(22) + '未采到'); return; }
  const r = Math.round(v * 10) / 10;
  console.log(name.padEnd(22) + String(r).padStart(8) + unit + '   线 ' + lim + unit + '   ' + (r <= lim ? '过' : '不过'));
}
try { unlinkSync(tmpY); unlinkSync(tmpA); } catch (e) {}
