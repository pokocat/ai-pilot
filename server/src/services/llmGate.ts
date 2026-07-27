// 上游模型网关的全局并发闸 + 429 自适应退避（压测 P0-2）。
//
// 为什么需要：2026-07 隔离压测直测上游模型网关得到——8 / 12 并发全成功；16 并发最大延迟飙到 18.67s；
// 20 并发出现 42.42% 的 429（全部是 429，0 个 5xx）；32 并发 71.88% 失败。压测前本仓库
// **没有任何并发控制**（全仓 grep semaphore/concurrency/p-limit/queue 零命中），所有调用点直接打上游。
//
// 关键观察（比“并发不超过 8”这个数字更重要）：20 并发触发 429 之后，紧接着的 12 并发复测 48/48 全部 429，
// 等窗口恢复后 8 并发才 80/80 成功。**说明上游是滚动时间窗限额，不只是瞬时并发限额。**
// 因此本模块的设计是「固定并发上限 + 对真实 429 做整窗冷却」，而不是去猜那个窗口配额的具体数值：
//   - 猜错了偏小 → 自己把自己限死；猜错了偏大 → 等于没限。
//   - 而 429 是上游给出的确定信号，按它反应永远不会限错方向。
// 需要显式速率窗口时可设 LLM_RATE_MAX_PER_MIN（默认 0=关闭），留给线上跑出真实 429 率后再校准。
//
// 挂载位置：llm/providers/{claude,openai,dify}.ts 的实际外呼处，不在 gateway.ts 的业务分支上——
// 那里有 17 个动态 import 调用点，逐个包既漏又难维护；挂在 provider 层则新增调用路径自动被覆盖。
// mock provider 不经过这里，所以测试与演示环境完全不受影响。

/**
 * 车道（lane）：主用户可见生成走 'main'，后台辅助抽取走 'aux'，**各有独立的并发预算与冷却状态**。
 *
 * 为什么要分：核对代码发现一条用户消息实际会触发 3–4 次模型调用——主生成 + `extractInsights`
 * （记忆学习）+ `extractProphecies`（预言抽取）+ 首条消息的 `summarizeSessionTitle`。它们原来
 * 全走同一个 `getAiConfig()`，同账号同模型，也就是说**辅助抽取占掉了 8 个槽位里的 2–3 个**，
 * 而它们既不需要主模型的质量，也不面向用户延迟。
 *
 * 分车道只有在 aux 真的配了**独立账号/网关**（`AI_AUX_*`）时才启用；没配时 aux 调用仍走 'main'，
 * 这样共享同一个上游配额的事实不会被两个独立计数器掩盖（否则等于把限额悄悄放大一倍）。
 * 这个判断在 aiConfig.resolveAuxConfig 里做，本模块只认调用方传进来的 lane。
 */
export type LlmLaneClass = 'main' | 'aux';

/**
 * 车道键。基础类是 'main' / 'aux'；接入端点池后每个端点各占一条独立车道
 * （`main#<endpointId>`），这样并发预算和 429 冷却都是**按端点**算的——
 * 一个端点被限流不会连累其它端点。见 services/llmPool.ts。
 */
export type LlmLane = string;

/** 从车道键取基础类（决定读哪一组环境变量）。 */
function laneClassOf(lane: LlmLane): LlmLaneClass {
  return lane.startsWith('aux') ? 'aux' : 'main';
}

/** 组装端点车道键。 */
export function endpointLane(cls: LlmLaneClass, endpointId: string): LlmLane {
  return `${cls}#${endpointId}`;
}

function num(name: string, dflt: number): number {
  // 注意 Number('') === 0（不是 NaN）：未设置 / 空串必须先判掉，否则会被当成「显式配了 0」，
  // 经 Math.max(1, 0) 变成并发上限 1 —— 等于把整个上游吞吐锁死。
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : dflt;
}

/** 按车道取环境变量：aux 优先读 LLM_AUX_*，缺省回落到主车道的同名项。 */
function laneNum(lane: LlmLane, name: string, dflt: number): number {
  if (laneClassOf(lane) === 'aux') {
    const k = name.replace(/^LLM_/, 'LLM_AUX_');
    if (process.env[k] != null) return num(k, dflt);
  }
  return num(name, dflt);
}

