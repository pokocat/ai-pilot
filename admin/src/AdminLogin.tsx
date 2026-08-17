import { useCallback, useEffect, useState } from 'react';
import Icon from './Icon';
import { adminAuth, verifyAdminToken } from './api';
import { setAdminToken } from './auth';
import logo from './assets/logo.png';

// 运营后台登录：状态探测、初始化、日常登录、主密钥应急登录四条路径必须各自有完整反馈。
type Mode = 'loading' | 'status-error' | 'init' | 'login' | 'master';

export default function AdminLogin({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<Mode>('loading');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [masterKey, setMasterKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const loadStatus = useCallback(() => {
    setMode('loading');
    setErr('');
    adminAuth.status()
      .then((s) => setMode(s.initialized ? 'login' : 'init'))
      .catch((e) => {
        setErr((e as Error)?.message || '无法连接后台服务');
        setMode('status-error');
      });
  }, []);
  useEffect(loadStatus, [loadStatus]);

  const finish = (token: string) => { setAdminToken(token); onAuthed(); };

  const doInit = async () => {
    if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(username.trim())) return setErr('账号仅限 2-40 位字母/数字/._-');
    if (password.length < 6) return setErr('密码至少 6 位');
    if (password !== confirm) return setErr('两次输入的密码不一致');
    if (!masterKey.trim()) return setErr('请输入主密钥（ADMIN_TOKEN）');
    setBusy(true); setErr('');
    try {
      const r = await adminAuth.init({ masterKey: masterKey.trim(), username: username.trim(), password });
      if (r.ok && r.data && 'token' in r.data) return finish(r.data.token);
      setErr((r.data as { error?: string })?.error || '初始化失败，请检查主密钥');
    } catch (e) {
      setErr((e as Error)?.message || '初始化失败，请检查网络后重试');
    } finally { setBusy(false); }
  };

  const doLogin = async () => {
    if (!username.trim() || !password) return setErr('请输入账号与密码');
    setBusy(true); setErr('');
    try {
      const r = await adminAuth.login({ username: username.trim(), password });
      if (r.ok && r.data && 'token' in r.data) return finish(r.data.token);
      setErr((r.data as { error?: string })?.error || '账号或密码错误');
    } catch (e) {
      setErr((e as Error)?.message || '登录失败，请检查网络后重试');
    } finally { setBusy(false); }
  };

  const doMaster = async () => {
    const t = masterKey.trim();
    if (!t) return setErr('请输入管理员密钥');
    setBusy(true); setErr('');
    try {
      const ok = await verifyAdminToken(t);
      if (ok) return finish(t);
      setErr('密钥无效或无权限');
    } catch (e) {
      setErr((e as Error)?.message || '校验失败，请检查网络后重试');
    } finally { setBusy(false); }
  };

  return (
    <div className="screen">
      <div className="admin-login">
        <img className="al-mk" src={logo} alt="军师" />
        <div className="al-t">运营后台</div>
        <div className="al-s">JUNSHI · CONSOLE</div>

        {mode === 'loading' && <div className="al-card" role="status"><div className="al-note">正在确认后台状态…</div></div>}

        {mode === 'status-error' && (
          <div className="al-card">
            <div className="al-label">后台暂时无法连接</div>
            <div className="al-err" role="alert"><Icon name="alert" size={13} /> {err}</div>
            <button type="button" className="al-btn" onClick={loadStatus}><Icon name="refresh" size={15} /> 重新连接</button>
            <div className="al-note">连接恢复后会自动判断进入初始化还是日常登录，不会把接口失败误判成已有账号。</div>
          </div>
        )}

        {mode === 'init' && (
          <form className="al-card" onSubmit={(e) => { e.preventDefault(); doInit(); }}>
            <div className="al-label">初始化管理员账号</div>
            <input className="al-input" value={username} aria-label="设置账号" autoComplete="username" placeholder="设置账号（字母/数字/._-）" onChange={(e) => setUsername(e.target.value)} autoFocus />
            <input className="al-input" type="password" value={password} aria-label="设置密码" autoComplete="new-password" placeholder="设置密码（至少 6 位）" onChange={(e) => setPassword(e.target.value)} />
            <input className="al-input" type="password" value={confirm} aria-label="确认密码" autoComplete="new-password" placeholder="确认密码" onChange={(e) => setConfirm(e.target.value)} />
            <input className="al-input" type="password" value={masterKey} aria-label="主密钥" placeholder="主密钥 ADMIN_TOKEN" onChange={(e) => setMasterKey(e.target.value)} />
            {err && <div className="al-err" role="alert"><Icon name="alert" size={13} /> {err}</div>}
            <button type="submit" className="al-btn" disabled={busy}><Icon name="check" size={15} /> {busy ? '初始化中…' : '初始化并进入'}</button>
            <div className="al-note">首次进入：用后端环境变量 ADMIN_TOKEN 验证身份，设置日常登录的账号密码。</div>
          </form>
        )}

        {mode === 'login' && (
          <form className="al-card" onSubmit={(e) => { e.preventDefault(); doLogin(); }}>
            <div className="al-label">账号登录</div>
            <input className="al-input" value={username} aria-label="账号" autoComplete="username" placeholder="账号" onChange={(e) => setUsername(e.target.value)} autoFocus />
            <input className="al-input" type="password" value={password} aria-label="密码" autoComplete="current-password" placeholder="密码" onChange={(e) => setPassword(e.target.value)} />
            {err && <div className="al-err" role="alert"><Icon name="alert" size={13} /> {err}</div>}
            <button type="submit" className="al-btn" disabled={busy}><Icon name="check" size={15} /> {busy ? '登录中…' : '登录'}</button>
            <button type="button" className="al-link" onClick={() => { setErr(''); setMode('master'); }}>用密钥应急登录</button>
          </form>
        )}

        {mode === 'master' && (
          <form className="al-card" onSubmit={(e) => { e.preventDefault(); doMaster(); }}>
            <div className="al-label">管理员密钥</div>
            <input className="al-input" type="password" value={masterKey} aria-label="管理员密钥" placeholder="请输入 ADMIN_TOKEN" onChange={(e) => setMasterKey(e.target.value)} autoFocus />
            {err && <div className="al-err" role="alert"><Icon name="alert" size={13} /> {err}</div>}
            <button type="submit" className="al-btn" disabled={busy}><Icon name="check" size={15} /> {busy ? '校验中…' : '应急登录'}</button>
            <button type="button" className="al-link" onClick={() => { setErr(''); setMode('login'); }}>← 返回账号登录</button>
          </form>
        )}
      </div>
    </div>
  );
}
