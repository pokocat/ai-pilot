import { View, Image } from '@tarojs/components';
import avGeneral from '../../assets/avatars/generated/general-imagegen.jpg';
import avStrat from '../../assets/avatars/generated/strat-imagegen.jpg';
import avGrowth from '../../assets/avatars/generated/growth-imagegen.jpg';
import avIp from '../../assets/avatars/generated/ip-imagegen.jpg';
import avOps from '../../assets/avatars/generated/ops-imagegen.jpg';
import avOrg from '../../assets/avatars/generated/org-imagegen.jpg';
import './index.scss';

// 军师拟人头像 —— imagegen 生成的古代/神话谋略人物商务漫画头像。
// 六幅立绘对应六类气质；未显式映射的智能体按气质就近复用。
const PORTRAITS: Record<string, string> = {
  general: avGeneral, // 总军师 · 诸葛亮意象 · 运筹
  strat: avStrat,     // 战略 · 鬼谷子意象 · 决断
  growth: avGrowth,   // 增长 · 姜子牙意象 · 生长
  ip: avIp,           // IP · 文曲星意象 · 表达
  ops: avOps,         // 经营复盘 · 刘伯温意象 · 明察
  org: avOrg,         // 组织 · 张良意象 · 调度
  // 气质就近复用
  intel: avStrat,     // 竞争情报 → 决断
  fund: avOrg,        // 融资参谋 → 沉稳
  model: avGrowth,    // 商业模式 → 结构生长
  brand: avIp,        // 品牌营销 → 表达
  promo: avIp,
  poster: avGrowth,
  shortvideo: avStrat,
  copy: avOrg,
};

const FALLBACK_POOL = [avGeneral, avStrat, avGrowth, avIp, avOps, avOrg];

function portraitFor(agentKey: string): string {
  if (PORTRAITS[agentKey]) return PORTRAITS[agentKey];
  let h = 0;
  for (let i = 0; i < agentKey.length; i++) h = (h * 31 + agentKey.charCodeAt(i)) % 997;
  return FALLBACK_POOL[h % FALLBACK_POOL.length];
}

interface AdvisorAvatarProps {
  agentKey: string;
  size?: number;      // 直径 px，默认 50（设计稿列表规格）
  online?: boolean;   // 右下角在线点
  className?: string;
}

export default function AdvisorAvatar({ agentKey, size = 50, online = false, className = '' }: AdvisorAvatarProps) {
  const px = `${size}px`;
  return (
    <View className={`advisor-avatar ${className}`} style={{ width: px, height: px }}>
      <Image className="aa-img" src={portraitFor(agentKey)} mode="aspectFill" />
      {online ? <View className="aa-dot" style={{ background: 'var(--accent-bright)' }} /> : null}
    </View>
  );
}
