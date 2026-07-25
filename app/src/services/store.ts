import Taro from '@tarojs/taro';
import { colorByKey } from '../data/colors';
import { DEFAULT_AGENTS } from '../data/agents';
import { api, getUserId, setUserId, clearUserId, setAuthLostHandler, type Agent, type Me } from './api';
import { syncTabBarHidden } from './tabbar';

// 轻量全局状态：本命色主题 + 用户/智能体缓存 + 订阅。
// 跨页面共享，避免每页重复拉取。

const LS_COLOR = 'junshi.color';
const LS_ONBOARDED = 'junshi.onboarded';

interface AppState {
  colorKey: string;
  onboarded: boolean;
  me: Me | null;
  agents: Agent[];
  tab: number; // 当前底栏选中项（0..4）
  overlay: boolean; // 是否有全屏弹层打开——打开时隐藏原生/自定义底栏
  badges: BadgeState; // 底栏角标（问策未读数 / 军令待复盘）
}

// 底栏角标数据（服务端为准，不做本地乐观清零：进会话已读由 lastReadAt 记账，下轮 loadBadges 自然归零）。
interface BadgeState {
  unread: number;         // 问策未读总数 = /sessions 各项 unreadCount 之和
  reviewedDate: string;   // 最近一次复盘日期（YYYY-MM-DD）；空 = 账本里没有复盘记录
  reviewLoaded: boolean;  // 复盘账本取到过一次才敢亮红点，避免冷启动/断网误报
}

const state: AppState = {
  colorKey: safeGet(LS_COLOR) || 'green', // 默认墨绿 = 设计稿主色
  onboarded: safeGet(LS_ONBOARDED) === '1',
  me: null,
  agents: DEFAULT_AGENTS, // 离线兜底；后端可达时由 loadAgents 覆盖
  tab: 0,
  overlay: false,
  badges: { unread: 0, reviewedDate: '', reviewLoaded: false },
};
const overlayKeys = new Set<string>();
let lastUnauthorizedPromptAt = 0;

// —— 底栏角标：拉取节流与「今日复盘」判定 ——
const BADGE_THROTTLE_MS = 15_000;     // 同一批数据 15 秒内不重复拉（tab 间来回切换不打服务端）
const REVIEW_DUE_HOUR = 21;           // 过了 21:00 今日还没复盘 → 军令 tab 亮红点
let badgesFetchedAt = 0;
let badgesInFlight: Promise<void> | null = null;

