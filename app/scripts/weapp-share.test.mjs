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

test('原生小程序 app.json 声明的路由数量未变（55 个）——分享覆盖清单据此派生', () => {
  assert.equal(routes.length, 55, '路由数量变化时，本文件的分享覆盖清单也要跟着复核');
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

/**
 * 桩掉 `./api`，收集 `api.track` 的调用。
 *
 * 与 `loadShare` 不同，这个 patch 必须在**调用期间**保持生效：share.js 与 invite.js 都是在
 * 回调/函数体里**懒 require('./api')**（理由见两文件注释——api.js 顶层 `require('./invite')`，
 * 顶部引用会成环并拿到半初始化的 exports），load 完就还原的话根本拦不到。
 *
 * `mode` 四态，对应四种要守的现实：
 *   · 'ok'         正常上报，收集调用；
 *   · 'throw'      `api.track` 本身抛（比如 wx.request 在某基础库版本上抛）；
 *   · 'require'    连 `require('./api')` 都失败（模块加载链断了）；
 *   · 'throw-once' **只有第一跳抛**、之后恢复正常。这一态专门为「冷启动首条埋点没发出去」
 *     那个场景：全程都抛的桩里永远不可能有成功的上报，也就分不出「被抑制吞掉」和「本来就发不出去」
 *     ——必须让后一跳能成功，才能断言「总共要有一条落地」。
 * 中间两种都必须**完全不影响**分享回调与冷启动捕获。
 */
/**
 * 埋点桩。**桩的是 `api.track` 的真实契约，而不是「让它抛错」**（2026-08-18 第七轮复核）。
 *
 * 真实契约（见 services/api.js）：`api.track` 自己把 `wx.request` 的同步异常吞掉，
 * **永不抛**，只以返回值如实告知「有没有交给 wx」——true = 已投递，false = 压根没发出去。
 * 早先的桩让 `api.track` 直接 `throw`，与这个契约不符，于是「只有确实发出去才置抑制标记」
 * 那条修复看着通过、真机上完全没生效（真实的永不抛 → 外层永远拿到 true）。桩与契约不符时，绿灯是假的。
 *
 * 模式：
 *   · `ok`        —— 都投递成功（返回 true）；
 *   · `nosend`    —— 一律没发出去（返回 false，**不抛**）；
 *   · `nosend-once` —— 第一跳没发出去、之后正常，用来验「首跳没发出去不许抵消次跳」；
 *   · `require`   —— 连 `require('./api')` 都失败（模块级异常，这条仍然是真的抛）。
 */
function stubApiTrack(mode = 'ok') {
  const Module = cjsRequire('node:module');
  const original = Module.prototype.require;
  const calls = [];
  const captureCalls = [];
  let failedOnce = false;
  let captureFailedOnce = false;
  Module.prototype.require = function patched(id) {
    if (id === './api') {
      if (mode === 'require') throw new Error('桩：api 模块加载失败');
      return { api: { track: (name, props) => {
        if (mode === 'nosend') return false;              // 契约：不抛，只回 false
        if (mode === 'nosend-once' && !failedOnce) { failedOnce = true; return false; }
        calls.push({ name, props });
        return true;
      }, captureReferral: (code, source) => {
        captureCalls.push({ code, source });
        if (mode === 'capture-fail-once' && !captureFailedOnce) {
          captureFailedOnce = true;
          return Promise.reject(new Error('temporary network failure'));
        }
        return Promise.resolve({ token: `signed-${code}-${source}`, capturedAt: new Date().toISOString() });
      } } };
    }
    return original.apply(this, arguments);
  };
  return { calls, captureCalls, restore() { Module.prototype.require = original; } };
}

/** 桩一个最小 wx storage（invite.js 只用这三个同步接口）。 */
function stubStorage(store) {
  global.wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = v; },
    removeStorageSync: (k) => { delete store[k]; },
  };
  return store;
}

/** 加载 services/invite.js，桩一个最小 wx storage。 */
function loadInvite(store = {}) {
  const invitePath = path.join(sourceRoot, 'services/invite.js');
  stubStorage(store);
  delete cjsRequire.cache[cjsRequire.resolve(invitePath)];
  return { mod: cjsRequire(invitePath), store };
}

/**
 * 加载 **app.js 本体**并取回它注册给微信的生命周期对象，用来跑真实的 onLaunch / onShow 次序。
 *
 * 为什么必须这样测而不是手工重复调 captureInvite：冷启动的重复上报是**生命周期**造成的
 * （微信把同一份启动参数先给 onLaunch、再给紧随其后的首次 onShow），手工调两次
 * 既模拟不出「同一份 options 两次投递」，也验不到 app.js 到底给哪一路传了 `{ launch: true }`。
 *
 * 桩掉 ./services/store 与 ./services/font（它们会拉起 api / token / request / env 整条链，
 * 与本测试无关），**invite 走真实实现**；invite 的模块级去重状态每次加载都清干净（删 require 缓存）。
 */
function loadApp(store = {}) {
  const Module = cjsRequire('node:module');
  const original = Module.prototype.require;
  const appPath = path.join(sourceRoot, 'app.js');
  const invitePath = path.join(sourceRoot, 'services/invite.js');
  let registered = null;
  global.App = (options) => { registered = options; };
  stubStorage(store);
  Module.prototype.require = function patched(id) {
    if (id === './services/store') return { bootstrap() {} };
    if (id === './services/font') return { loadAppFont() {} };
    return original.apply(this, arguments);
  };
  try {
    delete cjsRequire.cache[cjsRequire.resolve(appPath)];
    delete cjsRequire.cache[cjsRequire.resolve(invitePath)];
    cjsRequire(appPath);
  } finally {
    Module.prototype.require = original;
  }
  assert.ok(registered && typeof registered.onLaunch === 'function' && typeof registered.onShow === 'function', 'app.js 应向 App() 注册 onLaunch 与 onShow');
  return { app: registered, store };
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
  // 图池里每套都必须两张齐全，且都真实存在（漏一张线上就是裂图）
  for (const art of share.BUILTIN_ART) {
    assert.ok(art.image && art.timelineImage, '底图池里有一套缺图');
    for (const url of [art.image, art.timelineImage]) {
      assert.ok(fs.existsSync(path.join(appRoot, 'src', url)), `图不存在：${url}`);
    }
  }
});

