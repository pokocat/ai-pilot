// 锦囊 · 作品页（IA 重构第三刀，2026-08）。
//
// 分发铁律「第一次归军师，第二次起归锦囊」：本页不卖、不标价、不促销。
// 结构：①「最近做的」跨来源混排横滑流（检索职能）②「手艺」两列宫格（一门手艺一格）。
//
// 2026-08-13 修订（拍板：**锦囊是能力大全**）：本页不再只是「你已经有的」的陈列架 ——
// 用户就是想做张海报时，这里要能一步开工。所以**已启用**的手艺格点击直接进"做一件"的入口，
// 不再先绕作品库。铁律的另一半没动：**未启用**的手艺仍然置灰、仍然把人交回军师
// （启用层 → 军师对话 → 军师带着做第一次），价格也仍然不出现在卡面上。
// 一句话：改的是「已经会了的怎么快速再做一次」，没改「第一次由谁带」，也没把这里变成货架。
//
// 宫格由两份数据长出来，端上零写死类别清单：
//   - 固定子应用格（快出片 / 海报快印 / 方案报告）——作品数来自三条作品通道；
//   - 创意 agents 动态格——store.loadAgents() 里 type==='creative' 的每个 agent 一格，
//     运营侧上新一个创意军师，这里自动多一格，本文件不用改。
// 未启用的手艺是**置灰格**：不显示价格、不放开通按钮，点击把人带回总军师做导览
// （教育归军师，本页不卖；见 memory weapp-ia-redesign-2026-08）。
const { api } = require('../../services/api');
const store = require('../../services/store');
const { navTo, gotoExecution } = require('../../services/nav');
const { baseData, backendEnvironmentData } = require('../../services/page');
const worksCache = require('../../services/works-cache');
// 开发版环境角标：mock 时同时充当数据档案开关。
const mockProfile = require('../../services/mockProfile');
const { withShare } = require('../../services/share');

/** 分类型复出动词（文案铁律，不得改写）：海报「再来一张」、成片「再出一条」、方案「改一版」。 */
const TYPES = {
  poster: { label: '海报', verb: '再来一张', tagClass: 'pch-tag-poster', art: '/assets/craft/poster.jpg' },
  clip: { label: '成片', verb: '再出一条', tagClass: 'pch-tag-clip', art: '/assets/craft/clip.jpg' },
  report: { label: '方案', verb: '改一版', tagClass: 'pch-tag-report', art: '/assets/craft/report.jpg' },
};

/**
 * 固定子应用三格。插画（src/assets/craft/*.jpg，随 ASSET_ROOT 拷进产物，与头像同一条路子）
 * 只承担识别，卡体一律暖纸白卡；countKey 对应 load() 里三条通道的归一化结果。
 *
 * ── `agentKey` / `worksRoute` 的由来（2026-08-13 拍板：锦囊是能力大全，要有快捷入口）──
 *
 * 带 `agentKey` 的格子（目前只有海报）与那位创意军师是**同一件事**，因此：
 *   · 该军师**未启用** → 本格置灰，点击开启用层 → 启用后由 agentUnlocked 带进他的对话。
 *     「第一次归军师」这条没变：没一起做过的手艺，仍然是军师带着做第一次。
 *   · 该军师**已启用** → 点击**直接进"做一张"的入口**（不再先经过作品库）。用户就是想做张海报时，
 *     锦囊要能一步开工，这是本页作为「能力大全」的职责。
 *   · 作品库不因此丢失入口：作品数那行（`metaLine`）是独立点击区，走 `worksRoute`。
 * 动态 agents 那边会把已被本表覆盖的 key 过滤掉，否则「海报快印」和「海报设计师」会并排出现两格。
 *
 * 没有 `agentKey` 的两格（快出片 / 方案报告）行为一字不变：它们本来就不是单个军师驱动的
 * ——成片走独立的 video 包，方案是任何军师对话都能产出的东西，硬绑一位军师是错的。
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
    agentKey: 'poster',
    // 落到**海报设计师的对话**，不是空白需求单。
    // 一张海报要成立，至少得知道「为什么出、给谁看」——这两件事只有问出来，问不出来的表单
    // 只能靠用户自己写商业目标和客群，而那正是他找军师的原因。所以快捷入口的"快"是
    // 「少点几下就能开口说需求」，不是「直接甩一张空表」。需求单仍然存在，由军师的成果卡带着
    // 预填进去（那条链路一直是这么设计的）。
    route: '/packages/main/chat/index?agentKey=poster&continue=1',
    worksRoute: '/packages/work/gallery/index',
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
 * 缩略图走 poster.previewUrl —— 600 秒签名链接，页面侧的 90 秒缓存远在有效期内（见 load 注释）。
 */
