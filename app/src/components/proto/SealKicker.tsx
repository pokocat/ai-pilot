import { CSSProperties } from 'react';
import { View, Text } from '@tarojs/components';

// 题眉印记 —— kicker 前压一枚实心本命色小方印（落章感），替代裸露的题眉小字。
// 用显式元素而非 ::before（小程序伪元素不稳）。用法：<SealKicker text="方 案 版 本" />

interface SealKickerProps {
  text: string;
  color?: string;     // 方印色，默认本命色 --ac
  tone?: string;      // 题眉字色，默认 --faint
  spacing?: string;   // 字距，默认 .24em
  markSize?: number;  // 方印边长 px，默认 7
  style?: CSSProperties;
}

export default function SealKicker({
  text, color = 'var(--ac)', tone = 'var(--faint)', spacing = '.24em', markSize = 7, style,
}: SealKickerProps) {
  return (
    <View className="seal-kicker" style={{ display: 'flex', alignItems: 'center', gap: '9px', ...style }}>
      <View style={{ width: `${markSize}px`, height: `${markSize}px`, background: color, flex: 'none' }} />
      <Text style={{ fontFamily: 'var(--serif)', fontSize: '12px', letterSpacing: spacing, color: tone }}>{text}</Text>
    </View>
  );
}
