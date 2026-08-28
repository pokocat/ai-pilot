// Taro 内嵌 Swiper 的**实际**位置解析。
//
// 为什么要单独一层：补丁脚本与安全测试原来各自写死两条嵌套路径
//   node_modules/@tarojs/components{,-react}/node_modules/swiper/esm/utils/utils.js
// npm 把 swiper 提升到顶层后这两条路径就不存在了，于是
//   · 补丁脚本一个文件都没改（它只在「一条都没找到」时才抛，而这正是它被跳过的方式）；
//   · 安全测试红成 ENOENT，看起来像陈旧路径，不像「护栏没了」。
// 2026-08-27 实况：顶层 swiper@6.8.0 里带修复模式的文件数为 0，而 Taro 解析到的就是它。
//
// 所以改成按 Taro 自己的解析规则去找，提升与否都不影响。
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** 官方 12.1.2 对 GHSA-hmx5-qpq5-p643 的修复形态。 */
export const FIXED = "key !== '__proto__' && key !== 'constructor' && key !== 'prototype'";
/** 可被 Array.prototype.indexOf 污染绕过的旧写法。 */
export const VULNERABLE = 'return noExtend.indexOf(key) < 0;';

const CONSUMERS = ['@tarojs/components', '@tarojs/components-react'];

/** Taro 各包各自解析到的 swiper 根目录（去重）。 */
export function swiperRoots(appRoot) {
  const require = createRequire(path.join(appRoot, 'package.json'));
  const roots = new Set();
  for (const consumer of CONSUMERS) {
    let base;
    try { base = require.resolve(`${consumer}/package.json`); } catch (_) { continue; }
    const from = createRequire(base);
    try { roots.add(path.dirname(from.resolve('swiper/package.json'))); } catch (_) { /* 该包不依赖 swiper */ }
  }
  return [...roots];
}

/** 根目录下所有仍带脆弱写法的真实源码（跳过 .map 与压缩产物）。 */
export function vulnerableFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!full.endsWith('.js') || full.endsWith('.min.js')) continue;
      if (readFileSync(full, 'utf8').includes(VULNERABLE)) out.push(full);
    }
  };
  walk(root);
  return out;
}