/** 每条车道的并发上限覆盖（端点池按端点配 maxConcurrency 时写进来）。 */
const laneMaxOverride = new Map<LlmLane, number>();

/** 设置某条车道的并发上限（0/负数=清除覆盖，回落到环境变量默认）。 */
export function setLaneMaxConcurrency(lane: LlmLane, max: number): void {
  if (max > 0) laneMaxOverride.set(lane, Math.floor(max));
  else laneMaxOverride.delete(lane);
}

function cfg(lane: LlmLane = 'main') {
  const isAux = laneClassOf(lane) === 'aux';
  // aux 默认给 4 并发：它是后台工作，宁可慢也不该和用户可见的生成抢。
  const max = laneMaxOverride.get(lane)
    ?? Math.max(1, laneNum(lane, 'LLM_MAX_CONCURRENCY', isAux ? 4 : 8));
  return {
    enabled: (process.env.LLM_GATE_ENABLED ?? 'true') !== 'false',
    max,
    // 突发上限：报告建议 8 并发常态接入、12 仅作短时突发。第 9–12 个槽位只在“近期无 429”时开放。
    burst: Math.max(max, laneNum(lane, 'LLM_BURST_CONCURRENCY', isAux ? max : 12)),
    burstQuietMs: laneNum(lane, 'LLM_BURST_QUIET_MS', 60_000),
    queueMax: Math.max(1, laneNum(lane, 'LLM_QUEUE_MAX', 200)),
    // 排队超过这个时长主动降级，让上层提示“稍后重试”，而不是把用户挂死在一个永远排不到的队列里。
    // aux 是 fire-and-forget 的后台任务，排不到就该早点放弃，不占内存也不拖长尾。
    queueTimeoutMs: Math.max(1_000, laneNum(lane, 'LLM_QUEUE_TIMEOUT_MS', isAux ? 5_000 : 15_000)),
    cooldownBaseMs: Math.max(1_000, laneNum(lane, 'LLM_COOLDOWN_BASE_MS', 5_000)),
    cooldownMaxMs: Math.max(1_000, laneNum(lane, 'LLM_COOLDOWN_MAX_MS', 60_000)),
    // 冷却结束后不直接回到满并发，先降到这个水位再逐个爬升，避免窗口刚恢复就再次打满。
    rampStart: Math.max(1, laneNum(lane, 'LLM_RAMP_START', 2)),
    ratePerMin: laneNum(lane, 'LLM_RATE_MAX_PER_MIN', 0), // 0 = 不启用显式速率窗口
  };
}

export interface LlmSlot {
  /** 归还槽位。必须在 finally 里调用；重复调用无副作用。 */
  release(): void;
  /** 把本次调用的异常交给闸门判定（识别 429 → 触发整窗冷却）。 */
  noteError(err: unknown): void;
}

type Waiter = { resolve: (s: LlmSlot) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; at: number };

function freshLane() {
  return {
    inFlight: 0,
    queue: [] as Waiter[],
    /** 冷却截止时间戳；> now 时不再发放新槽位。 */
    cooldownUntil: 0,
    /** 连续 429 次数，用于指数退避；出现一次干净的成功即清零。 */
    consecutive429: 0,
    /** 最近一次 429 时间戳，决定 burst 槽位是否开放。 */
    last429At: 0,
    /** 冷却恢复后的爬升水位；0 表示未处于爬升期。 */
    rampCeiling: 0,
    /** 显式速率窗口的请求时间戳环（仅在 ratePerMin > 0 时使用）。 */
    recent: [] as number[],
    wakeTimer: null as NodeJS.Timeout | null,
    stats: { granted: 0, rejected: 0, timedOut: 0, seen429: 0, cooldowns: 0, maxQueueDepth: 0, maxWaitMs: 0 },
  };
}
type LaneState = ReturnType<typeof freshLane>;

const lanes = new Map<LlmLane, LaneState>([['main', freshLane()], ['aux', freshLane()]]);
function laneOf(lane: LlmLane = 'main'): LaneState {
  let s = lanes.get(lane);
  if (!s) { s = freshLane(); lanes.set(lane, s); }
  return s;
}

