import { useEffect, useState } from 'react';
import Icon from './Icon';
import { api, type AgentDetail, type AgentBilling, type MemoryConfig, type MemoryIntensity, type MemorySource } from './api';

const VARS = ['{企业档案}', '{行业基准}', '{长期记忆}', '{本命色}'];
const INTENSITY = [['conservative', '保守'], ['balanced', '均衡'], ['aggressive', '激进']];
const RETENTION = [[30, '30天'], [180, '180天'], [-1, '永久']];
const BILLING: [AgentBilling, string, string][] = [
  ['free', '免费', '注册即赠送 · 所有用户可用'],
  ['unlock', '一次性解锁', '用算力购买后永久可用 / 后台可指定开通'],
  ['metered', '按次计费', '无需解锁，每次产出消耗算力（如图片生成）'],
];
const SOURCES = [
  ['conversation', '对话记忆', '从历史会话提炼 · 已沉淀 128 条', 'chat'],
  ['document', '企业资料（可选投喂）', '客户补充的背景资料 · 24 份', 'doc'],
  ['deliverable_feedback', '产出反馈', '采纳 / 修改 / 忽略 信号回流', 'chart'],
];

// 顾问详情：基础信息 + 计费/价格 + System 提示词 + Agent Memory（持续学习）配置。
export default function AgentDetailPanel({ agentKey, onClose, onSaved }: { agentKey: string; onClose: () => void; onSaved: () => void }) {
  const [data, setData] = useState<AgentDetail | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [billing, setBilling] = useState<AgentBilling>('free');
  const [price, setPrice] = useState(0);
  const [prompt, setPrompt] = useState('');
  const [mem, setMem] = useState<MemoryConfig | null>(null);

  useEffect(() => {
    api.agent(agentKey).then((d) => {
      setData(d);
      setName(d.name); setRole(d.role);
      setBilling(d.billing); setPrice(d.price);
      setPrompt(d.systemPrompt);
      setMem(d.memoryConfig);
    }).catch(() => {});
  }, [agentKey]);

  if (!data || !mem) return null;

  const insertVar = (v: string) => setPrompt((p) => (p.endsWith('\n') || !p ? p : p + ' ') + v);
  const toggleSource = (s: MemorySource) =>
    setMem((m) => m && ({ ...m, sources: m.sources.includes(s) ? m.sources.filter((x) => x !== s) : [...m.sources, s] }));

  const save = () => api.saveAgent(agentKey, {
    name, role, gift: billing === 'free', billing,
    price: billing === 'free' ? 0 : Math.max(0, Math.trunc(price)),
    systemPrompt: prompt, memoryConfig: mem,
  }).then(onSaved).catch(() => {});

  return (
    <div className="ad-detail show">
      <div className="ad-dh">
        <div className="bk" onClick={onClose}><Icon name="arrow" size={18} /></div>
        <div className="di"><Icon name={data.icon} size={18} /></div>
        <div className="dt"><div className="t">{data.name}</div><div className="s">{data.deliverableKey ? `产出 · ${data.deliverableKey}` : data.role}</div></div>
      </div>

      <div className="ad-db">
        <div className="blk">
          <div className="blk-h"><Icon name="agent" size={15} /><span className="t">基础信息</span></div>
          <div className="ai-field"><div className="ai-fl">名称</div><input className="ai-input" value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="ai-field"><div className="ai-fl">一句话定位</div><input className="ai-input" value={role} onChange={(e) => setRole(e.target.value)} /></div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="crown" size={15} /><span className="t">计费与定价</span><span className="badge">{billingLabel(billing)}</span></div>
          <div className="blk-d">控制这位智能体是注册赠送、付费解锁，还是按次计费（如图片生成类）。价格单位为「算力次数」。</div>
          <div className="bill-seg">
            {BILLING.map(([v, l, d]) => (
              <div key={v} className={`bill-opt ${billing === v ? 'on' : ''}`} onClick={() => { setBilling(v); if (v === 'free') setPrice(0); }}>
                <div className="bo-t">{l}</div><div className="bo-d">{d}</div>
              </div>
            ))}
          </div>
          {billing !== 'free' && (
            <div className="ai-field">
              <div className="ai-fl">{billing === 'unlock' ? '解锁价格（算力次数）' : '每次产出消耗（算力次数）'}</div>
              <input className="ai-input" type="number" min={0} value={price} onChange={(e) => setPrice(Number(e.target.value))} />
            </div>
          )}
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="pen" size={15} /><span className="t">System 提示词</span><span className="badge">可优化</span></div>
          <div className="blk-d">定义这位顾问的角色、产出结构与语气。变量会在运行时注入企业档案与记忆。</div>
          <textarea className="ta" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={9} />
          <div className="var-row">
            {VARS.map((v) => <span key={v} className="var" onClick={() => insertVar(v)}>＋ {v}</span>)}
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="layers" size={15} /><span className="t">Agent Memory · 持续学习</span></div>
          <div className="blk-d">控制这位顾问如何从对话与企业资料中学习、沉淀长期记忆，越用越懂客户。</div>
          <div className="cfg">
            <div className="cfg-row">
              <div className="cb"><div className="ct">开启长期记忆</div><div className="cs">跨会话记住客户的偏好、结论与口径</div></div>
              <div className={`sw ${mem.longTerm ? 'on' : ''}`} onClick={() => setMem({ ...mem, longTerm: !mem.longTerm })}><i /></div>
            </div>
            <div className="cfg-row">
              <div className="cb"><div className="ct">从对话中自动学习</div><div className="cs">每次对话后提炼要点，写入长期记忆</div></div>
              <div className={`sw ${mem.autoLearn ? 'on' : ''}`} onClick={() => setMem({ ...mem, autoLearn: !mem.autoLearn })}><i /></div>
            </div>
            <div className="cfg-row">
              <div className="cb"><div className="ct">学习强度</div><div className="cs">更高更敏感，但也更易受单次对话影响</div></div>
              <div className="seg">{INTENSITY.map(([v, l]) => <b key={v} className={mem.intensity === v ? 'on' : ''} onClick={() => setMem({ ...mem, intensity: v as MemoryIntensity })}>{l}</b>)}</div>
            </div>
            <div className="cfg-row">
              <div className="cb"><div className="ct">记忆留存</div><div className="cs">超出时长的低价值记忆自动淡化</div></div>
              <div className="seg">{RETENTION.map(([v, l]) => <b key={v} className={mem.retentionDays === v ? 'on' : ''} onClick={() => setMem({ ...mem, retentionDays: v as number })}>{l}</b>)}</div>
            </div>
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="insight" size={15} /><span className="t">记忆来源</span><span className="badge">{mem.sources.length} 路</span></div>
          <div className="mem-list">
            {SOURCES.map(([key, t, m, ic]) => (
              <div key={key} className="mem-card">
                <span className="mi"><Icon name={ic} size={16} /></span>
                <div className="mb"><div className="mt">{t}</div><div className="mm">{m}</div></div>
                <div className={`sw ${mem.sources.includes(key as MemorySource) ? 'on' : ''}`} onClick={() => toggleSource(key as MemorySource)}><i /></div>
              </div>
            ))}
          </div>
          <div className="mem-meter"><i style={{ width: '62%' }} /></div>
          <div className="blk-d" style={{ margin: '9px 0 0' }}>记忆成熟度 62% · 随使用持续提升</div>
        </div>
        <div style={{ height: 70 }} />
      </div>

      <div className="save-bar">
        <button className="gh" onClick={() => { setPrompt(data.systemPrompt); }}><Icon name="clock" size={16} /></button>
        <button className="sv" onClick={save}><Icon name="check" size={16} /> 保存配置</button>
      </div>
    </div>
  );
}

function billingLabel(b: AgentBilling) {
  return b === 'free' ? '免费赠送' : b === 'unlock' ? '付费解锁' : '按次计费';
}
