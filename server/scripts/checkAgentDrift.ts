// 智能体配置漂移巡检 —— 回答「代码改了、也部署了，线上人格为什么没变」（2026-08-17）。
//
//   cd server && npm run agents:check-drift
//   npm run agents:check-drift -- --all             # 连线上已停用的 agent 一起查
//   npm run agents:check-drift -- --json            # 机器可读（CI / 巡检上报）
//   npm run agents:check-drift -- --fail-on-drift   # 有漂移则 exit 1（默认恒 0，发布流程里不阻断）
//
// ── 为什么需要它 ──
// 运行时读的**不是** src/data/agents.ts，而是 DB 里 `agent.publishedVersionId` 指向的 agent_version
// 快照（services/agentVersions.ts:resolveEffectiveAgent）。而 scripts/deploy-prod.sh 只跑
// `prisma db push`，**从不 seed**。于是「改代码 → 部署」这条路对行为字段是断的：代码进了生产，
// 线上人格纹丝不动，全程没有任何报错——这正是最难自查的一类事故。
//
// 2026-08-16 实际踩坑：海报设计师（key=poster）生产库停在 v2，还是旧的通用商业顾问提示词 +
// `deliverableKey='海报设计'`；而代码 2026-08-13 就已换成专用人格 + `deliverableKey=null`。
// 后果是 services/generationRequest.ts:106-111 的 `isDeliverable` 恒为真，每一轮回复都被强制成
// report 方案卡：用户说「帮我做个营销海报」，回来的是一份带「军师 敬上」的战略报告。
//
// ── 边界：比什么、不比什么 ──
// 比（代码是事实来源，改了就该生效）：systemPrompt / deliverableKey / skillsConfig。
// 不比（**归运营后台所有，代码里的值只是新建初值**）：
//   · 计费：billing / price / billingRatio / meterUnit / gift
//   · 接入：providerMode / apiBaseUrl / apiModel / apiTemperature / apiKey / dify*
//   · 文案：greet / chips / memText / learnText，以及 enabled / sort
// 所以生产 poster 是 free/0/5x、代码写着 unlock/8/1x —— 那是正常的，本脚本一个字都不提。
// 同一约定见 scripts/syncAdminContent.ts 的 OPERATOR_OWNED / AGENT_PRICING_FIELDS。
//
// ── 已知的「永远漂移」例外 ──
// general（总军师）的线上提示词是运营在后台逐版调教出来的长版本，仓库文件只是初始化种子。
// 2026-07-28 复核：线上 49,094 字节 / 19,486 字符，仓库 44,959 字节 / 17,232 字符。它写在
// OPERATOR_MANAGED 白名单里，标注「运营托管，忽略」，不计入漂移数。
//
// ── 长度口径 ──
// 生产库是 SQL_ASCII，psql 的 `length()` 返回的是**字节数**不是字符数；早年把两者混着看，
// 把 +13% 的差异误报成「漂了 2.85 倍」。本脚本在 Node 侧拿 JS 字符串，字符数与字节数**都打**，
// 判等一律以 md5 为准，不看长度。
//
// 只读：全程没有一次写库调用。

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { prisma } from '../src/db.js';
import { AGENTS, type AgentSeed } from '../src/data/agents.js';

// —— 比较范围 ——

/** 代码是事实来源的行为字段。改这里就同时影响比较、输出与 --json 契约。 */
export const BEHAVIOR_FIELDS = ['systemPrompt', 'deliverableKey', 'skillsConfig'] as const;
export type BehaviorField = (typeof BEHAVIOR_FIELDS)[number];

export const FIELD_LABELS: Record<BehaviorField, string> = {
  systemPrompt: '提示词',
  deliverableKey: '产出模板',
  skillsConfig: '技能配置',
};

/**
 * 「运营托管」白名单：命中的字段永远标注为忽略，不计入漂移。
 * 也可用环境变量临时追加，无需改代码：AGENT_DRIFT_IGNORE="general:systemPrompt,poster:skillsConfig"
 */
export const OPERATOR_MANAGED: Record<string, readonly BehaviorField[]> = {
  general: ['systemPrompt'],
};

