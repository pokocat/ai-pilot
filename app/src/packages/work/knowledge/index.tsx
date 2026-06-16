import { useState, useCallback } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api, type KnowledgeDocRow } from '../../../services/api';
import './index.scss';

const STATUS: Record<string, string> = { ready: '就绪', parsing: '解析中', embedding: '嵌入中', failed: '失败', pending: '排队' };
const isWeapp = process.env.TARO_ENV === 'weapp';

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
    let chosen: Taro.chooseMessageFile.SuccessCallbackResult;
    try {
      chosen = await Taro.chooseMessageFile({ count: 1, type: 'file' });
    } catch { return; } // 用户取消选择
    const f = chosen.tempFiles?.[0];
    if (!f) return;
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
            <Text className="kb-up-s">PDF / Word / Excel / Markdown / 文本，军师会读它来给建议</Text>
          </View>
        </View>

        {items.length === 0 ? (
          <View className="kb-empty">
            <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={22} color={accent} /></View>
            <Text className="et">资料库还是空的</Text>
            <Text className="es">上传你的业务资料（产品介绍、行业报告、FAQ…），军师在咨询时会自动参考。</Text>
          </View>
        ) : (
          <View className="kb-list">
            {items.map((it) => (
              <View key={it.id} className="kb-item card">
                <View className="ki-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={18} color={accent} /></View>
                <View className="ki-b">
                  <Text className="ki-t">{it.title || it.fileName || '未命名'}</Text>
                  <Text className="ki-m">{STATUS[it.status] || it.status} · {it.chunkCount} 切片{it.fileSize ? ' · ' + fmtSize(it.fileSize) : ''}{it.error ? ' · ' + it.error : ''}</Text>
                </View>
                <View className="ki-del" onClick={() => remove(it)}><Text>删除</Text></View>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}
