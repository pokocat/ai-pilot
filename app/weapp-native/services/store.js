const { api, isMock } = require('./api');
const { getToken, setToken, clearToken } = require('./token');
const { setAuthLostHandler } = require('./request');
const { DEFAULT_AGENTS } = require('./mock');
const { isColorKey } = require('./colors');
const { apiErrorPresentation } = require('./api-error');

const COLOR_KEY = 'junshi.color';
const ONBOARDED_KEY = 'junshi.onboarded';
const overlayKeys = new Set();
const state = {
  colorKey: 'green',
  onboarded: false,
  onboardingKnown: false,
  agents: DEFAULT_AGENTS,
  me: null,
  unread: 0,
  // 待复盘红点用：reviewedDate = 账本里最新一条复盘日期（空 = 没有记录）；
  // reviewLoaded = 取到过一次才敢亮红点，避免冷启动 / 断网误报。
  reviewedDate: '',
  reviewLoaded: false,
  overlay: false,
};

function safeGet(key) {
  try { return wx.getStorageSync(key); } catch (_) { return ''; }
}

function bootstrap() {
  state.colorKey = safeGet(COLOR_KEY) || 'green';
  state.onboarded = safeGet(ONBOARDED_KEY) === '1';
  // 有 token 但没有完成缓存时，必须等 /me 给出权威状态；否则老用户会在冷启动
  // 的第一个渲染帧被误判成“未建档”。未登录与已有完成缓存则无需等待。
  state.onboardingKnown = !getToken() || state.onboarded;
}

function currentRoute() {
  try {
    const pages = getCurrentPages();
    return pages.length ? pages[pages.length - 1].route : '';
  } catch (_) { return ''; }
}

function resetAuth() {
  clearToken();
  state.me = null;
  state.onboarded = false;
  state.onboardingKnown = true;
  try { wx.removeStorageSync(ONBOARDED_KEY); } catch (_) { /* noop */ }
}

function handleApiError(error, options) {
  const opts = options || {};
  const code = String((error && (error.code || (error.data && error.data.code))) || '');
  if (code === 'UNAUTHORIZED') {
    if (error && error.hadToken === false) return 'unauthorized';
    resetAuth();
    if (!opts.silent) wx.showToast({ title: '登录态已失效，请重新登录', icon: 'none' });
    if (currentRoute() !== 'pages/sessions/index') {
      setTimeout(() => wx.reLaunch({ url: '/pages/sessions/index' }), 250);
    }
    return 'unauthorized';
  }
  const view = apiErrorPresentation(error, opts.fallbackTitle);
  if (!opts.silent) {
    if (view.action === 'plans' || view.action === 'credits') promptErrorAction(view);
    else if (view.kind !== 'cancelled') wx.showToast({ title: view.message, icon: 'none' });
  }
  return view.kind;
}

let planModalOpen = false;
function promptErrorAction(view) {
  if (planModalOpen) return;
  planModalOpen = true;
  const credits = view.action === 'credits';
  const title = view.kind === 'quota' ? '当前用量已用完'
    : view.kind === 'plan_expired' ? '当前方案已到期'
      : credits ? '当前算力不足' : '尚未开通方案';
  wx.showModal({
    title,
    content: view.message,
    confirmText: credits ? '查看算力' : '查看方案',
    cancelText: '暂不处理',
    complete: () => { planModalOpen = false; },
    success: (result) => {
      if (result.confirm) wx.navigateTo({ url: credits ? '/packages/work/credits/index' : '/packages/work/plans/index' });
    },
  });
}

/** 「未开通方案」引导弹窗（去开通 → 方案页）。同屏多请求并发失败时只弹一次。 */
function promptPlanRequired() {
  promptErrorAction({
    kind: 'plan_required', action: 'plans',
    message: '开通方案后即可使用军师的推演与成果能力。',
  });
}

/** 当前账号是否从未开通方案（/me.planStatus.none）。取不到 me 时按「已开通」处理，不误拦。 */
function planRequired() {
  return Boolean(state.me && state.me.planStatus && state.me.planStatus.none);
}

setAuthLostHandler(() => handleApiError({ code: 'UNAUTHORIZED', hadToken: true }));

async function loadAgents() {
  try { state.agents = await api.agents(); } catch (_) { state.agents = DEFAULT_AGENTS; }
  return state.agents;
}