function busyError(reason: string): Error {
  return Object.assign(new Error('AI 当前排队较多，请稍后重试'), {
    code: 'AI_BUSY',
    statusCode: 503,
    reason,
  });
}

/** 当前允许的并发上限：冷却中为 0；爬升期用爬升水位；近期无 429 才开放 burst 槽位。 */
function ceilingNow(lane: LlmLane, now: number): number {
  const s = laneOf(lane);
  const c = cfg(lane);
  if (now < s.cooldownUntil) return 0;
  if (s.rampCeiling > 0) return Math.min(s.rampCeiling, c.max);
  const quiet = s.last429At === 0 || now - s.last429At >= c.burstQuietMs;
  return quiet ? c.burst : c.max;
}

/** 显式速率窗口检查（ratePerMin=0 时恒为 true）。 */
function rateAllows(lane: LlmLane, now: number): boolean {
  const s = laneOf(lane);
  const c = cfg(lane);
  if (c.ratePerMin <= 0) return true;
  const cutoff = now - 60_000;
  while (s.recent.length && s.recent[0] < cutoff) s.recent.shift();
  return s.recent.length < c.ratePerMin;
}

function scheduleWake(lane: LlmLane, at: number): void {
  const s = laneOf(lane);
  const delay = Math.max(1, at - Date.now());
  if (s.wakeTimer) clearTimeout(s.wakeTimer);
  s.wakeTimer = setTimeout(() => {
    s.wakeTimer = null;
    pump(lane);
  }, delay);
  // 不能让闸门的唤醒定时器把进程钉住（优雅停机时 app.close() 之后应能正常退出）。
  s.wakeTimer.unref?.();
}

function makeSlot(lane: LlmLane): LlmSlot {
  const s = laneOf(lane);
  let released = false;
  let failed = false;
  return {
    release() {
      if (released) return;
      released = true;
      s.inFlight--;
      // 只有干净成功才清连续 429 并推进爬升；失败归还槽位不等于上游已恢复。
      if (!failed) {
        s.consecutive429 = 0;
        if (s.rampCeiling > 0) {
          s.rampCeiling++;
          if (s.rampCeiling >= cfg(lane).max) s.rampCeiling = 0; // 爬满，回到常态
        }
      }
      pump(lane);
    },
    noteError(err: unknown) {
      failed = true;
      if (is429(err)) noteUpstreamRateLimited(retryAfterSecOf(err), lane);
    },
  };
}

function pump(lane: LlmLane): void {
  const s = laneOf(lane);
  const now = Date.now();
  while (s.queue.length) {
    const ceiling = ceilingNow(lane, now);
    if (s.inFlight >= ceiling || !rateAllows(lane, now)) break;
    const w = s.queue.shift()!;
    clearTimeout(w.timer);
    s.inFlight++;
    if (cfg(lane).ratePerMin > 0) s.recent.push(now);
    s.stats.granted++;
    s.stats.maxWaitMs = Math.max(s.stats.maxWaitMs, now - w.at);
    w.resolve(makeSlot(lane));
  }
  // 还有人在排队但当前放不出槽位：如果是冷却导致的，到点后主动再 pump 一次。
  if (s.queue.length && now < s.cooldownUntil) scheduleWake(lane, s.cooldownUntil);
}

/** 申请一个槽位。拿不到会排队；排队超时 / 队列满抛 AI_BUSY(503)。 */
export async function acquireLlmSlot(lane: LlmLane = 'main'): Promise<LlmSlot> {
  const c = cfg(lane);
  if (!c.enabled) return { release() {}, noteError() {} };

  const s = laneOf(lane);
  const now = Date.now();
  if (s.inFlight < ceilingNow(lane, now) && rateAllows(lane, now) && s.queue.length === 0) {
    s.inFlight++;
    if (c.ratePerMin > 0) s.recent.push(now);
    s.stats.granted++;
    return makeSlot(lane);
  }

  if (s.queue.length >= c.queueMax) {
    s.stats.rejected++;
    throw busyError('queue_full');
  }

  return new Promise<LlmSlot>((resolve, reject) => {
    const w: Waiter = {
      resolve,
      reject,
      at: now,
      timer: setTimeout(() => {
        const i = s.queue.indexOf(w);
        if (i >= 0) s.queue.splice(i, 1);
        s.stats.timedOut++;
        reject(busyError('queue_timeout'));
      }, c.queueTimeoutMs),
    };
    w.timer.unref?.();
    s.queue.push(w);
    s.stats.maxQueueDepth = Math.max(s.stats.maxQueueDepth, s.queue.length);
    if (now < s.cooldownUntil) scheduleWake(lane, s.cooldownUntil);
  });
}

