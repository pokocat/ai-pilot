// 告警配置化（监控大盘二期）——锁四件事：
//   ① 阈值：默认值=压测方案 §7 口径；DB 覆盖生效；越界脏值回落默认（配置坏了不能把告警线带沟里）。
//   ② 飞书渠道：URL 白名单（这是「把内部告警外发到任意 URL」的通道，不能变成数据外带口）；
//      掩码回显绝不吐明文 hook id；签名算法锁定（key=`${ts}\n${secret}`、空消息、base64）。
//   ③ 转发：Alertmanager 载荷 → 飞书 Card 2.0；带 secret 时 body 里有 timestamp+sign；飞书 code!=0 判失败。
//   ④ 端点：/api/alerts/webhook 与 /api/metrics 同门禁（未配 404 / 不对 401）；转发失败回 502 让 AM 重投。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { prisma } from '../src/db.js';
import { __clearFeatureCache, setFeatureFlagPayload } from '../src/services/featureFlag.js';
import {
  ALERT_CONFIG_DEFS, alertConfigValues, feishuSign, formatAlertCard,
  setFeishuTarget, feishuStatus, sendFeishuText, sendFeishuCard, __setFeishuTransportForTest,
} from '../src/services/alertConfig.js';
import { alertRoutes } from '../src/routes/alerts.js';
import { __resetMetrics } from '../src/services/metrics.js';

const TOKEN = 'alerts-token-for-test';
const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef-123456';
let savedToken: string | undefined;

async function cleanup() {
  await prisma.featureFlag.deleteMany({ where: { id: { startsWith: 'monitor.' } } });
  __clearFeatureCache();
  __setFeishuTransportForTest(null);
  __resetMetrics();
}

beforeEach(async () => { savedToken = process.env.METRICS_TOKEN; await cleanup(); });
afterEach(async () => {
  if (savedToken === undefined) delete process.env.METRICS_TOKEN; else process.env.METRICS_TOKEN = savedToken;
  await cleanup();
});

describe('阈值', () => {
  test('无覆盖时返回默认基线（API 用生产 SLO，容量/成本沿用压测口径）', async () => {
    const values = new Map((await alertConfigValues()).map((v) => [v.key, v.value]));
    for (const d of ALERT_CONFIG_DEFS) assert.equal(values.get(d.key), d.def, d.key);
    assert.equal(values.get('token_daily_budget_cny'), 200);
    assert.equal(values.get('host_cpu_warn_pct'), 65);
    assert.equal(values.get('api_p95_warn_ms'), 800);
    assert.equal(values.get('api_p95_crit_ms'), 2000);
    assert.equal(values.get('api_min_requests_15m'), 20);
  });

  test('DB 覆盖生效；越界/脏值回落默认', async () => {
    await setFeatureFlagPayload('monitor.token_daily_budget_cny', { value: 500 });
    await setFeatureFlagPayload('monitor.host_cpu_warn_pct', { value: 9999 }); // 超 max
    await setFeatureFlagPayload('monitor.pg_conn_warn_pct', { value: 'abc' as unknown as number }); // 非数值
    __clearFeatureCache();
    const values = new Map((await alertConfigValues()).map((v) => [v.key, v.value]));
    assert.equal(values.get('token_daily_budget_cny'), 500);
    assert.equal(values.get('host_cpu_warn_pct'), 65, '越界值必须回落默认');
    assert.equal(values.get('pg_conn_warn_pct'), 60, '脏值必须回落默认');
  });

  test('注册表 key 与规则文件引用一致（id 带 monitor. 前缀、key 不带）', () => {
    for (const d of ALERT_CONFIG_DEFS) {
      assert.equal(d.id, `monitor.${d.key}`);
      assert.ok(d.min <= d.def && d.def <= d.max, `${d.key} 默认值必须在 min-max 内`);
    }
    const byKey = new Map(ALERT_CONFIG_DEFS.map((d) => [d.key, d.def]));
    assert.ok(byKey.get('api_p95_warn_ms')! < byKey.get('api_p95_crit_ms')!, 'API 预警线必须低于严重线');
  });
});

