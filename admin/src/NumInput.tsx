import { useEffect, useState, type InputHTMLAttributes } from 'react';

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: number;
  onChange: (n: number) => void;
};

// 受控数字输入：内部用字符串维持显示，允许清空 / 删掉前导 0 / 输入中间态（如「-」）。
// 空值对外报 0；仅当外部 value 与当前文本表达的数值不一致时才回灌，
// 避免「清空 → 父级变 0 → 被强制弹回 0」导致永远删不掉的老问题。
export default function NumInput({ value, onChange, ...rest }: Props) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    const cur = text.trim() === '' ? 0 : Number(text);
    if (cur !== value) setText(String(value));
    // 仅在外部 value 变化时同步（如异步加载、计费改 free 强制 0）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <input
      {...rest}
      type="number"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);
        const n = raw.trim() === '' ? 0 : Number(raw);
        if (!Number.isNaN(n)) onChange(n);
      }}
    />
  );
}
