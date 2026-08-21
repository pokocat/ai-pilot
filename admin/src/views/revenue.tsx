// 经营：支付订单 / 处方漏斗 / 钻石消耗 / Token 成本。
import { useCallback, useState } from 'react';
import { api, downloadPaymentsCsv, type AdminUsageView, type AdminTokenUsageView, type AdminPrescriptionFunnel } from '../api';
import { DateRangeFilter, type DateRangeValue, PageHead, ViewState, SearchBox, ConfirmDialog, ErrorState, Skeleton, type ConfirmSpec } from '../components';
import { useResource } from '../useResource';
import { fmtTime, creditText, fmtTokens, fmtCny, fmtYuan } from '../format';
// A3：支付订单列表——状态筛选 + 天数切换 + summary 四格 + 卡单清单（查单补账）+ 明细（金额分转元）。
const PAY_STATUS: [string, string][] = [['', '全部'], ['applied', '已开通'], ['paid', '已支付'], ['created', '待支付'], ['failed', '失败'], ['closed', '关闭']];

function payStatusLabel(s: string): string {
  const m: Record<string, string> = { applied: '已开通', paid: '已支付(未发放)', created: '待支付', failed: '支付失败', closed: '已关闭' };
  return m[s] ?? s;
}

export function PaymentsView({ toast, isSuper, onFindUser }: { toast: (m: string) => void; isSuper: boolean; onFindUser: (userName: string) => void }) {
  const [status, setStatus] = useState('');
  const [days, setDays] = useState(30);
  const [busyNo, setBusyNo] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState(''); // 已提交的搜索词（回车/点搜索才生效，避免逐键请求）
  const [page, setPage] = useState(1);
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);
  const res = useResource(
    useCallback(() => api.payments({ status: status || undefined, days, q: q || undefined, page }), [status, days, q, page]),
    [status, days, q, page],
  );
  const data = res.data;
  const load = res.reload;
  const copyNo = (no: string) => { navigator.clipboard?.writeText(no).then(() => toast('已复制单号')).catch(() => toast(no)); };
  const search = () => { setPage(1); setQ(qInput.trim()); };
  // 订单只带 userName（契约里没有 userId），所以「查用户」用姓名带进用户搜索，
  // 而不是猜一个 id。改契约加 userId 是更干净的做法，但那要动后端路由，留作后续。
  const findUser = onFindUser;

  // 卡单处置：向微信查单并幂等入账（与回调共用同一底座，不会重复发放）。
  const reconcile = (o: { outTradeNo: string; userName: string; amount: number }) => setConfirmSpec({
    title: '向微信查单并补账',
    desc: '按单号向微信查询真实支付状态；若已支付则幂等入账、补发权益。与支付回调共用同一底座，不会重复发放。',
    echo: [
      { k: '用户', v: o.userName || '（未命名）' },
      { k: '单号', v: o.outTradeNo },
      { k: '金额', v: `¥${fmtYuan(o.amount)}`, amount: true },
    ],
    confirmText: '查单补账',
    onConfirm: async () => {
      setBusyNo(o.outTradeNo);
      try {
        const r = await api.reconcilePayment(o.outTradeNo);
        toast(r.applied ? '已补账，权益已发放' : `未入账：${r.tradeState ?? r.reason ?? '状态未变化'}`);
        load();
      } finally { setBusyNo(''); }
    },
  });

  // 全额退款（仅 owner/master 可见）：真金白银且不可撤销 —— 回显用户/单号/金额，
  // 必填原因（入审计），并要求手打「退款」。旧版这一切都靠一个 window.prompt，
  // 既不显示退给谁多少钱，回车即执行。
  // mock 单（PAY_MOCK_SUCCESS 测试期模拟支付）走同一个端点，但服务端不会调微信真退款：
  // 没有资金可退，只做本地权益回收。文案必须跟着变，否则运营会以为自己在退真钱。
  const refund = (o: { outTradeNo: string; userName: string; amount: number; mock?: boolean }) => setConfirmSpec({
    title: o.mock ? '撤销模拟支付并回收权益' : '全额退款并回收权益',
    desc: o.mock
      ? '这是测试期模拟支付单（未实际付款）：不会调用微信退款，仅幂等回收该订单发放过的权益（套餐 / 钻石 / 模块）。执行后不可撤销。'
      : '原路退回至用户支付账户，并幂等回收该订单发放过的权益（套餐 / 钻石 / 模块）。执行后不可撤销。',
    echo: [
      { k: '用户', v: o.userName || '（未命名）' },
      { k: '单号', v: o.outTradeNo },
      { k: o.mock ? '订单金额' : '退款额', v: `¥${fmtYuan(o.amount)}`, amount: true },
    ],
    warn: o.mock
      ? '模拟单没有真实资金流，本操作只回收权益，仍会连同原因写入审计。'
      : '这是一笔真实资金动作，不可撤销，操作会连同原因写入审计。',
    reason: { label: '退款原因（必填，写入审计）', required: true, maxLength: 80 },
    typed: '退款',
    confirmText: o.mock ? '确认回收' : '确认退款',
    danger: true,
    onConfirm: async (reason) => {
      setBusyNo(o.outTradeNo);
      try {
        const r = await api.refundPayment(o.outTradeNo, reason);
        toast(o.mock ? '模拟单已撤销，权益已回收' : `已退款（${r.wechatStatus}），权益已回收`);
        load();
      } finally { setBusyNo(''); }
    },
  });

  const exportCsv = async () => {
    try { await downloadPaymentsCsv({ status: status || undefined, days, q: q || undefined }); }
    catch (e) { toast((e as Error).message || '导出失败'); }
  };
  const pages = data ? Math.max(1, Math.ceil(data.total / (data.pageSize || 20))) : 1;
  return (
    <>
      <PageHead
        k="payments"
        res={res}
        badge={data ? `近 ${days} 天 ${data.total} 单` : undefined}
        actions={isSuper ? <button type="button" className="mini-btn" onClick={exportCsv}>导出 CSV</button> : undefined}
      />
      <div className="pad">
        <div className="filter-bar">
          <SearchBox value={qInput} onChange={setQInput} placeholder="单号 / 用户名 / 手机号，回车搜索" />
          <button type="button" className="mini-btn" onClick={search}>搜索</button>
          <div className="chip-row">
            {[7, 30, 90].map((d) => <button key={d} type="button" className={`chip ${days === d ? 'on' : ''}`} onClick={() => { setDays(d); setPage(1); }}>{d} 天</button>)}
          </div>
        </div>
        <div className="filter-bar">
          <div className="chip-row">
            {PAY_STATUS.map(([v, l]) => <button key={v} type="button" className={`chip ${status === v ? 'on' : ''}`} onClick={() => { setStatus(v); setPage(1); }}>{l}</button>)}
          </div>
        </div>
        {res.error && data === null && <ErrorState msg={res.error} onRetry={load} />}
        {res.initial ? <Skeleton kind="stats" /> : !data ? null : (
          <>
            <div className="usage-summary">
              <div><b>¥{fmtYuan(data.summary.paidAmount)}</b><span>期内实收（不含 mock）</span></div>
              <div><b>{data.summary.paidCount}</b><span>支付订单</span></div>
              <div><b>{data.items.length}</b><span>列表条数</span></div>
              <div><b>¥{data.summary.paidCount > 0 ? fmtYuan(Math.round(data.summary.paidAmount / data.summary.paidCount)) : '0.00'}</b><span>客单价</span></div>
            </div>
            {/* 测试期模拟支付单（PAY_MOCK_SUCCESS）没有真实资金：营收四格已把它们排除，
                但订单列表照常显示并打 mock 标——运营要能看见测试期发了多少权益出去。 */}
            {data.items.some((p) => p.mock) && (
              <div className="usage-meta">列表中带 <span className="tag warn">mock</span> 的是测试期模拟支付单（未实际付款），不计入上方营收金额。</div>
            )}
            {data.stuck.length > 0 && (
              <>
                <div className="sec-h"><span className="t">需要处理（{data.stuck.length}）</span><span className="s">已支付未发放 = 资损单，优先查单补账；超时未支付由对账任务自动关单</span></div>
                {data.stuck.map((o) => (
                  <div key={o.outTradeNo} className="usage-row">
                    <div className="usage-h">
                      <div className="usage-name">
                        {o.userName || '（未命名）'}
                        {o.mock && <span className="tag warn">mock</span>}
                        <span>{o.kind === 'paid_unapplied' ? '已支付未发放' : '超时未支付'} · {o.skuKey || o.planId || '—'}</span>
                      </div>
                      <div className="usage-num">¥{fmtYuan(o.amount)}</div>
                    </div>
                    <div className="usage-meta">{o.outTradeNo} · {o.paidAt ? '支付 ' + fmtTime(o.paidAt) : '下单 ' + fmtTime(o.createdAt)}</div>
                    <div className="crd-actions">
                      {/* mock 单不可查单补账（微信侧没有这笔交易），用户点一下模拟支付即可到账 */}
                      <button type="button" className="mini-btn primary" disabled={busyNo === o.outTradeNo || o.provider !== 'wechat'} onClick={() => reconcile(o)}>
                        {busyNo === o.outTradeNo ? '查单中…' : o.provider === 'wechat' ? '查单补账' : o.mock ? '模拟单' : '沙箱单'}
                      </button>
                      {isSuper && o.kind === 'paid_unapplied' && o.provider === 'wechat' && (
                        <button type="button" className="mini-btn danger" disabled={busyNo === o.outTradeNo} onClick={() => refund(o)}>退款</button>
                      )}
                      <button type="button" className="mini-btn" onClick={() => findUser(o.userName)}>查用户</button>
                      <button type="button" className="mini-btn" onClick={() => copyNo(o.outTradeNo)}>复制单号</button>
                    </div>
                  </div>
                ))}
              </>
            )}
            {data.items.length === 0 && <div className="empty">近 {days} 天{q ? `「${q}」` : ''}{status ? `「${PAY_STATUS.find(([v]) => v === status)?.[1]}」` : ''}暂无订单。</div>}
            {data.items.map((p, i) => (
              <div key={i} className="usage-row" title={p.outTradeNo} onClick={() => copyNo(p.outTradeNo)}>
                <div className="usage-h">
                  <div className="usage-name">
                    {p.userName || '（未命名）'}
                    {p.mock && <span className="tag warn">mock</span>}
                    <span>尾号 {p.orderNo}{p.attrSource ? ` · ${p.attrSource}` : ''}</span>
                  </div>
                  <div className={`usage-num ${p.status === 'applied' || p.status === 'paid' ? 'ok' : ''}`}>¥{fmtYuan(p.amount)}</div>
                </div>
                <div className="usage-meta">{payStatusLabel(p.status)}{p.mock ? ' · 测试期模拟支付（未实际付款）' : ''} · {p.paidAt ? '支付 ' + fmtTime(p.paidAt) : '下单 ' + fmtTime(p.createdAt)}（点击复制完整单号）</div>
                <div className="crd-actions">
                  <button type="button" className="mini-btn" onClick={(e) => { e.stopPropagation(); findUser(p.userName); }}>查用户</button>
                  {isSuper && (p.status === 'applied' || p.status === 'paid') && (
                    <button
                      type="button"
                      className="mini-btn danger"
                      disabled={busyNo === p.outTradeNo}
                      onClick={(e) => { e.stopPropagation(); refund(p); }}
                    >{busyNo === p.outTradeNo ? '退款中…' : '退款'}</button>
                  )}
                </div>
              </div>
            ))}
            {pages > 1 && (
              <div className="crd-actions" style={{ marginTop: 10 }}>
                <button type="button" className="mini-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
                <span className="badge">{page} / {pages} · 共 {data.total} 单</span>
                <button type="button" className="mini-btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
              </div>
            )}
          </>
        )}
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}

