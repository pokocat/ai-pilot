const { api, isMock } = require('../../../services/api');
const store = require('../../../services/store');
const { baseData } = require('../../../services/page');
const { fitCanvasText } = require('../../../utils/canvas-text');

const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const FALLBACK_ORDERS = [
  { text: '上传近 30 天成交漏斗表', tag: '待补' },
  { text: '重做案例证明', tag: '今日' },
  { text: '只投 3 个高意向主题', tag: '本周' },
];

function safeText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function textList(value) {
  return Array.isArray(value) ? value.map(safeText).filter(Boolean) : [];
}

function cellText(value) {
  if (typeof value === 'string') return value;
  return safeText(value && value.text);
}

function cardSection(section) {
  const item = section || {};
  switch (item.type) {
    case 'hero': return { h: safeText(item.h), b: textList(item.paras).join('\n\n') };
    case 'callout': return { h: `${item.tone ? `【${safeText(item.tone)}】` : ''}${safeText(item.h)}`, b: safeText(item.b) };
    case 'stats': return { h: safeText(item.h) || '关键数据', list: (item.items || []).map((v) => `${safeText(v && v.num)}${safeText(v && v.unit)} · ${safeText(v && v.label)}`) };
    case 'roster': return { h: safeText(item.h) || '人物', b: safeText(item.intro), list: (item.people || []).map((v) => `${safeText(v && v.name)}${v && v.role ? `（${safeText(v.role)}）` : ''}：${safeText(v && v.desc)}`) };
    case 'table': return { h: safeText(item.h) || '对比', list: [textList(item.headers).join(' / ')].concat((item.rows || []).map((row) => (row || []).map(cellText).join(' / '))).filter(Boolean) };
    case 'phases': return { h: safeText(item.h) || '分步打法', list: (item.items || []).reduce((all, v) => all.concat([`〔${safeText(v && v.tab)}〕${safeText(v && v.h)}${v && v.when ? ` · ${safeText(v.when)}` : ''}`], textList(v && v.actions), v && v.kpi ? [`军令状：${safeText(v.kpi)}`] : []), []) };
    case 'timeline': return { h: safeText(item.h) || '时间节奏', list: (item.items || []).map((v) => `${safeText(v && v.when)}　${safeText(v && v.h)}${v && v.d ? `：${safeText(v.d)}` : ''}`) };
    case 'quote': return { h: '金句', b: `「${safeText(item.text)}」` };
    case 'letter': return { h: '军师手书', b: [safeText(item.salute)].concat(textList(item.paras), [safeText(item.close), safeText(item.sign)]).filter(Boolean).join('\n\n') };
    case 'gauge': return { h: `评分 ${Number(item.score || 0)}/100${item.verdict ? ` ${safeText(item.verdict)}` : ''}`, list: (item.items || []).map((v) => `${safeText(v && v.label)} ${safeText(v && v.score)}分${v && v.note ? ` ${safeText(v.note)}` : ''}`) };
    case 'matrix': return { h: safeText(item.h) || '四象限', list: (item.quads || []).filter((v) => v && (v.title || textList(v.items).length)).map((v) => `${safeText(v.title)}${v.tone ? `（${safeText(v.tone)}）` : ''}：${textList(v.items).join('、')}`) };
    case 'gantt': return { h: safeText(item.h) || '排期', list: (item.rows || []).map((v) => `${safeText(v && v.label)}　第${safeText(v && v.from)}-${safeText(v && v.to)}${safeText(item.unit) || '周'}${v && v.note ? ` · ${safeText(v.note)}` : ''}`) };
    default: return { h: safeText(item.h || item.title), b: safeText(item.b || item.content), list: textList(item.list) };
  }
}

function cleanMarkdown(text) {
  return safeText(text)
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?/g, ''))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(^|\s)[#>*_`~=]+/g, '$1')
    .trim();
}

function sectionText(section) {
  const value = cardSection(section);
  return [value.b].concat(value.list || []).filter(Boolean).join('；');
}

function normalizeSections(sections) {
  return (Array.isArray(sections) ? sections : []).map((section, index) => {
    const value = cardSection(section);
    return {
      no: CN[index] || String(index + 1),
      h: cleanMarkdown(value.h) || `第 ${index + 1} 节`,
      b: cleanMarkdown(value.b),
      list: (value.list || []).map(cleanMarkdown).filter(Boolean),
      raw: section,
    };
  });
}

