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
import { alertConfigValues } from './alertConfig.js';
import { prisma } from '../db.js';

/* ─────────────── 带标签的计数器 / 直方图（基建） ─────────────── */

// 不引入 prom-client：现有渲染是手写文本格式，引库要把全部既有指标迁一遍口径；
// 这里补一个最小实现（labels → series），保持单文件可审计。
// 防雷点：任何来自业务数据的标签值都必须过 maxSeries 上限，超限折叠进 other——
// 标签基数失控会让 /metrics 输出与 Prometheus 内存一起膨胀。

type LabelValues = Record<string, string>;

function seriesKey(labels: LabelValues): string {
  // 分隔符必须写成转义序列而非字面控制字符——否则本文件会被 grep 判为二进制整体跳过（见 test/sourceHygiene.test.ts）。
  return Object.keys(labels).sort().map((k) => `${k}\u0000${labels[k]}`).join('\u0001');
}

class LabeledCounter {
  private series = new Map<string, { labels: LabelValues; value: number }>();
  constructor(readonly name: string, readonly help: string, private maxSeries = 200) {}
  inc(labels: LabelValues, v = 1): void {
    const key = seriesKey(labels);
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= this.maxSeries) {
        // 折叠：全部标签置 other，保总量不丢
        const folded: LabelValues = Object.fromEntries(Object.keys(labels).map((k) => [k, 'other']));
        const fk = seriesKey(folded);
        s = this.series.get(fk) ?? { labels: folded, value: 0 };
        this.series.set(fk, s);
      } else {
        s = { labels, value: 0 };
        this.series.set(key, s);
      }
    }
    s.value += v;
  }
  renderInto(ms: Metric[]): void {
    const m = metric(this.name, this.help, 'counter');
    for (const s of this.series.values()) m.samples.push(fmt(this.name, s.value, s.labels));
    if (!this.series.size) m.samples.push(fmt(this.name, 0));
    ms.push(m);
  }
  reset(): void { this.series.clear(); }
}

class LabeledHistogram {
  private series = new Map<string, { labels: LabelValues; counts: number[]; sum: number; count: number }>();
  constructor(readonly name: string, readonly help: string, private buckets: number[], private maxSeries = 300) {}
  observe(labels: LabelValues, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = seriesKey(labels);
    let s = this.series.get(key);
    if (!s) {
      if (this.series.size >= this.maxSeries) {
        const folded: LabelValues = Object.fromEntries(Object.keys(labels).map((k) => [k, 'other']));
        const fk = seriesKey(folded);
        s = this.series.get(fk) ?? { labels: folded, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
        this.series.set(fk, s);
      } else {
        s = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
        this.series.set(key, s);
      }
    }
    for (let i = 0; i < this.buckets.length; i++) if (value <= this.buckets[i]) s.counts[i]++;
    s.sum += value;
    s.count++;
  }
  renderInto(ms: Metric[]): void {
    if (!this.series.size) return;
    const m = metric(this.name, this.help, 'histogram');
    for (const s of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        m.samples.push(fmt(`${this.name}_bucket`, s.counts[i], { ...s.labels, le: String(this.buckets[i]) }));
      }
      m.samples.push(fmt(`${this.name}_bucket`, s.count, { ...s.labels, le: '+Inf' }));
      m.samples.push(fmt(`${this.name}_sum`, s.sum, s.labels));
      m.samples.push(fmt(`${this.name}_count`, s.count, s.labels));
    }
    ms.push(m);
  }
  reset(): void { this.series.clear(); }
}

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

/* ──────────────── HTTP 路由级时延 / 状态 ──────────────── */

