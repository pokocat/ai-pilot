#!/usr/bin/env node
// 军师 · Grafana 看板生成器。
// 四块盘（主机与数据库 / API 服务 / LLM 网关 / 业务大盘）的 JSON 全部由本脚本生成：
//   node build.mjs        → 在当前目录写出 junshi-*.json
// 要改看板：改这里再重新生成（Grafana UI 里的临时改动不会回写文件）。
// 数据源 uid 与 provisioning/datasources/datasources.yml 锚定：prometheus / junshi-pg / loki。

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = dirname(fileURLToPath(import.meta.url));

const PROM = { type: 'prometheus', uid: 'prometheus' };
const PG = { type: 'postgres', uid: 'junshi-pg' };

let idSeq = 1;

/* ── 面板工厂 ── */

function promTarget(expr, legend, refId) {
  return { refId, expr, legendFormat: legend ?? '__auto', range: true, datasource: PROM };
}
function pgTarget(rawSql, refId, format = 'time_series') {
  return { refId, rawSql, rawQuery: true, format, datasource: PG };
}
const refIds = 'ABCDEFGH';
const withRefs = (targets) => targets.map((t, i) => ({ ...t, refId: refIds[i] }));

function thresholds(steps) {
  // steps: [[null,'green'],[65,'yellow'],[80,'red']]
  return { mode: 'absolute', steps: steps.map(([value, color]) => ({ value, color })) };
}

function timeseries({ title, targets, w = 12, h = 8, unit = 'short', min, max, desc, stack = false }) {
  return {
    id: idSeq++, type: 'timeseries', title, description: desc,
    datasource: targets[0].datasource, targets: withRefs(targets),
    gridPos: { w, h },
    fieldConfig: {
      defaults: {
        unit, min, max,
        custom: {
          fillOpacity: 12, showPoints: 'never', lineWidth: 1, spanNulls: true,
          ...(stack ? { stacking: { mode: 'normal' } } : {}),
        },
      },
      overrides: [],
    },
    options: { legend: { displayMode: 'list', placement: 'bottom' }, tooltip: { mode: 'multi', sort: 'desc' } },
  };
}

function stat({ title, targets, w = 4, h = 5, unit = 'short', steps, decimals, desc, mappings }) {
  return {
    id: idSeq++, type: 'stat', title, description: desc,
    datasource: targets[0].datasource, targets: withRefs(targets),
    gridPos: { w, h },
    fieldConfig: {
      defaults: {
        unit, decimals,
        thresholds: thresholds(steps ?? [[null, 'green']]),
        ...(mappings ? { mappings } : {}),
      },
      overrides: [],
    },
    options: {
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      graphMode: 'area', colorMode: 'value', textMode: 'auto',
    },
  };
}

function table({ title, targets, w = 12, h = 8, desc }) {
  return {
    id: idSeq++, type: 'table', title, description: desc,
    datasource: targets[0].datasource, targets: withRefs(targets),
    gridPos: { w, h },
    fieldConfig: { defaults: {}, overrides: [] },
    options: { showHeader: true, footer: { show: false } },
  };
}

function row(title) {
  return { id: idSeq++, type: 'row', title, collapsed: false, gridPos: { w: 24, h: 1 }, panels: [] };
}

/* ── 布局：从左到右塞,塞不下换行;row 面板强制换行 ── */
function layout(panels) {
  let x = 0, y = 0, rowH = 0;
  for (const p of panels) {
    const { w, h } = p.gridPos;
    if (p.type === 'row' || x + w > 24) { x = 0; y += rowH; rowH = 0; }
    p.gridPos = { x, y, w, h };
    x += w;
    rowH = Math.max(rowH, h);
    if (p.type === 'row') { x = 0; y += 1; rowH = 0; }
  }
  return panels;
}

function dashboard({ uid, title, panels, refresh = '30s', from = 'now-6h' }) {
  return {
    uid, title, tags: ['junshi'], timezone: 'browser', editable: true,
    schemaVersion: 39, version: 1, refresh,
    time: { from, to: 'now' },
    panels: layout(panels),
  };
}

/* ════════ 1. 主机与数据库 ════════ */

