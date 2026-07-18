import { View } from '@tarojs/components';
import { svgToDataUri } from '../proto/svg';
import './index.scss';

// 线性图标 —— 路径数据对齐原型 scripts/icons.js。
// 跨端方案：生成 SVG data-URI 作为 background-image；颜色在生成时注入（替代 H5 的 currentColor 继承）。
// 编码用 base64（见 ../proto/svg）——URL 编码的 SVG 背景在微信小程序真机常整块不渲染（图标空白）。

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
  flag: '<path d="M6 21V4"/><path d="M6 5h11l-3.5 3.5L17 12H6Z"/>',
  token: '<rect x="6.5" y="4" width="11" height="16" rx="1"/><path d="M6.5 7.5h11M6.5 16.5h11M10 4v16M14 4v16"/>',
  pouch: '<path d="M9.5 6.5c0-1.4 1.1-2.5 2.5-2.5s2.5 1.1 2.5 2.5"/><path d="M6.3 8.2h11.4"/><path d="M7 8.2c-1.2 2-1.7 4.2-1.7 6C5.3 18.3 8 20.5 12 20.5s6.7-2.2 6.7-6.3c0-1.8-.5-4-1.7-6"/>',
  upload: '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 14v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/><circle cx="12" cy="15" r="1.1" fill="CCC" stroke="none"/>',
  diamond: '<path d="M6 4h12l3 5-9 12L3 9l3-5Z"/><path d="M3 9h18M9 4l-3 5 6 12 6-12-3-5"/>',
  phone: '<rect x="6.5" y="3" width="11" height="18" rx="2.5"/><path d="M10 18h4"/>',
  wechat: '<path d="M8.4 4C4.9 4 2 6.5 2 9.6c0 1.7.9 3.3 2.4 4.3l-.6 2.2 2.5-1.3c.6.2 1.2.3 1.9.3"/><path d="M22 14.4c0-2.6-2.5-4.7-5.6-4.7-3.1 0-5.6 2.1-5.6 4.7s2.5 4.7 5.6 4.7c.6 0 1.2-.1 1.8-.3l2.2 1.2-.5-1.9c1.3-.9 2.1-2.2 2.1-3.7Z"/><circle cx="6.3" cy="9" r="1" fill="CCC" stroke="none"/><circle cx="10.5" cy="9" r="1" fill="CCC" stroke="none"/><circle cx="14.6" cy="13.8" r=".9" fill="CCC" stroke="none"/><circle cx="18.2" cy="13.8" r=".9" fill="CCC" stroke="none"/>',
};

