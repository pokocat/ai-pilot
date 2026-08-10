// 锦囊 · 能力。
//
// 目录本身是公开的（GET /modules 不带 token 也返回 listPublicModules），所以游客照样能翻能力清单，
// 只有「启用」这一步才过登录门 —— 让人先看清楚买的是什么，再谈登录，比反过来讲得通。
//
// 支付：PC 一期不接微信支付，也不允许 import services/pay（那个模块仍绑 Taro，一引用整个 Taro 运行时
// 就被拖回 PC 包，构建守卫会直接红）。所以 tier='sku' 的单次购买只给引导文案，不下单；
// tier='credits'/'member' 走的是 enableModule（扣算力 / 核销会员权益，不经支付），PC 可以直接启用。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../hooks/useStore';
import { api, type ModuleTier, type ModuleView, type ModulesView } from '../../services/api';
import { apiErrorCode } from '../../services/apiError';
import { requireAuth } from '../authBridge';
import type { PcState } from '../state';
import { chatKeyOf } from './sessions';
import './thinkSide.scss';

/** tier → 卡片右上角徽章。移动端那套「免费绿 / 单次金 / 算力蓝 / 会员黑」里没有蓝，
 *  PC 只用 index.scss 已定义的变量，算力档退到中性墨色（详见汇报）。 */
const TIER_BADGE: Record<ModuleTier, { label: string; cls: string }> = {
  free: { label: '免费', cls: ' pc-free' },
  sku: { label: '单次', cls: ' pc-sku' },
  credits: { label: '算力', cls: '' },
  member: { label: '会员', cls: ' pc-member' },
};

const BUY_IN_WEAPP = '这项能力要单独购买，PC 一期不做支付，请在微信小程序内购买后回来启用';

