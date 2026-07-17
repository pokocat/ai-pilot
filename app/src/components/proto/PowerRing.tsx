import { View, Text } from '@tarojs/components';
import { useStore } from '../../hooks/useStore';

// 算力环 —— 对齐原型 zhugong 段 SVG circle stroke-dasharray + powerDash 算法。
// 跨端方案：底环 + 进度环画成 SVG data-URI 背景；中心数字/分母/标签用 <Text> 叠加。
//
// 用法：<PowerRing percent={68} />
//       <PowerRing percent={68} value={68} max={100} label="本月算力" size={78} />

interface PowerRingProps {
  percent: number;  // 进度 0-100（决定 dash）
  value?: number;   // 中心大数，默认 = percent
  max?: number;     // 分母，默认 100
  label?: string;   // 环下标签，默认 本月算力
  size?: number;    // 直径 px，默认 78
  accent?: string;  // 进度色，默认当前本命色 hex
  track?: string;   // 底环色，默认 --surf-3
  className?: string;
}

const R = 42;
const CIRC = 2 * Math.PI * R; // 周长

function powerDash(pct: number): string {
  const p = Math.max(0, Math.min(100, pct)) / 100;
  return `${(CIRC * p).toFixed(1)} ${CIRC.toFixed(1)}`;
}

function svgUri(pct: number, accent: string, track: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<circle cx="50" cy="50" r="${R}" fill="none" stroke="${track}" stroke-width="7"/>` +
    `<circle cx="50" cy="50" r="${R}" fill="none" stroke="${accent}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${powerDash(pct)}" transform="rotate(-90 50 50)"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export default function PowerRing({
  percent,
  value,
  max = 100,
  label = '本月算力',
  size = 78,
  accent,
  track = '#E3DBC9',
  className = '',
}: PowerRingProps) {
  const s = useStore();
  const ac = accent || s.color().hex;
  const uri = svgUri(percent, ac, track);
  const num = value ?? Math.round(percent);
  return (
    <View className={`power-ring ${className}`} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <View style={{ position: 'relative', width: `${size}px`, height: `${size}px` }}>
        <View style={{ width: '100%', height: '100%', backgroundImage: `url("${uri}")`, backgroundRepeat: 'no-repeat', backgroundSize: '100% 100%' }} />
        <View style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontFamily: 'var(--serif)', fontSize: `${size * 0.31}px`, fontWeight: 600, lineHeight: 1, color: 'var(--tx)' }}>{num}</Text>
          <Text style={{ fontFamily: 'var(--serif)', fontSize: `${size * 0.13}px`, color: 'var(--mut)', marginTop: '2px' }}>/ {max}</Text>
        </View>
      </View>
      {label ? <Text style={{ fontFamily: 'var(--serif)', fontSize: '12px', color: 'var(--mut)', letterSpacing: '.1em', marginTop: '8px' }}>{label}</Text> : null}
    </View>
  );
}
