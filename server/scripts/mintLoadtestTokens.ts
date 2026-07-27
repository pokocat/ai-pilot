// 为压测用户批量签发真实 HS256 JWT，落 loadtest/tokens.json。
//   cd server && LT_JWT_SECRET=... npx tsx scripts/mintLoadtestTokens.ts [用户数]
// 通常由 loadtest/prepare.sh 调用，不必手动跑。
//
// 为什么必须有这一步：上一轮压测 APP_JWT_REQUIRED=false、APP_JWT_SECRET 置空，k6 直接发裸
// `x-user-id: lt-user-0001`，于是 verifyUserToken() 走的是「非 JWT 形原样放行」分支——
// HS256 验签一次都没执行，而生产每个请求都要验。容量数字因此偏乐观。
//
// 关键：这里**直接 import 服务端的 signUserToken**，而不是照着它再实现一遍 JWT 签名。
// 手写一份 base64url/HMAC 看着简单，但一旦服务端的 claim 或编码细节变了，压测这边会静默失配，
// 表现为全站 401——那时候你会先去怀疑限流和鉴权配置，而不是怀疑压测脚本。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { signUserToken, jwtEnabled } from '../src/services/userToken.js';

const secret = (process.env.LT_JWT_SECRET ?? process.env.APP_JWT_SECRET ?? '').trim();
if (!secret) {
  console.error('!! 需要 LT_JWT_SECRET（或 APP_JWT_SECRET）。请执行 bash loadtest/prepare.sh');
  process.exit(1);
}
// signUserToken 从 APP_JWT_SECRET 读密钥（懒读，赋值早于调用即可）。
process.env.APP_JWT_SECRET = secret;
if (!jwtEnabled()) {
  console.error('!! 密钥设置后 jwtEnabled() 仍为 false，签发逻辑异常，终止');
  process.exit(1);
}

const count = Math.max(1, Number(process.argv[2] ?? process.env.LT_USERS ?? 1000) || 1000);
// 与 prisma/loadtestSeed.ts 的 id 约定一致：lt-user-0001 …
const pad4 = (n: number) => String(n).padStart(4, '0');

const tokens: string[] = [];
for (let i = 1; i <= count; i++) tokens.push(signUserToken(`lt-user-${pad4(i)}`));

// 自检：签出来的 token 必须能被同一套 verifyUserToken 验回原 userId。
// 这条断言就是为了让「压测脚本与服务端签名口径漂移」立刻暴露在生成阶段，而不是变成运行期 401。
const { verifyUserToken } = await import('../src/services/userToken.js');
for (let i = 0; i < Math.min(tokens.length, 5); i++) {
  const want = `lt-user-${pad4(i + 1)}`;
  const got = verifyUserToken(tokens[i]);
  if (got !== want) {
    console.error(`!! 自检失败：token[${i}] 验回 ${JSON.stringify(got)}，期望 ${want}`);
    process.exit(1);
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'loadtest', 'tokens.json');
writeFileSync(out, `${JSON.stringify(tokens)}\n`, { mode: 0o600 });
console.log(`已签发 ${tokens.length} 个 JWT → ${out}（0600，含压测密钥派生物，勿入库）`);
