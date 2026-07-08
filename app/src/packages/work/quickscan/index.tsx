// 3 问速诊（WO-06）：行业 + 阶段/营收段 + 最痛的一件事 → 初诊卡（主要矛盾 / 军师判断 / 今天做的一件事）。
// 选项复用 /survey（industry + stage）；提交走 api.quickScan（服务端 structured()，mock 有确定性模板）。
// 结果卡可 useShareAppMessage 分享；CTA 进参谋室走完整六轮诊断。替代「送你一卦」承担获客。
import { useEffect, useState } from 'react';
import { View, Text, Textarea, ScrollView } from '@tarojs/components';
import Taro, { useShareAppMessage } from '@tarojs/taro';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
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

  useEffect(() => { api.survey().then(setSurvey).catch(() => {}); }, []);
  const opt = (key: string) => survey.find((x) => x.key === key)?.options ?? [];
  const industryOpts = opt('industry');
  const bandOpts = opt('stage');
  const canSubmit = !!industry && !!revenueBand && pain.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try { setResult(await api.quickScan({ industry, revenueBand, pain: pain.trim() })); }
    catch (e) { s.handleApiError(e); }
    finally { setBusy(false); }
  };

  const enterWarRoom = () =>
    Taro.navigateTo({ url: `/pages/chat/index?agentKey=general&fresh=1&send=${encodeURIComponent('我做完速诊了，帮我把主要矛盾展开，进入完整诊断。')}` });

  useShareAppMessage(() => ({
    title: result ? `军师速诊：${result.contradiction}` : '3 个问题，10 分钟拿到你的初诊 · 军师参谋部',
    path: '/packages/work/quickscan/index',
  }));

  return (
    <View className="qs-page">
      <SafeHeader title="速诊" onBack={() => Taro.navigateBack()} />
      <ScrollView scrollY className="qs-scroll">
        {!result ? (
          <View className="qs-form">
            <View className="qs-hero">
              <Text className="qs-hero-t">3 个问题，拿到你的初诊</Text>
              <Text className="qs-hero-d">主要矛盾 · 军师判断 · 今天就能做的一件事</Text>
            </View>

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
            <View className="qs-cta" onClick={enterWarRoom}><Text>想要完整作战方案？进参谋室聊 6 轮 →</Text></View>
            <View className="qs-again" onClick={() => setResult(null)}><Text>换个问题再诊一次</Text></View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
