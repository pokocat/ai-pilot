// 把历史 enc:v1 AI 模型凭证一次性改为明文。
// 只处理 AiSetting / AiModel；Agent、Dify、Skill、告警等其它 secretBox 字段不在本决策范围。

import { prisma } from '../db.js';
import { isEncrypted } from './secretBox.js';
import { plainAiCredential } from './aiCredentialStorage.js';

export interface AiCredentialMigrationResult {
  settingRows: number;
  modelRows: number;
  fields: number;
}

export async function migrateAiCredentialsToPlaintext(): Promise<AiCredentialMigrationResult> {
  const setting = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
  const models = await prisma.aiModel.findMany({ select: { id: true, apiKey: true } });
  const operations: Array<ReturnType<typeof prisma.aiSetting.update> | ReturnType<typeof prisma.aiModel.update>> = [];
  let settingRows = 0;
  let modelRows = 0;
  let fields = 0;

  if (setting) {
    const data: Record<string, string> = {};
    for (const key of ['apiKey', 'embeddingApiKey', 'rerankApiKey'] as const) {
      if (!isEncrypted(setting[key])) continue;
      // 所有值在开启事务前先完成解密：主密钥错误时 fail-closed，不留下半迁移状态。
      data[key] = plainAiCredential(setting[key]);
      fields += 1;
    }
    if (Object.keys(data).length) {
      operations.push(prisma.aiSetting.update({ where: { id: setting.id }, data }));
      settingRows = 1;
    }
  }

  for (const model of models) {
    if (!isEncrypted(model.apiKey)) continue;
    const apiKey = plainAiCredential(model.apiKey);
    operations.push(prisma.aiModel.update({ where: { id: model.id }, data: { apiKey } }));
    modelRows += 1;
    fields += 1;
  }

  if (operations.length) await prisma.$transaction(operations);
  return { settingRows, modelRows, fields };
}
