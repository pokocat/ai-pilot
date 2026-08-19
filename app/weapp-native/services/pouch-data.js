// 锦囊数据的唯一事实源：三条作品通道的归一化 + 手艺行。
//
// 2026-08-19 IA 第四刀（B + E3）：锦囊主体内联进今日页尾，跨手艺档案留一个子页。
// 于是同一份「作品 + 手艺」数据要在两处各渲染一次：
//   · pages/execution —— 页尾锦囊段（一门手艺一行，作品挂在这门手艺下半格）
//   · pages/pouch     —— 跨手艺档案（搜索 + 类型筛选 + 时间分组的作品墙）
// 抄第二份必然漂移（分类动词、置灰口径、计数文案是三处铁律），所以拆到这里。
//
// 铁律照旧，改结构不改规矩：
//   · 卡面永不出现价格 —— 本模块不搬 price / billing 进任何返回值；
//   · 未启用的手艺置灰、交回军师（启用层 → 军师对话），第一次仍由军师带；
//   · 复出动词按类型固定：海报「再来一张」、成片「再出一条」、方案「改一版」。
const store = require('./store');
const worksCache = require('./works-cache');

/** 分类型复出动词（文案铁律，不得改写）。 */
const TYPES = {
  poster: { label: '海报', verb: '再来一张', tagClass: 'pch-tag-poster', art: '/assets/craft/poster.jpg' },
  clip: { label: '成片', verb: '再出一条', tagClass: 'pch-tag-clip', art: '/assets/craft/clip.jpg' },
  report: { label: '方案', verb: '改一版', tagClass: 'pch-tag-report', art: '/assets/craft/report.jpg' },
};

/**
 * 固定子应用三格 = 三条作品通道，一门手艺一行。
 *
 * `makeVerb` / `makeRoute` 是行上半格那个按钮（开工）；`worksVerb` / `unit` / `worksRoute`
 * 是行下半格那条作品带（看已有的）。两个落点上下分家，不再像旧宫格那样挤在一张卡上靠猜
 * ——旧版整卡的落点还随「有没有作品」反转，2026-08 走查的主要投诉就是这个。
 *
 * 方案报告的 makeRoute 落到总军师对话而不是需求单：方案是任何军师对话都能产出的东西，
 * 硬绑一位创意军师是错的（与 makeCommand 同一条路子）。
 */
const CRAFT_APPS = [
  {
    key: 'app-poster', type: 'poster', name: '海报快印', art: '/assets/craft/poster.jpg',
    roleLine: '一句主张进去，一张能贴出去的海报出来',
    agentKey: 'poster',
    makeVerb: '做一张', makeRoute: '/packages/main/chat/index?agentKey=poster&continue=1',
    worksVerb: '出过', unit: '张', worksRoute: '/packages/work/gallery/index',
  },
  {
    key: 'app-clip', type: 'clip', name: '快出片', art: '/assets/craft/clip.jpg',
    roleLine: '你的分身替你出镜，念完稿就是一条能发的片',
    makeVerb: '做一条', makeRoute: '/packages/video/home/index',
    worksVerb: '出过', unit: '条', worksRoute: '/packages/video/works/index',
  },
  {
    key: 'app-report', type: 'report', name: '方案报告', art: '/assets/craft/report.jpg',
    roleLine: '军师定过的方案都在这，改一版留一版',
    makeVerb: '写一份', makeRoute: '/packages/main/chat/index?agentKey=general&continue=1',
    worksVerb: '存了', unit: '份', worksRoute: '/packages/work/library/index',
  },
];
const AGENT_ART = '/assets/craft/agent.jpg';

function safeList(value) { return Array.isArray(value) ? value : []; }
function text(value) { return String(value == null ? '' : value).trim(); }
function at(value) { return Date.parse(text(value)) || 0; }

/** allSettled 的一路结果：成功给值，失败给 null——null 是「这一路没读到」的唯一信号。 */
function settled(result) { return result && result.status === 'fulfilled' ? result.value : null; }

/**
 * 归一化：三条来源各自的形状统一成一张作品小卡。
 * thumb 优先真实成品图（海报签名图 / 成片抽帧），拿不到落回该类型插画——
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
    art: meta.art,
  };
}

/**
 * 海报（GET /creative/posters → CreativePosterListResult）。
 * 只收 succeeded：pending/running 还没有成品，摆进作品流会给出一句「再来一张」却无物可看。
 * 缩略图走 poster.previewUrl —— 600 秒签名链接，works-cache 的 90 秒缓存远在有效期内。
 */
