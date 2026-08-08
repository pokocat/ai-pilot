const ICONS = new Set([
  'home', 'grid', 'agent', 'user', 'chat', 'insight', 'attach', 'arrow', 'up', 'plus',
  'alert', 'trend', 'check', 'target', 'layers', 'doc', 'image', 'video', 'pen', 'spark',
  'chart', 'clock', 'flow', 'bolt', 'shield', 'crown', 'flag', 'token', 'pouch', 'upload',
  'lock', 'diamond', 'phone', 'wechat', 'group', 'square',
]);

function str(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function arr(value) { return Array.isArray(value) ? value : []; }
function strList(value) { return arr(value).map(str).filter(Boolean); }

// 与 Taro services/deliverableSection.ts 的 cardSection 同口径：
// 类型化 section 先降级成卡片稳定可读的 h / b / list，再交给 WXML 渲染。
function cardSection(section) {
  const s = section && typeof section === 'object' ? section : {};
  const cell = (value) => (typeof value === 'string' ? value : str(value && value.text));
  switch (s.type) {
    case 'hero': return { h: str(s.h), b: strList(s.paras).join('\n\n') };
    case 'callout': return { h: `【${str(s.tone)}】${str(s.h)}`, b: str(s.b) };
    case 'stats': return { h: str(s.h) || '关键数据', list: arr(s.items).map((item) => `${str(item && item.num)}${str(item && item.unit)} · ${str(item && item.label)}`) };
    case 'roster': return { h: str(s.h) || '人物', b: str(s.intro), list: arr(s.people).map((person) => `${str(person && person.name)}${person && person.role ? `（${str(person.role)}）` : ''}：${str(person && person.desc)}`) };
    case 'table': return { h: str(s.h) || '对比', list: [strList(s.headers).join(' / '), ...arr(s.rows).map((row) => arr(row).map(cell).join(' / '))] };
    case 'phases': return { h: str(s.h) || '分步打法', list: arr(s.items).flatMap((item) => [`〔${str(item && item.tab)}〕${str(item && item.h)}${item && item.when ? ` · ${str(item.when)}` : ''}`, ...strList(item && item.actions).map((action) => `· ${action}`), ...(item && item.kpi ? [`军令状：${str(item.kpi)}`] : [])]) };
    case 'timeline': return { h: str(s.h) || '时间节奏', list: arr(s.items).map((item) => `${str(item && item.when)}　${str(item && item.h)}${item && item.d ? `：${str(item.d)}` : ''}`) };
    case 'quote': return { h: '金句', b: `「${str(s.text)}」` };
    case 'letter': return { h: '军师手书', b: [str(s.salute), ...strList(s.paras), str(s.close), str(s.sign)].filter(Boolean).join('\n\n') };
    case 'gauge': return { h: `评分 ${s.score == null ? 0 : str(s.score)}/100${s.verdict ? ` ${str(s.verdict)}` : ''}`, list: arr(s.items).map((item) => `${str(item && item.label)} ${str(item && item.score)}分${item && item.note ? ` ${str(item.note)}` : ''}`) };
    case 'matrix': return { h: str(s.h) || '四象限', list: arr(s.quads).filter((quad) => quad && (quad.title || strList(quad.items).length)).map((quad) => `${str(quad.title)}${quad.tone ? `（${str(quad.tone)}）` : ''}：${strList(quad.items).join('、')}`) };
    case 'gantt': return { h: str(s.h) || '排期', list: arr(s.rows).map((row) => `${str(row && row.label)}　第${str(row && row.from)}-${str(row && row.to)}${str(s.unit) || '周'}${row && row.note ? ` · ${str(row.note)}` : ''}`) };
    default: return { h: str(s.h), b: str(s.b), list: Array.isArray(s.list) ? strList(s.list) : undefined };
  }
}

function stripInlineMarks(value) {
  return str(value)
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/==([^=\n]+)==/g, '$1')
    .replace(/!!([^!\n]+)!!/g, '$1')
    .replace(/##([^#\n]+)##/g, '$1');
}

function displayText(value) {
  return stripInlineMarks(value).replace(/^\s*[-*+]\s+/gm, '');
}

function normalizeReport(value) {
  const report = value && typeof value === 'object' ? value : {};
  return {
    icon: ICONS.has(str(report.icon)) ? str(report.icon) : 'doc',
    title: stripInlineMarks(report.title) || '军师方案',
    meta: displayText(report.meta),
    trust: displayText(report.trust),
    creativeJobId: str(report.creativeJobId),
    sections: arr(report.sections).map((section, index) => {
      const normalized = cardSection(section);
      return {
        key: `section-${index}`,
        h: stripInlineMarks(normalized.h),
        b: displayText(normalized.b),
        list: strList(normalized.list).map(displayText).filter(Boolean),
      };
    }),
  };
}

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    report: { type: Object, value: null },
    fallbackText: { type: String, value: '' },
    streaming: { type: Boolean, value: false },
    operable: { type: Boolean, value: false },
    saved: { type: Boolean, value: false },
    accepting: { type: Boolean, value: false },
    busy: { type: Boolean, value: false },
    posterEnabled: { type: Boolean, value: false },
    posterPrice: { type: Number, value: 0 },
    colorKey: { type: String, value: 'green' },
  },
  data: { card: normalizeReport(null) },
  observers: {
    report(value) { this.setData({ card: normalizeReport(value) }); },
  },
  methods: {
    emitAction(name) {
      if (!this.data.operable || this.data.streaming || this.data.busy) return;
      this.triggerEvent(name);
    },
    viewReport() { this.emitAction('viewreport'); },
    openMenu() { this.emitAction('menu'); },
    saveReport() { if (!this.data.saved) this.emitAction('save'); },
    generatePoster() {
      if (!this.data.posterEnabled) return;
      this.emitAction('poster');
    },
    viewPoster() {
      if (!this.data.card.creativeJobId) return;
      this.emitAction('viewposter');
    },
    acceptReport() {
      if (this.data.accepting) return;
      this.emitAction('accept');
    },
  },
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { cardSection, normalizeReport, stripInlineMarks };
}
