// 克隆类动作的钻石预扣 / 退回。
//
// 这组用例存在的理由：此前端上明码标价「这次要扣 200 钻石」，服务端却一分不扣 ——
// 界面承诺了系统不兑现的东西。下面每一条都在钉「显示的价 = 实际扣的账」，
// 以及「扣了钱没拿到东西必须退」。
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCloneSettlements, cloneChargeItems, cloneChargeTotal, refundCloneHold,
  reserveCloneCredits, resolveCloneSettlements, attachCloneTargets,
} from '../src/services/video/cloneCredits.js';
import type { ClonePricing } from '../src/services/video/pricing.js';
import { getBalance } from '../src/services/credits.js';
import { prisma } from '../src/db.js';
import { cleanBusiness, closeApp, seedBaseline, uniquePhone } from './helpers.js';

const PRICING: ClonePricing = {
  voiceCreate: 200, voiceRetrain: 60, avatarVideo: 200, avatarImage: 100, configured: true,
};

/* ── 1. 收哪几档：服务端自己判，且必须与端上明细同口径 ────────────────────── */

test('单独训声音：带了 voiceId 走重训档，没带走新建档', () => {
  assert.deepEqual(cloneChargeItems({ kind: 'voice', voiceId: 'VC-1' }, PRICING),
    [{ action: 'voiceRetrain', targetKind: 'voice', credits: 60 }]);
  assert.deepEqual(cloneChargeItems({ kind: 'voice' }, PRICING),
    [{ action: 'voiceCreate', targetKind: 'voice', credits: 200 }]);
});

test('建数字人复用已有声音只收形象一档；选「视频原声」要多收一条新训声音', () => {
  const reuse = cloneChargeItems({ kind: 'avatar', voiceId: 'VC-1', voiceSource: 'existing' }, PRICING);
  assert.deepEqual(reuse.map((i) => i.action), ['avatarVideo']);
  assert.equal(cloneChargeTotal(reuse), 200);

  const fresh = cloneChargeItems({ kind: 'avatar', voiceSource: 'video' }, PRICING);
  assert.deepEqual(fresh.map((i) => i.action), ['avatarVideo', 'voiceCreate']);
  assert.equal(cloneChargeTotal(fresh), 400, '视频原声不是免费顺带产物，它同样要新训一条');
});

test('voiceSource=video 压过 voiceId：用户明确选了视频原声就按新训收，不按复用', () => {
  // 端上「主动选视频原声」时仍可能带着上一次的 voiceId。若按 voiceId 判成复用，
  // 用户会看着「新训练 · 200 钻石」的明细却被按 0 收 —— 也是一种价实不符。
  const items = cloneChargeItems({ kind: 'avatar', voiceId: 'VC-1', voiceSource: 'video' }, PRICING);
  assert.deepEqual(items.map((i) => i.action), ['avatarVideo', 'voiceCreate']);
});

test('内测免费靠把单价配成 0 实现，不靠代码分支：档位照排、金额为 0', () => {
  const free: ClonePricing = { ...PRICING, voiceCreate: 0, avatarVideo: 0 };
  const items = cloneChargeItems({ kind: 'avatar', voiceSource: 'video' }, free);
  assert.equal(items.length, 2, '免费不等于不计费：档位仍然要在，只是金额是 0');
  assert.equal(cloneChargeTotal(items), 0);
});

/* ── 2. 结算：什么时候算成功、什么时候必须退 ─────────────────────────────── */

const hold = (id: string, targetId: string | null, createdAt: Date, targetKind = 'voice') =>
  ({ id, targetKind, targetId, createdAt } as Parameters<typeof resolveCloneSettlements>[0][number]);

test('训练成功才结算，失败必须退，还在训就不动', () => {
  const t0 = new Date('2026-08-13T00:00:00Z');
  const rows = [hold('h-ok', 'VC-1', t0), hold('h-bad', 'VC-2', t0), hold('h-wait', 'VC-3', t0)];
  const status: Record<string, string> = { 'VC-1': 'ready', 'VC-2': 'failed', 'VC-3': 'training' };
  assert.deepEqual(resolveCloneSettlements(rows, (_kind, id) => status[id] ?? null), [
    { holdId: 'h-ok', outcome: 'settled' },
    { holdId: 'h-bad', outcome: 'refunded' },
  ]);
});

test('还没拿到上游 id 的预扣不参与结算（交给超时清扫器，别凭空判它成功）', () => {
  const rows = [hold('h-none', null, new Date('2026-08-13T00:00:00Z'))];
  assert.deepEqual(resolveCloneSettlements(rows, () => 'ready'), []);
});

test('同一条声音上压着两笔在途预扣时，只有最新那笔认领上游状态', () => {
  // 重训复用同一个 voiceId，所以一条声音上可能压着多笔 hold。
  // 旧的那笔判 superseded 并**结算**而不是退回：一次被后续重训覆盖掉的旧训练，
  // 并不能证明它当初失败了；凭「现在这条是 failed」去退旧账等于凭空送钱。
  const rows = [
    hold('h-old', 'VC-1', new Date('2026-08-13T00:00:00Z')),
    hold('h-new', 'VC-1', new Date('2026-08-13T01:00:00Z')),
  ];
  assert.deepEqual(resolveCloneSettlements(rows, () => 'failed'), [
    { holdId: 'h-old', outcome: 'superseded' },
    { holdId: 'h-new', outcome: 'refunded' },
  ]);
});

