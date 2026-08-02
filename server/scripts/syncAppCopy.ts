// 把服务端 seed 中本批次的公开文案同步到 app 的 mock / 离线镜像。
//
// 用法：
//   npm run copy:sync             # 只更新 greet / memText / learnText 与 REPLIES['默认']
//   npm run copy:sync -- --check  # 只检查；不一致时返回非零，适合 CI
//
// 保护边界：本脚本刻意不处理完整公开对象。agent 的 enabled / owned / gift / billing / price /
// deliverableKey 等行为字段，以及 DELIVERABLES 全表，仍不在本脚本守卫范围内。存量镜像在这些字段
// 上有产品层面的有意差异，文案同步不得顺手拉齐。
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { AGENTS } from '../src/data/agents.js';
import { REPLIES } from '../src/data/deliverables.js';

const COPY_FIELDS = ['greet', 'memText', 'learnText'] as const;
type CopyField = (typeof COPY_FIELDS)[number];
type AgentCopy = { key: string } & Record<CopyField, string> & Record<string, unknown>;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../..');
const AGENT_MIRROR = path.join(REPO_ROOT, 'app/src/data/agents.ts');
const DELIVERABLE_MIRROR = path.join(REPO_ROOT, 'app/src/data/deliverables.ts');

export function updateAgentMirrorSource(source: string): string {
  const pattern = /(const RAW_AGENTS:[^=]+?= )(\[[\s\S]*?\n\]);/;
  const match = source.match(pattern);
  if (!match) throw new Error('找不到 RAW_AGENTS JSON 镜像');
  const current = JSON.parse(match[2]) as AgentCopy[];
  const byKey = new Map(AGENTS.map((agent) => [agent.key, agent]));
  const seen = new Set<string>();
  const next = current.map((row) => {
    const seed = byKey.get(row.key);
    if (!seed) throw new Error(`前端镜像存在服务端未登记的 agent：${row.key}`);
    seen.add(row.key);
    return { ...row, greet: seed.greet, memText: seed.memText, learnText: seed.learnText };
  });
  const missing = AGENTS.map((agent) => agent.key).filter((key) => !seen.has(key));
  if (missing.length) throw new Error(`前端镜像缺少 agent：${missing.join(', ')}`);
  // 用替换函数而不是替换串：文案由运营持续编辑，串里的 `$&`/`$'`/`$1` 会被 String.replace
  // 当成替换模式解释，静默写坏镜像。
  return source.replace(pattern, (_match, head: string) => `${head}${JSON.stringify(next, null, 2)};`);
}

export function updateDeliverableMirrorSource(source: string): string {
  const pattern = /(export const REPLIES:[^=]+?= )(\{[\s\S]*?\n\});/;
  const match = source.match(pattern);
  if (!match) throw new Error('找不到 REPLIES JSON 镜像');
  const current = JSON.parse(match[2]) as Record<string, unknown>;
  // 右值为 undefined 时 JSON.stringify 会直接丢键，mock 的默认回复会静默消失。
  if (!REPLIES['默认']) throw new Error("服务端 REPLIES['默认'] 缺失，拒绝写空镜像");
  const next = { ...current, 默认: REPLIES['默认'] };
  return source.replace(pattern, (_match, head: string) => `${head}${JSON.stringify(next, null, 2)};`);
}

export async function syncAppCopy(opts: { check?: boolean } = {}): Promise<{ changed: string[] }> {
  const [agentSource, deliverableSource] = await Promise.all([
    readFile(AGENT_MIRROR, 'utf8'),
    readFile(DELIVERABLE_MIRROR, 'utf8'),
  ]);
  const nextAgent = updateAgentMirrorSource(agentSource);
  const nextDeliverable = updateDeliverableMirrorSource(deliverableSource);
  const changed = [
    ...(nextAgent === agentSource ? [] : ['app/src/data/agents.ts']),
    ...(nextDeliverable === deliverableSource ? [] : ['app/src/data/deliverables.ts']),
  ];

  if (opts.check) {
    if (changed.length) throw Object.assign(new Error(`文案镜像未同步：${changed.join(', ')}`), { code: 'COPY_MIRROR_DRIFT' });
    return { changed };
  }
  await Promise.all([
    nextAgent === agentSource ? Promise.resolve() : writeFile(AGENT_MIRROR, nextAgent, 'utf8'),
    nextDeliverable === deliverableSource ? Promise.resolve() : writeFile(DELIVERABLE_MIRROR, nextDeliverable, 'utf8'),
  ]);
  return { changed };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.some((arg) => arg !== '--check' && arg !== '--help')) {
    throw new Error('用法：npm run copy:sync [-- --check]');
  }
  if (argv.includes('--help')) {
    console.log('用法：npm run copy:sync [-- --check]');
    console.log("范围：仅 agent greet/memText/learnText 与 REPLIES['默认']；不保护行为字段或 DELIVERABLES 全表。");
    return;
  }
  const result = await syncAppCopy({ check: argv.includes('--check') });
  console.log(result.changed.length ? `已同步：${result.changed.join(', ')}` : '文案镜像已一致');
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch((error) => {
    console.error((error as Error).message);
    process.exitCode = 1;
  });
}
