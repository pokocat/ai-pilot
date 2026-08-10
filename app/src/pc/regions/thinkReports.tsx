// 锦囊 · 方案。
//
// 方案库是「对话里出过的判断」的留档：同一份方案存一次就多一版，所以卡片上给的是当前版号，
// 抽屉里才是正文与版本链。三个接口分工明确 —— reports() 列表、report(id) 版本历史、
// reportVersion(id, v) 某一版正文；PC 一期不做 diff 视图（reportDiff 留给后续的对照面板）。
//
// 列表接口只有 ReportItem（id/title/type/agentName/currentVersion/updatedAt），**没有摘要字段**。
// 不为了一行摘要给每张卡各发一次详情请求（N+1），改成：打开过的方案把正文首段缓存下来当摘要，
// 没打开过的位置放一句怎么用的提示，并在样式上压暗一档，不冒充真摘要。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../hooks/useStore';
import {
  api,
  type Deliverable, type ReportDetail, type ReportItem, type ReportVersionContent,
} from '../../services/api';
import { cardSection } from '../../services/deliverableSection';
import { acceptDeliverable } from '../../services/dossier';
import { Empty } from '../Chrome';
import { requireAuth } from '../authBridge';
import type { CtxItem, DrawerData, PcState } from '../state';
import './thinkSide.scss';

const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return '刚刚';
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}
function shortTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const metaOf = (r: ReportItem) => [r.type, r.agentName].filter(Boolean).join(' · ');

/** 正文首段当摘要：meta 是服务端给报告写的一句话概述，没有就退到第一节正文。 */
function briefOf(c: Deliverable): string {
  const meta = String(c.meta || '').trim();
  if (meta) return meta;
  for (const sec of c.sections || []) {
    const v = cardSection(sec);
    const text = (v.b || (v.list || []).join('；')).trim();
    if (text) return text;
  }
  return '';
}

