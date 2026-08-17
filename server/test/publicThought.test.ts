import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPublicThought, PublicThoughtStreamParser } from '../src/llm/publicThought.ts';
import { CHAT_TAIL_DIRECTIVE } from '../src/llm/schema.ts';

test('extractPublicThought：只剥离回复开头的公开摘要', () => {
  const result = extractPublicThought(`\n<public_thought>\n先核对现金流，再判断增长动作。\n</public_thought>\n\n结论：先收缩。`);
  assert.deepEqual(result, {
    thoughtSummary: '先核对现金流，再判断增长动作。',
    text: '结论：先收缩。',
  });
  const middle = '正文讨论 <public_thought> 标签，不应被剥离。';
  assert.deepEqual(extractPublicThought(middle), { text: middle });
});

test('PublicThoughtStreamParser：标签任意切块时摘要与正文仍进入独立通道', () => {
  const parser = new PublicThoughtStreamParser();
  const chunks = ['\n<pub', 'lic_thought>先核对', '事实，再取舍。</public_', 'thought>结论先行。'];
  const events = chunks.flatMap((chunk) => parser.push(chunk)).concat(parser.finish());
  assert.equal(events.filter((event) => event.type === 'thought_delta').map((event) => event.text).join(''), '先核对事实，再取舍。');
  assert.equal(events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), '结论先行。');
});

test('PublicThoughtStreamParser：未使用协议时不吞字、不延迟整段', () => {
  const parser = new PublicThoughtStreamParser();
  const events = [...parser.push('直接回答'), ...parser.push('即可。'), ...parser.finish()];
  assert.equal(events.map((event) => event.text).join(''), '直接回答即可。');
  assert.ok(events.every((event) => event.type === 'delta'));
});

test('公开摘要异常超长时只展示安全上限，正文仍完整通过', () => {
  const parser = new PublicThoughtStreamParser();
  const events = parser.push(`<public_thought>${'想'.repeat(900)}</public_thought>正文`);
  assert.equal(events.filter((event) => event.type === 'thought_delta').map((event) => event.text).join('').length, 600);
  assert.equal(events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), '正文');
  assert.equal(extractPublicThought(`<public_thought>${'想'.repeat(900)}</public_thought>正文`).thoughtSummary?.length, 600);
});

test('CHAT_TAIL_DIRECTIVE：明确公开摘要不是隐藏思维链', () => {
  assert.match(CHAT_TAIL_DIRECTIVE, /公开思路摘要协议/);
  assert.match(CHAT_TAIL_DIRECTIVE, /严禁披露隐藏推理、逐步思维链/);
  assert.match(CHAT_TAIL_DIRECTIVE, /<public_thought>\.\.\.<\/public_thought>/);
});
