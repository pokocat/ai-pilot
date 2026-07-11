// D-8 军师收编 4+1：未购用户只见保留科室；已购下架 agent 的用户仍可对话；
// 处方 toolKey 白名单仍含创作型（判断点：创作型保持 enabled，是白名单供给方 + 货架商品）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { toolWhitelist } from '../src/services/prescription.ts';

const KEEP_ADVISORY = ['general', 'strat', 'growth', 'ops', 'brand'];
const RETIRED_ADVISORY = ['intel', 'fund', 'model', 'org'];

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

test('未购用户 /agents 只见保留科室：下架顾问 intel/fund/model/org 不出现', async () => {
  const t = await login(uniquePhone());
  const list = (await api('GET', '/api/agents', { token: t })).body as { key: string; type: string }[];
  const keys = new Set(list.map((a) => a.key));
  // 保留的 4+1 顾问科室都在
  for (const k of KEEP_ADVISORY) assert.ok(keys.has(k), `保留科室 ${k} 应可见`);
  // 下架的冗余顾问不在默认列表
  for (const k of RETIRED_ADVISORY) assert.ok(!keys.has(k), `下架顾问 ${k} 不应出现在用户列表`);
  // 顾问科室（type=advisory）恰好只剩保留集（general 为 general 类型，单独校验已在上）
  const advisoryKeys = list.filter((a) => a.type === 'advisory').map((a) => a.key).sort();
  assert.deepEqual(advisoryKeys, ['brand', 'growth', 'ops', 'strat'], '顾问科室只剩保留 4 个');
});

test('已购下架 agent 的用户仍可对话（assertAgentAccess 豁免 owned）', async () => {
  const t = await login(uniquePhone());
  // 下架 agent 默认不在列表、未购时对话被拦
  const locked = await api('POST', '/api/generate-sync', { token: t, body: { text: '竞品分析', agentKey: 'intel' } });
  assert.equal(locked.status, 403);
  assert.equal(locked.body.code, 'AGENT_LOCKED');
  // 后台为其开通该下架 agent
  const grant = await api('POST', `/api/admin/users/${t}/agents`, { body: { agentKey: 'intel' } });
  assert.equal(grant.status, 200);
  // 开通后即便 agent 已下架仍可正常对话产出
  const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '竞品分析', agentKey: 'intel' } });
  assert.equal(gen.status, 200, '已购用户对下架 agent 仍可对话');
});

test('处方 toolKey 白名单：含创作型工坊 agent，不含下架顾问', async () => {
  const wl = await toolWhitelist();
  // 判断点：创作型保持 enabled → 仍是处方可开工具（白名单供给方）
  for (const k of ['ip', 'promo', 'poster', 'shortvideo', 'copy']) assert.ok(wl.has(k), `创作型 ${k} 应在处方白名单`);
  // 保留顾问也在
  for (const k of KEEP_ADVISORY) assert.ok(wl.has(k), `保留科室 ${k} 应在处方白名单`);
  // 下架顾问退出白名单（随科室退役）
  for (const k of RETIRED_ADVISORY) assert.ok(!wl.has(k), `下架顾问 ${k} 应退出处方白名单`);
});
