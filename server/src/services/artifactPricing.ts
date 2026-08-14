// 产出物价格表：**钻石价挂在「产出物 × 规格」上，不挂 agent**（2026-08-13 拍板）。
//
// ── 为什么不挂 agent（这是本模块存在的理由）──
//
// 计费分两条轴：
//   · **对话轴** = agent 的属性 —— 这个军师费不费 token、倍率多少（Agent.billingRatio）。
//     它天然属于 agent：同一个人跟不同军师聊，成本本来就不同。
//   · **产出轴** = 产出物的属性 —— 一张标准海报 10 钻、高级海报 25 钻。
//     它**不属于任何一位军师**：等名片设计师、易拉宝设计师都用上 canvas_design，
//     价格若挂在 agent 上就会变成「同一张海报在不同入口卖不同价」，用户一比就穿帮。
//
// 所以这里按 `技能 key × 规格` 存价，谁调用这个技能都拿到同一个价。
//
// ── 数据归属 ──
//
// 价格是**运营数据**（见 memory「对外数据归运营不归代码」）：本模块只提供读写口径，
// **不 seed、不写默认值进库**。库里没有配置时读到 null，由调用方决定回退到什么
// （海报那条链路回退到 creative 旧字段，见 creative/config.resolvePosterPrices）——
// 这样迁移期线上价格零变化，而不是被一个代码里的"默认值"悄悄改掉。
//
// FeatureFlag 行 `artifact-pricing` 只用 payload，**enabled 字段无意义**（没有任何地方读它）：
// 它是一张价目表，不是开关。别给它加语义。
import { featureFlagPayload, setFeatureFlagPayload } from './featureFlag.js';
import type { Prisma } from '@prisma/client';

export const ARTIFACT_PRICING_FLAG_ID = 'artifact-pricing';

/**
 * 规格。当前只有海报用到两档；新增产出物若没有规格之分，用 `standard` 一档即可
 * （别为了"看起来对称"给它编一个用不上的 premium）。
 */
export const ARTIFACT_VARIANTS = ['standard', 'premium'] as const;
export type ArtifactVariant = (typeof ARTIFACT_VARIANTS)[number];

/** 单个技能的价目：规格 → 钻石数。缺的规格 = 没配，不是 0。 */
export type ArtifactSkillPrices = Partial<Record<ArtifactVariant, number>>;
export type ArtifactPriceTable = Record<string, ArtifactSkillPrices>;

/** 价格上限与 creative 侧同口径（0–10000），越界按未配处理——宁可回退也不用一个离谱的数扣费。 */
const MAX_PRICE = 10_000;

function priceOf(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) return null;
  return Math.round(n);
}

function tableOf(raw: unknown): ArtifactPriceTable {
  const out: ArtifactPriceTable = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [skill, prices] of Object.entries(raw as Record<string, unknown>)) {
    if (!skill || !prices || typeof prices !== 'object' || Array.isArray(prices)) continue;
    const entry: ArtifactSkillPrices = {};
    for (const variant of ARTIFACT_VARIANTS) {
      const n = priceOf((prices as Record<string, unknown>)[variant]);
      if (n !== null) entry[variant] = n;
    }
    if (Object.keys(entry).length) out[skill] = entry;
  }
  return out;
}

/** 读整张价目表（未配置 → 空对象，不是抛错）。 */
export async function getArtifactPrices(opts: { fresh?: boolean } = {}): Promise<ArtifactPriceTable> {
  return tableOf(await featureFlagPayload(ARTIFACT_PRICING_FLAG_ID, opts));
}

/**
 * 查一个价。**未配置返回 null**，绝不返回 0 —— 0 是「免费」这个明确的业务含义，
 * 而 null 是「这里没数，去回退」。把两者混成一个值，迁移期会把一整条付费链路悄悄变成免费。
 */
export function artifactPrice(
  table: ArtifactPriceTable,
  skillKey: string,
  variant: ArtifactVariant,
): number | null {
  return table[skillKey]?.[variant] ?? null;
}

/**
 * 局部更新价目表（只覆盖传进来的键，其余原样保留）。
 * 传 `null` 清掉某个规格的价（回到"未配置"→ 走调用方的回退），传数字则写入。
 */
export async function updateArtifactPrices(
  patch: Record<string, Partial<Record<ArtifactVariant, number | null>>>,
): Promise<ArtifactPriceTable> {
  const cur = await getArtifactPrices({ fresh: true });
  const next: ArtifactPriceTable = { ...cur };
  for (const [skill, prices] of Object.entries(patch)) {
    if (!skill || !prices) continue;
    const entry: ArtifactSkillPrices = { ...(next[skill] ?? {}) };
    for (const variant of ARTIFACT_VARIANTS) {
      if (!(variant in prices)) continue;
      const raw = prices[variant];
      if (raw === null) { delete entry[variant]; continue; }
      const n = priceOf(raw);
      if (n !== null) entry[variant] = n;
    }
    if (Object.keys(entry).length) next[skill] = entry;
    else delete next[skill];
  }
  await setFeatureFlagPayload(ARTIFACT_PRICING_FLAG_ID, next as unknown as Prisma.InputJsonValue);
  return next;
}
