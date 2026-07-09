import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import MarkdownText from '../../../components/MarkdownText';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { api, type ReportDetail, type ReportVersionContent, type ReportDiff } from '../../../services/api';
import './index.scss';

function fmt(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 版本化报告：版本时间线 + 查看某一版内容 + 与上一版的 section 级差异。
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

  useEffect(() => {
    if (!id) { setFailed(true); return; }
    setFailed(false);
    api.report(id).then((d) => {
      setDetail(d);
      setSel(d.currentVersion);
    }).catch((e) => { s.handleApiError(e); setDetail(null); setFailed(true); });
  }, [id]);

  useEffect(() => {
    if (!id || !sel) return;
    if (mode === 'content') {
      api.reportVersion(id, sel).then(setContent).catch((e) => { s.handleApiError(e); setContent(null); });
    } else {
      api.reportDiff(id, Math.max(1, sel - 1), sel).then(setDiff).catch((e) => { s.handleApiError(e); setDiff(null); });
    }
  }, [id, sel, mode]);

  if (!detail) {
    return (
      <View className={`page report-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
        <SafeHeader title="方案" onBack={() => Taro.navigateBack()} titleClassName="rp-title" />
        <View className="rp-loading">
          <Text>{failed ? '方案加载失败，请返回重试' : '加载中…'}</Text>
        </View>
      </View>
    );
  }

  return (
    <View className={`page report-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title={detail.title} onBack={() => Taro.navigateBack()} titleClassName="rp-title" />

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

        {mode === 'content' && content && (
          <View className="rp-card card">
            <View className="rp-card-h"><Icon name={(content.content as any).icon || 'doc'} size={18} color={accent} /><View><Text className="rp-card-t">{content.title}</Text><Text className="rp-card-m">{content.content.meta} · v{content.version}</Text></View></View>
            {content.content.sections.map((sec, i) => (
              <View key={i} className="rp-sec">
                <Text className="rp-sh"><Text className="rp-no" style={{ background: accent }}>{i + 1}</Text>{sec.h}</Text>
                {sec.b ? <MarkdownText text={sec.b} className="rp-sb" /> : null}
                {sec.list ? sec.list.map((x, j) => <View key={j} className="rp-li"><View className="dot" style={{ background: accent }} /><MarkdownText text={x} className="rp-li-t" /></View>) : null}
              </View>
            ))}
          </View>
        )}

        {mode === 'diff' && (
          sel <= 1 ? (
            <View className="rp-card card"><Text className="rp-nodiff">这是第一个版本，没有可对比的上一版。</Text></View>
          ) : diff ? (
            <View className="rp-card card">
              <Text className="rp-diff-sum" style={{ color: accent }}>v{diff.from} → v{diff.to}：{diff.summary}</Text>
              {diff.sections.map((sd, i) => (
                <View key={i} className={`rp-dsec ${sd.change}`}>
                  <View className="rp-dh"><Text className={`rp-badge ${sd.change}`}>{badge(sd.change)}</Text><Text className="rp-dh-t">{sd.h}</Text></View>
                  {sd.change === 'changed' ? (
                    sd.words && sd.words.length ? (
                      <View className="rp-words">
                        {sd.words.map((w, k) => (
                          <Text key={k} className={`rp-w ${w.t}`} style={w.t === 'add' ? { background: 'var(--accent-soft)', color: 'var(--accent-ink)' } : {}}>{w.s}</Text>
                        ))}
                      </View>
                    ) : (
                      <View className="rp-dchg">
                        <View className="rp-dbefore"><Text className="rp-dlabel">改前</Text><Text className="rp-dtext">{secText(sd.before)}</Text></View>
                        <View className="rp-dafter"><Text className="rp-dlabel" style={{ color: accent }}>改后</Text><Text className="rp-dtext">{secText(sd.after)}</Text></View>
                      </View>
                    )
                  ) : sd.change === 'unchanged' ? (
                    <Text className="rp-dtext dim">{secText(sd.after)}</Text>
                  ) : (
                    <Text className="rp-dtext">{secText(sd.after || sd.before)}</Text>
                  )}
                </View>
              ))}
            </View>
          ) : <View className="rp-loading"><Text>计算差异中…</Text></View>
        )}
      </View>
      <View style={{ height: '24px' }} />
    </View>
  );
}

function badge(change: string): string {
  return ({ added: '＋ 新增', removed: '－ 删除', changed: '~ 修改', unchanged: '未变' } as Record<string, string>)[change] || '';
}
function secText(sec?: { b?: string; list?: string[] }): string {
  if (!sec) return '';
  return [sec.b, ...(sec.list ?? [])].filter(Boolean).join('；');
}
