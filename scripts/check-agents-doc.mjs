#!/usr/bin/env node
// AGENTS.md 膨胀防线（2026-09-09）。
//
// 背景：AGENTS.md 曾长到 379 KB / 1048 行，每个新会话整份加载。各章正文已拆进 docs/agents/ 分册，
// 本脚本把「入口文件只放规则 + 骨架 + 索引」这条约定变成机器可判的闸门：
//   - 总体量 / 行数 / 单节体量 / 单行长度有硬上限；
//   - 顶层章节骨架固定（不许悄悄加 §15）；
//   - 禁止出现只属于 CHANGELOG / 13-todo 的内容形态（部署基线、NRestarts、Notion 待补、TODO 复选框）；
//   - 附录 A 的索引必须与 docs/agents/ 目录一一对应，且每本分册保留它的 `## N.` 锚点。
//
// 用法：
//   node scripts/check-agents-doc.mjs           # 直接检查，失败退出码 1
//   node scripts/check-agents-doc.mjs --hook    # Claude Code PostToolUse 钩子：stdin 读工具入参，只在改的是 AGENTS.md 时检查，失败退出码 2
//   app/scripts/agents-doc.test.mjs 把同一份检查挂进 `npm test`（CI frontend-unit 覆盖）。
//
// 调上限之前先问：这条内容是不是应该去分册 / CHANGELOG？上限是为了逼这个问题被问出来，不是为了被调大。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LIMITS = Object.freeze({
  totalBytes: 40 * 1024,        // 整文件
  totalLines: 320,
  sectionBytes: 6 * 1024,       // 每个 `## ` 节（§0 例外见下）
  section0Bytes: 9 * 1024,      // §0 规则表允许略大
  lineChars: 1400,              // 单行（一条铁律再长也该拆成分册里的小节）
  dateTokens: 24,               // `2026-MM-DD` 形态的日期：事故/拍板日期可以写，基线流水不行
});

// 顶层章节骨架。新增章节 = 改这里 + 改附录 A + 在 CHANGELOG 说明为什么，缺一即红。
export const HEADINGS = Object.freeze([
  '## 0. ', '## 1. ', '## 2. ', '## 3. ', '## 4. ', '## 5. ', '## 6. ', '## 7. ', '## 8. ',
  '## 9. ', '## 10. ', '## 11. ', '## 12. ', '## 13. ', '## 14. ', '## 附录 A', '## 附录 B',
]);

// 这些形态只属于 docs/CHANGELOG.md、docs/WEAPP_RELEASES.md 或 docs/agents/13-todo.md。
export const FORBIDDEN = Object.freeze([
  { re: /预发基线|生产基线|当前基线|当前预发|当前生产为/u, why: '部署/预发基线只进 docs/CHANGELOG.md' },
  { re: /NRestarts|active\/running/u, why: '服务运行态快照只进 docs/CHANGELOG.md' },
  { re: /Notion[^\n]{0,24}待补|待补[^\n]{0,12}Notion/u, why: 'Notion 待补项只进 docs/agents/13-todo.md' },
  { re: /^\s*- \[[ x]\]/mu, why: 'TODO 复选框只进 docs/agents/13-todo.md' },
  { re: /\b[0-9a-f]{7,8}\b(?=[^\n]{0,12}(已上线|已部署|已发布|上传|预发|生产))/u, why: '提交 SHA 只进 docs/CHANGELOG.md' },
  { re: /^\s*[-*] \*\*[^*\n]{0,40}（20\d\d-\d\d-\d\d[^）\n]{0,40}）\*\*：/mu, why: '「**标题（日期）**：正文」是分册账本的条目形态，入口文件只写规则；把它放进 docs/agents/ 对应小节' },
]);

function sizeOf(s) { return Buffer.byteLength(s, 'utf8'); }

