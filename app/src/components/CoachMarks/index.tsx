import { useEffect, useRef, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { switchTo } from '../../services/nav';
import { store } from '../../services/store';
import { getToken } from '../../services/token';
import './index.scss';

// 功能点亮 · 五步 coach marks（原型交互）：入局后首次进入依次点亮五个 tab，
// 每步覆盖层落底、▾ 指向底栏，「下一步」切到对应 tab 实景演示。
// 取代旧 4 步 OnboardSheet（V7-03）；进度落 storage，中途退出下次续走。
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

export default function CoachMarks() {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const syncedRef = useRef(false); // 激活时只纠一次偏（当前页 ≠ 当前步的 tab）

  const refresh = () => {
    if (!store.isAuthed() || !store.isOnboarded() || !coachPending()) { setActive(false); return; }
    setStep(loadStep());
    setActive(true);
  };
  useEffect(refresh, []);
  useDidShow(refresh);

  // 激活即校准 tab：coach 的每一步都应演示对应 tab 的实景（原型行为）。
  useEffect(() => {
    if (!active || syncedRef.current) return;
    syncedRef.current = true;
    const pages = (Taro.getCurrentPages?.() || []) as { route?: string }[];
    const cur = pages[pages.length - 1]?.route || '';
    const want = STEPS[step].route;
    if (cur && !want.includes(cur)) switchTo(want);
  }, [active, step]);

  if (!active) return null;

  const last = step >= STEPS.length - 1;
  const next = () => {
    if (last) { markCoachDone(); setActive(false); return; }
    const ns = step + 1;
    try { Taro.setStorageSync(stepKey(), String(ns)); } catch { /* noop */ }
    setStep(ns);
    switchTo(STEPS[ns].route);
  };
  const skip = () => { markCoachDone(); setActive(false); };

  return (
    <View className="coach" catchMove>
      <View className="coach-panel">
        <View className="cp-head">
          <View className="cp-lead">
            <View className="cp-seal"><Text className="serif">师</Text></View>
            <Text className="cp-kicker">功能点亮 · {CN[step]} / 五</Text>
          </View>
          <Text className="cp-skip" onClick={skip}>跳过</Text>
        </View>
        <Text className="cp-title serif">{STEPS[step].title}</Text>
        <Text className="cp-text">{STEPS[step].text}</Text>
        <View className="cp-btn serif" onClick={next}>
          <Text>{last ? '开 始 使 用' : '下 一 步'}</Text>
        </View>
      </View>
      <Text className="coach-arrow">▾</Text>
    </View>
  );
}
