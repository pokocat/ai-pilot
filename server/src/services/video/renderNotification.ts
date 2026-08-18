import type { ClipJobView } from '../../../../shared/contracts';
import { prisma } from '../../db.js';
import { settleVideoJob } from './credits.js';
import { sendWechatSubscribeMessage } from '../wechatSubscribe.js';
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
 * 幂等靠 hold 状态机上的一次**原子认领**：`updateMany({where:{status:'submitted'}})`
 * 只会有一方 count>0。认领完立刻结算，再去发推送 —— 钱的正确性优先于推送。
 * 小程序前台轮询若先把这一单结算掉，这里就选不中，也就不推；那种情况下用户本来就在看着页面。
 */
/**
 * 进程内互斥。scheduler 用的是裸 setInterval（services/scheduler.ts 没有运行中判断），
 * 一轮跑超过间隔时下一轮照样开跑，两轮同时选中同一个 submitted hold 就会重复推送。
 * 跨进程仍需选主，那是 AGENTS §13 已在案的既有约束，不在这里解决。
 */
let scanning = false;

export async function scanClipRenderNotifications(): Promise<{ scanned: number; settled: number; sent: number; failed: number }> {
  if (scanning) return { scanned: 0, settled: 0, sent: 0, failed: 0 };
  scanning = true;
  try {
    return await runScan();
  } finally {
    scanning = false;
  }
}

async function runScan(): Promise<{ scanned: number; settled: number; sent: number; failed: number }> {
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
      if (job.status !== 'succeeded' && job.status !== 'failed') {
        // 还在跑：只刷新 lastJobStatus，不认领、不推送。
        await settleVideoJob(job.id, job.status);
        continue;
      }

      // 原子认领。条件里带上 status: 'submitted'，所以并发的两轮扫描只有一方 count>0，
      // 另一方直接跳过 —— 这是「同一单只推一次」的唯一保证。
      // 认领后立刻结算：钱的正确性优先于推送，绝不能为了保住推送而让 hold 悬在中间态。
      const claimed = await prisma.videoCreditHold.updateMany({
        where: { id: hold.id, status: 'submitted' },
        data: { status: 'notifying' },
      });
      if (claimed.count === 0) continue;
      await settleVideoJob(job.id, job.status);
      settled += 1;

      // 等发送结果，别 void 掉 —— 否则 sent 统计的是「调用过」而不是「发出去了」。
      // 已知取舍：认领是单向的，所以推送失败**不会重投**。用户仍能在作品列表里看到结果，
      // 而重投需要一张独立的通知状态表（(jobId, terminalStatus) 唯一 + CAS），
      // 那要加迁移，留到下一批。真正常见的失败是 43101「用户没订阅」，本来就不该重投。
      const outcome = await sendWechatSubscribeMessage({
        tenantId: hold.tenantId,
        userId: hold.userId,
        scene: 'clip',
        title: '你的视频',
        statusText: job.status === 'succeeded' ? '已出片' : '未出片',
        note: job.status === 'succeeded' ? '视频已经生成好，点击查看' : '这次没出成，积分已退回',
        workId: job.workId ?? null,
      }).catch(() => ({ sent: false }));
      if (outcome.sent) sent += 1;
    } catch (error) {
      failed += 1;
      console.error('[clip-render-notification] poll failed:', hold.upstreamJobId, (error as Error).message);
    }
  }

  return { scanned, settled, sent, failed };
}
