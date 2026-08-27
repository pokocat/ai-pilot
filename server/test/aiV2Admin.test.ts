// 归一化接入配置的**写路径**（三期收尾，2026-08-08）。
//   cd server && npm test -- test/aiV2Admin.test.ts
//
// 三期承诺了三件事，这里逐条钉死——因为它们此前一件都没真正兑现（后台还写旧表、V2 靠投影）：
//   ① **没有拷贝**：「生效」是 primary 指针，改它不复制任何字段；
//   ② **一把 key 喂多个端点**：轮换只改凭证一处，下面所有端点一起生效；
//   ③ **用途化**：每个用途独立路由，辅助档不再只能改环境变量。
// 另外覆盖被删掉的三个旧测试文件（aiModelUpsert / aiTemperatureConfig / aiV2Writeback）
// 里仍然有效的断言：池参数落库与 clamp、温度不被 Thinking 改写、写完缓存立刻失效。
import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import {
  v2View, createEndpoint, updateEndpoint, deleteEndpoint, updateCredential,
  saveRoute, setPrimary, setPoolMembership, configurePurpose, __wipeAiV2,
} from '../src/services/aiV2Admin.js';
import { resolveRoute, configForPurpose, __resetAiRoutes } from '../src/services/aiRoutes.js';
import { getAiConfig } from '../src/services/aiConfig.js';
import {
  checkEndpoint, checkEndpointRoutes, checkPoolMembershipPurpose, checkRoutePurpose, draftFromEndpointUpsert,
  hasBlocking,
} from '../src/services/aiValidation.js';
import type { ResolvedAiConfig } from '../src/services/aiConfig.js';

const base: ResolvedAiConfig = {
  provider: 'openai', label: 'base', baseUrl: '', model: '', apiKey: '',
  embeddingModel: '', temperature: 0.7, thinkingMode: 'disabled', thinkingBudget: 1024, timeoutMs: 60_000,
  embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '',
  rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
};

const QINIU = {
  label: '七牛主端点', provider: 'claude' as const,
  baseUrl: 'https://api.qnaigc.com', model: 'claude-opus-4-6', apiKey: 'sk-qiniu-shared',
};

beforeEach(async () => { await __wipeAiV2(); });
after(async () => { await __wipeAiV2(); await prisma.$disconnect(); });

describe('① 没有拷贝：「生效」是一个指针', () => {
  test('setPrimary 只改 primary 标记，不复制端点的任何字段到别处', async () => {
    const a = await createEndpoint({ ...QINIU });
    const b = await createEndpoint({ ...QINIU, label: '备用', model: 'claude-sonnet-4-6' });
    await setPrimary('chat', a);

    const before = await prisma.aiEndpoint.findMany({ orderBy: { createdAt: 'asc' } });
    await setPrimary('chat', b);
    const afterRows = await prisma.aiEndpoint.findMany({ orderBy: { createdAt: 'asc' } });
    // 切换生效不该动端点行本身——旧结构这一步会把 8 个字段拷进 AiSetting。
    assert.deepEqual(afterRows.map((r) => ({ ...r, updatedAt: null })), before.map((r) => ({ ...r, updatedAt: null })));

    const route = await resolveRoute('chat', true);
    assert.equal(route!.endpoints.find((e) => e.primary)!.model, 'claude-sonnet-4-6');
  });

  test('一个用途同时只有一个 primary（切换是移动指针，不是追加）', async () => {
    const a = await createEndpoint({ ...QINIU });
    const b = await createEndpoint({ ...QINIU, label: '备用' });
    await setPrimary('chat', a);
    await setPrimary('chat', b);
    const members = await prisma.aiRouteMember.findMany({ where: { route: { purpose: 'chat' } } });
    assert.equal(members.filter((m) => m.primary).length, 1);
  });

  test('改端点字段立刻对运行时生效（写完缓存必须失效，否则「改完 5 秒不生效」）', async () => {
    const id = await createEndpoint({ ...QINIU });
    await setPrimary('chat', id);
    assert.equal((await configForPurpose('chat', base))!.model, 'claude-opus-4-6');

    await updateEndpoint(id, { label: QINIU.label, provider: 'claude', model: 'claude-sonnet-4-6' });
    // 不手动清缓存——写路径自己必须清掉。
    assert.equal((await configForPurpose('chat', base))!.model, 'claude-sonnet-4-6');
  });
});

