// 爱速拍 · 出片对账台。
//
// 这一屏回答独立运营最先要问的那个问题：**有没有钱悬在半空、悬了多少、能不能收回来**。
//
// VideoCreditHold 是唯一一张记着「用户的钻石已经扣了、片子还没交付」的表。出片链路有三段
// 真实会卡的地方，定时任务都在兜底，但兜底失败时之前没人看得见 —— 这一屏就是那双眼睛：
//   · 提交中 / 受理不明 —— 钱扣了却没拿到上游任务号。**绝不能按超时猜失败退款**
//     （上游可能已经在跑了，退款 = 白送一次出片），只能按 clientRequestId 查单。
//   · 上游已受理 / 结算中 —— 上游收了但迟迟不回终态，由出片完成扫描推进。
//   · 已退款 —— 终点，任何路径都不许写回已结算。
import { useCallback, useState } from 'react';
import {
  api, type AdminClipHoldItem, type AdminClipOpsView, type AdminClipHoldListView,
} from '../api';
import { PageHead, ViewState, EmptyState, ErrorState, Skeleton, Pager, ConfirmDialog, type ConfirmSpec } from '../components';
import { useResource } from '../useResource';
import { fmtTime } from '../format';

const RANGES = [7, 30, 90];

/** 状态筛选。空 = 只看还悬着的（服务端默认），这一屏是来处置问题的，不是来翻流水的。 */
const STATUS_TABS: [string, string][] = [
  ['', '还悬着的'],
  ['submitting', '提交中'],
  ['unknown', '受理不明'],
  ['submitted', '上游已受理'],
  ['settled', '已结算'],
  ['refunded', '已退款'],
];

