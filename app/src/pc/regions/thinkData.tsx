// 锦囊 · 账号与数据。
//
// 这一区只做两件事：把「哪些经营来源已经在军师手里」摆清楚，以及给每个来源一个能落地的下一步。
// 真正的 OAuth 授权和账号矩阵管理都不在 PC 一期范围内（矩阵是独立小程序），所以顶部两张入口卡
// 只交代现状、不假装能点进去；能落地的动作是每条来源的「预约开通授权 / 上传替代资料」——
// 与移动端 thinktank 的 data 分区同一套接口，状态与三个统计数都由服务端算，前端不自己推。

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../hooks/useStore';
import { api, type DataSourceView, type DataSourcesView } from '../../services/api';
import { requireAuth } from '../authBridge';
import type { PcState } from '../state';
import './thinkSide.scss';

/**
 * 状态 → 状态 pill 配色档，与移动端 thinktank 的 dsClass 同一口径。
 * 只有 uploaded 走告警红：那条状态的文案是「待上传」——主公已经认下要补资料却还没传，是欠账；
 * unbound 的「上传即可 / 高级」只是还没开始，用金色提示即可，不该同样刺眼。
 */
function pillTone(d: DataSourceView): string {
  if (d.status === 'bound') return ' pc-ok';
  if (d.status === 'uploaded') return ' pc-miss';
  return ' pc-warn';
}

/** 抽屉里那句「现在是什么状态、下一步等谁」。statusLabel 太短，撑不起详情。 */
function statusBody(d: DataSourceView): string {
  switch (d.status) {
    case 'bound': return '已接入。军师做判断时会直接用上这条来源的数据。';
    case 'uploaded': return '替代资料已提交，整理完成后并入判断。';
    case 'auth_requested': return '已登记开通，服务老师会联系你完成授权。';
    default: return d.tier === 'advanced'
      ? '需要一次性授权。登记后由服务老师协助开通，不需要你自己配后台。'
      : '还没有数据。先上传一份替代资料，军师就能先用起来。';
  }
}

const HUBS = [
  {
    key: 'matrix', ic: '阵', t: '账号矩阵',
    s: '按账号类型、项目、平台和授权状态统一管理。',
    m: '独立矩阵小程序 · 即将上线', em: '待上线',
    tip: '账号矩阵是独立小程序，即将上线；账号绑定先在下面的「经营来源」里做。',
  },
  {
    key: 'memory', ic: '忆', t: '持续记忆',
    s: '个人微信、会议和日历构成持续记忆，你确认后才回写判断。',
    m: '可单独开通 · 只读导入 · 支持删除', em: '查看',
    tip: '持续记忆的开通与管理暂在微信小程序内，PC 一期只看状态。',
  },
];

