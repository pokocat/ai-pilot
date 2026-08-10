import { useCallback, useEffect, useRef } from 'react';
import type { PcState } from './state';

export interface NavRow {
  key: string;
  ic: string;
  t: string;
  s?: string;
  val?: string;
  on?: boolean;
  go: () => void;
}
export interface NavGroup {
  label: string;
  rows: NavRow[];
}

/**
 * 列表栏外壳：区标题（含水印字）+ 可拖拽列宽 + 内容插槽。
 * 问策区塞会话线程，其余四区塞分区导航（navGroups）。
 */
export default function ListPane({
  st, glyph, kicker, title, groups, children,
}: {
  st: PcState;
  glyph: string;
  kicker: string;
  title: string;
  groups?: NavGroup[];
  children?: React.ReactNode;
}) {
  const dragging = useRef(false);

  const onDown = useCallback(() => { dragging.current = true; document.body.style.cursor = 'col-resize'; }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      // 轨道宽 76px：鼠标 x 减去轨道宽即列表栏应有宽度。
      st.setListW(e.clientX - 76);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  }, [st]);

  return (
    <aside className="pc-list">
      <header className="pc-list-head">
        <span className="pc-list-glyph">{glyph}</span>
        <div className="pc-list-kicker">{kicker}</div>
        <div className="pc-list-title">{title}</div>
        <div className="pc-list-rule" />
      </header>

      {children}

      {groups && groups.length > 0 && (
        <div className="pc-list-body">
          {groups.map((g) => (
            <div className="pc-navgroup" key={g.label}>
              <div className="pc-navgroup-label">{g.label}</div>
              {g.rows.map((r) => (
                <button
                  type="button"
                  key={r.key}
                  className={`pc-navrow${r.on ? ' pc-on' : ''}`}
                  onClick={r.go}
                >
                  <span className="pc-navrow-ic">{r.ic}</span>
                  <span className="pc-navrow-main">
                    <span className="pc-navrow-t">{r.t}</span>
                    {r.s && <span className="pc-navrow-s">{r.s}</span>}
                  </span>
                  {r.val && <span className="pc-navrow-val">{r.val}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="pc-list-grip" onMouseDown={onDown} title="拖动调整列表宽度" />
    </aside>
  );
}
