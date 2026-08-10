// 锦囊区 · 案卷资产。三段流水（待整理 → 已优化 → 知识库）在 PC 上摊成一张表。
//
// 为什么 PC 值得单独写一遍而不是照搬移动端：手机上「选文件」只能从微信聊天里挑，
// 一次几份；PC 是用户真正倒资料的地方——文件管理器里框一堆、甚至整个文件夹拖进来。
// 所以这里的重心全在**进料口**：多选、文件夹拖放、逐份进度、逐份可取消。
// 后面的整理/确认/入库三步与移动端共用同一批服务端接口和同一套纯逻辑模块
// （uploadGuard / uploadName / knowledgePreview），不另起炉灶。
//
// 三段的行数据来源并不同源，这是服务端的既有形状，不是这里偷懒：
//   待整理 = pipeline.batches[].files（只有文件名/状态/字节，没有归类与摘要）
//   已优化 = pipeline.optimizedItems（有归类/摘要/正文预览，唯独没有字节数）
//   知识库 = knowledgeDocs()（有字节与摘要，没有归类）
// 缺的列一律显示「—」，不拿别的字段冒充——表头写着「归类」就必须是归类。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../hooks/useStore';
import { platform } from '../../services/platform';
import { checkUpload } from '../../services/uploadGuard';
import { displaySourceName, sourceUploadName } from '../../services/uploadName';
import { displayKnowledgePreview } from '../../services/knowledgePreview';
import {
  api,
  type KnowledgeDocRow, type KnowledgePipelineFolder, type KnowledgePipelineView, type OrganizeItem,
} from '../../services/api';
import { requireAuth } from '../authBridge';
import type { CtxItem, DrawerData, PcState } from '../state';
import './thinkAssets.scss';

type Stage = 'staging' | 'optimized' | 'confirmed';
type Tone = 'ok' | 'run' | 'wait' | 'bad';

const STAGE_META: Record<Stage, { tab: string; title: string; desc: string; action: string }> = {
  staging: { tab: '待整理', title: '待整理', desc: '先集中收着，整理过才有归类和摘要', action: '帮我整理这批资料' },
  optimized: { tab: '已优化', title: '已优化', desc: '我理过一遍了，你过目，点头我就入库', action: '确认并写入知识库' },
  confirmed: { tab: '知识库', title: '知识库', desc: '这些资料我都读过了，做判断时会用上', action: '刷新战局判断' },
};

const CATEGORY_LABEL: Record<string, string> = {
  founder: '老板档案', company: '企业档案', finance: '财务经营', content: '内容IP',
  growth: '增长资料', customer: '客户问答', proof: '案例证明', unknown: '待识别',
};
const categoryLabel = (key: string) => CATEGORY_LABEL[key] || key;

// 批次内单份文件的解析状态 → 军师语汇（与移动端同一套说法，两端别各说各话）。
const FILE_STATUS: Record<string, { t: string; tone: Tone }> = {
  ready: { t: '已备好', tone: 'ok' },
  parsing: { t: '在读', tone: 'run' },
  embedding: { t: '在读', tone: 'run' },
  pending: { t: '排队', tone: 'wait' },
  failed: { t: '读不出', tone: 'bad' },
};

const NAME_SOURCE_SHORT: Record<OrganizeItem['nameSource'], string> = {
  original: '源文件名',
  content: '按正文识别',
  fallback: '原名未保留',
};
const NAME_SOURCE_FULL: Record<OrganizeItem['nameSource'], string> = {
  original: '标题就是你上传时的文件名。',
  content: '原文件名没保留下来，标题是从正文首段标题识别出来的，核对一下是否贴切。',
  fallback: '原文件名没保留，正文里也没识别出标题，只能先挂一个占位名。',
};

// 一次拖放最多收 50 份：拖错目录（比如整个「下载」文件夹）时不至于闷头发几百个请求。
const MAX_DROP_FILES = 50;

function fmtBytes(b: number): string {
  if (b >= 1024 * 1024 * 1024) return `${(b / 1024 / 1024 / 1024).toFixed(1)}GB`;
  if (b >= 1024 * 1024) return `${Math.round(b / 1024 / 1024)}MB`;
  return `${Math.max(0, Math.round(b / 1024))}KB`;
}

