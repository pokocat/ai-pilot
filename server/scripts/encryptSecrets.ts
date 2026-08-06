// 存量业务密钥回填加密：把历史明文敏感字段就地加密（AES-256-GCM）。
// 用法：先在 server/.env 配 APP_ENCRYPTION_KEY，再 `npx tsx scripts/encryptSecrets.ts`。
// 幂等：已加密的字段（带 enc:v1: 前缀）跳过；可安全重复执行。
//
// 覆盖字段：
//   Agent.{apiKey, difyApiKey}
//   SkillTool.headersJson（逐值加密）
//
// 注意：AiSetting / AiModel 的模型、Embedding、Rerank 凭证按 2026-08-05 产品决策改为
// 明文存库，不在本脚本范围；历史密文用 `npm run secrets:decrypt-ai` 迁移。

import { prisma } from '../src/db.js';
import { encryptSecret, isEncrypted, encryptionEnabled } from '../src/services/secretBox.js';

function encField(v: string | null | undefined): string | null {
  if (!v) return v ?? null; // 空值不动
  if (isEncrypted(v)) return null; // 已加密 → 返回 null 表示无需更新
  return encryptSecret(v);
}

async function main() {
  if (!encryptionEnabled()) {
    console.error('✗ APP_ENCRYPTION_KEY 未配置，无法加密。请先在环境变量里设置后再运行。');
    process.exit(1);
  }
  let changed = 0;

  // Agent
  for (const ag of await prisma.agent.findMany()) {
    const upd: Record<string, string> = {};
    const a = encField(ag.apiKey); if (a !== null) upd.apiKey = a;
    const d = encField(ag.difyApiKey); if (d !== null) upd.difyApiKey = d;
    if (Object.keys(upd).length) { await prisma.agent.update({ where: { id: ag.id }, data: upd }); changed++; }
  }

  // SkillTool.headersJson（逐值）
  for (const t of await prisma.skillTool.findMany()) {
    const h = (t.headersJson as Record<string, unknown> | null) ?? {};
    const out: Record<string, string> = {};
    let dirty = false;
    for (const [k, v] of Object.entries(h)) {
      if (typeof v !== 'string') continue;
      if (isEncrypted(v)) { out[k] = v; continue; }
      out[k] = encryptSecret(v); dirty = true;
    }
    if (dirty) { await prisma.skillTool.update({ where: { id: t.id }, data: { headersJson: out } }); changed++; }
  }

  console.log(`✓ 回填完成，更新 ${changed} 行（已加密的字段已跳过）。`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('回填失败：', e);
  await prisma.$disconnect();
  process.exit(1);
});
