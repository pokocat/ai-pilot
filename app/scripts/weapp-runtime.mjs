// 最小微信小程序运行时 —— 让原生页面代码在 Node 里真实跑起来。
//
// 为什么要有这个：`video-e2e.mjs` 走的是开发者工具自动化端口，能验渲染与布局，
// 但它要求工具已登录、服务端口已开，换机后第一件事就是跑不起来；而且它只覆盖到
// 模板详情，真正的出片链路（改文案 → 配画面 → 确认 → 出片 → 作品）一步没走过。
//
// 这层不冒充渲染：**不做** WXML 编译、样式、布局测量——那些只有开发者工具/真机能验。
// 它跑的是页面 JS 的真实行为：onLoad 取数、setData 状态流转、按钮 handler、页面间跳转参数。
// 也就是「用户点了会发生什么」这一层，恰好是纯函数测试和布局 e2e 中间那段空白。
//
// 载入的是 `weapp-native/` **源码**，不是 dist-native：构建器对 JS 是逐字节搬运
// （只编译 SCSS、并用真实构建模式覆盖 config/env.js），所以跑源码等于跑产物，
// 而且改完源码立刻生效，不存在「拿旧产物测新代码」的假绿。
// 另外测试里不该去写共享的 dist-native —— `node --test scripts/*.test.mjs` 是并行的，
// 重建产物会和读产物的用例抢文件（实测把 native-weapp.test.mjs 打成 ENOENT app.wxss）。
import { createRequire } from 'node:module';
import path from 'node:path';

/** 微信 setData 的合并语义。视频分包只用到平铺键（唯一的 `[field]` 是计算属性名，不是深路径）。 */
function mergeData(target, patch) {
  for (const key of Object.keys(patch || {})) target[key] = patch[key];
}

/**
 * 造一个运行时。每个 chain 用一个，互不串状态。
 * @param {string} root 小程序源码根（app/weapp-native）
 * @param {object} [env] 覆盖 config/env 的字段，默认 mock 档
 */