// D-1/WO-12：处方多来源漏斗——处方六态转化（按 toolKey）+ 开通来源计数（ActivationEvent）。
// ★ 口径警告：前三项是「从哪个位子成交的」三个**互斥**答案；`invite`（2026-08-18 接上写入方）
// 是另一个维度——「这个人是被谁带来的」，由服务端在付费入账后按 Referral 另落一行，
// 一个被邀请来的人从处方位成交会同时出现在「处方位」和「邀请」两格里。
// 所以这几个数字**不能相加**当总开通数，「邀请」那格读作「其中有多少笔来自被邀请的人（首次付费，按人去重）」。
const RX_SOURCE_LABEL: Record<string, string> = { prescription: '处方位', catalog: '货架', market: '生态市场', invite: '邀请（重叠口径）' };

// token_usage 里「非用户用量」那几档 kind 的中文名。后台按 kind !== chat/deliverable 归到这一栏，
// 新增一档 kind 必须同步加标签，否则界面上直接漏出裸 key（sandbox 这档就是 2026-08 补记账时一起补的）。
const INFRA_KIND_LABEL: Record<string, string> = {
  embedding: '嵌入',
  rerank: '重排',
  aux: '辅助抽取',
  probe: '端点探活',
  sandbox: '运营沙盒试跑',
};

