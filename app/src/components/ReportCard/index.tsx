import { useEffect, useRef, useState } from 'react';
import { View, Text, Canvas } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../Icon';
import MarkdownText from '../MarkdownText';
import { useStore } from '../../hooks/useStore';
import type { Deliverable, Section } from '../../services/api';
import { makeReportShareImage, shareReportImageToFriend, saveReportImageToAlbum } from '../../services/reportShareCard';
import './index.scss';

// 报告 V2 最小防线：把 9 种类型 section 降级成卡片可渲染的 {h,b?,list?}，保证不破版/不 crash。
// 用 any 读取以容忍存量脏数据/未来类型（未知 type 走 default 白卡）。
function cardSection(sec: Section): { h: string; b?: string; list?: string[] } {
  const s = sec as any;
  const cell = (c: string | { text: string; trend?: 'up' | 'dn' }) => (typeof c === 'string' ? c : c?.text ?? '');
  switch (s.type) {
    case 'hero': return { h: s.h, b: (s.paras ?? []).join('\n\n') };
    case 'callout': return { h: `【${s.tone}】${s.h}`, b: s.b };
    case 'stats': return { h: s.h || '关键数据', list: (s.items ?? []).map((it: any) => `${it.num}${it.unit ?? ''} · ${it.label}`) };
    case 'roster': return { h: s.h || '人物', b: s.intro, list: (s.people ?? []).map((p: any) => `${p.name}${p.role ? `（${p.role}）` : ''}：${p.desc}`) };
    case 'table': return { h: s.h || '对比', list: [(s.headers ?? []).join(' / '), ...(s.rows ?? []).map((r: any[]) => r.map(cell).join(' / '))] };
    case 'phases': return { h: s.h || '分步打法', list: (s.items ?? []).flatMap((it: any) => [`〔${it.tab}〕${it.h}${it.when ? ` · ${it.when}` : ''}`, ...(it.actions ?? []).map((a: string) => `· ${a}`), ...(it.kpi ? [`军令状：${it.kpi}`] : [])]) };
    case 'timeline': return { h: s.h || '时间节奏', list: (s.items ?? []).map((it: any) => `${it.when}　${it.h}${it.d ? `：${it.d}` : ''}`) };
    case 'quote': return { h: '金句', b: `「${s.text}」` };
    case 'letter': return { h: '军师手书', b: [s.salute, ...(s.paras ?? []), s.close, s.sign].filter(Boolean).join('\n\n') };
    case 'gauge': return { h: `评分 ${s.score ?? 0}/100${s.verdict ? ` ${s.verdict}` : ''}`, list: (s.items ?? []).map((it: any) => `${it.label} ${it.score}分${it.note ? ` ${it.note}` : ''}`) };
    case 'matrix': return { h: s.h || '四象限', list: (s.quads ?? []).filter((q: any) => q && (q.title || (q.items && q.items.length))).map((q: any) => `${q.title || ''}${q.tone ? `（${q.tone}）` : ''}：${(q.items ?? []).join('、')}`) };
    case 'gantt': return { h: s.h || '排期', list: (s.rows ?? []).map((r: any) => `${r.label}　第${r.from}-${r.to}${s.unit ?? '周'}${r.note ? ` · ${r.note}` : ''}`) };
    default: return { h: s.h || '', b: s.b, list: Array.isArray(s.list) ? s.list : undefined };
  }
}

const IS_WEAPP = process.env.TARO_ENV === 'weapp';
// 首次成果引导条一次性标记：展示过即写，此后任何成果卡都不再出现。
const GUIDE_KEY = 'report_guide_shown';
const GUIDE_TEXT = '军师首呈方略，已自动收入方案库存档。欲览全篇，点「查看报告」；欲外传，点「分享」发图或装订成 PDF 带走。';
let shareSeq = 0;

