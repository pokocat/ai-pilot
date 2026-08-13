#!/usr/bin/env node
// 把 src/assets/video/promo-banner.svg 渲染成 PNG。
//
// 为什么要转 PNG：微信 <image> 对 SVG 的支持在各基础库/机型上不一致（iOS 常整块空白），
// 而横幅是首页门面，不能赌。SVG 留在仓库里当可编辑源，PNG 是发布产物。
//
// sharp 来自 server/node_modules（app 侧没装，不为一张图再拉一份依赖）。
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ROOT = path.resolve(APP_ROOT, '..', 'server');
const require = createRequire(path.join(SERVER_ROOT, 'package.json'));

let sharp;
try { sharp = require('sharp'); }
catch (_) {
  console.error('未找到 sharp（预期在 server/node_modules）。先在 server/ 跑一次 npm i。');
  process.exit(2);
}

const SRC = path.join(APP_ROOT, 'src', 'assets', 'video', 'promo-banner.svg');
const OUT = path.join(APP_ROOT, 'src', 'assets', 'video', 'promo-banner.png');

if (!fs.existsSync(SRC)) { console.error(`源文件不存在：${SRC}`); process.exit(2); }

// 2 倍图：端上显示 350×168，出 1500×720 覆盖 3x 屏也不糊。
await sharp(fs.readFileSync(SRC), { density: 288 })
  .resize(1500, 720, { fit: 'fill' })
  .png({ compressionLevel: 9, palette: true })
  .toFile(OUT);

const bytes = fs.statSync(OUT).size;
console.log(`✓ ${path.relative(APP_ROOT, OUT)} — ${(bytes / 1024).toFixed(0)} KB`);
if (bytes > 300 * 1024) console.warn('⚠️ 超过 300KB，分包体积敏感，考虑降分辨率或减少渐变。');
