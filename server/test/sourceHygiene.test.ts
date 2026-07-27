// 源码卫生：源文件里不许出现裸 NUL 字节。
//   cd server && node --import tsx --test test/sourceHygiene.test.ts
//
// 为什么值得一条独立测试：`src/llm/gateway.ts` 曾在缓存键分隔符处写了一个**字面** NUL 字节
// （`.join('\0')` 的 `\0` 被写成了真字节）。后果不是运行时错误——运行时完全正常——而是
// `file(1)` 把该文件判定为 `data`，于是 grep / ripgrep / ugrep 一律按二进制处理并**静默整文件跳过**。
// 结果是项目里最关键的 LLM 网关对所有基于 grep 的检索隐形：代码搜索、批量重构、安全扫描全都看不见它，
// 而且没有任何报错提示你漏了。这类缺陷靠 code review 极难发现（diff 里 NUL 通常渲染成空格），
// 只能靠自动检查兜住。
//
// NUL 本身作为分隔符是合理选择（正常文本不会出现，拼接结果无法被内容伪造），
// 所以修法不是换分隔符，而是**必须写成转义序列**，让源文件保持纯文本。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// 扫这几棵源码树（含 shared 契约）。构建产物、依赖、二进制资源不扫。
const ROOTS = ['server/src', 'server/test', 'server/scripts', 'shared', 'admin/src', 'app/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.prisma']);
const TEXT_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml|sh|sql|prisma)$/i;

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name), out);
    } else if (e.isFile() && TEXT_EXT.test(e.name)) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

test('源文件不含裸 NUL 字节（否则 grep 会把整个文件当二进制跳过）', () => {
  const files = ROOTS.flatMap((r) => {
    const abs = join(REPO_ROOT, r);
    try { statSync(abs); } catch { return []; }
    return walk(abs);
  });
  assert.ok(files.length > 100, `只扫到 ${files.length} 个源文件，扫描根目录可能配错了`);

  const offenders: string[] = [];
  for (const f of files) {
    const buf = readFileSync(f);
    const at = buf.indexOf(0);
    if (at >= 0) {
      const line = buf.subarray(0, at).toString('utf8').split('\n').length;
      offenders.push(`${relative(REPO_ROOT, f)}:${line}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `以下源文件含裸 NUL 字节，会被 grep/ripgrep 当二进制整文件跳过；请改用转义序列（如 \\u0000）：\n  ${offenders.join('\n  ')}`,
  );
});
