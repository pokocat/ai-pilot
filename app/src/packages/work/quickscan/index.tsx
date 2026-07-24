// 3 问速诊（WO-06）：行业 + 阶段/营收段 + 最痛的一件事 → 初诊卡（主要矛盾 / 军师判断 / 今天做的一件事）。
// 选项复用 /survey（industry + stage）；提交走 api.quickScan（服务端 structured()，mock 有确定性模板）。
// 结果卡可 useShareAppMessage 分享；CTA 用结果导向文案进入参谋室继续完善判断，不向用户暴露固定轮次。替代「送你一卦」承担获客。
import { useEffect, useState } from 'react';
import { View, Text, Textarea, ScrollView, Button } from '@tarojs/components';
import Taro, { useShareAppMessage } from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { navTo } from '../../../services/nav';
import { api, type SurveyQ, type QuickScanResult } from '../../../services/api';
import './index.scss';

export default function QuickScanPage() {
  const s = useStore();
  const [survey, setSurvey] = useState<SurveyQ[]>([]);
  const [industry, setIndustry] = useState('');
  const [revenueBand, setRevenueBand] = useState('');
  const [pain, setPain] = useState('');
  const [result, setResult] = useState<QuickScanResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefilled, setPrefilled] = useState(false); // 行业/阶段已由注册建档收过 → 折叠，不重复问
  const [editBasics, setEditBasics] = useState(false);

  useEffect(() => {
    api.survey().then(setSurvey).catch(() => {});
    // 复用注册入场引导已收的档案：行业/阶段已答就预填并折叠，避免重复问，用户只补「最痛的一件事」。
    api.getProfile().then((p) => {
      if (!p) return;
      if (p.industry) setIndustry(p.industry);
      if (p.stage) setRevenueBand(p.stage);
      if (p.industry && p.stage) setPrefilled(true);
    }).catch(() => {});
  }, []);
  const opt = (key: string) => survey.find((x) => x.key === key)?.options ?? [];
  const industryOpts = opt('industry');
  const bandOpts = opt('stage');
  const canSubmit = !!industry && !!revenueBand && pain.trim().length > 0 && !busy;

  const errCode = (e: unknown) => String((e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code || '');
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try { setResult(await api.quickScan({ industry, revenueBand, pain: pain.trim() })); }
    catch (e) {
      // D6：每日 3 次限流（服务端 quickscan.ts DAILY_LIMIT=3）→ 专属文案，不走通用报错。
      if (errCode(e) === 'RATE_LIMITED') Taro.showToast({ title: '今天的速诊次数用完了（每日 3 次），明天再来', icon: 'none' });
      else s.handleApiError(e);
    }
    finally { setBusy(false); }
  };

  const enterWarRoom = () =>
    navTo(`/packages/main/chat/index?agentKey=general&continue=1&send=${encodeURIComponent('我做完速诊了，帮我把主要矛盾展开，进入完整诊断。')}`);

  useShareAppMessage(() => ({
    title: result ? `军师速诊：${result.contradiction}` : '3 个问题，10 分钟拿到你的初诊 · 军师参谋部',
    path: '/packages/work/quickscan/index',
  }));

  return (
    <View className={`qs-page ${s.themeClass()}`}>
      <SafeHeader title="速诊" onBack={() => Taro.navigateBack()} />
      <ScrollView scrollY className="qs-scroll">
        {!result ? (
          <View className="qs-form">
            <View className="qs-hero">
              <Text className="qs-hero-t">{prefilled && !editBasics ? '补一句最痛的事，拿你的初诊' : '3 个问题，拿到你的初诊'}</Text>
              <Text className="qs-hero-d">主要矛盾 · 军师判断 · 今天就能做的一件事</Text>
            </View>

            {prefilled && !editBasics ? (
              <View className="qs-q">
                <View className="qs-basics">
                  <View className="qs-basics-main">
                    <Text className="qs-basics-t">行业：{industry} · 阶段：{revenueBand}</Text>
                    <Text className="qs-basics-note">来自你的档案</Text>
                  </View>
                  <Text className="qs-basics-edit" onClick={() => setEditBasics(true)}>重新选</Text>
                </View>
              </View>
            ) : (
              <>
                <View className="qs-q">
                  <Text className="qs-qt">① 你的行业</Text>
                  <View className="qs-chips">
                    {industryOpts.map((o) => (
                      <View key={o} className={`qs-chip ${industry === o ? 'on' : ''}`} onClick={() => setIndustry(o)}><Text>{o}</Text></View>
                    ))}
                  </View>
                </View>
                <View className="qs-q">
                  <Text className="qs-qt">② 当前阶段 / 年营收段</Text>
                  <View className="qs-chips">
                    {bandOpts.map((o) => (
                      <View key={o} className={`qs-chip ${revenueBand === o ? 'on' : ''}`} onClick={() => setRevenueBand(o)}><Text>{o}</Text></View>
                    ))}
                  </View>
                </View>
              </>
            )}

            <View className="qs-q">
              <Text className="qs-qt">③ 当前最痛的一件事</Text>
              <Textarea
                className="qs-pain"
                value={pain}
                maxlength={200}
                placeholder="一句话说清眼下最卡你的那件事"
                onInput={(e: { detail: { value: string } }) => setPain(e.detail.value)}
              />
            </View>

            <View className={`qs-submit ${canSubmit ? '' : 'off'}`} onClick={submit}>
              <Text>{busy ? '军师研判中…' : '出初诊卡'}</Text>
            </View>
          </View>
        ) : (
          <View className="qs-result">
            <View className="qs-card">
              <View className="qs-block">
                <Text className="qs-label">主要矛盾</Text>
                <Text className="qs-main">{result.contradiction}</Text>
              </View>
              <View className="qs-block">
                <Text className="qs-label">军师判断</Text>
                <Text className="qs-body">{result.judgement}</Text>
              </View>
              <View className="qs-block">
                <Text className="qs-label">今天就做这一件</Text>
                <Text className="qs-body">{result.firstMove}</Text>
              </View>
              <View className="qs-brand"><Text>军师参谋部 · 初诊</Text></View>
            </View>
            <View className="qs-cta" onClick={enterWarRoom}><Text>继续问策，完善这份判断 →</Text></View>
            {/* D6：显式「分享给同行」按钮（open-type=share 触发 useShareAppMessage） */}
            <Button className="qs-share" openType="share" hoverClass="none"><Text>分享给同行</Text></Button>
            <View className="qs-again" onClick={() => setResult(null)}><Text>换个问题再诊一次</Text></View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
