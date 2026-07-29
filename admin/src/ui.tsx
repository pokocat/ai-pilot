// 运营端调教 studio 的共享小组件/工具（与 App.tsx 内的同名局部保持一致口径）。
import Icon from './Icon';
import type { Deliverable, DeliverableSection, DeliverableTableCell, ChatReply } from '../../shared/contracts';

// 骨架屏优先（见 components.tsx 的 Skeleton）；这里保留一个纯文本兜底给 studio 子页。
export function Loading() {
  return <div className="empty">加载中…</div>;
}

export function fmtTime(s: string) {
  return s.replace('T', ' ').replace('Z', '');
}

// 0-10 分 → 色阶类名（.score.ok/.mid/.warn/.bad，颜色定义在 admin.css）。
// 旧版直接返回 hex 拼进 inline style，绕过了设计系统 token。
export function scoreClass(score: number | null): 'none' | 'ok' | 'mid' | 'warn' | 'bad' {
  if (score === null) return 'none';
  if (score >= 8.5) return 'ok';
  if (score >= 7) return 'mid';
  if (score >= 5) return 'warn';
  return 'bad';
}

// 报告 V2 最小防线（同 app/src/components/ReportCard 的 cardSection）：把 12 种类型化 section
// 降级成沙盒可渲染的 {h,b?,list?}。shared/contracts.d.ts 的兼容性设计只保证 s.h/s.b/s.list
// 在类型层面对所有变体都存在（可选），但 stats/roster/table/phases/timeline/quote/letter 这 7 种
// 实际把内容存在 items/people/rows/paras/text 等专属字段——直接读 s.h/s.b/s.list 会让沙盒试跑结果
// 静默剥空大半内容（quote/letter 甚至连标题都没有，整节渲染成空 div），操作员据此“满意再发布”就成了
// 盲发。运营侧独立实现，字段口径与前端 cardSection 保持一致，避免用错字段。
function cellText(c: DeliverableTableCell): string {
  return typeof c === 'string' ? c : c?.text ?? '';
}
// 导出供 ui.sandbox.test.ts 做纯函数回归测试（不牵扯 JSX/DOM）。
export function sandboxSection(s: DeliverableSection): { h: string; b?: string; list?: string[] } {
  switch (s.type) {
    case 'hero': return { h: s.h, b: (s.paras ?? []).join('\n\n') };
    case 'callout': return { h: `【${s.tone}】${s.h}`, b: s.b };
    case 'stats': return { h: s.h || '关键数据', list: s.items.map((it) => `${it.num}${it.unit ?? ''} · ${it.label}`) };
    case 'roster': return { h: s.h || '人物', b: s.intro, list: s.people.map((p) => `${p.name}${p.role ? `（${p.role}）` : ''}：${p.desc}`) };
    case 'table': return { h: s.h || '对比', list: [s.headers.join(' / '), ...s.rows.map((r) => r.map(cellText).join(' / '))] };
    case 'phases': return {
      h: s.h || '分步打法',
      list: s.items.flatMap((it) => [
        `〔${it.tab}〕${it.h}${it.when ? ` · ${it.when}` : ''}`,
        ...it.actions.map((a) => `· ${a}`),
        ...(it.kpi ? [`军令状：${it.kpi}`] : []),
      ]),
    };
    case 'timeline': return { h: s.h || '时间节奏', list: s.items.map((it) => `${it.when}　${it.h}${it.d ? `：${it.d}` : ''}`) };
    case 'quote': return { h: '金句', b: `「${s.text}」${s.cite ? ` — ${s.cite}` : ''}` };
    case 'letter': return { h: '军师手书', b: [s.salute, ...(s.paras ?? []), s.close, s.sign].filter(Boolean).join('\n\n') };
    case 'gauge': return { h: `评分 ${s.score ?? 0}/100${s.verdict ? ` ${s.verdict}` : ''}`, list: (s.items ?? []).map((it) => `${it.label} ${it.score}分${it.note ? ` ${it.note}` : ''}`) };
    case 'matrix': return { h: s.h || '四象限', list: s.quads.filter((q) => q && (q.title || q.items?.length)).map((q) => `${q.title || ''}${q.tone ? `（${q.tone}）` : ''}：${(q.items ?? []).join('、')}`) };
    case 'gantt': return { h: s.h || '排期', list: s.rows.map((r) => `${r.label}　第${r.from}-${r.to}${s.unit ?? '周'}${r.note ? ` · ${r.note}` : ''}`) };
    default: return { h: s.h || '', b: s.b, list: Array.isArray(s.list) ? s.list : undefined };
  }
}

// 沙盒/评测里渲染一份结构化产出（只读，简版）。
export function DeliverableView({ d }: { d: Deliverable }) {
  return (
    <div className="sbx-doc">
      <div className="sbx-doc-h">{d.title}</div>
      {d.meta && <div className="sbx-doc-meta">{d.meta}</div>}
      {d.sections.map((s, i) => {
        const v = sandboxSection(s);
        return (
          <div key={i} className="sbx-sec">
            <div className="sbx-sec-h">{v.h}</div>
            {v.b && <div className="sbx-sec-b">{v.b}</div>}
            {v.list && v.list.length > 0 && (
              <ul className="sbx-sec-l">{v.list.map((x, j) => <li key={j}>{x}</li>)}</ul>
            )}
          </div>
        );
      })}
      {d.trust && <div className="sbx-doc-trust"><Icon name="shield" size={12} /> {d.trust}</div>}
    </div>
  );
}

export function ChatView({ r }: { r: ChatReply }) {
  return (
    <div className="sbx-doc">
      <div className="sbx-sec-b" style={{ whiteSpace: 'pre-wrap' }}>{r.text}</div>
      {r.points && r.points.length > 0 && (
        <ul className="sbx-sec-l">{r.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
      )}
    </div>
  );
}
