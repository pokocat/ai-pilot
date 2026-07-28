// 可观测性：Prometheus 文本格式指标（路由见 routes/metrics.ts）。
//
// 口径原则（压测方案 V2 §6）：**压测采集什么，线上就告警什么，指标名一致**。
// 否则压测跑出来的阈值没法直接变成告警规则，等于要长期维护两套口径。
// 对应的告警线见 docs/[OPUS5]LOADTEST_OPT_PLAN_2026-07-26.md §7：
//   API CPU、普通接口 P95、RDS 连接使用率、LLM 429 率、LLM 队列等待、Token 成本。
// 其中 CPU / P95 由 k6 与主机侧采集，本模块负责**进程内那部分**：在途请求、事件循环延迟、
// LLM 闸门与端点池、Prisma 连接池。
//
// 安全：本模块只暴露计数与状态，绝不包含 apiKey / baseUrl / 用户数据。
// 端点只报 id / label / model / tier（都是运营自己填的展示信息）。

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { llmGateStatsAll } from './llmGate.js';
import { poolStatus } from './llmPool.js';
import { prisma } from '../db.js';

/* ─────────────────────── HTTP 层 ─────────────────────── */

// 全量在途（含长耗时 LLM 路径与探活）：回答「这个进程此刻同时扛着多少请求」。
let inFlight = 0;
let inFlightPeak = 0;
// 过载闸自己的在途数（**不含**长耗时与探活，口径见 app.ts）：这才是和 MAX_IN_FLIGHT 比的那个数。
let gateInFlight = 0;
let gateInFlightPeak = 0;
const responsesByClass = new Map<string, number>();
let overloadRejected = 0; // 过载闸主动 503
let rateLimited = 0;      // 限流 429

export function noteRequestStart(): void {
  inFlight++;
  if (inFlight > inFlightPeak) inFlightPeak = inFlight;
}

export function noteRequestEnd(status: number): void {
  if (inFlight > 0) inFlight--;
  const k = `${Math.floor(status / 100)}xx`;
  responsesByClass.set(k, (responsesByClass.get(k) ?? 0) + 1);
  if (status === 429) rateLimited++;
}

/** 客户端中途断开：也要归还在途计数，否则长连接被掐断后 in_flight 只增不减。 */
export function noteRequestAborted(): void {
  if (inFlight > 0) inFlight--;
}

export function gateEnter(): void {
  gateInFlight++;
  if (gateInFlight > gateInFlightPeak) gateInFlightPeak = gateInFlight;
}
export function gateLeave(): void { if (gateInFlight > 0) gateInFlight--; }
export function gateInFlightNow(): number { return gateInFlight; }
export function noteOverloadRejected(): void { overloadRejected++; }

/* ──────────────── 用量漏账（provider 未回传 usage）──────────────── */

// 真实 provider 调用完成却报不出 token 用量 → 该次消耗在 token_usage 里查不到任何行。
// `usageOf` 里的 `?? 0` 把「字段缺失」和「真的是 0」抹平了，所以只能靠这个计数器暴露。
// 按 provider+model 分标签：切换接入点后若这个数开始涨，说明新网关不回传 usage，成本口径有缺口。
const usageUnreported = new Map<string, number>();
export function noteUsageUnreported(provider: string, model: string): void {
  const k = `${provider}|${model}`;
  usageUnreported.set(k, (usageUnreported.get(k) ?? 0) + 1);
}
export function usageUnreportedNow(): Map<string, number> { return usageUnreported; }

/* ──────────────── 事件循环延迟 ──────────────── */

// 进程启动即开始采样（libuv 层的 unref 定时器，开销可忽略，且不会把进程挂住）。
// 注意：分位数是**自进程启动累计**的，不随 scrape 重置——多个采集端同时拉取才不会互相清数据。
// 压测按拓扑重建容器，因此每轮的数字天然是干净的。
let loopDelay: IntervalHistogram | null = null;
function loopHist(): IntervalHistogram {
  if (!loopDelay) {
    loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
  }
  return loopDelay;
}
export function startEventLoopMonitor(): void { loopHist(); }
/** 仅供测试：停止采样，避免用例之间互相污染。 */
export function __stopEventLoopMonitor(): void {
  loopDelay?.disable();
  loopDelay = null;
}

