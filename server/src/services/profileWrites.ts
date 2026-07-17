// 档案写入的单一真相源（Chat-First 重构 · WO-S）：
// PUT /profile、PUT /profile/bazi 与入帐状态机 onboarding.ts 共用同一套落库逻辑，避免行为漂移。
// 审计（recordAudit）仍留在各路由层，这里只做纯数据写入。

import { prisma } from '../db.js';
import { computeAndStoreChart, validatePaipanInput, type ChartView } from './paipan.js';
import { cityLongitude } from '../data/cityLongitude.js';
import { now } from './clock.js';

type ProfileFields = { industry?: string; stage?: string; pain?: string; extra?: object };

/**
 * upsert 企业档案字段（industry/stage/pain），并同步租户行业/阶段。
 * 只写传入的字段（undefined 不覆盖已有值）。创建 Profile 行 = onboarded。
 * 抽自 profile.ts PUT /profile，供入帐状态机复用。
 */
export async function upsertProfileFields(tenantId: string, fields: ProfileFields): Promise<{ industry: string | null; stage: string | null; pain: string | null }> {
  const existing = await prisma.profile.findFirst({ where: { tenantId } });
  const data = {
    industry: fields.industry,
    stage: fields.stage,
    pain: fields.pain,
    extraJson: fields.extra ?? undefined,
  };
  const p = existing
    ? await prisma.profile.update({ where: { id: existing.id }, data })
    : await prisma.profile.create({ data: { ...data, tenantId } });
  await prisma.tenant.update({
    where: { id: tenantId },
    data: { industry: p.industry ?? undefined, stage: p.stage ?? undefined },
  });
  return { industry: p.industry, stage: p.stage, pain: p.pain };
}

export interface BaziBody {
  calendar?: 'solar' | 'lunar';
  year?: number; month?: number; day?: number;
  hour?: number | null; minute?: number;
  gender?: 'male' | 'female';
  birthPlace?: string; longitude?: number;
  believe?: boolean;
}

export type SaveBaziResult =
  | { ok: true; believe: false; chart: null }
  | { ok: true; believe: true; chart: ChartView }
  | { ok: false; error: string };

/**
 * 八字采集：先落偏好（含不信命理开关，排盘失败也不丢采集），信命理则排盘落库。
 * 抽自 profile.ts PUT /profile/bazi，供入帐状态机复用。返回判定结果供路由决定 audit / 状态码。
 */
export async function saveUserBazi(user: { id: string; tenantId: string }, body: BaziBody): Promise<SaveBaziResult> {
  const b = body ?? {};
  const believe = b.believe !== false;

  const existing = await prisma.profile.findFirst({ where: { tenantId: user.tenantId } });
  const extra = { ...((existing?.extraJson as object) ?? {}), bazi: { ...b, believe } };
  if (existing) await prisma.profile.update({ where: { id: existing.id }, data: { extraJson: extra } });
  else await prisma.profile.create({ data: { tenantId: user.tenantId, extraJson: extra } });

  if (!believe) return { ok: true, believe: false, chart: null };

  const v = validatePaipanInput(b, now().getFullYear());
  if (!v.ok) return { ok: false, error: v.error };
  try {
    const chart = await computeAndStoreChart({
      tenantId: user.tenantId,
      userId: user.id,
      input: { ...v.input, longitude: v.input.longitude ?? cityLongitude(b.birthPlace) },
      targetYear: now().getFullYear(),
    });
    return { ok: true, believe: true, chart };
  } catch {
    return { ok: false, error: '生辰无法排盘，请检查日期是否存在（如农历大小月/闰月）' };
  }
}
