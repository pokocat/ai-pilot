// AGENTS.md 膨胀防线：与 scripts/check-agents-doc.mjs 同一份判定，挂进 `npm test`（CI frontend-unit 覆盖）。
// 为什么放在 app/scripts：这里的 `node --test scripts/*.test.mjs` 是三端里唯一零依赖、CI 必跑、不需要数据库的纯函数测试基座。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAgentsDoc, LIMITS } from '../../scripts/check-agents-doc.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('AGENTS.md 守在体量预算内、骨架固定、索引与 docs/agents/ 一一对应', () => {
  const r = checkAgentsDoc(ROOT);
  assert.ok(
    r.ok,
    `AGENTS.md 膨胀防线未通过（${r.bytes} 字节 / ${r.lines} 行，上限 ${LIMITS.totalBytes} / ${LIMITS.totalLines}）：\n- ${r.problems.join('\n- ')}\n` +
      '处理办法：把新增内容挪到 docs/agents/ 对应分册的对应小节（或 docs/CHANGELOG.md），入口文件只留一句规则 + 链接。不要抬上限。',
  );
});
