import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveAnswerPrompt, ARCHIVE_INTERVIEW_PROMPT } from './intents';

// 档案缺口的两种意图不能混：卡上显示哪条问题，点进对话就必须带哪条。
// 回归的是这个 bug：军令页第 0 号军令显示「你的公司、门店或品牌叫什么？」，
// 点进去却发批量话术「你先问我最关键的 1-3 个问题」，等于把用户刚点的那条丢了。

test('具体问题原样带进 prompt', () => {
  const q = '你的公司、门店或品牌叫什么？';
  const p = archiveAnswerPrompt(q);
  assert.ok(p.includes(q), '必须包含原问题，否则军师会重新再问一遍');
  assert.ok(!p.includes('1-3 个问题'), '不能退化成批量话术');
});

test('不同问题产出不同 prompt（每行各带各的）', () => {
  const a = archiveAnswerPrompt('以后军师怎么称呼你？');
  const b = archiveAnswerPrompt('你现在主要做哪个行业或品类？');
  assert.notEqual(a, b);
});

test('空问题退回批量话术，不发空指令', () => {
  assert.equal(archiveAnswerPrompt(''), ARCHIVE_INTERVIEW_PROMPT);
  assert.equal(archiveAnswerPrompt('   '), ARCHIVE_INTERVIEW_PROMPT);
});

test('两条话术彼此不同（聚合入口与具体问题不是一回事）', () => {
  assert.notEqual(archiveAnswerPrompt('你的公司叫什么？'), ARCHIVE_INTERVIEW_PROMPT);
});
