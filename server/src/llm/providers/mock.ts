// Mock 提供方（默认）：基于原型 DELIVERABLES / REPLIES 模板 + 档案变量插值。
// 不调用真实模型，零成本、可离线，用于演示与前端联调。

import { DELIVERABLES, REPLIES, TRUST_NOTE } from '../../data/deliverables.js';
import type { Deliverable, ChatReply, GenContext } from '../schema.js';

function metaOf(ctx: GenContext): string {
  const p = ctx.profile;
  if (p?.industry) return `云栖科技 · ${p.industry}${p.stage ? ' · ' + p.stage : ''}`;
  return '云栖科技 · 已就绪';
}

// 把显式引用 + 知识召回汇成一行「参考依据」，让 mock 也能直观体现引用生效。
function referenceNote(ctx: GenContext): string[] {
  const items = [...(ctx.references ?? []), ...(ctx.knowledge ?? [])];
  return items.slice(0, 4).map((s) => s.replace(/^【[^】]*】/, '').slice(0, 60));
}

export function mockDeliverable(ctx: GenContext): Deliverable {
  const key = ctx.deliverableKey ?? '战略体检';
  const tpl = DELIVERABLES[key] ?? DELIVERABLES['战略体检'];
  const pain = ctx.profile?.pain || '增长与盈利';
  const sections = tpl.sections.map((s) => ({
    h: s.h,
    b: s.b ? s.b.replaceAll('{PAIN}', pain) : undefined,
    list: s.list,
  }));
  const refs = referenceNote(ctx);
  if (refs.length) sections.push({ h: '参考依据', b: undefined, list: refs });
  return {
    title: tpl.title,
    icon: tpl.icon,
    meta: ctx.projectName ? `${metaOf(ctx)} · ${ctx.projectName}` : metaOf(ctx),
    sections,
    trust: TRUST_NOTE,
    actions: ['save_to_library', 'export_pdf'],
  };
}

export function mockChat(ctx: GenContext): ChatReply {
  const r = REPLIES['默认'];
  const refs = referenceNote(ctx);
  const points = refs.length ? [...r.points, `已参考：${refs.join('；')}`] : r.points;
  return { text: r.t, points, acts: r.acts };
}
