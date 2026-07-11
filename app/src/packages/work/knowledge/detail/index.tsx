import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import Icon from '../../../../components/Icon';
import SafeHeader from '../../../../components/SafeHeader';
import PaySheet from '../../../../components/PaySheet';
import { useStore } from '../../../../hooks/useStore';
import { api, type KnowledgeDetail } from '../../../../services/api';
import './index.scss';

const STATUS: Record<string, string> = { ready: '就绪', parsing: '解析中', embedding: '嵌入中', failed: '失败', pending: '排队' };

function fmtSize(b: number | null): string {
  if (!b) return '';
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}

// WO-09 资料详情：展示解析状态/正文预览；财务经营表（canAnalyze）显示「生成经营体检」入口，
// 点按 → 军师过账 → 跳报告详情页。错误逐码友好化（未开通/次数用完/非财务表/额度套餐）。
export default function KnowledgeDetailPage() {
  const router = useRouter();
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const id = (router.params as Record<string, string>).id || '';
  const [detail, setDetail] = useState<KnowledgeDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [payOpen, setPayOpen] = useState(false);

  useEffect(() => {
    if (!id) { setFailed(true); return; }
    setFailed(false);
    api.knowledgeDetail(id)
      .then(setDetail)
      .catch((e) => { s.handleApiError(e); setDetail(null); setFailed(true); });
  }, [id]);

  const analyze = () => {
    if (busy || !detail) return;
    setBusy(true);
    api.analyzeKnowledge(detail.id)
      .then((r) => {
        Taro.navigateTo({ url: `/packages/work/report/index?id=${r.reportId}` });
      })
      .catch((e: unknown) => {
        const code = String((e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code || '');
        // SKU_REQUIRED → 引导开通（对齐现有 SKU 购买动线：PaySheet mode=sku）。
        if (code === 'SKU_REQUIRED') { setPayOpen(true); return; }
        // 日限 3 次。
        if (code === 'RATE_LIMITED') { Taro.showToast({ title: '今天的体检次数用完了，明天再来', icon: 'none' }); return; }
        // 非财务/经营表。
        if (code === 'NOT_ANALYZABLE') { Taro.showToast({ title: '这份资料看着不像财务表，换一份试试', icon: 'none' }); return; }
        // 额度/套餐等沿用全局既有处理（过期/额度不足/网络/登录失效）。
        s.handleApiError(e, { fallbackTitle: '经营体检暂时没跑成功，请稍后再试' });
      })
      .finally(() => setBusy(false));
  };

  if (!detail) {
    return (
      <View className={`page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
        <SafeHeader title="资料详情" onBack={() => Taro.navigateBack()} />
        <View className="kd-loading"><Text>{failed ? '资料加载失败，请返回重试' : '加载中…'}</Text></View>
      </View>
    );
  }

  return (
    <View className={`page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="资料详情" onBack={() => Taro.navigateBack()} />
      <View className="pad" style={{ paddingTop: '12px' }}>
        <View className="kd-head card">
          <View className="kd-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={20} color={accent} /></View>
          <View className="kd-hb">
            <Text className="kd-t">{detail.title || detail.fileName || '未命名'}</Text>
            <Text className="kd-m">{STATUS[detail.status] || detail.status} · {detail.chunks.length} 切片{detail.fileType ? ' · ' + detail.fileType.toUpperCase() : ''}{detail.fileSize ? ' · ' + fmtSize(detail.fileSize) : ''}{detail.error ? ' · ' + detail.error : ''}</Text>
          </View>
        </View>

        {detail.canAnalyze ? (
          <View className={`kd-analyze card ${busy ? 'busy' : ''}`} onClick={analyze}>
            <View className="kd-an-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="chart" size={20} color={accent} /></View>
            <View className="kd-an-b">
              <Text className="kd-an-t">{busy ? '军师正在过账…' : '生成经营体检'}</Text>
              <Text className="kd-an-s">让军师过一遍账，读出隐患，开三条军令</Text>
            </View>
            <View className="kd-an-go" style={{ background: accent }}><Text>{busy ? '…' : '›'}</Text></View>
          </View>
        ) : null}

        {detail.textPreview ? (
          <>
            <Text className="kd-sec-title">正文预览</Text>
            <View className="kd-preview card">
              <Text className="kd-preview-t">{detail.textPreview}</Text>
            </View>
          </>
        ) : null}
      </View>

      {/* SKU_REQUIRED：未开通经营体检 → 走微信支付开通（fin-checkup，购买后可反复用） */}
      <PaySheet
        open={payOpen}
        mode="sku"
        skuKey="fin-checkup"
        title="开通经营体检"
        desc="开通后可反复让军师过账，逐月体检经营数字。"
        costLabel="单 次 开 通"
        costValue="经营体检权益"
        balanceValue="—"
        afterValue="开通后可反复使用"
        confirmText="开通经营体检"
        onClose={() => setPayOpen(false)}
      />
    </View>
  );
}
