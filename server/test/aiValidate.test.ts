// 接入配置互斥校验器（2026-08-07 · 重设计二期）。
//   cd server && npm test -- test/aiValidate.test.ts
//
// 这些规则此前要么散在 routes/admin.ts 的三段重复 if 里（判据还是 AiSetting.provider 这个拷贝值），
// 要么根本不存在（thinking 的约束没有任何保存期校验，后台能存下运行时必然 400 的配置）。
// 本文件按 AI_CONFIG_REDESIGN §5 的规则表逐条锁住，重点是**每条规则的「不该误伤」那一侧**——
// 校验器最容易出的事故不是漏拦，是把正常配置拦住，让运营改不动线上。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEndpoint, validateAuxEndpoint, validateRoute, hasBlocking, blockingMessage,
  type EndpointDraft,
} from '../src/llm/validate.js';
import type { AiConfigIssue } from '../src/llm/schema.js';

const ep = (over: Partial<EndpointDraft> = {}): EndpointDraft => ({
  label: '端点', provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'some-model',
  thinkingMode: 'disabled', thinkingBudget: 1024, hasKey: true,
  priceInput: 36, priceOutput: 180, ...over,
});
const codes = (issues: AiConfigIssue[]) => issues.map((i) => i.code);
const has = (issues: AiConfigIssue[], code: string) => codes(issues).includes(code);
const errs = (issues: AiConfigIssue[]) => issues.filter((i) => i.level === 'error').map((i) => i.code);

