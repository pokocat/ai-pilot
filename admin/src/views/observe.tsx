// 观测：调用诊断 / 内容审核 / 审计日志 —— 只读的「发生过什么」。
// 模型配置曾误放本组（见 nav.ts 顶部说明），已移入「配置」——那是写屏，不是观测屏。
import { useCallback, useEffect, useState } from 'react';
import Icon from '../Icon';
import { api, type AdminAuditItem, type AdminAuditListView, type AdminTraceListView, type AdminTraceDetail, type AdminModerationLogView } from '../api';
import { DateRangeFilter, type DateRangeValue, PageHead, Pager, ViewState, ErrorState, Skeleton, SearchBox, useDialogFocus } from '../components';
import { useResource } from '../useResource';
import { fmtTime, fmtShortTime, actorText, compactActorText, mobileAuditMeta, auditTarget, actionKind, statusClass, formatPayload, auditLabel } from '../format';

const TRACE_KIND_LABEL: Record<string, string> = {
  chat: '对话回复',
  deliverable: '方案生成',
};

function traceAgent(t: { agentName: string | null; agentKey: string | null }): string {
  return t.agentName || (t.agentKey ? `智能体 ${t.agentKey}` : '全局调用');
}

function traceUser(t: { userName: string | null; userPhone: string | null; userId: string | null }): string {
  if (!t.userId) return '系统任务 / 未关联用户';
  return `${t.userName || '未命名用户'} · ${t.userPhone || t.userId.slice(0, 8)}`;
}

function traceEndpoint(t: { provider: string; model: string; endpointId: string | null; endpointLabel: string | null }): string {
  const endpoint = t.endpointLabel || t.endpointId;
  return `${t.provider}/${t.model || '-'}${endpoint ? ` · ${endpoint}` : ''}`;
}