export default function ThinkData({ st }: { st: PcState }) {
  const s = useStore();
  const authed = s.isAuthed();

  const [view, setView] = useState<DataSourcesView | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    // 游客不发请求：/data-sources 是私有接口，401 只会白跑一趟。骨架照铺，登录后自然重取。
    if (!s.isAuthed()) { setView(null); setFailed(false); return; }
    setLoading(true);
    setFailed(false);
    try {
      setView(await api.dataSources());
    } catch (e) {
      s.handleApiError(e, { silent: true });
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [s]);

  useEffect(() => { void load(); }, [load, authed]);

  const bind = async (d: DataSourceView) => {
    if (!requireAuth('profile')) return;
    try {
      // 高级来源只做开通登记（真授权走人工），基础来源记一笔「以替代资料顶上」。
      const next = d.tier === 'advanced'
        ? await api.requestDataSourceAuth(d.key)
        : await api.uploadDataSource(d.key);
      setView(next);
      st.closeDrawer();
      st.say(d.tier === 'advanced' ? '已预约开通，服务老师会联系你' : '已记为替代资料，去案卷资产把文件传上来');
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '操作失败，请重试' });
    }
  };

  const openSource = (d: DataSourceView) => {
    st.setDrawer({
      kicker: '数 据 授 权',
      title: d.label,
      quote: d.desc,
      blocks: [
        { label: '当 前 状 态', title: d.statusLabel, body: statusBody(d) },
        { label: '读 取 范 围', title: '只读当前案卷需要的数据', body: d.scope.join(' · ') || '按来源默认范围读取' },
        {
          label: '同 步 与 隐 私',
          title: '每日复盘前刷新一次',
          body: '回写位置：战局、执行、方案。\n可随时暂停或删除这条来源，已经出过的判断不会被追溯改写。',
        },
      ],
      actions: [
        { t: d.tier === 'advanced' ? '预约开通授权' : '上传替代资料', primary: true, go: () => { void bind(d); } },
      ],
    });
  };

  const sources = view?.sources ?? [];
  const basic = sources.filter((d) => d.tier === 'basic');
  const advanced = sources.filter((d) => d.tier === 'advanced');
  const num = (n: number | undefined) => (view ? String(n ?? 0) : '—');

  const list = (rows: DataSourceView[]) => (
    <div className="pc-ds-list">
      {rows.map((d) => (
        <button type="button" key={d.key} className="pc-ds-row" onClick={() => openSource(d)}>
          <span className="pc-ds-ic">{d.icon}</span>
          <span className="pc-ds-b">
            <span className="pc-ds-t">{d.label}</span>
            <span className="pc-ds-s">{d.desc}</span>
          </span>
          <span className={`pc-ds-pill${pillTone(d)}`}>{d.statusLabel}</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="pc-page">
      <div className="pc-side-hero">
        <div className="pc-side-hero-k">账号资产 · 持续记忆 · 经营数据</div>
        <div className="pc-side-hero-t">让军师长期理解你正在做什么</div>
        <div className="pc-side-hero-d">
          内容账号连接执行与复盘，个人微信、会议和日历形成持续记忆。每个来源独立授权，也可以随时暂停和删除。
        </div>
        <div className="pc-side-metrics">
          <div>
            <div className="pc-side-mv">{num(view?.bound)}</div>
            <div className="pc-side-ml">已绑定</div>
          </div>
          <div>
            <div className="pc-side-mv">{num(view?.needed)}</div>
            <div className="pc-side-ml">待补关键项</div>
          </div>
          <div>
            <div className="pc-side-mv">{num(view?.total)}</div>
            <div className="pc-side-ml">类经营来源</div>
          </div>
        </div>
      </div>

      <div className="pc-side-label">入 口</div>
      <div className="pc-ds-hubs">
        {HUBS.map((h) => (
          <button type="button" key={h.key} className="pc-ds-hub" onClick={() => st.say(h.tip)}>
            <span className="pc-ds-hub-ic">{h.ic}</span>
            <span className="pc-ds-hub-b">
              <span className="pc-ds-hub-t">{h.t}</span>
              <span className="pc-ds-hub-s">{h.s}</span>
              <span className="pc-ds-hub-m">{h.m}</span>
            </span>
            <span className="pc-ds-hub-em">{h.em}</span>
          </button>
        ))}
      </div>

      <div className="pc-side-label">经 营 来 源</div>
      {!authed ? (
        <div className="pc-side-note">
          <span className="pc-side-note-t">登录后才看得到你已接入哪些来源，以及还缺哪几项关键数据。</span>
          <button type="button" className="pc-btn pc-primary" onClick={() => requireAuth('profile')}>登录</button>
        </div>
      ) : failed ? (
        <div className="pc-side-note">
          <span className="pc-side-note-t">经营来源没取到，可能是网络断了。</span>
          <button type="button" className="pc-btn" onClick={() => { void load(); }}>重试</button>
        </div>
      ) : loading && !view ? (
        <div className="pc-side-skel">
          <div className="pc-side-skel-b pc-tall" />
          <div className="pc-side-skel-b" />
        </div>
      ) : basic.length === 0 && advanced.length === 0 ? (
        <div className="pc-side-note">
          <span className="pc-side-note-t">还没有可接入的经营来源，先去案卷资产传一份资料，军师会告诉你缺什么。</span>
        </div>
      ) : (
        <>
          {basic.length > 0 && list(basic)}
          {advanced.length > 0 && (
            <>
              {/* 高级来源要人工开通、口径也不同（持续读取而非一次性上传），与基础来源混在一张表里会让
                  「点一下就能补上」的预期落空，所以单独起一段。 */}
              <div className="pc-side-label">高 级 授 权</div>
              {list(advanced)}
            </>
          )}
        </>
      )}
    </div>
  );
}