describe('飞书渠道', () => {
  test('URL 白名单：只收飞书机器人域名', async () => {
    await assert.rejects(() => setFeishuTarget('https://evil.example.com/collect', ''), /仅支持飞书/);
    await assert.rejects(() => setFeishuTarget('http://open.feishu.cn/open-apis/bot/v2/hook/x', ''), /仅支持飞书/); // http 不行
    await setFeishuTarget(HOOK, ''); // 合法不抛
  });

  test('掩码回显不吐明文；清空配置生效', async () => {
    await setFeishuTarget(HOOK, 's3cret');
    const st = await feishuStatus();
    assert.equal(st.configured, true);
    assert.equal(st.hasSecret, true);
    assert.ok(!st.urlMasked!.includes('abcdef-123456'.slice(0, -6)), '掩码不得包含 hook id 主体');
    assert.ok(st.urlMasked!.endsWith('123456'), '保留尾 6 位供人工比对');
    await setFeishuTarget('', '');
    assert.equal((await feishuStatus()).configured, false);
  });

  test('签名算法锁定：HMAC-SHA256(key=`${ts}\\n${secret}`, msg=空) 的 base64', () => {
    // 期望值按算法定义一次性算出后写死——防止实现被误改成「secret 当 key、ts 当消息」等变体。
    assert.equal(feishuSign('test-secret', 1700000000), 'mbm4Y4oluIPQ00qlBIhX8vAZ0EKv3nw0LuTb91jPL84=');
  });

  test('转发：带 secret 时 body 含 timestamp+sign；飞书 code!=0 判失败', async () => {
    await setFeishuTarget(HOOK, 's3cret');
    const seen: { url: string; body: Record<string, unknown> }[] = [];
    __setFeishuTransportForTest(async (url, body) => {
      seen.push({ url, body: body as Record<string, unknown> });
      return { ok: true, status: 200, text: '{"code":0}' };
    });
    const r = await sendFeishuText('hello', { fresh: true });
    assert.equal(r.sent, true);
    assert.equal(seen[0].url, HOOK);
    assert.equal(seen[0].body.msg_type, 'text');
    assert.ok(typeof seen[0].body.timestamp === 'string' && typeof seen[0].body.sign === 'string');

    __setFeishuTransportForTest(async () => ({ ok: true, status: 200, text: '{"code":19021,"msg":"sign match fail"}' }));
    const bad = await sendFeishuText('hello', { fresh: true });
    assert.equal(bad.sent, false);
    assert.match(bad.reason!, /19021/);
  });

  test('Card 2.0 走 interactive 消息，签名与回执规则复用文本通道', async () => {
    await setFeishuTarget(HOOK, 's3cret');
    let body: Record<string, unknown> | null = null;
    __setFeishuTransportForTest(async (_url, value) => {
      body = value as Record<string, unknown>;
      return { ok: true, status: 200, text: '{"code":0}' };
    });
    const r = await sendFeishuCard({ schema: '2.0', body: { elements: [] } }, { fresh: true });
    assert.equal(r.sent, true);
    assert.equal(body!.msg_type, 'interactive');
    assert.deepEqual((body!.card as Record<string, unknown>).schema, '2.0');
    assert.equal(typeof body!.timestamp, 'string');
    assert.equal(typeof body!.sign, 'string');
  });

  test('未配置渠道 → not_configured（不算失败）', async () => {
    const r = await sendFeishuText('hello', { fresh: true });
    assert.deepEqual(r, { sent: false, reason: 'not_configured' });
  });
});

