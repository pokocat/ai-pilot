// 原生 SQL 的时间边界必须是 UTC naive。
// 跑法：只能 `npm test`（自带 .env.test + pretest db push）；裸 node --test 会连 dev 库清业务数据。
//
// 背景（2026-08-20 实测，不是假想）：Prisma 的类型化写入把 DateTime 列存成 **UTC naive**，
// 而原生 SQL 里的 JS Date 参数会被按**会话时区**渲染成本地 naive。生产库时区 Asia/Shanghai
// 下参数比列值快 480 分钟；本地 dev / 测试库 America/Los_Angeles 下慢 420 分钟。
// 后果分两类，本文件各钉一条：
//   1. 「表头总量走 Prisma 聚合、按天曲线走原生 SQL」的后台屏，两个数字来自两个窗口；
//   2. 「naive UTC 列 > now()」的到期判断（now() 是 timestamptz，会把 naive 列按会话时区解释）。
//
// 这些用例**刻意不断言 SQL 文本**，只断言行为，所以换写法（库端 now() AT TIME ZONE 'UTC'
// 或 utcTimestamp 拼字面量）都能过；而任何一侧退回裸 Date 参数 / 裸 now() 就会红。
// 断言都选「与时区偏移方向无关」的不变式：偏移往前往后都会破，所以在 +8 的生产库和
// -7 的本地库上，红的条件一致。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.ts';
import { prisma, utcTimestamp } from '../src/db.ts';
import { tokenUsageSummary } from '../src/services/usage.ts';
import { MEMORY_ALIVE_SQL } from '../src/services/vectorStore.ts';

const HOUR = 3600_000;

let tenantId = '';
let userId = '';

before(async () => {
  await getApp();
  await seedBaseline();
});
after(async () => { await closeApp(); });

beforeEach(async () => {
  await cleanBusiness();
  const phone = uniquePhone();
  await login(phone, '边界用例');
  const u = await prisma.user.findUniqueOrThrow({ where: { phone } });
  tenantId = u.tenantId;
  userId = u.id;
});

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const usage = (createdAt: Date, totalTokens: number) => ({
  tenantId, userId, kind: 'chat', provider: 'claude', model: 'm',
  inputTokens: 0, outputTokens: 0, totalTokens, costMicros: 0, createdAt,
});

/**
 * 「表头一个数 + 曲线一串数」的屏，边界两侧各摆一行再比总和。
 * 间距取 1 小时——远小于任何时区偏移（7~8 小时），所以偏移无论把窗口撑宽还是收窄，
 * 都必然多吃或少吃一行：
 *   会话时区在 UTC 之西（本地 -7）→ 窗口变宽，错纳边界外那行 → 曲线 > 表头；
 *   会话时区在 UTC 之东（生产 +8）→ 窗口变窄，错排边界内那行 → 曲线 < 表头。
 * 断言「曲线之和 = 表头」因此与偏移方向无关，两种库上红的条件一致。
 */
const boundaryRows = (since: Date) => ({
  inside: new Date(since.getTime() + HOUR),
  outside: new Date(since.getTime() - HOUR),
  middle: new Date(since.getTime() + 5 * 864e5),
});

