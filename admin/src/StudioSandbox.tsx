// 调教沙盒（P2）：用「草稿 / 已发布版本」即时试跑一条测试消息，看产出 + 诊断指标。
// 这是「反复试」的核心：改了配置 → 这里立刻试 → 看 token/缓存/延迟/模拟扣额 → 满意再发布。
import { useState } from 'react';
import Icon from './Icon';
import { api, type SandboxResult, type SandboxTarget } from './api';
import { DeliverableView, ChatView } from './ui';

export default function StudioSandbox({ agentKey, draftDirty }: { agentKey: string; draftDirty: boolean }) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState<'draft' | 'published'>('draft');
  const [profile, setProfile] = useState({ industry: '', stage: '', pain: '' });
  const [showProfile, setShowProfile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SandboxResult | null>(null);
  const [err, setErr] = useState('');

  const run = async () => {
    if (!text.trim()) { setErr('请输入测试消息'); return; }
    setBusy(true); setErr(''); setResult(null);
    const hasProfile = profile.industry || profile.stage || profile.pain;
    try {
      const r = await api.sandbox(agentKey, {
        text: text.trim(),
        target: target as SandboxTarget,
        profile: hasProfile ? profile : undefined,
      });
      setResult(r);
    } catch (e) { setErr((e as Error)?.message || '试跑失败'); }
    setBusy(false);
  };

  return (
    <div className="ad-db">
      <div className="blk">
        <div className="blk-h"><Icon name="spark" size={15} /><span className="t">调教沙盒</span><span className="badge">不真扣额度</span></div>
        <div className="blk-d">用「草稿」或「已发布版本」即时试跑一条消息，看产出与诊断。沙盒用模拟客户上下文、不拉真实用户数据、不计入计费统计。</div>

        <div className="bill-seg">
          <div className={`bill-opt ${target === 'draft' ? 'on' : ''}`} onClick={() => setTarget('draft')}>
            <div className="bo-t">草稿{draftDirty ? ' ●' : ''}</div><div className="bo-d">你正在编辑的最新配置</div>
          </div>
          <div className={`bill-opt ${target === 'published' ? 'on' : ''}`} onClick={() => setTarget('published')}>
            <div className="bo-t">已发布</div><div className="bo-d">C 端用户当前实际用的版本</div>
          </div>
        </div>

        <div className="ai-field" style={{ marginTop: 8 }}>
          <div className="ai-fl">测试消息（模拟 C 端用户发的话）</div>
          <textarea className="ta" rows={3} value={text} placeholder="例如：我们是做社区生鲜的，最近复购在掉，帮我看看问题" onChange={(e) => setText(e.target.value)} />
        </div>

        <div className="var-row">
          <span className="var" onClick={() => setShowProfile((v) => !v)}>{showProfile ? '－ 收起模拟档案' : '＋ 模拟客户档案（可选）'}</span>
        </div>
        {showProfile && (
          <div className="cfg" style={{ marginTop: 6 }}>
            <div className="ai-field"><div className="ai-fl">行业</div><input className="ai-input" value={profile.industry} placeholder="社区生鲜零售" onChange={(e) => setProfile({ ...profile, industry: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">阶段</div><input className="ai-input" value={profile.stage} placeholder="A 轮 / 年营收 5000 万" onChange={(e) => setProfile({ ...profile, stage: e.target.value })} /></div>
            <div className="ai-field"><div className="ai-fl">最关注</div><input className="ai-input" value={profile.pain} placeholder="复购下滑、毛利承压" onChange={(e) => setProfile({ ...profile, pain: e.target.value })} /></div>
          </div>
        )}

        <button className="sv" style={{ marginTop: 10 }} onClick={run} disabled={busy}>
          <Icon name="spark" size={15} /> {busy ? '试跑中…' : `用${target === 'draft' ? '草稿' : '已发布版本'}试跑`}
        </button>
        {err && <div className="ai-test err" style={{ marginTop: 8 }}><Icon name="alert" size={13} /> {err}</div>}
      </div>

      {result && (
        <div className="blk">
          <div className="blk-h"><Icon name="insight" size={15} /><span className="t">试跑结果</span>
            <span className="badge">{result.source === 'draft' ? '草稿' : result.source === 'version' ? `v${result.versionNumber}` : `已发布 v${result.versionNumber ?? '-'}`}</span>
          </div>
          <div className="usage-summary">
            <div><b>{result.trace.latencyMs}ms</b><span>延迟</span></div>
            <div><b>{result.trace.totalTokens}</b><span>token</span></div>
            <div><b>{result.trace.cachedInput}</b><span>缓存命中</span></div>
            <div><b style={{ color: '#c98a2e' }}>{result.charged}</b><span>模拟扣额 ×{result.billingRatio}</span></div>
          </div>
          <div className="blk-d" style={{ margin: '4px 0 10px' }}>provider={result.trace.provider} / {result.trace.model} · 倍率 {result.billingRatio}（真实产出会按此扣月度额度）</div>
          {result.kind === 'report' && result.deliverable && <DeliverableView d={result.deliverable} />}
          {result.kind === 'chat' && result.reply && <ChatView r={result.reply} />}
        </div>
      )}
      <div style={{ height: 70 }} />
    </div>
  );
}
