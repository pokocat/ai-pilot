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
    progress: STAGES.includes(job.progress) ? job.progress : (isInFlight(status) ? 'philosophy' : 'upload'),
  });
}

function normalizeStatus(raw) {
  const status = raw || {};
  return {
    enabled: status.enabled !== false,
    pricePerPoster: Number.isFinite(Number(status.pricePerPoster)) ? Number(status.pricePerPoster) : null,
    templates: Array.isArray(status.templates) ? status.templates : [],
  };
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
  normalizeJob, normalizeStatus, newIdempotencyKey, posterScope, readPosterPending,
  markPosterPending, attachPosterJob, clearPosterPendingByJob, fetchPosterFile, formatTime,
};
