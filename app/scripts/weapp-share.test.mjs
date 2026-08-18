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

// 朋友圈落地页被微信**固定为当前页**（只能带 query，改不了 path），所以能开朋友圈的页面
// 必须自己就对陌生游客友好。
//
// 这个清单一开始拍了 9 个，自审时发现其中 5 个（速诊 / 作品廊 / 生态市场 / 图籍及详情）
// 的 onLoad 里就 `setData({ showLogin: true })`——陌生人从朋友圈点进来第一屏是登录弹层，
// 与「转发落地页刻意不用速诊页」的理由自相矛盾，也踩 2026-08-05 整改口径。故收缩到这 4 个。
// 下面「朋友圈白名单必须游客友好」那条测试会持续守住这件事。
// 成片页（packages/video/work）也被移出：它 onLoad 依赖 workId，而朋友圈只能带 query、
// 回不到带参数的页面，访客会落在「缺少作品参数」的失败态上；成片本身还是私有资产。
const TIMELINE_ROUTES = new Set([
  'pages/sessions/index',
  'packages/work/mingpan/index',
  'packages/work/calendar/index',
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

test('朋友圈白名单必须游客友好：onLoad 里不得对未登录用户直接弹登录弹层', () => {
  // 朋友圈的落地页是当前页、无法重定向到公开页，所以 onLoad 就 setData({ showLogin: true })
  // 的页面绝不能进白名单——陌生人点开朋友圈第一屏会是登录门。
  // 转发（onShareAppMessage）不受此限：它的落地页统一指向问策 tab，与当前页无关。
  // 查 onLoad 与 onShow 两个进页生命周期；页面没有某个钩子就跳过（命盘/天时只有 onShow）。
  // 动作触发或 401 里的 showLogin 不在此列——那是用户主动点了要登录的功能，合规且合理。
  let checked = 0;
  for (const route of TIMELINE_ROUTES) {
    const src = fs.readFileSync(path.join(sourceRoot, `${route}.js`), 'utf8');
    for (const hook of ['onLoad', 'onShow']) {
      const block = src.match(new RegExp(`${hook}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n  \\},`));
      if (!block) continue;
      checked += 1;
      assert.doesNotMatch(
        block[0],
        /showLogin:\s*true/,
        `${route} 的 ${hook} 会对游客弹登录，不能开朋友圈（转发不受影响，它的落地页是问策 tab）`,
      );
    }
  }
  assert.ok(checked >= TIMELINE_ROUTES.size, '每个白名单页至少要有一个进页生命周期被实际检查到');
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

test('timeline 白名单精确：只有 3 个游客友好且无必填参数的页挂朋友圈，其余 51 个只挂转发', () => {
  assert.equal(TIMELINE_ROUTES.size, 3);
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

// ── 以下是**行为级**断言：真正把模块 require 进来执行回调，而不是只匹配源码文本。
// 只做文本匹配的话，"imageUrl 留空导致微信截当前页"这类问题照样能全绿。

/** 加载 services/share.js，桩掉它唯一的本地依赖 ./store（避免拉起整条 api/token 链）。 */
function loadShare(me) {
  const Module = cjsRequire('node:module');
  const original = Module.prototype.require;
  Module.prototype.require = function patched(id) {
    if (id === './store') return { snapshot: () => ({ me }) };
    return original.apply(this, arguments);
  };
  try {
    delete cjsRequire.cache[cjsRequire.resolve(shareSourcePath)];
    return cjsRequire(shareSourcePath);
  } finally {
    Module.prototype.require = original;
  }
}

/** 加载 services/invite.js，桩一个最小 wx storage。 */
function loadInvite(store = {}) {
  const invitePath = path.join(sourceRoot, 'services/invite.js');
  global.wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v; },
    removeStorageSync: (k) => { delete store[k]; },
  };
  delete cjsRequire.cache[cjsRequire.resolve(invitePath)];
  return { mod: cjsRequire(invitePath), store };
}

test('分享回调实际执行：必须带真图（留空会让微信截当前页，从账本页转发就泄露经营数据）', () => {
  const share = loadShare({ inviteCode: 'JS2K7P' });
  const friend = share.friendMixin.onShareAppMessage();
  const timeline = share.timelineMixin.onShareTimeline();

  assert.ok(friend.imageUrl, '转发必须给 imageUrl');
  assert.ok(timeline.imageUrl, '朋友圈必须给 imageUrl');
  assert.match(friend.imageUrl, /^\/assets\/share\//, '转发封面必须是内置品牌图');
  assert.match(timeline.imageUrl, /^\/assets\/share\//, '朋友圈封面必须是内置品牌图');
  assert.notEqual(friend.imageUrl, timeline.imageUrl, '两个入口裁切规则不同，不能共用一张');
  // 图必须真实存在于会被构建拷贝的目录里，否则线上是一张裂图
  for (const url of [friend.imageUrl, timeline.imageUrl]) {
    assert.ok(fs.existsSync(path.join(appRoot, 'src', url)), `图不存在：${url}`);
  }
  // 每套素材都必须自带图，不能有一套漏配
  for (const poster of share.BUILTIN_POSTERS) {
    assert.ok(poster.image && poster.timelineImage, `素材「${poster.title}」缺图`);
  }
});

test('分享回调实际执行：有码带 ?ic=、无码退回无参、朋友圈只回 query 不回 path', () => {
  const withCode = loadShare({ inviteCode: 'JS2K7P' });
  assert.equal(withCode.friendMixin.onShareAppMessage().path, `${withCode.LANDING}?ic=JS2K7P`);
  assert.equal(withCode.timelineMixin.onShareTimeline().query, 'ic=JS2K7P');
  assert.equal(withCode.timelineMixin.onShareTimeline().path, undefined, '朋友圈给 path 是无效的（微信固定回当前页）');

  const noCode = loadShare(null);
  assert.equal(noCode.friendMixin.onShareAppMessage().path, noCode.LANDING, '拿不到码要退回无参路径，不能把按钮变哑');
  assert.equal(noCode.timelineMixin.onShareTimeline().query, '');
});

test('素材轮动：同一自然日幂等，且严格逐日递进（含 2/29 → 3/1 边界）', () => {
  const share = loadShare(null);
  const at = (y, m, d, h = 0) => new Date(y, m - 1, d, h);
  // 同日不同时刻 → 同一套
  assert.equal(share.currentPoster(at(2026, 8, 18, 0)).title, share.currentPoster(at(2026, 8, 18, 23)).title);
  // 逐日严格 +1（这条能挡住「年*372+月*31+日」那种在月末月初不连续的手算式）
  for (const [a, b] of [[at(2026, 8, 18), at(2026, 8, 19)], [at(2026, 8, 31), at(2026, 9, 1)], [at(2028, 2, 29), at(2028, 3, 1)]]) {
    assert.equal(share.dayIndex(b) - share.dayIndex(a), 1, `${a.toDateString()} → ${b.toDateString()} 不是相邻一天`);
    assert.notEqual(share.currentPoster(a).title, share.currentPoster(b).title, '相邻两天必须换素材');
  }
});

test('自定义分享页的落地页目标逐个钉死（速诊必须落到统一公开页）', () => {
  const share = loadShare(null);
  // 速诊 onLoad 就对游客弹登录，所以它的分享只能落到统一公开页
  assert.match(read('packages/work/quickscan/index.js'), /path: pathWithCode\(LANDING\)/, '速诊落地页必须是 LANDING');
  assert.doesNotMatch(read('packages/work/quickscan/index.js'), /pathWithCode\('\/packages\/work\/quickscan/, '速诊不得落回自己的页面');
  // 命盘 / 天时日历落自己的页（onShow 不弹登录，访客看到空态+引导）
  assert.match(read('packages/work/mingpan/index.js'), /pathWithCode\('\/packages\/work\/mingpan\/index'\)/);
  assert.match(read('packages/work/calendar/index.js'), /pathWithCode\('\/packages\/work\/calendar\/index'\)/);
  // 成片落快拍入口而不是 work 页（成片是私有资产，转出去对方拿不到）
  assert.match(read('packages/video/work/index.js'), /pathWithCode\('\/packages\/video\/home\/index'\)/);
  assert.ok(share.LANDING.startsWith('/pages/'), 'LANDING 应是主包 tab 页');
});

test('邀请码捕获实际执行：query 与 scene 两路都认，脏值不写入，解码异常不崩', () => {
  const { mod, store } = loadInvite();
  assert.equal(mod.captureInvite({ query: { ic: 'JS2K7P' } }), 'JS2K7P');
  assert.equal(mod.currentInviteCode(), 'JS2K7P');
  assert.ok(mod.capturedAt() > 0, '必须记下捕获时刻，服务端要用它判归因窗口');

  // scene 两种形态：裸码与带 ic: 前缀（海报小程序码用后者）
  assert.equal(mod.captureInvite({ query: { scene: 'JSABCD' } }), 'JSABCD');
  assert.equal(mod.captureInvite({ query: { scene: 'ic%3AJSWXYZ' } }), 'JSWXYZ');

  // 脏值一律不写入，且不覆盖已有的好码
  const before = mod.currentInviteCode();
  for (const bad of ['js2k7p', 'JS2K7I', 'JS2K7', 'JS2K7PP', 'not-a-code', 'S0123456789abcdef01234567', '']) {
    assert.equal(mod.captureInvite({ query: { ic: bad } }), '', `脏码 ${bad} 不应被接受`);
  }
  assert.equal(mod.currentInviteCode(), before, '脏码不得覆盖已捕获的有效码');

  // decodeURIComponent 会对孤立的 % 抛错——绝不能让启动流程崩掉
  assert.doesNotThrow(() => mod.captureInvite({ query: { scene: '%E0%A4%A' } }));

  // 登录参数：有码带两个字段，清掉后什么都不带
  const params = mod.inviteParams();
  assert.equal(params.inviteCode, before);
  assert.ok(typeof params.inviteCodeAt === 'number');
  mod.clearInvite();
  assert.deepEqual(mod.inviteParams(), {}, '清码后请求体不得出现 undefined 字段');
  assert.equal(Object.keys(store).length, 0, 'storage 应被清空');
});

test('页面自定义分享回调漏了 imageUrl 时，withShare 必须兜上默认图', () => {
  // 这是上一轮 codex 抓到的假闭环：mixin 自己返回了图，但那 4 个成果型分享页
  // **整体覆盖**了 mixin 的实现，只要它们漏写 imageUrl，微信就退回截当前页——
  // 从命盘 / 成片页转发等于把个人内容贴进聊天窗。逐页补容易再漏，所以兜在 withShare 里。
  //
  // 这条断言 + 上面「零漏挂：54 页全部经过 withShare」两条合起来，才等价于
  // 「任何页面的任何分享都一定带图」——单独任何一条都不够。
  const share = loadShare({ inviteCode: 'JS2K7P' });

  const leaky = share.withShare({
    onShareAppMessage() { return { title: '我的命盘报告', path: '/packages/work/mingpan/index' }; },
  }, { timeline: true });
  const friend = leaky.onShareAppMessage();
  assert.equal(friend.imageUrl, share.CARD_FRIEND, '漏图的自定义回调必须被补上品牌底图');
  assert.equal(friend.title, '我的命盘报告', '页面自己的标题不能被改掉');
  assert.equal(friend.path, '/packages/work/mingpan/index', '页面自己的落地页不能被改掉');
  const timeline = leaky.onShareTimeline();
  assert.equal(timeline.imageUrl, share.CARD_TIMELINE, '朋友圈要补 1:1 那张');

  // 页面自己给了图就不许被覆盖（将来运营给某页配专属图时不能被兜底顶掉）
  const own = share.withShare({
    onShareAppMessage() { return { title: 'x', path: '/y', imageUrl: '/assets/custom.png' }; },
  });
  assert.equal(own.onShareAppMessage().imageUrl, '/assets/custom.png');

  // 回调返回空 / 不返回对象时不得抛错（微信允许返回 undefined）
  const empty = share.withShare({ onShareAppMessage() { return undefined; } });
  assert.doesNotThrow(() => empty.onShareAppMessage());
});

test('四个成果型分享页确实走的是 withShare 包装（否则上一条兜底不生效）', () => {
  // 它们保留自己的 onShareAppMessage，但必须仍然经过 withShare —— 否则兜底那层不会挂上。
  for (const route of CUSTOM_SHARE_ROUTES) {
    const src = read(`${route}.js`);
    assert.match(src, /Page\(withShare\(/, `${route} 必须经 withShare 包装`);
    assert.match(src, /onShareAppMessage\(\)\s*\{/, `${route} 应保留自己的成果型分享`);
  }
});
