// 测试环境自足性（hermetic env）预载模块 —— 由 package.json 的 test 脚本用
// `--import ./test/hermeticEnv.mjs` 在任何业务/测试模块之前执行（node 会把 execArgv 透给
// test runner 派生的每个子进程，与 `--import tsx` 同理）。刻意写成 .mjs：它必须先于 tsx 生效。
//
// 背景：`npm test` 用 `node --env-file=.env.test` 注入测试变量，但进程里还有两个会**自动**读
// `server/.env` 的装载器。dotenv 系不覆盖已存在的键，所以 `.env.test` 已声明的键（DATABASE_URL /
// NODE_ENV）是安全的，其余「`.env.test` 没声明的键」照样会被注入进来：
//   1) `src/env.ts` 的 dotenv —— 已在该文件按 NODE_ENV=test 整体跳过（见其顶部注释）；
//   2) `@prisma/client` —— 生成产物里烤死了 `relativeEnvPaths.schemaEnvPath`（指向 server/.env），
//      import 时按绝对路径无条件加载，与 cwd 无关；Prisma 5.22 的 runtime 里没有任何 opt-out
//      开关（已 grep 确认），因此只能在装载之后抹掉。
// 后果：开发机的真实配置（微信订阅模板 ID、OSS、短信…）渗进测试，同一份用例在「有 .env 的开发机」
// 红、在「没有 .env 的 CI」绿。历史坑（2026-07-27 修）：`wechatMessage`「订阅消息 accept 后累计
// 一次额度」与 `reminders`「三条提醒节奏」两例因 .env 里的 WECHAT_SUBSCRIBE_*_TEMPLATE_ID 长期本地失败。
//
// 做法（通用，不 pin 具体变量名）：记下进程启动那一刻的键集合（= 真实 shell 环境 + `.env.test`），
// 之后凡是「启动后新增的键」一律抹掉。于是测试看到的 process.env 恒等于「shell + .env.test」——
// 以后往 `.env` 里加任何新键都不会再弄红测试。Prisma 的注入有两个时机，因此抹除也在两处触发：
//   · 模块 import 时 —— 本文件下方主动引一次 `@prisma/client`，注入完立刻抹；
//   · 每次 `new PrismaClient()` 时 —— 由 `src/db.ts`（全仓唯一构造点）在构造语句的下一行调
//     `globalThis.__hermeticEnv.scrub()`；这个钩子只在测试预载了本文件时存在，生产进程里是 no-op。
// 守卫用例：test/envHermetic.test.ts。

// 进程启动时的键集合。此刻还没有任何模块跑过，因此这就是「外部真实环境 + --env-file」的真值。
const pristineKeys = new Set(Object.keys(process.env));
const removed = new Set();

/** 抹掉进程启动后被自动装载器注入的键；返回本次抹掉的个数。可反复调用。 */
function scrub() {
  let n = 0;
  for (const key of Object.keys(process.env)) {
    if (pristineKeys.has(key)) continue;
    delete process.env[key];
    removed.add(key);
    n += 1;
  }
  if (n && process.env.TEST_ENV_DEBUG === '1') {
    console.error(`[hermetic-env] 抹除 ${n} 个自动注入的键：${[...removed].join(', ')}`);
  }
  return n;
}

// 供 src/db.ts 的构造后钩子与守卫用例使用（守卫用例据此判断「.env 里的键有没有漏进来」，
// 且不会把 shell 里本就导出的同名变量误判成泄漏）。
globalThis.__hermeticEnv = { pristineKeys: [...pristineKeys], removed, scrub };

// 让 @prisma/client 的 import 时注入**在这里**发生并立即抹除。
// 若客户端尚未 generate，这里抛错是对的：整套测试本来也跑不起来。
await import('@prisma/client');
scrub();
