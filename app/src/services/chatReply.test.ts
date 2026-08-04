import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { asReply, replyToText } from './chatReply.js';

describe('asReply 收口落库回复', () => {
  test('正常形状原样过', () => {
    assert.deepEqual(asReply({ text: '结论是收缩', points: ['先看现金流'] }), {
      text: '结论是收缩',
      points: ['先看现金流'],
    });
  });

  test('整条不是对象 / 缺 text 也要给出可渲染形状（否则渲染期整页白屏）', () => {
    assert.deepEqual(asReply(null), { text: '' });
    assert.deepEqual(asReply('不是对象'), { text: '' });
    assert.deepEqual(asReply({}), { text: '' });
    assert.deepEqual(asReply({ text: 42 }), { text: '42' });
  });

  test('points / asks 不是数组时丢弃，不带进渲染期', () => {
    assert.deepEqual(asReply({ text: 'x', points: '不是数组' }), { text: 'x' });
    assert.deepEqual(asReply({ text: 'x', asks: '不是数组' }), { text: 'x' });
  });

  test('asks 逐项保证 options 是数组', () => {
    assert.deepEqual(asReply({ text: 'x', asks: [{ q: '选哪个', options: null }] }), {
      text: 'x',
      asks: [{ q: '选哪个', options: [] }],
    });
  });

  test('truncated 必须还原：退出重进后那条回复仍要带「继续写完」入口', () => {
    assert.equal(asReply({ text: '写到一半', truncated: true }).truncated, true);
  });

  test('只认布尔 true —— 存量脏数据不能被误判成未写完', () => {
    for (const v of ['false', 'true', 1, 0, null, undefined, {}]) {
      assert.equal(asReply({ text: 'x', truncated: v }).truncated, undefined, `truncated=${JSON.stringify(v)}`);
    }
  });

  test('正常写完的回复不带 truncated 字段（不是 false，是没有）', () => {
    assert.equal('truncated' in asReply({ text: '写完了' }), false);
  });
});

describe('replyToText', () => {
  test('正文 + 要点拼成一段', () => {
    assert.equal(replyToText({ text: '正文', points: ['要点一', '要点二'] }), '正文\n\n要点一\n\n要点二');
  });

  test('缺字段不炸', () => {
    assert.equal(replyToText({ text: '' }), '');
    assert.equal(replyToText({ text: '只有正文' }), '只有正文');
  });
});
