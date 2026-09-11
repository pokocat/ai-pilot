// 爱速拍运营台的 API 客户端。
//
// 打的是军师 BFF 的 /admin/video/*（那九条接口 2026-09-11 就已经在生产上了），
// 鉴权复用同一套后台账号体系 —— 账号中心是一个，不给爱速拍再造一套登录。
// 服务端对非超管要求 quickreel 授权（services/adminProductGate.ts），
// 所以「谁能进这个台」由军师后台「经营 · 产品」里的授权决定，不在这儿另开一张表。
import type {
  AdminAuthResult, AdminLoginRequest, AdminMe,
  AdminClipOpsView, AdminClipHoldListView, AdminClipReconcileResult,
  ClipAdminTemplate, ClipGenerationPricing, ClipGenerationPricingUpdate,
  ClipTemplateFromProject, ClipVendorOverview, ClipClonePricing,
} from '../../shared/contracts';

export type {
  AdminMe, AdminClipOpsView, AdminClipHoldListView, AdminClipReconcileResult,
  ClipAdminTemplate, ClipGenerationPricing, ClipGenerationPricingUpdate,
  ClipTemplateFromProject, ClipVendorOverview, ClipClonePricing,
};
export type AdminClipHoldItem = AdminClipHoldListView['items'][number];

const BASE = '/api';
const KEY = 'quickreel-console-token';

export function getToken(): string {
  try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; }
}
export function setToken(v: string) {
  try { localStorage.setItem(KEY, v); } catch { /* 隐私模式下存不进去：这一次会话仍可用 */ }
}
export function clearToken() {
  try { localStorage.removeItem(KEY); } catch { /* 同上 */ }
}

/** 401 要能被 App 认出来，好把人送回登录页，而不是弹一个看不懂的错误。 */
export class Unauthorized extends Error {
  constructor() { super('登录已过期，请重新登录'); }
}

async function call<T>(path: string, method = 'GET', body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const t = getToken();
    if (t) headers['x-admin-token'] = t;
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // 网络层失败与「服务端说不行」是两件事，文案不能一样：
    // 前者多半是本机断网或服务没起，后者是业务拒绝。
    throw new Error('连不上服务端');
  }
  if (res.status === 401) { clearToken(); throw new Unauthorized(); }

  const text = await res.text();
  let data: unknown = null;
  if (text) { try { data = JSON.parse(text); } catch { /* 非 JSON：下面按状态码兜底 */ } }

  if (!res.ok) {
    const d = data as { error?: string; message?: string; code?: string } | null;
    // 服务端的中文 error 优先；没有就退到状态码，别抛一个空字符串让界面显示一片空白
    throw new Error(d?.error || d?.message || `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

export const auth = {
  login: (body: AdminLoginRequest) => call<AdminAuthResult>('/admin/auth/login', 'POST', body, false),
  me: () => call<AdminMe>('/admin/auth/me'),
  logout: () => call<{ ok: boolean }>('/admin/auth/logout', 'POST').catch(() => ({ ok: false })),
};

export const api = {
  // —— 出片对账 ——
  // VideoCreditHold 是唯一一张记着「钱扣了、片子还没交付」的表。
  ops: (days: number) => call<AdminClipOpsView>(`/admin/video/ops?days=${days}`),
  holds: (p: { status?: string; days: number; page: number }) => {
    const q = new URLSearchParams({ days: String(p.days), page: String(p.page) });
    if (p.status) q.set('status', p.status);
    return call<AdminClipHoldListView>(`/admin/video/holds?${q}`);
  },
  // 仅超管。判定复用定时任务那条路径：能补交就补交，明确被拒才退款，问不清原样保留 ——
  // 上游可能已经在跑了，退了就是白送一次出片。
  reconcile: (id: string) =>
    call<AdminClipReconcileResult>(`/admin/video/holds/${encodeURIComponent(id)}/reconcile`, 'POST'),

  // —— 模板货架 ——
  templates: () => call<ClipAdminTemplate[]>('/admin/video/templates'),
  // 仅超管（与改价同级：直接改变小程序首页看得到什么）
  setTemplateStatus: (id: string, status: 'published' | 'draft') =>
    call<ClipAdminTemplate>(`/admin/video/templates/${encodeURIComponent(id)}/status`, 'PUT', { status }),
  // 把一条草稿存成模板。草稿属主 = 当前后台账号绑定的那个小程序账号，服务端只认那一列、
  // 不看请求体，所以存不了别人的草稿。
  templateFromProject: (body: ClipTemplateFromProject) =>
    call<ClipAdminTemplate>('/admin/video/templates/from-project', 'POST', body),

  // —— 定价 ——
  generationPricing: () => call<ClipGenerationPricing>('/admin/video/generation-pricing'),
  saveGenerationPricing: (body: ClipGenerationPricingUpdate) =>
    call<ClipGenerationPricing>('/admin/video/generation-pricing', 'PUT', body),
  clonePricing: () => call<ClipClonePricing>('/admin/video/clone-pricing'),
  saveClonePricing: (body: Omit<ClipClonePricing, 'configured'>) =>
    call<ClipClonePricing>('/admin/video/clone-pricing', 'PUT', body),

  // —— 供应商 ——
  // 实时打上游、还要和本地库比对，慢。别放进任何轮询里。
  vendor: () => call<ClipVendorOverview>('/admin/video/vendor'),
};
