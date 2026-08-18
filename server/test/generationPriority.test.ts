// 生成队列的付费优先级 + 老化 + 排位透出。
// 跑法：只能 `npm test`（自带 .env.test + pretest db push）；裸 node --test 会连 dev 库清业务数据。
//
// 本文件所有断言都依赖「队列里只有本用例的单」——claim 是全库范围的，所以每条用例前先清空
// 在途单（见 drainQueue），否则前一条用例遗留的 queued 单会插进排序里，失败信息还会指向错误的原因。
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { GenerationView } from '../../shared/contracts';
import { api, cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { enqueueDurableGeneration } from '../src/services/generationRequest.ts';
import { claimNextGenerationJob, countQueuedAhead } from '../src/services/generationJobs.ts';
import { pipeGenerationSSE } from '../src/routes/generations.ts';

const AGING_ENV = 'GENERATION_PRIORITY_AGING_SECONDS';

interface TestUser {
  token: string;
  user: { id: string; tenantId: string };
}

/** 建用户。tierRank 给定时改挂库里该档位的套餐（档位映射归运营数据，测试也只读它，不写死映射）。 */
async function userOnPlan(name: string, tierRank?: number): Promise<TestUser> {
  const phone = uniquePhone();
  const token = await login(phone, name);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  if (tierRank != null) {
    const plan = await prisma.plan.findFirstOrThrow({ where: { tierRank } });
    await prisma.user.update({ where: { id: user.id }, data: { planId: plan.id } });
  }
  return { token, user };
}

let seq = 0;
async function enqueue(who: TestUser, text: string) {
  return enqueueDurableGeneration(who.user, {
    text,
    agentKey: 'general',
    clientRequestId: `priority-${Date.now()}-${seq++}`,
  });
}

async function drainQueue(): Promise<void> {
  await prisma.generationJob.updateMany({
    where: { status: { in: ['queued', 'running'] } },
    data: { status: 'cancelled', completedAt: new Date() },
  });
  await prisma.session.updateMany({ where: { NOT: { activeGenerationId: null } }, data: { activeGenerationId: null } });
}

/** 把 createdAt 回填到过去，模拟「已经排了很久」（老化项只看 now - createdAt）。 */
async function ageJob(jobId: string, secondsAgo: number): Promise<void> {
  await prisma.generationJob.update({
    where: { id: jobId },
    data: { createdAt: new Date(Date.now() - secondsAgo * 1000) },
  });
}

function withAging<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[AGING_ENV];
  if (value === undefined) delete process.env[AGING_ENV];
  else process.env[AGING_ENV] = value;
  const restore = () => {
    if (previous === undefined) delete process.env[AGING_ENV];
    else process.env[AGING_ENV] = previous;
  };
  return fn().then(
    (result) => { restore(); return result; },
    (error) => { restore(); throw error; },
  );
}