/** 本机今日日期键（YYYY-MM-DD），与服务端复盘账本 date 同格式（用户与服务同在东八区）。 */
function todayKey(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

type ApiErrorKind = 'unauthorized' | 'network' | 'other';

function apiErrorCode(e: unknown): string {
  return String((e as any)?.code || (e as any)?.data?.code || '');
}

function isUnauthorizedError(e: unknown): boolean {
  return apiErrorCode(e) === 'UNAUTHORIZED' || String((e as any)?.message || '').includes('未登录');
}

function resetAuthState() {
  clearUserId();
  state.me = null;
  state.onboarded = false;
  safeSet(LS_ONBOARDED, '');
}

function reportApiError(e: unknown, options: { silent?: boolean; fallbackTitle?: string } = {}): ApiErrorKind {
  if (isUnauthorizedError(e)) {
    resetAuthState();
    emit();
    if (!options.silent) {
      const now = Date.now();
      const shouldPrompt = now - lastUnauthorizedPromptAt > 1500;
      if (shouldPrompt) {
        lastUnauthorizedPromptAt = now;
        Taro.showToast({ title: '登录态已失效，请重新登录', icon: 'none' });
      }
      if (currentRoute() !== 'pages/sessions/index') {
        setTimeout(() => Taro.reLaunch({ url: '/pages/sessions/index' }), 250);
      }
    }
    return 'unauthorized';
  }

  if (apiErrorCode(e) === 'NETWORK_ERROR') {
    if (!options.silent) {
      const msg = String((e as any)?.message || options.fallbackTitle || '网络请求失败');
      Taro.showToast({ title: msg, icon: 'none' });
    }
    return 'network';
  }

  if (!options.silent && options.fallbackTitle) {
    Taro.showToast({ title: options.fallbackTitle, icon: 'none' });
  }
  return 'other';
}

// 全局登录态失效处理：api.request() 收到 401 时**无条件**回调这里，即便页面 .catch 吞掉了错误，
// 也会走到「清登录态 + 提示重新登录 + reLaunch 回登录入口」。杜绝用户滞留在失效界面看旧缓存。
setAuthLostHandler(() => reportApiError({ code: 'UNAUTHORIZED' }));

type Listener = () => void;
const listeners = new Set<Listener>();
export function subscribe(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit() {
  listeners.forEach((fn) => fn());
}

function safeGet(k: string): string {
  try { return Taro.getStorageSync(k) || ''; } catch { return ''; }
}
function safeSet(k: string, v: string) {
  try { Taro.setStorageSync(k, v); } catch { /* noop */ }
}
function currentRoute(): string {
  try {
    const getPages = (globalThis as typeof globalThis & { getCurrentPages?: () => { route?: string }[] }).getCurrentPages;
    const pages = getPages?.() ?? [];
    return pages[pages.length - 1]?.route || '';
  } catch {
    return '';
  }
}

export const store = {
  get: () => state,
  colorKey: () => state.colorKey,
  color: () => colorByKey(state.colorKey),
  themeClass: () => `theme-${state.colorKey}`,
  isOnboarded: () => state.onboarded,
  isAuthed: () => !!getUserId(),
  // P2-18：移除死方法 setOnboarded（无调用方，与 completeOnboarding 重复）。
  me: () => state.me,
  // P0-2：命理总开关（合规降级）。me 未加载时默认 true，不误伤首屏；后端 /me 下发后即真态。
  fortuneOn: () => state.me?.features?.fortune !== false,
  agents: () => state.agents,
  tab: () => state.tab,
  setTab(i: number) { state.tab = i; emit(); },
  overlay: () => state.overlay,
  handleApiError: reportApiError,

  // —— 底栏角标（问策未读数 / 军令待复盘红点） ——
  badgeUnread: () => state.badges.unread,
  // 军令红点：账本已取到 + 今日无复盘记录 + 已过 21:00。时点即时判定，不缓存布尔值。
  reviewDue: () =>
    state.badges.reviewLoaded
    && state.badges.reviewedDate !== todayKey()
    && new Date().getHours() >= REVIEW_DUE_HOUR,
  /** 会话列表已在手（问策页刚拉过）时就地同步未读：省一次请求，也免得同屏列表与角标对不上。 */
  syncUnreadFromSessions(list: { unreadCount?: number }[]) {
    const unread = list.reduce((sum, it) => sum + (it.unreadCount ?? 0), 0);
    if (state.badges.unread === unread) return;
    state.badges.unread = unread;
    emit();
  },
  /**
   * 拉底栏角标数据（未登录直接返回；15 秒节流；单飞去重）。
   * 失败一律静默——角标不该为自己弹错误 toast，也不做本地乐观清零：
   * 进会话已读由服务端 lastReadAt 记账，下一轮拉取自然归零。
   * skipSessions：调用页自己在拉 /sessions（问策页）时传，避免同一次进页发两遍同样的请求。
   */
  async loadBadges(opts: { force?: boolean; skipSessions?: boolean } = {}) {
    const { force = false, skipSessions = false } = opts;
    if (!getUserId()) return;
    if (badgesInFlight) { await badgesInFlight; return; }
    if (!force && Date.now() - badgesFetchedAt < BADGE_THROTTLE_MS) return;
    const job = (async () => {
      try {
        const [sessions, reviews] = await Promise.all([
          skipSessions ? Promise.resolve(null) : api.sessions().catch(() => null),
          api.reviews().catch(() => null),
        ]);
        let changed = false;
        if (sessions) {
          const unread = (sessions ?? []).reduce((sum, it) => sum + (it?.unreadCount ?? 0), 0);
          if (unread !== state.badges.unread) { state.badges.unread = unread; changed = true; }
        }
        if (reviews) {
          // 「今日已复盘」信号：复盘账本里最新一条的 date（day/week/month 任一层级都算今日做过复盘）
          const latest = (reviews.items ?? []).reduce((max, it) => (it?.date && it.date > max ? it.date : max), '');
          if (latest !== state.badges.reviewedDate) { state.badges.reviewedDate = latest; changed = true; }
          if (!state.badges.reviewLoaded) { state.badges.reviewLoaded = true; changed = true; }
        }
        if (sessions || reviews) badgesFetchedAt = Date.now(); // 全失败则不记时点，下次调用立即重试
        if (changed) emit();
      } catch { /* 角标是附属信息：任何异常都不外溢、不弹错，等下一轮刷新 */ }
    })();
    badgesInFlight = job.finally(() => { badgesInFlight = null; });
    await badgesInFlight;
  },
  setOverlay(v: boolean, key = 'global') {
    if (v) overlayKeys.add(key);
    else overlayKeys.delete(key);
    const next = overlayKeys.size > 0;
    if (state.overlay !== next) {
      state.overlay = next;
      syncTabBarHidden(next);
      emit();
    }
  },

  setColor(key: string, persist = true) {
    state.colorKey = key;
    if (persist) {
      safeSet(LS_COLOR, key);
      api.setColor(key).catch(() => {});
    }
    emit();
  },
  completeOnboarding() {
    state.onboarded = true;
    safeSet(LS_ONBOARDED, '1');
    emit();
  },
  async loadMe() {
    if (!getUserId()) return; // 未登录不拉取
    try {
      const me = await api.me();
      state.me = me;
      if (me.user.benmingColor && !safeGet(LS_COLOR)) {
        state.colorKey = me.user.benmingColor;
      }
      if (typeof me.onboarded === 'boolean') state.onboarded = me.onboarded;
      emit();
    } catch (e) { reportApiError(e, { silent: true }); }
  },
  // 登录成功：落 token、同步账号状态，并拉取该账号数据
  async afterLogin(token: string, onboarded: boolean, benmingColor?: string) {
    setUserId(token);
    state.onboarded = onboarded;
    safeSet(LS_ONBOARDED, onboarded ? '1' : '');
    if (benmingColor) { state.colorKey = benmingColor; safeSet(LS_COLOR, benmingColor); }
    emit();
    await this.loadMe();
    await this.loadAgents();
    void this.loadBadges({ force: true }); // 换账号即重算角标，不沿用上一个账号的未读/复盘态
  },
  logout() {
    clearUserId();
    state.me = null;
    state.onboarded = false;
    state.agents = DEFAULT_AGENTS;
    state.badges = { unread: 0, reviewedDate: '', reviewLoaded: false };
    badgesFetchedAt = 0;
    overlayKeys.clear();
    state.overlay = false;
    syncTabBarHidden(false);
    safeSet(LS_ONBOARDED, '');
    emit();
  },
  async loadAgents() {
    try {
      const list = await api.agents();
      if (list?.length) {
        const fallback = new Map(DEFAULT_AGENTS.map((a) => [a.key, a]));
        state.agents = list.map((a) => {
          const base = fallback.get(a.key);
          return base
            ? {
                ...base,
                ...a,
                billing: a.billing ?? base.billing,
                price: typeof a.price === 'number' ? a.price : base.price,
                owned: typeof a.owned === 'boolean' ? a.owned : base.owned,
              }
            : a;
        });
      }
      emit();
    } catch { /* 离线时保留内置兜底 */ }
  },
  agentsByType(type: string) {
    return state.agents.filter((a) => a.type === type);
  },
  // 专项能力启用/方案更新后刷新：余额（me）+ 智能体 owned 状态。
  async refreshAfterPurchase() {
    await Promise.all([this.loadMe(), this.loadAgents()]);
  },
};
