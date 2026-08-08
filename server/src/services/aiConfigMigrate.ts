// 接入配置归一化迁移（重设计三期，2026-08-07）：ai_model + ai_setting → 四张新表。
//
//   cd server && npx tsx scripts/migrateAiConfig.ts            # 预演（只打印，不写库）
//   cd server && npx tsx scripts/migrateAiConfig.ts --apply    # 真正写入
//
// ── 设计要点 ──────────────────────────────────────────────────────────────────
//  ① **幂等**：端点带 `legacyModelId` 唯一键，重跑只更新不重复建；凭证按 apiKey 去重。
//     迁移脚本必须能反复跑——一次跑不完、跑一半失败、迁完又新增了端点，都是常态。
//  ② **只增不删**：旧表一个字段都不动；它们仅保留为切换当天的应急历史快照。
//  ③ **迁移期只标黄不阻断**：vendor 推断不出来时写 `needsReview=true` 但**照样入路由**。
//     若在这里就拦住，chat 路由会被迁成空的——直接把线上 AI 关掉，比 vendor 标错严重得多。
//  ④ **辅助档从 env 收编进库**：`AI_AUX_*` 一直只能改 env + 重启，运营在后台看不见。
//     迁移把它变成 purpose='aux' 的一条路由；env 保留一个版本作兜底，不立刻删。

import { prisma } from '../db.js';
import { readAiCredential } from './aiCredentialStorage.js';
import { inferDialect, dialectById } from '../llm/dialects.js';
import { vendorOf } from '../llm/vendors.js';
import { normalizeThinkingBudget, normalizeThinkingMode } from '../llm/thinking.js';
import type { AiProvider } from '../llm/schema.js';

// 本模块是一次性迁移脚本的实现；CLI 壳在 scripts/migrateAiConfig.ts。
// 正常后台写路径直接操作归一化表（services/aiV2Admin.ts），不再运行投影。
let APPLY = false;
let QUIET = false;
const log = (...a: unknown[]) => { if (!QUIET) console.log(APPLY ? '[apply]' : '[dry-run]', ...a); };

/**
 * 凭证的 vendor 推断，三档（顺序不可换）：
 *   ① 端点已显式固化 dialect / 选过 preset → 直接映射；
 *   ② 按 baseUrl 域名匹配厂商表（qnaigc.com → qiniu）；
 *   ③ 都判不出 → 'custom' + needsReview=true，**标黄但放行**（见文件头 ③）。
 */
function inferVendor(baseUrl: string, preset: string | null): { vendor: string; needsReview: boolean } {
  if (preset) {
    // 预设 id 形如 qiniu / qiniu-anthropic / deepseek-anthropic，取厂商前缀。
    const base = preset.replace(/-(anthropic|openai)$/, '');
    if (base) return { vendor: base, needsReview: false };
  }
  const v = vendorOf(baseUrl);
  if (v) return { vendor: v.id, needsReview: false };
  return { vendor: 'custom', needsReview: true };
}

/** 同一把 key 只建一条凭证：这正是三期要消掉的「key 复制 N 份」。 */
async function upsertCredential(
  apiKey: string, label: string, baseUrl: string, preset: string | null,
): Promise<string> {
  const { vendor, needsReview } = inferVendor(baseUrl, preset);
  const existing = await prisma.aiCredential.findFirst({ where: { apiKey } });
  if (existing) {
    log(`凭证复用：${existing.label}（vendor=${existing.vendor}）`);
    return existing.id;
  }
  const data = { label: `${label} · 凭证`, vendor, apiKey, needsReview };
  log(`凭证新建：${data.label} vendor=${vendor}${needsReview ? '（待运营确认）' : ''}`);
  if (!APPLY) return `dry-${vendor}`;
  const created = await prisma.aiCredential.create({ data });
  return created.id;
}

