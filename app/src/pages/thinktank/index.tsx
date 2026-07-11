import { useState, useEffect } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import PaySheet from '../../components/PaySheet';
import ExceptionSheet from '../../components/ExceptionSheet';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { checkUpload } from '../../services/uploadGuard';
import {
  api,
  type KnowledgePipelineView, type OrganizeResult,
  type DataSourcesView, type DataSourceView,
  type ModulesView, type ModuleView, type ModuleTier, type ModuleGroup,
  type ReportItem,
} from '../../services/api';
import './index.scss';

type ThinkTab = 'assets' | 'data' | 'modules' | 'reports';
type Stage = 'staging' | 'optimized' | 'confirmed';

const TABS: { key: ThinkTab; label: string }[] = [
  { key: 'assets', label: '案卷资产' },
  { key: 'data', label: '数据源' },
  { key: 'modules', label: '能力' },
  { key: 'reports', label: '报告' },
];

const isWeapp = process.env.TARO_ENV === 'weapp';

// V7-06：资料整理 4 步动画（逐字，设计规格 §6.3）。
const PROC_STEPS = ['识别资料来源和文件类型', '去重并标记敏感信息', '按案卷目标生成分类结构', '输出待确认资料和问题清单'];
// 已优化静态兜底（无本轮整理结果时；设计规格 §6.4）。
const OPTIMIZED_ROWS = [
  { i: '证', t: '信任证明缺口', s: '案例、评价、成交截图已整理为证据', em: '3' },
  { i: '问', t: '增长断点问题清单', s: '线索到咨询、咨询到成交的关键问题', em: '6' },
  { i: 'IP', t: 'IP 内容可用素材', s: '历史选题、同行参考、脚本角度已筛选', em: '12' },
];
// 知识库文件夹兜底（设计规格 §6.5）。
const FOLDER_FALLBACK = [
  { key: 'growth', label: '增长资料库', count: 18 },
  { key: 'content', label: 'IP 内容库', count: 24 },
  { key: 'founder', label: '老板与企业档案', count: 19 },
];