export function createRuntime(root, env) {
  const require = createRequire(path.join(root, 'package.json'));

  /* 把 config/env 钉死成 mock 档。
     源码里本来就有 `config/env.js`（默认也是 mock，构建时会被真实模式覆盖），
     所以这不是「补一个缺失的文件」，而是**不让测试依赖那份默认值** ——
     它是可以被改的，改了之后链路测试会连同它一起漂。这里显式钉住。 */
  const envPath = path.join(root, 'config/env.js');
  require.cache[envPath] = {
    id: envPath, filename: envPath, loaded: true, children: [], paths: [],
    exports: Object.assign({
      APP_MODE: 'mock', BASE_URL: 'http://localhost:4000/api',
      CONFIGURED_API: '', API_EXPLICIT: false,
      VERSION: '0.0.0-test', GIT_SHA: 'test', STREAM_CHAT: true,
      FONT_FAMILY: 'JunshiSerif', FONT_BASE: '', FONT_WEIGHTS: [400, 600],
    }, env || {}),
  };

  /* 模块级单例（`services/nav` 的导航锁、store 的快照）会跨会话泄漏，
     让第二个测试莫名其妙跳不动。建会话时把整棵源码树的缓存清干净 ——
     但要留住上面刚注入的 env。 */
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(root) && key !== envPath) delete require.cache[key];
  }

  const storage = new Map();
  /** 页面栈：navigateTo 压栈，navigateBack 弹栈，redirectTo 替换栈顶。 */
  const stack = [];
  /** 用户可见的反馈（toast / modal / loading），断言「用户被告知了什么」。 */
  const toasts = [];
  const modals = [];
  /** 待处理的跳转意图；driver 消费后真正 mount 目标页。 */
  let pendingNav = null;
  /** 测试可预置 modal 的回答（confirm 弹窗点了确定还是取消）。 */
  let modalAnswer = true;
  /** 操作菜单按文案选项而不是按下标选；null 表示取第一项。 */
  let actionSheetPick = null;
  const actionSheets = [];

  const wx = {
    getStorageSync: (k) => (storage.has(k) ? storage.get(k) : ''),
    setStorageSync: (k, v) => { storage.set(k, v); },
    removeStorageSync: (k) => { storage.delete(k); },
    getStorageInfoSync: () => ({ keys: [...storage.keys()], currentSize: 0, limitSize: 10240 }),

    // 真机 390×844（iPhone 14/15），与原型和 §3.7.4 的量法同一台设备
    getSystemInfoSync: () => ({
      windowWidth: 390, windowHeight: 844, screenWidth: 390, screenHeight: 844,
      statusBarHeight: 44, safeArea: { top: 44, bottom: 810, left: 0, right: 390, height: 766, width: 390 },
      platform: 'devtools', theme: 'light', SDKVersion: '3.5.0',
    }),
    getMenuButtonBoundingClientRect: () => ({ top: 48, right: 383, bottom: 80, left: 296, width: 87, height: 32 }),
    getWindowInfo: () => wx.getSystemInfoSync(),
    getDeviceInfo: () => ({ platform: 'devtools' }),
    getAppBaseInfo: () => ({ theme: 'light', SDKVersion: '3.5.0' }),

    /* 跳转类 API 必须回调 success。`services/nav` 的导航锁靠 success/fail 复位
       `inFlight`，不回调就等于第一次跳转后整个 App 永远跳不动了 —— 不回调的桩
       会把真实代码测成「点了没反应」。 */
    navigateTo: (o) => { pendingNav = { type: 'navigateTo', url: o.url }; if (o.success) o.success({}); if (o.complete) o.complete({}); return Promise.resolve(); },
    redirectTo: (o) => { pendingNav = { type: 'redirectTo', url: o.url }; if (o.success) o.success({}); if (o.complete) o.complete({}); return Promise.resolve(); },
    reLaunch: (o) => { pendingNav = { type: 'reLaunch', url: o.url }; if (o.success) o.success({}); if (o.complete) o.complete({}); return Promise.resolve(); },
    switchTab: (o) => { pendingNav = { type: 'switchTab', url: o.url }; if (o.success) o.success({}); if (o.complete) o.complete({}); return Promise.resolve(); },
    navigateBack: (o = {}) => {
      // 返回同样有生命周期：被关掉的页要 onUnload（清计时器/浮层），露出来的页要 onShow
      // （多数页靠 onShow 刷新状态）。只 pop 数组的话，这两类逻辑一条都测不到。
      for (let i = 0; i < (o.delta || 1); i += 1) {
        const gone = stack.pop();
        if (gone && typeof gone.onUnload === 'function') { try { gone.onUnload(); } catch (_) { /* 收尾尽力而为 */ } }
      }
      const revealed = stack[stack.length - 1];
      if (revealed && typeof revealed.onShow === 'function') { try { revealed.onShow(); } catch (_) { /* 同上 */ } }
      if (o.success) o.success({}); if (o.complete) o.complete({});
      return Promise.resolve();
    },

    showToast: (o) => { toasts.push({ kind: 'toast', ...o }); if (o && o.success) o.success(); },
    hideToast: () => {},
    showLoading: (o) => { toasts.push({ kind: 'loading', ...o }); },
    hideLoading: () => {},
    showModal: (o) => {
      modals.push(o);
      const res = { confirm: modalAnswer, cancel: !modalAnswer };
      if (o && o.success) o.success(res);
      if (o && o.complete) o.complete(res);
      return Promise.resolve(res);
    },
    /**
     * 操作菜单。固定选第 0 项是不行的：`shots/index.js` 的 pickAsset 会按素材库
     * 有没有东西重排选项，第 0 项时而是「我的素材库」时而是「从相册选」——
     * 固定下标等于测试在选一个自己也不知道是什么的东西。所以按文案选。
     */
    showActionSheet: (o) => {
      const items = (o && o.itemList) || [];
      actionSheets.push(items);
      let index = 0;
      if (actionSheetPick) {
        const found = items.findIndex((label) => actionSheetPick.test(String(label)));
        if (found < 0) {
          const error = { errMsg: `showActionSheet: 没有匹配 ${actionSheetPick} 的选项：${items.join(' / ')}` };
          if (o && o.fail) o.fail(error);
          if (o && o.complete) o.complete(error);
          return Promise.reject(new Error(error.errMsg));
        }
        index = found;
      }
      const res = { tapIndex: index };
      if (o && o.success) o.success(res);
      if (o && o.complete) o.complete(res);
      return Promise.resolve(res);
    },

    setNavigationBarTitle: () => {}, setNavigationBarColor: () => {}, stopPullDownRefresh: () => {},
    pageScrollTo: () => {}, createSelectorQuery: () => ({ select: () => ({ boundingClientRect: () => ({ exec: (cb) => cb && cb([null]) }) }), selectAll: () => ({ boundingClientRect: () => ({ exec: (cb) => cb && cb([[]]) }) }), in: function () { return this; }, exec: (cb) => cb && cb([]) }),
    nextTick: (fn) => { if (fn) setTimeout(fn, 0); },

    // 采集类 API 只有真机能验；这里给可控替身，让链路不至于在这断掉。
    chooseMedia: (o) => { const res = { tempFiles: [{ tempFilePath: 'wxfile://mock-video.mp4', size: 1024, duration: 6 }] }; if (o && o.success) o.success(res); return Promise.resolve(res); },
    chooseVideo: (o) => { const res = { tempFilePath: 'wxfile://mock-video.mp4', size: 1024, duration: 6 }; if (o && o.success) o.success(res); return Promise.resolve(res); },
    chooseImage: (o) => { const res = { tempFilePaths: ['wxfile://mock.jpg'] }; if (o && o.success) o.success(res); return Promise.resolve(res); },
    getSetting: (o) => { const res = { authSetting: {} }; if (o && o.success) o.success(res); return Promise.resolve(res); },
    openSetting: (o) => { const res = { authSetting: {} }; if (o && o.success) o.success(res); return Promise.resolve(res); },
    requestSubscribeMessage: (o) => { const res = {}; if (o && o.success) o.success(res); return Promise.resolve(res); },
    saveVideoToPhotosAlbum: (o) => { if (o && o.success) o.success({}); return Promise.resolve({}); },
    saveImageToPhotosAlbum: (o) => { if (o && o.success) o.success({}); return Promise.resolve({}); },
    downloadFile: (o) => { const res = { tempFilePath: 'wxfile://dl.mp4', statusCode: 200 }; if (o && o.success) o.success(res); return Promise.resolve(res); },
    createInnerAudioContext: () => ({ play() {}, stop() {}, destroy() {}, onEnded() {}, onError() {}, onPlay() {}, set src(v) {} }),
    createVideoContext: () => ({ play() {}, pause() {}, stop() {}, seek() {} }),
    request: () => { throw new Error('harness 跑 mock 模式，不应发真实请求'); },
    uploadFile: () => { throw new Error('harness 跑 mock 模式，不应发真实上传'); },
    pluginLogin: (o) => { if (o && o.fail) o.fail({ errMsg: 'not a plugin' }); },
    env: { USER_DATA_PATH: '/tmp' },
  };

  /** 页面实例：data + setData + 绑定后的方法，与微信一致。 */
  function instantiate(config, query) {
    const page = { route: config.__route, options: query || {}, __config: config };
    page.data = JSON.parse(JSON.stringify(config.data || {}));
    page.setData = function (patch, cb) { mergeData(this.data, patch); if (cb) cb(); };
    for (const key of Object.keys(config)) {
      if (typeof config[key] === 'function') page[key] = config[key].bind(page);
      else if (key !== 'data' && !(key in page)) page[key] = config[key];
    }
    return page;
  }

  let captured = null;
  const globals = {
    wx,
    Page: (config) => { captured = config; },
    Component: (config) => { captured = config; },
    App: () => {},
    getApp: () => ({ globalData: {} }),
    getCurrentPages: () => stack.slice(),
  };

  /* 全局在建会话时就装上，直到 dispose 才摘。
     不能按调用范围临时装摘：页面普遍是 onLoad 里发请求、`.then()` 里 setData，
     那些回调在 await 之后才跑，作用域一还原回调里的 wx 就没了 —— 表现为
     「点了没反应」，而真机上 wx 本来就是常驻全局。 */
  const saved = {};
  let installed = false;
  function install() {
    if (installed) return;
    for (const k of Object.keys(globals)) { saved[k] = globalThis[k]; globalThis[k] = globals[k]; }
    installed = true;
  }
  function dispose() {
    if (!installed) return;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete globalThis[k]; else globalThis[k] = saved[k];
    }
    installed = false;
  }

  /** require 页面模块 → 取出 Page() 配置。每次清 require 缓存，页面模块保持干净。 */
  function loadPageConfig(route) {
    install();
    captured = null;
    const file = path.join(root, `${route}.js`);
    delete require.cache[require.resolve(file)];
    require(file);
    if (!captured) throw new Error(`${route} 没有调用 Page()/Component()`);
    captured.__route = route;
    return captured;
  }

  /** 保留这个名字让调用方读起来仍是「在小程序环境里跑这段」。 */
  async function withGlobals(fn) { install(); return fn(); }

  return {
    wx, require, storage, stack, toasts, modals,
    get pendingNav() { return pendingNav; },
    clearNav() { pendingNav = null; },
    answerModalWith(v) { modalAnswer = v; },
    /** 预置下一次（及之后）操作菜单要点哪一项，按文案正则匹配。 */
    pickActionSheetBy(re) { actionSheetPick = re; },
    actionSheets,
    lastToast() { return toasts.length ? toasts[toasts.length - 1] : null; },
    instantiate, loadPageConfig, withGlobals, install, dispose,
  };
}