test('分享回调实际执行：有码带 ?ic=、无码退回无参、朋友圈只回 query 不回 path', () => {
  const withCode = loadShare({ inviteCode: 'JS2K7P' });
  assert.equal(withCode.friendMixin.onShareAppMessage().path, `${withCode.LANDING}?ic=JS2K7P&src=friend`);
  assert.equal(withCode.timelineMixin.onShareTimeline().query, 'ic=JS2K7P&src=timeline');
  assert.equal(withCode.timelineMixin.onShareTimeline().path, undefined, '朋友圈给 path 是无效的（微信固定回当前页）');

  const noCode = loadShare(null);
  assert.equal(noCode.friendMixin.onShareAppMessage().path, noCode.LANDING, '拿不到码要退回无参路径，不能把按钮变哑');
  assert.equal(noCode.timelineMixin.onShareTimeline().query, '');
});

test('素材随机：多次分享不会永远同一套，且每次都取自池内', () => {
  // 2026-08-19 改口径：原先按本地自然日轮动（同一天全站同一套，为了「用户说图不对」能复现），
  // 现在改成每次随机——同一个人一天分享几次，卡片一模一样会显得很假。
  // 可排查性没丢，改由埋点记下本次选中的序号（见下一条用例）。
  const share = loadShare(null);
  const titles = new Set();
  const images = new Set();
  const copyTitles = new Set(share.BUILTIN_COPY.map((c) => c.title));
  for (let i = 0; i < 80; i++) {
    const p = share.currentPoster();
    assert.ok(p.title, '每次都必须取到文案，不能是 undefined');
    assert.ok(copyTitles.has(p.title), `取到的文案必须来自池内：${p.title}`);
    assert.ok(p.image, '每次都必须取到底图');
    assert.equal(typeof p.copyIndex, 'number', '必须回传本次文案序号，埋点要用');
    assert.equal(typeof p.artIndex, 'number', '必须回传本次底图序号');
    titles.add(p.title);
    images.add(p.image);
  }
  // 12 条文案跑 80 次只出现 1 种，几乎不可能（除非退回了确定性选择）
  assert.ok(titles.size > 1, `文案必须是随机的，80 次只出现了 ${titles.size} 种`);
  assert.ok(titles.size >= 5, `随机应覆盖多条文案，实际只覆盖 ${titles.size} 种，疑似分布有问题`);
});