// 告警线「普通接口 P95 ≥200ms 预警 / ≥500ms 严重」需要**服务端自采**的分位数——压测期靠 k6 采，
// 线上没有 k6，只能靠这里的直方图 + PromQL histogram_quantile。
// route 用 Fastify 路由模板（/api/agents/:key），不是原始 URL——否则每个 id 一条序列，基数爆炸。
const httpDuration = new LabeledHistogram(
  'junshi_http_request_duration_seconds',
  '请求处理时长（按方法/路由模板；含 LLM 长路径，看板侧按 route 过滤）',
  [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
);
const httpRouteResponses = new LabeledCounter(
  'junshi_http_route_responses_total',
  '响应数（按路由模板/方法/状态码大类；定位「哪条路由在冒 5xx」用）',
  400,
);

export function noteHttpTiming(method: string, route: string, status: number, seconds: number): void {
  const cls = `${Math.floor(status / 100)}xx`;
  httpDuration.observe({ method, route }, seconds);
  httpRouteResponses.inc({ method, route, class: cls });
}

/* ──────────────── LLM 调用（与 llm_trace 同源） ──────────────── */

// 挂在 recordTrace 上：每次模型调用（含 mock / 错误）都过那里，是唯一不漏的口子。
const llmCalls = new LabeledCounter('junshi_llm_calls_total', 'LLM 调用数（与 llm_trace 同口径，含 mock 与错误）');
const llmCallDuration = new LabeledHistogram(
  'junshi_llm_call_duration_seconds',
  'LLM 单次调用时长（含工具循环整体耗时）',
  [0.5, 1, 2, 5, 10, 20, 30, 60, 120, 180, 300, 600],
);

export function noteLlmCall(kind: string, provider: string, status: 'ok' | 'error', latencyMs: number): void {
  llmCalls.inc({ kind, provider, status });
  llmCallDuration.observe({ kind, provider }, latencyMs / 1000);
}

/* ──────────────── Token 用量与成本（与 token_usage 同源） ──────────────── */

// 告警线「Token 成本：日预算 70%/90%/100%」的数据源。金额单位元（micros/1e6），
// 用 increase(junshi_llm_cost_cny_total[1d]) 对着日预算画线即可。
const llmTokens = new LabeledCounter('junshi_llm_tokens_total', 'Token 消耗（dir=input|output|cached_input|cache_write）');
const llmCost = new LabeledCounter('junshi_llm_cost_cny_total', 'Token 成本（元；按运营配置单价折算，与 token_usage.costMicros 同口径）');

export function noteTokenUsage(args: {
  kind: string; provider: string; model: string;
  inputTokens: number; outputTokens: number; cachedInput: number; cacheWrite: number; costMicros: number;
}): void {
  const l = { kind: args.kind, provider: args.provider, model: args.model };
  if (args.inputTokens > 0) llmTokens.inc({ ...l, dir: 'input' }, args.inputTokens);
  if (args.outputTokens > 0) llmTokens.inc({ ...l, dir: 'output' }, args.outputTokens);
  if (args.cachedInput > 0) llmTokens.inc({ ...l, dir: 'cached_input' }, args.cachedInput);
  if (args.cacheWrite > 0) llmTokens.inc({ ...l, dir: 'cache_write' }, args.cacheWrite);
  if (args.costMicros > 0) llmCost.inc(l, args.costMicros / 1e6);
}

/* ──────────────── 产出质量（降级 / 截断） ──────────────── */

// 「报告假完成」「降级模板」这类缺陷线上最难被用户报出来——用户只觉得内容差，不会截图报错。
// path 标签指认降级发生在哪条产出路径（gateway 各 fallback 分支）。
const genDegraded = new LabeledCounter('junshi_gen_degraded_total', '产出降级次数（mock 兜底 / 工程语境泄漏替换）');
export function noteGenDegraded(path: string): void { genDegraded.inc({ path }); }

const outputTruncated = new LabeledCounter('junshi_llm_output_truncated_total', '输出达 token 上限被判残缺的次数（AI_OUTPUT_TRUNCATED）');
export function noteOutputTruncated(provider: string): void { outputTruncated.inc({ provider }); }

/* ──────────────── 业务事件 ──────────────── */

const registrations = new LabeledCounter('junshi_user_registrations_total', '新注册用户数（channel=注册入口）');
export function noteRegistration(channel: string): void { registrations.inc({ channel }); }

const moderationChecks = new LabeledCounter('junshi_moderation_checks_total', '内容审核判定数（ref=input|output，verdict=pass|block）');
export function noteModeration(ref: string, pass: boolean): void {
  moderationChecks.inc({ ref, verdict: pass ? 'pass' : 'block' });
}

// reason 取「· 分隔的首段 + 截断」：套餐名/智能体名有限集合，防运营改文案把基数打飞。
// 首段去重集超 100 后新 reason 一律归 other——只折叠 reason 这一个维度，direction 保留（看板要分方向）。
const creditsFlow = new LabeledCounter('junshi_credits_flow_total', '算力流水（direction=spent|granted，单位=点）', 300);
const knownCreditReasons = new Set<string>();
export function noteCreditDelta(delta: number, reason: string): void {
  if (delta === 0) return;
  let r = (reason ?? '').split('·')[0].trim().slice(0, 24) || 'unknown';
  if (!knownCreditReasons.has(r)) {
    if (knownCreditReasons.size >= 100) r = 'other';
    else knownCreditReasons.add(r);
  }
  creditsFlow.inc({ direction: delta < 0 ? 'spent' : 'granted', reason: r }, Math.abs(delta));
}

const planGateBlocked = new LabeledCounter('junshi_plan_gate_blocked_total', '商业化禁写闸拦截数（state=none 未开通 | expired 已过期）——转化/续费信号');
export function notePlanGateBlocked(state: string): void { planGateBlocked.inc({ state }); }

/* ──────────────── 支付 ──────────────── */

const payOrdersCreated = new LabeledCounter('junshi_pay_orders_created_total', '微信支付下单成功数');
const payApplied = new LabeledCounter('junshi_pay_orders_applied_total', '支付入账（权益发放）成功数（type=plan|sku）');
const payAmount = new LabeledCounter('junshi_pay_amount_cny_total', '入账金额（元）');
const payRefunds = new LabeledCounter('junshi_pay_refunds_total', '全额退款成功数');
const payRefundAmount = new LabeledCounter('junshi_pay_refund_amount_cny_total', '退款金额（元）');
export function notePayOrderCreated(): void { payOrdersCreated.inc({}); }
export function notePayApplied(type: 'plan' | 'sku', amountFen: number): void {
  payApplied.inc({ type });
  if (amountFen > 0) payAmount.inc({ type }, amountFen / 100);
}
export function notePayRefund(amountFen: number): void {
  payRefunds.inc({});
  if (amountFen > 0) payRefundAmount.inc({}, amountFen / 100);
}

// 告警转发（Alertmanager → 飞书）自身的成败——通知链路哑了也得有人知道。
const alertForwards = new LabeledCounter('junshi_alerts_forwarded_total', '告警转发次数（outcome=sent|failed|not_configured）');
export function noteAlertForward(outcome: string): void { alertForwards.inc({ outcome }); }

// 对账 sweep 每 5 分钟跑一轮；last_* 是上一轮结果快照（gauge），runs 是累计轮数。
let paySweep = { scanned: 0, applied: 0, failed: 0, closed: 0, runs: 0 };
export function notePaySweep(r: { scanned: number; applied: number; failed: number; closed: number }): void {
  paySweep = { ...r, runs: paySweep.runs + 1 };
}

// 卡单（scrape 时查库，60s 缓存）：paid 未 applied = 用户付了钱没拿到权益，任何 >0 都值得看。
let stuckCache = { at: 0, paidUnapplied: 0, createdStale: 0 };
async function stuckOrders(): Promise<{ paidUnapplied: number; createdStale: number }> {
  const now = Date.now();
  if (now - stuckCache.at < 60_000) return stuckCache;
  const [paidUnapplied, createdStale] = await Promise.all([
    prisma.paymentOrder.count({ where: { status: 'paid', appliedAt: null } }),
    prisma.paymentOrder.count({ where: { status: 'created', createdAt: { lt: new Date(now - 15 * 60_000) } } }),
  ]);
  stuckCache = { at: now, paidUnapplied, createdStale };
  return stuckCache;
}

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

interface Metric { name: string; help: string; type: 'gauge' | 'counter' | 'histogram'; samples: string[] }

function metric(name: string, help: string, type: 'gauge' | 'counter' | 'histogram'): Metric {
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
  const cpu = process.cpuUsage(); // 微秒累计 → rate() 后即该进程的 CPU 核数占用
  push(metric('junshi_process_cpu_seconds_total', '进程累计 CPU 时间（user+system）', 'counter'))
    .samples.push(fmt('junshi_process_cpu_seconds_total', (cpu.user + cpu.system) / 1e6));

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

  /* —— 路由级时延 / 状态 —— */
  httpDuration.renderInto(ms);
  httpRouteResponses.renderInto(ms);

  /* —— LLM 调用 / Token / 成本 / 产出质量 —— */
  llmCalls.renderInto(ms);
  llmCallDuration.renderInto(ms);
  llmTokens.renderInto(ms);
  llmCost.renderInto(ms);
  genDegraded.renderInto(ms);
  outputTruncated.renderInto(ms);

  /* —— 业务事件 —— */
  registrations.renderInto(ms);
  moderationChecks.renderInto(ms);
  creditsFlow.renderInto(ms);
  planGateBlocked.renderInto(ms);

  /* —— 支付 —— */
  payOrdersCreated.renderInto(ms);
  payApplied.renderInto(ms);
  payAmount.renderInto(ms);
  payRefunds.renderInto(ms);
  payRefundAmount.renderInto(ms);
  push(metric('junshi_pay_sweep_runs_total', '支付对账 sweep 累计轮数', 'counter'))
    .samples.push(fmt('junshi_pay_sweep_runs_total', paySweep.runs));
  const sweepLast = push(metric('junshi_pay_sweep_last', '上一轮对账 sweep 结果（result=scanned|applied|failed|closed）', 'gauge'));
  for (const k of ['scanned', 'applied', 'failed', 'closed'] as const) {
    sweepLast.samples.push(fmt('junshi_pay_sweep_last', paySweep[k], { result: k }));
  }
  try {
    const stuck = await stuckOrders();
    push(metric('junshi_pay_stuck_paid_unapplied', '已支付未发放权益的订单数（>0 即该看，sweep 会自愈但要盯）', 'gauge'))
      .samples.push(fmt('junshi_pay_stuck_paid_unapplied', stuck.paidUnapplied));
    push(metric('junshi_pay_stuck_created_stale', '超 15 分钟仍停在 created 的订单数（大多是用户放弃支付，sweep 会关单）', 'gauge'))
      .samples.push(fmt('junshi_pay_stuck_created_stale', stuck.createdStale));
  } catch { /* 未连库时跳过 */ }

  /* —— 告警阈值（后台「功能开关」页可调，规则用 scalar() 取值）——
     注意：本指标缺席（如 API 刚重启还没连上库）时，引用它的告警表达式会静默不评估——
     但那种状态下 up==0/JunshiApiDown 一定已经在响，不会静默漏大事。 */
  try {
    const cfg = push(metric('junshi_alert_config', '告警阈值运行值（后台可调；单位编码在 key 后缀：_ms/_permille/_pct/_cny/_mb/_s）', 'gauge'));
    for (const { key, value } of await alertConfigValues()) {
      cfg.samples.push(fmt('junshi_alert_config', value, { key }));
    }
  } catch { /* 未连库时跳过（告警规则随之不评估，由 JunshiApiDown 兜底） */ }

  /* —— 告警转发自观测 —— */
  alertForwards.renderInto(ms);

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
  httpDuration.reset(); httpRouteResponses.reset();
  llmCalls.reset(); llmCallDuration.reset(); llmTokens.reset(); llmCost.reset();
  genDegraded.reset(); outputTruncated.reset();
  registrations.reset(); moderationChecks.reset(); creditsFlow.reset(); knownCreditReasons.clear(); planGateBlocked.reset();
  payOrdersCreated.reset(); payApplied.reset(); payAmount.reset(); payRefunds.reset(); payRefundAmount.reset();
  alertForwards.reset();
  paySweep = { scanned: 0, applied: 0, failed: 0, closed: 0, runs: 0 };
  stuckCache = { at: 0, paidUnapplied: 0, createdStale: 0 };
}