async function loadMe() {
  if (!getToken()) {
    state.onboardingKnown = true;
    return null;
  }
  try {
    state.me = await api.me();
    const color = state.me && state.me.user && state.me.user.benmingColor;
    if (color) { state.colorKey = color; wx.setStorageSync(COLOR_KEY, color); }
    if (typeof state.me.onboarded === 'boolean') {
      state.onboarded = state.me.onboarded;
      state.onboardingKnown = true;
      wx.setStorageSync(ONBOARDED_KEY, state.onboarded ? '1' : '');
    }
    return state.me;
  } catch (error) {
    handleApiError(error, { silent: true });
    return null;
  }
}

async function afterLogin(result) {
  setToken(result.token);
  state.onboarded = Boolean(result.onboarded);
  state.onboardingKnown = true;
  wx.setStorageSync(ONBOARDED_KEY, state.onboarded ? '1' : '');
  const color = result.user && result.user.benmingColor;
  if (color) { state.colorKey = color; wx.setStorageSync(COLOR_KEY, color); }
  await Promise.all([loadMe(), loadAgents()]);
}

function setColor(colorKey, persist) {
  const value = isColorKey(colorKey) ? colorKey : 'green';
  state.colorKey = value;
  if (persist !== false) {
    wx.setStorageSync(COLOR_KEY, value);
    api.setColor(value).catch(() => {});
  }
}

function completeOnboarding() {
  state.onboarded = true;
  state.onboardingKnown = true;
  wx.setStorageSync(ONBOARDED_KEY, '1');
}

function setOverlay(open, key) {
  const id = String(key || 'default');
  if (open) overlayKeys.add(id); else overlayKeys.delete(id);
  state.overlay = overlayKeys.size > 0;
  try {
    const pages = getCurrentPages();
    const page = pages.length ? pages[pages.length - 1] : null;
    const tabbar = page && page.getTabBar && page.getTabBar();
    if (tabbar && typeof tabbar.syncState === 'function') tabbar.syncState({ overlay: state.overlay });
    else if (tabbar && tabbar.setData) tabbar.setData({ overlay: state.overlay });
  } catch (_) { /* 非 tab 页或组件销毁阶段无需同步 */ }
}

function syncUnread(list) {
  state.unread = (list || []).reduce((sum, item) => sum + (Number(item.unreadCount) || 0), 0);
}

// —— 战局 tab 的待复盘红点（2026-08-12 补产出方）——
// 此前 custom-tab-bar 一直在消费 reviewDue，但小程序侧没有任何地方产出它，红点从来不亮
// （只有 H5 的 store.ts 有实现）。判据与 H5 同源：复盘账本取到过 + 今日无复盘记录 + 已过 21:00。
// 时点即时判定、不缓存布尔值，跨过 21:00 不需要额外刷新就会亮。
const REVIEW_DUE_HOUR = 21;
const REVIEW_THROTTLE_MS = 15000;
let reviewFetchedAt = 0;
let reviewInFlight = null;

function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function reviewDue() {
  return state.reviewLoaded && state.reviewedDate !== todayKey() && new Date().getHours() >= REVIEW_DUE_HOUR;
}
/** 拉复盘账本判红点：未登录直接返回；15 秒节流 + 单飞去重；失败静默（角标不为自己弹错）。 */
async function loadReviewBadge(options) {
  if (!getToken()) return;
  if (reviewInFlight) { await reviewInFlight; return; }
  const force = Boolean(options && options.force);
  if (!force && Date.now() - reviewFetchedAt < REVIEW_THROTTLE_MS) return;
  const job = (async () => {
    try {
      const { api } = require('./api');
      const result = await api.reviews();
      const items = result && Array.isArray(result.items) ? result.items : [];
      // day / week / month 任一层级算今日做过复盘，与 H5 判据一致。
      state.reviewedDate = items.reduce((max, item) => (item && item.date && item.date > max ? item.date : max), '');
      state.reviewLoaded = true;
      reviewFetchedAt = Date.now();
    } catch (_) { /* 角标是附属信息，失败不外溢；不记时点，下次调用立即重试 */ }
  })();
  reviewInFlight = job.then(() => { reviewInFlight = null; }, () => { reviewInFlight = null; });
  await reviewInFlight;
}

function snapshot() {
  return {
    colorKey: state.colorKey,
    themeClass: `theme-${state.colorKey}`,
    onboarded: state.onboarded,
    onboardingKnown: state.onboardingKnown,
    agents: state.agents,
    me: state.me,
    unread: state.unread,
    reviewDue: reviewDue(),
    overlay: state.overlay,
    authed: Boolean(getToken()),
    mock: isMock(),
  };
}

module.exports = {
  bootstrap, snapshot, isAuthed: () => Boolean(getToken()), loadAgents, loadMe,
  afterLogin, syncUnread, loadReviewBadge, handleApiError, resetAuth, setColor, completeOnboarding, setOverlay,
  planRequired, promptPlanRequired,
};
