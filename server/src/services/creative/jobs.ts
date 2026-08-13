// 创作任务编排（海报成品图）：建单 / 改文案 / 重出图 / 取消 / 退款 / 视图组装。
//
// 计费口径（方案 §11，已拍板）：
//   · 预扣即实扣：建单事务内 chargeCredits + 写 chargedAt，失败靠退款回补；
//   · **不用 credits.reserveCredits 的内存闭包**——它跨不过 worker/重启的进程边界，且没有幂等标志（已知坑）；
//   · 退款唯一入口 refundJob()，用 `updateMany where refundedAt: null` 抢占，抢到才真退 → 天然只退一次；
//   · 不限量用户（余额 -1）实扣 0（appendCreditDelta 直接 return，连流水都不写），
//     但 creditCost 仍记名义价，成本以 creative_job 行为准（流水表指望不上）。
//   · revise（只改文案重排）不再扣钻石（creditCost=0 / chargedAt=null）；regenerate（重出主视觉）重新扣。
//
// 门禁顺序（方案 §9.1）：功能开关 → 智能体已解锁 → 套餐有效 → brief 校验 → 输入审核 → 幂等 → 日限额 → 扣费建单。
// 顺序不是随意的：不该让一个功能关着的接口去查用户余额，也不该让校验不过的请求先扣钻石。
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { now, dayStart } from '../clock.js';
import { chargeCredits, refundCredits, ensureCredits } from '../credits.js';
import { assertAgentAccess } from '../entitlements.js';
import { assertPlanActive } from '../tokenQuota.js';
import { moderate } from '../moderation.js';
import { recordAudit } from '../audit.js';
import { noteCreativeJobCreated } from '../metrics.js';
import { getBrandKit } from '../brandKit.js';
import {
  assertCreativeEnabled, visualProviderConfigured, premiumTierAvailable, priceForTier,
  POSTER_SKILL_KEY, type CreativeRuntimeConfig,
} from './config.js';
import { normalizePosterBrief, briefModerationText, LIMITS, type NormalizedPosterBrief } from './schema.js';
import { resolveBriefAssets, UploadRejectedError } from './uploads.js';
import { creativeAssetUrl } from './storage.js';
import type {
  CreativeJobView, CreativeAssetView, PosterBrief,
  RevisePosterJobRequest, RegeneratePosterJobRequest,
  CreativePosterListItem, CreativePosterListResult,
} from '../../../../shared/contracts';

// 技能 key 的定义在 config.ts（价格表按技能存，config 读价要用它；放这里会绕成循环 import）。
// 这里再导出一次，让既有的 `from './jobs.js'` 引用零改动。
export { POSTER_SKILL_KEY } from './config.js';
export const POSTER_AGENT_KEY = 'poster';
export const POSTER_JOB_KIND = 'poster';
/**
 * CreativeJob.engine 的唯一取值。曾由 env CANVAS_DESIGN_ENGINE 决定，但全仓没有一处
 * `engine === ...` 分支、anthropic_skill 也没有实现 → 那个 env 只会让运维以为自己能切引擎。
 * 已删掉 env，这里写死常量；DB 列保留（已有行全是 'native'，无迁移），二期真接第二种引擎时再放开。
 */
const POSTER_ENGINE = 'native';

export class CreativeError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}
export class DailyLimitError extends CreativeError {
  constructor(limit: number) { super(`今天的成品图额度已用完（每日 ${limit} 张），明天再来`, 'CREATIVE_DAILY_LIMIT', 429); }
}
export class JobNotFoundError extends CreativeError {
  // 越权一律 404：不区分「不存在」与「不是你的」，否则接口本身就是探测器。
  constructor() { super('任务不存在', 'NOT_FOUND', 404); }
}

/**
 * requestJson 里除 brief 之外的编排元信息。
 * 曾有一个 `visualConfigured` 布尔（建单时的供应商可用性快照）：只写不读，且与 `provider` 列
 * 表达同一件事 → 已删。**实际是否产出了主视觉**看 resultJson.degraded，那才是有读者的字段。
 */
interface RequestSnapshot {
  brief: NormalizedPosterBrief;
  /** revise 复用父任务主视觉时记来源资产 id（worker 据此跳过 visual 阶段）。 */
  sourceVisualAssetId?: string | null;
}

type JobRow = {
  id: string; tenantId: string; userId: string; sessionId: string | null; messageId: string | null;
  agentKey: string; skillKey: string; kind: string; status: string; progress: string | null;
  parentJobId: string | null; engine: string; provider: string | null; providerTaskId: string | null;
  requestJson: unknown; resultJson: unknown; promptSnapshot: string | null; idempotencyKey: string;
  creditCost: number; chargedAt: Date | null; refundedAt: Date | null;
  errorCode: string | null; errorMessage: string | null; attempts: number;
  startedAt: Date | null; completedAt: Date | null; createdAt: Date; updatedAt: Date;
  metadataJson?: unknown;
};

