// 爱速拍 · 出片对账台的取数层。
//
// 为什么要有这一屏：VideoCreditHold 是**唯一**一张记着「用户的钻石已经扣了、片子还没交付」
// 的表，而在这之前运营后台一行都读不到它。出片链路有三段真实会卡的地方：
//   · submitting/unknown —— 钱扣了，但没拿到上游 jobId。绝不能按超时猜失败退款
//     （上游可能已经在跑了，退款 = 白送一次出片），只能按 clientRequestId 查单。
//   · submitted/notifying —— 上游收了但迟迟不回终态。
//   · refunded —— 终点，任何路径都不许写回 settled。
// 这三种都在定时任务里有兜底，但兜底失败时没人看得见。这一屏就是那双眼睛。
//
// 与「订单」页的卡单处置同一形制：先给数，再给一个能落审计的修复动作，
// 修复动作复用定时任务那条路径，不另写一套判定。
import type {
  AdminClipOpsView, AdminClipHoldItem, AdminClipHoldListView, ClipAdminTemplate,
  ClipGenerationPricing, ClipVendorOverview,
} from '../../../../shared/contracts';
import { prisma } from '../../db.js';
import { aidramaJson, type VideoGatewayIdentity } from './aidramaGateway.js';
import { PRODUCT } from '../products.js';

/**
 * 钱还悬着的那几个状态。
 *
 * settled（已交付、钱已结）和 refunded（已退回）都是终点，不计入悬挂。
 * 注意 notifying 只是 submitted 被扫描认领后的瞬时中间态，但它照样是「钱扣了没结清」，
 * 所以算在里面 —— 漏掉它会让悬挂额在每轮扫描时小幅跳水，看起来像账在自己变。
 */
export const OPEN_HOLD_STATUSES = ['submitting', 'unknown', 'submitted', 'notifying'] as const;

/** 已经扣了钱却还没拿到上游锚点的两种。真正的资损风险集中在这里。 */
export const UNANCHORED_STATUSES = ['submitting', 'unknown'] as const;

const STATUS_LABEL: Record<string, string> = {
  submitting: '提交中',
  unknown: '受理不明',
  submitted: '上游已受理',
  notifying: '结算中',
  settled: '已结算',
  refunded: '已退款',
};

export const holdStatusLabel = (s: string): string => STATUS_LABEL[s] ?? s;

/** 合法的状态筛选值；其它一律当「不筛」，不把任意字符串拼进查询。 */
export function normalizeHoldStatus(value: unknown): string | undefined {
  const s = String(value ?? '').trim();
  return s in STATUS_LABEL ? s : undefined;
}

/**
 * 出片对账总览。
 *
 * `stuckCredits` 是这一屏的头号数字：**已经从用户余额里扣走、既没交付也没退回**的钻石。
 * 它不是「今天花了多少」——那个在「钻石消耗」里；它是「现在有多少钱悬在半空」。
 */
export async function clipOpsSummary(from: Date, toExclusive: Date): Promise<AdminClipOpsView> {
  const window = { createdAt: { gte: from, lt: toExclusive } };
  const [byStatus, openAgg, unanchoredAgg, refundedAgg, settledAgg, oldestOpen] = await Promise.all([
    prisma.videoCreditHold.groupBy({ by: ['status'], where: window, _count: { _all: true }, _sum: { credits: true } }),
    // 悬挂额**不按时间窗口算**：一单卡了 40 天，它照样是今天悬着的钱。
    // 按窗口算会让最该被看见的陈年卡单从视野里消失 —— 那正好和这一屏的目的相反。
    prisma.videoCreditHold.aggregate({ where: { status: { in: [...OPEN_HOLD_STATUSES] } }, _sum: { credits: true }, _count: { _all: true } }),
    prisma.videoCreditHold.aggregate({ where: { status: { in: [...UNANCHORED_STATUSES] } }, _sum: { credits: true }, _count: { _all: true } }),
    prisma.videoCreditHold.aggregate({ where: { ...window, status: 'refunded' }, _sum: { credits: true }, _count: { _all: true } }),
    prisma.videoCreditHold.aggregate({ where: { ...window, status: 'settled' }, _sum: { credits: true }, _count: { _all: true } }),
    prisma.videoCreditHold.findFirst({
      where: { status: { in: [...OPEN_HOLD_STATUSES] } },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  const settled = settledAgg._count._all;
  const refunded = refundedAgg._count._all;
  const finished = settled + refunded;
  return {
    from: from.toISOString(),
    to: toExclusive.toISOString(),
    byStatus: byStatus
      .map((r) => ({ status: r.status, label: holdStatusLabel(r.status), count: r._count._all, credits: r._sum.credits ?? 0 }))
      .sort((a, b) => b.count - a.count),
    openCount: openAgg._count._all,
    openCredits: openAgg._sum.credits ?? 0,
    unanchoredCount: unanchoredAgg._count._all,
    unanchoredCredits: unanchoredAgg._sum.credits ?? 0,
    settledCount: settled,
    settledCredits: settledAgg._sum.credits ?? 0,
    refundedCount: refunded,
    refundedCredits: refundedAgg._sum.credits ?? 0,
    // 分母只用已收口的单。把还在跑的单算进分母，成功率会随「此刻有多少单在队列里」上下飘，
    // 那不是质量指标，是排队长度指标。窗口内一单都没收口时给 null，前端显示「—」而不是 0%。
    successRate: finished > 0 ? Math.round((settled / finished) * 100) : null,
    oldestOpenAt: oldestOpen?.createdAt.toISOString() ?? null,
  };
}

export async function listClipHolds(input: {
  status?: string;
  from: Date;
  toExclusive: Date;
  page: number;
  pageSize: number;
}): Promise<AdminClipHoldListView> {
  const page = Math.max(1, Math.floor(input.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Math.floor(input.pageSize) || 30));
  // 不传状态时默认只看**还悬着**的单：这一屏是来处置问题的，
  // 默认把几万条已结算的单摆在最前面，等于让人自己去翻。
  const where = input.status
    ? { status: input.status, createdAt: { gte: input.from, lt: input.toExclusive } }
    : { status: { in: [...OPEN_HOLD_STATUSES] } };
  const [total, rows] = await Promise.all([
    prisma.videoCreditHold.count({ where }),
    prisma.videoCreditHold.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);
  const users = rows.length
    ? await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.userId))] } }, select: { id: true, name: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const items: AdminClipHoldItem[] = rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    userName: nameOf.get(r.userId) ?? null,
    projectId: r.projectId,
    clientRequestId: r.clientRequestId,
    upstreamJobId: r.upstreamJobId,
    credits: r.credits,
    status: r.status,
    statusLabel: holdStatusLabel(r.status),
    lastJobStatus: r.lastJobStatus,
    // 归属为空 = 本列上线之前建的单。不猜，照实报空，前端标「历史」。
    productCode: r.productCode,
    chargedAt: r.chargedAt.toISOString(),
    refundedAt: r.refundedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    // 「能不能对账」由状态决定，不由前端猜：只有还没拿到上游锚点的单才需要查单补交。
    // 已经有 jobId 的单靠 clip-render-notification 推进，手工插一脚只会和它抢。
    reconcilable: (UNANCHORED_STATUSES as readonly string[]).includes(r.status) && !r.upstreamJobId,
  }));
  return { total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)), items };
}

