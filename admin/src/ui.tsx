// 运营端调教 studio 的共享小组件/工具（与 App.tsx 内的同名局部保持一致口径）。
import Icon from './Icon';
import type { Deliverable, ChatReply } from '../../shared/contracts';

export function Loading() {
  return <div className="pad" style={{ padding: 40, textAlign: 'center', color: '#969BA1' }}>加载中…</div>;
}

export function fmtTime(s: string) {
  return s.replace('T', ' ').replace('Z', '');
}

// 0-10 分 → 颜色（红→黄→绿）。
export function scoreColor(score: number | null): string {
  if (score === null) return '#969BA1';
  if (score >= 8.5) return '#1a8a5a';
  if (score >= 7) return '#caa53d';
  if (score >= 5) return '#c98a2e';
  return '#d4503a';
}

// 沙盒/评测里渲染一份结构化产出（只读，简版）。
export function DeliverableView({ d }: { d: Deliverable }) {
  return (
    <div className="sbx-doc">
      <div className="sbx-doc-h">{d.title}</div>
      {d.meta && <div className="sbx-doc-meta">{d.meta}</div>}
      {d.sections.map((s, i) => (
        <div key={i} className="sbx-sec">
          <div className="sbx-sec-h">{s.h}</div>
          {s.b && <div className="sbx-sec-b">{s.b}</div>}
          {s.list && s.list.length > 0 && (
            <ul className="sbx-sec-l">{s.list.map((x, j) => <li key={j}>{x}</li>)}</ul>
          )}
        </div>
      ))}
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