export function FunnelView() {
  const [days, setDays] = useState(30);
  const res = useResource(useCallback(() => api.prescriptionFunnel(days), [days]), [days]);
  return (
    <>
      <PageHead k="funnel" res={res} badge={`近 ${days} 天`} />
      <div className="pad">
        <div className="chip-row">
          {[7, 30, 90].map((d) => (
            <button key={d} type="button" className={`chip ${days === d ? 'on' : ''}`} onClick={() => setDays(d)}>{d} 天</button>
          ))}
        </div>
      </div>
      <ViewState res={res} skeleton="stats">
        {(data: AdminPrescriptionFunnel) => {
          const maxProposed = Math.max(1, ...data.prescriptions.map((r) => r.proposed));
          return (
            <div className="pad">
              <div className="sec-h"><span className="t">开通来源</span><span className="s">ActivationEvent 计数</span></div>
              <div className="usage-summary">
                {data.activations.length === 0
                  ? <div><b>0</b><span>开通事件</span></div>
                  : data.activations.map((a) => <div key={a.source}><b>{a.count}</b><span>{RX_SOURCE_LABEL[a.source] ?? a.source}</span></div>)}
              </div>
              <div className="sec-h"><span className="t">处方六态转化</span><span className="s">按工具 · 各态到达数</span></div>
              {data.prescriptions.length === 0 && <div className="empty">近 {data.days} 天暂无处方。</div>}
              {data.prescriptions.map((r) => (
                <div key={r.toolKey} className="usage-row">
                  <div className="usage-h">
                    <div className="usage-name">{r.toolKey}<span>{r.toolType === 'external' ? '生态工具' : '内部顾问'}</span></div>
                    <div className="usage-num">{r.proposed} 开方</div>
                  </div>
                  <div className="usage-meta">曝光 {r.seen} · 点击 {r.clicked} · 开通 {r.activated} · 使用 {r.used} · 验证 {r.verified}{r.dismissed ? ` · 作废 ${r.dismissed}` : ''}</div>
                  <div className="meter"><i style={{ width: `${Math.max(3, Math.round((r.proposed / maxProposed) * 100))}%` }} /></div>
                </div>
              ))}
            </div>
          );
        }}
      </ViewState>
    </>
  );
}