describe('② 一把 key 喂多个端点', () => {
  test('填同一把 key 的两个端点复用同一条凭证', async () => {
    await createEndpoint({ ...QINIU });
    await createEndpoint({ ...QINIU, label: '备用', model: 'claude-sonnet-4-6' });
    const creds = await prisma.aiCredential.findMany();
    assert.equal(creds.length, 1, '同一把 key 不该建出两条凭证');
    assert.equal((await v2View()).credentials[0].endpointCount, 2);
  });

  test('轮换 key 只改凭证一处，下面所有端点一起生效', async () => {
    const a = await createEndpoint({ ...QINIU });
    await createEndpoint({ ...QINIU, label: '备用', model: 'claude-sonnet-4-6' });
    await setPrimary('chat', a);
    await saveRoute('chat', { mode: 'pool' });
    await setPoolMembership((await prisma.aiEndpoint.findFirst({ where: { label: '备用' } }))!.id, true);

    const cred = (await prisma.aiCredential.findMany())[0];
    await updateCredential(cred.id, { apiKey: 'sk-rotated' });

    const route = await resolveRoute('chat', true);
    assert.equal(route!.endpoints.length, 2);
    assert.ok(route!.endpoints.every((e) => e.apiKey === 'sk-rotated'), '两个端点都该拿到新 key');
  });

  test('不同 key 建不同凭证（不会把无关端点串到一起）', async () => {
    await createEndpoint({ ...QINIU });
    await createEndpoint({ ...QINIU, label: '另一账号', apiKey: 'sk-other' });
    assert.equal((await prisma.aiCredential.findMany()).length, 2);
  });

  test('编辑端点时 key 留空＝不动凭证（不会把它踢到一条新凭证上）', async () => {
    const id = await createEndpoint({ ...QINIU });
    const before = (await prisma.aiEndpoint.findUnique({ where: { id } }))!.credentialId;
    await updateEndpoint(id, { label: '改个名', provider: 'claude' });
    const afterId = (await prisma.aiEndpoint.findUnique({ where: { id } }))!.credentialId;
    assert.equal(afterId, before);
    assert.equal((await prisma.aiCredential.findMany()).length, 1);
  });
});

describe('③ 用途化：每个用途独立', () => {
  test('辅助抽取可以指向另一个便宜端点，且不影响对话', async () => {
    await configurePurpose('chat', { ...QINIU });
    await configurePurpose('aux', {
      label: '小模型', provider: 'openai', baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat', apiKey: 'sk-ds',
    });
    const chat = await configForPurpose('chat', base);
    const aux = await configForPurpose('aux', base);
    assert.equal(chat!.model, 'claude-opus-4-6');
    assert.equal(aux!.model, 'deepseek-chat');
    // 抽取走独立车道、且不参与主池——否则后台任务会和用户可见的生成抢槽位。
    assert.equal(aux!.lane, 'aux');
    assert.equal(aux!.poolBypass, true);
  });

  test('用途级预算独立（成果可以给更长超时）', async () => {
    await configurePurpose('deliverable', { ...QINIU });
    await saveRoute('deliverable', { budget: { timeoutMs: 300_000 } });
    const cfg = await configForPurpose('deliverable', base);
    assert.equal(cfg!.timeoutMs, 300_000);
  });

  test('用途级预算可以显式清空，清空后立即回到系统默认', async () => {
    await configurePurpose('deliverable', { ...QINIU });
    await saveRoute('deliverable', { budget: { timeoutMs: 300_000, temperature: 0.2 } });
    assert.equal((await configForPurpose('deliverable', base))!.timeoutMs, 300_000);

    await saveRoute('deliverable', { budget: null });
    const cfg = await configForPurpose('deliverable', base);
    assert.equal(cfg!.timeoutMs, base.timeoutMs);
    assert.equal(cfg!.temperature, QINIU.provider === 'claude' ? 0.7 : base.temperature);
    assert.deepEqual((await v2View()).routes.find((r) => r.purpose === 'deliverable')!.budget, {});
  });

  test('没配的用途解析为 null，不会悄悄借用对话的端点', async () => {
    await configurePurpose('chat', { ...QINIU });
    assert.equal(await configForPurpose('rerank', base), null);
  });
});

