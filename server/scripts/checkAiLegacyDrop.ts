// 「旧列能不能删了」自检（重设计三期收尾，2026-08-07）。
//
//   cd server && npx tsx scripts/checkAiLegacyDrop.ts
//
// 设计稿 §7.3 第 12 条是「观察一个发布周期后删除旧列」。这条待办最容易出的事故不是忘了删，
// 而是**删早了**——V2 还在回落旧路径、或者某个端点根本没迁过去，删完当场停摆。
// 「观察一个发布周期」是时间条件，压不掉；但「能不能删」这件事本身可以变成一次机器检查，
// 而不是靠人凭印象拍板。本脚本回答的就是后者。
//
// 检查通过 ≠ 现在就删；它只是把「时间到了之后要人肉核对的那几条」变成一条命令。

import { prisma } from '../src/db.js';
import { v2Enabled } from '../src/services/aiRoutes.js';

/** 删列之后就再也回不去的那些字段。删之前必须确认它们已经没有唯一信息。 */
export const LEGACY_COLUMNS = {
  ai_setting: ['provider', 'label', 'baseUrl', 'model', 'apiKey', 'temperature', 'thinkingMode', 'thinkingBudget', 'activeModelId', 'routingMode', 'stickyRouting', 'dialect', 'capsJson', 'embeddingEnabled', 'embeddingModel', 'embeddingBaseUrl', 'embeddingApiKey', 'rerankEnabled', 'rerankModel', 'rerankBaseUrl', 'rerankApiKey'],
  ai_model: ['(整张表)'],
};

export interface DropCheck { ok: boolean; label: string; detail: string }

export async function checkLegacyDroppable(): Promise<DropCheck[]> {
  const out: DropCheck[] = [];

  // 归一化表还没建（没跑过 db push）——这正是本脚本第一次被运行时的状态。
  // 不能让它甩一个 Prisma 原始堆栈：那看起来像脚本坏了，而事实是「还没到能删的阶段」。
  try {
    await prisma.aiEndpoint.count();
  } catch {
    return [{
      ok: false,
      label: '归一化表已建好',
      detail: 'ai_endpoint 等表还不存在——请先 prisma db push 并跑 npm run ai:migrate:apply，此时远没到能删旧列的阶段',
    }];
  }

  // ① 读路径确实已经切过去了。没切就删＝直接把 AI 关掉。
  out.push({
    ok: v2Enabled(),
    label: 'AI_CONFIG_V2 已开启',
    detail: v2Enabled() ? '读路径已切到归一化表' : '还没切读路径——此时删旧列会当场停摆',
  });

  // ② 每一行 ai_model 都有对应端点。漏迁的那一行，删表之后就永久丢了。
  const models = await prisma.aiModel.findMany({ select: { id: true, label: true } });
  const migrated = await prisma.aiEndpoint.findMany({ select: { legacyModelId: true } });
  const done = new Set(migrated.map((e) => e.legacyModelId).filter(Boolean));
  const missing = models.filter((m) => !done.has(m.id));
  out.push({
    ok: missing.length === 0,
    label: '所有 ai_model 行都已迁成端点',
    detail: missing.length ? `未迁移：${missing.map((m) => m.label).join('、')}——重跑 npm run ai:migrate:apply` : `${models.length} 行全部有对应端点`,
  });

  // ③ chat 路由有可用成员。这是「AI 还能不能工作」的最低门槛。
  const chat = await prisma.aiRoute.findUnique({ where: { purpose: 'chat' }, include: { members: true } });
  out.push({
    ok: !!chat?.members.length,
    label: 'chat 路由有可用端点',
    detail: chat?.members.length ? `${chat.members.length} 个成员，primary=${chat.members.some((m) => m.primary) ? '有' : '无'}` : 'chat 路由为空',
  });

  // ④ 旧表里开着、但新表里没有对应路由的能力——删了就是静默丢功能。
  const setting = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
  for (const kind of ['embedding', 'rerank'] as const) {
    const enabledOld = kind === 'embedding' ? setting?.embeddingEnabled : setting?.rerankEnabled;
    if (!enabledOld) continue;
    const route = await prisma.aiRoute.findUnique({ where: { purpose: kind }, include: { members: true } });
    out.push({
      ok: !!route?.members.length,
      label: `${kind} 旧配置已开启 → 新表要有对应路由`,
      detail: route?.members.length ? '已迁移' : `旧表开着 ${kind} 但新表没有该路由——删列会静默丢掉这个能力`,
    });
  }

  // ⑤ 没有待确认 vendor 的凭证。删列之后再想按 baseUrl 反推厂商就没有依据了。
  const review = await prisma.aiCredential.count({ where: { needsReview: true } });
  out.push({
    ok: review === 0,
    label: '没有待确认接入商的凭证',
    detail: review ? `${review} 条凭证 vendor='custom' 待运营确认——删旧列后就失去反推依据` : '全部已判定',
  });

  // ⑥ 辅助档：env 还配着但新表没有 aux 路由 → 删列不影响它（它本来就在 env），
  //    但要提醒运营这条路径还没收编，否则会以为「都在后台了」。
  if ((process.env.AI_AUX_MODEL ?? '').trim()) {
    const aux = await prisma.aiRoute.findUnique({ where: { purpose: 'aux' }, include: { members: true } });
    out.push({
      ok: !!aux?.members.length,
      label: '辅助档已从 env 收编进路由',
      detail: aux?.members.length ? '已收编' : 'AI_AUX_MODEL 仍只在 env 里——不影响删列，但运营在后台仍看不见它',
    });
  }

  return out;
}

async function main(): Promise<void> {
  const checks = await checkLegacyDroppable();
  for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.label} —— ${c.detail}`);
  const blocked = checks.filter((c) => !c.ok);
  console.log('');
  if (blocked.length) {
    console.log(`还不能删旧列：${blocked.length} 项未通过。`);
    process.exitCode = 1;
    return;
  }
  console.log('机器可查的条件全部通过。');
  console.log('仍需人工确认：① 已按设计稿观察满一个发布周期；② 期间没有回滚过 AI_CONFIG_V2。');
  console.log('确认后再删这些列（改 prisma/schema.prisma + db push）：');
  for (const [table, cols] of Object.entries(LEGACY_COLUMNS)) console.log(`  ${table}: ${cols.join(', ')}`);
}

const runAsCli = process.argv[1]?.endsWith('checkAiLegacyDrop.ts');
if (runAsCli) {
  main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
}
