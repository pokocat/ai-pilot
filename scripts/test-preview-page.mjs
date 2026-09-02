#!/usr/bin/env node
/**
 * 单轨时间线预览页的状态机自测（打桩 wx/Page/host/api，假时钟）。
 * 模拟器里的 mock 项目全是空白段，双缓冲那条路跑不到；这里喂一份带视频地址的项目，
 * 专门验：段表构建、播放中按边界切段且 a/b 交替、切段前已预热、点段暂停并定位、播完归零。
 */
import { createRequire } from 'node:module';
import Module from 'node:module';
const PAGE = '/Users/donis/dev/ai-pilot-gate-a/app/weapp-native/packages/video/preview/index.js';

let now = 0, seq = 0; const timers = new Map();
global.setTimeout = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: 0 }); return id; };
global.setInterval = (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn, every: ms || 1 }); return id; };
global.clearTimeout = (id) => timers.delete(id); global.clearInterval = (id) => timers.delete(id);
const realDateNow = Date.now; Date.now = () => now;
function advance(ms) {
  const target = now + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
    if (!next) break; const [id, t] = next; now = t.at;
    if (t.every) t.at = now + t.every; else timers.delete(id); t.fn();
  }
  now = target;
}

const videos = {}; const calls = [];
global.wx = {
  createVideoContext: (id) => { const v = videos[id] || (videos[id] = { t: 0, playing: false }); return {
    play: () => { v.playing = true; calls.push(['play', id]); }, pause: () => { v.playing = false; calls.push(['pause', id]); },
    seek: (t) => { v.t = t; calls.push(['seek', id, t]); }, stop: () => { v.playing = false; } }; },
  createInnerAudioContext: () => ({ set src(v) {}, set obeyMuteSwitch(v) {}, currentTime: 0, play() {}, pause() {}, seek() {}, destroy() {}, onEnded() {}, onError() {} }),
};
const pages = []; global.Page = (o) => pages.push(o);

// 22 段 ct_shiti 真实段，配 3 个视频素材 + 数字人预览图，尾段固定
const req = createRequire(import.meta.url);
const model = req('/Users/donis/dev/ai-pilot-gate-a/app/weapp-native/packages/video/model.js');
const catalog = req('/Users/donis/dev/ai-pilot-gate-a/app/weapp-native/packages/video/catalog.js');
const seed = catalog.getBuiltInProjectSeed('ct_shiti');
const segments = catalog.getBuiltInTemplate('ct_shiti').scriptSkeleton.segments;
const shots = model.defaultShots(segments).map((s, i) => Object.assign({}, s, s.role === 'broll' ? { assetId: 'v' + (i % 3) } : {}));
const project = { id: 'p1', title: '为实体发声 · 测试', segments, shots, avatarId: 'av1' };
const assets = [0, 1, 2].map((i) => ({ id: 'v' + i, kind: 'video', contentUrl: `https://x/seg-${i}.mp4`, durationSec: 9 }));
const avatars = [{ id: 'av1', imagePreviewUrl: 'https://x/avatar.jpg', imageStatus: 'ready' }];

const origLoad = Module._load;
Module._load = function (r, parent) {
  if (/\/host$/.test(r) || r.endsWith('host.js')) return { hostBaseData: () => ({}), toast: () => {}, back: () => {}, go: (p) => calls.push(['go', p]), requireLogin: () => true, readDraft: () => null };
  if (/\/api$/.test(r)) return { project: async () => project, assets: async () => assets, avatars: async () => avatars };
  return origLoad.apply(this, arguments);
};
req(PAGE);
const page = pages[0];
page.setData = function (patch, cb) { Object.assign(this.data, patch); if (cb) cb(); };

const fails = []; const ok = (c, m) => { if (!c) fails.push(m); console.log((c ? '  ✓ ' : '  ✗ ') + m); };

page.onLoad({ projectId: 'p1' });
await new Promise((r) => realDateNow && setImmediate(r)); await new Promise((r) => setImmediate(r));
const clips = page.clips || [];
ok(clips.length === shots.length, `段表 ${clips.length} 段（镜头数 ${shots.length}）`);
const kinds = clips.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m; }, {});
ok(kinds.video > 0 && kinds.image > 0, `段类型齐全：${JSON.stringify(kinds)}（数字人段用预览图，配画面段是视频）`);
ok(clips[clips.length - 1].locked && clips[clips.length - 1].role === 'tail', '最后一段是固定片段且锁定');
ok(page.data.footB.indexOf('待生成') > 0 && page.data.footA.indexOf('共') > 0, '底栏两行文案已生成');
ok(page.data.cur && page.data.segIndex === 0, '初始显示第 1 段');

// 播放到底：按边界切段
const layers = [page.data.layer]; const segs = [0]; let primes = 0;
const origPrime = page.prime.bind(page); page.prime = function (i) { const before = this.primedIndex; origPrime(i); if (this.primedIndex !== before) primes++; };
page.play();
for (let step = 0; step < page.data.total * 10 + 20; step++) {
  advance(100);
  if (!page.data.playing) break;   // 播完会归零到第 1 段，那不算经过一段
  if (page.data.segIndex !== segs[segs.length - 1]) { segs.push(page.data.segIndex); layers.push(page.data.layer); }
}
ok(segs.length === clips.length, `播放中经过 ${segs.length} 段（应 ${clips.length}）：${segs.join(',')}`);
const videoSwaps = clips.filter((c, i) => i > 0 && c.kind === 'video' && clips[i - 1].kind === 'video').length;
const alt = layers.filter((l, i) => i > 0 && l !== 'img' && l !== 'blank' && layers[i - 1] !== 'img' && layers[i - 1] !== 'blank' && l !== layers[i - 1]).length;
ok(alt >= videoSwaps, `视频→视频切换 ${videoSwaps} 次，a/b 交替 ${alt} 次`);
ok(primes >= kinds.video - 1, `预热 ${primes} 次（视频段 ${kinds.video}）`);
ok(!page.data.playing && page.data.segIndex === 0, '播完自动回到第 1 段并停止');

// 点段：暂停 + 定位
page.play(); advance(3000);
page.pickClip({ currentTarget: { dataset: { i: 5 } } });
ok(!page.data.playing && page.data.segIndex === 5 && Math.abs(page.t - clips[5].from) < 1e-9, `点第 6 段：暂停，时钟落在 ${clips[5].from}s`);
ok(page.data.cur.ops.length === (clips[5].role === 'tail' ? 0 : 2), `第 6 段（${clips[5].roleName}）给出 ${page.data.cur.ops.length} 个操作`);
page.onOp({ currentTarget: { dataset: { key: 'asset' } } });
ok(calls.some((c) => c[0] === 'go' && /assets\/index\?pick=1/.test(c[1])), '「换画面」跳素材库并带 shotId');
page.generate();
ok(calls.some((c) => c[0] === 'go' && /confirm\/index/.test(c[1])), '「立即生成」跳确认扣费');

console.log(fails.length ? `\n${fails.length} 项没过` : '\n全部通过'); process.exit(fails.length ? 1 : 0);
