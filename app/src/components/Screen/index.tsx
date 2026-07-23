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
      if (!r?.bottom) return;
      // 内容落在胶囊「下方」（真机胶囊位置多变，落带内会与标题/按钮重叠——回归）；比原来 +8 收紧到 +2，标题区也压到 56。
      // 不再下发 --cap-right：头部在胶囊之下，右侧操作按钮无需避让，保持贴边（避免被推进标题区重叠）。
      setVars({ '--nav-inset-h': `${r.bottom + 2}px` } as CSSProperties);
    } catch { /* H5 无胶囊，走 CSS 兜底 */ }
  }, [topInset]);

  const inset = topInset ? <View className="nav-inset" /> : null;
  const rootStyle = topInset ? vars : undefined;

  if (!scroll) {
    return (
      <View className={`page ${s.themeClass()} ${className}`} style={rootStyle}>
        {inset}
        {children}
        {tab && <View className="tabbar-space" />}
      </View>
    );
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
