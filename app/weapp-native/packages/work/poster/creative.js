const { getToken } = require('../../../services/token');
const { getApiBaseUrl } = require('../../../services/runtime-mode');

const LIMITS = {
  goal: 60,
  audience: 40,
  headline: 20,
  subheadline: 30,
  proofPoint: 20,
  cta: 15,
  visualDirection: 100,
};
const STAGES = ['philosophy', 'visual', 'render', 'upload'];
const PROGRESS_TEXT = {
  philosophy: '构思视觉',
  visual: '生成主视觉',
  render: '排版渲染',
  upload: '上传收尾',
};
const PENDING_KEY = 'junshi.poster.pending.v1';
const PENDING_TTL = 10 * 60 * 1000;

function progressText(progress) {
  return PROGRESS_TEXT[String(progress || '')] || '构思视觉';
}

function absoluteCreativeUrl(url) {
  const value = String(url || '').trim();
  if (!value || /^(https?:|data:|wxfile:)/i.test(value)) return value;
  const origin = String(getApiBaseUrl() || '').replace(/\/api\/?$/, '').replace(/\/$/, '');
  return `${origin}${value.startsWith('/') ? '' : '/'}${value}`;
}

function posterAsset(job) {
  const assets = job && Array.isArray(job.assets) ? job.assets : [];
  return assets.find((asset) => asset.kind === 'poster_png') || assets[0] || null;
}

function isInFlight(status) {
  return status === 'pending' || status === 'running';
}

function normalizeJob(raw) {
  const job = raw || {};
  const outputs = Array.isArray(job.outputs) ? job.outputs : [];
  const assets = Array.isArray(job.assets) ? job.assets : outputs.map((url, index) => ({ id: `legacy-${index}`, kind: 'poster_png', previewUrl: typeof url === 'string' ? url : url && (url.previewUrl || url.url) })).filter((item) => item.previewUrl);
  const status = ['pending', 'running', 'succeeded', 'failed', 'cancelled'].includes(job.status) ? job.status : 'failed';
  const actions = Array.isArray(job.actions) ? job.actions : (isInFlight(status) ? ['cancel'] : status === 'succeeded' ? ['revise', 'regenerate'] : ['regenerate']);
  return Object.assign({}, job, {
    id: String(job.id || ''), status, assets, actions,
    creditCost: Number(job.creditCost || 0), refunded: Boolean(job.refunded),
    // 缺省 false：服务端没说有本人照片就当没有（露出一个必然 422 的方向比不露更糟）。
    hasPortrait: job.hasPortrait === true,
    progress: STAGES.includes(job.progress) ? job.progress : (isInFlight(status) ? 'philosophy' : 'upload'),
  });
}

/**
 * ⚠️ 这个函数是**白名单**：没在这里显式搬过去的字段会被整个丢掉。
 * 2026-08-13 的教训：档位上线时只改了页面去读 `premiumAvailable` / `premiumPricePerPoster`，
 * 忘了这一层 —— 于是 `premiumOn` 恒为 false，原生端的档位选择器**一次都没渲染出来**，
 * 页面、契约、服务端全是对的，唯独中间这层悄悄把字段吃了。新增 status 字段必须同步改这里。
 */
function normalizeStatus(raw) {
  const status = raw || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    enabled: status.enabled !== false,
    pricePerPoster: num(status.pricePerPoster),
    premiumPricePerPoster: num(status.premiumPricePerPoster),
    // 缺省 false：服务端没说可用就当不可用（露出一个必然 422 的选项比不露更糟）。
    premiumAvailable: status.premiumAvailable === true,
    directions: Array.isArray(status.directions) ? status.directions.map((item) => Object.assign({}, item, {
      previewUrl: absoluteCreativeUrl(item && item.previewUrl),
    })) : [],
    templates: Array.isArray(status.templates) ? status.templates : [],
  };
}

/**
 * 军师推荐组合（PosterBriefDraft.recommendation）归一。**两端同一套判据**
 * （H5 在 app/src/services/creative.ts 的 normalizeRecommendation，逐条对照着写）。
 *
 * 只认「当前 status 清单里真存在」的组合：服务端保证下发那一刻合法，但用户可能停在本页，
 * 期间后台停用了某套版式 / 关掉了高级路线 —— 拿一个已停用的 key 当默认值，用户点「生成」必 422，
 * 而他压根没做过这个选择。任一项对不上就整条作废，页面回退现行为（按现逻辑预选 + 把选择器展开），
 * 不半信半疑地用一半。老服务端不下发这个字段时同样返回 null。
 */
