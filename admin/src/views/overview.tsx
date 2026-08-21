// 今日：待处理队列 + 经营概览。
//
// 「待处理」是本次改版新增的首屏：旧版上班第一眼只有一组同比数字和一条动态流，
// 而真正需要动作的信号（已支付未发放的资损单、调用失败、审核拦截、端点被限流冷却、
// 额度耗尽）分散在 5 个不同 tab 里，运营得逐个点开才知道有没有事。
// 现在一屏收口，每格点进去就是筛好的那张清单；全零时明确显示「无待处理」，
// 而不是留几个 0 让人猜是没事还是没加载出来。

import { useCallback, useState } from 'react';
import Icon from '../Icon';
import { api, type Overview, type AdminPaymentsView, type AdminTraceListView, type AdminModerationLogView, type AiRoutingStatus, type AdminUserItem } from '../api';
import { DateRangeFilter, type DateRangeValue, PageHead, ViewState } from '../components';
import { useResource } from '../useResource';

export function OverviewView({ onGo }: { onGo: (k: string) => void }) {
  const [range, setRange] = useState<DateRangeValue>({ days: 7, from: '', to: '' });
  const res = useResource(
    useCallback(() => api.overview(range.days ? { days: range.days } : { from: range.from, to: range.to }), [range]),
    [range],
  );
  return (
    <>
      <PageHead k="home" res={res} />
      <div className="pad">
        <TriageBoard onGo={onGo} />
        <div className="overview-range"><DateRangeFilter value={range} onChange={setRange} /></div>
      </div>
      <ViewState res={res} skeleton="stats">
        {(data: Overview) => (
          <>
            <div className="sec-h"><span className="t">经营统计</span><span className="s">{data.range ? `${data.range.fromDate} 至 ${data.range.toDate} · 对比前一等长区间` : '所选区间对比'}</span></div>
            <div className="pad">
              <div className="stats">
                {data.stats.map((s) => (
                  <div key={s.t} className="stat">
                    <div className="v">{s.v}</div>
                    <div className="l">{s.t}</div>
                    <StatDelta deltaPct={s.deltaPct} sub={s.sub} />
                  </div>
                ))}
              </div>
            </div>
            <div className="sec-h"><span className="t">近期动态</span><span className="s">运营事件</span></div>
            <div className="pad">
              {data.feed.length === 0 ? <div className="empty">近期没有运营事件。</div> : (
                <div className="feed">
                  {data.feed.map((f, i) => (
                    <div key={i} className="fr">
                      <span className="fi"><Icon name={f.icon} size={16} /></span>
                      <div className="fb"><div className="ft">{f.t}</div><div className="fm">{f.m}</div></div>
                      <span className="fv">{f.v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </ViewState>
    </>
  );
}

/* ────────────── 待处理队列 ──────────────
   全部复用已有接口，不需要后端改动：
     payments.stuck        已支付未发放（资损单）+ 超时未支付
     traces(1d, error)     近 24h 调用失败数
     moderationLogs(block) 审核拦截条数
     aiRouting.endpoints   被上游限流而冷却中的端点
     users                 月度额度已耗尽的用户数
   任一分项接口失败只让该格显示「—」，不连带整块崩掉：值班看板不能因为一个次要接口
   500 就整屏消失。 */
interface TriageCell {
  key: string;
  n: number | null;
  label: string;
  icon: string;
  /** hot=资金/线上故障，必须马上处理；warn=需要关注 */
  level: 'hot' | 'warn';
  go: string;
}

function TriageBoard({ onGo }: { onGo: (k: string) => void }) {
  // 各分项独立取数：一个挂了不影响其它格。
  const pay = useResource(useCallback(() => api.payments({ days: 30 }), []), []);
  const trace = useResource(useCallback(() => api.traces({ days: 1, status: 'error' }), []), []);
  const mod = useResource(useCallback(() => api.moderationLogs({ verdict: 'block', limit: 200 }), []), []);
  const routing = useResource(api.aiRouting, []);
  const users = useResource(api.users, []);

  const stuck = (pay.data as AdminPaymentsView | null)?.stuck ?? null;
  const unapplied = stuck ? stuck.filter((s) => s.kind === 'paid_unapplied').length : null;
  const errors = (trace.data as AdminTraceListView | null)?.totals.errors ?? null;
  const blocks = (mod.data as AdminModerationLogView | null)?.items.length ?? null;
  const cooling = (routing.data as AiRoutingStatus | null)?.endpoints.filter((e) => e.cooling).length ?? null;
  const drained = (users.data as AdminUserItem[] | null)?.filter((u) => u.quotaRemaining === 0).length ?? null;

  const cells: TriageCell[] = [
    { key: 'unapplied', n: unapplied, label: '已支付未发放（资损单）', icon: 'doc', level: 'hot', go: 'payments' },
    { key: 'errors', n: errors, label: '近 24h 调用失败', icon: 'alert', level: 'hot', go: 'trace' },
    { key: 'cooling', n: cooling, label: '端点冷却中（被限流）', icon: 'insight', level: 'hot', go: 'model' },
    { key: 'blocks', n: blocks, label: '内容审核拦截', icon: 'shield', level: 'warn', go: 'moderation' },
    { key: 'drained', n: drained, label: '月度额度已耗尽', icon: 'crown', level: 'warn', go: 'users' },
  ];
  const loading = pay.initial || trace.initial || mod.initial || routing.initial || users.initial;
  // 已知结果里全是 0 才算「无待处理」；还有格子在加载或报错时不敢下这个结论。
  const known = cells.filter((c) => c.n !== null);
  const allClear = !loading && known.length === cells.length && known.every((c) => c.n === 0);

  return (
    <>
      <div className="sec-h"><span className="t">待处理</span><span className="s">{allClear ? '当前无待处理事项' : '点任一项进入筛好的清单'}</span></div>
      {allClear ? (
        <div className="triage-clear"><Icon name="check" size={15} /> 资损单、调用失败、端点冷却、审核拦截、额度耗尽均为 0。</div>
      ) : (
        <div className="triage">
          {cells.map((c) => (
            <button
              key={c.key}
              type="button"
              className={`triage-i ${c.n && c.n > 0 ? c.level : ''}`}
              onClick={() => onGo(c.go)}
              aria-label={`${c.label}：${c.n ?? '未取到'}，点击查看`}
            >
              <span className="ic"><Icon name={c.icon} size={16} /></span>
              <span className="b">
                <span className="n">{loading && c.n === null ? '·' : c.n ?? '—'}</span>
                <span className="l">{c.label}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// 概览卡环比：deltaPct 非 null 才渲染箭头（正=绿↑ / 负=红↓ / 0=中性），无前期数据显示「—」。
function StatDelta({ deltaPct, sub }: { deltaPct: number | null; sub: string }) {
  if (deltaPct === null) {
    return <div className="d">—{sub ? <span className="sub"> · {sub}</span> : null}</div>;
  }
  const dir = deltaPct > 0 ? 'up' : deltaPct < 0 ? 'down' : '';
  const pct = `${deltaPct > 0 ? '+' : ''}${deltaPct}%`;
  return (
    <div className={`d ${dir}`}>
      {dir && <Icon name={dir === 'up' ? 'up' : 'trend'} size={12} />}
      {pct}
      {sub ? <span className="sub"> · {sub}</span> : null}
    </div>
  );
}
