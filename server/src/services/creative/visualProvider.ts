// 图片生成接入点（后台可配，不硬编码供应商 —— 2026-07-29 拍板）。
//
// 形态：OpenAI images 兼容的通用适配器。POST {baseUrl}/images/generations
//   请求：{ prompt, model, size, ...extraParams }（extraParams 是后台填的参数模板，原样合并）
//   响应：{ data: [{ b64_json }] } 或 { data: [{ url }] } —— 两种都吃；国内厂商多兼容此形态。
// 未配置或 disabled → standard 不受影响；premium 不开放新单，在途任务按契约失败退款。
//
// **只支持同步返回**（OpenAI images 就是同步的）：submit 一次调用要么拿到图，要么算失败。
// 曾经还有一条 `status:'pending'` + `query(taskId)` 的异步分支，写着「记下 providerTaskId 让 sweep
// 续查」—— 但 sweep 从来没有查过它，query() 也没有任何调用点。删掉假承诺后语义变诚实：
// 异步响应 = 当前不支持的失败；premium 任务重试/退款，standard 根本不会调用本适配器。
// 真要接异步供应商，得连着 worker 的状态机与 sweep 的续查一起做，不是补一个方法就成立的。
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
}
export interface VisualSubmitResult {
  status: 'succeeded' | 'failed';
  /** 成功时必带图片字节（同步供应商在 submit 阶段就拿到）。 */
  image?: { buffer: Buffer; mimeType: string };
  error?: string;
}
export interface VisualDryRunResult { ok: boolean; message: string; ms: number }

export interface VisualProvider {
  readonly name: string;
  submit(req: VisualRequest): Promise<VisualSubmitResult>;
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
  // 部分厂商把异步任务 id 放在这些字段上。本适配器只支持同步返回 → 认出来只为给一条能排障的错误文案。
  id?: unknown; task_id?: unknown; output?: { task_id?: unknown; task_status?: unknown };
};

/**
 * 按方言拼请求体。**纯函数**（不碰网络），所以三家的协议差异可以零 IO 单测钉住 ——
 * 这些差异全都是「填错了才发现」的类型，靠一次次真调去试太贵。
 *
 * 共同约定：`extraParams` 先铺底、显式字段后覆盖。运营可以用参数模板补厂商专有项，
 * 但**不能借它改掉由业务决定的字段**（prompt/model/size，以及方舟那个 watermark）。
 */
export function buildVisualBody(cfg: CreativeRuntimeConfig, req: VisualRequest): Record<string, unknown> {
  const withNegative = req.negativePrompt ? `${req.prompt}\n【排除】${req.negativePrompt}` : req.prompt;
  const base = { ...cfg.visual.extraParams };

  if (cfg.visual.dialect === 'ark_seedream') {
    return {
      ...base,
      model: cfg.visual.model,
      prompt: req.prompt,
      // 方舟原生支持负向提示词 —— 拼进正向 prompt 里是下策（模型经常把"不要 X"读成"要 X"）。
      ...(req.negativePrompt ? { negative_prompt: req.negativePrompt } : {}),
      size: cfg.visual.size,
      response_format: 'b64_json',
      // ★ watermark 必须显式 false，且**刻意放在 extraParams 之后**：方舟这个参数默认 true，
      //   一张右下角印着供应商水印的付费海报是直接不能交付的。这不是运营可选项。
      watermark: false,
      // 输出 jpeg：2K 的 PNG base64 逼近 10MB 上限，而这张图只是排版层底下的背景，
      // 最终成品还要由渲染器重新编码成 PNG，中间这一道无损没有意义。
      output_format: 'jpeg',
      // 关掉提示词优化：imagePrompt 那套骨架已经把景别/光线/构图写死了（含"画面内不得有文字"），
      // 让模型再改写一遍等于把这些约束交回给它自己 —— 无文字这条一旦被改写掉，整张图就废了。
      optimize_prompt: false,
    };
  }

  if (cfg.visual.dialect === 'gpt_image') {
    return {
      ...base,
      model: cfg.visual.model,
      prompt: withNegative,   // gpt-image-1 没有负向字段，只能拼进正向
      size: cfg.visual.size,
      // ★ 绝不能带 response_format：gpt-image-1 对这个参数直接 400（它恒定返回 b64）。
      //   这正是"通用适配器打所有家"会翻车的地方。
    };
  }

  // 通用 OpenAI images（原行为，一字不改）
  return {
    ...base,
    prompt: withNegative,
    model: cfg.visual.model,
    size: cfg.visual.size,
    response_format: 'b64_json',
  };
}

/** images 兼容适配器（按 cfg.visual.dialect 决定请求体形态）。 */
class ImagesApiVisualProvider implements VisualProvider {
  readonly name: string;
  constructor(private cfg: CreativeRuntimeConfig) {
    this.name = cfg.visual.dialect;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.visual.apiKey) h.Authorization = `Bearer ${this.cfg.visual.apiKey}`;
    return h;
  }

  private body(req: VisualRequest): Record<string, unknown> {
    return buildVisualBody(this.cfg, req);
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
      return { status: 'succeeded', image: decodeB64Image(first.b64_json) };
    }
    if (first && typeof first.url === 'string' && first.url) {
      return { status: 'succeeded', image: await downloadVisual(first.url, this.cfg.visual.timeoutMs) };
    }
    // 异步形态（只回任务 id）：本适配器不支持轮询 → 按失败上报，由 premium 重试/退款。
    const asyncId = [json.id, json.task_id, json.output?.task_id].find((v) => typeof v === 'string' && v);
    if (typeof asyncId === 'string') {
      return { status: 'failed', error: '供应商返回异步任务，当前只支持同步返回图片的接口' };
    }
    return { status: 'failed', error: '供应商未返回图片' };
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
      return { ok: false, message: r.error ?? '供应商未返回图片', ms };
    } catch (e) {
      return { ok: false, message: (e as Error).message, ms: Date.now() - t0 };
    }
  }
}

/** 解析当前生效的图片供应商；未配置 / 未启用 → null（premium 不开放或执行失败，standard 不调用）。 */
export async function resolveVisualProvider(cfg?: CreativeRuntimeConfig): Promise<VisualProvider | null> {
  const c = cfg ?? (await getCreativeConfig());
  if (!visualProviderConfigured(c)) return null;
  return new ImagesApiVisualProvider(c);
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
