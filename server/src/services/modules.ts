// V7-08：能力/模块中心服务。合并「目录真相源（data/modules.ts）」与「用户启用态（UserModule 表）」→ ModulesView。
// tier 分流启用：free 直启（幂等）；credits 走 credits.ts 扣算力；sku 校验 SKU 已购（未购 402 SKU_REQUIRED）；
// member 校验 assertPlanActive（过期 403）。所有查询按 tenantId+userId 行级隔离。计费一律复用 credits/tokenQuota，不自造。
import type { Prisma, UserModule } from '@prisma/client';
import { prisma } from '../db.js';
import { chargeCredits } from './credits.js';
import { assertPlanActive } from './tokenQuota.js';
import { activeCasefile, todayStr } from './casefile.js';
import { MODULES, MODULE_INDEX, getModule, type ModuleCatalogItem } from '../data/modules.js';
import type { ModuleView, ModulesView, JourneyStage } from '../../../shared/contracts';

type RowMap = Map<string, UserModule>;

/** 加载该用户全部 UserModule 行（按 moduleKey 索引）。行级隔离：tenantId + userId。 */
async function loadRows(tenantId: string, userId: string): Promise<RowMap> {
  const rows = await prisma.userModule.findMany({ where: { tenantId, userId } });
  return new Map(rows.map((r) => [r.moduleKey, r]));
}

/**
 * 一个 sku 模块「视为已购/已启用」要查的 UserModule.moduleKey 集合：
 *   - 模块自身 key（deep-contradiction 自身 key === grantsModuleKey，且 admin 直启也用自身 key）；
 *   - price.skuKey（= SKU.grantsModuleKey，module 类 SKU 购买后 purchase.ts 写的就是这个 key）；
 *   - 'sku:'+skuKey（service 类一次性凭据，防御性覆盖）。
 */
function purchaseKeys(m: ModuleCatalogItem): string[] {
  const keys = [m.key];
  if (m.price?.skuKey) keys.push(m.price.skuKey, `sku:${m.price.skuKey}`);
  return keys;
}

/** 计算某模块对该用户是否已启用。free 恒真；sku 看购买集合任一命中；credits/member 看自身行。 */
function computeEnabled(m: ModuleCatalogItem, rows: RowMap): boolean {
  if (m.tier === 'free') return true;
  if (m.tier === 'sku') return purchaseKeys(m).some((k) => rows.get(k)?.enabled === true);
  return rows.get(m.key)?.enabled === true; // credits / member
}

/** 目录条目 + 用户行 → ModuleView。 */
function toView(m: ModuleCatalogItem, rows: RowMap): ModuleView {
  const own = rows.get(m.key);
  const index = MODULE_INDEX.get(m.key) ?? 0;
  const enabled = computeEnabled(m, rows);
  // 已启用 → 统一「已启用」；免费模块保留其目录态文案（默认启用 / 可直接调用 / 基础版免费）。
  const stateLabel = enabled && m.tier !== 'free' ? '已启用' : m.stateLabel;
  // sortOrder：仅正整数视为用户显式排序（我的页拖拽）；0/未设 → 按目录序（含 SKU 购买写入的默认 0）。
  const sortOrder = own && own.sortOrder > 0 ? own.sortOrder : index;
  return {
    key: m.key,
    label: m.label,
    desc: m.desc,
    iconChar: m.iconChar,
    group: m.group,
    tier: m.tier,
    price: m.price,
    stateLabel,
    enabled,
    hidden: own?.hidden ?? false,
    sortOrder,
    detail: m.detail,
    agentKey: m.agentKey ?? null,
  };
}

// journey 阶段 → 推荐模块（纯规则映射，不走 LLM）。
const STAGE_RECOMMEND: Record<JourneyStage, string> = {
  new: 'conflict',
  scanned: 'deep-contradiction',
  diagnosing: 'deep-contradiction',
  plan_ready: 'daily-command',
  executing: 'growth',
  reviewing: 'weekly-review',
};

/** 兜底：第一条深度模块。 */
function firstDeepKey(): string {
  return MODULES.find((m) => m.group === 'deep')?.key ?? MODULES[0].key;
}

/**
 * 推荐位 key（纯规则）：
 *   1) 有活跃案卷且「今日军令未完成 或 今日无数据回填」→ growth（增长漏斗诊断，先补漏斗证据）；
 *   2) 否则按 journey 阶段映射；
 *   3) 阶段无映射 → 第一条深度模块。
 * 只读、无副作用（不创建 journey 行）。
 */
async function recommendedKey(userId: string): Promise<string> {
  const cf = await activeCasefile(userId);
  if (cf) {
    const date = todayStr();
    const [orders, metric] = await Promise.all([
      prisma.casefileOrder.findMany({ where: { casefileId: cf.id, date }, select: { done: true } }),
      prisma.casefileMetric.findFirst({ where: { casefileId: cf.id, date }, select: { id: true } }),
    ]);
    const hasUnfilled = orders.some((o) => !o.done);
    if (hasUnfilled || !metric) return 'growth';
  }
  const j = await prisma.userJourney.findUnique({ where: { userId }, select: { stage: true } });
  const stage = (j?.stage as JourneyStage) ?? 'new';
  return STAGE_RECOMMEND[stage] ?? firstDeepKey();
}

