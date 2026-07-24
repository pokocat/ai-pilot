// 聊天回复泄漏类型化 section JSON 的三层修复中【第 2 层历史脱敏】【第 3 层读取端清洗】共用的
// 纯函数 scrubSectionJson，以及其在 loadConversationHistory / GET /sessions/:id 上的接线单测。
//   cd server && node --import tsx --test test/sectionScrub.test.ts
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scrubSectionJson } from '../src/llm/schema.js';
import { prisma } from '../src/db.js';
import { api, login, seedBaseline, cleanBusiness, closeApp, uniquePhone } from './helpers.js';
import { loadConversationHistory } from '../src/routes/sessions.js';

const PLACEHOLDER = '（此处曾呈结构化图表，内容略）';
const tenantOf = async (token: string) => (await prisma.user.findUnique({ where: { id: token } }))!.tenantId;

// 生产实证同形态样本：正常散文 + Markdown 标题，中段直插一段残缺 section JSON（缺开头 { ，末尾未闭合）。
const PROD_LEAK = `老板，先说结论。你和竞争对手的差距主要在渠道效率，牌面并不落下风。

## 牌面对比

["type":"matrix","h":"你和竞争对手的牌面对比","xLabels":["弱","强"],"yLabels":["低","高"],"quads":[{"title":"你方","items":["产品扎实"]},{"title":"对手","items":["渠道更广"]}`;

describe('scrubSectionJson · 纯函数各形态', () => {
  test('完整形态 [{"type":...}] 整段擦除，保留前后散文', () => {
    const t = '这是分析。[{"type":"stats","items":[{"num":"30","label":"门店"}]}] 以上。';
    const out = scrubSectionJson(t);
    assert.ok(out.includes('这是分析。'));
    assert.ok(out.includes('以上。'));
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes('"type"'), `不应残留 type：${out}`);
  });

  test('残缺形态 ["type":... （缺 { 且未闭合）擦到文本结尾', () => {
    const out = scrubSectionJson(PROD_LEAK);
    assert.ok(out.startsWith('老板，先说结论。'));
    assert.ok(out.includes('## 牌面对比'), '前置 Markdown 标题应保留');
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes('"type"'), `残缺片段应被吞净：${out}`);
    assert.ok(!out.includes('quads'), '残缺片段中段字段不应残留');
  });

  test('残缺片段后接空行 + 散文：只吞片段，保留后续正文', () => {
    const t = `前言。

["type":"gantt","rows":[{"label":"A","from":1,"to":4}

## 后续
后面还有正文分析。`;
    const out = scrubSectionJson(t);
    assert.ok(out.includes('前言。'));
    assert.ok(out.includes('## 后续'));
    assert.ok(out.includes('后面还有正文分析。'), '空行后的散文必须保留');
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes('gantt'));
  });

  test('裸对象序列 {"type":..},{"type":..} 连吞', () => {
    const t = '看这里：{"type":"callout","tone":"风险","h":"现金流","b":"紧"},{"type":"quote","text":"谋定后动"} 完。';
    const out = scrubSectionJson(t);
    assert.ok(out.includes('看这里：'));
    assert.ok(out.includes('完。'));
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes('"type"'), `裸序列应整体擦除：${out}`);
  });

  test('分隔符坏形态 "rows">[ / "type">"..." 仍能配平擦除', () => {
    const t = '排期：[{"type":"gantt","rows">[{"label":"A","from":1,"to":4}]}] 收工。';
    const out = scrubSectionJson(t);
    assert.ok(out.includes('排期：') && out.includes('收工。'));
    assert.ok(out.includes(PLACEHOLDER));
    assert.ok(!out.includes('rows'), `">" 坏分隔符不应阻碍配平：${out}`);
  });

  test('多块：一条消息里两段泄漏都被擦除', () => {
    const t = '甲 [{"type":"stats","items":[{"num":"1","label":"a"}]}] 乙 [{"type":"quote","text":"x"}] 丙';
    const out = scrubSectionJson(t);
    assert.equal(out.match(new RegExp(PLACEHOLDER, 'g'))?.length, 2, `应有两处占位：${out}`);
    assert.ok(out.includes('甲 ') && out.includes(' 乙 ') && out.includes(' 丙'));
    assert.ok(!out.includes('"type"'));
  });

  test('误伤防护：普通 JSON（type 值不在白名单）原样返回', () => {
    const t = '我在配置里看到 {"type":"object","name":"user","enabled":true}，这是什么意思？';
    assert.equal(scrubSectionJson(t), t);
  });

  test('误伤防护：散文里内联提到 "type":"table"（前非结构位）不擦', () => {
    const t = '他问 "type":"table" 这个字段是不是必填，我说看场景。';
    assert.equal(scrubSectionJson(t), t);
  });

  test('误伤防护：纯中文散文 / Markdown 表格原样返回', () => {
    const t = '老板，本月三个动作：\n\n| 动作 | 负责人 |\n| --- | --- |\n| 拉新 | 你 |\n\n先做拉新。';
    assert.equal(scrubSectionJson(t), t);
  });

  test('幂等：擦过一遍再擦结果不变', () => {
    const once = scrubSectionJson(PROD_LEAK);
    assert.equal(scrubSectionJson(once), once);
  });

  test('空串 / 无 type 走快路径原样返回', () => {
    assert.equal(scrubSectionJson(''), '');
    assert.equal(scrubSectionJson('就是一段普通回复，没有任何结构。'), '就是一段普通回复，没有任何结构。');
  });
});

