// 成本记账真实性（2026-08 与七牛逐笔对账后补的三个洞）。
//
// 对账结论：我方账本 ¥22.44 vs 七牛实计 ¥56.30，系统性少记约 60%。三个根因各占一块：
//   ① aux（占当月成本 17.5%）按「字符数÷2」估 token —— 推理模型的思考 token 不在返回正文里，
//      实测 kimi 一次 completion_tokens:400 / reasoning_tokens:400 而正文 0 字，估出来是 0，最多低估 11 倍；
//   ② 探活按每项固定 40 in / 20 out 记 —— 倒算实测真实约 215 in / 174 out，输出低估 9-15 倍；
//   ③ 沙盒试跑直接不写 token_usage —— 七牛照样计费，8 月约 ¥45 完全查不到出处。
//
// 这三条用例锁的都是同一件事：**记的必须是 provider 回报的真实 usage，不是任何形式的估算或常数**。
// 因此每条都刻意把「真实值」和「估算值」设成明显不同的数，断言落库的是前者。
//   cd server && node --import tsx --test test/costAccounting.test.ts
import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness } from './helpers.js';
import { prisma } from '../src/db.js';
import { __resetAiConfigCache, type ResolvedAiConfig } from '../src/services/aiConfig.js';
import { auxUsageOf } from '../src/services/usage.js';

const CHAT_URL = '/chat/completions';
const realFetch = globalThis.fetch;