interface Props {
  data: Deliverable;
  animate?: boolean; // 渐进式呈现（新产出）vs 直接展示（历史还原）
  streaming?: boolean; // 服务端 SSE 仍在产出中：展示当前已到达分段，暂不开放操作
  saved?: boolean;
  onSave?: () => void;
  // 主操作：查看网页版报告全文（复活死代码 shareReport → 生成网页版并打开）。
  onView?: () => void;
  // 「分享」选单里由父级承接的三项：PDF 发好友 / 查看保存 PDF / 复制全文（图片两项在组件内自持出图）。
  onShareMenu?: (kind: 'pdfFriend' | 'pdfView' | 'copy') => void;
}

// 结构化成果卡 —— 对齐原型 renderReport：骨架 → 分段渐显 → 可信赖页脚 + 操作。
export default function ReportCard({ data, animate = false, streaming = false, saved = false, onSave, onView, onShareMenu }: Props) {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  // D-3-4：每张卡一块隐藏 canvas，用于分享图出图（唯一 id 防列表内串扰）。
  const shareCanvasId = useRef(`rcshare-${(shareSeq += 1)}`).current;

  // 分享图 = 品牌分享图（标题+核心结论+落款，无全文/敏感数字）。出图后按已选动作直接发好友 / 存相册。
  const makeShareImage = async (): Promise<string | null> => {
    Taro.showLoading({ title: '生成分享图…' });
    try {
      const path = await makeReportShareImage(shareCanvasId, data);
      Taro.hideLoading();
      return path;
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成分享图失败，请重试', icon: 'none' });
      return null;
    }
  };

  // 「分享」→ 动作选单。weapp：图片(发好友/存相册) + PDF(发好友/查看保存) + 复制全文；
  // H5：图片/发文件不可用，选单收敛为「下载 PDF（开新窗）」+「复制全文」。
  const openShareMenu = async () => {
    if (IS_WEAPP) {
      try {
        const { tapIndex } = await Taro.showActionSheet({
          itemList: ['发送图片给好友', '保存图片到相册', 'PDF 发给好友', '查看 / 保存 PDF', '复制全文'],
        });
        if (tapIndex === 0) { const p = await makeShareImage(); if (p) shareReportImageToFriend(p); return; }
        if (tapIndex === 1) { const p = await makeShareImage(); if (p) saveReportImageToAlbum(p); return; }
        if (tapIndex === 2) { onShareMenu?.('pdfFriend'); return; }
        if (tapIndex === 3) { onShareMenu?.('pdfView'); return; }
        if (tapIndex === 4) { onShareMenu?.('copy'); return; }
      } catch { /* 用户取消 */ }
    } else {
      try {
        const { tapIndex } = await Taro.showActionSheet({ itemList: ['下载 PDF', '复制全文'] });
        if (tapIndex === 0) { onShareMenu?.('pdfView'); return; }
        if (tapIndex === 1) { onShareMenu?.('copy'); return; }
      } catch { /* 用户取消 */ }
    }
  };
  const [revealed, setRevealed] = useState(animate ? 0 : data.sections.length);
  const [done, setDone] = useState(!animate);
  const [isSaved, setIsSaved] = useState(saved);
  // 自动存入成功后父级会把消息 saved 置真 → 卡片 saved 态随之点亮（本地 setIsSaved 只 flip 不回退）。
  useEffect(() => { if (saved) setIsSaved(true); }, [saved]);
  const shown = streaming ? data.sections.length : revealed;
  const isDone = !streaming && done;

  // 首次成果引导条（一次性）：挂载时读标记，未展示过才亮；展示或手动 × 关掉都写标记，此后不再出现。
  const [showGuide, setShowGuide] = useState(false);
  useEffect(() => {
    try { if (!Taro.getStorageSync(GUIDE_KEY)) setShowGuide(true); } catch { /* noop */ }
  }, []);
  useEffect(() => {
    // 真正呈现（完成态且未关）时落标记——不在 render 里写副作用。
    if (isDone && showGuide) { try { Taro.setStorageSync(GUIDE_KEY, 1); } catch { /* noop */ } }
  }, [isDone, showGuide]);
  const dismissGuide = () => {
    setShowGuide(false);
    try { Taro.setStorageSync(GUIDE_KEY, 1); } catch { /* noop */ }
  };

  // B9：逐段渐显仅用于「历史/一次性成果」（animate=true，非流式）。流式路径 animate=false、shown 直接取全部，
  // 不会走这里。此处大幅缩短首延与逐段间隔（900/640ms → 200/160ms），保留轻微错落，避免长报告等待过久。
  useEffect(() => {
    if (!animate) return;
    let i = 0;
    const timers: any[] = [];
    const tick = () => {
      i += 1;
      setRevealed(i);
      if (i < data.sections.length) {
        timers.push(setTimeout(tick, 160));
      } else {
        timers.push(setTimeout(() => setDone(true), 160));
      }
    };
    timers.push(setTimeout(tick, 200));
    return () => timers.forEach(clearTimeout);
  }, [animate, data.sections.length]);

  return (
    <View className="report">
      <View className="rh">
        <View className="ic-wrap" style={{ background: 'var(--accent-soft)' }}>
          <Icon name={data.icon} size={18} color={accent} />
        </View>
        <View className="tt">
          <Text className="t">{data.title}</Text>
          <Text className="m">{data.meta}</Text>
        </View>
        {isDone ? (
          <Text className="status">已生成</Text>
        ) : (
          <View className="gen">
            <View className="spin" style={{ borderTopColor: accent }} />
            <Text>产出中</Text>
          </View>
        )}
      </View>

      <View className="rb">
        {shown === 0 && (
          <View className="skeleton">
            <View className="skl h" />
            <View className="skl w90" />
            <View className="skl w70" />
            <View className="skl w50" />
          </View>
        )}
        {data.sections.slice(0, shown).map((sec, i) => {
          const v = cardSection(sec);
          return (
            <View key={i} className="rsec reveal">
              <View className="sh">
                <Text className="no" style={{ background: accent }}>{i + 1}</Text>
                <Text className="sh-t">{v.h}</Text>
              </View>
              {v.b && <MarkdownText text={v.b} className="sb" />}
              {v.list && (
                <View className="slist">
                  {v.list.map((x, j) => (
                    <View key={j} className="sli">
                      <View className="dot" style={{ background: accent }} />
                      <MarkdownText text={x} className="sli-t" />
                    </View>
                  ))}
                </View>
              )}
            </View>
          );
        })}
      </View>

      {isDone && (
        <>
          {showGuide && (
            <View className="rc-guide">
              <Text className="rc-guide-t">{GUIDE_TEXT}</Text>
              <Text className="rc-guide-x" onClick={dismissGuide}>×</Text>
            </View>
          )}
          <View className="foot">
            {/* B9：Icon 颜色烘焙进 SVG，不能用 var()；此处取与 --ink-3(#7E848B) 等值的 hex。 */}
            <Icon name="shield" size={13} color="#7E848B" />
            <Text className="foot-t">{data.trust}</Text>
          </View>
          <View className="acts">
            {/* 主操作：查看网页版报告全文；primary Icon 烘焙进 SVG，用白色。 */}
            <View className="act primary" style={{ background: accent }} onClick={() => onView?.()}>
              <Icon name="doc" size={14} color="#fff" />
              <Text>查看报告</Text>
            </View>
            {/* 分享 = 图片/PDF/复制全文选单；ghost Icon 取与 --ink-2(#565C63) 等值的 hex。 */}
            <View className="act ghost" onClick={openShareMenu}>
              <Icon name="up" size={14} color="#565C63" />
              <Text>分享</Text>
            </View>
            {/* 存入方案库已弱化为兜底：已存入 → 轻量状态签（非按钮）；未存入（自动存入失败/历史旧卡）→ 小号 ghost 按钮。 */}
            {isSaved ? (
              <View className="act-saved">
                <Icon name="check" size={12} color={accent} />
                <Text>已入库</Text>
              </View>
            ) : (
              <View className="act ghost sm" onClick={() => { setIsSaved(true); onSave?.(); }}>
                <Icon name="layers" size={13} color="#565C63" />
                <Text>存入</Text>
              </View>
            )}
          </View>
          {/* D-3-4 隐藏出图画布（屏外，仅点分享图时绘制导出） */}
          <Canvas type="2d" id={shareCanvasId} className="rc-share-canvas" style={{ width: '600px', height: '900px' }} />
        </>
      )}
    </View>
  );
}
