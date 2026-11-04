// 供应商（石榴）—— 额度还剩多少、我方库和对面对不对得上。
//
// 这一屏是**手动刷新**的：它实时打上游、还要和本地库逐条比对，慢。
// 放进轮询会给供应商和自己的库都加一份没人看的负载。
//
// 对账要能落到「具体是哪一条」，不能只给数字。原来这里只显示计数，运营看到
// 「1 条对不上」也不知道去石榴后台找哪一个 —— 而且那几个计数字段服务端根本不返回
// （契约写错了），实际显示成「NaN 条对不上」。现在直接列明细。
import { useCallback, useState } from 'react';
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
        {(v) => {
          const exhausted = v.quota.avatarSlotsExhausted || v.quota.speakerSlotsExhausted;
          const orphans = v.avatars.orphan.length + v.voices.orphan.length;
          return (
            <>
              {v.mock && (
                <div className="note" style={{ marginBottom: 12 }}>
                  <b>当前是 mock 模式</b> —— 下面的数字不是真的向石榴查来的，只是本地假数据。
                  生产上看到这个说明供应商凭证没配上。
                </div>
              )}

              {/* 额度读失败要单独说。混在「0 个槽位」里会让人以为额度用完了，那是完全相反的结论 */}
              {v.quota.error ? (
                <div className="err" style={{ marginBottom: 12 }}>额度读不到：{v.quota.error}</div>
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
                    <b style={{ fontSize: 14 }}>{v.quota.validToTime ?? '—'}</b>
                    <span>有效期至</span>
                  </div>
                </div>
              )}

              {/* 槽位用尽 + 有孤儿 = 有现成的解法，把这层关系直接说出来，别让人自己拼 */}
              {exhausted && (
                <div className="err" style={{ marginBottom: 12 }}>
                  有槽位已经用尽 —— 用户现在<b>训不了</b>新的数字人 / 声音，提交会失败。
                  {orphans > 0 && <>下面有 <b>{orphans} 条孤儿</b>（石榴有、我方无）正白占着槽位，清掉就能腾出来。</>}
                </div>
              )}

              <Recon title="数字人" r={v.avatars} />
              <Recon title="声音" r={v.voices} />

              <div className="note" style={{ marginTop: 12 }}>
                查于 {fmtTime(v.checkedAt)}。这一屏不自动刷新 —— 它要实时打供应商并逐条比对本地库，
                放进轮询是给两边都加一份没人看的负载。
              </div>
            </>
          );
        }}
      </View>
    </>
  );
}

/**
 * 一类资源的对账结果。
 *
 * 四类各自的含义与处置都不同，所以分开列，每条都带能去对面找到它的标识：
 *   匹配   两边都有，正常。默认折叠 —— 它是多数，摊开会把要处理的那几条淹掉
 *   孤儿   石榴有、我方无。白占槽位、照样收钱，可安全清理。**只有 engineRef 和石榴侧标题**
 *          （本地压根没这条记录，所以给不出本地名字，也没有封面可看）
 *   悬挂   我方有、石榴无。用户看得到但一提交就失败
 *   未对账 本地行但不参与对账（训练中 / mock 残留），单列只为解释行数差
 */
