import avGeneral from '../assets/avatars/generated/general-imagegen.jpg';
import avStrat from '../assets/avatars/generated/strat-imagegen.jpg';
import avGrowth from '../assets/avatars/generated/growth-imagegen.jpg';
import avIp from '../assets/avatars/generated/ip-imagegen.jpg';
import avOps from '../assets/avatars/generated/ops-imagegen.jpg';
import avOrg from '../assets/avatars/generated/org-imagegen.jpg';

// 军师立绘。与移动端 components/AdvisorAvatar 同一批图，但那个组件是 Taro 的，PC 不能复用。
// 只映射有立绘的 key：运营新上架的军师落到首字兜底，不去猜「气质相近」硬派一张脸。
const PORTRAITS: Record<string, string> = {
  general: avGeneral,
  strat: avStrat,
  growth: avGrowth,
  ip: avIp,
  ops: avOps,
  org: avOrg,
  intel: avStrat,
  fund: avOrg,
  model: avGrowth,
  brand: avIp,
  promo: avIp,
  poster: avGrowth,
  shortvideo: avStrat,
  copy: avOrg,
};

/** 无立绘时返回空串，调用方回退首字底。 */
export function portraitOf(agentKey: string): string {
  return PORTRAITS[agentKey] || '';
}
