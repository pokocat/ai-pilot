// 军师反问选项协议：extractAsks 从回复尾部解析 ```ask 块 → ChatReply.asks（纯函数，零 I/O）。
// 另含兜底抽取用到的两块：normalizeAsks（与 extractAsks 共用的归一化口径）、looksLikeAsking（触发闸门）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAsks, looksLikeAsking, normalizeAsks, CHAT_TAIL_DIRECTIVE } from '../src/llm/schema.ts';

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

test('extractAsks：模型漏掉 ask 围栏时，裸 JSON 数组不再泄漏到正文', () => {
  const payload = JSON.stringify([
    { q: '每月刚性生活支出大概多少？', options: ['1万以下', '1-2万', '2-3万', '3万以上'] },
    { q: '你打算做哪个市场？', options: ['A股', '美股', '加密货币', '期货/商品'] },
  ]);
  const r = extractAsks(`还有两个问题需要你回答。\n\n${payload}`);
  assert.equal(r.text, '还有两个问题需要你回答。');
  assert.equal(r.asks?.length, 2);
  assert.equal(r.asks?.[0].q, '每月刚性生活支出大概多少？');
});

test('extractAsks：json 围栏与 {asks:[]} 包装均可收口', () => {
  const payload = JSON.stringify({ asks: [{ q: '现在最缺什么？', options: ['现金流', '客户', '团队'] }] });
  const r = extractAsks(`先答这一题。\n\n\`\`\`json\n${payload}\n\`\`\``);
  assert.equal(r.text, '先答这一题。');
  assert.deepEqual(r.asks, [{ q: '现在最缺什么？', options: ['现金流', '客户', '团队'] }]);
});

test('extractAsks：普通业务 JSON 与行内数组不误删', () => {
  const business = '接口示例：\n```json\n{"revenue":100,"cost":60}\n```';
  assert.equal(extractAsks(business).text, business);
  const inline = '你可以把配置写成 [{"q":"字段名","options":["a","b"]}] 作为示例。';
  assert.equal(extractAsks(inline).text, inline);
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

// —— 兜底抽取（gateway.recoverAsks）依赖的两块纯逻辑 ——
// 兜底和协议解析必须共用同一把裁剪尺子，否则「模型给的」与「事后补抽的」端上表现会不一致。
test('normalizeAsks：与 extractAsks 同一口径（裁剪 4×4、丢弃残缺项、非数组返回 undefined）', () => {
  assert.equal(normalizeAsks(null), undefined);
  assert.equal(normalizeAsks({ q: '不是数组' }), undefined);
  assert.equal(normalizeAsks([{ q: '选项不够', options: ['一个'] }]), undefined);
  const many = normalizeAsks(Array.from({ length: 6 }, (_, i) => ({ q: `问题${i}`, options: ['a', 'b'] })));
  assert.equal(many?.length, 4);
  // question 别名与逐项长度裁剪都要跟 extractAsks 一致
  const aliased = normalizeAsks([{ question: '别名字段', options: ['x'.repeat(40), 'y'] }]);
  assert.equal(aliased?.[0].q, '别名字段');
  assert.equal(aliased?.[0].options[0].length, 24);
});

test('looksLikeAsking：只看尾部——结尾提问命中，中段修辞反问不命中', () => {
  // 线上那条 2845 字长回复的真实形态：问题在倒数第二段，后面还跟两句陈述收尾。
  assert.equal(looksLikeAsking('客户找你做得最多的是哪一种图？\n\n这个答案决定你的MVP砍成什么形状。答完我帮你画产品骨架。'), true);
  // 中段反问 + 长尾陈述：不该触发兜底抽取（白烧一次调用）
  const rhetorical = `你以为这是产品问题？其实是渠道问题。${'先把渠道盘清楚再谈产品迭代。'.repeat(30)}`;
  assert.equal(looksLikeAsking(rhetorical), false);
  assert.equal(looksLikeAsking(''), false);
});

// 提示词装配的回归闸：ask 协议必须在尾部指令里、且排在体例约束之后（位置就是这次修的东西）。
test('CHAT_TAIL_DIRECTIVE：含提问选项协议，且排在体例约束之后', () => {
  const styleIdx = CHAT_TAIL_DIRECTIVE.indexOf('真人教练或老朋友');
  const askIdx = CHAT_TAIL_DIRECTIVE.indexOf('提问选项协议');
  assert.ok(styleIdx >= 0, '体例约束应在尾部指令内');
  assert.ok(askIdx > styleIdx, 'ask 协议必须排在体例约束之后（靠近生成点）');
  // 「严禁 JSON」那条必须显式豁免 ask 块，否则它就是在禁止下面这份协议
  assert.match(CHAT_TAIL_DIRECTIVE, /唯一例外是下面「提问选项协议」规定的 ```ask 块/);
  // 长回复丢块是线上实测的主要失败形态，复查指令不能被后续改动删掉
  assert.match(CHAT_TAIL_DIRECTIVE, /长回复（含表格、分段、多标题的回复）同样不能省/);
  assert.match(CHAT_TAIL_DIRECTIVE, /不要写成机构公文、客服话术或通用 AI 模板/);
  assert.match(CHAT_TAIL_DIRECTIVE, /哪里做得好、哪里有风险、为什么/);
  assert.match(CHAT_TAIL_DIRECTIVE, /事实之间的联系、反常识判断或更深一层的因果/);
});
