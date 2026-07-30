// 幂等把「成品图版式推荐」段落追加到库内 poster 智能体的提示词末尾（海报成品图 canvas_design 上线前置动作）。
//
//   npx tsx scripts/upgradePosterPrompt.ts            # 默认 dry-run：只打印将要发生的变更
//   npm run db:upgrade-poster-prompt -- --apply       # 真写库
//
// ── 为什么是「追加」而不是「同步」──
// 提示词是运营在后台逐版调教出来的资产，仓库文件只是旧快照（见 scripts/syncAdminContent.ts 文件头的
// 漂移记录：general 线上 49,094 字符 vs 仓库 17,230）。所以这里绝不整段覆盖，只做两件事：
//   ① 库内已含本段（按 MARKER 判重）→ 什么都不做；
//   ② 不含 → 把段落 append 到末尾（旧版本 MARKER 的残段先剔除，避免叠加多份）。
//
// ── 改哪几处 ──
// 运行时读的是 AgentVersion 的**已发布快照**（resolveEffectiveAgent），所以只改 Agent.systemPrompt
// 不会立刻生效。本脚本同时处理：
//   · Agent.systemPrompt（草稿）——运营下次发布会带上；
//   · Agent.publishedVersionId 指向的 AgentVersion.systemPrompt——让 C 端立即生效；
//   · 并把 Agent.draftDirty 保持原样（不谎报「草稿有未发布改动」，因为两边都改了）。
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';
import {
  POSTER_TEMPLATE_BLOCK,
  POSTER_TEMPLATE_BLOCK_MARKER,
  POSTER_TEMPLATE_BLOCK_MARKER_RE,
} from '../src/data/agents.js';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');
const AGENT_KEY = 'poster';

/** 纯函数（便于回归）：返回升级后的提示词，已是最新版则回 null。 */
export function upgradePrompt(current: string | null | undefined): string | null {
  const text = current ?? '';
  if (text.includes(POSTER_TEMPLATE_BLOCK_MARKER)) return null; // 已是本版，幂等退出
  // 剔除旧版本残段（含其前后空行），再追加新段——多次升级不会叠出好几份说明。
  const cleaned = text.replace(POSTER_TEMPLATE_BLOCK_MARKER_RE, '').trimEnd();
  return cleaned + POSTER_TEMPLATE_BLOCK;
}

function preview(label: string, before: string, after: string): void {
  console.log(`  ${label}：${before.length} → ${after.length} 字符（+${after.length - before.length}）`);
  const addedFrom = Math.max(0, before.replace(POSTER_TEMPLATE_BLOCK_MARKER_RE, '').trimEnd().length);
  const added = after.slice(addedFrom);
  console.log('  ── 追加内容 ──');
  for (const line of added.split('\n')) if (line.trim()) console.log(`  + ${line}`);
}

async function main() {
  console.log(`🔄 升级 poster 提示词（追加「成品图版式推荐」段）${apply ? '' : ' [dry-run，不写库]'}…`);
  const agent = await prisma.agent.findUnique({
    where: { key: AGENT_KEY },
    select: { key: true, name: true, systemPrompt: true, publishedVersionId: true },
  });
  if (!agent) {
    console.log(`  ⚠ 库里没有 ${AGENT_KEY} 智能体（新环境请先跑 npm run db:seed）`);
    return;
  }

  let changed = 0;

  // ① 草稿（Agent.systemPrompt）
  const nextDraft = upgradePrompt(agent.systemPrompt);
  if (!nextDraft) {
    console.log('  = 草稿已含本段，无需改动');
  } else {
    preview('草稿 Agent.systemPrompt', agent.systemPrompt ?? '', nextDraft);
    if (apply) await prisma.agent.update({ where: { key: AGENT_KEY }, data: { systemPrompt: nextDraft } });
    changed += 1;
  }

  // ② 已发布版本（C 端实际读的那份）
  if (!agent.publishedVersionId) {
    console.log('  ⚠ 该 agent 没有已发布版本：C 端读 Agent 行兜底，草稿改动即生效');
  } else {
    const version = await prisma.agentVersion.findUnique({
      where: { id: agent.publishedVersionId },
      select: { id: true, version: true, systemPrompt: true },
    });
    if (!version) {
      console.log(`  ⚠ publishedVersionId=${agent.publishedVersionId} 指向的版本不存在（数据异常，请人工核对）`);
    } else {
      const nextPublished = upgradePrompt(version.systemPrompt);
      if (!nextPublished) {
        console.log(`  = 已发布版本 v${version.version} 已含本段，无需改动`);
      } else {
        preview(`已发布版本 v${version.version}`, version.systemPrompt ?? '', nextPublished);
        if (apply) await prisma.agentVersion.update({ where: { id: version.id }, data: { systemPrompt: nextPublished } });
        changed += 1;
      }
    }
  }

  if (!changed) console.log('✅ 已是最新，未做任何改动');
  else console.log(apply ? `✅ 完成，改动 ${changed} 处` : `✅ dry-run 完成：将改动 ${changed} 处（加 --apply 才写库）`);
}

// 只在直接执行时跑（对齐 scripts/syncAdminContent.ts）：测试要 import upgradePrompt 这个纯函数，
// 不能因为 import 就顺手连库改提示词。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
}
