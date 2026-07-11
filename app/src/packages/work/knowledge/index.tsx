import { useState, useCallback } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api, type KnowledgeDocRow } from '../../../services/api';
import { checkUpload } from '../../../services/uploadGuard';
import './index.scss';

const STATUS: Record<string, string> = { ready: '就绪', parsing: '解析中', embedding: '嵌入中', failed: '失败', pending: '排队' };
const isWeapp = process.env.TARO_ENV === 'weapp';
const SUPPORTED_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'md', 'markdown', 'txt'];

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

  const load = useCallback(() => {
    api.knowledgeDocs().then(setItems).catch((e) => { s.handleApiError(e); setItems([]); });
  }, [s]);
  useDidShow(() => { load(); });

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
      await api.uploadKnowledge(f.path);
      Taro.showToast({ title: '已上传，解析中…', icon: 'none' });
      load();
      setTimeout(load, 1500); // 解析+嵌入异步，稍后再刷一次拿到 ready
    } catch (e) {
      Taro.showToast({ title: (e as Error).message || '上传失败', icon: 'none' });
    }
    setBusy(false);
  };

  const openDetail = (it: KnowledgeDocRow) => {
    Taro.navigateTo({ url: `/packages/work/knowledge/detail/index?id=${it.id}` });
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

        {items.length === 0 ? (
          <View className="kb-empty">
            <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={22} color={accent} /></View>
            <Text className="et">资料库还是空的</Text>
            <Text className="es">上传你的业务资料（产品介绍、行业报告、FAQ…），军师在咨询时会自动参考。微信里需先把文件发到「文件传输助手」，再回来选取。</Text>
          </View>
        ) : (
          <View className="kb-list">
            {items.map((it) => (
              <View key={it.id} className="kb-item card" onClick={() => openDetail(it)}>
                <View className="ki-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={18} color={accent} /></View>
                <View className="ki-b">
                  <Text className="ki-t">{it.title || it.fileName || '未命名'}</Text>
                  <Text className="ki-m">{STATUS[it.status] || it.status} · {it.chunkCount} 切片{it.fileSize ? ' · ' + fmtSize(it.fileSize) : ''}{it.error ? ' · ' + it.error : ''}</Text>
                </View>
                <View className="ki-del" onClick={(e) => { e.stopPropagation(); remove(it); }}><Text>删除</Text></View>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}
