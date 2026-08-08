// 接入配置归一化迁移的 CLI 壳（重设计三期，2026-08-07）。
//
//   cd server && npm run ai:migrate         # 预演（只打印，不写库）
//   cd server && npm run ai:migrate:apply   # 真正写入
//
// 迁移体在 `src/services/aiConfigMigrate.ts`——它同时是运行时的投影函数
// （切到 V2 后后台每次写配置都要调），所以必须待在 src 里，不能只当脚本。
import { prisma } from '../src/db.js';
import { migrateAiConfig } from '../src/services/aiConfigMigrate.js';

migrateAiConfig({ apply: process.argv.includes('--apply') })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
