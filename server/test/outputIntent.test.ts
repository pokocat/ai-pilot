import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequestedOutput, wantsDeliverableRequest } from '../src/services/outputIntent.js';

test('明确生成请求进入报告形态', () => {
  for (const text of ['帮我出一个方案', '给我一份诊断报告', '整理成会议纪要', '转成军令', '生成一份宣传文案']) {
    assert.equal(resolveRequestedOutput(text), 'report', text);
    assert.equal(wantsDeliverableRequest(text), true, text);
  }
});

test('否定交付意图优先，保持正常聊天', () => {
  for (const text of ['先别出报告，我们聊清楚', '不用生成方案，先分析原因', '暂时不需要做一份计划', '只聊聊就行', '先讨论一下']) {
    assert.equal(resolveRequestedOutput(text), 'chat', text);
  }
});

test('用户明确翻转刚才的否定时，以新指令为准', () => {
  assert.equal(resolveRequestedOutput('先别出报告——不过我改主意了，现在直接给我出一份报告'), 'report');
});

test('谈到报告或方案不等于请求生成', () => {
  for (const text of ['这个报告的问题在哪里？', '我们聊聊方案的取舍', '你怎么看昨天那份计划', '报告和方案有什么区别']) {
    assert.equal(resolveRequestedOutput(text), 'unspecified', text);
  }
});
