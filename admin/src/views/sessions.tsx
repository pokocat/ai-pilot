import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from '../Icon';
import { api, type AdminSessionDetail, type AdminSessionListView } from '../api';
import {
  DateRangeFilter,
  type DateRangeValue,
  ErrorState,
  PageHead,
  Pager,
  SearchBox,
  Skeleton,
  useDialogFocus,
  ViewState,
} from '../components';
import { fmtTime } from '../format';
import { useResource } from '../useResource';

const STATUS = [
  ['', '全部'],
  ['active', '生成中'],
  ['failed', '有失败'],
  ['completed', '已完成'],
] as const;

function rangeQuery(range: DateRangeValue): { days?: number; from?: string; to?: string } {
  return range.days ? { days: range.days } : { from: range.from, to: range.to };
}

function roleLabel(role: string): string {
  return ({ user: '用户', assistant: '军师', report: '成果' } as Record<string, string>)[role] ?? role;
}

function generationLabel(status: string): string {
  return ({ queued: '排队中', running: '生成中', completed: '已完成', truncated: '已截断', failed: '失败', cancelled: '已取消' } as Record<string, string>)[status] ?? status;
}

export function SessionsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [range, setRange] = useState<DateRangeValue>({ days: 30, from: '', to: '' });
  const [status, setStatus] = useState('');
  const [draftQ, setDraftQ] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const applyRange = (next: DateRangeValue) => { setPage(1); setRange(next); };
  const applySearch = () => { setPage(1); setQ(draftQ.trim()); };
  const res = useResource(
    useCallback(() => api.sessions({ ...rangeQuery(range), status: status || undefined, q: q || undefined, page, pageSize: 30 }), [range, status, q, page]),
    [range, status, q, page],
  );
  return (
    <>
      <PageHead k="sessions" res={res} badge={res.data ? `${res.data.total} 个会话` : undefined} />
      <div className="pad session-filter">
        <DateRangeFilter value={range} onChange={applyRange} />
        <form className="filter-search" onSubmit={(e) => { e.preventDefault(); applySearch(); }}>
          <SearchBox value={draftQ} onChange={setDraftQ} placeholder="会话 / 用户 / 手机 / 租户 / 顾问 / 项目…" />
          <button type="submit" className="mini-btn">查询</button>
        </form>
        <div className="chip-row">
          {STATUS.map(([value, label]) => (
            <button key={value} type="button" className={`chip ${status === value ? 'on' : ''}`} onClick={() => { setPage(1); setStatus(value); }}>{label}</button>
          ))}
        </div>
      </div>
      <ViewState res={res} skeleton="stats">
        {(data: AdminSessionListView) => (
          <div className="pad session-workbench">
            <div className="usage-summary">
              <div><b>{data.summary.sessions}</b><span>匹配会话</span></div>
              <div><b>{data.summary.messages}</b><span>消息</span></div>
              <div><b>{data.summary.activeGenerations}</b><span>在途生成</span></div>
              <div><b>{data.summary.failedGenerations}</b><span>失败任务</span></div>
            </div>
            {data.items.length === 0 ? (
              <div className="empty">该时间范围内没有匹配会话。可扩大日期或清除筛选后重试。</div>
            ) : data.items.map((s) => (
              <button key={s.id} type="button" className="session-row" onClick={() => onOpen(s.id)}>
                <span className="session-main">
                  <span className="session-title">{s.title || '未命名会话'}</span>
                  <span className="session-preview">{s.lastMessage ? `${roleLabel(s.lastMessage.role)}：${s.lastMessage.preview || '（结构化内容）'}` : '尚无消息'}</span>
                  <span className="session-meta">{s.userName || '未命名用户'} · {s.userPhone || s.userId.slice(0, 8)} · {s.tenantName || '未命名租户'}</span>
                </span>
                <span className="session-side">
                  <span className={`session-state ${s.activeGeneration ? 'live' : s.failedGenerationCount ? 'bad' : ''}`}>
                    {s.activeGeneration ? '生成中' : s.failedGenerationCount ? `${s.failedGenerationCount} 次失败` : '正常'}
                  </span>
                  <span>{s.agentName || s.agentKey}{s.projectName ? ` · ${s.projectName}` : ''}</span>
                  <span>{s.messageCount} 条消息 · {fmtTime(s.updatedAt)}</span>
                </span>
              </button>
            ))}
            <Pager page={data.page} pages={data.pages} total={data.total} onChange={setPage} />
          </div>
        )}
      </ViewState>
    </>
  );
}
export function SessionDetailPanel({ id, onClose, onOpenUser }: { id: string; onClose: () => void; onOpenUser: (id: string) => void }) {
  const res = useResource(useCallback(() => api.session(id), [id]), [id]);
  const [tab, setTab] = useState<'messages' | 'generations' | 'traces'>('messages');
  const [older, setOlder] = useState<AdminSessionDetail['messages']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [olderErr, setOlderErr] = useState('');
  const panelRef = useDialogFocus(onClose);
  useEffect(() => {
    setOlder([]);
    setCursor(res.data?.nextMessageCursor ?? null);
  }, [id, res.data?.nextMessageCursor]);
  const messages = useMemo(() => [...older, ...(res.data?.messages ?? [])], [older, res.data?.messages]);
  const loadOlder = async () => {
    if (!cursor || olderBusy) return;
    setOlderBusy(true); setOlderErr('');
    try {
      const data = await api.session(id, { before: cursor });
      setOlder((rows) => [...data.messages, ...rows]);
      setCursor(data.nextMessageCursor);
    } catch (e) { setOlderErr((e as Error).message || '更早消息加载失败'); }
    finally { setOlderBusy(false); }
  };
  return (
    <div className="ad-detail session-detail show" role="dialog" aria-modal="true" aria-label="会话详情" ref={panelRef} tabIndex={-1}>
      <div className="ad-dh">
        <button className="bk" type="button" onClick={onClose} aria-label="关闭会话详情"><Icon name="arrow" size={18} /></button>
        <div className="di"><Icon name="chat" size={18} /></div>
        <div className="dt"><div className="t">{res.data?.session.title || '会话详情'}</div><div className="s">消息、生成任务与模型调用在同一处核对</div></div>
      </div>
      <div className="ad-db">
        {res.initial && <Skeleton kind="stats" />}
        {res.error && !res.data && <ErrorState msg={res.error} onRetry={res.reload} />}
        {res.data && <SessionDetailBody
          data={res.data}
          tab={tab}
          onTab={setTab}
          messages={messages}
          cursor={cursor}
          olderBusy={olderBusy}
          olderErr={olderErr}
          onLoadOlder={loadOlder}
          onOpenUser={onOpenUser}
        />}
      </div>
    </div>
  );
}