/** GET /modules 数据源：目录 × 用户态合并 + 推荐位。隐藏模块仍返回（flag hidden），按 sortOrder→目录序排列。 */
export async function listForUser(args: { tenantId: string; userId: string }): Promise<ModulesView> {
  const { tenantId, userId } = args;
  const rows = await loadRows(tenantId, userId);
  const modules = MODULES.map((m) => toView(m, rows)).sort(
    (a, b) => a.sortOrder - b.sortOrder || (MODULE_INDEX.get(a.key)! - MODULE_INDEX.get(b.key)!),
  );
  const recKey = await recommendedKey(userId);
  const recommended = modules.find((v) => v.key === recKey) ?? null;
  return { recommended, modules };
}

/** 领域错误：sku 未购买。携带 skuKey 供前端跳转对应 SKU 支付。 */
function skuRequired(skuKey?: string): Error & { statusCode: number; code: string; skuKey?: string } {
  return Object.assign(new Error('该能力需购买后启用'), { statusCode: 402, code: 'SKU_REQUIRED', skuKey });
}

/** 幂等 upsert 自身 key 行（启用态）。sortOrder 不设（默认 0 → 视图按目录序），不覆盖用户 PATCH 的排序。 */
async function enableRow(tenantId: string, userId: string, moduleKey: string, source: string): Promise<void> {
  await prisma.userModule.upsert({
    where: { userId_moduleKey: { userId, moduleKey } },
    update: { enabled: true, hidden: false, source },
    create: { tenantId, userId, moduleKey, enabled: true, hidden: false, source },
  });
}

/**
 * 启用一个能力（tier 分流）：
 *   - free    → 直启（幂等 upsert，source='free'）。
 *   - credits → 已启用则幂等返回（不重复扣费）；否则 chargeCredits(price.credits)（不足抛 402），再 upsert（source='purchase'）。
 *   - sku     → 校验已购（purchaseKeys 命中）；未购抛 402 SKU_REQUIRED(skuKey)。已购则确保自身行启用。
 *   - member  → assertPlanActive（过期抛 403 PLAN_EXPIRED），再 upsert（source='purchase'）。
 * 返回更新后的 ModuleView。
 */
export async function enable(args: { tenantId: string; userId: string; moduleKey: string }): Promise<ModuleView> {
  const { tenantId, userId, moduleKey } = args;
  const m = getModule(moduleKey);
  if (!m) throw Object.assign(new Error('能力不存在'), { statusCode: 404, code: 'MODULE_NOT_FOUND' });

  switch (m.tier) {
    case 'free':
      await enableRow(tenantId, userId, m.key, 'free');
      break;
    case 'credits': {
      const rows = await loadRows(tenantId, userId);
      if (!computeEnabled(m, rows)) {
        const cost = m.price?.credits ?? 0;
        await chargeCredits(tenantId, userId, cost, `启用能力 · ${m.label}`); // 不足抛 InsufficientCreditsError(402)
        await enableRow(tenantId, userId, m.key, 'purchase');
      }
      break;
    }
    case 'sku': {
      const rows = await loadRows(tenantId, userId);
      if (!computeEnabled(m, rows)) throw skuRequired(m.price?.skuKey); // 未购 → 402 SKU_REQUIRED
      await enableRow(tenantId, userId, m.key, 'purchase'); // 已购：确保自身行启用（deep-contradiction 自身即购买 key）
      break;
    }
    case 'member': {
      await assertPlanActive(userId); // 过期抛 PlanExpiredError(403)
      await enableRow(tenantId, userId, m.key, 'purchase');
      break;
    }
  }

  const rows = await loadRows(tenantId, userId);
  return toView(m, rows);
}

/**
 * 我的页模块管理：隐藏 / 排序持久化（不改 enabled）。upsert 自身 key 行。
 * 新建行时 enabled 取当前有效启用态（避免 schema 默认 true 误把未启用模块标为已启用）。
 */
export async function patchModule(args: {
  tenantId: string;
  userId: string;
  moduleKey: string;
  hidden?: boolean;
  sortOrder?: number;
}): Promise<ModuleView> {
  const { tenantId, userId, moduleKey, hidden, sortOrder } = args;
  const m = getModule(moduleKey);
  if (!m) throw Object.assign(new Error('能力不存在'), { statusCode: 404, code: 'MODULE_NOT_FOUND' });

  const rows = await loadRows(tenantId, userId);
  const existing = rows.get(m.key);
  const update: Prisma.UserModuleUpdateInput = {};
  if (typeof hidden === 'boolean') update.hidden = hidden;
  if (typeof sortOrder === 'number' && Number.isFinite(sortOrder)) update.sortOrder = Math.max(0, Math.trunc(sortOrder));

  await prisma.userModule.upsert({
    where: { userId_moduleKey: { userId, moduleKey: m.key } },
    update,
    create: {
      tenantId,
      userId,
      moduleKey: m.key,
      enabled: computeEnabled(m, rows), // 保持当前启用态，勿被 schema 默认 true 污染
      hidden: typeof hidden === 'boolean' ? hidden : false,
      sortOrder: typeof sortOrder === 'number' && Number.isFinite(sortOrder) ? Math.max(0, Math.trunc(sortOrder)) : 0,
      source: existing?.source ?? 'free',
    },
  });

  const after = await loadRows(tenantId, userId);
  return toView(m, after);
}