test('形象与声音各认各的状态，不会互相串台', () => {
  const t0 = new Date('2026-08-13T00:00:00Z');
  const rows = [hold('h-a', 'X-1', t0, 'avatar'), hold('h-v', 'X-1', t0, 'voice')];
  const settlements = resolveCloneSettlements(rows, (kind) => (kind === 'avatar' ? 'ready' : 'failed'));
  assert.deepEqual(settlements, [
    { holdId: 'h-a', outcome: 'settled' },
    { holdId: 'h-v', outcome: 'refunded' },
  ]);
});

/* ── 3. 真扣真退（打库）────────────────────────────────────────────────── */

async function userWithBalance(balance: number) {
  const tenant = await prisma.tenant.create({ data: { name: '克隆计费测试企业' } });
  // 无套餐用户全局禁写；本组测的是扣费本身，用户必须先走得到扣减逻辑。
  const plan = await prisma.plan.findFirstOrThrow({ orderBy: { sort: 'asc' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: '克隆计费用户', role: 'owner', planId: plan.id },
  });
  await prisma.creditLedger.create({
    data: { tenantId: tenant.id, userId: user.id, delta: balance, reason: '测试初始余额', balance },
  });
  return { tenantId: tenant.id, userId: user.id };
}

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
});

// 本文件直接打库、不起 app，但仍然握着 prisma 连接；不断开的话这个子进程会拖着连接不退，
// 后面的测试文件容易在共享测试库上撞见半开的连接。closeApp 对「没起过 app」是安全的。
after(async () => { await closeApp(); });

test('提交训练即扣钱，同一请求标识重试不重复扣', async () => {
  const { tenantId, userId } = await userWithBalance(1000);
  const items = cloneChargeItems({ kind: 'avatar', voiceSource: 'video' }, PRICING);

  const first = await reserveCloneCredits({ tenantId, userId, clientRequestId: 'req-aaaaaaaa', items });
  assert.equal(first.holds.length, 2);
  assert.equal(first.reused, false);
  assert.equal(await getBalance(userId), 600, '400 必须真的从余额里扣走，而不是只显示');

  const retry = await reserveCloneCredits({ tenantId, userId, clientRequestId: 'req-aaaaaaaa', items });
  assert.equal(retry.reused, true);
  assert.equal(await getBalance(userId), 600, '上传超时重试不能扣第二次');
});

test('余额不够时在调用上游之前就挡住 —— 不能让钱不够的人把算力跑完', async () => {
  const { tenantId, userId } = await userWithBalance(100);
  const items = cloneChargeItems({ kind: 'voice' }, PRICING);
  await assert.rejects(
    () => reserveCloneCredits({ tenantId, userId, clientRequestId: 'req-bbbbbbbb', items }),
    (error: { code?: string }) => error.code === 'INSUFFICIENT_CREDITS',
  );
  assert.equal(await getBalance(userId), 100, '挡住之后余额分文不动');
});

test('训练失败全额退回，且只退一次', async () => {
  const { tenantId, userId } = await userWithBalance(1000);
  const items = cloneChargeItems({ kind: 'voice' }, PRICING);
  const { holds } = await reserveCloneCredits({ tenantId, userId, clientRequestId: 'req-cccccccc', items });
  assert.equal(await getBalance(userId), 800);

  await refundCloneHold(holds[0].id, 'failed');
  assert.equal(await getBalance(userId), 1000);
  await refundCloneHold(holds[0].id, 'failed');
  assert.equal(await getBalance(userId), 1000, '重复退款必须幂等，否则退一次送一次');
});

test('已结算的不许再退：训练成功过就是成功过', async () => {
  const { tenantId, userId } = await userWithBalance(1000);
  const items = cloneChargeItems({ kind: 'voice' }, PRICING);
  const { holds } = await reserveCloneCredits({ tenantId, userId, clientRequestId: 'req-dddddddd', items });
  const attached = await attachCloneTargets(holds, { voiceId: 'VC-ok' });
  await applyCloneSettlements([{ holdId: attached[0].id, outcome: 'settled' }]);

  await refundCloneHold(attached[0].id, 'failed');
  assert.equal(await getBalance(userId), 800, '结算之后再收到退款请求也不能把钱吐回去');
});

test('选了「视频原声」但上游没提取出声音时，声音那一档当场退回', async () => {
  const { tenantId, userId } = await userWithBalance(1000);
  const items = cloneChargeItems({ kind: 'avatar', voiceSource: 'video' }, PRICING);
  const { holds } = await reserveCloneCredits({ tenantId, userId, clientRequestId: 'req-eeeeeeee', items });
  assert.equal(await getBalance(userId), 600);

  // 上游只回了 avatarId：声音是 best-effort 增强，这次没产出。没产出就不能收这份钱。
  const attached = await attachCloneTargets(holds, { avatarId: 'DH-1' });
  assert.equal(await getBalance(userId), 800, '没生成的声音必须立刻退，不能等超时');
  assert.equal(attached.find((h) => h.targetKind === 'voice')?.status, 'refunded');
  assert.equal(attached.find((h) => h.targetKind === 'avatar')?.status, 'submitted');
});

test('免费档（单价 0）照样建 hold 留审计，但不产生钻石流水', async () => {
  const { tenantId, userId } = await userWithBalance(1000);
  const free: ClonePricing = { ...PRICING, voiceCreate: 0 };
  const items = cloneChargeItems({ kind: 'voice' }, free);
  const { holds } = await reserveCloneCredits({ tenantId, userId, clientRequestId: 'req-ffffffff', items });

  assert.equal(holds.length, 1);
  assert.equal(holds[0].credits, 0);
  assert.equal(await getBalance(userId), 1000);
  assert.equal(
    await prisma.creditLedger.count({ where: { userId, reason: { contains: '快出片' } } }), 0,
    '0 元动作不该在用户账单里留一条「扣 0 钻石」的噪音',
  );
});
