// M3 意图路由/角色语气/阶段/轮次测试：确定性识别矩阵 + 注入 + 会话粘性 + 复盘意图自动落账。
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { detectIntent, detectInnerState, stageOf, resolveMode, encodeMode } from '../src/services/intent.ts';
import { buildGenContext } from '../src/services/context.ts';
import { buildSystemParts } from '../src/llm/schema.ts';
import { bumpDiagRound } from '../src/services/strategicProfile.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

describe('意图识别矩阵（V6.0 §3 入口规则）', () => {
  test('复盘分层：②诊断过的「这周复盘」「帮我算一卦」不再错分', () => {
    assert.deepEqual(detectIntent('这周复盘一下'), { mode: 'review', reviewLayer: 'week' });
    assert.deepEqual(detectIntent('做个月度总结吧'), { mode: 'review', reviewLayer: 'month' });
    assert.deepEqual(detectIntent('Q3 季度回顾'), { mode: 'review', reviewLayer: 'quarter' });
    assert.deepEqual(detectIntent('年终复盘'), { mode: 'review', reviewLayer: 'year' });
    assert.deepEqual(detectIntent('团队复盘一下人员状态'), { mode: 'review', reviewLayer: 'team' });
    assert.deepEqual(detectIntent('今天的 6 件事复盘'), { mode: 'review', reviewLayer: 'day' });
    assert.equal(detectIntent('帮我给朋友算一卦').mode, 'gift_bazi');
  });

  test('紧急/择时/团队匹配/情绪/默认', () => {
    assert.equal(detectIntent('出大事了，供应商今晚必须答复').mode, 'urgent');
    assert.equal(detectIntent('我们什么时候签合同比较好').mode, 'timing');
    assert.equal(detectIntent('帮我看看这个合伙人靠谱吗').mode, 'team_match');
    assert.equal(detectIntent('最近很迷茫，不知道往哪走').mode, 'mentor');
    assert.equal(detectIntent('帮我看看增长怎么做').mode, 'strategy');
    // 有「复盘」词但无周期词 → 不落层，不误记账
    assert.equal(detectIntent('复盘方法论是什么').mode, 'strategy');
  });

  test('内在状态 → 五角色；阶段映射兼容新旧标签', () => {
    assert.equal(detectInnerState('下个月工资都发不出了'), '生存焦虑');
    assert.equal(detectInnerState('这个月订单爆了，翻倍了'), '增长兴奋');
    assert.equal(detectInnerState('团队跟不上，招不到人'), '管理痛苦');
    assert.equal(detectInnerState('感觉卡住了，遇到瓶颈'), '瓶颈迷茫');
    assert.equal(detectInnerState('赚了钱但觉得没意义'), '意义追问');
    assert.equal(detectInnerState('帮我写个方案'), null);

    assert.equal(stageOf('100 万以下'), 'survival');
    assert.equal(stageOf('100-500 万'), 'start');
    assert.equal(stageOf('500 万-5000 万'), 'growth');
    assert.equal(stageOf('5000 万以上'), 'expansion');
    // 旧问卷标签兼容
    assert.equal(stageOf('起步 / 验证'), 'survival');
    assert.equal(stageOf('A 轮前后'), 'start');
    assert.equal(stageOf('规模化'), 'growth');
    assert.equal(stageOf('稳定盈利'), 'expansion');
    assert.equal(stageOf(''), null);
  });

  test('粘性模式：本轮识别不出沿用会话模式；识别出新模式则切换', () => {
    const r1 = resolveMode('继续', 'review:week');
    assert.deepEqual(r1.intent, { mode: 'review', reviewLayer: 'week' });
    assert.equal(r1.persist, undefined, '沿用不重写');
    const r2 = resolveMode('出大事了，今晚必须定', 'review:week');
    assert.equal(r2.intent.mode, 'urgent');
    assert.equal(r2.persist, 'urgent');
    assert.equal(encodeMode({ mode: 'strategy' }), null);
  });
});

describe('注入与端到端', () => {
  test('modeLine/角色/轮次注入 dynamic 首位；阶段指令入 stable', async () => {
    const token = await login(uniquePhone(), 'M3用户');
    const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
    await api('PUT', '/api/profile', { token, body: { industry: '美业 / 医美', stage: '100 万以下', pain: '现金流' } });

    // 紧急 + 生存焦虑：模式指令 + 角色指令都注入
    const { ctx } = await buildGenContext({
      userId: user.id, tenantId: user.tenantId, agentKey: 'general',
      userMessage: '出大事了，现金流快断了，今晚必须定',
    });
    const parts = buildSystemParts(ctx.systemPrompt, ctx, 'chat');
    assert.match(parts.dynamic, /【本轮导引/);
    assert.match(parts.dynamic, /紧急战况模式/);
    assert.match(parts.dynamic, /「教官」角色/);
    assert.match(parts.stable, /阶段适配=生存期/);
    assert.doesNotMatch(parts.stable, /表达风格参考 · 本命色/);

    // 默认诊断：注入轮次（F-5 用户级持久化 diagRound——换/删会话不清零，不再按当前会话 history 现算；
    // 写侧在 routes/sessions.ts 一问一答开始时 bumpDiagRound，这里直接调用模拟已进行 3 轮）
    await bumpDiagRound({ tenantId: user.tenantId, userId: user.id, sessionId: null });
    await bumpDiagRound({ tenantId: user.tenantId, userId: user.id, sessionId: null });
    await bumpDiagRound({ tenantId: user.tenantId, userId: user.id, sessionId: null });
    const { ctx: c2 } = await buildGenContext({
      userId: user.id, tenantId: user.tenantId, agentKey: 'general',
      userMessage: '帮我看增长',
    });
    assert.match(buildSystemParts(c2.systemPrompt, c2, 'chat').dynamic, /诊断进度：第 3 轮（六轮深度对话制/);
  });

  test('端到端：聊天说「这周复盘」→ 自动落 week 复盘账 + 会话模式粘住', async () => {
    const token = await login(uniquePhone(), '周复盘用户');
    const r = await api('POST', '/api/generate-sync', { token, body: { text: '这周复盘一下', agentKey: 'general' } });
    assert.equal(r.status, 200);
    // week 层复盘账已落
    const rows = await prisma.reviewLog.findMany({ where: { userId: token, layer: 'week' } });
    assert.equal(rows.length, 1);
    // 会话模式粘住
    const session = await prisma.session.findFirstOrThrow({ where: { id: r.body.sessionId } });
    assert.equal(session.mode, 'review:week');
    // 下一轮不带触发词 → 模式沿用（不清空）
    const r2 = await api('POST', '/api/generate-sync', { token, body: { text: '继续', sessionId: r.body.sessionId } });
    assert.equal(r2.status, 200);
    const again = await prisma.session.findFirstOrThrow({ where: { id: r.body.sessionId } });
    assert.equal(again.mode, 'review:week');
  });
});
