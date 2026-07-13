import { useEffect, type ReactNode } from 'react';
import { View, Text } from '@tarojs/components';
import { store } from '../../services/store';
import './index.scss';

export interface SheetProps {
  /** 是否展示 */
  visible: boolean;
  /** 关闭回调（遮罩点击默认触发） */
  onClose?: () => void;
  /** setOverlay 桥接键：每个弹层唯一，随开合驱动原生底栏隐藏 */
  overlayKey: string;
  /** 可选内建标题（grip 下方，serif）；多数弹层用自定义 hero，可不传 */
  title?: string;
  /** 主体内容 */
  children?: ReactNode;
  /** 动作区，渲染在内容之后（无额外包裹，样式由调用方自持） */
  footer?: ReactNode;
  /** 遮罩点击是否关闭，默认 true（false 时点击遮罩无反应，catchMove 仍防穿透） */
  maskClosable?: boolean;
  /** 遮罩点击/关闭动作覆写（如 OnboardSheet「置已看」副作用）；给定则取代 onClose 处理遮罩点击 */
  onMaskClose?: () => void;
  /** 面板内容横向对齐，默认 stretch；启用/方案页用 center */
  align?: 'stretch' | 'center';
  /** 面板最大高度，默认 84vh（scss）；如 OnboardSheet 传 88vh */
  maxHeight?: string;
  /** 面板附加类（padding / grip 间距等个别微调） */
  panelClassName?: string;
  /** 根遮罩附加类 */
  className?: string;
}

// 弹层基座：统一五要素（z-index=900 字面量 / 遮罩 rgba(22,25,29,.55) / 入场 sheet-rise /
// 圆角 var(--r-lg) / 根 catchMove 防穿透），并内聚 setOverlay 原生底栏桥接。
// z-index 见 index.scss——weapp 真机对 page 级 var 用于 z-index 不稳定，故写字面量 900。
export default function Sheet({
  visible, onClose, overlayKey, title, children, footer,
  maskClosable = true, onMaskClose, align = 'stretch', maxHeight,
  panelClassName = '', className = '',
}: SheetProps) {
  // 底栏协调：随开合驱动 store.setOverlay，卸载/关闭时清理（原各 Sheet 的公共行为，收敛至基座）。
  useEffect(() => {
    store.setOverlay(visible, overlayKey);
    return () => store.setOverlay(false, overlayKey);
  }, [visible, overlayKey]);

  if (!visible) return null;

  const handleMask = () => {
    if (!maskClosable) return;
    (onMaskClose || onClose)?.();
  };

  return (
    <View className={`sheet-mask ${className}`} onClick={handleMask} catchMove>
      <View
        className={`sheet-panel ${align === 'center' ? 'sheet-panel--center' : ''} ${panelClassName}`}
        style={maxHeight ? { maxHeight } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <View className="sheet-grip" />
        {title ? <Text className="sheet-title serif">{title}</Text> : null}
        {children}
        {footer}
      </View>
    </View>
  );
}
