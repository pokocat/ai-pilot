import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useStore } from '../hooks/useStore';
import { hideNativeTabBarOnly, onTabBarHiddenChange, readTabBarHidden, syncTabBarHidden } from '../services/tabbar';
import './index.scss';

// 直角案卷底栏 —— 全宽、--surf 底、顶 hairline。5 平铺 tab：问策/军情/军令/锦囊/主公。
// 选中态：顶部 16px 短横 bar（--ac）+ 字加粗变本命色（对齐原型 navItems，无图标）。
// 锦囊 tab 保留朱砂点（store.satchelDot 驱动）。索引 0-4 与各 tab 页 useDidShow 的 setTab 同步。
const TABS = [
  { path: '/pages/counsel/index', text: '问策' },
  { path: '/pages/home/index', text: '军情' },
  { path: '/pages/junling/index', text: '军令' },
  { path: '/pages/satchel/index', text: '锦囊' },
  { path: '/pages/profile/index', text: '主公' },
];

export default function CustomTabBar() {
  const s = useStore();
  const selected = s.tab();
  const color = s.color();
  const accent = color.hex;
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

  // 有全屏弹层时隐藏底栏。登录弹层由目标页面承接（原生 tabbar 层会让组件样式失效）。
  if (s.overlay() || nativeHidden) return null;

  const switchTo = (i: number) => {
    if (i === selected) return;
    const prev = selected;
    s.setTab(i);
    hideNativeTabBarOnly();
    Taro.switchTab({
      url: TABS[i].path,
      success: () => hideNativeTabBarOnly(),
      fail: () => s.setTab(prev), // 跳转失败回滚高亮，避免底栏停在未生效的 tab
    });
  };

  return (
    <View className={`tabbar ${s.themeClass()}`}>
      <View className="tabbar-inner">
        {TABS.map((t, i) => {
          const active = i === selected;
          const showDot = t.path === '/pages/satchel/index' && satchelDot;
          return (
            <View key={t.path} className={`tab ${active ? 'on' : ''}`} role="tab" aria-label={t.text} aria-selected={active} onClick={() => switchTo(i)}>
              <View className="tab-bar" style={active ? { background: accent } : {}} />
              <View className="tab-labelwrap">
                <Text className="tab-label" style={active ? { color: accent } : {}}>
                  {t.text}
                </Text>
                {showDot ? <View className="tab-dot" /> : null}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}
