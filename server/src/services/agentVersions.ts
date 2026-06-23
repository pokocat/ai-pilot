// 智能体版本化服务（P0/P1 地基）。
//
// 模型：Agent 行 = 运营正在编辑的「工作草稿」；AgentVersion = 发布时冻结的不可变快照。
// C 端运行时只读 Agent.publishedVersionId 指向的快照（resolveEffectiveAgent），与草稿隔离——
// 运营怎么改草稿、怎么沙盒试，都不影响线上已发布版本，直到「发布」才生效。
//
// 调教越好→倍率越高→卖越贵：billingRatio 等定价字段随版本走，发布即冻结，C 端按版本扣额度。

import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import type { Prisma } from '@prisma/client';
import type { AgentVersionDetail } from '../../../shared/contracts';

// 冻结进版本的「行为 + 定价 + 接入」字段（Agent 与 AgentVersion 上同名同义）。
// 改这里就同时影响快照、哈希去重、字段级 diff —— 单一事实来源。
export const SNAPSHOT_FIELDS = [
  'systemPrompt', 'memoryConfig', 'skillsConfig', 'greet', 'deliverableKey',
  'chipsJson', 'memText', 'learnText', // P1-A5：面向用户的行为内容随版本冻结
  'billing', 'price', 'billingRatio', 'meterUnit',
  'providerMode', 'apiBaseUrl', 'apiModel', 'apiKey', 'difyBaseUrl', 'difyApiKey', 'difyInputs',
] as const;
type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];
export type SnapshotInput = Record<SnapshotField, unknown>;

// Json 字段（需按 Prisma.InputJsonValue 写入；可空的传 null）。
const JSON_FIELDS = new Set<SnapshotField>(['memoryConfig', 'skillsConfig', 'difyInputs', 'chipsJson']);

/** 运行时/计费实际生效的「有效配置」——身份取 Agent 行，行为/定价/接入取已解析到的版本（或草稿回退）。 */
export interface EffectiveAgentConfig {
  // 身份（恒取 Agent 行，不随版本走）
  key: string;
  name: string;
  role: string;
  icon: string;
  type: string;
  enabled: boolean;
  // 解析来源
  source: 'published' | 'draft' | 'version';
  versionId: string | null; // 实际使用的 AgentVersion.id；null=回退草稿
  versionNumber: number | null;
  // 行为 + 定价 + 接入（取版本快照或草稿）
  systemPrompt: string;
  memoryConfig: unknown;
  skillsConfig: unknown;
  greet: string;
  deliverableKey: string | null;
  billing: string;
  price: number;
  billingRatio: number;
  meterUnit: string;
  providerMode: string;
  apiBaseUrl: string | null;
  apiModel: string | null;
  apiKey: string | null;
  difyBaseUrl: string | null;
  difyApiKey: string | null;
  difyInputs: unknown;
}

export type PreviewTarget = 'draft' | { versionId: string };

// 从 Agent 或 AgentVersion 行抽出快照字段。
function pickSnapshot(src: Record<string, unknown>): SnapshotInput {
  const out = {} as SnapshotInput;
  for (const f of SNAPSHOT_FIELDS) out[f] = src[f] ?? null;
  return out;
}

// 把抽出的快照字段映射为可写入 AgentVersion 的 data（Json 字段做类型修饰）。
function snapshotToData(src: Record<string, unknown>): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of SNAPSHOT_FIELDS) {
    const v = src[f] ?? null;
    data[f] = JSON_FIELDS.has(f) ? (v as Prisma.InputJsonValue) : v;
  }
  return data;
}

