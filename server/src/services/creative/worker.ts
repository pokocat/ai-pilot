// 创作任务 worker：抢占 pending → 执行管线（philosophy → visual → render → upload）→ 收口。
//
// 抢占用 `FOR UPDATE SKIP LOCKED`（天然多进程安全），**刻意不复刻 scheduler 的单实例约束**——
// scheduler 注释里写着「选主没做完，多进程只许一个实例开 SCHEDULER_ENABLED」，创作 worker 不该继承这个限制。
// 状态以 creative_job 行为真源（不是进程内 Map）：这是从两处教训来的硬要求——会话 generating 活在
// sessionGeneration 的内存 Map 里（重启即丢），知识库 processDocument 曾 fire-and-forget（重启把条目
// 永久卡在 parsing 且无人捞）。所以第一天就配 sweep 兜底 + 幂等退款。
import { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';
import { now } from '../clock.js';
import { recordAudit } from '../audit.js';
import { registerJob } from '../scheduler.js';
import { noteCreativeJobSucceeded, noteCreativeJobFailed, noteCreativeEngine } from '../metrics.js';
import { PdfUnavailableError } from '../reportPdf.js';
import { getCreativeConfig, visualProviderConfigured, type CreativeRuntimeConfig } from './config.js';
import { generatePhilosophy, philosophyText, composeVisualPrompt, type VisualPhilosophy } from './philosophy.js';
import { generateManifesto, manifestoText, type PosterManifesto } from './manifesto.js';
import { generateCanvasPoster, AI_ENGINE_BUDGET_MS, type CanvasPoster } from './canvasEngine.js';
import { photoRouteAllowedFor, resolvePosterRouteFor, isPremiumTier, type ResolvedPosterRoute } from './posterRoute.js';
import { assembleImagePrompt } from './imagePrompt.js';
import { renderPoster, PosterRenderError } from './renderer.js';
import { resolveVisualProvider } from './visualProvider.js';
import { moderate } from '../moderation.js';
import { checkImage } from './imageModeration.js';
import { creativeAssetKey, putCreativeObject, getCreativeObject, creativeAssetUrl } from './storage.js';
import { cancelRequested, loadJobExecutionInput, refundJob, POSTER_SKILL_KEY, type JobExecutionInput } from './jobs.js';
import type { TemplateAssets } from './templates.js';
import type { Deliverable, DeliverableAsset } from '../../../../shared/contracts';

const POLL_INTERVAL_MS = 2000;
/**
 * 一轮 tick 最多**连续处理**几单。注意这不是并发：下面是串行 `await runJobOnce()`，
 * 而渲染本身还被 reportPdf 的单例浏览器 + 单并发队列串起来，所以真正的并行度恒为 1。
 * 曾有一个后台可配的 `maxConcurrency`（标签写着「worker 并发槽 1–8」），那是个假承诺 ——
 * 调大它只会让任务在渲染队列里排队并同时占内存。要真并发得先把 Puppeteer 拆出 API 进程。
 */
const TICK_BATCH_SIZE = 2;
/**
 * running 超过此时长视为卡死（进程被杀 / 上游 hang），由 sweep 回收。
 *
 * ★ 两条不变式，改它必须一起看：
 *   ① 必须**大于** config.ts 的 MAX_TIMEOUT_MS（渲染超时上限 480s）；
 *   ② 必须**大于**一单的正常挂钟上限 = 宣言 + 主视觉 + `AI_ENGINE_BUDGET_MS` + 上传。
 *   任一条不满足，一次正常的长任务还没结束就被判卡死重新入队 → 同一单跑两遍、产出两张资产。
 *
 * 10min → 15min（2026-08-12）：看图打磨闭环与高级档把一单的正常上限抬到了约 580s
 * （宣言 40 + 主视觉 40 + 排版 480 + 上传 20），10 分钟只剩 20s 余量，太贴。
 * 放宽看门狗的代价只是「真卡死的单晚 5 分钟被回收」，而贴太紧的代价是双执行 —— 不对等。
 */
export const STALE_RUNNING_MS = 15 * 60_000;
/** 最大尝试次数；超过即 failed + 幂等退款。判定统一走 canRetry()。 */
export const MAX_ATTEMPTS = 3;

/**
 * 还能不能再试一次。**唯一实现**：worker 收口与 sweep 回收必须用同一把尺子 ——
 * 此前两处分别写 `attempts < MAX_ATTEMPTS` 与 `attempts <= MAX_ATTEMPTS`，
 * 于是「worker 判定已用完重试、落了终态失败」的任务，在 sweep 眼里还能再入队一次。
 * @param attempts 已发生的尝试次数（claimNextJob 抢占时就 +1，所以传进来的值含当前这次）。
 */
export function canRetry(attempts: number): boolean {
  return attempts < MAX_ATTEMPTS;
}

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

/**
 * AI 引擎回落留痕：把「最后一轮量出的违规码 + 模型最后那份 HTML」写进 metadataJson.aiDebug。
 *
 * 为什么落 metadataJson 而不是 resultJson：resultJson 是对外结论（任务台/小程序都读它），
 * 要保持轻且字段稳定 —— 回落原因已经以 `aiEngineError` 一句话在那里了。这里是排障原料：
 * 「量测器是不是误伤了某种手法」只有看到模型想画的东西才判得出来（2026-07-30 的 text_overlap 实锤
 * 就是靠猜才拖了一轮）。
 *
 * 两条注意：
 *   · **合并写**，不覆盖：同一个键上住着 cancelRequested / cancelRequestedAt（jobs.cancelJob 写的），
 *     整块替换会把用户的取消请求抹掉 → worker 的检查点再也停不下来。
 *   · 带 `status:'running'` 守卫（与本文件其它写入同口径）：任务若已被他人收口就别再碰它的行。
 * 失败只 warn：留痕是排障便利，绝不能让它把一单正常回落搞成异常。
 */
export async function recordAiDebug(
  jobId: string,
  debug: { violations: string[]; lastHtml?: string },
): Promise<void> {
  try {
    const row = await prisma.creativeJob.findUnique({ where: { id: jobId }, select: { metadataJson: true } });
    const raw = row?.metadataJson;
    const meta = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    await prisma.creativeJob.updateMany({
      where: { id: jobId, status: 'running' },
      data: {
        metadataJson: {
          ...meta,
          aiDebug: { at: now().toISOString(), violations: debug.violations, ...(debug.lastHtml ? { lastHtml: debug.lastHtml } : {}) },
        } as Prisma.InputJsonValue,
      },
    });
  } catch (e) {
    console.warn('[creative] AI 回落留痕写入失败（不影响回落）：', jobId, (e as Error).message);
  }
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

/**
 * 一次执行的结论。
 * `skipped` = 本轮什么都没做（任务已被别人收口）：不落状态、不退款、不记指标，也不算失败。
 * `providerLabel` = **实际**的主视觉来源，供 metrics 用（不是建单时那个 'configured' 快照）。
 */
interface RunOutcome {
  status: 'succeeded' | 'failed' | 'cancelled' | 'skipped';
  code?: string;
  message?: string;
  providerLabel?: string;
  /** 本轮实际用的排版引擎（metrics 与审计用）：ai | template | template_fallback。 */
  engineLabel?: string;
}

/**
 * 测试注入缝（**只为测试存在，生产恒空**）。
 *
 * 为什么需要它：AI 引擎的价值在「几条子路、什么时候退回哪一条」这套编排，而它在测试环境里根本跑不到 ——
 * `completeText` 无 live provider 恒 null，于是宣言就地失败、photo 子路一次也不会被走到。
 * 没有这个缝，「photo 失败 → graphic 同宣言重试 → 仍败 → 模板」这条三层回落链就只能靠人肉在生产上验证。
 * 口径与 canvasEngine.CanvasEngineDeps 一致：缺省即真实实现，绝不允许「没注入就跳过某一步」。
 */
export interface CreativeWorkerDeps {
  /** 宣言生成（注入以跳过真 LLM）。 */
  manifesto?: typeof generateManifesto;
  /** photo 子路的主视觉产出（注入以跳过真图片供应商与真审核）。 */
  photoVisual?: (
    input: JobExecutionInput, cfg: CreativeRuntimeConfig, route: ResolvedPosterRoute,
  ) => Promise<PhotoVisualResult>;
  /** 排版（注入以按「有没有 photoStyle」分别返回成功/失败，从而钉住回落链）。 */
  compose?: typeof generateCanvasPoster;
}

/**
 * 管线总入口。**两条排版路径 + 一条回落边**：
 *
 *   layoutEngine='ai'（默认）
 *     ├─ 宣言(LLM) → 创作 HTML(LLM) → 量测 → 无条件打磨 → 成功            → engine='ai'
 *     └─ 任一步走不通（模型不可用/宣言不完整/三轮仍违规/渲染或量测异常/超预算）
 *          → **回落模板路径的完整逻辑**                                    → engine='template_fallback'
 *   layoutEngine='template'
 *     └─ 三套白名单模板（含图片供应商主视觉）                              → engine='template'
 *
 * 回落**复用同一个 runTemplatePipeline**（不复制一份）：图片供应商调用、降级留痕（degraded/visualError）、
 * 弹性版面契约、溢出闸这些教训全在那条路径上，抄一份就等于把它们全部作废一次。
 */
async function runPipeline(input: JobExecutionInput, deps: CreativeWorkerDeps = {}): Promise<RunOutcome> {
  const { job, brief } = input;
  const cfg = await getCreativeConfig();

  // ── 阶段 1：视觉哲学（永不抛错，失败自动回退确定性哲学）──
  // 两条路径都要它：模板路径整套版式靠它，AI 路径拿它的色板作宣言色板的兜底，
  // 且它是回落时唯一还在手上的美学输入。
  await setProgress(job.id, 'philosophy');
  await checkpoint(job.id);
  const philosophy: VisualPhilosophy = await generatePhilosophy({
    brief, brandKit: input.brandKit, tenantId: job.tenantId, userId: job.userId,
  });
  // 带 status 守卫：任务若已被他人收口（sweep 回队后老进程还在跑），不该覆盖它的快照。
  await prisma.creativeJob.updateMany({
    where: { id: job.id, status: 'running' },
    data: { promptSnapshot: philosophyText(philosophy) },
  });

  // ── 阶段 2：AI 排版引擎（默认路径）──
  let aiError: string | null = null;
  if (cfg.layoutEngine === 'ai') {
    const ai = await runAiEngine(input, cfg, philosophy, deps);
    if (ai.outcome) return ai.outcome;
    aiError = ai.error ?? 'AI 引擎未产出';
    if (ai.debug) await recordAiDebug(job.id, ai.debug);
    // ★ 高级档到此为止：**连模板回落也不走**。
    //   模板海报是标准档的兜底形态；把它交给一个付了高级价的用户，是这条链路上最贵的一次货不对板。
    //   整单失败 + 全额退款（既有幂等退款路径），用户可以重试或改用标准档。
    //   注意这与标准档的回落矩阵是**刻意相反**的取舍，不要以"统一行为"为由把它抹平。
    if (isPremiumTier(brief)) {
      console.warn('[creative] 高级档 AI 引擎未产出，整单失败并退款（不回落模板）：', job.id, aiError);
      return { status: 'failed', code: 'PREMIUM_VISUAL_FAILED', message: aiError };
    }
    console.warn('[creative] AI 排版引擎未产出，回落模板路径：', job.id, aiError);
  }

  return runTemplatePipeline(input, cfg, philosophy, aiError);
}

/** photo 子路第一步（出主视觉）的结论。失败一律走 `error`，绝不抛。 */
export interface PhotoVisualResult {
  /** 已落库的 kind='visual' 资产 id（成功时必有，进 resultJson.visualAssetId）。 */
  assetId?: string;
  /** 供应商名（metrics 的 provider 维度用真实名字，不用建单时的 'configured' 快照）。 */
  providerLabel?: string;
  /** 主视觉字节的 data URI（直接喂给排版层的 {{VISUAL_URL}}，不再从 OSS 读回）。 */
  dataUri?: string;
  error?: string;
}

/** 一次「创作 → 量测 → 打磨」尝试的结论（photo 与 graphic 两条子路共用）。 */
interface CanvasAttempt {
  poster?: CanvasPoster;
  error?: string;
  debug?: { violations: string[]; lastHtml?: string };
}

/**
 * AI 排版引擎路径。**永不让整单失败**：拿不到产物就返回 error，由 runPipeline 回落模板。
 * 唯一会往外抛的是 JobCancelled（用户取消必须原样冒到 runJobOnce，不能被当成"AI 引擎失败"吞掉）。
 *
 * ── 两条子路 + 一条**内部**回落边（2026-07-30 影像主导模式）──
 *
 *   photo（影像主导，门禁见 posterRoute.ts）
 *     └─ 拼 prompt → 图片供应商出全幅无文字主视觉 → 图片审核 → 存 kind='visual' 资产
 *        → 排版层（photo 变体提示词：全幅铺底 + 安全区叠层）→ 量测/打磨/交付闸门照旧
 *   graphic（纯图形排印，上一代 AI 引擎行为，一字不改）
 *
 * **photo 链任一步失败 → 退回 graphic 复用同一篇宣言**（不重新生成宣言，省一次 LLM 调用；
 * 而且那篇宣言本身是过审过的、与本单商业目标匹配的，重新生成只会换来一篇不一定更好的）。
 * graphic 也失败才把 error 交给 runPipeline 去回落模板。三层回落链的单测在
 * server/test/creativePhotoRoute.test.ts 钉住。
 *
 * 时间预算：photo 与 graphic 两次排版**共享**同一个 AI_ENGINE_BUDGET_MS（deadline 从本函数开始算），
 * 所以 photo 烧掉大半预算后 graphic 只拿到 30s 下限（够跑一轮创作，多半没有打磨轮）。
 * 这是刻意取舍：宁可交一张没打磨的图，也不要让一单在 running 里耗到被 sweep 判卡死（那会重跑 + 两张资产）。
 */
async function runAiEngine(
  input: JobExecutionInput,
  cfg: CreativeRuntimeConfig,
  philosophy: VisualPhilosophy,
  deps: CreativeWorkerDeps = {},
): Promise<{ outcome?: RunOutcome; error?: string; debug?: { violations: string[]; lastHtml?: string } }> {
  const { job, brief } = input;
  const startedAt = Date.now();
  // 进度沿用既有四段（philosophy|visual|render|upload）：AI 引擎的创作+打磨+渲染整体属于 'render'。
  // 刻意不新增 'compose' —— 小程序的进度条是按这四个值写死的（app/src/services/creative.ts），
  // 新值会让它退回第一档文案。等前端跟上再拆。
  await setProgress(job.id, 'render');
  await checkpoint(job.id);

  // 门禁在**调宣言之前**先判一次：不满足就不给模型 photo 选项（省 token，也免得它选个走不通的）。
  const allowPhoto = photoRouteAllowedFor(cfg, brief);

  let manifesto: PosterManifesto | null;
  try {
    manifesto = await (deps.manifesto ?? generateManifesto)({
      brief, brandKit: input.brandKit, fallbackPalette: philosophy.palette,
      tenantId: job.tenantId, userId: job.userId, allowPhoto,
      // 高级档不给模型选路线的机会：给了选项它就可能选 graphic 且不给 subject，
      // 而那会让一张已经付了高级价的单在路线归一处直接判失败（预发实测过一次）。
      forcePhoto: isPremiumTier(brief),
    });
  } catch (e) {
    if (e instanceof JobCancelled) throw e;
    return { error: `AI 引擎异常：${(e as Error).message}` };
  }
  if (!manifesto) return { error: '视觉哲学宣言不可用（模型未就绪 / 产出不完整 / 未过审）' };
  // 收成 const：下面两个闭包要用它，而 let 在闭包里不会被 TS 收窄成非空。
  const doc: PosterManifesto = manifesto;
  const movement = doc.movement;
  const route = resolvePosterRouteFor(cfg, brief, doc.route);
  // 高级档但路线没能落到 photo：只可能是宣言没给出可用的 subject（供应商未配 / 本人照片这两条
  // 建单时就拦掉了）。同样**不降级交付**——整单失败 + 全额退款，用户可以重试。
  if (isPremiumTier(brief) && route.mode !== 'photo') {
    return { error: `高级海报未能确定影像主体：${route.reason}` };
  }

  // 宣言进 promptSnapshot（覆盖阶段 1 写的六维度；六维度仍拼在后面，回落排障要看得到两份）。
  // 路线裁定结论也写进去：「模型想走 photo 但被门禁降级」这件事只有这里看得见。
  await prisma.creativeJob.updateMany({
    where: { id: job.id, status: 'running' },
    data: {
      promptSnapshot: `${manifestoText(doc)}\n路线裁定：${route.mode} · ${route.reason}`
        + `\n\n—— 以下为模板回落用的六维度哲学 ——\n${philosophyText(philosophy)}`,
    },
  });
  await checkpoint(job.id);

  const moderateText = (t: string): Promise<boolean> =>
    // 交付闸门带任务上下文：审核记录要能落到这单头上（与宣言过审同一口径）。
    moderate('output', t, { tenantId: job.tenantId, userId: job.userId });
  // 预算扣掉已花的时间，且至少留 90s。
  // 这个下限 2026-08-12 从 30s 提到 90s：引擎侧现在要求「剩余 < 60s 就不开新一轮」
  // （单轮 HTML 开了思考挂钟就要 1–2.5 分钟），30s 的余量意味着 photo 烧穿预算后
  // graphic 那次重排**一轮都开不了**，三层回落链的中间那层等于不存在。
  // 最坏情况仍在 sweep 的 10 分钟内：360s 排版 + 90s 下限 + 宣言约 40s + 上传约 15s ≈ 505s。
  const budget = (): number => Math.max(90_000, AI_ENGINE_BUDGET_MS - (Date.now() - startedAt));

  const compose = async (assets: TemplateAssets, photoStyle: ResolvedPosterRoute['style'] | null): Promise<CanvasAttempt> => {
    try {
      const r = await (deps.compose ?? generateCanvasPoster)({
        brief, manifesto: doc, assets,
        ...(photoStyle ? { photoStyle } : {}),
        timeoutMs: cfg.timeoutMs,
        budgetMs: budget(),
      }, { moderateText });
      if (r.ok) return { poster: r.poster };
      // 留痕原料：违规码列表（最多 20 条，够看"卡在哪一类"）+ 模型最后那份 HTML（引擎已截断）。
      return {
        error: r.reason,
        debug: {
          violations: r.violations.slice(0, 20).map((v) => v.code),
          ...(r.lastHtml ? { lastHtml: r.lastHtml } : {}),
        },
      };
    } catch (e) {
      if (e instanceof JobCancelled) throw e;
      return { error: `AI 引擎异常：${(e as Error).message}` };
    }
  };

  /** 收口：两条子路成功时共用同一份 resultJson 口径（aiMode / styleKey 只在这里写一次）。 */
  const settle = async (o: {
    poster: CanvasPoster;
    aiMode: 'graphic' | 'photo';
    providerLabel: string;
    visualAssetId: string | null;
    photoError: string | null;
  }): Promise<RunOutcome> => {
    await checkpoint(job.id);
    return settlePoster(input, {
      rendered: o.poster,
      providerLabel: o.providerLabel,
      engineLabel: `ai${o.aiMode === 'photo' ? '_photo' : ''}:${o.poster.rounds}rounds`,
      assetMetadata: {
        engine: 'ai',
        aiMode: o.aiMode,
        movement,
        rounds: o.poster.rounds,
        visualCritiques: o.poster.visualCritiques,
        critiquePassed: o.poster.critiquePassed,
        violationsFixed: o.poster.violationsFixed,
        polishReverted: o.poster.polishReverted,
        aiMarkInjected: o.poster.aiMarkInjected,
        ...(o.aiMode === 'photo' ? { styleKey: route.styleKey, subject: route.subject } : {}),
        // 最终 HTML 只存在资产 metadata 里（排障用）；不进 CreativeJob 行，那张表要保持轻。
        html: o.poster.html,
      },
      result: {
        engine: 'ai',
        // 档位进 resultJson：任务台要能把「收了高级价」与「真的走了影像」对上账。
        tier: brief.tier,
        // 实际路线（不是配置意图）：photo 静默降级成 graphic 时任务台必须看得出来，
        // 否则「影像路线名义上开着、其实全在出图形版」又只存在于日志里（degraded 那次的教训）。
        aiMode: o.aiMode,
        ...(o.aiMode === 'photo' ? { styleKey: route.styleKey } : {}),
        rounds: o.poster.rounds,
        violationsFixed: o.poster.violationsFixed,
        ...(o.poster.polishReverted ? { polishReverted: true } : {}),
        movement,
        philosophySource: philosophy.source,
        visualAssetId: o.visualAssetId,
        degraded: false,
        // photo 尝试过但没走通（本单实际是 graphic）：原因落库，任务台展示。
        ...(o.photoError ? { photoError: o.photoError.slice(0, 300) } : {}),
      },
    });
  };

  // ── 子路 A：影像主导 ──
  let photoError: string | null = null;
  let photoDebug: { violations: string[]; lastHtml?: string } | undefined;
  if (route.mode === 'photo') {
    const visual = await (deps.photoVisual ?? runPhotoVisual)(input, cfg, route);
    if (visual.assetId && visual.dataUri) {
      // 主视觉走**手上的字节**直接拼 data URI，不再从 OSS 读回：字节已经在内存里，读回只是多一次
      // 往返和多一条「落库了却读不回」的失败分支。其它素材（logo/qr）照旧走 resolveTemplateAssets。
      const assets: TemplateAssets = { ...(await resolveTemplateAssets(input, null)), visualUrl: visual.dataUri };
      const r = await compose(assets, route.style);
      if (r.poster) {
        return {
          outcome: await settle({
            poster: r.poster,
            aiMode: 'photo',
            // photo 成功时 provider label 用真实供应商名（metrics 要能看出影像路线在跑）。
            providerLabel: visual.providerLabel ?? 'none',
            visualAssetId: visual.assetId,
            photoError: null,
          }),
        };
      }
      photoError = `影像版排版未通过：${r.error ?? '未知原因'}`;
      photoDebug = r.debug;
    } else {
      photoError = visual.error ?? '主视觉未产出';
    }
    // ★ 高级档到此为止：**不退回 graphic**。
    //   用户为「顶级图片模型出主视觉」付了高级价，交一张纯图形海报就是货不对板；
    //   而且影像链走不通通常正是供应商在出问题，那种时候更不该继续收这笔钱。
    //   返回 error → runJobOnce 走整单失败 + 全额退款（既有幂等退款路径，不新造部分退款）。
    //   标准档的三层回落链一字不动 —— 它的承诺本来就是「给你一张海报」，不是「给你一张影像海报」。
    if (isPremiumTier(brief)) {
      console.warn('[creative] 高级档影像路线失败，整单失败并退款（不降级交付）：', job.id, photoError);
      return { error: `高级海报未能生成主视觉：${photoError}`, ...(photoDebug ? { debug: photoDebug } : {}) };
    }
    console.warn('[creative] 影像主导路线未走通，退回纯图形路线（复用同一篇宣言）：', job.id, photoError);
  }

  // ── 子路 B：纯图形排印（photo 的回落边，也是默认路线）──
  const assets = await resolveTemplateAssets(input, null);
  const g = await compose(assets, null);
  if (!g.poster) {
    return {
      // 两条子路都失败时把 photo 的原因也带上：只报 graphic 的原因会让排障丢掉一半线索。
      error: photoError ? `${g.error ?? 'AI 引擎未产出'}（影像路线亦失败：${photoError}）` : g.error ?? 'AI 引擎未产出',
      ...(g.debug ? { debug: g.debug } : {}),
    };
  }
  return {
    outcome: await settle({
      poster: g.poster,
      aiMode: 'graphic',
      providerLabel: 'none',   // graphic 子路不调图片供应商
      visualAssetId: null,
      photoError,
    }),
  };
}

/**
 * photo 子路的第一步：拼 prompt → 供应商出图 → 图片审核 → 存 kind='visual' 资产。
 *
 * **一律不抛**：任何一步走不通都回 `{ error }`，由 runAiEngine 退回 graphic。
 * 特别注意图片审核不过这一格：模板路径上它是 `IMAGE_MODERATION_BLOCKED`（整单失败 + 退款），
 * 但在这里**只是这条子路不通** —— graphic 子路的画面完全不含那张图，没有理由让用户为此拿不到海报。
 */
async function runPhotoVisual(
  input: JobExecutionInput,
  cfg: CreativeRuntimeConfig,
  route: ResolvedPosterRoute,
): Promise<PhotoVisualResult> {
  const { job, brief } = input;
  await setProgress(job.id, 'visual');
  await checkpoint(job.id);
  const provider = await resolveVisualProvider(cfg);
  if (!provider) return { error: '图片供应商不可用' };

  const assembled = assembleImagePrompt({ style: route.style, subject: route.subject, brief });
  try {
    const submitted = await provider.submit({ prompt: assembled.prompt, negativePrompt: assembled.negativePrompt });
    if (submitted.status !== 'succeeded' || !submitted.image) {
      return { error: `主视觉未生成：${submitted.error ?? '供应商未返回图片'}` };
    }
    const verdict = await checkImage(submitted.image.buffer, {
      tenantId: job.tenantId, userId: job.userId, refId: job.id, scene: 'visual',
    });
    if (!verdict.pass) return { error: '主视觉未通过图片审核' };
    const saved = await saveAsset({
      jobId: job.id, tenantId: job.tenantId, userId: job.userId, kind: 'visual',
      buffer: submitted.image.buffer, mimeType: submitted.image.mimeType,
      metadata: {
        route: 'photo',
        styleKey: assembled.styleKey,
        subject: assembled.subject,
        prompt: assembled.prompt,
        negativePrompt: assembled.negativePrompt,
        // 剥了什么词也留痕：模型反复塞禁用词/景别词是提示词该改的信号，不是每次现场猜。
        ...(assembled.strippedWords.length ? { strippedWords: assembled.strippedWords } : {}),
        ...(assembled.strippedShotSizes.length ? { strippedShotSizes: assembled.strippedShotSizes } : {}),
        provider: provider.name,
        moderation: { provider: verdict.provider, skipped: !!verdict.skipped },
      },
    });
    await setProgress(job.id, 'render');
    return {
      assetId: saved.id,
      providerLabel: provider.name,
      dataUri: `data:${submitted.image.mimeType};base64,${submitted.image.buffer.toString('base64')}`,
    };
  } catch (e) {
    if (e instanceof JobCancelled) throw e;
    return { error: `主视觉生成失败：${(e as Error).message}` };
  }
}

/** 模板路径（既有逻辑原样保留）。`aiError` 非空表示这是 AI 引擎失败后的回落，需留痕。 */
async function runTemplatePipeline(
  input: JobExecutionInput,
  cfg: CreativeRuntimeConfig,
  philosophy: VisualPhilosophy,
  aiError: string | null,
): Promise<RunOutcome> {
  const { job, brief } = input;

  // ── 阶段 2：主视觉（未配供应商 / 复用父任务资产 → 跳过，不报错）──
  //
  // 降级要留痕（D7）：供应商挂掉时这里只 console.warn 过，而 CreativeJob.provider 是**建单时**
  // 的快照 'configured'、metrics 也用它 —— 结果供应商挂一整天，任务台全绿、监控全绿，
  // 用户拿到的却全是"无主视觉"版。所以把结论写进 resultJson.degraded + visualError，任务台展示。
  let visualAssetId = input.sourceVisualAssetId;
  let providerLabel = visualAssetId ? 'reused' : 'none';
  let visualError: string | null = null;
  if (!visualAssetId && visualProviderConfigured(cfg)) {
    await setProgress(job.id, 'visual');
    await checkpoint(job.id);
    const provider = await resolveVisualProvider(cfg);
    if (provider) {
      try {
        // 止血（2026-07-29）：原先只发一句 ≤80 字的 visualPrompt，palette/构图/材质全没传 →
        // 真机实测出现「墨绿页头 + 大红照片」的撞色，且「留出负空间供排版」被画成了三个空的粉色占位卡片。
        // composeVisualPrompt 把色板主色与负向约束（禁文字/禁 UI 卡片占位框/禁 logo/禁边框）拼进去，
        // 兜底文案同步加强。这条路径现在是回落路径，但仍是付费用户会拿到的图。
        const prompt = composeVisualPrompt(brief, philosophy);
        const submitted = await provider.submit({
          prompt,
          ...(brief.negativePrompt ? { negativePrompt: brief.negativePrompt } : {}),
        });
        if (submitted.status === 'succeeded' && submitted.image) {
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
          providerLabel = provider.name;
        } else {
          visualError = '主视觉未生成，本张为纯排版版式';
          console.warn('[creative] 图片供应商未产出主视觉，走纯排版路径：', job.id, submitted.error ?? '');
        }
      } catch (e) {
        // 供应商失败**不**让整个任务失败：纯排版模板本身就是完整可交付的产物（方案 §7 拍板）。
        visualError = '主视觉生成失败，本张为纯排版版式';
        console.warn('[creative] 主视觉生成失败，降级为纯排版：', job.id, (e as Error).message);
      }
    }
    // 配了供应商却没拿到图 = 降级。未配供应商是既定形态（纯排版路径），不算降级。
    if (!visualAssetId) {
      providerLabel = 'degraded';
      visualError ??= '主视觉未生成，本张为纯排版版式';
    }
  }
  const degraded = providerLabel === 'degraded';

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
  return settlePoster(input, {
    rendered,
    providerLabel,
    engineLabel: aiError ? 'template_fallback' : 'template',
    assetMetadata: {
      engine: aiError ? 'template_fallback' : 'template',
      templateKey: brief.templateKey,
      movement: philosophy.movement,
      philosophySource: philosophy.source,
    },
    result: {
      engine: aiError ? 'template_fallback' : 'template',
      templateKey: brief.templateKey,
      movement: philosophy.movement,
      philosophySource: philosophy.source,
      visualAssetId: visualAssetId ?? null,
      degraded,
      ...(visualError ? { visualError } : {}),
      // 回落原因落库：否则「AI 引擎在生产静默失效」这件事只存在于日志里，任务台全是绿的模板图。
      ...(aiError ? { aiEngineError: aiError.slice(0, 300) } : {}),
    },
  });
}

/**
 * 上传成品 + 收口（两条排版路径共用）。
 * `result` 是 resultJson 的**附加**字段，assetId/kind/宽高由本函数统一写，避免两处各写一份口径。
 */
async function settlePoster(
  input: JobExecutionInput,
  o: {
    rendered: { buffer: Buffer; mimeType: string; width: number; height: number };
    providerLabel: string;
    engineLabel: string;
    assetMetadata: Record<string, unknown>;
    result: Record<string, unknown>;
  },
): Promise<RunOutcome> {
  const { job } = input;
  const { rendered } = o;
  await setProgress(job.id, 'upload');
  await checkpoint(job.id);
  const poster = await saveAsset({
    jobId: job.id, tenantId: job.tenantId, userId: job.userId, kind: 'poster_png',
    buffer: rendered.buffer, mimeType: rendered.mimeType,
    width: rendered.width, height: rendered.height,
    metadata: o.assetMetadata,
  });

  const url = creativeAssetUrl(poster.id, poster.ossKey);
  // ★ 成功写入必须带 `status:'running'` 守卫（失败路径一直有，成功路径曾经没有）。
  // 场景：sweep 把这一单判为卡死并回队 → 别的 worker 抢走跑完置了终态，而老进程这时才回来。
  // 无守卫的 update 会把它的终态覆盖掉（连 completedAt / resultJson 一起换成本轮的），
  // 于是同一单在库里只剩一个成功结论、却挂着两张成品资产。抢不到就认输：只 warn，不抛错
  //（抛错会走 runJobOnce 的失败分支 → 触发一次不该发生的退款）。
  const settled = await prisma.creativeJob.updateMany({
    where: { id: job.id, status: 'running' },
    data: {
      status: 'succeeded',
      progress: null,
      completedAt: now(),
      resultJson: {
        assetId: poster.id,
        kind: 'poster_png',
        width: rendered.width,
        height: rendered.height,
        ...o.result,
      } as Prisma.InputJsonValue,
    },
  });
  if (settled.count === 0) {
    console.warn('[creative] 收口时任务已不在 running（已被他人收口），放弃写入本轮结果：', job.id);
    return { status: 'skipped', code: 'ALREADY_SETTLED' };
  }

  await patchDeliverable(job, {
    id: poster.id,
    kind: 'poster_png',
    mimeType: rendered.mimeType,
    width: rendered.width,
    height: rendered.height,
    previewUrl: url,
    downloadUrl: url,
  }).catch((e) => console.error('[creative] 成果消息回写失败（不影响任务成功）：', (e as Error).message));

  return { status: 'succeeded', providerLabel: o.providerLabel, engineLabel: o.engineLabel };
}

/**
 * 已抢占的任务无法展开成可执行输入时，直接落终态并退款——不能让它留在 running 等 sweep 兜（10 分钟）。
 * **只有真的把 running 改成 failed 才退款**：这个函数在状态守卫之前被调用（判状态得先加载，而它
 * 正是加载失败的分支），若无条件退款，一个已成功交付的任务只要 requestJson 恰好读不出来，
 * 就会白退给用户 10 钻。抢不到就当作已被他人收口。
 */
async function failUnloadable(jobId: string, code: string, message: string): Promise<RunOutcome> {
  const claimed = await prisma.creativeJob.updateMany({
    where: { id: jobId, status: 'running' },
    data: { status: 'failed', progress: null, completedAt: now(), errorCode: code, errorMessage: message.slice(0, 500) },
  });
  if (claimed.count === 0) {
    console.warn('[creative] 展开失败但任务已不在 running，跳过收口与退款：', jobId, code);
    return { status: 'skipped', code: 'NOT_RUNNING' };
  }
  await refundJob(jobId, `失败 · ${code}`).catch(() => {});
  noteCreativeJobFailed(POSTER_SKILL_KEY, 'none', code);
  return { status: 'failed', code, message };
}

/** 执行一个已抢占的任务并收口（成功/失败/取消都在这里落库；失败一律幂等退款）。 */
export async function runJobOnce(jobId: string, deps: CreativeWorkerDeps = {}): Promise<RunOutcome> {
  // 展开阶段自身也会抛（requestJson 损坏 → BRIEF_MISSING）。它在 try 之外，所以必须单独收口，
  // 否则任务会一直停在 running（正是「知识库条目永久卡在 parsing」那类坑的复刻）。
  let input: JobExecutionInput | null;
  try {
    input = await loadJobExecutionInput(jobId);
  } catch (e) {
    return failUnloadable(jobId, (e as { code?: string }).code ?? 'INTERNAL', (e as Error).message);
  }
  if (!input) return failUnloadable(jobId, 'NOT_FOUND', '任务不存在');

  // 双执行闸（D3 前半）：只有仍是 running 的任务才允许进管线。
  // 光靠收口时的 status 守卫不够——管线中途会 saveAsset，等到最后一步才发现"已被他人收口"时，
  // 第二张成品资产已经落库了（资产不会因为状态写失败而消失）。所以在入口就判一次。
  if (input.job.status !== 'running') {
    console.warn('[creative] 任务不在 running，跳过本轮执行：', jobId, input.job.status);
    return { status: 'skipped', code: 'NOT_RUNNING' };
  }

  let outcome: RunOutcome;
  try {
    outcome = await runPipeline(input, deps);
  } catch (e) {
    outcome = e instanceof JobCancelled
      ? { status: 'cancelled', code: 'CANCELLED', message: '用户取消' }
      : { status: 'failed', code: (e as { code?: string }).code ?? 'INTERNAL', message: (e as Error).message };
  }

  if (outcome.status === 'skipped') return outcome; // 已被他人收口：不落状态、不退款、不记指标

  if (outcome.status === 'succeeded') {
    // provider 标签用**本轮实际结果**（reused / 供应商名 / degraded），不是建单时的 'configured' 快照——
    // 用快照的后果是供应商挂掉时监控看不出任何异常。
    noteCreativeJobSucceeded(POSTER_SKILL_KEY, outcome.providerLabel ?? 'none');
    // 引擎维度单独一个计数器（不往 creativeJobs 那个 counter 上加标签：同名指标的标签集必须稳定，
    // created/failed 事件没有 engine 这一维，混着加会让同一指标出现两种 series 形状）。
    noteCreativeEngine(POSTER_SKILL_KEY, outcome.engineLabel ?? 'template');
    await recordAudit({
      tenantId: input.job.tenantId, userId: input.job.userId, action: 'creative.job.succeeded',
      payload: {
        jobId, templateKey: input.brief.templateKey, provider: outcome.providerLabel ?? 'none',
        engine: outcome.engineLabel ?? 'template',
      },
    });
    return outcome;
  }

  // 失败/取消：落错误 + 幂等退款。attempts 用完才算终态失败，否则回 pending 让下一轮重试。
  const providerLabel = input.job.provider ?? 'none';
  const retriable = outcome.status === 'failed'
    && canRetry(input.job.attempts)
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

/**
 * 跑一轮：串行抢占并执行至多 TICK_BATCH_SIZE 单。返回本轮处理的任务数（供测试驱动，不依赖真实计时器）。
 * 功能开关在这里判（getCreativeConfig 走 featureFlag 的 60s 缓存，所以 2s 轮询不会每次都打 DB）。
 */
export async function tickCreativeWorker(): Promise<number> {
  const cfg = await getCreativeConfig();
  if (!cfg.enabled) return 0; // 功能关闭时不消费队列（已入队的任务留着，开启后继续）
  let handled = 0;
  for (let i = 0; i < TICK_BATCH_SIZE; i++) {
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
    if (canRetry(job.attempts)) {
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

/**
 * 启动 worker 轮询（2s）。NODE_ENV=test 不自启——测试直接调 tickCreativeWorker 驱动。
 *
 * **无条件起定时器**：功能开关由 tick 内部判（关着就 return 0，不碰队列）。曾在这里读部署级
 * env CANVAS_DESIGN_ENABLED 提前 return —— 那个 env 已删，而且改成"启动时读一次 DB 开关"是错的：
 * 进程启动早于运营放量，读一次就永远不轮询了，运营在后台打开开关也得等重启。
 * 空转成本可忽略：tick 第一件事是 getCreativeConfig()，走 featureFlag 的 60s 缓存 →
 * 关闭状态下每分钟才一次单行主键查询。
 */
export function startCreativeWorker(): void {
  if (timer || process.env.NODE_ENV === 'test') return;
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
