import Taro from '@tarojs/taro';
import { colorByKey } from '../data/colors';
import { DEFAULT_AGENTS } from '../data/agents';
import { api, getUserId, setUserId, clearUserId, type Agent, type Me } from './api';
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
}

const state: AppState = {
  colorKey: safeGet(LS_COLOR) || 'green', // 默认墨绿 = 设计稿主色
  onboarded: safeGet(LS_ONBOARDED) === '1',
  me: null,
  agents: DEFAULT_AGENTS, // 离线兜底；后端可达时由 loadAgents 覆盖
  tab: 0,
  overlay: false,
};
const overlayKeys = new Set<string>();

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
      Taro.showToast({ title: '登录态已失效，请重新登录', icon: 'none' });
      setTimeout(() => Taro.reLaunch({ url: '/pages/sessions/index' }), 250);
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

export const store = {
  get: () => state,
  colorKey: () => state.colorKey,
  color: () => colorByKey(state.colorKey),
  themeClass: () => `theme-${state.colorKey}`,
  isOnboarded: () => state.onboarded,
  isAuthed: () => !!getUserId(),
  // P2-18：移除死方法 setOnboarded（无调用方，与 completeOnboarding 重复）。
  me: () => state.me,
  agents: () => state.agents,
  tab: () => state.tab,
  setTab(i: number) { state.tab = i; emit(); },
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
    state.agents = [];
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
