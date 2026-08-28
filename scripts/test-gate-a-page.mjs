#!/usr/bin/env node
/**
 * 闸门 A 页面的状态机自测（不需要开发者工具、不需要真机）。
 *
 * 把小程序运行时（Page / wx / host）全部打桩，用**假时钟**把 163 秒连播跑完，
 * 检查这些事：
 *   - 22 段边界一个不落，切换正好 21 次，且每次都切到对的段
 *   - 每次切换前都已经预热过下一段（没预热的切换就是黑场）
 *   - 主时钟是音频：把音频时间强行拨快，画面要被拉回来，漂移不许累积
 *   - 音频结束时正常收尾出报告
 *
 * 这一层过了只说明**逻辑**对。切换间隙、黑场、真实解码压力必须上真机测（协议 §2）。
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
import path from 'node:path';

const PAGE = '/Users/donis/dev/ai-pilot-gate-a/app/weapp-native/packages/video/gatea/index.js';

// ── 假时钟：所有 setTimeout / setInterval 进虚拟队列，由 advance() 推动 ──────────
let now = 0, seq = 0;
const timers = new Map();
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: 0 }); return id; };
global.setInterval = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: ms || 1 }); return id; };
global.clearTimeout = (id) => timers.delete(id);
global.clearInterval = (id) => timers.delete(id);

function advance(ms) {
  const target = now + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
    if (!next) break;
    const [id, t] = next;
    now = t.at;
    if (t.every) t.at = now + t.every; else timers.delete(id);
    t.fn();
  }
  now = target;
}

// ── 运行时打桩 ───────────────────────────────────────────────────────────────
const videos = {};   // id -> { src, playing, currentTime, plays, seeks }
const vctx = (id) => {
  if (!videos[id]) videos[id] = { playing: false, currentTime: 0, plays: 0, seeks: 0 };
  const v = videos[id];
  return {
    play: () => { v.playing = true; v.plays++; realTick(id); },
    pause: () => { v.playing = false; },
    stop: () => { v.playing = false; v.currentTime = 0; },
    seek: (t) => { v.currentTime = t; v.seeks++; },
  };
};
let page = null;
function realTick(id) {
  // 模拟 bindplay 回调
  if (page && page.onVideoPlay) page.onVideoPlay({ currentTarget: { dataset: { key: id === 'gv-a' ? 'a' : 'b' } } });
}

const audio = { currentTime: 0, playing: false, _ended: null, _err: null };
global.wx = {
  createVideoContext: (id) => vctx(id),
  createInnerAudioContext: () => ({
    set src(v) {}, set autoplay(v) {}, set obeyMuteSwitch(v) {},
    get currentTime() { return audio.currentTime; },
    play: () => { audio.playing = true; },
    stop: () => { audio.playing = false; }, destroy: () => {},
    onError: (f) => { audio._err = f; }, onEnded: (f) => { audio._ended = f; },
  }),
  setClipboardData: () => {},
};

const capturedPages = [];
global.Page = (o) => capturedPages.push(o);

// host.js 打桩
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req.endsWith('host.js')) {
    return { hostBaseData: () => ({}), toast: () => {}, back: () => {} };
  }
  return origLoad.apply(this, arguments);
};

const require_ = createRequire(import.meta.url);
require_(PAGE);
page = capturedPages[0];
page.setData = function (patch, cb) { Object.assign(this.data, patch); if (cb) cb(); };

// ── 跑 ──────────────────────────────────────────────────────────────────────
const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); console.log((cond ? '  ✓ ' : '  ✗ ') + msg); };

page.onLoad();

// 测状态机不需要真素材（wx 全是桩，不会去取任何东西），但需要真的段边界 ——
// 边界不真，「切换贴不贴合边界」这条就测了个假的。所以从 catalog 现推一份，
// 和线上首页用的是同一条路径（catalog.templateMeta → model.summarize）。
const model = require_('/Users/donis/dev/ai-pilot-gate-a/app/weapp-native/packages/video/model.js');
const catalog = require_('/Users/donis/dev/ai-pilot-gate-a/app/weapp-native/packages/video/catalog.js');
let acc = 0;
const realSegs = catalog.getBuiltInTemplate('ct_shiti').scriptSkeleton.segments.map((x) => {
  const dur = model.summarize([x]).totalSec;
  const row = { no: x.no, role: x.role, startSec: Math.round(acc * 100) / 100, durationSec: dur, url: `seg-${x.no}.mp4` };
  acc += dur; return row;
});
page.source = { id: 'test', label: '测试夹具（段边界取自 catalog）', totalSec: acc, audioUrl: 'audio.m4a', segments: realSegs, cues: [] };
page.setData({ manifestLabel: page.source.label, segCount: realSegs.length, totalSec: acc, runnable: true });

console.log(`清单：${page.data.manifestLabel}  ${page.data.segCount} 段 / ${page.data.totalSec} 秒`);
ok(page.data.segCount === 22 && page.data.totalSec === 163, 'ct_shiti 段边界对上运行时真值（22 段 / 163 秒）');

let pulledBack = false;
const swaps = [];
const origSwap = page.swapTo.bind(page);
page.swapTo = function (i) { swaps.push({ index: i, at: audio.currentTime, primed: this.primedIndex === i }); origSwap(i); };

let segs = [];
function playThrough() {
page.start();
advance(10);                                  // 让 A 的 bindplay 回来，音轨起来
ok(page.data.phase === 'playing', '首帧就绪后才起音轨（phase=playing）');

// 音频按真实速度走，视频跟着走。每 100ms 推一次。
  segs = page.live.segments;
for (let step = 0; step < 1700; step++) {
  audio.currentTime = Math.min(163, audio.currentTime + 0.1);
  // 音轨放完就该收尾。不这么写的话音频停在 163、视频还在往前跑，
  // 末尾会多出一段纯属夹具制造的漂移。
  if (audio.currentTime >= 163) { audio._ended && audio._ended(); break; }
  const key = page.data.activeKey === 'a' ? 'gv-a' : 'gv-b';
  const v = videos[key];
  if (v && v.playing) {
    v.currentTime += 0.1;
    page.onVideoTime({ currentTarget: { dataset: { key: page.data.activeKey } }, detail: { currentTime: v.currentTime } });
  }
  advance(100);

  // 跑到中段时把画面强行拨快 500ms，看下一拍会不会被拉回。
  // 必须在播放中测：放完页面已收尾，onTick 会直接返回，测了个寂寞。
  if (step === 300) {
    const k = page.data.activeKey === 'a' ? 'gv-a' : 'gv-b';
    const before = videos[k].seeks;
    page.lastVideoTime[page.data.activeKey] += 0.5;
    page.onTick();
    pulledBack = videos[k].seeks > before;
    videos[k].currentTime = page.lastVideoTime[page.data.activeKey] = Math.max(0, audio.currentTime - segs[page.data.segIndex].startSec);
  }
}
}
playThrough();
ok(pulledBack, '画面跑偏 500ms 时会被拉回音频位置（主时钟是音频）');

console.log('\n连播结束：');
ok(swaps.length === 21, `切换 ${swaps.length} 次（22 段应 21 次）`);
const wrongOrder = swaps.filter((s, i) => s.index !== i + 1);
ok(!wrongOrder.length, '切换顺序正确，没有跳段或重复' + (wrongOrder.length ? `（错的：${wrongOrder.map((w) => w.index).join(',')}）` : ''));
const cold = swaps.filter((s) => !s.primed);
ok(!cold.length, `每次切换前都已预热${cold.length ? `（没预热的：第 ${cold.map((c) => c.index + 1).join(',')} 段）` : ''}`);
const offBoundary = swaps.filter((s, i) => Math.abs(s.at - segs[i + 1].startSec) > 0.25);
ok(!offBoundary.length, '切换时刻贴合段边界（误差 ≤ 250ms）'
  + (offBoundary.length ? `（偏的：${offBoundary.slice(0, 3).map((o) => `#${o.index + 1} 差 ${((o.at - segs[o.index].startSec) * 1000).toFixed(0)}ms`).join(' ')}）` : ''));

ok(page.data.phase === 'done' && !!page.data.report, '音轨结束后出报告');
// 排掉上面故意注入的那一次扰动（30 秒附近），它是被测行为不是缺陷
const d = page.marks.drift.filter((x) => !(x.t >= 30 && x.t < 30.3));
const swing = d.length ? Math.max(...d.map((x) => x.d)) - Math.min(...d.map((x) => x.d)) : 0;
ok(Math.abs(swing) < 200, `整程漂移波动 ${Math.round(swing)}ms，没有随时间累积`);

const worst=[...d].sort((a,b)=>Math.abs(b.d)-Math.abs(a.d)).slice(0,6);
console.log('\n漂移最大的几个采样：', worst.map(x=>x.t+'s:'+x.d+'ms').join('  '));
const bnd=new Set(segs.map(x=>x.startSec));
console.log('其中落在段边界后 0.2s 内的：', worst.filter(x=>[...bnd].some(b=>x.t>=b&&x.t<b+0.25)).length,'/',worst.length);

// 协议 §1.4 要求一格跑 10 次并池算一次 P95。跑第二遍确认样本是累加不是覆盖。
const gaps1 = page.pool.gaps.length, runs1 = page.pool.runs;
audio.currentTime = 0; pulledBack = false; swaps.length = 0;
for (const k of Object.keys(videos)) { videos[k].currentTime = 0; videos[k].playing = false; }
playThrough();
ok(page.pool.runs === runs1 + 1, `跑第二遍后 runs=${page.pool.runs}（应 ${runs1 + 1}）`);
ok(page.pool.gaps.length === gaps1 * 2, `样本并池：间隙 ${gaps1} → ${page.pool.gaps.length}（应翻倍，不是覆盖）`);
page.clearPool();
ok(page.pool === null || page.data.runs === 0, '清空重来能倒掉池子');

console.log(fails.length ? `\n${fails.length} 项没过` : '\n全部通过');
process.exit(fails.length ? 1 : 0);
