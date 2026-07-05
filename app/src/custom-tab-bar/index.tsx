import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Icon from '../components/Icon';
import { useStore } from '../hooks/useStore';
import { hideNativeTabBarOnly, onTabBarHiddenChange, readTabBarHidden, syncTabBarHidden } from '../services/tabbar';
import './index.scss';

// 悬浮胶囊式底栏 —— 五个平铺 tab，「问策」（参谋室，第一入口）居首，选中态为本命色柔底。
// 取名与图标对齐军师帐下议事的氛围：问策（对话）· 军情（战局）· 军令（执行）· 锦囊（智库）· 主公（我的）。
const TABS = [
  { path: '/pages/sessions/index', icon: 'fan', text: '问策' },
  { path: '/pages/home/index', icon: 'flag', text: '军情' },
  { path: '/pages/studio/index', icon: 'token', text: '军令' },
  { path: '/pages/thinktank/index', icon: 'pouch', text: '锦囊' },
  { path: '/pages/profile/index', icon: 'crown', text: '主公' },
];

export default function CustomTabBar() {
  const s = useStore();
  const selected = s.tab();
  const color = s.color();
  const accent = color.vars['--accent'];
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
            return (
              <View key={t.path} className={`tab ${active ? 'on' : ''}`} role="tab" aria-label={t.text} aria-selected={active} onClick={() => switchTo(i)}>
                <View className="tab-ic">
                  <Icon name={t.icon} size={22} color={active ? accent : '#969BA1'} />
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
