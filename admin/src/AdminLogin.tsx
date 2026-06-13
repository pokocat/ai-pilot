import { useState } from 'react';
import Icon from './Icon';
import { verifyAdminToken } from './api';
import { setAdminToken } from './auth';

// 运营后台登录：填入管理员密钥（后端 ADMIN_TOKEN）。校验通过后写入登录态。
export default function AdminLogin({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    const t = token.trim();
    if (!t) {
      setErr('请输入管理员密钥');
      return;
    }
    setBusy(true);
    setErr('');
    const ok = await verifyAdminToken(t);
    setBusy(false);
    if (ok) {
      setAdminToken(t);
      onAuthed();
    } else {
      setErr('密钥无效或无权限，请重试');
    }
  };

  return (
    <div className="phone">
      <div className="screen">
        <div className="admin-login">
          <div className="al-mk">军</div>
          <div className="al-t">运营后台</div>
          <div className="al-s">JUNSHI · CONSOLE</div>
          <div className="al-card">
            <div className="al-label">管理员密钥</div>
            <input
              className="al-input"
              type="password"
              value={token}
              placeholder="请输入 ADMIN_TOKEN"
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              autoFocus
            />
            {err && <div className="al-err"><Icon name="alert" size={13} /> {err}</div>}
            <button className="al-btn" onClick={submit} disabled={busy}>
              <Icon name="check" size={15} /> {busy ? '校验中…' : '登录'}
            </button>
            <div className="al-note">密钥对应后端环境变量 ADMIN_TOKEN，仅运营持有；普通用户无法访问后台接口。</div>
          </div>
        </div>
      </div>
    </div>
  );
}
