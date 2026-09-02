import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { swiperRoots, vulnerableFiles, FIXED, VULNERABLE } from './swiper-targets.mjs';

// Taro 3.6 的 H5 Swiper 固定依赖 Swiper 6 API，直接强升 Swiper 12 会让构建和运行时同时断裂。
// 官方 12.1.2 对 GHSA-hmx5-qpq5-p643 的修复是不再用可被污染的 Array#indexOf
// 判断 __proto__/constructor/prototype。这里在 Taro 实际解析到的那份 Swiper 6 上回移同一修复。
//
// 路径不再写死：见 swiper-targets.mjs 的说明 —— 写死嵌套路径的版本在 npm 提升后
// 一个文件都没打到，而失败方式是「找不到 → 静默跳过」，护栏没了也看不出来。
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const roots = swiperRoots(APP_ROOT);
if (!roots.length) throw new Error('未找到 Taro 依赖的 Swiper，请重新评估安全补丁');

let patched = 0;
for (const root of roots) {
  for (const file of vulnerableFiles(root)) {
    const source = readFileSync(file, 'utf8');
    const next = source
      .split("  var noExtend = ['__proto__', 'constructor', 'prototype'];\n").join('')
      .split(VULNERABLE).join(`return ${FIXED};`);
    if (!next.includes(FIXED)) throw new Error(`Swiper 原型污染修复未命中：${file}`);
    writeFileSync(file, next);
    patched += 1;
  }
}
console.log(`[swiper-security] ${roots.length} 份 Swiper，回移修复 ${patched} 个文件`);
