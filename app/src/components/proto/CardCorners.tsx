import { View } from '@tarojs/components';

// 案卷装订角 —— 重点卡四角加「L 形角线」（2px 本命色短角线，绝对定位）。低成本、高 character。
// 用四个带 border 的空 View 画 L 角（weapp 对 border 稳，避免 ::before/::after 在小程序不可靠）。
// 父卡须 position:relative（proto-card 已是）。用法：<CardCorners />

interface CardCornersProps {
  color?: string;  // 角线色，默认本命色 --ac
  size?: number;   // 角线臂长 px，默认 12
  inset?: number;  // 距卡边 px，默认 6
  arm?: number;    // 线宽 px，默认 2（直角案卷线宽）
}

export default function CardCorners({ color = 'var(--ac)', size = 12, inset = 6, arm = 2 }: CardCornersProps) {
  const s = `${size}px`;
  const i = `${inset}px`;
  const b = `${arm}px solid ${color}`;
  const base = { position: 'absolute' as const, width: s, height: s, pointerEvents: 'none' as const };
  return (
    <View>
      <View style={{ ...base, top: i, left: i, borderTop: b, borderLeft: b }} />
      <View style={{ ...base, top: i, right: i, borderTop: b, borderRight: b }} />
      <View style={{ ...base, bottom: i, left: i, borderBottom: b, borderLeft: b }} />
      <View style={{ ...base, bottom: i, right: i, borderBottom: b, borderRight: b }} />
    </View>
  );
}