/* ──────────────── Prometheus 渲染 ──────────────── */

type Labels = Record<string, string | number>;

function escapeLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

function fmt(name: string, value: number, labels?: Labels): string {
  const v = Number.isFinite(value) ? value : 0;
  if (!labels || Object.keys(labels).length === 0) return `${name} ${v}`;
  const inner = Object.entries(labels)
    .map(([k, lv]) => `${k}="${escapeLabel(String(lv))}"`)
    .join(',');
  return `${name}{${inner}} ${v}`;
}

interface Metric { name: string; help: string; type: 'gauge' | 'counter'; samples: string[] }

function metric(name: string, help: string, type: 'gauge' | 'counter'): Metric {
  return { name, help, type, samples: [] };
}

function render(metrics: Metric[]): string {
  const out: string[] = [];
  for (const m of metrics) {
    if (!m.samples.length) continue;
    out.push(`# HELP ${m.name} ${m.help}`);
    out.push(`# TYPE ${m.name} ${m.type}`);
    out.push(...m.samples);
  }
  return `${out.join('\n')}\n`;
}

/** 组装全部指标。任一子系统取数失败都不能让整个端点挂掉——观测在出事时最有用。 */
export async function renderMetrics(): Promise<string> {
  const ms: Metric[] = [];
  const push = (m: Metric) => { ms.push(m); return m; };

  push(metric('junshi_up', '进程存活（恒为 1，用于确认抓取通路本身正常）', 'gauge'))
    .samples.push(fmt('junshi_up', 1));

  /* —— 进程 —— */
  const mem = process.memoryUsage();
  push(metric('junshi_process_resident_memory_bytes', '进程 RSS（耐久场景看它是否随时间单调上升）', 'gauge'))
    .samples.push(fmt('junshi_process_resident_memory_bytes', mem.rss));
  push(metric('junshi_process_heap_used_bytes', 'V8 已用堆', 'gauge'))
    .samples.push(fmt('junshi_process_heap_used_bytes', mem.heapUsed));
  push(metric('junshi_process_uptime_seconds', '进程运行时长', 'gauge'))
    .samples.push(fmt('junshi_process_uptime_seconds', Math.round(process.uptime())));

  /* —— 事件循环 —— */
  try {
    const h = loopHist();
    const eld = push(metric(
      'junshi_nodejs_event_loop_delay_seconds',
      '事件循环延迟分位数（自进程启动累计）。持续上升说明单进程已被 CPU 绑住——这正是「加进程还是加机器」的判据之一',
      'gauge',
    ));
    for (const q of [0.5, 0.95, 0.99]) {
      eld.samples.push(fmt('junshi_nodejs_event_loop_delay_seconds', h.percentile(q * 100) / 1e9, { quantile: q }));
    }
    push(metric('junshi_nodejs_event_loop_delay_max_seconds', '事件循环延迟峰值', 'gauge'))
      .samples.push(fmt('junshi_nodejs_event_loop_delay_max_seconds', h.max / 1e9));
  } catch { /* 拿不到就不报这几条，不影响其余指标 */ }

  /* —— HTTP —— */
  push(metric('junshi_http_in_flight', '当前在途请求数（含长耗时 LLM 路径与探活）', 'gauge'))
    .samples.push(fmt('junshi_http_in_flight', inFlight));
  push(metric('junshi_http_in_flight_peak', '在途请求峰值（自进程启动）', 'gauge'))
    .samples.push(fmt('junshi_http_in_flight_peak', inFlightPeak));
  push(metric('junshi_http_overload_in_flight', '过载闸计的在途数（不含长耗时与探活），与 junshi_http_overload_limit 比较', 'gauge'))
    .samples.push(fmt('junshi_http_overload_in_flight', gateInFlight));
  push(metric('junshi_http_overload_in_flight_peak', '过载闸在途峰值', 'gauge'))
    .samples.push(fmt('junshi_http_overload_in_flight_peak', gateInFlightPeak));
  push(metric('junshi_http_overload_limit', 'MAX_IN_FLIGHT 配置值（0=闸关闭）', 'gauge'))
    .samples.push(fmt('junshi_http_overload_limit', Number(process.env.MAX_IN_FLIGHT ?? 200)));
  push(metric('junshi_http_overload_rejected_total', '被过载闸主动 503 的请求数', 'counter'))
    .samples.push(fmt('junshi_http_overload_rejected_total', overloadRejected));

  // 漏账计数：真实 provider 未回传 usage 的调用次数。>0 即表示成本统计有缺口。
  const unreported = push(metric('junshi_usage_unreported_total', '真实 provider 未回传 token usage 的调用次数（成本漏账）', 'counter'));
  if (usageUnreported.size === 0) {
    unreported.samples.push(fmt('junshi_usage_unreported_total', 0));
  } else {
    for (const [k, v] of usageUnreported) {
      const [provider, model] = k.split('|');
      unreported.samples.push(fmt('junshi_usage_unreported_total', v, { provider, model }));
    }
  }
  push(metric('junshi_http_rate_limited_total', '被限流 429 的响应数', 'counter'))
    .samples.push(fmt('junshi_http_rate_limited_total', rateLimited));

  const cls = push(metric('junshi_http_responses_total', '响应数（按状态码大类）', 'counter'));
  for (const k of ['2xx', '3xx', '4xx', '5xx']) {
    cls.samples.push(fmt('junshi_http_responses_total', responsesByClass.get(k) ?? 0, { class: k }));
  }

  /* —— LLM 并发闸（按车道，含每端点车道）—— */
  try {
    const lanes = llmGateStatsAll();
    const g = {
      inFlight: push(metric('junshi_llm_in_flight', '该车道正在打上游的请求数', 'gauge')),
      queued: push(metric('junshi_llm_queued', '该车道排队等槽位的请求数（告警线：等待 P95 ≥5s 预警 / ≥15s 降级）', 'gauge')),
      ceiling: push(metric('junshi_llm_ceiling', '当前允许的并发上限（冷却中为 0，爬坡期为中间值）', 'gauge')),
      max: push(metric('junshi_llm_max_concurrency', '配置的稳态并发上限', 'gauge')),
      burst: push(metric('junshi_llm_burst_concurrency', '配置的突发并发上限', 'gauge')),
      cooling: push(metric('junshi_llm_cooling', '是否处于 429 整窗冷却（1=是）', 'gauge')),
      cooldown: push(metric('junshi_llm_cooldown_remaining_seconds', '冷却剩余时间', 'gauge')),
      consec: push(metric('junshi_llm_consecutive_429', '连续 429 次数（驱动指数退避）', 'gauge')),
      granted: push(metric('junshi_llm_granted_total', '成功获得槽位的次数', 'counter')),
      rejected: push(metric('junshi_llm_rejected_total', '队列满被直接拒的次数', 'counter')),
      timedOut: push(metric('junshi_llm_timed_out_total', '排队超时降级 AI_BUSY 的次数', 'counter')),
      seen429: push(metric('junshi_llm_upstream_429_total', '上游 429 次数（告警线：≥0.5% 预警 / ≥2% 收紧并发）', 'counter')),
      cooldowns: push(metric('junshi_llm_cooldowns_total', '进入冷却的次数', 'counter')),
      qmax: push(metric('junshi_llm_queue_depth_max', '队列深度峰值', 'gauge')),
      wmax: push(metric('junshi_llm_wait_max_seconds', '排队等待峰值', 'gauge')),
    };
    for (const s of lanes) {
      const l = { lane: s.lane };
      g.inFlight.samples.push(fmt('junshi_llm_in_flight', s.inFlight, l));
      g.queued.samples.push(fmt('junshi_llm_queued', s.queued, l));
      g.ceiling.samples.push(fmt('junshi_llm_ceiling', s.ceiling, l));
      g.max.samples.push(fmt('junshi_llm_max_concurrency', s.maxConcurrency, l));
      g.burst.samples.push(fmt('junshi_llm_burst_concurrency', s.burstConcurrency, l));
      g.cooling.samples.push(fmt('junshi_llm_cooling', s.coolingDown ? 1 : 0, l));
      g.cooldown.samples.push(fmt('junshi_llm_cooldown_remaining_seconds', s.cooldownRemainingMs / 1000, l));
      g.consec.samples.push(fmt('junshi_llm_consecutive_429', s.consecutive429, l));
      g.granted.samples.push(fmt('junshi_llm_granted_total', s.granted, l));
      g.rejected.samples.push(fmt('junshi_llm_rejected_total', s.rejected, l));
      g.timedOut.samples.push(fmt('junshi_llm_timed_out_total', s.timedOut, l));
      g.seen429.samples.push(fmt('junshi_llm_upstream_429_total', s.seen429, l));
      g.cooldowns.samples.push(fmt('junshi_llm_cooldowns_total', s.cooldowns, l));
      g.qmax.samples.push(fmt('junshi_llm_queue_depth_max', s.maxQueueDepth, l));
      g.wmax.samples.push(fmt('junshi_llm_wait_max_seconds', s.maxWaitMs / 1000, l));
    }
  } catch { /* 闸门未初始化时跳过 */ }

  /* —— 端点池 —— */
  try {
    const p = await poolStatus();
    push(metric('junshi_llm_pool_enabled', '端点池是否启用（1=pool 分流，0=single 单端点）', 'gauge'))
      .samples.push(fmt('junshi_llm_pool_enabled', p.mode === 'pool' ? 1 : 0));
    push(metric('junshi_llm_pool_sticky', '会话粘性是否开启（关掉会显著拉低上游提示词缓存命中）', 'gauge'))
      .samples.push(fmt('junshi_llm_pool_sticky', p.sticky ? 1 : 0));
    push(metric('junshi_llm_pool_endpoints', '池内端点数', 'gauge'))
      .samples.push(fmt('junshi_llm_pool_endpoints', p.endpoints.length));
    const cool = push(metric('junshi_llm_pool_endpoint_cooling', '端点是否在冷却（1=是，被跳过不参与分流）', 'gauge'));
    const w = push(metric('junshi_llm_pool_endpoint_weight', '端点分流权重', 'gauge'));
    for (const e of p.endpoints) {
      const l = { endpoint: e.id, label: e.label, model: e.model, tier: e.tier };
      cool.samples.push(fmt('junshi_llm_pool_endpoint_cooling', e.cooling ? 1 : 0, l));
      w.samples.push(fmt('junshi_llm_pool_endpoint_weight', e.weight, l));
    }
  } catch { /* 未连库 / 未配池时跳过 */ }

  const base = render(ms);

  /* —— Prisma 连接池（依赖 schema.prisma 的 metrics 预览特性）——
     池 in-use/idle 是 P0-3「连接池到底该配多少」的直接依据，压测方案 §6 也把它列为必采项。
     指标自带 prisma_ 前缀，不与本文件的命名冲突。 */
  let prismaText = '';
  try {
    const m = (prisma as unknown as { $metrics?: { prometheus(): Promise<string> } }).$metrics;
    if (m) prismaText = await m.prometheus();
  } catch { /* 客户端未带 metrics 特性时静默跳过 */ }

  return prismaText ? `${base}${prismaText.endsWith('\n') ? prismaText : `${prismaText}\n`}` : base;
}

/** 仅供测试：复位全部计数。 */
export function __resetMetrics(): void {
  usageUnreported.clear();
  inFlight = 0; inFlightPeak = 0;
  gateInFlight = 0; gateInFlightPeak = 0;
  responsesByClass.clear();
  overloadRejected = 0; rateLimited = 0;
}
