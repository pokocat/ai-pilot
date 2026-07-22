import { CSSProperties, PropsWithChildren, useEffect, useRef, useState } from 'react';
import { View, ScrollView } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { useStore } from '../../hooks/useStore';
import { ScreenKbCtx } from './keyboard';
import './index.scss';

interface ScreenProps {
  /** 是否为底栏 tab 页（留出悬浮底栏空间） */
  tab?: boolean;
  scroll?: boolean;
  /** Tab 页顶部让位系统状态栏 + 微信胶囊；非 Tab 自定义头使用 SafeHeader。 */
  topInset?: boolean;
  className?: string;
}

/** 页面外壳：注入本命色主题类 + 暖底 + 可滚动区（键盘避让：收缩滚动区 + 聚焦输入滚入可视）。 */
export default function Screen({ children, tab = true, scroll = true, topInset = false, className = '' }: PropsWithChildren<ScreenProps>) {
  const s = useStore();
  const [vars, setVars] = useState<CSSProperties>();
  // 键盘避让：kbH=键盘高度，kbAnchor=当前聚焦输入的锚点 id（scrollIntoView 目标）。
  // kbActive=当前聚焦的是 KbInput（才收缩滚动区）——固定浮层里的原生 Input 自管避让，不触发收缩，避免双重补偿。
  const [kbH, setKbH] = useState(0);
  const [kbAnchor, setKbAnchor] = useState('');
  const [kbActive, setKbActive] = useState(false);
  const anchorRef = useRef('');

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

  // 键盘高度变化：收缩滚动区；若已有聚焦锚点，键盘落定后再滚一次（此时才知道真正可视高度）。
  useEffect(() => {
    if (!scroll) return;
    const on = (r: { height: number }) => {
      setKbH(r.height);
      if (r.height > 0 && anchorRef.current) reScroll(anchorRef.current);
      else if (r.height === 0) { anchorRef.current = ''; setKbAnchor(''); setKbActive(false); }
    };
    Taro.onKeyboardHeightChange(on);
    return () => Taro.offKeyboardHeightChange(on);
  }, [scroll]);

  // scrollIntoView 对相同目标不重复触发：先清空再于下一拍设值，强制生效。
  const reScroll = (id: string) => {
    setKbAnchor('');
    setTimeout(() => setKbAnchor(id), 30);
  };
  const ensureVisible = (anchorId: string) => {
    anchorRef.current = anchorId;
    setKbActive(true);
    reScroll(anchorId);
  };

  const inset = topInset ? <View className="nav-inset" /> : null;
  const rootStyle = topInset ? vars : undefined;

  if (!scroll) {
    return (
      <ScreenKbCtx.Provider value={ensureVisible}>
        <View className={`page ${s.themeClass()} ${className}`} style={rootStyle}>{inset}{children}</View>
      </ScreenKbCtx.Provider>
    );
  }
  return (
    <ScreenKbCtx.Provider value={ensureVisible}>
      <View className={`page ${s.themeClass()} ${className}`} style={rootStyle}>
        <ScrollView
          scrollY
          className="screen-scroll"
          enhanced
          showScrollbar={false}
          scrollIntoView={kbAnchor || undefined}
          scrollWithAnimation
          style={kbActive && kbH ? { height: `calc(100vh - ${kbH}px)` } : undefined}
        >
          {inset}
          {children}
          {tab && <View className="tabbar-space" />}
        </ScrollView>
      </View>
    </ScreenKbCtx.Provider>
  );
}
