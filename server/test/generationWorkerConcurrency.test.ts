// 生成 worker 的有界滚动并发（services/generationWorker.ts 的 pumpGenerationWorker）。
//   跑法只有 `npm test`（自带 .env.test + pretest db push）；**禁止裸 node --test**，那会连 dev 库清业务数据。
//
// 为什么必须有这组用例：旧实现每拍 `await processJob(job)`，单进程同时只跑 1 单，llmGate 主车道
// 8 个槽长期吃不满。改成滚动 pump 后有三件事必须被锁住，否则回归时没人看得见：
//   ① 多单排队时真的同时在途 > 1（这是改动的全部意义）；
//   ② GENERATION_WORKER_CONCURRENCY=1 时严格等价于旧串行行为（这是线上回退开关，必须可信）；
//   ③ 槽位释放后自动补下一单 —— 我们只 pump 一次，第二单要靠 `.finally` 里的即时再 pump 领走，
//      而不是等下一个 300ms interval。
//
// 观察手段：AI_MOCK_LATENCY_MS 让 mock 占一个真实闸门槽位并睡够模拟耗时（见 providers/mock.ts
// 顶部注释），于是「在途」是一个可稳定观察的状态，不用靠 sleep 猜时序。
// 注意 tickGenerationWorker 那条路径是刻意保留的串行驱动器，在它上面观察不到并发。
import { after, before, afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanBusiness, closeApp, getApp, login, seedBaseline, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { enqueueDurableGeneration } from '../src/services/generationRequest.ts';
import {
  __generationWorkerInFlight,
  __resumeGenerationWorker,
  pumpGenerationWorker,
  stopGenerationWorker,
} from '../src/services/generationWorker.ts';

/** 单次 mock 外呼的模拟耗时：要远长于一次 DB claim，才能在 pump 返回后稳定观察到「还在途」。 */
const MOCK_LATENCY_MS = 600;
const TERMINAL = ['completed', 'truncated', 'failed', 'cancelled'];
const ENV = ['GENERATION_WORKER_CONCURRENCY', 'AI_MOCK_LATENCY_MS'] as const;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let saved: Record<string, string | undefined> = {};

async function enqueueOne(label: string): Promise<string> {
  const phone = uniquePhone();
  await login(phone, label);
  const user = await prisma.user.findUniqueOrThrow({ where: { phone } });
  const created = await enqueueDurableGeneration(user, {
    text: `并发验证 ${label}`,
    agentKey: 'general',
    clientRequestId: `worker-concurrency-${label}-${Date.now()}`,
  });
  return created.job.id;
}

async function statusesOf(ids: string[]): Promise<Record<string, string>> {
  const rows = await prisma.generationJob.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } });
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

/** 等到全部落终态且在途归零；超时就把实际状态打出来，别让用例挂死在轮询里。 */
async function drain(ids: string[], timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const statuses = await statusesOf(ids);
    if (Object.values(statuses).every((s) => TERMINAL.includes(s)) && __generationWorkerInFlight() === 0) break;
    if (Date.now() > deadline) {
      throw new Error(`任务未在 ${timeoutMs}ms 内收口：inFlight=${__generationWorkerInFlight()} ${JSON.stringify(statuses)}`);
    }
    await sleep(25);
  }
  // 收尾副作用是 fire-and-forget（runPostEffects），给它一点时间落地，避免跨用例互相打扰。
  await sleep(50);
}

