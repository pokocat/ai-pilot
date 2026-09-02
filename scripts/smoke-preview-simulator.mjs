#!/usr/bin/env node
/** 在开发者工具模拟器里把单轨时间线预览页跑一遍：读数据、播 6 秒、点段、截图。 */
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const AUTO = '/Users/donis/dev/ai-pilot-gate-a/app/node_modules/miniprogram-automator/out/';
const automator = req(AUTO + 'index.js');
req(AUTO + 'MiniProgram.js').default.prototype.checkVersion = async function () {};
const PID = process.env.PID || 'cp_mock';
const OUT = process.env.SHOT || '/private/tmp/claude-501/-Users-donis-dev-ai-pilot/469b0a30-94ed-4e85-8944-f73530f1447a/scratchpad/preview';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
let page = null;
for (let i = 0; i < 10; i++) {
  try { await mp.navigateTo(`/packages/video/preview/index?projectId=${PID}`); } catch (e) {}
  await sleep(2000); page = await mp.currentPage();
  if (page && page.path.indexOf('preview') >= 0) break;
}
if (!page || page.path.indexOf('preview') < 0) { console.error('没跳到预览页，当前 ' + (page && page.path)); process.exit(1); }
await sleep(1500);
let d = await page.data();
console.log(`标题「${d.title}」 段数 ${d.clips.length} 总长 ${d.totalText} 有配音=${d.hasAudio}`);
console.log('底栏 A:', d.footA); console.log('底栏 B:', d.footB);
console.log('段 kind 分布:', JSON.stringify(d.clips.reduce((m, c) => { m[c.kind] = (m[c.kind] || 0) + 1; return m; }, {})));
await mp.screenshot({ path: OUT + '-idle.png' });

await page.callMethod('play'); await sleep(6500);
d = await page.data();
console.log(`播 6.5s 后：playing=${d.playing} 第 ${d.segIndex + 1} 段 时钟 ${d.clockText} 播放头 ${d.headPx}px layer=${d.layer}`);
await mp.screenshot({ path: OUT + '-playing.png' });

await page.callMethod('pickClip', { currentTarget: { dataset: { i: 6 } } }); await sleep(1200);
d = await page.data();
console.log(`点第 7 段后：playing=${d.playing} 第 ${d.segIndex + 1} 段 ${d.cur.roleName} 时钟 ${d.clockText} ops=${d.cur.ops.map((o) => o.label).join('/')}`);
await mp.screenshot({ path: OUT + '-picked.png' });
await page.callMethod('pickClip', { currentTarget: { dataset: { i: d.clips.length - 1 } } }); await sleep(800);
d = await page.data(); console.log(`点最后一段：${d.cur.roleName} locked=${d.cur.locked}`);
await mp.disconnect();