/* ───────────────── 视图组装 ───────────────── */

function assetView(a: { id: string; kind: string; ossKey: string; mimeType: string; width: number | null; height: number | null }): CreativeAssetView {
  const url = creativeAssetUrl(a.id, a.ossKey);
  return {
    id: a.id,
    kind: (a.kind as CreativeAssetView['kind']),
    mimeType: a.mimeType,
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    previewUrl: url,
    downloadUrl: url,
  };
}

/** 当前状态下前端可展示的操作。已成功任务不提供 cancel；失败任务允许重出图（regenerate 会新建任务重新扣费）。 */
function actionsFor(status: string): CreativeJobView['actions'] {
  if (status === 'pending' || status === 'running') return ['cancel'];
  if (status === 'succeeded') return ['revise', 'regenerate'];
  if (status === 'failed' || status === 'cancelled') return ['regenerate'];
  return [];
}

/**
 * 面向用户的失败原因（克制口径，不透内部细节；内部原文留在 errorMessage 里给运营看）。
 * 只列**真的会落到 errorCode 上**的码。删掉过三个永不出现的：MODERATION_BLOCKED（建单前就 422，
 * 不会变成任务的终态）、VISUAL_PROVIDER_FAILED（供应商失败一律降级为纯排版，从不置此码）、
 * ASSET_STORE_FAILED（那是上传期抛的 502 UploadRejectedError）。未列出的码统一回落到兜底文案。
 */
const USER_FACING_ERROR: Record<string, string> = {
  IMAGE_MODERATION_BLOCKED: '主视觉未通过审核，换个视觉方向再试',
  POSTER_RENDER_FAILED: '出图失败，已退回钻石',
  PDF_UNAVAILABLE: '出图服务暂不可用，已退回钻石',
  TIMEOUT: '出图超时，已退回钻石',
  CANCELLED: '已取消',
};
function userFacingError(code: string | null, fallback: string | null): string | undefined {
  if (!code) return fallback ? '出图失败，已退回钻石' : undefined;
  return USER_FACING_ERROR[code] ?? '出图失败，已退回钻石';
}

function toView(job: JobRow, assets: Parameters<typeof assetView>[0][]): CreativeJobView {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status as CreativeJobView['status'],
    ...(job.progress ? { progress: job.progress } : {}),
    creditCost: job.creditCost,
    refunded: !!job.refundedAt,
    ...(job.status === 'failed' || job.status === 'cancelled'
      ? { errorMessage: userFacingError(job.errorCode, job.errorMessage) ?? '出图失败' }
      : {}),
    createdAt: job.createdAt.toISOString(),
    ...(job.completedAt ? { completedAt: job.completedAt.toISOString() } : {}),
    // 只对外暴露成品与主视觉；源素材是用户自己传的，不必在任务视图里回显。
    assets: assets.filter((a) => a.kind !== 'source').map(assetView),
    ...(job.parentJobId ? { parentJobId: job.parentJobId } : {}),
    // 档位：详情页的「换风格」按它显示价格（regenerate 继承父单档位、按 priceForTier 扣费）。
    // 老任务 requestJson 里没有这个字段 → 不带，前端按 standard 显示。
    ...(requestOf(job).brief?.tier === 'premium' ? { tier: 'premium' as const } : {}),
    actions: actionsFor(job.status),
  };
}

/** 任务视图（越权一律 404）。 */
export async function getJobView(jobId: string, userId: string): Promise<CreativeJobView> {
  const job = await prisma.creativeJob.findFirst({ where: { id: jobId, userId } });
  if (!job) throw new JobNotFoundError();
  const assets = await prisma.creativeAsset.findMany({
    where: { jobId: job.id },
    orderBy: { createdAt: 'asc' },
    select: { id: true, kind: true, ossKey: true, mimeType: true, width: true, height: true },
  });
  return toView(job as JobRow, assets);
}

/* ───────────────── 作品库列表（历史成品图） ───────────────── */

export const POSTER_LIST_DEFAULT_LIMIT = 20;
export const POSTER_LIST_MAX_LIMIT = 50;

/**
 * 游标格式：`<createdAt 毫秒>:<jobId>`。
 *
 * 为什么不用 Prisma 的 `cursor: { id }` + `skip: 1`：那个写法把「上一页最后一行」当成锚点，
 * 而锚点行如果不满足本查询的 where（例如它在翻页期间被 revise 顶成了别的状态、或干脆是别人的 id），
 * 结果会静默变成空页 —— 一个「还有数据但翻不到」的哑失败。keyset 自己算就没有这个耦合：
 * 游标只是一个 (createdAt, id) 坐标，与那一行还在不在无关。
 */
