import { PropsWithChildren } from 'react';
import { View, ScrollView } from '@tarojs/components';
import { useStore } from '../../hooks/useStore';
import './index.scss';

interface ScreenProps {
  /** 是否为底栏 tab 页（留出悬浮底栏空间） */
  tab?: boolean;
  scroll?: boolean;
  className?: string;
}

/** 页面外壳：注入本命色主题类 + 暖底 + 可滚动区。 */
export default function Screen({ children, tab = true, scroll = true, className = '' }: PropsWithChildren<ScreenProps>) {
  const s = useStore();
  if (!scroll) {
    return <View className={`page ${s.themeClass()} ${className}`}>{children}</View>;
  }
  return (
    <View className={`page ${s.themeClass()} ${className}`}>
      <ScrollView scrollY className="screen-scroll" enhanced showScrollbar={false}>
        {children}
        {tab && <View className="tabbar-space" />}
      </ScrollView>
    </View>
  );
}