/**
 * 剩余空间一律**向下取整**并同时给出总量（`199/200MB`）。
 * 四舍五入会把「已经占掉一点」显示成满格，用户以为没传上去；宁可少报一 MB。
 */
function fmtRemainingQuota(usedBytes: number, totalBytes: number): string {
  const mb = 1024 * 1024;
  const totalMb = Math.floor(Math.max(0, totalBytes) / mb);
  const remainingMb = Math.floor(Math.max(0, totalBytes - Math.max(0, usedBytes)) / mb);
  return `${remainingMb}/${totalMb}MB`;
}

const displayFileName = (name: string | null | undefined, fallback = '待识别资料') => displaySourceName(name, fallback);

/** 表格一行。三段各自装配，装配完之后渲染层只认这一种形状。 */
interface AssetRow {
  id: string;
  name: string;
  summary: string;
  category: string;
  nameSourceShort: string;
  nameSourceFull: string;
  size: string;
  status: { t: string; tone: Tone };
  fileType: string | null;
  /** 已优化段自带正文预览；其余段要点开详情才拉得到 */
  preview: string;
  stage: Stage;
}

/** 上传队列里的一份。abort 是 platform.upload 给的真中止句柄，不是「假装取消」。 */
interface UploadRow {
  uid: string;
  name: string;
  size: number;
  percent: number;
  state: 'up' | 'done' | 'fail' | 'cancel';
}

/**
 * 从拖放数据里取文件，能展开文件夹就展开。
 * 注意：`webkitGetAsEntry()` 必须在事件回调同步阶段调完——DataTransferItemList 在
 * 回调返回后就失效，一旦 await 过再去读就全是 null。所以调用方先同步取 entries，再交给这里递归。
 */
async function readEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const out: FileSystemEntry[] = [];
  // readEntries 每次最多回 100 条，必须一直读到空数组，否则大文件夹会被悄悄截断。
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((res) => reader.readEntries(res, () => res([])));
    if (!batch.length) return out;
    out.push(...batch);
  }
}

async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (out.length >= MAX_DROP_FILES) return;
  if (entry.isFile) {
    const f = await new Promise<File | null>((res) => (entry as FileSystemFileEntry).file(res, () => res(null)));
    // 跳过 .DS_Store 之类的隐藏文件：用户拖文件夹是要传资料，不是要传系统垃圾。
    if (f && !f.name.startsWith('.')) out.push(f);
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readEntries(entry as FileSystemDirectoryEntry);
  for (const child of children) {
    await walkEntry(child, out);
    if (out.length >= MAX_DROP_FILES) return;
  }
}

