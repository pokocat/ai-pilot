import { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';
import { store } from '../services/store';
import { mobileHashUrl } from './mobile';
import { authReasonText, type AuthReason } from '../services/authGate';
import './Login.scss';

// PC 登录：手机号 + 短信验证码。与移动端 components/Login 同一套接口
// （api.sendSmsCode / api.login / store.afterLogin），只是换了桌面形态。
//
// 不做微信扫码：那需要开放平台「网站应用」资质，审核周期不可控。手机号登录服务端早就通了，
// 不该为一个还没有的资质卡住整个 PC 端。
//
// PC 是个人工作台，未登录时该组件以 required 形态独占首屏，不允许遮罩 / Esc / 关闭按钮退出。
// onClose 只保留给可能复用的非强制弹层形态；移动 H5 与小程序登录策略不受这里影响。

const PHONE_RE = /^1[3-9]\d{9}$/;

export default function Login({ reason, required = false, onClose }: {
  reason?: AuthReason;
  required?: boolean;
  onClose?: () => void;
}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setInterval>>();

  const phoneOk = PHONE_RE.test(phone);
  const codeOk = code.trim().length >= 4;

  useEffect(() => () => clearInterval(timer.current), []);

  useEffect(() => {
    if (required || !onClose) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, required]);

  const startCooldown = (sec: number) => {
    setCooldown(sec);
    clearInterval(timer.current);
    timer.current = setInterval(() => {
      setCooldown((n) => {
        if (n <= 1) { clearInterval(timer.current); return 0; }
        return n - 1;
      });
    }, 1000);
  };

  const sendCode = async () => {
    if (!phoneOk) { setError('请输入正确的手机号'); return; }
    if (cooldown > 0 || sending) return;
    setSending(true);
    setError('');
    try {
      const res = await api.sendSmsCode(phone, 'login');
      startCooldown(res.cooldownSec || 60);
      // 演示/预发环境直接回验证码，省一次手输。
      if (res.devCode) setCode(res.devCode);
    } catch (e) {
      setError((e as Error)?.message || '验证码发送失败，请稍后再试');
    } finally {
      setSending(false);
    }
  };

  const submit = async () => {
    if (!phoneOk) { setError('请输入正确的手机号'); return; }
    if (!codeOk) { setError('请输入短信验证码'); return; }
    if (!agreed) { setError('请先阅读并同意用户协议与隐私政策'); return; }
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.login(phone, undefined, code);
      await store.afterLogin(res.token, res.onboarded, res.user.benmingColor);
      onClose?.();
    } catch (e) {
      setError((e as Error)?.message || '登录失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`pc-login-mask${required ? ' pc-login-required' : ''}`} onClick={() => { if (!required) onClose?.(); }}>
      <div className="pc-login" role="dialog" aria-modal="true" aria-label="登录军师 PC 工作台" onClick={(e) => e.stopPropagation()}>
        {!required && onClose && <button type="button" className="pc-login-x" onClick={onClose} title="关闭（Esc）">✕</button>}

        <div className="pc-login-seal">军</div>
        <div className="pc-login-title">{required ? '登录军师工作台' : '请军师入帐'}</div>
        <div className="pc-login-sub">{required ? 'PC 版仅向已登录用户开放。登录后才能查看你的对话、案卷、军令与权益。' : authReasonText(reason)}</div>

        <div className="pc-login-field">
          <input
            className="pc-login-input"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
            onKeyDown={(e) => { if (e.key === 'Enter') void sendCode(); }}
            placeholder="手机号"
            inputMode="numeric"
            autoFocus
          />
        </div>

        <div className="pc-login-field">
          <input
            className="pc-login-input"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
            placeholder="短信验证码"
            inputMode="numeric"
          />
          <button
            type="button"
            className="pc-login-code"
            disabled={!phoneOk || cooldown > 0 || sending}
            onClick={() => void sendCode()}
          >
            {cooldown > 0 ? `${cooldown}s 后重发` : sending ? '发送中' : '获取验证码'}
          </button>
        </div>

        <button
          type="button"
          className="pc-login-submit"
          disabled={busy || !phoneOk || !codeOk}
          onClick={() => void submit()}
        >
          {busy ? '入帐中…' : '进 帐'}
        </button>

        <label className="pc-login-agree">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
          <span>
            我已阅读并同意
            <a href={mobileHashUrl('/packages/main/legal/index?doc=terms')} target="_blank" rel="noopener">《用户协议》</a>
            与
            <a href={mobileHashUrl('/packages/main/legal/index?doc=privacy')} target="_blank" rel="noopener">《隐私政策》</a>
          </span>
        </label>

        {error && <div className="pc-login-tip" style={{ color: 'var(--pc-danger)' }}>{error}</div>}

        <div className="pc-login-tip">
          账号与微信小程序「军师」通用：在哪一端登录，资料、案卷与方案都是同一份。
        </div>
      </div>
    </div>
  );
}
