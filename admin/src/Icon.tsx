// 线性图标（与 app/src/components/Icon 同一套路径，web 端用 inline SVG + currentColor）
const PATHS: Record<string, string> = {
  chart: '<path d="M5 19V5M5 19h14"/><rect x="8" y="11" width="2.6" height="5" rx="1" fill="currentColor" stroke="none"/><rect x="13" y="8" width="2.6" height="8" rx="1" fill="currentColor" stroke="none"/>',
  spark: '<path d="M12 3l1.8 5.6L19.5 10l-5.7 1.4L12 17l-1.8-5.6L4.5 10l5.7-1.4L12 3Z"/>',
  agent: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 7V4"/><circle cx="9.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><path d="M9.5 15.4h5"/>',
  doc: '<path d="M7 3h7l4 4v14H7V3Z"/><path d="M14 3v4h4M9.5 12h5M9.5 15.5h5"/>',
  crown: '<path d="M4 8l3.5 3L12 5l4.5 6L20 8l-1.5 9h-13L4 8Z"/>',
  pen: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z"/><path d="M14.5 6.5l3 3"/>',
  layers: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 13l9 5 9-5M3 16.5 12 21l9-4.5"/>',
  insight: '<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/><circle cx="12" cy="12" r="3.4"/>',
  chat: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.5V6a1 1 0 0 1 1-1Z"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  arrow: '<path d="M8 5l7 7-7 7"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  trend: '<path d="M4 16l5-5 3.5 3.5L20 7"/><path d="M20 11V7h-4"/>',
  alert: '<path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4M12 17h.01"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.2l3 1.8"/>',
  user: '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 19.5c.6-3.4 3.2-5.2 6.5-5.2s5.9 1.8 6.5 5.2"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4-3.5 3 2.5 3-3 4 4"/>',
  video: '<rect x="3.5" y="6" width="12.5" height="12" rx="2.5"/><path d="M16 10.5 20.5 8v8L16 13.5"/>',
};

export default function Icon({ name, size = 18 }: { name: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      dangerouslySetInnerHTML={{ __html: PATHS[name] || '' }}
    />
  );
}
