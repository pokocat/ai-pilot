import Taro from '@tarojs/taro';
import { colorByKey } from '../data/colors';
import { api, type Agent, type Me } from './api';

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
}

const state: AppState = {
  colorKey: safeGet(LS_COLOR) || 'gold',
  onboarded: safeGet(LS_ONBOARDED) === '1',
  me: null,
  agents: [],
  tab: 0,
};

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
  me: () => state.me,
  agents: () => state.agents,
  tab: () => state.tab,
  setTab(i: number) { state.tab = i; emit(); },

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
    try {
      const me = await api.me();
      state.me = me;
      if (me.user.benmingColor && !safeGet(LS_COLOR)) {
        state.colorKey = me.user.benmingColor;
      }
      emit();
    } catch { /* 离线时忽略 */ }
  },
  async loadAgents() {
    try {
      state.agents = await api.agents();
      emit();
    } catch { /* 离线时忽略 */ }
  },
  agentsByType(type: string) {
    return state.agents.filter((a) => a.type === type);
  },
};
