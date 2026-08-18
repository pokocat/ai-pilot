// 锦囊作品数据的模块级缓存：TTL + single-flight。
// execution 只读 posters；pouch 读 posters/clips/reports。两页先后进入时不得重复请求同一路。
const { api } = require('./api');
const { getToken } = require('./token');

const TTL_MS = 90000;
const slots = {
  posters: { scope: '', at: 0, value: null, inFlight: null },
  clips: { scope: '', at: 0, value: null, inFlight: null },
  reports: { scope: '', at: 0, value: null, inFlight: null },
};

function run(key, loader, options) {
  const slot = slots[key];
  const scope = String(getToken() || 'guest');
  if (slot.scope !== scope) {
    slot.scope = scope;
    slot.at = 0;
    slot.value = null;
    slot.inFlight = null;
  }
  const force = Boolean(options && options.force);
  if (!force && slot.value !== null && Date.now() - slot.at < TTL_MS) return Promise.resolve(slot.value);
  if (slot.inFlight) return slot.inFlight;
  const request = Promise.resolve().then(loader);
  slot.inFlight = request;
  return request.then((value) => {
    if (slot.scope !== scope || slot.inFlight !== request) return value;
    slot.value = value; slot.at = Date.now(); slot.inFlight = null;
    return value;
  }, (error) => {
    if (slot.scope === scope && slot.inFlight === request) slot.inFlight = null;
    throw error;
  });
}

function loadPosters(options) { return run('posters', () => api.creativePosters(undefined, 20), options); }
function loadClips(options) { return run('clips', () => api.videoWorks(), options); }
function loadReports(options) { return run('reports', () => api.reports(), options); }
function invalidate(key) {
  if (key && slots[key]) { slots[key].scope = ''; slots[key].at = 0; slots[key].value = null; slots[key].inFlight = null; return; }
  Object.values(slots).forEach((slot) => { slot.scope = ''; slot.at = 0; slot.value = null; slot.inFlight = null; });
}

module.exports = { TTL_MS, loadPosters, loadClips, loadReports, invalidate };
