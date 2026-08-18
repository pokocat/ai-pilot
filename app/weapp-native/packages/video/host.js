// 宿主适配层 —— 「快出片」分包与军师之间的**唯一**耦合点。
//
// 铁律：packages/video/ 下的任何页面都不许直接 require 军师的 services/*。
// 全部经由本文件。抽成微信插件或独立小程序时，只重写这一个文件：
//
//   · 插件形态：storage 是插件私有的（读不到宿主的），登录只有 wx.pluginLogin，
//     路由要 plugin:// 前缀 —— 三处都在这里，改一个文件即可。
//   · 独立小程序：把 request 换成自己的 baseUrl + 鉴权头，其余不动。
//
// 这层只做「转接」，不做业务判断。业务判断在 model.js / 各页面里。
const store = require('../../services/store');
const { baseData, capsuleMetrics } = require('../../services/page');
const { navTo, gotoExecution } = require('../../services/nav');
const { getToken } = require('../../services/token');
const { request, upload, directUpload } = require('../../services/request');
const { useMockApi, getApiBaseUrl } = require('../../services/runtime-mode');

/* ── 1. 页面基座：主题、导航安全区、mock 标记 ────────────────────────── */

/** 页面 data 的公共底座。分包页面统一 `Object.assign(hostBaseData(), {...})`。 */
function hostBaseData(extra) { return baseData(extra); }

/** 胶囊按钮几何（自定义导航栏要用）。 */
function navMetrics() { return capsuleMetrics(); }

/* ── 2. 登录态 ──────────────────────────────────────────────────────── */

/**
 * 当前是否已登录。
 * 注意：军师的登录门整改结论是「游客可浏览、手机号非必需」，所以本分包的浏览类页面
 * （首页/模板详情）**不得**在 onLoad 里拦登录；只有「出片」「克隆分身」这类
 * 落库+扣费动作才要求登录。
 */
function isLoggedIn() { return Boolean(getToken()); }

/** 取当前用户快照（昵称/积分等）。未登录返回 null。 */
function currentUser() {
  const snapshot = store.snapshot();
  return snapshot && snapshot.me ? snapshot.me : null;
}

/** mock 构建被运营附身 JWT 激活后必须跟随真实服务端，不能继续读分包 mock。 */
function shouldUseMock() { return useMockApi(); }

/**
 * 要求登录。未登录时由宿主弹登录浮层（分包不自带登录页 —— 设计稿屏 01 在分包形态下不存在）。
 * @param {string} reason 透传给 login-sheet 的场景码，影响文案
 * @returns {boolean} 已登录返回 true；否则 false，调用方应立即 return
 */
function requireLogin(page, reason) {
  if (isLoggedIn()) return true;
  if (page && page.setData) page.setData({ showLogin: true, loginReason: reason || 'execute' });
  return false;
}

/* ── 3. 路由 ────────────────────────────────────────────────────────── */

const ROOT = '/packages/video';

/**
 * 分包内跳转。传相对路径（如 'shots/index?projectId=x'），由本函数补前缀。
 * 抽成插件后这里改成 plugin:// 前缀即可，页面代码不动。
 */
function go(relative) {
  const path = String(relative || '').replace(/^\/+/, '');
  return navTo(`${ROOT}/${path}`);
}

/** 跳出分包，去军师宿主的页面（充值、协议等）。抽走后这些要换成自己的实现或降级隐藏。 */
function goHost(absolute) { return navTo(absolute); }

/** 返回上一页；没有上一页时回军师「执行」tab。 */
function back(delta) {
  const pages = getCurrentPages();
  if (pages.length > (delta || 1)) { wx.navigateBack({ delta: delta || 1 }); return; }
  gotoExecution('today');
}

/* ── 4. 网络 ────────────────────────────────────────────────────────── */

/**
 * 发请求。**故意不暴露 baseUrl 给页面** —— 由 config.js 统一决定打哪个后端
 * （军师 BFF / mock），页面只认业务路径。
 * 详见 config.js 的 BACKEND_MODE 注释与技术方案 §3。
 */
function httpRequest(path, options) { return request(path, options); }
function httpUrl(path) { return `${getApiBaseUrl()}${path}`; }

/** 上传文件（b-roll 素材、克隆采集素材）。 */
function httpUpload(path, filePath, formData, options) { return upload(path, filePath, formData, options); }
function directFileUpload(url, filePath, formData, options) { return directUpload(url, filePath, formData, options); }
function downloadFile(url, options) {
  const opts = options || {};
  const token = getToken();
  return wx.downloadFile(Object.assign({}, opts, { url, header: Object.assign({}, opts.header || {}, token ? { 'x-user-id': token } : {}) }));
}

/* ── 5. 反馈 ────────────────────────────────────────────────────────── */

