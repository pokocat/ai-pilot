import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Sheet from '../Sheet';
import { useStore } from '../../hooks/useStore';
import { getToken } from '../../services/token';
import './index.scss';

export interface OnboardSheetProps {
  open: boolean;
  onClose?: () => void;
  onStart?: () => void;
}

// 首登引导「只弹一次」标记，按账号 token 隔离（未登录回落 anon）。
const ONBOARD_KEY_PREFIX = 'junshi.onboard.v7.';
function onboardKey(): string { return ONBOARD_KEY_PREFIX + (getToken() || 'anon'); }

// 是否应展示首登引导（页面在建档后据此决定是否 open）。
export function shouldShowOnboard(): boolean {
  try { return Taro.getStorageSync(onboardKey()) !== '1'; } catch { return true; }
}
// 标记已看过，后续不再自动弹。
export function markOnboardShown(): void {
  try { Taro.setStorageSync(onboardKey(), '1'); } catch { /* noop */ }
}

interface Step { t: string; d: string; }
// 设计规格 §1：4 步引导，文案逐字。
const STEPS: Step[] = [
  { t: '建立当前案卷', d: '先用对话说清目标、现状和卡点' },
  { t: '上传杂乱资料', d: '聊天、表格、截图先进入待整理区' },
  { t: '查看战局判断', d: '确认主要矛盾和下一步动作' },
  { t: '生成军令复盘', d: '执行页承接任务，晚上回填数据' },
];

// V7-03 OnboardSheet：首登建档后的 4 步引导。「开始上传资料」→ onStart（调用方 switchTab 智库 + 开上传）。
export default function OnboardSheet({ open, onClose, onStart }: OnboardSheetProps) {
  const s = useStore();
  const accent = s.color().vars['--accent'];

  // 遮罩点击 = 稍后再看（含「置已看」副作用），经 Sheet 的 onMaskClose 表达。
  const later = () => { markOnboardShown(); onClose?.(); };
  const start = () => { markOnboardShown(); onStart?.(); };

  return (
    <Sheet
      visible={open}
      overlayKey="onboard"
      onMaskClose={later}
      maxHeight="88vh"
      footer={
        <View className="onboard-actions">
          <View className="btn btn-ghost onboard-later" onClick={later}><Text>稍后再看</Text></View>
          <View className="btn btn-primary onboard-start" style={{ background: accent }} onClick={start}><Text>开始上传资料</Text></View>
        </View>
      }
    >
      <Text className="onboard-k">FIRST RUN</Text>
      <Text className="onboard-title serif">先把案卷跑通，再让军师开工</Text>
      <Text className="onboard-desc">第一次用不用理解所有模块。按这 4 步走，系统会把资料、判断、军令和复盘串起来。</Text>

      <View className="onboard-steps">
        {STEPS.map((st, i) => (
          <View key={st.t} className="onboard-step">
            <Text className="ob-num">{i + 1}</Text>
            <View className="ob-body">
              <Text className="ob-t">{st.t}</Text>
              <Text className="ob-d">{st.d}</Text>
            </View>
          </View>
        ))}
      </View>
    </Sheet>
  );
}
