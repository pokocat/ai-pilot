import type { ClipJobView } from '../../../../shared/contracts';
import { prisma } from '../../db.js';
import { settleVideoJob } from './credits.js';
import { notifyClipRendered } from '../wechatSubscribe.js';
import { aidramaJson } from './aidramaGateway.js';

/** 只看最近一天的在途单：更久以前还没终态的，属于要人工看的异常，不该由这个 job 无限重扫。 */
const WATCH_WINDOW_MS = 24 * 3600_000;
const BATCH = 100;

/**
 * 后台推进出片任务状态，并在终态时发一次微信订阅消息。
 *
 * 两件事，一个 job 里做完：
 *
 * 1. **结算**。`settleVideoJob` 此前**只**在小程序 GET /video/jobs/:id 时被调用
 *    （routes/video.ts），也就是说结算完全依赖用户停在进度页上轮询。用户一旦退出小程序，
 *    这笔 hold 就永远停在 `submitted`：出片成功了不落 settled，出片失败了也不退积分。
 *    `refundStaleUnsubmittedVideoHolds` 补不上这个洞——它只管 `upstreamJobId` 还没拿到的崩溃窗口。
 *
 * 2. **通知**。用户反馈「能不能看到大概什么时候完成」。准确的 ETA 要先攒够各 stage 的耗时样本，
 *    但「不用一直盯着」今天就能给：出好了微信推一条。
 *
 * 幂等锚点是 hold 自己的状态机：只挑 `submitted` 的单来扫，一旦 settle 成 `settled`/`refunded`
 * 就再也选不中，所以同一单不会推两次。小程序前台轮询若先把它结算掉，这里就不会再推——
 * 那种情况下用户本来就在看着页面，也不需要推送。
 */
export async function scanClipRenderNotifications(): Promise<{ scanned: number; settled: number; sent: number; failed: number }> {
  const holds = await prisma.videoCreditHold.findMany({
    where: {
      status: 'submitted',
      upstreamJobId: { not: null },
      createdAt: { gte: new Date(Date.now() - WATCH_WINDOW_MS) },
    },
    select: { id: true, tenantId: true, userId: true, upstreamJobId: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  let scanned = 0;
  let settled = 0;
  let sent = 0;
  let failed = 0;

  for (const hold of holds) {
    if (!hold.upstreamJobId) continue;
    scanned += 1;
    try {
      const job = await aidramaJson<ClipJobView>(
        `/api/me/clip/jobs/${encodeURIComponent(hold.upstreamJobId)}`,
        { userId: hold.userId, tenantId: hold.tenantId },
      );
      await settleVideoJob(job.id, job.status);
      if (job.status !== 'succeeded' && job.status !== 'failed') continue;
      settled += 1;
      // 通知永不抛：推送失败不该影响结算。没订阅的用户在 sendWechatSubscribeMessage 里被静默跳过。
      notifyClipRendered({
        tenantId: hold.tenantId,
        userId: hold.userId,
        title: '你的视频',
        workId: job.workId ?? null,
        ok: job.status === 'succeeded',
      });
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error('[clip-render-notification] poll failed:', hold.upstreamJobId, (error as Error).message);
    }
  }

  return { scanned, settled, sent, failed };
}
