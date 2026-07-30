// 会话读取端自愈（GET /sessions/:id）——2026-07-29 生产白屏热修的服务端一层。
//
// 现场：军师 tab 点「品牌营销官」进对话页整页白屏。根因在小程序渲染期解引用脏形状抛错
// （小程序无红屏、无堆栈）：
//   ① 成果消息 sections 缺字段        → ReportCard 读 data.sections.length → TypeError
//   ② section 叶子是对象（早于报告 V2 归一化落库） → MarkdownText 的 parseBlocks 执行
//      `input.replace(...)` → “e.replace is not a function”
//   ③ assistant 消息缺 text           → 同上 parseBlocks(undefined)
// 方案库 / 版本化报告的读取路径早就套了 healDeliverableSections，唯独会话详情这条最热的读取
// 路径漏了。补齐后**不发版**即可救线上（端上防御随下次发版加固）。
//   cd server && node --import tsx --test test/sessionReadHeal.test.ts
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { api, login, seedBaseline, cleanBusiness, closeApp, uniquePhone } from './helpers.js';

const tenantOf = async (token: string) => (await prisma.user.findUnique({ where: { id: token } }))!.tenantId;

type Msg = { id: string; role: string; content: any };
const msgOf = (body: { messages: Msg[] }, id: string) => body.messages.find((m) => m.id === id)!;

// 健康成果（覆盖 typed + 旧版白卡两类段），用于幂等断言。
const HEALTHY = {
  title: '营销内容方案',
  icon: 'image',
  meta: '2026-07-29 · 餐饮',
  trust: '判断依据：企业档案 + 最近 3 次对话',
  actions: ['save_to_library', 'export_pdf'],
  sections: [
    { type: 'hero', h: '现状判断', paras: ['第一段', '第二段'] },
    { type: 'stats', h: '关键数据', items: [{ num: '240', unit: '万', label: '月流水' }] },
    { h: '内容方向', b: '把战略翻译成一句客户能复述的话', list: ['客户证言', '场景化短视频'] },
  ],
};