describe('生成队列：套餐优先级、老化防饥饿与排位透出', () => {
  before(async () => {
    await getApp();
    await cleanBusiness();
    await seedBaseline();
  });
  beforeEach(drainQueue);
  after(async () => { await closeApp(); });

  test('高档位用户后入队也先被领单，且 tierRank 超界封顶到 9', async () => {
    const low = await userOnPlan('优先级低档用户');
    const high = await userOnPlan('优先级高档用户', 999);
    const first = await enqueue(low, '低档的这条先排进队列');
    const second = await enqueue(high, '高档的这条后排进队列');

    assert.equal(first.job.priority, 1, '入门版 tierRank=1 应原样落列');
    assert.equal(
      second.job.priority, 9,
      'tierRank=999 必须封顶到 9 —— 否则一个档位就吃掉整条老化曲线，低档单永远等不到',
    );
    const claimed = await claimNextGenerationJob('worker-priority-tier', 15_000);
    assert.equal(claimed?.id, second.job.id, '同一时刻入队时应由 priority 决定先后');
  });

  test('同优先级严格 FIFO（优先级不改变同档内的公平）', async () => {
    const a = await userOnPlan('同档甲');
    const b = await userOnPlan('同档乙');
    const earlier = await enqueue(a, '同档里先来的一条');
    const later = await enqueue(b, '同档里后来的一条');
    assert.equal(earlier.job.priority, later.job.priority);

    assert.equal((await claimNextGenerationJob('worker-fifo-1', 15_000))?.id, earlier.job.id);
    assert.equal((await claimNextGenerationJob('worker-fifo-2', 15_000))?.id, later.job.id);
  });

  test('老化：等够窗口的低档单必须反超新到的高档单', async () => {
    const low = await userOnPlan('老化低档用户');
    const high = await userOnPlan('老化高档用户', 999);
    const stale = await enqueue(low, '这条已经排了十分钟');
    // 虚拟到达时间 = createdAt - priority×30s：老单 now-600-30s，刚到的 9 级单也只提前到 now-270s，
    // 600s 的真实等待必须压过任何档位的虚拟提前量（封顶 9×30s=270s）。
    await ageJob(stale.job.id, 600);
    const fresh = await enqueue(high, '这条是刚到的高档单');

    const claimed = await claimNextGenerationJob('worker-aging', 15_000);
    assert.equal(claimed?.id, stale.job.id, '老化失效就等于低档用户在高峰期饥饿，这是本设计的底线');
    assert.equal((await claimNextGenerationJob('worker-aging-2', 15_000))?.id, fresh.job.id);
  });

  test('排位：queued 单透出 ahead，running 单不再占用户前方的位置', async () => {
    const a = await userOnPlan('排位甲');
    const b = await userOnPlan('排位乙');
    const head = await enqueue(a, '排位里排在前面的一条');
    const tail = await enqueue(b, '排位里排在后面的一条');

    assert.equal(await countQueuedAhead(head.job), 0);
    assert.equal(await countQueuedAhead(tail.job), 1);

    const second = await api<GenerationView>('GET', `/api/generations/${tail.job.id}`, { token: b.token });
    assert.equal(second.status, 200);
    assert.equal(second.body.queue?.ahead, 1, 'GET 也要给出排位——断连重连/冷启动恢复只走这条路');
    const first = await api<GenerationView>('GET', `/api/generations/${head.job.id}`, { token: a.token });
    assert.equal(first.body.queue?.ahead, 0);

    assert.equal((await claimNextGenerationJob('worker-ahead', 15_000))?.id, head.job.id);
    const afterClaim = await api<GenerationView>('GET', `/api/generations/${tail.job.id}`, { token: b.token });
    assert.equal(afterClaim.body.queue?.ahead, 0, '前面那单已经在跑了，不该继续算在「前面还有几位」里');
    const running = await api<GenerationView>('GET', `/api/generations/${head.job.id}`, { token: a.token });
    assert.equal(running.body.queue ?? null, null, 'queue 只在 queued 时出现');
  });

  test(`${AGING_ENV}=0 时严格按 priority，不做老化`, async () => {
    await withAging('0', async () => {
      const low = await userOnPlan('严格优先级低档用户');
      const high = await userOnPlan('严格优先级高档用户', 999);
      const stale = await enqueue(low, '关掉老化后这条等再久也要让位');
      await ageJob(stale.job.id, 6 * 3600);
      const fresh = await enqueue(high, '关掉老化后高档单绝对优先');

      assert.equal((await claimNextGenerationJob('worker-strict', 15_000))?.id, fresh.job.id);
      assert.equal((await claimNextGenerationJob('worker-strict-2', 15_000))?.id, stale.job.id);
    });
  });

  test('SSE：claim 把 queued→running 时即使 snapshotVersion 不动也必须推快照', async () => {
    // claim 更新 status/phase 但**不递增 snapshotVersion**；SSE 若只比对版本，
    // 「排队中·前面还有 N 位」会一直挂到首个 token 快照——用户看到的是已经在跑的单还在"排队"。
    const who = await userOnPlan('SSE状态用户');
    const created = await enqueue(who, 'SSE 状态推送验证');
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const raw = {
      writableEnded: false,
      destroyed: false,
      on() {},
      write(chunk: string) {
        const m = /^event: (.+)\ndata: (.*)\n\n$/s.exec(chunk);
        if (m) events.push({ event: m[1], data: JSON.parse(m[2]) });
        return true;
      },
    };
    const pipe = pipeGenerationSSE({ raw } as never, created.job.id);
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const queuedFrame = events.find((e) => e.event === 'snapshot');
      assert.equal(queuedFrame?.data.status, 'queued');
      assert.deepEqual(queuedFrame?.data.queue, { ahead: 0 }, '排队首帧要带排位');

      await claimNextGenerationJob('worker-sse-transition', 15_000);
      // SSE 轮询间隔 350ms，等一个整周期多一点，让 status 变化那一帧发出来。
      await new Promise((resolve) => setTimeout(resolve, 900));
      const runningFrame = events.find((e) => e.event === 'snapshot' && e.data.status === 'running');
      assert.ok(runningFrame, 'queued→running 必须推一帧，即使 snapshotVersion 没变');
      assert.equal(runningFrame?.data.queue ?? null, null, '开跑之后不该再挂排位');
    } finally {
      raw.writableEnded = true;
      await pipe;
    }
  });

  test(`${AGING_ENV}=0.5 这类小数不得被截成 0（截成 0 = 语义反转成「关掉老化」）`, async () => {
    // 「把老化窗口调小」和「关掉老化恢复饥饿」是语义相反的两件事，绝不能只差一个小数点：
    // 0<n<1 至少按 1 秒生效，只有精确的 0 才是严格优先级。
    await withAging('0.5', async () => {
      const low = await userOnPlan('小数老化低档用户');
      const high = await userOnPlan('小数老化高档用户', 999);
      const stale = await enqueue(low, '小数老化下这条老单仍要反超');
      await ageJob(stale.job.id, 600);
      await enqueue(high, '小数老化环境里刚到的高档单');

      // 老化生效（≥1s/级）时 600s 的真实等待必然压过 9 级封顶的虚拟提前量；
      // 若 0.5 被截成 0（严格优先级），领到的会是高档新单，此断言即失败。
      assert.equal((await claimNextGenerationJob('worker-fraction-env', 15_000))?.id, stale.job.id);
    });
  });

  test(`${AGING_ENV}='' 回落默认 30s，而不是被当成显式 0`, async () => {
    // Number('') === 0 的陷阱：空串若被当成「关掉老化」，线上只要有人把这行留空就静默恢复饥饿。
    await withAging('', async () => {
      const low = await userOnPlan('空串环境低档用户');
      const high = await userOnPlan('空串环境高档用户', 999);
      const stale = await enqueue(low, '空串不该关掉老化');
      await ageJob(stale.job.id, 600);
      await enqueue(high, '空串环境里刚到的高档单');

      assert.equal((await claimNextGenerationJob('worker-empty-env', 15_000))?.id, stale.job.id);
    });
  });
});