function Recon({ title, r }: { title: string; r: Reconcile }) {
  const [openMatched, setOpenMatched] = useState(false);

  if (r.error) {
    return (
      <div className="row" style={{ marginBottom: 8 }}>
        <div className="row-h"><span className="row-t">{title}</span></div>
        {/* 读失败 ≠ 对面是空的。绝不能显示成「0 个孤儿、全部悬挂」 */}
        <div className="err" style={{ marginTop: 8 }}>对账没做成：{r.error}（不代表石榴那边是空的）</div>
      </div>
    );
  }

  const bad = r.orphan.length + r.dangling.length + r.unmatchable.length;

  return (
    <div className="row" style={{ marginBottom: 8 }}>
      <div className="row-h">
        <span className="row-t">{title}</span>
        <span className={`tag ${bad === 0 ? 'ok' : 'warn'}`}>{bad === 0 ? '对得上' : `${bad} 条要看`}</span>
        <span className="row-n">{r.matched.length} / {r.localCount}</span>
      </div>
      <div className="row-m">
        对面 {r.vendorCount ?? '—'} 条 · 我方 {r.localCount} 条 · 匹配 {r.matched.length} 条
      </div>

      {r.orphan.length > 0 && (
        <Group
          label={`孤儿 ${r.orphan.length}`}
          hint="石榴有、我方无 —— 白占槽位还照样收钱，确认后可以在石榴后台删掉。本地没有这条记录，所以只能按下面的标题和 ID 去对面找。"
          tone="warn"
        >
          {r.orphan.map((x) => (
            <Item key={x.engineRef} name={x.vendorTitle || '（对面没给标题）'} meta={`石榴 ID ${x.engineRef}`} />
          ))}
        </Group>
      )}

      {r.dangling.length > 0 && (
        <Group
          label={`悬挂 ${r.dangling.length}`}
          hint="我方有、石榴无 —— 上游被删了本地没同步。用户在小程序里看得到，一用就失败。"
          tone="danger"
        >
          {r.dangling.map((x) => (
            <Item
              key={x.localId}
              name={x.localName || '（没有名字）'}
              meta={`本地 ${x.localId} · 属主 ${x.ownerUserId} · 状态 ${x.engineStatus} · 石榴 ID ${x.engineRef} · 更新于 ${fmtTime(x.updatedAt)}`}
            />
          ))}
        </Group>
      )}

      {r.unmatchable.length > 0 && (
        <Group
          label={`未对账 ${r.unmatchable.length}`}
          hint="本地行，但本来就没有对应的上游对象，所以不算孤儿也不算悬挂。列在这里只是解释「为什么本地行数对不上」。"
        >
          {r.unmatchable.map((x) => (
            <Item
              key={x.localId}
              name={x.localName || '（没有名字）'}
              meta={`本地 ${x.localId} · 属主 ${x.ownerUserId} · 状态 ${x.engineStatus} · ${
                x.reason === 'training' ? '还没拿到石榴 ID（训练中或训练失败）'
                  : x.reason === 'mock' ? 'mock 时代的残留数据'
                    : x.reason
              }`}
            />
          ))}
        </Group>
      )}

      {r.matched.length > 0 && (
        <>
          <button
            type="button" className="btn" style={{ marginTop: 9 }}
            onClick={() => setOpenMatched((v) => !v)}
          >{openMatched ? '收起' : `展开匹配的 ${r.matched.length} 条`}</button>
          {openMatched && (
            <div style={{ marginTop: 8 }}>
              {r.matched.map((x) => (
                <Item
                  key={x.localId}
                  name={x.localName || '（没有名字）'}
                  meta={`本地 ${x.localId} · 属主 ${x.ownerUserId} · 状态 ${x.engineStatus} · 石榴「${x.vendorTitle}」${x.engineRef}`}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Group({ label, hint, tone, children }: {
  label: string; hint: string; tone?: 'warn' | 'danger'; children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginBottom: 4 }}>
        <span className={`tag ${tone ?? ''}`}>{label}</span>
      </div>
      <div className="row-m" style={{ marginTop: 0, marginBottom: 6 }}>{hint}</div>
      {children}
    </div>
  );
}

/** 一条明细。名字在前、标识在后 —— 运营先认名字，拿 ID 才是去对面搜。 */
function Item({ name, meta }: { name: string; meta: string }) {
  return (
    <div style={{ padding: '7px 9px', background: 'var(--sunken)', borderRadius: 8, marginBottom: 5 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{name}</div>
      <div className="row-m" style={{ marginTop: 2 }}>{meta}</div>
    </div>
  );
}
