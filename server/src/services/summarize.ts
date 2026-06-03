// 对话汇总（记忆固化）：把整段会话提炼成一份「对话纪要」结构化报告，
// 写为版本化报告（同名会续版本）并把关键要点沉淀进知识库，供后续检索/引用。
//
// 当前为确定性提炼（零依赖、可离线）；接真实模型时可在此调用 gateway 做更高质量的归纳
// （见 AGENTS §16 升级路径），产出结构保持不变。

import { prisma } from '../db.js';
import { saveReportVersion } from './reports.js';
import { ingestKnowledge } from './knowledge.js';
import { summarizePoints } from '../llm/gateway.js';
import { TRUST_NOTE } from '../data/deliverables.js';
import type { Deliverable, SummarizeResult } from '../llm/schema.js';

interface MsgLite { role: string; contentJson: unknown }

function transcriptOf(messages: MsgLite[]): string {
  return messages.map((m) => {
    const c = m.contentJson as { text?: string; title?: string; points?: string[] };
    if (m.role === 'user') return `用户：${c.text ?? ''}`;
    if (m.role === 'report') return `顾问产出：《${c.title ?? '成果'}》`;
    return `顾问：${c.text ?? ''}${(c.points ?? []).length ? '（要点：' + (c.points ?? []).join('；') + '）' : ''}`;
  }).join('\n').slice(0, 6000);
}

function buildSummary(title: string, agentName: string, messages: MsgLite[]): Deliverable {
  const userPoints: string[] = [];
  const reportTitles: string[] = [];
  const replyPoints: string[] = [];

  for (const m of messages) {
    const c = m.contentJson as { text?: string; title?: string; points?: string[] };
    if (m.role === 'user' && c.text) userPoints.push(c.text.trim().slice(0, 60));
    else if (m.role === 'report' && c.title) reportTitles.push(c.title);
    else if (m.role === 'assistant') {
      if (c.text) replyPoints.push(c.text.trim().slice(0, 60));
      (c.points ?? []).forEach((p) => replyPoints.push(p));
    }
  }

  const sections: Deliverable['sections'] = [];
  sections.push({
    h: '讨论要点',
    list: (userPoints.length ? userPoints : ['（本次对话内容较少）']).slice(0, 6),
  });
  if (reportTitles.length) {
    sections.push({ h: '本次产出', list: reportTitles.map((t) => `已产出《${t}》`).slice(0, 6) });
  }
  sections.push({
    h: '关键结论',
    list: (replyPoints.length ? replyPoints : ['顾问已给出阶段性判断，详见对话原文。']).slice(0, 6),
  });
  sections.push({
    h: '待办与决策',
    b: '将上述结论中需要跟进的事项纳入项目推进；重大决策请结合专业意见。',
  });

  return {
    title: `《${title}》对话纪要`,
    icon: 'doc',
    meta: `${agentName} · 对话汇总`,
    sections,
    trust: TRUST_NOTE,
    actions: ['save_to_library', 'export_pdf'],
  };
}

export async function summarizeSession(opts: {
  tenantId: string;
  userId: string;
  sessionId: string;
}): Promise<SummarizeResult> {
  const session = await prisma.session.findFirst({
    where: { id: opts.sessionId, userId: opts.userId },
    include: { messages: { orderBy: { createdAt: 'asc' } }, agent: true },
  });
  if (!session) throw Object.assign(new Error('session not found'), { statusCode: 404 });

  const deliverable = buildSummary(session.title, session.agent.name, session.messages);

  // 有真实模型时用 LLM 归纳覆盖确定性要点（失败/mock 时保留兜底）。
  const llm = await summarizePoints(transcriptOf(session.messages));
  if (llm) {
    const secs: Deliverable['sections'] = [];
    if (llm.points.length) secs.push({ h: '讨论要点', list: llm.points });
    if (llm.conclusions.length) secs.push({ h: '关键结论', list: llm.conclusions });
    if (llm.todos.length) secs.push({ h: '待办与决策', list: llm.todos });
    if (secs.length) deliverable.sections = secs;
  }

  // 1) 写为版本化报告（归属会话所在项目）
  const saved = await saveReportVersion({
    tenantId: opts.tenantId,
    userId: opts.userId,
    projectId: session.projectId,
    title: deliverable.title,
    type: '对话纪要',
    agentKey: session.agentKey,
    content: deliverable as object,
    authorKind: 'agent',
    sessionId: session.id,
  });

  // 2) 关键要点沉淀进知识库（供后续检索/引用）
  const insightText = deliverable.sections
    .flatMap((s) => (s.list ?? []).concat(s.b ? [s.b] : []))
    .join('；')
    .slice(0, 1000);
  let knowledgeAdded = 0;
  if (insightText) {
    await ingestKnowledge({
      tenantId: opts.tenantId,
      userId: opts.userId,
      projectId: session.projectId,
      kind: 'insight',
      title: deliverable.title,
      text: insightText,
      sourceType: 'conversation',
      sourceId: session.id,
      tags: [session.agent.name, '对话纪要'],
    });
    knowledgeAdded = 1;
  }

  return { reportId: saved.reportId, version: saved.version, title: deliverable.title, knowledgeAdded };
}
