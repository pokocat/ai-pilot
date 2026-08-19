import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const file of [
  'node_modules/@tarojs/components/node_modules/swiper/esm/utils/utils.js',
  'node_modules/@tarojs/components-react/node_modules/swiper/esm/utils/utils.js',
]) {
  test(`Taro 内嵌 Swiper 已回移官方原型污染修复: ${file}`, () => {
    const source = readFileSync(file, 'utf8');
    assert.match(source, /key !== '__proto__' && key !== 'constructor' && key !== 'prototype'/);
    assert.doesNotMatch(source, /noExtend\.indexOf\(key\)/);
  });
}
