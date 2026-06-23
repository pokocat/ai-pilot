import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Icon from '../components/Icon';
import { useStore } from '../hooks/useStore';
import { hideNativeTabBarOnly, onTabBarHiddenChange, readTabBarHidden } from '../services/tabbar';
import './index.scss';

// 悬浮胶囊式底栏 —— 对齐原型：脱离底边的圆角悬浮条 + 中间「对话」柔色圆形高亮。
const TABS = [
  { path: '/pages/home/index', icon: 'home', text: '首页' },
  { path: '/pages/thinktank/index', icon: 'grid', text: '智库' },
  { path: '/pages/sessions/index', icon: 'chat', text: '对话', center: true },
  { path: '/pages/studio/index', icon: 'agent', text: '智能体' },
  { path: '/pages/profile/index', icon: 'user', text: '我的' },
];

export default function CustomTabBar() {
  const s = useStore();
  const selected = s.tab();
  const color = s.color();
  const accent = color.vars['--accent'];
  const [nativeHidden, setNativeHidden] = useState(() => readTabBarHidden());

  const syncNativeState = () => {
    setNativeHidden(readTabBarHidden());
    hideNativeTabBarOnly();
  };

  useDidShow(syncNativeState);

  useEffect(() => {
    syncNativeState();
    const off = onTabBarHiddenChange(setNativeHidden);
    return off;
  }, []);

  // 有全屏弹层时隐藏底栏。不要在 custom-tab-bar 内渲染登录弹层，
  // 小程序原生 tabbar 层会让组件样式失效，登录由目标页面承接。
  if (s.overlay() || nativeHidden) return null;

  const switchTo = (i: number) => {
    // 中间「对话」= 直接开新会话（参考主流 AI 应用），历史列表在对话页顶部「历史」入口
    if (i === 2) {
      if (!s.isAuthed()) {
        Taro.showToast({ title: '请先登录后再开始对话', icon: 'none' });
        Taro.navigateTo({ url: '/pages/chat/index?fresh=1' });
        return;
      }
      Taro.navigateTo({ url: '/pages/chat/index?fresh=1' });
      return;
    }
    if (i === selected) return;
    s.setTab(i);
    hideNativeTabBarOnly();
    Taro.switchTab({
      url: TABS[i].path,
      success: () => hideNativeTabBarOnly(),
    });
  };

  return (
    <>
      <View className={`tabbar ${s.themeClass()}`}>
        <View className="tabbar-inner">
          {TABS.map((t, i) => {
            const active = i === selected;
            if (t.center) {
              return (
                <View key={t.path} className="tab tab-center" role="tab" aria-label={t.text} onClick={() => switchTo(i)}>
                  <View className="center-btn" style={{ background: accent }}>
                    <Icon name="chat" size={22} color="#FBFAF6" />
                  </View>
                  <Text className="tab-label center-label">{t.text}</Text>
                </View>
              );
            }
            return (
              <View key={t.path} className={`tab ${active ? 'on' : ''}`} role="tab" aria-label={t.text} aria-selected={active} onClick={() => switchTo(i)}>
                <Icon name={t.icon} size={21} color={active ? accent : '#969BA1'} />
                <Text className="tab-label" style={active ? { color: accent } : {}}>
                  {t.text}
                </Text>
              </View>
            );
          })}
        </View>
      </View>
    </>
  );
}