describe('生成 worker 的有界滚动并发', () => {
  before(async () => {
    await getApp();
    await cleanBusiness();
    await seedBaseline();
    saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    process.env.AI_MOCK_LATENCY_MS = String(MOCK_LATENCY_MS);
  });
  afterEach(() => { delete process.env.GENERATION_WORKER_CONCURRENCY; });
  after(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await closeApp();
  });

  test('多单排队时同时在途 > 1（旧串行实现恒为 1）', async () => {
    process.env.GENERATION_WORKER_CONCURRENCY = '3';
    const ids = [await enqueueOne('并发甲'), await enqueueOne('并发乙'), await enqueueOne('并发丙')];

    // pump 只 await「分类 + 领单」，任务本体是 void 出去的，所以它返回时三单都还在途。
    await pumpGenerationWorker();
    assert.ok(
      __generationWorkerInFlight() >= 2,
      `pump 返回时应有多单在途，实际 ${__generationWorkerInFlight()}`,
    );

    await drain(ids);
    const statuses = await statusesOf(ids);
    for (const id of ids) {
      assert.ok(['completed', 'truncated'].includes(statuses[id]), `${id} 应正常收口，实际 ${statuses[id]}`);
    }
  });

  test('GENERATION_WORKER_CONCURRENCY=1 等价于旧串行行为：一单在途时不领第二单', async () => {
    process.env.GENERATION_WORKER_CONCURRENCY = '1';
    const first = await enqueueOne('串行甲');
    const second = await enqueueOne('串行乙');

    await pumpGenerationWorker();
    assert.equal(__generationWorkerInFlight(), 1, '上限 1 时只能有一单在途');
    const midway = await statusesOf([first, second]);
    // 两个用户都是测试期默认套餐（同优先级），所以领单顺序退化为先入队者先跑。
    assert.equal(midway[first], 'running', '同优先级下先入队的单先被领');
    assert.equal(midway[second], 'queued', '上限 1 时第二单必须还在排队');

    await drain([first, second]);
  });

  test('槽位释放后立刻自动补下一单：只 pump 一次，两单都跑完', async () => {
    process.env.GENERATION_WORKER_CONCURRENCY = '1';
    const ids = [await enqueueOne('补位甲'), await enqueueOne('补位乙')];

    // 关键：全程只调用一次 pump。第二单必须由第一单收尾时 `.finally` 里的即时再 pump 领走，
    // 不依赖 startGenerationWorker 的 300ms interval（测试态 interval 根本没起）。
    await pumpGenerationWorker();
    await drain(ids);

    const statuses = await statusesOf(ids);
    for (const id of ids) {
      assert.ok(['completed', 'truncated'].includes(statuses[id]), `${id} 应正常收口，实际 ${statuses[id]}`);
    }
  });

  // Number('') === 0（不是 NaN）：这个坑曾让 llmGate 在未配 LLM_MAX_CONCURRENCY 时把上限算成 1，
  // 零报错地把上游吞吐锁死半个月。这里锁住同一形状的解析。
  test('空串等同未配置 → 回落默认 4（第 5 单靠槽位释放自动补上）', async () => {
    process.env.GENERATION_WORKER_CONCURRENCY = '';
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await enqueueOne(`默认档${i}`));

    await pumpGenerationWorker();
    assert.equal(__generationWorkerInFlight(), 4, '空串必须回落默认 4，不能被当成「显式配了 0」');

    await drain(ids);
    const statuses = await statusesOf(ids);
    for (const id of ids) {
      assert.ok(['completed', 'truncated'].includes(statuses[id]), `${id} 应正常收口，实际 ${statuses[id]}`);
    }
  });

  test('stop 之后在途单收尾不得续领：第二单必须保持 queued', async () => {
    // stop 只清 interval 是不够的：每单收尾的 .finally 会再 pump 一次，「停止领新单」的承诺
    // 恰好在停机时失效——这正是 stopped 标志存在的原因，锁住它。
    process.env.GENERATION_WORKER_CONCURRENCY = '1';
    const first = await enqueueOne('停机甲');
    const second = await enqueueOne('停机乙');
    try {
      await pumpGenerationWorker();
      assert.equal((await statusesOf([first]))[first], 'running');
      stopGenerationWorker();

      // 等第一单收口（含 .finally 的再 pump 触发点），第二单必须原地不动。
      const deadline = Date.now() + 30_000;
      while (!TERMINAL.includes((await statusesOf([first]))[first])) {
        if (Date.now() > deadline) throw new Error('第一单未在期限内收口');
        await sleep(25);
      }
      await sleep(200);
      assert.equal((await statusesOf([second]))[second], 'queued', 'stop 后不得再领新单');
    } finally {
      __resumeGenerationWorker();
    }
    await pumpGenerationWorker();
    await drain([first, second]);
  });

  test('非法值回落默认、0 与负数夹到 1 —— 任何取值都不会「一单都不领」', async () => {
    for (const [raw, expected] of [['abc', 4], ['0', 1], ['-3', 1]] as const) {
      process.env.GENERATION_WORKER_CONCURRENCY = raw;
      const ids = [await enqueueOne(`解析${raw}甲`), await enqueueOne(`解析${raw}乙`)];
      await pumpGenerationWorker();
      // 只有 2 单在队，所以默认 4 这一档观察到的在途是 2（上限没被吃满）。
      assert.equal(
        __generationWorkerInFlight(),
        Math.min(expected, 2),
        `GENERATION_WORKER_CONCURRENCY=${JSON.stringify(raw)} 的在途数不对`,
      );
      await drain(ids);
    }
  });
});
