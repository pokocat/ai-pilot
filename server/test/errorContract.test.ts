import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const consumerRoutes = ['agents.ts', 'memories.ts', 'projects.ts', 'reports.ts', 'sessions.ts'];

test('C 端核心路由的字面量 4xx/5xx 同时返回可读原因与机器码', () => {
  for (const name of consumerRoutes) {
    const file = path.resolve(process.cwd(), 'src/routes', name);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (!/reply\.code\([^)]*\)\.send\(\{\s*error:/.test(line)) continue;
      assert.match(line, /\bcode:/, `${name}:${index + 1} 的用户错误缺少机器码`);
      assert.doesNotMatch(
        line,
        /error:\s*['"](?:report|version|project|memory|agent|session) not found['"]/i,
        `${name}:${index + 1} 仍把英文内部错误直接给用户`,
      );
    }
  }
});
