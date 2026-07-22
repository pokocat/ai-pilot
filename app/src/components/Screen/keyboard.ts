import { createContext, useContext } from 'react';

// Screen 键盘避让上下文：输入框聚焦时把自己的锚点 id 报给 Screen，
// Screen 收缩滚动区高度（露出键盘上方）并 scrollIntoView 该锚点，保证输入框不被键盘遮住。
// 默认空实现：不在 Screen 内的输入框调用也不报错。
export const ScreenKbCtx = createContext<(anchorId: string) => void>(() => {});
export const useScreenKb = () => useContext(ScreenKbCtx);