function behaviorFrom(src: Record<string, unknown>): Omit<EffectiveAgentConfig, 'key' | 'name' | 'role' | 'icon' | 'type' | 'enabled' | 'source' | 'versionId' | 'versionNumber'> {
  return {
    systemPrompt: (src.systemPrompt as string) ?? '',
    memoryConfig: src.memoryConfig ?? {},
    skillsConfig: src.skillsConfig ?? null,
    greet: (src.greet as string) ?? '',
    deliverableKey: (src.deliverableKey as string | null) ?? null,
    billing: (src.billing as string) ?? 'free',
    price: (src.price as number) ?? 0,
    billingRatio: (src.billingRatio as number) ?? 1,
    meterUnit: (src.meterUnit as string) ?? 'text',
    providerMode: (src.providerMode as string) ?? 'inherit',
    apiBaseUrl: (src.apiBaseUrl as string | null) ?? null,
    apiModel: (src.apiModel as string | null) ?? null,
    apiKey: (src.apiKey as string | null) ?? null,
    difyBaseUrl: (src.difyBaseUrl as string | null) ?? null,
    difyApiKey: (src.difyApiKey as string | null) ?? null,
    difyInputs: src.difyInputs ?? null,
  };
}

function identityFrom(agent: Record<string, unknown>) {
  return {
    key: agent.key as string,
    name: agent.name as string,
    role: agent.role as string,
    icon: agent.icon as string,
    type: agent.type as string,
    enabled: agent.enabled as boolean,
  };
}

/**
 * 解析某 agent 当前生效的有效配置。
 * - 默认（C 端）：用 Agent.publishedVersionId 指向的已发布快照；尚未发布 → 优雅回退草稿（向后兼容未回填的 agent）。
 * - preview='draft'（沙盒/评测）：直接用 Agent 行的草稿。
 * - preview={versionId}（评测某历史版本/AB 对比）：用指定版本；找不到 → 回退草稿。
 */
export async function resolveEffectiveAgent(
  agentKey: string,
  preview?: PreviewTarget,
): Promise<EffectiveAgentConfig | null> {
  const agent = (await prisma.agent.findUnique({ where: { key: agentKey } })) as Record<string, unknown> | null;
  if (!agent) return null;

  const asDraft = (): EffectiveAgentConfig => ({
    ...identityFrom(agent), source: 'draft', versionId: null, versionNumber: null, ...behaviorFrom(agent),
  });

  if (preview === 'draft') return asDraft();

  let versionId: string | null = null;
  let wantVersion = false;
  if (preview && typeof preview === 'object') { versionId = preview.versionId; wantVersion = true; }
  else { versionId = (agent.publishedVersionId as string | null) ?? null; }

  if (!versionId) return asDraft(); // 未发布且非指定版本 → 草稿回退

  const ver = (await prisma.agentVersion.findUnique({ where: { id: versionId } })) as Record<string, unknown> | null;
  if (!ver || ver.agentKey !== agentKey) return asDraft(); // 指针悬空/跨 agent → 草稿回退（不抛错）

  return {
    ...identityFrom(agent),
    source: wantVersion ? 'version' : 'published',
    versionId: ver.id as string,
    versionNumber: ver.version as number,
    ...behaviorFrom(ver),
  };
}

// —— 内容哈希（稳定序列化，键排序）：同配置 = 同 hash，用于发布去重 ——
function canonical(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj) ?? 'null';
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical((obj as Record<string, unknown>)[k])}`).join(',')}}`;
}
export function hashSnapshot(src: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(pickSnapshot(src))).digest('hex');
}

// —— 字段级变更摘要（相对上一版）。文本/对象只标「有改动」，数值/枚举给 前→后 ——
const FIELD_LABELS: Partial<Record<SnapshotField, string>> = {
  systemPrompt: '提示词', greet: '开场白', memoryConfig: '记忆配置', skillsConfig: '技能',
  deliverableKey: '产出模板', billing: '计费方式', price: '价格', billingRatio: '倍率',
  meterUnit: '计量单位', providerMode: '接入方式',
};
const SCALAR_FIELDS = new Set<SnapshotField>(['billing', 'price', 'billingRatio', 'meterUnit', 'providerMode', 'deliverableKey']);

