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
  type ClipAdminTemplate,
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

/**
 * 爱速拍 · 模板货架。
 *
 * 模板就是爱速拍的首页：用户进来第一屏就是挑模板，内容即产品。而在这之前**没有任何控制台
 * 能碰它** —— AIStar 的 /api/admin/clip/templates 要一枚 staff JWT，军师 BFF 只有 service token，
 * 全仓也没有任何前端调过那几条接口。运营要下架一个模板，只能 curl + 手搓 JWT。
 *
 * **只做看和上下架。** 模板的文案骨架 / 时间线 / 片尾是内容创作产物，不是几个表单字段；
 * 给它做半吊子的编辑表单，运营一存就可能把配好的片尾和分镜清掉。创建与整体编辑仍走
 * AIStar 那边，或由内容同学导入。
 */
export function ClipTemplatesView({ toast, isSuper }: { toast: (m: string) => void; isSuper: boolean }) {
  const res = useResource(useCallback(() => api.clipTemplates(), []), []);
  const [busy, setBusy] = useState('');
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);

  const toggle = (t: ClipAdminTemplate) => {
    const next = t.status === 'published' ? 'draft' : 'published';
    setConfirmSpec({
      title: next === 'published' ? '上架模板' : '下架模板',
      desc: next === 'published'
        ? '上架后，小程序首页的模板货架里立刻能看到它，用户可以直接拿它开始做片子。'
        : '下架后，小程序里看不到它了。已经用它做过的草稿和作品不受影响，不会被删。',
      echo: [
        { k: '模板', v: t.name },
        { k: '行业', v: t.industry || '（未填）' },
        { k: '时长 / 分段', v: `${t.estDurationSec} 秒 · ${t.segmentCount} 段` },
      ],
      confirmText: next === 'published' ? '上架' : '下架',
      onConfirm: async () => {
        setBusy(t.id);
        try {
          await api.setClipTemplateStatus(t.id, next);
          toast(next === 'published' ? `已上架「${t.name}」` : `已下架「${t.name}」`);
          res.reload();
        } finally { setBusy(''); }
      },
    });
  };

  const published = (res.data ?? []).filter((t) => t.status === 'published').length;

  return (
    <>
      <PageHead
        k="templates"
        res={res}
        badge={res.data ? `${published}/${res.data.length} 已上架` : undefined}
      />
      <div className="pad">
        <div className="usage-meta">
          模板是爱速拍的首页货架，用户进来第一屏就是挑它。这里只管**看和上下架** ——
          文案骨架、时间线、片尾这些是内容创作产物，不做成表单：一个字段没填对就可能把配好的
          分镜清掉。新建模板与整体编辑走内容侧导入。
        </div>
        {/* 读失败绝不能长成「货架是空的」—— 那会让人以为模板被清了，跑去重新导一遍 */}
        <ViewState res={res}>
          {(list: ClipAdminTemplate[]) => (
            <>
              {list.length === 0 ? (
                <EmptyState msg="还没有模板" hint="模板由内容侧导入，导入后在这里上架" />
              ) : list.map((t) => (
                <div key={t.id} className="usage-row">
                  <div className="usage-h">
                    <div className="usage-name">
                      {t.name}
                      <span>{t.status === 'published' ? '已上架' : '未上架'}</span>
                    </div>
                    <div className="usage-num">{t.estDurationSec}s</div>
                  </div>
                  <div className="usage-meta">
                    {t.industry || '未分类'} · {t.themeKey} · {t.segmentCount} 段
                    {t.creditHint ? ` · 约 ${t.creditHint} 钻` : ''}
                    {t.ownerScope !== 'official' ? ' · 用户自建' : ''}
                    {t.description ? ` · ${t.description}` : ''}
                  </div>
                  <div className="crd-actions">
                    {isSuper ? (
                      <button
                        type="button"
                        className={`mini-btn ${t.status === 'published' ? '' : 'primary'}`}
                        disabled={busy === t.id}
                        onClick={() => toggle(t)}
                      >{t.status === 'published' ? '下架' : '上架'}</button>
                    ) : (
                      <span className="usage-meta">上下架会改变小程序首页，需要超级管理员</span>
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </ViewState>
      </div>
      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}
