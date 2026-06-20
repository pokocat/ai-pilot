// 存量密钥回填加密：把历史明文密钥字段就地加密（AES-256-GCM）。
// 用法：先在 server/.env 配 APP_ENCRYPTION_KEY，再 `npx tsx scripts/encryptSecrets.ts`。
// 幂等：已加密的字段（带 enc:v1: 前缀）跳过；可安全重复执行。
//
// 覆盖字段：
//   AiSetting.{apiKey, embeddingApiKey, rerankApiKey}
//   AiModel.apiKey
//   Agent.{apiKey, difyApiKey}
//   SkillTool.headersJson（逐值加密）

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

  // AiSetting（单例）
  const setting = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
  if (setting) {
    const upd: Record<string, string> = {};
    const a = encField(setting.apiKey); if (a !== null) upd.apiKey = a;
    const e = encField(setting.embeddingApiKey); if (e !== null) upd.embeddingApiKey = e;
    const r = encField(setting.rerankApiKey); if (r !== null) upd.rerankApiKey = r;
    if (Object.keys(upd).length) { await prisma.aiSetting.update({ where: { id: 'default' }, data: upd }); changed++; }
  }

  // AiModel
  for (const m of await prisma.aiModel.findMany()) {
    const a = encField(m.apiKey);
    if (a !== null) { await prisma.aiModel.update({ where: { id: m.id }, data: { apiKey: a } }); changed++; }
  }

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
