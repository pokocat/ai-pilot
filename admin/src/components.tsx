// 运营后台共享组件：页头 / 三态渲染 / 二次确认 / 搜索框。
// 组件类词汇见 admin/DESIGN.md；这里只负责组装，不写一次性 inline 样式。

import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from 'react';
import Icon from './Icon';
import { findSection, type SectionKey } from './nav';
import { freshness, type Resource, type ResourceStatus } from './useResource';

/* ────────────── 页头 ──────────────
   标题与副标题统一来自 nav.ts（SSOT），页内不再各写一份 sec-h，避免"这屏到底叫什么"
   在导航和标题之间打架。右侧固定给出刷新 + 数据新鲜度：运营看的是不是新鲜数据，
   不该靠猜。 */
export function PageHead({ k, badge, res, actions }: {
  k: SectionKey;
  /** 标题后的计数徽标，如「128 人」 */
  badge?: string;
  /** 传入后自动渲染刷新按钮与「刚刚更新」 */
  res?: ResourceStatus;
  actions?: ReactNode;
}) {
  const sec = findSection(k);
  // 让「刚刚更新 / 3 分钟前」随时间走，而不是停在渲染那一刻。
  // 依赖取 updatedAt 而非 res 本身：部分调用方传的是内联对象字面量，用 res 会每次渲染都重建定时器。
  const updatedAt = res?.updatedAt ?? 0;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!updatedAt) return;
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [updatedAt]);
  const stamp = res ? freshness(updatedAt) : '';
  return (
    <div className="ph">
      <div className="ph-b">
        <div className="t">{sec?.label ?? k}{badge && <span className="badge">{badge}</span>}</div>
        <div className="s">{sec?.hint}</div>
      </div>
      <div className="ph-actions">
        {actions}
        {stamp && <span className="ph-stamp">{stamp}</span>}
        {res && (
          <button
            type="button"
            className="mini-btn"
            disabled={res.loading}
            onClick={res.reload}
            title="重新加载本页数据"
            aria-label="刷新"
          >
            <Icon name="refresh" size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

/* ────────────── 三态渲染 ──────────────
   旧版所有取数都是 `.catch(() => {})` + `if (!data) return <Loading/>`：请求失败与"确实没数据"
   在界面上完全一样。运营在排障时最需要区分这两件事——接口挂了得重试/上报，没数据才是业务结论。 */
export function ViewState<T>({ res, skeleton = 'rows', children }: {
  res: Resource<T>;
  skeleton?: 'rows' | 'stats' | 'none';
  children: (data: T) => ReactNode;
}) {
  if (res.error && res.data === null) {
    return <div className="pad"><ErrorState msg={res.error} onRetry={res.reload} forbidden={res.forbidden} /></div>;
  }
  if (res.initial) {
    return skeleton === 'none' ? null : <div className="pad"><Skeleton kind={skeleton} /></div>;
  }
  if (res.data === null) return null;
  return (
    <>
      {/* 已有旧数据但刷新失败：保留数据、顶部提示，不把运营已经在看的内容抽走 */}
      {res.error && <div className="pad"><ErrorState msg={res.error} onRetry={res.reload} stale forbidden={res.forbidden} /></div>}
      {children(res.data)}
    </>
  );
}

/** forbidden=403：登录态没问题，是这个账户权限不够——文案要指向「找 owner 授权」，且不给重试按钮（再点还是 403）。 */
export function ErrorState({ msg, onRetry, stale = false, forbidden = false }: { msg: string; onRetry?: () => void; stale?: boolean; forbidden?: boolean }) {
  return (
    <div className="state-err">
      <span className="ic"><Icon name="alert" size={16} /></span>
      <div className="b">
        <div className="t">{forbidden ? (stale ? '权限已变化，下面是上一次的数据' : '当前账户没有查看这块内容的权限') : stale ? '刷新失败，下面是上一次的数据' : '数据没能加载出来'}</div>
        <div className="m">{forbidden ? `${msg} · 需要的话请让 owner 调整授权（重试无效）` : msg}</div>
      </div>
      {onRetry && !forbidden && <button type="button" className="mini-btn" onClick={onRetry}>重试</button>}
    </div>
  );
}

export function Skeleton({ kind = 'rows' }: { kind?: 'rows' | 'stats' }) {
  if (kind === 'stats') {
    return (
      <div className="skel">
        <div className="skel-grid">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skel-b skel-h" />)}
        </div>
        <div className="skel-b skel-r" />
        <div className="skel-b skel-r" />
      </div>
    );
  }
  return (
    <div className="skel">
      {[0, 1, 2, 3, 4].map((i) => <div key={i} className="skel-b skel-r" />)}
    </div>
  );
}

/** 页面级空态：与「加载中」「加载失败」明确区分开。 */
export function EmptyState({ msg, hint }: { msg: string; hint?: string }) {
  return <div className="empty">{msg}{hint && <div className="usage-meta">{hint}</div>}</div>;
}

/* ────────────── 键盘与辅助技术基础设施 ──────────────
   运营后台的弹层承载退款、改密钥、改密码等高风险动作。只有 role="dialog" 还不够：
   打开后焦点必须进入弹层，Tab 不能跑到遮罩后的页面，Esc 可退出，关闭后还要回到触发控件。
   统一 hook 避免三个弹层各做一半。 */
const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialogFocus<R extends HTMLElement = HTMLDivElement>(onClose: () => void, preferred?: RefObject<HTMLElement>): RefObject<R> {
  const rootRef = useRef<R>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusFirst = () => {
      const target = preferred?.current
        ?? root.querySelector<HTMLElement>('[autofocus]')
        ?? root.querySelector<HTMLElement>(FOCUSABLE)
        ?? root;
      target.focus();
    };
    const frame = window.requestAnimationFrame(focusFirst);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((el) => el.getClientRects().length > 0 && el.getAttribute('aria-hidden') !== 'true');
      if (items.length === 0) { e.preventDefault(); root.focus(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, [preferred]);

  return rootRef;
}

/** 统一开关：原来的 div.sw 鼠标能点、键盘和读屏却完全不可用。 */
export function Switch({ checked, onChange, label, disabled = false, stopPropagation = false }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  stopPropagation?: boolean;
}) {
  return (
    <button
      type="button"
      className={`sw ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => { if (stopPropagation) e.stopPropagation(); onChange(!checked); }}
    >
      <i aria-hidden="true" />
    </button>
  );
}

/* ────────────── 二次确认 ──────────────
   替掉 window.confirm / window.prompt。原生弹窗的问题：
     ① 不回显「对谁、多少钱、哪一单」——退款原因居然是靠 prompt 收的；
     ② 回车即确认，误触就是一笔真实退款；
     ③ 样式不受控，与 DESIGN.md 明令禁止的 window.alert 同类。
   现在资金动作会把金额/单号/用户回显出来，退款还必须手打确认词。 */
export interface ConfirmSpec {
  title: string;
  desc: string;
  /** 回显字段：让运营在按下确认前核对对象 */
  echo?: { k: string; v: string; amount?: boolean }[];
  /** 红色警示语（不可撤销之类） */
  warn?: string;
  /** 需要填写事由（secret=按密码框渲染，用于重置密码这类不该明文回显的输入） */
  reason?: { label: string; required?: boolean; maxLength?: number; secret?: boolean };
  /** 需原样输入该词才允许提交（最危险的动作用，如退款输「退款」） */
  typed?: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: (reason: string) => Promise<void>;
}

export function ConfirmDialog({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const titleId = useId();
  const descId = useId();
  const requestClose = () => { if (!busy) onClose(); };
  const dialogRef = useDialogFocus(requestClose);

  const blocked = !!spec.typed && typed.trim() !== spec.typed;
  const submit = async () => {
    if (busy) return;
    if (spec.reason?.required && !reason.trim()) { setErr('请填写事由'); return; }
    if (blocked) { setErr(`请输入「${spec.typed}」以确认`); return; }
    setBusy(true); setErr('');
    try { await spec.onConfirm(reason.trim()); onClose(); }
    catch (e) { setBusy(false); setErr((e as Error)?.message || '操作失败'); }
  };

  return (
    <div className="modal-scrim" onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div ref={dialogRef} className="al-card modal" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descId} tabIndex={-1}>
        <div className="al-label" id={titleId}>{spec.title}</div>
        <div className="blk-d" id={descId}>{spec.desc}</div>
        {spec.echo && spec.echo.length > 0 && (
          <div className="cfm-echo">
            {spec.echo.map((r) => (
              <div key={r.k} className="cfm-echo-r">
                <span>{r.k}</span>
                <b className={r.amount ? 'amount' : ''}>{r.v}</b>
              </div>
            ))}
          </div>
        )}
        {spec.warn && <div className="cfm-warn"><Icon name="alert" size={14} /> {spec.warn}</div>}
        {spec.reason && (
          <input
            className="al-input"
            type={spec.reason.secret ? 'password' : 'text'}
            value={reason}
            maxLength={spec.reason.maxLength ?? 80}
            placeholder={spec.reason.label}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !spec.typed) submit(); }}
            autoFocus
          />
        )}
        {spec.typed && (
          <div className="ai-field">
            <div className="ai-fl">请输入「{spec.typed}」以确认</div>
            <input
              className="ai-input"
              value={typed}
              placeholder={spec.typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus={!spec.reason}
            />
          </div>
        )}
        {err && <div className="al-err" role="alert"><Icon name="alert" size={13} /> {err}</div>}
        <button
          type="button"
          className={`al-btn ${spec.danger ? 'danger' : ''}`}
          onClick={submit}
          disabled={busy || blocked}
        >
          <Icon name="check" size={15} /> {busy ? '执行中…' : spec.confirmText ?? '确认'}
        </button>
        <button type="button" className="al-cancel" onClick={requestClose} disabled={busy}>取消</button>
      </div>
    </div>
  );
}

/** 列表搜索框（带清除）。 */
export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="search-box">
      <Icon name="search" size={14} />
      <input className="search-in" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {value && <button type="button" className="search-clear" onClick={() => onChange('')} aria-label="清除搜索"><Icon name="close" size={12} /></button>}
    </div>
  );
}
