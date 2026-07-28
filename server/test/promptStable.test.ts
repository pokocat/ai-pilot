// stable 段必须真的稳定 —— 纯单元测试（不连库、不联网）。
//   cd server && node --import tsx --test test/promptStable.test.ts
//
// 提示词缓存是前缀匹配：`cache_control` 断点之前的字节变一个，整段前缀就失效。stable 段在断点
// 之前，所以往里填「本轮用户消息 / 本轮 RAG 召回 / 逐渐累积的长期记忆」等于每轮换一份前缀。
//
// 2026-07-28 登生产核对：strat/growth 的底座含 {长期记忆}、intel 含 {知识库}+{引用资料}，
// 这三个 agent 的缓存命中率恒为 0；主力 general 不含，大头流量未受影响。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemParts, type GenContext } from '../src/llm/schema.js';

function ctxOf(over: Partial<GenContext> = {}): GenContext {
  return {
    agentKey: 'strat',
    systemPrompt: '',
    userMessage: '本轮问题',
    history: [],
    memories: [],
    understanding: [],
    benmingColor: '青',
    companyName: '某公司',
    ...over,
  } as unknown as GenContext;
}

// 逐轮变化的两轮上下文：只有「本轮才变」的字段不同，客户档案等稳定字段保持一致。
const TURN_A = ctxOf({ userMessage: '第一轮问题', memories: ['记忆一'], knowledge: ['召回A'], references: ['引用A'] });
const TURN_B = ctxOf({ userMessage: '第二轮问题', memories: ['记忆一', '记忆二'], knowledge: ['召回B'], references: ['引用B'] });

describe('stable 段跨轮必须逐字节一致', () => {
  for (const ph of ['{长期记忆}', '{知识库}', '{引用资料}', '{用户消息}']) {
    test(`底座含 ${ph} 时，stable 段仍然稳定`, () => {
      const base = `你是战略顾问。参考：${ph}。请作答。`;
      const a = buildSystemParts(base, TURN_A, 'chat').stable;
      const b = buildSystemParts(base, TURN_B, 'chat').stable;
      assert.equal(a, b, `stable 段随轮次变化 → 该 agent 提示词缓存永不命中（占位符 ${ph}）`);
    });
  }

  test('多个逐轮占位符同时出现也稳定（intel 的真实形态）', () => {
    const base = '你是情报官。知识库：{知识库}。引用：{引用资料}。';
    assert.equal(
      buildSystemParts(base, TURN_A, 'chat').stable,
      buildSystemParts(base, TURN_B, 'chat').stable,
    );
  });

  test('稳定占位符仍然被正常填充（不能把该填的也剥掉）', () => {
    const { stable } = buildSystemParts('客户：{客户名}。', TURN_A, 'chat');
    assert.match(stable, /某公司/);
    assert.doesNotMatch(stable, /\{客户名\}/);
  });

  test('降级后 stable 段不残留占位符原文', () => {
    const { stable } = buildSystemParts('记忆：{长期记忆}。', TURN_A, 'chat');
    assert.doesNotMatch(stable, /\{长期记忆\}/, '残留原文会被模型当成字面量读出来');
  });
});

describe('内容不能丢 —— 剥离只是换段落，不是删除', () => {
  // {长期记忆} 是记忆进入提示词的唯一通道（没有独立 dynamic 块），剥离后必须在 dynamic 补回。
  test('底座用了 {长期记忆} → 记忆出现在 dynamic 段', () => {
    const { dynamic } = buildSystemParts('记忆：{长期记忆}。', TURN_B, 'chat');
    assert.match(dynamic, /记忆一/);
    assert.match(dynamic, /记忆二/);
  });

  test('底座没用 {长期记忆} → 不给它凭空加一段（保持既有 agent 行为不变）', () => {
    const { dynamic } = buildSystemParts('你是顾问，请作答。', TURN_B, 'chat');
    assert.doesNotMatch(dynamic, /【长期记忆】/);
  });

  test('知识库与引用资料本就在 dynamic 段，剥离不会丢内容', () => {
    const { dynamic } = buildSystemParts('知识：{知识库}。引用：{引用资料}。', TURN_A, 'chat');
    assert.match(dynamic, /召回A/);
    assert.match(dynamic, /引用A/);
  });

  test('stable 段留下的是指针，能让模型知道内容在后面', () => {
    const { stable } = buildSystemParts('知识：{知识库}。', TURN_A, 'chat');
    assert.match(stable, /参考资料/, '不能只是删掉——那样模型会以为这一项缺失');
  });
});

describe('不含逐轮占位符的底座（general 的形态）不受影响', () => {
  test('stable 段稳定且内容原样', () => {
    const base = '你是总军师。客户：{客户名}。行业基准：{行业基准}。';
    const a = buildSystemParts(base, TURN_A, 'chat');
    const b = buildSystemParts(base, TURN_B, 'chat');
    assert.equal(a.stable, b.stable);
    assert.match(a.stable, /总军师/);
  });
});