/**
 * skillsConfig 里**归后台所有**的键。运营在「接入配置」里保存一次，admin.ts:normalizeSkills
 * 就会把整个对象重写成 `{ enabled, tools }` —— 顺手把代码侧的 deliverableMode 丢掉。
 * 所以这里逐键比较：只看代码/库两侧的非后台键（并集），后台键的差异一律不算漂移。
 */
export const OPERATOR_OWNED_SKILL_KEYS = ['enabled', 'tools', 'customTools'] as const;

// —— 纯函数区（不连库，便于回归；见 test/agentDrift.test.ts）——

export interface BehaviorSnapshot {
  systemPrompt: string | null;
  deliverableKey: string | null;
  skillsConfig: unknown;
}

export interface FieldDiff {
  field: BehaviorField;
  same: boolean;
  /** 命中运营托管白名单：差异照实展示，但不计入漂移。 */
  ignored: boolean;
  repo: string;
  db: string;
}

export type DriftStatus = 'ok' | 'drift' | 'missing' | 'db-only';

export interface AgentDriftRow {
  key: string;
  name: string;
  enabled: boolean;
  status: DriftStatus;
  /** 运行时实际读的那一份：'v2' / '草稿（未发布）' / '草稿（指针悬空）' / '—' */
  effective: string;
  publishedAt: string | null;
  fields: FieldDiff[];
  hints: string[];
}

/** 稳定序列化（键排序），对齐 agentVersions.ts 的口径：同配置 = 同字符串。 */
function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

/** 提示词指纹。字符数按码点算（不是 UTF-16 单元），字节数按 UTF-8 算——两个口径都给，判等只看 md5。 */
export function promptStat(s: string | null | undefined): { md5: string; chars: number; bytes: number } {
  const t = s ?? '';
  return {
    md5: createHash('md5').update(t, 'utf8').digest('hex'),
    chars: [...t].length,
    bytes: Buffer.byteLength(t, 'utf8'),
  };
}

function describePrompt(s: string | null | undefined): string {
  const t = s ?? '';
  if (!t) return '空';
  const { md5, chars, bytes } = promptStat(t);
  return `md5 ${md5.slice(0, 8)} · ${chars.toLocaleString('en-US')} 字 / ${bytes.toLocaleString('en-US')} 字节`;
}

/** 运行时按 `!!deliverableKey` 判真假（generationRequest.ts:106），故空串与 null 等价。 */
export function normDeliverableKey(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/** 剥掉 skillsConfig 里归后台所有的键，只留代码该管的部分。 */
export function behaviorSkills(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!(OPERATOR_OWNED_SKILL_KEYS as readonly string[]).includes(k)) out[k] = val;
  }
  return out;
}

function describeSkills(raw: unknown): string {
  const b = behaviorSkills(raw);
  return Object.keys(b).length ? canonical(b) : '空';
}

/** 解析 AGENT_DRIFT_IGNORE="general:systemPrompt,poster:skillsConfig"。非法项静默跳过。 */
export function parseIgnoreSpec(spec: string | undefined): Record<string, BehaviorField[]> {
  const out: Record<string, BehaviorField[]> = {};
  for (const item of (spec ?? '').split(',')) {
    const [key, field] = item.split(':').map((s) => s.trim());
    if (!key || !field) continue;
    if (!(BEHAVIOR_FIELDS as readonly string[]).includes(field)) continue;
    (out[key] ??= []).push(field as BehaviorField);
  }
  return out;
}

/** 合并内置白名单与环境变量追加项。 */
export function resolveIgnore(env: string | undefined = process.env.AGENT_DRIFT_IGNORE): Record<string, BehaviorField[]> {
  const merged: Record<string, BehaviorField[]> = {};
  for (const [k, v] of Object.entries(OPERATOR_MANAGED)) merged[k] = [...v];
  for (const [k, v] of Object.entries(parseIgnoreSpec(env))) merged[k] = [...new Set([...(merged[k] ?? []), ...v])];
  return merged;
}

/** 代码种子 → 行为快照。skillsConfig 未配（undefined）与库里的 null 等价。 */
export function seedSnapshot(a: AgentSeed): BehaviorSnapshot {
  return {
    systemPrompt: a.systemPrompt ?? null,
    deliverableKey: a.deliverableKey ?? null,
    skillsConfig: a.skillsConfig ?? null,
  };
}

