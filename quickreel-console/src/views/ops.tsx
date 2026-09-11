// 出片对账 —— 这个台最要紧的一屏：钱扣了、片子交付了没有。
//
// VideoCreditHold 是唯一记着这件事的表。一条 hold 的生命周期：
//   submitting  已扣钱，还没拿到上游 jobId
//   unknown     请求发出去了但没收到回执 —— **绝不能按超时退款**，上游可能正在跑
//   submitted   拿到 jobId 了，等出片
//   notifying   出片完成通知的原子认领态（短暂）
//   settled     结算完成（终点）
//   refunded    已退款（终点，任何路径都不许写回 settled）
//
// 值班动线就一条：看「悬着多少钻」→ 看「最老的一单卡了多久」→ 对能查的那几单查单。
import { useCallback, useState } from 'react';
import { api, type AdminClipHoldItem } from '../api';
import { Confirm, ErrorBox, View, since, fmtTime, useResource, type ConfirmSpec } from '../components';

const RANGES = [7, 30, 90];

// 这里的取值要和服务端 holdStatusLabel 对得上；label 本身由服务端给，
// 前端只决定「筛哪些」和「用什么颜色」。
const FILTERS: { v: string; t: string }[] = [
  { v: '', t: '全部' },
  { v: 'open', t: '未了结' },
  { v: 'unknown', t: '受理不明' },
  { v: 'settled', t: '已结算' },
  { v: 'refunded', t: '已退款' },
];

const tagOf = (s: string): string =>
  s === 'settled' ? 'ok'
    : s === 'refunded' ? 'slate'
      : s === 'unknown' ? 'danger'
        : 'warn';

