// Alertmanager → 飞书 转发端点（监控大盘二期：通知渠道后台配置化）。
//
// 链路：Prometheus 告警规则 → Alertmanager（分组/去重/抑制）→ 本端点（Bearer METRICS_TOKEN）
//       → services/alertConfig.sendFeishuText（webhook 存 DB、后台「功能开关」页配置）。
// 为什么经应用转发而不是 Alertmanager 直发/PrometheusAlert 桥：
//   ① 飞书 webhook 地址成为运行时配置（后台改，不发版、不重启容器）；
//   ② 少维护一个桥接容器；③ 转发成败进 /metrics（junshi_alerts_forwarded_total），通知链路本身可观测。
// 诚实边界：API 进程挂掉时本通道随之失联（JunshiApiDown 只在 Alertmanager UI 可见），
//   需要外部拨测兜底——见 docs/MONITORING.md §7。
import type { FastifyInstance } from 'fastify';
import { bearerOf, tokenMatches } from './metrics.js';
import { sendFeishuText, formatAlertText, type AmWebhookPayload } from '../services/alertConfig.js';
import { noteAlertForward } from '../services/metrics.js';

export async function alertRoutes(app: FastifyInstance) {
  // rateLimit:false —— 告警风暴时恰恰不能丢通知；量级由 Alertmanager 的分组/repeat_interval 管着。
  app.post('/alerts/webhook', { config: { rateLimit: false } }, async (req, reply) => {
    const configured = (process.env.METRICS_TOKEN ?? '').trim();
    // 与 /api/metrics 同规则：未配 token 整个端点关闭（404），配了但对不上 401。
    if (!configured) return reply.code(404).send({ error: '未配置 METRICS_TOKEN，告警回传端点已关闭', code: 'METRICS_DISABLED' });
    if (!tokenMatches(bearerOf(req), configured)) {
      return reply.code(401).send({ error: '告警回传鉴权失败', code: 'METRICS_UNAUTHORIZED' });
    }
    const payload = (req.body ?? {}) as AmWebhookPayload;
    if (!Array.isArray(payload.alerts) || payload.alerts.length === 0) {
      return { forwarded: false, reason: 'empty' };
    }
    const r = await sendFeishuText(formatAlertText(payload));
    noteAlertForward(r.sent ? 'sent' : r.reason === 'not_configured' ? 'not_configured' : 'failed');
    if (!r.sent && r.reason !== 'not_configured') {
      // 转发失败回 502：Alertmanager 会按自己的重试策略再投，不丢告警。
      return reply.code(502).send({ forwarded: false, reason: r.reason });
    }
    return { forwarded: r.sent, ...(r.sent ? {} : { reason: r.reason }) };
  });
}
