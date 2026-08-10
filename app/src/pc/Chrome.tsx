// 主工作区的通用外壳件：顶栏、详情抽屉、右键菜单、Toast、空态。

import { useEffect, useRef } from 'react';
import type { CtxData, DrawerData, PcState } from './state';

export interface BarAction {
  t: string;
  primary?: boolean;
  ghost?: boolean;
  go: () => void;
}

export function TopBar({ title, sub, actions }: { title: string; sub?: string; actions?: BarAction[] }) {
  return (
    <div className="pc-topbar">
      <div className="pc-topbar-main">
        <span className="pc-topbar-title">{title}</span>
        {sub && <span className="pc-topbar-sub">{sub}</span>}
      </div>
      {(actions || []).map((b) => (
        <button
          type="button"
          key={b.t}
          className={`pc-btn${b.primary ? ' pc-primary' : ''}${b.ghost ? ' pc-ghost' : ''}`}
          onClick={b.go}
        >
          {b.t}
        </button>
      ))}
    </div>
  );
}

export function Drawer({ data, onClose }: { data: DrawerData; onClose: () => void }) {
  return (
    <aside className="pc-drawer">
      <div className="pc-drawer-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="pc-drawer-kicker">{data.kicker}</div>
          <div className="pc-drawer-title">{data.title}</div>
        </div>
        <button type="button" className="pc-drawer-x" onClick={onClose} title="关闭（Esc）">✕</button>
      </div>
      <div className="pc-drawer-body">
        {data.quote && <div className="pc-drawer-quote">{data.quote}</div>}
        {(data.blocks || []).map((b, i) => (
          <div
            className="pc-drawer-block"
            key={`${b.label}-${i}`}
            style={b.mark ? { borderLeftColor: b.mark } : undefined}
          >
            <div className="pc-drawer-block-label">{b.label}</div>
            <div className="pc-drawer-block-title">{b.title}</div>
            <div className="pc-drawer-block-body">{b.body}</div>
            {b.tactic && (
              <div className="pc-drawer-block-tactic" style={{ color: b.tacticColor || 'var(--accent)' }}>
                {b.tactic}
              </div>
            )}
          </div>
        ))}
        {data.synthesis && (
          <div className="pc-drawer-synth">
            <div className="pc-drawer-synth-t">{data.synthesis.title}</div>
            <div className="pc-drawer-synth-b">{data.synthesis.body}</div>
          </div>
        )}
        {(data.actions || []).map((a) => (
          <button
            type="button"
            key={a.t}
            className={`pc-drawer-act${a.primary ? ' pc-primary' : ''}${a.danger ? ' pc-danger' : ''}`}
            onClick={a.go}
          >
            {a.t}
          </button>
        ))}
      </div>
    </aside>
  );
}

export function ContextMenu({ data, onClose }: { data: CtxData; onClose: () => void }) {
  return (
    <div className="pc-ctx-mask" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className="pc-ctx" style={{ left: data.x, top: data.y }} onClick={(e) => e.stopPropagation()}>
        <div className="pc-ctx-label">{data.label}</div>
        {data.items.map((i) => (
          <button
            type="button"
            key={i.t}
            className={`pc-ctx-item${i.danger ? ' pc-danger' : ''}`}
            onClick={() => { onClose(); i.go(); }}
          >
            <span>{i.t}</span>
            {i.k && <span className="pc-ctx-key">{i.k}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Toast({ text }: { text: string }) {
  return <div className="pc-toast">{text}</div>;
}

export function Empty({ glyph, title, sub }: { glyph: string; title: string; sub?: string }) {
  return (
    <div className="pc-empty">
      <div className="pc-empty-glyph">{glyph}</div>
      <div className="pc-empty-t">{title}</div>
      {sub && <div className="pc-empty-s">{sub}</div>}
    </div>
  );
}

/** 主工作区右侧抽屉 + 内容体的组合容器。 */
export function Stage({ st, children }: { st: PcState; children: React.ReactNode }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  // 区/子视图都是工作台内切换，不触发浏览器导航；手动归零才能避免从长页面切走后
  // 新页面从半截开始。抽屉开合不在依赖里，不会打断用户阅读位置。
  useEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = 0; }, [st.tab, st.view]);
  return (
    <div className="pc-stage">
      <div className="pc-stage-body" ref={bodyRef}>{children}</div>
      {st.drawer && <Drawer data={st.drawer} onClose={st.closeDrawer} />}
    </div>
  );
}
