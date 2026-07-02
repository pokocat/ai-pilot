// 定时任务框架（M1 PR-4）：进程内周期扫描（生产为单实例部署，见 prod 部署口径）。
// 设计：任务注册制（名字+周期+执行体），每个任务独立 try/catch —— 一个任务崩不影响其它；
// 每次执行打点日志，命中业务动作再落审计（audit_log）。测试/脚本环境不自启（NODE_ENV=test 或未调 start）。
// 任务位（随里程碑挂载）：案卷久未推进召回（已挂，v1 打点候选）→ M2 接：久不复盘提醒、预言到期验证、里程碑解锁。
// 触达注意：微信订阅消息是一次性授权，发送额度来自用户在打卡/复盘动线里的每次授权（前端埋点），
// 定时任务只负责「找出该提醒谁」并登记候选，发送走后续订阅消息通道。
import { prisma } from '../db.js';
import { recordAudit } from './audit.js';
import { now } from './clock.js';

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
}

const jobs: ScheduledJob[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
let started = false;

export function registerJob(job: ScheduledJob): void {
  jobs.push(job);
}

/** 单个任务执行（含隔离与打点）；测试可直接调用驱动任务，不依赖真实计时器。 */
export async function runJob(name: string): Promise<void> {
  const job = jobs.find((j) => j.name === name);
  if (!job) throw new Error(`未注册的定时任务：${name}`);
  const t0 = Date.now();
  try {
    await job.run();
    console.log(`[scheduler] ${name} ok in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error(`[scheduler] ${name} failed:`, (err as Error).message);
  }
}

export function startScheduler(): void {
  if (started || process.env.NODE_ENV === 'test') return;
  started = true;
  for (const job of jobs) {
    const t = setInterval(() => { void runJob(job.name); }, job.intervalMs);
    // 不阻止进程退出
    (t as { unref?: () => void }).unref?.();
    timers.push(t);
  }
  console.log(`[scheduler] started · ${jobs.length} jobs: ${jobs.map((j) => `${j.name}@${Math.round(j.intervalMs / 1000)}s`).join(', ')}`);
}

export function stopScheduler(): void {
  timers.forEach((t) => clearInterval(t));
  timers.length = 0;
  started = false;
}

// ============ 任务：案卷久未推进召回候选 ============
// 有活跃案卷、但 ≥48h 没有任何动作（打卡/回填/认可都会碰 casefile.updatedAt）→ 登记召回候选。
// 幂等：同一用户同一天只登记一次（按当天已有 system.recall.candidate 审计去重）。
export const RECALL_IDLE_HOURS = 48;

export async function scanIdleCasefiles(): Promise<number> {
  const cutoff = new Date(now().getTime() - RECALL_IDLE_HOURS * 3600_000);
  const dayStart = new Date(now().getFullYear(), now().getMonth(), now().getDate());
  const stale = await prisma.casefile.findMany({
    where: { status: 'active', updatedAt: { lt: cutoff } },
    select: { id: true, tenantId: true, userId: true, title: true, updatedAt: true },
    take: 200,
  });
  let flagged = 0;
  for (const cf of stale) {
    const already = await prisma.auditLog.findFirst({
      where: { userId: cf.userId, action: 'system.recall.candidate', createdAt: { gte: dayStart } },
      select: { id: true },
    });
    if (already) continue;
    await recordAudit({
      tenantId: cf.tenantId,
      userId: cf.userId,
      action: 'system.recall.candidate',
      payload: { casefileId: cf.id, title: cf.title, idleSince: cf.updatedAt.toISOString(), reason: `案卷超过 ${RECALL_IDLE_HOURS}h 未推进` },
    });
    flagged += 1;
  }
  if (flagged) console.log(`[scheduler] recall candidates: ${flagged}`);
  return flagged;
}

// 注册内置任务（周期：每 6 小时扫一轮；召回按天幂等，多扫无副作用）
registerJob({ name: 'casefile-idle-recall', intervalMs: 6 * 3600_000, run: async () => { await scanIdleCasefiles(); } });
