// 告警配置化（监控大盘二期）：阈值与飞书通知渠道都从 DB 读，后台改完即生效，不再改文件发版。
//
// 阈值链路：本注册表 → 运营后台「功能开关」页（数值型开关，复用既有 UI/校验/审计）→
//   FeatureFlag.payload → /api/metrics 吐 `junshi_alert_config{key=...}` 配置指标 →
//   告警规则用 scalar(junshi_alert_config{key="..."}) 取阈值（Prometheus 每 15s 抓一次，改动 ≤75s 生效：
//   flag payload 60s 缓存 + 一个抓取周期）。
//
// 单位约定：**全部取整数**（ms / ‰ / % / 元 / MB / 次）——既有开关 PATCH 会 Math.floor，
// 规则表达式里再除回去（如 p95_warn_ms / 1000）。别在这里加小数阈值。
//
// 通知链路：Alertmanager webhook → POST /api/alerts/webhook（Bearer METRICS_TOKEN）→
//   本模块按 DB 里的飞书群机器人 webhook 转发（可选签名）。webhook/secret 经 secretBox 加密落库。
//
// 诚实边界：通知通道依赖 API 进程本身——API 挂掉时 JunshiApiDown 告警只在 Alertmanager UI 可见，
// 发不到飞书（要外部拨测兜底，见 docs/MONITORING.md §7）。

import { createHmac } from 'node:crypto';
import { featureFlagPayload, setFeatureFlagPayload } from './featureFlag.js';
import { encryptSecret, decryptSecretSafe } from './secretBox.js';

/* ─────────────── 阈值注册表 ─────────────── */

export interface AlertConfigDef {
  /** FeatureFlag 表主键（带 monitor. 前缀）。 */
  id: string;
  /** Prometheus 标签值（junshi_alert_config{key=...}），去前缀。 */
  key: string;
  label: string;
  desc: string;
  def: number;
  min: number;
  max: number;
  unit: string;
}

const D = (key: string, label: string, desc: string, def: number, min: number, max: number, unit: string): AlertConfigDef =>
  ({ id: `monitor.${key}`, key, label, desc, def, min, max, unit });

// 默认值 = 压测方案 §7 告警线原文（docs/[OPUS5]LOADTEST_OPT_PLAN_2026-07-26.md）。
// 后台改的是「运行值」；默认值是口径基线，改基线仍走文档+代码。
export const ALERT_CONFIG_DEFS: AlertConfigDef[] = [
  D('token_daily_budget_cny', 'Token 日预算', '达 70% 预警 / 90% 严重（成本告警基准）', 200, 10, 1_000_000, '元/天'),
  D('api_p95_warn_ms', '接口 P95 预警线', '普通接口（剔除生成/流式）P95 超过即预警', 200, 10, 60_000, 'ms'),
  D('api_p95_crit_ms', '接口 P95 严重线', '超过即「停止放量」级告警', 500, 10, 60_000, 'ms'),
  D('api_5xx_crit_permille', '5xx 错误率严重线', '千分比：10 = 1%', 10, 1, 1000, '‰'),
  D('llm_429_warn_permille', 'LLM 429 率预警线', '千分比：5 = 0.5%（上游限流开始冒头）', 5, 1, 1000, '‰'),
  D('llm_429_crit_permille', 'LLM 429 率严重线', '千分比：20 = 2%（该收紧并发/延长退避）', 20, 1, 1000, '‰'),
  D('llm_wait_warn_s', 'LLM 排队等待预警线', '排队等待峰值超过即预警', 5, 1, 600, '秒'),
  D('llm_wait_crit_s', 'LLM 排队等待严重线', '超过即「降级或暂停接单」级告警', 15, 1, 600, '秒'),
  D('host_cpu_warn_pct', '主机 CPU 预警线', '持续 5 分钟超过即预警', 65, 10, 100, '%'),
  D('host_cpu_crit_pct', '主机 CPU 严重线', '持续 3 分钟超过=该扩容', 80, 10, 100, '%'),
  D('pg_conn_warn_pct', 'PG 连接使用率预警线', '连接数/max_connections', 60, 10, 100, '%'),
  D('pg_conn_crit_pct', 'PG 连接使用率严重线', '超过即「限流并扩连接层」级告警', 75, 10, 100, '%'),
  D('rss_warn_mb', 'API 进程内存预警线', 'RSS 持续 30 分钟超过即怀疑泄漏', 1500, 100, 65_536, 'MB'),
  D('refund_spike_6h', '退款激增线', '6 小时内退款笔数超过即预警', 3, 1, 1000, '笔'),
  D('moderation_block_1h', '审核拦截激增线', '1 小时内拦截次数超过即预警', 20, 1, 100_000, '次'),
  // —— 对话交互质量（2026-08-04 截断/超时复盘后补；默认值按当时实测取，不是压测方案原文）——
  D('chat_truncated_1h', '未写完交回用户线', '1 小时内「续写后仍未写完」次数超过即预警（用户真的看到了未写完）', 5, 1, 100_000, '次'),
  D('chat_continued_1h', '自动续写频次线', '1 小时内被续写救回的次数超过即提示——该调输出预算或提示词长度约束了', 20, 1, 100_000, '次'),
  D('chat_first_token_p95_s', '首字延迟 P95 线', '流式对话首字延迟 P95 超过即预警（实测干净时 4–11s）', 20, 1, 300, '秒'),
];

