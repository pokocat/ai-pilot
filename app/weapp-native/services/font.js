// 自带中文衬线字体（思源宋体 SC 子集，2026-08-09）。
//
// 为什么必须自带：小程序既没有 H5 那样的 <link>，也没有任何 webfont，字体 100% 靠设备
// —— 而各家安卓 ROM 对 generic `serif` 的映射各装各的，同一版包在不同机型上一个宋体一个黑体
// （真机实拍两种都见过）。这一层在 CSS 里没有任何办法拉平，堆字体族名也没用。
// 对照组：H5 之所以「到哪都是宋体」，是因为它在 index.html 里下载 Google Fonts 的 Noto Serif SC。
//
// 口径：
//   · family 名走 FONT_FAMILY，CSS 字体栈里它排第一位；没加载成功就自然落到系统字体，不白屏不报错。
//   · 400/600 各发一份（正文与标题），合计约 1.8MB。只发这两个字重：再多就是为观感付流量。
//   · 只发 woff2（同一份文件也供 H5 用）。若真机验出老基础库加载不上，再补一份 ttf 作第二 src。
//   · global:true + scopes 覆盖 webview 与 native 组件；只在 onLaunch 调一次，字体文件由微信缓存。
//   · 失败一律静默：字体是观感增强，不该为它弹东西给用户，也不该阻塞启动。
//   · FONT_BASE 为空（本地调试想关掉时）直接跳过，这条路径必须永远可用。
const env = require('../config/env');

let started = false;

function sourceFor(base, weight) {
  return `url("${base}/junshi-serif-${weight}.woff2") format("woff2")`;
}

function loadAppFont() {
  if (started) return;
  started = true;
  const base = String(env.FONT_BASE || '').trim().replace(/\/+$/, '');
  const family = String(env.FONT_FAMILY || '').trim();
  const weights = Array.isArray(env.FONT_WEIGHTS) ? env.FONT_WEIGHTS : [];
  if (!base || !family || !weights.length) return;
  if (typeof wx === 'undefined' || typeof wx.loadFontFace !== 'function') return;
  weights.forEach((weight) => {
    wx.loadFontFace({
      family,
      source: sourceFor(base, weight),
      desc: { style: 'normal', weight: String(weight) },
      global: true,
      scopes: ['webview', 'native'],
      success: () => {},
      fail: () => {},
    });
  });
}

module.exports = { loadAppFont, sourceFor };
