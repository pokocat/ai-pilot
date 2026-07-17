import { CSSProperties } from 'react';
import { View, Text } from '@tarojs/components';

// 水印巨字 —— 页头/卡片右侧的单字大水印（font-weight:900 是全站唯一装饰例外）。
// 对齐原型 header 的 {{tabWatermark}} / 军情「势」水印。绝对定位、不可点选。
// 也可直接用 .proto-watermark 样式类（见 app.scss）。

interface WatermarkProps {
  char: string;
  size?: number;      // 字号 px，默认 130（页头）；卡片内常用 88
  opacity?: number;   // 默认 .06（页头）；卡片内常用 .1
  top?: number | string;
  right?: number | string;
  left?: number | string;
  bottom?: number | string;
  color?: string;     // 默认 var(--ac)
  style?: CSSProperties;
}

export default function Watermark({
  char, size = 130, opacity = 0.06, top, right, left, bottom, color = 'var(--ac)', style,
}: WatermarkProps) {
  const pos = (v?: number | string) => (typeof v === 'number' ? `${v}px` : v);
  return (
    <View
      className="proto-watermark"
      style={{
        top: pos(top), right: pos(right), left: pos(left), bottom: pos(bottom),
        ...style,
      }}
    >
      <Text style={{ fontFamily: 'var(--serif)', fontWeight: 900, fontSize: `${size}px`, lineHeight: 1, color, opacity }}>
        {char}
      </Text>
    </View>
  );
}
