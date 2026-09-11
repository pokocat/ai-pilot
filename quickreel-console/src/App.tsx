// 爱速拍 · 运营台。
//
// **独立于军师运营后台。** 2026-09-11 这四屏一度做在军师后台里，当天撤掉了 ——
// 两个产品挤一个控制台，军师那边是 30 屏，爱速拍的四屏混在里面谁也找不着。
// 现在各是各的：独立 URL（/quickreel/）、独立导航、独立配色。
//
// 共用的只有两样，都是刻意的：
//   · 账号 —— 账号中心是一个，不给爱速拍再造一套登录和一张权限表
//   · 服务端 —— /admin/video/* 那九条接口，跑在军师 BFF 里（爱速拍本来就没有自己的服务端）
//
// 谁进得来：服务端要 quickreel 授权（services/adminProductGate.ts），
// 授权在军师后台「经营 · 产品」里发。超管隐式拥有全部产品。
import { useCallback, useEffect, useState } from 'react';
import { auth, clearToken, getToken, Unauthorized, type AdminMe } from './api';
import { Login } from './components';
import { OpsView } from './views/ops';
import { TemplatesView } from './views/templates';
import { PricingView } from './views/pricing';
import { VendorView } from './views/vendor';
import './styles.css';

type Tab = 'ops' | 'templates' | 'pricing' | 'vendor';

// 顺序 = 值班动线：先看钱有没有卡住，再看货架，再是价，最后才是供应商（最少看）。
const TABS: { k: Tab; t: string }[] = [
  { k: 'ops', t: '出片对账' },
  { k: 'templates', t: '模板货架' },
  { k: 'pricing', t: '定价' },
  { k: 'vendor', t: '供应商' },
];

const readTab = (): Tab => {
  const h = window.location.hash.replace(/^#\/?/, '');
  return TABS.some((x) => x.k === h) ? (h as Tab) : 'ops';
};

export default function App() {
  const [authed, setAuthed] = useState(() => !!getToken());
  const [me, setMe] = useState<AdminMe | null>(null);
  const [denied, setDenied] = useState('');
  const [tab, setTab] = useState<Tab>(readTab);
  const [toast, setToast] = useState('');

  useEffect(() => {
    const onHash = () => setTab(readTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (k: Tab) => { window.location.hash = `#/${k}`; setTab(k); };

  const onAuthLost = useCallback(() => { clearToken(); setAuthed(false); setMe(null); }, []);

  const say = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((cur) => (cur === m ? '' : cur)), 4000);
  }, []);

  // 登录后先拿一次 me：既确认令牌还有效，也决定哪些动作显示得出来。
  useEffect(() => {
    if (!authed) return;
    let alive = true;
    auth.me().then(
      (v) => { if (alive) { setMe(v); setDenied(''); } },
      (e: unknown) => {
        if (!alive) return;
        if (e instanceof Unauthorized) { onAuthLost(); return; }
        // 401 之外的失败（比如没有 quickreel 授权时的 403）要说清楚是哪一种，
        // 不能把人踢回登录页 —— 他账号没问题，是没被授权，再登一次也一样。
        setDenied(e instanceof Error ? e.message : '进不来');
      },
    );
    return () => { alive = false; };
  }, [authed, onAuthLost]);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  if (denied) {
    return (
      <div className="login">
        <div className="login-card">
          <h1>进不来</h1>
          <p className="sub">{denied}</p>
          <div className="note" style={{ marginBottom: 14 }}>
            这个台要「爱速拍」产品授权。账号本身没问题 —— 再登一次也一样，
            得让超管在军师运营后台的「经营 · 产品」里给你发一个授权。
          </div>
          <button type="button" className="btn lg" onClick={() => { clearToken(); setAuthed(false); setDenied(''); }}>
            换个账号登录
          </button>
        </div>
      </div>
    );
  }

  const isSuper = !!me?.isSuper;

  return (
    <div className="shell">
      <header className="top">
        <div className="brand">
          <b>爱速拍</b>
          <span>QUICKREEL · OPS</span>
        </div>
        {me && <span className="who">{me.username}{isSuper ? ' · 超管' : ''}</span>}
        <button
          type="button" className="btn"
          onClick={() => { auth.logout(); clearToken(); setAuthed(false); setMe(null); }}
        >退出</button>
      </header>

      <nav className="tabs" aria-label="分区">
        {TABS.map((x) => (
          <button
            key={x.k} type="button"
            className={`tab ${tab === x.k ? 'on' : ''}`}
            aria-current={tab === x.k ? 'page' : undefined}
            onClick={() => go(x.k)}
          >{x.t}</button>
        ))}
      </nav>

      <main className="main">
        <div className="wrap">
          {/* me 还没回来时不渲染各屏：isSuper 未知的话，写操作按钮会先以只读态闪一下再变 */}
          {!me ? <div className="empty">加载中…</div> : (
            <>
              {tab === 'ops' && <OpsView toast={say} isSuper={isSuper} onAuthLost={onAuthLost} />}
              {tab === 'templates' && <TemplatesView toast={say} isSuper={isSuper} onAuthLost={onAuthLost} />}
              {tab === 'pricing' && <PricingView toast={say} isSuper={isSuper} onAuthLost={onAuthLost} />}
              {tab === 'vendor' && <VendorView onAuthLost={onAuthLost} />}
            </>
          )}
        </div>
      </main>

      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
