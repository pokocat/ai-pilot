import { useEffect, useState } from 'react';
import { View, Text, Canvas } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import MarkdownText from '../../../components/MarkdownText';
import SafeHeader from '../../../components/SafeHeader';
import Sheet from '../../../components/Sheet';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { acceptDeliverable, refreshDossier, ordersOf, today, type DossierOrder } from '../../../services/dossier';
import { api, type ReportDetail, type ReportVersionContent, type ReportDiff } from '../../../services/api';
import { makeReportShareImage, presentReportShareImage } from '../../../services/reportShareCard';
// 报告 V2 最小防线：直接读 sec.h/sec.b/sec.list 对 stats/roster/table/phases/timeline/quote/letter
// 这 7 种类型化 section 会剥空大半内容（quote/letter 甚至没有 h）——与 ReportCard 共用同一套映射，
// 避免「方案库详情」页在报告 V2 落地后仍停留在旧白卡假设（2026-07-21 例行 QA 发现）。
import { cardSection, cardSectionText } from '../../../services/deliverableSection';
import { switchTo } from '../../../services/nav';
import { REVIEW_TIME } from '../../../data/constants';
import './index.scss';

const IS_WEAPP = process.env.TARO_ENV === 'weapp';

// 编号章节用中文序号（设计规格 §9.1：一 / 二 / 三 / 四）。
const CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
// 同步为军令兜底军令（真实案卷军令缺省时，设计规格 §9.2）。
const SYNC_FALLBACK: { text: string; tag: string }[] = [
  { text: '上传近 30 天成交漏斗表', tag: '待补' },
  { text: '重做案例证明', tag: '今日' },
  { text: '只投 3 个高意向主题', tag: '本周' },
];