export default function ThinkAssets({ st }: { st: PcState }) {
  const s = useStore();
  const authed = s.isAuthed();

  const [pipe, setPipe] = useState<KnowledgePipelineView | null>(null);
  const [docs, setDocs] = useState<KnowledgeDocRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  const [stage, setStage] = useState<Stage>('staging');
  const [sel, setSel] = useState<Record<string, boolean>>({});

  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // 同步锁用 ref 不用 state：二次确认是异步的（platform.confirm 要等用户点），
  // 等 setState 那一帧回来，第二次点击早就穿过去了——重复入库就是这么来的。
  const confirmingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const batchRef = useRef<string | null>(null);
  const abortRef = useRef(new Map<string, () => void>());
  const cancelRef = useRef(new Set<string>());
  const drawerRef = useRef('');

  const load = useCallback(async () => {
    if (!s.isAuthed()) { setPipe(null); setDocs([]); setLoaded(true); return; }
    setLoading(true);
    try {
      const view = await api.knowledgePipeline();
      setPipe(view);
      setFailed(false);
    } catch (e) {
      s.handleApiError(e, { silent: true });
      setFailed(true);
    }
    // 文档视图只补两件事：知识库段的行，和已优化段缺的「大小」。
    // 它挂了不该把整屏判成失败，静默降级即可（大小列显示「—」）。
    try { setDocs(await api.knowledgeDocs()); } catch (e) { s.handleApiError(e, { silent: true }); }
    setLoading(false);
    setLoaded(true);
  }, [s]);

  useEffect(() => { void load(); }, [load, authed]);
  useEffect(() => { setSel({}); }, [stage]);

  const counts = pipe?.counts ?? { staging: 0, optimized: 0, confirmed: 0 };
  const quota = pipe?.quota ?? { usedDocs: 0, freeDocs: 30, usedBytes: 0, freeBytes: 200 * 1024 * 1024 };
  const batches = useMemo(() => pipe?.batches ?? [], [pipe]);
  const folders: KnowledgePipelineFolder[] = useMemo(
    () => (pipe?.folders ?? []).filter((f) => f.stage === 'confirmed'),
    [pipe],
  );
  const busy = uploading || organizing || confirming;

  // 已优化项没带字节数，用文档视图按 id 补上；补不到就老实显示「—」。
  const sizeById = useMemo(() => {
    const m = new Map<string, number>();
    docs.forEach((d) => { if (d.fileSize) m.set(d.id, d.fileSize); });
    return m;
  }, [docs]);

  const rows: AssetRow[] = useMemo(() => {
    if (stage === 'staging') {
      return batches.flatMap((b) => b.files.map((f) => {
        const bad = f.status === 'failed';
        return {
          id: f.id,
          name: displayFileName(f.fileName),
          summary: bad ? '这份读不出来，删掉重传即可' : '还没整理，先在待整理区收着',
          category: '—',
          nameSourceShort: sourceUploadName(f.fileName) ? '源文件名' : '原名未保留',
          nameSourceFull: sourceUploadName(f.fileName)
            ? '标题就是你上传时的文件名。'
            : '上传时没带上原文件名，整理时军师会尝试从正文认一个标题。',
          size: f.fileSize ? fmtBytes(f.fileSize) : '—',
          status: FILE_STATUS[f.status] || FILE_STATUS.ready,
          fileType: null,
          preview: '',
          stage: 'staging' as const,
        };
      }));
    }
    if (stage === 'optimized') {
      return (pipe?.optimizedItems ?? []).map((it) => {
        const size = sizeById.get(it.id);
        return {
          id: it.id,
          name: displayFileName(it.fileName, categoryLabel(it.category)),
          summary: it.isDup ? '与同名资料重复，已合并' : it.summary,
          category: categoryLabel(it.category),
          nameSourceShort: NAME_SOURCE_SHORT[it.nameSource],
          nameSourceFull: NAME_SOURCE_FULL[it.nameSource],
          size: size ? fmtBytes(size) : '—',
          status: it.isDup ? { t: '已合并', tone: 'wait' as Tone } : { t: '待确认', tone: 'run' as Tone },
          fileType: it.fileType,
          preview: displayKnowledgePreview(it.preview, it.fileType),
          stage: 'optimized' as const,
        };
      });
    }
    return docs.filter((d) => d.stage === 'confirmed').map((d) => {
      const named = sourceUploadName(d.fileName);
      return {
        id: d.id,
        name: displayFileName(d.fileName, d.title || '待识别资料'),
        summary: d.summary || '已入库，正文可在详情里核对',
        // 文档视图不回归类字段，只有目录格能看到分类分布——不拿文件类型冒充归类。
        category: '—',
        nameSourceShort: named ? '源文件名' : '原名未保留',
        nameSourceFull: named ? '标题就是你上传时的文件名。' : '入库记录里没有原文件名，标题是入库时定的。',
        size: d.fileSize ? fmtBytes(d.fileSize) : '—',
        status: d.status === 'ready'
          ? { t: '已入库', tone: 'ok' as Tone }
          : d.status === 'failed' ? { t: '读不出', tone: 'bad' as Tone } : { t: '在读', tone: 'run' as Tone },
        fileType: d.fileType,
        preview: '',
        stage: 'confirmed' as const,
      };
    });
  }, [batches, docs, pipe, sizeById, stage]);

  const selIds = useMemo(() => rows.filter((r) => sel[r.id]).map((r) => r.id), [rows, sel]);
  const allChecked = rows.length > 0 && selIds.length === rows.length;

  // ── 上传 ──────────────────────────────────────────────

  const doUpload = useCallback(async (files: File[]) => {
    if (!files.length) return;
    if (!requireAuth('upload')) return;
    if (uploading || organizing || confirmingRef.current) { st.say('上一批还在处理，稍等一下'); return; }

    // 任一份不合规就整批拦下：一半传上去一半被拒，用户根本分不清哪份没进去。
    for (const f of files) {
      const chk = checkUpload({ name: f.name, size: f.size });
      if (!chk.ok) { st.say(chk.desc || chk.title || '这份资料上传不了'); return; }
    }

    const queue = files.map((file, i) => ({
      file,
      row: { uid: `u${Date.now()}-${i}`, name: file.name, size: file.size, percent: 0, state: 'up' as const },
    }));
    setUploads(queue.map((q) => q.row));
    setUploading(true);

    const patch = (uid: string, next: Partial<UploadRow>) =>
      setUploads((prev) => prev.map((u) => (u.uid === uid ? { ...u, ...next } : u)));

    let bid = batchRef.current || undefined;
    let ok = 0;
    let firstError: unknown = null;
    for (const q of queue) {
      if (cancelRef.current.has(q.row.uid)) { patch(q.row.uid, { state: 'cancel' }); continue; }
      try {
        const r = await api.uploadKnowledge(q.file, undefined, true, bid, q.file.name, {
          onProgress: (p) => patch(q.row.uid, { percent: p }),
          onTask: (task) => { abortRef.current.set(q.row.uid, () => task.abort()); },
        });
        // 第一份回来的 batchId 带着后面几份走，整批才会归到同一个批次里一起整理。
        bid = r.batchId || bid;
        ok += 1;
        patch(q.row.uid, { state: 'done', percent: 100 });
      } catch (e) {
        if (cancelRef.current.has(q.row.uid)) patch(q.row.uid, { state: 'cancel' });
        else { patch(q.row.uid, { state: 'fail' }); firstError = firstError ?? e; }
      } finally {
        abortRef.current.delete(q.row.uid);
      }
    }
    cancelRef.current.clear();
    batchRef.current = bid || null;
    setUploading(false);
    // 成功的行收掉，失败/取消的留着——用户得看得见哪几份没进去。
    setUploads((prev) => prev.filter((u) => u.state !== 'done'));
    if (firstError) s.handleApiError(firstError, { fallbackTitle: '有资料没能上传' });
    if (ok) {
      setStage('staging');
      st.say(`已收到 ${ok} 份资料，待整理`);
      await load();
    }
  }, [load, organizing, s, st, uploading]);

  const pickFiles = () => {
    if (!requireAuth('upload')) return;
    fileRef.current?.click();
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const dt = e.dataTransfer;
    // 同步阶段先把 entry 抓在手里（见 readEntries 注释），异步遍历放到后面。
    const entries = Array.from(dt.items || [])
      .filter((it) => it.kind === 'file')
      .map((it) => (typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null));
    const flat = Array.from(dt.files || []);
    void (async () => {
      if (!entries.some(Boolean)) { await doUpload(flat.slice(0, MAX_DROP_FILES)); return; }
      const out: File[] = [];
      for (const entry of entries) {
        if (!entry) continue;
        await walkEntry(entry, out);
      }
      if (out.length >= MAX_DROP_FILES) st.say(`一次最多收 ${MAX_DROP_FILES} 份，先传这些`);
      await doUpload(out);
    })();
  };

  const cancelUpload = (uid: string) => {
    cancelRef.current.add(uid);
    abortRef.current.get(uid)?.();
    setUploads((prev) => prev.map((u) => (u.uid === uid && u.state === 'up' ? { ...u, state: 'cancel' } : u)));
  };

  // ── 整理 / 确认 / 回写 ─────────────────────────────────

  const organize = async (deep: boolean) => {
    if (!requireAuth('upload')) return;
    if (busy) return;
    const bid = batches[0]?.id;
    if (!bid) { st.say('先上传资料到待整理区，再让军师整理'); return; }
    if (deep) {
      const ok = await platform.confirm({
        title: '深度整理',
        content: '深度整理会做更彻底的去重、提炼与补标，并产出一份整理报告。这是单次付费能力，确认发起？',
        confirmText: '发起深度整理',
      });
      if (!ok) return;
    }
    setOrganizing(true);
    try {
      const r = deep ? await api.deepOrganize(bid) : await api.organizeBatch(bid);
      await load();
      setStage('optimized');
      st.say(`已整理 ${r.total} 份${r.dedup ? `，去重 ${r.dedup} 份` : ''}，去确认入库`);
    } catch (e) {
      const code = (e as { code?: string; data?: { code?: string } })?.code
        || (e as { data?: { code?: string } })?.data?.code;
      // 深度整理是微信支付的单次凭据，PC 这边不接支付（pay 服务仍绑着小程序运行时）。
      if (code === 'SKU_REQUIRED') st.say('深度整理需先在手机小程序里购买，买完回这儿点一次就跑');
      else s.handleApiError(e, { fallbackTitle: '整理失败' });
    } finally {
      setOrganizing(false);
    }
  };

  const confirmIntoLibrary = async () => {
    if (!requireAuth('save')) return;
    if (confirmingRef.current) return;
    const all = (pipe?.optimizedItems ?? []).map((it) => it.id);
    const ids = selIds.length ? selIds.filter((id) => all.includes(id)) : all;
    if (!ids.length) { st.say('暂无可确认资料，先到待整理区整理一批'); return; }
    const noPreview = (pipe?.optimizedItems ?? [])
      .filter((it) => ids.includes(it.id) && !it.preview?.trim()).length;
    const ok = await platform.confirm({
      title: '确认写入知识库',
      content: noPreview
        ? `共 ${ids.length} 份，其中 ${noPreview} 份没有提取到可预览正文。建议先核对或重新上传，仍要继续吗？`
        : `共 ${ids.length} 份。入库后会供战局、方案和对话引用。`,
      confirmText: noPreview ? '仍然入库' : '确认，写入知识库',
    });
    if (!ok) return;
    confirmingRef.current = true;
    setConfirming(true);
    try {
      const r = await api.confirmKnowledge({ ids });
      if (!r.count) { st.say('暂无可确认资料，先到待整理区整理一批'); return; }
      setSel({});
      batchRef.current = null;
      await load();
      setStage('confirmed');
      st.say(`${r.count} 份资料已入库`);
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '入库失败' });
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  };

  const refreshForces = async () => {
    if (!requireAuth('save')) return;
    try {
      await api.refreshForces();
      st.say('已刷新战局判断');
    } catch (e) { s.handleApiError(e, { fallbackTitle: '刷新失败' }); }
  };

  const removeRow = async (r: AssetRow) => {
    if (!requireAuth('save')) return;
    const ok = await platform.confirm({
      title: '删除这份资料',
      content: `删除「${r.name}」后不可恢复，可以重新上传这一份。确定删除？`,
      confirmText: '删除',
    });
    if (!ok) return;
    try {
      await api.deleteKnowledge(r.id);
      st.closeDrawer();
      await load();
      st.say('已删除');
    } catch (e) { s.handleApiError(e, { fallbackTitle: '删除失败' }); }
  };

  const confirmOne = async (r: AssetRow) => {
    if (!requireAuth('save')) return;
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setConfirming(true);
    try {
      await api.confirmKnowledge({ ids: [r.id] });
      st.closeDrawer();
      await load();
      setStage('confirmed');
      st.say(`「${r.name}」已入库`);
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '入库失败' });
    } finally {
      confirmingRef.current = false;
      setConfirming(false);
    }
  };

  // ── 详情抽屉 / 右键菜单 ───────────────────────────────

  // 抽屉内容纯由入参拼装，不做 useCallback：它闭包着 confirmOne/removeRow，
  // 一旦缓存住就会拿着上一轮的 pipe/stage 去提交，是很难查的那类脏数据。
  const drawerOf = (r: AssetRow, preview: string, pending: boolean): DrawerData => ({
    kicker: STAGE_META[r.stage].title,
    title: r.name,
    quote: r.summary,
    blocks: [
      { label: '这份资料', title: `${r.category} · ${r.size}`, body: `状态：${r.status.t}${r.fileType ? ` · 类型 ${r.fileType}` : ''}` },
      { label: '名称来源', title: r.nameSourceShort, body: r.nameSourceFull },
      {
        label: '正文预览',
        title: preview ? '入库前先核对正文' : pending ? '正在取正文…' : '没有可预览的正文',
        body: preview || (pending ? '' : '这份资料没提取出可读正文，入库后军师也读不到内容，建议换个格式重传。'),
      },
    ],
    actions: [
      ...(r.stage === 'optimized'
        ? [{ t: '确认这一份入库', primary: true, go: () => { void confirmOne(r); } }]
        : []),
      { t: '删除这份资料', danger: true, go: () => { void removeRow(r); } },
    ],
  });

  const openRow = (r: AssetRow) => {
    drawerRef.current = r.id;
    st.setDrawer(drawerOf(r, r.preview, !r.preview));
    if (r.preview) return;
    // 待整理/知识库两段的行不带正文，点开才去拉详情——列表阶段没必要为每一行发请求。
    api.knowledgeDetail(r.id)
      .then((d) => {
        if (drawerRef.current !== r.id) return; // 用户已经点开别的了，别把旧内容盖回去
        st.setDrawer(drawerOf(r, displayKnowledgePreview(d.textPreview, d.fileType), false));
      })
      .catch(() => {
        if (drawerRef.current !== r.id) return;
        st.setDrawer(drawerOf(r, '', false));
      });
  };

  const menuOf = (r: AssetRow): CtxItem[] => [
    { t: '查看这份资料', k: 'Enter', go: () => openRow(r) },
    ...(r.stage === 'optimized' ? [{ t: '确认入库', go: () => { void confirmOne(r); } }] : []),
    { t: '删除资料', k: '⌫', danger: true, go: () => { void removeRow(r); } },
  ];

  // ── 渲染 ──────────────────────────────────────────────

  const headAction = { staging: () => void organize(false), optimized: () => void confirmIntoLibrary(), confirmed: () => void refreshForces() }[stage];
  const headLabel = confirming && stage === 'optimized'
    ? '切片并建立索引…'
    : organizing && stage === 'staging'
      ? '正在整理…'
      : stage === 'optimized' && selIds.length
        ? `确认 ${selIds.length} 份并写入知识库`
        : STAGE_META[stage].action;

  return (
    <div className="pc-page pc-asset">
      <input
        ref={fileRef}
        className="pc-asset-file"
        type="file"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = ''; // 清空才能连着选同一个文件第二次
          void doUpload(files);
        }}
      />

      <div className="pc-asset-quota">
        <button type="button" className="pc-asset-qcard" onClick={() => st.say(`本月免费整理额度：${quota.freeDocs} 份，已用 ${quota.usedDocs} 份`)}>
          <span className="pc-asset-qv">{quota.usedDocs} / {quota.freeDocs}</span>
          <span className="pc-asset-ql">免费资料额度</span>
        </button>
        <button type="button" className="pc-asset-qcard" onClick={() => st.say(`知识库已用 ${fmtBytes(quota.usedBytes)}，其余可继续上传`)}>
          <span className="pc-asset-qv">{fmtRemainingQuota(quota.usedBytes, quota.freeBytes)}</span>
          <span className="pc-asset-ql">可用空间 · 可扩容</span>
        </button>
        <button type="button" className="pc-asset-qcard" disabled={busy} onClick={() => { void organize(true); }}>
          <span className="pc-asset-qv">深度整理</span>
          <span className="pc-asset-ql">去重 / 分类 / 优化</span>
        </button>
      </div>

      <div
        className={`pc-asset-drop${dragOver ? ' pc-on' : ''}`}
        onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragOver(true); }}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragOver(false); }}
        onDrop={onDrop}
      >
        <div className="pc-asset-drop-head">
          <div className="pc-asset-drop-main">
            <div className="pc-asset-drop-k">第一步 · 接住乱资料</div>
            <div className="pc-asset-drop-t">上传资料</div>
            <div className="pc-asset-drop-d">
              先把资料放进来，我过一遍。理清楚了你点个头，我再收进知识库，判断时用上。PC 端可直接把文件夹拖到这里。
            </div>
          </div>
          <button type="button" className="pc-asset-drop-btn" disabled={busy} onClick={pickFiles}>
            {uploading ? '上传中…' : '＋ 上传'}
          </button>
        </div>

        {uploads.length > 0 && (
          <div className="pc-asset-queue">
            {uploads.map((u) => (
              <div className={`pc-asset-qrow pc-${u.state}`} key={u.uid}>
                <span className="pc-asset-qname">{u.name}</span>
                <span className="pc-asset-qbar"><span className="pc-asset-qfill" style={{ width: `${u.percent}%` }} /></span>
                <span className="pc-asset-qpct">
                  {u.state === 'fail' ? '没传上去' : u.state === 'cancel' ? '已取消' : u.state === 'done' ? '完成' : `${u.percent}%`}
                </span>
                {u.state === 'up'
                  ? <button type="button" className="pc-asset-qx" onClick={() => cancelUpload(u.uid)}>取消</button>
                  : <span className="pc-asset-qsize">{fmtBytes(u.size)}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pc-asset-tabs">
        {(['staging', 'optimized', 'confirmed'] as Stage[]).map((k) => (
          <button
            type="button"
            key={k}
            className={`pc-asset-tab${stage === k ? ' pc-on' : ''}`}
            onClick={() => { if (!confirmingRef.current) setStage(k); }}
          >
            {STAGE_META[k].tab}
            <span className="pc-asset-tab-n">{counts[k]}</span>
          </button>
        ))}
      </div>

      <div className="pc-asset-card">
        <div className="pc-asset-card-head">
          <span className="pc-asset-card-t">{STAGE_META[stage].title}</span>
          <span className="pc-asset-card-s">
            {selIds.length ? `已选 ${selIds.length} 份` : STAGE_META[stage].desc}
          </span>
          <div className="pc-asset-card-gap" />
          <button type="button" className="pc-asset-card-btn" disabled={busy} onClick={headAction}>
            {headLabel}
          </button>
        </div>

        <div className="pc-asset-scroll">
          <table className="pc-asset-table">
            <thead>
              <tr>
                <th className="pc-asset-th-ck">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    disabled={!rows.length}
                    onChange={() => setSel(allChecked ? {} : Object.fromEntries(rows.map((r) => [r.id, true])))}
                  />
                </th>
                <th>资料</th>
                <th className="pc-asset-th-cat">归类</th>
                <th className="pc-asset-th-src">名称来源</th>
                <th className="pc-asset-th-size">大小</th>
                <th className="pc-asset-th-st">状态</th>
              </tr>
            </thead>
            <tbody>
              {loading && !loaded ? (
                [0, 1, 2, 3].map((i) => (
                  <tr className="pc-asset-skel" key={i}>
                    <td colSpan={6}><span className="pc-asset-skel-l" /></td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td className="pc-asset-blank" colSpan={6}>
                    {!authed
                      ? '登录后才看得到自己的案卷。资料只存在你自己的账号里。'
                      : failed
                        ? '资料没拉到，网络或服务端出了点问题。'
                        : stage === 'staging'
                          ? '还没放资料进来。聊天记录、表格、文档、图片——散在各处的材料，拖进上面那块就行。'
                          : stage === 'optimized'
                            ? '还没有已优化的资料。先在待整理区上传并整理，结果会到这里等你确认。'
                            : '知识库还空着。资料理好、确认入库后，我做判断和出方案就能直接用上。'}
                    {failed && authed && (
                      <button type="button" className="pc-asset-retry" onClick={() => { void load(); }}>重试</button>
                    )}
                  </td>
                </tr>
              ) : rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => openRow(r)}
                  onContextMenu={(e) => st.openCtx(e, r.name, menuOf(r))}
                >
                  <td className="pc-asset-td-ck">
                    <input
                      type="checkbox"
                      checked={!!sel[r.id]}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => setSel((m) => ({ ...m, [r.id]: !m[r.id] }))}
                    />
                  </td>
                  <td>
                    <div className="pc-asset-name">{r.name}</div>
                    <div className="pc-asset-sum">{r.summary}</div>
                  </td>
                  <td><span className="pc-asset-pill">{r.category}</span></td>
                  <td className="pc-asset-src">{r.nameSourceShort}</td>
                  <td className="pc-asset-size">{r.size}</td>
                  <td><span className={`pc-asset-st pc-${r.status.tone}`}>{r.status.t}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="pc-asset-folders-head">
        <span className="pc-asset-folders-t">知识库目录</span>
        <span className="pc-asset-folders-s">这些资料我都读过了，做判断时会用上</span>
      </div>
      {folders.length ? (
        <div className="pc-asset-folders">
          {folders.map((f) => (
            <button
              type="button"
              key={f.key}
              className="pc-asset-folder"
              // 服务端没有「按目录取资料」的接口，点进来只能把整段知识库摊开；
              // 与其做个假筛选，不如切到知识库段并说清这一类有几份。
              onClick={() => { setStage('confirmed'); st.say(`「${f.label}」共 ${f.count} 份，已在知识库里`); }}
            >
              <span className="pc-asset-folder-ic">{f.label.slice(0, 1)}</span>
              <span className="pc-asset-folder-t">{f.label}</span>
              <span className="pc-asset-folder-n">{f.count} 份 ›</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="pc-asset-folders-empty">
          还没有入库的资料。确认入库后，军师会按老板档案、财务经营、内容 IP 这些口径自动归目录。
        </div>
      )}
    </div>
  );
}