// V7-08：能力 tier → 徽章（free绿 / sku金 / credits蓝 / member黑，设计规格 §0.2）。
const TIER_BADGE: Record<ModuleTier, { label: string; cls: string }> = {
  free: { label: '免费', cls: 'tier-free' },
  sku: { label: '单次', cls: 'tier-paid' },
  credits: { label: '算力', cls: 'tier-power' },
  member: { label: '会员', cls: 'tier-member' },
};
const MODULE_SUBTABS: { key: ModuleGroup | 'recommend'; label: string }[] = [
  { key: 'recommend', label: '推荐' },
  { key: 'free', label: '免费' },
  { key: 'deep', label: '深度' },
  { key: 'member', label: '模块' },
];

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return '刚刚';
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}
function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (b >= 1024 * 1024) return `${Math.round(b / 1024 / 1024)}MB`;
  return `${Math.max(0, Math.round(b / 1024))}KB`;
}
// 数据源状态 → 色板（已绑定绿 / 待上传红 / 其余金，设计规格 §7.1）。
function dsClass(label: string): string {
  if (/已绑定|已接入/.test(label)) return 'ds-ok';
  if (/待上传/.test(label)) return 'ds-miss';
  return 'ds-warn';
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface PayState {
  open: boolean; mode: 'credits' | 'sku' | 'member' | 'quota';
  title?: string; desc?: string; costValue?: string; balanceValue?: string;
  afterValue?: string; result?: string; confirmText?: string; skuKey?: string;
  onConfirm?: () => void | Promise<void>;
}
interface ExcState { open: boolean; kind: 'upload' | 'power' | 'sku'; title?: string; desc?: string; onPrimary?: () => void; }

// 智库 —— 案卷资产（V7-06 三段式管道）/ 数据源（V7-07）/ 能力（V7-08）/ 报告（V7-09）。
export default function ThinkTank() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [tab, setTab] = useState<ThinkTab>('assets');

  // —— assets（V7-06）——
  const [pipe, setPipe] = useState<KnowledgePipelineView | null>(null);
  const [stage, setStage] = useState<Stage>('staging');
  const [uploading, setUploading] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [organizeStep, setOrganizeStep] = useState(0);
  const [organized, setOrganized] = useState<OrganizeResult | null>(null);
  const [activeBatch, setActiveBatch] = useState<string | null>(null);

  // —— data（V7-07）——
  const [dsView, setDsView] = useState<DataSourcesView | null>(null);
  const [dsSel, setDsSel] = useState<DataSourceView | null>(null);

  // —— modules（V7-08）——
  const [modView, setModView] = useState<ModulesView | null>(null);
  const [modTab, setModTab] = useState<ModuleGroup | 'recommend'>('recommend');
  const [modSel, setModSel] = useState<ModuleView | null>(null);

  // —— reports（V7-09）——
  const [reports, setReports] = useState<ReportItem[]>([]);

  // —— 弹层 ——
  const [pay, setPay] = useState<PayState>({ open: false, mode: 'credits' });
  const [exc, setExc] = useState<ExcState>({ open: false, kind: 'upload' });
  const closePay = () => setPay((p) => ({ ...p, open: false }));
  const closeExc = () => setExc((e) => ({ ...e, open: false }));

  const loadPipeline = () => api.knowledgePipeline().then(setPipe).catch((e) => { s.handleApiError(e, { silent: true }); });
  const loadData = () => api.dataSources().then(setDsView).catch((e) => { s.handleApiError(e, { silent: true }); });
  const loadModules = () => api.modules().then(setModView).catch((e) => { s.handleApiError(e, { silent: true }); });
  const loadReports = () => api.reports().then(setReports).catch((e) => { s.handleApiError(e, { silent: true }); setReports([]); });

  useDidShow(() => {
    s.setTab(3);
    Taro.getCurrentInstance().page?.getTabBar?.();
    if (s.isAuthed()) {
      loadPipeline();
      loadData();
      loadModules();
      loadReports();
    }
  });

  const openReport = (id: string) => Taro.navigateTo({ url: `/packages/work/report/index?id=${id}` });
  const goLibrary = () => Taro.navigateTo({ url: '/packages/work/library/index' });
  const goChat = (agentKey: string, prompt: string) =>
    Taro.navigateTo({ url: `/pages/chat/index?agentKey=${agentKey}&fresh=1&send=${encodeURIComponent(prompt)}` });

  // ============ V7-06 案卷资产 ============
  const counts = pipe?.counts ?? { staging: 0, optimized: 0, confirmed: 0 };
  const quota = pipe?.quota ?? { usedDocs: 0, freeDocs: 30, usedBytes: 0, freeBytes: 200 * 1024 * 1024 };
  const batches = pipe?.batches ?? [];
  const folders = pipe?.folders ?? [];

  const chooseUpload = async () => {
    if (uploading || organizing) return;
    if (!isWeapp) {
      setUploading(true);
      try {
        const r = await api.uploadKnowledge('', undefined, true, activeBatch || undefined);
        setActiveBatch(r.batchId || activeBatch);
        Taro.showToast({ title: '资料已进入待整理区', icon: 'none' });
        await loadPipeline();
      } catch (e) { s.handleApiError(e); }
      setUploading(false);
      return;
    }
    const guide = await Taro.showModal({
      title: '从微信聊天选择文件',
      content: '微信只允许小程序选取「聊天里的文件」。请先把资料发到「文件传输助手」，再选它即可。这不是转发，是选文件。',
      confirmText: '去选择', cancelText: '取消',
    });
    if (!guide.confirm) return;
    let chosen: Taro.chooseMessageFile.SuccessCallbackResult;
    try {
      chosen = await Taro.chooseMessageFile({ count: 9, type: 'file' });
    } catch (e) {
      const msg = String((e as { errMsg?: string })?.errMsg || '');
      if (!/cancel/i.test(msg)) Taro.showToast({ title: '没能打开文件选择，请重试', icon: 'none' });
      return;
    }
    const files = chosen.tempFiles || [];
    if (!files.length) return;
    // 上传前置校验：任一文件不合规 → 异常屏（可换格式/压缩后重传）。
    for (const f of files) {
      const chk = checkUpload({ name: f.name, size: f.size });
      if (!chk.ok) { setExc({ open: true, kind: 'upload', title: chk.title, desc: chk.desc, onPrimary: () => { closeExc(); chooseUpload(); } }); return; }
    }
    setUploading(true);
    try {
      let bid = activeBatch || undefined;
      for (const f of files) {
        const r = await api.uploadKnowledge(f.path, undefined, true, bid);
        bid = r.batchId || bid;
      }
      setActiveBatch(bid || null);
      Taro.showToast({ title: `${files.length} 份资料已进入待整理区`, icon: 'none' });
      await loadPipeline();
    } catch (e) { s.handleApiError(e); }
    setUploading(false);
  };

  const runOrganize = async (batchId: string, deep: boolean, afterPayment = false, attempt = 0) => {
    if (organizing) return;
    setOrganized(null);
    setOrganizing(true);
    setOrganizeStep(0);
    let step = 0;
    const timer = setInterval(() => { step = Math.min(4, step + 1); setOrganizeStep(step); if (step >= 4) clearInterval(timer); }, 450);
    try {
      const call = deep ? api.deepOrganize(batchId) : api.organizeBatch(batchId);
      // 普通整理让 4 步动画走完再出结果；深度整理若 402 会即时 reject，不会有明显闪烁。
      const res = deep ? await call : (await Promise.all([call, wait(1900)]))[0];
      clearInterval(timer);
      setOrganizeStep(4);
      setActiveBatch(batchId);
      setOrganized(res);
      setOrganizing(false);
      await loadPipeline();
      Taro.showToast({ title: deep ? '深度整理完成' : '整理完成', icon: 'none' });
    } catch (e) {
      clearInterval(timer);
      setOrganizing(false);
      const code = (e as { code?: string; data?: { code?: string; skuKey?: string } })?.code || (e as { data?: { code?: string } })?.data?.code;
      if (code === 'SKU_REQUIRED') {
        // 微信支付回调发放权益是异步的：requestPayment 刚 resolve 时凭据未必已到账（webhook 竞态）。
        // 刚支付完成时先短暂重试几次，避免把「还没到账」误判成「未购买」而弹出第二次支付（重复扣费）。
        if (afterPayment && attempt < 2) {
          await wait(1500);
          await runOrganize(batchId, deep, true, attempt + 1);
          return;
        }
        openDeepPay(batchId);
      }
      else s.handleApiError(e);
    }
  };

  const openDeepPay = async (batchId: string) => {
    // 价格从 admin 可实时改价的 SKU 表取（70db762），避免确认弹窗显示的金额与微信实际扣款不一致。
    let yuan = 39;
    try {
      const skus = await api.skus();
      const sku = skus.find((it) => it.key === 'deep-organize');
      if (sku) yuan = sku.priceFen / 100;
    } catch { /* 拉取失败时用兜底价，不阻塞支付弹窗 */ }
    setPay({
      open: true, mode: 'sku', skuKey: 'deep-organize',
      title: '深度资料整理', desc: '军师对上传资料做深度去重、提炼与补标，整理成可直接调用的知识。',
      costValue: `¥${yuan}`, balanceValue: '微信支付', afterValue: '支付后立即整理',
      confirmText: `确认支付 ¥${yuan}`, result: '支付后开始深度整理，并写入待确认区。',
      onConfirm: async () => {
        try {
          const order = await api.createSkuOrder('deep-organize');
          if (order.payParams) {
            await Taro.requestPayment({
              timeStamp: order.payParams.timeStamp, nonceStr: order.payParams.nonceStr,
              package: order.payParams.package, signType: order.payParams.signType as 'RSA', paySign: order.payParams.paySign,
            });
          }
          closePay();
          await runOrganize(batchId, true, true);
        } catch (e) {
          closePay();
          if ((e as { errMsg?: string })?.errMsg && /cancel/i.test((e as { errMsg?: string }).errMsg!)) { Taro.showToast({ title: '已取消支付', icon: 'none' }); return; }
          const code = (e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code;
          if (code === 'PAYMENT_NOT_CONFIGURED' || code === 'PAYMENT_COMING_SOON') Taro.showToast({ title: '支付即将开通，敬请期待', icon: 'none' });
          else s.handleApiError(e, { fallbackTitle: '开通失败，请重试' });
        }
      },
    });
  };

  const confirmOptimized = async () => {
    try {
      const r = await api.confirmKnowledge(activeBatch ? { batchId: activeBatch } : {});
      if (!r.count) { Taro.showToast({ title: '暂无可确认资料，请先整理待整理区', icon: 'none' }); return; }
      Taro.showToast({ title: `已写入知识库 · ${r.count} 份`, icon: 'none' });
      setOrganized(null);
      setActiveBatch(null);
      await loadPipeline();
      setStage('confirmed');
    } catch (e) { s.handleApiError(e); }
  };

  const syncKnowledge = async () => {
    try {
      await api.refreshForces();
      Taro.showToast({ title: '已刷新战局判断', icon: 'none' });
    } catch (e) { s.handleApiError(e); }
  };

  // ============ V7-07 数据源 ============
  const bindDataSource = async () => {
    if (!dsSel) return;
    const d = dsSel;
    try {
      if (d.tier === 'advanced') {
        // 广告 / CRM 等高级授权：只预约，不做假授权动画（必然走上传替代，设计规格 §7.4）。
        await api.requestDataSourceAuth(d.key);
        Taro.showToast({ title: '已预约开通，服务老师会联系你', icon: 'none' });
      } else {
        await api.uploadDataSource(d.key);
        Taro.showToast({ title: '已作为替代资料上传，进入待整理区', icon: 'none' });
      }
      setDsSel(null);
      await loadData();
    } catch (e) { s.handleApiError(e); }
  };

  // ============ V7-08 能力 ============
  const modules = (modView?.modules ?? []).filter((m) => !m.hidden);
  const modStats = {
    free: modules.filter((m) => m.group === 'free').length,
    deep: modules.filter((m) => m.group === 'deep').length,
    member: modules.filter((m) => m.group === 'member').length,
  };
  const modListFor = (g: ModuleGroup | 'recommend') => (g === 'recommend' ? [] : modules.filter((m) => m.group === g));

  const primaryModule = () => {
    if (!modSel) return;
    const m = modSel;
    if (m.enabled || m.tier === 'free') {
      setModSel(null);
      if (m.agentKey) goChat(m.agentKey, `用「${m.label}」帮我分析当前案卷，先问我关键的 1-2 个问题。`);
      else Taro.showToast({ title: '已启用，可在执行页查看', icon: 'none' });
      return;
    }
    setModSel(null);
    openModulePay(m);
  };

  const openModulePay = (m: ModuleView) => {
    const bal = s.me()?.creditBalance ?? 0;
    const credits = m.price?.credits ?? 0;
    const yuan = m.price?.priceFen ? m.price.priceFen / 100 : 0;
    if (m.tier === 'credits') {
      setPay({
        open: true, mode: 'credits', title: m.label, desc: m.detail.scene,
        costValue: `${credits} 算力`, balanceValue: bal < 0 ? '当前不限量' : `当前可用 ${bal} 算力`,
        afterValue: bal < 0 ? '不额外扣费' : `预计剩余 ${Math.max(0, bal - credits)} 算力`,
        confirmText: `消耗 ${credits} 算力启用`, result: `确认后生成${m.detail.output}，并同步到${m.detail.writeback}。`,
        onConfirm: () => doEnable(m),
      });
    } else if (m.tier === 'member') {
      setPay({
        open: true, mode: 'member', title: m.label, desc: m.detail.scene,
        costValue: '会员权益', balanceValue: '本月权益可用', afterValue: '不额外扣费',
        confirmText: '启用会员权益', result: `启用后生成${m.detail.output}，并回写${m.detail.writeback}。`,
        onConfirm: () => doEnable(m),
      });
    } else {
      setPay({
        open: true, mode: 'sku', skuKey: m.price?.skuKey, title: m.label, desc: m.detail.scene,
        costValue: `¥${yuan}`, balanceValue: '微信支付', afterValue: '支付后立即开通',
        confirmText: `确认支付 ¥${yuan}`, result: `支付后生成${m.detail.output}，并写入${m.detail.writeback}。`,
        onConfirm: () => doEnableSku(m),
      });
    }
  };

  // credits / member：直接 enableModule（扣算力 / 会员权益）。
  const doEnable = async (m: ModuleView) => {
    try {
      await api.enableModule(m.key);
      closePay();
      await loadModules();
      Taro.showToast({ title: '已启用', icon: 'success' });
    } catch (e) {
      closePay();
      const code = (e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code;
      if (code === 'INSUFFICIENT_CREDITS') {
        setExc({ open: true, kind: 'power', title: '算力不足', desc: '启用该能力所需算力不足，可购买算力或改用免费能力。', onPrimary: () => { closeExc(); Taro.navigateTo({ url: '/packages/work/credits/index' }); } });
      } else if (code === 'PLAN_EXPIRED') {
        Taro.showToast({ title: '会员已过期，续费后可继续使用', icon: 'none' });
      } else s.handleApiError(e, { fallbackTitle: '启用失败，请重试' });
    }
  };

  // sku：先微信支付下单，再 enableModule（服务端购买即授予对应模块）。
  const doEnableSku = async (m: ModuleView) => {
    try {
      if (m.price?.skuKey) {
        const order = await api.createSkuOrder(m.price.skuKey);
        if (order.payParams) {
          await Taro.requestPayment({
            timeStamp: order.payParams.timeStamp, nonceStr: order.payParams.nonceStr,
            package: order.payParams.package, signType: order.payParams.signType as 'RSA', paySign: order.payParams.paySign,
          });
        }
      }
      // 微信支付回调发放权益是异步的：requestPayment 刚 resolve 时权益未必已到账。此前直接吞掉
      // enableModule 失败并无条件展示"已开通"，webhook 真正延迟时会误导用户；改为短暂重试，
      // 仍失败才如实报错（购买本身已成功，不会重复扣费，只是提示用户稍后重试启用）。
      for (let i = 0; i < 3; i++) {
        try { await api.enableModule(m.key); break; }
        catch (e) { if (i === 2) throw e; await wait(1200); }
      }
      closePay();
      await loadModules();
      Taro.showToast({ title: '已开通', icon: 'success' });
    } catch (e) {
      closePay();
      if ((e as { errMsg?: string })?.errMsg && /cancel/i.test((e as { errMsg?: string }).errMsg!)) { Taro.showToast({ title: '已取消支付', icon: 'none' }); return; }
      const code = (e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code;
      if (code === 'PAYMENT_NOT_CONFIGURED' || code === 'PAYMENT_COMING_SOON') Taro.showToast({ title: '支付即将开通，敬请期待', icon: 'none' });
      else s.handleApiError(e, { fallbackTitle: '开通失败，请重试' });
    }
  };

  const modCard = (m: ModuleView) => {
    const badge = TIER_BADGE[m.tier] || TIER_BADGE.free;
    return (
      <View key={m.key} className="skill card" onClick={() => setModSel(m)}>
        <View className="skill-ic"><Text className="serif">{m.iconChar}</Text></View>
        <View className="skill-b">
          <View className="skill-top">
            <Text className="skill-name serif">{m.label}</Text>
            <Text className={`tier-badge ${badge.cls}`}>{badge.label}</Text>
          </View>
          <Text className="skill-sub">{m.desc}</Text>
          <Text className="module-state">{m.stateLabel}</Text>
        </View>
      </View>
    );
  };

  return (
    <Screen topInset>
      <View className="pad think">
        {/* 页头 */}
        <View className="think-nav tab-page-head">
          <Text className="tn-title serif">智库</Text>
        </View>

        {/* 分区切换 */}
        <View className="think-tabs">
          {TABS.map((it) => (
            <View key={it.key} className={`think-tab ${tab === it.key ? 'on' : ''}`} onClick={() => setTab(it.key)}>
              <Text>{it.label}</Text>
            </View>
          ))}
        </View>

        {/* ===================== 案卷资产（V7-06） ===================== */}
        {tab === 'assets' ? (
          <>
            {/* 额度三卡 */}
            <View className="quota-grid">
              <View className="quota-card card" onClick={() => Taro.showToast({ title: `本月免费整理额度：${quota.freeDocs} 份 / 200MB`, icon: 'none' })}>
                <Text className="qc-v serif">{quota.usedDocs} / {quota.freeDocs}</Text>
                <Text className="qc-l">免费资料额度</Text>
              </View>
              <View className="quota-card card" onClick={() => Taro.showToast({ title: `知识库已用 ${fmtBytes(quota.usedBytes)}，剩余可继续上传`, icon: 'none' })}>
                <Text className="qc-v serif">{fmtBytes(Math.max(0, quota.freeBytes - quota.usedBytes))}</Text>
                <Text className="qc-l">剩余空间 · 可扩容</Text>
              </View>
              <View className="quota-card card" onClick={() => { if (batches.length) openDeepPay(batches[0].id); else Taro.showToast({ title: '先上传资料到待整理区，再做深度整理', icon: 'none' }); }}>
                <Text className="qc-v serif">深度整理</Text>
                <Text className="qc-l">去重 / 分类 / 优化</Text>
              </View>
            </View>

            {/* 三段流水段 */}
            <View className="stage-seg">
              {([['staging', '待整理', counts.staging], ['optimized', '已优化', counts.optimized], ['confirmed', '知识库', counts.confirmed]] as [Stage, string, number][]).map(([k, label, n]) => (
                <View key={k} className={`stage-tab ${stage === k ? 'on' : ''}`} onClick={() => setStage(k)}>
                  <Text className="stage-t">{label}</Text>
                  <Text className="stage-n" style={stage === k ? { color: accent } : {}}>{n}</Text>
                </View>
              ))}
            </View>

            {/* —— 待整理 —— */}
            {stage === 'staging' ? (
              <>
                <View className="upload-zone card" onClick={chooseUpload}>
                  <View className="uz-b">
                    <Text className="uz-k">第一步 · 接住乱资料</Text>
                    <Text className="uz-t serif">上传资料</Text>
                    <Text className="uz-d">聊天记录、表格、文档、图片都先放进来，系统会统一进入待整理区。</Text>
                  </View>
                  <View className="uz-btn"><Text>{uploading ? '上传中…' : '＋ 上传'}</Text></View>
                </View>

                {organizing ? (
                  <View className="proc card">
                    <View className="proc-head">
                      <View className="proc-ic"><Text>算</Text></View>
                      <View className="proc-b"><Text className="proc-t serif">正在整理这一批资料</Text></View>
                      <Text className="proc-tag">处理中</Text>
                    </View>
                    <View className="proc-steps">
                      {PROC_STEPS.map((label, i) => (
                        <View key={i} className={`proc-row ${organizeStep > i ? 'done' : organizeStep === i ? 'active' : ''}`}>
                          <View className="proc-dot">{organizeStep > i ? <Text>✓</Text> : null}</View>
                          <Text className="proc-label">{label}</Text>
                        </View>
                      ))}
                    </View>
                    <Text className="proc-hint">整理过程中不要离开也没关系，资料会先保存在待整理区，完成后再让你确认是否入库。</Text>
                  </View>
                ) : (
                  <>
                    {organized ? (
                      <View className="orgd card">
                        <View className="orgd-head">
                          <View className="orgd-ic"><Text>整</Text></View>
                          <View className="orgd-b">
                            <Text className="orgd-t serif">{organized.deep ? '这一批资料已深度整理' : '这一批资料已整理'}</Text>
                            <Text className="orgd-s">共 {organized.total} 份 · 去重 {organized.dedup} 份</Text>
                          </View>
                          <Text className="orgd-tag">已粗分</Text>
                        </View>
                        {organized.folders.map((f) => (
                          <View key={f.key} className="organized-row">
                            <View className="or-i"><Text>{f.label.slice(0, 1)}</Text></View>
                            <View className="or-b"><Text className="or-t">{f.label}</Text><Text className="or-s">已归类 · 待确认入库</Text></View>
                            <Text className="or-em">{f.count}</Text>
                          </View>
                        ))}
                        <Text className="orgd-hint">整理完成后，可进入「已优化」确认入库，也可以继续深度整理进一步提炼。</Text>
                        <View className="orgd-btn" style={{ background: accent }} onClick={() => setStage('optimized')}><Text>去确认入库 ›</Text></View>
                      </View>
                    ) : null}

                    {batches.map((b) => (
                      <View key={b.id} className="pile card">
                        <View className="pile-head">
                          <View className="pile-ic"><Text>收</Text></View>
                          <View className="pile-b">
                            <Text className="pile-t serif">已接收 {b.count} 份原始素材</Text>
                            <Text className="pile-s">这一批资料还没整理，先集中放在待整理区</Text>
                          </View>
                          <Text className="pile-tag">待整理</Text>
                        </View>
                        {b.typeStats.length ? (
                          <View className="pile-chips">
                            {b.typeStats.map((t) => <Text key={t.label} className="pile-chip">{t.label} {t.count} 份</Text>)}
                          </View>
                        ) : null}
                      </View>
                    ))}

                    {batches.length ? (
                      <View className="pile-actions">
                        <View className="pile-btn primary" style={{ background: accent }} onClick={() => runOrganize(batches[0].id, false)}><Text>资料整理</Text></View>
                        <View className="pile-btn" onClick={() => runOrganize(batches[0].id, true)}><Text>深度整理</Text></View>
                      </View>
                    ) : (!organized ? (
                      <View className="stage-empty"><Text className="se-t">待整理区还是空的</Text><Text className="se-s">先把散落在微信、表格、文档、图片里的材料放进来。</Text></View>
                    ) : null)}
                  </>
                )}
              </>
            ) : null}

            {/* —— 已优化 —— */}
            {stage === 'optimized' ? (
              <>
                <View className="stage-summary card">
                  <Text className="ss-t serif">已优化，等你确认</Text>
                  <Text className="ss-s">这里只放系统整理后的结果，用户确认后再写入知识库。</Text>
                  <Text className="ss-em">{counts.optimized} 份</Text>
                </View>
                <View className="asset-list card">
                  {(organized?.folders?.length
                    ? organized.folders.map((f) => ({ i: f.label.slice(0, 1), t: f.label, s: '已优化 · 待写入知识库', em: String(f.count) }))
                    : OPTIMIZED_ROWS
                  ).map((r, idx) => (
                    <View key={idx} className="asset-list-row">
                      <View className="al-i"><Text>{r.i}</Text></View>
                      <View className="al-b"><Text className="al-t serif">{r.t}</Text><Text className="al-s">{r.s}</Text></View>
                      <Text className="al-em">{r.em}</Text>
                    </View>
                  ))}
                </View>
                <View className="confirm-library card" onClick={confirmOptimized}>
                  <Text className="cl-t serif">确认优化后的资料 → 写入知识库</Text>
                  <Text className="cl-s">确认后将回写战局页、报告页和后续对话引用。</Text>
                </View>
              </>
            ) : null}

            {/* —— 知识库 —— */}
            {stage === 'confirmed' ? (
              <>
                <View className="stage-summary card">
                  <Text className="ss-t serif">已进入知识库</Text>
                  <Text className="ss-s">这里的资料已经可被战局、报告和对话直接调用。</Text>
                  <Text className="ss-em">{counts.confirmed} 份</Text>
                </View>
                <View className="folder-grid">
                  {(folders.length ? folders : FOLDER_FALLBACK).map((f) => (
                    <View key={f.key} className="folder-tile card">
                      <View className="ft-ic"><Text>{f.label.slice(0, 1)}</Text></View>
                      <Text className="ft-t serif">{f.label}</Text>
                      <Text className="ft-n">{f.count} 份</Text>
                    </View>
                  ))}
                </View>
                <View className="confirm-library card" onClick={syncKnowledge}>
                  <Text className="cl-t serif">同步知识库 → 刷新战局判断</Text>
                  <Text className="cl-s">把知识库内容回写给战局页、报告页和后续对话。</Text>
                </View>
              </>
            ) : null}
          </>
        ) : null}

        {/* ===================== 数据源（V7-07） ===================== */}
        {tab === 'data' ? (
          <>
            <View className="ds-hero card">
              <Text className="dh-k">经营数据源</Text>
              <Text className="dh-t serif">让军师判断有真实证据</Text>
              <Text className="dh-d">先支持上传表格、截图和聊天记录，再逐步做后台授权。数据会参与战局判断、执行复盘和报告更新。</Text>
              <View className="dh-metrics">
                <View className="dh-m"><Text className="dh-mv serif">{dsView?.bound ?? 0}</Text><Text className="dh-ml">已绑定</Text></View>
                <View className="dh-m"><Text className="dh-mv serif">{dsView?.needed ?? 0}</Text><Text className="dh-ml">待补关键项</Text></View>
                <View className="dh-m"><Text className="dh-mv serif">{dsView?.total ?? 0}</Text><Text className="dh-ml">类经营来源</Text></View>
              </View>
            </View>

            <Text className="think-h2">经营来源</Text>
            {(dsView?.sources ?? []).filter((d) => d.tier === 'basic').map((d) => (
              <View key={d.key} className="data-source-card card" onClick={() => setDsSel(d)}>
                <View className="dsc-ic"><Text>{d.icon}</Text></View>
                <View className="dsc-b">
                  <Text className="dsc-t serif">{d.label}</Text>
                  <Text className="dsc-s">{d.desc}</Text>
                </View>
                <Text className={`dsc-state ${dsClass(d.statusLabel)}`}>{d.statusLabel}</Text>
              </View>
            ))}

            <Text className="think-h2">高级授权</Text>
            {(dsView?.sources ?? []).filter((d) => d.tier === 'advanced').map((d) => (
              <View key={d.key} className="data-source-card card" onClick={() => setDsSel(d)}>
                <View className="dsc-ic"><Text>{d.icon}</Text></View>
                <View className="dsc-b">
                  <Text className="dsc-t serif">{d.label}</Text>
                  <Text className="dsc-s">{d.desc}</Text>
                </View>
                <Text className={`dsc-state ${dsClass(d.statusLabel)}`}>{d.statusLabel}</Text>
              </View>
            ))}
          </>
        ) : null}

        {/* ===================== 能力（V7-08） ===================== */}
        {tab === 'modules' ? (
          <>
            <View className="module-hero card">
              <Text className="mh-k">SKILL CENTER</Text>
              <Text className="mh-t serif">按当前案卷调用能力</Text>
              <Text className="mh-d">免费能力先判断，深度能力做推演，会员模块承接长期执行。</Text>
              <View className="mh-stats">
                <View className="mh-s"><Text className="mh-sv serif">{modStats.free}</Text><Text className="mh-sl">免费可用</Text></View>
                <View className="mh-s"><Text className="mh-sv serif">{modStats.deep}</Text><Text className="mh-sl">深度 Skill</Text></View>
                <View className="mh-s"><Text className="mh-sv serif">{modStats.member}</Text><Text className="mh-sl">会员模块</Text></View>
              </View>
            </View>

            <View className="module-subtabs">
              {MODULE_SUBTABS.map((it) => (
                <View key={it.key} className={`msub ${modTab === it.key ? 'on' : ''}`} style={modTab === it.key ? { color: accent } : {}} onClick={() => setModTab(it.key)}>
                  <Text>{it.label}</Text>
                </View>
              ))}
            </View>

            {modTab === 'recommend' ? (
              modView?.recommended ? (
                <View className="module-recommend card" onClick={() => setModSel(modView.recommended!)}>
                  <Text className="mr-k">当前案卷推荐</Text>
                  <View className="mr-head">
                    <Text className="mr-t serif">{modView.recommended.label}</Text>
                    <Text className="mr-em">{modView.recommended.stateLabel}</Text>
                  </View>
                  <Text className="mr-d">{modView.recommended.detail.scene}，先用它重算损耗点，再刷新战局和军令。</Text>
                </View>
              ) : (
                <View className="stage-empty"><Text className="se-t">暂无推荐能力</Text></View>
              )
            ) : (
              modListFor(modTab).map(modCard)
            )}
          </>
        ) : null}

        {/* ===================== 报告（V7-09） ===================== */}
        {tab === 'reports' ? (
          <>
            <Text className="think-h2">报告与历史方案</Text>
            {reports.length === 0 ? (
              <View className="think-empty">
                <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={22} color={accent} /></View>
                <Text className="et">还没有沉淀报告</Text>
                <Text className="es">在战局页认可判断、或让军师产出方案后，报告会按版本沉淀在这里。</Text>
              </View>
            ) : (
              reports.map((r) => (
                <View key={r.id} className="report card" onClick={() => openReport(r.id)}>
                  <View className="report-ic"><Text className="serif">报</Text></View>
                  <View className="report-b">
                    <Text className="report-t serif">{r.title}</Text>
                    <Text className="report-s">{r.type}{r.agentName ? ` · ${r.agentName}` : ''} · v{r.currentVersion} · {relTime(r.updatedAt)}</Text>
                  </View>
                  <Text className="report-state">查看</Text>
                </View>
              ))
            )}
            <View className="report card" onClick={() => Taro.switchTab({ url: '/pages/sessions/index' })}>
              <View className="report-ic"><Text className="serif">新</Text></View>
              <View className="report-b">
                <Text className="report-t serif">从对话生成新报告</Text>
                <Text className="report-s">认可判断后生成，并同步到执行模块</Text>
              </View>
              <Text className="report-state">生成</Text>
            </View>
            <View className="report card" onClick={goLibrary}>
              <View className="report-ic"><Text className="serif">案</Text></View>
              <View className="report-b">
                <Text className="report-t serif">我的方案库</Text>
                <Text className="report-s">对话产出的结构化方案，存库即沉淀一版</Text>
              </View>
              <Text className="report-state">查看</Text>
            </View>
          </>
        ) : null}

        {/* 底部主行动 */}
        <View className="think-cta" onClick={chooseUpload}>
          <Icon name="upload" size={16} color="#FBFAF6" />
          <Text>上传资料，让军师补全判断</Text>
        </View>
      </View>

      {/* 数据源详情屏（授权范围 / 同步频率 / 回写位置 / 隐私控制） */}
      <DsSheet sel={dsSel} onClose={() => setDsSel(null)} onBind={bindDataSource} />

      {/* 能力详情屏（使用场景 / 输入·产出·消耗 / 回写位置） */}
      <ModSheet sel={modSel} onClose={() => setModSel(null)} onPrimary={primaryModule} />

      <PaySheet
        open={pay.open} mode={pay.mode} title={pay.title} desc={pay.desc}
        costValue={pay.costValue} balanceValue={pay.balanceValue} afterValue={pay.afterValue}
        result={pay.result} confirmText={pay.confirmText} skuKey={pay.skuKey}
        onConfirm={pay.onConfirm} onClose={closePay}
      />
      <ExceptionSheet
        open={exc.open} kind={exc.kind} title={exc.title} desc={exc.desc}
        onPrimary={exc.onPrimary} onClose={closeExc}
      />
    </Screen>
  );
}

// —— 数据源详情屏 ——（hand-rolled sheet，mask z900 + setOverlay）
function DsSheet({ sel, onClose, onBind }: { sel: DataSourceView | null; onClose: () => void; onBind: () => void }) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  useDidShowOverlay(!!sel, 'ds-detail');
  if (!sel) return null;
  const advanced = sel.tier === 'advanced';
  return (
    <View className="tk-mask" onClick={onClose} catchMove>
      <View className="tk-sheet" onClick={(e) => e.stopPropagation()}>
        <View className="tk-grip" />
        <Text className="tk-k">数 据 授 权</Text>
        <View className="tk-head">
          <View className="tk-head-ic"><Text>{sel.icon}</Text></View>
          <View className="tk-head-b"><Text className="tk-head-t serif">{sel.label}</Text><Text className="tk-head-s">{sel.desc}</Text></View>
        </View>

        <Text className="tk-sub-label">读取范围</Text>
        <View className="tk-chips">
          {sel.scope.map((c) => <Text key={c} className="tk-chip">{c}</Text>)}
        </View>

        <View className="detail-mini-grid">
          <View className="dm-cell"><Text className="dm-k">授权范围</Text><Text className="dm-v">只读当前案卷需要的数据</Text></View>
          <View className="dm-cell"><Text className="dm-k">同步频率</Text><Text className="dm-v">每日复盘前刷新一次</Text></View>
          <View className="dm-cell"><Text className="dm-k">回写位置</Text><Text className="dm-v">战局、执行、报告</Text></View>
          <View className="dm-cell"><Text className="dm-k">隐私控制</Text><Text className="dm-v">可随时断开或隐藏来源</Text></View>
        </View>

        <View className="tk-actions">
          <View className="tk-secondary" onClick={onClose}><Text>返回</Text></View>
          <View className="tk-primary" style={{ background: accent }} onClick={onBind}><Text>{advanced ? '预约开通授权' : '上传替代资料'}</Text></View>
        </View>
      </View>
    </View>
  );
}

// —— 能力详情屏 ——
function ModSheet({ sel, onClose, onPrimary }: { sel: ModuleView | null; onClose: () => void; onPrimary: () => void }) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  useDidShowOverlay(!!sel, 'mod-detail');
  if (!sel) return null;
  const callable = sel.enabled || sel.tier === 'free';
  return (
    <View className="tk-mask" onClick={onClose} catchMove>
      <View className="tk-sheet" onClick={(e) => e.stopPropagation()}>
        <View className="tk-grip" />
        <Text className="tk-k">能 力 详 情</Text>
        <View className="tk-head">
          <View className="tk-head-ic"><Text>{sel.iconChar}</Text></View>
          <View className="tk-head-b"><Text className="tk-head-t serif">{sel.label}</Text><Text className="tk-head-s">{sel.stateLabel}</Text></View>
        </View>

        <Text className="tk-sub-label">使用场景</Text>
        <Text className="tk-scene">{sel.detail.scene}</Text>

        <View className="mod-flow">
          <View className="mf-cell"><Text className="mf-k">输入</Text><Text className="mf-v">{sel.detail.input}</Text></View>
          <View className="mf-cell"><Text className="mf-k">产出</Text><Text className="mf-v">{sel.detail.output}</Text></View>
          <View className="mf-cell"><Text className="mf-k">消耗</Text><Text className="mf-v">{sel.detail.cost}</Text></View>
        </View>

        <View className="tk-outline">
          <View className="to-row"><Text className="to-k">回写位置</Text><Text className="to-v">{sel.detail.writeback}</Text></View>
        </View>

        <View className="tk-actions">
          <View className="tk-secondary" onClick={onClose}><Text>返回</Text></View>
          <View className="tk-primary" style={{ background: accent }} onClick={onPrimary}><Text>{callable ? '立即调用' : '查看启用方式'}</Text></View>
        </View>
      </View>
    </View>
  );
}

// 弹层与 tab-bar 协调：跟随 open 驱动 store.setOverlay，并在卸载/关闭时清理。
function useDidShowOverlay(open: boolean, key: string) {
  useEffect(() => {
    store.setOverlay(open, key);
    return () => store.setOverlay(false, key);
  }, [open]);
}
