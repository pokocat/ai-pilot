// 产品：分产品的钻石账 + 运营账号的产品授权 ——「哪个产品在挣钱、谁能管它」。
//
// 后台是**一个**，按产品分区，不给每个小程序各配一个：产品专属的面很少
// （爱速拍只有模板、单价、供应商对账），而 AI 端点与路由、账号与角色、审计、SKU、
// 钱包流水这些共享面复制 N 份的代价远大于收益，其中角色管理最不该分叉。
//
// 分区键 productCode 与统一账号中心的 product_code 同一命名空间：
// 「令牌来自哪个产品」和「这笔钱花在哪个产品」用同一把尺子，对账不必再做一层映射。
import { useCallback, useState } from 'react';
import { api, type AdminAccountItem } from '../api';
import { PageHead, ViewState, EmptyState } from '../components';
import { useResource } from '../useResource';
import { fmtTime } from '../format';
// 产品码 → 中文名与 nav 共用一份：左栏的视角选择器和这一屏的表头必须叫同一个名字，
// 两处各维护一张表迟早会对不上。
import { productLabel as label } from '../nav';

/** 最近 N 天的起点，交给服务端当 from；不传 to = 查到此刻。 */
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

export function ProductsView({ toast, isSuper }: { toast: (m: string) => void; isSuper: boolean }) {
  const [days, setDays] = useState(30);
  const res = useResource(useCallback(() => api.productLedger(daysAgo(days)), [days]), [days]);
  const perms = useResource(useCallback(() => api.adminProducts(), []), []);

  return (
    <>
      <PageHead k="products" res={res} badge={res.data ? `近 ${days} 天 ${res.data.slices.length} 个产品` : undefined} />
      <div className="pad">
        <div className="filter-bar">
          <div className="chip-row">
            {[7, 30, 90].map((d) => (
              <button key={d} type="button" className={`chip ${days === d ? 'on' : ''}`} onClick={() => setDays(d)}>{d} 天</button>
            ))}
          </div>
        </div>

        {/* 读失败绝不能长成「这段时间没有流水」—— ViewState 把加载中 / 失败（可重试）/ 空态分开 */}
        <ViewState res={res} skeleton="stats">
          {(view) => (
            <>
              <div className="usage-summary">
                <div>
                  <b>{view.slices.reduce((s, r) => s + r.granted, 0).toLocaleString()}</b>
                  <span>卖出（钻石）</span>
                </div>
                <div>
                  <b>{view.slices.reduce((s, r) => s + r.spent, 0).toLocaleString()}</b>
                  <span>消耗（钻石）</span>
                </div>
                <div>
                  <b>{view.slices.reduce((s, r) => s + r.entries, 0).toLocaleString()}</b>
                  <span>流水条数</span>
                </div>
              </div>

              {view.slices.length === 0 ? (
                <EmptyState msg="这段时间没有流水" hint="换个时间范围看看" />
              ) : view.slices.map((row) => (
                <div key={row.productCode} className="usage-row">
                  <div className="usage-h">
                    <div className="usage-name">
                      {label(row.productCode)}
                      {row.productCode === 'unattributed' && <span>历史</span>}
                    </div>
                    <div className="usage-num">{row.spent.toLocaleString()}</div>
                  </div>
                  <div className="usage-meta">
                    卖出 {row.granted.toLocaleString()} · 消耗 {row.spent.toLocaleString()} · {row.entries.toLocaleString()} 条流水
                    {row.productCode === 'unattributed' && ' · 本列上线前的旧流水，无从追认归属'}
                  </div>
                </div>
              ))}

              {/* 这两个词容易被理解反，所以写在表下面，而不是靠列名硬扛 */}
              <div className="usage-meta">
                钱包是一个：用户在军师充的钻石，在爱速拍也花得动。「卖出」= 这批钻石从哪个产品的充值入口卖出去的；
                「消耗」= 这批钻石花在哪个产品上。所以军师打通爱速拍出片不需要跨钱包转账，收入和消耗各归各的，两边的账都对得上。
                窗口 {fmtTime(view.from)} 起{view.to ? `，到 ${fmtTime(view.to)}` : '至今'}。
              </div>
            </>
          )}
        </ViewState>
      </div>

      {isSuper && <ProductGrants toast={toast} products={perms.data?.all ?? []} />}
    </>
  );
}

/**
 * 运营账号的产品授权。
 *
 * 只有超管能改，服务端每次都留审计 —— 权限变更是最需要能倒查的一类操作。
 * 注意：授权只决定「看得见哪个产品的面」，**不放松各个面自己的闸**。
 * 比如改价一直是超管动作（与套餐改价、海报改价同级），
 * 给某人 quickreel 的 editor 也改不动爱速拍的价。
 */
function ProductGrants({ toast, products }: { toast: (m: string) => void; products: string[] }) {
  const accounts = useResource(useCallback(() => api.accounts(), []), []);
  const [openId, setOpenId] = useState('');
  const grants = useResource(
    useCallback(() => (openId ? api.accountProducts(openId) : Promise.resolve(null)), [openId]),
    [openId],
  );
  const [busy, setBusy] = useState('');

  const setRole = async (productCode: string, role: 'viewer' | 'editor' | null) => {
    if (!openId) return;
    setBusy(productCode);
    try {
      await api.setAccountProduct(openId, productCode, role);
      toast(role ? `已授予 ${label(productCode)} · ${role === 'editor' ? '可改' : '只读'}` : `已收回 ${label(productCode)}`);
      grants.reload();
    } catch (e) {
      toast((e as Error).message || '没改成，稍后再试');
    } finally { setBusy(''); }
  };

  const current = (code: string) => grants.data?.grants.find((g) => g.productCode === code)?.role ?? null;

  return (
    <div className="pad">
      <div className="sec-h">
        <span className="t">产品授权</span>
        <span className="s">决定这个运营在后台看得见哪些产品的面；不放松各个面自己的权限（改价仍要超管）</span>
      </div>
      <ViewState res={accounts}>
        {(list: AdminAccountItem[]) => (
          <>
            {list.map((acc) => (
              <div key={acc.id} className="usage-row" style={{ cursor: 'pointer' }} onClick={() => setOpenId(openId === acc.id ? '' : acc.id)}>
                <div className="usage-h">
                  <div className="usage-name">{acc.username}<span>{acc.role}</span></div>
                  <div className="usage-num">{openId === acc.id ? '收起' : '展开'}</div>
                </div>
                {openId !== acc.id ? null : acc.role === 'owner' ? (
                  <div className="usage-meta">超管隐式拥有全部产品，不需要也不能单独授权。</div>
                ) : grants.error ? (
                  <div className="usage-meta">授权读不到：{grants.error}</div>
                ) : (
                  products.map((code) => (
                    <div key={code} className="filter-bar" onClick={(e) => e.stopPropagation()}>
                      <div className="usage-name">{label(code)}</div>
                      <div className="chip-row">
                        {(['viewer', 'editor'] as const).map((r) => (
                          <button
                            key={r}
                            type="button"
                            disabled={busy === code}
                            className={`chip ${current(code) === r ? 'on' : ''}`}
                            onClick={() => setRole(code, current(code) === r ? null : r)}
                          >{r === 'editor' ? '可改' : '只读'}</button>
                        ))}
                        {current(code) && (
                          <button type="button" disabled={busy === code} className="mini-btn danger" onClick={() => setRole(code, null)}>收回</button>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            ))}
          </>
        )}
      </ViewState>
    </div>
  );
}
