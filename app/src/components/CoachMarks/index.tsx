import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import { useStore } from '../../hooks/useStore';
import './index.scss';

// 功能点亮导览（原型 COACH 五段）—— 进 App 后首次覆盖在 tab 上的引导层。
// 五步各点亮一个 tab（问策/军情/军令/锦囊/主公）；跳过即止；本地记 flag（由宿主控制显隐）。
const COACH = [
  { tab: '问策', title: '问策 · 有事问军师', text: '总军师置顶统筹，专业军师分线出主意，结论汇回主线。像用微信一样，直接说你的问题。' },
  { tab: '军情', title: '军情 · 每天的判断', text: '今天的主要矛盾、下一步该做什么、现在不能做什么，一屏讲清——先判断，再行动。' },
  { tab: '军令', title: '军令 · 把话变成事', text: '判断拆成任务卡：谁做、几点前、多久。做完打卡、回填数据，形成闭环。' },
  { tab: '锦囊', title: '锦囊 · 越攒越值钱', text: '资料、方法、历次方案都在这。方案从 v1 长到 v7，全部留档，是你的资产。' },
  { tab: '主公', title: '主公 · 你自己', text: '档案、算力、本命色都在这——还藏着送你一卦、天时日历、天机记账几个彩蛋。' },
];
const CN = ['一', '二', '三', '四', '五'];
const TABS = ['问策', '军情', '军令', '锦囊', '主公'];

interface Props {
  active: boolean;
  onClose: () => void;
}

export default function CoachMarks({ active, onClose }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [step, setStep] = useState(0);
  if (!active) return null;

  const c = COACH[step];
  const last = step >= COACH.length - 1;
  const next = () => { if (last) onClose(); else setStep((n) => n + 1); };

  return (
    <View className="coach">
      <View className="coach-card proto-card proto-card--top ink-in" style={{ borderTopColor: accent }}>
        <View className="coach-head">
          <View className="coach-badge">
            <View className="coach-avatar" style={{ background: accent }}><Text className="serif">师</Text></View>
            <Text className="coach-count" style={{ color: accent }}>功能点亮 · {CN[step]} / 五</Text>
          </View>
          <Text className="coach-skip" onClick={onClose}>跳过</Text>
        </View>
        <Text className="coach-title">{c.title}</Text>
        <Text className="coach-text">{c.text}</Text>
        <View className="coach-btn proto-btn" style={{ background: accent }} onClick={next}>
          <Text>{last ? '开始使用' : '下一步'}</Text>
        </View>
      </View>
      {/* 底部 5-tab 高亮：点亮当前 coach 对应的 tab */}
      <View className="coach-nav">
        {TABS.map((t) => {
          const on = t === c.tab;
          return (
            <View key={t} className="coach-nav-item">
              <View className="coach-nav-bar" style={{ background: on ? accent : 'transparent' }} />
              <Text className="coach-nav-label" style={{ color: on ? accent : 'var(--faint)', fontWeight: on ? 600 : 400 }}>{t}</Text>
            </View>
          );
        })}
      </View>
      <Text className="coach-arrow" style={{ color: accent }}>▾</Text>
    </View>
  );
}
