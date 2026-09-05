#!/usr/bin/env node
// 桌面窗口预览台 · 把开发者工具里**真实渲染后**的 WXML 拉出来，转成可在浏览器里
// 任意拉宽的 HTML，用来验收 `resizable` 大窗口下五个主 Tab 的排版。
//
// 为什么需要它：开发者工具模拟器只给手机宽度，微信 PC 的真实窗口又没法在本地驱动。
// 但 WXSS 就是 CSS、WXML 渲染后就是一棵普通标签树 —— 把两者搬进浏览器，
// 断点(720 / 1100px)与 `viewport-medium / expanded` 的排版就能逐像素地看。
//
// 跑法：
//   1) npm run build:weapp                 # 产物 → app/dist-native
//   2) 开发者工具 → 设置 → 安全设置 → 打开「服务端口」
//   3) npm run preview:desktop             # 产物 → app/dist-desktop-preview/index.html
//   改完 SCSS 只想重看样式：npm run build:weapp && node scripts/desktop-preview.mjs --reuse
//
// 两个坑（2026-09-05 实测）：
//   · 开发者工具连着跑几轮之后路由会开始整片报 `Uncaught [object Object]`，五个 tab 全抓不到。
//     那是工具自己的状态烂了，不是产物的问题：`pkill -9 -f wechatwebdevtools` 再起一次 cli auto 即可。
//   · 工具已经带着这个项目在跑时不要重复喊 `cli auto`，它会卡在 "preparing" 直到超时——
//     下面的 enableAutomation 先探端口就是为了这个。
//
// 它只搬结构与样式，不搬交互：截出来的东西能量宽度、能看断点，不能点。
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(APP_ROOT, 'package.json'));
const args = process.argv.slice(2);

// 同 video-e2e：0.12.1 的 checkVersion 读不到新版工具版本号，直接建连绕开。
const Connection = require('miniprogram-automator/out/Connection').default;
const MiniProgram = require('miniprogram-automator/out/MiniProgram').default;

const PROJECT = path.join(APP_ROOT, 'dist-native');
const CLI = process.env.WEAPP_CLI || '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const PORT = Number(process.env.WEAPP_AUTO_PORT || 9421);
const OUT = process.env.WEAPP_DESKTOP_PREVIEW || path.join(APP_ROOT, 'dist-desktop-preview');

// prepare：桌面专属节点在手机宽度下根本不渲染（wx:if 为假），不先把开关打开就抓不到。
// 这里改的是**页面自己的 data**，不是伪造结构——抓到的仍是小程序真实渲染出来的那棵树。
const TABS = [
  { key: 'sessions', route: '/pages/sessions/index', label: '问策',
    prepare: (page) => page.setData({ railOn: true }) },
  { key: 'home', route: '/pages/home/index', label: '战局' },
  { key: 'execution', route: '/pages/execution/index', label: '今日' },
  { key: 'thinktank', route: '/pages/thinktank/index', label: '图籍' },
  { key: 'profile', route: '/pages/profile/index', label: '主公' },
  // 不是 tab，但它是问策侧栏里点任何一位军师之后落地的地方，桌面排版一样要核。
  { key: 'chat', route: '/packages/main/chat/index?agentKey=general', label: '对话',
    wxss: 'packages/main/chat/index.wxss' },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 端口已经在监听就别再喊一次 `cli auto`：工具已经带着这个项目起来时，
 * 再执行一次会卡在 "preparing" 直到超时被 SIGTERM，整条链路就白等两分钟。
 */
async function portIsLive() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}`, { signal: AbortSignal.timeout(2000) });
    return res.status === 426 || (await res.text()).includes('Upgrade');
  } catch (_) { return false; }
}

async function enableAutomation() {
  if (await portIsLive()) { console.log(`[preview] 自动化端口 ${PORT} 已在监听，跳过 cli auto`); return; }
  await new Promise((resolve, reject) => {
    execFile(CLI, ['auto', '--project', PROJECT, '--auto-port', String(PORT)],
      { timeout: 180000 }, (error) => (error ? reject(error) : resolve()));
  });
}

async function connectWithRetry(attempts = 20) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try { return new MiniProgram(await Connection.create(`ws://127.0.0.1:${PORT}`)); }
    catch (error) { lastError = error; await wait(1000); }
  }
  throw lastError;
}

