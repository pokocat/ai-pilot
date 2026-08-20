// 生成任务的两道护栏：接管抖动熔断 / 接管退避 / 单用户在途上限。
// 跑法：只能 `npm test`（自带 .env.test + pretest db push）；裸 node --test 会连 dev 库清业务数据。
//
// 这些护栏为什么存在——2026-08-19 生产事故（有据可查，不是假想）：
//   单个 chat job 的 leaseVersion 冲到 644,208，16 小时里被重新领取 64 万次（11 次/秒），
//   产生 23,239 条 attempt（23,238 条 terminationReason='process_recovered'，只有 1 条成功），
//   把 28k token 的提示词往上游推了 1.7 万次，独占并发闸 12 小时，期间该用户一条回复都没拿到。
//   它不会自愈——最后是一次无关的部署重启才把它掐断的。
//   当时 CHAT_JOB_MAX_RUNTIME_MS 只管单次 processJob 五分钟封顶，对「一个 job 被接管多少次」
//   完全没有上限。同期正常 job 的 leaseVersion 是 2。
//
// 所以这个文件的每条用例都对应一个「当时缺失、缺了就会重演」的约束。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { enqueueDurableGeneration } from '../src/services/generationRequest.ts';
import { claimNextGenerationJob, GenerationInflightLimitError } from '../src/services/generationJobs.ts';

interface TestUser { user: { id: string; tenantId: string } }

async function makeUser(name: string): Promise<TestUser> {
  const phone = uniquePhone();
  await login(phone, name);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  return { user };
}

let seq = 0;
async function enqueue(who: TestUser, text = '护栏用例') {
  return enqueueDurableGeneration(who.user, {
    text, agentKey: 'general', clientRequestId: `guard-${Date.now()}-${seq++}`,
  });
}

/** 把 job 摆成「running 且租约已过期」——这正是 claim 会去接管的形态。 */
async function makeStaleRunning(jobId: string, leaseVersion: number): Promise<void> {
  await prisma.generationJob.update({
    where: { id: jobId },
    data: {
      status: 'running',
      leaseOwner: 'dead-worker',
      leaseVersion,
      leaseExpiresAt: new Date(Date.now() - 60_000),
      startedAt: new Date(Date.now() - 120_000),
    },
  });
}

async function drainQueue(): Promise<void> {
  await prisma.generationJob.updateMany({
    where: { status: { in: ['queued', 'running'] } },
    data: { status: 'cancelled', completedAt: new Date() },
  });
  await prisma.session.updateMany({ where: { NOT: { activeGenerationId: null } }, data: { activeGenerationId: null } });
}

describe('生成任务护栏：接管抖动熔断与在途上限', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  beforeEach(drainQueue);
  after(async () => { await closeApp(); });

  // 本文件最重要的一条：没有它，644,208 那种数字就会重演。
  test('接管次数超上限 → 熔断判失败，而不是继续接管', async () => {
    const who = await makeUser('熔断用例用户');
    const { job } = await enqueue(who);
    await makeStaleRunning(job.id, 50); // 默认上限 50

    const claimed = await claimNextGenerationJob('worker-thrash', 15_000);
    assert.equal(claimed, null, '超上限的单不许被领走');

    const after = await prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(after.status, 'failed', '必须判失败，否则它会一直躺在队列里被反复接管');
    assert.equal(after.terminationReason, 'lease_thrashing');
    assert.equal(after.leaseOwner, null);
    assert.equal(
      after.leaseVersion, 50,
      '熔断时不许再 +1——每熔断一次自己又涨一次的话，上限永远追不上',
    );
  });

  test('未超上限仍正常接管，leaseVersion 递增', async () => {
    const who = await makeUser('正常接管用户');
    const { job } = await enqueue(who);
    await makeStaleRunning(job.id, 3);

    const claimed = await claimNextGenerationJob('worker-normal', 15_000);
    assert.equal(claimed?.id, job.id, '没超上限的过期单应当被正常接管');
    assert.equal(claimed?.leaseVersion, 4);
    assert.equal(claimed?.leaseOwner, 'worker-normal');
  });

  // 退避是「越抖越慢」，让抖动在撞上限之前先自然衰减；缺了它，接管就是热循环。
  test('接管过的单租约更长：退避随接管次数增长', async () => {
    const who = await makeUser('退避用例用户');
    const { job: fresh } = await enqueue(who);
    const claimedFresh = await claimNextGenerationJob('worker-fresh', 15_000);
    assert.equal(claimedFresh?.id, fresh.id);
    const freshLease = claimedFresh!.leaseExpiresAt!.getTime() - Date.now();

    await drainQueue();
    const who2 = await makeUser('退避用例用户2');
    const { job: thrashed } = await enqueue(who2);
    await makeStaleRunning(thrashed.id, 8);
    const claimedThrashed = await claimNextGenerationJob('worker-thrashed', 15_000);
    assert.equal(claimedThrashed?.id, thrashed.id);
    const thrashedLease = claimedThrashed!.leaseExpiresAt!.getTime() - Date.now();

    assert.ok(
      thrashedLease > freshLease + 10_000,
      `被接管 8 次的单租约应显著更长（首次约 ${Math.round(freshLease / 1000)}s，实际 ${Math.round(thrashedLease / 1000)}s）`,
    );
  });

  test('单用户在途任务超上限 → 抛 429，且不影响别的用户', async () => {
    const who = await makeUser('堆单用户');
    const other = await makeUser('无辜用户');
    // 默认上限 8：前 8 条应当都能建
    for (let i = 0; i < 8; i++) await enqueue(who, `堆第 ${i + 1} 条`);

    await assert.rejects(
      () => enqueue(who, '第 9 条应当被挡'),
      (err: unknown) => {
        assert.ok(err instanceof GenerationInflightLimitError, `期望 GenerationInflightLimitError，实际 ${String(err)}`);
        assert.equal((err as GenerationInflightLimitError & { statusCode: number }).statusCode, 429);
        return true;
      },
    );

    // 上限必须是**按用户**的，不能变成全站闸门
    const ok = await enqueue(other, '别人的单不该被牵连');
    assert.ok(ok.job.id, '另一个用户仍应能正常建单');
  });

  test('幂等重复点击不吃在途配额（走 existing 分支，压根到不了计数）', async () => {
    const who = await makeUser('重复点击用户');
    const rid = `guard-idem-${Date.now()}`;
    const body = { text: '同一条重复发', agentKey: 'general', clientRequestId: rid };
    const first = await enqueueDurableGeneration(who.user, body);
    for (let i = 0; i < 12; i++) {
      const again = await enqueueDurableGeneration(who.user, body);
      assert.equal(again.job.id, first.job.id, '幂等命中必须复用同一个 job');
    }
    const count = await prisma.generationJob.count({
      where: { userId: who.user.id, status: { in: ['queued', 'running'] } },
    });
    assert.equal(count, 1, '重复点击 13 次也只应有 1 个在途单');
  });
});
