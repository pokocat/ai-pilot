const { getToken, clearToken } = require('./token');
const { getApiBaseUrl } = require('./runtime-mode');

let onAuthLost = null;

function setAuthLostHandler(handler) {
  onAuthLost = typeof handler === 'function' ? handler : null;
}

function networkErrorInfo(errMsg, origin) {
  const msg = String(errMsg || '').toLowerCase();
  let reason = 'network';
  let message = '网络连接失败，请检查网络后重试。';
  if (/timeout|timed out|超时/.test(msg)) {
    reason = 'timeout'; message = '军师响应超时了，请稍后重试。';
  } else if (/abort|cancel|canceled|cancelled|取消/.test(msg)) {
    reason = 'cancelled'; message = '请求已取消。';
  } else if (/domain|合法域名|not in domain/.test(msg)) {
    reason = 'domain'; message = '服务连接配置还没生效，请稍后再试。';
  } else if (/ssl|certificate|cert|handshake|证书/.test(msg)) {
    reason = 'ssl'; message = '服务安全连接异常，请稍后再试。';
  } else if (/dns|resolve host|name resolution/.test(msg)) {
    reason = 'dns'; message = '暂时找不到服务地址，请稍后再试。';
  }
  return Object.assign(new Error(message), {
    code: 'NETWORK_ERROR',
    reason,
    technicalMessage: `${errMsg || 'wx.request failed'}; API: ${origin}`,
  });
}

function unauthorized(tokenAtRequest, data, isolatedAuth) {
  const hadToken = Boolean(tokenAtRequest);
  if (hadToken && !isolatedAuth) {
    clearToken();
    if (onAuthLost) onAuthLost();
  }
  return Object.assign(new Error((data && data.error) || '未登录'), {
    code: 'UNAUTHORIZED',
    data,
    hadToken,
  });
}

function parseBody(data) {
  if (typeof data !== 'string') return data;
  if (!data) return null;
  try { return JSON.parse(data); } catch (_) { return data; }
}

function request(path, options) {
  const opts = options || {};
  const method = opts.method || 'GET';
  const tokenAtRequest = opts.token === undefined ? getToken() : opts.token;
  const origin = opts.baseUrl || getApiBaseUrl();
  const url = `${origin}${path}`;
  const header = Object.assign({ 'content-type': 'application/json' }, opts.header || {});
  if (tokenAtRequest) header['x-user-id'] = tokenAtRequest;

  return new Promise((resolve, reject) => {
    wx.request({
      url,
      method,
      data: opts.data,
      header,
      timeout: opts.timeout || 30000,
      enableChunked: Boolean(opts.enableChunked),
      success(res) {
        const data = parseBody(res.data);
        if (res.statusCode === 401) { reject(unauthorized(tokenAtRequest, data, opts.isolatedAuth)); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const message = data && typeof data === 'object' && data.error
            ? data.error
            : `请求失败（${res.statusCode}）`;
          reject(Object.assign(new Error(message), {
            code: (data && data.code) || `HTTP_${res.statusCode}`,
            statusCode: res.statusCode,
            data,
          }));
          return;
        }
        resolve(data);
      },
      fail(error) { reject(networkErrorInfo(error && error.errMsg, origin)); },
    });
  });
}

function upload(path, filePath, formData, options) {
  const opts = options || {};
  const tokenAtRequest = getToken();
  const origin = opts.baseUrl || getApiBaseUrl();
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url: `${origin}${path}`,
      filePath,
      name: opts.name || 'file',
      formData: formData || {},
      header: tokenAtRequest ? { 'x-user-id': tokenAtRequest } : {},
      timeout: opts.timeout || 180000,
      success(res) {
        const data = parseBody(res.data);
        if (res.statusCode === 401) { reject(unauthorized(tokenAtRequest, data)); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(Object.assign(new Error((data && data.error) || `上传失败（${res.statusCode}）`), {
            code: (data && data.code) || `HTTP_${res.statusCode}`,
            statusCode: res.statusCode,
            data,
          }));
          return;
        }
        resolve(data);
      },
      fail(error) { reject(networkErrorInfo(error && error.errMsg, origin)); },
    });
    if (opts.onProgress) task.onProgressUpdate(opts.onProgress);
  });
}

module.exports = { request, upload, setAuthLostHandler, networkErrorInfo, unauthorized, parseBody };
