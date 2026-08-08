// 读配置失败时不得静默降级（2026-08-08）。
//   cd server && npm test -- test/aiConfigFallback.test.ts
//
// 背景：`getAiConfig` 读 `ai_setting` 失败时会回落环境变量，通常就是 provider=mock ——
// **全站产出因此变成本地模板**。此前这个 catch 一行日志都没有，注释写的理由是「DB 不可达」。
// 但 2026-08-08 实测最常见的成因根本不是 DB 挂了，而是**新代码 + 旧 schema**：
// 部署时 db push 没跑（或被 data-loss 门拦住），Prisma 报
// `The column ai_setting.dialect does not exist in the current database`。
// 这种状态下服务健康、接口 200、日志干净，只是每个用户拿到的都是模板——
// 是最坏的一类故障。回落行为保留（DB 抖一下不该变成事故），但必须喊出来。
import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const errors: string[] = [];
const realError = console.error;
beforeEach(() => { errors.length = 0; console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); }; });
afterEach(() => { console.error = realError; });

/** 直接驱动模块内的降级提示逻辑：构造一次读失败，看它喊不喊。 */
async function triggerFallback(message: string): Promise<string[]> {
  const { prisma } = await import('../src/db.js');
  const { getAiConfig } = await import('../src/services/aiConfig.js');
  const original = prisma.aiSetting.findUnique;
  // @ts-expect-error 测试替身
  prisma.aiSetting.findUnique = async () => { throw new Error(message); };
  try {
    const cfg = await getAiConfig(true);
    assert.ok(cfg.provider, '回落行为必须保留：仍要给得出一份可用配置');
  } finally {
    // @ts-expect-error 还原
    prisma.aiSetting.findUnique = original;
  }
  return [...errors];
}

describe('读模型配置失败：回落照旧，但必须喊出来', () => {
  test('schema 与代码不一致 → 明确指出该跑 db push，并点明全站正在降级', async () => {
    const logs = await triggerFallback('The column `ai_setting.dialect` does not exist in the current database.');
    const hit = logs.find((l) => l.includes('[aiConfig]'));
    assert.ok(hit, '这种故障不能静默——此前正是一行日志都没有');
    assert.match(hit!, /schema/);
    assert.match(hit!, /db push/);
    assert.match(hit!, /本地模板/, '必须说清楚后果，不能只说读失败');
  });

  test('其它读失败（DB 真的不可达）也要喊，但不误报成 schema 问题', async () => {
    const logs = await triggerFallback('Cant reach database server at localhost:5432');
    const hit = logs.find((l) => l.includes('[aiConfig]'));
    assert.ok(hit);
    assert.doesNotMatch(hit!, /db push/, '别把连不上库误导成 schema 问题');
  });

  test('同一原因 60 秒内不重复刷屏（配置有 4s 缓存，持续故障会反复触发）', async () => {
    await triggerFallback('The column `ai_setting.dialect` does not exist in the current database.');
    const first = errors.filter((l) => l.includes('[aiConfig]')).length;
    errors.length = 0;
    await triggerFallback('The column `ai_setting.dialect` does not exist in the current database.');
    const second = errors.filter((l) => l.includes('[aiConfig]')).length;
    assert.equal(first, 1);
    assert.equal(second, 0, '同一原因应被去重，否则每 4 秒刷一条');
  });
});