describe('端点自洽性', () => {
  test('正常的七牛 Anthropic 端点：没有任何 error', () => {
    const issues = validateEndpoint(ep({
      provider: 'claude', baseUrl: 'https://api.qnaigc.com', model: 'claude-opus-4-6',
      thinkingMode: 'adaptive', dialect: 'anthropic_gateway',
    }));
    assert.deepEqual(errs(issues), [], `不该拦：${JSON.stringify(issues)}`);
  });

  test('OpenAI 官方 + 开思考 → error（官方没有该扩展，配了也发不出去）', () => {
    const issues = validateEndpoint(ep({
      baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', thinkingMode: 'enabled',
    }));
    assert.ok(has(issues, 'THINKING_UNSUPPORTED_DIALECT'));
    assert.ok(hasBlocking(issues));
  });

  test('探活已证伪 thinking → error，且拦得住（取代按模型名猜）', () => {
    const issues = validateEndpoint(ep({
      provider: 'claude', baseUrl: 'https://api.qnaigc.com', model: 'some-non-thinking-model',
      thinkingMode: 'enabled', capsJson: { thinking: 'no' },
    }));
    assert.ok(has(issues, 'THINKING_CAP_NO'));
  });

  test('caps 没探测过 → 不拦（unknown 不能当成 no，否则新端点全被挡住）', () => {
    for (const caps of [undefined, {}, { thinking: 'unknown' }, { thinking: 'yes' }]) {
      const issues = validateEndpoint(ep({
        provider: 'claude', baseUrl: 'https://api.qnaigc.com', model: 'claude-opus-4-6',
        thinkingMode: 'enabled', capsJson: caps,
      }));
      assert.equal(has(issues, 'THINKING_CAP_NO'), false, `caps=${JSON.stringify(caps)}`);
    }
  });

  test('DeepSeek 的 Anthropic 端点开手动预算 → warn 说明预算不生效（能存，但要说清楚）', () => {
    const issues = validateEndpoint(ep({
      provider: 'claude', baseUrl: 'https://api.deepseek.com/anthropic', model: 'claude-sonnet-4-6',
      thinkingMode: 'enabled', thinkingBudget: 4096,
    }));
    assert.ok(has(issues, 'THINKING_BUDGET_IGNORED'));
    assert.equal(hasBlocking(issues), false, 'DeepSeek 能跑，不该拒绝保存');
  });

  test('思考预算 + 正文预算顶穿实测上限 → error（这正是「回复未完整结束」的形状）', () => {
    const issues = validateEndpoint(
      ep({ provider: 'claude', baseUrl: 'https://g', model: 'claude-x', thinkingMode: 'enabled', thinkingBudget: 7000, capsJson: { maxOutputTokens: 8192 } }),
      { bodyMaxTokens: 8000 },
    );
    assert.ok(has(issues, 'BUDGET_EXCEEDS_MAX_TOKENS'));
  });

  test('没有实测上限时不报（不能拿猜测拦人）', () => {
    const issues = validateEndpoint(
      ep({ provider: 'claude', baseUrl: 'https://g', model: 'claude-x', thinkingMode: 'enabled', thinkingBudget: 7000 }),
      { bodyMaxTokens: 8000 },
    );
    assert.equal(has(issues, 'BUDGET_EXCEEDS_MAX_TOKENS'), false);
  });

  test('baseUrl 粘成完整接口路径 → error（七牛 FAQ 点名过这种错法）', () => {
    const issues = validateEndpoint(ep({ baseUrl: 'https://api.qnaigc.com/v1/chat/completions' }));
    assert.ok(has(issues, 'BASEURL_HAS_ENDPOINT_PATH'));
    assert.ok(hasBlocking(issues));
  });

  test('baseUrl 只写到域名根 → warn（能改就改，但自建网关确实可能没有版本段）', () => {
    assert.ok(has(validateEndpoint(ep({ baseUrl: 'https://api.qnaigc.com' })), 'BASEURL_MISSING_VERSION'));
    assert.equal(has(validateEndpoint(ep({ baseUrl: 'https://api.qnaigc.com/v1' })), 'BASEURL_MISSING_VERSION'), false);
    // 阿里云的兼容模式路径也不该被误报。
    assert.equal(
      has(validateEndpoint(ep({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' })), 'BASEURL_MISSING_VERSION'),
      false,
    );
  });

  test('Anthropic 协议不受 /v1 形状规则约束（那是 OpenAI 协议的约定）', () => {
    const issues = validateEndpoint(ep({ provider: 'claude', baseUrl: 'https://api.qnaigc.com', model: 'claude-x' }));
    assert.equal(has(issues, 'BASEURL_MISSING_VERSION'), false);
  });

  test('单价只填一半 → warn（整个模型不校准，成本会记 0）', () => {
    assert.ok(has(validateEndpoint(ep({ priceInput: 36, priceOutput: 0 })), 'PRICE_HALF_CONFIGURED'));
    assert.ok(has(validateEndpoint(ep({ priceInput: 0, priceOutput: 0 })), 'PRICE_MISSING'));
  });

  test('同名模型价格不一致 → warn（维持既有的确定性回退口径）', () => {
    const issues = validateEndpoint(ep({ model: 'claude-x' }), {
      siblingPrices: [{ priceInput: 30, priceOutput: 150, priceCachedInput: 0, priceCacheWrite: 0 }],
    });
    assert.ok(has(issues, 'PRICE_INCONSISTENT'));
  });

  test('同名模型价格一致（含缓存两档）→ 不报', () => {
    const issues = validateEndpoint(ep({ model: 'claude-x', priceCachedInput: 3.6, priceCacheWrite: 45 }), {
      siblingPrices: [{ priceInput: 36, priceOutput: 180, priceCachedInput: 3.6, priceCacheWrite: 45 }],
    });
    assert.equal(has(issues, 'PRICE_INCONSISTENT'), false);
  });

  test('model 不在 Key 的模型范围里 → warn（七牛 model groups）；没探测过则不报', () => {
    assert.ok(has(validateEndpoint(ep({ model: 'claude-x' }), { modelScope: ['a', 'b'] }), 'MODEL_OUT_OF_KEY_SCOPE'));
    assert.equal(has(validateEndpoint(ep({ model: 'claude-x' })), 'MODEL_OUT_OF_KEY_SCOPE'), false);
    assert.equal(has(validateEndpoint(ep({ model: 'a' }), { modelScope: ['a', 'b'] }), 'MODEL_OUT_OF_KEY_SCOPE'), false);
  });

  test('方言没固化 → info 提示可「确认固化」，但绝不拦', () => {
    const inferred = validateEndpoint(ep({ provider: 'claude', baseUrl: 'https://g', model: 'claude-x' }));
    assert.ok(has(inferred, 'DIALECT_INFERRED'));
    assert.equal(hasBlocking(inferred), false);
    const fixed = validateEndpoint(ep({ provider: 'claude', baseUrl: 'https://g', model: 'claude-x', dialect: 'anthropic_gateway' }));
    assert.equal(has(fixed, 'DIALECT_INFERRED'), false);
  });
});

describe('嵌入 / 重排：协议与厂商两条否决都要判', () => {
  const chatAnthropic = { provider: 'claude' as const, baseUrl: 'https://api.qnaigc.com', model: 'claude-x', hasKey: true };
  const chatQiniuOpenAI = { provider: 'openai' as const, baseUrl: 'https://api.qnaigc.com/v1', model: 'x', hasKey: true };
  const chatSilicon = { provider: 'openai' as const, baseUrl: 'https://api.siliconflow.cn/v1', model: 'x', hasKey: true };

  test('① 协议不符：对话端点走 Anthropic → 留空复用必被拦', () => {
    const issues = validateAuxEndpoint('embedding', { enabled: true, model: 'bge', baseUrl: '', hasKey: false }, chatAnthropic);
    assert.ok(has(issues, 'AUX_ORIGIN_PROTOCOL_MISMATCH'));
  });

  test('② 厂商没能力：七牛 OpenAI 入口协议完全合法，但仍必被拦', () => {
    // 这一条正是「只判协议」会漏掉的：api.qnaigc.com/v1 是标准 OpenAI 兼容，
    // /embeddings 路径拼得出来、格式也对，可七牛压根没有嵌入模型。
    const issues = validateAuxEndpoint('embedding', { enabled: true, model: 'bge', baseUrl: '', hasKey: false }, chatQiniuOpenAI);
    assert.ok(has(issues, 'AUX_VENDOR_UNSUPPORTED'));
    assert.equal(has(issues, 'AUX_ORIGIN_PROTOCOL_MISMATCH'), false, '这条不是协议问题，别报错成协议问题');
  });

  test('有嵌入能力的厂商 + 留空复用 → 放行（不误伤既有配置）', () => {
    const issues = validateAuxEndpoint('embedding', { enabled: true, model: 'bge', baseUrl: '', hasKey: false }, chatSilicon);
    assert.deepEqual(errs(issues), []);
  });

  test('显式填了独立网关与 Key → 两条否决都不适用', () => {
    const issues = validateAuxEndpoint(
      'embedding',
      { enabled: true, model: 'bge', baseUrl: 'https://api.siliconflow.cn/v1', hasKey: true },
      chatAnthropic,
    );
    assert.deepEqual(errs(issues), []);
  });

  test('没开启 → 一条都不报（关掉的东西不该有意见）', () => {
    assert.deepEqual(validateAuxEndpoint('embedding', { enabled: false, model: '', baseUrl: '', hasKey: false }, chatAnthropic), []);
  });

  test('开了却没填模型 → error', () => {
    const issues = validateAuxEndpoint('rerank', { enabled: true, model: '', baseUrl: 'https://x/v1', hasKey: true }, chatSilicon);
    assert.ok(has(issues, 'AUX_MODEL_REQUIRED'));
  });

  test('只留空 Key（网关填了）也算复用 → 同样要判', () => {
    const issues = validateAuxEndpoint(
      'embedding',
      { enabled: true, model: 'bge', baseUrl: 'https://api.siliconflow.cn/v1', hasKey: false },
      chatAnthropic,
    );
    assert.ok(has(issues, 'AUX_ORIGIN_PROTOCOL_MISMATCH'));
  });
});

describe('端点池成员一致性', () => {
  const m = (over: Partial<{ id: string; label: string; provider: 'claude' | 'openai' | 'mock'; baseUrl: string; model: string; dialect: string | null; hasKey: boolean }> = {}) => ({
    id: 'a', label: 'A', provider: 'claude' as const, baseUrl: 'https://api.qnaigc.com', model: 'claude-x', dialect: null, hasKey: true, ...over,
  });

  test('single 模式下不校验池（不配就是旧行为）', () => {
    assert.deepEqual(validateRoute({ mode: 'single' }, []), []);
  });

  test('空池 → error（开了分流却没成员 = 把 AI 关了）', () => {
    assert.ok(has(validateRoute({ mode: 'pool' }, []), 'POOL_EMPTY'));
  });

  test('混协议 → error，且报错里点名是谁', () => {
    const issues = validateRoute({ mode: 'pool' }, [
      m({ id: 'a', label: '七牛Anthropic' }),
      m({ id: 'b', label: '硅基OpenAI', provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' }),
    ]);
    assert.ok(has(issues, 'POOL_PROTOCOL_MISMATCH'));
    assert.match(blockingMessage(issues), /七牛Anthropic/);
    assert.match(blockingMessage(issues), /硅基OpenAI/);
  });

  test('同协议不同方言 → 只 info，不拦（官方直连 + 兼容网关混池是合法的）', () => {
    const issues = validateRoute({ mode: 'pool' }, [
      m({ id: 'a', dialect: 'anthropic_gateway' }),
      m({ id: 'b', label: 'B', baseUrl: '', dialect: 'anthropic_official' }),
    ]);
    assert.equal(hasBlocking(issues), false);
    assert.ok(has(issues, 'POOL_MIXED_DIALECTS'));
  });

  test('mock 入池 → error', () => {
    assert.ok(has(validateRoute({ mode: 'pool' }, [m({ provider: 'mock', baseUrl: '' })]), 'POOL_HAS_MOCK'));
  });

  test('没配 Key 的成员 → error（只会稳定失败并白耗一次故障转移配额）', () => {
    assert.ok(has(validateRoute({ mode: 'pool' }, [m(), m({ id: 'b', label: 'B', hasKey: false })]), 'POOL_MEMBER_NO_KEY'));
  });

  test('同协议同方言的正常池 → 干干净净', () => {
    const issues = validateRoute({ mode: 'pool' }, [
      m({ id: 'a', dialect: 'anthropic_gateway' }),
      m({ id: 'b', label: 'B', dialect: 'anthropic_gateway' }),
    ]);
    assert.deepEqual(issues, []);
  });

  test('判据是成员自身的方言，不是任何全局拷贝值', () => {
    // 两个成员的 provider 都是 claude，但一个被固化成 openai 协议的方言——
    // 历史实现按 AiSetting.provider 判，这种情况看不出来；按成员自身判就能。
    const issues = validateRoute({ mode: 'pool' }, [
      m({ id: 'a', dialect: 'anthropic_gateway' }),
      m({ id: 'b', label: 'B', dialect: 'openai_chat' }),
    ]);
    assert.ok(has(issues, 'POOL_PROTOCOL_MISMATCH'));
  });
});
