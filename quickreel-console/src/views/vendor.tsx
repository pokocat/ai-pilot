// 供应商（石榴）—— 额度还剩多少、我方库和对面对不对得上。
//
// 这一屏是**手动刷新**的：它实时打上游、还要和本地库逐条比对，慢。
// 放进轮询会给供应商和自己的库都加一份没人看的负载。
import { useCallback } from 'react';
import { api, type ClipVendorOverview } from '../api';
import { View, fmtTime, useResource } from '../components';

type Reconcile = ClipVendorOverview['avatars'];

export function VendorView({ onAuthLost }: { onAuthLost: () => void }) {
  const res = useResource(useCallback(() => api.vendor(), []), [], onAuthLost);

  return (
    <>
      <div className="head">
        <h1>供应商</h1>
        <span className="sub">石榴额度 · 与我方库对账</span>
        <span className="spacer" />
        <button type="button" className="btn" disabled={res.loading} onClick={res.reload}>
          {res.loading ? '查…' : '重新查'}
        </button>
      </div>

      <View res={res} skeleton={3}>
        {(v) => (
          <>
            {v.mock && (
              <div className="note" style={{ marginBottom: 12 }}>
                <b>当前是 mock 模式</b> —— 下面的数字不是真的向石榴查来的，只是本地假数据。
                生产上看到这个说明供应商凭证没配上。
              </div>
            )}

            {/* 额度读失败要单独说。混在「0 个槽位」里会让人以为额度用完了，那是完全相反的结论 */}
            {v.quota.error ? (
              <div className="err" style={{ marginBottom: 12 }}>
                额度读不到：{v.quota.error}
              </div>
            ) : (
              <div className="stats">
                <div className={`stat ${v.quota.avatarSlotsExhausted ? 'alert' : ''}`}>
                  <b>{v.quota.availableAvatar ?? '—'}</b>
                  <span>数字人槽位{v.quota.avatarSlotsExhausted ? ' · 已用尽' : ''}</span>
                </div>
                <div className={`stat ${v.quota.speakerSlotsExhausted ? 'alert' : ''}`}>
                  <b>{v.quota.availableSpeaker ?? '—'}</b>
                  <span>声音槽位{v.quota.speakerSlotsExhausted ? ' · 已用尽' : ''}</span>
                </div>
                <div className="stat">
                  <b>{v.quota.validPoint?.toLocaleString() ?? '—'}</b>
                  <span>剩余算力</span>
                </div>
                <div className="stat">
                  <b style={{ fontSize: 14 }}>{v.quota.validToTime ? fmtTime(v.quota.validToTime) : '—'}</b>
                  <span>有效期至</span>
                </div>
              </div>
            )}

            {(v.quota.avatarSlotsExhausted || v.quota.speakerSlotsExhausted) && (
              <div className="err" style={{ marginBottom: 12 }}>
                有槽位已经用尽 —— 用户现在<b>训不了</b>新的数字人 / 声音，提交会失败。要么去供应商那儿扩容，要么清理不用的。
              </div>
            )}

            <Recon title="数字人" r={v.avatars} />
            <Recon title="声音" r={v.voices} />

            <div className="note" style={{ marginTop: 12 }}>
              查于 {fmtTime(v.checkedAt)}。这一屏不自动刷新 —— 它要实时打供应商并逐条比对本地库，
              放进轮询是给两边都加一份没人看的负载。
            </div>
          </>
        )}
      </View>
    </>
  );
}

/**
 * 一类资源的对账结果。
 *
 * 三个词的意思要写出来，否则没人分得清：
 *   孤儿  对面有、我方库没有 —— 多半是我方写库失败，用户付了钱却看不到
 *   悬空  我方库有、对面没有 —— 用户看得到但用不了，提交会失败
 *   对不上 两边都有但认不到一起，需要人工看
 */
function Recon({ title, r }: { title: string; r: Reconcile }) {
  if (r.error) {
    return (
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="row-h"><span className="row-t">{title}</span></div>
        <div className="err" style={{ marginTop: 8 }}>对账没做成：{r.error}</div>
      </div>
    );
  }
  const bad = r.orphanCount + r.danglingCount + r.unmatchableCount;
  return (
    <div className="row" style={{ marginBottom: 8 }}>
      <div className="row-h">
        <span className="row-t">{title}</span>
        <span className={`tag ${bad === 0 ? 'ok' : 'warn'}`}>{bad === 0 ? '对得上' : `${bad} 条对不上`}</span>
        <span className="row-n">{r.matchedCount} / {r.localCount}</span>
      </div>
      <div className="row-m">
        对面 {r.vendorCount ?? '—'} 条 · 我方 {r.localCount} 条 · 匹配 {r.matchedCount} 条
        {bad > 0 && (
          <>
            <br />
            {r.orphanCount > 0 && <>孤儿 {r.orphanCount}（对面有我方没有，多半是写库失败，用户付了钱看不到）</>}
            {r.orphanCount > 0 && (r.danglingCount > 0 || r.unmatchableCount > 0) && ' · '}
            {r.danglingCount > 0 && <>悬空 {r.danglingCount}（我方有对面没有，用户看得到但一提交就失败）</>}
            {r.danglingCount > 0 && r.unmatchableCount > 0 && ' · '}
            {r.unmatchableCount > 0 && <>对不上 {r.unmatchableCount}（两边都有但认不到一起，要人工看）</>}
          </>
        )}
      </div>
    </div>
  );
}