function fmt(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function coverKicker(type: string, title: string): string {
  return /季度/.test(`${type}${title}`) ? 'QUARTER PLAN · 执行中' : 'STRATEGY REPORT · 可查看';
}

// 版本化报告：版本时间线 + 查看某一版内容（深绿封面 + 编号章节）+ 与上一版 section 级差异 + 同步为军令。
export default function Report() {
  const router = useRouter();
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const id = (router.params as Record<string, string>).id || '';
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<'content' | 'diff'>('content');
  const [content, setContent] = useState<ReportVersionContent | null>(null);
  const [diff, setDiff] = useState<ReportDiff | null>(null);
  const [failed, setFailed] = useState(false);
  // 内容区/差异区三态：加载中 / 失败可重试。reloadTick 递增触发重取（就地重试）。
  const [verLoading, setVerLoading] = useState(false);
  const [verErr, setVerErr] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // V7-09：同步为军令。syncing 防双击重复记账（D1）。
  const [synced, setSynced] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncOrders, setSyncOrders] = useState<DossierOrder[]>([]);

  const loadDetail = () => {
    if (!id) { setFailed(true); return; }
    setFailed(false);
    api.report(id).then((d) => {
      setDetail(d);
      setSel(d.currentVersion);
    }).catch((e) => { s.handleApiError(e); setDetail(null); setFailed(true); });
  };
  useEffect(loadDetail, [id]);

  useEffect(() => {
    if (!id || !sel) return;
    setVerLoading(true); setVerErr(false);
    if (mode === 'content') {
      api.reportVersion(id, sel)
        .then((c) => { setContent(c); })
        .catch((e) => { s.handleApiError(e); setContent(null); setVerErr(true); })
        .finally(() => setVerLoading(false));
    } else {
      api.reportDiff(id, Math.max(1, sel - 1), sel)
        .then((d) => { setDiff(d); })
        .catch((e) => { s.handleApiError(e); setDiff(null); setVerErr(true); })
        .finally(() => setVerLoading(false));
    }
  }, [id, sel, mode, reloadTick]);

  // 已同步检测：案卷标题与报告一致且今日已有军令 → 视为已同步。
  useEffect(() => {
    if (!detail) return;
    refreshDossier().then((d) => {
      if (d && d.title === detail.title && ordersOf(d, today()).length) setSynced(true);
    }).catch(() => { /* noop */ });
  }, [detail?.id]);

  // 军令同步屏底栏协调（setOverlay）已收敛至 Sheet 基座。

  const sync = async () => {
    if (syncing) return; // D1：in-flight 防抖，双击不重复记账
    setSyncing(true);
    try {
      let c = content;
      if (!c) c = await api.reportVersion(id, sel || (detail?.currentVersion ?? 1)).catch(() => null);
      if (!c || !detail) { Taro.showToast({ title: '方案内容加载失败，请重试', icon: 'none' }); return; }
      const r = await acceptDeliverable(c.content, detail.agentName || '军师').catch(() => null);
      if (!r) { Taro.showToast({ title: '同步失败，请重试', icon: 'none' }); return; }
      setSynced(true);
      setSyncOrders(ordersOf(r.dossier, today()));
      setSyncOpen(true);
    } finally {
      setSyncing(false);
    }
  };
  const goStudio = () => { setSyncOpen(false); switchTo('/pages/studio/index'); };

  // D-3-4：方案库详情对外分享 = 生成品牌分享图（标题+首节核心结论+落款，无全文/敏感数字）。
  const shareImage = async () => {
    if (!IS_WEAPP) { Taro.showToast({ title: '请在小程序内生成分享图', icon: 'none' }); return; }
    let c = content;
    if (!c) c = await api.reportVersion(id, sel || (detail?.currentVersion ?? 1)).catch(() => null);
    if (!c) { Taro.showToast({ title: '方案内容加载失败，请重试', icon: 'none' }); return; }
    Taro.showLoading({ title: '生成分享图…' });
    try {
      const path = await makeReportShareImage('rp-share-canvas', c.content);
      Taro.hideLoading();
      presentReportShareImage(path);
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成分享图失败，请重试', icon: 'none' });
    }
  };

  if (!detail) {
    return (
      <View className={`page report-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
        <SafeHeader title="方案" onBack={() => Taro.navigateBack()} titleClassName="rp-title" />
        <View className="rp-loading">
          <Text>{failed ? '方案加载失败' : '加载中…'}</Text>
          {failed ? <View className="rp-retry" onClick={loadDetail}><Text>重试</Text></View> : null}
        </View>
      </View>
    );
  }

  const orders = syncOrders.length ? syncOrders.map((o) => ({ text: o.text, tag: o.dueAt || o.tag || '待执行' })) : SYNC_FALLBACK;

  return (
    <View className={`page report-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader
        title={detail.title}
        onBack={() => Taro.navigateBack()}
        titleClassName="rp-title"
        right={<Text className="rp-share-btn serif" onClick={shareImage}>分享图</Text>}
      />

      <View className="pad">
        {/* 版本时间线 */}
        <View className="rp-versions">
          {detail.versions.map((v) => (
            <View key={v.id} className={`rp-v ${sel === v.version ? 'on' : ''}`} style={sel === v.version ? { borderColor: accent } : {}} onClick={() => setSel(v.version)}>
              <View className="rp-v-top">
                <Text className="rp-v-no" style={{ background: sel === v.version ? accent : 'var(--surface-2)', color: sel === v.version ? '#fff' : 'var(--ink-2)' }}>v{v.version}</Text>
                {v.version === detail.currentVersion ? <Text className="rp-v-latest" style={{ color: accent }}>最新</Text> : null}
                <Text className="rp-v-at">{fmt(v.at)}</Text>
              </View>
              <Text className="rp-v-sum">{v.changeSummary || '—'}</Text>
              <Text className="rp-v-by">{v.authorKind === 'user' ? '你保存' : '顾问产出'}</Text>
            </View>
          ))}
        </View>

        {/* 模式切换 */}
        <View className="rp-modes">
          <View className={`rp-mode ${mode === 'content' ? 'on' : ''}`} style={mode === 'content' ? { background: accent } : {}} onClick={() => setMode('content')}><Text>查看内容</Text></View>
          <View className={`rp-mode ${mode === 'diff' ? 'on' : ''}`} style={mode === 'diff' ? { background: accent } : {}} onClick={() => setMode('diff')}><Text>对比上一版</Text></View>
        </View>

        {mode === 'content' && (
          verLoading ? (
            <View className="rp-loading"><Text>加载方案内容…</Text></View>
          ) : verErr ? (
            <View className="rp-card card">
              <Text className="rp-nodiff">方案内容加载失败</Text>
              <View className="rp-retry" onClick={() => setReloadTick((t) => t + 1)}><Text>重试</Text></View>
            </View>
          ) : content ? (
          <View className="rp-reader">
            {/* 深绿封面 */}
            <View className="report-cover">
              <Text className="rc-k">{coverKicker(detail.type, detail.title)}</Text>
              <Text className="rc-t serif">{content.title}</Text>
              <Text className="rc-m">{content.content.meta} · v{content.version}</Text>
            </View>

            {/* 报告主判断引用 */}
            {content.content.trust ? <Text className="report-quote serif">{content.content.trust}</Text> : null}

            {/* 编号章节 一 / 二 / 三 / 四（cardSection 归一：typed section 的 items/paras/rows… 都要能看到） */}
            {content.content.sections.map((sec, i) => {
              const v = cardSection(sec);
              return (
                <View key={i} className="report-section card">
                  <Text className="rs-h serif"><Text className="rs-no" style={{ color: accent }}>{CN[i] || `${i + 1}`}</Text>{v.h}</Text>
                  {v.b ? <MarkdownText text={v.b} className="rs-b" /> : null}
                  {v.list ? v.list.map((x, j) => <View key={j} className="rs-li"><View className="rs-dot" style={{ background: accent }} /><MarkdownText text={x} className="rs-li-t" /></View>) : null}
                </View>
              );
            })}
          </View>
          ) : null
        )}

        {mode === 'diff' && (
          sel <= 1 ? (
            <View className="rp-card card"><Text className="rp-nodiff">这是第一个版本，没有可对比的上一版。</Text></View>
          ) : verErr ? (
            <View className="rp-card card">
              <Text className="rp-nodiff">差异计算失败</Text>
              <View className="rp-retry" onClick={() => setReloadTick((t) => t + 1)}><Text>重试</Text></View>
            </View>
          ) : diff && !verLoading ? (
            <View className="rp-card card">
              <Text className="rp-diff-sum" style={{ color: accent }}>v{diff.from} → v{diff.to}：{diff.summary}</Text>
              {diff.sections.map((sd, i) => {
                // sd.h 是服务端原始 h 字段：quote/letter 等 typed section 根本没有 h（恒为空串），
                // stats/roster/table/phases/timeline 的 h 也可能是省略章节标题——都要用 cardSection
                // 从 after/before 派生一个可读标题兜底，不能让 diff 标题栏直接留白。
                const titleSec = sd.after ?? sd.before;
                const dTitle = sd.h || (titleSec ? cardSection(titleSec).h : '');
                return (
                <View key={i} className={`rp-dsec ${sd.change}`}>
                  <View className="rp-dh"><Text className={`rp-badge ${sd.change}`}>{badge(sd.change)}</Text><Text className="rp-dh-t">{dTitle}</Text></View>
                  {sd.change === 'changed' ? (
                    sd.words && sd.words.length ? (
                      <View className="rp-words">
                        {sd.words.map((w, k) => (
                          <Text key={k} className={`rp-w ${w.t}`} style={w.t === 'add' ? { background: 'var(--accent-soft)', color: 'var(--accent-ink)' } : {}}>{w.s}</Text>
                        ))}
                      </View>
                    ) : (
                      <View className="rp-dchg">
                        <View className="rp-dbefore"><Text className="rp-dlabel">改前</Text><Text className="rp-dtext">{cardSectionText(sd.before)}</Text></View>
                        <View className="rp-dafter"><Text className="rp-dlabel" style={{ color: accent }}>改后</Text><Text className="rp-dtext">{cardSectionText(sd.after)}</Text></View>
                      </View>
                    )
                  ) : sd.change === 'unchanged' ? (
                    <Text className="rp-dtext dim">{cardSectionText(sd.after)}</Text>
                  ) : (
                    <Text className="rp-dtext">{cardSectionText(sd.after || sd.before)}</Text>
                  )}
                </View>
                );
              })}
            </View>
          ) : <View className="rp-loading"><Text>计算差异中…</Text></View>
        )}
      </View>
      <View style={{ height: '96px' }} />

      {/* 底部：同步为军令 / 已同步 → 查看军令 */}
      <View className="rp-syncbar">
        {synced ? (
          <View className="rp-sync-btn done" onClick={goStudio}><Text>已同步 → 查看军令</Text></View>
        ) : (
          <View className={`rp-sync-btn ${syncing ? 'busy' : ''}`} style={{ background: accent }} onClick={sync}><Text>{syncing ? '同步中…' : '同步为军令'}</Text></View>
        )}
      </View>

      {/* D-3-4 隐藏出图画布（屏外，仅点分享图时绘制导出） */}
      <Canvas type="2d" id="rp-share-canvas" className="rp-share-canvas" style={{ width: '600px', height: '900px' }} />

      {/* 军令同步屏（半屏）——迁入 Sheet 基座（五要素统一） */}
      <Sheet
        visible={syncOpen && !!detail}
        onClose={() => setSyncOpen(false)}
        overlayKey="command-sync"
        panelClassName="cs-pad"
        footer={
          <View className="cs-actions">
            <View className="cs-secondary" onClick={() => setSyncOpen(false)}><Text>留在这里</Text></View>
            <View className="cs-primary" style={{ background: accent }} onClick={goStudio}><Text>去执行</Text></View>
          </View>
        }
      >
        <View className="cs-hero">
          <View className="cs-check" style={{ background: accent }}><Text>✓</Text></View>
          <Text className="cs-t serif">方案已同步为今日军令</Text>
          <Text className="cs-d">已把「{detail?.title}」里的判断拆成执行动作，并同步到执行页、方案库和今晚 {REVIEW_TIME} 复盘。</Text>
        </View>
        <View className="cs-flow">
          <Text className="cs-flow-i">方案</Text><Text className="cs-arr">→</Text>
          <Text className="cs-flow-i on">军令</Text><Text className="cs-arr">→</Text>
          <Text className="cs-flow-i">复盘</Text>
        </View>
        <View className="cs-list">
          {orders.map((o, i) => (
            <View key={i} className="cs-cmd">
              <View className="cs-cmd-b"><Text className="cs-cmd-t">{o.text}</Text></View>
              <Text className="cs-cmd-due">{o.tag}</Text>
            </View>
          ))}
        </View>
      </Sheet>
    </View>
  );
}

function badge(change: string): string {
  return ({ added: '＋ 新增', removed: '－ 删除', changed: '~ 修改', unchanged: '未变' } as Record<string, string>)[change] || '';
}
