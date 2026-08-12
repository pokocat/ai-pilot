// 锦囊 · 作品页（IA 重构第三刀，2026-08）。
//
// 分发铁律「第一次归军师，第二次起归锦囊」：本页**只放你已经有的**，不卖、不标价、不促销。
// 结构：①「最近做的」跨来源混排横滑流（检索职能）②「手艺」两列宫格（一门手艺一格）。
//
// 宫格由两份数据长出来，端上零写死类别清单：
//   - 固定子应用格（快出片 / 海报快印 / 方案报告）——作品数来自三条作品通道；
//   - 创意 agents 动态格——store.loadAgents() 里 type==='creative' 的每个 agent 一格，
//     运营侧上新一个创意军师，这里自动多一格，本文件不用改。
// 未启用的手艺是**置灰格**：不显示价格、不放开通按钮，点击把人带回总军师做导览
// （教育归军师，本页不卖；见 memory weapp-ia-redesign-2026-08）。
const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo } = require('../../services/nav');
const { baseData, syncTabBar } = require('../../services/page');
// mock 数据档案：只有 mock 包才渲染角标，非 mock 构建下这几行是死代码（留着无害）。
const mockProfile = require('../../services/mockProfile');

/** 分类型复出动词（文案铁律，不得改写）：海报「再来一张」、成片「再出一条」、方案「改一版」。 */
const TYPES = {
  poster: { label: '海报', verb: '再来一张', tagClass: 'pch-tag-poster', art: '/assets/craft/poster.jpg' },
  clip: { label: '成片', verb: '再出一条', tagClass: 'pch-tag-clip', art: '/assets/craft/clip.jpg' },
  report: { label: '方案', verb: '改一版', tagClass: 'pch-tag-report', art: '/assets/craft/report.jpg' },
};

/**
 * 固定子应用三格。插画（src/assets/craft/*.jpg，随 ASSET_ROOT 拷进产物，与头像同一条路子）
 * 只承担识别，卡体一律暖纸白卡；countKey 对应 load() 里三条通道的归一化结果。
 */
const CRAFT_APPS = [
  {
    key: 'app-clip', name: '快出片', art: '/assets/craft/clip.jpg', countKey: 'clip',
    roleLine: '你的分身替你出镜，念完稿就是一条能发的片',
    route: '/packages/video/home/index',
  },
  {
    key: 'app-poster', name: '海报快印', art: '/assets/craft/poster.jpg', countKey: 'poster',
    roleLine: '一句主张进去，一张能贴出去的海报出来',
    route: '/packages/work/gallery/index',
  },
  {
    key: 'app-report', name: '方案报告', art: '/assets/craft/report.jpg', countKey: 'report',
    roleLine: '军师定过的方案都在这，改一版留一版',
    route: '/packages/work/library/index',
  },
];
const AGENT_ART = '/assets/craft/agent.jpg';

function safeList(value) { return Array.isArray(value) ? value : []; }
function text(value) { return String(value == null ? '' : value).trim(); }
function at(value) { return Date.parse(text(value)) || 0; }

/** allSettled 的一路结果：成功给值，失败给 null——null 是「这格计数显示 —」的唯一信号。 */
function settled(result) { return result && result.status === 'fulfilled' ? result.value : null; }

/**
 * 归一化：三条来源各自的形状统一成一张作品小卡。
 * thumb 优先用真实成品图（海报签名图 / 成片抽帧），拿不到就落回该类型的插画——
 * 缺图不留空框（product-ui-completeness：missing media 必须有兜底）。
 */
function normalize(type, id, title, updatedAt, from, verbRoute, thumb) {
  const meta = TYPES[type];
  return {
    key: `${type}:${id}`,
    id, type, from,
    title: title || `未命名${meta.label}`,
    updatedAt,
    typeLabel: meta.label,
    typeClass: meta.tagClass,
    verb: meta.verb,
    verbRoute,
    thumb: thumb || meta.art,
    // 真图 404 / 签名过期时 binderror 换成插画，见 onThumbError。
    art: meta.art,
  };
}

/**
 * 海报（GET /creative/posters → CreativePosterListResult）。
 * 只收 succeeded：pending/running 还没有成品，摆进作品流会给出一句「再来一张」却无物可看。
 * 缩略图走 poster.previewUrl —— 600 秒签名链接，所以本页每次 onShow 都重新取数，不做缓存。
 */
function posterWorks(payload) {
  return safeList(payload && payload.items)
    .filter((row) => row && row.status === 'succeeded')
    .map((row) => normalize(
      'poster', text(row.jobId), text(row.headline),
      at(row.completedAt || row.createdAt), '海报快印',
      '/packages/work/poster/index',
      text(row.poster && row.poster.previewUrl),
    ));
}

/**
 * 成片（GET /video/works → ClipWork[]，裸数组）。
 * 只收 done/published：generating 是在跑的任务不是作品。时间取 generatedAt，历史行缺字段回落 createdAt。
 */
function clipWorks(payload) {
  // 端点当前回裸数组；`{ items }` 分支只为容错（成片走 aidrama 网关代理，别让一次包装改动白屏本页）。
  return safeList(Array.isArray(payload) ? payload : payload && payload.items)
    .filter((row) => row && (row.status === 'done' || row.status === 'published'))
    .map((row) => normalize(
      'clip', text(row.id), text(row.title),
      at(row.generatedAt || row.createdAt), '快出片',
      '/packages/video/home/index',
      text(row.thumbnailUrl),
    ));
}