function decodeCursor(raw: string): { at: Date; id: string } {
  const m = /^(\d{1,15}):([A-Za-z0-9_-]{1,40})$/.exec(raw);
  const ms = m ? Number(m[1]) : NaN;
  if (!m || !Number.isFinite(ms)) throw new CreativeError('分页游标非法', 'CURSOR_INVALID', 422);
  return { at: new Date(ms), id: m[2] };
}
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.getTime()}:${row.id}`;
}

/** 安全读出建单时定格的 brief 字段（requestJson 是裸 JSON，历史行可能缺字段/被改坏）。 */
function briefTextOf(requestJson: unknown, key: 'headline' | 'templateKey'): string {
  const brief = (requestJson as { brief?: Record<string, unknown> } | null)?.brief;
  const v = brief?.[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 作品库：用户自己的海报任务列表（createdAt 倒序，游标分页）。
 *
 * 收录口径 = 「有东西可看的」：succeeded 且真有 poster_png 资产，或仍在途（pending/running）。
 * succeeded 却没有成品资产的行是数据异常（worker 半途丢了产物），列表里放它只会给用户一格破图；
 * failed / cancelled 同理不收 —— 用户要的是找回作品，不是回顾失败史（重试入口在详情页）。
 *
 * **版本链全部平铺**：revise/regenerate 出来的每一版都是独立一项。这正是本功能要解的痛点——
 * 此前同一张成果卡只记得最近一次出图，早期版本只能顺着 parentJobId 一层层往上翻。
 *
 * 归属隔离：where 恒带 userId，越权 id 当游标只会得到空页（不区分「不存在」与「不是你的」）。
 */
export async function listPosterJobs(
  userId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<CreativePosterListResult> {
  const rawLimit = Math.trunc(Number(opts.limit));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, POSTER_LIST_MAX_LIMIT)
    : POSTER_LIST_DEFAULT_LIMIT;
  const rawCursor = String(opts.cursor ?? '').trim();
  const cur = rawCursor ? decodeCursor(rawCursor) : null;

  const rows = await prisma.creativeJob.findMany({
    where: {
      userId,
      kind: POSTER_JOB_KIND,
      AND: [
        {
          OR: [
            { status: { in: ['pending', 'running'] } },
            { status: 'succeeded', assets: { some: { kind: 'poster_png' } } },
          ],
        },
        // keyset：严格小于上一页最后一行的 (createdAt, id)，与下面的 orderBy 同序。
        ...(cur
          ? [{ OR: [{ createdAt: { lt: cur.at } }, { createdAt: cur.at, id: { lt: cur.id } }] }]
          : []),
      ],
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1, // 多取一条只为判断「还有没有下一页」，不下发
    select: {
      id: true, status: true, progress: true, parentJobId: true,
      createdAt: true, completedAt: true, requestJson: true,
    },
  });

  const page = rows.slice(0, limit);
  const doneIds = page.filter((r) => r.status === 'succeeded').map((r) => r.id);
  const assets = doneIds.length
    ? await prisma.creativeAsset.findMany({
      where: { jobId: { in: doneIds }, kind: 'poster_png' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, jobId: true, kind: true, ossKey: true, mimeType: true, width: true, height: true },
    })
    : [];
  // 一条任务理论上只有一张成品图；真有多张时取最新（orderBy desc + 先到先占）。
  const posterOf = new Map<string, CreativeAssetView>();
  for (const a of assets) {
    if (!a.jobId || posterOf.has(a.jobId)) continue;
    posterOf.set(a.jobId, assetView(a));
  }

  const items: CreativePosterListItem[] = page.map((r) => {
    const poster = posterOf.get(r.id);
    const templateKey = briefTextOf(r.requestJson, 'templateKey');
    return {
      jobId: r.id,
      status: r.status as CreativePosterListItem['status'],
      createdAt: r.createdAt.toISOString(),
      ...(r.completedAt ? { completedAt: r.completedAt.toISOString() } : {}),
      headline: briefTextOf(r.requestJson, 'headline'),
      ...(templateKey ? { templateKey } : {}),
      // progress 只对在途项有意义（终态行里它停在最后一个阶段，展示出来像"还在跑"）。
      ...(r.status !== 'succeeded' && r.progress ? { progress: r.progress } : {}),
      ...(poster ? { poster } : {}),
      ...(r.parentJobId ? { parentJobId: r.parentJobId } : {}),
    };
  });

  const last = page[page.length - 1];
  return {
    items,
    ...(rows.length > limit && last ? { nextCursor: encodeCursor(last) } : {}),
  };
}

/* ───────────────── 退款（全局唯一入口） ───────────────── */

/**
 * 幂等退款。`updateMany({ chargedAt: {not:null}, refundedAt: null })` 抢占成功才真退——
 * 多条失败路径（worker catch、sweep、用户取消）叠在一起也只会退一次。
 * creditCost=0（revise / 不限量用户名义价为 0 的场景）直接标记不退。
 *
 * **标记与钱在同一个事务里**（2026-07-29 改）。原先是「先标 refundedAt → 再退款 → 出错就复位标记」，
 * 那个补偿写法有两个真实缺口：
 *   ① 复位本身失败时（刚写成功的同一条连接下一句写失败，罕见但真实）任务停在「已标已退、钱没退」，
 *      而 sweep 的兜底扫描正是以 refundedAt 为空为条件 → 这单永远捞不回来，用户白丢一次钻石；
 *   ② `recordAudit` 当时在 try 内，**审计写失败会走进 catch 复位标记，而钱已经退出去了** →
 *      sweep 重扫再退一次，这是一条真正的双退路径。
 * refundCredits 支持传入事务客户端，所以这两个缺口都没有必要存在。审计移到事务外：
 * 审计失败不该回滚已经退成的钱，只记日志。
 */
export async function refundJob(jobId: string, reason: string): Promise<{ refunded: boolean }> {
  const job = await prisma.creativeJob.findUnique({
    where: { id: jobId },
    select: { id: true, tenantId: true, userId: true, creditCost: true, chargedAt: true, refundedAt: true },
  });
  if (!job) return { refunded: false };
  if (!job.chargedAt || job.refundedAt) return { refunded: false };

  const refunded = await prisma.$transaction(async (tx) => {
    const claimed = await tx.creativeJob.updateMany({
      where: { id: jobId, chargedAt: { not: null }, refundedAt: null },
      data: { refundedAt: now() },
    });
    if (claimed.count === 0) return false; // 别人先抢到了
    if (job.creditCost <= 0) return false; // 名义价 0：标记已处理即可，无流水可退
    await refundCredits(job.tenantId, job.userId, job.creditCost, `海报成品图 · ${reason}`, tx);
    return true;
  });

  if (!refunded) return { refunded: false };
  await recordAudit({
    tenantId: job.tenantId, userId: job.userId, action: 'creative.job.refunded',
    payload: { jobId, credits: job.creditCost, reason },
  }).catch((e) => console.error('[creative] 退款已落账但审计写失败：', jobId, (e as Error).message));
  return { refunded: true };
}

/* ───────────────── 建单 ───────────────── */

async function todayJobCount(userId: string): Promise<number> {
  return prisma.creativeJob.count({ where: { userId, createdAt: { gte: dayStart() } } });
}

/** poster 智能体的解锁校验（billing 取 Agent 行；行缺失按 unlock 处理，宁可拦住也不放行未上架能力）。 */
async function assertPosterAccess(userId: string): Promise<void> {
  const agent = await prisma.agent.findUnique({ where: { key: POSTER_AGENT_KEY }, select: { key: true, billing: true } });
  await assertAgentAccess(userId, { key: POSTER_AGENT_KEY, billing: agent?.billing ?? 'unlock' });
}

/** 已确认（approvedAt 非空）的品牌资产包才允许被引用 —— 与 BrandKit 现有口径一致。 */
async function approvedBrandKit(userId: string) {
  const row = await prisma.brandKit.findUnique({ where: { userId }, select: { approvedAt: true } });
  if (!row?.approvedAt) return null;
  return getBrandKit(userId);
}

export interface CreatePosterJobOpts {
  sessionId?: string | null;
  messageId?: string | null;
  idempotencyKey: string;
}

export interface CreatePosterJobResult {
  jobId: string;
  status: string;
  creditCost: number;
  /** true = 命中幂等键，返回的是既有任务（未重复扣费）。 */
  reused: boolean;
}

function normalizeIdempotencyKey(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s || s.length > 80 || !/^[A-Za-z0-9_:.-]+$/.test(s)) {
    throw new CreativeError('idempotencyKey 非法', 'IDEMPOTENCY_KEY_INVALID', 422);
  }
  return s;
}

/** 校验成果消息归属（messageId 传了就必须是本人的 report 消息，否则不给挂）。 */
async function assertMessageOwnership(messageId: string, userId: string): Promise<string | null> {
  const msg = await prisma.message.findFirst({
    where: { id: messageId, role: 'report', session: { userId } },
    select: { id: true, sessionId: true },
  });
  if (!msg) throw new CreativeError('成果消息不存在', 'MESSAGE_NOT_FOUND', 404);
  return msg.sessionId;
}

async function insertJob(input: {
  cfg: CreativeRuntimeConfig;
  tenantId: string;
  userId: string;
  sessionId: string | null;
  messageId: string | null;
  brief: NormalizedPosterBrief;
  idempotencyKey: string;
  parentJobId?: string | null;
  sourceVisualAssetId?: string | null;
  /** false = 不扣费路径（revise）。 */
  charge: boolean;
}): Promise<CreatePosterJobResult> {
  const { cfg } = input;
  const visualReady = visualProviderConfigured(cfg);
  const request: RequestSnapshot = {
    brief: input.brief,
    ...(input.sourceVisualAssetId ? { sourceVisualAssetId: input.sourceVisualAssetId } : {}),
  };
  // 按档位定价：高级档每单多一次图片大模型调用，成本结构不同（priceForTier 是唯一口径）。
  const nominalCost = input.charge ? priceForTier(cfg, input.brief.tier) : 0;

  try {
    return await prisma.$transaction(async (tx) => {
      // 不限量用户（余额 -1）：chargeCredits 内部零流水，但 creditCost 仍记名义价（成本统计以本行为准）。
      // 余额必须在**事务内**读：据它决定 chargedAt，而 chargedAt 是退款的前置条件。事务外读会有一个
      // 窗口——套餐在这中间从不限量切成限量，就会出现「chargedAt 非空但从未扣过钱」的行，
      // 之后一次失败退款就凭空给用户发 10 钻。
      const lastLedger = input.charge
        ? await tx.creditLedger.findFirst({
          where: { userId: input.userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { balance: true },
        })
        : null;
      const unlimited = input.charge && (lastLedger?.balance ?? 0) < 0;
      const created = await tx.creativeJob.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          sessionId: input.sessionId,
          messageId: input.messageId,
          agentKey: POSTER_AGENT_KEY,
          skillKey: POSTER_SKILL_KEY,
          kind: POSTER_JOB_KIND,
          status: 'pending',
          engine: POSTER_ENGINE,
          provider: visualReady ? 'configured' : null,
          requestJson: request as unknown as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey,
          creditCost: nominalCost,
          // chargedAt 的语义严格是「真的扣到钻石了」（schema 注释：非空=已扣，退款前置条件）。
          // 因此不扣费路径（revise）与不限量用户（零流水）都保持 null → refundJob 天然不给它们退钱。
          // creditCost 仍记名义价，成本统计看 creditCost，是否退钱看 chargedAt，两件事分开。
          chargedAt: input.charge && !unlimited ? now() : null,
          ...(input.parentJobId ? { parentJobId: input.parentJobId } : {}),
        },
        select: { id: true, status: true, creditCost: true },
      });
      if (input.charge && !unlimited) {
        // 同事务扣费：余额不足在这里抛 402，整个事务回滚 → 不会留下一个没付钱的任务。
        await chargeCredits(input.tenantId, input.userId, nominalCost, `海报成品图 · ${input.brief.templateKey}`, tx);
      }
      return { jobId: created.id, status: created.status, creditCost: created.creditCost, reused: false };
    });
  } catch (e) {
    // 幂等键并发撞车（同一用户双击）：唯一约束报 P2002 → 回读既有任务，不重复扣费。
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const existing = await prisma.creativeJob.findUnique({
        where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } },
        select: { id: true, status: true, creditCost: true },
      });
      if (existing) return { jobId: existing.id, status: existing.status, creditCost: existing.creditCost, reused: true };
    }
    throw e;
  }
}

/**
 * 高级档可用性闸门。**不可用一律 422，绝不静默降标准档。**
 *
 * 与「显式请求了被停用的模板 → 422」是同一条口径：用户是为「顶级图片模型出主视觉」付的高级价，
 * 悄悄给他一张标准图再照常扣钱，就是拿了钱交付别的东西。而且高级档不可用通常正是因为
 * 供应商出了问题——那种时候更不该继续收钱。
 *
 * 正常前端根本走不到这里：`GET /creative/status` 的 `premiumAvailable` 为假时高级档选项整块不显示。
 * 走到这里说明状态已过期（用户停在确认页时运营关了供应商）或有人直连接口。
 */
export function assertTierAvailable(cfg: CreativeRuntimeConfig, brief: NormalizedPosterBrief): void {
  if (brief.tier !== 'premium') return;
  // 本人照片与高级档互斥，且**这件事在建单时就知道**，所以在这里拦住而不是等 worker 跑到一半：
  // 高级档的主视觉是模型画出来的人，和用户自己的照片放同一张海报上必然打架（两张脸、两种光）。
  // 让它先扣 25 钻再失败退款，是把一次可预见的拒绝做成了一次往返。
  if (brief.portraitAssetId) {
    throw new CreativeError(
      '高级海报的主视觉由图片模型生成，不能同时使用您上传的本人照片；请改用标准海报，或去掉人物照片',
      'PREMIUM_PORTRAIT_CONFLICT', 422,
    );
  }
  if (premiumTierAvailable(cfg)) return;
  throw new CreativeError('高级海报暂时不可用，请改用标准海报或稍后再试', 'PREMIUM_UNAVAILABLE', 422);
}

/**
 * 建海报任务。门禁顺序见文件头。
 * @throws CanvasDisabledError(403) / AgentLockedError(403) / PlanExpiredError(403) /
 *         BriefInvalidError(422) / InsufficientCreditsError(402) / DailyLimitError(429)
 */
export async function createPosterJob(
  user: { id: string; tenantId: string },
  rawBrief: unknown,
  opts: CreatePosterJobOpts,
): Promise<CreatePosterJobResult> {
  const cfg = await assertCreativeEnabled();              // ① 功能开关（后台单一开关）
  await assertPosterAccess(user.id);                      // ② 智能体已解锁 → 403 AGENT_LOCKED
  await assertPlanActive(user.id);                        // ③ 套餐有效 → 403 PLAN_EXPIRED
  const brief = normalizePosterBrief(rawBrief, cfg.templates); // ④ brief 校验 → 422
  assertTierAvailable(cfg, brief);                        //    高级档可用性 → 422
  await resolveBriefAssets(user.id, brief);               //    资产归属 + MIME → 422
  const idempotencyKey = normalizeIdempotencyKey(opts.idempotencyKey);

  // ⑤ 输入审核（用户可控文案）。不过审直接 422，不建任务、不扣费。
  const passed = await moderate('input', briefModerationText(brief), {
    tenantId: user.tenantId, userId: user.id, sessionId: opts.sessionId ?? null,
  });
  if (!passed) throw new CreativeError('文案未通过内容审核，调整后再试', 'MODERATION_BLOCKED', 422);

  // ⑥ 幂等键查重（先查一遍免掉无谓的限额/扣费；并发撞车由 insertJob 的 P2002 兜住）
  const dup = await prisma.creativeJob.findUnique({
    where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
    select: { id: true, status: true, creditCost: true },
  });
  if (dup) return { jobId: dup.id, status: dup.status, creditCost: dup.creditCost, reused: true };

  // ⑦ 日限额（按 userId 当日 job 计数，含 revise/regenerate —— 限的是「出图动作」总量）
  if (cfg.dailyLimit > 0 && (await todayJobCount(user.id)) >= cfg.dailyLimit) throw new DailyLimitError(cfg.dailyLimit);

  // ⑧ 余额预检（早于事务给出干净的 402；事务内 chargeCredits 仍是最终裁判）
  await ensureCredits(user.id, priceForTier(cfg, brief.tier));

  const sessionId = opts.messageId
    ? await assertMessageOwnership(opts.messageId, user.id)
    : (opts.sessionId ?? null);

  const r = await insertJob({
    cfg,
    tenantId: user.tenantId,
    userId: user.id,
    sessionId,
    messageId: opts.messageId ?? null,
    brief,
    idempotencyKey,
    charge: true,
  });
  if (!r.reused) {
    noteCreativeJobCreated(POSTER_SKILL_KEY, visualProviderConfigured(cfg) ? 'configured' : 'none');
    await recordAudit({
      tenantId: user.tenantId, userId: user.id, action: 'creative.job.created',
      payload: { jobId: r.jobId, templateKey: brief.templateKey, scene: brief.scene, credits: r.creditCost },
    });
  }
  return r;
}

/* ───────────────── revise / regenerate ───────────────── */

async function loadOwnedJob(jobId: string, userId: string): Promise<JobRow> {
  const job = await prisma.creativeJob.findFirst({ where: { id: jobId, userId } });
  if (!job) throw new JobNotFoundError();
  return job as JobRow;
}

function requestOf(job: JobRow): RequestSnapshot {
  const raw = (job.requestJson ?? {}) as Partial<RequestSnapshot>;
  if (!raw.brief) throw new CreativeError('原任务需求单已损坏，请重新发起', 'BRIEF_MISSING', 422);
  return raw as RequestSnapshot;
}

/** 找出可复用的主视觉资产 id（沿版本链往上找：父任务自己没有就用它记录的来源）。 */
async function reusableVisualAssetId(job: JobRow): Promise<string | null> {
  const own = await prisma.creativeAsset.findFirst({
    where: { jobId: job.id, kind: 'visual' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  if (own) return own.id;
  return requestOf(job).sourceVisualAssetId ?? null;
}

/**
 * 只改文案重排：**不再扣钻石**（creditCost=0 / chargedAt=null），复用父任务主视觉。
 * 仍生成新任务（parentJobId 指向来源）——成功任务的资产永不被覆盖。
 *
 * 门禁与 create/regenerate 完全一致（含 assertPosterAccess）：revise 不收费不代表它不是出图动作。
 * 少了解锁校验，一个被回收了 poster 权限的用户仍能拿着旧 jobId 无限免费出新版本。
 */
export async function reviseJob(
  user: { id: string; tenantId: string },
  jobId: string,
  patch: RevisePosterJobRequest,
): Promise<CreatePosterJobResult> {
  const cfg = await assertCreativeEnabled();
  await assertPosterAccess(user.id);
  await assertPlanActive(user.id);
  const parent = await loadOwnedJob(jobId, user.id);
  const base = requestOf(parent).brief;

  // 只允许改文案字段：视觉方向/素材/场景一律沿用父任务（改那些就属于 regenerate，要重新扣费）。
  const merged: PosterBrief = {
    ...base,
    ...(patch.headline !== undefined ? { headline: patch.headline } : {}),
    ...(patch.subheadline !== undefined ? { subheadline: patch.subheadline } : {}),
    ...(patch.proofPoints !== undefined ? { proofPoints: patch.proofPoints.slice(0, LIMITS.proofPoints) } : {}),
    ...(patch.cta !== undefined ? { cta: patch.cta } : {}),
    ...(patch.templateKey !== undefined ? { templateKey: patch.templateKey } : {}),
  };
  const brief = normalizePosterBrief(merged, cfg.templates);
  await resolveBriefAssets(user.id, brief);
  const passed = await moderate('input', briefModerationText(brief), {
    tenantId: user.tenantId, userId: user.id, sessionId: parent.sessionId,
  });
  if (!passed) throw new CreativeError('文案未通过内容审核，调整后再试', 'MODERATION_BLOCKED', 422);
  if (cfg.dailyLimit > 0 && (await todayJobCount(user.id)) >= cfg.dailyLimit) throw new DailyLimitError(cfg.dailyLimit);

  const idempotencyKey = patch.idempotencyKey
    ? normalizeIdempotencyKey(patch.idempotencyKey)
    : `revise:${parent.id}:${Date.now()}`;
  const r = await insertJob({
    cfg,
    tenantId: user.tenantId,
    userId: user.id,
    sessionId: parent.sessionId,
    messageId: parent.messageId,
    brief,
    idempotencyKey,
    parentJobId: parent.id,
    sourceVisualAssetId: await reusableVisualAssetId(parent),
    charge: false, // 改文案不扣钻石（已拍板）
  });
  if (!r.reused) {
    noteCreativeJobCreated(POSTER_SKILL_KEY, visualProviderConfigured(cfg) ? 'configured' : 'none');
    await recordAudit({
      tenantId: user.tenantId, userId: user.id, action: 'creative.job.revised',
      payload: { jobId: r.jobId, parentJobId: parent.id, templateKey: brief.templateKey },
    });
  }
  return r;
}

/** 重出主视觉：允许改 visualDirection / negativePrompt / templateKey，**重新扣费**（同 create 计费路径）。 */
export async function regenerateJob(
  user: { id: string; tenantId: string },
  jobId: string,
  patch: RegeneratePosterJobRequest = {},
): Promise<CreatePosterJobResult> {
  const cfg = await assertCreativeEnabled();
  await assertPosterAccess(user.id);
  await assertPlanActive(user.id);
  const parent = await loadOwnedJob(jobId, user.id);
  const base = requestOf(parent).brief;

  const merged: PosterBrief = {
    ...base,
    ...(patch.visualDirection !== undefined ? { visualDirection: patch.visualDirection } : {}),
    ...(patch.negativePrompt !== undefined ? { negativePrompt: patch.negativePrompt } : {}),
    ...(patch.templateKey !== undefined ? { templateKey: patch.templateKey } : {}),
  };
  const brief = normalizePosterBrief(merged, cfg.templates);
  // 档位从父单继承（...base 带过来的）。重出主视觉**要真的再调一次图片模型**，所以这条路径
  // 与 create 同门禁同定价；revise 不需要（它不调供应商，只是拿父单的主视觉重排文字）。
  assertTierAvailable(cfg, brief);
  await resolveBriefAssets(user.id, brief);
  const passed = await moderate('input', briefModerationText(brief), {
    tenantId: user.tenantId, userId: user.id, sessionId: parent.sessionId,
  });
  if (!passed) throw new CreativeError('文案未通过内容审核，调整后再试', 'MODERATION_BLOCKED', 422);
  if (cfg.dailyLimit > 0 && (await todayJobCount(user.id)) >= cfg.dailyLimit) throw new DailyLimitError(cfg.dailyLimit);
  await ensureCredits(user.id, priceForTier(cfg, brief.tier));

  const idempotencyKey = patch.idempotencyKey
    ? normalizeIdempotencyKey(patch.idempotencyKey)
    : `regen:${parent.id}:${Date.now()}`;
  const r = await insertJob({
    cfg,
    tenantId: user.tenantId,
    userId: user.id,
    sessionId: parent.sessionId,
    messageId: parent.messageId,
    brief,
    idempotencyKey,
    parentJobId: parent.id,
    charge: true, // 重出主视觉再扣一次
  });
  if (!r.reused) {
    noteCreativeJobCreated(POSTER_SKILL_KEY, visualProviderConfigured(cfg) ? 'configured' : 'none');
    await recordAudit({
      tenantId: user.tenantId, userId: user.id, action: 'creative.job.regenerated',
      payload: { jobId: r.jobId, parentJobId: parent.id, templateKey: brief.templateKey, credits: r.creditCost },
    });
  }
  return r;
}

/* ───────────────── 取消 ───────────────── */

/** worker 检查点读这个标记（running 中的任务不能被外部强行改状态，只能请求取消）。 */
export function cancelRequested(metadataJson: unknown): boolean {
  return !!(metadataJson as { cancelRequested?: unknown } | null)?.cancelRequested;
}

/**
 * 取消任务。
 * · pending：直接置 cancelled 并退款（还没开始跑，不会有半成品）；
 * · running：只打 cancelRequested 标记，worker 在阶段检查点尊重它（强杀会留下悬空产物与未退的钻石）。
 */
export async function cancelJob(user: { id: string; tenantId: string }, jobId: string): Promise<CreativeJobView> {
  const job = await loadOwnedJob(jobId, user.id);
  if (job.status === 'pending') {
    // 条件更新：只有仍是 pending 才抢得到（worker 可能刚好抢走并置 running）。
    const claimed = await prisma.creativeJob.updateMany({
      where: { id: job.id, status: 'pending' },
      data: { status: 'cancelled', errorCode: 'CANCELLED', errorMessage: '用户取消', completedAt: now() },
    });
    if (claimed.count > 0) {
      await refundJob(job.id, '用户取消');
      await recordAudit({
        tenantId: user.tenantId, userId: user.id, action: 'creative.job.cancelled',
        payload: { jobId: job.id, at: 'pending' },
      });
      return getJobView(job.id, user.id);
    }
  }
  if (job.status === 'running' || job.status === 'pending') {
    const meta = ((job.metadataJson ?? {}) as Record<string, unknown>);
    await prisma.creativeJob.update({
      where: { id: job.id },
      data: { metadataJson: { ...meta, cancelRequested: true, cancelRequestedAt: now().toISOString() } as Prisma.InputJsonValue },
    });
    await recordAudit({
      tenantId: user.tenantId, userId: user.id, action: 'creative.job.cancelRequested',
      payload: { jobId: job.id },
    });
    return getJobView(job.id, user.id);
  }
  // 终态（succeeded/failed/cancelled）：不改状态；已扣未产出的走幂等退款兜底一次。
  if (job.status !== 'succeeded') await refundJob(job.id, '任务未产出');
  return getJobView(job.id, user.id);
}

/* ───────────────── 供 worker / briefDraft 复用的读取器 ───────────────── */

export interface JobExecutionInput {
  job: JobRow;
  brief: NormalizedPosterBrief;
  sourceVisualAssetId: string | null;
  brandKit: Awaited<ReturnType<typeof getBrandKit>> | null;
}

/** worker 执行前把任务展开成可执行输入（含已确认的 BrandKit）。 */
export async function loadJobExecutionInput(jobId: string): Promise<JobExecutionInput | null> {
  const job = await prisma.creativeJob.findUnique({ where: { id: jobId } });
  if (!job) return null;
  const row = job as JobRow;
  const req = requestOf(row);
  // brandKitVersion 只是「用户当时引用了资产包」的意思；实际取当前 approved 版本（未确认则不用）。
  const brandKit = req.brief.brandKitVersion ? await approvedBrandKit(row.userId) : null;
  return { job: row, brief: req.brief, sourceVisualAssetId: req.sourceVisualAssetId ?? null, brandKit };
}

export { UploadRejectedError };