test('文案库本身的口径：条数、双语气、不出现盘面黑话与品牌红线', () => {
  const share = loadShare(null);
  assert.ok(share.BUILTIN_COPY.length >= 8, `文案库要够用才谈得上随机，当前只有 ${share.BUILTIN_COPY.length} 条`);
  for (const c of share.BUILTIN_COPY) {
    assert.ok(c.title && c.title.length <= 30, `title 过长会被微信截断：${c.title}`);
    assert.ok(c.timelineTitle, `每条都要有朋友圈语气版本（广而告之 vs 递给你看）：${c.title}`);
    const both = `${c.title}${c.timelineTitle}`;
    assert.doesNotMatch(both, /宜攻|宜守|攻守|运势|吉凶|流年/, `不许用盘面黑话：${c.title}`);
    assert.doesNotMatch(both, /米诺|Mino/i, `品牌红线：${c.title}`);
    // **每条都必须有行动召唤**（2026-08-20）：只说中痛点、不告诉人来干什么，
    // 分享卡的唯一文案位（图上刻意无字）就只用了一半——看的人「然后呢？」没了。
    // 认「军师」这个称谓：召唤必须落到产品上，不能只是泛泛的「值得想想」。
    assert.match(c.title, /军师/, `转发文案缺少行动召唤（要落到「军师」上）：${c.title}`);
    assert.match(c.timelineTitle, /军师/, `朋友圈文案缺少行动召唤：${c.timelineTitle}`);
  }
  // 底图池里每套都要两张（5:4 与 1:1 分开，共用会被朋友圈裁掉两侧）
  for (const a of share.BUILTIN_ART) {
    assert.ok(a.image && a.timelineImage, '每套底图都要有转发图与朋友圈图');
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

  // 没有签发成功前只带 raw code（服务端只留诊断、不建边），清掉后什么都不带。
  const params = mod.inviteParams();
  assert.equal(params.inviteCode, before);
  assert.equal(params.referralToken, undefined);
  mod.clearInvite();
  assert.deepEqual(mod.inviteParams(), {}, '清码后请求体不得出现 undefined 字段');
  assert.equal(Object.keys(store).length, 0, 'storage 应被清空');
});

test('捕获凭证使用服务端签名并保留来源：朋友圈/海报不再被硬记为好友分享', async () => {
  const stub = stubApiTrack();
  try {
    const { mod } = loadInvite();
    mod.captureInvite({ query: { ic: 'JS2K7P', src: 'timeline' } });
    await mod.inviteParamsReady();
    assert.deepEqual(stub.captureCalls[0], { code: 'JS2K7P', source: 'share_timeline' });
    assert.deepEqual(mod.inviteParams(), {
      inviteCode: 'JS2K7P', referralToken: 'signed-JS2K7P-share_timeline',
    });

    mod.captureInvite({ query: { scene: 'ic%3AJSWXYZ' } });
    await mod.inviteParamsReady();
    assert.deepEqual(stub.captureCalls[1], { code: 'JSWXYZ', source: 'poster_qr' });
  } finally { stub.restore(); }
});

test('首次捕获签名失败后，下一次登录会用保留的码主动重签，不会永远重复 no_timestamp', async () => {
  const stub = stubApiTrack('capture-fail-once');
  try {
    const { mod } = loadInvite();
    mod.captureInvite({ query: { ic: 'JS2K7P', src: 'timeline' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(mod.inviteParams(), { inviteCode: 'JS2K7P' }, '首次失败后保留 raw code');

    const params = await mod.inviteParamsReady();
    assert.deepEqual(stub.captureCalls, [
      { code: 'JS2K7P', source: 'share_timeline' },
      { code: 'JS2K7P', source: 'share_timeline' },
    ]);
    assert.deepEqual(params, {
      inviteCode: 'JS2K7P', referralToken: 'signed-JS2K7P-share_timeline',
    });
  } finally { stub.restore(); }
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
  // 注意：上面的 leaky 只覆盖了 onShareAppMessage，onShareTimeline 仍是 mixin 的实现
  // （自带随机图，走不到兜底）。要验朋友圈的兜底，得让页面把 onShareTimeline 也覆盖掉且漏图。
  const tlImgs = new Set(share.BUILTIN_ART.map((a) => a.timelineImage));
  assert.ok(tlImgs.has(leaky.onShareTimeline().imageUrl), 'mixin 的朋友圈图取自图池');

  const leakyTl = share.withShare({
    onShareTimeline() { return { title: '我的命盘报告', query: 'x=1' }; },
  }, { timeline: true });
  assert.equal(leakyTl.onShareTimeline().imageUrl, share.CARD_TIMELINE, '漏图的自定义朋友圈回调要补 1:1 那张');

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

// ── 邀请漏斗埋点（P2，2026-08-18）：分享曝光 share_expose + 落地打开 invite_landing。
// 这两条事件是漏斗前两段，注册段从 ReferralAttribution 算、首开通段从 ActivationEvent(source=invite) 算。
// 埋点是**背景动作**：分享与冷启动这两条主链路的正确性优先级远高于任何一条统计。

test('分享曝光埋点：两个通道各报一条 share_expose，且回调返回值一字不变', () => {
  const share = loadShare({ inviteCode: 'JS2K7P' });
  const stub = stubApiTrack();
  try {
    const page = share.withShare({}, { timeline: true });
    const friend = page.onShareAppMessage();
    const timeline = page.onShareTimeline();

    assert.deepEqual(stub.calls.map((c) => c.name), ['share_expose', 'share_expose'], '两个入口各一条');
    assert.equal(stub.calls[0].props.channel, 'friend');
    assert.equal(stub.calls[1].props.channel, 'timeline');
    // props 只许这三个键：带上页面路径/内容/邀请码等于把「谁在账本页点了转发」写进埋点库，
    // 与「分享内容与页面解耦」自相矛盾。
    for (const c of stub.calls) {
      assert.deepEqual(Object.keys(c.props).sort(), ['art', 'channel', 'copy'], 'props 不得夹带内容或个人数据');
      assert.equal(typeof c.props.copy, 'number');
      assert.equal(typeof c.props.art, 'number');
    }

    // **关键守卫**：上报的序号必须是这次真正用掉的那组。随机化之后，如果埋点在自己内部
    // 再算一次序号（旧写法就是），报上去的就不是用户看到的那张——埋点等于说谎，而且
    // 按日轮动时期这个 bug 是看不出来的（同一天恒等）。这里按序号回查文案，必须与返回值一致。
    const copies = share.BUILTIN_COPY;
    assert.equal(copies[stub.calls[0].props.copy].title, friend.title, 'friend 埋点序号必须对应本次实际用的文案');
    assert.equal(copies[stub.calls[1].props.copy].timelineTitle, timeline.title, 'timeline 埋点序号必须对应本次实际用的文案');

    // 返回值本身：路径与图不受随机影响，逐个钉死
    assert.equal(friend.path, `${share.LANDING}?ic=JS2K7P&src=friend`);
    // 图池有 3 套、随机取，所以只能验「取自池内」而不是等于某一张固定图
    const friendImgs = new Set(share.BUILTIN_ART.map((a) => a.image));
    const tlImgs = new Set(share.BUILTIN_ART.map((a) => a.timelineImage));
    assert.ok(friendImgs.has(friend.imageUrl), `转发封面必须来自图池：${friend.imageUrl}`);
    assert.equal(timeline.query, 'ic=JS2K7P&src=timeline');
    assert.ok(tlImgs.has(timeline.imageUrl), `朋友圈封面必须来自图池：${timeline.imageUrl}`);
    // 埋点的 art 序号也要对应本次真正用掉的那套
    assert.equal(share.BUILTIN_ART[stub.calls[0].props.art].image, friend.imageUrl, 'friend 的 art 序号必须对应实际用图');
    assert.equal(share.BUILTIN_ART[stub.calls[1].props.art].timelineImage, timeline.imageUrl, 'timeline 的 art 序号必须对应实际用图');
    // 内部字段绝不能漏给微信（分享回调返回值是有固定契约的）
    assert.equal(friend.__pick, undefined, '__pick 必须在返回微信前删掉');
    assert.equal(timeline.__pick, undefined, '__pick 必须在返回微信前删掉');
  } finally { stub.restore(); }
});

test('分享曝光埋点：页面自定义的分享回调同样上报，且恰好一条（不漏也不双报）', () => {
  // 埋点刻意兜在 withShare 的 wrapper 而不是 mixin 里：那 4 个成果型分享页**整体覆盖**了 mixin，
  // 埋在 mixin 里它们就一条都不上报，漏斗第一段会凭空少掉最活跃的几页。
  const share = loadShare({ inviteCode: 'JS2K7P' });
  const stub = stubApiTrack();
  try {
    const page = share.withShare({
      onShareAppMessage() { return { title: '我的命盘报告', path: '/packages/work/mingpan/index?ic=JS2K7P', imageUrl: '/assets/custom.png' }; },
    });
    const r = page.onShareAppMessage();
    assert.equal(stub.calls.length, 1, 'wrapper 只包最终生效的那个回调，不可能双报');
    assert.equal(stub.calls[0].name, 'share_expose');
    assert.equal(stub.calls[0].props.channel, 'friend');
    assert.deepEqual(r, { title: '我的命盘报告', path: '/packages/work/mingpan/index?ic=JS2K7P', imageUrl: '/assets/custom.png' }, '页面自己的返回值一字不改');
  } finally { stub.restore(); }
});

test('埋点炸了绝不能弄坏分享：track 抛 / require 抛，两个回调都不抛错且返回值仍然正确', () => {
  for (const mode of ['throw', 'require']) {
    const share = loadShare({ inviteCode: 'JS2K7P' });
    // 随机化之后不能再拿「预先调一次 currentPoster」当期望值——那次调用与回调里的那次
    // 本来就该不同。这条用例要证的是「埋点炸了分享照常」，与具体选中哪条文案无关，
    // 所以断言改成：文案必须来自池内且非空（不是等于某个特定值）。
    const titles = new Set(share.BUILTIN_COPY.map((c) => c.title));
    const expected = { path: `${share.LANDING}?ic=JS2K7P&src=friend` };
    const friendImgs = new Set(share.BUILTIN_ART.map((a) => a.image));
    const stub = stubApiTrack(mode);
    try {
      const page = share.withShare({}, { timeline: true });
      let friend;
      let timeline;
      assert.doesNotThrow(() => { friend = page.onShareAppMessage(); }, `mode=${mode}：转发回调不得抛错`);
      assert.doesNotThrow(() => { timeline = page.onShareTimeline(); }, `mode=${mode}：朋友圈回调不得抛错`);
      assert.ok(friend.title && titles.has(friend.title), `mode=${mode}：标题仍须是池内的真实文案，不能变空或变脏`);
      assert.equal(friend.path, expected.path, `mode=${mode}：归因路径不变`);
      assert.ok(friendImgs.has(friend.imageUrl), `mode=${mode}：封面图仍须取自图池（3 套随机，不能写死单张）`);
      assert.ok(timeline.imageUrl, `mode=${mode}：朋友圈封面仍在`);
    } finally { stub.restore(); }
  }
});

test('落地打开埋点：每次成功捕获都报一条 invite_landing（重复进入照报），通道分 query / scene', () => {
  const stub = stubApiTrack();
  try {
    const { mod } = loadInvite();
    mod.captureInvite({ query: { ic: 'JS2K7P' } });
    mod.captureInvite({ query: { scene: 'ic%3AJSWXYZ' } });
    // onShow 那次「小程序已在后台、又点了一张分享卡」：重复进入本身就是漏斗要看的数据，
    // 端上不偷偷合并，去重交给取数侧。（唯一的例外是冷启动那次回响——它由 onLaunch 传
    // `{ launch: true }` 标出来，见下一条「冷启动只算一次落地」。这里三次都没带那个标记，
    // 全都是货真价实的落地，必须三条。）
    mod.captureInvite({ query: { ic: 'JS2K7P' } });
    assert.deepEqual(stub.calls.map((c) => c.name), ['invite_landing', 'invite_landing', 'invite_landing']);
    assert.deepEqual(stub.calls.map((c) => c.props.channel), ['query', 'scene', 'query']);
    // 邀请码本身绝不进埋点库（它能反查到人，而服务端在绑定那一刻已完整留痕 attribution）
    for (const c of stub.calls) assert.deepEqual(Object.keys(c.props), ['channel']);

    const before = stub.calls.length;
    for (const bad of [{ query: { ic: 'not-a-code' } }, { query: { scene: 'S0123456789abcdef01234567' } }, {}]) {
      mod.captureInvite(bad);
    }
    assert.equal(stub.calls.length, before, '没捕获到码就不该有落地事件，否则漏斗分母被灌水');
  } finally { stub.restore(); }
});

test('冷启动只算一次落地：微信把同一份启动参数投给 onLaunch + 首次 onShow，埋点只许一条', () => {
  // 这是 codex 审出的阻断 1：小程序**已被销毁**时点分享卡，微信依次触发 onLaunch(options) 与
  // 紧随其后的首次 onShow(**同一份** options)，两处都上报就写两条 invite_landing；暖启动只走
  // onShow 一次、只写一条——漏斗分母于是按启动形态系统性失真。
  const stub = stubApiTrack();
  try {
    const { app, store } = loadApp();
    // 微信真实次序 + 真实形状：options 带 path / scene / query，两次是同一个对象内容。
    const launchOptions = { path: 'pages/sessions/index', scene: 1007, query: { ic: 'JS2K7P' } };
    app.onLaunch(launchOptions);
    app.onShow({ ...launchOptions });
    assert.deepEqual(stub.calls.map((c) => c.name), ['invite_landing'], '冷启动的两次投递只许上报一条');
    assert.equal(store['junshi.invite'], 'JS2K7P', '捕获仍然两处都做（游客可能从任一路径进来），只是不重复上报');

    // 运行期间用户又点了一张**别人的**卡：新的一次落地，照报。
    app.onShow({ query: { ic: 'JSWXYZ' } });
    // 同一张卡把人**再拉回来一次**：也是新的一次落地（这正是漏斗要看的「被同一张卡拉回几次」），
    // 所以去重绝不能做成「整个生命周期只报一次」或「同码只报一次」。
    app.onShow({ query: { ic: 'JSWXYZ' } });
    assert.deepEqual(
      stub.calls.map((c) => c.props.channel), ['query', 'query', 'query'],
      '冷启动 1 条 + 运行期两次真落地 2 条 = 3 条',
    );
    assert.equal(store['junshi.invite'], 'JSWXYZ', '末次触点覆盖口径不变');

    // 抑制额度只有一次性的一份：它已经被首次 onShow 消费掉，之后同码再进来照报（上面第 3 条即是）。
    const before = stub.calls.length;
    app.onShow({ ...launchOptions });
    assert.equal(stub.calls.length, before + 1, '回到最初那个码也是新落地，不得被残留的标记吞掉');
  } finally { stub.restore(); }
});

test('暖启动一条不少：没有 onLaunch 的纯 onShow 进入，每次都是一条落地', () => {
  // 去重的实现是「onLaunch 置一次性标记 → 紧邻的下一次调用消费」。这条守住反面：
  // 小程序还在后台、只走 onShow 的路径上没有任何标记被置上，两次进入必须两条。
  const stub = stubApiTrack();
  try {
    const { app } = loadApp();
    app.onShow({ query: { ic: 'JS2K7P' } });
    app.onShow({ query: { ic: 'JS2K7P' } });
    assert.equal(stub.calls.length, 2, '暖启动重复进入不许被合并（否则修阻断 1 反而少报）');
  } finally { stub.restore(); }
});

test('冷启动那次 onShow 没带码时，抑制标记也必须被消费掉（不许留到下一次真落地上）', () => {
  // 一次性标记若只在「同码」时才消费，onLaunch 捕到码而紧随的 onShow 参数为空（基础库差异）
  // 就会把标记留着，下一次真落地被白吞一条。这条把「无论捕不捕到码都消费」钉住。
  const stub = stubApiTrack();
  try {
    const { app } = loadApp();
    app.onLaunch({ query: { ic: 'JS2K7P' } });
    app.onShow({});                              // 没带码：不捕获、不上报，但把标记消费掉
    app.onShow({ query: { ic: 'JS2K7P' } });     // 真的又点了一次同一张卡：必须照报
    assert.equal(stub.calls.length, 2, '标记不得跨过一次空 onShow 继续抑制');
  } finally { stub.restore(); }
});

test('冷启动首条埋点没发出去时，抑制标记不许置上：onLaunch → onShow 总共必须有一条落地', () => {
  // codex 复审抓到的真 bug：旧实现在**确认埋点发出去之前**就把抑制标记置上，于是
  // `api.track` 抛错（或 require 抛）那一跳根本没发出去，紧随的首次 onShow 又被同码标记吞掉，
  // **净结果一条落地都没有**——少的不是一条重复，是一整次冷启动的漏斗分母，而且全程静默。
  // 旧的异常测试只验了「码还能存下」、没跑 onLaunch → onShow 的完整时序，所以是假绿。
  const stub = stubApiTrack('nosend-once');
  try {
    const { app, store } = loadApp();
    const launchOptions = { path: 'pages/sessions/index', scene: 1007, query: { ic: 'JS2K7P' } };
    app.onLaunch(launchOptions);
    assert.deepEqual(stub.calls, [], '本用例的前提：onLaunch 那一跳确实没发出去');
    app.onShow({ ...launchOptions });
    assert.deepEqual(
      stub.calls.map((c) => c.name), ['invite_landing'],
      '没发出去的一跳不得抵消掉紧随其后真发出去的这一跳（总数不能是 0）',
    );
    assert.equal(stub.calls[0].props.channel, 'query');
    assert.equal(store['junshi.invite'], 'JS2K7P', '捕获与埋点无关，码照常落 storage');
  } finally { stub.restore(); }
});

test('抑制标记的时效要校验下界：设备把时钟往回拨，陈旧标记也不许吞掉真落地', () => {
  // 只判上界（`<= 3000`）是不够的：设备校时可能把时钟往回调，
  // 那时 `Date.now() - echo.at` 是**负数**，照样满足「≤ 3000」——
  // 于是一个几小时前留下的陈旧标记会把这次真落地吞掉。所以判定必须是 `0 <= d <= 窗口`。
  const stub = stubApiTrack();
  const realNow = Date.now;
  try {
    let t = 1_760_000_000_000;
    Date.now = () => t;
    const { app } = loadApp();
    app.onLaunch({ query: { ic: 'JS2K7P' } });
    assert.equal(stub.calls.length, 1, '冷启动这一条照发');
    t -= 3_600_000;                               // 时钟被往回拨一小时（NTP 校时 / 用户手动改）
    app.onShow({ query: { ic: 'JS2K7P' } });      // 用户又从同一张卡进来 = 真实的第二次落地
    assert.equal(stub.calls.length, 2, '负时差不得命中抑制窗口（陈旧标记必须失效）');
  } finally { Date.now = realNow; stub.restore(); }
});

test('抑制标记有时效：onShow 压根没来时，标记不许留到未来某次真落地上把它吞掉', () => {
  // 正常路径上标记会被紧邻的下一次调用消费掉（上面两条已覆盖）。这条守的是长尾：
  // 万一某个基础库在 onLaunch 之后不发首次 onShow，标记就一直留着——下一次同码进来
  // （可能是几小时后用户又点了同一张卡）会被白吞一条。时效窗口专门封这个口。
  const stub = stubApiTrack();
  const realNow = Date.now;
  try {
    let t = 1_760_000_000_000;
    Date.now = () => t;
    const { app } = loadApp();
    app.onLaunch({ query: { ic: 'JS2K7P' } });
    assert.equal(stub.calls.length, 1, '冷启动这一条照发');
    t += 3_600_000;                               // 一小时后：那次 onShow 从未发生
    app.onShow({ query: { ic: 'JS2K7P' } });      // 用户又从同一张卡进来 = 货真价实的第二次落地
    assert.equal(stub.calls.length, 2, '过期的抑制标记不得再抑制任何落地');
  } finally { Date.now = realNow; stub.restore(); }
});

test('落地埋点炸了不得影响冷启动：track 抛 / require 抛，captureInvite 照常返回码并写 storage', () => {
  for (const mode of ['throw', 'require']) {
    const stub = stubApiTrack(mode);
    try {
      const { mod, store } = loadInvite();
      let code;
      assert.doesNotThrow(() => { code = mod.captureInvite({ query: { ic: 'JS2K7P' } }); }, `mode=${mode}：捕获不得抛错`);
      assert.equal(code, 'JS2K7P', `mode=${mode}：码照常返回`);
      assert.equal(store['junshi.invite'], 'JS2K7P', `mode=${mode}：码照常落 storage`);
    } finally { stub.restore(); }
  }
});

/**
 * 从 TS 源码里**解析出真实的事件名清单**（而不是全文正则匹配整个文件）。
 *
 * 上一版守卫是 `assert.match(wenceRoute, /'invite_landing'/)`：从 EVENT_NAMES 集合里删掉这一项、
 * 只要文件里还留着提到它的说明注释，测试照样全绿——而线上此刻已经在 400，端上 `api.track` 的
 * fail 是空实现，事件静默消失。所以这里先把**声明本身**截出来，再**剥掉注释**，只认引号里的名字。
 */
function parseDeclaredNames(source, label, declaration) {
  const block = source.match(declaration);
  assert.ok(block, `${label}：没解析到事件名声明（声明形状变了就来这里改，别把守卫退回全文匹配）`);
  const body = block[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const names = (body.match(/'[^']+'/g) || []).map((quoted) => quoted.slice(1, -1));
  assert.ok(names.length >= 10, `${label}：只解析出 ${names.length} 个名字，解析器多半失效了`);
  return names.sort();
}

test('事件名白名单必须真的一致：解析服务端集合与 SSOT 联合类型逐项比对（不是全文匹配）', () => {
  // 两处必须一起改：shared/contracts.d.ts 的 ClientEventName 与 server/src/routes/wence.ts 的
  // EVENT_NAMES（已导出，就是为了让这条守卫拿到真集合）。只改端上不改服务端，事件会被 400 掉
  // 且端上完全静默，症状是「代码明明埋了、库里查不到」——这条守卫就是为它。
  const repoRoot = path.resolve(appRoot, '..');
  const contracts = fs.readFileSync(path.join(repoRoot, 'shared/contracts.d.ts'), 'utf8');
  const wenceRoute = fs.readFileSync(path.join(repoRoot, 'server/src/routes/wence.ts'), 'utf8');

  const serverNames = parseDeclaredNames(wenceRoute, 'server/src/routes/wence.ts 的 EVENT_NAMES', /export const EVENT_NAMES = new Set\(\[([\s\S]*?)\]\)/);
  const contractNames = parseDeclaredNames(contracts, 'shared/contracts.d.ts 的 ClientEventName', /export type ClientEventName =([\s\S]*?);\n/);

  // 逐项相等：任何一侧多一个 / 少一个都红。多出来的那侧要么是 400（服务端缺），
  // 要么是「后端认了但端上类型不认」（SSOT 缺），两种都必须当场发现。
  assert.deepEqual(serverNames, contractNames, '服务端白名单与 SSOT 联合类型必须逐项一致');
  for (const name of ['share_expose', 'invite_landing']) {
    assert.ok(serverNames.includes(name), `server/src/routes/wence.ts 的 EVENT_NAMES 缺 ${name}`);
    assert.ok(contractNames.includes(name), `shared/contracts.d.ts 的 ClientEventName 缺 ${name}`);
  }
  // 端上真的用了这两个名字（防止改名后只剩白名单里的死取值）
  assert.match(read('services/share.js'), /track\('share_expose'/);
  assert.match(read('services/invite.js'), /track\('invite_landing'/);
});

/**
 * 加载**真实的邀请页**并取回它注册给微信的 Page 对象。
 *
 * 为什么必须这样测而不是源码文本匹配（codex 2026-08-20 的批评，成立）：
 * 上一版三条测试全是 `assert.match(src, ...)`，它们只能证明「某段文字存在」，
 * 正好漏掉了本次两个真实事故——切位乱序串码、以及无码/取消保存时的误报。
 * 文本匹配还会在重构后变脆或恒真。这里注入可控的 api/canvas/wx，跑真回调。
 */
function loadInvitePage(opts = {}) {
  const Module = cjsRequire('node:module');
  const original = Module.prototype.require;
  const pagePath = path.join(sourceRoot, 'packages/work/invite/index.js');
  const tracks = [];
  const saves = [];
  let registered = null;
  global.Page = (o) => { registered = o; };
  stubStorage({});
  global.wx = Object.assign({}, global.wx, {
    showToast() {},
    setClipboardData() {},
    navigateBack() {},
    saveImageToPhotosAlbum(o) {
      saves.push(o);
      // 由用例决定相册回调走 success 还是 fail
      if (opts.albumFail) { if (o.fail) o.fail({ errMsg: opts.albumFail }); }
      else if (o.success) o.success();
    },
  });
  Module.prototype.require = function patched(id) {
    if (id.endsWith('services/api')) {
      return { api: {
        inviteQrcode: (slot) => opts.qr(slot),
        me: () => Promise.resolve(opts.me || { inviteCode: 'JS2K7P', referral: null }),
        track: (name, props) => { tracks.push({ name, props }); return true; },
      } };
    }
    if (id.endsWith('services/store')) return { isAuthed: () => true, snapshot: () => ({}), handleApiError: () => '' };
    if (id.endsWith('services/page')) return { baseData: (x) => Object.assign({}, x) };
    if (id.endsWith('services/share')) return { withShare: (page) => page };
    if (id.endsWith('gift/canvas')) return { render: () => Promise.resolve('/tmp/card.png'), save() {}, share() {} };
    return original.apply(this, arguments);
  };
  try {
    delete cjsRequire.cache[cjsRequire.resolve(pagePath)];
    cjsRequire(pagePath);
  } finally { Module.prototype.require = original; }
  assert.ok(registered && typeof registered.load === 'function', '邀请页应向 Page() 注册 load');
  // 给 Page 对象补上 setData 与 data，模拟微信运行时
  registered.data = Object.assign({}, registered.data);
  registered.setData = function setData(patch) { Object.assign(this.data, patch); };
  // 必须跑一次 onLoad：请求代次 `_gen` 在那里初始化，跳过它 load() 里的 ++this._gen
  // 会从 NaN 起算，代次比较恒为 false —— 那样测的就不是真实运行时序了。
  if (typeof registered.onLoad === 'function') registered.onLoad();
  return { page: registered, tracks, saves };
}

test('切物料位不许串码：旧请求晚到必须整份丢弃，不落地也不上报', async () => {
  // 真实事故（codex 审出的阻断）：default 请求还在飞时点「名片」，
  // 旧响应晚到会把 default 的二维码写进已显示「名片」的状态——用户出的图是
  // 「名片」文案配通用码，印出去归因就错了；还会按当前 slot 误报一次 view。
  let releaseDefault;
  const pending = new Promise((r) => { releaseDefault = r; });
  const { page, tracks } = loadInvitePage({
    qr: (slot) => (slot === 'default'
      ? pending.then(() => ({ inviteCode: 'JS2K7P', slot: 'default', dataUri: 'data:image/png;base64,AAA' }))
      : Promise.resolve({ inviteCode: 'JS2K7P', slot, dataUri: `data:image/png;base64,${slot}` })),
  });

  const first = page.load();                       // default，卡住不返回
  await page.pickSlot({ currentTarget: { dataset: { slot: 'card' } } });  // 切到名片并完成
  assert.equal(page.data.slot, 'card');
  assert.equal(page.data.qr, 'data:image/png;base64,card', '当前显示的必须是名片的码');

  releaseDefault();                                 // 旧请求现在才回来
  await first;
  assert.equal(page.data.slot, 'card', '旧请求不得改回 slot');
  assert.equal(page.data.qr, 'data:image/png;base64,card', '旧请求的码绝不能盖住当前码');
  const views = tracks.filter((t) => t.props.act === 'view');
  assert.deepEqual(views.map((v) => v.props.slot), ['card'], '只该有名片这一条 view，旧请求不得上报');
});

test('无码时不报投放：降级卡能出图，但它不是可扫的物料', async () => {
  const { page, tracks } = loadInvitePage({
    qr: () => Promise.resolve({ inviteCode: 'JS2K7P', slot: 'default', dataUri: null }),
  });
  await page.load();
  assert.equal(page.data.qrFailed, true, '要显式进失败态，不能一直转圈');
  await page.makeImage();
  assert.ok(page.data.imgPath, '降级卡照样要能出图（大字邀请码可手输）');
  page.saveImage();
  assert.deepEqual(tracks.filter((t) => t.name === 'qr_provision'), [],
    '无码时 view/image/save 一条都不许报——否则漏斗混进贴不出去的物料');
});

test('save 必须等相册成功回调：用户取消或拒权限不算「已存相册」', async () => {
  const good = { qr: () => Promise.resolve({ inviteCode: 'JS2K7P', slot: 'default', dataUri: 'data:image/png;base64,AAA' }) };

  const ok = loadInvitePage(good);
  await ok.page.load();
  await ok.page.makeImage();
  ok.page.saveImage();
  assert.equal(ok.tracks.filter((t) => t.props.act === 'save').length, 1, '成功保存要报一条');

  const cancelled = loadInvitePage(Object.assign({ albumFail: 'saveImageToPhotosAlbum:fail cancel' }, good));
  await cancelled.page.load();
  await cancelled.page.makeImage();
  cancelled.page.saveImage();
  assert.deepEqual(cancelled.tracks.filter((t) => t.props.act === 'save'), [],
    '用户取消不算存了相册——契约里 save 的定义是「存了相册」，报上去就是造假');
});

test('跨端 scene 形状对齐：服务端生成的每一种码，端上都必须解析得出邀请码', () => {
  // **这条是补上一个真实事故的守卫**（2026-08-20）：服务端 sceneFor 对 default 之外的物料位
  // 会拼成 `ic:JS2K7P:card`，而端上早先只 slice(3) 不切物料位，于是 `JS2K7P:card`
  // 过不了 isInviteCode——**名片/门店/提案/活动四个位印出去的码全部归因不了**。
  // default 位是好的，所以自测扫一张通用码完全看不出问题，码印出去才会发现。
  //
  // 根因是端上解析与服务端生成**两处独立实现**，此前从未被放在一起测过。
  // 这里用服务端的枚举与拼法逐个产出 scene，喂给端上的真实解析逻辑。
  const serverSrc = fs.readFileSync(
    path.join(appRoot, '..', 'server/src/services/inviteQrcode.ts'), 'utf8',
  );
  // 从服务端源码里取权威的物料位列表，而不是在测试里再抄一份（抄一份就会各自漂移）
  const slots = [...serverSrc.matchAll(/'(default|card|store|deck|event)'/g)].map((m) => m[1]);
  const uniqueSlots = [...new Set(slots)];
  assert.ok(uniqueSlots.length >= 5, `未从服务端解析出物料位列表，实际 ${JSON.stringify(uniqueSlots)}`);

  const { mod: invite } = loadInvite();
  const CODE = 'JS2K7P';
  for (const slot of uniqueSlots) {
    // 与服务端 sceneFor 同一拼法
    const scene = slot === 'default' ? `ic:${CODE}` : `ic:${CODE}:${slot}`;
    assert.ok(scene.length <= 32, `${slot}: scene 超微信 32 字符上限（${scene.length}）`);
    const got = invite.captureInvite({ query: { scene } });
    assert.equal(got, CODE, `物料位 ${slot} 的 scene（${scene}）端上解析不出邀请码——这张码印出去就归因不了`);
    invite.clearInvite();
  }
  // 裸码（历史形态）也要继续认
  assert.equal(invite.captureInvite({ query: { scene: CODE } }), CODE, '裸邀请码形态不能回归');
  invite.clearInvite();
  // 脏物料位不该让整张码失效——位标识只是埋点维度
  assert.equal(invite.captureInvite({ query: { scene: `ic:${CODE}:BAD!` } }), CODE, '脏物料位不该让码失效');
});

test('出图必须把 data URI 落成本地文件：drawImage 不认 base64，真机会导出空白码', () => {
  // codex 2026-08-20 审出：页面 <image> 认 data URI（所以屏上看得见码），
  // 但旧版 CanvasContext.drawImage 只认本地路径——直接喂 base64 会导出**空白码**，
  // 而空白码印到名片上就是一批废物料，且屏上完全看不出问题。
  const src = read('packages/work/invite/index.js');
  assert.match(src, /USER_DATA_PATH/, '必须落盘成本地文件再交给 canvas');
  assert.match(src, /writeFileSync/, '要用 getFileSystemManager().writeFileSync 写 base64');
  // 关键：交给 paint 的是落盘后的路径，不是原始 data URI
  assert.match(src, /qr: qrFile/, 'paint 收到的必须是本地文件路径');
  assert.doesNotMatch(src, /qr: this\.data\.qr,/, '不得再把 data URI 直接喂给 canvas');
  // image 埋点要按「图里真有码」判断，落盘失败时导出的是无码版
  assert.match(src, /if \(qrFile\) trackProvision/, 'image 埋点必须按落盘结果判断，不是按页面有没有码');
});

test('服务端失败必须留痕：限流/接口变更时不能只有用户看到降级', () => {
  // codex 审出：此前 token/HTTP/超时全被吞成 null，45009 限流时服务端一点痕迹都没有。
  const src = fs.readFileSync(
    path.join(appRoot, '..', 'server/src/services/inviteQrcode.ts'), 'utf8',
  );
  assert.match(src, /noteFailure/, '各失败分支都要记原因');
  for (const reason of ['access_token', 'empty_body', 'timeout', 'network']) {
    assert.ok(src.includes(reason), `缺少失败原因分类：${reason}`);
  }
  assert.match(src, /errcode/, '微信错误要把 errcode 读出来——这是区分限流与接口变更的唯一线索');
  assert.match(src, /REASON_LOG_TTL_MS|限频/, '必须限频：码页会被反复打开，真故障时每秒能刷几十条');
});

test('二维码卡的文案：固定不随机，但同样要有召唤（不能只罗列痛点）', () => {
  // 两个场景要求相反，所以这张卡刻意**不接** BUILTIN_COPY 也不随机：
  // 那 12 条是给微信聊天流的（一闪而过、每次不同才不显假）；
  // 这张是**印出去的静态物料**（名片/台卡/提案封底），同一批每张字不一样很怪，
  // 而且印错了召不回。但口径要一致：有钩子也要有召唤。
  const paint = read('packages/work/invite/paint.js');
  // 剥掉注释再查：文件头注释里正好解释了「为什么不接 BUILTIN_COPY」，
  // 直接全文匹配会把那段说明当成违规（第一次写这条断言就踩了这个）。
  const code = paint.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /BUILTIN_COPY|require\([^)]*services\/share/,
    '物料卡不该接分享文案库——印出去的东西不能每张不一样');
  assert.doesNotMatch(code, /Math\.random/, '物料卡的文案不许随机');
  // 必须落到产品上，不能只摆痛点
  assert.match(paint, /问问 AI 军师|找军师|问策/, '物料卡缺少行动召唤：只罗列痛点等于没说该干什么');
  // 痛点那行仍要在（它是钩子），但后面必须紧跟召唤
  assert.match(paint, /获客贵/, '痛点钩子应保留');
  assert.match(paint, /这些事，找军师陪你拆一遍/, '痛点罗列后必须紧跟一句召唤');
  // 老口径不得回归
  assert.doesNotMatch(paint, /值得有人陪你想一遍/, '旧文案没有召唤，不得回归');
});