function toast(title, icon) { wx.showToast({ title: String(title || ''), icon: icon || 'none' }); }
function loading(title) { wx.showLoading({ title: String(title || '处理中'), mask: true }); }
function hideLoading() { wx.hideLoading(); }

function confirm(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    wx.showModal({
      title: opts.title || '确认',
      content: opts.content || '',
      confirmText: opts.confirmText || '确定',
      cancelText: opts.cancelText || '取消',
      confirmColor: opts.confirmColor || '#C74A1C',
      success: (res) => resolve(Boolean(res.confirm)),
      fail: () => resolve(false),
    });
  });
}

function alert(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    wx.showModal({
      title: opts.title || '提示',
      content: opts.content || '',
      showCancel: false,
      confirmText: opts.confirmText || '知道了',
      confirmColor: opts.confirmColor || '#C74A1C',
      complete: resolve,
    });
  });
}

function prompt(options) {
  const opts = options || {};
  return new Promise((resolve) => {
    wx.showModal({
      title: opts.title || '请输入',
      content: opts.content || '',
      editable: true,
      placeholderText: opts.placeholderText || '',
      confirmText: opts.confirmText || '保存',
      confirmColor: opts.confirmColor || '#C74A1C',
      success: (res) => resolve(res.confirm ? String(res.content || '').trim() : null),
      fail: () => resolve(null),
    });
  });
}

/**
 * 媒体选择兼容层：优先 chooseMedia；旧基础库回退 chooseVideo / chooseImage。
 * 方案文档 §5 的平台兼容要求集中在宿主层，页面不各写一套探测。
 */
function chooseMedia(options) {
  const opts = options || {};
  if (typeof wx.chooseMedia === 'function') return wx.chooseMedia(opts);
  const mediaTypes = opts.mediaType || ['image', 'video'];
  if (mediaTypes.indexOf('video') >= 0 && typeof wx.chooseVideo === 'function') {
    return wx.chooseVideo({
      sourceType: opts.sourceType,
      maxDuration: opts.maxDuration,
      camera: opts.camera,
      success: (res) => opts.success && opts.success({ tempFiles: [{
        tempFilePath: res.tempFilePath,
        duration: res.duration,
        size: res.size,
        fileType: 'video',
      }] }),
      fail: opts.fail,
    });
  }
  if (typeof wx.chooseImage === 'function') {
    return wx.chooseImage({
      count: opts.count || 1,
      sourceType: opts.sourceType,
      success: (res) => opts.success && opts.success({
        tempFiles: (res.tempFilePaths || []).map((tempFilePath, index) => ({
          tempFilePath,
          size: res.tempFiles && res.tempFiles[index] && res.tempFiles[index].size,
          fileType: 'image',
        })),
      }),
      fail: opts.fail,
    });
  }
  if (opts.fail) opts.fail({ errMsg: 'chooseMedia:fail unsupported' });
  return undefined;
}

/** 分包内全屏业务层仍需同步隐藏宿主 custom-tab-bar。 */
function setOverlay(open, key) { if (typeof store.setOverlay === 'function') store.setOverlay(open, key); }

/* ── 6. 本地草稿 ────────────────────────────────────────────────────── */
// 出片是多步流程（改文案 → 配画面 → 出片确认），中途退出必须能接着来。
// 服务端有草稿态（clip_project），本地这份只是「断网/退出时的兜底」，以服务端为准。

const DRAFT_KEY = 'video:draft';

function readDraft(projectId) {
  try {
    const all = wx.getStorageSync(DRAFT_KEY) || {};
    return projectId ? (all[projectId] || null) : all;
  } catch (_) { return projectId ? null : {}; }
}

function writeDraft(projectId, payload) {
  if (!projectId) return;
  try {
    const all = wx.getStorageSync(DRAFT_KEY) || {};
    all[projectId] = Object.assign({}, all[projectId], payload, { savedAt: Date.now() });
    wx.setStorageSync(DRAFT_KEY, all);
  } catch (_) { /* 存储满/被禁用时静默失败：草稿是增强，不该阻断出片 */ }
}

function clearDraft(projectId) {
  try {
    const all = wx.getStorageSync(DRAFT_KEY) || {};
    delete all[projectId];
    wx.setStorageSync(DRAFT_KEY, all);
  } catch (_) { /* 同上 */ }
}

module.exports = {
  hostBaseData, navMetrics,
  isLoggedIn, currentUser, shouldUseMock, requireLogin,
  go, goHost, back, ROOT,
  httpRequest, httpUrl, httpUpload, directFileUpload, downloadFile,
  toast, loading, hideLoading, confirm, alert, prompt, chooseMedia, setOverlay,
  readDraft, writeDraft, clearDraft,
};
