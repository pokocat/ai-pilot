// LLM 健康兜底扫描（2026-08-20）。
//
// 08-19 那天 llm_trace 里躺着 23,303 条 error，16 小时无人知晓。已有的接管熔断与洪水闸都是**定向**
// 告警，只在各自那个已知故障形态下响；这个 sweep 是兜底，不问错因只看错量。
// 用例锁四件事：面/点两条规则各自的触发与不触发边界、节流、以及「一键关停 + 扫描失败不外溢」。
//   cd server && node --import tsx --test test/llmHealthSweep.test.ts
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { setFeishuTarget, __setFeishuTransportForTest } from '../src/services/alertConfig.js';
import { __clearFeatureCache } from '../src/services/featureFlag.js';
import { runLlmHealthSweep, __resetLlmHealthThrottle } from '../src/services/llmHealth.js';

const HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/abcdef-123456';

/** 收下所有外发告警文本，供断言「响了没有、说了什么」。 */
function captureAlerts(): string[] {
  const sent: string[] = [];
  __setFeishuTransportForTest(async (_url, body) => {
    const content = (body as { content?: { text?: string } }).content;
    sent.push(content?.text ?? '');
    return { ok: true, status: 200, text: '{"code":0}' };
  });
  return sent;
}

/** 告警是 fire-and-forget（绝不拖垮扫描），轮询等它发出去。 */
async function settle(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function trace(opts: { status: string; userId?: string; sessionId?: string; kind?: string; minutesAgo?: number }) {
  await prisma.llmTrace.create({
    data: {
      kind: opts.kind ?? 'chat', provider: 'openai', model: 'm', status: opts.status,
      userId: opts.userId ?? null, sessionId: opts.sessionId ?? null,
      createdAt: new Date(Date.now() - (opts.minutesAgo ?? 1) * 60_000),
    },
  });
}

const ENV_KEYS = ['LLM_HEALTH_SWEEP', 'LLM_ERROR_ALERT_PER_5MIN', 'LLM_USER_ERROR_ALERT_PER_HOUR'];
const savedEnv: Record<string, string | undefined> = {};

describe('LLM 健康兜底扫描', () => {
  beforeEach(async () => {
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
    await prisma.llmTrace.deleteMany({});
    __resetLlmHealthThrottle();
    __clearFeatureCache();
    await setFeishuTarget(HOOK, '');
    __clearFeatureCache();
  });
  afterEach(async () => {
    for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    __setFeishuTransportForTest(null);
    await prisma.llmTrace.deleteMany({});
    await prisma.featureFlag.deleteMany({ where: { id: { startsWith: 'monitor.' } } });
    __clearFeatureCache();
    __resetLlmHealthThrottle();
  });

  test('规则①：近 5 分钟报错超阈值 → 告警，文案带排查指引与调参 env 名', async () => {
    process.env.LLM_ERROR_ALERT_PER_5MIN = '3';
    for (let i = 0; i < 4; i++) await trace({ status: 'error', minutesAgo: 1 });
    const sent = captureAlerts();

    const r = await runLlmHealthSweep();
    assert.equal(r.errorCount5m, 4);
    assert.equal(r.alerts, 1);
    await settle();
    assert.equal(sent.length, 1, '超阈值必须推飞书——16 小时无人知晓正是因为没有这一步');
    assert.match(sent[0], /llm_trace/, '要说清查哪张表');
    assert.match(sent[0], /LLM_ERROR_ALERT_PER_5MIN/, '要说清怎么调阈值');
    assert.match(sent[0], /LLM_HEALTH_SWEEP/, '要说清怎么一键关');
  });

  test('规则①：5 分钟窗口之外的报错不算（不能拿一整天的量去撞 5 分钟的阈值）', async () => {
    process.env.LLM_ERROR_ALERT_PER_5MIN = '3';
    for (let i = 0; i < 50; i++) await trace({ status: 'error', minutesAgo: 30 });
    const sent = captureAlerts();

    const r = await runLlmHealthSweep();
    assert.equal(r.errorCount5m, 0, '半小时前的报错不属于近 5 分钟');
    await settle();
    assert.equal(sent.length, 0);
  });

  test('规则②：单用户近 1 小时错 ≥N 次且零成功 → 告警带 userId/sessionId，且不带手机号', async () => {
    process.env.LLM_ERROR_ALERT_PER_5MIN = '0'; // 关掉规则①，隔离验证规则②
    process.env.LLM_USER_ERROR_ALERT_PER_HOUR = '3';
    for (let i = 0; i < 3; i++) await trace({ status: 'error', userId: 'u_stuck', sessionId: 's_stuck', minutesAgo: 10 });
    const sent = captureAlerts();

    const r = await runLlmHealthSweep();
    assert.equal(r.alerts, 1);
    assert.equal(r.stuckUsers.length, 1);
    assert.equal(r.stuckUsers[0].userId, 'u_stuck');
    assert.equal(r.stuckUsers[0].sessionId, 's_stuck', '要能直接落到具体会话');
    await settle();
    assert.equal(sent.length, 1);
    assert.match(sent[0], /u_stuck/);
    assert.match(sent[0], /s_stuck/);
    assert.doesNotMatch(sent[0], /1[3-9]\d{9}/, '告警群可见范围比后台宽，绝不带手机号');
  });

  test('规则②：只要有一次成功就不算被卡死（否则会把「偶发失败」误报成不可用）', async () => {
    process.env.LLM_ERROR_ALERT_PER_5MIN = '0';
    process.env.LLM_USER_ERROR_ALERT_PER_HOUR = '3';
    for (let i = 0; i < 5; i++) await trace({ status: 'error', userId: 'u_mixed', minutesAgo: 10 });
    await trace({ status: 'ok', userId: 'u_mixed', minutesAgo: 5 });
    const sent = captureAlerts();

    const r = await runLlmHealthSweep();
    assert.equal(r.stuckUsers.length, 0);
    await settle();
    assert.equal(sent.length, 0);
  });

  test('节流：同类告警 10 分钟内只发一条（冒烟期间每 5 分钟都命中，刷爆群等于没有告警）', async () => {
    process.env.LLM_ERROR_ALERT_PER_5MIN = '3';
    for (let i = 0; i < 4; i++) await trace({ status: 'error', minutesAgo: 1 });
    const sent = captureAlerts();

    await runLlmHealthSweep();
    await runLlmHealthSweep();
    await runLlmHealthSweep();
    await settle();
    assert.equal(sent.length, 1, '三轮扫描只应外发一条');
  });

  test('阈值设 0 关掉单条规则；LLM_HEALTH_SWEEP=false 整体关停', async () => {
    for (let i = 0; i < 100; i++) await trace({ status: 'error', userId: 'u_x', minutesAgo: 1 });
    const sent = captureAlerts();

    process.env.LLM_ERROR_ALERT_PER_5MIN = '0';
    process.env.LLM_USER_ERROR_ALERT_PER_HOUR = '0';
    const off = await runLlmHealthSweep();
    assert.equal(off.alerts, 0, '两条规则都设 0 → 一条都不发');

    __resetLlmHealthThrottle();
    delete process.env.LLM_ERROR_ALERT_PER_5MIN;
    process.env.LLM_HEALTH_SWEEP = 'false';
    const disabled = await runLlmHealthSweep();
    assert.equal(disabled.skipped, 'disabled');
    assert.equal(disabled.errorCount5m, 0, '关停后连查都不查');

    await settle();
    assert.equal(sent.length, 0);
  });

  test('告警发不出去不抛（告警链路绝不能把 job 拖下水）', async () => {
    process.env.LLM_ERROR_ALERT_PER_5MIN = '3';
    for (let i = 0; i < 4; i++) await trace({ status: 'error', minutesAgo: 1 });
    __setFeishuTransportForTest(async () => { throw new Error('飞书挂了'); });

    // 不抛即通过：sweep 正常返回统计，异常只落 console.error。
    const r = await runLlmHealthSweep();
    assert.equal(r.errorCount5m, 4);
    await settle();
  });
});
