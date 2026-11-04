// 共用件：取数 hook、三态渲染、确认弹层、登录页。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { auth, clearToken, setToken, Unauthorized } from './api';

/* ── 取数 ────────────────────────────────────────────────── */

export interface Res<T> {
  data: T | null;
  error: string;
  loading: boolean;
  /** 首次加载（还没有任何数据）。骨架屏只在这时出，刷新时不要把已有内容换成骨架。 */
  initial: boolean;
  reload: () => void;
  setData: (v: T) => void;
}

/**
 * 一个请求的三态。
 *
 * 关键约束：**读失败时绝不能把 data 清成 null**。清了的话界面会从「上一份数据」
 * 掉成空态，运营看到的是「一条都没有」，而真相是「这次没读到」。
 */
export function useResource<T>(fn: () => Promise<T>, deps: unknown[], onAuthLost?: () => void): Res<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  // StrictMode 会重放 effect；用 ref 记「当前这一轮是不是还有效」，
  // 而不是在 cleanup 里置一个永久 false（admin 那边踩过：所有页面恒停在骨架屏）。
  const runId = useRef(0);

  useEffect(() => {
    const my = ++runId.current;
    let cancelled = false;
    setLoading(true);
    setError(''); // 新一轮开始就清掉上一轮的错，否则旧错会压在新结果上面
    fn().then(
      (v) => { if (!cancelled && my === runId.current) { setData(v); setError(''); setLoading(false); } },
      (e: unknown) => {
        if (cancelled || my !== runId.current) return;
        // 即便要跳走也要复位 loading：onAuthLost 是可选的，没传就会永久停在骨架屏
        setLoading(false);
        if (e instanceof Unauthorized) { onAuthLost?.(); return; }
        setError(e instanceof Error ? e.message : '读取失败');
        // data 保持原样，见上方说明
      },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return {
    data, error, loading,
    initial: loading && data === null,
    reload: useCallback(() => setTick((n) => n + 1), []),
    setData: useCallback((v: T) => setData(v), []),
  };
}

/* ── 三态渲染 ────────────────────────────────────────────── */

export function Skeleton({ n = 3 }: { n?: number }) {
  return <div className="skel">{Array.from({ length: n }, (_, i) => <i key={i} />)}</div>;
}

export function ErrorBox({ msg, onRetry, stale }: { msg: string; onRetry?: () => void; stale?: boolean }) {
  return (
    <div className="err">
      <div className="msg">{stale ? '刷新失败，下面还是上一次读到的：' : '读不到：'}{msg}</div>
      {onRetry && <button type="button" className="btn" onClick={onRetry}>重试</button>}
    </div>
  );
}

/**
 * 把「加载中 / 读失败 / 真的没有」分开渲染。
 *
 * 这三件事长得必须不一样。上游（AIStar）是另一台机器，它挂了要说「读不到」；
 * 显示成「一条都没有」会让运营以为业务没跑，那是最贵的一种误导。
 */
export function View<T>({ res, skeleton = 3, children }: {
  res: Res<T>; skeleton?: number; children: (data: T) => ReactNode;
}) {
  if (res.initial) return <Skeleton n={skeleton} />;
  if (res.error && res.data === null) return <ErrorBox msg={res.error} onRetry={res.reload} />;
  if (res.data === null) return <div className="empty">没有数据</div>;
  return (
    <>
      {/* 有旧数据时读失败不清屏，但要显式说「下面是旧的」，不能让人以为刚刷出来的就是现状 */}
      {res.error && <div style={{ marginBottom: 8 }}><ErrorBox msg={res.error} onRetry={res.reload} stale /></div>}
      {/* 换了筛选条件 / 翻了页时，下面暂时还是上一组结果。不加这个提示的话，
          屏幕上是「全部」的那几行，人却以为已经是「受理不明」的了。 */}
      <div style={{ opacity: res.loading ? 0.45 : 1, transition: 'opacity .12s' }} aria-busy={res.loading}>
        {res.loading && (
          <div className="note" style={{ marginBottom: 8 }} role="status">正在按新条件读取，下面暂时还是上一组结果…</div>
        )}
        {children(res.data)}
      </div>
    </>
  );
}

/* ── 确认 ────────────────────────────────────────────────── */

export interface ConfirmSpec {
  title: string;
  desc?: string;
  /** 回显：让人在按下去之前看清动的是哪一条 */
  echo?: { k: string; v: string }[];
  warn?: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
}

export function Confirm({ spec, onClose }: { spec: ConfirmSpec; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  // 打开后焦点进弹层、Esc 可退 —— 这里承载退款/上下架这类不可逆动作，
  // 只有 role="dialog" 不够。
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // 失败必须**在弹层里说出来**。原来只有 try/finally，onConfirm 抛出时错误会变成
  // 未处理的 promise rejection：弹层留在原地、busy 归位、界面一个字都不给 ——
  // 而这里承载的是会退款的动作，「没反应」和「已经做了」在操作者眼里分不开。
  const go = async () => {
    setBusy(true); setErr('');
    try {
      await spec.onConfirm();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '没做成，请稍后重试');
    } finally { setBusy(false); }
  };

  return (
    <div className="mask" onClick={() => !busy && onClose()}>
      <div
        className="dlg" role="dialog" aria-modal="true" aria-label={spec.title}
        tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}
      >
        <h2>{spec.title}</h2>
        {spec.desc && <p className="sub">{spec.desc}</p>}
        {spec.echo && spec.echo.length > 0 && (
          <div className="note" style={{ marginBottom: 10 }}>
            {spec.echo.map((r) => (
              <div key={r.k} style={{ display: 'flex', gap: 8 }}>
                <span style={{ color: 'var(--muted)', flex: 'none', minWidth: 52 }}>{r.k}</span>
                <b style={{ wordBreak: 'break-all' }}>{r.v}</b>
              </div>
            ))}
          </div>
        )}
        {spec.warn && <div className="err" style={{ marginBottom: 10 }}>{spec.warn}</div>}
        {err && <div className="err" style={{ marginBottom: 10 }} role="alert">没做成：{err}</div>}
        <div className="dlg-act">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button>
          <button
            type="button"
            className={`btn ${spec.danger ? 'danger' : 'primary'}`}
            disabled={busy}
            onClick={go}
          >{busy ? '处理中…' : (spec.confirmText ?? '确认')}</button>
        </div>
      </div>
    </div>
  );
}

/* ── 登录 ────────────────────────────────────────────────── */

export function Login({ onDone }: { onDone: () => void }) {
  const [username, setU] = useState('');
  const [password, setP] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) { setErr('账号和密码都要填'); return; }
    setBusy(true); setErr('');
    try {
      const r = await auth.login({ username: username.trim(), password });
      if (!r.token) throw new Error('服务端没有返回令牌');
      setToken(r.token);
      onDone();
    } catch (e2) {
      clearToken();
      setErr(e2 instanceof Error ? e2.message : '登录失败');
    } finally { setBusy(false); }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <h1>爱速拍 · 运营台</h1>
        {/* 说清楚用哪套账号：这里和军师后台共用账号中心，不是另一套密码 */}
        <p className="sub">用运营后台的同一个账号登录。需要「爱速拍」授权才进得来。</p>
        <label className="f">
          <span className="k">账号</span>
          <input className="i" autoComplete="username" value={username} onChange={(e) => setU(e.target.value)} />
        </label>
        <label className="f">
          <span className="k">密码</span>
          <input className="i" type="password" autoComplete="current-password" value={password} onChange={(e) => setP(e.target.value)} />
        </label>
        {err && <div className="err" style={{ marginBottom: 10 }}>{err}</div>}
        <button type="submit" className="btn primary lg" disabled={busy}>{busy ? '登录中…' : '登录'}</button>
      </form>
    </div>
  );
}

/* ── 小工具 ──────────────────────────────────────────────── */

export const fmtTime = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** 「多久之前」。对账时「卡了多久」比「几点扣的」更要紧。 */
export const since = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
};
