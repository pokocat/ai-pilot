// 时序知识图谱：实体去重 + 关系时序入边 + 新事实软失效旧事实 + as-of 查询。
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { upsertTriples, queryRelations, listEntities } from '../src/services/knowledgeGraph.js';
import { getApp, closeApp, api, seedBaseline, cleanBusiness } from './helpers.js';

let tenantId = '', userId = '';

before(async () => { await getApp(); await seedBaseline(); });
after(async () => { await closeApp(); });

beforeEach(async () => {
  await prisma.graphRelation.deleteMany();
  await prisma.graphEntity.deleteMany();
  await cleanBusiness();
  await seedBaseline();
  const tenant = await prisma.tenant.create({ data: { name: '图谱公司' } });
  tenantId = tenant.id;
  const user = await prisma.user.create({ data: { tenantId, phone: '13600000001', name: '图谱用户', role: 'owner' } });
  userId = user.id;
});

test('实体去重：同名同类型只建一个节点', async () => {
  await upsertTriples(tenantId, null, [
    { subject: '项目A', predicate: '负责人', object: '张三' },
    { subject: '项目A', predicate: '客户', object: '云栖科技' },
  ], { source: 'manual' });
  const ents = await listEntities(tenantId);
  // 项目A 只应有一个实体
  assert.equal(ents.filter((e) => e.name === '项目A').length, 1);
});

test('时序：新负责人软失效旧负责人，as-of 取当时有效', async () => {
  const t1 = new Date('2026-01-01T00:00:00Z');
  const t2 = new Date('2026-03-01T00:00:00Z');
  await upsertTriples(tenantId, null, [{ subject: '项目A', predicate: '负责人', object: '张三' }], { validFrom: t1, source: 'manual' });
  await upsertTriples(tenantId, null, [{ subject: '项目A', predicate: '负责人', object: '李四' }], { validFrom: t2, source: 'manual' });

  // 当前有效 = 李四
  const now = await queryRelations(tenantId, { entity: '项目A', predicate: '负责人' });
  const active = now.filter((r) => r.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].object, '李四');

  // as-of 2026-02（t1~t2 之间）= 张三
  const feb = await queryRelations(tenantId, { entity: '项目A', predicate: '负责人', asOf: new Date('2026-02-01T00:00:00Z') });
  assert.equal(feb.length, 1);
  assert.equal(feb[0].object, '张三');

  // as-of 2026-04（t2 之后）= 李四
  const apr = await queryRelations(tenantId, { entity: '项目A', predicate: '负责人', asOf: new Date('2026-04-01T00:00:00Z') });
  assert.equal(apr.length, 1);
  assert.equal(apr[0].object, '李四');
});

test('幂等：完全相同的关系不重复入边', async () => {
  await upsertTriples(tenantId, null, [{ subject: 'A', predicate: '持有', object: 'B' }], { source: 'manual' });
  const r = await upsertTriples(tenantId, null, [{ subject: 'A', predicate: '持有', object: 'B' }], { source: 'manual' });
  assert.equal(r.relations, 0, '相同关系应幂等跳过');
  const all = await prisma.graphRelation.count({ where: { tenantId } });
  assert.equal(all, 1);
});

test('HTTP：手工 triples 入图 + as-of 查询 + 租户隔离', async () => {
  const ins = await api('POST', '/api/graph/extract', {
    token: userId,
    body: { triples: [{ subject: '团队', predicate: '使用', object: '军师' }], source: 'manual' },
  });
  assert.equal(ins.status, 200);
  assert.equal(ins.body.relations, 1);

  const rel = await api('GET', '/api/graph/relations?entity=团队', { token: userId });
  assert.equal(rel.status, 200);
  assert.equal(rel.body[0].object, '军师');

  // 他人看不到
  const otherT = await prisma.tenant.create({ data: { name: '别家3' } });
  const other = await prisma.user.create({ data: { tenantId: otherT.id, phone: '13600000002', name: '别人3', role: 'owner' } });
  const otherRel = await api('GET', '/api/graph/relations?entity=团队', { token: other.id });
  assert.equal(otherRel.body.length, 0);

  // 非法 asOf
  const bad = await api('GET', '/api/graph/relations?asOf=notadate', { token: userId });
  assert.equal(bad.status, 400);
});