export default function ThinkReports({ st }: { st: PcState }) {
  const s = useStore();
  const authed = s.isAuthed();

  const [items, setItems] = useState<ReportItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [briefs, setBriefs] = useState<Record<string, string>>({});

  // 抽屉里的内容是异步拼出来的，而抽屉本身归 Shell 管（✕/Esc/切区都会清掉）。
  // 用这两个 ref 判断「请求回来时，用户还在等的是不是这一份」：
  // 换了一份（token 变了）或抽屉已被关掉（drawerRef 为空）就丢弃结果，绝不把关掉的面板重新推开。
  const drawerRef = useRef<DrawerData | null>(st.drawer);
  drawerRef.current = st.drawer;
  const tokenRef = useRef('');

  const push = (d: DrawerData) => { drawerRef.current = d; st.setDrawer(d); };
  const alive = (token: string) => tokenRef.current === token && !!drawerRef.current;

  const load = useCallback(async () => {
    // 游客不发请求：/reports 是私有接口。
    if (!s.isAuthed()) { setItems([]); setFailed(false); return; }
    setLoading(true);
    setFailed(false);
    try {
      setItems(await api.reports());
    } catch (e) {
      s.handleApiError(e, { silent: true });
      setItems([]);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [s]);

  useEffect(() => { void load(); }, [load, authed]);

  const toOrders = async (r: ReportItem, content: Deliverable) => {
    if (!requireAuth('save')) return;
    try {
      const res = await acceptDeliverable(content, r.agentName || '军师');
      st.closeDrawer();
      // 三种落点分开说：真加了 / 全是重复 / 这份方案压根拆不出可执行动作。
      // 混成一句「已在案」会让「方案写得太虚」被误读成「已经转过了」。
      st.say(res.newOrders > 0
        ? `已转成 ${res.newOrders} 条军令，去点兵区领`
        : res.skippedOrders > 0
          ? '这份方案的军令都已在案，没有重复添加'
          : '这份方案没拆出可执行动作，已存为案卷判断');
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '转军令失败，请重试' });
    }
  };

  /** 打开某一版正文。version 省略 = 当前版。 */
  const openReport = async (r: ReportItem, version?: number) => {
    const token = `${r.id}#${version ?? 'cur'}`;
    tokenRef.current = token;
    push({ kicker: '方 案 详 情', title: r.title, quote: metaOf(r), blocks: [{ label: '正 文', title: '正在取方案内容…', body: '' }] });
    try {
      const [detail, ver] = await Promise.all([api.report(r.id), api.reportVersion(r.id, version)]);
      setBriefs((m) => ({ ...m, [r.id]: briefOf(ver.content) || m[r.id] || '' }));
      if (!alive(token)) return;
      push(contentDrawer(r, detail, ver));
    } catch (e) {
      s.handleApiError(e, { silent: true });
      if (!alive(token)) return;
      push({
        kicker: '方 案 详 情',
        title: r.title,
        quote: metaOf(r),
        blocks: [{ label: '取 数 失 败', title: '方案正文没取到', body: '可能是网络断了，或这份方案已被删除。关掉重开一次试试。' }],
      });
    }
  };

  /** 版本链。DrawerData 是静态结构，所以每一版做成一个 action 按钮，点了就切回正文视图。 */
  const openVersions = async (r: ReportItem) => {
    const token = `${r.id}#versions`;
    tokenRef.current = token;
    push({ kicker: '历 史 版 本', title: r.title, quote: metaOf(r), blocks: [{ label: '版 本 链', title: '正在取版本历史…', body: '' }] });
    try {
      const detail = await api.report(r.id);
      if (!alive(token)) return;
      const versions = [...detail.versions].sort((a, b) => b.version - a.version);
      push({
        kicker: '历 史 版 本',
        title: r.title,
        quote: `共 ${versions.length} 版 · 当前 v${detail.currentVersion}`,
        blocks: versions.map((v) => ({
          label: `v${v.version} · ${shortTime(v.at)}`,
          title: v.changeSummary || (v.version === 1 ? '首版' : '这一版没留改动说明'),
          body: `${v.authorKind === 'user' ? '主公改定' : '军师出稿'}${v.title && v.title !== r.title ? ` · 标题：${v.title}` : ''}`,
        })),
        // 版本多了按钮会排成一列长条，只给最近 6 版；更早的版本本就极少回看。
        actions: versions.slice(0, 6).map((v) => ({
          t: `看 v${v.version} 正文`,
          primary: v.version === detail.currentVersion,
          go: () => { void openReport(r, v.version); },
        })),
      });
    } catch (e) {
      s.handleApiError(e, { silent: true });
      if (!alive(token)) return;
      push({ kicker: '历 史 版 本', title: r.title, blocks: [{ label: '取 数 失 败', title: '版本历史没取到', body: '关掉重开一次试试。' }] });
    }
  };

  function contentDrawer(r: ReportItem, detail: ReportDetail, ver: ReportVersionContent): DrawerData {
    const note = detail.versions.find((v) => v.version === ver.version)?.changeSummary;
    const blocks = (ver.content.sections || []).map((sec, i) => {
      const v = cardSection(sec);
      const body = [v.b, (v.list || []).join('\n')].filter(Boolean).join('\n');
      return { label: `第 ${CN[i] || i + 1} 节`, title: v.h || '正文', body };
    });
    return {
      kicker: '方 案 详 情',
      title: ver.title || r.title,
      quote: `${metaOf(r)} · v${ver.version} · ${shortTime(ver.at)}`,
      blocks: [
        { label: '本 版 改 动', title: note || (ver.version === 1 ? '首版' : '这一版没留改动说明'), body: ver.content.meta || '' },
        ...blocks,
      ],
      synthesis: ver.content.trust ? { title: '判断依据', body: ver.content.trust } : undefined,
      actions: [
        { t: '转成军令', primary: true, go: () => { void toOrders(r, ver.content); } },
        { t: `看历史版本（${detail.versions.length} 版）`, go: () => { void openVersions(r); } },
      ],
    };
  }

  /** 右键直转军令：卡片上没有正文，先补一次当前版再转。 */
  const quickToOrders = async (r: ReportItem) => {
    if (!requireAuth('save')) return;
    try {
      const ver = await api.reportVersion(r.id);
      setBriefs((m) => ({ ...m, [r.id]: briefOf(ver.content) || m[r.id] || '' }));
      await toOrders(r, ver.content);
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '方案正文没取到，转军令失败' });
    }
  };

  const menuFor = (r: ReportItem): CtxItem[] => [
    { t: '打开方案', k: 'Enter', go: () => { void openReport(r); } },
    { t: '转成军令', go: () => { void quickToOrders(r); } },
    { t: '看历史版本', go: () => { void openVersions(r); } },
  ];

  const body = () => {
    if (!authed) {
      return <Empty glyph="方" title="登录后才看得到方案库" sub="对话里出的方案会按版本存在你的账号下，换台电脑也在" />;
    }
    if (failed && items.length === 0) {
      return (
        <div className="pc-side-note">
          <span className="pc-side-note-t">方案库没取到，可能是网络断了。</span>
          <button type="button" className="pc-btn" onClick={() => { void load(); }}>重试</button>
        </div>
      );
    }
    if (loading && items.length === 0) {
      return (
        <div className="pc-rep-grid">
          {[0, 1, 2, 3, 4, 5].map((i) => <div className="pc-side-skel-b pc-tall" key={i} />)}
        </div>
      );
    }
    if (items.length === 0) {
      return <Empty glyph="方" title="还没有方案" sub="在战局里定下判断，或让军师出一份方案，每存一次就留一版" />;
    }
    return (
      <div className="pc-rep-grid">
        {items.map((r) => {
          const brief = briefs[r.id];
          return (
            <button
              type="button"
              key={r.id}
              className="pc-rep-card"
              onClick={() => { void openReport(r); }}
              onContextMenu={(e) => st.openCtx(e, r.title, menuFor(r))}
            >
              <span className="pc-rep-top">
                <span className="pc-rep-ic">报</span>
                <span className="pc-rep-v">v{r.currentVersion}</span>
                <span className="pc-rep-gap" />
                <span className="pc-rep-time">{relTime(r.updatedAt)}</span>
              </span>
              <span className="pc-rep-t">{r.title}</span>
              <span className="pc-rep-m">{metaOf(r)}</span>
              <span className={`pc-rep-s${brief ? '' : ' pc-hint'}`}>
                {brief || '点开看正文与版本链；右键可直接转成军令。'}
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <div className="pc-page">
      <div className="pc-rep-head">
        <span className="pc-rep-head-t">方 案 与 历 史 版 本</span>
        <span className="pc-rep-head-s">对话里出的方案，存一次就留一版</span>
      </div>
      {body()}
    </div>
  );
}