export function diffSnapshots(before: Record<string, unknown>, after: Record<string, unknown>): string {
  const a = pickSnapshot(before);
  const b = pickSnapshot(after);
  const parts: string[] = [];
  for (const f of SNAPSHOT_FIELDS) {
    const changed = JSON_FIELDS.has(f) || typeof a[f] === 'object'
      ? canonical(a[f]) !== canonical(b[f])
      : a[f] !== b[f];
    if (!changed) continue;
    const label = FIELD_LABELS[f];
    if (SCALAR_FIELDS.has(f) && label) parts.push(`${label} ${fmt(a[f])}→${fmt(b[f])}`);
    else if (f === 'apiBaseUrl' || f === 'apiModel' || f === 'apiKey' || f === 'difyBaseUrl' || f === 'difyApiKey' || f === 'difyInputs') {
      if (!parts.includes('接入配置有改动')) parts.push('接入配置有改动');
    } else if (label) parts.push(`${label}有改动`);
  }
  return parts.length ? parts.join(' · ') : '无字段变更';
}
function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '空';
  return String(v);
}

export interface PublishResult {
  version: number;
  versionId: string;
  changed: boolean;       // 是否产生了新版本（false=与当前已发布版本同配置，未重复成版）
  changeSummary: string;
}

async function lockAgentPublish(db: Prisma.TransactionClient, agentKey: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent-publish:${agentKey}`}))`;
}

/**
 * 发布：把当前草稿（Agent 行）冻结成一个新的已发布版本，指针指向它，清 draftDirty。
 * 去重：草稿与「最新版本」同 hash → 不重复成版，仅确保指针指向它（幂等）。
 */
export async function publishDraft(
  agentKey: string,
  opts: { accountId?: string | null; label?: string | null } = {},
): Promise<PublishResult> {
  return prisma.$transaction(async (tx) => {
    await lockAgentPublish(tx, agentKey);
    const agent = (await tx.agent.findUnique({ where: { key: agentKey } })) as Record<string, unknown> | null;
    if (!agent) throw Object.assign(new Error('agent not found'), { statusCode: 404, code: 'AGENT_NOT_FOUND' });

    const hash = hashSnapshot(agent);
    const latest = await tx.agentVersion.findFirst({ where: { agentKey }, orderBy: { version: 'desc' } });
    // P1-A4：去重/变更摘要基线取「当前已发布版本」而非「最新版本号」——回滚到 v2 后再发布同 v2 配置应识别为幂等，
    // 而非因 latest=v5 hash 不同误造 v6；摘要也应相对 v2 而非 v5。无已发布版本时退回 latest（兼容旧/首发）。
    const published = agent.publishedVersionId
      ? await tx.agentVersion.findUnique({ where: { id: agent.publishedVersionId as string } })
      : null;
    const baseline = published ?? latest;

    // 与基线同配置：不重复成版，只确保指针/状态指向它并清 dirty（幂等发布）。
    if (baseline && baseline.contentHash === hash) {
      if (agent.publishedVersionId !== baseline.id || agent.draftDirty) {
        await tx.agentVersion.updateMany({ where: { agentKey, status: 'published', NOT: { id: baseline.id } }, data: { status: 'archived' } });
        await tx.agentVersion.update({ where: { id: baseline.id }, data: { status: 'published', publishedAt: new Date() } });
        await tx.agent.update({ where: { key: agentKey }, data: { publishedVersionId: baseline.id, draftDirty: false } });
      }
      return { version: baseline.version, versionId: baseline.id, changed: false, changeSummary: baseline.changeSummary ?? '无字段变更' };
    }

    const changeSummary = baseline ? diffSnapshots(baseline as unknown as Record<string, unknown>, agent) : '首个版本';
    const nextVersion = (latest?.version ?? 0) + 1;

    const ver = await tx.agentVersion.create({
      data: {
        agentKey,
        version: nextVersion,
        status: 'published',
        label: opts.label?.trim() || null,
        changeSummary,
        contentHash: hash,
        createdBy: opts.accountId ?? null,
        publishedAt: new Date(),
        ...(snapshotToData(agent) as object),
      } as Prisma.AgentVersionUncheckedCreateInput,
    });
    await tx.agentVersion.updateMany({ where: { agentKey, status: 'published', NOT: { id: ver.id } }, data: { status: 'archived' } });
    await tx.agent.update({ where: { key: agentKey }, data: { publishedVersionId: ver.id, draftDirty: false } });
    return { version: ver.version, versionId: ver.id, changed: true, changeSummary };
  });
}

