const COLORS = [
  { key: 'green', cn: '墨 绿', short: '墨绿', wm: '谋', seal: '绿', en: 'MO LÜ · VERDANT', verdict: '稳中求进，守正出奇。', accent: '#1E5A43' },
  { key: 'gold', cn: '财 金', short: '财金', wm: '势', seal: '金', en: 'CAI JIN · FORTUNE', verdict: '聚财为势，谋定而动。', accent: '#A07D2C' },
  { key: 'red', cn: '朱 砂', short: '朱砂', wm: '决', seal: '朱', en: 'ZHU SHA · CINNABAR', verdict: '当机立断，先发制人。', accent: '#9E2B25' },
  { key: 'blue', cn: '黛 蓝', short: '黛蓝', wm: '远', seal: '黛', en: 'DAI LAN · AZURE', verdict: '高瞻远瞩，运筹千里。', accent: '#1F4E79' },
  { key: 'purple', cn: '绛 紫', short: '绛紫', wm: '局', seal: '绛', en: 'JIANG ZI · AMETHYST', verdict: '格局为先，纳于无形。', accent: '#5B3A6B' },
  { key: 'iron', cn: '玄 铁', short: '玄铁', wm: '藏', seal: '玄', en: 'XUAN TIE · GRAPHITE', verdict: '大巧若拙，藏锋守拙。', accent: '#33373D' },
];

function colorIndex(key) {
  const index = COLORS.findIndex((color) => color.key === key);
  return index < 0 ? 0 : index;
}

function colorByKey(key) {
  return COLORS[colorIndex(key)];
}

function isColorKey(key) {
  return COLORS.some((color) => color.key === key);
}

module.exports = { COLORS, colorIndex, colorByKey, isColorKey };
