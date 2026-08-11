import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const catalog = require('../weapp-native/packages/video/catalog.js');
const model = require('../weapp-native/packages/video/model.js');
const mock = require('../weapp-native/packages/video/mock.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const videoRoot = path.resolve(here, '../weapp-native/packages/video');

test('快出片内置三套可独立制作的模板', () => {
  const templates = catalog.listBuiltInTemplates();
  assert.equal(templates.length, 3);
  assert.deepEqual(templates.map((item) => item.id), ['ct_shiti', 'ct_kaimen', 'ct_shouyi']);

  const scripts = templates.map((template) => {
    const seed = catalog.getBuiltInProjectSeed(template.id);
    assert.ok(seed);
    assert.equal(seed.segments.length, template.segmentCount);
    assert.deepEqual(seed.segments.map((item) => item.no), Array.from({ length: template.segmentCount }, (_, index) => index + 1));
    assert.ok(seed.segments.some((item) => item.role === model.ROLE.AVATAR));
    assert.ok(seed.segments.some((item) => item.role === model.ROLE.BROLL));
    assert.equal(seed.segments.at(-1).role, model.ROLE.TAIL);
    assert.equal(seed.segments.at(-1).durationSec, template.tailDurationSec);
    return seed.segments.map((item) => item.text).join('|');
  });
  assert.equal(new Set(scripts).size, templates.length);
});

test('快出片模板目录返回防御性副本', () => {
  const first = catalog.getBuiltInProjectSeed('ct_kaimen');
  first.segments[0].text = '被调用方修改';
  first.variables.shopName = '被调用方修改';
  const second = catalog.getBuiltInProjectSeed('ct_kaimen');
  assert.notEqual(second.segments[0].text, first.segments[0].text);
  assert.notEqual(second.variables.shopName, first.variables.shopName);
});

test('快出片纯 mock 会话自带可跑完整出片链路的演示额度', () => {
  assert.equal(mock.creditBalance(), 200);
  const mostExpensive = Math.max(...catalog.listBuiltInTemplates().map((item) => item.creditHint));
  assert.ok(mock.creditBalance() > mostExpensive);
});

test('快出片所有页面只占一层原生导航高度', () => {
  const pages = fs.readdirSync(videoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(videoRoot, entry.name, 'index.wxml')))
    .map((entry) => path.join(videoRoot, entry.name, 'index.wxml'));
  assert.equal(pages.length, 11);
  pages.forEach((file) => {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /--native-nav-inset:\{\{navInset\}\}px/);
    assert.match(source, /--native-nav-top:\{\{navTop\}\}px/);
    assert.match(source, /--native-nav-row-height:\{\{navRowHeight\}\}px/);
    assert.match(source, /--native-nav-right:\{\{navRightInset\}\}px/);
    assert.doesNotMatch(source, /class="vd-safe" style="height:/);
  });

  const tokens = fs.readFileSync(path.join(videoRoot, 'styles/tokens.scss'), 'utf8');
  assert.match(tokens, /\.vd-headrow\s*\{[\s\S]*position: absolute;/);
  assert.match(tokens, /top: var\(--native-nav-top/);
  assert.match(tokens, /height: var\(--native-nav-row-height/);
  assert.match(tokens, /\.vd-footer\s*\{[\s\S]*width: 100%;[\s\S]*box-sizing: border-box;[\s\S]*padding: 12px 20px;/);
  assert.doesNotMatch(tokens, /padding:[^;]*constant\(safe-area-inset-bottom\)/);
});
