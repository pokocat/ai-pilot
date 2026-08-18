import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// 全站分享 mixin 覆盖度守卫。参见 services/share.js 头部注释：改动前 54 个页面里
// 只有 4 个实现了 onShareAppMessage，其余转发按钮全是置灰的——问题是**静默失效**，
// 代码 review 看不出来，只有真机点开 ··· 菜单才发现。这份测试把"54 个页面全部挂了
// withShare"钉成硬断言，往后新增页面忘了挂，这里就会红。

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(appRoot, 'weapp-native');
const cjsRequire = createRequire(import.meta.url);
const shareSourcePath = path.join(sourceRoot, 'services/share.js');
const read = (...segments) => fs.readFileSync(path.join(sourceRoot, ...segments), 'utf8');

// 权威清单只认 app.json（pages + subPackages），不遍历文件系统——文件系统里还有
// packages/main/vendor/towxml/** 9 个第三方模块与 1 个自定义组件
// packages/video/components/voice-preview/index.js，它们不是 Page，混进来就会把
// towxml 改坏。这条注释同时说明了为什么下面用 app.json 而不是 walk(sourceRoot)。
function allRoutes() {
  const app = JSON.parse(read('app.json'));
  const routes = [...(app.pages || [])];
  for (const pkg of app.subPackages || []) {
    for (const page of pkg.pages || []) routes.push(`${pkg.root}/${page}`);
  }
  return routes;
}

// 朋友圈落地页被微信固定为当前页，只有对陌生游客打开仍有意义的公开内容页才适合开。
const TIMELINE_ROUTES = new Set([
  'pages/sessions/index',
  'packages/work/quickscan/index',
  'packages/work/mingpan/index',
  'packages/work/calendar/index',
  'packages/video/work/index',
  'packages/work/gallery/index',
  'packages/work/market/index',
  'packages/work/knowledge/index',
  'packages/work/knowledge/detail/index',
]);

// 这 4 个页面分享的是「我的命盘 / 我的天时日历 / 我的速诊结果 / 我的成片」，比通用海报
// 有效得多，保留自己的 onShareAppMessage；withShare 的合并语义保证页面同名方法优先。
const CUSTOM_SHARE_ROUTES = new Set([
  'packages/work/calendar/index',
  'packages/work/mingpan/index',
  'packages/work/quickscan/index',
  'packages/video/work/index',
]);

const routes = allRoutes();

test('原生小程序 app.json 声明的路由数量未变（54 个）——分享覆盖清单据此派生', () => {
  assert.equal(routes.length, 54, '路由数量变化时，本文件的分享覆盖清单也要跟着复核');
});

