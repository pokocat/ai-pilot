// 空 key 的 ai_setting(default) 会盖掉 env、让整站静默降级成模板（2026-11-24 声量AI 本地联调踩到）。
//   ① seed 不再写这一行；② 读配置时遇到「声明了真实 provider 却没有可用 key」必须喊一次。
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const warns: string[] = [];
const realWarn = console.warn;
afterEach(() => { console.warn = realWarn; delete process.env.AI_ALLOW_REAL_PROVIDER; });

async function readWithRow(row: Record<string, unknown> | null) {
  const { prisma } = await import('../src/db.js');
  const { getAiConfig, effectiveProvider, __resetLegacyUnreadyWarning } = await import('../src/services/aiConfig.js');
  __resetLegacyUnreadyWarning();
  warns.length = 0;
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  // 测试环境 isAiTestMode() 恒真、提示会被压住；这里显式放行代码路径（不发任何网络请求）。
  process.env.AI_ALLOW_REAL_PROVIDER = '1';
  const prevV2 = process.env.AI_CONFIG_V2;
  process.env.AI_CONFIG_V2 = 'false';
  const original = prisma.aiSetting.findUnique;
  // @ts-expect-error 测试替身
  prisma.aiSetting.findUnique = async () => row;
  try {
    const cfg = await getAiConfig(true);
    return { cfg, effective: effectiveProvider(cfg), logs: [...warns] };
  } finally {
    // @ts-expect-error 还原
    prisma.aiSetting.findUnique = original;
    if (prevV2 === undefined) delete process.env.AI_CONFIG_V2; else process.env.AI_CONFIG_V2 = prevV2;
  }
}

const emptyKeyRow = {
  id: 'default', provider: 'openai', label: 'Agnes 2.0 Flash', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash',
  apiKey: '', embeddingModel: '', temperature: 0.7, thinkingMode: null, thinkingBudget: null, dialect: null, capsJson: null,
  embeddingEnabled: false, embeddingBaseUrl: '', embeddingApiKey: '', rerankEnabled: false, rerankModel: '', rerankBaseUrl: '', rerankApiKey: '',
  activeModelId: null,
};

test('空 key 的 ai_setting 行：仍降级 mock（行为不变），但明确告警并给出处理办法；每进程只喊一次', async () => {
  const first = await readWithRow(emptyKeyRow);
  assert.equal(first.effective, 'mock');
  const hit = first.logs.find((line) => line.includes('ai_setting(default)'));
  assert.ok(hit, '空 key 行让整站降级时不能沉默');
  assert.match(hit!, /本地模板/);
  assert.match(hit!, /DELETE FROM ai_setting WHERE id='default'/);
  assert.doesNotMatch(hit!, /sk-|apiKey=/, '日志不得带出任何密钥值');
});

test('有可用 key 的行、或根本没有这一行：不告警', async () => {
  const ready = await readWithRow({ ...emptyKeyRow, apiKey: 'sk-local-real-looking-1234' });
  assert.equal(ready.effective, 'openai');
  assert.equal(ready.logs.filter((line) => line.includes('ai_setting(default)')).length, 0);
  const none = await readWithRow(null);
  assert.equal(none.logs.filter((line) => line.includes('ai_setting(default)')).length, 0);
});

test('seed 不再写 ai_setting（否则新环境一跑 seed，.env 的模型配置就被空 key 行盖掉）', () => {
  const seed = readFileSync(new URL('../prisma/seed.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(seed, /aiSetting\.(upsert|create|update)/);
});
