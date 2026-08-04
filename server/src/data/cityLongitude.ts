// 主要城市 → 东经（真太阳时校正用，M1 PR-2；匹配规则 2026-08 收紧）。
// 取市中心近似值（精确到 0.1° ≈ 24 秒时差，远小于时辰颗粒度）；未命中返回 undefined = 不校正。
//
// 为什么匹配必须保守：经度校正不是微调。经度每偏 1° 平移 4 分钟，时辰颗粒是 120 分钟，
// 一次误命中足以改时柱；落在子时/立春边界上还会改日柱甚至年柱月柱，日主一变整盘重算。
// 所以这里的口径是「宁可不校正，也不能乱校正」——不命中只是少一层精度且可解释，
// 错命中是把用户的盘算成别人的盘且无从发现。
//
// 旧实现 `s.includes(city) || city.includes(s)` 的反向包含会把以下输入全部误命中（已复现）：
//   「南」→ 南京 118.8   「海」→ 上海 121.5   「大」→ 大连 121.6
//   「长」→ 长沙 113.0（而非长春 125.3，差 12.3° ≈ 49 分钟）
//   「南京路」→ 南京 118.8（这是上海的路名，差 2.7° 且方向相反）
// 现口径：先精确匹配 → 再「输入包含城市名」的前缀/含有匹配，且输入至少 2 字；
// 反向包含（城市名包含输入）整条删除。

const CITY_LNG: Record<string, number> = {
  北京: 116.4, 上海: 121.5, 广州: 113.3, 深圳: 114.1, 杭州: 120.2, 南京: 118.8,
  苏州: 120.6, 成都: 104.1, 重庆: 106.6, 武汉: 114.3, 西安: 108.9, 长沙: 113.0,
  郑州: 113.7, 济南: 117.0, 青岛: 120.4, 天津: 117.2, 沈阳: 123.4, 大连: 121.6,
  哈尔滨: 126.6, 长春: 125.3, 石家庄: 114.5, 太原: 112.6, 合肥: 117.2, 福州: 119.3,
  厦门: 118.1, 南昌: 115.9, 昆明: 102.7, 贵阳: 106.7, 南宁: 108.4, 海口: 110.3,
  兰州: 103.8, 西宁: 101.8, 银川: 106.2, 呼和浩特: 111.7, 乌鲁木齐: 87.6, 拉萨: 91.1,
  香港: 114.2, 澳门: 113.5, 台北: 121.5, 宁波: 121.6, 温州: 120.7, 无锡: 120.3,
  佛山: 113.1, 东莞: 113.8, 泉州: 118.6, 潍坊: 119.1, 烟台: 121.4, 徐州: 117.2,
};

/** 命中结果：城市名回执给前端展示（「已识别：杭州 · 东经 120.2°」），不命中返回 undefined。 */
export interface CityMatch { city: string; longitude: number }

/**
 * 出生地字符串 → 城市经度。
 * 先精确匹配（「杭州市」「浙江杭州」去后缀后 === 杭州），再退到「输入含有城市名」。
 * 含有匹配按城市名长度降序取最长命中，避免「哈尔滨」被更短的城市名抢先。
 */
export function matchCity(place?: string | null): CityMatch | undefined {
  if (!place) return undefined;
  const s = place.replace(/[省市区县]|自治区|特别行政区/g, '').trim();
  // 单字输入无法可靠定位（「南」既可能是南京也可能是南昌/南宁），一律不校正。
  if (s.length < 2) return undefined;

  const exact = CITY_LNG[s];
  if (typeof exact === 'number') return { city: s, longitude: exact };

  // 最长命中优先：「黑龙江哈尔滨」既含「哈尔滨」也不含更短项时取「哈尔滨」；
  // 若某天表里同时有「南京」和「南京市郊」，长的那个更具体。
  let best: CityMatch | undefined;
  for (const [city, longitude] of Object.entries(CITY_LNG)) {
    if (!s.includes(city)) continue;
    if (!best || city.length > best.city.length) best = { city, longitude };
  }
  return best;
}

/** 兼容旧签名：只要经度。新代码请用 matchCity（能拿到命中的城市名做回执）。 */
export function cityLongitude(place?: string | null): number | undefined {
  return matchCity(place)?.longitude;
}