describe('池参数与删除保护', () => {
  test('入池后权重/备份层/并发落库并 clamp（weight<1 会让 HRW 打分恒为 0）', async () => {
    const a = await createEndpoint({ ...QINIU });
    const b = await createEndpoint({ ...QINIU, label: '备用' });
    await setPrimary('chat', a);
    await saveRoute('chat', { mode: 'pool' });
    await setPoolMembership(b, true);
    await saveRoute('chat', { members: [{ endpointId: b, weight: 0, tier: -3, maxConcurrency: -1 }] });

    const m = await prisma.aiRouteMember.findFirst({ where: { endpointId: b } });
    assert.equal(m?.weight, 1);
    assert.equal(m?.tier, 0);
    assert.equal(m?.maxConcurrency, 0);
  });

  test('被用途引用的端点不能删——必须先把用途改指到别处', async () => {
    const id = await createEndpoint({ ...QINIU });
    await setPrimary('chat', id);
    const r = await deleteEndpoint(id);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /用途|引用|chat|对话/);
    assert.ok(await prisma.aiEndpoint.findUnique({ where: { id } }), '拒绝删除时不能已经删掉了');
  });

  test('没被任何用途引用的端点可以删', async () => {
    const id = await createEndpoint({ ...QINIU, label: '孤儿' });
    assert.equal((await deleteEndpoint(id)).ok, true);
    assert.equal(await prisma.aiEndpoint.findUnique({ where: { id } }), null);
  });

  test('路由成员重建失败会完整回滚，不会先把线上路由清空', async () => {
    const a = await createEndpoint({ ...QINIU, label: '当前线上' });
    const b = await createEndpoint({ ...QINIU, label: '待切换' });
    await setPrimary('chat', a);

    await assert.rejects(saveRoute('chat', {
      members: [{ endpointId: b, primary: true }, { endpointId: b }],
    }));

    const route = await resolveRoute('chat', true);
    assert.equal(route!.endpoints.length, 1);
    assert.equal(route!.endpoints[0].id, a);
    assert.equal(route!.endpoints[0].primary, true);
  });

  test('单端点用途换生效项时会移除旧成员，避免留下幽灵引用', async () => {
    const a = await createEndpoint({ ...QINIU, label: '旧辅助端点' });
    const b = await createEndpoint({ ...QINIU, label: '新辅助端点' });
    await setPrimary('aux', a);
    await setPrimary('aux', b);

    const members = await prisma.aiRouteMember.findMany({ where: { route: { purpose: 'aux' } } });
    assert.deepEqual(members.map((m) => m.endpointId), [b]);
    const view = await v2View();
    assert.deepEqual(view.endpoints.find((e) => e.id === a)!.usedByPurposes, []);
  });
});

