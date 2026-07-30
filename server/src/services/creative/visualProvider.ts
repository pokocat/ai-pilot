// 图片生成接入点（后台可配，不硬编码供应商 —— 2026-07-29 拍板）。
//
// 形态：OpenAI images 兼容的通用适配器。POST {baseUrl}/images/generations
//   请求：{ prompt, model, size, ...extraParams }（extraParams 是后台填的参数模板，原样合并）
//   响应：{ data: [{ b64_json }] } 或 { data: [{ url }] } —— 两种都吃；国内厂商多兼容此形态。
// 未配置或 disabled → 上层跳过 visual 阶段走「无主视觉」纯排版路径（不报错，见方案 §7）。
//
// 同步 vs 异步：本适配器按**同步返回**实现（OpenAI images 是同步的），submit 直接拿到图；
// 为了让 worker 与 sweep 的状态机对异步供应商也成立，接口仍保留 submit/query 两段：
// 同步供应商的 submit 直接回 status='succeeded' + 图，query 只在 taskId 形如异步任务时才有意义。
// 真接了异步供应商（先返回 taskId 后轮询）时，在这里补一个 provider 分支即可，调用方不动。
//
// 安全：目标地址过 assertSafeUrl（复用 llm/tools/httpTool 的 SSRF 防护——运营可在后台填任意
// baseUrl，不设防等于给了一个内网探测器）；下载图片同样要过。密钥永不出现在日志与错误文案里。
import { assertSafeUrl } from '../../llm/tools/httpTool.js';
import { IMAGE_MIME_EXT, MAX_IMAGE_BYTES } from '../chatImage.js';
import { getCreativeConfig, visualProviderConfigured, type CreativeRuntimeConfig } from './config.js';

export interface VisualRequest {
  prompt: string;
  /** 负向提示（供应商支持时透传；不支持则拼进 prompt 尾部由模型自行理解）。 */
  negativePrompt?: string;
  size?: string;
}
export type VisualStatus = 'pending' | 'succeeded' | 'failed';
export interface VisualSubmitResult {
  taskId: string;
  status: VisualStatus;
  /** 同步供应商在 submit 阶段就带回图片字节。 */
  image?: { buffer: Buffer; mimeType: string };
  error?: string;
}
export interface VisualQueryResult {
  status: VisualStatus;
  imageUrl?: string;
  image?: { buffer: Buffer; mimeType: string };
  error?: string;
}
export interface VisualDryRunResult { ok: boolean; message: string; ms: number }

export interface VisualProvider {
  readonly name: string;
  submit(req: VisualRequest): Promise<VisualSubmitResult>;
  query(taskId: string): Promise<VisualQueryResult>;
  dryRun(): Promise<VisualDryRunResult>;
}

const MIME_BY_MAGIC: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
];

/** 按魔数判 MIME（不信供应商的 content-type：错标会让后续 OSS 与小程序渲染一起出错）。 */
export function sniffImageMime(buf: Buffer): string | null {
  for (const [magic, mime] of MIME_BY_MAGIC) {
    if (magic.every((b, i) => buf[i] === b)) return mime;
  }
  // WebP：RIFF....WEBP
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  await assertSafeUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // 不把上游响应体原样冒泡（可能含供应商内部信息或回显的 key），只留状态码。
      throw new Error(`供应商返回 HTTP ${res.status}`);
    }
    try { return JSON.parse(text) as unknown; } catch { throw new Error('供应商返回的不是合法 JSON'); }
  } finally {
    clearTimeout(timer);
  }
}

