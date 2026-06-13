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

function wantsBriefInterview(ctx: GenContext): boolean {
  return /军师档案访谈模式|补齐军师档案|完善军师档案|更新军师档案|让军师来问/.test(ctx.userMessage);
}

function nextQuestions(ctx: GenContext): string[] {
  const qs = ctx.understandingQuestions?.length
    ? ctx.understandingQuestions
    : ['你现在做什么行业或品类？', '业务处在哪个阶段？', '这段时间最卡你的经营问题是什么？'];
  return qs.slice(0, 3);
}

export function mockDeliverable(ctx: GenContext): Deliverable {
  if (wantsBriefInterview(ctx) || needsCustomerInput(ctx)) {
    return {
      title: '先让军师问清楚',
      icon: 'target',
      meta: metaOf(ctx),
      sections: [
        { h: '先问几个关键问题', b: '我先把你的行业、阶段和当前卡点问清楚，再给下一步判断。' },
        { h: '请你简单回答', list: nextQuestions(ctx) },
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
  if (wantsBriefInterview(ctx) || needsCustomerInput(ctx)) {
    return {
      text: '好，我先问清楚，再给判断。你不用写长文，按下面几个问题简单答就行。',
      points: nextQuestions(ctx),
      acts: [['spark', '开始补档案']],
    };
  }
  const r = REPLIES['默认'];
  const refs = referenceNote(ctx);
  const points = refs.length ? [...r.points, `已参考：${refs.join('；')}`] : r.points;
  return { text: r.t, points, acts: r.acts };
}
