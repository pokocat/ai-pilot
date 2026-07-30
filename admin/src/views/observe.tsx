// 观测：调用诊断 / 内容审核 / 审计日志 —— 只读的「发生过什么」。
// 模型配置曾误放本组（见 nav.ts 顶部说明），已移入「配置」——那是写屏，不是观测屏。
import { useCallback, useEffect, useState } from 'react';
import Icon from '../Icon';
import { api, type AdminAuditItem, type AdminTraceListView, type AdminTraceDetail, type AdminModerationLogView } from '../api';
import { PageHead, ViewState, ErrorState, Skeleton, SearchBox } from '../components';
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

export function ObservabilityView() {
  const [status, setStatus] = useState<'' | 'ok' | 'error'>('');
  const [detail, setDetail] = useState<AdminTraceDetail | null>(null);
  const [detailErr, setDetailErr] = useState('');
  const res = useResource(
    useCallback(() => api.traces({ days: 7, status: status || undefined }), [status]),
    [status],
  );
  const openTrace = (id: string) => {
    setDetailErr('');
    api.trace(id).then(setDetail).catch((e) => setDetailErr((e as Error).message || '调用详情加载失败'));
  };
  return (
    <>
      <PageHead k="trace" res={res} badge={res.data ? `近 ${res.data.windowDays} 天` : undefined} />
      <div className="pad">
        <div className="chip-row">
          {([['', '全部'], ['ok', '成功'], ['error', '错误']] as const).map(([v, l]) => (
            <button key={v} type="button" className={`chip ${status === v ? 'on' : ''}`} onClick={() => setStatus(v)}>{l}</button>
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
                <div key={t.id} className="usage-row" style={{ cursor: 'pointer' }} onClick={() => openTrace(t.id)}>
                  <div className="usage-h">
                    <div className="usage-name">{traceAgent(t)}<span>{TRACE_KIND_LABEL[t.kind] ?? t.kind} · {t.provider}/{t.model || '-'}</span></div>
                    <div className={`usage-num ${t.status === 'error' ? '' : 'ok'}`}>{t.status === 'error' ? '错误' : `${t.latencyMs}ms`}</div>
                  </div>
                  <div className="usage-meta">来源：{traceUser(t)}{t.tenantName ? ` · ${t.tenantName}` : ''}</div>
                  <div className="usage-meta">{new Date(t.at).toLocaleString()} · {t.totalTokens} token{t.cachedInput ? ` · 缓存命中 ${t.cachedInput}` : ''}{t.toolCalls ? ` · 工具×${t.toolCalls}` : ''}{t.errorMessage ? ` · ${t.errorMessage.slice(0, 40)}` : ''}</div>
                </div>
              ))}
            </div>
          );
        }}
      </ViewState>
      {detail && (
        <div className="ad-detail show" onClick={() => setDetail(null)}>
          <div className="ad-dh"><div className="bk" onClick={() => setDetail(null)}><Icon name="arrow" size={18} /></div><div className="dt"><div className="t">{traceAgent(detail)}</div><div className="s">{TRACE_KIND_LABEL[detail.kind] ?? detail.kind} · {detail.provider}/{detail.model || '-'}</div></div></div>
          <div className="ad-db" onClick={(e) => e.stopPropagation()}>
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
                <div className="audit-detail-kv wide"><span>排障标识</span><b>agent={detail.agentKey || '—'} · kind={detail.kind} · session={detail.sessionId || '—'} · user={detail.userId || '—'}</b></div>
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
      )}
    </>
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

export function AuditView() {
  const [selected, setSelected] = useState<AdminAuditItem | null>(null);
  const [includeAdmin, setIncludeAdmin] = useState(false); // P2-11：可显式查看后台自身操作（多运营问责）
  const [includeMetrics, setIncludeMetrics] = useState(false); // Prometheus /api/metrics 历史抓取默认隐藏，避免淹没用户动作
  const [q, setQ] = useState('');
  const res = useResource(useCallback(() => api.auditLogs({ includeAdmin, includeMetrics }), [includeAdmin, includeMetrics]), [includeAdmin, includeMetrics]);
  const all = res.data ?? [];
  // 100 条日志里找一次特定动作/用户/IP，旧版只能靠眼扫；前端过滤足够（后端已限量返回）。
  const list = q.trim()
    ? all.filter((a) => {
        const n = q.trim().toLowerCase();
        return auditTarget(a).toLowerCase().includes(n)
          || (a.summary ?? auditLabel(a.action)).toLowerCase().includes(n)
          || actorText(a).toLowerCase().includes(n)
          || (a.ip ?? '').includes(n)
          || a.action.toLowerCase().includes(n);
      })
    : all;
  return (
    <>
      <PageHead k="audit" res={res} badge={`${list.length}${q.trim() ? ` / ${all.length}` : ''} 条`} />
      <div className="pad audit-pad">
        <div className="filter-bar">
          <SearchBox value={q} onChange={setQ} placeholder="接口 / 动作 / 用户 / IP…" />
          <div className="chip-row">
            {([[false, '用户行为'], [true, '含后台操作']] as const).map(([v, l]) => (
              <button key={String(v)} type="button" className={`chip ${includeAdmin === v ? 'on' : ''}`} onClick={() => setIncludeAdmin(v)}>{l}</button>
            ))}
            <button type="button" className={`chip ${includeMetrics ? 'on' : ''}`} onClick={() => setIncludeMetrics((v) => !v)}>含监控抓取</button>
          </div>
        </div>
        {res.error && all.length === 0 && <ErrorState msg={res.error} onRetry={res.reload} />}
        {res.initial ? <Skeleton /> : (
          <>
            <div className="audit-table-wrap">
              <div className="audit-table">
                <div className="audit-row audit-header-row">
                  <span>时间</span><span>状态</span><span>方法</span><span>接口/动作</span><span>用户</span><span>IP</span><span>摘要</span>
                </div>
                {list.map((a) => (
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
            {!list.length && <div className="empty">{all.length ? '没有匹配的审计记录。' : '暂无审计记录'}</div>}
          </>
        )}
      </div>
      {selected && <AuditDetailPanel item={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

function AuditDetailPanel({ item, onClose }: { item: AdminAuditItem; onClose: () => void }) {
  const target = auditTarget(item);
  const summary = item.summary ?? auditLabel(item.action);
  return (
    <div className="ad-detail audit-detail show">
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

        <div className="blk">
          <div className="blk-h"><Icon name="target" size={15} /><span className="t">请求与动作</span></div>
          <div className="audit-detail-grid">
            <AuditDetailRow k="动作" v={`${auditLabel(item.action)} (${item.action})`} />
            <AuditDetailRow k="方法" v={item.method ?? actionKind(item.action)} />
            <AuditDetailRow k="接口" v={target} wide />
            <AuditDetailRow k="日志 ID" v={item.id} wide />
          </div>
        </div>

        <div className="blk">
          <div className="blk-h"><Icon name="user" size={15} /><span className="t">账号上下文</span></div>
          <div className="audit-detail-grid">
            <AuditDetailRow k="用户" v={actorText(item)} wide />
            <AuditDetailRow k="租户" v={item.tenantName || item.tenantId || '-'} />
            <AuditDetailRow k="用户 ID" v={item.userId || '-'} wide />
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