/** 悬了多久。超过一小时的单值得看一眼，超过一天的基本是兜底没兜住。 */
function agoText(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)} 小时前`;
  return `${Math.floor(ms / 86400_000)} 天前`;
}

export function ClipOpsView({ toast, isSuper }: { toast: (m: string) => void; isSuper: boolean }) {
  const [days, setDays] = useState(30);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState('');
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);

  const ops = useResource(useCallback(() => api.clipOps(days), [days]), [days]);
  const holds = useResource(
    useCallback(() => api.clipHolds({ status: status || undefined, days, page }), [status, days, page]),
    [status, days, page],
  );

  // 手工对单：判定在服务端，复用定时任务那条路径。这里只负责把后果讲清楚再让人点。
  const reconcile = (h: AdminClipHoldItem) => setConfirmSpec({
    title: '向出片服务查单',
    desc: '按这单的请求号问上游到底收没收：收了就回填任务号交给出片完成扫描；'
      + '上游明确拒绝才退回钻石；问不清就原样保留，不退款 —— 上游可能已经在跑了，退了就是白送一次出片。',
    echo: [
      { k: '用户', v: h.userName || '（未命名）' },
      { k: '请求号', v: h.clientRequestId },
      { k: '悬挂', v: `${h.credits} 钻石`, amount: true },
      { k: '当前状态', v: `${h.statusLabel} · ${agoText(h.createdAt)}` },
    ],
    confirmText: '查单',
    onConfirm: async () => {
      setBusy(h.id);
      try {
        const r = await api.reconcileClipHold(h.id);
        toast(r.message);
        ops.reload();
        holds.reload();
      } finally { setBusy(''); }
    },
  });

  return (
    <>
      <PageHead
        k="clipops"
        res={ops}
        badge={ops.data ? `${ops.data.openCount} 单悬挂 · ${ops.data.openCredits.toLocaleString()} 钻石` : undefined}
      />
      <div className="pad">
        <div className="filter-bar">
          <div className="chip-row">
            {RANGES.map((d) => (
              <button key={d} type="button" className={`chip ${days === d ? 'on' : ''}`}
                onClick={() => { setDays(d); setPage(1); }}>{d} 天</button>
            ))}
          </div>
        </div>

        {ops.error && !ops.data && <ErrorState msg={ops.error} onRetry={ops.reload} forbidden={ops.forbidden} />}
        {ops.initial ? <Skeleton kind="stats" /> : !ops.data ? null : (
          <>
            <div className="usage-summary">
              <div><b>{ops.data.openCredits.toLocaleString()}</b><span>悬挂钻石（不分时段）</span></div>
              <div><b>{ops.data.unanchoredCredits.toLocaleString()}</b><span>没拿到任务号</span></div>
              <div><b>{ops.data.successRate === null ? '—' : `${ops.data.successRate}%`}</b><span>出片成功率</span></div>
              <div><b>{ops.data.refundedCredits.toLocaleString()}</b><span>期内已退回</span></div>
            </div>
            <div className="usage-meta">
              「悬挂」= 钻石已经从用户余额扣走、片子既没交付也没退回。
              <b>它不按时间段算</b> —— 卡了 40 天的单照样是今天悬着的钱，按时段算只会把最该看见的藏起来。
              「没拿到任务号」是其中最危险的一档：连上游收没收都不知道，只能查单，不能按超时判失败。
              成功率的分母只含已收口的单（已结算 + 已退款），还在跑的不算，否则它会变成排队长度指标。
              {ops.data.oldestOpenAt && <> 最老的一笔悬在 {fmtTime(ops.data.oldestOpenAt)}（{agoText(ops.data.oldestOpenAt)}）。</>}
            </div>
            {ops.data.byStatus.length > 0 && (
              <div className="chip-row">
                {ops.data.byStatus.map((s) => (
                  <span key={s.status} className="chip">{s.label} {s.count}（{s.credits.toLocaleString()} 钻）</span>
                ))}
              </div>
            )}
          </>
        )}

        <div className="sec-h">
          <span className="t">出片单</span>
          <span className="s">默认只列还悬着的；查单只对「没拿到任务号」的单开放，有任务号的由出片完成扫描推进</span>
        </div>
        <div className="filter-bar">
          <div className="chip-row">
            {STATUS_TABS.map(([v, l]) => (
              <button key={v || 'open'} type="button" className={`chip ${status === v ? 'on' : ''}`}
                onClick={() => { setStatus(v); setPage(1); }}>{l}</button>
            ))}
          </div>
        </div>

        {/* 读失败绝不能长成「没有卡住的单」—— 那正好是运营最会误判的方向 */}
        <ViewState res={holds}>
          {(list: AdminClipHoldListView) => (
            <>
              {list.items.length === 0 ? (
                <EmptyState
                  msg={status ? '这个状态下没有单' : '没有悬着的单'}
                  hint={status ? '换个状态或时间段看看' : '钱都结清了 —— 要翻历史单，上面换个状态'}
                />
              ) : list.items.map((h) => (
                <div key={h.id} className="usage-row">
                  <div className="usage-h">
                    <div className="usage-name">
                      {h.userName || '（未命名）'}
                      <span>{h.statusLabel}</span>
                    </div>
                    <div className="usage-num">{h.credits} 钻</div>
                  </div>
                  <div className="usage-meta">
                    {agoText(h.createdAt)} 建单 · 请求号 {h.clientRequestId}
                    {h.upstreamJobId ? ` · 任务 ${h.upstreamJobId}` : ' · 未拿到任务号'}
                    {h.lastJobStatus ? ` · 上游态 ${h.lastJobStatus}` : ''}
                    {h.refundedAt ? ` · ${fmtTime(h.refundedAt)} 已退回` : ''}
                    {!h.productCode && ' · 本列上线前的旧单，无归属'}
                  </div>
                  {h.reconcilable && (
                    <div className="crd-actions">
                      {isSuper ? (
                        <button type="button" className="mini-btn primary" disabled={busy === h.id}
                          onClick={() => reconcile(h)}>向上游查单</button>
                      ) : (
                        <span className="usage-meta">查单会动钱，需要超级管理员</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {list.pages > 1 && (
                <Pager page={list.page} pages={list.pages} total={list.total} onChange={setPage} />
              )}
            </>
          )}
        </ViewState>
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}
