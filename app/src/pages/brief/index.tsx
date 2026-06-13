import { useEffect } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import SafeHeader from '../../components/SafeHeader';
import Icon from '../../components/Icon';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import type { ClientUnderstanding } from '../../services/api';
import './index.scss';

export default function BriefPage() {
  const s = useStore();
  const color = s.color();
  const accent = color.vars['--accent'];
  const understanding = s.me()?.understanding;

  useEffect(() => {
    store.loadMe();
  }, []);

  return (
    <View className={`page brief-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="军师档案" onBack={() => Taro.navigateBack()} titleClassName="brief-title" />

      <View className="pad">
        <View className="bf-hero" style={{ background: '#1B1E22' }}>
          <View className="bf-hero-top">
            <View className="bf-hero-ic" style={{ background: 'rgba(255,255,255,.09)' }}>
              <Icon name="insight" size={20} color={color.vars['--accent-bright']} />
            </View>
            {understanding ? (
              <View className={`bf-badge ${understanding.maturity}`}>
                <Text>{maturityLabel(understanding.maturity)}</Text>
              </View>
            ) : null}
          </View>
          <Text className="bf-k">军师有多了解你的生意</Text>
          <Text className="bf-t serif">{understanding?.title ?? '军师档案'}</Text>
          <Text className="bf-summary">{understanding?.summary ?? '登录并补充经营资料后，军师会把对你的理解整理在这里。'}</Text>
          {understanding ? <Text className="bf-counts">{evidenceLine(understanding)}</Text> : null}
        </View>

        {understanding ? (
          <>
            {understanding.sections.map((sec) => (
              <View key={sec.key} className="bf-sec">
                <Text className="bf-sec-t">{sec.title}</Text>
                {sec.items.length ? (
                  sec.items.slice(0, 6).map((item) => <Text key={item} className="bf-item">• {item}</Text>)
                ) : (
                  <Text className="bf-empty">{sec.emptyText}</Text>
                )}
              </View>
            ))}

            {understanding.nextQuestions.length ? (
              <View className="bf-sec">
                <Text className="bf-sec-t">军师下一步会问</Text>
                <View className="bf-chip-wrap">
                  {understanding.nextQuestions.map((q) => (
                    <View key={q} className="bf-chip" style={{ background: 'var(--accent-soft)' }} onClick={() => startInterview(q)}>
                      <Text style={{ color: 'var(--accent-ink)' }}>{q}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ) : null}
          </>
        ) : (
          <View className="bf-sec">
            <Text className="bf-empty">暂无资料。先登录并完成建档，后续对话、项目、报告和知识库都会逐步沉淀到军师档案。</Text>
          </View>
        )}

        <View className="bf-cta" style={{ background: accent }} onClick={() => startInterview()}>
          <Icon name="spark" size={17} color="#fff" />
          <Text>让军师来问我</Text>
        </View>
      </View>
    </View>
  );
}

function maturityLabel(v: ClientUnderstanding['maturity']): string {
  if (v === 'ready') return '可用于咨询';
  if (v === 'forming') return '正在整理';
  return '待补资料';
}

function evidenceLine(u: ClientUnderstanding): string {
  const parts = [
    u.evidenceCount.profile ? '档案 1' : '',
    u.evidenceCount.memories ? `线索 ${u.evidenceCount.memories}` : '',
    u.evidenceCount.projects ? `项目 ${u.evidenceCount.projects}` : '',
    u.evidenceCount.knowledge ? `资料 ${u.evidenceCount.knowledge}` : '',
    u.evidenceCount.sessions ? `对话 ${u.evidenceCount.sessions}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '暂无沉淀资料';
}

function startInterview(focus?: string) {
  const text = focus
    ? `请进入军师档案访谈模式，围绕「${focus}」只问我一个简单具体的问题。不要先分析，不要引用旧报告，不要替我假设业务事实。`
    : '请进入军师档案访谈模式。不要先分析，不要引用旧报告，不要替我假设业务事实；请先用老板能听懂的话问我 3 个简单具体的问题，帮你补齐行业、阶段和当前难题。';
  Taro.navigateTo({ url: `/pages/chat/index?send=${encodeURIComponent(text)}` });
}
