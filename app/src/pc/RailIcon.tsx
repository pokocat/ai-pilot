// 导航轨五个区的线性图标 —— 逐笔取自 PC 设计稿（`军师 PC.dc.html` 的 nav 段）。
// 移动端的 components/Icon 是 lucide 位图/背景图方案，桌面这里要跟随 currentColor 变色，
// 所以直接内联 SVG。

export type RailIconName = 'sessions' | 'sand' | 'exec' | 'think' | 'lord';

const PATHS: Record<RailIconName, JSX.Element> = {
  sessions: (
    <>
      <path d="M12 4.6c4.4 0 7.6 2.7 7.6 6.1s-3.2 6.1-7.6 6.1c-.55 0-1.1-.04-1.62-.12l-3.05 1.98a.5.5 0 0 1-.77-.5l.53-3.05C5.4 14.1 4.4 12.5 4.4 10.7c0-3.4 3.2-6.1 7.6-6.1Z" />
      <circle cx="8.9" cy="10.7" r=".8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="10.7" r=".8" fill="currentColor" stroke="none" />
      <circle cx="15.1" cy="10.7" r=".8" fill="currentColor" stroke="none" />
    </>
  ),
  sand: (
    <>
      <rect x="3.8" y="14" width="16.4" height="5.2" rx="1.5" />
      <path d="M11.2 14V4.6" />
      <path d="M11.2 4.6h5.6l-1.9 2.3 1.9 2.3h-5.6" />
      <circle cx="7.4" cy="16.6" r=".85" fill="currentColor" stroke="none" />
      <circle cx="16.6" cy="16.6" r=".85" fill="currentColor" stroke="none" />
    </>
  ),
  exec: (
    <>
      <path d="M4.4 6.1l1.3 1.3 2.2-2.4" />
      <path d="M11 6.6h8.6" />
      <path d="M4.4 11.9l1.3 1.3 2.2-2.4" />
      <path d="M11 12.4h8.6" />
      <circle cx="6" cy="18" r="1.4" />
      <path d="M11 18.2h8.6" />
    </>
  ),
  think: (
    <>
      <path d="M9.6 4.7c1.55.78 3.25.78 4.8 0" />
      <path d="M9.6 4.7 8.6 8.5" />
      <path d="M14.4 4.7l1 3.8" />
      <path d="M8 8.8c2.55-.68 5.45-.68 8 0" />
      <path d="M8.2 8.9c-1.95 1.65-3.05 3.65-3.05 5.65 0 3.35 2.95 5.35 6.85 5.35s6.85-2 6.85-5.35c0-2-1.1-4-3.05-5.65" />
    </>
  ),
  lord: (
    <>
      <path d="M9.3 12.6v-3c0-2.1 1.1-3.8 2.7-3.8s2.7 1.7 2.7 3.8v3" />
      <rect x="6.4" y="12.6" width="11.2" height="4.6" rx="1.2" />
      <path d="M5 20.4h14" />
    </>
  ),
};

export default function RailIcon({ name, size = 24 }: { name: RailIconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke="currentColor" strokeWidth={1.6}
      strokeLinecap="round" strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}
