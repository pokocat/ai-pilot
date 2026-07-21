import type { Section } from './api';

// 报告 V2 最小防线：把 9 种类型化 section（hero/callout/stats/roster/table/phases/timeline/quote/letter）
// 降级成任意「读 h/b/list」的旧版展示位都能渲染的 {h,b?,list?}。
//
// 背景：shared/contracts.d.ts 的 DeliverableSection 判别联合把 h/b/list 以「可选」形式挂在所有变体的
// 公共基上——这只保证类型层面兼容（旧代码读 sec.h/sec.b/sec.list 能通过类型检查），不代表运行时这些
// 字段真的有值：stats/roster/table/phases/timeline 的实际内容在 items/people/rows 等专属字段，
// quote/letter 干脆没有 h。任何直接读 sec.h/sec.b/sec.list 的展示位对这 7 种类型都会静默剥空大半内容
// （quote/letter 甚至连标题都没有）。ReportCard（成果卡）在报告 V2 落地时就用这套映射正确处理了全部
// 类型；本文件把它提成共享工具，供其它同样需要展示 Deliverable.sections 的位置（如「方案库详情」的
// 内容页/版本 diff）复用，避免同一个坑各处重复踩（2026-07-21 例行 QA 发现方案库详情页仍在直接读
// sec.h/sec.b/sec.list，未随报告 V2 一起更新）。
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

/** 把一个 section（含可能为 undefined，diff before/after 场景）拍平成一行纯文本，用于 diff 摘要预览。 */
export function cardSectionText(sec?: Section): string {
  if (!sec) return '';
  const v = cardSection(sec);
  return [v.b, ...(v.list ?? [])].filter(Boolean).join('；');
}
