// 纯文本口径：模型写的行内 Markdown 不能漏进「只当纯文本渲染」的位。
// 起因（2026-08-09 真机实拍）：首页「军师判断 · 主要矛盾」整条显示成 `==你现在的主要矛盾……==`。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainText, plainLine } from '../src/services/plainText.ts';

test('高亮语法 == 必须洗掉：它不是 CommonMark，端上任何渲染路径都只会显示成四个字符', () => {
  assert.equal(
    plainText('==你现在的主要矛盾不是「该攻该守该等」，而是「看不清自己手里有什么牌」。=='),
    '你现在的主要矛盾不是「该攻该守该等」，而是「看不清自己手里有什么牌」。',
  );
});

test('加粗/斜体/删除/行内代码/标题/引用一并去壳留字', () => {
  assert.equal(plainText('**现金流**是命门'), '现金流是命门');
  assert.equal(plainText('***全都要***'), '全都要');
  assert.equal(plainText('这是*重点*内容'), '这是重点内容');
  assert.equal(plainText('~~不要做~~换个打法'), '不要做换个打法');
  assert.equal(plainText('先看 `毛利率` 再谈扩张'), '先看 毛利率 再谈扩张');
  assert.equal(plainText('## 主要矛盾'), '主要矛盾');
  assert.equal(plainText('> 军师按'), '军师按');
});

test('链接与图片只留可读文字：纯文本位点不了 URL', () => {
  assert.equal(plainText('详见[三步走方案](https://x.test/a)'), '详见三步走方案');
  assert.equal(plainText('![封面图](https://x.test/a.png)'), '封面图');
});

test('列表符号与正文里的裸星号不动：洗过头会把分条粘成一坨', () => {
  assert.equal(plainText('- 第一条\n- 第二条'), '- 第一条\n- 第二条');
  assert.equal(plainText('毛利 30% * 单量'), '毛利 30% * 单量');
});

test('plainLine 压成一行并可截断：<text> 里换行会撑成半屏', () => {
  assert.equal(plainLine('**结论**\n第二行\n第三行'), '结论 第二行 第三行');
  assert.equal(plainLine('一二三四五六七八九十', 4), '一二三四');
});

test('空值安全：null/undefined/空串一律回空串，不抛也不返回 "null"', () => {
  assert.equal(plainText(null), '');
  assert.equal(plainText(undefined), '');
  assert.equal(plainLine(''), '');
});
