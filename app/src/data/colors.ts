// 6 套「本命色」主题 —— 事实来源对齐原型 scripts/app.js 的 COLORS。
// 金色（财金）默认第一并默认选中（首登强制选择）。

export interface BenmingColor {
  key: string;
  cn: string;
  short: string;
  wm: string; // 水印字
  seal: string; // 印章字
  en: string;
  verdict: string; // 军师批语
  vars: Record<string, string>;
}

export const COLORS: BenmingColor[] = [
  {
    key: 'gold', cn: '财 金', short: '财金', wm: '势', seal: '金', en: 'CAI JIN · FORTUNE',
    verdict: '聚财为势，谋定而动。',
    vars: { '--accent': '#A07D2C', '--accent-deep': '#6E5621', '--accent-soft': '#F2EAD6', '--accent-ink': '#43340F', '--accent-bright': '#D8B25A', '--accent-glow': 'rgba(200,165,90,.30)' },
  },
  {
    key: 'green', cn: '墨 绿', short: '墨绿', wm: '谋', seal: '绿', en: 'MO LÜ · VERDANT',
    verdict: '稳中求进，守正出奇。',
    vars: { '--accent': '#1E5A43', '--accent-deep': '#163F30', '--accent-soft': '#E7EEE9', '--accent-ink': '#0F2B20', '--accent-bright': '#5FB389', '--accent-glow': 'rgba(99,160,130,.32)' },
  },
  {
    key: 'red', cn: '朱 砂', short: '朱砂', wm: '决', seal: '朱', en: 'ZHU SHA · CINNABAR',
    verdict: '当机立断，先发制人。',
    vars: { '--accent': '#9E2B25', '--accent-deep': '#6F1B17', '--accent-soft': '#F3E2DF', '--accent-ink': '#4A1310', '--accent-bright': '#D98077', '--accent-glow': 'rgba(190,90,80,.30)' },
  },
  {
    key: 'blue', cn: '黛 蓝', short: '黛蓝', wm: '远', seal: '黛', en: 'DAI LAN · AZURE',
    verdict: '高瞻远瞩，运筹千里。',
    vars: { '--accent': '#1F4E79', '--accent-deep': '#143350', '--accent-soft': '#E2EAF1', '--accent-ink': '#122C44', '--accent-bright': '#6E98C6', '--accent-glow': 'rgba(90,140,200,.30)' },
  },
  {
    key: 'purple', cn: '绛 紫', short: '绛紫', wm: '局', seal: '绛', en: 'JIANG ZI · AMETHYST',
    verdict: '格局为先，纳于无形。',
    vars: { '--accent': '#5B3A6B', '--accent-deep': '#3D2748', '--accent-soft': '#ECE4F1', '--accent-ink': '#2F1E38', '--accent-bright': '#A07FB3', '--accent-glow': 'rgba(150,110,170,.30)' },
  },
  {
    key: 'iron', cn: '玄 铁', short: '玄铁', wm: '藏', seal: '玄', en: 'XUAN TIE · GRAPHITE',
    verdict: '大巧若拙，藏锋守拙。',
    vars: { '--accent': '#33373D', '--accent-deep': '#212429', '--accent-soft': '#E8E9EB', '--accent-ink': '#1B1D21', '--accent-bright': '#8A9099', '--accent-glow': 'rgba(120,130,140,.28)' },
  },
];

export function colorIndex(key: string): number {
  const i = COLORS.findIndex((c) => c.key === key);
  return i < 0 ? 0 : i;
}

export function colorByKey(key: string): BenmingColor {
  return COLORS[colorIndex(key)];
}

/** 当前主题强调色（用于 Icon 等需要显式颜色的场景） */
export function accentOf(key: string): string {
  return colorByKey(key).vars['--accent'];
}