function posterWorks(payload) {
  return safeList(payload && payload.items)
    .filter((row) => row && row.status === 'succeeded')
    .map((row) => normalize(
      'poster', text(row.jobId), text(row.headline),
      at(row.completedAt || row.createdAt), '海报快印',
      // 「再来一张」落到**这张海报的详情页**，不是空白需求单：那里的「改文字」（不扣钻）与
      // 「换方向」（重新创作、按本单路线再扣一次）都带着上一版的完整上下文，
      // 而空白需求单等于让用户把刚做过的一张从头再描述一遍。
      `/packages/work/posterJob/index?jobId=${encodeURIComponent(text(row.jobId))}`,
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
  // 未启用：卡面仍然不带价格（货架铁律），但点击要能真正走到启用——
  // agentKey 留着给 agent-unlock 用，启用成功后由它带进这位军师的对话（= 军师带你做第一次）。
  return {
    key: `agent-${key}`, name, art: AGENT_ART, locked: true,
    agentKey: key,
    roleLine: '还没一起用过',
    metaLine: '让军师带你做一次',
    route: '',
  };
}

Page(withShare({
  data: baseData({
    authed: false, loading: false, loadFailed: false, showLogin: false,
    recent: [], crafts: [], unlockAgent: null,
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
   * 取数：agents + 三条作品通道一律 Promise.allSettled，任何一路失败都不拦页面。
   * 游客只取 agents（/agents 免登录可得），三条作品通道不请求——不能为了一格计数把人推去登录。
   *
   * 90 秒内再次进入锦囊直接用上一次结果（`force=true` 跳过，用于启用/切档案后的主动刷新）。
   * 动因：`/video/works` 是服务端到 aidrama 的**同步代理**（上游预算 15–60s），且不在
   * server 过载闸 MAX_IN_FLIGHT 的豁免名单里；普通页每次重进都会新建页面实例，若无模块缓存就会再打一次
   * 会把在途槽位耗在等外部上游上，拖累无关的快接口。海报缩略图是 600 秒签名链接，90 秒缓存远在有效期内。
   * 正解是服务端把 BFF 代理排除在过载计数外，已记 AGENTS §13。
   */
  async load(options) {
    if (this.data.loading) return;
    // 游客态整页只出一屏登录引导，不取任何数（连 /agents 都不用——宫格根本不渲染）。
    if (!store.isAuthed()) { this.setData({ authed: false, recent: [], crafts: [], loadFailed: false, loading: false }); return; }
    const force = Boolean(options && options.force);
    this.setData({ loading: true });
    const authed = store.isAuthed();
    const [agentsResult, postersResult, clipsResult, reportsResult] = await Promise.allSettled([
      store.loadAgents(),
      authed ? worksCache.loadPosters({ force }) : Promise.resolve(null),
      authed ? worksCache.loadClips({ force }) : Promise.resolve(null),
      authed ? worksCache.loadReports({ force }) : Promise.resolve(null),
    ]);

    const posters = authed && settled(postersResult) ? posterWorks(settled(postersResult)) : null;
    const clips = authed && settled(clipsResult) ? clipWorks(settled(clipsResult)) : null;
    const reports = authed && settled(reportsResult) ? reportWorks(settled(reportsResult)) : null;
    const counts = {
      poster: posters ? posters.length : null,
      clip: clips ? clips.length : null,
      report: reports ? reports.length : null,
    };
    // 任一通道塌了就提示可重试：只塌一条时作品流会静默残缺（少一类作品，用户看不出是漏了还是没有），
    // 各格的「—」只说明这一格没数，说不清整页缺了东西。
    const loadFailed = authed && (posters === null || clips === null || reports === null);
    const recent = []
      .concat(posters || [], clips || [], reports || [])
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 10);

    const agents = safeList(settled(agentsResult) || store.snapshot().agents);
    // 原始 agent 留一份索引给启用层用（价格只在 agent-unlock 那一刻出现，不进卡面 data）。
    this._agentsByKey = Object.fromEntries(agents.filter((item) => item && text(item.key)).map((item) => [text(item.key), item]));
    // 被固定格覆盖的军师不再另出一格：否则「海报快印」和「海报设计师」并排出现，
    // 名字不同、落点不同，用户分不清哪个是"做一张海报"。
    const covered = new Set(CRAFT_APPS.map((app) => app.agentKey).filter(Boolean));
    const crafts = CRAFT_APPS
      .map((app) => {
        const agent = app.agentKey ? this._agentsByKey[app.agentKey] : null;
        // ★ 有成品 = 已经一起用过（2026-08-14 走查后加）。此前只看目录的 owned/billing，
        //   结果同一屏自相矛盾：上面「最近做的」摆着这门手艺出的海报、写着「出自 · 海报快印」，
        //   下面这一格却置灰写「还没一起用过」，点下去弹的是**付费启用层**。
        //   自己已经有的资产，任何情况下都不许被收费闸挡在外面。
        const hasWorks = counts[app.countKey] > 0;
        // 没有 agentKey 的格子恒可用（快出片 / 方案报告，本来就不由单个军师驱动）。
        // 有 agentKey 却在目录里查不到（/agents 挂了）→ **按未启用处理**，不臆断成已启用：
        // 直接放行会让人点进确认页，提交时才撞 403 AGENT_LOCKED，那时钻石已经在扣费路径上了。
        const unlocked = !app.agentKey
          || hasWorks
          || Boolean(agent && (agent.owned || text(agent.billing) !== 'unlock'));
        if (!unlocked) {
          return {
            key: app.key, name: app.name, art: app.art, locked: true, agentKey: app.agentKey,
            roleLine: '还没一起用过', metaLine: '让军师带你做一次', route: '', worksRoute: '',
          };
        }
        // ★ 落点按**有没有作品**分（2026-08-14 真机走查后改）：
        //   有作品 → 点整卡进作品库，先让人看见自己已有的资产（「锦囊只放你已经有的」这条铁律的本意），
        //            「再做一张」退成卡内那行小字去对话；
        //   零作品 → 点整卡进对话（那时作品库是个空页，先进去只是白跑一趟）。
        //   上一版一律进对话、作品库只挂在一行下划线小字上 —— 结果是卡上明写着「看 1 件作品」，
        //   点下去却进了聊天窗，用户找不到以前生成的图。主路径必须通向卡面正在承诺的那件事。
        const worksRoute = hasWorks ? (app.worksRoute || '') : '';
        return {
          key: app.key, name: app.name, art: app.art,
          locked: false, roleLine: app.roleLine,
          // 卡内那行小字始终指向**主路径之外**的那一个：进了作品库就给「再做一张」，反之给作品数。
          metaLine: worksRoute ? '再做一张' : countLine(counts[app.countKey]),
          route: worksRoute || app.route,
          worksRoute: worksRoute ? app.route : '',
        };
      })
      .concat(agents
        .filter((agent) => agent && text(agent.type) === 'creative' && text(agent.key) && !covered.has(text(agent.key)))
        .map(craftFromAgent));

    this.setData({ authed, recent, crafts, loadFailed, loading: false });
  },
  retry() { this.setData({ loadFailed: false }); this.load({ force: true }); },
  askLogin() { this.requireLogin(); },

  /** 真实成品图取不到（签名过期 / 已清理）时换成该类型插画，不留破图。 */
  onThumbError(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.recent[index];
    if (!item || item.thumb === item.art) return;
    this.setData({ [`recent[${index}].thumb`]: item.art });
  },

  /**
   * 手艺插画取不到（资源没打进产物、路径写错）时收起 image，留 .pch-art 的纸底占位。
   * 本地资源理论上不会 404，但确认页的档位插画就是这么丢的（引了 /assets/tier/*.jpg，
   * src/assets 下压根没这个目录）——同类风险摆在这里，兜底比"理论上不会"可靠。
   */
  onCraftArtError(event) {
    const index = Number(event.currentTarget.dataset.index);
    const item = this.data.crafts[index];
    if (!item || !item.art) return;
    this.setData({ [`crafts[${index}].art`]: '' });
  },

  /** MOCK 角标即档案开关：切「经营中 / 空态」后重取本页数据（作品流与手艺格计数一起变）。 */
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

  /** 作品小卡整卡即动词：海报去出图、成片去出片、方案去改版。 */
  openWork(event) {
    if (!this.requireLogin()) return;
    const item = this.data.recent[Number(event.currentTarget.dataset.index)];
    if (item && item.verbRoute) navTo(item.verbRoute);
  },
  /** 手艺格：已启用的直接进手艺；未启用的开启用层（价格只在这一刻出现，卡面永不标价），
      启用成功后由 agentUnlocked 带进这位军师的对话——第一次仍然是军师带着做。
      浏览不拦游客；启用是扣费动作，需要登录。 */
  openCraft(event) {
    const item = this.data.crafts[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    if (item.locked && item.agentKey) {
      if (!this.requireLogin()) return;
      const agent = this._agentsByKey && this._agentsByKey[item.agentKey];
      if (agent) { this.setData({ unlockAgent: agent }); return; }
      // 目录没取到这位军师（/agents 挂了）：locked 格的 route 是空串，再往下走会点了没反应。
      wx.showToast({ title: '军师目录没读到，下拉重试一次', icon: 'none' });
      return;
    }
    if (item.route) navTo(item.route);
  },
  /**
   * 作品数那行的独立点击区（catchtap，不冒泡给 openCraft）。
   * 手艺格主体改成"做一件"之后，作品库就靠这行进——没有 worksRoute 的格子（没作品、
   * 或压根没配作品库）落回主体行为，不能让用户点了一行没反应。
   */
  openWorks(event) {
    const item = this.data.crafts[Number(event.currentTarget.dataset.index)];
    if (!item) return;
    if (item.worksRoute) { navTo(item.worksRoute); return; }
    this.openCraft(event);
  },
  closeUnlock() { this.setData({ unlockAgent: null }); },
  agentUnlocked(event) {
    const agent = event.detail && event.detail.agent;
    this.setData({ unlockAgent: null });
    if (!agent || !agent.key) { this.load({ force: true }); return; }
    this.load({ force: true });
    navTo(`/packages/main/chat/index?agentKey=${encodeURIComponent(agent.key)}&continue=1`);
  },
  back() {
    try { if (getCurrentPages().length > 1) { wx.navigateBack(); return; } } catch (_) { /* fall through */ }
    gotoExecution('today');
  },
  goExecution() { gotoExecution('today'); },
}));
