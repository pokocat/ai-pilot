// seed 幂等性回归：2026-08-01 预发部署实测，`npm run db:seed` 第二次跑必炸——
// seed 自己创建 TokenWallet，但它的清理列表（当时是 resetBusinessData 的过时子集）没有这张表，
// 于是 user.deleteMany() 撞 `token_wallet_userId_fkey` 报 P2003。deploy-preprod.sh 用 `|| echo`
// 咽掉退出码，脚本照样报成功，演示租户其实没重建。
//
// 这里不跑完整 seed（慢且会推平预设目录），而是直接钉住根因：
//   ① 造出「user + 挂在它下面的 tokenWallet」这一最小现场，resetBusinessData 必须能清掉；
//   ② resetBusinessData 必须覆盖所有指向 User/Tenant 的外键表——用 schema 反查，漏一张就红。
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/db.js';
import { resetBusinessData } from '../prisma/resetBusinessData.js';
import { cleanBusiness, closeApp, getApp } from './helpers.js';

before(async () => { await getApp(); await cleanBusiness(); });
after(async () => { await closeApp(); });

test('user 下挂 tokenWallet 时，resetBusinessData 仍能清空（P2003 回归）', async () => {
  const tenant = await prisma.tenant.create({ data: { name: '幂等测试', industry: 'SaaS', stage: 'A' } });
  const user = await prisma.user.create({
    data: { tenantId: tenant.id, phone: '13900000001', name: '钱包用户', role: 'owner' },
  });
  // 正是 seed 会创建、而旧清理列表漏掉的那张表。
  await prisma.tokenWallet.create({ data: { userId: user.id, tenantId: tenant.id, quota: 1_000_000, balance: 1_000_000 } });

  await resetBusinessData(prisma); // 修复前这里抛 P2003

  assert.equal(await prisma.user.count(), 0, 'user 应被清空');
  assert.equal(await prisma.tenant.count(), 0, 'tenant 应被清空');
  assert.equal(await prisma.tokenWallet.count(), 0, 'tokenWallet 应被清空');

  // 幂等：连跑两次不报错、不残留。
  await resetBusinessData(prisma);
  assert.equal(await prisma.user.count(), 0);
});

test('resetBusinessData 覆盖了 schema 里所有指向 User / Tenant 的外键表', async () => {
  const schema = await readFile(path.resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8');
  const resetSrc = await readFile(path.resolve(process.cwd(), 'prisma/resetBusinessData.ts'), 'utf8');

  // 逐个 model 块扫描：块内出现指向 User/Tenant 的 @relation，就必须在 reset 列表里。
  const blocks = schema.split(/\nmodel\s+/).slice(1);
  const missing: string[] = [];
  for (const block of blocks) {
    const name = block.slice(0, block.indexOf(' ')).trim();
    if (name === 'User' || name === 'Tenant') continue;
    const refsUserOrTenant = /@relation\([^)]*references:\s*\[id\][^)]*\)/.test(block)
      && /\b(user|tenant)\s+(User|Tenant)\b/.test(block);
    if (!refsUserOrTenant) continue;
    // prisma client 属性名 = model 名首字母小写
    const prop = name.charAt(0).toLowerCase() + name.slice(1);
    if (!new RegExp(`prisma\\.${prop}\\.deleteMany\\(\\)`).test(resetSrc)) missing.push(name);
  }
  assert.deepEqual(
    missing, [],
    `以下表指向 User/Tenant 但不在 prisma/resetBusinessData.ts 中，seed 与测试清库都会因它们报 P2003：${missing.join(', ')}`,
  );
});
