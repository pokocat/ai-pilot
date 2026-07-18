// V7-07 数据源状态持久化服务：目录（data/dataSources.ts）+ 用户 UserDataSource 行合并为展示视图，
// 上传替代资料 / 高级授权登记两条状态流转，以及注入总军师的「已接入数据源」上下文块。
// 行级隔离：读按 tenantId+userId（block 按 userId，userId 全局唯一即所有者），写同时落 tenantId+userId。
import { prisma } from '../db.js';
import { recordAudit } from './audit.js';
import { DATA_SOURCES, type DataSourceTier } from '../data/dataSources.js';
import type { DataSourceView, DataSourcesView, DataSourceStatus } from '../../../shared/contracts';

/** 状态 → 展示文案（unbound 依 tier 分「上传即可 / 高级」）。 */
export function statusLabelFor(status: DataSourceStatus, tier: DataSourceTier): string {
  switch (status) {
    case 'bound':
      return '已绑定';
    case 'uploaded':
      return '待上传';
    case 'auth_requested':
      return '待授权';
    case 'unbound':
    default:
      return tier === 'advanced' ? '高级' : '上传即可';
  }
}

/** 目录 + 用户状态 → DataSourcesView（hero 三指标由服务端计数）。 */
export async function listForUser(args: { tenantId: string; userId: string }): Promise<DataSourcesView> {
  const { tenantId, userId } = args;
  const rows = await prisma.userDataSource.findMany({ where: { tenantId, userId } });
  const byKey = new Map(rows.map((r) => [r.sourceKey, r]));

  const sources: DataSourceView[] = DATA_SOURCES.map((c) => {
    const row = byKey.get(c.key);
    const status = (row?.status as DataSourceStatus) ?? 'unbound';
    return {
      key: c.key,
      label: c.label,
      desc: c.desc,
      icon: c.icon,
      scope: [...c.scope],
      tier: c.tier,
      status,
      statusLabel: statusLabelFor(status, c.tier),
      updatedAt: row?.updatedAt.toISOString(),
    };
  });

  const bound = sources.filter((s) => s.status === 'bound').length;
  const needed = sources.filter((s) => s.status === 'unbound' && s.tier === 'basic').length;
  return { bound, needed, total: DATA_SOURCES.length, sources };
}

/** 上传替代资料 → 状态置 uploaded（可关联已上传 knowledgeId）。幂等：同 (userId, sourceKey) 只一行。 */
export async function recordUpload(args: {
  tenantId: string;
  userId: string;
  sourceKey: string;
  knowledgeId?: string;
}): Promise<DataSourcesView> {
  const { tenantId, userId, sourceKey, knowledgeId } = args;
  const meta = knowledgeId ? { knowledgeId } : {};
  await prisma.userDataSource.upsert({
    where: { userId_sourceKey: { userId, sourceKey } },
    update: { status: 'uploaded', method: 'upload', metaJson: meta },
    create: { tenantId, userId, sourceKey, status: 'uploaded', method: 'upload', metaJson: meta },
  });
  await recordAudit({
    tenantId,
    userId,
    action: 'user.datasource.upload',
    payload: knowledgeId ? { sourceKey, knowledgeId } : { sourceKey },
  });
  return listForUser({ tenantId, userId });
}

/** 高级授权登记（OAuth 预约，运营跟进）→ 状态置 auth_requested。幂等：同 (userId, sourceKey) 只一行。 */
export async function requestAuth(args: {
  tenantId: string;
  userId: string;
  sourceKey: string;
}): Promise<DataSourcesView> {
  const { tenantId, userId, sourceKey } = args;
  await prisma.userDataSource.upsert({
    where: { userId_sourceKey: { userId, sourceKey } },
    update: { status: 'auth_requested', method: 'oauth' },
    create: { tenantId, userId, sourceKey, status: 'auth_requested', method: 'oauth' },
  });
  await recordAudit({
    tenantId,
    userId,
    action: 'user.datasource.auth.requested',
    payload: { sourceKey },
  });
  return listForUser({ tenantId, userId });
}

/**
 * 【已接入数据源】注入块（并入客户档案）：列出已绑定 / 已上传替代资料的来源及其读取范围，
 * 让军师知道有哪些真实证据可向客户索取、可引用。无任何接入来源返回 null（宁缺勿假）。
 */
export async function dataSourcesBlock(userId: string): Promise<string | null> {
  const rows = await prisma.userDataSource.findMany({
    where: { userId, status: { in: ['bound', 'uploaded'] } },
    orderBy: { updatedAt: 'desc' },
  });
  if (!rows.length) return null;
  const byKey = new Map(DATA_SOURCES.map((c) => [c.key, c]));
  const lines = rows
    .map((r) => {
      const c = byKey.get(r.sourceKey);
      if (!c) return null;
      const state = r.status === 'bound' ? '已绑定' : '已上传';
      return `${c.label}（${state}）：${c.scope.join('、')}`;
    })
    .filter((x): x is string => x !== null);
  if (!lines.length) return null;
  return `【已接入数据源（客户已连接的经营数据，可据此向客户索取真实数据与证据；未列出的来源不要假设已具备）】\n${lines.join('\n')}`;
}