/** 只拦 chat/completions；其余出站一律报错（测试不该出网）。 */
function stubChat(body: unknown): void {
  globalThis.fetch = (async (url: unknown) => {
    if (!String(url).includes(CHAT_URL)) throw new Error(`unexpected fetch: ${url}`);
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** 记账是 fire-and-forget（绝不拖垮产出），所以只能轮询等它落库。 */
async function waitForUsage(kind: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await prisma.tokenUsage.findFirst({ where: { kind }, orderBy: { createdAt: 'desc' } });
    if (row) return row;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 全局 AI 配置指向被打桩的 OpenAI 兼容端点（aux / 沙盒都从这里取 cfg）。 */
async function useStubbedGlobalEndpoint(): Promise<void> {
  await prisma.aiSetting.upsert({
    where: { id: 'default' },
    create: {
      id: 'default', provider: 'openai', label: '记账测试端点',
      baseUrl: 'http://mock.test/v1', model: 'metering-test-model', apiKey: 'sk-test-real-123',
    },
    update: {
      provider: 'openai', label: '记账测试端点',
      baseUrl: 'http://mock.test/v1', model: 'metering-test-model', apiKey: 'sk-test-real-123',
    },
  });
  __resetAiConfigCache();
}

describe('成本记账记的是真实 usage，不是估算', () => {
  before(async () => {
    process.env.AI_ALLOW_REAL_PROVIDER = '1'; // 放行 provider 代码路径；fetch 仍被打桩，不出网
    await getApp();
    await cleanBusiness();
    await seedBaseline();
    await useStubbedGlobalEndpoint();
  });
  after(async () => {
    delete process.env.AI_ALLOW_REAL_PROVIDER;
    globalThis.fetch = realFetch;
    await closeApp();
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await prisma.tokenUsage.deleteMany({});
  });

  // ── 任务一：aux ──────────────────────────────────────────────────────────────

  test('aux：正文为空但 provider 报了 400 输出 token（推理模型形态）→ 记 400，不是字符估算的 0', async () => {
    // 这就是实测到的 kimi-k3 形态：思考烧掉 400 token，返回正文一个字都没有。
    // 旧实现按 `outputText.length / 2` 估 → 记 0，整笔思考成本凭空消失。
    stubChat({
      choices: [{ message: { content: '' } }],
      usage: { prompt_tokens: 1200, completion_tokens: 400, completion_tokens_details: { reasoning_tokens: 400 } },
    });
    const { completeText } = await import('../src/llm/gateway.js');
    await completeText('你是抽取器。', '短输入');

    const row = await waitForUsage('aux');
    assert.ok(row, 'aux 调用必须落一条 token_usage');
    assert.equal(row.outputTokens, 400, '输出 token 必须取 provider 回报的 400（字符估算会是 0）');
    assert.notEqual(row.outputTokens, 0, '正文为空不等于没花钱——这正是低估 60% 的来源之一');
    assert.equal(row.inputTokens, 1200, '输入 token 同样取真实回报');
    // 反向锁：证明真实值确实和估算值不同，否则这条用例可能什么都没测到。
    const estimated = Math.ceil('你是抽取器。\n短输入'.length / 2);
    assert.notEqual(row.inputTokens, estimated, `真实 1200 必须区别于字符估算 ${estimated}`);
    assert.equal(row.creditCost, 0, 'aux 不扣用户额度');
  });

  test('aux：provider 没回 usage 时才退回字符估算（兜底顺序不能反）', async () => {
    const content = '一二三四五六七八九十'; // 10 字 → 估 5 token
    stubChat({ choices: [{ message: { content } }] }); // 刻意不带 usage 字段
    const { completeText } = await import('../src/llm/gateway.js');
    const system = '你是抽取器。';
    const user = '短输入';
    await completeText(system, user);

    const row = await waitForUsage('aux');
    assert.ok(row, '没有 usage 也要按估算记一条，成本不能完全隐身');
    assert.equal(row.outputTokens, Math.ceil(content.length / 2), 'provider 无 usage → 回落字符估算');
    assert.equal(row.inputTokens, Math.ceil(`${system}\n${user}`.length / 2));
  });

  test('aux 取数顺序（纯函数）：真实回报优先，全 0 视为「没回」而非「真的是 0」', () => {
    // >0 才认。`?? 0` 会把「字段缺失」和「真的是 0」抹平，两者都必须退回估算，否则静默漏账。
    assert.deepEqual(
      auxUsageOf('输入文本', '输出文本', { inputTokens: 900, outputTokens: 700, cachedInput: 0 }),
      { inputTokens: 900, outputTokens: 700, cachedInput: 0 },
    );
    assert.equal(auxUsageOf('输入文本', '输出文本', { inputTokens: 0, outputTokens: 0, cachedInput: 0 }).inputTokens, 2);
    assert.equal(auxUsageOf('输入文本', '输出文本', null).outputTokens, 2);
  });

  // ── 任务二：探活 ─────────────────────────────────────────────────────────────

  test('探活：记 provider 回报的真实用量，而不是每项 40/20 的常数', async () => {
    stubChat({
      choices: [{ message: { content: '可用' } }],
      usage: { prompt_tokens: 215, completion_tokens: 174 },
    });
    const { runProbes } = await import('../src/services/aiProbe.js');
    const cfg = probeCfg();
    await runProbes(cfg, ['connectivity'], new Date());

    const row = await waitForUsage('probe');
    assert.ok(row, '探活是真实计费请求，必须落账');
    assert.equal(row.inputTokens, 215, '输入取真实回报（旧常数是 40）');
    assert.equal(row.outputTokens, 174, '输出取真实回报（旧常数是 20）');
    assert.notEqual(row.inputTokens, 40);
    assert.notEqual(row.outputTokens, 20);
  });

  test('探活：thinking 一项发两次请求 → 两次用量都要累加，不是只记一次', async () => {
    stubChat({
      choices: [{ message: { content: '可用' } }],
      usage: { prompt_tokens: 215, completion_tokens: 174 },
    });
    const { runProbes } = await import('../src/services/aiProbe.js');
    // thinkingMode=enabled → 关闭态 + 开启态各发一次。
    await runProbes({ ...probeCfg(), thinkingMode: 'enabled' }, ['thinking'], new Date());

    const row = await waitForUsage('probe');
    assert.ok(row);
    assert.equal(row.inputTokens, 430, '两次调用的输入要累加（215×2）');
    assert.equal(row.outputTokens, 348, '两次调用的输出要累加（174×2）');
  });

  test('探活：一个 token 都没花（mock 端点）→ 不写账，不再凭空造 40/20', async () => {
    // 旧实现按 results.length 乘常数，连没真外呼的探活都会记出 80/40 的假消耗。
    const { runProbes } = await import('../src/services/aiProbe.js');
    await runProbes({ ...probeCfg(), provider: 'mock', apiKey: '' }, ['connectivity', 'thinking'], new Date());
    await new Promise((r) => setTimeout(r, 200)); // 给 fire-and-forget 一点时间，确认它确实没写
    const row = await prisma.tokenUsage.findFirst({ where: { kind: 'probe' } });
    assert.equal(row, null, '没有真实消耗就不该有流水（表=真实消耗）');
  });

  // ── 任务三：沙盒 ─────────────────────────────────────────────────────────────

  test('沙盒试跑：按 kind=sandbox 照实入账，creditCost=0 且不挂用户', async () => {
    // 旧实现直接 return「不污染计费统计」——可七牛照样收钱，这笔成本在库里完全查不到。
    stubChat({
      choices: [{ message: { content: '沙盒试跑的回答。' } }],
      usage: { prompt_tokens: 333, completion_tokens: 222 },
    });
    const { buildSandboxContext } = await import('../src/services/context.js');
    const { chatComplete } = await import('../src/llm/gateway.js');
    const built = await buildSandboxContext({ agentKey: 'general', userMessage: '试跑一下' });
    assert.ok(built, 'general 应存在');
    await chatComplete(built.ctx, { agentKey: 'general', sandbox: true, userId: 'u_should_not_be_recorded' });

    const row = await waitForUsage('sandbox');
    assert.ok(row, '沙盒消耗必须可见——单独成档，但不能不记');
    assert.equal(row.inputTokens, 333);
    assert.equal(row.outputTokens, 222);
    assert.equal(row.creditCost, 0, '沙盒不扣任何额度');
    assert.equal(row.userId, null, '沙盒是运营试跑，挂用户会造成错误归因');
    const asChat = await prisma.tokenUsage.findFirst({ where: { kind: 'chat' } });
    assert.equal(asChat, null, '不能混进用户用量口径（后台只聚合 chat/deliverable）');
  });
});

/** 探活用的被测端点：真 key + bypass，效果等同运营在表单里点「测试连接」。 */
function probeCfg(): ResolvedAiConfig {
  return {
    provider: 'openai', label: '探活记账测试', baseUrl: 'http://mock.test/v1',
    model: 'probe-test-model', apiKey: 'sk-test-real-123', embeddingModel: '', temperature: 0.3,
    thinkingMode: 'disabled', thinkingBudget: 1024, timeoutMs: 20_000, poolBypass: true,
    embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
    rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
  };
}