/** 下载供应商临时图片 URL（过 SSRF 防护 + 体积上限 + 魔数判型）。 */
export async function downloadVisual(url: string, timeoutMs: number): Promise<{ buffer: Buffer; mimeType: string }> {
  await assertSafeUrl(url);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`下载主视觉失败 HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('主视觉为空');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('主视觉超过 10MB 上限');
    const mime = sniffImageMime(buf);
    if (!mime || !IMAGE_MIME_EXT[mime]) throw new Error('主视觉不是受支持的图片格式');
    return { buffer: buf, mimeType: mime };
  } finally {
    clearTimeout(timer);
  }
}

function decodeB64Image(b64: string): { buffer: Buffer; mimeType: string } {
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('主视觉为空');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('主视觉超过 10MB 上限');
  const mime = sniffImageMime(buf);
  if (!mime || !IMAGE_MIME_EXT[mime]) throw new Error('主视觉不是受支持的图片格式');
  return { buffer: buf, mimeType: mime };
}

type ImagesResponse = {
  data?: Array<{ b64_json?: unknown; url?: unknown }>;
  // 部分厂商把异步任务 id 放在这些字段上；有 id 无图时按异步任务处理。
  id?: unknown; task_id?: unknown; output?: { task_id?: unknown; task_status?: unknown };
};

/** OpenAI images 兼容适配器。 */
class OpenAiCompatibleVisualProvider implements VisualProvider {
  readonly name = 'openai_images';
  constructor(private cfg: CreativeRuntimeConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.visual.apiKey) h.Authorization = `Bearer ${this.cfg.visual.apiKey}`;
    return h;
  }

  private body(req: VisualRequest): Record<string, unknown> {
    const prompt = req.negativePrompt
      ? `${req.prompt}\n【排除】${req.negativePrompt}`
      : req.prompt;
    return {
      // extraParams 先铺底，显式字段后覆盖：运营可以用参数模板补 quality/style/n 之类的厂商专有项，
      // 但不能借它悄悄改掉 prompt/model/size 这三个由业务决定的字段。
      ...this.cfg.visual.extraParams,
      prompt,
      model: this.cfg.visual.model,
      size: req.size || this.cfg.visual.size,
      response_format: 'b64_json',
    };
  }

  async submit(req: VisualRequest): Promise<VisualSubmitResult> {
    const url = joinUrl(this.cfg.visual.baseUrl, 'images/generations');
    const json = (await fetchJson(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.body(req)),
    }, this.cfg.visual.timeoutMs)) as ImagesResponse;

    const first = Array.isArray(json.data) ? json.data[0] : undefined;
    if (first && typeof first.b64_json === 'string' && first.b64_json) {
      return { taskId: `sync:${Date.now()}`, status: 'succeeded', image: decodeB64Image(first.b64_json) };
    }
    if (first && typeof first.url === 'string' && first.url) {
      return { taskId: `sync:${Date.now()}`, status: 'succeeded', image: await downloadVisual(first.url, this.cfg.visual.timeoutMs) };
    }
    // 异步形态：只回了任务 id → 交给 query/sweep 续查。
    const asyncId = [json.id, json.task_id, json.output?.task_id].find((v) => typeof v === 'string' && v);
    if (typeof asyncId === 'string') return { taskId: asyncId, status: 'pending' };
    return { taskId: '', status: 'failed', error: '供应商未返回图片' };
  }

  async query(taskId: string): Promise<VisualQueryResult> {
    if (taskId.startsWith('sync:')) return { status: 'failed', error: '同步供应商任务不可续查' };
    const url = joinUrl(this.cfg.visual.baseUrl, `images/generations/${encodeURIComponent(taskId)}`);
    const json = (await fetchJson(url, { method: 'GET', headers: this.headers() }, this.cfg.visual.timeoutMs)) as ImagesResponse;
    const first = Array.isArray(json.data) ? json.data[0] : undefined;
    if (first && typeof first.b64_json === 'string' && first.b64_json) {
      return { status: 'succeeded', image: decodeB64Image(first.b64_json) };
    }
    if (first && typeof first.url === 'string' && first.url) {
      return { status: 'succeeded', imageUrl: first.url, image: await downloadVisual(first.url, this.cfg.visual.timeoutMs) };
    }
    const state = String(json.output?.task_status ?? '').toUpperCase();
    if (state === 'FAILED' || state === 'CANCELED') return { status: 'failed', error: `供应商任务状态 ${state}` };
    return { status: 'pending' };
  }

  /** 连通性试跑：发一条最小提示词，只看能不能拿回一张图。不落任何资产。 */
  async dryRun(): Promise<VisualDryRunResult> {
    const t0 = Date.now();
    try {
      const r = await this.submit({ prompt: '极简几何构成，纯色背景，中央留出干净负空间，无任何文字' });
      const ms = Date.now() - t0;
      if (r.status === 'succeeded' && r.image) {
        return { ok: true, message: `连通正常，返回 ${r.image.mimeType} ${Math.round(r.image.buffer.length / 1024)}KB`, ms };
      }
      if (r.status === 'pending') return { ok: true, message: `连通正常（异步任务已受理：${r.taskId}）`, ms };
      return { ok: false, message: r.error ?? '供应商未返回图片', ms };
    } catch (e) {
      return { ok: false, message: (e as Error).message, ms: Date.now() - t0 };
    }
  }
}

/** 解析当前生效的图片供应商；未配置 / 未启用 → null（上层跳过 visual 阶段，不报错）。 */
export async function resolveVisualProvider(cfg?: CreativeRuntimeConfig): Promise<VisualProvider | null> {
  const c = cfg ?? (await getCreativeConfig());
  if (!visualProviderConfigured(c)) return null;
  return new OpenAiCompatibleVisualProvider(c);
}

/** 后台「连通性试跑」端点用：未配置时给出可操作的提示而不是空 ok。 */
export async function dryRunVisualProvider(): Promise<VisualDryRunResult> {
  const cfg = await getCreativeConfig({ fresh: true });
  if (!cfg.visual.enabled) return { ok: false, message: '图片供应商未启用', ms: 0 };
  if (!cfg.visual.baseUrl || !cfg.visual.model) return { ok: false, message: '请先填写接口地址与模型名', ms: 0 };
  const provider = await resolveVisualProvider(cfg);
  if (!provider) return { ok: false, message: '供应商配置不完整', ms: 0 };
  return provider.dryRun();
}
