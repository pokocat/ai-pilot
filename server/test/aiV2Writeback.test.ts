// 切到 V2 之后，后台改配置必须真的生效（2026-08-07 · 三期补缺）。
//   cd server && npm test -- test/aiV2Writeback.test.ts
//
// 这是三期最阴的一个坑，也是我自己先埋进去的：切换后**运行时读的是 `ai_route`，
// 而后台写的仍是 `ai_model` / `ai_setting`**。少了投影这一步，运营在后台改完配置——
// 页面显示已保存、审计日志也有记录、库里旧表确实变了——但线上纹丝不动，而且没有任何报错。
// 所有东西看起来都对，这是最难排查的一类故障，必须有回归钉死。
import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { addModel, updateModel, deleteModel, activateModel, getAiConfig } from '../src/services/aiConfig.js';
import { migrateAiConfig } from '../src/services/aiConfigMigrate.js';
import { resolveRoute, __resetAiRoutes } from '../src/services/aiRoutes.js';

let savedFlag: string | undefined;
const setV2 = (on: boolean) => {
  if (on) process.env.AI_CONFIG_V2 = 'true'; else delete process.env.AI_CONFIG_V2;
  __resetAiRoutes();
};

async function wipe(): Promise<void> {
  await prisma.aiRouteMember.deleteMany({});
  await prisma.aiRoute.deleteMany({});
  await prisma.aiEndpoint.deleteMany({});
  await prisma.aiCredential.deleteMany({});
  await prisma.aiModel.deleteMany({});
  await prisma.aiSetting.deleteMany({});
  __resetAiRoutes();
}

/** 已迁移 + 已切换的状态：这正是缺陷会显形的那个状态。 */
async function seedMigratedAndSwitched() {
  const m = await addModel({
    provider: 'claude', label: '主端点', baseUrl: 'https://api.qnaigc.com',
    model: 'claude-opus-4-6', apiKey: 'sk-real-key-aaa', temperature: 0.7,
  });
  await prisma.aiSetting.upsert({
    where: { id: 'default' },
    update: { activeModelId: m.id },
    create: {
      id: 'default', provider: 'claude', label: '主端点', baseUrl: 'https://api.qnaigc.com',
      model: 'claude-opus-4-6', apiKey: 'sk-real-key-aaa', activeModelId: m.id,
    },
  });
  await migrateAiConfig({ apply: true, quiet: true });
  setV2(true);
  return m;
}

before(() => { savedFlag = process.env.AI_CONFIG_V2; });
beforeEach(async () => { setV2(false); await wipe(); });
after(async () => {
  await wipe();
  if (savedFlag === undefined) delete process.env.AI_CONFIG_V2; else process.env.AI_CONFIG_V2 = savedFlag;
  __resetAiRoutes();
  await prisma.$disconnect();
});

