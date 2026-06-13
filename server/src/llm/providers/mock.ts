// Mock 提供方（默认）：基于原型 DELIVERABLES / REPLIES 模板 + 档案变量插值。
// 不调用真实模型，零成本、可离线，用于演示与前端联调。

import { DELIVERABLES, REPLIES, TRUST_NOTE } from '../../data/deliverables.js';
import type { Deliverable, ChatReply, GenContext } from '../schema.js';

function metaOf(ctx: GenContext): string {
  const parts = [ctx.companyName, ctx.profile?.industry, ctx.profile?.stage].filter(Boolean) as string[];
  return parts.length ? parts.join(' · ') : '经营快照';
}

// 把显式引用 + 知识召回汇成一行「参考依据」，让 mock 也能直观体现引用生效。
function referenceNote(ctx: GenContext): string[] {
  const items = [...(ctx.references ?? []), ...(ctx.knowledge ?? [])];
  return items.slice(0, 4).map((s) => s.replace(/^【[^】]*】/, '').slice(0, 60));
}

function needsCustomerInput(ctx: GenContext): boolean {
  const hasContext = !!ctx.companyName || !!ctx.profile || !!ctx.memories.length || !!ctx.references?.length || !!ctx.knowledge?.length || !!ctx.projectSummary;
  return !hasContext && (ctx.understandingMaturity === 'empty' || ctx.userMessage.trim().length < 24);
}

function nextQuestions(ctx: GenContext): string[] {
  const qs = ctx.understandingQuestions?.length
    ? ctx.understandingQuestions
    : ['你现在做什么行业或品类？', '业务处在哪个阶段？', '这段时间最卡你的经营问题是什么？'];
  return qs.slice(0, 3);
}

export function mockDeliverable(ctx: GenContext): Deliverable {
  if (needsCustomerInput(ctx)) {
    return {
      title: '先补齐军师档案',
      icon: 'target',
      meta: metaOf(ctx),
      sections: [
        { h: '需要先确认', b: '现有资料还不足以判断你的真实业务，军师不会替你编造公司背景或经营困难。' },
        { h: '请补充三点', list: nextQuestions(ctx) },
      ],
      trust: TRUST_NOTE,
      actions: ['save_to_library'],
    };
  }
  const key = ctx.deliverableKey ?? '战略体检';
  const tpl = DELIVERABLES[key] ?? DELIVERABLES['战略体检'];
  const pain = ctx.profile?.pain || '当前经营问题';
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
  if (needsCustomerInput(ctx)) {
    return {
      text: '我先不替你假设业务背景。要给出贴近你实际情况的判断，需要先补几项军师档案。',
      points: nextQuestions(ctx),
      acts: [['target', '补充经营情况']],
    };
  }
  const r = REPLIES['默认'];
  const refs = referenceNote(ctx);
  const points = refs.length ? [...r.points, `已参考：${refs.join('；')}`] : r.points;
  return { text: r.t, points, acts: r.acts };
}
