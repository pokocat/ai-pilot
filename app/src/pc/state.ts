// PC 工作台的区/子区状态 + URL 同步 + 抽屉/右键菜单/Toast。
//
// 与移动端的关系：移动端一个 tab 是一个页面，PC 端整个工作台是**单页应用内的组件树**，
// 「换区」不走页面跳转，只改这里的 state。但地址栏必须跟着走，否则刷新回到默认区、
// 也无法把「某个区的某条会话」发给别人。
//
// 路由形如 `#/think?view=assets&k=general`：路径段是区，query 是子区与选中项。

import { useCallback, useEffect, useRef, useState } from 'react';

export type PcTab = 'sessions' | 'sand' | 'exec' | 'think' | 'lord';
export type SandView = 'business' | 'timing' | 'destiny';
export type ExecView = 'today' | 'week' | 'review';
export type ThinkView = 'assets' | 'data' | 'modules' | 'reports';
export type LordView = 'overview';

/** 抽屉内容：由各区自行构造，Shell 只负责壳与开合。 */
export interface DrawerBlock {
  label: string;
  title: string;
  body: string;
  mark?: string;
  tactic?: string;
  tacticColor?: string;
}
export interface DrawerAction {
  t: string;
  primary?: boolean;
  danger?: boolean;
  go: () => void;
}
export interface DrawerData {
  kicker: string;
  title: string;
  quote?: string;
  blocks?: DrawerBlock[];
  synthesis?: { title: string; body: string };
  actions?: DrawerAction[];
}

export interface CtxItem {
  t: string;
  k?: string;
  danger?: boolean;
  go: () => void;
}
export interface CtxData {
  x: number;
  y: number;
  label: string;
  items: CtxItem[];
}

const TABS: PcTab[] = ['sessions', 'sand', 'exec', 'think', 'lord'];

const DEFAULT_VIEW: Record<PcTab, string> = {
  sessions: '',
  sand: 'business',
  exec: 'today',
  think: 'assets',
  lord: 'overview',
};

const LS_LIST_W = 'junshi_pc_list_w';
const LS_RAIL_LABELS = 'junshi_pc_rail_labels';

function lsGet(k: string): string {
  try { return window.localStorage.getItem(k) || ''; } catch { return ''; }
}
function lsSet(k: string, v: string): void {
  try { window.localStorage.setItem(k, v); } catch { /* 隐私模式写不进就算了 */ }
}

/** 解析 `#/think?view=assets&k=general` → { tab, query }。 */
function readRoute(): { tab: PcTab; query: URLSearchParams } {
  if (typeof window === 'undefined') return { tab: 'sessions', query: new URLSearchParams() };
  const hash = window.location.hash.replace(/^#\/?/, '');
  const i = hash.indexOf('?');
  const path = (i < 0 ? hash : hash.slice(0, i)).trim();
  const query = new URLSearchParams(i < 0 ? '' : hash.slice(i + 1));
  return { tab: (TABS.includes(path as PcTab) ? path : 'sessions') as PcTab, query };
}

function writeRoute(tab: PcTab, next: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  Object.entries(next).forEach(([k, v]) => { if (v) params.set(k, v); });
  const qs = params.toString();
  const url = `${window.location.pathname}${window.location.search}#/${tab}${qs ? `?${qs}` : ''}`;
  try { window.history.replaceState(null, '', url); } catch { /* 地址栏同步失败不影响使用 */ }
}

export function usePcState() {
  const route0 = readRoute();
  const q0 = route0.query;
  const tab0 = route0.tab;

  const [tab, setTabRaw] = useState<PcTab>(tab0);
  const [view, setViewRaw] = useState<string>(q0.get('view') || DEFAULT_VIEW[tab0]);
  // 当前选中的会话/军师 key（问策区）。空 = 用第一条。
  const [chatKey, setChatKeyRaw] = useState<string>(q0.get('k') || '');

  const [drawer, setDrawer] = useState<DrawerData | null>(null);
  const [ctx, setCtx] = useState<CtxData | null>(null);
  const [toast, setToastRaw] = useState('');

  const [listW, setListWRaw] = useState<number>(() => Number(lsGet(LS_LIST_W)) || 348);
  const [railLabels, setRailLabelsRaw] = useState<boolean>(() => lsGet(LS_RAIL_LABELS) !== '0');

  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => { writeRoute(tab, { view, k: chatKey }); }, [tab, view, chatKey]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // 地址栏被外部改写时（权益弹窗跳「主公」、用户手改 hash、前进后退）同步回状态。
  // 自己 writeRoute 用的是 replaceState，不触发 hashchange，不会和这里打架。
  useEffect(() => {
    const onHash = () => {
      const r = readRoute();
      setTabRaw(r.tab);
      setViewRaw(r.query.get('view') || DEFAULT_VIEW[r.tab]);
      setChatKeyRaw(r.query.get('k') || '');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const say = useCallback((t: string) => {
    setToastRaw(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastRaw(''), 2200);
  }, []);

  const go = useCallback((next: PcTab) => {
    setTabRaw(next);
    setViewRaw(DEFAULT_VIEW[next]);
    setDrawer(null);
    setCtx(null);
  }, []);

  const setView = useCallback((v: string) => { setViewRaw(v); setDrawer(null); }, []);
  const setChatKey = useCallback((k: string) => { setChatKeyRaw(k); setDrawer(null); }, []);

  const setListW = useCallback((w: number) => {
    const clamped = Math.max(280, Math.min(460, Math.round(w)));
    setListWRaw(clamped);
    lsSet(LS_LIST_W, String(clamped));
  }, []);

  const toggleRailLabels = useCallback(() => {
    setRailLabelsRaw((v) => { lsSet(LS_RAIL_LABELS, v ? '0' : '1'); return !v; });
  }, []);

  const openCtx = useCallback((e: { clientX: number; clientY: number; preventDefault: () => void }, label: string, items: CtxItem[]) => {
    e.preventDefault();
    // 靠近右/下边缘时回收，菜单不出屏（菜单约 200×(44+34n)）。
    const w = 200;
    const h = 48 + items.length * 36;
    const x = Math.min(e.clientX, window.innerWidth - w - 12);
    const y = Math.min(e.clientY, window.innerHeight - h - 12);
    setCtx({ x, y, label, items });
  }, []);

  const closeCtx = useCallback(() => setCtx(null), []);

  return {
    tab, view, chatKey,
    go, setView, setChatKey,
    drawer, setDrawer, closeDrawer: () => setDrawer(null),
    ctx, openCtx, closeCtx,
    toast, say,
    listW, setListW,
    railLabels, toggleRailLabels,
  };
}

export type PcState = ReturnType<typeof usePcState>;