/** 包住一次非流式外呼：自动申请槽位、识别 429、无论成败都归还。 */
export async function withLlmSlot<T>(fn: () => Promise<T>, lane: LlmLane = 'main'): Promise<T> {
  const slot = await acquireLlmSlot(lane);
  try {
    return await fn();
  } catch (err) {
    slot.noteError(err);
    throw err;
  } finally {
    slot.release();
  }
}

/**
 * 记录一次上游 429，进入整窗冷却。
 * 冷却期内**不发放任何新槽位**（在途的自然跑完），到点后从 rampStart 水位逐步爬回常态。
 * 优先采信上游给的 Retry-After；没有则按 base × 2^(连续次数-1) 指数退避，封顶 cooldownMaxMs。
 */
export function noteUpstreamRateLimited(retryAfterSec?: number, lane: LlmLane = 'main'): void {
  const c = cfg(lane);
  if (!c.enabled) return;
  const s = laneOf(lane);
  const now = Date.now();
  s.consecutive429++;
  s.stats.seen429++;
  const backoff = retryAfterSec && retryAfterSec > 0
    ? retryAfterSec * 1000
    : Math.min(c.cooldownMaxMs, c.cooldownBaseMs * 2 ** (s.consecutive429 - 1));
  const until = now + backoff;
  if (until > s.cooldownUntil) {
    s.cooldownUntil = until;
    s.stats.cooldowns++;
    scheduleWake(lane, until);
  }
  s.last429At = now;
  s.rampCeiling = c.rampStart;
}

/** 是否是上游限流错误。覆盖 Anthropic SDK 的 err.status、fetch 分支塞的 statusCode，以及兜底的文案匹配。 */
export function is429(err: unknown): boolean {
  const e = err as { status?: number; statusCode?: number; message?: string } | null;
  if (!e) return false;
  if (e.status === 429 || e.statusCode === 429) return true;
  return typeof e.message === 'string' && /\b429\b|rate.?limit|too many requests/i.test(e.message);
}

/** 从错误对象里尽力取 Retry-After（秒）。 */
export function retryAfterSecOf(err: unknown): number | undefined {
  const e = err as { headers?: Record<string, unknown>; retryAfter?: unknown } | null;
  const raw = e?.retryAfter ?? (e?.headers ? (e.headers['retry-after'] ?? e.headers['Retry-After']) : undefined);
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 单条车道的实时状态（供 /metrics 与运维诊断；口径与压测报告 §8 的告警项一致）。 */
export function llmGateStats(lane: LlmLane = 'main') {
  const now = Date.now();
  const c = cfg(lane);
  const s = laneOf(lane);
  return {
    lane,
    enabled: c.enabled,
    maxConcurrency: c.max,
    burstConcurrency: c.burst,
    ceiling: ceilingNow(lane, now),
    inFlight: s.inFlight,
    queued: s.queue.length,
    coolingDown: now < s.cooldownUntil,
    cooldownRemainingMs: Math.max(0, s.cooldownUntil - now),
    consecutive429: s.consecutive429,
    ...s.stats,
  };
}

/** 全部车道状态（含每个端点自己的车道）。 */
export function llmGateStatsAll() {
  return [...lanes.keys()].sort().map((lane) => llmGateStats(lane));
}

/** 仅供测试：复位全部车道。 */
export function __resetLlmGate(): void {
  for (const s of lanes.values()) {
    for (const w of s.queue) clearTimeout(w.timer);
    if (s.wakeTimer) clearTimeout(s.wakeTimer);
  }
  lanes.clear();
  lanes.set('main', freshLane());
  lanes.set('aux', freshLane());
  laneMaxOverride.clear();
}
