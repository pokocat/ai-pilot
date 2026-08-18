import { platform } from './platform';
import { colorByKey } from '../data/colors';
import { DEFAULT_AGENTS } from '../data/agents';
import { api, getUserId, setUserId, clearUserId, setAuthLostHandler, type Agent, type Me } from './api';
// 静态引入（勿改动态 import）：小程序打包会把动态 import 切成独立 chunk，真机上有解析风险。
// wechatSubscribe 只依赖 ./api、不反向依赖 store，无循环引用。
import { apiErrorCode, apiErrorPresentation, type ApiErrorKind, type ApiErrorPresentation } from './apiError';

// 轻量全局状态：本命色主题 + 用户/智能体缓存 + 订阅。
// 跨页面共享，避免每页重复拉取。

const LS_COLOR = 'junshi.color';
const LS_ONBOARDED = 'junshi.onboarded';

interface AppState {
  colorKey: string;
  onboarded: boolean;
  onboardingKnown: boolean;
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
  // 有 token 但没有本地完成标记时，必须先等 /me 给权威结果；不能把「尚未加载」误当「未建档」。
  onboardingKnown: !getUserId() || safeGet(LS_ONBOARDED) === '1',
  me: null,
  agents: DEFAULT_AGENTS, // 离线兜底；后端可达时由 loadAgents 覆盖
  tab: 0,
  overlay: false,
  badges: { unread: 0, reviewedDate: '', reviewLoaded: false },
};
const overlayKeys = new Set<string>();
let lastUnauthorizedPromptAt = 0;
let entitlementPromptOpen = false;

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

function isUnauthorizedError(e: unknown): boolean {
  return apiErrorCode(e) === 'UNAUTHORIZED' || String((e as any)?.message || '').includes('未登录');
}

function promptErrorAction(view: ApiErrorPresentation) {
  if (entitlementPromptOpen) return;
  entitlementPromptOpen = true;
  const credits = view.action === 'credits';
  const title = view.kind === 'quota' ? '当前用量已用完'
    : view.kind === 'plan_expired' ? '当前方案已到期'
      : credits ? '当前算力不足' : '尚未开通方案';
  void platform.confirm({
    title,
    content: view.message,
    confirmText: credits ? '查看算力' : '查看方案',
    cancelText: '暂不处理',
  }).then((ok) => {
    if (ok) platform.navigate(credits ? '/packages/work/credits/index' : '/packages/work/plans/index');
  }).finally(() => { entitlementPromptOpen = false; });
}

function resetAuthState() {
  clearUserId();
  state.me = null;
  state.onboarded = false;
  state.onboardingKnown = true;
  safeSet(LS_ONBOARDED, '');
}

function reportApiError(e: unknown, options: { silent?: boolean; fallbackTitle?: string } = {}): ApiErrorKind {
  if (isUnauthorizedError(e)) {
    // 游客从未持有 token：这是动作级登录门，不是「登录态失效」。不清状态、不提示、不跳路由。
    if ((e as { hadToken?: boolean })?.hadToken === false) return 'unauthorized';
    // 请求层已处理过全局退出，或旧请求在新会话建立后才返回 401：页面 catch 不得再跳一次。
    if ((e as { authHandled?: boolean; staleAuth?: boolean })?.authHandled === true
      || (e as { authHandled?: boolean; staleAuth?: boolean })?.staleAuth === true) return 'unauthorized';
    resetAuthState();
    emit();
    if (!options.silent) {
      const now = Date.now();
      const shouldPrompt = now - lastUnauthorizedPromptAt > 1500;
      if (shouldPrompt) {
        lastUnauthorizedPromptAt = now;
        platform.toast('登录态已失效，请重新登录');
      }
      if (currentRoute() !== 'pages/sessions/index') {
        setTimeout(() => platform.relaunch('/pages/sessions/index'), 250);
      }
    }
    return 'unauthorized';
  }

  const view = apiErrorPresentation(e, options.fallbackTitle);
  if (!options.silent) {
    if (view.action === 'plans' || view.action === 'credits') promptErrorAction(view);
    else if (view.kind !== 'cancelled') platform.toast(view.message);
  }
  return view.kind;
}

// 全局登录态失效处理：api.request() 只有在请求发出时携带过 token 且收到 401 才回调这里；
// 即便页面 .catch 吞掉了错误，也会走到「清登录态 + 提示重新登录 + reLaunch 回登录入口」。
// 游客请求的 401 留给动作级登录门处理，不提示“登录态失效”。
setAuthLostHandler(() => reportApiError({ code: 'UNAUTHORIZED', hadToken: true }));

/**
 * 宿主钩子：store 里少数「只有某一端才有意义」的副作用，由宿主在启动时注入，默认不做事。
 * 这样 store 不必静态 import 小程序专用模块（Taro 底栏、订阅消息），PC 包才能不含 Taro 运行时。
 */
export interface HostHooks {
  /** 全屏弹层开合：移动端据此同步隐藏自定义底栏；PC 没有底栏，不注册。 */
  onOverlayChange?: (hidden: boolean) => void;
  /** 用户信息加载完成：移动端据此预取微信订阅模板；PC 无订阅消息，不注册。 */
  onMeLoaded?: () => void;
}
let hostHooks: HostHooks = {};
export function setHostHooks(hooks: HostHooks): void {
  hostHooks = { ...hostHooks, ...hooks };
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
  return platform.storage.get(k);
}
function safeSet(k: string, v: string) {
  platform.storage.set(k, v);
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
  isOnboardingKnown: () => state.onboardingKnown,
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
      hostHooks.onOverlayChange?.(next);
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
    state.onboardingKnown = true;
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
      if (typeof me.onboarded === 'boolean') {
        state.onboarded = me.onboarded;
        state.onboardingKnown = true;
        safeSet(LS_ONBOARDED, me.onboarded ? '1' : '');
      }
      emit();
    } catch (e) { reportApiError(e, { silent: true }); }
  },
  // 登录成功：落 token、同步账号状态，并拉取该账号数据
  async afterLogin(token: string, onboarded: boolean, benmingColor?: string) {
    setUserId(token);
    state.onboarded = onboarded;
    state.onboardingKnown = true;
    safeSet(LS_ONBOARDED, onboarded ? '1' : '');
    if (benmingColor) { state.colorKey = benmingColor; safeSet(LS_COLOR, benmingColor); }
    emit();
    await this.loadMe();
    await this.loadAgents();
    void this.loadBadges({ force: true }); // 换账号即重算角标，不沿用上一个账号的未读/复盘态
    // 订阅模板预热必须在这里再来一次（2026-07-31 真机实测的坑）：app.tsx 的 useLaunch 里那次
    // 带 `!getUserId()` 前置，**新用户启动时还没登录，那次直接空转**，tplCache 恒为 null。
    // 于是点「购买」时 requestWechatSubscribe 只能先 await 拉模板，第一个 await 就落在
    // requestSubscribeMessage 之前 → 手势上下文丢失 → 微信拒（can only be invoked by user TAP
    // gesture）→ 弹窗不出、不留记录、购买照常继续，用户永远拿不到 payment 配额、收不到到账通知。
    // 内部对 tplCache 已有幂等判断，已热则直接返回。
    hostHooks.onMeLoaded?.();
  },
  logout() {
    clearUserId();
    state.me = null;
    state.onboarded = false;
    state.onboardingKnown = true;
    state.agents = DEFAULT_AGENTS;
    state.badges = { unread: 0, reviewedDate: '', reviewLoaded: false };
    badgesFetchedAt = 0;
    overlayKeys.clear();
    state.overlay = false;
    hostHooks.onOverlayChange?.(false);
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
