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

const KB_GAP = 16; // 输入框露出键盘后再留一点呼吸位

/** 页面外壳：注入本命色主题类 + 暖底 + 可滚动区（键盘避让：按需最小滚动，不顶到顶部）。 */
export default function Screen({ children, tab = true, scroll = true, topInset = false, className = '' }: PropsWithChildren<ScreenProps>) {
  const s = useStore();
  const [vars, setVars] = useState<CSSProperties>();
  // 键盘避让：满屏 ScrollView 下 weapp 的 adjustPosition 失效（无处上推），改手动最小滚动——
  // 量出聚焦输入框被键盘遮住多少，只把 ScrollView 往下滚那么多（scrollIntoView 会对齐顶部→顶过头，弃用）。
  const [kbH, setKbH] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const kbHRef = useRef(0);
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

  // 量出锚点输入框底边被键盘遮住多少，只滚那么多（已可见则不滚）。延时让键盘/布局落定后再量。
  const ensureAnchorVisible = (anchorId: string) => {
    setTimeout(() => {
      const kb = kbHRef.current;
      if (!kb || anchorRef.current !== anchorId) return;
      Taro.createSelectorQuery()
        .select(`#${anchorId}`).boundingClientRect()
        .select('#screen-scroll').boundingClientRect()
        .select('#screen-scroll').scrollOffset()
        .exec((res: unknown[]) => {
          const el = res?.[0] as { bottom?: number } | null;
          const sv = res?.[1] as { bottom?: number } | null;
          const off = res?.[2] as { scrollTop?: number } | null;
          if (!el || !sv || !off) return;
          // ScrollView 占满屏（rect.bottom = 视口底），键盘遮住底部 kb → 可视底边 = sv.bottom - kb - 留白
          const visibleBottom = Number(sv.bottom || 0) - kb - KB_GAP;
          const overflow = Number(el.bottom || 0) - visibleBottom;
          if (overflow <= 0) return; // 输入框本就在键盘上方，不滚（也就不会顶过头）
          const next = Math.round(Number(off.scrollTop || 0) + overflow);
          // Taro 受控 scrollTop 同值不触发：与当前相等时 +0.5px 扰动强制生效
          setScrollTop((prev) => (next === prev ? next + 0.5 : next));
        });
    }, 40);
  };

  useEffect(() => {
    if (!scroll) return;
    const on = (r: { height: number }) => {
      kbHRef.current = r.height;
      setKbH(r.height);
      if (r.height > 0) { if (anchorRef.current) ensureAnchorVisible(anchorRef.current); }
      else { anchorRef.current = ''; } // 收键盘：不回滚，停在原处
    };
    Taro.onKeyboardHeightChange(on);
    return () => Taro.offKeyboardHeightChange(on);
  }, [scroll]);

  // 输入框聚焦上报锚点：若键盘已弹起（切换输入框，高度不变无 height 事件）立刻量一次；否则等 height 事件触发。
  const ensureVisible = (anchorId: string) => {
    anchorRef.current = anchorId;
    if (kbHRef.current > 0) ensureAnchorVisible(anchorId);
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
          id="screen-scroll"
          className="screen-scroll"
          enhanced
          showScrollbar={false}
          scrollTop={scrollTop}
          scrollWithAnimation
        >
          {inset}
          {children}
          {tab && <View className="tabbar-space" />}
          {/* 键盘弹起时垫底，给最底部输入框留出可上滚的空间 */}
          {kbH ? <View style={{ height: `${kbH}px` }} /> : null}
        </ScrollView>
      </View>
    </ScreenKbCtx.Provider>
  );
}