async function migrateEndpoints(): Promise<Map<string, string>> {
  const rows = await prisma.aiModel.findMany({ orderBy: { createdAt: 'asc' } });
  const byLegacy = new Map<string, string>();

  // 旧行已被删掉的端点必须一并清掉。迁移是「按旧表算出该有什么」，不是「只增不减」——
  // 少了这一步，运营在后台删掉一个模型之后，它仍会留在路由里继续接流量。
  const alive = new Set(rows.map((r) => r.id));
  const orphans = (await prisma.aiEndpoint.findMany({ where: { legacyModelId: { not: null } }, select: { id: true, label: true, legacyModelId: true } }))
    .filter((e) => e.legacyModelId && !alive.has(e.legacyModelId));
  for (const o of orphans) {
    log(`清理孤儿端点（旧行已删）：${o.label}`);
    if (APPLY) await prisma.aiEndpoint.delete({ where: { id: o.id } }).catch(() => {});
  }

  for (const m of rows) {
    const provider = (m.provider as AiProvider) ?? 'mock';
    const apiKey = readAiCredential(m.apiKey);
    const credentialId = provider === 'mock'
      ? await upsertCredential('', '本地模板', '', 'mock')
      : await upsertCredential(apiKey, m.label, m.baseUrl, m.preset);

    // 方言：显式值优先，否则用**全仓唯一**的 inferDialect 兜底并就此固化——
    // 三期起 dialect 是必填，端点不该再靠推断组装请求。
    const dialect = dialectById(m.dialect)?.id ?? inferDialect(provider, m.baseUrl, m.model).id;
    const data = {
      label: m.label,
      credentialId,
      dialect,
      provider,
      baseUrl: m.baseUrl,
      model: m.model,
      temperature: m.temperature,
      thinkingMode: normalizeThinkingMode(m.thinkingMode),
      thinkingBudget: normalizeThinkingBudget(m.thinkingBudget),
      capsJson: (m.capsJson ?? undefined) as object | undefined,
      priceInput: m.priceInput,
      priceOutput: m.priceOutput,
      priceCachedInput: m.priceCachedInput,
      priceCacheWrite: m.priceCacheWrite,
      legacyModelId: m.id,
    };
    log(`端点：${m.label} → dialect=${dialect}`);
    if (!APPLY) { byLegacy.set(m.id, `dry-${m.id}`); continue; }
    const ep = await prisma.aiEndpoint.upsert({
      where: { legacyModelId: m.id },
      update: data,
      create: data,
    });
    byLegacy.set(m.id, ep.id);
  }
  return byLegacy;
}

interface RouteMemberSpec {
  endpointId: string; primary?: boolean; weight?: number; tier?: number; maxConcurrency?: number;
}

async function upsertRoute(
  purpose: string,
  mode: 'single' | 'pool',
  sticky: boolean,
  members: RouteMemberSpec[],
  budget?: Record<string, unknown>,
): Promise<void> {
  log(`路由 ${purpose}：mode=${mode} sticky=${sticky} 成员=${members.length}`);
  if (!APPLY) return;
  const route = await prisma.aiRoute.upsert({
    where: { purpose },
    update: { mode, sticky, ...(budget ? { budgetJson: budget as object } : {}) },
    create: { purpose, mode, sticky, ...(budget ? { budgetJson: budget as object } : {}) },
  });
  // 成员全量重放：迁移是「按旧表算出该有哪些成员」，残留的旧成员必须清掉，
  // 否则重跑会把已经移出池的端点留在路由里。
  await prisma.aiRouteMember.deleteMany({ where: { routeId: route.id } });
  for (const m of members) {
    await prisma.aiRouteMember.create({
      data: {
        routeId: route.id, endpointId: m.endpointId,
        primary: !!m.primary, weight: m.weight ?? 1, tier: m.tier ?? 0, maxConcurrency: m.maxConcurrency ?? 0,
      },
    });
  }
}

