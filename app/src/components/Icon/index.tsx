import { View } from '@tarojs/components';
import './index.scss';

// 线性图标 —— 路径数据对齐原型 scripts/icons.js。
// 跨端方案：生成 SVG data-URI 作为 background-image（H5 + 微信小程序均支持），
// 颜色在生成时注入（替代 H5 的 currentColor 继承）。

const PATHS: Record<string, string> = {
  home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v10h12V10"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.4"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.4"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.4"/>',
  agent: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 7V4"/><circle cx="9.5" cy="12" r="1.1" fill="CCC" stroke="none"/><circle cx="14.5" cy="12" r="1.1" fill="CCC" stroke="none"/><path d="M9.5 15.4h5"/>',
  user: '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 19.5c.6-3.4 3.2-5.2 6.5-5.2s5.9 1.8 6.5 5.2"/>',
  chat: '<path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9l-4 3.5V6a1 1 0 0 1 1-1Z"/>',
  insight: '<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/><circle cx="12" cy="12" r="3.4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  attach: '<path d="M20 11.5l-7.6 7.6a4 4 0 0 1-5.7-5.7l7.6-7.6a2.6 2.6 0 0 1 3.7 3.7l-7.5 7.5a1.2 1.2 0 0 1-1.7-1.7l6.9-6.9"/>',
  send: '<path d="M5 12h13M12 5l7 7-7 7"/>',
  arrow: '<path d="M8 5l7 7-7 7"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  alert: '<path d="M12 4 2.5 20h19L12 4Z"/><path d="M12 10v4M12 17h.01"/>',
  trend: '<path d="M4 16l5-5 3.5 3.5L20 7"/><path d="M20 11V7h-4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1" fill="CCC" stroke="none"/>',
  layers: '<path d="M12 3 3 8l9 5 9-5-9-5Z"/><path d="M3 13l9 5 9-5M3 16.5 12 21l9-4.5"/>',
  doc: '<path d="M7 3h7l4 4v14H7V3Z"/><path d="M14 3v4h4M9.5 12h5M9.5 15.5h5"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M5 17l4-3.5 3 2.5 3-3 4 4"/>',
  video: '<rect x="3.5" y="6" width="12.5" height="12" rx="2.5"/><path d="M16 10.5 20.5 8v8L16 13.5"/>',
  pen: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z"/><path d="M14.5 6.5l3 3"/>',
  spark: '<path d="M12 3l1.8 5.6L19.5 10l-5.7 1.4L12 17l-1.8-5.6L4.5 10l5.7-1.4L12 3Z"/>',
  chart: '<path d="M5 19V5M5 19h14"/><rect x="8" y="11" width="2.6" height="5" rx="1" fill="CCC" stroke="none"/><rect x="13" y="8" width="2.6" height="8" rx="1" fill="CCC" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.2l3 1.8"/>',
  flow: '<circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M8.2 11 16 6.6M8.2 13l7.8 4.4"/>',
  bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"/>',
  shield: '<path d="M12 3l7 3v6c0 4.2-3 7.5-7 9-4-1.5-7-4.8-7-9V6l7-3Z"/><path d="M9 12l2 2 4-4"/>',
  crown: '<path d="M4 8l3.5 3L12 5l4.5 6L20 8l-1.5 9h-13L4 8Z"/>',
  upload: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 14v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15" r="1.1" fill="CCC" stroke="none"/>',
  diamond: '<path d="M6 4h12l3 5-9 12L3 9l3-5Z"/><path d="M3 9h18M9 4l-3 5 6 12 6-12-3-5"/>',
  phone: '<rect x="6.5" y="3" width="11" height="18" rx="2.5"/><path d="M10 18h4"/>',
  wechat: '<path d="M8.4 4C4.9 4 2 6.5 2 9.6c0 1.7.9 3.3 2.4 4.3l-.6 2.2 2.5-1.3c.6.2 1.2.3 1.9.3"/><path d="M22 14.4c0-2.6-2.5-4.7-5.6-4.7-3.1 0-5.6 2.1-5.6 4.7s2.5 4.7 5.6 4.7c.6 0 1.2-.1 1.8-.3l2.2 1.2-.5-1.9c1.3-.9 2.1-2.2 2.1-3.7Z"/><circle cx="6.3" cy="9" r="1" fill="CCC" stroke="none"/><circle cx="10.5" cy="9" r="1" fill="CCC" stroke="none"/><circle cx="14.6" cy="13.8" r=".9" fill="CCC" stroke="none"/><circle cx="18.2" cy="13.8" r=".9" fill="CCC" stroke="none"/>',
};

function dataUri(name: string, color: string): string {
  const inner = (PATHS[name] || '').replaceAll('CCC', color);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

interface IconProps {
  name: string;
  size?: number;
  color?: string;
  className?: string;
}

export default function Icon({ name, size = 18, color = '#16191D', className = '' }: IconProps) {
  return (
    <View
      className={`ic ${className}`}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        backgroundImage: `url("${dataUri(name, color)}")`,
      }}
    />
  );
}
