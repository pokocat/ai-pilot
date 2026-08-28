#!/usr/bin/env node
/**
 * 在开发者工具模拟器里跑一次闸门 A 连播，把埋点报告取回来。
 *
 * 模拟器**不是判据环境**（协议 §1.1 判定只看 A-low 与 I-old 两台真机）。
 * 它能回答的是：双缓冲切换在真实小程序运行时里成不成立、音轨能不能当主时钟、
 * 22 段跑完会不会崩。真机跑之前先在这里把这些问题清掉，省真机时间。
 */
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const AUTO = '/Users/donis/dev/ai-pilot-gate-a/app/node_modules/miniprogram-automator/out/';
const automator = req(AUTO + 'index.js');
// automator 0.12.1 比当前开发者工具老，握手拿不到版本号，checkVersion 会在
// cmpVersion(undefined) 上炸。这个检查只是提示兼容性，跟本次要测的东西无关，跳过。
const MiniProgram = req(AUTO + 'MiniProgram.js').default;
MiniProgram.prototype.checkVersion = async function () {};

const PORT = Number(process.env.AUTO_PORT || 9420);
const PAGE = '/packages/video/gatea/index';
const WAIT_SEC = Number(process.env.WAIT_SEC || 200);

const mp = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${PORT}` });
console.log('已连上模拟器');

// 重建之后小程序会重启，navigateTo 可能落在启动流程里被吞掉。重试到真的到了为止。
let page = null;
for (let i = 0; i < 12; i++) {
  try { await mp.navigateTo(PAGE); } catch (e) { /* 启动中，等下一轮 */ }
  await new Promise((r) => setTimeout(r, 2000));
  page = await mp.currentPage();
  if (page && page.path && page.path.indexOf('gatea') >= 0) break;
  console.log(`  第 ${i + 1} 次跳转，当前还在 ${page && page.path}`);
}
if (!page || page.path.indexOf('gatea') < 0) { console.error('跳不过去，当前页 ' + (page && page.path)); process.exit(1); }
console.log('当前页:', page.path);

const d0 = await page.data();
console.log(`清单：${d0.manifestLabel}  ${d0.segCount} 段 / ${d0.totalSec} 秒  可跑=${d0.runnable}`);
if (!d0.runnable) { console.error('清单不可跑，先填 manifest.js 的 REAL'); process.exit(1); }

await page.callMethod('start');
const t0 = Date.now();
let last = -1;
for (let i = 0; i < WAIT_SEC; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const d = await page.data();
  if (d.segIndex !== last) {
    process.stdout.write(`\r  ${d.audioSec}s  第 ${d.segNo} 段/${d.segRole}  漂移 ${d.driftMs}ms      `);
    last = d.segIndex;
  }
  if (d.phase === 'done') { console.log('\n连播结束，用时 ' + Math.round((Date.now() - t0) / 1000) + 's'); break; }
  if (d.phase === 'idle') { console.log('\n没起来'); break; }
}

const d = await page.data();
if (d.report) {
  console.log('\n采样数:', JSON.stringify(d.report.counts));
  console.log('\n指标                       实测       线');
  for (const c of d.report.checks) {
    console.log(String(c.name).padEnd(22) + String(c.value === null ? '未采到' : c.value + c.unit).padStart(9)
      + '   ' + (c.line + c.unit).padStart(7) + '  ' + (c.ok === null ? '' : (c.ok ? '过' : '不过')));
  }
  console.log('\n（§2.5 建议，不参与判定）');
  for (const c of d.report.proposed) {
    console.log(String(c.name).padEnd(22) + String(c.value === null ? '未采到' : c.value + c.unit).padStart(9)
      + '   ' + (c.line + c.unit).padStart(7));
  }
  if (d.report.rate) {
    const r = d.report.rate;
    console.log(`\n画面播放速率：中位数 ${r.median}× · 最低 ${r.min}×（${r.n} 个采样）`);
    console.log(r.median < 0.9 ? '  → 解码跟不上，漂移数据在这个环境下不作数（协议 §1.1 判定只看真机）'
                               : '  → 播放器跟得上，漂移反映的是逻辑本身');
  }
  const s = d.report.series || [];
  if (s.length) {
    const ds = s.map((x) => x.d);
    console.log(`\n漂移曲线 ${s.length} 点：最小 ${Math.min(...ds)}ms 最大 ${Math.max(...ds)}ms`);
    console.log('抽样 ' + s.filter((_, i) => i % Math.ceil(s.length / 12) === 0).map((x) => `${x.t}s:${x.d}`).join('  '));
  }
} else {
  console.log('没拿到报告，phase =', d.phase);
}
await mp.disconnect();
