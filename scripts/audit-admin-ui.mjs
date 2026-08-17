#!/usr/bin/env node
// 运营后台设计系统合规扫描（admin design-system linter）。
// 约束「军师运营后台」的所有前端变更对齐 admin/DESIGN.md：
//   1) 不得使用未在 admin.css 定义的 class（如曾经的裸 `gh`）——会退化成无样式原生控件；
//   2) .tsx 内联样式里不得出现硬编码颜色（#hex / rgb()）——必须走 CSS 变量 token；
//   3) <button>/<input>/<select> 不得带一次性 inline style（width/padding/color/border 等）——用组件类；
//   4) admin.css 里（:root 之外）不得把某个 token 的颜色值硬编码（如 #2D7A52 应写 var(--success)）。
// 用法：node scripts/audit-admin-ui.mjs   （CI / 提交前跑；有违规则 exit 1）
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CSS = path.join(ROOT, 'admin/src/styles/admin.css');
// 递归扫 admin/src 下所有 .tsx（旧版是 6 个文件的硬编码清单，新增文件会静默逃过合规检查——
// 拆分 App.tsx 成 views/ 后必须按目录扫，否则新页面可以随便写裸 class 和硬编码颜色）。
function collectTsx(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectTsx(p));
    else if (e.name.endsWith('.tsx') && !e.name.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}
const TSX = collectTsx(path.join(ROOT, 'admin/src')).sort();

const css = fs.readFileSync(CSS, 'utf8');
const cssClasses = new Set([...css.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]));
// :root token 值 → 变量名（用于「裸色应写 var()」检查）
const root = (css.match(/:root\s*\{([\s\S]*?)\}/) || [, ''])[1];
const tokenByValue = new Map();
for (const m of root.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})/g)) tokenByValue.set(m[2].toLowerCase(), m[1]);
const ALLOW_HEX = new Set(['#fff', '#ffffff', '#000', '#000000']); // 纯黑白允许直写

const violations = [];
// 相对路径而非 basename：views/ 下会出现同名文件，basename 无法定位。
const add = (file, line, msg) => violations.push(`${path.relative(ROOT, file)}:${line}  ${msg}`);

// —— .tsx 扫描 ——
for (const f of TSX) {
  fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    const ln = i + 1;
    // 1) className：抓取并校验每个 class token 是否有 CSS 规则
    for (const m of line.matchAll(/className=(?:"([^"]*)"|\{([^}]*(?:\{[^{}]*\}[^}]*)*)\})/g)) {
      let tokens = [];
      if (m[1] != null) tokens = m[1].split(/\s+/).map((t) => [t, true]);
      else {
        const expr = m[2] || '';
        for (const t of expr.matchAll(/`([^`]*)`/g)) for (const w of t[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) tokens.push([w, true]);
        for (const q of expr.matchAll(/(['"])(.*?)\1/g)) {
          const before = expr.slice(0, q.index).replace(/\s+$/, '');
          const isCompare = /[=!]={1,2}$/.test(before); // x === 'image' 里的 'image' 是比较值，不是 class
          if (!isCompare) for (const w of q[2].split(/\s+/)) tokens.push([w, true]);
        }
      }
      for (const [tok] of tokens) if (tok && !cssClasses.has(tok)) add(f, ln, `未定义 class「${tok}」（admin.css 无规则 → 无样式）`);
    }
    // 2) inline style 里的硬编码颜色
    if (/style=\{\{/.test(line)) {
      for (const h of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) if (!ALLOW_HEX.has(h[0].toLowerCase())) add(f, ln, `inline 硬编码颜色 ${h[0]} → 改用 var(--token)`);
      if (/rgba?\(/.test(line) && /(color|background|border)/i.test(line)) add(f, ln, `inline 颜色用了 rgb()/rgba() → 改用 var(--token)`);
    }
    // 3) 表单控件带一次性 inline style
    if (/<(button|input|select)[^>]*style=\{\{/.test(line)) add(f, ln, `<${RegExp.$1}> 带一次性 inline style → 用组件类/修饰类（见 DESIGN.md）`);
    // 4) 开关必须走共享 Switch（button + role=switch），禁止鼠标专用的 div.sw 回流。
    if (/<div[^>]*className=.*\bsw\b/.test(line)) add(f, ln, `div.sw 只有鼠标能操作 → 使用 components.tsx 的 Switch`);
    // 5) 取数失败不得吞掉并伪装成空态。
    const trimmed = line.trim();
    if (!trimmed.startsWith('//') && !trimmed.startsWith('*') && !line.includes('`') && /\.catch\(\(\)\s*=>\s*\{\s*\}\)/.test(line)) add(f, ln, `空 catch 会把请求失败伪装成空数据 → 使用 useResource/ViewState 或显示可重试错误`);
  });
}

// —— admin.css 扫描：:root 之外把 token 颜色硬编码 ——
const rootEnd = css.indexOf('}', css.indexOf(':root'));
css.split('\n').forEach((line, i) => {
  const ln = i + 1;
  const offset = css.split('\n').slice(0, i).join('\n').length;
  if (offset < rootEnd) return; // 跳过 :root 定义区
  for (const h of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    const hex = h[0].toLowerCase();
    if (!ALLOW_HEX.has(hex)) {
      const known = tokenByValue.get(hex);
      add(CSS, ln, known ? `硬编码 ${h[0]} 等于 token → 改用 var(--${known})` : `硬编码颜色 ${h[0]} → 先在 :root 定义语义 token，再用 var()`);
    }
  }
  if (/\bz-index\s*:\s*\d+\b/.test(line)) add(CSS, ln, `z-index 使用字面量 → 改用 var(--z-*) 刻度`);
});

if (violations.length) {
  console.error(`✖ 运营后台设计系统合规：发现 ${violations.length} 处违规\n`);
  for (const v of violations) console.error('  ' + v);
  console.error('\n规则见 admin/DESIGN.md「Engineering Compliance」。修好后再提交。');
  process.exit(1);
}
console.log('✓ 运营后台设计系统合规：通过（class 均有定义、无硬编码颜色、无一次性 inline 控件样式）');
