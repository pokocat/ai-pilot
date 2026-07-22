// 报告 V2 最小防线（服务端版，对齐 app/src/services/deliverableSection.ts）：把 9 种类型化
// section（hero/callout/stats/roster/table/phases/timeline/quote/letter）降级成任意「读
// h/b/list」的旧版消费方都能用的 {h,b?,list?}。
//
// 背景：shared/contracts.d.ts 的 DeliverableSection 判别联合把 h/b/list 以「可选」形式挂在
// 所有变体的公共基上——这只保证类型层面兼容（旧代码读 sec.h/sec.b/sec.list 能通过类型检查），
// 不代表运行时这些字段真的有值：stats/roster/table/phases/timeline 的实际内容在
// items/people/rows 等专属字段，quote/letter 干脆没有 h。任何直接读 sec.h/sec.b/sec.list 的
// 消费方对这 7 种类型都会静默剥空大半内容（quote/letter 甚至连标题都没有）。
//
// 前端 ReportCard 在报告 V2 落地时就用这套映射正确处理了全部类型，并在 2026-07-21 例行 QA
// 时把它提成 app/ 侧共享工具；2026-07-22 例行 QA 审计发现服务端的 casefile.ts/
// strategicProfile.ts（认可方案 → 案卷/军令/风险锁/战略档案的核心执行闭环）、sessions.ts
// harvestText（预言账本抽取）、evals.ts（运营调教沙盒评测打分）四处同样直接读
// sec.h/sec.b/sec.list，从未随报告 V2 一起更新——本文件把同一套映射搬到服务端，供这四处
// 及未来任何需要「展示/摘要 Deliverable.sections」的服务端代码复用，避免同一个坑各处重复踩。
import type { DeliverableSection as Section } from '../llm/schema.js';

export function cardSection(sec: Section): { h: string; b?: string; list?: string[] } {
  const s = sec as any;
  const cell = (c: string | { text: string; trend?: 'up' | 'dn' }) => (typeof c === 'string' ? c : c?.text ?? '');
  switch (s.type) {
    case 'hero': return { h: s.h, b: (s.paras ?? []).join('\n\n') };
    case 'callout': return { h: `【${s.tone}】${s.h}`, b: s.b };
    case 'stats': return { h: s.h || '关键数据', list: (s.items ?? []).map((it: any) => `${it.num}${it.unit ?? ''} · ${it.label}`) };
    case 'roster': return { h: s.h || '人物', b: s.intro, list: (s.people ?? []).map((p: any) => `${p.name}${p.role ? `（${p.role}）` : ''}：${p.desc}`) };
    case 'table': return { h: s.h || '对比', list: [(s.headers ?? []).join(' / '), ...(s.rows ?? []).map((r: any[]) => r.map(cell).join(' / '))] };
    case 'phases': return { h: s.h || '分步打法', list: (s.items ?? []).flatMap((it: any) => [`〔${it.tab}〕${it.h}${it.when ? ` · ${it.when}` : ''}`, ...(it.actions ?? []).map((a: string) => `· ${a}`), ...(it.kpi ? [`军令状：${it.kpi}`] : [])]) };
    case 'timeline': return { h: s.h || '时间节奏', list: (s.items ?? []).map((it: any) => `${it.when}　${it.h}${it.d ? `：${it.d}` : ''}`) };
    case 'quote': return { h: '金句', b: `「${s.text}」` };
    case 'letter': return { h: '军师手书', b: [s.salute, ...(s.paras ?? []), s.close, s.sign].filter(Boolean).join('\n\n') };
    default: return { h: s.h || '', b: s.b, list: Array.isArray(s.list) ? s.list : undefined };
  }
}

/** 把一份 Deliverable 的 sections 整体归一成 {h,b?,list?}[]，供只认旧形状的消费方直接替换 d.sections 使用。 */
export function normalizedSections(sections?: Section[]): { h: string; b?: string; list?: string[] }[] {
  return (sections ?? []).map(cardSection);
}
