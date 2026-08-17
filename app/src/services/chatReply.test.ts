import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { asReply, attachmentOnlyPrompt, replyToText } from './chatReply.js';

describe('asReply 收口落库回复', () => {
  test('正常形状原样过', () => {
    assert.deepEqual(asReply({ text: '结论是收缩', points: ['先看现金流'] }), {
      text: '结论是收缩',
      points: ['先看现金流'],
    });
  });

  test('保留可重新展开的公开思路摘要', () => {
    assert.deepEqual(asReply({ text: '先守现金流。', thoughtSummary: '先核对现金流，再判断扩张节奏。' }), {
      text: '先守现金流。',
      thoughtSummary: '先核对现金流，再判断扩张节奏。',
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

  test('历史回复里的 asks 裸 JSON 只保留问答卡，不再显示协议代码', () => {
    const asks = [
      { q: '每月刚性生活支出大概多少？', options: ['1万以下', '1-2万', '2-3万', '3万以上'] },
      { q: '你打算做哪个市场？', options: ['A股', '美股', '加密货币', '期货/商品'] },
    ];
    const reply = asReply({ text: `还有两个问题。\n\n${JSON.stringify(asks)}`, asks });
    assert.equal(reply.text, '还有两个问题。');
    assert.deepEqual(reply.asks, asks);
  });

  test('与问答卡不一致的业务 JSON 不误删', () => {
    const asks = [{ q: '选哪个？', options: ['A', 'B'] }];
    const text = '数据样例：\n[{"q":"字段说明","options":["一","二"]}]';
    assert.equal(asReply({ text, asks }).text, text);
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

describe('attachmentOnlyPrompt', () => {
  test('单份文件与多份资料生成自然请求', () => {
    assert.equal(attachmentOnlyPrompt([{ kind: 'knowledge', label: '现金流.xlsx' }]), '请通读我附上的《现金流.xlsx》，先概括重点，再告诉我最值得注意的判断。');
    assert.match(attachmentOnlyPrompt([{ kind: 'knowledge', label: 'A.pdf' }, { kind: 'knowledge', label: 'B.docx' }]), /2份资料/);
  });
  test('单张图片使用看图口径，空引用不伪造文字', () => {
    assert.match(attachmentOnlyPrompt([{ kind: 'image', label: '对话图片' }]), /请看我附上的图片/);
    assert.equal(attachmentOnlyPrompt([]), '');
  });
});
