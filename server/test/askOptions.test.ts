// 军师反问选项协议：extractAsks 从回复尾部解析 ```ask 块 → ChatReply.asks（纯函数，零 I/O）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAsks } from '../src/llm/schema.ts';

test('extractAsks：尾部 ask 块解析为结构化问题+选项，并从正文剥离', () => {
  const text = '好，我先问清楚。\n你现在主要做哪个行业？\n\n```ask\n[{"q":"你现在主要做哪个行业？","options":["餐饮","电商零售","本地服务"]}]\n```';
  const r = extractAsks(text);
  assert.equal(r.text, '好，我先问清楚。\n你现在主要做哪个行业？');
  assert.deepEqual(r.asks, [{ q: '你现在主要做哪个行业？', options: ['餐饮', '电商零售', '本地服务'] }]);
});

test('extractAsks：多问题各带选项（访谈模式一次三问）', () => {
  const block = JSON.stringify([
    { q: '做什么行业？', options: ['餐饮', '零售'] },
    { q: '什么阶段？', options: ['刚起步', '在增长', '遇到瓶颈'] },
    { q: '最卡什么？', options: ['获客', '现金流'] },
  ]);
  const r = extractAsks(`三个问题：\n\n\`\`\`ask\n${block}\n\`\`\`\n`);
  assert.equal(r.asks?.length, 3);
  assert.equal(r.text, '三个问题：');
});

test('extractAsks：无 ask 块原样返回，不误伤正文中的普通代码块', () => {
  const text = '示例代码：\n```js\nconsole.log(1)\n```\n以上。';
  const r = extractAsks(text);
  assert.equal(r.text, text);
  assert.equal(r.asks, undefined);
});

test('extractAsks：JSON 非法时块仍被剥离（不把原始 JSON 漏给用户），asks 为空', () => {
  const r = extractAsks('先问一句。\n```ask\n[{"q":"坏的 json",]\n```');
  assert.equal(r.text, '先问一句。');
  assert.equal(r.asks, undefined);
});

test('extractAsks：选项不足 2 项 / q 为空的条目被丢弃；超长裁剪到 4 项选项、4 个问题', () => {
  const block = JSON.stringify([
    { q: '只有一个选项', options: ['唯一'] },
    { q: '', options: ['a', 'b'] },
    { q: '正常问题', options: ['a', 'b', 'c', 'd', 'e', 'f'] },
  ]);
  const r = extractAsks(`问：\n\`\`\`ask\n${block}\n\`\`\``);
  assert.equal(r.asks?.length, 1);
  assert.deepEqual(r.asks![0], { q: '正常问题', options: ['a', 'b', 'c', 'd'] });
});
