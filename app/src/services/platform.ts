// 平台垫片 —— services 层与宿主运行时之间的唯一接缝。
//
// 为什么存在：services/（api、store、mock、token）原本直接 import Taro，于是任何想复用这套业务层的
// 宿主都被迫扛上整个 Taro 运行时。PC 工作台是纯 React DOM 应用，不该为了发一个 HTTP 请求装 Taro。
// 这里把「存储 / 请求 / 上传 / 提示 / 导航」五件事抽成接口，默认实现是纯 Web，
// Taro H5 宿主在启动时用 setPlatform 换成 Taro 版（保持移动端行为逐像素不变）。
//
// 存储格式必须与 Taro H5 一致：Taro 把值包成 {"data": <value>} 存进 localStorage。
// PC 与移动 H5 同源（aibuzz.cn），用户在手机网页登录后再开 PC 必须能读到同一个 token，
// 所以这里的 Web 实现照抄那层包装，不许图省事写裸值。

export interface HttpResponse {
  statusCode: number;
  data: unknown;
}

export interface HttpRequestOptions {
  url: string;
  method?: string;
  data?: unknown;
  header?: Record<string, string>;
  timeout?: number;
}

export interface UploadOptions {
  url: string;
  /** Web 传 File/Blob；小程序传临时文件路径字符串 */
  file: File | Blob | string;
  name: string;
  header?: Record<string, string>;
  formData?: Record<string, string>;
  timeout?: number;
}

export interface UploadHandle {
  /** 与 Taro.uploadFile 一致：既能 await 结果，也能中途 abort */
  promise: Promise<HttpResponse>;
  abort(): void;
  onProgress(cb: (percent: number) => void): void;
}

export interface ConfirmOptions {
  title: string;
  content: string;
  confirmText?: string;
  cancelText?: string;
}

export interface Platform {
  storage: {
    get(key: string): string;
    set(key: string, value: string): void;
    remove(key: string): void;
  };
  request(options: HttpRequestOptions): Promise<HttpResponse>;
  upload(options: UploadOptions): UploadHandle;
  /** 轻提示（移动端 Taro.showToast / PC 自绘 toast） */
  toast(message: string): void;
  /** 确认框：true=确认，false=取消 */
  confirm(options: ConfirmOptions): Promise<boolean>;
  /** 打开一个页面（移动端 navigateTo / PC 路由） */
  navigate(url: string): void;
  /** 重置到某页（移动端 reLaunch / PC 路由 replace） */
  relaunch(url: string): void;
}

/* ────────────────── 默认实现：纯 Web ────────────────── */

const hasWindow = typeof window !== 'undefined';

const webStorage: Platform['storage'] = {
  get(key) {
    if (!hasWindow) return '';
    try {
      const raw = window.localStorage.getItem(key);
      if (raw == null) return '';
      // Taro H5 写入的是 {"data": v}；裸值也兼容读（手工塞进来的、或别处写的）
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && 'data' in parsed) {
          const v = (parsed as { data: unknown }).data;
          return typeof v === 'string' ? v : JSON.stringify(v);
        }
      } catch { /* 不是 JSON，按裸值处理 */ }
      return raw;
    } catch { return ''; }
  },
  set(key, value) {
    if (!hasWindow) return;
    try { window.localStorage.setItem(key, JSON.stringify({ data: value })); } catch { /* 隐私模式/超配额 */ }
  },
  remove(key) {
    if (!hasWindow) return;
    try { window.localStorage.removeItem(key); } catch { /* noop */ }
  },
};

async function webRequest(o: HttpRequestOptions): Promise<HttpResponse> {
  const controller = new AbortController();
  const timer = o.timeout ? setTimeout(() => controller.abort(), o.timeout) : undefined;
  try {
    const method = (o.method || 'GET').toUpperCase();
    const hasBody = method !== 'GET' && method !== 'HEAD' && o.data !== undefined;
    const res = await fetch(o.url, {
      method,
      headers: { ...(hasBody ? { 'Content-Type': 'application/json' } : {}), ...(o.header || {}) },
      body: hasBody ? JSON.stringify(o.data) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : {}; } catch { /* 非 JSON 原样回传，交给调用方判 */ }
    return { statusCode: res.status, data };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function webUpload(o: UploadOptions): UploadHandle {
  // 用 XHR 而不是 fetch：要进度回调和 abort，fetch 的 upload 进度在浏览器里还没有标准支持。
  const xhr = new XMLHttpRequest();
  let onProgressCb: ((p: number) => void) | undefined;

  const promise = new Promise<HttpResponse>((resolve, reject) => {
    xhr.open('POST', o.url, true);
    Object.entries(o.header || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
    if (o.timeout) xhr.timeout = o.timeout;

    xhr.upload.onprogress = (e) => {
      if (onProgressCb && e.lengthComputable) onProgressCb(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      let data: unknown = xhr.responseText;
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch { /* 原样 */ }
      resolve({ statusCode: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error('上传失败'));
    xhr.ontimeout = () => reject(new Error('上传超时'));
    xhr.onabort = () => reject(new Error('已取消'));

    const form = new FormData();
    if (typeof o.file === 'string') {
      // Web 侧拿不到路径式文件；调用方传字符串说明宿主用错了实现。
      reject(new Error('Web 平台需要 File/Blob，收到的是路径字符串'));
      return;
    }
    form.append(o.name, o.file);
    Object.entries(o.formData || {}).forEach(([k, v]) => form.append(k, v));
    xhr.send(form);
  });

  return {
    promise,
    abort: () => xhr.abort(),
    onProgress: (cb) => { onProgressCb = cb; },
  };
}

const webPlatform: Platform = {
  storage: webStorage,
  request: webRequest,
  upload: webUpload,
  // 默认提示走 console：宿主没注册就退化成静默，不该因为缺一个 toast 就抛错打断业务。
  toast: (m) => { if (hasWindow) console.info('[toast]', m); },
  confirm: async (o) => (hasWindow ? window.confirm(`${o.title}\n${o.content}`) : false),
  navigate: (url) => { if (hasWindow) window.location.hash = url; },
  relaunch: (url) => { if (hasWindow) window.location.hash = url; },
};

/* ────────────────── 注册与取用 ────────────────── */

let current: Platform = webPlatform;

/** 宿主启动时调用；只覆盖传入的字段，其余保留 Web 默认实现。 */
export function setPlatform(impl: Partial<Platform>): void {
  current = { ...current, ...impl, storage: { ...current.storage, ...(impl.storage || {}) } };
}

export const platform = {
  get storage() { return current.storage; },
  request: (o: HttpRequestOptions) => current.request(o),
  upload: (o: UploadOptions) => current.upload(o),
  toast: (m: string) => current.toast(m),
  confirm: (o: ConfirmOptions) => current.confirm(o),
  navigate: (u: string) => current.navigate(u),
  relaunch: (u: string) => current.relaunch(u),
};
