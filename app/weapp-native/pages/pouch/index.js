// 锦囊 · 跨手艺档案（IA 第四刀，2026-08-19）。
//
// 本页从「能力大全 + 陈列架」收成单一职能：**按时间翻你做过的每一件**。
// 手艺（开工）已经搬到今日页尾的锦囊段，这里不再出现手艺宫格、也不再有启用层——
// 一页两个职能是上一版落点混乱的根源（同一张卡两个点击区，落点还随有没有作品反转）。
//
// 为什么还留这一页：今日页里每门手艺只露 3 张缩略图，回答的是「这门手艺出过什么」；
// 而人找东西常常是「上周那张图」，压根记不得是哪门手艺出的。跨手艺、按时间、能搜能筛的
// 那份清单只能有一个地方放，就是这里。入口是今日页锦囊段末尾那行。
//
// 分发铁律没变：本页不卖、不标价、不促销，只有「再来一张 / 再出一条 / 改一版」。
const store = require('../../services/store');
const { navTo, gotoExecution } = require('../../services/nav');
const { baseData, backendEnvironmentData } = require('../../services/page');
const pouchData = require('../../services/pouch-data');
const worksCache = require('../../services/works-cache');
// 开发版环境角标：mock 时同时充当数据档案开关。
const mockProfile = require('../../services/mockProfile');
const { withShare } = require('../../services/share');

/** 首屏先给 8 件，其余收在「更早的 N 件」后面——档案页会越长越长，不能一次全渲染。 */
const FIRST_PAGE = 8;
const TYPE_TABS = [
  { key: 'all', label: '全部' },
  { key: 'report', label: '方案' },
  { key: 'poster', label: '海报' },
  { key: 'clip', label: '成片' },
];
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function today() { return dateKey(new Date()); }
function dayKey(offset) { const date = new Date(); date.setDate(date.getDate() + Number(offset || 0)); return dateKey(date); }
function pad(value) { return String(value).padStart(2, '0'); }

/** 时间戳 → 这一件属于哪一组，以及行尾那个时间的说法（今天给点钟、本周给星期、更早给日期）。 */
function bucketOf(updatedAt) {
  const date = new Date(updatedAt);
  const key = dateKey(date);
  if (key === today()) return { group: 'today', label: '今 天', time: `${pad(date.getHours())}:${pad(date.getMinutes())}` };
  if (key >= dayKey(-6)) return { group: 'week', label: '本 周', time: `周${WEEK_CN[date.getDay()]}` };
  return { group: 'earlier', label: '更 早', time: `${date.getMonth() + 1} 月 ${date.getDate()} 日` };
}

/** 搜索只在标题和出处上做，端上本地过滤：作品总量是几十件级别，不值得为它加一个搜索接口。 */
function matches(work, query) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return String(work.title || '').toLowerCase().indexOf(needle) >= 0
    || String(work.from || '').toLowerCase().indexOf(needle) >= 0;
}

function groupWorks(works) {
  const order = ['today', 'week', 'earlier'];
  const buckets = new Map();
  for (const work of works) {
    const bucket = bucketOf(work.updatedAt);
    if (!buckets.has(bucket.group)) buckets.set(bucket.group, { key: bucket.group, label: bucket.label, items: [] });
    buckets.get(bucket.group).items.push(Object.assign({ time: bucket.time }, work));
  }
  return order.filter((key) => buckets.has(key)).map((key) => buckets.get(key));
}

