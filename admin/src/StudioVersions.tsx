// 版本历史（P3）：查看每个版本的变更摘要 / 倍率 / 发布人，回滚到任意历史版本。
// C 端只读「已发布」版本；草稿改动需在「配置」页点「发布新版本」才对用户生效。
import { useEffect, useState } from 'react';
import Icon from './Icon';
import { api, type AgentVersionListView } from './api';
import { Loading, fmtTime } from './ui';

export default function StudioVersions({ agentKey, onChanged, toast }: { agentKey: string; onChanged: () => void; toast: (m: string) => void }) {
  const [data, setData] = useState<AgentVersionListView | null>(null);
  const [busy, setBusy] = useState('');
  const load = () => api.agentVersions(agentKey).then(setData).catch(() => {});
  useEffect(() => { load(); }, [agentKey]);
  if (!data) return <Loading />;

  const rollback = async (id: string, version: number) => {
    if (!confirm(`回滚到 v${version}？C 端用户将立即切回该版本（含其倍率/定价）。草稿不受影响。`)) return;
    setBusy(id);
    try { await api.rollbackAgent(agentKey, id); toast(`已回滚到 v${version}`); await load(); onChanged(); }
    catch (e) { toast((e as Error)?.message || '回滚失败'); }
    setBusy('');
  };

  return (
    <div className="ad-db">
      <div className="blk">
        <div className="blk-h"><Icon name="layers" size={15} /><span className="t">版本历史</span>
          {data.draftDirty
            ? <span className="badge warn">草稿有未发布改动</span>
            : <span className="badge">草稿=已发布</span>}
        </div>
        <div className="blk-d">每次「发布」把当前草稿冻结成不可变版本；C 端只读已发布版本。回滚 = 把已发布指针指回旧版本（不动草稿）。</div>
        {!data.versions.length && <div className="blk-d" style={{ padding: '8px 0' }}>尚无版本。去「配置」页编辑后，点底部「发布新版本」。</div>}
        {data.versions.map((v) => (
          <div key={v.id} className="mem-card">
            <span className="mi"><Icon name="layers" size={16} /></span>
            <div className="mb">
              <div className="mt">
                v{v.version}
                {v.isPublished && <span className="tag live" style={{ marginLeft: 6 }}>线上</span>}
                {!v.isPublished && v.status === 'archived' && <span className="tag off" style={{ marginLeft: 6 }}>历史</span>}
                {v.label ? <span style={{ opacity: .6, marginLeft: 6, fontWeight: 400 }}>{v.label}</span> : null}
              </div>
              <div className="mm">{v.changeSummary || '—'} · 倍率 ×{v.billingRatio} · {tierName(v.billingRatio)} · {v.createdBy || '系统'} · {fmtTime(v.createdAt)}</div>
            </div>
            {!v.isPublished && (
              <button className="mini-btn primary" disabled={busy === v.id} onClick={() => rollback(v.id, v.version)}>
                {busy === v.id ? '…' : '回滚'}
              </button>
            )}
          </div>
        ))}
      </div>
      <div style={{ height: 70 }} />
    </div>
  );
}

// 倍率 → 档位名（与服务端 PRICING_TIERS 对齐）。
export function tierName(ratio: number): string {
  if (ratio >= 2) return '旗舰';
  if (ratio >= 1.5) return '进阶';
  return '标准';
}
