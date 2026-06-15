// 提示词模块化单元测试：标记解析 + 按 kind/关键词挑选生效模块。
//   cd server && node --import tsx --test test/promptAssembly.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parsePromptModules, selectModuleText } from '../src/llm/promptAssembly.js';

const PROMPT = [
  '你是军师，核心人设与路由规则。',
  '===MODULE deliverable===',
  'A级报告 HTML 规范 + 自检清单（只在产出时用）。',
  '===MODULE keyword:什么时候,择时,签约===',
  '决策择时模块（用户问时间时才用）。',
].join('\n');

describe('parsePromptModules', () => {
  test('切出底座 + 两个模块', () => {
    const { base, modules } = parsePromptModules(PROMPT);
    assert.equal(base, '你是军师，核心人设与路由规则。');
    assert.equal(modules.length, 2);
    assert.deepEqual(modules[0].cond, { type: 'deliverable' });
    assert.deepEqual(modules[1].cond, { type: 'keyword', words: ['什么时候', '择时', '签约'] });
  });

  test('无标记 → 整段是底座、零模块', () => {
    const r = parsePromptModules('普通提示词，没有任何标记。');
    assert.equal(r.base, '普通提示词，没有任何标记。');
    assert.equal(r.modules.length, 0);
  });
});

describe('selectModuleText', () => {
  test('chat 且无关键词 → 只底座，不带 deliverable/keyword 模块', () => {
    const { base, active } = selectModuleText(PROMPT, { kind: 'chat', userMessage: '帮我看下增长' });
    assert.match(base, /核心人设/);
    assert.equal(active, '');
  });

  test('deliverable → 注入 HTML 规范模块', () => {
    const { active } = selectModuleText(PROMPT, { kind: 'deliverable', userMessage: '出个报告' });
    assert.match(active, /HTML 规范/);
    assert.doesNotMatch(active, /决策择时/); // 关键词没命中
  });

  test('chat 但命中关键词 → 注入择时模块', () => {
    const { active } = selectModuleText(PROMPT, { kind: 'chat', userMessage: '什么时候签合同最好' });
    assert.match(active, /决策择时/);
    assert.doesNotMatch(active, /HTML 规范/); // 非 deliverable
  });

  test('deliverable + 命中关键词 → 两个模块都注入', () => {
    const { active } = selectModuleText(PROMPT, { kind: 'deliverable', userMessage: '择时报告' });
    assert.match(active, /HTML 规范/);
    assert.match(active, /决策择时/);
  });

  test('无标记提示词 → active 空、base 原样', () => {
    const { base, active } = selectModuleText('纯提示词', { kind: 'deliverable', userMessage: 'x' });
    assert.equal(base, '纯提示词');
    assert.equal(active, '');
  });
});
