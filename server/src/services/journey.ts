// WO-07：用户级 journey 状态机（借鉴 LangGraph StateGraph 思想——声明式 state + transition + 落库，
// 但只是一个约百行的领域模块，不引依赖）。事件确定性驱动、服务端唯一写入；前端只读派生的「下一步」。
// 依赖方向单一：本模块只 import prisma/clock/casefile 服务；事件由各路由/服务反向 fire（避免环）。
import { prisma } from '../db.js';
import { now } from './clock.js';
import { activeCasefile } from './casefile.js';
import type { JourneyStage, JourneyNextStep, JourneyView } from '../../../shared/contracts';

export const JOURNEY_STAGES: JourneyStage[] = ['new', 'scanned', 'diagnosing', 'plan_ready', 'executing', 'reviewing'];
export type JourneyEvent = 'quickscan.done' | 'diag.round' | 'plan.accept' | 'review.first';

type Stamp = 'quickScanAt' | 'planAcceptedAt' | 'firstReviewAt';
interface Transition { on: JourneyEvent; from: JourneyStage[] | '*'; to: JourneyStage; stamp?: Stamp }

// 声明式状态图：事件在「允许的起始态」触发 → 目标态（可选落时间戳）；无效态触发即忽略（幂等、无副作用）。
// plan_ready 是瞬时埋点态：plan.accept 直接进 executing 并落 planAcceptedAt（同一信号，省一次写）。
const TRANSITIONS: Transition[] = [
  { on: 'quickscan.done', from: ['new'], to: 'scanned', stamp: 'quickScanAt' },
  { on: 'diag.round', from: ['new', 'scanned', 'diagnosing'], to: 'diagnosing' },
  { on: 'plan.accept', from: '*', to: 'executing', stamp: 'planAcceptedAt' },
  { on: 'review.first', from: ['executing', 'reviewing'], to: 'reviewing', stamp: 'firstReviewAt' },
];

async function loadOrCreate(userId: string, tenantId: string) {
  return prisma.userJourney.upsert({ where: { userId }, update: {}, create: { userId, tenantId, stage: 'new' } });
}

/** 触发一个 journey 事件（确定性迁移 + 首次落时间戳）。内部吞错——绝不打断宿主流程（fire-and-forget 安全）。 */
export async function applyJourneyEvent(userId: string, tenantId: string, event: JourneyEvent): Promise<void> {
  try {
    const j = await loadOrCreate(userId, tenantId);
    const t = TRANSITIONS.find((x) => x.on === event && (x.from === '*' || x.from.includes(j.stage as JourneyStage)));
    if (!t) return; // 事件在当前态无效
    const data: { stage: string; quickScanAt?: Date; planAcceptedAt?: Date; firstReviewAt?: Date } = { stage: t.to };
    if (t.stamp && !j[t.stamp]) data[t.stamp] = now();
    await prisma.userJourney.update({ where: { userId }, data });
  } catch (err) {
    console.error('[journey] applyEvent failed:', (err as Error).message);
  }
}

/** 纯函数：状态 + 当日信号 → 下一步卡。单测覆盖全分支（WO-07 验收）。 */
export function deriveNextStep(input: {
  stage: JourneyStage; diagRound: number;
  todayOrdersTotal: number; todayOrdersDone: number; todayReviewed: boolean; hour: number;
}): JourneyNextStep | null {
  const { stage, diagRound } = input;
  switch (stage) {
    case 'new':
      return { key: 'quickscan', title: '先做个 3 问速诊', desc: '10 分钟拿到主要矛盾与今天能做的一件事。', route: '/packages/work/quickscan/index' };
    case 'scanned':
      return { key: 'continue_diagnosis', title: '进参谋室，开始诊断', desc: '速诊只是开胃，六轮深聊才出完整打法。', route: 'chat' };
    case 'diagnosing':
      return { key: 'continue_diagnosis', title: `继续第 ${diagRound + 1} 轮诊断`, desc: '把打法聊定，认可后自动拆成军令。', route: 'chat' };
    case 'plan_ready':
      return { key: 'accept_plan', title: '认可方案，生成军令', desc: '认可后自动拆成今日军令。', route: 'chat' };
    case 'executing':
    case 'reviewing': {
      if (input.todayOrdersTotal > 0 && input.todayOrdersDone < input.todayOrdersTotal)
        return { key: 'do_orders', title: `今日军令 ${input.todayOrdersDone}/${input.todayOrdersTotal}`, desc: '完成今日军令并录入战果。', route: 'studio' };
      if (!input.todayReviewed && input.hour >= 19)
        return { key: 'do_review', title: '今晚该复盘了', desc: '录入战果，军师据此定明日军令。', route: 'studio' };
      return { key: 'do_orders', title: '录入今日战果', desc: '把线索 / 咨询 / 成交录进去。', route: 'studio' };
    }
    default:
      return null;
  }
}

function todayKey(): string {
  const d = now();
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/** GET /journey 数据源：装配 stage + diagRound + 当日案卷/复盘信号 → 派生下一步。 */
export async function getJourneyView(userId: string, tenantId: string): Promise<JourneyView> {
  const j = await loadOrCreate(userId, tenantId);
  const stage = j.stage as JourneyStage;
  // diagRound 仍以 StrategicProfile 为真源（F-5）；直接读列避免 import strategicProfile（防环）。
  const sp = await prisma.strategicProfile.findUnique({ where: { userId }, select: { diagRound: true } });
  const diagRound = sp?.diagRound ?? 0;
  let todayOrdersTotal = 0, todayOrdersDone = 0, todayReviewed = false;
  try {
    const cf = await activeCasefile(userId);
    if (cf) {
      const date = todayKey();
      const orders = await prisma.casefileOrder.findMany({ where: { casefileId: cf.id, date } });
      todayOrdersTotal = orders.length;
      todayOrdersDone = orders.filter((o) => o.done).length;
      todayReviewed = !!(await prisma.reviewLog.findUnique({ where: { userId_layer_date: { userId, layer: 'day', date } } }));
    }
  } catch { /* 信号读失败不影响 stage 级下一步 */ }
  return { stage, diagRound, nextStep: deriveNextStep({ stage, diagRound, todayOrdersTotal, todayOrdersDone, todayReviewed, hour: now().getHours() }) };
}
