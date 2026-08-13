// 兵器挂军令（2026-08-12）：拆军令那一轮选出的 toolKey 落库 → 读时解析成 OrderWeapon。
//   cd server && npm test -- test/orderWeapon.test.ts
//
// 这条链路要钉住三件事：
//   ① 只存 key，展示物料读时从运营目录解析——工具改名/停用立刻生效，不留过期快照；
//   ② 白名单外的 key 一律丢（模型可能编一个不存在的工具）；
//   ③ external 兵器缺 appId 时不下发——端上不能出一个点了没反应的卡。
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { resolveWeapons, toolMenuLines } from '../src/services/prescription.js';

const KEY_AGENT = 'test-weapon-agent';
const KEY_ECO_OK = 'test-weapon-eco-ok';
const KEY_ECO_NOAPP = 'test-weapon-eco-noapp';
const KEY_DISABLED = 'test-weapon-agent-off';

describe('兵器解析：只存 key，展示物料读时取', () => {
  before(async () => {
    await prisma.agent.upsert({
      where: { key: KEY_AGENT },
      update: { enabled: true, name: '测试代笔官', role: '替你把这条军令做成成品' },
      create: { key: KEY_AGENT, name: '测试代笔官', role: '替你把这条军令做成成品', enabled: true, icon: 'spark', type: 'creative', greet: '我在', chipsJson: [], memText: '记忆', learnText: '记忆已更新', systemPrompt: '测试用', memoryConfig: {} as object },
    });
    await prisma.agent.upsert({
      where: { key: KEY_DISABLED },
      update: { enabled: false, name: '已停用官', role: '停用的' },
      create: { key: KEY_DISABLED, name: '已停用官', role: '停用的', enabled: false, icon: 'spark', type: 'creative', greet: '我在', chipsJson: [], memText: '记忆', learnText: '记忆已更新', systemPrompt: '测试用', memoryConfig: {} as object },
    });
    await prisma.ecoTool.upsert({
      where: { id: KEY_ECO_OK },
      update: { enabled: true, name: '外部快印', desc: '跳外部小程序出图', appId: 'wxtestappid', path: 'pages/index' },
      create: { id: KEY_ECO_OK, name: '外部快印', desc: '跳外部小程序出图', appId: 'wxtestappid', path: 'pages/index', enabled: true },
    });
    await prisma.ecoTool.upsert({
      where: { id: KEY_ECO_NOAPP },
      update: { enabled: true, name: '缺配置工具', desc: '没配 appId', appId: '', path: '' },
      create: { id: KEY_ECO_NOAPP, name: '缺配置工具', desc: '没配 appId', appId: '', path: '', enabled: true },
    });
  });

  test('启用的 agent → kind=agent，名称与一句话来自目录', async () => {
    const map = await resolveWeapons([KEY_AGENT]);
    const w = map.get(KEY_AGENT);
    assert.ok(w, '启用的 agent 必须解析出兵器');
    assert.equal(w.kind, 'agent');
    assert.equal(w.name, '测试代笔官');
    assert.equal(w.line, '替你把这条军令做成成品');
  });

  test('启用且配了 appId 的 EcoTool → kind=external，带 appId/path', async () => {
    const w = (await resolveWeapons([KEY_ECO_OK])).get(KEY_ECO_OK);
    assert.ok(w);
    assert.equal(w.kind, 'external');
    assert.equal(w.appId, 'wxtestappid');
    assert.equal(w.path, 'pages/index');
  });

  test('停用的 agent / 缺 appId 的 EcoTool / 表外 key 一律不下发', async () => {
    const map = await resolveWeapons([KEY_DISABLED, KEY_ECO_NOAPP, 'no-such-tool-key']);
    assert.equal(map.get(KEY_DISABLED), undefined, '停用工具不得继续下发（否则端上点了进不去）');
    assert.equal(map.get(KEY_ECO_NOAPP), undefined, 'external 缺 appId 跳不动，不能下发');
    assert.equal(map.get('no-such-tool-key'), undefined, '表外 key 必须丢');
  });

  test('工具表注入文本含启用项、不含停用项', async () => {
    const lines = await toolMenuLines();
    assert.ok(lines.some((l) => l.startsWith(`${KEY_AGENT} · `)), '启用 agent 要出现在可开方工具表里');
    assert.ok(lines.some((l) => l.startsWith(`${KEY_ECO_OK} · `)), '启用 EcoTool 要出现在可开方工具表里');
    assert.ok(!lines.some((l) => l.startsWith(`${KEY_DISABLED} · `)), '停用项不得进工具表');
  });
});

describe('落库：白名单外的 toolKey 必须丢', () => {
  beforeEach(async () => { await prisma.casefileOrder.deleteMany({ where: { text: { startsWith: '[weapon-test]' } } }); });

  test('军令表能存 toolKey，且解析走同一份目录', async () => {
    const tenant = await prisma.tenant.create({ data: { name: '兵器测试租户' } });
    const user = await prisma.user.create({ data: { tenantId: tenant.id, phone: `weapon-${Date.now()}`, name: '兵器测试' } });
    const cf = await prisma.casefile.create({ data: { tenantId: tenant.id, userId: user.id, title: '兵器测试案卷', sourceAgent: '军师', risksJson: [] } });
    await prisma.casefileOrder.create({
      data: { tenantId: tenant.id, userId: user.id, casefileId: cf.id, date: '2026-08-12', text: '[weapon-test] 发一条口播', fromAgent: '军师', tag: '军令', toolKey: KEY_AGENT },
    });
    const row = await prisma.casefileOrder.findFirst({ where: { casefileId: cf.id } });
    assert.equal(row?.toolKey, KEY_AGENT);
    const w = (await resolveWeapons([row!.toolKey!])).get(KEY_AGENT);
    assert.equal(w?.name, '测试代笔官', '读时解析必须拿到目录里的当前名称');
  });
});
