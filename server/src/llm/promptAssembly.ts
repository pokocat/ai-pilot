// 提示词模块化：把一段系统提示词按标记切成「常驻底座 + 按需模块」，运行时只注入命中的模块。
// 目的：像 V6.0 这种超长提示词里，「交付物 HTML 规范」等大块只在产出成果时才需要，
// 日常对话不必每轮都带（配合 prompt caching，底座常驻吃缓存，按需模块放缓存断点之后）。
//
// 标记语法（整行）：
//   ===MODULE deliverable===              此标记到下个标记/结尾之间，仅在「产出成果」时注入
//   ===MODULE keyword:什么时候,择时,签约===  仅当用户消息含任一关键词时注入
// 第一个标记之前的内容 = 底座（始终注入）。无任何标记的提示词 = 整段都是底座（完全向后兼容，零副作用）。

export type PromptKind = 'chat' | 'deliverable';

type ModuleCond = { type: 'deliverable' } | { type: 'keyword'; words: string[] };
interface PromptModule { cond: ModuleCond; text: string; }

const MARKER = /^===MODULE\s+(.+?)===\s*$/;

function parseCond(spec: string): ModuleCond | null {
  const s = spec.trim();
  if (s === 'deliverable') return { type: 'deliverable' };
  if (s.startsWith('keyword:')) {
    const words = s.slice('keyword:'.length).split(',').map((w) => w.trim()).filter(Boolean);
    return words.length ? { type: 'keyword', words } : null;
  }
  return null;
}

export function parsePromptModules(prompt: string): { base: string; modules: PromptModule[] } {
  const baseLines: string[] = [];
  const modules: PromptModule[] = [];
  let cur: PromptModule | null = null;
  for (const line of prompt.split('\n')) {
    const m = line.match(MARKER);
    if (m) {
      const cond = parseCond(m[1]);
      if (cond) { cur = { cond, text: '' }; modules.push(cur); continue; }
      // 无法识别的标记 → 当普通文本处理
    }
    if (cur) cur.text += (cur.text ? '\n' : '') + line;
    else baseLines.push(line);
  }
  return { base: baseLines.join('\n').trim(), modules };
}

/** 按本轮 kind / 用户消息挑出生效模块；返回底座 + 拼好的生效模块文本（均未填占位符）。 */
export function selectModuleText(prompt: string, opts: { kind?: PromptKind; userMessage?: string }): { base: string; active: string } {
  const { base, modules } = parsePromptModules(prompt);
  if (!modules.length) return { base, active: '' };
  const msg = opts.userMessage ?? '';
  const active = modules
    .filter((mod) => (mod.cond.type === 'deliverable' ? opts.kind === 'deliverable' : mod.cond.words.some((w) => msg.includes(w))))
    .map((m) => m.text.trim())
    .filter(Boolean);
  return { base, active: active.join('\n\n') };
}
