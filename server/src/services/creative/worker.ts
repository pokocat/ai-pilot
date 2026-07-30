// 创作任务 worker：抢占 pending → 执行管线（philosophy → visual → render → upload）→ 收口。
//
// 抢占用 `FOR UPDATE SKIP LOCKED`（天然多进程安全），**刻意不复刻 scheduler 的单实例约束**——
// scheduler 注释里写着「选主没做完，多进程只许一个实例开 SCHEDULER_ENABLED」，创作 worker 不该继承这个限制。
// 状态以 creative_job 行为真源（不是进程内 Map）：这是从两处教训来的硬要求——会话 generating 活在
// sessionGeneration 的内存 Map 里（重启即丢），知识库 processDocument 曾 fire-and-forget（重启把条目
// 永久卡在 parsing 且无人捞）。所以第一天就配 sweep 兜底 + 幂等退款。
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { env } from '../../env.js';
import { now } from '../clock.js';
import { recordAudit } from '../audit.js';
import { registerJob } from '../scheduler.js';
import { noteCreativeJobSucceeded, noteCreativeJobFailed } from '../metrics.js';
import { PdfUnavailableError } from '../reportPdf.js';
import { getCreativeConfig, visualProviderConfigured } from './config.js';
import { generatePhilosophy, philosophyText, type VisualPhilosophy } from './philosophy.js';
import { renderPoster, PosterRenderError } from './renderer.js';
import { resolveVisualProvider } from './visualProvider.js';
import { checkImage } from './imageModeration.js';
import { creativeAssetKey, putCreativeObject, getCreativeObject, creativeAssetUrl } from './storage.js';
import { cancelRequested, loadJobExecutionInput, refundJob, POSTER_SKILL_KEY, type JobExecutionInput } from './jobs.js';
import type { TemplateAssets } from './templates.js';
import type { Deliverable, DeliverableAsset } from '../../../../shared/contracts';

const POLL_INTERVAL_MS = 2000;
/** running 超过此时长视为卡死（进程被杀 / 上游 hang），由 sweep 回收。 */
export const STALE_RUNNING_MS = 10 * 60_000;
/** 最大尝试次数；超过即 failed + 幂等退款。 */
export const MAX_ATTEMPTS = 3;

class JobCancelled extends Error {
  readonly code = 'CANCELLED';
  constructor() { super('用户取消'); }
}

/* ───────────────── 抢占 ───────────────── */

/**
 * 抢一个 pending 任务并置 running。
 * `FOR UPDATE SKIP LOCKED` 让多个 worker 各拿各的行、互不阻塞；事务内改状态保证「抢到 = 已占位」。
 */
export async function claimNextJob(): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM creative_job
      WHERE status = 'pending'
      ORDER BY "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    const id = rows[0]?.id;
    if (!id) return null;
    await tx.creativeJob.update({
      where: { id },
      data: { status: 'running', startedAt: now(), progress: 'philosophy', attempts: { increment: 1 }, errorCode: null, errorMessage: null },
    });
    return id;
  });
}

async function setProgress(jobId: string, progress: string): Promise<void> {
  await prisma.creativeJob.updateMany({ where: { id: jobId, status: 'running' }, data: { progress } });
}

/** 阶段检查点：用户请求取消就在这里停（不强杀，避免留悬空产物）。 */
async function checkpoint(jobId: string): Promise<void> {
  const row = await prisma.creativeJob.findUnique({ where: { id: jobId }, select: { metadataJson: true } });
  if (row && cancelRequested(row.metadataJson)) throw new JobCancelled();
}

/* ───────────────── 资产读写 ───────────────── */

async function assetDataUri(ossKey: string, mimeType: string): Promise<string | null> {
  const buf = await getCreativeObject(ossKey);
  if (!buf?.length) return null;
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}

/**
 * 把 brief 引用的素材解析成模板可用的 URL。
 * 一律走 **data URI**（读回字节内联），不用签名 URL：签名链接有过期时间，而渲染是在无头浏览器里
 * 取图——一旦签名在渲染时刻恰好过期，产出的就是一张缺图的海报，且没有任何报错。内联字节没有这个窗口。
 */
