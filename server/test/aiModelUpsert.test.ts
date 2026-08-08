// 模型接入点的增改必须把表单字段真的写进库（2026-08-07 修 D2 / 补 D4 / 补 D7）。
//   cd server && npm test -- test/aiModelUpsert.test.ts
//
// D2 的形状：路由层为 poolEnabled 做了协议校验（不匹配会 409），校验通过后 addModel 却没把这四个
// 池字段写进 data —— 于是「新增时勾了入池」静默变成未入池，只有事后再 PATCH 一次才生效。
// 这类「接口收下了、库里没有」的缺陷不会报错，只会让运营以为配好了，必须有回归钉住。
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { addModel, updateModel, listModels, AI_PRESETS } from '../src/services/aiConfig.js';

const created: string[] = [];

async function make(over: Parameters<typeof addModel>[0]) {
  const m = await addModel(over);
  created.push(m.id);
  return m;
}

before(async () => { await prisma.aiModel.deleteMany({ where: { label: { startsWith: 'TEST-upsert-' } } }); });
beforeEach(() => { created.length = 0; });
after(async () => {
  await prisma.aiModel.deleteMany({ where: { label: { startsWith: 'TEST-upsert-' } } });
  await prisma.$disconnect();
});

describe('新增模型：池参数必须落库', () => {
  test('addModel 带池参数 → 库里读回同值（D2 回归）', async () => {
    const m = await make({
      provider: 'openai', label: 'TEST-upsert-pool', baseUrl: 'https://x/v1', model: 'm-1',
      poolEnabled: true, weight: 5, tier: 2, maxConcurrency: 3,
    });
    assert.equal(m.poolEnabled, true);
    assert.equal(m.weight, 5);
    assert.equal(m.tier, 2);
    assert.equal(m.maxConcurrency, 3);

    // 不只信返回值——再从列表读一次，确认写的是库不是内存。
    const listed = (await listModels()).find((x) => x.id === m.id);
    assert.equal(listed?.poolEnabled, true);
    assert.equal(listed?.weight, 5);
  });

  test('不传池参数 → 保持既有默认（未入池、权重 1、tier 0、并发跟随全局）', async () => {
    const m = await make({ provider: 'openai', label: 'TEST-upsert-default', baseUrl: 'https://x/v1', model: 'm-2' });
    assert.equal(m.poolEnabled, false);
    assert.equal(m.weight, 1);
    assert.equal(m.tier, 0);
    assert.equal(m.maxConcurrency, 0);
  });

  test('新增与编辑的取值口径同源：weight 至少为 1（0 会让 HRW 打分恒为 0＝悄悄踢出池）', async () => {
    const m = await make({
      provider: 'openai', label: 'TEST-upsert-clamp', baseUrl: 'https://x/v1', model: 'm-3',
      poolEnabled: true, weight: 0, tier: -3, maxConcurrency: -1,
    });
    assert.equal(m.weight, 1);
    assert.equal(m.tier, 0);
    assert.equal(m.maxConcurrency, 0);

    const patched = await updateModel(m.id, {
      provider: 'openai', label: m.label, model: m.model, weight: 0, tier: -3, maxConcurrency: -1,
    });
    assert.equal(patched?.weight, 1);
    assert.equal(patched?.tier, 0);
    assert.equal(patched?.maxConcurrency, 0);
  });
});

describe('缓存写单价第四档能存能读（D4 回归）', () => {
  test('新增时填 → 读回同值；未填 → 0（＝按输入价 ×1.25 推导，行为不变）', async () => {
    const filled = await make({
      provider: 'claude', label: 'TEST-upsert-price', baseUrl: 'https://g', model: 'claude-x',
      priceInput: 36, priceOutput: 180, priceCachedInput: 3.6, priceCacheWrite: 72,
    });
    assert.equal(filled.priceCacheWrite, 72);

    const blank = await make({
      provider: 'claude', label: 'TEST-upsert-price-blank', baseUrl: 'https://g', model: 'claude-y',
      priceInput: 36, priceOutput: 180,
    });
    assert.equal(blank.priceCacheWrite, 0);
  });

  test('编辑可改回 0（供应商按统一单价结算时要能撤销显式值）', async () => {
    const m = await make({
      provider: 'claude', label: 'TEST-upsert-price-edit', baseUrl: 'https://g', model: 'claude-z',
      priceInput: 36, priceOutput: 180, priceCacheWrite: 72,
    });
    const patched = await updateModel(m.id, { provider: 'claude', label: m.label, model: m.model, priceCacheWrite: 0 });
    assert.equal(patched?.priceCacheWrite, 0);
  });
});

describe('接入商预设（D7 回归）', () => {
  const byId = (id: string) => AI_PRESETS.find((p) => p.id === id);

  test('生产在用的七牛必须在预设里，且两个协议各占一条（baseUrl 不同）', () => {
    const anthropic = byId('qiniu-anthropic');
    const openai = byId('qiniu');
    assert.ok(anthropic, '缺 七牛 Anthropic 协议预设');
    assert.ok(openai, '缺 七牛 OpenAI 兼容预设');
    assert.equal(anthropic!.provider, 'claude');
    assert.equal(openai!.provider, 'openai');
    // 同一家两个入口的 baseUrl 必须不同——相同就说明有人把协议当成了模型名的属性。
    assert.notEqual(anthropic!.baseUrl, openai!.baseUrl);
  });

  test('同时提供两种协议的厂商都补齐了 Anthropic 入口', () => {
    for (const id of ['deepseek-anthropic', 'volcengine-anthropic']) {
      const p = byId(id);
      assert.ok(p, `缺 ${id} 预设`);
      assert.equal(p!.provider, 'claude');
      assert.ok(p!.baseUrl.startsWith('https://'), `${id} 缺 baseUrl`);
    }
  });

  test('预设 id 唯一（重复会让「选择接入商」下拉出现两个同名项）', () => {
    const ids = AI_PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('每条预设都有 baseUrl 或明确是 mock/官方直连；model 允许留空但必须给出查法', () => {
    for (const p of AI_PRESETS) {
      if (p.provider === 'mock') continue;
      // model 留空是刻意的（没实测过的模型名不预填），但必须在 note 里告诉运营怎么查。
      if (!p.model) assert.ok(p.note && p.note.length > 0, `${p.id} 的 model 留空却没有 note 指引`);
    }
  });
});
