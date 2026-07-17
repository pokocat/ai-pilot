import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Icon from '../components/Icon';
import { useStore } from '../hooks/useStore';
import { hideNativeTabBarOnly, onTabBarHiddenChange, readTabBarHidden, syncTabBarHidden } from '../services/tabbar';
import './index.scss';

// 悬浮胶囊式底栏 —— 四个平铺 tab：问策（对话本体，第一入口）· 军情（沙盘）· 锦囊（产出书架）· 主公（我的）。
// 锦囊可显示未读朱砂点（store.satchelDot 驱动，WO-A2 接数据）。
const TABS = [
  { path: '/pages/counsel/index', icon: 'hat', text: '问策' },
  { path: '/pages/home/index', icon: 'flag', text: '军情' },
  { path: '/pages/satchel/index', icon: 'pouch', text: '锦囊' },
  { path: '/pages/profile/index', icon: 'crown', text: '主公' },
];

export default function CustomTabBar() {
  const s = useStore();
  const selected = s.tab();
  const color = s.color();
  const accent = color.vars['--accent'];
  const satchelDot = s.satchelDot();
  const [nativeHidden, setNativeHidden] = useState(() => readTabBarHidden());

  const syncNativeState = () => {
    const hidden = readTabBarHidden();
    if (!s.overlay() && hidden) {
      syncTabBarHidden(false);
      setNativeHidden(false);
      return;
    }
    setNativeHidden(hidden);
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
            const showDot = t.path === '/pages/satchel/index' && satchelDot;
            return (
              <View key={t.path} className={`tab ${active ? 'on' : ''}`} role="tab" aria-label={t.text} aria-selected={active} onClick={() => switchTo(i)}>
                <View className="tab-ic">
                  <Icon name={t.icon} size={22} color={active ? accent : '#969BA1'} />
                  {showDot ? <View className="tab-dot" /> : null}
                </View>
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
