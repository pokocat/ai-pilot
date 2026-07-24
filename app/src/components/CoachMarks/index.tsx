import { useEffect, useReducer, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { switchTo } from '../../services/nav';
import { store } from '../../services/store';
import { getToken } from '../../services/token';
import './index.scss';

// 功能点亮 · 五步 coach marks（原型交互）：入局后依次点亮五个 tab，
// 覆盖层落底、▾ 指向当前 tab，「下一步」切到对应 tab 实景演示。
// 取代旧 4 步 OnboardSheet（V7-03）；进度落 storage，中途退出下次续走。
//
// 状态用「模块级单一状态源 + 订阅」而非各页各自 useState：五个 tab 页各挂一个实例，
// 若各自持有 active，则某页点「完成」只关掉本页，切到别的 tab 会先用旧 active=true
// 抢渲染一帧再被 useDidShow 关掉 → 表现为「完成后切 tab 又闪一下引导卡」。改为共享状态后，
// 任一实例置完成 → 广播 → 所有实例同步渲染为空，杜绝闪现。
const KEY_PREFIX = 'junshi.coach.v1.';
const doneKey = () => `${KEY_PREFIX}${getToken() || 'anon'}`;
const stepKey = () => `${KEY_PREFIX}step.${getToken() || 'anon'}`;

const STEPS = [
  { route: '/pages/sessions/index', title: '问策 · 有事问军师', text: '总军师置顶统筹，专业军师分线出策，结论汇回主线。像发微信一样，直接说你的问题。' },
  { route: '/pages/home/index', title: '军情 · 每天的判断', text: '今天的主要矛盾、下一步就做、现在别做，一屏讲清——先判断，再行动。' },
  { route: '/pages/studio/index', title: '军令 · 把话变成事', text: '判断拆成今日任务：做完打卡、回填战果，军师据此修正下一轮判断。' },
  { route: '/pages/thinktank/index', title: '锦囊 · 越攒越值钱', text: '资料、方法、历次方案都留档在这，方案从 v1 长到 v7，是你的家底。' },
  { route: '/pages/profile/index', title: '老板 · 你自己', text: '档案、算力、本命色都在这里打理。往后有事，随时唤军师。' },
] as const;
const CN = ['一', '二', '三', '四', '五'];

/** 本账号是否还欠这轮功能点亮（onboarding 出口据此决定落到哪个 tab）。 */
export function coachPending(): boolean {
  try { return Taro.getStorageSync(doneKey()) !== '1'; } catch { return false; }
}
function markCoachDone(): void {
  try { Taro.setStorageSync(doneKey(), '1'); } catch { /* noop */ }
  try { Taro.removeStorageSync(stepKey()); } catch { /* noop */ }
}
function loadStep(): number {
  try {
    const v = Number(Taro.getStorageSync(stepKey()));
    return Number.isFinite(v) && v >= 0 && v < STEPS.length ? v : 0;
  } catch { return 0; }
}
function saveStep(n: number): void {
  try { Taro.setStorageSync(stepKey(), String(n)); } catch { /* noop */ }
}

// 当前小程序页面路由（同 services/store.ts 的 currentRoute 口径，本文件独立小份复用不值得跨模块导出）。
function currentRoute(): string {
  try {
    const getPages = (globalThis as typeof globalThis & { getCurrentPages?: () => { route?: string }[] }).getCurrentPages;
    const pages = getPages?.() ?? [];
    return pages[pages.length - 1]?.route || '';
  } catch { return ''; }
}
// 当前页面对应的引导步骤（找不到 → -1，如非五个 tab 页之一）。
function stepForRoute(route: string): number {
  if (!route) return -1;
  const normalized = route.startsWith('/') ? route : `/${route}`;
  return STEPS.findIndex((s) => s.route === normalized);
}

// —— 模块级共享状态 + 订阅 —— //
const shared = { active: false, step: 0 };
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

// 依据登录/建档态与 storage 重新裁定是否展示（各实例 mount 与 onShow 时调用）。
function evaluate(): void {
  const active = store.isAuthed() && store.isOnboarded() && coachPending();
  shared.active = active;
  if (active) {
    const persisted = loadStep();
    const onScreen = stepForRoute(currentRoute());
    // 用户可能不点「下一步」而是直接点底栏切到某个 tab（CustomTabBar.switchTo 对引导态没有拦截，
    // 属有意保留——底栏必须可点透才能让箭头指向真实底栏）；此时以「当前实际停留的 tab」为准重新
    // 裁定要展示的步骤并回写存储，避免引导卡文案/箭头指向与用户实际所在页错位（2026-07-23 例行 QA）。
    const step = onScreen >= 0 ? onScreen : persisted;
    if (step !== persisted) saveStep(step);
    shared.step = step;
  }
  notify();
}
function advance(): void {
  if (shared.step >= STEPS.length - 1) { markCoachDone(); shared.active = false; notify(); return; }
  const ns = shared.step + 1;
  saveStep(ns);
  shared.step = ns;
  // 先切到目标 tab（其 onShow→evaluate 会以新 step 实景渲染）；本页随即被隐藏，不广播避免旧页闪现新步文案。
  switchTo(STEPS[ns].route);
}
function finish(): void { markCoachDone(); shared.active = false; notify(); }

export default function CoachMarks() {
  const [, force] = useReducer((c: number) => c + 1, 0);
  const [winW, setWinW] = useState(375);

  useEffect(() => {
    listeners.add(force);
    try { setWinW(Taro.getWindowInfo().windowWidth || 375); } catch { /* H5 兜底 375 */ }
    evaluate();
    return () => { listeners.delete(force); };
  }, []);
  useDidShow(() => { evaluate(); });

  if (!shared.active) return null;
  const step = shared.step;
  const last = step >= STEPS.length - 1;

  // 箭头对准当前 tab 中心：悬浮底栏 margin 14 + 内边距 12，内容区 5 等分（见 custom-tab-bar/index.scss）。
  const arrowLeft = 26 + ((winW - 52) / 5) * (step + 0.5);

  return (
    <View className="coach" catchMove>
      <View className="coach-panel">
        <View className="cp-head">
          <View className="cp-lead">
            <View className="cp-seal"><Text className="serif">师</Text></View>
            <Text className="cp-kicker">功能点亮 · {CN[step]} / 五</Text>
          </View>
          <Text className="cp-skip" onClick={finish}>跳过</Text>
        </View>
        <Text className="cp-title serif">{STEPS[step].title}</Text>
        <Text className="cp-text">{STEPS[step].text}</Text>
        <View className="cp-btn serif" onClick={advance}>
          <Text>{last ? '开 始 使 用' : '下 一 步'}</Text>
        </View>
      </View>
      <View className="coach-arrow" style={{ left: `${arrowLeft}px` }} />
    </View>
  );
}