/** 这一屏归爱速拍。单列出来，免得路由那边把产品码写成字面量。 */
export const CLIP_OPS_PRODUCT = PRODUCT.quickreel;


/* ─────────── 模板货架 ───────────
 * 模板就是爱速拍的首页：内容即产品，上下架是最高频的运营动作。
 *
 * 模板存在 AIStar 那边（clip_template 表），这里只做代理。之前没有任何控制台能碰它 ——
 * AIStar 的 /api/admin/clip/templates 需要一枚 staff JWT，军师 BFF 手里只有 clip service token，
 * 调过去必然 403；而全仓也没有任何前端调过那几条接口。为此在 AIStar 侧加了一条
 * service token 鉴权的只读 + 上下架路径（ClipServiceAdminController），这里对接它。
 *
 * **只做看和上下架，不做创建与整体编辑**：模板的 scriptSkeleton / timeline 是内容创作产物，
 * 不是几个表单字段。给它做半吊子的编辑表单，运营一存就可能把配好的片尾和分镜清掉。
 */

/** AIStar 的运营面不需要属主，但 ClipServiceIdentity.require 仍要求一个合法 owner id。 */
const ADMIN_SENTINEL: VideoGatewayIdentity = { userId: 'junshi-admin-console', tenantId: 'junshi' };

export async function listClipTemplates(): Promise<ClipAdminTemplate[]> {
  const rows = await aidramaJson<ClipAdminTemplate[]>(
    '/api/service/clip/admin/templates', ADMIN_SENTINEL, { timeoutCapMs: 15_000 });
  return Array.isArray(rows) ? rows : [];
}

export async function setClipTemplateStatus(id: string, status: 'published' | 'draft'): Promise<ClipAdminTemplate> {
  return aidramaJson<ClipAdminTemplate>(
    `/api/service/clip/admin/templates/${encodeURIComponent(id)}/status`, ADMIN_SENTINEL,
    { method: 'PUT', body: { status }, timeoutCapMs: 15_000 },
  );
}


/**
 * 爱速拍的六档生成单价（只读）。
 *
 * 这六个数**配在 AIStar 的 Spring 配置里**（ClipProperties → application.yml / 环境变量），
 * 不是数据库，所以后台改不了 —— 改它要改目标机上的配置再重启 AIStar。
 *
 * 本仓的定价铁律是「会影响真实用户的对外数据归运营后台，代码不许当真相源」
 * （见 services/video/pricing.ts 顶部）。这六档今天不满足那条规矩，这是一笔明账。
 * 把它做成可改需要在 AIStar 侧加表 + 迁移 + 覆盖优先级 + 缓存失效，还要保证端上与服务端
 * 算出的报价仍然逐分钱一致（不一致就是每次生成都 409），值得单独一轮来做。
 *
 * 在那之前，至少让运营**看得见**：不知道单价是多少，连「这个价对不对」都没法判断。
 */
export async function clipGenerationPricing(): Promise<ClipGenerationPricing> {
  return aidramaJson<ClipGenerationPricing>('/api/me/clip/pricing', ADMIN_SENTINEL, { timeoutCapMs: 10_000 });
}


/**
 * 供应商（石榴）总览：额度快照 + 与我方 DB 的对账。**只读，实时打上游，不走缓存。**
 *
 * 独立运营要能回答两件事：数字人 / 声音的槽位还剩几个（用完了用户就练不了新形象），
 * 以及两边有没有对不上的对象（孤儿 = 供应商那边有、我们这边没有，每个月照样收钱）。
 *
 * 不做任何清理动作。清孤儿要连本地记录与素材一起处理，误删就是把用户练好的数字人弄没了，
 * 那不是一个按钮能收口的事（AIStar 侧 AdminClipController.vendorOverview 上也是这么写的）。
 */
export async function clipVendorOverview(): Promise<ClipVendorOverview> {
  return aidramaJson<ClipVendorOverview>(
    '/api/service/clip/admin/vendor/overview', ADMIN_SENTINEL,
    // 实时打上游、还要和本地库对账，比普通读接口慢得多；给它单独一个更宽的预算。
    { timeoutCapMs: 30_000 },
  );
}
