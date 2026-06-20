// 评测（P5）：给 agent 建「黄金测试集」，跑草稿/已发布版本，LLM 评委逐条打分，汇总成客观分数。
// 分数 → 建议定价档位（旗舰/进阶/标准），让「调教越好卖越贵」从拍脑袋变成有据可依。
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { api, type EvalSetItem, type EvalSetDetail, type EvalRunItem, type EvalRunDetail, type SandboxTarget } from './api';
import { Loading, fmtTime, scoreColor } from './ui';

export default function StudioEval({ agentKey, toast }: { agentKey: string; toast: (m: string) => void }) {
  const [sets, setSets] = useState<EvalSetItem[] | null>(null);
  const [runs, setRuns] = useState<EvalRunItem[]>([]);
  const [sel, setSel] = useState<EvalSetDetail | null>(null);
  const [run, setRun] = useState<EvalRunDetail | null>(null);
  const [newName, setNewName] = useState('');
  const [target, setTarget] = useState<'draft' | 'published'>('draft');
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSets = () => api.evalSets(agentKey).then(setSets).catch(() => setSets([]));
  const loadRuns = () => api.evalRuns(agentKey).then(setRuns).catch(() => {});
  useEffect(() => { loadSets(); loadRuns(); return () => { if (poll.current) clearInterval(poll.current); }; }, [agentKey]);

  const openSet = (id: string) => api.evalSet(id).then(setSel).catch(() => {});

  const createSet = async () => {
    if (!newName.trim()) return;
    try { const s = await api.createEvalSet(agentKey, newName.trim()); setNewName(''); await loadSets(); openSet(s.id); }
    catch { toast('创建失败'); }
  };

  const startRun = async () => {
    if (!sel) return;
    setBusy(true);
    try {
      const { runId } = await api.startEvalRun(agentKey, { setId: sel.id, target: target as SandboxTarget });
      toast('已开始跑分，请稍候…');
      // 轮询直到 done/error
      if (poll.current) clearInterval(poll.current);
      const tick = async () => {
        const d = await api.evalRun(runId).catch(() => null);
        if (d) { setRun(d); if (d.status !== 'running') { if (poll.current) clearInterval(poll.current); loadRuns(); } }
      };
      await tick();
      poll.current = setInterval(tick, 2500);
    } catch (e) { toast((e as Error)?.message || '跑分失败'); }
    setBusy(false);
  };

  const openRun = (id: string) => { if (poll.current) clearInterval(poll.current); api.evalRun(id).then((d) => { setRun(d); if (d.status === 'running') { poll.current = setInterval(async () => { const x = await api.evalRun(id).catch(() => null); if (x) { setRun(x); if (x.status !== 'running' && poll.current) clearInterval(poll.current); } }, 2500); } }).catch(() => {}); };

  if (sets === null) return <Loading />;

  // —— 单个集合：用例编辑 + 跑分 + 结果 ——
  if (sel) {
    return (
      <div className="ad-db">
        <div className="blk">
          <div className="blk-h">
            <span className="bk" style={{ cursor: 'pointer' }} onClick={() => { setSel(null); setRun(null); }}><Icon name="arrow" size={16} /></span>
            <span className="t">{sel.name}</span><span className="badge">{sel.caseCount} 用例</span>
          </div>
          <CaseEditor set={sel} onChanged={() => openSet(sel.id)} toast={toast} />
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="spark" size={15} /><span className="t">跑分</span></div>
          <div className="blk-d">用 LLM 评委按每条用例的评分标准给被测版本打 0-10 分，加权汇总。需配置真实模型（mock 无法评分）。</div>
          <div className="bill-seg">
            {(['draft', 'published'] as const).map((t) => (
              <div key={t} className={`bill-opt ${target === t ? 'on' : ''}`} onClick={() => setTarget(t)}>
                <div className="bo-t">{t === 'draft' ? '测草稿' : '测已发布'}</div>
              </div>
            ))}
          </div>
          <button className="sv" style={{ marginTop: 10 }} disabled={busy || !sel.caseCount} onClick={startRun}><Icon name="spark" size={15} /> 开始跑分</button>
        </div>

        {run && <RunResult run={run} />}
        <div style={{ height: 70 }} />
      </div>
    );
  }

  // —— 集合列表 + 历史跑分 ——
  return (
    <div className="ad-db">
      <div className="blk">
        <div className="blk-h"><Icon name="doc" size={15} /><span className="t">黄金测试集</span></div>
        <div className="blk-d">把「好答案长什么样」固化成一组测试用例，调教后反复跑分，量化进步。</div>
        {sets.map((s) => (
          <div key={s.id} className="mem-card" onClick={() => openSet(s.id)} style={{ cursor: 'pointer' }}>
            <span className="mi"><Icon name="doc" size={16} /></span>
            <div className="mb"><div className="mt">{s.name}</div><div className="mm">{s.caseCount} 用例 · {fmtTime(s.createdAt)}</div></div>
            <Icon name="arrow" size={14} />
          </div>
        ))}
        <div className="add-row" style={{ marginTop: 8 }}>
          <input className="add-input" placeholder="新建测试集名称，如「战略诊断·黄金 10 题」" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createSet(); }} />
          <button className="add-btn" onClick={createSet}><Icon name="spark" size={15} /> 新建</button>
        </div>
      </div>

      {runs.length > 0 && (
        <div className="blk">
          <div className="blk-h"><Icon name="trend" size={15} /><span className="t">历史跑分</span></div>
          {runs.map((r) => (
            <div key={r.id} className="usage-row" style={{ cursor: 'pointer' }} onClick={() => openRun(r.id)}>
              <div className="usage-h">
                <div className="usage-name">{r.targetLabel ?? r.targetRef}<span>{r.caseCount} 用例 · {fmtTime(r.createdAt)}</span></div>
                <div className="usage-num" style={{ color: scoreColor(r.score) }}>{r.status === 'running' ? '跑分中…' : r.status === 'error' ? '失败' : r.score?.toFixed(1) ?? '-'}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ height: 70 }} />
    </div>
  );
}

function RunResult({ run }: { run: EvalRunDetail }) {
  return (
    <div className="blk">
      <div className="blk-h"><Icon name="insight" size={15} /><span className="t">跑分结果</span>
        <span className="badge">{run.targetLabel ?? run.targetRef}</span>
      </div>
      {run.status === 'running' && <div className="blk-d" style={{ padding: '6px 0' }}><Icon name="spark" size={13} /> 评委打分中… 已完成 {run.results.length} 条</div>}
      {run.status !== 'running' && (
        <div className="usage-summary">
          <div><b style={{ color: scoreColor(run.score), fontSize: 22 }}>{run.score?.toFixed(1) ?? '-'}</b><span>加权总分 /10</span></div>
          {run.suggested && <div><b>{run.suggested.tier.label} ×{run.suggested.tier.billingRatio}</b><span>建议档位</span></div>}
          <div><b>{run.caseCount}</b><span>用例数</span></div>
        </div>
      )}
      {run.note && <div className="blk-d" style={{ margin: '4px 0 8px' }}>{run.note}</div>}
      {run.suggested && run.status === 'done' && (
        <div className="ai-test ok" style={{ marginBottom: 8 }}>
          <Icon name="crown" size={13} /> 该版本得分 {run.score?.toFixed(1)} → 建议定价档位「{run.suggested.tier.label}」，即倍率 ×{run.suggested.tier.billingRatio}。到「配置」页把计费比例设为该值即可「调教越好卖越贵」。
        </div>
      )}
      {run.results.map((r) => (
        <div key={r.id} className="mem-card" style={{ alignItems: 'flex-start' }}>
          <span className="mi" style={{ color: scoreColor(r.judgeScore) }}><b>{r.judgeScore?.toFixed(1) ?? '-'}</b></span>
          <div className="mb">
            <div className="mt" style={{ fontWeight: 400 }}>{r.input.slice(0, 50)}{r.input.length > 50 ? '…' : ''}</div>
            <div className="mm">{r.judgeNote || '—'} · {r.inputTokens + r.outputTokens} token · {r.latencyMs}ms</div>
          </div>
        </div>
      ))}
    </div>
  );
}

// 用例增删（输入 + 评分标准 + 权重）。
function CaseEditor({ set, onChanged, toast }: { set: EvalSetDetail; onChanged: () => void; toast: (m: string) => void }) {
  const [input, setInput] = useState('');
  const [rubric, setRubric] = useState('');
  const [weight, setWeight] = useState(1);

  const add = async () => {
    if (!input.trim()) return;
    try { await api.addEvalCase(set.id, { input: input.trim(), rubric: rubric.trim() || undefined, weight }); setInput(''); setRubric(''); setWeight(1); onChanged(); }
    catch (e) { toast((e as Error)?.message || '添加失败'); }
  };
  const del = async (id: string) => { try { await api.delEvalCase(id); onChanged(); } catch { toast('删除失败'); } };

  return (
    <>
      {set.cases.map((c, i) => (
        <div key={c.id} className="mem-card" style={{ alignItems: 'flex-start' }}>
          <span className="mi">{i + 1}</span>
          <div className="mb">
            <div className="mt" style={{ fontWeight: 400 }}>{c.input}</div>
            <div className="mm">{c.rubric ? `标准：${c.rubric}` : '（无评分标准）'} · 权重 {c.weight}</div>
          </div>
          <button className="gh" style={{ width: 'auto', padding: '0 10px' }} onClick={() => del(c.id)}>删</button>
        </div>
      ))}
      {!set.cases.length && <div className="blk-d" style={{ padding: '6px 0' }}>还没有用例。在下面添加第一条。</div>}
      <div className="ai-field" style={{ marginTop: 8 }}><div className="ai-fl">用例输入（模拟用户消息）</div><textarea className="ta" rows={2} value={input} onChange={(e) => setInput(e.target.value)} /></div>
      <div className="ai-field"><div className="ai-fl">评分标准（给评委：好答案长什么样，可选）</div><textarea className="ta" rows={2} value={rubric} onChange={(e) => setRubric(e.target.value)} placeholder="如：必须给出 3 个 MECE 卡点 + 30 天可执行动作" /></div>
      <button className="mini-btn primary" onClick={add}><Icon name="spark" size={13} /> 添加用例</button>
    </>
  );
}
