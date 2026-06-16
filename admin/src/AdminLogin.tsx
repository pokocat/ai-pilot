import { useEffect, useState, type KeyboardEvent } from 'react';
import Icon from './Icon';
import { adminAuth, verifyAdminToken } from './api';
import { setAdminToken } from './auth';
import logo from './assets/logo.png';

// 运营后台登录：
//   - 未初始化 → 用主密钥（ADMIN_TOKEN）初始化一个管理员账号+密码（自动登录）。
//   - 已初始化 → 账号密码登录；另有「用密钥应急登录」入口（主密钥始终有效）。
type Mode = 'loading' | 'init' | 'login' | 'master';

export default function AdminLogin({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<Mode>('loading');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [masterKey, setMasterKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    adminAuth.status().then((s) => setMode(s.initialized ? 'login' : 'init')).catch(() => setMode('login'));
  }, []);

  const finish = (token: string) => { setAdminToken(token); onAuthed(); };

  const doInit = async () => {
    if (!/^[a-zA-Z0-9_.-]{2,40}$/.test(username.trim())) return setErr('账号仅限 2-40 位字母/数字/._-');
    if (password.length < 6) return setErr('密码至少 6 位');
    if (password !== confirm) return setErr('两次输入的密码不一致');
    if (!masterKey.trim()) return setErr('请输入主密钥（ADMIN_TOKEN）');
    setBusy(true); setErr('');
    const r = await adminAuth.init({ masterKey: masterKey.trim(), username: username.trim(), password });
    setBusy(false);
    if (r.ok && r.data && 'token' in r.data) return finish(r.data.token);
    setErr((r.data as { error?: string })?.error || '初始化失败，请检查主密钥');
  };

  const doLogin = async () => {
    if (!username.trim() || !password) return setErr('请输入账号与密码');
    setBusy(true); setErr('');
    const r = await adminAuth.login({ username: username.trim(), password });
    setBusy(false);
    if (r.ok && r.data && 'token' in r.data) return finish(r.data.token);
    setErr((r.data as { error?: string })?.error || '账号或密码错误');
  };

  const doMaster = async () => {
    const t = masterKey.trim();
    if (!t) return setErr('请输入管理员密钥');
    setBusy(true); setErr('');
    const ok = await verifyAdminToken(t);
    setBusy(false);
    if (ok) return finish(t);
    setErr('密钥无效或无权限');
  };

  const onEnter = (fn: () => void) => (e: KeyboardEvent) => { if (e.key === 'Enter') fn(); };

  return (
    <div className="screen">
      <div className="admin-login">
          <img className="al-mk" src={logo} alt="军师" />
          <div className="al-t">运营后台</div>
          <div className="al-s">JUNSHI · CONSOLE</div>

          {mode === 'loading' && <div className="al-card"><div className="al-note">加载中…</div></div>}

          {mode === 'init' && (
            <div className="al-card">
              <div className="al-label">初始化管理员账号</div>
              <input className="al-input" value={username} placeholder="设置账号（字母/数字/._-）" onChange={(e) => setUsername(e.target.value)} autoFocus />
              <input className="al-input" type="password" value={password} placeholder="设置密码（至少 6 位）" onChange={(e) => setPassword(e.target.value)} />
              <input className="al-input" type="password" value={confirm} placeholder="确认密码" onChange={(e) => setConfirm(e.target.value)} />
              <input className="al-input" type="password" value={masterKey} placeholder="主密钥 ADMIN_TOKEN" onChange={(e) => setMasterKey(e.target.value)} onKeyDown={onEnter(doInit)} />
              {err && <div className="al-err"><Icon name="alert" size={13} /> {err}</div>}
              <button className="al-btn" onClick={doInit} disabled={busy}><Icon name="check" size={15} /> {busy ? '初始化中…' : '初始化并进入'}</button>
              <div className="al-note">首次进入：用后端环境变量 ADMIN_TOKEN 验证身份，设置日常登录的账号密码。</div>
            </div>
          )}

          {mode === 'login' && (
            <div className="al-card">
              <div className="al-label">账号登录</div>
              <input className="al-input" value={username} placeholder="账号" onChange={(e) => setUsername(e.target.value)} autoFocus />
              <input className="al-input" type="password" value={password} placeholder="密码" onChange={(e) => setPassword(e.target.value)} onKeyDown={onEnter(doLogin)} />
              {err && <div className="al-err"><Icon name="alert" size={13} /> {err}</div>}
              <button className="al-btn" onClick={doLogin} disabled={busy}><Icon name="check" size={15} /> {busy ? '登录中…' : '登录'}</button>
              <div className="al-note" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => { setErr(''); setMode('master'); }}>用密钥应急登录</div>
            </div>
          )}

          {mode === 'master' && (
            <div className="al-card">
              <div className="al-label">管理员密钥</div>
              <input className="al-input" type="password" value={masterKey} placeholder="请输入 ADMIN_TOKEN" onChange={(e) => setMasterKey(e.target.value)} onKeyDown={onEnter(doMaster)} autoFocus />
              {err && <div className="al-err"><Icon name="alert" size={13} /> {err}</div>}
              <button className="al-btn" onClick={doMaster} disabled={busy}><Icon name="check" size={15} /> {busy ? '校验中…' : '应急登录'}</button>
              <div className="al-note" style={{ cursor: 'pointer', textDecoration: 'underline' }} onClick={() => { setErr(''); setMode('login'); }}>← 返回账号登录</div>
            </div>
          )}
        </div>
      </div>
  );
}
