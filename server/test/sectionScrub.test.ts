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

  // —— 回归：当轮直出（/generate-sync、/generate SSE）此前遗漏脱敏 ——
  // 三层修复原文档只提到「历史脱敏」+「GET /sessions/:id 读取端清洗」，两者都只在「后续轮 / 刷新重进」
  // 才生效；当轮生成完毕直接下发给客户端的完整回复（sync 的 body.reply、SSE 的 event: chat）此前是
  // 模型原始输出，未经脱敏——用户在生成的当下就已经看到满屏 JSON 源码，而非要等下次打开会话才看见。
  // 用 per-agent runtime openai 覆盖 + fetch 打桩模拟模型泄漏，验证两条直出路径都已接上同一 scrub。
  {
    const realFetch = globalThis.fetch;
    const makeGeneralOpenai = () => prisma.agent.update({
      where: { key: 'general' },
      data: { providerMode: 'openai', apiBaseUrl: 'http://mock.test/v1', apiModel: 'mock-model', apiKey: 'sk-test-real-123' },
    });
    const resetGeneral = () => prisma.agent.update({
      where: { key: 'general' },
      data: { providerMode: 'inherit', apiBaseUrl: null, apiModel: null, apiKey: null },
    });

    test('/generate-sync：当轮直出的 reply.text 已脱敏，不用等刷新重进才干净', async () => {
      process.env.AI_ALLOW_REAL_PROVIDER = '1'; // 放行 per-agent 真实 openai 代码路径（fetch 仍打桩）
      await makeGeneralOpenai();
      globalThis.fetch = (async (url: unknown) => {
        if (!String(url).includes('/chat/completions')) throw new Error(`unexpected fetch: ${url}`);
        return {
          ok: true, status: 200,
          json: async () => ({ choices: [{ message: { content: PROD_LEAK } }], usage: { prompt_tokens: 12, completion_tokens: 40 } }),
        } as unknown as Response;
      }) as unknown as typeof fetch;
      try {
        const userId = await login(uniquePhone(), '当轮直出甲');
        const r = await api('POST', '/api/generate-sync', { token: userId, body: { text: '牌面对比给我看看', agentKey: 'general' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.kind, 'chat');
        assert.ok(r.body.reply.text.includes(PLACEHOLDER), `当轮直出应已脱敏：${r.body.reply.text}`);
        assert.ok(!r.body.reply.text.includes('"type"'), `当轮直出不应含 section JSON：${r.body.reply.text}`);
        assert.ok(r.body.reply.text.includes('## 牌面对比'), '正常散文/标题应保留');

        // DB 落库仍是模型原始输出（不改库，口径与历史脱敏/读取端清洗一致）。
        const raw = await prisma.message.findFirst({ where: { sessionId: r.body.sessionId, role: 'assistant' }, orderBy: { createdAt: 'desc' } });
        assert.ok((raw!.contentJson as { text: string }).text.includes('quads'), '落库数据应保持模型原始输出未被改写');
      } finally {
        globalThis.fetch = realFetch;
        await resetGeneral();
        delete process.env.AI_ALLOW_REAL_PROVIDER;
      }
    });

    test('/generate（SSE）：当轮 event: chat 完整回复兜底也已脱敏', async () => {
      process.env.AI_ALLOW_REAL_PROVIDER = '1';
      await makeGeneralOpenai();
      const encLeak = PROD_LEAK.replace(/\n/g, '\\n').replace(/"/g, '\\"');
      const chunks = [
        `data: {"choices":[{"delta":{"content":"${encLeak}"}}]}\n\n`,
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":40}}\n\n',
        'data: [DONE]\n\n',
      ];
      globalThis.fetch = (async (url: unknown) => {
        if (!String(url).includes('/chat/completions')) throw new Error(`unexpected fetch: ${url}`);
        const enc = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) { for (const c of chunks) controller.enqueue(enc.encode(c)); controller.close(); },
        }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }) as unknown as typeof fetch;
      try {
        const userId = await login(uniquePhone(), '当轮直出乙');
        const r = await api('POST', '/api/generate', { token: userId, body: { text: '牌面对比给我看看', agentKey: 'general' } });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        const sse = String(r.body);
        const m = sse.match(/event: chat\ndata: (\{.*\})\n\n/);
        assert.ok(m, `应含 event: chat：${sse}`);
        const chatPayload = JSON.parse(m![1]) as { text: string };
        assert.ok(chatPayload.text.includes(PLACEHOLDER), `event: chat 应已脱敏：${chatPayload.text}`);
        assert.ok(!chatPayload.text.includes('"type"'), `event: chat 不应含 section JSON：${chatPayload.text}`);
        assert.ok(chatPayload.text.includes('## 牌面对比'), '正常散文/标题应保留');
      } finally {
        globalThis.fetch = realFetch;
        await resetGeneral();
        delete process.env.AI_ALLOW_REAL_PROVIDER;
      }
    });
  }
});
