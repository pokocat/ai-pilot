// 旧表必须保持只读（三期收尾，2026-08-08）。
//   cd server && npm test -- test/aiLegacyReadOnly.test.ts
//
// 这条是**结构性防回退**，不是行为测试：三期收尾把 `AiSetting`/`AiModel` 降为只读，
// 但下一个人完全可能顺手写一句 `prisma.aiModel.update(...)` 把双写又带回来——
// 那正是「后台改完线上没变」这类故障的温床，而且它不报错、测不出来。
// 所以直接扫源码：运行时代码里对旧表的写操作必须为零。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 允许写旧表的白名单：一次性迁移。它们的职责就是搬运存量数据。 */
const ALLOWED = ['aiConfigMigrate.ts', 'aiCredentialMigration.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('运行时代码不得再写 ai_model / ai_setting（旧表只读）', () => {
  const offenders: string[] = [];
  for (const file of walk('src')) {
    if (ALLOWED.some((a) => file.endsWith(a))) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/prisma\.(aiModel|aiSetting)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g)) {
      offenders.push(`${file.replace(/^src\//, '')} → ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    '旧表已降为只读。要改接入配置请走 services/aiV2Admin.ts 的写路径；'
    + '若确实是一次性迁移，把文件加进本测试的 ALLOWED 白名单并说明理由。',
  );
});

test('归一化写路径存在且是唯一入口', () => {
  const v2 = readFileSync('src/services/aiV2Admin.ts', 'utf8');
  for (const fn of ['createEndpoint', 'updateEndpoint', 'deleteEndpoint', 'updateCredential', 'saveRoute', 'setPrimary']) {
    assert.ok(v2.includes(`export async function ${fn}`), `写路径缺 ${fn}`);
  }
  // 每个写操作都必须让缓存失效，否则「运营改完最多 4 秒不生效且无报错」会回来。
  assert.ok(v2.includes('__resetAiConfigCache'), '写路径必须清 aiConfig 的已解析配置缓存');
});