Page(withShare({
  data: baseData({
    authed: false, loading: false, loadFailed: false, showLogin: false,
    query: '', typeIndex: 0, tabs: TYPE_TABS.map((tab) => Object.assign({ text: tab.label }, tab)),
    groups: [], total: 0, hiddenCount: 0, expanded: false, filtered: false, empty: false,
  }),
  onShow() {
    const state = store.snapshot();
    this.setData(Object.assign({
      themeClass: state.themeClass, colorKey: state.colorKey, isMock: state.mock,
      mockProfileLabel: state.mock ? mockProfile.label() : '',
      authed: state.authed,
    }, backendEnvironmentData()));
    this.load();
  },

  /**
   * 三条作品通道一并取，任何一路失败都不拦其余两路（顶部出重试条点名说明缺了什么）。
   * 归一化与缓存都在 services/pouch-data —— 今日页尾的锦囊段读的是同一份，不许在这里再抄一遍。
   */
  async load(options) {
    if (this.data.loading) return;
    // 游客态整页只出一屏登录引导，不取任何数：锦囊装的是你自己的成品，游客本来只能看到一排空架子。
    if (!store.isAuthed()) { this.setData({ authed: false, groups: [], loadFailed: false, loading: false }); return; }
    this.setData({ loading: true });
    let feed = null;
    try { feed = await pouchData.loadFeed(options); } catch (_) { feed = null; }
    if (!feed) { this.setData({ loading: false, loadFailed: true }); return; }
    this._works = pouchData.mergeWorks(feed);
    this._counts = feed.counts;
    this.setData({
      authed: true, loading: false,
      // 只塌一条时作品流会静默残缺（少一类作品，用户看不出是漏了还是没有），所以照样提示可重试。
      loadFailed: feed.failed.length > 0,
    });
    this.applyView();
  },

  /** 过滤 + 分组 + 折叠，纯本地计算：切筛选、打字都不重新取数。 */
  applyView() {
    const works = this._works || [];
    const counts = this._counts || {};
    const type = TYPE_TABS[this.data.typeIndex] ? TYPE_TABS[this.data.typeIndex].key : 'all';
    const query = String(this.data.query || '').trim();
    const matched = works.filter((work) => (type === 'all' || work.type === type) && matches(work, query));
    const shown = this.data.expanded ? matched : matched.slice(0, FIRST_PAGE);
    // 那一路没读出来时不给数字：写个少算了一类的数比不写更糟。
    const tabs = TYPE_TABS.map((tab) => {
      const count = tab.key === 'all'
        ? (Object.values(counts).some((value) => value == null) ? null : works.length)
        : counts[tab.key];
      return Object.assign({ text: count == null ? tab.label : `${tab.label} ${count}` }, tab);
    });
    this.setData({
      tabs, groups: groupWorks(shown), total: matched.length,
      hiddenCount: Math.max(0, matched.length - shown.length),
      filtered: Boolean(query) || type !== 'all',
      empty: !matched.length,
    });
  },

  inputQuery(event) { this.setData({ query: String(event.detail.value || ''), expanded: false }); this.applyView(); },
  clearQuery() { this.setData({ query: '', expanded: false }); this.applyView(); },
  selectType(event) {
    const index = Number(event.currentTarget.dataset.index) || 0;
    if (index === this.data.typeIndex) return;
    this.setData({ typeIndex: index, expanded: false });
    this.applyView();
  },
  expand() { this.setData({ expanded: true }); this.applyView(); },
  resetFilters() { this.setData({ query: '', typeIndex: 0, expanded: false }); this.applyView(); },
  retry() { this.setData({ loadFailed: false }); this.load({ force: true }); },
  askLogin() { this.requireLogin(); },

  /** 真实成品图取不到（签名过期 / 已清理）时换成该类型插画，不留破图。 */
  onThumbError(event) {
    const { group, item } = event.currentTarget.dataset;
    const row = this.data.groups[Number(group)] && this.data.groups[Number(group)].items[Number(item)];
    if (!row || row.thumb === row.art) return;
    this.setData({ [`groups[${group}].items[${item}].thumb`]: row.art });
  },

  /** MOCK 角标即档案开关：切「经营中 / 空态」后重取本页数据。 */
  switchMockProfile() {
    if (!this.data.isMock) return;
    mockProfile.switchProfile(() => { this.setData({ mockProfileLabel: mockProfile.label() }); worksCache.invalidate(); this.load({ force: true }); });
  },

  requireLogin() {
    if (store.isAuthed()) return true;
    this.setData({ showLogin: true });
    return false;
  },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false, authed: true }); this.load({ force: true }); },

  /** 整卡即动词：海报去出图、成片去出片、方案去改版。 */
  openWork(event) {
    if (!this.requireLogin()) return;
    const { group, item } = event.currentTarget.dataset;
    const row = this.data.groups[Number(group)] && this.data.groups[Number(group)].items[Number(item)];
    if (row && row.verbRoute) navTo(row.verbRoute);
  },
  back() {
    try { if (getCurrentPages().length > 1) { wx.navigateBack(); return; } } catch (_) { /* fall through */ }
    gotoExecution('today');
  },
  goExecution() { gotoExecution('today'); },
}));