describe('保存前一致性校验', () => {
  test('同名模型价格冲突从 V2 端点表取事实，不再误读旧 AiModel', async () => {
    await createEndpoint({ ...QINIU, priceInput: 36, priceOutput: 180 });
    const draft = await draftFromEndpointUpsert({
      ...QINIU, label: '另一区域', priceInput: 30, priceOutput: 150,
    });
    const issues = await checkEndpoint(draft);
    assert.ok(issues.some((i) => i.code === 'PRICE_INCONSISTENT'));
  });

  test('编辑池成员时会重算现有路由，协议混用在落库前被拦截', async () => {
    const a = await createEndpoint({ ...QINIU, label: 'Anthropic A' });
    const b = await createEndpoint({ ...QINIU, label: 'Anthropic B' });
    await setPrimary('chat', a);
    await saveRoute('chat', { mode: 'pool' });
    await setPoolMembership(b, true);

    const override = await draftFromEndpointUpsert({
      provider: 'openai', dialect: 'openai_chat', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
    }, b);
    const issues = await checkEndpointRoutes(b, override);
    assert.ok(issues.some((i) => i.code === 'POOL_PROTOCOL_MISMATCH'));
  });

  test('“加入分流池”入口立即校验完整池，不把混协议成员先存成定时炸弹', async () => {
    const primary = await createEndpoint({ ...QINIU, label: 'Anthropic 主端点' });
    const incompatible = await createEndpoint({
      label: 'OpenAI 端点', provider: 'openai', dialect: 'openai_chat',
      baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-deepseek',
    });
    await setPrimary('chat', primary);
    const issues = await checkPoolMembershipPurpose(incompatible, true);
    assert.ok(issues.some((i) => i.code === 'POOL_PROTOCOL_MISMATCH'));
  });

  test('路由拒绝重复、失效成员与多个 primary', async () => {
    const a = await createEndpoint({ ...QINIU });
    const issues = await checkRoutePurpose('chat', {
      mode: 'single',
      members: [
        { endpointId: a, primary: true },
        { endpointId: a, primary: true },
        { endpointId: 'missing-endpoint', primary: false },
      ],
    });
    assert.ok(issues.some((i) => i.code === 'ROUTE_DUPLICATE_MEMBER'));
    assert.ok(issues.some((i) => i.code === 'ROUTE_ENDPOINT_NOT_FOUND'));
    assert.ok(issues.some((i) => i.code === 'ROUTE_MULTIPLE_PRIMARY'));
  });

  test('embedding/rerank 不接受不提供该能力的 OpenAI 兼容厂商', async () => {
    const id = await createEndpoint({
      label: '七牛 OpenAI', provider: 'openai', dialect: 'openai_chat',
      baseUrl: 'https://api.qnaigc.com/v1', model: 'text-embedding-x', apiKey: 'sk-qiniu-embed',
    });
    const issues = await checkRoutePurpose('embedding', { members: [{ endpointId: id, primary: true }] });
    assert.ok(issues.some((i) => i.code === 'AUX_VENDOR_UNSUPPORTED'));
  });

  test('迁移或自定义凭证必须先确认接入商，确认后才能进入路由', async () => {
    const id = await createEndpoint({
      label: '自建网关', provider: 'openai', dialect: 'openai_chat',
      baseUrl: 'https://gateway.example.com/v1', model: 'custom-model', apiKey: 'sk-custom',
    });
    const cred = await prisma.aiCredential.findFirstOrThrow({ where: { endpoints: { some: { id } } } });
    assert.equal(cred.needsReview, true);
    const before = await checkRoutePurpose('chat', { members: [{ endpointId: id, primary: true }] });
    assert.ok(before.some((i) => i.code === 'CREDENTIAL_VENDOR_UNCONFIRMED'));

    assert.deepEqual(await updateCredential(cred.id, { vendor: 'custom' }), { ok: true });
    const afterIssues = await checkRoutePurpose('chat', { members: [{ endpointId: id, primary: true }] });
    assert.equal(afterIssues.some((i) => i.code === 'CREDENTIAL_VENDOR_UNCONFIRMED'), false);
  });

  // 2026-08-27 线上死局：混协议的池里，运营移出任何一个成员都被**剩下的成员**挡回去，
  // 而删端点又要求先从路由移出 —— 一个坏池子把自己的每条修复路径都锁上了。
  test('已经混协议的池：移出成员不再被剩下的成员挡回去', async () => {
    const a = await createEndpoint({ ...QINIU, label: 'Anthropic 主端点' });
    const a2 = await createEndpoint({ ...QINIU, label: 'Anthropic 备端点', model: 'claude-sonnet-4-6' });
    const b = await createEndpoint({
      label: 'OpenAI 端点', provider: 'openai', dialect: 'openai_chat',
      baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'sk-deepseek',
    });
    // 这种池子确实存在：单端点模式下攒成员不校验池形状，一开分流整池就变成不可编辑。
    await saveRoute('chat', {
      mode: 'pool',
      members: [{ endpointId: a, primary: true }, { endpointId: a2 }, { endpointId: b }],
    });

    // 移出同协议的那个：池子仍然混着，但这一步没让它更糟 → 只提醒，放行。
    const removeSame = await checkPoolMembershipPurpose(a2, false);
    assert.ok(removeSame.some((i) => i.code === 'POOL_PROTOCOL_MISMATCH'), '仍要说出来');
    assert.equal(hasBlocking(removeSame), false, '收拾池子的动作不能被旧账挡回去');

    // 移出协议不同的那个：一步就修好了。
    assert.equal(hasBlocking(await checkPoolMembershipPurpose(b, false)), false);
    // 但往这个坏池子里再塞一个成员，照旧拦死。
    const add = await checkPoolMembershipPurpose(await createEndpoint({ ...QINIU, label: '再来一个' }), true);
    assert.ok(add.some((i) => i.code === 'POOL_PROTOCOL_MISMATCH'));
    assert.equal(hasBlocking(add), true);
  });

  test('已在路由里的未确认凭证只提醒；新加入的照旧拦死', async () => {
    const inRoute = await createEndpoint({
      label: '自建网关', provider: 'openai', dialect: 'openai_chat',
      baseUrl: 'https://gateway.example.com/v1', model: 'custom-model', apiKey: 'sk-custom-1',
    });
    // 已经在跑的成员：换 Key 时新凭证是在校验之后才建的，运营能给自己造出这种状态。
    await saveRoute('chat', { mode: 'single', members: [{ endpointId: inRoute, primary: true }] });
    const cred = await prisma.aiCredential.findFirstOrThrow({ where: { endpoints: { some: { id: inRoute } } } });
    assert.equal(cred.needsReview, true);

    const editing = await checkRoutePurpose('chat', { sticky: false });
    assert.ok(editing.some((i) => i.code === 'CREDENTIAL_VENDOR_UNCONFIRMED'), '黄标仍要说出来');
    assert.equal(hasBlocking(editing), false, '不能让一条黄标把整条路由的编辑全锁住');

    const joining = await createEndpoint({
      label: '另一个自建网关', provider: 'openai', dialect: 'openai_chat',
      baseUrl: 'https://gateway2.example.com/v1', model: 'custom-model-2', apiKey: 'sk-custom-2',
    });
    const issues = await checkRoutePurpose('chat', {
      members: [{ endpointId: inRoute, primary: true }, { endpointId: joining }],
    });
    assert.equal(hasBlocking(issues), true, '新加入的必须先确认接入商');
  });

  test('非法用途预算在写库前被拦截', async () => {
    const id = await createEndpoint({ ...QINIU });
    const issues = await checkRoutePurpose('chat', {
      members: [{ endpointId: id, primary: true }],
      budget: { temperature: 3 },
    });
    assert.ok(issues.some((i) => i.code === 'ROUTE_BUDGET_INVALID'));
  });
});

