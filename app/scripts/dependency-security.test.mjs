import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { swiperRoots, vulnerableFiles, FIXED } from './swiper-targets.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 断言的是「Taro 实际会加载的那份 Swiper 已经打上修复」，不是某条写死的路径存在。
// 旧版按嵌套路径读文件，npm 提升后红成 ENOENT —— 看着像环境问题，
// 实际是护栏已经失效（2026-08-27：顶层 swiper@6.8.0 带修复模式的文件数为 0）。
test('Taro 解析到的 Swiper 确实存在', () => {
  assert.ok(swiperRoots(APP_ROOT).length > 0,
    'Taro 应当至少解析到一份 Swiper；解析不到就说明依赖结构变了，安全补丁要重新评估');
});

test('Taro 内嵌 Swiper 已回移官方原型污染修复（GHSA-hmx5-qpq5-p643）', () => {
  for (const root of swiperRoots(APP_ROOT)) {
    const left = vulnerableFiles(root);
    assert.deepEqual(left, [],
      `这些文件仍用可被 Array.prototype.indexOf 污染绕过的旧写法：\n${left.join('\n')}`);
    const entry = readFileSync(path.join(root, 'esm/utils/utils.js'), 'utf8');
    assert.ok(entry.includes(FIXED), `${root} 的 ESM 入口没有带上修复写法`);
  }
});
