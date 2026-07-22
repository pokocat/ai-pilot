import { Input } from '@tarojs/components';
import { useScreenKb } from '../Screen/keyboard';

// 键盘安全输入框：置于 Screen 滚动区内的 <Input> 用它替代原生 Input，
// 关掉 weapp 默认的整页上推（adjustPosition=false，全屏 ScrollView 下会失效导致输入框被键盘遮住），
// 改由 Screen 收缩滚动区 + scrollIntoView(锚点) 把输入框滚到键盘上方。anchorId 需页面内唯一。
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
  const ensureVisible = useScreenKb();
  return (
    <Input
      {...rest}
      id={anchorId}
      adjustPosition={false}
      cursorSpacing={20}
      onFocus={() => ensureVisible(anchorId)}
      onConfirm={onConfirm}
    />
  );
}
