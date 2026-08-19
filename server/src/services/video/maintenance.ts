import type { ClipAvatarView, ClipVoiceView } from '../../../../shared/contracts';
import { aidramaJson, VideoGatewayError } from './aidramaGateway.js';
import { refundStaleUnsubmittedCloneHolds, refundStalledCloneHolds, type CloneStatusProbe } from './cloneCredits.js';
import { reconcileStaleUnsubmittedVideoHolds, type VideoSubmissionProbe } from './credits.js';

const enc = (value: string) => encodeURIComponent(value);
const validId = (value: string) => /^[A-Za-z0-9_-]{3,100}$/.test(value);

/** 克隆卡死兜底前先问上游；查不清就继续保留，绝不靠超时猜失败。 */
export const stalledCloneProbe: CloneStatusProbe = async (hold) => {
  const targetId = String(hold.targetId ?? '').trim();
  if (!targetId || !validId(targetId)) return null;
  const identity = { userId: hold.userId, tenantId: hold.tenantId };
  try {
    if (hold.targetKind === 'voice') {
      const view = await aidramaJson<ClipVoiceView>(`/api/me/clip/voices/${enc(targetId)}`, identity, { timeoutCapMs: 10_000 });
      return view?.status ?? null;
    }
    const view = await aidramaJson<ClipAvatarView>(`/api/me/clip/avatars/${enc(targetId)}`, identity, { timeoutCapMs: 10_000 });
    return view?.imageStatus ?? null;
  } catch { return null; }
};

/** 出片提交结果不明时按原 clientRequestId 查单并幂等补交；只有权威拒绝才允许退款。 */
export const videoSubmissionProbe: VideoSubmissionProbe = async (hold) => {
  const identity = { userId: hold.userId, tenantId: hold.tenantId };
  try {
    const found = await aidramaJson<{ jobId: string; status?: string }>(
      `/api/me/clip/jobs/by-request/${enc(hold.clientRequestId)}`, identity, { timeoutCapMs: 10_000 },
    );
    if (!validId(found.jobId)) throw new Error('视频服务返回的任务标识非法');
    return { outcome: 'accepted', jobId: found.jobId, status: found.status };
  } catch (error) {
    if (!(error instanceof VideoGatewayError) || error.statusCode !== 404) return { outcome: 'unknown' };
  }
  try {
    const created = await aidramaJson<{ jobId: string; status?: string }>(
      `/api/me/clip/projects/${enc(hold.projectId)}/render`, identity,
      { method: 'POST', body: { clientRequestId: hold.clientRequestId, externalCreditsHeld: hold.credits } },
    );
    if (!validId(created.jobId)) throw new Error('视频服务返回的任务标识非法');
    return { outcome: 'accepted', jobId: created.jobId, status: created.status };
  } catch (error) {
    if (error instanceof VideoGatewayError && [400, 401, 403, 404, 422].includes(error.statusCode)) {
      return { outcome: 'rejected', reason: error.code };
    }
    return { outcome: 'unknown' };
  }
};

/** 由全局 scheduler 选主后执行，禁止在每个 API 路由实例各起一份 timer。 */
export async function runVideoMaintenanceSweep(): Promise<void> {
  await Promise.all([
    reconcileStaleUnsubmittedVideoHolds(videoSubmissionProbe),
    refundStaleUnsubmittedCloneHolds(),
    refundStalledCloneHolds(undefined, stalledCloneProbe),
  ]);
}