export function UsageView() {
  const res = useResource(api.usage, []);
  return (
    <>
      <PageHead k="usage" res={res} />
      <ViewState res={res} skeleton="stats">
        {(data: AdminUsageView) => {
          const maxSpent = Math.max(1, ...data.users.map((u) => u.totalSpent));
          return (
            <div className="pad">
              <div className="usage-summary">
                <div><b>{data.summary.totalSpent}</b><span>累计消耗（点）</span></div>
                <div><b>{data.summary.currentBalanceTotal}</b><span>当前余额合计</span></div>
                <div><b>{data.summary.activeUsers}</b><span>30 天活跃</span></div>
                <div><b>{data.summary.reportCount}</b><span>成果产出</span></div>
              </div>
              {data.users.length === 0 && <div className="empty">还没有权益点流水。</div>}
              {data.users.map((u) => (
                <div key={u.id} className="usage-row">
                  <div className="usage-h">
                    <div className="usage-name">{u.name}<span>{u.phone}</span></div>
                    <div className="usage-num">{u.totalSpent} 次</div>
                  </div>
                  <div className="usage-meta">赠送 {u.totalGranted} · 余额 {creditText(u.creditBalance)} · 成果 {u.deliverableCount}</div>
                  <div className="meter"><i style={{ width: `${Math.max(3, Math.round((u.totalSpent / maxSpent) * 100))}%` }} /></div>
                </div>
              ))}
            </div>
          );
        }}
      </ViewState>
    </>
  );
}

