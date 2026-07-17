// 入帐状态机（Chat-First 重构 · WO-S）集成测试：
// 断点续答、逐步落库（档案字段 + 本命色 + general 会话真实消息）、收官异步生成《初见断语》，
// 以及出策契约的火候规则（≥5 轮用户发言后 /generate-sync 带 proposal）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';

let token = '';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
  token = await login(uniquePhone(), '入帐用户');
});

after(async () => {
  await closeApp();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('GET /onboarding/state 新用户 → ASK_COLOR + GREET 军师开场（帅旗第一问）', async () => {
  const r = await api('GET', '/api/onboarding/state', { token });
  assert.equal(r.status, 200);
  assert.equal(r.body.stage, 'ASK_COLOR');
  assert.ok(r.body.messages.length >= 3, '应下发 GREET 两条 + 择帅旗');
  assert.match(r.body.messages[0].text, /坐。既入此帐/);
  assert.match(r.body.messages[2].text, /帅旗/);
  assert.equal(r.body.messages[2].widget, 'color-pick');
});

test('advance 逐步推进：色 → 营生 → 阶段 → 痛点 → 生辰，断点续答正确', async () => {
  // 择帅旗（第一问）→ 落 benmingColor → ASK_INDUSTRY
  const rColor = await api('POST', '/api/onboarding/advance', { token, body: { color: 'red' } });
  assert.equal(rColor.status, 200);
  assert.equal(rColor.body.stage, 'ASK_INDUSTRY');
  assert.equal(rColor.body.done, false);
  const user0 = await prisma.user.findUnique({ where: { id: token } });
  assert.equal(user0?.benmingColor, 'red');

  // 断点续答：色已择、营生未答（尚无 Profile）→ 由入帐会话进度推断 ASK_INDUSTRY
  const resume0 = await api('GET', '/api/onboarding/state', { token });
  assert.equal(resume0.body.stage, 'ASK_INDUSTRY');

  const r1 = await api('POST', '/api/onboarding/advance', { token, body: { answer: 'SaaS / 软件' } });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.stage, 'ASK_STAGE');
  assert.equal(r1.body.done, false);

  // 断点续答：industry 已答，重新拉 state 应停在 ASK_STAGE
  const resume = await api('GET', '/api/onboarding/state', { token });
  assert.equal(resume.body.stage, 'ASK_STAGE');

  const r2 = await api('POST', '/api/onboarding/advance', { token, body: { answer: '有进项，起伏不定' } });
  assert.equal(r2.body.stage, 'ASK_PAIN');

  const r3 = await api('POST', '/api/onboarding/advance', { token, body: { answer: '增长乏力' } });
  assert.equal(r3.body.stage, 'ASK_BAZI');

  // 档案字段已落库（复用 saveProfile 逻辑 → 建 Profile 行 = onboarded）
  const prof = await api('GET', '/api/profile', { token });
  assert.equal(prof.body.industry, 'SaaS / 软件');
  assert.equal(prof.body.stage, '有进项，起伏不定');
  assert.equal(prof.body.pain, '增长乏力');
  const me = await api('GET', '/api/me', { token });
  assert.equal(me.body.onboarded, true);
});

test('advance：跳过生辰（末问）→ FORGE，异步产出《初见断语》', async () => {
  const rb = await api('POST', '/api/onboarding/advance', { token, body: { skip: true } });
  assert.equal(rb.body.stage, 'FORGE');
  assert.equal(rb.body.done, false);
  assert.match(rb.body.messages[0].text, /初见断语/);

  // 本命色已落库（帅旗第一步即落定）
  const user = await prisma.user.findUnique({ where: { id: token } });
  assert.equal(user?.benmingColor, 'red');

  // 轮询生成结果
  let reportMessageId = '';
  for (let i = 0; i < 60; i++) {
    const res = await api('GET', '/api/onboarding/result', { token });
    if (res.body.ready) { reportMessageId = res.body.reportMessageId; break; }
    await sleep(50);
  }
  assert.ok(reportMessageId, '《初见断语》应在数十秒内生成完毕');

  // general 会话内有 role=report 的《初见断语》
  const reportMsg = await prisma.message.findUnique({ where: { id: reportMessageId } });
  assert.equal(reportMsg?.role, 'report');
  assert.equal((reportMsg?.contentJson as { title?: string }).title, '初见断语');

  // 落进版本化报告库
  const reports = await api('GET', '/api/reports', { token });
  assert.ok(reports.body.some((r: { title: string }) => r.title === '初见断语'), '应出现在方案库/报告列表');

  // 天势一眼段被过滤（本例跳过了生辰）
  const secs = (reportMsg?.contentJson as { sections?: { h: string }[] }).sections ?? [];
  assert.ok(!secs.some((s) => /天势/.test(s.h)), '无命盘时应略去「天势一眼」段');

  // 入帐问答已落库为 general 会话真实消息（军师问 + 用户答 + report + DONE 收束）
  const generalSession = await prisma.session.findFirst({ where: { userId: token, agentKey: 'general' } });
  const msgs = await prisma.message.findMany({ where: { sessionId: generalSession!.id }, orderBy: { createdAt: 'asc' } });
  assert.ok(msgs.some((m) => m.role === 'user' && /增长乏力/.test((m.contentJson as { text?: string }).text ?? '')));
  assert.ok(msgs.some((m) => m.role === 'assistant' && /断语在此/.test((m.contentJson as { text?: string }).text ?? '')));
});

test('GET /counsel/opening：有档案后返回主动开场 + chips', async () => {
  const r = await api('GET', '/api/counsel/opening', { token });
  assert.equal(r.status, 200);
  assert.ok(typeof r.body.text === 'string' && r.body.text.length > 0);
  assert.ok(Array.isArray(r.body.chips));
});

test('出策契约火候：连聊 5 轮后 /generate-sync 带 propose；措辞命中出报告正则', async () => {
  const u = await login(uniquePhone(), '火候用户');
  // 建档使 understanding ≠ empty
  await api('PUT', '/api/profile', { token: u, body: { industry: 'SaaS / 软件', stage: '有进项，起伏不定', pain: '增长乏力' } });

  const texts = [
    '我最近有点焦虑，不太确定方向',
    '团队现在也不太稳，人心浮动',
    '感觉每天都在救火，抓不住重点',
    '客户来了不少，但留不住',
    '我该先从哪里下手',
  ];
  let sessionId: string | undefined;
  let proposal: unknown = null;
  for (let i = 0; i < texts.length; i++) {
    const r = await api('POST', '/api/generate-sync', { token: u, body: { agentKey: 'general', sessionId, text: texts[i] } });
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'chat');
    sessionId = r.body.sessionId;
    proposal = r.body.proposal;
    if (i < 4) assert.ok(!r.body.proposal, `第 ${i + 1} 轮不应过早请缨`);
  }
  assert.ok(proposal, '第 5 轮应出现「出策请缨」');
  const p = proposal as { title: string; prompt: string; declinePrompt: string; readiness: number };
  assert.ok(p.title.length > 0);
  assert.match(p.prompt, /出一份《.+》/);
  assert.equal(p.declinePrompt, '先别出，再问我两个最关键的问题');

  // prompt 天然命中现有 wantsDeliverableRequest → 发送即出报告（零新后端路径）
  const gen = await api('POST', '/api/generate-sync', { token: u, body: { agentKey: 'general', sessionId, text: p.prompt } });
  assert.equal(gen.body.kind, 'report');

  // proposal 已持久化进该 assistant 消息（刷新后仍可点）
  const persisted = await prisma.message.findFirst({
    where: { sessionId, role: 'assistant', contentJson: { path: ['proposal'], not: Prisma.AnyNull } },
    orderBy: { createdAt: 'desc' },
  });
  assert.ok((persisted?.contentJson as { proposal?: unknown })?.proposal, 'proposal 应写入 assistant 消息 contentJson');
});
