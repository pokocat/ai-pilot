import { View, Text } from '@tarojs/components';

// 钤印 —— 关键产出卡右下角盖一枚本命色实心方印（含单字，如 断/策/军/师）。
// 轻转 -4deg，作「落章」，是全站考究记忆点。父卡须 position:relative（proto-card 已是）。
// 用法：<CardSeal char="断" />  /  <CardSeal char="策" size={24} />

interface CardSealProps {
  char: string;
  size?: number;      // 方印边长 px，默认 24（单字可读又不喧宾夺主）
  color?: string;     // 印底色，默认本命色 --ac
  right?: number;     // 右下定位（px）
  bottom?: number;
}

export default function CardSeal({ char, size = 24, color = 'var(--ac)', right = 16, bottom = 16 }: CardSealProps) {
  return (
    <View
      className="card-seal"
      style={{ width: `${size}px`, height: `${size}px`, background: color, right: `${right}px`, bottom: `${bottom}px` }}
    >
      <Text style={{ fontFamily: 'var(--serif)', fontWeight: 600, fontSize: `${Math.round(size * 0.52)}px`, color: 'var(--onac)', lineHeight: 1 }}>
        {char}
      </Text>
    </View>
  );
}