/** 方案（GET /reports → ReportItem[]，裸数组）。出处取 agentName（服务端 include agent 后下发）。 */
function reportWorks(payload) {
  return safeList(payload)
    .filter((row) => row && text(row.id))
    .map((row) => normalize(
      'report', text(row.id), text(row.title),
      at(row.updatedAt), text(row.agentName) || '军师参谋部',
      `/packages/work/report/index?id=${encodeURIComponent(text(row.id))}`,
      '',
    ));
}

/**
 * 计数文案：null = 那一路取数失败，显示「—」而不是骗人的 0；
 * 游客态整行不渲染（wxml 判 authed），不摆一排「—」让人以为坏了。
 */
function countLine(count) {
  if (count == null) return '—';
  return count > 0 ? `${count} 件作品` : '还没有作品';
}

/**
 * 创意 agents 动态格。已启用 = owned 或 billing!=='unlock'。
 * 置灰格铁律：只搬名字/角色行/动词三样进 data，**price / billing 一律不带进页面**，
 * 页面因此没有任何可渲染的价格字段。
 */
function craftFromAgent(agent) {
  const key = text(agent.key);
  const name = text(agent.name) || '创意军师';
  const enabled = Boolean(agent.owned) || text(agent.billing) !== 'unlock';
  if (enabled) {
    return {
      key: `agent-${key}`, name, art: AGENT_ART, locked: false,
      roleLine: text(agent.role) || '创意手艺',
      metaLine: '接着做一件',
      route: `/packages/main/chat/index?agentKey=${encodeURIComponent(key)}&continue=1`,
    };
  }
  const send = encodeURIComponent(`军师还没带我用过「${name}」。先说说它能替我出什么、我现在的案卷用得上吗？`);
  return {
    key: `agent-${key}`, name, art: AGENT_ART, locked: true,
    roleLine: '还没一起用过',
    metaLine: '让军师带你做一次',
    route: `/packages/main/chat/index?agentKey=general&continue=1&send=${send}`,
  };
}

Page({
  data: baseData({
    authed: false, loading: false, loadFailed: false, showLogin: false,
    recent: [], crafts: [],
  }),
  onShow() {
    const state = store.snapshot();
    this.setData({
      themeClass: state.themeClass, colorKey: state.colorKey, isMock: state.mock,
      mockProfileLabel: state.mock ? mockProfile.label() : '',
      authed: state.authed,
    });
    syncTabBar(this, 2);
    this.load();
  },

  /**
   * 取数：agents + 三条作品通道一律 Promise.allSettled，任何一路失败都不拦页面。
   * 游客只取 agents（/agents 免登录可得），三条作品通道不请求——不能为了一格计数把人推去登录。
   */
  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true });
    const authed = store.isAuthed();
    const [agentsResult, postersResult, clipsResult, reportsResult] = await Promise.allSettled([
      store.loadAgents(),
      authed ? api.creativePosters(undefined, 20) : Promise.resolve(null),
      authed ? api.videoWorks() : Promise.resolve(null),
      authed ? api.reports() : Promise.resolve(null),
    ]);

    const posters = authed && settled(postersResult) ? posterWorks(settled(postersResult)) : null;
    const clips = authed && settled(clipsResult) ? clipWorks(settled(clipsResult)) : null;
    const reports = authed && settled(reportsResult) ? reportWorks(settled(reportsResult)) : null;
    const counts = {
      poster: posters ? posters.length : null,
      clip: clips ? clips.length : null,
      report: reports ? reports.length : null,
    };
    // 三条都塌了 = 网络/服务端问题，给一条可重试的提示条；只塌一条时各格自己显示「—」，不打扰。
    const loadFailed = authed && posters === null && clips === null && reports === null;
    const recent = []
      .concat(posters || [], clips || [], reports || [])
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10);

    const agents = safeList(settled(agentsResult) || store.snapshot().agents);
    const crafts = CRAFT_APPS
      .map((app) => ({
        key: app.key, name: app.name, art: app.art,
        locked: false, roleLine: app.roleLine, metaLine: countLine(counts[app.countKey]),
        route: app.route,
      }))
      .concat(agents.filter((agent) => agent && text(agent.type) === 'creative' && text(agent.key)).map(craftFromAgent));

    this.setData({ authed, recent, crafts, loadFailed, loading: false });
  },
  retry() { this.setData({ loadFailed: false }); this.load(); },

  /** 真实成品图取不到（签名过期 / 已清理）时换成该类型插画，不留破图。 */
  onThumbError(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.recent[index];
    if (!item || item.thumb === item.art) return;
    this.setData({ [`recent[${index}].thumb`]: item.art });
  },

  /** MOCK 角标即档案开关：切「经营中 / 空态」后重取本页数据（作品流与手艺格计数一起变）。 */
  switchMockProfile() {
    mockProfile.switchProfile(() => { this.setData({ mockProfileLabel: mockProfile.label() }); this.load(); });
  },

  requireLogin() {
    if (store.isAuthed()) return true;
    this.setData({ showLogin: true });
    return false;
  },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false, authed: true }); this.load(); },

  /** 作品小卡整卡即动词：海报去出图、成片去出片、方案去改版。 */
  openWork(event) {
    if (!this.requireLogin()) return;
    const item = this.data.recent[Number(event.currentTarget.dataset.index)];
    if (item && item.verbRoute) navTo(item.verbRoute);
  },
  /** 手艺格：正常格直接进手艺，置灰格回总军师做导览（本页不卖）。
      游客不拦——快出片等子应用对游客开放浏览、对话页游客可进（登录门铁律：
      浏览不拦，落库/扣费动作由目标页自己把守）。 */
  openCraft(event) {
    const item = this.data.crafts[Number(event.currentTarget.dataset.index)];
    if (item && item.route) navTo(item.route);
  },
  goBattle() { wx.switchTab({ url: '/pages/home/index' }); },
});