function normalizeRecommendation(raw, context) {
  if (!raw || typeof raw !== 'object') return null;
  const ctx = context || {};
  const directions = Array.isArray(ctx.directions) ? ctx.directions : [];
  const templates = Array.isArray(ctx.templates) ? ctx.templates : [];
  // 高级路线不可用却推了高级：整条作废，不悄悄降标准 —— 降了之后方案卡上的价格与那句
  // 「军师为什么这么定」就对不上，用户看到的是一句解释配着另一档的价。
  if (raw.tier === 'premium' && ctx.premiumAvailable !== true) return null;
  const tier = raw.tier === 'premium' ? 'premium' : 'standard';
  const direction = directions.find((item) => item && item.key === raw.directionKey && item.tier === tier);
  const template = templates.find((item) => item && item.key === raw.templateKey);
  if (!direction || !template) return null;
  return { tier, directionKey: direction.key, templateKey: template.key, reason: String(raw.reason || '').trim() };
}

function newIdempotencyKey(prefix) {
  return `${prefix || 'poster'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function readPendingMap() {
  try {
    const raw = wx.getStorageSync(PENDING_KEY);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const now = Date.now();
    return Object.keys(parsed).reduce((result, key) => {
      const item = parsed[key];
      if (item && typeof item.idempotencyKey === 'string' && Number.isFinite(item.at) && now - item.at < PENDING_TTL) result[key] = item;
      return result;
    }, {});
  } catch (_) { return {}; }
}

function writePendingMap(value) {
  try {
    if (Object.keys(value).length) wx.setStorageSync(PENDING_KEY, value);
    else wx.removeStorageSync(PENDING_KEY);
  } catch (_) { /* storage 不可用时仅失去在途恢复，不影响服务端幂等 */ }
}

function posterScope(messageId, sessionId) {
  return `m:${messageId || ''}|s:${sessionId || ''}`;
}

function readPosterPending(scope) {
  return readPendingMap()[scope] || null;
}

function markPosterPending(scope, idempotencyKey) {
  if (!scope || !idempotencyKey) return;
  const current = readPendingMap();
  current[scope] = { idempotencyKey, jobId: current[scope] && current[scope].jobId, at: Date.now() };
  writePendingMap(current);
}

function attachPosterJob(scope, jobId) {
  const current = readPendingMap();
  if (!scope || !jobId || !current[scope]) return;
  current[scope] = Object.assign({}, current[scope], { jobId, at: Date.now() });
  writePendingMap(current);
}

function clearPosterPendingByJob(jobId) {
  const current = readPendingMap();
  let changed = false;
  Object.keys(current).forEach((scope) => {
    if (current[scope].jobId === jobId) { delete current[scope]; changed = true; }
  });
  if (changed) writePendingMap(current);
}

function fetchPosterFile(url) {
  const source = absoluteCreativeUrl(url);
  if (!source) return Promise.reject(new Error('成品图链接已失效'));
  if (source.startsWith('data:')) {
    try {
      const base64 = source.slice(source.indexOf(',') + 1);
      const path = `${wx.env.USER_DATA_PATH}/poster-${Date.now()}.png`;
      wx.getFileSystemManager().writeFileSync(path, base64, 'base64');
      return Promise.resolve(path);
    } catch (_) { return Promise.reject(new Error('当前环境不支持保存图片')); }
  }
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url: source,
      header: getToken() ? { 'x-user-id': getToken() } : {},
      success(result) {
        if (result.statusCode === 200 && result.tempFilePath) resolve(result.tempFilePath);
        else reject(new Error('成品图下载失败'));
      },
      fail: reject,
    });
  });
}

function formatTime(iso) {
  const date = new Date(iso || '');
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) return `今天 ${hm}`;
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? `${md} ${hm}` : `${date.getFullYear()}年${md}`;
}

module.exports = {
  LIMITS, STAGES, progressText, absoluteCreativeUrl, posterAsset, isInFlight,
  normalizeJob, normalizeStatus, normalizeRecommendation, newIdempotencyKey, posterScope, readPosterPending,
  markPosterPending, attachPosterJob, clearPosterPendingByJob, fetchPosterFile, formatTime,
};