// 实心图标（美术描摹稿，非线性描边）：viewBox 与描边图标不同，按素材原始比例渲染。
const FILLED: Record<string, { viewBox: string; markup: string }> = {
  hat: {
    viewBox: '0 0 156 144',
    markup:
      '<g transform="translate(0,144) scale(0.1,-0.1)" fill="CCC" stroke="none"><path d="M710 1158 c-30 -5 -80 -10 -110 -12 -154 -10 -232 -82 -277 -253 -4 -15 -7 -167 -8 -337 0 -301 0 -309 20 -316 22 -8 809 -13 835 -5 13 4 15 31 12 184 l-2 179 45 22 c25 12 52 32 60 44 53 82 59 236 13 336 -45 98 -99 135 -211 145 -34 3 -89 10 -122 15 -71 12 -178 11 -255 -2z m91 -50 c-85 -83 -124 -213 -143 -475 -12 -162 -16 -170 -68 -156 -18 5 -20 14 -20 97 1 122 24 306 49 386 39 125 100 188 180 189 l45 1 -43 -42z m179 27 c0 -3 -15 -11 -33 -18 -50 -21 -111 -98 -140 -175 -35 -94 -55 -238 -56 -398 -1 -67 -8 -76 -55 -67 l-28 6 7 125 c4 69 8 133 10 143 2 9 7 39 10 66 10 68 52 190 81 232 37 55 98 91 156 91 26 0 48 -2 48 -5z m-318 -43 c-62 -78 -112 -305 -112 -511 l0 -99 -27 -5 c-44 -8 -50 0 -56 77 -11 150 22 378 69 467 27 54 91 109 125 109 l31 0 -30 -38z m483 27 c88 -24 144 -101 163 -224 15 -92 -15 -202 -66 -248 -55 -50 -150 -23 -189 52 -67 129 32 297 122 206 29 -28 35 -98 11 -131 -21 -28 -26 -15 -13 34 10 40 10 44 -14 68 -34 33 -71 25 -93 -21 -21 -43 -20 -81 3 -132 23 -49 50 -66 105 -66 156 0 154 352 -2 419 -20 9 -62 16 -93 16 -130 -1 -214 -78 -253 -229 -16 -62 -36 -244 -36 -330 0 -33 -4 -53 -12 -53 -8 0 -9 34 -5 127 13 263 54 389 150 467 63 50 143 67 222 45z m-605 -3 c0 -2 -20 -16 -45 -30 -111 -65 -145 -172 -145 -450 0 -113 -3 -157 -11 -149 -7 7 -9 74 -7 199 4 160 7 199 26 254 24 73 74 139 124 163 32 16 58 22 58 13z m-25 -98 c-49 -106 -67 -206 -69 -385 l-1 -151 -30 -5 c-16 -3 -34 -2 -38 3 -4 4 -8 74 -8 157 1 246 33 356 123 422 23 17 45 31 49 31 5 0 -7 -33 -26 -72z m672 26 c96 -71 112 -286 26 -354 -31 -24 -56 -25 -90 -3 -49 32 -71 134 -35 165 30 27 40 29 57 12 13 -13 15 -28 10 -69 -6 -42 -4 -53 9 -58 26 -10 56 39 56 94 0 40 -5 55 -32 85 -29 33 -36 36 -71 31 -122 -16 -147 -200 -41 -306 42 -42 44 -46 44 -102 0 -58 -1 -59 -27 -60 -16 0 -84 -1 -153 -2 l-125 -1 2 130 c5 262 66 414 182 454 61 20 149 13 188 -16z m-27 -504 c0 -33 -4 -60 -10 -60 -6 0 -10 27 -10 60 0 33 4 60 10 60 6 0 10 -27 10 -60z m-723 -93 c-4 -12 -71 -20 -97 -11 -24 9 5 20 55 21 32 1 45 -2 42 -10z m73 3 c0 -5 -9 -10 -20 -10 -11 0 -20 5 -20 10 0 6 9 10 20 10 11 0 20 -4 20 -10z m69 -20 c19 -57 -23 -109 -49 -61 -14 28 -12 57 6 75 22 23 31 20 43 -14z m61 20 c0 -5 -9 -10 -20 -10 -11 0 -20 5 -20 10 0 6 9 10 20 10 11 0 20 -4 20 -10z m527 -4 c-4 -11 -456 -21 -485 -11 -42 15 24 21 243 21 173 1 245 -2 242 -10z m-677 -41 c6 -8 10 -21 8 -29 -2 -11 -8 -7 -20 14 -18 31 -10 41 12 15z m143 -17 c-13 -26 -18 -29 -21 -15 -4 19 14 47 29 47 5 0 2 -15 -8 -32z m-165 -25 l23 -42 66 2 c66 2 66 2 89 42 l22 40 243 0 244 0 2 -52 2 -52 -332 -3 c-183 -2 -367 -2 -409 0 l-78 3 0 55 0 55 52 -3 c50 -3 54 -5 76 -45z m700 -102 c3 -8 -115 -11 -417 -11 -254 0 -421 4 -421 9 0 15 32 16 445 15 274 -1 390 -5 393 -13z"/></g>',
  },
};

function dataUri(name: string, color: string): string {
  const filled = FILLED[name];
  if (filled) {
    const [, , vw, vh] = filled.viewBox.split(/\s+/);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${vw}" height="${vh}" viewBox="${filled.viewBox}">${filled.markup.replaceAll('CCC', color)}</svg>`;
    return svgToDataUri(svg);
  }
  const inner = (PATHS[name] || '').replaceAll('CCC', color);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  return svgToDataUri(svg);
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