test('零漏挂：app.json 里的全部页面都必须挂上 withShare', () => {
  const missing = [];
  for (const route of routes) {
    const source = read(`${route}.js`);
    if (!/\bwithShare\(/.test(source)) missing.push(route);
  }
  assert.deepEqual(missing, [], `以下页面缺少 withShare 分享 mixin：\n${missing.join('\n')}`);
});

test('require 深度正确：每个页面对 services/share 的相对引用都必须真实解析到同一个文件', () => {
  const wrong = [];
  for (const route of routes) {
    const file = path.join(sourceRoot, `${route}.js`);
    const source = fs.readFileSync(file, 'utf8');
    const match = source.match(/require\((['"])((?:\.\.\/)+services\/share)\1\)/);
    if (!match) { wrong.push(`${route}：未找到 require(.../services/share) 语句`); continue; }
    const resolved = path.resolve(path.dirname(file), `${match[2]}.js`);
    if (resolved !== shareSourcePath) {
      wrong.push(`${route}：require('${match[2]}') 解析到 ${resolved}，不是 ${shareSourcePath}`);
    }
  }
  assert.deepEqual(wrong, [], `以下页面的 require 深度算错了：\n${wrong.join('\n')}`);
});

test('每个页面只 require 一次 services/share，且真的引入了 withShare', () => {
  for (const route of routes) {
    const source = read(`${route}.js`);
    const occurrences = source.match(/require\((['"])(?:\.\.\/)+services\/share\1\)/g) || [];
    assert.equal(occurrences.length, 1, `${route}：services/share 应当只被 require 一次`);
    assert.match(source, /const\s*\{[^}]*\bwithShare\b[^}]*\}\s*=\s*require\((['"])(?:\.\.\/)+services\/share\1\)/, `${route}：必须用解构拿到 withShare`);
  }
});

test('timeline 白名单精确：只有 9 个公开内容页挂朋友圈，其余 45 个只挂转发', () => {
  assert.equal(TIMELINE_ROUTES.size, 9);
  const wrongOn = [];
  const wrongOff = [];
  for (const route of routes) {
    const source = read(`${route}.js`);
    const hasTimelineOpt = /withShare\([\s\S]*\{\s*timeline:\s*true\s*\}\s*\)\s*\)/.test(source);
    if (TIMELINE_ROUTES.has(route) && !hasTimelineOpt) wrongOn.push(route);
    if (!TIMELINE_ROUTES.has(route) && hasTimelineOpt) wrongOff.push(route);
  }
  assert.deepEqual(wrongOn, [], `以下页面本应开启朋友圈但没有 { timeline: true }：\n${wrongOn.join('\n')}`);
  assert.deepEqual(wrongOff, [], `以下页面不在朋友圈白名单里却开了 { timeline: true }：\n${wrongOff.join('\n')}`);
});

test('4 个成果型分享页保留自己的 onShareAppMessage，且落地路径已补上邀请码', () => {
  assert.equal(CUSTOM_SHARE_ROUTES.size, 4);
  for (const route of CUSTOM_SHARE_ROUTES) {
    const file = path.join(sourceRoot, `${route}.js`);
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /onShareAppMessage\s*\(/, `${route}：必须保留自己的 onShareAppMessage，不能被通用海报顶替`);
    assert.match(source, /const\s*\{[^}]*\bpathWithCode\b[^}]*\}\s*=\s*require\((['"])(?:\.\.\/)+services\/share\1\)/, `${route}：必须从 services/share 引入 pathWithCode`);
    assert.match(source, /pathWithCode\(/, `${route}：落地页 path 必须经过 pathWithCode`);
    // 不得再留裸的 path: '/pages/...' 或 path: '/packages/...' 字面量——那样归因码就丢了。
    assert.doesNotMatch(source, /path:\s*['"]\/(?:pages|packages)\//, `${route}：不得残留未经 pathWithCode 包裹的裸路径`);
  }
});

test('非成果型页面不得反向新增 onShareAppMessage（分享内容应统一交给内置海报）', () => {
  const unexpected = [];
  for (const route of routes) {
    if (CUSTOM_SHARE_ROUTES.has(route)) continue;
    const source = read(`${route}.js`);
    if (/onShareAppMessage\s*\(/.test(source)) unexpected.push(route);
  }
  assert.deepEqual(unexpected, [], `以下页面不在成果型白名单，却自定义了 onShareAppMessage：\n${unexpected.join('\n')}`);
});

test('Page 定义整体被 withShare 包裹（不是仅在注释或死代码里出现字符串）', () => {
  for (const route of routes) {
    const source = read(`${route}.js`);
    assert.match(source, /\bPage\(withShare\(\{/, `${route}：Page({...}) 必须整体改写成 Page(withShare({...}))`);
    // 结尾必须是 withShare 调用的闭合，而不是裸的 Page({...});
    assert.match(source.trimEnd(), /\}(?:,\s*\{\s*timeline:\s*true\s*\})?\)\);?$/, `${route}：文件结尾未见 withShare(...) 的正确闭合`);
  }
});

test('vendor 未被污染：packages/main/vendor/towxml/** 第三方模块不得出现 withShare', () => {
  const vendorRoot = path.join(sourceRoot, 'packages/main/vendor/towxml');
  const walk = (root) => fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  const files = walk(vendorRoot);
  assert.ok(files.length > 0, 'towxml vendor 目录不应为空，测试本身失去意义');
  const polluted = files.filter((file) => /withShare/.test(fs.readFileSync(file, 'utf8')));
  assert.deepEqual(polluted, [], `以下 vendor 文件不应包含 withShare：\n${polluted.join('\n')}`);
});

test('自定义组件 voice-preview 不是 Page，不应被误挂 withShare', () => {
  const file = path.join(sourceRoot, 'packages/video/components/voice-preview/index.js');
  assert.ok(fs.existsSync(file), '该自定义组件应仍然存在（若已删除，需重新核对文件系统里的 63 个 index.js 清单）');
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /withShare/, 'voice-preview 是 Component，不是 Page，不应引入分享 mixin');
});

test('services/share 模块本身导出 withShare 与 pathWithCode（防止上游签名漂移）', () => {
  delete cjsRequire.cache[cjsRequire.resolve(shareSourcePath)];
  const shareModule = cjsRequire(shareSourcePath);
  assert.equal(typeof shareModule.withShare, 'function');
  assert.equal(typeof shareModule.pathWithCode, 'function');
});
