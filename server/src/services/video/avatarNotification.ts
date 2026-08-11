import type { ClipAvatarView } from '../../../../shared/contracts';
import { prisma } from '../../db.js';
import { now } from '../clock.js';
import { sendWechatSubscribeMessage } from '../wechatSubscribe.js';
import { aidramaJson } from './aidramaGateway.js';

const WATCH_WINDOW_MS = 24 * 3600_000;

export type AvatarNotificationOutcome = 'ready' | 'failed' | null;

/**
 * 只以 Avatar 形象任务为创建成功标准；视频原声 / 专属声音是独立增强，不得阻断。
 * image training / 尚无任务时继续等待，不能把中间态误报给用户。
 */
export function avatarNotificationOutcome(view: ClipAvatarView | null): AvatarNotificationOutcome {
  if (!view) return null;
  if (view.imageStatus === 'failed') return 'failed';
  if (view.imageStatus === 'ready') return 'ready';
  return null;
}

/**
 * 后台推进石榴训练状态并发送一次微信订阅消息。
 *
 * AIStar 的 GET /avatar 会查询石榴 Avatar 任务并推进 training -> ready/failed；
 * 不能只靠小程序页面轮询，否则用户点击“通知我”后离开页面，状态永远没人推进。
 * acceptedAt > lastSentAt 是一次训练通知的幂等锚点：重复 scheduler 不会重复发送；
 * 用户未来重新训练并再次点订阅后，acceptedAt 更新，允许下一次通知。
 */
export async function scanAvatarTrainingNotifications(): Promise<{ scanned: number; sent: number; failed: number }> {
  const cutoff = new Date(now().getTime() - WATCH_WINDOW_MS);
  const subscriptions = await prisma.wechatSubscription.findMany({
    where: {
      scene: 'avatar', status: 'accept', remaining: { gt: 0 },
      acceptedAt: { not: null, gte: cutoff },
    },
    select: { tenantId: true, userId: true, acceptedAt: true, lastSentAt: true },
    orderBy: { acceptedAt: 'asc' },
    take: 100,
  });

  let scanned = 0;
  let sent = 0;
  let failed = 0;
  for (const sub of subscriptions) {
    if (!sub.acceptedAt || (sub.lastSentAt && sub.acceptedAt <= sub.lastSentAt)) continue;
    scanned += 1;
    try {
      const view = await aidramaJson<ClipAvatarView | null>('/api/me/clip/avatar', {
        userId: sub.userId,
        tenantId: sub.tenantId,
      });
      const outcome = avatarNotificationOutcome(view);
      if (!outcome) continue;
      const result = await sendWechatSubscribeMessage({
        tenantId: sub.tenantId,
        userId: sub.userId,
        scene: 'avatar',
        title: '数字分身训练',
        statusText: outcome === 'ready' ? '已完成' : '训练失败',
        note: outcome === 'ready' ? '数字人形象已就绪，可以开始制作视频' : '训练未完成，请返回查看原因',
      });
      if (result.sent) sent += 1;
      else if (result.retryable) failed += 1;
    } catch (error) {
      failed += 1;
      console.error('[avatar-notification] poll failed:', sub.userId, (error as Error).message);
    }
  }
  return { scanned, sent, failed };
}
