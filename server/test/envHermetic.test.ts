// 测试环境自足性守卫（免 DB 连接、免网）：`npm test` 只吃 `.env.test` + 真实 shell 环境 +
// 用例内显式设置的变量，绝不吃开发机的 `server/.env`。
//
// 历史坑（2026-07-27 修）：进程里有两个会自动读 `server/.env` 的装载器 —— `src/env.ts` 的 dotenv 与
// `@prisma/client`。dotenv 系不覆盖已存在的键，所以 `.env.test` 已声明的 DATABASE_URL 是安全的，
// 但 `.env` 里那些 `.env.test` **没**声明的键照样被注入：开发机真实的 WECHAT_SUBSCRIBE_*_TEMPLATE_ID
// 因此渗进测试，`wechatMessage`「订阅消息 accept 后累计一次额度」与 `reminders`「三条提醒节奏」两例
// 在本地长期失败，而 CI（没有 `.env`）全绿 —— 同一份代码的红绿取决于谁的机器。
//
// 本守卫钉的是不变量本身，不逐个 pin 变量名：读一遍 `server/.env` 的键，断言「本文件没声明、
// shell 也没导出」的键一个都没漏进 process.env。所以以后往 `.env` 里加任何新键都会被这条用例罩住。
// 机制见 test/hermeticEnv.mjs（预载抹除 + 提供 scrub 钩子）、src/env.ts（测试跳过 dotenv）、
// src/db.ts（构造 PrismaClient 后调 scrub）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { dotenvLoaded } from '../src/env.js';
import { prisma } from '../src/db.js'; // 触发 new PrismaClient()——第二个注入时机

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseEnvFile(name: string): Record<string, string> {
  try {
    return dotenv.parse(readFileSync(path.join(serverDir, name), 'utf8')); // 只解析，不注入
  } catch {
    return {}; // 文件不存在（如 CI 没有 .env）——本守卫自然成立
  }
}

test('测试环境不加载 server/.env：env.ts 跳过 dotenv', () => {
  assert.equal(process.env.NODE_ENV, 'test', 'npm test 必须以 NODE_ENV=test 运行（由 .env.test 注入）');
  assert.equal(
    dotenvLoaded,
    false,
    'env.ts 不得在测试环境加载 server/.env —— 需要的变量请写进 .env.test 或在用例里显式设置，详见 src/env.ts 顶部注释',
  );
});

test('测试环境不加载 server/.env：.env 独有的键一个都没漏进 process.env', () => {
  assert.ok(prisma, 'PrismaClient 已构造（覆盖 @prisma/client 的构造时注入）');

  const hermetic = (globalThis as { __hermeticEnv?: { pristineKeys?: string[] } }).__hermeticEnv;
  assert.ok(
    Array.isArray(hermetic?.pristineKeys),
    'test/hermeticEnv.mjs 未被预载 —— package.json 的 test 脚本必须带 `--import ./test/hermeticEnv.mjs`',
  );
  // 进程启动时就在的键（shell 导出 + .env.test）不算泄漏：本机 shell 里恰好导出同名变量是合法的。
  const pristine = new Set(hermetic!.pristineKeys!);

  const envTestKeys = new Set(Object.keys(parseEnvFile('.env.test')));
  const leaked = Object.keys(parseEnvFile('.env')).filter(
    (k) => !pristine.has(k) && !envTestKeys.has(k) && process.env[k] !== undefined,
  );

  assert.deepEqual(
    leaked,
    [],
    `server/.env 独有的键漏进了测试进程：${leaked.join(', ')} —— 有新的自动装载器绕过了 test/hermeticEnv.mjs 的抹除`,
  );
});
