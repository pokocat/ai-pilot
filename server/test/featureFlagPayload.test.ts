// FeatureFlag payload 的两种写法必须各守其语义（2026-08-18 补）：
//  · mergeFeatureFlagPayload：只覆盖传进来的顶层键 —— 运营后台「功能开关」页的 number / arms 分支用它。
//    以前这两处走整块覆盖写，运营改一个数值就把同一 flag payload 上其他运营配置（referral 的
//    rewardInviter/dailyCap/ladder 等预留栏位）静默抹掉；奖励键当时全是 null，所以看不出来。
//  · setFeatureFlagPayload：整块覆盖 —— artifactPricing.updateArtifactPrices 靠「不写某键 = 删掉它」
//    表达回退默认（delete entry[variant]），把它改成合并会让运营再也删不掉一个已配的价。
// 两条语义都在本文件钉住：任何一边被「顺手统一」掉，这里就红。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api } from './helpers.ts';
import { prisma } from '../src/db.ts';
import {
  featureFlagPayload, setFeatureFlagPayload, mergeFeatureFlagPayload, __clearFeatureCache,
} from '../src/services/featureFlag.ts';
import { WENCE_FLAG } from '../src/services/wence.ts';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const FLAG = 'referral';            // 奖励配置那张 payload：预留栏位最多，最怕被抹
const NUMBER_FLAG = 'review-grace'; // catalog 里的 number 类开关（payloadKey='perDay'）

/** 直读库里的 payload（绕开 60s 缓存，断言落库形态而不是内存值）。 */
async function rawPayload(id: string): Promise<Record<string, unknown> | null> {
  const row = await prisma.featureFlag.findUnique({ where: { id }, select: { payload: true } });
  return (row?.payload ?? null) as Record<string, unknown> | null;
}

describe('FeatureFlag payload 写入语义', () => {
  before(async () => {
    await getApp();
    await cleanBusiness();
    await seedBaseline();
  });
  after(async () => { await closeApp(); });

  beforeEach(async () => {
    await prisma.featureFlag.deleteMany({ where: { id: { in: [FLAG, NUMBER_FLAG, WENCE_FLAG] } } });
    __clearFeatureCache();
  });

  describe('mergeFeatureFlagPayload', () => {
    test('只覆盖传进来的键，同 payload 上其余键原样保留', async () => {
      await setFeatureFlagPayload(FLAG, {
        window: 30,
        rewardInviter: 5,
        rewardInvitee: 3,
        rewardOnPaid: 20,
        dailyCap: 10,
        ladder: [{ min: 1, reward: 5 }],
      });
      await mergeFeatureFlagPayload(FLAG, { window: 14 });

      const p = await rawPayload(FLAG);
      assert.equal(p?.window, 14, '目标键写进去了');
      assert.equal(p?.rewardInviter, 5);
      assert.equal(p?.rewardInvitee, 3);
      assert.equal(p?.rewardOnPaid, 20);
      assert.equal(p?.dailyCap, 10);
      assert.deepEqual(p?.ladder, [{ min: 1, reward: 5 }], '嵌套结构整块保留');
    });

    test('清 payload 缓存：写完立刻读到新值（不用等 60s）', async () => {
      await setFeatureFlagPayload(FLAG, { window: 30, ladder: [1] });
      assert.deepEqual(await featureFlagPayload(FLAG), { window: 30, ladder: [1] }); // 这一读把旧值写进缓存
      await mergeFeatureFlagPayload(FLAG, { window: 7 });
      assert.deepEqual(await featureFlagPayload(FLAG), { window: 7, ladder: [1] });
    });

    test('行不存在 → 新建（enabled 取库默认 true，与 setFeatureFlagPayload 同）', async () => {
      await mergeFeatureFlagPayload(FLAG, { window: 21 });
      const row = await prisma.featureFlag.findUnique({ where: { id: FLAG } });
      assert.deepEqual(row?.payload, { window: 21 });
      assert.equal(row?.enabled, true);
      assert.ok(row && Date.now() - row.updatedAt.getTime() < 60_000, 'updatedAt 按 UTC 落库，不能偏出一个时区');
    });

    test('旧值不是 JSON 对象（历史脏数据）→ 按空对象起算，不抛也不拼成数组', async () => {
      await setFeatureFlagPayload(FLAG, [1, 2, 3]);
      await mergeFeatureFlagPayload(FLAG, { window: 9 });
      assert.deepEqual(await rawPayload(FLAG), { window: 9 });

      await setFeatureFlagPayload(FLAG, 5);
      await mergeFeatureFlagPayload(FLAG, { window: 8 });
      assert.deepEqual(await rawPayload(FLAG), { window: 8 });
    });

    test('并发写不同键：两边都留住（单条 jsonb || 而非先读后写）', async () => {
      await setFeatureFlagPayload(FLAG, { ladder: [{ min: 1, reward: 5 }] });
      await Promise.all([
        mergeFeatureFlagPayload(FLAG, { window: 14 }),
        mergeFeatureFlagPayload(FLAG, { dailyCap: 10 }),
      ]);
      const p = await rawPayload(FLAG);
      assert.equal(p?.window, 14);
      assert.equal(p?.dailyCap, 10);
      assert.deepEqual(p?.ladder, [{ min: 1, reward: 5 }]);
    });
  });

  describe('setFeatureFlagPayload 仍是整块覆盖（artifactPricing 的「删键=回退默认」依赖它）', () => {
    test('未出现的键被删掉', async () => {
      await setFeatureFlagPayload(FLAG, { window: 30, ladder: [1] });
      await setFeatureFlagPayload(FLAG, { window: 30 });
      assert.deepEqual(await rawPayload(FLAG), { window: 30 }, 'ladder 应被整块覆盖掉');
    });
  });

  describe('PATCH /admin/flags/:id 不再抹掉同 payload 的其他键', () => {
    test('number 分支：改数值，运营在同一 payload 上配的其他键留着', async () => {
      await setFeatureFlagPayload(NUMBER_FLAG, { perDay: 6, ladder: [{ min: 1, reward: 5 }], dailyCap: 10 });
      __clearFeatureCache();

      const res = await api('PATCH', `/api/admin/flags/${NUMBER_FLAG}`, { body: { value: 3 } });
      assert.equal(res.status, 200);
      assert.equal(res.body.value, 3, '回包按新值');

      const p = await rawPayload(NUMBER_FLAG);
      assert.equal(p?.perDay, 3);
      assert.deepEqual(p?.ladder, [{ min: 1, reward: 5 }]);
      assert.equal(p?.dailyCap, 10);
    });

    test('arms 分支：改权重，同 payload 其他键留着；arms 自身整块换（少传的臂要能删掉）', async () => {
      await setFeatureFlagPayload(WENCE_FLAG, { arms: { control: 1, dock: 1, chat: 1 }, note: 'keep-me' });
      __clearFeatureCache();

      const res = await api('PATCH', `/api/admin/flags/${WENCE_FLAG}`, { body: { arms: { control: 50, dock: 50 } } });
      assert.equal(res.status, 200);

      const p = await rawPayload(WENCE_FLAG);
      assert.deepEqual(p?.arms, { control: 50, dock: 50 }, 'arms 是整块提交的，chat 应被移除');
      assert.equal(p?.note, 'keep-me', 'arms 之外的键不受影响');
    });
  });
});
