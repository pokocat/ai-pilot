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
import { api, auth, clearToken, Forbidden, getToken, setUnauthorizedHandler, Unauthorized, type AdminMe } from './api';
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
  const [failed, setFailed] = useState('');
  const [tab, setTab] = useState<Tab>(readTab);
  const [toast, setToast] = useState('');

  useEffect(() => {
    const onHash = () => setTab(readTab());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (k: Tab) => { window.location.hash = `#/${k}`; setTab(k); };

  const onAuthLost = useCallback(() => { clearToken(); setAuthed(false); setMe(null); setDenied(''); }, []);

  // 令牌失效的**唯一**出口。写请求（查单 / 上下架 / 改价）是在确认弹层里直接调的，
  // 没有 useResource 那条链路 —— 不挂全局钩子的话，令牌过期后点「保存」只会把 token
  // 悄悄删掉、界面照常显示，运营会接着白点好几下才发现。
  useEffect(() => {
    setUnauthorizedHandler(onAuthLost);
    return () => setUnauthorizedHandler(null);
  }, [onAuthLost]);

  const say = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((cur) => (cur === m ? '' : cur)), 4000);
  }, []);

  // 登录后先拿一次 me（确认令牌有效 + 决定写操作显不显示），再探一次真正受 quickreel 闸
  // 保护的接口来判准入。
  //
  // **不能只靠 auth.me()**：`/admin/auth` 在 adminProductGate 的 SHARED 白名单里
  // （账号中心是共享面，按产品切开会变成「改不了自己的密码」），所以没有 quickreel 授权的人
  // me() 也是 200 —— 原来的 denied 分支因此是死代码，那种人会进到四屏、每屏各弹一个 403。
  // 反过来，me() 的网络错/5xx 会掉进 denied，被解释成「你没有授权、再登也一样」，
  // 于是服务挂了运营却去找超管要权限。两个方向都错，所以改成探一条真闸接口，
  // 且只有**确认的 403** 才算没授权。
  useEffect(() => {
    if (!authed) return;
    let alive = true;
    (async () => {
      try {
        const v = await auth.me();
        if (!alive) return;
        setMe(v);
        // 最轻的一条受闸读接口。超管隐式拥有全部产品，这里必然通过。
        await api.ops(7);
        if (alive) setDenied('');
      } catch (e) {
        if (!alive) return;
        if (e instanceof Unauthorized) return;      // 全局钩子已经把人送回登录页
        if (e instanceof Forbidden) { setDenied(e.message); return; }
        // 网络错 / 5xx：是服务的问题，不是授权的问题，文案必须分开
        setFailed(e instanceof Error ? e.message : '读不到');
      }
    })();
    return () => { alive = false; };
  }, [authed, onAuthLost]);

  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  // 服务读不到 ≠ 没授权。混成一个文案的话，服务挂了运营会去找超管要权限。
  if (failed) {
    return (
      <div className="login">
        <div className="login-card">
          <h1>读不到</h1>
          <p className="sub">{failed}</p>
          <div className="note" style={{ marginBottom: 14 }}>
            这不是权限问题 —— 多半是服务端或它上游（出片服务）这会儿不通。稍等再试；一直这样就去看服务状态。
          </div>
          <button type="button" className="btn lg" onClick={() => { setFailed(''); window.location.reload(); }}>重试</button>
        </div>
      </div>
    );
  }

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