describe('切到 V2 后后台的每一种写操作都要投影到路由表', () => {
  test('改模型 → 运行时立刻拿到新值（不投影的话这里会读到旧 model）', async () => {
    const m = await seedMigratedAndSwitched();
    assert.equal((await getAiConfig(true)).model, 'claude-opus-4-6');

    await updateModel(m.id, { provider: 'claude', label: '主端点', model: 'claude-sonnet-4-6' });
    __resetAiRoutes();
    assert.equal((await getAiConfig(true)).model, 'claude-sonnet-4-6', '后台改了但线上没变——投影没生效');
  });

  test('改温度 / 思考模式同样要跟着走（不只是 model）', async () => {
    const m = await seedMigratedAndSwitched();
    await updateModel(m.id, { provider: 'claude', label: '主端点', model: 'claude-opus-4-6', temperature: 0.2, thinkingMode: 'enabled', thinkingBudget: 4096 });
    __resetAiRoutes();
    const cfg = await getAiConfig(true);
    assert.equal(cfg.temperature, 0.2);
    assert.equal(cfg.thinkingMode, 'enabled');
    assert.equal(cfg.thinkingBudget, 4096);
  });

  test('新增模型 → 出现在端点表（否则它永远进不了路由）', async () => {
    await seedMigratedAndSwitched();
    const before = await prisma.aiEndpoint.count();
    await addModel({ provider: 'claude', label: '新端点', baseUrl: 'https://api.qnaigc.com', model: 'claude-haiku', apiKey: 'sk-real-key-bbb' });
    assert.equal(await prisma.aiEndpoint.count(), before + 1);
  });

  test('切换生效模型 → chat 路由的 primary 跟着换', async () => {
    await seedMigratedAndSwitched();
    const other = await addModel({ provider: 'claude', label: '备端点', baseUrl: 'https://api.qnaigc.com', model: 'claude-haiku', apiKey: 'sk-real-key-bbb' });

    await activateModel(other.id);
    __resetAiRoutes();
    const route = await resolveRoute('chat', true);
    const primary = route!.endpoints.find((e) => e.primary);
    assert.equal(primary?.model, 'claude-haiku', '切换生效模型没反映到路由的 primary');
    assert.equal((await getAiConfig(true)).model, 'claude-haiku');
  });

  test('删除模型 → 对应端点一并清掉，不会留在路由里继续接流量', async () => {
    await seedMigratedAndSwitched();
    const doomed = await addModel({ provider: 'claude', label: '待删端点', baseUrl: 'https://api.qnaigc.com', model: 'claude-haiku', apiKey: 'sk-real-key-bbb' });
    assert.ok(await prisma.aiEndpoint.findUnique({ where: { legacyModelId: doomed.id } }));

    const r = await deleteModel(doomed.id);
    assert.equal(r.ok, true);
    assert.equal(await prisma.aiEndpoint.findUnique({ where: { legacyModelId: doomed.id } }), null, '孤儿端点没清掉');
  });

  test('V2 没开时投影是空操作（不给旧路径带任何额外写入）', async () => {
    const m = await addModel({ provider: 'claude', label: '主端点', baseUrl: 'https://api.qnaigc.com', model: 'claude-opus-4-6', apiKey: 'sk-real-key-aaa' });
    await updateModel(m.id, { provider: 'claude', label: '主端点', model: 'claude-sonnet-4-6' });
    // 没开 V2 → 新表一行都不该被写出来。
    assert.equal(await prisma.aiEndpoint.count(), 0);
    assert.equal(await prisma.aiRoute.count(), 0);
  });

  test('投影失败不该让后台的保存请求变红（配置已经写进旧表了）', async () => {
    const m = await seedMigratedAndSwitched();
    // 制造一个投影必失败的状态：删掉路由表主键约束依赖的行不现实，
    // 这里改用「新表被清空 + 旧表 activeModelId 悬空」，让迁移算不出 chat 成员。
    await prisma.aiSetting.update({ where: { id: 'default' }, data: { activeModelId: null } });
    await prisma.aiModel.updateMany({ data: { poolEnabled: false } });
    // 不该抛。
    const updated = await updateModel(m.id, { provider: 'claude', label: '主端点', model: 'claude-opus-4-6', temperature: 0.9 });
    assert.equal(updated?.temperature, 0.9, '旧表必须照常写入');
  });
});

describe('探活结果也必须走到运行时（能力靠测的闭环不能断在最后一步）', () => {
  test('探活写的 caps 会投影到端点表 —— 否则「这个模型不支持思考」到不了运行时', async () => {
    const m = await seedMigratedAndSwitched();
    // 直接改旧表模拟探活回填，再走一次投影（探活内部就是这么做的）。
    await prisma.aiModel.update({ where: { id: m.id }, data: { capsJson: { thinking: 'no' } } });
    const { syncV2FromLegacy } = await import('../src/services/aiRoutes.js');
    await syncV2FromLegacy();

    const ep = await prisma.aiEndpoint.findUnique({ where: { legacyModelId: m.id } });
    assert.deepEqual(ep?.capsJson, { thinking: 'no' }, '探活回填的能力没到端点表');

    // 而且要真的影响请求组装：caps 说不支持，就不该再发 thinking 字段。
    __resetAiRoutes();
    const cfg = await getAiConfig(true);
    const { thinkingRequestTuning } = await import('../src/llm/thinking.js');
    assert.equal(thinkingRequestTuning({ ...cfg, thinkingMode: 'enabled' }).thinking, undefined);
  });

  test('model_scope 探活查回的模型清单能被校验器读到（这根线两头必须接上）', async () => {
    const m = await addModel({
      provider: 'openai', label: '范围受限端点', baseUrl: 'https://api.qnaigc.com/v1',
      model: '不在范围内的模型', apiKey: 'sk-real-key-ccc',
    });
    await prisma.aiModel.update({
      where: { id: m.id },
      data: { capsJson: { modelScope: { models: ['a', 'b'], at: '2026-08-08T00:00:00.000Z' } } },
    });
    const { draftFromUpsert, checkEndpoint } = await import('../src/services/aiValidation.js');
    const issues = await checkEndpoint(await draftFromUpsert({ provider: 'openai', label: '范围受限端点', model: '不在范围内的模型' }, m.id));
    assert.ok(issues.some((i) => i.code === 'MODEL_OUT_OF_KEY_SCOPE'), '探活查回了范围，校验器却没读到');
  });

  test('没探过模型范围 → 该规则不报（不能拿「没查过」当「不在范围内」）', async () => {
    const m = await addModel({
      provider: 'openai', label: '未探端点', baseUrl: 'https://api.qnaigc.com/v1',
      model: 'whatever', apiKey: 'sk-real-key-ddd',
    });
    const { draftFromUpsert, checkEndpoint } = await import('../src/services/aiValidation.js');
    const issues = await checkEndpoint(await draftFromUpsert({ provider: 'openai', label: '未探端点', model: 'whatever' }, m.id));
    assert.equal(issues.some((i) => i.code === 'MODEL_OUT_OF_KEY_SCOPE'), false);
  });
});
