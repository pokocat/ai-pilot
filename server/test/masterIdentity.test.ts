// 主军师身份（M1 PR-5b）：V6.0 主线人格由总军师 general 承载；strat 回归专业参谋；
// 调度白名单语义（unlock=可深聊/可被调度资格）保持既有 assertAgentAccess 行为。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { AGENTS } from '../src/data/agents.ts';
import { prisma } from '../src/db.ts';
import { scanBannedWords } from '../src/services/bannedWords.ts';

before(async () => {
  await getApp();
  await cleanBusiness();
  await seedBaseline();
});

after(async () => {
  await closeApp();
});

test('总军师 general 承载 V1.0 全文；strat 为专业参谋短模板；无米诺品牌残留', () => {
  const general = AGENTS.find((a) => a.key === 'general')!;
  const strat = AGENTS.find((a) => a.key === 'strat')!;
  // V1.0 全文（约 1.6 万字，b2321fb 由旧「天势终极版 V6.0」重置版本号而来）挂 general；
  // 文件缺失时回退模板（此断言同时守护文件存在性）
  assert.ok(general.systemPrompt.length > 10000, `general 应为 V1.0 全文，实际 ${general.systemPrompt.length} 字`);
  assert.match(general.systemPrompt, /^军师参谋部 · 天势战略系统 V1\.0/);
  assert.match(general.systemPrompt, /三势/);
  // strat 回归专业参谋（短模板 + 回流主线口径）
  assert.ok(strat.systemPrompt.length < 2000, 'strat 应为专业参谋短模板');
  assert.match(strat.systemPrompt, /战略诊断官/);
  assert.match(strat.systemPrompt, /回流总军师主线/);
  // 品牌红线（AGENTS §0 #10）：注册表任何提示词/文案不得含米诺
  for (const a of AGENTS) {
    assert.ok(!/米诺|Mino/i.test(a.systemPrompt + a.greet + a.name), `${a.key} 含品牌残留`);
  }
  // 主军师问候不含禁用词（V6.0 §17）
  assert.deepEqual(scanBannedWords(general.greet), []);
});

test('调度白名单：unlock 专业军师未解锁 → 专属线程 403 AGENT_LOCKED；免费主线不受限', async () => {
  const token = await login(uniquePhone(), '白名单用户');
  const locked = await prisma.agent.findFirst({ where: { billing: 'unlock', enabled: true } });
  assert.ok(locked, '注册表应存在 unlock 智能体');
  const r = await api('POST', '/api/generate-sync', { token, body: { text: '你好', agentKey: locked!.key } });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'AGENT_LOCKED');
  // 总军师（free）畅通
  const ok = await api('POST', '/api/generate-sync', { token, body: { text: '你好', agentKey: 'general' } });
  assert.equal(ok.status, 200);
});

test('总军师成果承接（P0-3）：闲聊保持对话体；聊到要方案 → 按需产出「战略方案」成果卡（可采纳拆军令）', async () => {
  const token = await login(uniquePhone(), '承接用户');
  await api('PUT', '/api/profile', { token, body: { industry: '美业 / 医美', stage: '100-500 万', pain: '增长乏力' } });
  // 注册表口径：general 配 on-demand + 战略方案
  const general = AGENTS.find((a) => a.key === 'general')!;
  assert.equal(general.deliverableKey, '战略方案');
  assert.equal((general.skillsConfig as { deliverableMode?: string }).deliverableMode, 'on-demand');
  // 闲聊轮：不甩报告
  const chat = await api('POST', '/api/generate-sync', { token, body: { text: '最近有点迷茫，跟你聊聊', agentKey: 'general' } });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.kind, 'chat');
  // 方案轮：产出结构化成果，且军令/风险锁可被案卷提取（采纳动线的前提）
  const rep = await api('POST', '/api/generate-sync', { token, body: { text: '聊得差不多了，给我出个方案', agentKey: 'general' } });
  assert.equal(rep.status, 200);
  assert.equal(rep.body.kind, 'report');
  assert.ok(rep.body.deliverable?.sections?.length, '应返回分节成果');
  const { extractOrders, extractRisks } = await import('../src/services/casefile.ts');
  assert.ok(extractOrders(rep.body.deliverable).length >= 1, '成果应能拆出军令');
  assert.ok(extractRisks(rep.body.deliverable).length >= 1, '成果应能提出风险锁');
});