/** 回滚：把已发布指针重指到某个历史版本（不动草稿）。回滚后按草稿 vs 该版本重算 draftDirty。 */
export async function rollbackToVersion(agentKey: string, versionId: string): Promise<{ version: number }> {
  // P1-A3：与 publishDraft 同把回滚纳入 per-agent advisory lock + 单事务，杜绝「回滚×发布」并发交错留下两行 published / 指针错位。
  return prisma.$transaction(async (tx) => {
    await lockAgentPublish(tx, agentKey);
    const ver = await tx.agentVersion.findUnique({ where: { id: versionId } });
    if (!ver || ver.agentKey !== agentKey) throw Object.assign(new Error('version not found'), { statusCode: 404, code: 'VERSION_NOT_FOUND' });
    const agent = (await tx.agent.findUnique({ where: { key: agentKey } })) as Record<string, unknown> | null;
    const dirty = agent ? hashSnapshot(agent) !== ver.contentHash : false;
    await tx.agentVersion.updateMany({ where: { agentKey, status: 'published', NOT: { id: ver.id } }, data: { status: 'archived' } });
    await tx.agentVersion.update({ where: { id: ver.id }, data: { status: 'published', publishedAt: new Date() } });
    await tx.agent.update({ where: { key: agentKey }, data: { publishedVersionId: ver.id, draftDirty: dirty } });
    return { version: ver.version };
  });
}

/** 编辑草稿后调用：按草稿 vs 已发布版本精确重算 draftDirty（无已发布版本则视为 dirty）。 */
export async function recomputeDraftDirty(agentKey: string): Promise<boolean> {
  // P1-A3：同 lock，避免与发布并发交错把 draftDirty 写成陈旧值。
  return prisma.$transaction(async (tx) => {
    await lockAgentPublish(tx, agentKey);
    const agent = (await tx.agent.findUnique({ where: { key: agentKey } })) as Record<string, unknown> | null;
    if (!agent) return false;
    const pubId = agent.publishedVersionId as string | null;
    let dirty = true;
    if (pubId) {
      const pub = await tx.agentVersion.findUnique({ where: { id: pubId } });
      if (pub) dirty = pub.contentHash !== hashSnapshot(agent);
    }
    await tx.agent.update({ where: { key: agentKey }, data: { draftDirty: dirty } });
    return dirty;
  });
}

/** 版本历史（倒序）。 */
export async function listVersions(agentKey: string) {
  return prisma.agentVersion.findMany({ where: { agentKey }, orderBy: { version: 'desc' } });
}

/** P1-A6：单个版本完整内容（回滚前查看 / A-B 对比用）。租户无关，按 agentKey 校验防越权取错 agent。 */
export async function getVersionDetail(agentKey: string, versionId: string): Promise<AgentVersionDetail | null> {
  const v = await prisma.agentVersion.findUnique({ where: { id: versionId } });
  if (!v || v.agentKey !== agentKey) return null;
  return {
    id: v.id, version: v.version, status: v.status as AgentVersionDetail['status'], label: v.label,
    systemPrompt: v.systemPrompt, greet: v.greet, deliverableKey: v.deliverableKey,
    billing: v.billing as AgentVersionDetail['billing'], price: v.price, billingRatio: v.billingRatio,
    meterUnit: v.meterUnit, providerMode: v.providerMode,
    memText: v.memText, learnText: v.learnText, createdAt: v.createdAt.toISOString(),
  };
}
