// 一次性取消 AI 模型凭证存库加密。
//
// 用法：`npm run secrets:decrypt-ai`
// - 幂等：明文字段跳过，可安全重复执行。
// - fail-closed：若仍有 enc:v1 密文但 APP_ENCRYPTION_KEY 缺失/错误，整批不写入并退出 1。
// - 不打印任何凭证，只输出更新行数/字段数。

import 'dotenv/config';
import { prisma } from '../src/db.js';
import { migrateAiCredentialsToPlaintext } from '../src/services/aiCredentialMigration.js';

async function main() {
  const result = await migrateAiCredentialsToPlaintext();
  console.log(
    `✓ AI 模型凭证明文化完成：AiSetting ${result.settingRows} 行，AiModel ${result.modelRows} 行，共 ${result.fields} 个字段。`,
  );
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(`AI 模型凭证明文化失败：${(error as Error).message}`);
  await prisma.$disconnect();
  process.exit(1);
});