export function checkAgentsDoc(root = ROOT) {
  const problems = [];
  const file = path.join(root, 'AGENTS.md');
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');

  // 1. 总体量
  const bytes = sizeOf(text);
  if (bytes > LIMITS.totalBytes) problems.push(`AGENTS.md ${bytes} 字节 > 上限 ${LIMITS.totalBytes}（把新增内容挪到 docs/agents/ 对应分册，本文只留一句规则 + 链接）`);
  if (lines.length > LIMITS.totalLines) problems.push(`AGENTS.md ${lines.length} 行 > 上限 ${LIMITS.totalLines}`);

  // 2. 单行长度
  lines.forEach((l, i) => {
    if (l.length > LIMITS.lineChars) problems.push(`第 ${i + 1} 行 ${l.length} 字 > 上限 ${LIMITS.lineChars}（一条规则写不进一行半，说明它是分册小节，不是入口铁律）`);
  });

  // 3. 章节骨架 + 单节体量
  const heads = [];
  lines.forEach((l, i) => { if (l.startsWith('## ')) heads.push({ i, l }); });
  const seen = heads.map(h => HEADINGS.find(p => h.l.startsWith(p)) ?? null);
  heads.forEach((h, k) => { if (!seen[k]) problems.push(`第 ${h.i + 1} 行出现骨架之外的顶层章节「${h.l}」；新增章节要同时改 scripts/check-agents-doc.mjs 的 HEADINGS 与附录 A`); });
  HEADINGS.forEach(p => { if (!seen.includes(p)) problems.push(`缺少顶层章节「${p}…」`); });
  heads.forEach((h, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
    const secBytes = sizeOf(lines.slice(h.i, end).join('\n'));
    const cap = h.l.startsWith('## 0. ') ? LIMITS.section0Bytes : LIMITS.sectionBytes;
    if (secBytes > cap) problems.push(`章节「${h.l.slice(0, 24)}…」${secBytes} 字节 > 上限 ${cap}（该节只留铁律摘要，正文进分册）`);
  });

  // 4. 禁止形态（§0 是「规则的规则」，它要点名这些形态，所以扫描从 §1 开始）
  const sec1 = heads.find(h => h.l.startsWith('## 1. '));
  const scanFrom = sec1 ? sec1.i : 0;
  const scanned = lines.slice(scanFrom).join('\n');
  for (const f of FORBIDDEN) {
    const m = scanned.match(f.re);
    if (m) {
      const at = scanFrom + scanned.slice(0, m.index).split('\n').length;
      problems.push(`第 ${at} 行命中禁止形态「${m[0].slice(0, 40)}」：${f.why}`);
    }
  }
  const dates = (text.match(/20\d\d-\d\d-\d\d/g) ?? []).length;
  if (dates > LIMITS.dateTokens) problems.push(`日期出现 ${dates} 次 > 上限 ${LIMITS.dateTokens}（入口文件写规则，不写流水）`);

  // 5. 索引 ↔ docs/agents/ 一一对应；分册保留 `## N.` 锚点
  const dir = path.join(root, 'docs', 'agents');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /^\d\d-.*\.md$/.test(f)).sort() : [];
  if (!files.length) problems.push('docs/agents/ 下没有分册');
  for (const f of files) {
    if (!text.includes(`docs/agents/${f}`)) problems.push(`docs/agents/${f} 没有出现在 AGENTS.md 附录 A 的索引里`);
    const n = String(parseInt(f.slice(0, 2), 10));
    const body = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!new RegExp(`^## ${n}\\. `, 'm').test(body)) problems.push(`docs/agents/${f} 丢了顶层锚点「## ${n}. 」——代码注释里的「AGENTS.md §${n}」会失效`);
  }
  for (const m of text.matchAll(/docs\/agents\/(\d\d-[\w.-]+\.md)/g)) {
    if (!files.includes(m[1])) problems.push(`AGENTS.md 引用的 docs/agents/${m[1]} 不存在`);
  }

  return { ok: problems.length === 0, problems, bytes, lines: lines.length };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--hook')) {
    // Claude Code PostToolUse：stdin 是工具调用 JSON；只对 AGENTS.md 的写入做检查。
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
    let target = '';
    try { target = JSON.parse(raw)?.tool_input?.file_path ?? ''; } catch { /* ignore */ }
    if (path.basename(target) !== 'AGENTS.md') process.exit(0);
    const r = checkAgentsDoc();
    if (r.ok) process.exit(0);
    process.stderr.write(`AGENTS.md 膨胀防线未通过（${r.bytes} 字节 / ${r.lines} 行）：\n- ${r.problems.join('\n- ')}\n请把内容挪到 docs/agents/ 对应分册或 docs/CHANGELOG.md，入口文件只留规则 + 链接。\n`);
    process.exit(2);
  }
  const r = checkAgentsDoc();
  if (r.ok) {
    console.log(`AGENTS.md OK：${r.bytes} 字节 / ${r.lines} 行（上限 ${LIMITS.totalBytes} / ${LIMITS.totalLines}）`);
    return;
  }
  console.error(`AGENTS.md 膨胀防线未通过（${r.bytes} 字节 / ${r.lines} 行）：`);
  for (const p of r.problems) console.error(`- ${p}`);
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