const CPU_PCT = '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])))';
const sysDash = dashboard({
  uid: 'junshi-system', title: '军师 · 主机与数据库',
  panels: [
    row('主机（node_exporter）'),
    stat({ title: 'CPU 使用率', unit: 'percent', decimals: 0, targets: [promTarget(CPU_PCT)], steps: [[null, 'green'], [65, 'yellow'], [80, 'red']], desc: '告警线：≥65% 预警 / ≥80% 扩容（压测方案 §7）' }),
    stat({ title: '内存使用率', unit: 'percent', decimals: 0, targets: [promTarget('100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)')], steps: [[null, 'green'], [80, 'yellow'], [90, 'red']] }),
    stat({ title: '根分区使用率', unit: 'percent', decimals: 0, targets: [promTarget('100 * (1 - node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"})')], steps: [[null, 'green'], [80, 'yellow'], [90, 'red']] }),
    stat({ title: '负载(1m)/核数', decimals: 2, targets: [promTarget('node_load1 / count(count by (cpu) (node_cpu_seconds_total{mode="idle"}))')], steps: [[null, 'green'], [0.8, 'yellow'], [1.5, 'red']] }),
    stat({ title: '文件句柄占用', unit: 'percent', decimals: 1, targets: [promTarget('100 * node_filefd_allocated / node_filefd_maximum')], steps: [[null, 'green'], [60, 'yellow'], [85, 'red']] }),
    stat({ title: 'TCP 连接(established)', targets: [promTarget('node_netstat_Tcp_CurrEstab')], steps: [[null, 'green']] }),
    timeseries({ title: 'CPU 按模式', unit: 'percent', max: 100, stack: true, targets: [promTarget('avg by (mode) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) * 100', '{{mode}}')] }),
    timeseries({ title: '内存', unit: 'bytes', targets: [
      promTarget('node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes', '已用'),
      promTarget('node_memory_MemAvailable_bytes', '可用'),
    ] }),
    timeseries({ title: '磁盘吞吐', unit: 'Bps', targets: [
      promTarget('sum(rate(node_disk_read_bytes_total[5m]))', '读'),
      promTarget('sum(rate(node_disk_written_bytes_total[5m]))', '写'),
    ] }),
    timeseries({ title: '网络吞吐', unit: 'Bps', targets: [
      promTarget('sum(rate(node_network_receive_bytes_total{device!~"lo|docker.*|veth.*|br.*"}[5m]))', '入'),
      promTarget('sum(rate(node_network_transmit_bytes_total{device!~"lo|docker.*|veth.*|br.*"}[5m]))', '出'),
    ] }),
    row('PostgreSQL（postgres_exporter）'),
    stat({ title: '连接使用率', unit: 'percent', decimals: 0, targets: [promTarget('100 * sum(pg_stat_activity_count) / pg_settings_max_connections')], steps: [[null, 'green'], [60, 'yellow'], [75, 'red']], desc: '告警线：≥60% 预警 / ≥75% 扩容（压测方案 §7）' }),
    stat({ title: '库大小', unit: 'bytes', targets: [promTarget('pg_database_size_bytes{datname="junshi"}')] }),
    stat({ title: '缓存命中率', unit: 'percent', decimals: 1, targets: [promTarget('100 * sum(rate(pg_stat_database_blks_hit{datname="junshi"}[10m])) / clamp_min(sum(rate(pg_stat_database_blks_hit{datname="junshi"}[10m])) + sum(rate(pg_stat_database_blks_read{datname="junshi"}[10m])), 1e-9)')], steps: [[null, 'red'], [90, 'yellow'], [98, 'green']] }),
    stat({ title: '最长事务', unit: 's', decimals: 0, targets: [promTarget('max(pg_stat_activity_max_tx_duration{datname="junshi"})')], steps: [[null, 'green'], [60, 'yellow'], [300, 'red']] }),
    stat({ title: '死锁(1h)', targets: [promTarget('sum(increase(pg_stat_database_deadlocks{datname="junshi"}[1h]))')], steps: [[null, 'green'], [1, 'red']] }),
    stat({ title: 'exporter 状态', targets: [promTarget('pg_up')], steps: [[null, 'red'], [1, 'green']], mappings: [{ type: 'value', options: { 0: { text: 'DOWN' }, 1: { text: 'UP' } } }] }),
    timeseries({ title: '事务速率', unit: 'ops', targets: [
      promTarget('rate(pg_stat_database_xact_commit{datname="junshi"}[5m])', 'commit'),
      promTarget('rate(pg_stat_database_xact_rollback{datname="junshi"}[5m])', 'rollback'),
    ] }),
    timeseries({ title: '连接数按状态', targets: [promTarget('sum by (state) (pg_stat_activity_count{datname="junshi"})', '{{state}}')] }),
    timeseries({ title: '行级操作', unit: 'ops', targets: [
      promTarget('rate(pg_stat_database_tup_fetched{datname="junshi"}[5m])', 'fetched'),
      promTarget('rate(pg_stat_database_tup_inserted{datname="junshi"}[5m])', 'inserted'),
      promTarget('rate(pg_stat_database_tup_updated{datname="junshi"}[5m])', 'updated'),
      promTarget('rate(pg_stat_database_tup_deleted{datname="junshi"}[5m])', 'deleted'),
    ] }),
    timeseries({ title: '临时文件写入（>0 说明 work_mem 不够或有烂查询）', unit: 'Bps', targets: [promTarget('rate(pg_stat_database_temp_bytes{datname="junshi"}[5m])', 'temp bytes')] }),
  ],
});

