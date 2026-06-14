// 运营后台账户 — 纯单元测试（密码哈希 / 主密钥校验，不连库、不联网）。
// 仅覆盖纯函数；初始化/登录/会话等需 Prisma 的部分由集成测试覆盖。
//   cd server && node --import tsx --test test/adminAccount.test.ts
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, masterKeyValid, masterKeyConfigured } from '../src/services/adminAccount.js';

describe('密码哈希（scrypt）', () => {
  test('hashPassword 形如 scrypt$salt$hash，且每次盐不同', () => {
    const a = hashPassword('s3cret!');
    const b = hashPassword('s3cret!');
    assert.match(a, /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
    assert.notEqual(a, b, '相同密码两次哈希应因随机盐而不同');
  });

  test('verifyPassword：正确密码 true、错误密码 false', () => {
    const stored = hashPassword('correct-horse');
    assert.equal(verifyPassword('correct-horse', stored), true);
    assert.equal(verifyPassword('wrong', stored), false);
    assert.equal(verifyPassword('', stored), false);
  });

  test('verifyPassword：畸形/非 scrypt 串一律 false（不抛错）', () => {
    assert.equal(verifyPassword('x', 'not-a-hash'), false);
    assert.equal(verifyPassword('x', 'scrypt$zz'), false);          // 段数不足
    assert.equal(verifyPassword('x', 'bcrypt$aa$bb'), false);        // 算法前缀不符
    assert.equal(verifyPassword('x', 'scrypt$gg$hh'), false);        // 非法 hex
  });

  test('哈希区分大小写与空白', () => {
    const stored = hashPassword('Pass Word');
    assert.equal(verifyPassword('pass word', stored), false);
    assert.equal(verifyPassword('Pass Word', stored), true);
  });
});

describe('主密钥校验', () => {
  const saved = process.env.ADMIN_TOKEN;
  afterEach(() => { if (saved === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = saved; });

  test('masterKeyValid：命中/不命中/空值', () => {
    process.env.ADMIN_TOKEN = 'super-secret-token';
    assert.equal(masterKeyValid('super-secret-token'), true);
    assert.equal(masterKeyValid('super-secret-token '), true, '前后空白应被裁剪');
    assert.equal(masterKeyValid('wrong'), false);
    assert.equal(masterKeyValid(''), false);
    assert.equal(masterKeyValid(undefined), false);
  });

  test('未配置 ADMIN_TOKEN 时一律 false，且 masterKeyConfigured=false', () => {
    delete process.env.ADMIN_TOKEN;
    assert.equal(masterKeyConfigured(), false);
    assert.equal(masterKeyValid('anything'), false);
    process.env.ADMIN_TOKEN = 'x';
    assert.equal(masterKeyConfigured(), true);
  });
});
