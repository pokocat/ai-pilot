import { useState, useCallback, useEffect, useRef } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, usePullDownRefresh } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import AsyncState from '../../../components/AsyncState';
import { useStore } from '../../../hooks/useStore';
import { navTo } from '../../../services/nav';
import { api, type KnowledgeDocRow } from '../../../services/api';
import { checkUpload } from '../../../services/uploadGuard';
import './index.scss';

const STATUS: Record<string, string> = { ready: '就绪', parsing: '解析中', embedding: '嵌入中', failed: '失败', pending: '排队' };
// 阶段标注：staging 待整理（灰）/ optimized 已优化；confirmed 不标（已可调用）。
const STAGE_BADGE: Record<string, { label: string; cls: string }> = {
  staging: { label: '待整理', cls: 'kb-st-staging' },
  optimized: { label: '已优化', cls: 'kb-st-optimized' },
};
const isWeapp = process.env.TARO_ENV === 'weapp';
const SUPPORTED_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'md', 'markdown', 'txt'];
// 解析中项退避轮询节奏（2s → 4s → 8s → …），累计约 30s 后停止并提示下拉刷新。
const POLL_DELAYS = [2000, 4000, 8000, 8000, 8000];
const isSettled = (st: string) => st === 'ready' || st === 'failed';