/* ════════ 2. API 服务 ════════ */

// 「普通接口」= 剔除 LLM 长路径与探活,与压测 §7 / app.ts 过载闸同口径
const NORMAL = 'route!~".*(generate|stream).*", route!~"/api/health.*"';
const apiP95 = (q) => `histogram_quantile(${q}, sum by (le) (rate(junshi_http_request_duration_seconds_bucket{${NORMAL}}[5m])))`;

const apiDash = dashboard({
  uid: 'junshi-api', title: '军师 · API 服务',
  panels: [
    stat({ title: '服务状态', targets: [promTarget('up{job="junshi-api"}')], steps: [[null, 'red'], [1, 'green']], mappings: [{ type: 'value', options: { 0: { text: 'DOWN' }, 1: { text: 'UP' } } }] }),
    stat({ title: 'RPS(5m)', decimals: 1, targets: [promTarget('sum(rate(junshi_http_responses_total[5m]))')] }),
    stat({ title: '普通接口 P95', unit: 's', decimals: 3, targets: [promTarget(apiP95(0.95))], steps: [[null, 'green'], [0.2, 'yellow'], [0.5, 'red']], desc: '告警线：>200ms 预警 / >500ms 停止放量（压测方案 §7）' }),
    stat({ title: '5xx 率(5m)', unit: 'percentunit', decimals: 3, targets: [promTarget('sum(rate(junshi_http_responses_total{class="5xx"}[5m])) / clamp_min(sum(rate(junshi_http_responses_total[5m])), 1e-9)')], steps: [[null, 'green'], [0.005, 'yellow'], [0.01, 'red']] }),
    stat({ title: '在途请求', targets: [promTarget('junshi_http_in_flight')], steps: [[null, 'green'], [100, 'yellow'], [180, 'red']] }),
    stat({ title: '进程内存 RSS', unit: 'bytes', targets: [promTarget('junshi_process_resident_memory_bytes')], steps: [[null, 'green'], [1e9, 'yellow'], [1.5e9, 'red']] }),
    timeseries({ title: '请求速率按状态类', unit: 'reqps', stack: true, targets: [promTarget('sum by (class) (rate(junshi_http_responses_total[5m]))', '{{class}}')] }),
    timeseries({ title: '普通接口时延分位', unit: 's', targets: [
      promTarget(apiP95(0.5), 'P50'), promTarget(apiP95(0.95), 'P95'), promTarget(apiP95(0.99), 'P99'),
    ] }),
    timeseries({ title: '最慢路由 Top（P95）', unit: 's', targets: [
      promTarget(`topk(8, histogram_quantile(0.95, sum by (le, route) (rate(junshi_http_request_duration_seconds_bucket{${NORMAL}}[10m]))))`, '{{route}}'),
    ] }),
    timeseries({ title: '路由级 5xx（哪条在冒错）', unit: 'reqps', targets: [
      promTarget('sum by (route) (rate(junshi_http_route_responses_total{class="5xx"}[5m])) > 0', '{{route}}'),
    ] }),
    timeseries({ title: '限流 429 / 过载 503', unit: 'reqps', w: 8, targets: [
      promTarget('rate(junshi_http_rate_limited_total[5m])', '429 限流'),
      promTarget('rate(junshi_http_overload_rejected_total[5m])', '503 过载闸'),
    ] }),
    timeseries({ title: '事件循环延迟（自启动累计分位）', unit: 's', w: 8, targets: [
      promTarget('junshi_nodejs_event_loop_delay_seconds{quantile="0.5"}', 'P50'),
      promTarget('junshi_nodejs_event_loop_delay_seconds{quantile="0.99"}', 'P99'),
    ] }),
    timeseries({ title: '进程资源', w: 8, targets: [
      promTarget('junshi_process_resident_memory_bytes', 'RSS(B)'),
      promTarget('junshi_process_heap_used_bytes', 'Heap(B)'),
      promTarget('rate(junshi_process_cpu_seconds_total[5m])', 'CPU(核)'),
    ] }),
    timeseries({ title: 'Prisma 连接池（连接该配多少的直接依据）', targets: [
      promTarget('prisma_pool_connections_busy', 'busy'),
      promTarget('prisma_pool_connections_idle', 'idle'),
      promTarget('prisma_pool_connections_open', 'open'),
    ] }),
    timeseries({ title: '探活耗时（本机直连 vs 公网全链路）', unit: 's', targets: [
      promTarget('probe_duration_seconds', '{{instance}}'),
    ] }),
  ],
});