describe('对外视图', () => {
  test('不回传明文 key，只回 hasKey', async () => {
    await createEndpoint({ ...QINIU });
    const view = await v2View();
    const raw = JSON.stringify(view);
    assert.equal(raw.includes('sk-qiniu-shared'), false, '视图里绝不能出现明文 key');
    assert.equal(view.endpoints[0].hasKey, true);
    assert.equal(view.credentials[0].hasKey, true);
  });

  test('端点带出「被哪些用途引用」——删之前必须看得见影响面', async () => {
    const id = await createEndpoint({ ...QINIU });
    await setPrimary('chat', id);
    await setPrimary('deliverable', id);
    const view = await v2View();
    assert.deepEqual([...view.endpoints[0].usedByPurposes].sort(), ['chat', 'deliverable']);
  });

  test('温度是运营原值，不被 Thinking 改写（旧 aiTemperatureConfig 的断言）', async () => {
    await createEndpoint({ ...QINIU, temperature: 0.3, thinkingMode: 'enabled', thinkingBudget: 2048 } as never);
    const view = await v2View();
    assert.equal(view.endpoints[0].temperature, 0.3);
    assert.equal(view.endpoints[0].thinkingMode, 'enabled');
  });

  test('视图自带接入商预设与方言目录（前端建端点要用，不该再多两次往返）', async () => {
    const view = await v2View();
    assert.ok(view.presets.some((p) => p.id === 'qiniu-anthropic'));
    assert.ok(view.dialects.some((d) => d.id === 'anthropic_gateway'));
    assert.ok(view.vendors.some((v) => v.id === 'custom'));
  });
});

describe('运行时读的是同一份数据（不再有投影这一层）', () => {
  test('getAiConfig 直接反映后台刚写的端点', async () => {
    await configurePurpose('chat', { ...QINIU });
    __resetAiRoutes();
    const cfg = await getAiConfig(true);
    assert.equal(cfg.model, 'claude-opus-4-6');
    assert.equal(cfg.apiKey, 'sk-qiniu-shared');
    // 方言必须一路带到请求组装处，否则关闭思考的写法会用错。
    assert.equal(cfg.dialect, 'anthropic_gateway');
  });

  test('写完不清 aiConfig 缓存 → 运营改完最多 4 秒不生效且无报错（这一层最容易漏）', async () => {
    await configurePurpose('chat', { ...QINIU });
    assert.equal((await getAiConfig()).model, 'claude-opus-4-6');   // 先把缓存焐热
    const ep = (await prisma.aiEndpoint.findFirstOrThrow());
    await updateEndpoint(ep.id, { label: ep.label, provider: 'claude', model: 'claude-sonnet-4-6' });
    // 注意这里**不传 force**：走的就是运营改完之后线上真实的读法。
    assert.equal((await getAiConfig()).model, 'claude-sonnet-4-6');
  });

  test('单价配在端点上时成本核算读得到（读错表会静默记 0）', async () => {
    await configurePurpose('chat', { ...QINIU, priceInput: 36, priceOutput: 180 });
    const { resolveModelRate } = await import('../src/services/aiConfig.js');
    const { rate, calibrated } = await resolveModelRate('claude-opus-4-6');
    assert.equal(calibrated, true, '端点上配的单价必须进得了费率表');
    assert.equal(rate.in, 36);
    assert.equal(rate.out, 180);
  });
});