/** 当前生效的全部阈值（默认值 + DB 覆盖）。featureFlagPayload 自带 60s 缓存，抓取热路径可承受。 */
export async function alertConfigValues(): Promise<{ key: string; value: number }[]> {
  return Promise.all(ALERT_CONFIG_DEFS.map(async (d) => {
    const payload = (await featureFlagPayload(d.id)) as Record<string, unknown> | null;
    const raw = payload?.value;
    const value = typeof raw === 'number' && Number.isFinite(raw) && raw >= d.min && raw <= d.max ? raw : d.def;
    return { key: d.key, value };
  }));
}

/* ─────────────── 飞书通知渠道 ─────────────── */

const FEISHU_FLAG_ID = 'monitor.feishu-webhook';
const FEISHU_HOST_ALLOW = /^https:\/\/open\.(feishu\.cn|larksuite\.com)\/open-apis\/bot\/v2\/hook\//;

export interface FeishuTarget { url: string; secret: string | null }

/** 读飞书机器人配置（解密后）。未配置 → null。fresh=true 绕过 60s 缓存（保存后立即测试用）。 */
export async function feishuTarget(opts: { fresh?: boolean } = {}): Promise<FeishuTarget | null> {
  const payload = (await featureFlagPayload(FEISHU_FLAG_ID, opts)) as Record<string, unknown> | null;
  const url = decryptSecretSafe(typeof payload?.url === 'string' ? payload.url : '');
  if (!url) return null;
  const secret = decryptSecretSafe(typeof payload?.secret === 'string' ? payload.secret : '') || null;
  return { url, secret };
}

/**
 * 写飞书机器人配置（加密落库）。url 传空串 = 清除配置。
 * 只允许飞书官方机器人域名——这是一条「把内部告警外发到任意 URL」的通道，白名单防它变成数据外带口。
 */
export async function setFeishuTarget(url: string, secret: string): Promise<void> {
  const u = url.trim();
  if (u && !FEISHU_HOST_ALLOW.test(u)) {
    throw Object.assign(new Error('仅支持飞书群自定义机器人 webhook（https://open.feishu.cn/open-apis/bot/v2/hook/…）'), {
      statusCode: 400, code: 'BAD_WEBHOOK_URL',
    });
  }
  await setFeatureFlagPayload(FEISHU_FLAG_ID, {
    url: u ? encryptSecret(u) : '',
    secret: secret.trim() ? encryptSecret(secret.trim()) : '',
  });
}