/** 逐字段比较。纯函数：给两个快照，回一张字段级 diff。 */
export function compareBehavior(
  agentKey: string,
  repo: BehaviorSnapshot,
  db: BehaviorSnapshot,
  ignore: Record<string, readonly BehaviorField[]> = OPERATOR_MANAGED,
): FieldDiff[] {
  const ignored = new Set(ignore[agentKey] ?? []);
  return BEHAVIOR_FIELDS.map((field): FieldDiff => {
    let same: boolean;
    let repoText: string;
    let dbText: string;
    if (field === 'systemPrompt') {
      same = promptStat(repo.systemPrompt).md5 === promptStat(db.systemPrompt).md5;
      repoText = describePrompt(repo.systemPrompt);
      dbText = describePrompt(db.systemPrompt);
    } else if (field === 'deliverableKey') {
      const r = normDeliverableKey(repo.deliverableKey);
      const d = normDeliverableKey(db.deliverableKey);
      same = r === d;
      repoText = r === null ? '空' : `「${r}」`;
      dbText = d === null ? '空' : `「${d}」`;
    } else {
      same = canonical(behaviorSkills(repo.skillsConfig)) === canonical(behaviorSkills(db.skillsConfig));
      repoText = describeSkills(repo.skillsConfig);
      dbText = describeSkills(db.skillsConfig);
    }
    return { field, same, ignored: ignored.has(field), repo: repoText, db: dbText };
  });
}

/** 有一个「非忽略」的字段不同即判漂移。 */
export function statusOf(fields: FieldDiff[]): 'ok' | 'drift' {
  return fields.some((f) => !f.same && !f.ignored) ? 'drift' : 'ok';
}

// —— 连库巡检 ——

export interface DriftReport {
  checkedAt: string;
  rows: AgentDriftRow[];
  /** 库里有、代码种子里没有的 agent（运营自建），无从比较，只列出来。 */
  dbOnly: Array<{ key: string; name: string; enabled: boolean }>;
  /** 线上已停用、本次未检查的种子 agent。 */
  skipped: string[];
  counts: { ok: number; drift: number; missing: number; ignoredFields: number };
}