function SessionDetailBody({ data, tab, onTab, messages, cursor, olderBusy, olderErr, onLoadOlder, onOpenUser }: {
  data: AdminSessionDetail;
  tab: 'messages' | 'generations' | 'traces';
  onTab: (tab: 'messages' | 'generations' | 'traces') => void;
  messages: AdminSessionDetail['messages'];
  cursor: string | null;
  olderBusy: boolean;
  olderErr: string;
  onLoadOlder: () => void;
  onOpenUser: (id: string) => void;
}) {
  const s = data.session;
  return (
    <>
      <div className="audit-detail-grid session-identity">
        <div className="audit-detail-kv wide"><span>用户</span><b>{s.userName || '未命名用户'} · {s.userPhone || s.userId}</b></div>
        <div className="audit-detail-kv"><span>租户</span><b>{s.tenantName || s.tenantId}</b></div>
        <div className="audit-detail-kv"><span>顾问</span><b>{s.agentName || s.agentKey}</b></div>
        <div className="audit-detail-kv"><span>项目</span><b>{s.projectName || '散落会话'}</b></div>
        <div className="audit-detail-kv wide"><span>会话 ID</span><b className="selectable">{s.id}</b></div>
      </div>
      <div className="crd-actions session-actions">
        <button type="button" className="mini-btn" onClick={() => onOpenUser(s.userId)}>查看用户</button>
      </div>
      <div className="detail-tabs" role="tablist" aria-label="会话详情分区">
        {([['messages', `消息 ${data.messagesTotal}`], ['generations', `生成任务 ${data.generations.length}`], ['traces', `模型调用 ${data.traces.length}`]] as const).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`chip ${tab === key ? 'on' : ''}`} onClick={() => onTab(key)}>{label}</button>
        ))}
      </div>
      {tab === 'messages' && (
        <div className="message-timeline">
          {cursor && <button type="button" className="load-older" onClick={onLoadOlder} disabled={olderBusy}>{olderBusy ? '加载中…' : '加载更早消息'}</button>}
          {olderErr && <ErrorState msg={olderErr} onRetry={onLoadOlder} />}
          {!messages.length && <div className="empty">该会话尚无消息。</div>}
          {messages.map((m) => (
            <article key={m.id} className={`message-card role-${m.role}`}>
              <header><b>{roleLabel(m.role)}</b><span>{fmtTime(m.at)}</span></header>
              <pre>{m.textPreview || JSON.stringify(m.content, null, 2)}</pre>
              {m.refs ? <details><summary>查看引用元数据</summary><pre>{JSON.stringify(m.refs, null, 2)}</pre></details> : null}
            </article>
          ))}
        </div>
      )}
      {tab === 'generations' && (
        <div className="detail-list">
          {!data.generations.length && <div className="empty">没有生成任务。</div>}
          {data.generations.map((g) => (
            <div key={g.id} className="usage-row">
              <div className="usage-h"><div className="usage-name">{generationLabel(g.status)}<span>{g.kind} · {g.phase} · {g.deliveryMode}</span></div><div className={`usage-num ${g.status === 'completed' ? 'ok' : ''}`}>{g.quotaCharged} token 额度</div></div>
              <div className="usage-meta">{fmtTime(g.createdAt)} · {g.id}</div>
              {g.terminationReason && <div className="session-error">{g.terminationReason}</div>}
              {g.usage ? <details><summary>用量明细</summary><pre className="audit-json">{JSON.stringify(g.usage, null, 2)}</pre></details> : null}
            </div>
          ))}
        </div>
      )}
      {tab === 'traces' && (
        <div className="detail-list">
          {!data.traces.length && <div className="empty">该会话没有模型调用记录。</div>}
          {data.traces.map((t) => (
            <div key={t.id} className="usage-row">
              <div className="usage-h"><div className="usage-name">{t.endpointLabel || `${t.provider}/${t.model}`}<span>{t.kind} · {t.id}</span></div><div className={`usage-num ${t.status === 'ok' ? 'ok' : ''}`}>{t.status === 'ok' ? `${t.latencyMs}ms` : '错误'}</div></div>
              <div className="usage-meta">{fmtTime(t.at)} · {t.totalTokens} token · 工具 {t.toolCalls} 次</div>
              {t.errorMessage && <div className="session-error">{t.errorMessage}</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
