// 时序知识图谱服务：抽取 → 落库（实体去重 + 关系时序入边，新事实软失效旧同主谓事实）→ as-of 查询。
// 回答「X 时谁负责 Y」类问题：关系带 validFrom/validTo，查询给定时刻取当时有效的边。
import { prisma } from '../db.js';
import { extractGraphTriples } from '../llm/gateway.js';

function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface Triple { subject: string; predicate: string; object: string }

/** 实体去重 upsert（按 tenant+归一名+type 唯一）。返回实体 id。 */
async function upsertEntity(tenantId: string, projectId: string | null, name: string, type: string): Promise<string> {
  const normName = norm(name);
  const existing = await prisma.graphEntity.findUnique({
    where: { tenantId_normName_type: { tenantId, normName, type } },
  });
  if (existing) return existing.id;
  const created = await prisma.graphEntity.create({
    data: { tenantId, projectId, name: name.trim(), normName, type },
  });
  return created.id;
}

export interface UpsertGraphResult { entities: number; relations: number; superseded: number }

/**
 * 把三元组写入图谱。实体去重；同 (subject,predicate) 的旧关系若指向不同 object，
 * 视为被新事实推翻 → 软失效（置 validTo/invalidatedAt），保留历史。完全相同的关系幂等跳过。
 */
export async function upsertTriples(
  tenantId: string,
  projectId: string | null,
  triples: Triple[],
  opts: { source?: string; sourceId?: string | null; validFrom?: Date; entityTypes?: Record<string, string> } = {},
): Promise<UpsertGraphResult> {
  const validFrom = opts.validFrom ?? new Date();
  const typeOf = (n: string) => opts.entityTypes?.[norm(n)] ?? 'other';
  let relCount = 0, superseded = 0;
  const entityIds = new Set<string>();

  for (const t of triples) {
    if (!t.subject?.trim() || !t.predicate?.trim() || !t.object?.trim()) continue;
    const subjectId = await upsertEntity(tenantId, projectId, t.subject, typeOf(t.subject));
    const objectId = await upsertEntity(tenantId, projectId, t.object, typeOf(t.object));
    entityIds.add(subjectId); entityIds.add(objectId);

    // 当前有效的同主谓关系
    const actives = await prisma.graphRelation.findMany({
      where: { tenantId, subjectId, predicate: t.predicate.trim(), validTo: null, invalidatedAt: null },
    });
    // 已存在指向同 object 的有效关系 → 幂等跳过
    if (actives.some((a) => a.objectId === objectId)) continue;
    // 指向不同 object 的旧关系 → 软失效（被新事实推翻）
    for (const a of actives) {
      await prisma.graphRelation.update({ where: { id: a.id }, data: { validTo: validFrom, invalidatedAt: new Date() } });
      superseded++;
    }
    await prisma.graphRelation.create({
      data: {
        tenantId, projectId, subjectId, predicate: t.predicate.trim(), objectId,
        validFrom, source: opts.source ?? 'conversation', sourceId: opts.sourceId ?? null,
      },
    });
    relCount++;
  }
  return { entities: entityIds.size, relations: relCount, superseded };
}

/** 抽取 + 入库（一步）。无真实模型时 extractGraphTriples 返回空 → 不写入。 */
export async function ingestTextToGraph(
  tenantId: string,
  projectId: string | null,
  text: string,
  opts: { source?: string; sourceId?: string | null } = {},
): Promise<UpsertGraphResult> {
  const extracted = await extractGraphTriples(text);
  const entityTypes: Record<string, string> = {};
  for (const e of extracted.entities) entityTypes[norm(e.name)] = e.type;
  return upsertTriples(tenantId, projectId, extracted.relations, { ...opts, entityTypes });
}

export interface RelationView {
  id: string; subject: string; subjectType: string; predicate: string; object: string; objectType: string;
  validFrom: string; validTo: string | null; active: boolean; source: string;
}

/**
 * as-of 时序查询：返回在 asOf 时刻有效的关系（validFrom<=asOf 且 validTo 为空或 >asOf）。
 * 不传 asOf → 返回当前有效关系。可按实体名（主或宾）/谓词过滤。
 */
export async function queryRelations(
  tenantId: string,
  opts: { entity?: string; predicate?: string; asOf?: Date; projectId?: string | null; limit?: number } = {},
): Promise<RelationView[]> {
  const asOf = opts.asOf;
  const take = Math.min(200, Math.max(1, opts.limit ?? 100));

  let entityIds: string[] | undefined;
  if (opts.entity?.trim()) {
    const ents = await prisma.graphEntity.findMany({ where: { tenantId, normName: norm(opts.entity) }, select: { id: true } });
    entityIds = ents.map((e) => e.id);
    if (entityIds.length === 0) return [];
  }

  const rows = await prisma.graphRelation.findMany({
    where: {
      tenantId,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.predicate ? { predicate: opts.predicate } : {}),
      ...(entityIds ? { OR: [{ subjectId: { in: entityIds } }, { objectId: { in: entityIds } }] } : {}),
      ...(asOf
        ? { validFrom: { lte: asOf }, OR: [{ validTo: null }, { validTo: { gt: asOf } }] }
        : {}),
    },
    orderBy: { validFrom: 'desc' },
    take,
    include: { subject: true, object: true },
  });

  return rows.map((r) => ({
    id: r.id, subject: r.subject.name, subjectType: r.subject.type, predicate: r.predicate,
    object: r.object.name, objectType: r.object.type,
    validFrom: r.validFrom.toISOString(), validTo: r.validTo?.toISOString() ?? null,
    active: !r.validTo && !r.invalidatedAt, source: r.source,
  }));
}

/** 实体列表（运营/调试用）。 */
export async function listEntities(tenantId: string, projectId?: string | null, limit = 100) {
  const rows = await prisma.graphEntity.findMany({
    where: { tenantId, ...(projectId ? { projectId } : {}) },
    orderBy: { createdAt: 'desc' }, take: Math.min(500, limit),
  });
  return rows.map((e) => ({ id: e.id, name: e.name, type: e.type, projectId: e.projectId, createdAt: e.createdAt.toISOString() }));
}
