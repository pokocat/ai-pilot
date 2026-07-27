// 辅助档（aux tier）配置解析 — 纯单元测试（不连库、不联网）。
//   cd server && node --import tsx --test test/aiAuxConfig.test.ts
//
// 背景：一条用户消息实际触发 3–4 次模型调用（主生成 + extractInsights + extractProphecies
// + 首条的 summarizeSessionTitle），原来全走同一个 getAiConfig()，后台抽取占掉了上游 8 个槽位
// 里的 2–3 个。辅助档把抽取切到小模型；配了独立账号时还切到独立并发车道。
//
// 最重要的一条约定：**未配 AI_AUX_MODEL 时必须原样返回主配置**——对话与成果生成的行为
// 一个字节都不能变。
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuxConfig, auxConfigured, type ResolvedAiConfig } from '../src/services/aiConfig.js';

const ENV_KEYS = ['AI_AUX_MODEL', 'AI_AUX_BASE_URL', 'AI_AUX_API_KEY', 'AI_AUX_PROVIDER', 'AI_AUX_TIMEOUT_MS', 'AI_AUX_TEMPERATURE'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

const main: ResolvedAiConfig = {
  provider: 'claude', label: 'Claude', baseUrl: '', model: 'claude-opus-4-6',
  apiKey: 'sk-main-key', embeddingModel: '', temperature: 0.7, timeoutMs: 60_000,
  embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
  rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
};

describe('未配置时零副作用', () => {
  test('未配 AI_AUX_MODEL → 原样返回主配置对象本身（引用相等）', () => {
    const out = resolveAuxConfig(main);
    assert.equal(out, main, '必须是同一个对象引用，调用方据此判断「没走辅助档」');
    assert.equal(auxConfigured(), false);
  });

  test('AI_AUX_MODEL 为空串也算未配置', () => {
    process.env.AI_AUX_MODEL = '  ';
    assert.equal(resolveAuxConfig(main), main);
    assert.equal(auxConfigured(), false);
  });
});

describe('只换模型（同账号）', () => {
  test('切模型但车道仍是 main —— 配额本来就共享，分两个计数器等于把限额悄悄放大一倍', () => {
    process.env.AI_AUX_MODEL = 'claude-haiku-4-5';
    const aux = resolveAuxConfig(main);
    assert.notEqual(aux, main);
    assert.equal(aux.model, 'claude-haiku-4-5');
    assert.equal(aux.lane, 'main', '同账号必须共用 main 车道');
    assert.equal(aux.apiKey, main.apiKey, '未指定 key 时沿用主 key');
    assert.equal(aux.provider, main.provider);
  });

  test('temperature 归零：抽取要的是可解析的结构，不是文采', () => {
    process.env.AI_AUX_MODEL = 'x';
    assert.equal(resolveAuxConfig(main).temperature, 0);
  });

  test('超时收紧到不超过主档：抽取拖长了既占车道又没人等结果', () => {
    process.env.AI_AUX_MODEL = 'x';
    assert.ok(resolveAuxConfig(main).timeoutMs <= main.timeoutMs);
  });
});

describe('独立账号 → 独立车道', () => {
  test('给了 baseUrl 就切 aux 车道，并推断 provider=openai', () => {
    process.env.AI_AUX_MODEL = 'qwen-turbo';
    process.env.AI_AUX_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const aux = resolveAuxConfig(main);
    assert.equal(aux.lane, 'aux');
    assert.equal(aux.provider, 'openai');
    assert.equal(aux.baseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
  });

  test('给了独立 key 也切 aux 车道，且不继承主档的解密失败标记', () => {
    process.env.AI_AUX_MODEL = 'x';
    process.env.AI_AUX_API_KEY = 'sk-aux-key';
    const aux = resolveAuxConfig({ ...main, keyDecryptFailed: true });
    assert.equal(aux.lane, 'aux');
    assert.equal(aux.apiKey, 'sk-aux-key');
    assert.equal(aux.keyDecryptFailed, false, '换过 key 就不该被主 key 的故障连累');
  });

  test('AI_AUX_PROVIDER 可显式覆盖推断结果', () => {
    process.env.AI_AUX_MODEL = 'x';
    process.env.AI_AUX_BASE_URL = 'https://example.com/v1';
    process.env.AI_AUX_PROVIDER = 'claude';
    assert.equal(resolveAuxConfig(main).provider, 'claude');
  });
});

describe('不动主路径', () => {
  test('辅助档不修改传入的主配置对象', () => {
    process.env.AI_AUX_MODEL = 'small';
    process.env.AI_AUX_API_KEY = 'sk-aux';
    const before = JSON.stringify(main);
    resolveAuxConfig(main);
    assert.equal(JSON.stringify(main), before, '主配置必须原封不动——对话与成果生成还要用它');
  });
});
