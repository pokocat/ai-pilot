import { useEffect, useState } from 'react';
import Icon from './Icon';
import { api, type Overview, type Saying, type AdminAgent, type AgentDetail, type SurveyQ, type Plan } from './api';
import AgentDetailPanel from './AgentDetailPanel';

type Tab = 'home' | 'say' | 'agent' | 'form' | 'plan';
const TABS: { key: Tab; icon: string; label: string }[] = [
  { key: 'home', icon: 'chart', label: '概览' },
  { key: 'say', icon: 'spark', label: '献策' },
  { key: 'agent', icon: 'agent', label: '顾问' },
  { key: 'form', icon: 'doc', label: '问卷' },
  { key: 'plan', icon: 'crown', label: '套餐' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('home');
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [toast, setToast] = useState('');

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 1800); };

  return (
    <div className="phone">
      <div className="screen">
        <div className="adm-top">
          <div className="adm-mk">军</div>
          <div className="adm-tt"><div className="t">运营后台</div><div className="s">JUNSHI · CONSOLE</div></div>
          <div className="adm-av">运营</div>
        </div>

        <div className="adm-scroll">
          {tab === 'home' && <OverviewView />}
          {tab === 'say' && <SayingsView toast={showToast} />}
          {tab === 'agent' && <AgentsView onOpen={setDetailKey} />}
          {tab === 'form' && <SurveyView />}
          {tab === 'plan' && <PlansView />}
        </div>

        <nav className="adm-tab">
          {TABS.map((t) => (
            <div key={t.key} className={`at ${tab === t.key ? 'on' : ''}`} onClick={() => setTab(t.key)}>
              <Icon name={t.icon} size={20} />
              <span>{t.label}</span>
            </div>
          ))}
        </nav>

        {detailKey && (
          <AgentDetailPanel
            agentKey={detailKey}
            onClose={() => setDetailKey(null)}
            onSaved={() => { setDetailKey(null); showToast('配置已保存并下发'); }}
          />
        )}

        {toast && <div className="admin-toast show"><Icon name="check" size={14} />{toast}</div>}
      </div>
    </div>
  );
}

function OverviewView() {
  const [data, setData] = useState<Overview | null>(null);
  useEffect(() => { api.overview().then(setData).catch(() => {}); }, []);
  if (!data) return <Loading />;
  return (
    <>
      <div className="sec-h"><span className="t">今日概览</span><span className="s">实时</span></div>
      <div className="pad">
        <div className="stats">
          {data.stats.map((s) => (
            <div key={s.l} className="stat">
              <div className="v">{s.v}</div>
              <div className="l">{s.l}</div>
              <div className={`d ${s.trend}`}><Icon name={s.trend === 'up' ? 'up' : 'trend'} size={12} />{s.d}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="sec-h"><span className="t">近期动态</span><span className="s">运营事件</span></div>
      <div className="pad">
        <div className="feed">
          {data.feed.map((f, i) => (
            <div key={i} className="fr">
              <span className="fi"><Icon name={f.icon} size={16} /></span>
              <div className="fb"><div className="ft">{f.t}</div><div className="fm">{f.m}</div></div>
              <span className="fv">{f.v}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function SayingsView({ toast }: { toast: (m: string) => void }) {
  const [list, setList] = useState<Saying[]>([]);
  const [adding, setAdding] = useState('');
  const load = () => api.sayings().then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  const strip = (s: string) => s.replace(/<[^>]+>/g, '');
  return (
    <>
      <div className="sec-h"><span className="t">每日献策库</span><span className="s">每日 08:00 随机推一条</span></div>
      <div className="pad">
        {list.map((s) => (
          <div key={s.id} className={`say-row ${s.pushedDate ? 'say-today' : ''}`}>
            <span className="grip"><Icon name="layers" size={15} /></span>
            <div className="sb"><div className="stx">{strip(s.text)}</div><div className="smeta">{s.enabled ? '已启用 · 排期池' : '已停用'}</div></div>
            <div className={`sw ${s.enabled ? 'on' : ''}`} onClick={() => api.toggleSaying(s.id, !s.enabled).then(load)}><i /></div>
          </div>
        ))}
        <div className="add-row">
          <input className="add-input" placeholder="新增一条献策（可用 <em> 强调）" value={adding} onChange={(e) => setAdding(e.target.value)} />
          <button className="add-btn" onClick={() => { if (adding.trim()) api.addSaying(adding.trim()).then(() => { setAdding(''); load(); toast('已新增献策'); }); }}>
            <Icon name="spark" size={15} /> 新增
          </button>
        </div>
      </div>
    </>
  );
}

function AgentsView({ onOpen }: { onOpen: (k: string) => void }) {
  const [list, setList] = useState<AdminAgent[]>([]);
  useEffect(() => { api.agents().then(setList).catch(() => {}); }, []);
  return (
    <>
      <div className="sec-h"><span className="t">内置顾问</span><span className="s">入驻赠送 · 可配置产出</span></div>
      <div className="pad">
        {list.map((a) => (
          <div key={a.key} className="crd" onClick={() => onOpen(a.key)}>
            <div className="crd-row">
              <span className="crd-ic"><Icon name={a.icon} size={18} /></span>
              <div className="crd-b">
                <div className="ct">{a.name} {a.gift && <span className="tag">赠送</span>} {!a.enabled && <span className="tag off">停用</span>}</div>
                <div className="cs">{a.deliverableKey ? `产出 · ${a.deliverableKey}` : a.role} · {typeLabel(a.type)}</div>
              </div>
              <span className="edit"><Icon name="pen" size={15} /></span>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function SurveyView() {
  const [list, setList] = useState<SurveyQ[]>([]);
  useEffect(() => { api.survey().then(setList).catch(() => {}); }, []);
  return (
    <>
      <div className="sec-h"><span className="t">首登建档问卷</span><span className="s">用于个性化产出</span></div>
      <div className="pad">
        {list.map((q, i) => (
          <div key={q.id} className="q-card">
            <div className="q-h"><span className="no">{i + 1}</span><span className="qt">{q.title}</span><span className="key">{q.key}</span></div>
            <div className="opts">
              {q.optionsJson.map((o) => <span key={o} className="opt">{o}</span>)}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function PlansView() {
  const [list, setList] = useState<Plan[]>([]);
  useEffect(() => { api.plans().then(setList).catch(() => {}); }, []);
  const price = (p: Plan) => p.price < 0 ? '面议' : p.price === 0 ? '¥0' : `¥${(p.price / 100).toLocaleString()}${p.period === 'year' ? '/年' : '/月'}`;
  return (
    <>
      <div className="sec-h"><span className="t">套餐与算力</span><span className="s">定价 · 算力规则</span></div>
      <div className="pad">
        {list.map((p) => (
          <div key={p.id} className={`plan ${p.highlighted ? 'feat' : ''}`}>
            <div className="plan-h">
              <span className="pn">{p.name}</span>
              {p.highlighted && <span className="tag">最受欢迎</span>}
              <span className="pp">{price(p)}</span>
            </div>
            <div className="plan-meta">{p.featuresJson.join(' · ')}</div>
            <button className="plan-edit"><Icon name="pen" size={13} /> 编辑套餐</button>
          </div>
        ))}
      </div>
    </>
  );
}

function typeLabel(t: string) { return t === 'advisory' ? '出谋' : t === 'creative' ? '出活' : '通用'; }
function Loading() { return <div className="pad" style={{ padding: 40, textAlign: 'center', color: '#969BA1' }}>加载中…</div>; }
