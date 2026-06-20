// secretBox 单测：加解密往返 / 向后兼容明文 / 幂等 / 未配密钥透传。
// 不依赖 DB，纯函数。masterSecret() 每次调用动态读 process.env，故单次 import 即可在两种 env 下分别验证。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret, decryptSecret, decryptSecretSafe, isEncrypted, encryptionEnabled } from '../src/services/secretBox.ts';

test('未配 APP_ENCRYPTION_KEY：透传明文，可读回', () => {
  delete process.env.APP_ENCRYPTION_KEY;
  delete process.env.SECRET_ENCRYPTION_KEY;
  assert.equal(encryptionEnabled(), false);
  const v = 'sk-plain-1234567890';
  assert.equal(encryptSecret(v), v); // 透传
  assert.equal(isEncrypted(v), false);
  assert.equal(decryptSecret(v), v); // 明文原样
});

test('配置密钥：加密往返 + 幂等 + 历史明文兼容', () => {
  process.env.APP_ENCRYPTION_KEY = 'unit-test-master-key-please-change';
  assert.equal(encryptionEnabled(), true);

  const plain = 'sk-secret-abc-XYZ-0987';
  const enc = encryptSecret(plain);
  assert.ok(enc.startsWith('enc:v1:'), '应带版本前缀');
  assert.notEqual(enc, plain);
  assert.equal(isEncrypted(enc), true);
  assert.equal(decryptSecret(enc), plain, '解密应还原');

  // 幂等：对已加密再加密不变
  assert.equal(encryptSecret(enc), enc);

  // 历史明文：无前缀 → 原样返回
  assert.equal(decryptSecret('legacy-plaintext'), 'legacy-plaintext');
  assert.equal(decryptSecretSafe('legacy-plaintext'), 'legacy-plaintext');

  // 空值
  assert.equal(encryptSecret(''), '');
  assert.equal(decryptSecret(''), '');

  // 两次加密同一明文应不同（随机 IV）
  assert.notEqual(encryptSecret(plain), encryptSecret(plain));

  delete process.env.APP_ENCRYPTION_KEY;
});