describe('格式化', () => {
  test('firing 组：严重度配色、三格态势、当前值/阈值/影响/动作和看板入口齐全', () => {
    const card = formatAlertCard({
      status: 'firing',
      groupLabels: { category: 'api', severity: 'critical' },
      alerts: [
        {
          status: 'firing', startsAt: '2026-07-28T12:00:00.000Z',
          labels: { alertname: 'JunshiApiP95High', severity: 'critical', category: 'api', route: '/api/me' },
          annotations: {
            title: 'API 延迟严重', summary: '普通接口持续变慢', current: '0.82 秒', threshold: '严重线 0.50 秒', excess: '高于告警线 64%',
            impact: '用户页面加载明显变慢', action: '停止放量并检查最慢路由', dashboard: 'junshi-api',
          },
        },
        { status: 'firing', labels: { alertname: 'X', severity: 'warning', category: 'api' }, annotations: { title: '另一个信号' } },
      ],
    }, { nowMs: Date.parse('2026-07-28T12:05:00.000Z'), environment: '预发', grafanaBaseUrl: 'https://ops.example.com/grafana/' });
    const header = card.header as Record<string, unknown>;
    assert.equal(header.template, 'red');
    assert.match(JSON.stringify(card), /API 延迟严重等 2 条关联告警/);
    assert.match(JSON.stringify(card), /P1 严重 · API 服务 · 2 个关联信号/);
    assert.match(JSON.stringify(card), /0.82 秒/);
    assert.match(JSON.stringify(card), /严重线 0.50 秒/);
    assert.match(JSON.stringify(card), /高于告警线 64%/);
    assert.match(JSON.stringify(card), /超限状态/);
    assert.match(JSON.stringify(card), /font color='red'/);
    assert.match(JSON.stringify(card), /用户页面加载明显变慢/);
    assert.match(JSON.stringify(card), /停止放量并检查最慢路由/);
    assert.match(JSON.stringify(card), /5 分 0 秒/);
    assert.match(JSON.stringify(card), /https:\/\/ops.example.com\/grafana\/d\/junshi-api/);
    assert.doesNotMatch(JSON.stringify(card), /background_style|rgba\(/);
  });

  test('resolved 组：绿色恢复态并展示从触发到恢复耗时', () => {
    const card = formatAlertCard({
      status: 'resolved',
      groupLabels: { category: 'system' },
      alerts: [{
        status: 'resolved', startsAt: '2026-07-28T12:00:00.000Z', endsAt: '2026-07-28T13:30:00.000Z',
        labels: { alertname: 'HostCpuHigh', severity: 'warning', category: 'system' }, annotations: { title: 'CPU 高负载' },
      }],
    }, { nowMs: Date.parse('2026-07-28T14:00:00.000Z') });
    const header = card.header as Record<string, unknown>;
    assert.equal(header.template, 'green');
    assert.match(JSON.stringify(card), /CPU 高负载 · 已恢复/);
    assert.match(JSON.stringify(card), /P2 预警 · 主机资源 · 当前：已恢复/);
    assert.match(JSON.stringify(card), /已回落至告警线内/);
    assert.match(JSON.stringify(card), /1 小时 30 分/);
  });

  test('标签与注解按数据转义，告警风暴最多展开 8 条并明示截断', () => {
    const alerts = Array.from({ length: 10 }, (_, i) => ({
      status: 'firing', labels: { alertname: `A${i}`, severity: 'warning', category: 'api', route: '*坏_[值]*' },
      annotations: { title: `信号 ${i}`, summary: '<script>alert(1)</script>' },
    }));
    const json = JSON.stringify(formatAlertCard({ status: 'firing', alerts, truncatedAlerts: 2 }));
    assert.doesNotMatch(json, /<script>/);
    assert.match(json, /还有 4 条信号未在卡片中展开/);
    assert.doesNotMatch(json, /信号 8/);
  });
});

describe('回传端点', () => {
  const build = async () => {
    const app = Fastify({ logger: false });
    await app.register(alertRoutes, { prefix: '/api' });
    await app.ready();
    return app;
  };
  const PAYLOAD = {
    status: 'firing', groupLabels: { alertname: 'X' },
    alerts: [{ status: 'firing', labels: { severity: 'warning' }, annotations: { summary: 's' } }],
  };

  test('未配 METRICS_TOKEN → 404；token 不对 → 401', async () => {
    delete process.env.METRICS_TOKEN;
    const app = await build();
    assert.equal((await app.inject({ method: 'POST', url: '/api/alerts/webhook', payload: PAYLOAD })).statusCode, 404);
    process.env.METRICS_TOKEN = TOKEN;
    const res = await app.inject({ method: 'POST', url: '/api/alerts/webhook', payload: PAYLOAD, headers: { authorization: 'Bearer wrong' } });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  test('鉴权通过：未配飞书 → 200 not_configured；配了 → 转发成功；传输失败 → 502（AM 会重投）', async () => {
    process.env.METRICS_TOKEN = TOKEN;
    const app = await build();
    const auth = { authorization: `Bearer ${TOKEN}` };

    const r1 = await app.inject({ method: 'POST', url: '/api/alerts/webhook', payload: PAYLOAD, headers: auth });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.json().forwarded, false);
    assert.equal(r1.json().reason, 'not_configured');

    await setFeishuTarget(HOOK, '');
    __setFeishuTransportForTest(async () => ({ ok: true, status: 200, text: '{"code":0}' }));
    const r2 = await app.inject({ method: 'POST', url: '/api/alerts/webhook', payload: PAYLOAD, headers: auth });
    assert.equal(r2.statusCode, 200);
    assert.equal(r2.json().forwarded, true);

    __setFeishuTransportForTest(async () => ({ ok: false, status: 500, text: '' }));
    const r3 = await app.inject({ method: 'POST', url: '/api/alerts/webhook', payload: PAYLOAD, headers: auth });
    assert.equal(r3.statusCode, 502, '转发失败必须非 2xx，Alertmanager 才会重试');

    // 空 alerts 不转发（AM 心跳/空组）
    const r4 = await app.inject({ method: 'POST', url: '/api/alerts/webhook', payload: { alerts: [] }, headers: auth });
    assert.equal(r4.json().forwarded, false);
    await app.close();
  });
});
