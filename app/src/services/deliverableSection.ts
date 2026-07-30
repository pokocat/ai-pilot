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
//
// 脏数据防线（2026-07-29）：本函数的返回值被声明为 {h: string; b?: string; list?: string[]}，
// 但此前只是「按类型取字段」，并没有真的保证类型——存量脏数据下有两类运行期崩溃：
//   ① 容器字段不是数组（items/rows/paras/people/quads/list 存成对象或字符串）→ `.map/.join/展开`
//      直接 TypeError；
//   ② 叶子字段不是字符串（list 项 / b / h 存成对象）→ 原样透给 <MarkdownText>，其 parseBlocks
//      第一行 `input.replace(...)` 抛 `e.replace is not a function`。
// 两者在小程序里都表现为**整页白屏**（渲染期抛错，无红屏堆栈）。脏数据来源：早于服务端
// normalizeDeliverableSections（报告 V2 归一化）落库的历史成果消息——而会话详情读取端
// （GET /sessions/:id）**不做** healDeliverableSections，脏值原样到端上。
// 故这里统一用 str()/arr() 收口：口径与服务端 llm/schema.ts 的 textOf/listOf 一致
//（非字符串标量转字符串，对象丢弃），保证「会话成果卡」与「方案库详情」显示同一份内容。
const str = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const strList = (v: unknown): string[] => arr(v).map(str).filter(Boolean);

export function cardSection(sec: Section): { h: string; b?: string; list?: string[] } {
  const s = (sec ?? {}) as any;
  const cell = (c: unknown) => (typeof c === 'string' ? c : str((c as { text?: unknown } | null)?.text));
  switch (s.type) {
    case 'hero': return { h: str(s.h), b: strList(s.paras).join('\n\n') };
    case 'callout': return { h: `【${str(s.tone)}】${str(s.h)}`, b: str(s.b) };
    case 'stats': return { h: str(s.h) || '关键数据', list: arr(s.items).map((it: any) => `${str(it?.num)}${str(it?.unit)} · ${str(it?.label)}`) };
    case 'roster': return { h: str(s.h) || '人物', b: str(s.intro), list: arr(s.people).map((p: any) => `${str(p?.name)}${p?.role ? `（${str(p.role)}）` : ''}：${str(p?.desc)}`) };
    case 'table': return { h: str(s.h) || '对比', list: [strList(s.headers).join(' / '), ...arr(s.rows).map((r: unknown) => arr(r).map(cell).join(' / '))] };
    case 'phases': return { h: str(s.h) || '分步打法', list: arr(s.items).flatMap((it: any) => [`〔${str(it?.tab)}〕${str(it?.h)}${it?.when ? ` · ${str(it.when)}` : ''}`, ...strList(it?.actions).map((a: string) => `· ${a}`), ...(it?.kpi ? [`军令状：${str(it.kpi)}`] : [])]) };
    case 'timeline': return { h: str(s.h) || '时间节奏', list: arr(s.items).map((it: any) => `${str(it?.when)}　${str(it?.h)}${it?.d ? `：${str(it.d)}` : ''}`) };
    case 'quote': return { h: '金句', b: `「${str(s.text)}」` };
    case 'letter': return { h: '军师手书', b: [str(s.salute), ...strList(s.paras), str(s.close), str(s.sign)].filter(Boolean).join('\n\n') };
    case 'gauge': return { h: `评分 ${s.score ?? 0}/100${s.verdict ? ` ${str(s.verdict)}` : ''}`, list: arr(s.items).map((it: any) => `${str(it?.label)} ${str(it?.score)}分${it?.note ? ` ${str(it.note)}` : ''}`) };
    case 'matrix': return { h: str(s.h) || '四象限', list: arr(s.quads).filter((q: any) => q && (q.title || strList(q.items).length)).map((q: any) => `${str(q.title)}${q.tone ? `（${str(q.tone)}）` : ''}：${strList(q.items).join('、')}`) };
    case 'gantt': return { h: str(s.h) || '排期', list: arr(s.rows).map((r: any) => `${str(r?.label)}　第${str(r?.from)}-${str(r?.to)}${str(s.unit) || '周'}${r?.note ? ` · ${str(r.note)}` : ''}`) };
    default: return { h: str(s.h), b: str(s.b), list: Array.isArray(s.list) ? strList(s.list) : undefined };
  }
}

/** 把一个 section（含可能为 undefined，diff before/after 场景）拍平成一行纯文本，用于 diff 摘要预览。 */
export function cardSectionText(sec?: Section): string {
  if (!sec) return '';
  const v = cardSection(sec);
  return [v.b, ...(v.list ?? [])].filter(Boolean).join('；');
}
