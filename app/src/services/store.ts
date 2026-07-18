import Taro from '@tarojs/taro';
import { colorByKey } from '../data/colors';
import { DEFAULT_AGENTS } from '../data/agents';
import { api, getUserId, setUserId, clearUserId, setAuthLostHandler, type Agent, type Me } from './api';
import { syncTabBarHidden } from './tabbar';

// 轻量全局状态：本命色主题 + 用户/智能体缓存 + 订阅。
// 跨页面共享，避免每页重复拉取。

const LS_COLOR = 'junshi.color';
const LS_ONBOARDED = 'junshi.onboarded';
const LS_LAST_SEEN_REPORT = 'junshi.lastSeenReportAt';

interface AppState {
  colorKey: string;
  onboarded: boolean;
  me: Me | null;
  agents: Agent[];
  tab: number; // 当前底栏选中项（0..4：问策/军情/军令/锦囊/主公）
  overlay: boolean; // 是否有全屏弹层打开——打开时隐藏原生/自定义底栏
  satchelDot: boolean; // 锦囊 tab 未读朱砂点（WO-A2：报告新出即亮，进锦囊即清）
  lastSeenReportAt: string; // 本地记：上次在锦囊看过的最新报告时间（ISO）——与最新报告对比决定朱砂点
}

const state: AppState = {
  colorKey: safeGet(LS_COLOR) || 'green', // 默认墨绿 = 设计稿主色
  onboarded: safeGet(LS_ONBOARDED) === '1',
  me: null,
  agents: DEFAULT_AGENTS, // 离线兜底；后端可达时由 loadAgents 覆盖
  tab: 0,
  overlay: false,
  satchelDot: false,
  lastSeenReportAt: safeGet(LS_LAST_SEEN_REPORT) || '',
};
const overlayKeys = new Set<string>();
let lastUnauthorizedPromptAt = 0;

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
      if (currentRoute() !== 'pages/counsel/index') {
        setTimeout(() => Taro.reLaunch({ url: '/pages/counsel/index' }), 250);
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
  satchelDot: () => state.satchelDot,
  setSatchelDot(v: boolean) { if (state.satchelDot !== v) { state.satchelDot = v; emit(); } },
  lastSeenReportAt: () => state.lastSeenReportAt,
  // 进锦囊：把已看时间推到最新报告时间并清点（satchel 页 useDidShow 调用）
  markReportsSeen(latestAt?: string) {
    const next = latestAt || new Date().toISOString();
    if (next > state.lastSeenReportAt) {
      state.lastSeenReportAt = next;
      safeSet(LS_LAST_SEEN_REPORT, next);
    }
    this.setSatchelDot(false);
  },
  // 启动/回前台：拉最新一条报告时间，比已看时间新 → 亮朱砂点
  async refreshSatchelDot() {
    if (!getUserId()) return;
    try {
      const list = await api.reports();
      const latest = list[0]?.updatedAt || '';
      if (latest && latest > state.lastSeenReportAt) this.setSatchelDot(true);
    } catch { /* 静默：拉取失败不影响导航 */ }
  },
  overlay: () => state.overlay,
  handleApiError: reportApiError,
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
  },
  logout() {
    clearUserId();
    state.me = null;
    state.onboarded = false;
    state.agents = DEFAULT_AGENTS;
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