describe('原生 SQL 时间边界与 Prisma 口径一致', () => {
  test('Token 用量看板：按天曲线之和 = 表头总量', async () => {
    const windowDays = 30;
    const at = boundaryRows(new Date(Date.now() - windowDays * 864e5));
    await prisma.tokenUsage.createMany({
      data: [usage(at.inside, 111), usage(at.outside, 222), usage(at.middle, 333)],
    });

    const view = await tokenUsageSummary(windowDays);
    const curve = view.byDay.reduce((s, d) => s + d.totalTokens, 0);

    assert.equal(
      curve, view.totals.totalTokens,
      `按天曲线(${curve}) 必须等于表头总量(${view.totals.totalTokens})——不等说明两侧窗口差了一个时区偏移`,
    );
    // 再钉死窗口本身是对的：边界外那 222 一分都不许进。
    assert.equal(view.totals.totalTokens, 111 + 333);
  });

  test('单用户用量下钻：按天曲线之和 = 表头总量', async () => {
    const days = 30;
    const at = boundaryRows(new Date(Date.now() - days * 864e5));
    await prisma.tokenUsage.createMany({
      data: [usage(at.inside, 111), usage(at.outside, 222), usage(at.middle, 333)],
    });

    const r = await api('GET', `/api/admin/users/${userId}/usage?days=${days}`);
    assert.equal(r.status, 200);
    const curve = r.body.tokens.byDay.reduce((s: number, d: { totalTokens: number }) => s + d.totalTokens, 0);

    assert.equal(curve, r.body.tokens.totalTokens, '曲线之和必须等于表头总量');
    assert.equal(r.body.tokens.totalTokens, 111 + 333);
  });

  test('营收看板：按天曲线之和 = 期内实收（真金白银，最不能漂的一处）', async () => {
    const days = 30;
    const at = boundaryRows(new Date(Date.now() - days * 864e5));
    // 营收口径只认 provider='wechat' + status paid/applied，所以三单都按这个造，
    // 差别只在 paidAt 落在窗口的哪一侧。
    const order = (outTradeNo: string, amount: number, paidAt: Date) => ({
      outTradeNo, tenantId, userId, planId: '', amount,
      provider: 'wechat', status: 'paid', paidAt,
    });
    await prisma.paymentOrder.createMany({
      data: [
        order('TZ-INSIDE-0001', 111, at.inside),
        order('TZ-OUTSIDE-0001', 222, at.outside),
        order('TZ-MIDDLE-0001', 333, at.middle),
      ],
    });

    const r = await api('GET', `/api/admin/payments?days=${days}`);
    assert.equal(r.status, 200);
    const curve = r.body.summary.byDay.reduce((s: number, d: { amount: number }) => s + d.amount, 0);

    assert.equal(
      curve, r.body.summary.paidAmount,
      `按天营收曲线(${curve}) 必须等于期内实收(${r.body.summary.paidAmount})`,
    );
    assert.equal(r.body.summary.paidAmount, 111 + 333);
  });

  test('邀请风控：原生 SQL 的分母与 Prisma where 的名单看同一个窗口', async () => {
    const days = 30;
    const at = boundaryRows(new Date(Date.now() - days * 864e5));
    // riskWindow 同时给出 SQL 片段（分母 scannedAttributions）与 Prisma where（成员名单）。
    // 两者共用一个 since，所以任何时区偏移都会让分母和名单看不同的窗口。
    const attr = (createdAt: Date) => ({
      tenantId, inviteCode: 'TZCODE', source: 'qr', outcome: 'bound',
      newUserId: userId, referrerId: null, clientIp: '203.0.113.7', createdAt,
    });
    await prisma.referralAttribution.createMany({
      data: [attr(at.inside), attr(at.outside), attr(at.middle)],
    });

    const r = await api('GET', `/api/admin/referral/risk?days=${days}`);
    assert.equal(r.status, 200);
    // 窗口内只有 2 条（inside + middle）；边界外那条不许算进分母。
    assert.equal(r.body.scannedAttributions, 2, '分母必须只数窗口内的留痕');
    assert.equal(r.body.scannedIps, 1);
  });

  test('utcTimestamp 绑定的边界与 Prisma 类型化写入同为 UTC naive', async () => {
    const mark = new Date('2026-08-20T00:00:00.000Z');
    await prisma.tokenUsage.create({ data: usage(mark, 42) });

    // 与写入时刻相等 → `>=` 必须收到；晚 1 毫秒 → 必须收不到。
    // 这一对断言把「参数与列同刻度」钉死：任何时区偏移都会让两条同时错。
    const at = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM token_usage
      WHERE "userId" = ${userId} AND "createdAt" >= ${utcTimestamp(mark)}`;
    const after1ms = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*) AS n FROM token_usage
      WHERE "userId" = ${userId} AND "createdAt" >= ${utcTimestamp(new Date(mark.getTime() + 1))}`;

    assert.equal(Number(at[0].n), 1, '边界相等时应命中');
    assert.equal(Number(after1ms[0].n), 0, '边界晚 1ms 时不应命中');
  });

  test('naive UTC 列的到期判断不受会话时区影响', async () => {
    // memory.expiresAt 是 timestamp(3) naive，存 UTC naive。裸 now() 是 timestamptz，
    // 比较时会把列按会话时区解释——已过期的会被判成还活着（本地 -7），
    // 或还没过期的被判成已过期（生产 +8）。vectorStore 的记忆检索就栽在这里。
    //
    // 被测的谓词直接从 vectorStore 引进来（不在这里抄一份）：本地没有 pgvector，
    // vectorSearchMemories 整条查询跑不起来，但谓词是同一个字符串，
    // 它退回裸 now() 这条就会红。
    const now = Date.now();
    await prisma.memory.createMany({
      data: [
        { tenantId, userId, text: '还有两小时到期', kind: 'fact', source: 'test', agentKey: 'general', weight: 1, expiresAt: new Date(now + 2 * HOUR) },
        { tenantId, userId, text: '两小时前已到期', kind: 'fact', source: 'test', agentKey: 'general', weight: 1, expiresAt: new Date(now - 2 * HOUR) },
        { tenantId, userId, text: '永不到期', kind: 'fact', source: 'test', agentKey: 'general', weight: 1, expiresAt: null },
      ],
    });

    const alive = await prisma.$queryRawUnsafe<{ text: string }[]>(
      `SELECT text FROM memory WHERE "userId" = $1 AND ${MEMORY_ALIVE_SQL} ORDER BY text`,
      userId,
    );
    const texts = alive.map((r) => r.text).sort();

    assert.deepEqual(texts, ['还有两小时到期', '永不到期'].sort());
  });
});
