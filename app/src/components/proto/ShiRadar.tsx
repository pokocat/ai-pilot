import { View, Text } from '@tarojs/components';
import { useStore } from '../../hooks/useStore';

// 三势雷达 —— 对齐原型 junqing 段 SVG + radarPoints 算法。
// 跨端方案：三角栅格 + 数值三角形画成 SVG data-URI 背景（weapp/h5 都稳），
// 三个中文标签用绝对定位 <Text> 叠加（SVG data-URI 内嵌中文字体在小程序不可靠，故外置）。
//
// 用法：<ShiRadar values={[70, 58, 62]} />        // 天势/市势/人势 0-100
//       <ShiRadar values={[a,b,c]} labels={['天势','市势','人势']} size={{ w: 150, h: 140 }} />

interface ShiRadarProps {
  values: [number, number, number]; // 天势 / 市势 / 人势，0-100
  labels?: [string, string, string];
  size?: { w: number; h: number };
  accent?: string;   // 描边色，默认当前本命色 hex
  fill?: string;     // 填充色，默认当前本命色 acg
  grid?: string;     // 外圈栅格线色
  gridSoft?: string; // 内圈/辐条线色
  className?: string;
}

// viewBox 固定 180x168（原型原值）；坐标算法照搬 renderVals。
const VB_W = 180;
const VB_H = 168;
const CX = 90;
const CY = 72;

function radarPoints([v0, v1, v2]: [number, number, number]): string {
  const clamp = (v: number) => Math.max(0, Math.min(100, v));
  const a = clamp(v0), b = clamp(v1), c = clamp(v2);
  const p0 = [CX, CY + (14 - CY) * a / 100];
  const p1 = [CX + (158 - CX) * b / 100, CY + (130 - CY) * b / 100];
  const p2 = [CX + (22 - CX) * c / 100, CY + (130 - CY) * c / 100];
  return `${p0[0].toFixed(0)},${p0[1].toFixed(0)} ${p1[0].toFixed(0)},${p1[1].toFixed(0)} ${p2[0].toFixed(0)},${p2[1].toFixed(0)}`;
}

function svgUri(pts: string, accent: string, fill: string, grid: string, gridSoft: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}">` +
    `<polygon points="90,14 158,130 22,130" fill="none" stroke="${grid}" stroke-width="1"/>` +
    `<polygon points="90,52 124,110 56,110" fill="none" stroke="${gridSoft}" stroke-width="1"/>` +
    `<line x1="90" y1="72" x2="90" y2="14" stroke="${gridSoft}"/>` +
    `<line x1="90" y1="72" x2="158" y2="130" stroke="${gridSoft}"/>` +
    `<line x1="90" y1="72" x2="22" y2="130" stroke="${gridSoft}"/>` +
    `<polygon points="${pts}" fill="${fill}" stroke="${accent}" stroke-width="2"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export default function ShiRadar({
  values,
  labels = ['天势', '市势', '人势'],
  size = { w: 150, h: 140 },
  accent,
  fill,
  grid = 'rgba(34,32,27,.24)',
  gridSoft = 'rgba(34,32,27,.13)',
  className = '',
}: ShiRadarProps) {
  const s = useStore();
  const col = s.color();
  const ac = accent || col.hex;
  const fl = fill || col.acg;
  const uri = svgUri(radarPoints(values), ac, fl, grid, gridSoft);

  const lbl = {
    fontFamily: 'var(--serif)', fontSize: '12px', fontWeight: 600, color: 'var(--tx)',
    position: 'absolute' as const,
  };
  return (
    <View className={`shi-radar ${className}`} style={{ position: 'relative', width: `${size.w}px`, height: `${size.h}px`, flex: 'none' }}>
      <View style={{ width: '100%', height: '100%', backgroundImage: `url("${uri}")`, backgroundRepeat: 'no-repeat', backgroundSize: '100% 100%' }} />
      <Text style={{ ...lbl, top: '-4px', left: 0, right: 0, textAlign: 'center' }}>{labels[0]}</Text>
      <Text style={{ ...lbl, bottom: '4px', right: '-6px' }}>{labels[1]}</Text>
      <Text style={{ ...lbl, bottom: '4px', left: '-6px' }}>{labels[2]}</Text>
    </View>
  );
}
