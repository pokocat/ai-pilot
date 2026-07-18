import { View, Text } from '@tarojs/components';
import type { ReactNode } from 'react';
import './index.scss';

export interface AsyncStateProps {
  /** 加载中：渲染骨架占位条 */
  loading?: boolean;
  /** 失败：渲染「加载失败 + 重试」；可为 boolean 或错误对象 */
  error?: boolean | unknown;
  /** 空态：数据为空时渲染空态文案（+ 可选引导按钮） */
  empty?: boolean;
  /** 重试回调（error 态的重试按钮） */
  onRetry?: () => void;
  /** 空态文案，缺省「暂时没有内容」 */
  emptyText?: string;
  /** 空态可选引导按钮 */
  emptyAction?: { text: string; onClick: () => void };
  /** 骨架条数量（loading 态），默认 3 */
  skeletonRows?: number;
  /** 正常态内容 */
  children?: ReactNode;
}

// 轻量三态容器：统一 loading（骨架）/ error（重试）/ empty（空态引导）三种缺省呈现，
// 让各页无需各自手搓。样式克制、与纸墨风一致，走 token 色。
export default function AsyncState({
  loading, error, empty, onRetry, emptyText = '暂时没有内容', emptyAction, skeletonRows = 3, children,
}: AsyncStateProps) {
  if (loading) {
    const rows = Math.max(2, Math.min(skeletonRows, 3));
    return (
      <View className="as-skeleton">
        {Array.from({ length: rows }).map((_, i) => (
          <View key={i} className="as-sk-row">
            <View className="as-sk-bar as-sk-title" />
            <View className="as-sk-bar as-sk-line" />
          </View>
        ))}
      </View>
    );
  }

  if (error) {
    return (
      <View className="as-state">
        <Text className="as-state-title">加载失败</Text>
        <Text className="as-state-desc">网络似乎不太稳，稍后再试一次。</Text>
        {onRetry && (
          <View className="as-retry" onClick={onRetry}><Text>重试</Text></View>
        )}
      </View>
    );
  }

  if (empty) {
    return (
      <View className="as-state">
        <Text className="as-state-title">{emptyText}</Text>
        {emptyAction && (
          <View className="as-empty-action" onClick={emptyAction.onClick}><Text>{emptyAction.text}</Text></View>
        )}
      </View>
    );
  }

  return <>{children}</>;
}