/** 后台展示用：已配置与否 + 掩码 URL（只露 hook id 尾 6 位），绝不回传明文。 */
export async function feishuStatus(): Promise<{ configured: boolean; urlMasked: string | null; hasSecret: boolean }> {
  const t = await feishuTarget({ fresh: true });
  if (!t) return { configured: false, urlMasked: null, hasSecret: false };
  return { configured: true, urlMasked: `…/bot/v2/hook/***${t.url.slice(-6)}`, hasSecret: !!t.secret };
}

/** 飞书自定义机器人签名：HMAC-SHA256(key=`${timestamp}\n${secret}`, msg='') 的 base64。 */
export function feishuSign(secret: string, timestampSec: number): string {
  return createHmac('sha256', `${timestampSec}\n${secret}`).update('').digest('base64');
}

/* ─────────────── Alertmanager → 飞书 转发 ─────────────── */

// Alertmanager webhook v4 载荷里本次要用的字段（其余忽略）。
export interface AmAlert {
  status?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
}
export interface AmWebhookPayload {
  status?: string; // firing | resolved（组级）
  groupLabels?: Record<string, string>;
  alerts?: AmAlert[];
}

const sevIcon = (sev: string | undefined) => (sev === 'critical' ? '🔴' : sev === 'warning' ? '🟡' : '🔵');

/** 把一组告警拼成飞书 text 消息（自定义机器人 text 不渲染 markdown，用行文本+emoji）。 */
export function formatAlertText(p: AmWebhookPayload): string {
  const alerts = p.alerts ?? [];
  const firing = alerts.filter((a) => a.status !== 'resolved');
  const resolved = alerts.filter((a) => a.status === 'resolved');
  const head = p.status === 'resolved'
    ? `✅ 告警恢复：${p.groupLabels?.alertname ?? ''}`
    : `${sevIcon(alerts[0]?.labels?.severity)} 军师告警：${p.groupLabels?.alertname ?? ''}（${firing.length} 条）`;
  const line = (a: AmAlert) => {
    const sev = a.labels?.severity ?? 'info';
    const summary = a.annotations?.summary ?? a.labels?.alertname ?? '(无描述)';
    const at = a.startsAt ? ` · 始于 ${a.startsAt.slice(0, 19).replace('T', ' ')}Z` : '';
    return `${sevIcon(sev)} [${sev}] ${summary}${at}`;
  };
  const lines = [head, ...firing.map(line), ...(resolved.length ? ['— 已恢复 —', ...resolved.map(line)] : [])];
  return lines.join('\n');
}

// 测试 seam：单测替换传输层，不真出网（参照 llmPool.__setPoolForTest 先例）。
type Transport = (url: string, body: unknown) => Promise<{ ok: boolean; status: number; text: string }>;
const defaultTransport: Transport = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  return { ok: res.ok, status: res.status, text: await res.text().catch(() => '') };
};
let transport: Transport = defaultTransport;
export function __setFeishuTransportForTest(t: Transport | null): void {
  transport = t ?? defaultTransport;
}

/**
 * 发一条文本到配置的飞书群。未配置 → { sent:false, reason:'not_configured' }。
 * 飞书返回体 { code:0 } 才算成功（HTTP 200 但 code!=0 是配置错，如签名不对/机器人被移除）。
 */
export async function sendFeishuText(text: string, opts: { fresh?: boolean } = {}): Promise<{ sent: boolean; reason?: string }> {
  const target = await feishuTarget(opts);
  if (!target) return { sent: false, reason: 'not_configured' };
  const body: Record<string, unknown> = { msg_type: 'text', content: { text } };
  if (target.secret) {
    const ts = Math.floor(Date.now() / 1000);
    body.timestamp = String(ts);
    body.sign = feishuSign(target.secret, ts);
  }
  try {
    const res = await transport(target.url, body);
    if (!res.ok) return { sent: false, reason: `http_${res.status}` };
    try {
      const parsed = JSON.parse(res.text) as { code?: number; msg?: string };
      if (typeof parsed.code === 'number' && parsed.code !== 0) return { sent: false, reason: `feishu_${parsed.code}:${parsed.msg ?? ''}` };
    } catch { /* 非 JSON 响应按成功处理（HTTP 已 2xx） */ }
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: (err as Error).message };
  }
}
