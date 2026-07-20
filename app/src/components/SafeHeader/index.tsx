import { CSSProperties, ReactNode, useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import './index.scss';

type SafeStyle = CSSProperties & {
  '--safe-head-top'?: string;
  '--safe-head-right'?: string;
  '--safe-head-min'?: string;
};

interface Props {
  title?: string;
  subtitle?: string;
  left?: ReactNode;
  right?: ReactNode;
  rightReserve?: boolean;
  className?: string;
  titleClassName?: string;
  onBack?: () => void;
  children?: ReactNode;
}

export default function SafeHeader({
  title,
  subtitle,
  left,
  right,
  rightReserve = true,
  className = '',
  titleClassName = '',
  onBack,
  children,
}: Props) {
  const [style, setStyle] = useState<SafeStyle>();

  useEffect(() => {
    try {
      const rect = Taro.getMenuButtonBoundingClientRect?.();
      const sys = Taro.getWindowInfo?.();
      if (!rect?.bottom || !sys?.windowWidth) return;
      const top = Math.max(rect.top || 0, (sys.statusBarHeight || 0) + 6);
      const rightInset = Math.max(sys.windowWidth - rect.left + 12, 16);
      setStyle({
        '--safe-head-top': `${top}px`,
        '--safe-head-right': `${rightInset}px`,
        '--safe-head-min': `${Math.max(rect.height || 32, 36)}px`,
      });
    } catch {
      // H5 and older base libraries use CSS safe-area fallback.
    }
  }, []);

  const fallbackBack = (
    // P2-17：图标型返回按钮补可访问性语义（H5 屏读可读；weapp 忽略未知属性，无副作用）。
    <View className="safe-hbtn" role="button" aria-label="返回" onClick={onBack ?? (() => Taro.navigateBack())}>
      <Text className="safe-back">‹</Text>
    </View>
  );

  const body = children ?? (
    <View className="safe-title-wrap">
      <Text className={`safe-title serif ${titleClassName}`}>{title}</Text>
      {subtitle ? <Text className="safe-subtitle">{subtitle}</Text> : null}
    </View>
  );

  return (
    <View className={`safe-head ${className}`} style={style}>
      {left ?? fallbackBack}
      <View className="safe-body">{body}</View>
      {right ?? (rightReserve ? <View className="safe-spacer" /> : null)}
    </View>
  );
}