/* ════════ 3. LLM 网关 ════════ */

const llm429Rate = 'sum(rate(junshi_llm_upstream_429_total[10m])) / clamp_min(sum(rate(junshi_llm_granted_total[10m])), 1e-9)';
const llmDash = dashboard({
  uid: 'junshi-llm', title: '军师 · LLM 网关',
  panels: [
    stat({ title: '在途上游调用', targets: [promTarget('sum(junshi_llm_in_flight)')] }),
    stat({ title: '排队中', targets: [promTarget('sum(junshi_llm_queued)')], steps: [[null, 'green'], [1, 'yellow'], [5, 'red']] }),
    stat({ title: '上游 429 率(10m)', unit: 'percentunit', decimals: 4, targets: [promTarget(llm429Rate)], steps: [[null, 'green'], [0.005, 'yellow'], [0.02, 'red']], desc: '告警线：≥0.5% 预警 / ≥2% 收紧并发（压测方案 §7）' }),
    stat({ title: '冷却中车道', targets: [promTarget('sum(junshi_llm_cooling)')], steps: [[null, 'green'], [1, 'red']] }),
    stat({ title: '今日 Token 成本(元)', decimals: 1, targets: [promTarget('sum(increase(junshi_llm_cost_cny_total[1d]))')], steps: [[null, 'green'], [140, 'yellow'], [180, 'red']], desc: '阈值与 llm.rules.yml 的日预算联动（当前基准 200 元/天）' }),
    stat({ title: '今日 Token 量', unit: 'short', targets: [promTarget('sum(increase(junshi_llm_tokens_total[1d]))')] }),
    timeseries({ title: '车道并发 vs 动态上限', targets: [
      promTarget('junshi_llm_in_flight', '{{lane}} 在途'),
      promTarget('junshi_llm_ceiling', '{{lane}} 上限'),
    ] }),
    timeseries({ title: '排队深度与等待峰值', targets: [
      promTarget('junshi_llm_queued', '{{lane}} 排队'),
      promTarget('junshi_llm_wait_max_seconds', '{{lane}} 等待峰值(s)'),
    ], desc: '告警线：等待 ≥5s 预警 / ≥15s 降级（压测方案 §7）' }),
    timeseries({ title: '调用速率（provider × 结果）', unit: 'ops', targets: [
      promTarget('sum by (provider, status) (rate(junshi_llm_calls_total[10m]))', '{{provider}} {{status}}'),
    ] }),
    timeseries({ title: '单次调用时长分位', unit: 's', targets: [
      promTarget('histogram_quantile(0.5, sum by (le) (rate(junshi_llm_call_duration_seconds_bucket[10m])))', 'P50'),
      promTarget('histogram_quantile(0.95, sum by (le) (rate(junshi_llm_call_duration_seconds_bucket[10m])))', 'P95'),
    ] }),
    timeseries({ title: 'Token 消耗速率（按流向）', unit: 'short', stack: true, targets: [
      promTarget('sum by (dir) (rate(junshi_llm_tokens_total[10m]))', '{{dir}}'),
    ], desc: 'cached_input 占比越高,提示词缓存省得越多（会话粘性关了这里会塌）' }),
    timeseries({ title: '成本速率（元/小时,按模型）', decimals: 2, targets: [
      promTarget('sum by (model) (rate(junshi_llm_cost_cny_total[30m])) * 3600', '{{model}}'),
    ] }),
    timeseries({ title: '上游 429 与冷却', targets: [
      promTarget('sum by (lane) (increase(junshi_llm_upstream_429_total[10m]))', '{{lane}} 429(10m)'),
      promTarget('sum by (lane) (increase(junshi_llm_cooldowns_total[10m]))', '{{lane}} 进冷却(10m)'),
    ] }),
    timeseries({ title: '产出质量：降级 / 截断 / 漏账（都该是 0）', targets: [
      promTarget('sum by (path) (increase(junshi_gen_degraded_total[15m]))', '降级 {{path}}'),
      promTarget('sum by (provider) (increase(junshi_llm_output_truncated_total[15m]))', '截断 {{provider}}'),
      promTarget('sum(increase(junshi_usage_unreported_total[15m]))', '用量漏账'),
    ] }),
    timeseries({ title: '端点池：权重与冷却', targets: [
      promTarget('junshi_llm_pool_endpoint_weight', '{{label}} 权重'),
      promTarget('junshi_llm_pool_endpoint_cooling * 10', '{{label}} 冷却(×10)'),
    ], desc: '冷却=1 的端点被跳过不参与分流;粘性开关见 junshi_llm_pool_sticky' }),
    timeseries({ title: '排队处置：拒绝 / 超时降级', targets: [
      promTarget('sum by (lane) (increase(junshi_llm_rejected_total[10m]))', '{{lane}} 队满拒绝'),
      promTarget('sum by (lane) (increase(junshi_llm_timed_out_total[10m]))', '{{lane}} 排队超时'),
    ] }),
  ],
});

