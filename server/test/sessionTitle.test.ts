// 会话标题：建会话落 18 字硬截断占位 → **首轮问答完成后**换成 ≤12 字短标题。
//
// 覆盖清单（对齐 AGENTS §11 后端集成测试红线）：
//  · 首轮完成即生成（mock 下走确定性兜底 → 可断言具体字符串）
//  · 幂等：已生成过的标题不再重写；用户改过名的标题不被覆盖
//  · 只在首轮：第二轮完成后标题不再横跳
//  · 主动消息注入的会话（占位取自模板文本）在用户首次回复完成后同规则生成
//  · 失败静默：会话不存在 / 尚无回复 / 空首问，一律不抛不写
//  · TC-G：只按 sessionId 改自己那条，B 名下会话一个字不动
//
// 跑单文件：cd server && node --env-file=.env.test --import tsx --test test/sessionTitle.test.ts
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { summarizeSessionTitle, normalizeSessionTitle, SESSION_TITLE_MAX_CHARS, SESSION_TITLE_MAX_TOKENS } from '../src/llm/gateway.js';
import { maybeGenerateTitle, fallbackSessionTitle, TITLE_PLACEHOLDER_CHARS } from '../src/services/sessionTitle.js';
import { setFeatureFlag, setFeatureFlagPayload, __clearFeatureCache } from '../src/services/featureFlag.ts';
import { WENCE_FLAG } from '../src/services/wence.ts';
import { prisma } from '../src/db.js';

const ASK = '我想请教一下今年餐饮门店到底该不该继续扩张再开三家分店';
const ASK_PLACEHOLDER = ASK.slice(0, TITLE_PLACEHOLDER_CHARS);
const ASK_FALLBACK = '今年餐饮门店到底该不该继'; // 去开场虚词 → 取首个语义片段 → 12 字上限

async function titleOf(sessionId: string): Promise<string> {
  const s = await prisma.session.findUnique({ where: { id: sessionId }, select: { title: true } });
  return s?.title ?? '';
}

/** 完成路径是即发即忘的，HTTP 返回时标题**可能**还没写完 → 轮询到位再断言（上限 3s）。 */
async function waitForTitle(sessionId: string, expected: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const now = await titleOf(sessionId);
    if (now === expected) return now;
    await new Promise((r) => setTimeout(r, 50));
  }
  return titleOf(sessionId);
}

/** 走一轮真实生成（测试下 durableGenerationBody 返回 null → 内联路径），返回 sessionId。 */
async function turn(token: string, text: string, sessionId?: string): Promise<string> {
  const gen = await api('POST', '/api/generate-sync', { token, body: { text, agentKey: 'general', ...(sessionId ? { sessionId } : {}) } });
  assert.equal(gen.status, 200, JSON.stringify(gen.body));
  return gen.body.sessionId as string;
}

