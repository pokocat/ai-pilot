// Radix 浮层的挂载点（Dialog / AlertDialog / Select / DropdownMenu / Tooltip）。
//
// 为什么需要：Radix 的 Portal 默认把内容挂到 `document.body` 下——那是 `.sc` 的**外面**。
// 而运营后台没有引 Tailwind 的 preflight（理由见 styles/shadcn.css 头注释），`border` 工具类的
// 默认边框色是由 `.sc *` 那条规则补的。浮层跑到 body 下就吃不到它，于是弹层的分隔线、下拉框的
// 边框会退化成 `currentColor`（墨色实线）。
//
// 解法：在模块根 `.sc` 里放一个零尺寸的挂载节点，用 context 传下去，各 ui 组件的 Portal 显式
// `container={...}`。这样 token 作用域与边框兜底都不漏，同时浮层依旧脱离文档流（Radix 自己
// 用 fixed 定位）。
import { createContext, useContext, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

const ScPortalContext = createContext<HTMLElement | null>(null);

/** 给 ui/ 组件用：拿到 `.sc` 内的挂载点；还没挂上时返回 undefined（Radix 回退到 body）。 */
export function useScPortalContainer(): HTMLElement | undefined {
  return useContext(ScPortalContext) ?? undefined;
}

/** 增长组每个视图的根节点。`.sc` 是 shadcn 主题的作用域标记，别在旧页面里用。 */
export function ScRoot({ children, className }: { children: ReactNode; className?: string }) {
  const [node, setNode] = useState<HTMLElement | null>(null);
  return (
    <div className={cn('sc', className)}>
      <ScPortalContext.Provider value={node}>{children}</ScPortalContext.Provider>
      <div className="sc-portal" ref={setNode} aria-hidden="true" />
    </div>
  );
}
