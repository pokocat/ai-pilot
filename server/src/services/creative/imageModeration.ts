// 图片审核（全新能力：现有 moderation.ts 的 provider 抽象是 (text) => verdict，图片得单开一路）。
//
// 现状（诚实版）：**只有 'none' 一种实现** —— 放行 + 落一条 skipped 审计，让「没审」这件事在
// audit_log 里可查，而不是零痕迹放过。合规缺口记录见 AGENTS.md §13，二期（阶段 B）才接真实供应商。
//
// 2026-07-29 删掉了 HttpModerator 半成品与 imageModerationProvider 配置项。删除理由：
// 那个实现直读三个**全仓只在本文件出现、既不在 env.ts 也不在 .env.example**的 process.env
// （CREATIVE_IMAGE_MODERATION_URL/_KEY/_TIMEOUT_MS），而 provider='http' 但缺 URL 时它 return
// NoneModerator —— 也就是后台显示「已开审核」、实际全部放行、连一条 error 审计都没有。
// 一个让人误以为已经在审的开关，比明确的"未接入"危险得多。真接供应商时连着实现一起加回来：
// 保留下面的 ImageModerator 接口就是为了那时候只需新增一个 class + 一个 resolve 分支。
import { recordAudit } from '../audit.js';

export interface ImageModerationVerdict {
  pass: boolean;
  /** 判定来源。目前恒为 'none'；接入真实供应商时在此扩联合类型。 */
  provider: 'none';
  label?: string;
  /** true = 未真正审核（默认 provider），已落 skipped 审计。 */
  skipped?: boolean;
}

export interface ImageModerationContext {
  tenantId?: string | null;
  userId?: string | null;
  /** 审核对象定位：源素材 id / 任务 id，落审计便于溯源。 */
  refId?: string | null;
  scene?: 'source' | 'visual' | 'poster';
}

/**
 * 图片审核器接口（二期接入缝）。
 * 入参收窄为 Buffer：两个调用点（uploads 的用户上传、worker 的供应商产出）手上都已经是字节，
 * 曾经的 `Buffer | { ossKey }` 联合从没有人走过第二个分支，只是让每个实现都要写两套编码逻辑。
 */
export interface ImageModerator {
  readonly provider: 'none';
  check(input: Buffer, ctx?: ImageModerationContext): Promise<ImageModerationVerdict>;
}

/** 默认：放行 + 记一条 skipped 审计（合规追溯要能证明「这批图当时没有图片审核能力」）。 */
class NoneModerator implements ImageModerator {
  readonly provider = 'none' as const;
  async check(input: Buffer, ctx?: ImageModerationContext): Promise<ImageModerationVerdict> {
    await recordAudit({
      tenantId: ctx?.tenantId ?? null,
      userId: ctx?.userId ?? null,
      action: 'creative.image.moderation.skipped',
      payload: {
        provider: 'none',
        scene: ctx?.scene ?? 'source',
        refId: ctx?.refId ?? null,
        bytes: input.length,
        reason: '未接入图片审核供应商，按放行处理',
      },
    });
    return { pass: true, provider: 'none', skipped: true };
  }
}

/** 取当前生效的图片审核器。二期接入真实供应商时在这里加配置分支。 */
export async function resolveImageModerator(): Promise<ImageModerator> {
  return new NoneModerator();
}

/** 便捷入口：审一张图。 */
export async function checkImage(
  input: Buffer,
  ctx?: ImageModerationContext,
): Promise<ImageModerationVerdict> {
  const moderator = await resolveImageModerator();
  return moderator.check(input, ctx);
}