/* ════════ 4. 业务大盘 ════════ */
// 实时/速率类走 Prometheus;历史/存量类直查业务库（只读账号）。
// 表名 = prisma/schema.prisma 的 @@map：app_user / payment_order / credit_ledger / token_usage / llm_trace / moderation_log / plan

const q = (sql) => sql.replace(/\s+/g, ' ').trim();
const bizDash = dashboard({
  uid: 'junshi-business', title: '军师 · 业务大盘', from: 'now-30d', refresh: '1m',
  panels: [
    stat({ title: '总用户数', targets: [pgTarget(q(`SELECT count(*)::float AS value FROM app_user`), 'A', 'table')] }),
    stat({ title: '今日注册', targets: [pgTarget(q(`SELECT count(*)::float AS value FROM app_user WHERE "createdAt" >= date_trunc('day', now())`), 'A', 'table')] }),
    stat({ title: '今日 GMV(元)', decimals: 0, targets: [pgTarget(q(`SELECT COALESCE(sum(amount), 0) / 100.0 AS value FROM payment_order WHERE status IN ('applied','refunded') AND "paidAt" >= date_trunc('day', now())`), 'A', 'table')] }),
    stat({ title: '今日订单(入账)', targets: [pgTarget(q(`SELECT count(*)::float AS value FROM payment_order WHERE status IN ('applied','refunded') AND "paidAt" >= date_trunc('day', now())`), 'A', 'table')] }),
    stat({ title: '卡单(已付未发放)', targets: [promTarget('junshi_pay_stuck_paid_unapplied')], steps: [[null, 'green'], [1, 'red']], desc: '>0 超 10 分钟会触发 critical 告警,处理入口=运营后台「订单」页' }),
    stat({ title: '今日产出(报告)', targets: [pgTarget(q(`SELECT count(*)::float AS value FROM llm_trace WHERE kind = 'deliverable' AND status = 'ok' AND "createdAt" >= date_trunc('day', now())`), 'A', 'table')] }),
    timeseries({ title: '注册趋势（日）', targets: [pgTarget(q(`
      SELECT date_trunc('day', "createdAt") AS time, count(*)::float AS "注册数"
      FROM app_user WHERE $__timeFilter("createdAt") GROUP BY 1 ORDER BY 1`))] }),
    timeseries({ title: '日活（当天有过模型调用的用户）', targets: [pgTarget(q(`
      SELECT date_trunc('day', "createdAt") AS time, count(DISTINCT "userId")::float AS "DAU"
      FROM llm_trace WHERE "userId" IS NOT NULL AND $__timeFilter("createdAt") GROUP BY 1 ORDER BY 1`))] }),
    timeseries({ title: 'GMV 与订单量（日,按支付时间）', targets: [
      pgTarget(q(`SELECT date_trunc('day', "paidAt") AS time, sum(amount)/100.0 AS "GMV(元)"
        FROM payment_order WHERE status IN ('applied','refunded') AND $__timeFilter("paidAt") GROUP BY 1 ORDER BY 1`)),
      pgTarget(q(`SELECT date_trunc('day', "paidAt") AS time, count(*)::float AS "订单数"
        FROM payment_order WHERE status IN ('applied','refunded') AND $__timeFilter("paidAt") GROUP BY 1 ORDER BY 1`)),
    ], desc: '口径=完成支付的订单（含事后退款的）;退款金额单看下面退款面板' }),
    timeseries({ title: 'Token 成本（元/日,含基建调用）', targets: [pgTarget(q(`
      SELECT date_trunc('day', "createdAt") AS time, sum("costMicros")/1e6 AS "成本(元)"
      FROM token_usage WHERE $__timeFilter("createdAt") GROUP BY 1 ORDER BY 1`))] }),
    timeseries({ title: '算力流水（日）', targets: [
      pgTarget(q(`SELECT date_trunc('day', "createdAt") AS time, sum(-delta)::float AS "消耗"
        FROM credit_ledger WHERE delta < 0 AND $__timeFilter("createdAt") GROUP BY 1 ORDER BY 1`)),
      pgTarget(q(`SELECT date_trunc('day', "createdAt") AS time, sum(delta)::float AS "发放"
        FROM credit_ledger WHERE delta > 0 AND $__timeFilter("createdAt") GROUP BY 1 ORDER BY 1`)),
    ] }),
    timeseries({ title: '产出量（日 × 类型）', targets: [pgTarget(q(`
      SELECT date_trunc('day', "createdAt") AS time, kind AS metric, count(*)::float AS value
      FROM llm_trace WHERE status = 'ok' AND $__timeFilter("createdAt") GROUP BY 1, 2 ORDER BY 1`))] }),
    table({ title: '套餐分布（当前存量）', targets: [pgTarget(q(`
      SELECT CASE WHEN u."planId" IS NULL THEN '无套餐'
                  WHEN u."planExpiresAt" IS NOT NULL AND u."planExpiresAt" <= now() THEN '已过期'
                  ELSE p.name END AS "套餐",
             count(*) AS "用户数"
      FROM app_user u LEFT JOIN plan p ON p.id = u."planId" GROUP BY 1 ORDER BY 2 DESC`), 'A', 'table')] }),
    timeseries({ title: '退款（日）', targets: [pgTarget(q(`
      SELECT date_trunc('day', "refundedAt") AS time, sum(amount)/100.0 AS "退款(元)"
      FROM payment_order WHERE status = 'refunded' AND $__timeFilter("refundedAt") GROUP BY 1 ORDER BY 1`))] }),
    timeseries({ title: '审核拦截（日 × 方向）', targets: [pgTarget(q(`
      SELECT date_trunc('day', "createdAt") AS time, "refType" AS metric, count(*)::float AS value
      FROM moderation_log WHERE verdict = 'block' AND $__timeFilter("createdAt") GROUP BY 1, 2 ORDER BY 1`))] }),
    timeseries({ title: '转化信号：禁写闸拦截（想用但没套餐/已到期）', unit: 'ops', targets: [
      promTarget('sum by (state) (rate(junshi_plan_gate_blocked_total[1h])) * 3600', '{{state}}/小时'),
    ], desc: 'none=未开通用户在尝试写操作（销售线索）;expired=到期用户还在用（续费提醒线索）' }),
  ],
});

/* ── 输出 ── */
for (const d of [sysDash, apiDash, llmDash, bizDash]) {
  const file = join(OUT, `${d.uid}.json`);
  writeFileSync(file, `${JSON.stringify(d, null, 2)}\n`);
  console.log(`✓ ${file}  (${d.panels.length} panels)`);
}
