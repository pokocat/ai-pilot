// LLM 健康兜底扫描（2026-08-20）。
//
// ── 为什么要有它 ──────────────────────────────────────────────────────────────
// 2026-08-19 那天 llm_trace 里躺着 **23,303 条 status='error'**，16 小时没有任何人知道。
// 事后补的两条告警都是**定向**的：generationJobs 的接管熔断只在「同一个 job 被反复接管」时响，
// gateway 的洪水闸只在「单位时间调用次数超限」时响。它们各自堵住了自己那个已知故障形态，
// 但只要下一次的形态不同（上游 5xx、key 过期、模型下线、审核全量拦截……），就又是 16 小时无声。
//
// 这个 sweep 是**兜底**：不关心错因，只看「错得多不多」。定向告警治具体病，它治「没人看」。
//
// ── 两条规则 ──────────────────────────────────────────────────────────────────
//  ① 面：近 5 分钟 llm_trace 的 error 条数超阈值 → 说明整条链路在冒烟。
//  ② 点：近 1 小时某个用户 chat **错 ≥N 次且一次都没成功** → 单用户被卡死。
//     这一条专治「总量不高所以规则①不响，但对当事人是 100% 不可用」——按用户聚合才看得见。
//
// ── 三条纪律 ──────────────────────────────────────────────────────────────────
//  · 只读、不改任何业务数据；整个 sweep 包 try/catch，炸了只打日志，绝不影响其它 job。
//  · 告警节流按「同类 10 分钟最多一条」（模块级时间戳），抄 generationJobs.fireThrashingAlert。
//    冒烟期间每 5 分钟都会命中，不节流就会把群刷爆——刷爆等于没有告警。
//  · 留 LLM_HEALTH_SWEEP=false 一键关停：告警本身不该成为下一个没法当场停掉的东西。

import { prisma } from '../db.js';
import { now } from './clock.js';

/** 一键关停。默认开。 */
export function llmHealthSweepEnabled(): boolean {
  return (process.env.LLM_HEALTH_SWEEP ?? 'true').trim() !== 'false';
}

/**
 * 读一个「空串/非法值回默认、显式 0 表示关掉」的整数 env。
 *
 * 必须先判空串：`Number('')` 是 0 而不是 NaN，不判就会把「没配」误读成「显式配了 0 = 关掉告警」——
 * 语义正好相反，而且是静默的（同 generationJobs.priorityAgingSeconds 的坑）。
 */
function envThreshold(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}

/** 规则①阈值：近 5 分钟 error 条数超过它就告警。0 = 关掉这条规则。 */
function errorBurstThreshold(): number {
  return envThreshold('LLM_ERROR_ALERT_PER_5MIN', 30);
}

/** 规则②阈值：近 1 小时单用户 chat 错误数达到它、且成功数为 0 才告警。0 = 关掉这条规则。 */
function userStuckThreshold(): number {
  return envThreshold('LLM_USER_ERROR_ALERT_PER_HOUR', 10);
}

// ── 告警节流 ──────────────────────────────────────────────────────────────────

const ALERT_THROTTLE_MS = 10 * 60_000;
const lastAlertAt: Record<string, number> = {};

/**
 * 同类告警 10 分钟最多一条。发送失败只打日志——**告警链路自己绝不能把调用方拖下水**，
 * 这正是 fireThrashingAlert 立的规矩。
 */
function fireAlert(key: string, text: string): void {
  const nowMs = Date.now();
  if (nowMs - (lastAlertAt[key] ?? 0) < ALERT_THROTTLE_MS) return;
  lastAlertAt[key] = nowMs;
  void import('./alertConfig.js')
    .then(({ sendFeishuText }) => sendFeishuText(text))
    .then((r) => { if (!r.sent) console.error('[llm-health] 告警未送达:', r.reason); })
    .catch((err) => console.error('[llm-health] 告警失败:', (err as Error).message));
}

/** 仅供测试：清掉节流窗口，避免用例之间互相吞告警。 */
export function __resetLlmHealthThrottle(): void {
  for (const k of Object.keys(lastAlertAt)) delete lastAlertAt[k];
}

// ── 扫描 ──────────────────────────────────────────────────────────────────────

export interface LlmHealthSweepResult {
  skipped?: 'disabled';
  errorCount5m: number;
  stuckUsers: { userId: string; errors: number; sessionId: string | null }[];
  alerts: number;
}

/**
 * 跑一轮扫描。**不抛**：任何异常都吞在内部，只体现为日志。
 *
 * 时间窗一律用 JS Date 走 Prisma 查询构造器，**不写裸 SQL**：raw SQL 的 Date 参数在生产会被
 * 整体偏移 8 小时（本地 -7），窗口一歪，扫的就不是最近 5 分钟（见 26 个文件那轮排查）。
 */
