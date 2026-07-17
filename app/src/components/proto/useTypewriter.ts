import { useEffect, useRef, useState } from 'react';

// 打字揭示 hook —— 对齐原型 pickIndustry 的 _typer：每 tick 揭示 2 字、间隔 38ms。
// 用法：const { typed, done, restart } = useTypewriter(fullText, { auto: true });
//   典型渲染：<Text>{typed}</Text> + 末尾闪烁光标（done 前显示）。

interface Options {
  step?: number;   // 每 tick 揭示字数，默认 2
  interval?: number; // tick 间隔 ms，默认 38
  auto?: boolean;  // text 变化即自动开跑，默认 true
}

export function useTypewriter(text: string, opts: Options = {}) {
  const { step = 2, interval = 38, auto = true } = opts;
  const [typed, setTyped] = useState('');
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval>>();

  const run = (full: string) => {
    clearInterval(timer.current);
    setTyped('');
    setDone(false);
    if (!full) { setDone(true); return; }
    let i = 0;
    timer.current = setInterval(() => {
      i += step;
      if (i >= full.length) {
        clearInterval(timer.current);
        setTyped(full);
        setDone(true);
      } else {
        setTyped(full.slice(0, i));
      }
    }, interval);
  };

  useEffect(() => {
    if (auto) run(text);
    return () => clearInterval(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, auto]);

  return { typed, done, restart: () => run(text) };
}