export async function migrateAiConfig(opts: { apply?: boolean; quiet?: boolean } = {}): Promise<void> {
  if (opts.apply !== undefined) APPLY = opts.apply;
  if (opts.quiet !== undefined) QUIET = opts.quiet;
  const setting = await prisma.aiSetting.findUnique({ where: { id: 'default' } });
  if (!setting) { console.error('没有 ai_setting 单例，无从迁移'); return; }

  const byLegacy = await migrateEndpoints();
  const models = await prisma.aiModel.findMany();

  // —— chat：activeModelId → primary 成员；池成员按 poolEnabled ——
  const activeId = setting.activeModelId && byLegacy.get(setting.activeModelId);
  const poolRows = models.filter((m) => m.poolEnabled);
  const chatMembers: RouteMemberSpec[] = [
    ...(activeId ? [{ endpointId: activeId, primary: true }] : []),
    ...poolRows
      .filter((m) => byLegacy.get(m.id) && byLegacy.get(m.id) !== activeId)
      .map((m) => ({ endpointId: byLegacy.get(m.id)!, weight: m.weight, tier: m.tier, maxConcurrency: m.maxConcurrency })),
  ];
  if (!chatMembers.length) {
    // 一个成员都没有＝迁完就是空路由＝线上 AI 停摆。宁可不迁，也不能迁出这种结果。
    console.error('⚠ chat 路由算不出任何成员（activeModelId 与池都为空），已跳过——请先在后台指定生效模型');
  } else {
    await upsertRoute('chat', setting.routingMode === 'pool' ? 'pool' : 'single', setting.stickyRouting, chatMembers);
    // 成果与对话共用同一批端点，但预算不同（成果是异步生成，可以给更长时间）。
    await upsertRoute('deliverable', 'single', true, chatMembers.filter((m) => m.primary), { timeoutMs: 300_000 });
  }

  // —— aux：把 AI_AUX_* 从 env 收编进库 ——
  const auxModel = (process.env.AI_AUX_MODEL ?? '').trim();
  if (auxModel && activeId) {
    const auxBase = (process.env.AI_AUX_BASE_URL ?? '').trim();
    const auxKey = (process.env.AI_AUX_API_KEY ?? '').trim();
    const separate = !!auxBase || !!auxKey;
    log(`辅助档：model=${auxModel}${separate ? '（独立账号）' : '（同账号换模型）'}`);
    if (APPLY) {
      const src = await prisma.aiEndpoint.findUnique({ where: { id: activeId } });
      if (src) {
        const credentialId = separate
          ? await upsertCredential(auxKey || (await prisma.aiCredential.findUnique({ where: { id: src.credentialId } }))!.apiKey, '辅助档', auxBase || src.baseUrl, null)
          : src.credentialId;
        const auxEp = await prisma.aiEndpoint.create({
          data: {
            label: `辅助抽取 · ${auxModel}`, credentialId,
            dialect: auxBase ? inferDialect('openai', auxBase, auxModel).id : src.dialect,
            provider: (process.env.AI_AUX_PROVIDER ?? '').trim() || (auxBase ? 'openai' : src.provider),
            baseUrl: auxBase || src.baseUrl, model: auxModel,
            // 抽取要的是稳定可解析的结构，不是文采。
            temperature: Number(process.env.AI_AUX_TEMPERATURE ?? '') || 0,
            thinkingMode: 'disabled', thinkingBudget: 1024,
          },
        });
        await upsertRoute('aux', 'single', true, [{ endpointId: auxEp.id, primary: true }], {
          // 抽取类任务应当快失败：拖长了既占车道又没人等它的结果。
          timeoutMs: Number(process.env.AI_AUX_TIMEOUT_MS ?? '') || 20_000,
          temperature: Number(process.env.AI_AUX_TEMPERATURE ?? '') || 0,
        });
      }
    }
  }

  // —— embedding / rerank：AiSetting 上的散字段 → 两条独立路由 ——
  for (const kind of ['embedding', 'rerank'] as const) {
    const enabled = kind === 'embedding' ? setting.embeddingEnabled : setting.rerankEnabled;
    const model = kind === 'embedding' ? setting.embeddingModel : setting.rerankModel;
    const baseUrl = kind === 'embedding' ? setting.embeddingBaseUrl : setting.rerankBaseUrl;
    const rawKey = kind === 'embedding' ? setting.embeddingApiKey : setting.rerankApiKey;
    if (!enabled || !model) { log(`${kind}：未启用或未配模型，跳过`); continue; }
    const key = readAiCredential(rawKey) || readAiCredential(setting.apiKey);
    const url = baseUrl || setting.baseUrl;
    log(`${kind}：model=${model} baseUrl=${url}`);
    if (!APPLY) continue;
    const credentialId = await upsertCredential(key, kind, url, null);
    const ep = await prisma.aiEndpoint.create({
      data: {
        label: `${kind === 'embedding' ? '向量嵌入' : '重排'} · ${model}`,
        credentialId, dialect: inferDialect('openai', url, model).id, provider: 'openai',
        baseUrl: url, model, thinkingMode: 'disabled',
      },
    });
    await upsertRoute(kind, 'single', true, [{ endpointId: ep.id, primary: true }]);
  }

  log('完成。归一化读路径默认开启；请确认 /admin/ai-v2-status.ready=true。AI_CONFIG_V2=false 只用于短时读取旧表历史快照。');
}