export async function runLlmHealthSweep(): Promise<LlmHealthSweepResult> {
  const empty: LlmHealthSweepResult = { errorCount5m: 0, stuckUsers: [], alerts: 0 };
  if (!llmHealthSweepEnabled()) return { ...empty, skipped: 'disabled' };
  try {
    const at = now();
    let alerts = 0;
    const errorCount5m = await sweepErrorBurst(at, () => { alerts++; });
    const stuckUsers = await sweepStuckUsers(at, () => { alerts++; });
    return { errorCount5m, stuckUsers, alerts };
  } catch (err) {
    // 扫描失败不该影响别的 job，也不该让调度器把这一轮标记成崩溃。
    console.error('[llm-health] sweep failed:', (err as Error).message);
    return empty;
  }
}

/** 规则①：近 5 分钟整体 error 量。 */
async function sweepErrorBurst(at: Date, onAlert: () => void): Promise<number> {
  const threshold = errorBurstThreshold();
  if (threshold <= 0) return 0;
  const since = new Date(at.getTime() - 5 * 60_000);
  const errorCount = await prisma.llmTrace.count({ where: { status: 'error', createdAt: { gte: since } } });
  if (errorCount <= threshold) return errorCount;
  fireAlert(
    'error-burst',
    `⚠️ 模型调用错误激增\n近 5 分钟 llm_trace 报错 ${errorCount} 条（阈值 ${threshold}）。\n`
    + `参照 2026-08-19：当天累计 23,303 条报错、16 小时无人知晓。\n`
    + `排查：llm_trace 按 createdAt 近 1 小时筛 status='error'，先按 errorMessage/provider/model 聚合看是不是单一上游；`
    + `再按 agentKey 聚合看是不是单一智能体。\n`
    + `调参：LLM_ERROR_ALERT_PER_5MIN（当前 ${threshold}，设 0 关掉这条规则）；LLM_HEALTH_SWEEP=false 全关。`,
  );
  onAlert();
  return errorCount;
}

/** 规则②：近 1 小时「错 ≥N 次且零成功」的用户。 */
async function sweepStuckUsers(at: Date, onAlert: () => void): Promise<{ userId: string; errors: number; sessionId: string | null }[]> {
  const threshold = userStuckThreshold();
  if (threshold <= 0) return [];
  const since = new Date(at.getTime() - 60 * 60_000);
  // 一次 groupBy 同时取回错误数与成功数：分两次查会在两次之间漏进新流水，把「零成功」判错。
  const rows = await prisma.llmTrace.groupBy({
    by: ['userId', 'status'],
    where: { kind: 'chat', createdAt: { gte: since }, userId: { not: null } },
    _count: { _all: true },
  });

  const tally = new Map<string, { errors: number; oks: number }>();
  for (const r of rows) {
    if (!r.userId) continue;
    const cur = tally.get(r.userId) ?? { errors: 0, oks: 0 };
    if (r.status === 'error') cur.errors += r._count._all;
    else cur.oks += r._count._all;
    tally.set(r.userId, cur);
  }

  const stuck = [...tally.entries()]
    .filter(([, v]) => v.errors >= threshold && v.oks === 0)
    .sort((a, b) => b[1].errors - a[1].errors)
    .slice(0, 5); // 告警是给人看的，列头部几个就够定位；全量在表里
  if (!stuck.length) return [];

  // 带上最近一条报错的 sessionId，让排查能直接落到具体会话。
  const withSession = await Promise.all(stuck.map(async ([userId, v]) => {
    const last = await prisma.llmTrace.findFirst({
      where: { userId, kind: 'chat', status: 'error', createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      select: { sessionId: true },
    });
    return { userId, errors: v.errors, sessionId: last?.sessionId ?? null };
  }));

  // 只带 userId / sessionId，**不带手机号**：告警群的可见范围比后台宽，个人信息不进群。
  const lines = withSession.map((u) => `· user=${u.userId} session=${u.sessionId ?? '（无）'} 错 ${u.errors} 次`).join('\n');
  fireAlert(
    'user-stuck',
    `⚠️ 有用户被模型错误卡死\n近 1 小时以下用户 chat 报错 ≥${threshold} 次且**一次都没成功**：\n${lines}\n`
    + `对当事人是 100% 不可用，总量未必触发激增告警，所以单列一条。\n`
    + `排查：llm_trace 按 userId + kind='chat' 筛近 1 小时，对比 status 的 ok/error 分布，看 errorMessage 是否同一类；`
    + `再查该用户额度与所在智能体的端点路由。\n`
    + `调参：LLM_USER_ERROR_ALERT_PER_HOUR（当前 ${threshold}，设 0 关掉这条规则）；LLM_HEALTH_SWEEP=false 全关。`,
  );
  onAlert();
  return withSession;
}