export async function collectDrift(opts: { all?: boolean } = {}): Promise<DriftReport> {
  const ignore = resolveIgnore();
  const dbAgents = await prisma.agent.findMany({ orderBy: [{ sort: 'asc' }, { key: 'asc' }] });
  const byKey = new Map(dbAgents.map((a) => [a.key, a]));

  const pubIds = dbAgents.map((a) => a.publishedVersionId).filter((id): id is string => !!id);
  const versions = pubIds.length
    ? await prisma.agentVersion.findMany({ where: { id: { in: pubIds } } })
    : [];
  const byVersionId = new Map(versions.map((v) => [v.id, v]));

  const rows: AgentDriftRow[] = [];
  const skipped: string[] = [];

  for (const seed of AGENTS) {
    const agent = byKey.get(seed.key);
    const repo = seedSnapshot(seed);

    if (!agent) {
      rows.push({
        key: seed.key, name: seed.name, enabled: seed.enabled, status: 'missing',
        effective: '—', publishedAt: null,
        fields: [],
        hints: ['库里根本没有这个 agent。新环境跑 `npm run db:seed`；老环境说明它被删过，需人工确认是否该重建'],
      });
      continue;
    }
    if (!opts.all && !agent.enabled) { skipped.push(seed.key); continue; }

    // 与 resolveEffectiveAgent 同一套解析：已发布版本优先，指针为空/悬空一律回退草稿（Agent 行）。
    const published = agent.publishedVersionId ? byVersionId.get(agent.publishedVersionId) : undefined;
    const usable = published && published.agentKey === agent.key ? published : undefined;
    const effectiveRow: BehaviorSnapshot = usable
      ? { systemPrompt: usable.systemPrompt, deliverableKey: usable.deliverableKey, skillsConfig: usable.skillsConfig }
      : { systemPrompt: agent.systemPrompt, deliverableKey: agent.deliverableKey, skillsConfig: agent.skillsConfig };

    const fields = compareBehavior(seed.key, repo, effectiveRow, ignore);
    const status = statusOf(fields);
    const hints: string[] = [];

    let effective: string;
    if (usable) effective = `v${usable.version}`;
    else if (!agent.publishedVersionId) {
      effective = '草稿（未发布）';
      hints.push('该 agent 从未发布过版本，运行时回退读 Agent 行草稿——此时改库草稿即时生效');
    } else {
      effective = '草稿（指针悬空）';
      hints.push(`publishedVersionId=${agent.publishedVersionId} 指向的版本不存在或跨了 agent（数据异常），运行时已回退草稿`);
    }

    if (status === 'drift') {
      // 修法取决于「库里的草稿」站在哪一边：草稿已对齐代码 → 缺一次发布；草稿也不同 → 运营调教过，别回灌。
      const draft: BehaviorSnapshot = {
        systemPrompt: agent.systemPrompt, deliverableKey: agent.deliverableKey, skillsConfig: agent.skillsConfig,
      };
      const draftDrift = statusOf(compareBehavior(seed.key, repo, draft, ignore));
      hints.push(draftDrift === 'ok'
        ? '库内草稿已与代码一致，只差一次「发布」：运营后台 → 智能体 → 发布（或调用 publishDraft）'
        : '库内草稿也与代码不同（运营在后台调教过）——先在后台逐字段核对，不要拿仓库值直接回灌');

      // normalizeSkills 只保留 enabled/tools，运营存一次接入配置就会把 deliverableMode 冲掉。
      const skillDrift = fields.find((f) => f.field === 'skillsConfig' && !f.same && !f.ignored);
      const dbKeys = Object.keys((effectiveRow.skillsConfig as Record<string, unknown> | null) ?? {});
      if (skillDrift && Object.keys(behaviorSkills(effectiveRow.skillsConfig)).length === 0
        && dbKeys.some((k) => (OPERATOR_OWNED_SKILL_KEYS as readonly string[]).includes(k))) {
        hints.push('库内 skillsConfig 只剩 enabled/tools：运营在后台保存过接入配置，admin.ts:normalizeSkills 会把 deliverableMode 一并丢掉');
      }
    }

    rows.push({
      key: seed.key, name: agent.name, enabled: agent.enabled, status,
      effective, publishedAt: usable?.publishedAt?.toISOString().slice(0, 10) ?? null,
      fields, hints,
    });
  }

  const seedKeys = new Set(AGENTS.map((a) => a.key));
  const dbOnly = dbAgents
    .filter((a) => !seedKeys.has(a.key) && (opts.all || a.enabled))
    .map((a) => ({ key: a.key, name: a.name, enabled: a.enabled }));

  return {
    checkedAt: new Date().toISOString(),
    rows,
    dbOnly,
    skipped,
    counts: {
      ok: rows.filter((r) => r.status === 'ok').length,
      drift: rows.filter((r) => r.status === 'drift').length,
      missing: rows.filter((r) => r.status === 'missing').length,
      ignoredFields: rows.reduce((n, r) => n + r.fields.filter((f) => f.ignored && !f.same).length, 0),
    },
  };
}

// —— 输出 ——

/** 终端列宽：CJK / 全角按 2 列算，否则表头和内容对不齐。 */
function width(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    const wide = (c >= 0x1100 && c <= 0x115f) || c === 0x2329 || c === 0x232a
      || (c >= 0x2e80 && c <= 0xa4cf && c !== 0x303f)
      || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff)
      || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6)
      || (c >= 0x1f300 && c <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
}
/** 定宽单元格：超宽先截断加省略号，保证列永远对齐（运营自建的 agent 名可能很长）。 */
function pad(s: string, n: number): string {
  if (width(s) <= n - 1) return s + ' '.repeat(n - width(s));
  let out = '';
  for (const ch of s) {
    if (width(out) + width(ch) > n - 2) break;
    out += ch;
  }
  return `${out}…${' '.repeat(Math.max(1, n - width(out) - 1))}`;
}

const STATUS_TEXT: Record<DriftStatus, string> = {
  ok: '✓ 一致', drift: '✗ 漂移', missing: '⚠ 库里缺失', 'db-only': '· 库内独有',
};

function maskDbUrl(raw: string | undefined): string {
  if (!raw) return '（未显式设置；Prisma 自行读 server/.env）';
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch { return '（无法解析）'; }
}

