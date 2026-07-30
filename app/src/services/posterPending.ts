import Taro from '@tarojs/taro';

// 「点击生成 → 任务落库」窗口的客户端交接标记（同 services/chatPending 的思路，另存一份 key，
// 不动聊天那套）。桥的是这个真实缺口：用户在确认页点了生成，请求在途时退出/杀进程 ——
// 服务端可能已经建单并扣了钻石，客户端却没拿到 jobId，重进就再也找不回那次任务。
//
// 存 idempotencyKey：重进确认页时**沿用同一个键**再提交一次，服务端按 (userId, idempotencyKey)
// 唯一约束返回原任务（reused=true，不重复扣费），用户不会被扣两次。
// 拿到 jobId 后回写，重进直接跳详情页。TTL 10 分钟（= 服务端单任务超时上限），过期即视为无关。
//
// 服务端 CreativeJob 始终是权威真值；本标记只桥接网络往返，不参与任何状态判定。
const KEY = 'junshi.poster.pending.v1';
const TTL_MS = 10 * 60_000;

export interface PosterPendingEntry {
  idempotencyKey: string;
  jobId?: string;
  at: number;
}
type PendingMap = Record<string, PosterPendingEntry>;

function read(): PendingMap {
  try {
    const raw = Taro.getStorageSync(KEY);
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(parsed as PendingMap).filter(([, v]) =>
        !!v && typeof v.idempotencyKey === 'string' && Number.isFinite(v.at) && now - v.at < TTL_MS),
    );
  } catch {
    return {};
  }
}

function write(value: PendingMap) {
  try {
    if (Object.keys(value).length) Taro.setStorageSync(KEY, value);
    else Taro.removeStorageSync(KEY);
  } catch { /* storage 不可用时退化为「每次都新建幂等键」，不影响主流程 */ }
}

/** 归一 scope：一个成果消息一条在途记录；没有 messageId（会话外发起）时按会话兜底。 */
export function posterScope(messageId?: string, sessionId?: string): string {
  return `m:${messageId || ''}|s:${sessionId || ''}`;
}

/** 读在途记录（已过 TTL 视为不存在）。 */
export function readPosterPending(scope: string): PosterPendingEntry | null {
  return read()[scope] ?? null;
}

/** 登记在途（发请求**之前**调用，这样请求在途被杀也留得下幂等键）。 */
export function markPosterPending(scope: string, idempotencyKey: string) {
  if (!scope || !idempotencyKey) return;
  const cur = read();
  write({ ...cur, [scope]: { idempotencyKey, jobId: cur[scope]?.jobId, at: Date.now() } });
}

/** 建单成功后回写 jobId（重进确认页即可直接跳详情）。 */
export function attachPosterJob(scope: string, jobId: string) {
  if (!scope || !jobId) return;
  const cur = read();
  const prev = cur[scope];
  if (!prev) return;
  write({ ...cur, [scope]: { ...prev, jobId, at: Date.now() } });
}

/** 任务已进终态（成功/失败/取消）→ 清标记，别让旧任务把下一次生成劫持到老详情页。 */
export function clearPosterPending(scope: string) {
  if (!scope) return;
  const next = read();
  delete next[scope];
  write(next);
}

/** 按 jobId 清（详情页只知道 jobId，不知道自己属于哪个 scope）。 */
export function clearPosterPendingByJob(jobId: string) {
  if (!jobId) return;
  const cur = read();
  let changed = false;
  for (const [scope, v] of Object.entries(cur)) {
    if (v.jobId === jobId) { delete cur[scope]; changed = true; }
  }
  if (changed) write(cur);
}
