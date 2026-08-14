// 存储额度与钻石扩容。
//
// 产品口径（2026-08-14）：默认 200MB，**素材与作品共用这一份**，不够用拿钻石扩容。
// 这组用例钉两件事：花钱换来的空间必须真的到账，以及重复提交不会重复扣钱。
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_PRICING_FLAG_ID, buyStoragePack, purchasedPackCount, purchasedStorageBytes,
  storagePlan, updateStoragePlan,
} from '../src/services/video/storagePlan.js';
import { getBalance } from '../src/services/credits.js';
import { prisma } from '../src/db.js';
import { __clearFeatureCache } from '../src/services/featureFlag.js';
import { cleanBusiness, closeApp, seedBaseline, uniquePhone } from './helpers.js';

const MB = 1024 * 1024;

beforeEach(async () => {
  await cleanBusiness();
  await seedBaseline();
  __clearFeatureCache();
});

after(async () => { await closeApp(); });

async function userWithBalance(balance: number) {
  const tenant = await prisma.tenant.create({ data: { name: '扩容测试企业' } });
  const plan = await prisma.plan.findFirstOrThrow({ orderBy: { sort: 'asc' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: uniquePhone(), name: '扩容用户', role: 'owner', planId: plan.id },
  });
  await prisma.creditLedger.create({
    data: { tenantId: tenant.id, userId: user.id, delta: balance, reason: '测试初始余额', balance },
  });
  return { tenantId: tenant.id, userId: user.id };
}

test('没配过时用兜底档，且明确标出 configured=false', async () => {
  const plan = await storagePlan({ fresh: true });
  assert.equal(plan.configured, false, '没配过就不能声称是运营核定过的价');
  assert.ok(plan.packBytes > 0 && plan.packCredits >= 0 && plan.maxPacks > 0);
});

test('运营可以把扩容配成免费（0 钻石），但非法值一律抛错不静默夹回', async () => {
  // 0 是合法配置：内测期把扩容设成免费就是这么做的，和克隆定价同一口径。
  const free = await updateStoragePlan({ packBytes: 100 * MB, packCredits: 0, maxPacks: 5 });
  assert.equal(free.packCredits, 0);
  assert.equal(free.configured, true);

  // 改价是营收动作：填错了必须看得见地失败，而不是「保存成功但没改上」。
  await assert.rejects(() => updateStoragePlan({ packCredits: -1 }), (e: { code?: string }) => e.code === 'STORAGE_PLAN_INVALID');
  await assert.rejects(() => updateStoragePlan({ packBytes: 1 }), (e: { code?: string }) => e.code === 'STORAGE_PLAN_INVALID');
  assert.equal((await storagePlan({ fresh: true })).packCredits, 0, '失败的那次不许改动已有配置');
});

test('买一个包：钻石真扣，空间真到账', async () => {
  const { tenantId, userId } = await userWithBalance(1000);
  await updateStoragePlan({ packBytes: 100 * MB, packCredits: 50, maxPacks: 5 });
  __clearFeatureCache();

  const result = await buyStoragePack({ tenantId, userId, clientRequestId: 'pack-req-0001' });

  assert.equal(result.reused, false);
  assert.equal(result.pack.bytes, 100 * MB);
  assert.equal(await getBalance(userId), 950, '扣的钱必须落到余额上');
  assert.equal(await purchasedStorageBytes(userId), 100 * MB, '买到的空间必须能被额度计算读到');
  assert.equal(await purchasedPackCount(userId), 1);
});

test('同一请求标识重复提交不重复扣钱（连点两下 / 网络重试）', async () => {
  const { tenantId, userId } = await userWithBalance(1000);
  await updateStoragePlan({ packBytes: 100 * MB, packCredits: 50, maxPacks: 5 });
  __clearFeatureCache();

  await buyStoragePack({ tenantId, userId, clientRequestId: 'pack-req-0002' });
  const retry = await buyStoragePack({ tenantId, userId, clientRequestId: 'pack-req-0002' });

  assert.equal(retry.reused, true);
  assert.equal(await getBalance(userId), 950);
  assert.equal(await purchasedPackCount(userId), 1, '重试不能变成买了两个包');
});

test('余额不够时买不成，且不会留下一条没付钱的扩容记录', async () => {
  const { tenantId, userId } = await userWithBalance(10);
  await updateStoragePlan({ packBytes: 100 * MB, packCredits: 50, maxPacks: 5 });
  __clearFeatureCache();

  await assert.rejects(
    () => buyStoragePack({ tenantId, userId, clientRequestId: 'pack-req-0003' }),
    (e: { code?: string }) => e.code === 'INSUFFICIENT_CREDITS',
  );
  assert.equal(await purchasedStorageBytes(userId), 0, '扣费失败必须整体回滚，不能白送空间');
  assert.equal(await getBalance(userId), 10);
});

test('买够上限就不许再买：存储成本要有上界', async () => {
  const { tenantId, userId } = await userWithBalance(1000);
  await updateStoragePlan({ packBytes: 10 * MB, packCredits: 10, maxPacks: 2 });
  __clearFeatureCache();

  await buyStoragePack({ tenantId, userId, clientRequestId: 'pack-req-0004' });
  await buyStoragePack({ tenantId, userId, clientRequestId: 'pack-req-0005' });
  await assert.rejects(
    () => buyStoragePack({ tenantId, userId, clientRequestId: 'pack-req-0006' }),
    (e: { code?: string }) => e.code === 'STORAGE_PACK_LIMIT',
  );
  assert.equal(await purchasedPackCount(userId), 2);
});

test('已成交的订单是快照：运营改档位不追溯改写用户已经买到的空间', async () => {
  const { tenantId, userId } = await userWithBalance(1000);
  await updateStoragePlan({ packBytes: 100 * MB, packCredits: 50, maxPacks: 5 });
  __clearFeatureCache();
  await buyStoragePack({ tenantId, userId, clientRequestId: 'pack-req-0007' });

  // 运营把档位改小
  await updateStoragePlan({ packBytes: 10 * MB, packCredits: 5 });
  __clearFeatureCache();

  assert.equal(await purchasedStorageBytes(userId), 100 * MB,
    '改档位不能把用户已经付过钱的空间缩水');
  const row = await prisma.videoStoragePack.findFirstOrThrow({ where: { userId } });
  assert.equal(row.credits, 50, '成交价同样是快照，留给退款争议与对账');
  assert.equal(STORAGE_PRICING_FLAG_ID, 'video-storage-pricing');
});