export function render(report: DriftReport): string {
  const out: string[] = [];
  out.push('🔎 智能体配置漂移巡检 —— 代码种子（src/data/agents.ts） vs 库内运行时快照');
  out.push(`   DATABASE_URL：${maskDbUrl(process.env.DATABASE_URL)}`);
  out.push(`   比较：${BEHAVIOR_FIELDS.map((f) => `${f}(${FIELD_LABELS[f]})`).join(' · ')}`);
  out.push('   不比较：billing/price/billingRatio/meterUnit/gift、provider* 接入字段、greet/chips/memText/learnText —— 归运营后台所有');
  out.push('');

  const cols = { key: 12, name: 16, eff: 18, status: 12 };
  out.push([pad('key', cols.key), pad('名称', cols.name), pad('运行时读', cols.eff), pad('状态', cols.status), '差异字段'].join(''));
  out.push('─'.repeat(96));

  for (const r of report.rows) {
    const marks = r.fields
      .filter((f) => !f.same)
      .map((f) => (f.ignored ? `${f.field}（运营托管，忽略）` : f.field));
    const eff = r.publishedAt ? `${r.effective} · ${r.publishedAt}` : r.effective;
    out.push([
      pad(r.key, cols.key), pad(r.name, cols.name), pad(eff, cols.eff),
      pad(STATUS_TEXT[r.status], cols.status), marks.join(' · ') || '—',
    ].join(''));
  }
  for (const d of report.dbOnly) {
    out.push([
      pad(d.key, cols.key), pad(d.name, cols.name), pad('—', cols.eff),
      pad(STATUS_TEXT['db-only'], cols.status), '运营自建，代码里没有种子，无从比较',
    ].join(''));
  }

  const drifted = report.rows.filter((r) => r.status === 'drift' || r.status === 'missing');
  if (drifted.length) {
    out.push('');
    out.push('── 详情 ──');
    for (const r of drifted) {
      out.push('');
      out.push(`▶ ${r.key} ${r.name}（运行时读：${r.effective}${r.publishedAt ? ` · 发布于 ${r.publishedAt}` : ''}）`);
      for (const f of r.fields) {
        if (f.same) continue;
        const tag = f.ignored ? '（运营托管，忽略）' : '';
        out.push(`   ${f.field}（${FIELD_LABELS[f.field]}）${tag}`);
        out.push(`     代码：${f.repo}`);
        out.push(`     库内：${f.db}`);
      }
      for (const h of r.hints) out.push(`   ↳ ${h}`);
    }
  }

  out.push('');
  const { ok, drift, missing, ignoredFields } = report.counts;
  out.push(`合计：一致 ${ok} · 漂移 ${drift} · 库里缺失 ${missing}`
    + (ignoredFields ? ` · 运营托管忽略 ${ignoredFields} 个字段` : '')
    + (report.skipped.length ? ` · 线上已停用未检查 ${report.skipped.length}（${report.skipped.join('、')}；加 --all 一并查）` : ''));
  if (drift || missing) {
    out.push('');
    out.push('⚠ 有漂移：`prisma db push` 不会同步行为字段，部署代码≠线上生效。');
    out.push('  修法（按上面每行的 ↳ 提示选）：运营后台改完点「发布」，或写一次性脚本改 agent + 当前已发布 agent_version');
    out.push('  （参照 scripts/upgradePosterPrompt.ts 的两处同改：Agent 草稿 + publishedVersionId 指向的快照）。');
    out.push('  ⚠️ 别用 `npm run db:seed`（破坏性重建），也别拿 --force-prompts 回灌——线上提示词多半是运营调教过的。');
  } else {
    out.push('✅ 行为字段与代码一致，线上跑的就是仓库里这一版。');
  }
  return out.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const report = await collectDrift({ all: argv.includes('--all') });
  console.log(argv.includes('--json') ? JSON.stringify(report, null, 2) : render(report));
  if (argv.includes('--fail-on-drift') && (report.counts.drift || report.counts.missing)) process.exit(1);
}

// 只在直接执行时连库（对齐 upgradePosterPrompt.ts）：测试要 import 上面的纯函数，
// 不能因为一次 import 就顺手连生产库。
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .catch((e) => { console.error(`巡检失败：${(e as Error).message}`); process.exitCode = 1; })
    .finally(async () => { await prisma.$disconnect(); });
}