describe('会话标题（首轮问答提炼）', () => {
  let alice = '';
  let bob = '';

  before(async () => {
    await getApp();
    await cleanBusiness();
    await seedBaseline();
    await prisma.wenceTemplate.deleteMany();
    alice = await login(uniquePhone(), '标题用户');
    bob = await login(uniquePhone(), '隔壁用户');
  });
  after(async () => {
    await prisma.wenceTemplate.deleteMany();
    await setFeatureFlag(WENCE_FLAG, false);
    __clearFeatureCache();
    await closeApp();
  });

  describe('纯函数口径', () => {
    test('无 live provider（测试/mock）→ summarizeSessionTitle 返回 null，绝不生造标题', async () => {
      assert.equal(await summarizeSessionTitle(ASK, '回复正文'), null);
      assert.equal(await summarizeSessionTitle(''), null);
      assert.equal(await summarizeSessionTitle('   '), null);
    });

    test('normalizeSessionTitle：去引号书名号 / 去句末标点 / 压换行 / 12 字截断 / 空串归 null', () => {
      assert.equal(normalizeSessionTitle('「门店扩张取舍」'), '门店扩张取舍');
      assert.equal(normalizeSessionTitle('《现金流吃紧》。'), '现金流吃紧');
      assert.equal(normalizeSessionTitle(' 门店\n扩张 '), '门店 扩张');
      assert.equal(normalizeSessionTitle('一二三四五六七八九十十一十二十三'), '一二三四五六七八九十十一');
      assert.equal(normalizeSessionTitle('一二三四五六七八九十十一十二十三')!.length, SESSION_TITLE_MAX_CHARS);
      assert.equal(normalizeSessionTitle('  '), null);
      assert.equal(normalizeSessionTitle(null), null);
    });

    test('fallbackSessionTitle 确定性：同输入恒同输出，去开场虚词后取首个语义片段', () => {
      assert.equal(fallbackSessionTitle(ASK), ASK_FALLBACK);
      assert.equal(fallbackSessionTitle(ASK), fallbackSessionTitle(ASK));
      assert.equal(fallbackSessionTitle('请问，现金流很紧张怎么办'), '现金流很紧张怎么办');
      assert.equal(fallbackSessionTitle(''), null);
    });

    test('标题预算固定 200 token：十来个字的产出不许再向上游多要配额', () => {
      assert.equal(SESSION_TITLE_MAX_TOKENS, 200);
    });
  });

  describe('生成时机与幂等', () => {
    test('首轮完成 → 完成路径即发即忘换掉占位（mock 下为确定性兜底）', async () => {
      const sessionId = await turn(alice, ASK);
      assert.equal(await waitForTitle(sessionId, ASK_FALLBACK), ASK_FALLBACK, '首轮完成后换成 ≤12 字短标题');
    });

    test('幂等：标题已不是占位 → 再调不重写', async () => {
      const sessionId = await turn(alice, ASK);
      const first = await waitForTitle(sessionId, ASK_FALLBACK);
      await maybeGenerateTitle(sessionId);
      await maybeGenerateTitle(sessionId);
      assert.equal(await titleOf(sessionId), first, '重复调用不产生第二次覆盖');
    });

    test('用户改过名的会话不被覆盖（幂等闸认的是「还是占位吗」）', async () => {
      const sessionId = await turn(alice, ASK);
      await waitForTitle(sessionId, ASK_FALLBACK); // 先等完成路径那一次写完，再模拟老板改名
      await prisma.session.update({ where: { id: sessionId }, data: { title: '老板自己起的名' } });
      await maybeGenerateTitle(sessionId);
      assert.equal(await titleOf(sessionId), '老板自己起的名');
    });

    test('只在首轮：第二轮完成后标题不再横跳', async () => {
      const sessionId = await turn(alice, ASK);
      const firstRound = await waitForTitle(sessionId, ASK_FALLBACK);

      await turn(alice, '那先只开一家试试呢', sessionId);
      await maybeGenerateTitle(sessionId);
      assert.equal(await titleOf(sessionId), firstRound, '后续轮次一律不动标题');
    });

    test('还没有回复落库 → 保留 18 字硬截断占位（要拿首轮问答一起提炼）', async () => {
      const sessionId = await turn(alice, ASK);
      await waitForTitle(sessionId, ASK_FALLBACK);
      // 回到「用户已开口、回复还没落库」的中间态：删掉回复并把标题还原成建会话时的占位。
      await prisma.message.deleteMany({ where: { sessionId, role: { in: ['assistant', 'report'] } } });
      await prisma.session.update({ where: { id: sessionId }, data: { title: ASK_PLACEHOLDER } });

      await maybeGenerateTitle(sessionId);
      assert.equal(await titleOf(sessionId), ASK_PLACEHOLDER, '只有 user 消息时不取名');
    });

    test('失败静默：会话不存在也不抛（调用方是 void fire-and-forget）', async () => {
      await maybeGenerateTitle('nope-not-a-session-id');
    });
  });

  describe('主动消息注入的会话', () => {
    test('占位取自模板文本 → 用户首次回复完成后同规则生成', async () => {
      await setFeatureFlag(WENCE_FLAG, true);
      await setFeatureFlagPayload(WENCE_FLAG, { arms: { chat: 1 } });
      __clearFeatureCache();
      await prisma.wenceTemplate.deleteMany();
      const tplText = '这两天看了你上传的门店流水，有件事想先跟你确认一下再往下聊';
      await prisma.wenceTemplate.create({ data: { kind: 'proactive', text: tplText, enabled: true, sort: 1 } });

      const carol = await login(uniquePhone(), '主动消息用户');
      const injected = await api('POST', '/api/sessions/proactive', { token: carol });
      assert.equal(injected.status, 200, JSON.stringify(injected.body));
      assert.equal(injected.body.injected, true);
      const sessionId: string = injected.body.sessionId;
      assert.equal(await titleOf(sessionId), tplText.slice(0, TITLE_PLACEHOLDER_CHARS), '占位 = 模板前 18 字');

      // 首条 assistant 已在，用户此时才第一次开口 → 首轮完成后按用户首问取名。
      await turn(carol, ASK, sessionId);
      assert.equal(await waitForTitle(sessionId, ASK_FALLBACK), ASK_FALLBACK, '模板占位同样被认作占位形状');
    });
  });

  describe('跨用户隔离（TC-G）', () => {
    test('只改自己那条会话，B 名下会话一个字不动', async () => {
      const bobSession = await turn(bob, '我们公司的仓储物流成本这两年一直压不下来该从哪里入手');
      const bobTitle = await waitForTitle(bobSession, '我们公司的仓储物流成本这');
      assert.equal(bobTitle, '我们公司的仓储物流成本这');

      const aliceSession = await turn(alice, ASK);
      await maybeGenerateTitle(aliceSession);
      assert.equal(await waitForTitle(aliceSession, ASK_FALLBACK), ASK_FALLBACK);
      assert.equal(await titleOf(bobSession), bobTitle, 'B 的标题不受 A 的生成影响');

      // A 也读不到 B 的会话（会话详情本身就按用户隔离）。
      const cross = await api('GET', `/api/sessions/${bobSession}`, { token: alice });
      assert.equal(cross.status, 404);
    });
  });
});
