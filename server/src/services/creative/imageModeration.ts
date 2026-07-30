// 图片审核（全新能力：现有 moderation.ts 的 provider 抽象是 (text) => verdict，图片得单开一路）。
//
// 第一期只交付**接口 + 默认 'none' provider**（放行 + 落一条 skipped 审计，让「没审」这件事在
// audit_log 里可查，而不是零痕迹放过），http 形态留配置位不接真实供应商（方案 §13 列入阶段 B）。
// 覆盖两处调用点：用户上传源素材（uploads.ts）、供应商产出主视觉（worker.ts）。
import { assertSafeUrl } from '../../llm/tools/httpTool.js';
import { recordAudit } from '../audit.js';
import { getCreativeConfig } from './config.js';

export interface ImageModerationVerdict {
  pass: boolean;
  provider: 'none' | 'http';
  label?: string;
  /** true = 未真正审核（默认 provider 或服务未配），已落 skipped 审计。 */
  skipped?: boolean;
}

export interface ImageModerationContext {
  tenantId?: string | null;
  userId?: string | null;
  /** 审核对象定位：源素材 id / 任务 id，落审计便于溯源。 */
  refId?: string | null;
  scene?: 'source' | 'visual' | 'poster';
}

export interface ImageModerator {
  readonly provider: 'none' | 'http';
  check(input: Buffer | { ossKey: string }, ctx?: ImageModerationContext): Promise<ImageModerationVerdict>;
}

/** 默认：放行 + 记一条 skipped 审计（合规追溯要能证明「这批图当时没有图片审核能力」）。 */
class NoneModerator implements ImageModerator {
  readonly provider = 'none' as const;
  async check(input: Buffer | { ossKey: string }, ctx?: ImageModerationContext): Promise<ImageModerationVerdict> {
    await recordAudit({
      tenantId: ctx?.tenantId ?? null,
      userId: ctx?.userId ?? null,
      action: 'creative.image.moderation.skipped',
      payload: {
        provider: 'none',
        scene: ctx?.scene ?? 'source',
        refId: ctx?.refId ?? null,
        bytes: Buffer.isBuffer(input) ? input.length : null,
        ossKey: Buffer.isBuffer(input) ? null : input.ossKey,
        reason: '未配置图片审核供应商，按放行处理',
      },
    });
    return { pass: true, provider: 'none', skipped: true };
  }
}

/**
 * http 形态：**配置位，未接真实供应商**。
 * 约定 POST { imageBase64 | ossKey } → { pass, label? }。
 * 未配 URL 时降级为 none（放行 + skipped 审计），绝不因为审核没接好把上传全拦死。
 */
class HttpModerator implements ImageModerator {
  readonly provider = 'http' as const;
  constructor(private url: string, private apiKey: string, private timeoutMs: number) {}

  async check(input: Buffer | { ossKey: string }, ctx?: ImageModerationContext): Promise<ImageModerationVerdict> {
    try {
      await assertSafeUrl(this.url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
          body: JSON.stringify(Buffer.isBuffer(input) ? { imageBase64: input.toString('base64') } : { ossKey: input.ossKey }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`图片审核服务 HTTP ${res.status}`);
        const data = (await res.json()) as { pass?: boolean; block?: boolean; label?: string };
        const pass = typeof data.pass === 'boolean' ? data.pass : !data.block;
        return { pass, provider: 'http', ...(data.label ? { label: data.label } : {}) };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      // 图片审核抖动：**fail-closed**（合规侧宁拦错不放过；用户重试一次即可），并记审计便于排查。
      await recordAudit({
        tenantId: ctx?.tenantId ?? null,
        userId: ctx?.userId ?? null,
        action: 'creative.image.moderation.error',
        payload: { provider: 'http', scene: ctx?.scene ?? 'source', refId: ctx?.refId ?? null, error: (e as Error).message },
      });
      return { pass: false, provider: 'http', label: 'moderation_unavailable' };
    }
  }
}

/** 取当前生效的图片审核器（后台配置 provider；http 未配地址时退回 none）。 */
export async function resolveImageModerator(): Promise<ImageModerator> {
  const cfg = await getCreativeConfig();
  if (cfg.imageModerationProvider !== 'http') return new NoneModerator();
  const url = (process.env.CREATIVE_IMAGE_MODERATION_URL ?? '').trim();
  if (!url) return new NoneModerator();
  const key = (process.env.CREATIVE_IMAGE_MODERATION_KEY ?? '').trim();
  const timeoutMs = Number(process.env.CREATIVE_IMAGE_MODERATION_TIMEOUT_MS ?? 5000);
  return new HttpModerator(url, key, Number.isFinite(timeoutMs) ? timeoutMs : 5000);
}

/** 便捷入口：审一张图。 */
export async function checkImage(
  input: Buffer | { ossKey: string },
  ctx?: ImageModerationContext,
): Promise<ImageModerationVerdict> {
  const moderator = await resolveImageModerator();
  return moderator.check(input, ctx);
}
