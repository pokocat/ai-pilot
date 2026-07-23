import { Input } from '@tarojs/components';

// 键盘安全输入框：聚焦期间不手动移动父级 ScrollView，交给微信原生上推处理。
// Android 的 Input 文字是独立原生层，聚焦后再改 scrollTop/父容器位置会让文字与输入框失去同步。
interface KbInputProps {
  anchorId: string;
  className?: string;
  value: string;
  placeholder?: string;
  type?: 'text' | 'number' | 'digit' | 'idcard';
  confirmType?: 'send' | 'search' | 'next' | 'go' | 'done';
  focus?: boolean;
  onInput: (e: { detail: { value: string } }) => void;
  onConfirm?: () => void;
}

export default function KbInput({ anchorId, onConfirm, ...rest }: KbInputProps) {
  return (
    <Input
      {...rest}
      id={anchorId}
      alwaysEmbed
      adjustPosition
      cursorSpacing={20}
      onConfirm={onConfirm}
    />
  );
}
