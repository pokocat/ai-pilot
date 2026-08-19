import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Taro 3.6 的 H5 Swiper 固定依赖 Swiper 6 API，直接强升 Swiper 12 会让构建和运行时同时断裂。
// 官方 12.1.2 对 GHSA-hmx5-qpq5-p643 的修复是不再用可被污染的 Array#indexOf
// 判断 __proto__/constructor/prototype。在两份 Taro 内嵌 Swiper 6 ESM 入口上回移同一修复。
const roots = [
  'node_modules/@tarojs/components/node_modules/swiper/esm/utils/utils.js',
  'node_modules/@tarojs/components-react/node_modules/swiper/esm/utils/utils.js',
];

let found = 0;
for (const relative of roots) {
  const file = resolve(relative);
  if (!existsSync(file)) continue;
  found += 1;
  const source = readFileSync(file, 'utf8');
  const patched = source
    .replace("  var noExtend = ['__proto__', 'constructor', 'prototype'];\n", '')
    .replace('return noExtend.indexOf(key) < 0;', "return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';");
  if (!patched.includes("key !== '__proto__' && key !== 'constructor' && key !== 'prototype'")) {
    throw new Error(`Swiper 原型污染修复未命中：${relative}`);
  }
  if (patched !== source) writeFileSync(file, patched);
}
if (!found) throw new Error('未找到 Taro 内嵌 Swiper，请重新评估安全补丁');