export default function ThinkModules({ st }: { st: PcState }) {
  const s = useStore();
  const authed = s.isAuthed();

  const [view, setView] = useState<ModulesView | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setView(await api.modules());
    } catch (e) {
      s.handleApiError(e, { silent: true });
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [s]);

  // authed 进依赖：登录后同一份目录会带上「已启用」，得重取一次才不会停在游客态。
  useEffect(() => { void load(); }, [load, authed]);

  const modules = useMemo(() => {
    const list = (view?.modules ?? []).filter((m) => !m.hidden);
    const recKey = view?.recommended?.key;
    if (!recKey) return list;
    // 推荐位在设计稿里没有独立卡位，就让它排在最前 + 状态行加「推荐」前缀，不另造 UI。
    return [...list].sort((a, b) => Number(b.key === recKey) - Number(a.key === recKey));
  }, [view]);

  const stat = (g: ModuleView['group']) => modules.filter((m) => m.group === g).length;

  const enable = async (m: ModuleView) => {
    if (!requireAuth('save')) return;
    try {
      await api.enableModule(m.key);
      st.closeDrawer();
      await load();
      st.say(`已启用「${m.label}」，结论回写到${m.detail.writeback}`);
    } catch (e) {
      // 这几种是「差一步权益」，不是故障：给一句该去哪补，比抛通用错误文案有用。
      const code = apiErrorCode(e);
      if (code === 'INSUFFICIENT_CREDITS') st.say('算力不足，请在微信小程序内补充算力后再启用');
      else if (code === 'PLAN_REQUIRED') st.say('这项能力要先开通方案，请在微信小程序内开通');
      else if (code === 'PLAN_EXPIRED') st.say('会员已过期，续费后可继续使用');
      else if (code === 'SKU_REQUIRED') st.say(BUY_IN_WEAPP);
      else s.handleApiError(e, { fallbackTitle: '启用失败，请重试' });
    }
  };

  /** 已启用/免费能力的「立即使用」：能力本身不产出内容，真正干活的是承接军师，所以送去问策区。 */
  const useNow = (m: ModuleView) => {
    st.closeDrawer();
    if (!m.agentKey) { st.say(`「${m.label}」已启用，产出会回写到${m.detail.writeback}`); return; }
    st.go('sessions');
    st.setChatKey(chatKeyOf({ kind: 'fresh', agentKey: m.agentKey }));
    st.say(`已另起一炉，把「${m.label}」要处理的情况说给军师`);
  };

  const openModule = (m: ModuleView) => {
    const callable = m.enabled || m.tier === 'free';
    const price = m.price?.priceFen ? `¥${m.price.priceFen / 100}` : '';
    st.setDrawer({
      kicker: '能 力 详 情',
      title: m.label,
      quote: m.detail.scene,
      blocks: [
        { label: '当 前 状 态', title: m.stateLabel, body: m.desc },
        {
          label: '输 入 · 产 出 · 消 耗',
          title: m.detail.output,
          body: `输入：${m.detail.input}\n消耗：${m.detail.cost}\n回写位置：${m.detail.writeback}`,
        },
        ...(!callable && m.tier === 'sku' ? [{
          label: '怎 么 开 通',
          title: price ? `${price} 单次购买` : '单次购买',
          body: 'PC 一期不做支付。在微信小程序内买下这项能力后，回到这里就是已启用状态。',
        }] : []),
      ],
      actions: callable
        ? [{ t: '立即使用', primary: true, go: () => useNow(m) }]
        : m.tier === 'sku'
          ? [{ t: '请在微信小程序内购买', go: () => st.say(BUY_IN_WEAPP) }]
          : [{
            t: m.tier === 'credits' ? `消耗 ${m.price?.credits ?? 0} 算力启用` : '启用会员权益',
            primary: true,
            go: () => { void enable(m); },
          }],
    });
  };

  return (
    <div className="pc-page">
      <div className="pc-side-hero">
        <div className="pc-side-hero-k">能力中心</div>
        <div className="pc-side-hero-t">按当前案卷选能力</div>
        <div className="pc-side-hero-d">免费能力先判断，深度能力做推演，会员模块负责长期执行。</div>
        <div className="pc-side-metrics">
          <div>
            <div className="pc-side-mv">{view ? stat('free') : '—'}</div>
            <div className="pc-side-ml">免费可用</div>
          </div>
          <div>
            <div className="pc-side-mv">{view ? stat('deep') : '—'}</div>
            <div className="pc-side-ml">深度能力</div>
          </div>
          <div>
            <div className="pc-side-mv">{view ? stat('member') : '—'}</div>
            <div className="pc-side-ml">会员模块</div>
          </div>
        </div>
      </div>

      {failed && !view ? (
        <div className="pc-side-note pc-gap">
          <span className="pc-side-note-t">能力目录没取到，可能是网络断了。</span>
          <button type="button" className="pc-btn" onClick={() => { void load(); }}>重试</button>
        </div>
      ) : loading && !view ? (
        <div className="pc-mod-grid">
          {[0, 1, 2, 3, 4, 5].map((i) => <div className="pc-side-skel-b pc-tall" key={i} />)}
        </div>
      ) : modules.length === 0 ? (
        <div className="pc-side-note pc-gap">
          <span className="pc-side-note-t">能力目录还是空的，稍后再看看。</span>
        </div>
      ) : (
        <div className="pc-mod-grid">
          {modules.map((m) => {
            const badge = TIER_BADGE[m.tier];
            const recommended = view?.recommended?.key === m.key;
            return (
              <button type="button" key={m.key} className="pc-mod-card" onClick={() => openModule(m)}>
                <span className="pc-mod-ic">{m.iconChar}</span>
                <span className="pc-mod-b">
                  <span className="pc-mod-head">
                    <span className="pc-mod-t">{m.label}</span>
                    <span className={`pc-mod-badge${badge.cls}`}>{badge.label}</span>
                  </span>
                  <span className="pc-mod-d">{m.desc}</span>
                  <span className="pc-mod-state">{recommended ? `当前案卷推荐 · ${m.stateLabel}` : m.stateLabel}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