async function resolveTemplateAssets(input: JobExecutionInput, visualAssetId: string | null): Promise<TemplateAssets> {
  const ids = [input.brief.portraitAssetId, input.brief.logoAssetId, input.brief.qrAssetId, visualAssetId]
    .filter((v): v is string => !!v);
  if (!ids.length) return {};
  const rows = await prisma.creativeAsset.findMany({
    where: { id: { in: [...new Set(ids)] }, userId: input.job.userId },
    select: { id: true, ossKey: true, mimeType: true },
  });
  const map = new Map(rows.map((r) => [r.id, r]));
  const pick = async (id?: string | null): Promise<string | null> => {
    if (!id) return null;
    const row = map.get(id);
    if (!row?.ossKey) return null;
    return assetDataUri(row.ossKey, row.mimeType);
  };
  return {
    portraitUrl: await pick(input.brief.portraitAssetId),
    logoUrl: await pick(input.brief.logoAssetId),
    qrUrl: await pick(input.brief.qrAssetId),
    visualUrl: await pick(visualAssetId),
  };
}

async function saveAsset(opts: {
  jobId: string; tenantId: string; userId: string;
  kind: 'visual' | 'poster_png';
  buffer: Buffer; mimeType: string;
  width?: number; height?: number;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; ossKey: string }> {
  const asset = await prisma.creativeAsset.create({
    data: {
      jobId: opts.jobId,
      tenantId: opts.tenantId,
      userId: opts.userId,
      kind: opts.kind,
      ossKey: '',
      mimeType: opts.mimeType,
      bytes: opts.buffer.length,
      ...(opts.width ? { width: opts.width } : {}),
      ...(opts.height ? { height: opts.height } : {}),
      ...(opts.metadata ? { metadataJson: opts.metadata as Prisma.InputJsonValue } : {}),
    },
    select: { id: true },
  });
  const ossKey = creativeAssetKey({ tenantId: opts.tenantId, jobId: opts.jobId, assetId: asset.id, mimeType: opts.mimeType });
  await putCreativeObject(ossKey, opts.buffer, opts.mimeType);
  await prisma.creativeAsset.update({ where: { id: asset.id }, data: { ossKey } });
  return { id: asset.id, ossKey };
}

/* ───────────────── 成果消息回写 ───────────────── */

/**
 * 任务成功后把 DeliverableAsset 补进成果消息 contentJson（与 render_report 写回 htmlUrl 同一路径）。
 * 归属再校验一次（messageId 是建单时存的，但消息可能已被删；也不能靠建单时的校验兜住之后的变化）。
 */
async function patchDeliverable(job: { id: string; messageId: string | null; userId: string }, asset: DeliverableAsset): Promise<void> {
  if (!job.messageId) return;
  const msg = await prisma.message.findFirst({
    where: { id: job.messageId, role: 'report', session: { userId: job.userId } },
    select: { id: true, contentJson: true },
  });
  if (!msg) {
    console.warn('[creative] 成果消息不存在或已不属该用户，跳过回写：', job.messageId);
    return;
  }
  const deliverable = (msg.contentJson ?? {}) as unknown as Deliverable;
  const prev = Array.isArray(deliverable.assets) ? deliverable.assets : [];
  // 同 kind 只留最新一张：版本链在 CreativeJob 上，成果卡只展示「最近一次成功」的成品。
  const assets = [...prev.filter((a) => a.kind !== asset.kind), asset];
  await prisma.message.update({
    where: { id: msg.id },
    data: { contentJson: { ...(deliverable as object), assets, creativeJobId: job.id } as unknown as Prisma.InputJsonValue },
  });
}

/* ───────────────── 执行管线 ───────────────── */

interface RunOutcome { status: 'succeeded' | 'failed' | 'cancelled'; code?: string; message?: string }

async function runPipeline(input: JobExecutionInput): Promise<RunOutcome> {
  const { job, brief } = input;
  const cfg = await getCreativeConfig();

  // ── 阶段 1：视觉哲学（永不抛错，失败自动回退确定性哲学）──
  await setProgress(job.id, 'philosophy');
  await checkpoint(job.id);
  const philosophy: VisualPhilosophy = await generatePhilosophy({
    brief, brandKit: input.brandKit, tenantId: job.tenantId, userId: job.userId,
  });
  await prisma.creativeJob.update({
    where: { id: job.id },
    data: { promptSnapshot: philosophyText(philosophy) },
  });

  // ── 阶段 2：主视觉（未配供应商 / 复用父任务资产 → 跳过，不报错）──
  let visualAssetId = input.sourceVisualAssetId;
  if (!visualAssetId && visualProviderConfigured(cfg)) {
    await setProgress(job.id, 'visual');
    await checkpoint(job.id);
    const provider = await resolveVisualProvider(cfg);
    if (provider) {
      try {
        const prompt = philosophy.visualPrompt?.trim()
          || `${brief.visualDirection || philosophy.mood || '克制的商业海报主视觉'}；在画面上部留出干净负空间供后续排版；画面中不要出现任何文字`;
        const submitted = await provider.submit({
          prompt,
          ...(brief.negativePrompt ? { negativePrompt: brief.negativePrompt } : {}),
        });
        if (submitted.status === 'pending' && submitted.taskId) {
          // 异步供应商：记下 providerTaskId 让 sweep 续查，本轮先按「无主视觉」继续出图——
          // 用户宁可先拿到一版纯排版，也不该盯着「制作中」等一个不知何时回来的上游。
          await prisma.creativeJob.update({ where: { id: job.id }, data: { providerTaskId: submitted.taskId } });
          console.warn('[creative] 图片供应商返回异步任务，本轮走纯排版路径：', job.id, submitted.taskId);
        } else if (submitted.status === 'succeeded' && submitted.image) {
          const verdict = await checkImage(submitted.image.buffer, {
            tenantId: job.tenantId, userId: job.userId, refId: job.id, scene: 'visual',
          });
          if (!verdict.pass) return { status: 'failed', code: 'IMAGE_MODERATION_BLOCKED', message: '主视觉未通过图片审核' };
          const saved = await saveAsset({
            jobId: job.id, tenantId: job.tenantId, userId: job.userId, kind: 'visual',
            buffer: submitted.image.buffer, mimeType: submitted.image.mimeType,
            metadata: { prompt, provider: provider.name, moderation: { provider: verdict.provider, skipped: !!verdict.skipped } },
          });
          visualAssetId = saved.id;
        } else {
          console.warn('[creative] 图片供应商未产出主视觉，走纯排版路径：', job.id, submitted.error ?? '');
        }
      } catch (e) {
        // 供应商失败**不**让整个任务失败：纯排版模板本身就是完整可交付的产物（方案 §7 拍板）。
        console.warn('[creative] 主视觉生成失败，降级为纯排版：', job.id, (e as Error).message);
      }
    }
  }

  // ── 阶段 3：渲染 ──
  await setProgress(job.id, 'render');
  await checkpoint(job.id);
  const assets = await resolveTemplateAssets(input, visualAssetId);
  let rendered;
  try {
    rendered = await renderPoster({ brief, philosophy, assets }, { timeoutMs: cfg.timeoutMs });
  } catch (e) {
    if (e instanceof PdfUnavailableError) return { status: 'failed', code: 'PDF_UNAVAILABLE', message: e.message };
    if (e instanceof PosterRenderError) return { status: 'failed', code: 'POSTER_RENDER_FAILED', message: e.message };
    throw e;
  }

  // ── 阶段 4：上传 + 收口 ──
  await setProgress(job.id, 'upload');
  await checkpoint(job.id);
  const poster = await saveAsset({
    jobId: job.id, tenantId: job.tenantId, userId: job.userId, kind: 'poster_png',
    buffer: rendered.buffer, mimeType: rendered.mimeType,
    width: rendered.width, height: rendered.height,
    metadata: { templateKey: brief.templateKey, movement: philosophy.movement, philosophySource: philosophy.source },
  });

  const url = creativeAssetUrl(poster.id, poster.ossKey);
  await prisma.creativeJob.update({
    where: { id: job.id },
    data: {
      status: 'succeeded',
      progress: null,
      completedAt: now(),
      resultJson: {
        assetId: poster.id,
        kind: 'poster_png',
        width: rendered.width,
        height: rendered.height,
        templateKey: brief.templateKey,
        movement: philosophy.movement,
        philosophySource: philosophy.source,
        visualAssetId: visualAssetId ?? null,
      } as Prisma.InputJsonValue,
    },
  });

  await patchDeliverable(job, {
    id: poster.id,
    kind: 'poster_png',
    mimeType: rendered.mimeType,
    width: rendered.width,
    height: rendered.height,
    previewUrl: url,
    downloadUrl: url,
  }).catch((e) => console.error('[creative] 成果消息回写失败（不影响任务成功）：', (e as Error).message));

  return { status: 'succeeded' };
}

/** 已抢占的任务无法展开成可执行输入时，直接落终态并退款——不能让它留在 running 等 sweep 兜（10 分钟）。 */
async function failUnloadable(jobId: string, code: string, message: string): Promise<RunOutcome> {
  await prisma.creativeJob.updateMany({
    where: { id: jobId, status: 'running' },
    data: { status: 'failed', progress: null, completedAt: now(), errorCode: code, errorMessage: message.slice(0, 500) },
  });
  await refundJob(jobId, `失败 · ${code}`).catch(() => {});
  noteCreativeJobFailed(POSTER_SKILL_KEY, 'none', code);
  return { status: 'failed', code, message };
}

/** 执行一个已抢占的任务并收口（成功/失败/取消都在这里落库；失败一律幂等退款）。 */
export async function runJobOnce(jobId: string): Promise<RunOutcome> {
  // 展开阶段自身也会抛（requestJson 损坏 → BRIEF_MISSING）。它在 try 之外，所以必须单独收口，
  // 否则任务会一直停在 running（正是「知识库条目永久卡在 parsing」那类坑的复刻）。
  let input: JobExecutionInput | null;
  try {
    input = await loadJobExecutionInput(jobId);
  } catch (e) {
    return failUnloadable(jobId, (e as { code?: string }).code ?? 'INTERNAL', (e as Error).message);
  }
  if (!input) return failUnloadable(jobId, 'NOT_FOUND', '任务不存在');
  const providerLabel = input.job.provider ?? 'none';

  let outcome: RunOutcome;
  try {
    outcome = await runPipeline(input);
  } catch (e) {
    outcome = e instanceof JobCancelled
      ? { status: 'cancelled', code: 'CANCELLED', message: '用户取消' }
      : { status: 'failed', code: (e as { code?: string }).code ?? 'INTERNAL', message: (e as Error).message };
  }

  if (outcome.status === 'succeeded') {
    noteCreativeJobSucceeded(POSTER_SKILL_KEY, providerLabel);
    await recordAudit({
      tenantId: input.job.tenantId, userId: input.job.userId, action: 'creative.job.succeeded',
      payload: { jobId, templateKey: input.brief.templateKey },
    });
    return outcome;
  }

  // 失败/取消：落错误 + 幂等退款。attempts 用完才算终态失败，否则回 pending 让下一轮重试。
  const retriable = outcome.status === 'failed'
    && input.job.attempts < MAX_ATTEMPTS
    && outcome.code !== 'IMAGE_MODERATION_BLOCKED'   // 审核结论重试无意义
    && outcome.code !== 'BRIEF_MISSING';
  if (retriable) {
    await prisma.creativeJob.updateMany({
      where: { id: jobId, status: 'running' },
      data: { status: 'pending', progress: null, errorCode: outcome.code ?? null, errorMessage: outcome.message?.slice(0, 500) ?? null },
    });
    console.warn(`[creative] 任务失败将重试（第 ${input.job.attempts} 次）：`, jobId, outcome.code, outcome.message);
    return outcome;
  }

  await prisma.creativeJob.updateMany({
    where: { id: jobId, status: 'running' },
    data: {
      status: outcome.status,
      progress: null,
      completedAt: now(),
      errorCode: outcome.code ?? null,
      errorMessage: outcome.message?.slice(0, 500) ?? null,
    },
  });
  await refundJob(jobId, outcome.status === 'cancelled' ? '用户取消' : `失败 · ${outcome.code ?? 'INTERNAL'}`).catch((e) =>
    console.error('[creative] 退款失败（sweep 会重试）：', jobId, (e as Error).message));
  if (outcome.status === 'failed') {
    noteCreativeJobFailed(POSTER_SKILL_KEY, providerLabel, outcome.code ?? 'INTERNAL');
    await recordAudit({
      tenantId: input.job.tenantId, userId: input.job.userId, action: 'creative.job.failed',
      payload: { jobId, code: outcome.code ?? null, message: outcome.message?.slice(0, 300) ?? null, attempts: input.job.attempts },
    });
  }
  return outcome;
}

/** 跑一轮：按并发槽抢占并执行。返回本轮处理的任务数（供测试驱动，不依赖真实计时器）。 */
export async function tickCreativeWorker(): Promise<number> {
  const cfg = await getCreativeConfig();
  if (!cfg.enabled) return 0; // 功能关闭时不消费队列（已入队的任务留着，开启后继续）
  const slots = Math.max(1, cfg.maxConcurrency);
  let handled = 0;
  for (let i = 0; i < slots; i++) {
    const jobId = await claimNextJob();
    if (!jobId) break;
    handled += 1;
    await runJobOnce(jobId).catch((e) => console.error('[creative] worker 执行异常：', jobId, (e as Error).message));
  }
  return handled;
}

/* ───────────────── sweep（服务重启自愈；照抄支付对账的「状态列 + 周期扫描」模板） ───────────────── */

export async function sweepCreativeJobs(): Promise<{ requeued: number; failed: number }> {
  const stats = { requeued: 0, failed: 0 };
  const cutoff = new Date(now().getTime() - STALE_RUNNING_MS);
  const stale = await prisma.creativeJob.findMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    orderBy: { startedAt: 'asc' },
    take: 50,
    select: { id: true, tenantId: true, userId: true, attempts: true },
  });
  for (const job of stale) {
    if (job.attempts <= MAX_ATTEMPTS) {
      const r = await prisma.creativeJob.updateMany({
        where: { id: job.id, status: 'running' },
        data: { status: 'pending', progress: null, errorCode: 'STALE_REQUEUED', errorMessage: '超时未完成，已重新入队' },
      });
      if (r.count > 0) stats.requeued += 1;
      continue;
    }
    const r = await prisma.creativeJob.updateMany({
      where: { id: job.id, status: 'running' },
      data: { status: 'failed', progress: null, completedAt: now(), errorCode: 'TIMEOUT', errorMessage: '超过最大重试次数' },
    });
    if (r.count > 0) {
      stats.failed += 1;
      await refundJob(job.id, '超时失败').catch(() => {});
      await recordAudit({
        tenantId: job.tenantId, userId: job.userId, action: 'creative.job.swept',
        payload: { jobId: job.id, attempts: job.attempts, reason: 'stale running' },
      });
    }
  }
  // 已扣未退的终态任务兜底（退款曾抛错、或历史遗留）：refundJob 幂等，重扫无副作用。
  const unrefunded = await prisma.creativeJob.findMany({
    where: { status: { in: ['failed', 'cancelled'] }, chargedAt: { not: null }, refundedAt: null, creditCost: { gt: 0 } },
    take: 50,
    select: { id: true },
  });
  for (const job of unrefunded) await refundJob(job.id, '兜底退款').catch(() => {});
  return stats;
}

registerJob({
  name: 'creative-job-sweep',
  intervalMs: 5 * 60_000,
  run: async () => {
    const r = await sweepCreativeJobs();
    if (r.requeued || r.failed) console.log(`[scheduler] creative sweep: requeued=${r.requeued} failed=${r.failed}`);
  },
});

/* ───────────────── 生命周期 ───────────────── */

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

/** 启动 worker 轮询（2s）。NODE_ENV=test 不自启——测试直接调 tickCreativeWorker 驱动。 */
export function startCreativeWorker(): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  if (!env.canvasDesignEnabled) return; // 部署级硬开关关着就不轮询（DB 开关由 tick 内部再判一次）
  timer = setInterval(() => {
    if (ticking) return; // 上一轮还没跑完就跳过，避免 tick 叠加
    ticking = true;
    void tickCreativeWorker()
      .catch((e) => console.error('[creative] worker tick 失败：', (e as Error).message))
      .finally(() => { ticking = false; });
  }, POLL_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.(); // 不阻止进程退出
  console.log('[creative] worker started · poll 2s');
}

export function stopCreativeWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
  ticking = false;
}
