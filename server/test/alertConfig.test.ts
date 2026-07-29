// 告警配置化（监控大盘二期）——锁四件事：
//   ① 阈值：默认值=压测方案 §7 口径；DB 覆盖生效；越界脏值回落默认（配置坏了不能把告警线带沟里）。
//   ② 飞书渠道：URL 白名单（这是「把内部告警外发到任意 URL」的通道，不能变成数据外带口）；
//      掩码回显绝不吐明文 hook id；签名算法锁定（key=`${ts}\n${secret}`、空消息、base64）。
//   ③ 转发：Alertmanager 载荷 → 飞书 text；带 secret 时 body 里有 timestamp+sign；飞书 code!=0 判失败。
//   ④ 端点：/api/alerts/webhook 与 /api/metrics 同门禁（未配 404 / 不对 401）；转发失败回 502 让 AM 重投。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { prisma } from '../src/db.js';
import { __clearFeatureCache, setFeatureFlagPayload } from '../src/services/featureFlag.js';
import {
  ALERT_CONFIG_DEFS, alertConfigValues, feishuSign, formatAlertText,
  setFeishuTarget, feishuStatus, sendFeishuText, __setFeishuTransportForTest,
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
  test('无覆盖时全部返回默认值（=压测方案 §7 口径）', async () => {
    const values = new Map((await alertConfigValues()).map((v) => [v.key, v.value]));
    for (const d of ALERT_CONFIG_DEFS) assert.equal(values.get(d.key), d.def, d.key);
    assert.equal(values.get('token_daily_budget_cny'), 200);
    assert.equal(values.get('host_cpu_warn_pct'), 65);
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

  test('未配置渠道 → not_configured（不算失败）', async () => {
    const r = await sendFeishuText('hello', { fresh: true });
    assert.deepEqual(r, { sent: false, reason: 'not_configured' });
  });
});

describe('格式化', () => {
  test('firing 组：标题带条数，行带 severity 图标与 summary', () => {
    const text = formatAlertText({
      status: 'firing',
      groupLabels: { alertname: 'JunshiApiP95High' },
      alerts: [
        { status: 'firing', labels: { severity: 'critical' }, annotations: { summary: 'P95 超严重线' }, startsAt: '2026-07-28T12:00:00.000Z' },
        { status: 'firing', labels: { severity: 'warning' }, annotations: { summary: '429 冒头' } },
      ],
    });
    assert.match(text, /军师告警：JunshiApiP95High（2 条）/);
    assert.match(text, /🔴 \[critical\] P95 超严重线 · 始于 2026-07-28 12:00:00Z/);
    assert.match(text, /🟡 \[warning\] 429 冒头/);
  });

  test('resolved 组：✅ 恢复标题', () => {
    const text = formatAlertText({
      status: 'resolved',
      groupLabels: { alertname: 'HostCpuHigh' },
      alerts: [{ status: 'resolved', labels: { severity: 'warning' }, annotations: { summary: 'CPU 回落' } }],
    });
    assert.match(text, /^✅ 告警恢复：HostCpuHigh/);
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