export function TokenUsageView({ onOpenUser }: { onOpenUser: (id: string) => void }) {
  const [range, setRange] = useState<DateRangeValue>({ days: 30, from: '', to: '' });
  const res = useResource(
    useCallback(() => api.tokenUsage(range.days ? { days: range.days } : { from: range.from, to: range.to }), [range]),
    [range],
  );
  return (
    <>
      <PageHead k="tokens" res={res} badge={res.data?.range ? `${res.data.range.fromDate} 至 ${res.data.range.toDate}` : undefined} />
      <div className="pad"><DateRangeFilter value={range} onChange={setRange} /></div>
      <ViewState res={res} skeleton="stats">
        {(data: AdminTokenUsageView) => <TokenUsageBody data={data} onOpenUser={onOpenUser} />}
      </ViewState>
    </>
  );
}

function TokenUsageBody({ data, onOpenUser }: { data: AdminTokenUsageView; onOpenUser: (id: string) => void }) {
  const { totals, byModel, topUsers, infra } = data;
  const maxModelCost = Math.max(1, ...byModel.map((m) => m.costMicros));
  const unpriced = byModel.some((m) => !m.calibrated);
  const infraTokens = infra.reduce((a, x) => a + x.totalTokens, 0);
  const infraCost = infra.reduce((a, x) => a + x.costMicros, 0);
  return (
    <>
      <div className="pad">
        <div className="usage-summary">
          <div><b>{fmtTokens(totals.totalTokens)}</b><span>总 Token</span></div>
          <div><b>{fmtCny(totals.costMicros)}</b><span>成本</span></div>
          <div><b>{totals.calls}</b><span>调用次数</span></div>
          <div><b>{fmtTokens(totals.outputTokens)}</b><span>输出 Token</span></div>
        </div>
        {totals.calls === 0 && (
          <div className="usage-meta" style={{ padding: '10px 0' }}>
            暂无 token 记录。仅真实 Claude / OpenAI 调用计量；本地模板（mock）与 Dify 不计。
          </div>
        )}
        {byModel.length > 0 && (
          <>
            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">按模型</span>{unpriced && <span className="s">部分模型未配单价（计 0）</span>}</div>
            {byModel.map((m) => (
              <div key={m.model} className="usage-row">
                <div className="usage-h">
                  <div className="usage-name">{m.model}{!m.calibrated && <span>未配价</span>}</div>
                  <div className="usage-num">{fmtCny(m.costMicros)}</div>
                </div>
                <div className="usage-meta">{m.calls} 次 · {fmtTokens(m.totalTokens)} token</div>
                <div className="meter"><i style={{ width: `${Math.max(3, Math.round((m.costMicros / maxModelCost) * 100))}%` }} /></div>
              </div>
            ))}
          </>
        )}
        {topUsers.length > 0 && (
          <>
            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">Top 用户</span><span className="s">按成本 · 点击看详情</span></div>
            {topUsers.map((u) => (
              <div key={u.userId} className="usage-row" style={{ cursor: 'pointer' }} onClick={() => onOpenUser(u.userId)}>
                <div className="usage-h">
                  <div className="usage-name">{u.name ?? '（未命名）'}<span>{u.userId.slice(0, 8)}</span></div>
                  <div className="usage-num">{fmtCny(u.costMicros)}</div>
                </div>
                <div className="usage-meta">{fmtTokens(u.totalTokens)} token</div>
              </div>
            ))}
          </>
        )}
        {infra.length > 0 && (
          <>
            <div className="sec-h" style={{ marginTop: 6 }}><span className="t">非用户用量消耗</span><span className="s">嵌入 / 重排 / 辅助抽取 / 探活 / 沙盒 · 不计入用户用量，但都是真实花掉的钱</span></div>
            <div className="usage-summary" style={{ gridTemplateColumns: '1fr 1fr' }}>
              <div><b>{fmtTokens(infraTokens)}</b><span>基建 Token</span></div>
              <div><b>{fmtCny(infraCost)}</b><span>基建成本（未配单价则计 0）</span></div>
            </div>
            {infra.map((x) => (
              <div key={x.kind + x.model} className="usage-row">
                <div className="usage-h">
                  <div className="usage-name">{INFRA_KIND_LABEL[x.kind] ?? x.kind}<span>{x.model}</span></div>
                  <div className="usage-num">{fmtCny(x.costMicros)}</div>
                </div>
                <div className="usage-meta">{x.calls} 次 · {fmtTokens(x.totalTokens)} token</div>
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}
