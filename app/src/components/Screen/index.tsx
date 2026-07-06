import { CSSProperties, PropsWithChildren, useEffect, useState } from 'react';
import { View, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useStore } from '../../hooks/useStore';
import './index.scss';

interface ScreenProps {
  /** 是否为底栏 tab 页（留出悬浮底栏空间） */
  tab?: boolean;
  scroll?: boolean;
  /** Tab 页顶部让位系统状态栏 + 微信胶囊；非 Tab 自定义头使用 SafeHeader。 */
  topInset?: boolean;
  className?: string;
}

/** 页面外壳：注入本命色主题类 + 暖底 + 可滚动区。 */
export default function Screen({ children, tab = true, scroll = true, topInset = false, className = '' }: PropsWithChildren<ScreenProps>) {
  const s = useStore();
  const [vars, setVars] = useState<CSSProperties>();

  useEffect(() => {
    if (!topInset) return;
    try {
      const r = Taro.getMenuButtonBoundingClientRect?.();
      const sys = Taro.getSystemInfoSync?.();
      if (!r?.top || !sys?.windowWidth) return;
      // 头部上移进胶囊带：内容顶到胶囊「顶」（原来顶到胶囊「底」浪费一整行），右侧留出胶囊宽度让操作按钮避让。
      const top = Math.max(r.top, (sys.statusBarHeight || 0) + 4);
      const capRight = Math.max(sys.windowWidth - r.left + 8, 16);
      setVars({ '--nav-inset-h': `${top}px`, '--cap-right': `${capRight}px` } as CSSProperties);
    } catch { /* H5 无胶囊，走 CSS 兜底 */ }
  }, [topInset]);

  const inset = topInset ? <View className="nav-inset" /> : null;
  const rootStyle = topInset ? vars : undefined;

  if (!scroll) {
    return <View className={`page ${s.themeClass()} ${className}`} style={rootStyle}>{inset}{children}</View>;
  }
  return (
    <View className={`page ${s.themeClass()} ${className}`} style={rootStyle}>
      <ScrollView scrollY className="screen-scroll" enhanced showScrollbar={false}>
        {inset}
        {children}
        {tab && <View className="tabbar-space" />}
      </ScrollView>
    </View>
  );
}