function fmtSize(b: number | null): string {
  if (!b) return '';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

// 我的资料库：上传业务资料（PDF/Word/Excel/MD/TXT），军师咨询时自动参考；展示解析状态。
export default function Knowledge() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [items, setItems] = useState<KnowledgeDocRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false); // D2：首屏加载与空态区分，避免拉取期间闪空态
  const [pollHint, setPollHint] = useState(false); // 轮询到上限仍有未就绪项 → 提示下拉刷新
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAttempt = useRef(0);

  const clearPoll = useCallback(() => { if (pollTimer.current) { clearTimeout(pollTimer.current); pollTimer.current = null; } }, []);

  // 拉列表；poll=true 时对未就绪项按退避节奏（2s→4s→8s）再拉，累计约 30s 到上限停并提示下拉刷新。
  const load = useCallback((poll = false) => {
    api.knowledgeDocs().then((rows) => {
      setItems(rows);
      setLoaded(true);
      if (!poll) return;
      clearPoll();
      const pending = rows.some((r) => !isSettled(r.status));
      if (!pending) { pollAttempt.current = 0; setPollHint(false); return; }
      if (pollAttempt.current >= POLL_DELAYS.length) { setPollHint(true); return; }
      const d = POLL_DELAYS[pollAttempt.current];
      pollAttempt.current += 1;
      pollTimer.current = setTimeout(() => { load(true); }, d);
    }).catch((e) => { s.handleApiError(e); setItems([]); setLoaded(true); });
  }, [s, clearPoll]);

  useDidShow(() => { pollAttempt.current = 0; setPollHint(false); load(true); });
  useDidHide(() => { clearPoll(); });
  useEffect(() => () => clearPoll(), [clearPoll]);
  usePullDownRefresh(() => { pollAttempt.current = 0; setPollHint(false); load(true); Taro.stopPullDownRefresh(); });

  const upload = async () => {
    if (busy) return;
    if (!isWeapp) { Taro.showToast({ title: '请在微信小程序内上传文件', icon: 'none' }); return; }
    // 微信限制：小程序只能从「聊天里的文件」选取，不能浏览手机本地文件。先把预期讲清楚，
    // 否则弹出的「选会话」界面会被当成「转发给好友」。
    const guide = await Taro.showModal({
      title: '从微信聊天选择文件',
      content: '微信只允许小程序选取「聊天里的文件」。请先把资料发给「文件传输助手」（电脑端微信也能发），下一步选它即可。这不是转发，是选文件。',
      confirmText: '去选择',
      cancelText: '取消',
    });
    if (!guide.confirm) return;
    let chosen: Taro.chooseMessageFile.SuccessCallbackResult;
    try {
      chosen = await Taro.chooseMessageFile({ count: 1, type: 'file', extension: SUPPORTED_EXT });
    } catch (e) {
      const msg = String((e as { errMsg?: string })?.errMsg || '');
      if (!/cancel/i.test(msg)) Taro.showToast({ title: '没能打开文件选择，请重试', icon: 'none' });
      return; // 用户取消则静默
    }
    const f = chosen.tempFiles?.[0];
    if (!f) return;
    const ext = (f.name?.split('.').pop() || '').toLowerCase();
    if (!SUPPORTED_EXT.includes(ext)) {
      Taro.showToast({ title: `不支持的格式 .${ext}（支持 PDF/Word/Excel/MD/TXT）`, icon: 'none' });
      return;
    }
    // 上传前置校验体积上限（与 server multipart 20MB 限制对齐），避免放行后被服务端 413 拒绝、
    // 只留一句无信息量的「上传失败」（thinktank 页已有此校验，本页此前遗漏，见 uploadGuard.ts）。
    const chk = checkUpload({ name: f.name, size: f.size });
    if (!chk.ok) {
      Taro.showToast({ title: chk.desc || '文件不符合上传要求', icon: 'none' });
      return;
    }
    setBusy(true);
    try {
      const res = await api.uploadKnowledge(f.path);
      Taro.showToast({ title: '已上传，解析中…', icon: 'none' });
      // 立即插入列表（乐观），不必等解析；随后轮询拿到就绪态。
      const nowIso = new Date().toISOString();
      const optimistic: KnowledgeDocRow = {
        id: res.id, kind: 'document', title: f.name, sourceType: 'upload',
        status: res.status || 'parsing', stage: (res.stage as string) || 'confirmed',
        fileName: f.name, fileType: ext, fileSize: f.size, chunkCount: 0,
        projectId: null, error: null, createdAt: nowIso, updatedAt: nowIso,
      };
      setItems((prev) => (prev.some((it) => it.id === res.id) ? prev : [optimistic, ...prev]));
      pollAttempt.current = 0; setPollHint(false);
      load(true);
      setTimeout(() => load(true), 1500); // 兜底：解析+嵌入异步，稍后再刷一次
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || '上传失败', icon: 'none' });
    }
    setBusy(false);
  };

  const openDetail = (it: KnowledgeDocRow) => {
    navTo(`/packages/work/knowledge/detail/index?id=${it.id}`);
  };

  const remove = (it: KnowledgeDocRow) => {
    Taro.showModal({
      title: '删除资料',
      content: `删除「${it.title || it.fileName || '该资料'}」？军师将不再参考它。`,
      success: (r) => {
        if (!r.confirm) return;
        api.deleteKnowledge(it.id).then(() => { Taro.showToast({ title: '已删除', icon: 'none' }); load(); }).catch((e) => s.handleApiError(e));
      },
    });
  };

  return (
    <View className={`page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="我的资料库" onBack={() => Taro.navigateBack()} />
      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="kb-up card" onClick={upload}>
          <View className="kb-up-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="upload" size={20} color={accent} /></View>
          <View className="kb-up-b">
            <Text className="kb-up-t">{busy ? '上传中…' : '上传资料'}</Text>
            <Text className="kb-up-s">先发到微信聊天（如文件传输助手）再选 · PDF/Word/Excel/MD/TXT</Text>
          </View>
        </View>

        {!loaded && items.length === 0 ? (
          <AsyncState loading skeletonRows={3} />
        ) : items.length === 0 ? (
          <View className="kb-empty">
            <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={22} color={accent} /></View>
            <Text className="et">资料库还是空的</Text>
            <Text className="es">上传你的业务资料（产品介绍、行业报告、FAQ…），军师在咨询时会自动参考。微信里需先把文件发到「文件传输助手」，再回来选取。</Text>
          </View>
        ) : (
          <View className="kb-list">
            {pollHint ? (
              <View className="kb-poll-hint"><Text>有资料还在解析中，下拉可刷新查看最新状态</Text></View>
            ) : null}
            {items.map((it) => {
              const badge = STAGE_BADGE[it.stage];
              const staging = it.stage === 'staging';
              return (
                <View key={it.id} className="kb-item card" onClick={() => openDetail(it)}>
                  <View className="ki-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={18} color={accent} /></View>
                  <View className="ki-b">
                    <View className="ki-tr">
                      <Text className="ki-t">{it.title || it.fileName || '未命名'}</Text>
                      {badge ? <Text className={`ki-stage ${badge.cls}`}>{badge.label}</Text> : null}
                    </View>
                    <Text className="ki-m">
                      {staging
                        ? '整理确认后才可被军师调用'
                        : `${STATUS[it.status] || it.status} · ${it.chunkCount} 切片${it.fileSize ? ' · ' + fmtSize(it.fileSize) : ''}${it.error ? ' · ' + it.error : ''}`}
                    </Text>
                  </View>
                  <View className="ki-del" onClick={(e) => { e.stopPropagation(); remove(it); }}><Text>删除</Text></View>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </View>
  );
}