export function ObservabilityView() {
  const [status, setStatus] = useState<'' | 'ok' | 'error'>('');
  const [range, setRange] = useState<DateRangeValue>({ days: 7, from: '', to: '' });
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<AdminTraceDetail | null>(null);
  const [detailErr, setDetailErr] = useState('');
  const res = useResource(
    useCallback(() => api.traces({ ...(range.days ? { days: range.days } : { from: range.from, to: range.to }), status: status || undefined, page, pageSize: 50 }), [range, status, page]),
    [range, status, page],
  );
  const openTrace = (id: string) => {
    setDetailErr('');
    api.trace(id).then(setDetail).catch((e) => setDetailErr((e as Error).message || '调用详情加载失败'));
  };
  return (
    <>
      <PageHead k="trace" res={res} badge={res.data?.range ? `${res.data.range.fromDate} 至 ${res.data.range.toDate}` : undefined} />
      <div className="pad">
        <DateRangeFilter value={range} onChange={(value) => { setPage(1); setRange(value); }} />
        <div className="chip-row">
          {([['', '全部'], ['ok', '成功'], ['error', '错误']] as const).map(([v, l]) => (
            <button key={v} type="button" className={`chip ${status === v ? 'on' : ''}`} onClick={() => { setPage(1); setStatus(v); }}>{l}</button>
          ))}
        </div>
        {detailErr && <div className="result-count"><ErrorState msg={detailErr} /></div>}
      </div>
      <ViewState res={res} skeleton="stats">
        {(data: AdminTraceListView) => {
          const errRate = data.totals.calls ? Math.round((data.totals.errors / data.totals.calls) * 100) : 0;
          return (
            <div className="pad">
              <div className="usage-summary">
                <div><b>{data.totals.calls}</b><span>调用次数</span></div>
                <div><b>{data.totals.errors}</b><span>错误数</span></div>
                <div><b>{errRate}%</b><span>错误率</span></div>
                <div><b>{data.totals.avgLatencyMs}ms</b><span>平均延迟</span></div>
              </div>
              {data.items.length === 0 && <div className="empty">近 {data.windowDays} 天{status === 'error' ? '没有失败调用' : '暂无调用记录'}。</div>}
              {data.items.map((t) => (
                <button key={t.id} type="button" className="usage-row usage-row-button" onClick={() => openTrace(t.id)}>
                  <div className="usage-h">
                    <div className="usage-name">{traceAgent(t)}<span>{TRACE_KIND_LABEL[t.kind] ?? t.kind} · {traceEndpoint(t)}</span></div>
                    <div className={`usage-num ${t.status === 'error' ? '' : 'ok'}`}>{t.status === 'error' ? '错误' : `${t.latencyMs}ms`}</div>
                  </div>
                  <div className="usage-meta">来源：{traceUser(t)}{t.tenantName ? ` · ${t.tenantName}` : ''}</div>
                  <div className="usage-meta">{new Date(t.at).toLocaleString()} · {t.totalTokens} token{t.cachedInput ? ` · 缓存命中 ${t.cachedInput}` : ''}{t.toolCalls ? ` · 工具×${t.toolCalls}` : ''}{t.errorMessage ? ` · ${t.errorMessage.slice(0, 40)}` : ''}</div>
                </button>
              ))}
              <Pager page={data.page ?? 1} pages={data.pages ?? 1} total={data.totals.calls} onChange={setPage} />
            </div>
          );
        }}
      </ViewState>
      {detail && <TraceDetailPanel detail={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function TraceDetailPanel({ detail, onClose }: { detail: AdminTraceDetail; onClose: () => void }) {
  const panelRef = useDialogFocus(onClose);
  return (
        <div ref={panelRef} className="ad-detail show" role="dialog" aria-modal="true" aria-label="调用详情" tabIndex={-1}>
          <div className="ad-dh"><button type="button" className="bk" onClick={onClose} aria-label="关闭调用详情"><Icon name="arrow" size={18} /></button><div className="dt"><div className="t">{traceAgent(detail)}</div><div className="s">{TRACE_KIND_LABEL[detail.kind] ?? detail.kind} · {traceEndpoint(detail)}</div></div></div>
          <div className="ad-db">
            <div className="usage-summary">
              <div><b>{detail.status === 'error' ? '错误' : '成功'}</b><span>状态</span></div>
              <div><b>{detail.latencyMs}ms</b><span>延迟</span></div>
              <div><b>{detail.toolCalls}/{detail.iterations}</b><span>工具/轮次</span></div>
              <div><b>{detail.totalTokens}</b><span>token</span></div>
              <div><b>{detail.cachedInput}</b><span>缓存命中</span></div>
            </div>
            {detail.errorMessage && <div className="ai-test err" style={{ marginTop: 8 }}><Icon name="spark" size={14} /> {detail.errorMessage}</div>}
            <div className="blk">
              <div className="blk-h"><Icon name="user" size={15} /><span className="t">来源用户</span></div>
              <div className="audit-detail-grid">
                <div className="audit-detail-kv wide"><span>用户</span><b>{traceUser(detail)}</b></div>
                <div className="audit-detail-kv"><span>租户</span><b>{detail.tenantName || detail.tenantId || '—'}</b></div>
                <div className="audit-detail-kv"><span>智能体</span><b>{traceAgent(detail)}</b></div>
                <div className="audit-detail-kv"><span>调用类型</span><b>{TRACE_KIND_LABEL[detail.kind] ?? detail.kind}</b></div>
                <div className="audit-detail-kv wide"><span>实际端点</span><b>{detail.endpointLabel || '—'}{detail.endpointId ? ` · ${detail.endpointId}` : ''} · {detail.provider}/{detail.model || '—'}</b></div>
                <div className="audit-detail-kv wide"><span>排障标识</span><b>agent={detail.agentKey || '—'} · kind={detail.kind} · session={detail.sessionId || '—'} · user={detail.userId || '—'}</b></div>
                {/* 账单对账用：拿这串 id 去供应商工作台可查到单次调用。一次产出可能多次外呼，故为多值。 */}
                <div className="audit-detail-kv wide"><span>上游调用 id</span><b style={{ userSelect: 'all', wordBreak: 'break-all' }}>{detail.upstreamIds || '—'}</b></div>
              </div>
            </div>
            <div className="sec-h" style={{ marginTop: 8 }}><span className="t">上下文召回</span></div>
            <pre className="trace-text">{detail.context
              ? JSON.stringify(detail.context, null, 2)
              : '（旧记录或本次未采集召回元数据）'}</pre>
            <div className="sec-h" style={{ marginTop: 8 }}><span className="t">输入</span></div>
            <pre className="trace-text">{detail.promptText ?? '（未捕获原文，设 LLM_TRACE_CAPTURE_TEXT=true 开启）'}</pre>
            <div className="sec-h"><span className="t">输出</span></div>
            <pre className="trace-text">{detail.responseText ?? '（未捕获原文）'}</pre>
          </div>
        </div>
  );
}

// P1-B5：内容审核日志（此前 moderation_log 写完无读取入口）。默认看被拦截，可切通过/全部。
export function ModerationView({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const [verdict, setVerdict] = useState<'' | 'pass' | 'block'>('block');
  const res = useResource(
    useCallback(() => api.moderationLogs({ verdict: verdict || undefined, limit: 200 }), [verdict]),
    [verdict],
  );
  return (
    <>
      <PageHead k="moderation" res={res} badge={res.data ? `${res.data.items.length} 条` : undefined} />
      <div className="pad">
        <div className="chip-row">
          {([['block', '被拦截'], ['pass', '通过'], ['', '全部']] as const).map(([v, l]) => (
            <button key={v} type="button" className={`chip ${verdict === v ? 'on' : ''}`} onClick={() => setVerdict(v)}>{l}</button>
          ))}
        </div>
      </div>
      <ViewState res={res}>
        {(data: AdminModerationLogView) => (
          <div className="pad">
            {data.items.length === 0 && <div className="empty">{verdict === 'block' ? '没有被拦截的内容。' : '暂无审核记录。'}</div>}
            {data.items.map((m) => (
              <div key={m.id} className="usage-row">
                <div className="usage-h">
                  <div className="usage-name">{m.refType === 'input' ? '输入' : '输出'}<span>{m.userId ? `用户 ${m.userId.slice(0, 8)}` : '—'}{m.sessionId ? ` · 会话 ${m.sessionId.slice(0, 8)}` : ''}</span></div>
                  <div className={`usage-num ${m.verdict === 'block' ? '' : 'ok'}`}>{m.verdict === 'block' ? '拦截' : '通过'}</div>
                </div>
                <div className="usage-meta">{new Date(m.at).toLocaleString()}{m.detail ? ` · ${JSON.stringify(m.detail).slice(0, 60)}` : ''}</div>
                {/* 拦截记录只有 userId，运营下一步就是去看这个人——给个直达入口，省掉手抄 id */}
                {m.userId && (
                  <div className="crd-actions">
                    <button type="button" className="mini-btn" onClick={() => onOpenUser(m.userId!)}>查看用户</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </ViewState>
    </>
  );
}

export function AuditView({ onOpenUser, onOpenSession }: { onOpenUser: (id: string) => void; onOpenSession: (id: string) => void }) {
  const [selected, setSelected] = useState<AdminAuditItem | null>(null);
  const [includeAdmin, setIncludeAdmin] = useState(false);
  const [includeMetrics, setIncludeMetrics] = useState(false);
  const [range, setRange] = useState<DateRangeValue>({ days: 30, from: '', to: '' });
  const [status, setStatus] = useState('');
  const [draftQ, setDraftQ] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const res = useResource(
    useCallback(() => api.auditView({
      ...(range.days ? { days: range.days } : { from: range.from, to: range.to }),
      includeAdmin,
      includeMetrics,
      status: status || undefined,
      q: q || undefined,
      page,
      pageSize: 50,
    }), [range, includeAdmin, includeMetrics, status, q, page]),
    [range, includeAdmin, includeMetrics, status, q, page],
  );
  const resetPage = () => setPage(1);
  return (
    <>
      <PageHead k="audit" res={res} badge={res.data ? `${res.data.total} 条` : undefined} />
      <div className="pad audit-pad">
        <DateRangeFilter value={range} onChange={(value) => { resetPage(); setRange(value); }} />
        <div className="filter-bar">
          <form className="filter-search" onSubmit={(e) => { e.preventDefault(); resetPage(); setQ(draftQ.trim()); }}>
            <SearchBox value={draftQ} onChange={setDraftQ} placeholder="接口 / 动作 / 用户 / 请求 ID / 操作者…" />
            <button type="submit" className="mini-btn">查询</button>
          </form>
          <div className="chip-row">
            {([[false, '用户行为'], [true, '含后台操作']] as const).map(([v, l]) => (
              <button key={String(v)} type="button" className={`chip ${includeAdmin === v ? 'on' : ''}`} onClick={() => { resetPage(); setIncludeAdmin(v); }}>{l}</button>
            ))}
            {([['', '全部状态'], ['ok', '成功'], ['error', '失败']] as const).map(([value, label]) => (
              <button key={value} type="button" className={`chip ${status === value ? 'on' : ''}`} onClick={() => { resetPage(); setStatus(value); }}>{label}</button>
            ))}
            <button type="button" className={`chip ${includeMetrics ? 'on' : ''}`} onClick={() => { resetPage(); setIncludeMetrics((v) => !v); }}>含监控抓取</button>
          </div>
        </div>
        {res.error && !res.data && <ErrorState msg={res.error} onRetry={res.reload} />}
        {res.initial ? <Skeleton /> : (
          <>
            {res.data && <AuditSummary data={res.data} />}
            <div className="audit-table-wrap">
              <div className="audit-table">
                <div className="audit-row audit-header-row">
                  <span>时间</span><span>状态</span><span>方法</span><span>接口/动作</span><span>用户</span><span>IP</span><span>摘要</span>
                </div>
                {(res.data?.items ?? []).map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className="audit-row audit-data-row"
                    onClick={() => setSelected(a)}
                    aria-label={`查看审计详情：${auditTarget(a)} ${a.summary ?? auditLabel(a.action)}`}
                  >
                    <span className="audit-time">{fmtShortTime(a.at)}</span>
                    <span className={`audit-status ${statusClass(a.statusCode)}`}>{a.statusCode ?? '-'}</span>
                    <span className="audit-method">{a.method ?? actionKind(a.action)}</span>
                    <span className="audit-target" title={auditTarget(a)}>{auditTarget(a)}</span>
                    <span className="audit-actor" title={actorText(a)}>{compactActorText(a)}</span>
                    <span className="audit-ip" title={a.ip ?? ''}>{a.ip ?? '-'}</span>
                    <span className="audit-summary" title={a.summary ?? auditLabel(a.action)}>{a.summary ?? auditLabel(a.action)}</span>
                    <span className="audit-mobile-meta">{mobileAuditMeta(a)}</span>
                  </button>
                ))}
              </div>
            </div>
            {!res.data?.items.length && <div className="empty">没有匹配的审计记录。可扩大日期、清除搜索或切换行为范围。</div>}
            {res.data && <Pager page={res.data.page} pages={res.data.pages} total={res.data.total} onChange={setPage} />}
          </>
        )}
      </div>
      {selected && <AuditDetailPanel
        item={selected}
        onClose={() => setSelected(null)}
        onOpenUser={onOpenUser}
        onOpenSession={onOpenSession}
        onFilterRequest={(requestId) => { setDraftQ(requestId); setQ(requestId); setPage(1); setSelected(null); }}
      />}
    </>
  );
}

function AuditSummary({ data }: { data: AdminAuditListView }) {
  return (
    <div className="usage-summary audit-summary-grid">
      <div><b>{data.summary.events}</b><span>事件</span></div>
      <div><b>{data.summary.failed}</b><span>失败</span></div>
      <div><b>{data.summary.users}</b><span>关联用户</span></div>
      <div><b>{data.summary.operators}</b><span>关联操作者</span></div>
    </div>
  );
}

function AuditDetailPanel({ item, onClose, onOpenUser, onOpenSession, onFilterRequest }: {
  item: AdminAuditItem;
  onClose: () => void;
  onOpenUser: (id: string) => void;
  onOpenSession: (id: string) => void;
  onFilterRequest: (requestId: string) => void;
}) {
  const target = auditTarget(item);
  const summary = item.summary ?? auditLabel(item.action);
  const panelRef = useDialogFocus(onClose);
  return (
    <div ref={panelRef} className="ad-detail audit-detail show" role="dialog" aria-modal="true" aria-label="审计详情" tabIndex={-1}>
      <div className="ad-dh">
        <button className="bk" type="button" onClick={onClose} aria-label="关闭审计详情"><Icon name="arrow" size={18} /></button>
        <div className="di"><Icon name="clock" size={18} /></div>
        <div className="dt"><div className="t">审计详情</div><div className="s">{item.method ?? actionKind(item.action)} · {target}</div></div>
      </div>
      <div className="ad-db">
        <div className="audit-detail-summary">
          <span className={`audit-status ${statusClass(item.statusCode)}`}>{item.statusCode ?? '-'}</span>
          <div>
            <b>{summary}</b>
            <span>{fmtTime(item.at)}</span>
          </div>
        </div>
        {(item.requestId || item.sessionId || item.userId) && (
          <div className="crd-actions audit-chain-actions">
            {item.requestId && <button type="button" className="mini-btn" onClick={() => onFilterRequest(item.requestId!)}>同一请求链</button>}
            {item.sessionId && <button type="button" className="mini-btn" onClick={() => onOpenSession(item.sessionId!)}>打开关联会话</button>}
            {item.userId && <button type="button" className="mini-btn" onClick={() => onOpenUser(item.userId!)}>查看关联用户</button>}
          </div>
        )}

        <div className="blk">
          <div className="blk-h"><Icon name="target" size={15} /><span className="t">请求与动作</span></div>
          <div className="audit-detail-grid">
            <AuditDetailRow k="动作" v={`${auditLabel(item.action)} (${item.action})`} />
            <AuditDetailRow k="方法" v={item.method ?? actionKind(item.action)} />
            <AuditDetailRow k="接口" v={target} wide />
            <AuditDetailRow k="日志 ID" v={item.id} wide />
            <AuditDetailRow k="请求 ID" v={item.requestId || '-'} wide />
            <AuditDetailRow k="会话 ID" v={item.sessionId || '-'} wide />
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="user" size={15} /><span className="t">账号上下文</span></div>
          <div className="audit-detail-grid">
            <AuditDetailRow k="用户" v={actorText(item)} wide />
            <AuditDetailRow k="租户" v={item.tenantName || item.tenantId || '-'} />
            <AuditDetailRow k="用户 ID" v={item.userId || '-'} wide />
            <AuditDetailRow k="后台操作者" v={item.operator || '-'} wide />
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="insight" size={15} /><span className="t">网络指纹</span></div>
          <div className="audit-detail-grid">
            <AuditDetailRow k="IP" v={item.ip || '-'} />
            <AuditDetailRow k="UA" v={item.userAgent || '-'} wide />
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="doc" size={15} /><span className="t">Payload</span></div>
          <pre className="audit-json">{formatPayload(item.payload)}</pre>
        </div>
        <div style={{ height: 32 }} />
      </div>
    </div>
  );
}

function AuditDetailRow({ k, v, wide = false }: { k: string; v: string; wide?: boolean }) {
  return (
    <div className={`audit-detail-kv ${wide ? 'wide' : ''}`}>
      <span>{k}</span>
      <b>{v || '-'}</b>
    </div>
  );
}
