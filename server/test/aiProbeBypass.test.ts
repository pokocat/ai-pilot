// 探活不得被端点池劫持（2026-08-07 修 D1）。
//   cd server && npm test -- test/aiProbeBypass.test.ts
//
// 背景：探活走 pingModel → claudeRaw/openaiRaw → withEndpoint → resolveCandidates 这条正常外呼链路。
// routingMode=pool 时 resolveCandidates 会把配置整体换成池成员（llmPool.toCfg 覆盖 baseUrl/apiKey/
// model/temperature/thinking），于是「测试连接」测的不是运营正在编辑的端点——错的 key 也返回「连通 ✓」。
// V2 只有端点表单探活入口；它和智能体自带接入探活都必须锁住 bypass。
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mergedTestConfig, type ResolvedAiConfig } from '../src/services/aiConfig.js';
import { resolveCandidates, __resetLlmPool, __setPoolForTest, type PoolEndpoint } from '../src/services/llmPool.js';

// 运营正在表单里编辑的那个端点：每个字段都与池成员不同，被改写就一定看得出来。
const FORM: ResolvedAiConfig = {
  provider: 'openai', label: '正在编辑的端点', baseUrl: 'https://being-edited/v1',
  model: 'model-being-edited', apiKey: 'sk-being-edited', embeddingModel: '', temperature: 0.3,
  thinkingMode: 'enabled', thinkingBudget: 4096, timeoutMs: 60_000,
  embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
  rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
};

const poolEp = (id: string): PoolEndpoint => ({
  id, label: `池端点-${id}`, provider: 'openai', baseUrl: `https://pool-${id}/v1`,
  apiKey: `sk-pool-${id}`, model: `pool-model-${id}`, temperature: 0.9,
  thinkingMode: 'disabled', thinkingBudget: 1024, weight: 1, tier: 0, maxConcurrency: 0,
});

function usePool(): void {
  __setPoolForTest([poolEp('a'), poolEp('b')], { mode: 'pool', sticky: true });
}

/** 断言候选就是「被测端点本身」：字段逐个比，而不是只看数量。 */
function assertIsFormEndpoint(cfg: ResolvedAiConfig): void {
  assert.equal(cfg.baseUrl, FORM.baseUrl);
  assert.equal(cfg.model, FORM.model);
  assert.equal(cfg.apiKey, FORM.apiKey);
  assert.equal(cfg.temperature, FORM.temperature);
  assert.equal(cfg.thinkingMode, FORM.thinkingMode);
  assert.equal(cfg.thinkingBudget, FORM.thinkingBudget);
}

describe('探活必须打被测端点本身（不被端点池改写）', () => {
  beforeEach(() => { __resetLlmPool(); });

  test('反向锁：不带 poolBypass 时确实会被池改写 —— 证明本测试在测有效的东西', async () => {
    usePool();
    const [first] = await resolveCandidates(FORM);
    assert.equal(first.baseUrl, 'https://pool-a/v1');
    assert.equal(first.apiKey, 'sk-pool-a');
    assert.equal(first.model, 'pool-model-a');
    // 池成员还会把 Thinking 配置一并换掉：探活因此测的是另一套思考参数。
    assert.equal(first.thinkingMode, 'disabled');
  });

  test('端点表单探活（/admin/ai-endpoints/test）：mergedTestConfig 产出必带 poolBypass', async () => {
    const cfg = await mergedTestConfig({
      provider: 'openai', label: FORM.label, baseUrl: FORM.baseUrl, model: FORM.model,
      apiKey: FORM.apiKey, temperature: FORM.temperature,
      thinkingMode: FORM.thinkingMode, thinkingBudget: FORM.thinkingBudget,
    });
    assert.equal(cfg.poolBypass, true);
    assertIsFormEndpoint(cfg);
  });

  test('端点表单探活：mergedTestConfig 的产物喂进路由也不被改写', async () => {
    usePool();
    const cfg = await mergedTestConfig({
      provider: 'openai', label: FORM.label, baseUrl: FORM.baseUrl, model: FORM.model,
      apiKey: FORM.apiKey, temperature: FORM.temperature,
      thinkingMode: FORM.thinkingMode, thinkingBudget: FORM.thinkingBudget,
    });
    const cands = await resolveCandidates(cfg);
    assert.equal(cands.length, 1);
    assertIsFormEndpoint(cands[0]);
  });

  test('智能体自带接入探活（pingAgentRuntime）同样不被劫持 —— D1 的第三个入口', async () => {
    // Agent 的 providerMode=openai 自带端点走 pingAgentRuntime；它也是自己拼 cfg + 调
    // pingModel，同样可能被池整体改写。
    usePool();
    const { pingAgentRuntime } = await import('../src/llm/gateway.js');
    // 没配 key → effectiveProvider 降级 mock，pingModel 早退，不会真外呼；
    // 这里要的是「返回里报的是被测端点自己的 model」，而不是池成员的 model。
    const r = await pingAgentRuntime({ mode: 'openai', baseUrl: FORM.baseUrl, model: FORM.model });
    assert.equal(r.model, FORM.model, '返回的 model 必须是被测端点，不能是池成员');
    assert.notEqual(r.model, 'pool-model-a');
  });

  test('智能体自带接入的明显错配在探活前就被拦下（决策点 5 的 B 项：共享校验地基）', async () => {
    const { pingAgentRuntime } = await import('../src/llm/gateway.js');
    // baseUrl 粘成完整接口路径——七牛 FAQ 点名过的错法，此前 Agent 这条路径完全不校验。
    const r = await pingAgentRuntime({
      mode: 'openai', baseUrl: 'https://api.qnaigc.com/v1/chat/completions', model: 'x', apiKey: 'sk-real-key-x',
    });
    assert.equal(r.ok, false);
    assert.match(r.error ?? '', /chat\/completions/);
  });

  test('single 模式下行为不变（不因 bypass 改变既有口径）', async () => {
    __setPoolForTest([poolEp('a')], { mode: 'single', sticky: true });
    const cands = await resolveCandidates({ ...FORM, poolBypass: true });
    assert.equal(cands.length, 1);
    assertIsFormEndpoint(cands[0]);
  });
});
