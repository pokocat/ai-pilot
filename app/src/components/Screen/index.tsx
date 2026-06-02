import { PropsWithChildren, useEffect, useState } from 'react';
import { View, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useStore } from '../../hooks/useStore';
import './index.scss';

interface ScreenProps {
  /** 是否为底栏 tab 页（留出悬浮底栏空间） */
  tab?: boolean;
  scroll?: boolean;
  /** 顶部让位系统状态栏 + 微信胶囊（自定义导航页用；首页/对话/库自管理，保持 false） */
  topInset?: boolean;
  className?: string;
}

/** 页面外壳：注入本命色主题类 + 暖底 + 可滚动区。 */
export default function Screen({ children, tab = true, scroll = true, topInset = false, className = '' }: PropsWithChildren<ScreenProps>) {
  const s = useStore();
  const [insetPx, setInsetPx] = useState<number>();

  useEffect(() => {
    if (!topInset) return;
    try {
      const r = Taro.getMenuButtonBoundingClientRect?.();
      if (r && r.bottom) setInsetPx(r.bottom + 8); // 内容落到胶囊之下
    } catch { /* H5 无胶囊，走 CSS 兜底 */ }
  }, [topInset]);

  const inset = topInset ? (
    <View className="nav-inset" style={insetPx ? { height: `${insetPx}px` } : undefined} />
  ) : null;

  if (!scroll) {
    return <View className={`page ${s.themeClass()} ${className}`}>{inset}{children}</View>;
  }
  return (
    <View className={`page ${s.themeClass()} ${className}`}>
      <ScrollView scrollY className="screen-scroll" enhanced showScrollbar={false}>
        {inset}
        {children}
        {tab && <View className="tabbar-space" />}
      </ScrollView>
    </View>
  );
}
