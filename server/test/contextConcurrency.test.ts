// P1-6 context 注入装配并发化：防退化护栏。
// ① 统计一次 buildGenContext 的 prisma 操作数（$use 中间件计数），断言 ≤ 合理上限（防 N+1 回归）；
// ② 断言注入块完整、两次调用产出一致（并发取数、顺序拼装，不引入抖动/丢块）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone, deliverable } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { buildGenContext } from '../src/services/context.ts';

// 全局中间件：仅在 counting=true 时对每个 prisma 操作计数（默认 inert，不影响其它测试文件）。
let counting = false;
let qCount = 0;
prisma.$use(async (params, next) => { if (counting) qCount += 1; return next(params); });

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

const MSG = '帮我看看增长怎么做';

test('buildGenContext 查询数有上限（防 N+1）+ 注入块完整 + 幂等一致', async () => {
  const token = await login(uniquePhone(), '并发装配用户');
  const user = await prisma.user.findFirstOrThrow({ where: { id: token } });
  await api('PUT', '/api/profile', { token, body: { industry: '美业 / 医美', stage: '100-500 万', pain: '获客' } });
  // 落一条日复盘 + 一条决策，让对应 briefing 命中（走真实注入路径）。
  await api('POST', '/api/casefile/review', { token, body: {} });
  await api('POST', '/api/casefile/accept', {
    token,
    body: { deliverable: deliverable('增长方案', [{ h: '判断', b: '先收缩再扩张，聚焦老客复购' }, { h: '下一步', list: ['私聊 20 个高意向老客'] }]) },
  });

  counting = true; qCount = 0;
  const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: MSG });
  counting = false;
  const first = qCount;

  assert.ok(first > 0, '应发起查询');
  // 合理上限：注入链约 20-35 次 round-trip，留 headroom 到 50；超出多半是引入了 per-item N+1。
  assert.ok(first <= 50, `buildGenContext prisma 操作数 ${first} 超过上限 50（疑似 N+1 回归）`);

  // 注入块完整：并发取数后仍拼出复盘账本 + 档案。
  assert.ok(ctx.reviewLine, '复盘账本应注入');
  assert.equal(ctx.profile?.industry, '美业 / 医美');

  // 幂等/确定性：再跑一次，关键注入块内容一致；查询数稳定（±2 容忍首访懒写：段位里程碑解锁/画像初始化）。
  counting = true; qCount = 0;
  const { ctx: ctx2 } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: MSG });
  counting = false;
  assert.ok(qCount <= 50, `第二次查询数 ${qCount} 超上限 50`);
  assert.ok(Math.abs(qCount - first) <= 2, `两次查询数应稳定（首访懒写差异 ≤2），实际 ${first} vs ${qCount}`);
  assert.equal(ctx2.reviewLine, ctx.reviewLine, '复盘账本注入内容一致');
  assert.equal(ctx2.decisionLine, ctx.decisionLine, '决策账本注入内容一致');
  assert.equal(ctx2.modeLine, ctx.modeLine, '本轮导引一致');
});
