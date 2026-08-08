import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getAiConfig } from '../src/services/aiConfig.js';
import { configurePurpose, __wipeAiV2 } from '../src/services/aiV2Admin.js';
import { migrateAiCredentialsToPlaintext } from '../src/services/aiCredentialMigration.js';
import { encryptSecret, isEncrypted } from '../src/services/secretBox.js';

test('AI 模型凭证新写明文，历史密文可读且能幂等迁移', async () => {
  const testMaster = 'ai-credential-storage-test-master';
  const previousMaster = process.env.APP_ENCRYPTION_KEY;
  const originalSetting = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
  let modelId = '';
  process.env.APP_ENCRYPTION_KEY = testMaster;

  try {
    // 旧表已停写（三期收尾），但这条迁移本来就是为存量旧行准备的——直接造行，
    // 而不是绕道已删除的 setAiConfig。
    await prisma.aiSetting.upsert({
      where: { id: 'default' },
      update: {
        provider: 'openai', label: 'AI 凭证明文测试', baseUrl: 'https://example.invalid/v1',
        model: 'plain-storage-test', apiKey: 'sk-main-plain-test',
        embeddingApiKey: 'sk-embedding-plain-test', rerankApiKey: 'sk-rerank-plain-test',
      },
      create: {
        id: 'default', provider: 'openai', label: 'AI 凭证明文测试', baseUrl: 'https://example.invalid/v1',
        model: 'plain-storage-test', apiKey: 'sk-main-plain-test',
        embeddingApiKey: 'sk-embedding-plain-test', rerankApiKey: 'sk-rerank-plain-test',
      },
    });
    const storedSetting = await prisma.aiSetting.findUniqueOrThrow({ where: { id: 'default' } });
    assert.equal(storedSetting.apiKey, 'sk-main-plain-test');
    assert.equal(storedSetting.embeddingApiKey, 'sk-embedding-plain-test');
    assert.equal(storedSetting.rerankApiKey, 'sk-rerank-plain-test');
    assert.equal(isEncrypted(storedSetting.apiKey), false);

    const added = await prisma.aiModel.create({
      data: { provider: 'openai', label: '明文模型测试', model: 'plain-model', apiKey: 'sk-model-plain-test' },
    });
    modelId = added.id;

    // 新写路径（凭证表）同样只存明文——沿用 2026-08-05 的明文化决定，不因为换了张表就变。
    await __wipeAiV2();
    await configurePurpose('chat', {
      label: 'V2 明文测试', provider: 'openai', baseUrl: 'https://example.invalid/v1',
      model: 'v2-plain', apiKey: 'sk-v2-plain-test',
    });
    const cred = await prisma.aiCredential.findFirstOrThrow();
    assert.equal(cred.apiKey, 'sk-v2-plain-test');
    assert.equal(isEncrypted(cred.apiKey), false);

    // 模拟升级前的存量密文。运行时先能兼容读取，再由部署迁移批量改为明文。
    await prisma.aiSetting.update({
      where: { id: 'default' },
      data: {
        apiKey: encryptSecret('sk-main-legacy'),
        embeddingApiKey: encryptSecret('sk-embedding-legacy'),
        rerankApiKey: encryptSecret('sk-rerank-legacy'),
      },
    });
    await prisma.aiModel.update({
      where: { id: modelId },
      data: { apiKey: encryptSecret('sk-model-legacy') },
    });
    // 这一段验的是「旧表里的历史密文仍读得出来」，而 V2 已是默认读路径——
    // 必须显式走 AI_CONFIG_V2=false 这个应急开关，否则读到的是新表，测了个寂寞。
    process.env.AI_CONFIG_V2 = 'false';
    const legacyReadable = await getAiConfig(true);
    assert.equal(legacyReadable.apiKey, 'sk-main-legacy');
    assert.equal(legacyReadable.embeddingApiKey, 'sk-embedding-legacy');
    assert.equal(legacyReadable.rerankApiKey, 'sk-rerank-legacy');
    assert.equal(legacyReadable.keyDecryptFailed, false);

    process.env.APP_ENCRYPTION_KEY = 'wrong-ai-credential-storage-test-master';
    await assert.rejects(
      migrateAiCredentialsToPlaintext(),
      /authenticate|decrypt|Unsupported state/i,
      '错钥必须在事务前失败',
    );
    const untouched = await prisma.aiSetting.findUniqueOrThrow({ where: { id: 'default' } });
    assert.equal(isEncrypted(untouched.apiKey), true, '失败后不能留下半迁移字段');
    assert.equal(isEncrypted(untouched.embeddingApiKey), true);
    assert.equal(isEncrypted(untouched.rerankApiKey), true);
    assert.equal(
      isEncrypted((await prisma.aiModel.findUniqueOrThrow({ where: { id: modelId } })).apiKey),
      true,
    );
    process.env.APP_ENCRYPTION_KEY = testMaster;

    const migrated = await migrateAiCredentialsToPlaintext();
    assert.deepEqual(migrated, { settingRows: 1, modelRows: 1, fields: 4 });
    const migratedSetting = await prisma.aiSetting.findUniqueOrThrow({ where: { id: 'default' } });
    const migratedModel = await prisma.aiModel.findUniqueOrThrow({ where: { id: modelId } });
    assert.equal(migratedSetting.apiKey, 'sk-main-legacy');
    assert.equal(migratedSetting.embeddingApiKey, 'sk-embedding-legacy');
    assert.equal(migratedSetting.rerankApiKey, 'sk-rerank-legacy');
    assert.equal(migratedModel.apiKey, 'sk-model-legacy');
    assert.deepEqual(
      await migrateAiCredentialsToPlaintext(),
      { settingRows: 0, modelRows: 0, fields: 0 },
      '重复迁移必须幂等',
    );
  } finally {
    delete process.env.AI_CONFIG_V2;
    await __wipeAiV2();
    if (modelId) await prisma.aiModel.deleteMany({ where: { id: modelId } });
    if (originalSetting) {
      const { id, updatedAt: _updatedAt, ...data } = originalSetting;
      await prisma.aiSetting.upsert({ where: { id }, update: data, create: { id, ...data } });
    } else {
      await prisma.aiSetting.deleteMany({ where: { id: 'default' } });
    }
    if (previousMaster === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousMaster;
  }
});