describe('接线 · 历史脱敏 + 读取端清洗（连库）', () => {
  before(async () => {
    await cleanBusiness();
    await seedBaseline();
  });
  after(async () => {
    await closeApp();
  });

  test('loadConversationHistory：assistant 泄漏被脱敏，user 原文不动', async () => {
    const userId = await login(uniquePhone(), '脱敏甲');
    const tenantId = await tenantOf(userId);
    const session = await prisma.session.create({ data: { tenantId, userId, agentKey: 'general', title: '脱敏历史' } });
    const base = Date.now() - 10_000;
    await prisma.message.create({ data: { sessionId: session.id, role: 'user', contentJson: { text: '帮我看看我和对手的牌面 ["type":"table" 之类的对比' }, createdAt: new Date(base) } });
    await prisma.message.create({ data: { sessionId: session.id, role: 'assistant', contentJson: { text: PROD_LEAK }, createdAt: new Date(base + 1_000) } });

    const { history } = await loadConversationHistory(session.id, '__none__', '接着聊');
    const asst = history.find((m) => m.role === 'assistant');
    const usr = history.find((m) => m.role === 'user');
    assert.ok(asst, '应载入 assistant 历史');
    assert.ok(asst!.text.includes(PLACEHOLDER), 'assistant 泄漏应被占位');
    assert.ok(!asst!.text.includes('quads'), 'assistant 历史不应再含 section JSON');
    // user 原文里内联的 "type":"table" 属散文提及，不结构化，不应被脱敏。
    assert.ok(usr!.text.includes('"type":"table"'), 'user 原文应原样保留');
  });

  test('GET /sessions/:id：读取端对 assistant 存量泄漏做清洗（含 ["type" 残缺）', async () => {
    const userId = await login(uniquePhone(), '读取清洗甲');
    const tenantId = await tenantOf(userId);
    const session = await prisma.session.create({ data: { tenantId, userId, agentKey: 'general', title: '读取清洗' } });
    await prisma.message.create({ data: { sessionId: session.id, role: 'user', contentJson: { text: '牌面对比给我看看' } } });
    const leaked = await prisma.message.create({ data: { sessionId: session.id, role: 'assistant', contentJson: { text: PROD_LEAK } } });

    const res = await api('GET', `/api/sessions/${session.id}`, { token: userId });
    assert.equal(res.status, 200);
    const asst = res.body.messages.find((m: { role: string }) => m.role === 'assistant');
    assert.ok(asst, '响应应含 assistant 消息');
    assert.ok(asst.content.text.includes(PLACEHOLDER), '读取时应替换为占位句');
    assert.ok(!asst.content.text.includes('"type"'), `读取响应不应含 section JSON：${asst.content.text}`);
    assert.ok(asst.content.text.includes('## 牌面对比'), '正常散文/标题应保留');

    // DB 原始数据不改（读时清洗）。
    const raw = await prisma.message.findUnique({ where: { id: leaked.id } });
    assert.ok((raw!.contentJson as { text: string }).text.includes('quads'), '落库数据应保持原样未被改写');
  });
});
