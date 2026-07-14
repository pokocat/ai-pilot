import { useRef, useState } from 'react';
import { ScrollView, View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import Login from '../../components/Login';
import MarkdownText from '../../components/MarkdownText';
import AsyncState from '../../components/AsyncState';
import PaySheet from '../../components/PaySheet';
import ExceptionSheet from '../../components/ExceptionSheet';
import Sheet from '../../components/Sheet';
import { navTo, switchTo } from '../../services/nav';
import { useStore } from '../../hooks/useStore';
import { checkUpload } from '../../services/uploadGuard';
import { displaySourceName, sourceUploadName } from '../../services/uploadName';
import {
  api,
  type KnowledgePipelineView, type OrganizeResult, type OrganizeItem, type KnowledgeBatchFile,
  type DataSourcesView, type DataSourceView,
  type ModulesView, type ModuleView, type ModuleTier, type ModuleGroup,
  type ReportItem,
} from '../../services/api';
import { awaitPaymentApplied, ensurePayableEnv, requestWechatPayment } from '../../services/pay';
import './index.scss';

type ThinkTab = 'assets' | 'data' | 'modules' | 'reports';
type Stage = 'staging' | 'optimized' | 'confirmed';

const TABS: { key: ThinkTab; label: string }[] = [
  { key: 'assets', label: '案卷资产' },
  { key: 'data', label: '数据源' },
  { key: 'modules', label: '能力' },
  { key: 'reports', label: '方案' },
];

const isWeapp = process.env.TARO_ENV === 'weapp';

// V7-06：资料整理 4 步动画（逐字，设计规格 §6.3）。
const PROC_STEPS = ['识别资料来源和文件类型', '去重并标记敏感信息', '按案卷目标生成分类结构', '输出待确认资料和问题清单'];
// V7-06：批次内单份文件解析状态 → 军师语汇徽章。
const FILE_STATUS: Record<string, { label: string; cls: string }> = {
  ready: { label: '已备好', cls: 'fs-ok' },
  parsing: { label: '在读', cls: 'fs-run' },
  embedding: { label: '在读', cls: 'fs-run' },
  pending: { label: '排队', cls: 'fs-wait' },
  failed: { label: '读不出', cls: 'fs-bad' },
};
// F15：已优化 / 知识库无真实数据时，改真空态引导，不再渲染假样例（原 OPTIMIZED_ROWS / FOLDER_FALLBACK 已移除）。

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
const CATEGORY_LABEL: Record<string, string> = {
  founder: '老板档案', company: '企业档案', finance: '财务经营', content: '内容IP',
  growth: '增长资料', customer: '客户问答', proof: '案例证明', unknown: '待识别',
};
const categoryLabel = (category: string) => CATEGORY_LABEL[category] || category;

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

function fmtRemainingQuota(usedBytes: number, totalBytes: number): string {
  const mb = 1024 * 1024;
  const totalMb = Math.floor(Math.max(0, totalBytes) / mb);
  const remainingMb = Math.floor(Math.max(0, totalBytes - Math.max(0, usedBytes)) / mb);
  return `${remainingMb}/${totalMb}MB`;
}

// 兼容历史客户端把微信临时路径写成文件名；新上传优先展示用户原始文件名。
function displayFileName(name: string | null | undefined, fallback = '待识别资料'): string {
  return displaySourceName(name, fallback);
}
// 数据源状态 → 色板（已绑定绿 / 待上传红 / 其余金，设计规格 §7.1）。
function dsClass(label: string): string {
  if (/已绑定|已接入/.test(label)) return 'ds-ok';
  if (/待上传/.test(label)) return 'ds-miss';
  return 'ds-warn';
}
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function previewBoxHeight(text: string): number {
  const visualLines = String(text || '').split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 22)), 0);
  return Math.min(300, Math.max(96, visualLines * 24 + 24));
}

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
  const [showLogin, setShowLogin] = useState(() => !s.isAuthed());
  // C2：四个 tab 各自的加载失败标记（失败给可重试错误态，不再静默空白）。
  const [err, setErr] = useState({ assets: false, data: false, modules: false, reports: false });

  // —— assets（V7-06）——
  const [pipe, setPipe] = useState<KnowledgePipelineView | null>(null);
  const [stage, setStage] = useState<Stage>('staging');
  const [uploading, setUploading] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const confirmingRef = useRef(false);
  const [organizeStep, setOrganizeStep] = useState(0);
  const [organized, setOrganized] = useState<OrganizeResult | null>(null);
  const [activeBatch, setActiveBatch] = useState<string | null>(null);
  const [openBatch, setOpenBatch] = useState<Record<string, boolean>>({}); // 批次逐份清单展开态（默认展开）
  const [openPreview, setOpenPreview] = useState<Record<string, boolean>>({});

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

  const loadPipeline = async (): Promise<boolean> => {
    setErr((e) => ({ ...e, assets: false }));
    try {
      setPipe(await api.knowledgePipeline());
      return true;
    } catch (e) {
      s.handleApiError(e, { silent: true });
      setErr((p) => ({ ...p, assets: true }));
      return false;
    }
  };
  const loadData = () => { setErr((e) => ({ ...e, data: false })); api.dataSources().then(setDsView).catch((e) => { s.handleApiError(e, { silent: true }); setErr((p) => ({ ...p, data: true })); }); };
  const loadModules = () => { setErr((e) => ({ ...e, modules: false })); api.modules().then(setModView).catch((e) => { s.handleApiError(e, { silent: true }); setErr((p) => ({ ...p, modules: true })); }); };
  const loadReports = () => { setErr((e) => ({ ...e, reports: false })); api.reports().then(setReports).catch((e) => { s.handleApiError(e, { silent: true }); setReports([]); setErr((p) => ({ ...p, reports: true })); }); };

  const loadAll = () => { loadPipeline(); loadData(); loadModules(); loadReports(); };

  useDidShow(() => {
    s.setTab(3);
    Taro.getCurrentInstance().page?.getTabBar?.();
    if (!s.isAuthed()) { setShowLogin(true); return; }
    loadAll();
  });

  const openReport = (id: string) => navTo(`/packages/work/report/index?id=${id}`);
  const goLibrary = () => navTo('/packages/work/library/index');
  const goChat = (agentKey: string, prompt: string) =>
    navTo(`/packages/main/chat/index?agentKey=${agentKey}&fresh=1&send=${encodeURIComponent(prompt)}`);

  // ============ V7-06 案卷资产 ============
  const counts = pipe?.counts ?? { staging: 0, optimized: 0, confirmed: 0 };
  const quota = pipe?.quota ?? { usedDocs: 0, freeDocs: 30, usedBytes: 0, freeBytes: 200 * 1024 * 1024 };
  const batches = pipe?.batches ?? [];
  const allFolders = pipe?.folders ?? [];
  const confirmedFolders = allFolders.filter((f) => f.stage === 'confirmed'); // 知识库段只取 confirmed 阶段
  // 已优化段以 pipeline 持久数据为准（刷新后不丢），本次整理的即时结果作乐观兜底。
  const optimizedItems: OrganizeItem[] = (pipe?.optimizedItems && pipe.optimizedItems.length)
    ? pipe.optimizedItems
    : (organized?.items ?? []);

  const chooseUpload = async () => {
    if (uploading || organizing || confirmingRef.current) return;
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
        // 带上原始文件名 f.name 作展示名（tempFilePath 是 tmp 名，服务端否则会存乱码 tmp 名）。
        const r = await api.uploadKnowledge(f.path, undefined, true, bid, sourceUploadName(f.name));
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
          if (!ensurePayableEnv()) return; // H5（server 模式）：下单前拦下
          const order = await api.createSkuOrder('deep-organize', undefined, { source: 'catalog' });
          if (order.payParams) {
            await requestWechatPayment(order.payParams);
            // 到账确认（统一收口）：轮询订单状态直至凭据发放（服务端会主动查单补账），
            // 再触发整理——SKU_REQUIRED 竞态重试仍保留作兜底。
            await awaitPaymentApplied(order.orderId);
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
    if (confirmingRef.current) return;
    const ids = optimizedItems.map((item) => item.id);
    if (!ids.length) { Taro.showToast({ title: '暂无可确认资料，请先整理待整理区', icon: 'none' }); return; }
    const noPreview = optimizedItems.filter((item) => !item.preview?.trim()).length;
    const confirm = await Taro.showModal({
      title: '确认写入知识库',
      content: noPreview
        ? `共 ${ids.length} 份，其中 ${noPreview} 份没有提取到可预览正文。建议先核对或重新上传，仍要继续吗？`
        : `共 ${ids.length} 份。请先展开每份资料核对正文，确认后将供战局、方案和对话引用。`,
      confirmText: noPreview ? '仍然入库' : '确认入库',
      cancelText: '再检查下',
    });
    if (!confirm.confirm) return;
    confirmingRef.current = true;
    setConfirming(true);
    try {
      const r = await api.confirmKnowledge({ ids });
      if (!r.count) { Taro.showToast({ title: '暂无可确认资料，请先整理待整理区', icon: 'none' }); return; }
      setOrganized(null);
      setActiveBatch(null);
      const refreshed = await loadPipeline();
      setStage('confirmed');
      Taro.showToast({ title: refreshed ? `已写入知识库 · ${r.count} 份` : '已入库，页面刷新失败，请稍后重试', icon: 'none' });
    } catch (e) {
      s.handleApiError(e);
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  };

  // 待整理批次里删除某份（解析失败的删掉重传；走既有知识删除接口）。
  const removeStagedFile = (f: KnowledgeBatchFile) => {
    Taro.showModal({
      title: '删除这份资料',
      content: `删除「${displayFileName(f.fileName)}」？删掉后可重新上传这一份。`,
      success: (r) => {
        if (!r.confirm) return;
        api.deleteKnowledge(f.id).then(() => { Taro.showToast({ title: '已删除', icon: 'none' }); loadPipeline(); }).catch((e) => s.handleApiError(e));
      },
    });
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
        setExc({ open: true, kind: 'power', title: '算力不足', desc: '启用该能力所需算力不足，可购买算力或改用免费能力。', onPrimary: () => { closeExc(); navTo('/packages/work/credits/index'); } });
      } else if (code === 'PLAN_EXPIRED') {
        Taro.showToast({ title: '会员已过期，续费后可继续使用', icon: 'none' });
      } else s.handleApiError(e, { fallbackTitle: '启用失败，请重试' });
    }
  };

  // sku：先微信支付下单，再 enableModule（服务端购买即授予对应模块）。
  const doEnableSku = async (m: ModuleView) => {
    try {
      if (m.price?.skuKey) {
        if (!ensurePayableEnv()) return; // H5（server 模式）：下单前拦下
        const order = await api.createSkuOrder(m.price.skuKey, undefined, { source: 'catalog' });
        if (order.payParams) {
          await requestWechatPayment(order.payParams);
          // 到账确认（统一收口）：先等权益发放（服务端会主动查单补账），下方 enableModule 重试仅作兜底。
          await awaitPaymentApplied(order.orderId);
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
          <Text className="tn-title serif">锦囊</Text>
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
          err.assets && !pipe ? (
            <AsyncState error onRetry={loadPipeline} />
          ) : (
          <>
            {/* 额度三卡 */}
            <View className="quota-grid">
              <View className="quota-card card" onClick={() => Taro.showToast({ title: `本月免费整理额度：${quota.freeDocs} 份 / 200MB`, icon: 'none' })}>
                <Text className="qc-v serif">{quota.usedDocs} / {quota.freeDocs}</Text>
                <Text className="qc-l">免费资料额度</Text>
              </View>
              <View className="quota-card card" onClick={() => Taro.showToast({ title: `知识库已用 ${fmtBytes(quota.usedBytes)}，剩余可继续上传`, icon: 'none' })}>
                <Text className="qc-v serif">{fmtRemainingQuota(quota.usedBytes, quota.freeBytes)}</Text>
                <Text className="qc-l">可用空间 · 可扩容</Text>
              </View>
              <View className="quota-card card" onClick={() => { if (batches.length) openDeepPay(batches[0].id); else Taro.showToast({ title: '先上传资料到待整理区，再做深度整理', icon: 'none' }); }}>
                <Text className="qc-v serif">深度整理</Text>
                <Text className="qc-l">去重 / 分类 / 优化</Text>
              </View>
            </View>

            {/* 三段流水段 */}
            <View className="stage-seg">
              {([['staging', '待整理', counts.staging], ['optimized', '已优化', counts.optimized], ['confirmed', '知识库', counts.confirmed]] as [Stage, string, number][]).map(([k, label, n]) => (
                <View key={k} className={`stage-tab ${stage === k ? 'on' : ''} ${confirming ? 'locked' : ''}`} onClick={() => { if (!confirmingRef.current) setStage(k); }}>
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
                    <Text className="uz-d">先上传并检查资料，再点击「开始资料整理」。确认后才会进入知识库，供战局和对话调用。</Text>
                  </View>
                  <View className="uz-btn"><Text>{uploading ? '上传中…' : '＋ 上传'}</Text></View>
                </View>

                {!organizing && !organized && batches.length ? (
                  <View className="next-step">
                    <View className="next-step-top">
                      <Text className="next-step-k">下一步 · 资料整理</Text>
                      <Text className="next-step-count">2 / 3</Text>
                    </View>
                    <Text className="next-step-t serif">资料已接收，先让军师整理</Text>
                    <Text className="next-step-d">会先识别类型、去重、归类并提炼摘要。整理完成后，你再确认哪些资料进入知识库。</Text>
                    <View className="next-step-actions">
                      <View className="next-step-primary" style={{ background: accent }} onClick={() => runOrganize(batches[0].id, false)}><Text>开始资料整理</Text></View>
                      <View className="next-step-secondary" onClick={() => runOrganize(batches[0].id, true)}><Text>深度整理</Text></View>
                    </View>
                  </View>
                ) : null}

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
                          <Text className="orgd-tag">待确认</Text>
                        </View>
                        {organized.items.map((it) => {
                          const previewing = !!openPreview[it.id];
                          return (
                            <View key={it.id} className={`organized-item ${it.isDup ? 'dup' : ''}`}>
                              <View className="organized-row">
                                <View className="or-i"><Text>{categoryLabel(it.category).slice(0, 1)}</Text></View>
                                <View className="or-b">
                                  <Text className="or-t">{displayFileName(it.fileName, categoryLabel(it.category))}</Text>
                                  <Text className="or-name-source">{it.nameSource === 'original' ? '源文件名' : it.nameSource === 'content' ? '按正文标题识别 · 原文件名未保留' : '原文件名未保留'}</Text>
                                  <Text className="or-s">{it.isDup ? '与同名资料重复，已合并' : `${categoryLabel(it.category)} · ${it.summary}`}</Text>
                                </View>
                                {it.isDup ? <Text className="or-dup">已合并</Text> : <Text className="or-tag">{categoryLabel(it.category)}</Text>}
                              </View>
                              <View className={`preview-toggle ${it.preview ? '' : 'disabled'}`} onClick={() => it.preview && setOpenPreview((m) => ({ ...m, [it.id]: !previewing }))}>
                                <Text>{it.preview ? (previewing ? '收起正文预览' : '预览正文') : '未提取到可预览正文'}</Text>
                                {it.preview ? <Text>{previewing ? '⌃' : '⌄'}</Text> : null}
                              </View>
                              {previewing && it.preview ? (
                                <ScrollView className="item-preview" scrollY style={{ height: `${previewBoxHeight(it.preview)}px` }}>
                                  <MarkdownText text={it.preview} selectable />
                                </ScrollView>
                              ) : null}
                            </View>
                          );
                        })}
                        {organized.deep && organized.reportId ? (
                          <View className="orgd-report" onClick={() => openReport(organized.reportId!)}><Text>查看整理报告 ›</Text></View>
                        ) : null}
                        <Text className="orgd-hint">下一步：确认这些资料后，才会写入知识库并参与战局判断和后续对话。</Text>
                        <View className="orgd-btn" style={{ background: accent }} onClick={() => setStage('optimized')}><Text>去确认入库 ›</Text></View>
                      </View>
                    ) : null}

                    {batches.map((b) => {
                      const expanded = openBatch[b.id] !== false; // 默认展开逐份清单
                      const failedN = b.files.filter((f) => f.status === 'failed').length;
                      return (
                        <View key={b.id} className="pile card">
                          <View className="pile-head" onClick={() => setOpenBatch((m) => ({ ...m, [b.id]: !expanded }))}>
                            <View className="pile-ic"><Text>收</Text></View>
                            <View className="pile-b">
                              <Text className="pile-t serif">已接收 {b.count} 份原始素材</Text>
                              <Text className="pile-s">{failedN ? `其中 ${failedN} 份读不出，删掉重传即可` : '这一批资料还没整理，先集中放在待整理区'}</Text>
                            </View>
                            <Text className="pile-tag">{expanded ? '收起' : `展开 ${b.count} 份`}</Text>
                          </View>
                          {expanded ? (
                            <View className="file-list">
                              {b.files.map((f) => {
                                const st = FILE_STATUS[f.status] || FILE_STATUS.ready;
                                const bad = f.status === 'failed';
                                return (
                                  <View key={f.id} className={`file-row ${bad ? 'bad' : ''}`}>
                                    <View className="fr-b">
                                      <Text className="fr-name">{displayFileName(f.fileName)}</Text>
                                      <Text className="fr-meta">{f.fileSize ? fmtBytes(f.fileSize) : '—'}{bad ? ' · 这份读不出来，删掉重传' : ''}</Text>
                                    </View>
                                    <Text className={`fr-badge ${st.cls}`}>{st.label}</Text>
                                    {bad ? <Text className="fr-del" onClick={() => removeStagedFile(f)}>删除</Text> : null}
                                  </View>
                                );
                              })}
                            </View>
                          ) : (
                            b.typeStats.length ? (
                              <View className="pile-chips">
                                {b.typeStats.map((t) => <Text key={t.label} className="pile-chip">{t.label} {t.count} 份</Text>)}
                              </View>
                            ) : null
                          )}
                        </View>
                      );
                    })}

                    {!batches.length && !organized ? (
                      <View className="stage-empty"><Text className="se-t">待整理区还是空的</Text><Text className="se-s">先把散落在微信、表格、文档、图片里的材料放进来。</Text></View>
                    ) : null}
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
                {optimizedItems.length ? (
                  <>
                    <View className="asset-list card">
                      {optimizedItems.map((it) => {
                        const previewing = !!openPreview[it.id];
                        return (
                          <View key={it.id} className={`asset-list-item ${it.isDup ? 'dup' : ''}`}>
                            <View className="asset-list-row">
                              <View className="al-i"><Text>{categoryLabel(it.category).slice(0, 1)}</Text></View>
                              <View className="al-b">
                                <Text className="al-t serif">{displayFileName(it.fileName, categoryLabel(it.category))}</Text>
                                <Text className="al-name-source">{it.nameSource === 'original' ? '源文件名' : it.nameSource === 'content' ? '按正文标题识别 · 原文件名未保留' : '原文件名未保留'}</Text>
                                <Text className="al-s">{it.isDup ? '与同名资料重复，已合并' : `${categoryLabel(it.category)} · ${it.summary}`}</Text>
                              </View>
                              {it.isDup ? <Text className="al-dup">已合并</Text> : <Text className="al-tag">{categoryLabel(it.category)}</Text>}
                            </View>
                            <View className={`preview-toggle ${it.preview ? '' : 'disabled'}`} onClick={() => it.preview && setOpenPreview((m) => ({ ...m, [it.id]: !previewing }))}>
                              <Text>{it.preview ? (previewing ? '收起正文预览' : '预览正文') : '未提取到可预览正文'}</Text>
                              {it.preview ? <Text>{previewing ? '⌃' : '⌄'}</Text> : null}
                            </View>
                            {previewing && it.preview ? (
                              <ScrollView className="item-preview" scrollY style={{ height: `${previewBoxHeight(it.preview)}px` }}>
                                <MarkdownText text={it.preview} selectable />
                              </ScrollView>
                            ) : null}
                          </View>
                        );
                      })}
                    </View>
                    <View className={`confirm-library card ${confirming ? 'busy' : ''}`} onClick={confirmOptimized}>
                      <Text className="cl-t serif">{confirming ? '正在写入知识库' : '下一步：确认入库'}</Text>
                      <Text className="cl-s">{confirming ? '正在切片并建立检索索引，请稍候，不要重复操作。' : '确认后将回写战局页、方案页和后续对话引用。'}</Text>
                      <View className="cl-btn" style={{ background: accent }}>
                        {confirming ? <View className="cl-spinner" /> : null}
                        <Text>{confirming ? `正在处理 ${optimizedItems.length} 份资料…` : `确认 ${optimizedItems.length} 份并写入知识库`}</Text>
                      </View>
                    </View>
                  </>
                ) : (
                  <View className="stage-empty">
                    <Text className="se-t">还没有已优化的资料</Text>
                    <Text className="se-s">先到「待整理」上传并整理资料，优化结果会在这里等你确认入库。</Text>
                  </View>
                )}
              </>
            ) : null}

            {/* —— 知识库 —— */}
            {stage === 'confirmed' ? (
              <>
                <View className="stage-summary card">
                  <Text className="ss-t serif">已进入知识库</Text>
                  <Text className="ss-s">这里的资料已经可被战局、方案和对话直接调用。</Text>
                  <Text className="ss-em">{counts.confirmed} 份</Text>
                </View>
                {confirmedFolders.length ? (
                  <>
                    <View className="folder-grid">
                      {confirmedFolders.map((f) => (
                        // 点入资料库逐份清单（可查看每份原名/摘要/正文），不再只停在「N 份」计数。
                        <View key={f.key} className="folder-tile card" onClick={() => navTo('/packages/work/knowledge/index')}>
                          <View className="ft-ic"><Text>{f.label.slice(0, 1)}</Text></View>
                          <Text className="ft-t serif">{f.label}</Text>
                          <Text className="ft-n">{f.count} 份 ›</Text>
                        </View>
                      ))}
                    </View>
                    <View className="confirm-library card" onClick={syncKnowledge}>
                      <Text className="cl-t serif">资料已入库，下一步去看判断</Text>
                      <Text className="cl-s">把知识库内容回写给战局页、方案页和后续对话。</Text>
                      <View className="cl-btn" style={{ background: accent }}><Text>刷新战局判断</Text></View>
                    </View>
                  </>
                ) : (
                  <View className="stage-empty">
                    <Text className="se-t">知识库还是空的</Text>
                    <Text className="se-s">确认优化后的资料入库后，会在这里按目录沉淀，供战局、方案和对话调用。</Text>
                  </View>
                )}
              </>
            ) : null}
          </>
          )
        ) : null}

        {/* ===================== 数据源（V7-07） ===================== */}
        {tab === 'data' ? (
          err.data && !dsView ? (
            <AsyncState error onRetry={loadData} />
          ) : (
          <>
            <View className="ds-hero card">
              <Text className="dh-k">经营数据源</Text>
              <Text className="dh-t serif">让军师判断有真实证据</Text>
              <Text className="dh-d">先支持上传表格、截图和聊天记录，再逐步做后台授权。数据会参与战局判断、执行复盘和方案更新。</Text>
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
          )
        ) : null}

        {/* ===================== 能力（V7-08） ===================== */}
        {tab === 'modules' ? (
          err.modules && !modView ? (
            <AsyncState error onRetry={loadModules} />
          ) : (
          <>
            <View className="module-hero card">
              <Text className="mh-k">能力中心</Text>
              <Text className="mh-t serif">按当前案卷调用能力</Text>
              <Text className="mh-d">免费能力先判断，深度能力做推演，会员模块承接长期执行。</Text>
              <View className="mh-stats">
                <View className="mh-s"><Text className="mh-sv serif">{modStats.free}</Text><Text className="mh-sl">免费可用</Text></View>
                <View className="mh-s"><Text className="mh-sv serif">{modStats.deep}</Text><Text className="mh-sl">深度能力</Text></View>
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
          )
        ) : null}

        {/* ===================== 报告（V7-09） ===================== */}
        {tab === 'reports' ? (
          err.reports && !reports.length ? (
            <AsyncState error onRetry={loadReports} />
          ) : (
          <>
            <Text className="think-h2">方案与历史版本</Text>
            {reports.length === 0 ? (
              <View className="think-empty">
                <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={22} color={accent} /></View>
                <Text className="et">还没有沉淀方案</Text>
                <Text className="es">在战局页认可判断、或让军师产出方案后，方案会按版本沉淀在这里。</Text>
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
            <View className="report card" onClick={() => switchTo('/pages/sessions/index')}>
              <View className="report-ic"><Text className="serif">新</Text></View>
              <View className="report-b">
                <Text className="report-t serif">从对话生成新方案</Text>
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
          )
        ) : null}

        {/* 底部主行动（C7：仅「案卷资产」tab 常驻，其它 tab 无「上传资料」语境不出现） */}
        {tab === 'assets' ? (
          <View className="think-cta" onClick={chooseUpload}>
            <Icon name="upload" size={16} color="#FBFAF6" />
            <Text>上传资料，让军师补全判断</Text>
          </View>
        ) : null}
      </View>

      {/* 数据源详情屏（授权范围 / 同步频率 / 回写位置 / 隐私控制） */}
      <DsSheet sel={dsSel} onClose={() => setDsSel(null)} onBind={bindDataSource} />

      {/* 能力详情屏（使用场景 / 输入·产出·消耗 / 回写位置） */}
      <ModSheet sel={modSel} onClose={() => setModSel(null)} onPrimary={primaryModule} />

      <PaySheet
        open={pay.open} mode={pay.mode} title={pay.title} desc={pay.desc}
        costValue={pay.costValue} balanceValue={pay.balanceValue} afterValue={pay.afterValue}
        result={pay.result} confirmText={pay.confirmText} skuKey={pay.skuKey}
        source="catalog" onConfirm={pay.onConfirm} onClose={closePay}
      />
      <ExceptionSheet
        open={exc.open} kind={exc.kind} title={exc.title} desc={exc.desc}
        onPrimary={exc.onPrimary} onClose={closeExc}
      />

      {/* C1：登录门（对齐 sessions/home）——未登录先引导，登录后再拉智库四 tab 数据 */}
      <Login open={showLogin} onLoggedIn={() => { setShowLogin(false); loadAll(); }} />
    </Screen>
  );
}

// —— 数据源详情屏 ——（hand-rolled sheet，mask z900 + setOverlay）
function DsSheet({ sel, onClose, onBind }: { sel: DataSourceView | null; onClose: () => void; onBind: () => void }) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  if (!sel) return null;
  const advanced = sel.tier === 'advanced';
  return (
    <Sheet
      visible={!!sel}
      onClose={onClose}
      overlayKey="ds-detail"
      panelClassName="tk-pad"
      footer={
        <View className="tk-actions">
          <View className="tk-secondary" onClick={onClose}><Text>返回</Text></View>
          <View className="tk-primary" style={{ background: accent }} onClick={onBind}><Text>{advanced ? '预约开通授权' : '上传替代资料'}</Text></View>
        </View>
      }
    >
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
        <View className="dm-cell"><Text className="dm-k">回写位置</Text><Text className="dm-v">战局、执行、方案</Text></View>
        <View className="dm-cell"><Text className="dm-k">隐私控制</Text><Text className="dm-v">可随时断开或隐藏来源</Text></View>
      </View>
    </Sheet>
  );
}

// —— 能力详情屏 ——
function ModSheet({ sel, onClose, onPrimary }: { sel: ModuleView | null; onClose: () => void; onPrimary: () => void }) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  if (!sel) return null;
  const callable = sel.enabled || sel.tier === 'free';
  return (
    <Sheet
      visible={!!sel}
      onClose={onClose}
      overlayKey="mod-detail"
      panelClassName="tk-pad"
      footer={
        <View className="tk-actions">
          <View className="tk-secondary" onClick={onClose}><Text>返回</Text></View>
          <View className="tk-primary" style={{ background: accent }} onClick={onPrimary}><Text>{callable ? '立即调用' : '查看启用方式'}</Text></View>
        </View>
      }
    >
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
    </Sheet>
  );
}

// 弹层与 tab-bar 协调（setOverlay）已收敛至 Sheet 基座（overlayKey）。