describe('GET /sessions/:id · 成果消息 sections 读取端自愈（连库）', () => {
  before(async () => {
    await cleanBusiness();
    await seedBaseline();
  });
  after(async () => {
    await closeApp();
  });

  test('①缺 sections 字段的成果消息：读取端补成空数组（端上 data.sections.length 不再抛错）', async () => {
    const userId = await login(uniquePhone(), '自愈甲');
    const tenantId = await tenantOf(userId);
    const session = await prisma.session.create({ data: { tenantId, userId, agentKey: 'brand', title: '营销内容' } });
    const dirty = await prisma.message.create({
      data: { sessionId: session.id, role: 'report', contentJson: { title: '旧格式·缺 sections', icon: 'image', meta: 'm', trust: 't' } },
    });

    const res = await api('GET', `/api/sessions/${session.id}`, { token: userId });
    assert.equal(res.status, 200);
    const content = msgOf(res.body, dirty.id).content;
    assert.ok(Array.isArray(content.sections), `sections 必须是数组，实际 ${JSON.stringify(content.sections)}`);
    assert.equal(content.sections.length, 0);
    // 其余字段原样保留（不要把治愈做成信息丢失）。
    assert.equal(content.title, '旧格式·缺 sections');
    assert.equal(content.trust, 't');

    // 读时治愈、不改库。
    const raw = await prisma.message.findUnique({ where: { id: dirty.id } });
    assert.equal('sections' in (raw!.contentJson as object), false, '落库数据应保持原样未被改写');
  });

  test('②section 叶子是对象（旧格式）：list 项 / b 归一化成字符串，绝不把对象下发给端上', async () => {
    const userId = await login(uniquePhone(), '自愈乙');
    const tenantId = await tenantOf(userId);
    const session = await prisma.session.create({ data: { tenantId, userId, agentKey: 'brand', title: '营销内容' } });
    const dirty = await prisma.message.create({
      data: {
        sessionId: session.id,
        role: 'report',
        contentJson: {
          title: '旧格式·叶子是对象',
          icon: 'image',
          sections: [
            { h: '内容方向', list: [{ point: '客户证言', why: '建立可信度' }, '场景化短视频'] },
            { h: '执行清单', b: '两周节奏排期', list: ['1 组主视觉海报'] },
          ],
        },
      },
    });

    const res = await api('GET', `/api/sessions/${session.id}`, { token: userId });
    assert.equal(res.status, 200);
    const content = msgOf(res.body, dirty.id).content;
    assert.ok(Array.isArray(content.sections));
    for (const sec of content.sections) {
      if (sec.b !== undefined) assert.equal(typeof sec.b, 'string', `b 必须是字符串：${JSON.stringify(sec.b)}`);
      for (const x of sec.list ?? []) assert.equal(typeof x, 'string', `list 项必须是字符串：${JSON.stringify(x)}`);
    }
    // 与服务端 listOf 口径一致：对象项丢弃，字符串项保留（方案库详情同口径，两处显示一致）。
    const dir = content.sections.find((s: { h: string }) => s.h === '内容方向');
    assert.deepEqual(dir.list, ['场景化短视频']);
    // 健康的那一段完整保留。
    const todo = content.sections.find((s: { h: string }) => s.h === '执行清单');
    assert.equal(todo.b, '两周节奏排期');
    assert.deepEqual(todo.list, ['1 组主视觉海报']);

    const raw = await prisma.message.findUnique({ where: { id: dirty.id } });
    const rawList = ((raw!.contentJson as any).sections[0].list as unknown[])[0];
    assert.equal(typeof rawList, 'object', '落库数据应保持原样未被改写');
  });

  test('③assistant 消息缺 text：读取端补成空串（端上 parseBlocks(undefined) 不再抛错）', async () => {
    const userId = await login(uniquePhone(), '自愈丙');
    const tenantId = await tenantOf(userId);
    const session = await prisma.session.create({ data: { tenantId, userId, agentKey: 'brand', title: '营销内容' } });
    const noText = await prisma.message.create({ data: { sessionId: session.id, role: 'assistant', contentJson: { points: ['要点一', '要点二'] } } });

    const res = await api('GET', `/api/sessions/${session.id}`, { token: userId });
    assert.equal(res.status, 200);
    const content = msgOf(res.body, noText.id).content;
    assert.equal(content.text, '', 'text 必须存在且是字符串');
    assert.deepEqual(content.points, ['要点一', '要点二'], 'points 等其余字段原样保留');

    const raw = await prisma.message.findUnique({ where: { id: noText.id } });
    assert.equal('text' in (raw!.contentJson as object), false, '落库数据应保持原样未被改写');
  });

  test('健康数据幂等：typed / 旧版白卡混排的正常成果，读取前后逐字段等价', async () => {
    const userId = await login(uniquePhone(), '自愈丁');
    const tenantId = await tenantOf(userId);
    const session = await prisma.session.create({ data: { tenantId, userId, agentKey: 'brand', title: '营销内容' } });
    const healthy = await prisma.message.create({ data: { sessionId: session.id, role: 'report', contentJson: HEALTHY } });

    const res = await api('GET', `/api/sessions/${session.id}`, { token: userId });
    assert.equal(res.status, 200);
    assert.deepEqual(msgOf(res.body, healthy.id).content, HEALTHY, '健康数据不能被自愈改动');
  });

  test('user 原文不参与形状改写：内容原样透传（自愈只作用于 report / assistant）', async () => {
    const userId = await login(uniquePhone(), '自愈戊');
    const tenantId = await tenantOf(userId);
    const session = await prisma.session.create({ data: { tenantId, userId, agentKey: 'brand', title: '营销内容' } });
    const usr = await prisma.message.create({ data: { sessionId: session.id, role: 'user', contentJson: { text: '营销内容', extra: { keep: true } } } });

    const res = await api('GET', `/api/sessions/${session.id}`, { token: userId });
    assert.equal(res.status, 200);
    assert.deepEqual(msgOf(res.body, usr.id).content, { text: '营销内容', extra: { keep: true } });
  });
});
