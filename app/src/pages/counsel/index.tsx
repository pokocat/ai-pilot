import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
// ChatView 先导入：其内部组件样式顺序（Icon→Login→…→SafeHeader）与 chat 页一致，避免 common chunk CSS order 冲突。
import ChatView from '../../components/ChatView';
import Icon from '../../components/Icon';
import SafeHeader from '../../components/SafeHeader';
import { useStore } from '../../hooks/useStore';
import './index.scss';

// 问策（tab0）—— 总军师对话本体，启动落地页，纯对话（军令/三势陈列在军情页）。
// 顶部页头：左「往来」入口（历史会话）· 标题「问策」。
// 内嵌共享 ChatView（general 线程，续接最近会话）。
// Login 弹层由 ChatView 承接（counsel 是唯一首登承接点）；onboarding 开关驱动入帐对话流 / 回帐一句。
export default function Counsel() {
  const s = useStore();

  useDidShow(() => {
    s.setTab(0);
    Taro.getCurrentInstance().page?.getTabBar?.();
  });

  const goSessions = () => Taro.navigateTo({ url: '/pages/sessions/index' });

  return (
    <View className={`page counsel ${s.themeClass()}`}>
      <SafeHeader
        className="counsel-head"
        rightReserve
        left={<View className="counsel-side" onClick={goSessions}><Icon name="chat" size={16} color="#565C63" /><Text>往来</Text></View>}
        title="问策"
        titleClassName="counsel-title"
      />

      {/* onboarding：未建档 → 入帐对话流（军师先开口、全程点选、收官出《初见断语》）；已建档 → 当日回帐一句 */}
      <ChatView
        agentKey="general"
        continueThread
        embedded
        onboarding
      />
    </View>
  );
}