/** WXML → HTML：只做标签改名与属性清洗，class 一个字都不动（样式全靠它命中）。 */
const TAG_MAP = {
  view: 'div', 'scroll-view': 'div', 'cover-view': 'div', 'movable-area': 'div', 'movable-view': 'div',
  text: 'span', 'cover-image': 'img', image: 'img', block: 'div',
  swiper: 'div', 'swiper-item': 'div', navigator: 'a', form: 'div', label: 'label',
  textarea: 'textarea', input: 'input', button: 'button', canvas: 'canvas',
  video: 'video', 'rich-text': 'div', progress: 'div', slider: 'div', switch: 'div',
  checkbox: 'div', radio: 'div', picker: 'div', 'picker-view': 'div',
};

function wxmlToHtml(wxml) {
  let html = wxml;
  // 事件绑定与小程序私有属性在浏览器里没有意义，留着只会污染 DOM。
  html = html.replace(/\s(?:bind|catch|capture-bind|capture-catch|mut-bind):?[a-zA-Z-]+="[^"]*"/g, '');
  html = html.replace(/\s(?:wx:[a-zA-Z-]+|data-[a-zA-Z-]+|scroll-into-view|scroll-top|enhanced|show-scrollbar|scroll-with-animation|scroll-y|scroll-x|hover-class|lazy-load|aria-[a-zA-Z-]+)="[^"]*"/g, '');
  html = html.replace(/\s(?:scroll-y|scroll-x|enhanced|scroll-with-animation)(?=[\s/>])/g, '');
  // 自闭合的小程序组件（native-icon 等）先落成占位方块，保住它们在行内占的位置。
  html = html.replace(/<([a-z][a-z0-9-]*)([^>]*?)\/>/g, '<$1$2></$1>');
  for (const [wx, dom] of Object.entries(TAG_MAP)) {
    html = html.replace(new RegExp(`<${wx}(?=[\\s>])`, 'g'), `<${dom}`);
    html = html.replace(new RegExp(`</${wx}>`, 'g'), `</${dom}>`);
  }
  // 未映射的自定义组件（native-icon / chat-* 等）统一收成 <i>，给一个固定尺寸的占位。
  html = html.replace(/<((?!\/)(?:native|chat|wx)-[a-z0-9-]+)([^>]*)>/g, '<i data-cmp="$1"$2>');
  html = html.replace(/<\/(?:native|chat|wx)-[a-z0-9-]+>/g, '</i>');
  // <img> 在 HTML 里不能有闭合标签；空 src 会画出破图占位，去掉。
  html = html.replace(/<img([^>]*)><\/img>/g, '<img$1>');
  html = html.replace(/<img([^>]*?)\ssrc="(?!http|data:)[^"]*"/g, '<img$1');
  return html;
}

