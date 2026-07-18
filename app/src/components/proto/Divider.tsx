import { CSSProperties } from 'react';
import { View } from '@tarojs/components';

// 大分区分隔 —— 居中一枚 accent 小菱 + 两侧渐隐细线（考究章节分隔，替代单薄 1px hairline）。
// weapp 支持 linear-gradient 背景。用法：<Divider />

interface DividerProps {
  color?: string;      // 菱色，默认本命色 --ac
  gap?: number;        // 上下外距 px，默认 22
  style?: CSSProperties;
}

export default function Divider({ color = 'var(--ac)', gap = 22, style }: DividerProps) {
  return (
    <View style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: `${gap}px 0`, ...style }}>
      <View style={{ flex: 1, height: '1px', background: 'linear-gradient(to right, transparent, var(--hair-2))' }} />
      <View style={{ width: '6px', height: '6px', background: color, transform: 'rotate(45deg)', flex: 'none' }} />
      <View style={{ flex: 1, height: '1px', background: 'linear-gradient(to left, transparent, var(--hair-2))' }} />
    </View>
  );
}
