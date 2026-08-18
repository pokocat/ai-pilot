const { getToken, clearToken } = require('./token');
const { getApiBaseUrl } = require('./runtime-mode');
const { httpErrorInfo } = require('./api-error');

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
  let authHandled = false;
  let staleAuth = false;
  if (hadToken && !isolatedAuth) {
    // 同一页面常会并发发出多条鉴权请求。第一条 401 清 token 后，其余旧请求仍会带着
    // tokenAtRequest 陆续返回；若每条都触发 onAuthLost，会连续 toast/reLaunch，看起来像闪退。
    // 更重要的是：旧请求若晚于一次新登录返回，绝不能把新 token 一并清掉。
    if (getToken() === tokenAtRequest) {
      clearToken();
      authHandled = true;
      if (onAuthLost) onAuthLost();
    } else {
      staleAuth = true;
    }
  }
  return Object.assign(new Error((data && data.error) || '未登录'), {
    code: 'UNAUTHORIZED',
    data,
    hadToken,
    authHandled,
    staleAuth,
  });
}

function decodeUtf8(bytes) {
  let out = ''; let index = 0;
  while (index < bytes.length) {
    const first = bytes[index++];
    if (first < 0x80) out += String.fromCharCode(first);
    else if (first < 0xe0) out += String.fromCharCode(((first & 0x1f) << 6) | (bytes[index++] & 0x3f));
    else if (first < 0xf0) out += String.fromCharCode(((first & 0x0f) << 12) | ((bytes[index++] & 0x3f) << 6) | (bytes[index++] & 0x3f));
    else {
      const point = ((first & 7) << 18) | ((bytes[index++] & 63) << 12) | ((bytes[index++] & 63) << 6) | (bytes[index++] & 63);
      const pair = point - 0x10000;
      out += String.fromCharCode(0xd800 + (pair >> 10), 0xdc00 + (pair & 1023));
    }
  }
  return out;
}

function parseBody(data) {
  let body = data;
  // enableChunked=true 的 4xx 在部分微信基础库里会把 JSON 响应作为 ArrayBuffer 交给 success；
  // 若不先解码，业务 code 会丢成 HTTP_402，端上只能显示「请求失败（402）」。
  if (typeof ArrayBuffer !== 'undefined' && body instanceof ArrayBuffer) body = decodeUtf8(new Uint8Array(body));
  else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(body)) {
    body = decodeUtf8(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  }
  if (typeof body !== 'string') return body;
  if (!body) return null;
  try { return JSON.parse(body); } catch (_) { return body; }
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
          const info = httpErrorInfo(res.statusCode, data, '请求');
          reject(Object.assign(new Error(info.message), {
            code: info.code || `HTTP_${res.statusCode}`,
            statusCode: res.statusCode,
            data,
            technicalMessage: info.technicalMessage,
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
  const tokenAtRequest = opts.token === undefined ? getToken() : opts.token;
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
          const info = httpErrorInfo(res.statusCode, data, '上传');
          reject(Object.assign(new Error(info.message), {
            code: info.code || `HTTP_${res.statusCode}`,
            statusCode: res.statusCode,
            data,
            technicalMessage: info.technicalMessage,
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

/** OSS PostObject 直传：完整 URL 由服务端短时票据给出，不附军师 JWT。 */
function directUpload(url, filePath, formData, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      url,
      filePath,
      name: opts.name || 'file',
      formData: formData || {},
      timeout: opts.timeout || 360000,
      success(res) {
        const data = parseBody(res.data);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(Object.assign(new Error('文件直传未完成，请稍后重试。'), {
            code: 'CLIP_DIRECT_UPLOAD_FAILED', statusCode: res.statusCode, data,
            technicalMessage: typeof res.data === 'string' ? res.data.slice(0, 500) : `HTTP ${res.statusCode}`,
          }));
          return;
        }
        resolve(data || { ok: true });
      },
      fail(error) { reject(networkErrorInfo(error && error.errMsg, String(url || '').match(/^https?:\/\/[^/]+/)?.[0] || 'direct-upload')); },
    });
    if (opts.onProgress) task.onProgressUpdate(opts.onProgress);
  });
}

module.exports = { request, upload, directUpload, setAuthLostHandler, networkErrorInfo, unauthorized, parseBody };