export function OpsView({ toast, isSuper, onAuthLost }: {
  toast: (m: string) => void; isSuper: boolean; onAuthLost: () => void;
}) {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [spec, setSpec] = useState<ConfirmSpec | null>(null);

  const ops = useResource(useCallback(() => api.ops(days), [days]), [days], onAuthLost);
  const list = useResource(
    useCallback(() => api.holds({ status: status || undefined, days, page }), [status, days, page]),
    [status, days, page],
    onAuthLost,
  );

  // 查单：能补交就补交，明确被拒才退款，问不清原样保留。
  // 这三种结果的文案必须不一样 —— 「问不清」被读成「已处理」，运营就不会再回来看这一单了。
  const reconcile = (h: AdminClipHoldItem) => setSpec({
    title: '向上游查这一单',
    desc: '按 clientRequestId 向出片服务查单：查得到就把任务号补回来；'
      + '上游明确拒绝才退款；问不清就原样留着等下一轮，不会凭超时退款。',
    echo: [
      { k: '用户', v: h.userName || h.userId },
      { k: '草稿', v: h.projectId },
      { k: '钻石', v: `${h.credits}` },
      { k: '当前', v: `${h.statusLabel}（${since(h.updatedAt)}）` },
    ],
    warn: '退款是不可逆的。上游其实在跑、却被判成拒绝的话，这一单等于白送一次出片。',
    confirmText: '查单',
    onConfirm: async () => {
      const r = await api.reconcile(h.id);
      toast(
        r.outcome === 'accepted' ? `上游认了：${r.statusLabel}${r.upstreamJobId ? ` · 任务 ${r.upstreamJobId}` : ''}`
          : r.outcome === 'rejected' ? `上游拒绝，已退款 ${h.credits} 钻`
            : `还是问不清，这一单原样留着（${r.message || '下一轮再试'}）`,
      );
      ops.reload(); list.reload();
    },
  });

  return (
    <>
      <div className="head">
        <h1>出片对账</h1>
        <span className="sub">钱扣了、片子交付了没有</span>
      </div>

      <div className="chips">
        {RANGES.map((d) => (
          <button key={d} type="button" className={`chip ${days === d ? 'on' : ''}`}
            onClick={() => { setDays(d); setPage(1); }}>近 {d} 天</button>
        ))}
      </div>

      <View res={ops} skeleton={2}>
        {(v) => (
          <>
            <div className="stats">
              <div className={`stat ${v.openCredits > 0 ? 'alert' : ''}`}>
                <b>{v.openCredits.toLocaleString()}</b>
                <span>悬着的钻石（{v.openCount} 单未了结）</span>
              </div>
              <div className={`stat ${v.unanchoredCount > 0 ? 'alert' : ''}`}>
                <b>{v.unanchoredCount}</b>
                <span>没有任务号（扣了钱没拿到回执）</span>
              </div>
              <div className="stat good">
                <b>{v.successRate === null ? '—' : `${Math.round(v.successRate * 100)}%`}</b>
                <span>出片成功率</span>
              </div>
              <div className="stat">
                <b>{v.refundedCredits.toLocaleString()}</b>
                <span>已退回（{v.refundedCount} 单）</span>
              </div>
            </div>

            {v.oldestOpenAt && (
              <div className="note" style={{ marginBottom: 12 }}>
                最老的一单未了结已经 <b>{since(v.oldestOpenAt)}</b>（{fmtTime(v.oldestOpenAt)}）。
                定时任务每轮会自己去查；这里的「查单」是手动催一次，用在等不及的时候。
              </div>
            )}

            {v.byStatus.length > 0 && (
              <div className="chips">
                {v.byStatus.map((s) => (
                  <span key={s.status} className={`tag ${tagOf(s.status)}`}>
                    {s.label} {s.count} · {s.credits.toLocaleString()} 钻
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </View>

      <div className="chips" style={{ marginTop: 14 }}>
        {FILTERS.map((f) => (
          <button key={f.v} type="button" className={`chip ${status === f.v ? 'on' : ''}`}
            onClick={() => { setStatus(f.v); setPage(1); }}>{f.t}</button>
        ))}
      </div>

      <View res={list} skeleton={4}>
        {(v) => v.items.length === 0 ? (
          <div className="empty">这个范围里没有单子</div>
        ) : (
          <>
            <div className="rows">
              {v.items.map((h) => (
                <div key={h.id} className="row">
                  <div className="row-h">
                    <span className="row-t">{h.userName || '（未命名）'}</span>
                    <span className={`tag ${tagOf(h.status)}`}>{h.statusLabel}</span>
                    <span className="row-n">{h.credits.toLocaleString()} 钻</span>
                  </div>
                  <div className="row-m">
                    草稿 {h.projectId} · {h.upstreamJobId ? `任务 ${h.upstreamJobId}` : '没有任务号'}
                    {h.lastJobStatus ? ` · 上游态 ${h.lastJobStatus}` : ''}
                    <br />
                    扣于 {fmtTime(h.chargedAt)}（{since(h.chargedAt)}）
                    {h.refundedAt ? ` · 退于 ${fmtTime(h.refundedAt)}` : ''}
                  </div>
                  {/* reconcilable 由服务端判定：只有「还没锚定任务号」的才查得动。
                      已结算 / 已退款是终点，没有可查的东西，不摆按钮。 */}
                  {h.reconcilable && isSuper && (
                    <div className="row-act">
                      <button type="button" className="btn" onClick={() => reconcile(h)}>查单</button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {v.pages > 1 && (
              <div className="chips" style={{ marginTop: 12, justifyContent: 'center' }}>
                <button type="button" className="btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
                <span style={{ alignSelf: 'center', fontSize: 12, color: 'var(--muted)' }}>
                  {v.page} / {v.pages} · 共 {v.total}
                </span>
                <button type="button" className="btn" disabled={page >= v.pages} onClick={() => setPage((p) => p + 1)}>下一页</button>
              </div>
            )}
          </>
        )}
      </View>

      {!isSuper && (
        <div className="note" style={{ marginTop: 14 }}>
          查单会动真钱（可能退款），只有超管能做。你现在是只读。
        </div>
      )}

      {spec && <Confirm spec={spec} onClose={() => setSpec(null)} />}
    </>
  );
}
