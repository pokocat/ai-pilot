// 主线会话摘要预热：取消 24 小时断链上线前，先把存量长会话的历史脉络追到最新。
//
// 默认只统计、不写库、不调用模型：
//   npm run db:prewarm-session-digests
// 实际预热（串行、有限量，避免和在线生成抢上游并发）：
//   npm run db:prewarm-session-digests -- --apply --limit=200 --min-messages=17
//
// 安全边界：只写 SessionContextSnapshot；原始消息、会话、记忆均不修改。任一会话抽取失败/
// 冷却/撞顶即停在原复合游标，后续可幂等重跑。脚本不会挂在用户打开会话的请求上。

import { prisma } from '../src/db.js';
import { readSessionDigest, updateSessionDigest, type SessionDigestStatus } from '../src/services/sessionDigest.js';

interface Args {
  apply: boolean;
  limit: number;
  minMessages: number;
  maxUpdates: number;
  delayMs: number;
}

function numberArg(name: string, fallback: number, min: number, max: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} 必须是 ${min}~${max} 的整数`);
  }
  return value;
}

function args(): Args {
  return {
    apply: process.argv.includes('--apply'),
    limit: numberArg('limit', 200, 1, 5_000),
    minMessages: numberArg('min-messages', 17, 1, 100_000),
    maxUpdates: numberArg('max-updates', 20, 1, 100),
    delayMs: numberArg('delay-ms', 250, 0, 60_000),
  };
}

const wait = (ms: number): Promise<void> => ms > 0
  ? new Promise((resolve) => setTimeout(resolve, ms))
  : Promise.resolve();

async function main(): Promise<void> {
  const opts = args();
  const sessions = await prisma.session.findMany({
    where: { agentKey: 'general', messages: { some: {} } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: opts.limit,
    select: {
      id: true,
      tenantId: true,
      userId: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  const targets = sessions.filter((session) => session._count.messages >= opts.minMessages);
  const statusCount = new Map<string, number>();
  const rows: Array<{ session: typeof targets[number]; status: SessionDigestStatus | 'missing'; pending: number; items: number }> = [];

  for (const session of targets) {
    const state = await readSessionDigest(session.id, session.userId);
    const status = state?.status ?? 'missing';
    const pending = state?.pendingMessages ?? session._count.messages;
    rows.push({ session, status, pending, items: state?.items.length ?? 0 });
    statusCount.set(status, (statusCount.get(status) ?? 0) + 1);
  }

  console.log(`${opts.apply ? 'APPLY' : 'DRY-RUN'} 主线会话摘要预热`);
  console.log(`  扫描最近 ${sessions.length} 条主线；消息数 >= ${opts.minMessages} 的目标 ${targets.length}`);
  console.log(`  状态 ${[...statusCount].map(([status, count]) => `${status}=${count}`).join('，') || '无目标'}`);
  for (const row of rows.slice(0, 30)) {
    console.log(`  - ${row.session.id}：消息 ${row.session._count.messages}，摘要 ${row.items}，待处理 ${row.pending}，${row.status}`);
  }
  if (rows.length > 30) console.log(`  ...以及另外 ${rows.length - 30} 条`);
  if (!opts.apply) {
    console.log('这是试运行，未写库、未调用模型。确认目标范围和上游余量后加 --apply。');
    return;
  }

  const outcomes = new Map<string, number>();
  for (const row of rows) {
    let state = await readSessionDigest(row.session.id, row.session.userId);
    let updates = 0;
    while ((!state || state.status === 'pending') && updates < opts.maxUpdates) {
      state = await updateSessionDigest({
        tenantId: row.session.tenantId,
        userId: row.session.userId,
        sessionId: row.session.id,
        maxBatches: 5,
      });
      updates += 1;
      if (state.status !== 'pending') break;
    }
    const outcome = state?.status ?? 'missing';
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
    console.log(`  ${outcome === 'caught_up' ? '✓' : '!'} ${row.session.id}：${outcome}，更新 ${updates} 轮，待处理 ${state?.pendingMessages ?? row.pending}`);
    await wait(opts.delayMs);
  }
  console.log(`预热结束：${[...outcomes].map(([status, count]) => `${status}=${count}`).join('，') || '无目标'}`);
  if ([...outcomes].some(([status]) => status !== 'caught_up')) process.exitCode = 2;
}

main()
  .catch((error) => {
    console.error('摘要预热失败：', error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