function fmtTime(iso) {
  const date = new Date(iso || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function normalizeDetail(raw) {
  const detail = raw || {};
  const versions = (detail.versions || []).map((version, index) => ({
    id: version.id || `version-${version.version || index + 1}`,
    version: Number(version.version || index + 1),
    atText: fmtTime(version.at || version.createdAt),
    changeSummary: safeText(version.changeSummary) || '本版方案已存档',
    authorText: version.authorKind === 'user' ? '你保存' : '顾问产出',
  }));
  const currentVersion = Number(detail.currentVersion || (versions.length ? versions[versions.length - 1].version : 1));
  if (!versions.length) versions.push({ id: 'version-1', version: currentVersion, atText: fmtTime(detail.createdAt), changeSummary: '本版方案已存档', authorText: '顾问产出' });
  return Object.assign({}, detail, { title: safeText(detail.title) || '方案详情', currentVersion, versions });
}

function normalizeContent(raw, detail, version) {
  const result = raw || {};
  const deliverable = result.content && typeof result.content === 'object' ? result.content : result;
  const sections = normalizeSections(deliverable.sections || result.sections);
  return {
    title: safeText(result.title || deliverable.title || (detail && detail.title)) || '军师方案',
    meta: safeText(deliverable.meta || result.meta || (detail && detail.type)) || '军师参谋部',
    trust: cleanMarkdown(deliverable.trust),
    version: Number(result.version || version || 1),
    sections,
    raw: Object.assign({}, deliverable, {
      title: safeText(deliverable.title || result.title || (detail && detail.title)) || '军师方案',
      sections: sections.map((item) => item.raw),
    }),
  };
}

function badgeLabel(change) {
  return ({ added: '新增', removed: '删除', changed: '修改', unchanged: '未变' })[change] || '变更';
}

function normalizeDiff(raw) {
  const diff = raw || {};
  return {
    from: Number(diff.from || 1),
    to: Number(diff.to || 1),
    summary: safeText(diff.summary) || '版本差异如下',
    sections: (diff.sections || []).map((section, index) => {
      const basis = section.after || section.before || {};
      return {
        id: `${section.change || 'changed'}-${index}`,
        change: section.change || 'changed',
        badge: badgeLabel(section.change),
        title: safeText(section.h) || cardSection(basis).h || `第 ${index + 1} 节`,
        words: (section.words || []).map((word, wordIndex) => ({ id: `${index}-${wordIndex}`, t: word.t || 'eq', s: safeText(word.s) })),
        beforeText: cleanMarkdown(sectionText(section.before)),
        afterText: cleanMarkdown(sectionText(section.after)),
        text: cleanMarkdown(sectionText(section.after || section.before)),
      };
    }),
  };
}

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function ordersForToday(casefile) {
  return casefile && Array.isArray(casefile.orders)
    ? casefile.orders.filter((order) => order.date === today()).map((order) => ({ text: order.text, tag: order.dueAt || order.tag || '待执行' }))
    : [];
}

function extractOrders(deliverable, agentName) {
  const candidates = normalizeSections(deliverable && deliverable.sections)
    .reduce((all, section) => all.concat(section.list), [])
    .map((text) => text.replace(/^[-·•]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 3);
  return (candidates.length ? candidates : FALLBACK_ORDERS.map((item) => item.text)).map((text, index) => ({
    id: `mock-report-order-${Date.now()}-${index}`,
    text,
    from: agentName || '军师',
    tag: '军令 · 方案',
    date: today(),
    done: false,
  }));
}

function mockAccept(deliverable, detail) {
  const token = wx.getStorageSync('junshi.userId') || 'guest';
  const key = `junshi.dossier.${token}`;
  let current = null;
  try {
    const raw = wx.getStorageSync(key);
    current = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch (_) { current = null; }
  const created = extractOrders(deliverable, detail.agentName);
  const casefile = Object.assign({
    id: `mock-casefile-${Date.now()}`,
    createdAt: new Date().toISOString(),
    risks: [], backfill: {}, orders: [],
  }, current || {}, {
    title: detail.title,
    sourceAgent: detail.agentName || '军师',
    updatedAt: new Date().toISOString(),
    judgment: sectionText(deliverable.sections && deliverable.sections[0]) || detail.title,
  });
  const old = (casefile.orders || []).filter((order) => order.date !== today());
  casefile.orders = created.concat(old);
  wx.setStorageSync(key, JSON.stringify(casefile));
  return { casefile, newOrders: created.length };
}

function maskSensitive(text) {
  return safeText(text)
    .replace(/https?:\/\/[^\s，。、；;）)】]+/gi, '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')
    .replace(/\d{11}/g, '已隐去')
    .replace(/[¥￥$]?\d[\d,，.]*\s*(万|亿|元|美元|美金|块|%|％|倍|人|单|家|店)/g, `已隐去$1`);
}

function wxAsync(name, options) {
  return new Promise((resolve, reject) => {
    const method = wx[name];
    if (typeof method !== 'function') { reject(new Error(`当前微信版本不支持 ${name}`)); return; }
    method(Object.assign({}, options || {}, { success: resolve, fail: reject }));
  });
}

Page({
  data: baseData({
    id: '', title: '方案', loading: true, failed: false, detail: null,
    versions: [], selectedVersion: 0, mode: 'content',
    verLoading: false, verErr: false, content: null, diff: null,
    synced: false, syncing: false, syncOpen: false, syncOrders: FALLBACK_ORDERS,
    sharePath: '', shareBusy: false, showLogin: false,
  }),

  onLoad(options) {
    this._variantSeq = 0;
    this.setData({ id: safeText(options && options.id) });
    if (!store.isAuthed()) {
      this.setData({ loading: false, showLogin: true });
      return;
    }
    this.loadDetail();
  },

  onUnload() { this._variantSeq += 1; },
  back() { wx.navigateBack({ fail: () => wx.navigateTo({ url: '/packages/work/library/index' }) }); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.loadDetail(); },

  async loadDetail() {
    const id = this.data.id;
    if (!id) { this.setData({ loading: false, failed: true }); return; }
    this.setData({ loading: true, failed: false });
    try {
      const detail = normalizeDetail(await api.report(id));
      this.setData({ detail, title: detail.title, versions: detail.versions, selectedVersion: detail.currentVersion, loading: false });
      await Promise.all([this.loadVariant(), this.checkSynced(detail)]);
    } catch (error) {
      store.handleApiError(error, { silent: true });
      this.setData({ loading: false, failed: true, detail: null });
    }
  },

  async checkSynced(detail) {
    try {
      const result = await api.raw('/casefile', 'GET');
      const casefile = result && (result.casefile || result);
      const orders = ordersForToday(casefile);
      if (casefile && casefile.title === detail.title && orders.length) this.setData({ synced: true, syncOrders: orders });
    } catch (_) { /* 同步检测不阻断阅读 */ }
  },

  selectVersion(event) {
    const version = Number(event.currentTarget.dataset.version);
    if (!version || version === this.data.selectedVersion) return;
    this.setData({ selectedVersion: version });
    this.loadVariant();
  },

  setMode(event) {
    const mode = event.currentTarget.dataset.mode === 'diff' ? 'diff' : 'content';
    if (mode === this.data.mode) return;
    this.setData({ mode });
    this.loadVariant();
  },

  retryVariant() { this.loadVariant(); },

  async loadVariant() {
    const id = this.data.id;
    const version = Number(this.data.selectedVersion);
    if (!id || !version) return;
    const seq = ++this._variantSeq;
    this.setData({ verLoading: true, verErr: false });
    try {
      if (this.data.mode === 'diff') {
        const raw = await api.reportDiff(id, Math.max(1, version - 1), version);
        if (seq !== this._variantSeq) return;
        this.setData({ diff: normalizeDiff(raw), verLoading: false });
      } else {
        const raw = await api.reportVersion(id, version);
        if (seq !== this._variantSeq) return;
        this.setData({ content: normalizeContent(raw, this.data.detail, version), verLoading: false });
      }
    } catch (error) {
      if (seq !== this._variantSeq) return;
      store.handleApiError(error, { silent: true });
      this.setData({ verLoading: false, verErr: true });
    }
  },

  async sync() {
    if (this.data.syncing) return;
    this.setData({ syncing: true });
    try {
      let content = this.data.content;
      if (!content || content.version !== this.data.selectedVersion) content = normalizeContent(await api.reportVersion(this.data.id, this.data.selectedVersion), this.data.detail, this.data.selectedVersion);
      let result;
      if (isMock()) result = mockAccept(content.raw, this.data.detail);
      else result = await api.raw('/casefile/accept', 'POST', { deliverable: content.raw, agentName: this.data.detail.agentName || '军师' });
      const orders = ordersForToday(result && result.casefile);
      this.setData({ synced: true, syncOpen: true, syncOrders: orders.length ? orders : FALLBACK_ORDERS });
    } catch (error) {
      store.handleApiError(error, { fallbackTitle: '同步失败，请重试' });
    } finally {
      this.setData({ syncing: false });
    }
  },

  closeSync() { this.setData({ syncOpen: false }); },
  stopTap() {},
  goStudio() { this.setData({ syncOpen: false }); wx.switchTab({ url: '/pages/home/index' }); },

  async shareImage() {
    if (this.data.shareBusy) return;
    this.setData({ shareBusy: true });
    wx.showLoading({ title: '生成分享图' });
    try {
      let content = this.data.content;
      if (!content || content.version !== this.data.selectedVersion) content = normalizeContent(await api.reportVersion(this.data.id, this.data.selectedVersion), this.data.detail, this.data.selectedVersion);
      const ctx = wx.createCanvasContext('reportShareCanvas', this);
      ctx.setFillStyle('#FBFAF6'); ctx.fillRect(0, 0, 600, 900);
      ctx.setFillStyle('#1E5A43'); ctx.fillRect(0, 0, 600, 250);
      ctx.setTextAlign('center'); ctx.setFillStyle('#D9C48A'); ctx.setFontSize(21); ctx.fillText('军师参谋部 · 军师献策', 300, 58);
      ctx.setFillStyle('#FFFFFF');
      const titleLayout = fitCanvasText(ctx, maskSensitive(content.title), { maxWidth: 504, maxLines: 4, maxFontSize: 36, minFontSize: 18 });
      const titleTop = 132 - Math.max(0, titleLayout.lines.length - 1) * titleLayout.lineHeight / 2;
      titleLayout.lines.forEach((line, index) => ctx.fillText(line, 300, titleTop + index * titleLayout.lineHeight));
      const titleBottom = titleTop + Math.max(0, titleLayout.lines.length - 1) * titleLayout.lineHeight;
      ctx.setFillStyle('rgba(255,255,255,.72)'); ctx.setFontSize(18); ctx.fillText('锦囊概要 · 机密已隐去', 300, Math.max(188, Math.min(218, titleBottom + 38)));
      ctx.setTextAlign('left');
      let y = 320;
      content.sections.slice(0, 3).forEach((section, index) => {
        ctx.setFillStyle('#1E5A43'); ctx.setFontSize(22); ctx.fillText(`${CN[index]}　${maskSensitive(section.h).slice(0, 18)}`, 48, y);
        ctx.setFillStyle('#565C63'); ctx.setFontSize(17);
        const text = maskSensitive(section.b || section.list[0] || '完整判断已在军师参谋部备好。').replace(/\s+/g, ' ');
        for (let line = 0; line < 2; line += 1) {
          const part = Array.from(text).slice(line * 25, (line + 1) * 25).join('');
          if (part) ctx.fillText(part, 48, y + 38 + line * 30);
        }
        y += 150;
      });
      ctx.setStrokeStyle('#E7E4DB'); ctx.beginPath(); ctx.moveTo(48, 810); ctx.lineTo(552, 810); ctx.stroke();
      ctx.setFillStyle('#8A8570'); ctx.setFontSize(15); ctx.fillText('完整方案请回到军师小程序查看', 48, 850);
      await new Promise((resolve) => ctx.draw(false, resolve));
      const path = await new Promise((resolve, reject) => wx.canvasToTempFilePath({ canvasId: 'reportShareCanvas', width: 600, height: 900, destWidth: 1200, destHeight: 1800, success: (res) => resolve(res.tempFilePath), fail: reject }, this));
      this.setData({ sharePath: path });
    } catch (_) {
      wx.showToast({ title: '生成分享图失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ shareBusy: false });
    }
  },

  closeShare() { this.setData({ sharePath: '' }); },
  async shareFriend() {
    const path = this.data.sharePath;
    if (!path) return;
    try { await wxAsync('showShareImageMenu', { path }); this.closeShare(); }
    catch (_) { wx.showToast({ title: '暂时打不开转发，可先存相册', icon: 'none' }); }
  },
  async saveShare() {
    const path = this.data.sharePath;
    if (!path) return;
    try { await wxAsync('saveImageToPhotosAlbum', { filePath: path }); this.closeShare(); wx.showToast({ title: '已保存到相册', icon: 'success' }); }
    catch (_) { wx.showToast({ title: '保存失败，请检查相册权限', icon: 'none' }); }
  },
});
