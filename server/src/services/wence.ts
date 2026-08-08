// 问策入口改版 WP1：实验分桶 + 模板池读取。
//
// 分桶铁律：**稳定哈希，不用 Math.random**。同一 userId 任何时刻、任何实例算出的组必须一致——
// 否则用户每次进 tab 看到的形态都在跳，A/B 数据也就没有归因可言（这是无状态分桶取代
// 「建表存分配」的唯一前提，见 llmPool 的 HRW 同一理由：各实例同输入独立算出同结果）。
//
// 降级口径：开关关 / payload 缺失 / 权重非法（全 0、负数、非对象）→ 'control'。
// control 就是零改动现状，所以任何不确定都往 control 落，不会把用户扔进半成品形态。
import { createHash } from 'node:crypto';
import type { WenceForm } from '../../../shared/contracts';
import { prisma } from '../db.js';
import { isFeatureEnabled, featureFlagPayload } from './featureFlag.js';

/** 问策入口实验开关 key（同时登记在 routes/admin.ts 的 FEATURE_FLAG_CATALOG）。 */
export const WENCE_FLAG = 'wence_entry';

/**
 * 分桶权重的默认口径：三臂均分。**开关已开但 payload 未配 / 非法时的实际生效值**——
 * 不是回 control。理由：「开关开了却静默零分流」会让运营以为实验在收数据，
 * 比误开实验更坏，因为它失败得无声。catalog 的 desc 也是这么向运营承诺的。
 * 安全性由写入端保证：PATCH /admin/flags/:id 的 arms 校验挡住了非法权重入库，
 * 运营路径写不进坏 payload，所以兜底到均分不会把人分到「运营没打算开的臂」。
 */
export const DEFAULT_ARMS: Record<WenceForm, number> = { control: 34, dock: 33, chat: 33 };

const FORMS: WenceForm[] = ['control', 'dock', 'chat'];

/** payload 形如 { arms: { control: 34, dock: 33, chat: 33 } }；读不出合法权重返回 null。 */
function parseArms(payload: unknown): Record<WenceForm, number> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const arms = (payload as { arms?: unknown }).arms;
  if (!arms || typeof arms !== 'object' || Array.isArray(arms)) return null;
  const out = {} as Record<WenceForm, number>;
  let total = 0;
  for (const f of FORMS) {
    const raw = (arms as Record<string, unknown>)[f];
    const n = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
    out[f] = n;
    total += n;
  }
  return total > 0 ? out : null;
}

/**
 * userId → [0,1) 的稳定分值。sha1 取前 8 个 hex（32 bit）而不是 JS 的字符串 hash：
 * 后者对形如 cuid 的近似前缀会聚簇，桶分布明显偏斜。加盐（开关 key）保证以后再开别的实验时，
 * 同一批用户不会在两个实验里被同一条分界线切成同样的两拨（分桶相关性会污染两个实验的结论）。
 */
export function bucketRatio(userId: string, salt = WENCE_FLAG): number {
  const hex = createHash('sha1').update(`${salt}:${userId}`).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 0x1_0000_0000;
}

/** 纯函数分桶（不碰 DB，供测试与调用方直接复用）：按 arms 权重把 [0,1) 切成连续区间。 */
export function pickArm(userId: string, arms: Record<WenceForm, number>): WenceForm {
  const total = FORMS.reduce((s, f) => s + arms[f], 0);
  if (total <= 0) return 'control';
  const point = bucketRatio(userId) * total;
  let acc = 0;
  for (const f of FORMS) {
    acc += arms[f];
    if (point < acc) return f;
  }
  return 'control'; // 浮点边界兜底
}

/**
 * payload → 实际生效的权重。**唯一口径**：读得出合法权重就用它，否则均分兜底。
 * 后台展示（routes/admin.ts 的 shapeFlag）与运行时分桶必须共用本函数——
 * 运营在后台看到的权重就是真正生效的权重，两边分头算迟早漂移。
 */
export function effectiveArms(payload: unknown): Record<WenceForm, number> {
  return parseArms(payload) ?? DEFAULT_ARMS;
}

/**
 * 解析某用户的问策入口形态。
 * · 开关**关闭** → 'control'（零改动现状，实验没开）。
 * · 开关**开启** → 按生效权重稳定分桶；payload 未配 / 非法时按 DEFAULT_ARMS 三臂均分，
 *   **不回 control**——运营把开关拨开了就该真的在分流，静默零分流是最难发现的一类故障。
 * 挂在 /me 的 features 上下发；客户端不许自己猜（游客没有 userId，也就没有 /me，端上按本地兜底渲染）。
 */
export async function resolveWenceForm(userId: string): Promise<WenceForm> {
  // 默认 false：实验开关必须运营显式打开才生效，不能因为「行还没建」就把全量用户扔进实验。
  if (!(await isFeatureEnabled(WENCE_FLAG, false))) return 'control';
  return pickArm(userId, effectiveArms(await featureFlagPayload(WENCE_FLAG)));
}

/**
 * 游客的问策入口形态（随 GET /wence/hints 下发，游客没有 /me 可读）。
 * · 开关**关闭** → 'control'（零改动现状）。
 * · 开关**开启**且 chat 臂权重 > 0 → 'chat'。
 * 游客没有稳定 userId：分桶既算不出稳定值，也无法在漏斗里归因，所以不对游客做三臂分流，
 * 只回答「chat 这条臂开没开」。'dock' 不下发——那一臂本来就是列表形态，与 control 同一条渲染路径。
 * 登录后端上必须改读 /me.features.wenceForm 的正式分桶，不得继续用这个值。
 */
export async function resolveGuestForm(): Promise<'control' | 'chat'> {
  if (!(await isFeatureEnabled(WENCE_FLAG, false))) return 'control';
  return effectiveArms(await featureFlagPayload(WENCE_FLAG)).chat > 0 ? 'chat' : 'control';
}

/** 提示词池：enabled 的 hint 模板，按 sort 升序（同 sort 按创建时间稳定排）。空池返回 []。 */
export async function listHints(): Promise<{ id: string; text: string }[]> {
  const rows = await prisma.wenceTemplate.findMany({
    where: { kind: 'hint', enabled: true },
    orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, text: true },
  });
  return rows.map((r) => ({ id: r.id, text: r.text }));
}

/** 主动消息模板：enabled 的 proactive 首条（按 sort）。空池返回 null——调用方据此走 empty-pool 降级。 */
export async function firstProactiveTemplate(): Promise<{ id: string; text: string; chips: string[] | null } | null> {
  const row = await prisma.wenceTemplate.findFirst({
    where: { kind: 'proactive', enabled: true },
    orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, text: true, chipsJson: true },
  });
  if (!row) return null;
  return { id: row.id, text: row.text, chips: normalizeChips(row.chipsJson) };
}

/** chipsJson → string[]：只收非空字符串，最多 4 条；不是数组/空数组一律 null（端上据此不渲染这一排）。 */
export function normalizeChips(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const chips = raw.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim()).slice(0, 4);
  return chips.length ? chips : null;
}