function readWxss(...segments) {
  const file = path.join(PROJECT, ...segments);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/** WXSS 里的 @import 是相对路径；预览台把它们拍平成一份大 CSS。 */
function inlineImports(css, baseDir, seen = new Set()) {
  return css.replace(/@import\s+["']([^"']+)["'];?/g, (_, ref) => {
    const target = path.resolve(baseDir, ref);
    if (seen.has(target) || !fs.existsSync(target)) return '';
    seen.add(target);
    return inlineImports(fs.readFileSync(target, 'utf8'), path.dirname(target), seen);
  });
}

async function main() {
  if (!fs.existsSync(PROJECT)) {
    console.error(`产物不存在：${PROJECT}\n先跑 npm run build:weapp`);
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // --reuse：只重新拼 HTML（结构吃上一轮的 captured.json，样式重新读 dist-native）。
  // 改 SCSS 时的迭代循环因此是 `build:weapp` + 这一条，不必再开一遍开发者工具。
  if (args.includes('--reuse')) {
    const snapshot = path.join(OUT, 'captured.json');
    if (!fs.existsSync(snapshot)) { console.error(`没有可复用的结构快照：${snapshot}\n先跑一次完整抓取`); process.exit(2); }
    writeShell(JSON.parse(fs.readFileSync(snapshot, 'utf8')));
    return;
  }

  await enableAutomation();
  const miniProgram = await connectWithRetry();
  // `auto` 返回时工具往往还在编译；systemInfo 这类调用会直接超时。先给它一段编译时间。
  await wait(Number(process.env.WEAPP_BOOT_WAIT || 8000));
  miniProgram.on('exception', () => {});   // 页面异常不该把预览台带崩
  const info = await miniProgram.callWxMethod('getSystemInfo');
  console.log(`[preview] 模拟器 ${info.windowWidth}x${info.windowHeight} · 基础库 ${info.SDKVersion}`);

  // 五个 tab 的首屏在游客态几乎都是空壳（「还没有建档」「登录后…」），拿它量排版等于白量。
  // 与 video-e2e 同一套约定：'local-user' 不是三段 JWT → isLoggedIn 为真而仍走 mock 数据。
  await miniProgram.callWxMethod('setStorageSync', 'junshi.userId', 'local-user');
  await miniProgram.callWxMethod('setStorageSync', 'junshi.onboarded', true);

  const captured = [];
  for (const tab of TABS) {
    // reLaunch 而不是 switchTab：工具停在非 tab 页时 switchTab 会直接抛，
    // 而每个 tab 本来就要从干净的栈重新进一次才拿得到首屏结构。
    // mock 模式下页面自己会因为连不上 localhost:4000 抛异常，工具把它当成调用失败回过来；
    // 路由其实已经完成，所以这里只记录不中断——预览台要的是结构，不是链路健康。
    try { await miniProgram.reLaunch(tab.route); }
    catch (error) { console.warn(`[preview] ! ${tab.label} 路由期页面抛错：${error.message}`); }
    await wait(2600);
    const page = await miniProgram.currentPage();
    if (tab.prepare) { try { await tab.prepare(page); await wait(600); } catch (e) { console.warn(`[preview] ! ${tab.label} prepare 失败：${e.message}`); } }
    const root = (await page.$('.native-page')) || (await page.$('.wence-page')) || (await page.$('.chat-page'));
    if (!root) { console.warn(`[preview] ✘ ${tab.label} 找不到页面根节点`); continue; }
    const wxml = await root.outerWxml();
    captured.push({ ...tab, html: wxmlToHtml(wxml) });
    console.log(`[preview] ✔ ${tab.label} ${wxml.length} 字节`);
  }
  miniProgram.disconnect();

  fs.writeFileSync(path.join(OUT, 'captured.json'), JSON.stringify(captured, null, 2));
  writeShell(captured);
}

function writeShell(captured) {
  const appCss = inlineImports(readWxss('app.wxss'), PROJECT);
  const pageCss = captured.map((tab) => {
    const file = path.join(PROJECT, tab.wxss || `pages/${tab.key}/index.wxss`);
    const css = fs.existsSync(file) ? inlineImports(fs.readFileSync(file, 'utf8'), path.dirname(file)) : '';
    return `/* ===== ${tab.label} ===== */\n${css}`;
  }).join('\n');
  fs.writeFileSync(path.join(OUT, 'index.html'), renderShell(captured, appCss, pageCss));
  console.log(`[preview] → ${path.join(OUT, 'index.html')}`);
}

function renderShell(tabs, appCss, pageCss) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>军师 · 桌面窗口预览台</title>
<style>
  /* 预览台外壳（不是产品样式）：一个可拉伸的窗口盒 + 档位标尺。 */
  html, body { margin: 0; background: #2A2D31; font: 13px/1.5 -apple-system, "PingFang SC", sans-serif; }
  .rig { padding: 16px; }
  .rig-bar { position: sticky; top: 0; z-index: 9999; display: flex; gap: 8px; align-items: center;
    padding: 10px 12px; margin-bottom: 12px; background: #16191D; color: #E6E7E9; border-radius: 10px; }
  .rig-bar button { font: inherit; padding: 5px 12px; border-radius: 999px; border: 1px solid #3A3F45;
    background: #22262B; color: #E6E7E9; cursor: pointer; }
  .rig-bar button.on { background: #1E5A43; border-color: #1E5A43; }
  .rig-w { margin-left: auto; font-variant-numeric: tabular-nums; opacity: .75; }
  /* 舞台按真实窗口宽度排版，再整体缩放塞进浏览器可视区 —— 缩放只改观感尺寸，
     不改 CSS 断点命中的那个宽度，所以 720 / 1100 的分档看到的仍是真的。 */
  .stage-wrap { overflow: hidden; margin: 0 0 16px; }
  .stage { background: #FBFAF6; box-shadow: 0 8px 40px rgba(0,0,0,.4); overflow: hidden;
    transform-origin: 0 0; }
  .stage-h { padding: 6px 10px; background: #16191D; color: #9AA0A6; font-size: 11px; }
  /* 页面根节点在真机是整屏；预览台给它一个固定高度的舞台。 */
  .stage .native-page, .stage .wence-page, .stage .chat-page { height: 760px; position: relative; overflow: hidden; }
  .stage .native-scroll { height: 760px; overflow: hidden; }
  /* 未映射的自定义组件占位：保住图标在行内的尺寸，不让排版塌掉。 */
  i[data-cmp] { display: inline-block; width: 1em; height: 1em; vertical-align: -.12em;
    background: currentColor; opacity: .35; border-radius: 3px; }
  img { max-width: 100%; }
</style>
<style id="app-wxss">${appCss}</style>
<style id="page-wxss">${pageCss}</style>
</head><body>
<div class="rig">
  <div class="rig-bar">
    <strong style="margin-right:6px">窗口宽度</strong>
    ${[390, 720, 900, 1100, 1280, 1440].map((w) => `<button data-w="${w}">${w}</button>`).join('')}
    <button data-w="full">铺满</button>
    <span class="rig-w"></span>
  </div>
  ${tabs.map((tab) => `
  <div class="stage-wrap">
    <div class="stage" data-key="${tab.key}">
      <div class="stage-h">${tab.label} · ${tab.route}</div>
      ${tab.html}
    </div>
  </div>`).join('')}
</div>
<script>
  var stages = document.querySelectorAll('.stage');
  var readout = document.querySelector('.rig-w');
  // 真机的档位由 services/page.js#viewportData 按当前栏宽算；预览台按同一条断点复刻，
  // 这样这里看到的 compact / medium / expanded 与线上是同一套判据。
  function classify(w) { return w >= 1100 ? 'expanded' : (w >= 720 ? 'medium' : 'compact'); }
  function apply(w) {
    var avail = document.querySelector('.rig').clientWidth - 32;
    var px = w === 'full' ? avail : Number(w);
    var scale = Math.min(1, avail / px);
    stages.forEach(function (stage) {
      stage.style.width = px + 'px';
      stage.style.transform = 'scale(' + scale + ')';
      stage.parentNode.style.height = Math.round((760 + 22) * scale) + 'px';
      var root = stage.querySelector('.native-page, .wence-page, .chat-page');
      if (!root) return;
      root.classList.remove('viewport-compact', 'viewport-medium', 'viewport-expanded');
      root.classList.add('viewport-' + classify(px));
      // 抓取时强开了问策的常驻侧栏（否则手机宽度下那棵树根本不渲染）。
      // 这里按真实规则还原：只有 expanded 才有栏；窄档把它收回半屏抽屉的"关着"状态。
      var rail = classify(px) === 'expanded';
      var sheet = root.querySelector('.wd-sheet');
      if (sheet) {
        root.classList.toggle('rail-on', rail);
        sheet.classList.toggle('as-rail', rail);
        sheet.style.display = rail ? '' : 'none';
      }
      root.style.setProperty('--window-width', px + 'px');
      root.style.setProperty('--window-height', '760px');
    });
    readout.textContent = px + 'px · viewport-' + classify(px) + ' · 显示 ' + Math.round(scale * 100) + '%';
    document.querySelectorAll('.rig-bar button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.w === String(w));
    });
  }
  window.addEventListener('resize', function () {
    var on = document.querySelector('.rig-bar button.on');
    if (on) apply(on.dataset.w);
  });
  document.querySelectorAll('.rig-bar button').forEach(function (b) {
    b.addEventListener('click', function () { apply(b.dataset.w); });
  });
  apply(1280);
</script>
</body></html>`;
}

main().catch((error) => { console.error(error); process.exit(1); });