function posterWorks(payload) {
  return safeList(payload && payload.items)
    .filter((row) => row && row.status === 'succeeded')
    .map((row) => normalize(
      'poster', text(row.jobId), text(row.headline),
      at(row.completedAt || row.createdAt), '海报快印',
      // 「再来一张」落到这张海报的详情页，不是空白需求单：那里的「改文字」与「换方向」
      // 都带着上一版的完整上下文，空白需求单等于让人把刚做过的一张从头再描述一遍。
      `/packages/work/posterJob/index?jobId=${encodeURIComponent(text(row.jobId))}`,
      text(row.poster && row.poster.previewUrl),
    ));
}

/**
 * 成片（GET /video/works → ClipWork[]，裸数组）。
 * 只收 done/published：generating 是在跑的任务不是作品。时间取 generatedAt，历史行缺字段回落 createdAt。
 */
function clipWorks(payload) {
  // 端点当前回裸数组；`{ items }` 分支只为容错（成片走 aidrama 网关代理，别让一次包装改动白屏）。
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
 * 每一路作品的状态是三态，不是两态 —— 所有消费方都要能分辨：
 *   数组      = 读到了（空数组＝真的一件都没有）
 *   null      = 读失败（绝不能说成「你还没有」，空态 vs 读失败不许混）
 *   undefined = 还没取（快慢双通道里慢通道未落地，此时什么都不许声称）
 */
function tally(feed) {
  const failed = [];
  const counts = {};
  for (const type of ['poster', 'clip', 'report']) {
    const rows = type === 'poster' ? feed.posters : type === 'clip' ? feed.clips : feed.reports;
    if (rows === null) failed.push(type);
    counts[type] = rows === undefined ? undefined : rows === null ? null : rows.length;
  }
  return Object.assign({}, feed, { counts, failed, pending: feed.clips === undefined ? ['clip'] : [] });
}

/**
 * 取作品。任何一路失败都不拦其余两路（allSettled）。
 *
 * `skipClips` 是给今日页快通道用的：`/video/works` 是服务端到 aidrama 的同步代理，
 * 端上预算 12s（服务端 10s 上游上限；`/api/video/` 已于 2026-08-12 从过载闸豁免，
 * 所以它不再拖累别的接口，但它自己仍然慢）。今日页首屏的汇总行不能吊在这 12s 上，
 * 于是先用海报 + 方案渲染，成片由 loadClips 单独补（见 pages/execution 的 loadClipChannel）。
 *
 * 90 秒模块级缓存来自 works-cache：两页先后进入时不重复打同一路。
 */
async function loadFeed(options) {
  if (!store.isAuthed()) {
    return tally({ authed: false, posters: [], clips: [], reports: [] });
  }
  const force = Boolean(options && options.force);
  const skipClips = Boolean(options && options.skipClips);
  const [postersResult, clipsResult, reportsResult] = await Promise.allSettled([
    worksCache.loadPosters({ force }),
    skipClips ? Promise.resolve(undefined) : worksCache.loadClips({ force }),
    worksCache.loadReports({ force }),
  ]);
  return tally({
    authed: true,
    posters: settled(postersResult) ? posterWorks(settled(postersResult)) : null,
    clips: skipClips ? undefined : (settled(clipsResult) ? clipWorks(settled(clipsResult)) : null),
    reports: settled(reportsResult) ? reportWorks(settled(reportsResult)) : null,
  });
}

/** 慢通道单独取：成片。返回数组或 null（失败），由 applyClips 合回 feed。 */
async function loadClips(options) {
  if (!store.isAuthed()) return [];
  try { return clipWorks(await worksCache.loadClips(options)); } catch (_) { return null; }
}

function applyClips(feed, clips) {
  return tally(Object.assign({}, feed, { clips }));
}

/** 跨来源混排，按时间倒序。读失败的那一路不参与（它的缺席由 feed.failed 交代）。 */
function mergeWorks(feed) {
  return []
    .concat((feed && feed.posters) || [], (feed && feed.clips) || [], (feed && feed.reports) || [])
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function worksOf(feed, type) {
  if (!feed) return null;
  if (type === 'poster') return feed.posters;
  if (type === 'clip') return feed.clips;
  return feed.reports;
}

/**
 * 那一路没读到就直说「没读出来」并给重试，不写骗人的 0，也不写一个没人看得懂的「—」
 * （旧宫格用的就是「—」：它只说明这一格没数，说不清是没有还是没读到）。
 */
const LOAD_FAILED_TEXT = '没读出来 · 重试';
function countText(app, count) {
  if (count === undefined) return '';   // 还没取到，这一行整条不出现，什么都不声称
  if (count === null) return LOAD_FAILED_TEXT;
  return count > 0 ? `${app.worksVerb} ${count} ${app.unit}` : '';
}

/**
 * 今日页尾锦囊段的手艺行。
 *
 * 未启用（locked）判定沿用旧宫格那套，一个字没松：
 *   · 没有 agentKey 的行恒可用（快出片 / 方案报告本来就不由单个军师驱动）；
 *   · 有成品 = 已经一起用过 —— 自己已有的资产任何情况下都不许被收费闸挡在外面；
 *   · 有 agentKey 却在目录里查不到（/agents 挂了）→ 按未启用处理，不臆断成已启用：
 *     放行会让人点进确认页、提交时才撞 403 AGENT_LOCKED，那时钻石已经在扣费路径上了。
 *
 * 创意 agents 只出上半格（开工），不挂作品带：它们的产出是方案，已经归在「方案报告」那一行，
 * 再按 agentName 数一遍就成了同一份东西在两行各算一次。
 */
function buildCraftRows(agents, feed) {
  const list = safeList(agents);
  const byKey = Object.fromEntries(list.filter((item) => item && text(item.key)).map((item) => [text(item.key), item]));
  const covered = new Set(CRAFT_APPS.map((app) => app.agentKey).filter(Boolean));
  const counts = (feed && feed.counts) || {};

  const rows = CRAFT_APPS.map((app) => {
    const agent = app.agentKey ? byKey[app.agentKey] : null;
    const count = counts[app.type];
    const hasWorks = count > 0;
    const unlocked = !app.agentKey
      || hasWorks
      || Boolean(agent && (agent.owned || text(agent.billing) !== 'unlock'));
    if (!unlocked) {
      return {
        key: app.key, name: app.name, art: app.art, locked: true, agentKey: app.agentKey,
        roleLine: '还没一起用过', makeVerb: '军师带一次', makeRoute: '',
        works: [], worksText: '', worksRoute: '', hint: '',
      };
    }
    const works = (worksOf(feed, app.type) || []).slice(0, 3).map((item) => ({ key: item.key, thumb: item.thumb, art: item.art }));
    return {
      key: app.key, name: app.name, art: app.art, locked: false, agentKey: '',
      roleLine: app.roleLine,
      makeVerb: app.makeVerb, makeRoute: app.makeRoute,
      works,
      worksText: countText(app, count),
      // 有作品才给作品带落点；一件都没有时点进去是个空页，白跑一趟。
      worksRoute: hasWorks ? app.worksRoute : '',
      // 「还没出过」只在确实读到 0 时说；undefined（没取到）时不出这一行。
      hint: count === 0 ? `还没出过东西 · 做完第一${app.unit}就收在这行` : '',
    };
  });

  return rows.concat(list
    .filter((agent) => agent && text(agent.type) === 'creative' && text(agent.key) && !covered.has(text(agent.key)))
    .map((agent) => {
      const key = text(agent.key);
      const enabled = Boolean(agent.owned) || text(agent.billing) !== 'unlock';
      return {
        key: `agent-${key}`, name: text(agent.name) || '创意军师', art: AGENT_ART,
        locked: !enabled, agentKey: enabled ? '' : key,
        roleLine: enabled ? (text(agent.role) || '创意手艺') : '还没一起用过',
        makeVerb: enabled ? '做一件' : '军师带一次',
        makeRoute: enabled ? `/packages/main/chat/index?agentKey=${encodeURIComponent(key)}&continue=1` : '',
        works: [], worksText: '', worksRoute: '', hint: '',
      };
    }));
}

module.exports = {
  TYPES, CRAFT_APPS, LOAD_FAILED_TEXT,
  posterWorks, clipWorks, reportWorks,
  loadFeed, loadClips, applyClips, mergeWorks, buildCraftRows,
};
