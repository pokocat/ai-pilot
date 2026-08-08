const THEME_TONES = ['gold', 'green', 'red', 'blue', 'purple', 'iron'];

function normalizeTone(tone, colorKey) {
  // 历史页面把主题业务色写成 tone="green"（对应 SCSS 的 --green），而六套
  // 主题里 --green 本来就随 --accent 变化。这里把 green 与 accent 都解释为
  // “当前本命色”，避免红/蓝/紫/金/铁主题仍夹着固定墨绿图标。
  if (tone !== 'accent' && tone !== 'green') return tone || 'ink';
  let stored = '';
  try { stored = wx.getStorageSync('junshi.color'); } catch (_) { /* 使用属性兜底 */ }
  if (THEME_TONES.includes(colorKey) && colorKey !== 'green') return colorKey;
  if (THEME_TONES.includes(stored)) return stored;
  return THEME_TONES.includes(colorKey) ? colorKey : 'green';
}

Component({
  properties: {
    name: { type: String, value: '' },
    tone: { type: String, value: 'ink' },
    colorKey: { type: String, value: 'green' },
    size: { type: Number, value: 18 },
  },
  data: { src: '', iconStyle: '' },
  observers: {
    'name,tone,colorKey,size': function sync(name, tone, colorKey, size) {
      const resolved = normalizeTone(tone, colorKey);
      this.setData({
        src: name ? `/assets/native-icons/${name}-${resolved}.svg` : '',
        iconStyle: `width:${Number(size) || 18}px;height:${Number(size) || 18}px`,
      });
    },
  },
});
