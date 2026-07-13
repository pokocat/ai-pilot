import { useEffect, useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { api, type ClientUnderstanding, type MemoryLibraryView, type MemoryCategoryKey, type MemoryFillLevel } from '../../../services/api';
import './index.scss';

// 军师记忆库六类展示元数据（现代白话，面向下沉老板群体；保留军师品牌，去文言）。
const MEM_CATS: { key: MemoryCategoryKey; title: string; sub: string; icon: string; tint: string; ink: string }[] = [
  { key: 'founder', title: '创始人 · 你这个人', sub: '创业故事 · 背景 · 性格 · 决策风格 · 天赋与短板', icon: 'insight', tint: '#EEEDFE', ink: '#3C3489' },
  { key: 'company', title: '企业 · 你的生意', sub: '发展历程 · 行业 · 阶段 · 团队 · 业务模式', icon: 'layers', tint: '#E1F5EE', ink: '#085041' },
  { key: 'status', title: '现状 · 眼下的经营', sub: '当前经营数据 · 主要痛点 · 卡点', icon: 'trend', tint: '#FAEEDA', ink: '#633806' },
  { key: 'vision', title: '目标愿景 · 你想做成的事', sub: '抱负 · 长期目标 · 使命', icon: 'target', tint: '#FBEAF0', ink: '#72243E' },
  { key: 'strategy', title: '战略 · 打法共识', sub: '主要矛盾 · 定位 · 主攻赛道 · 当前策略', icon: 'shield', tint: '#FAECE7', ink: '#712B13' },
  { key: 'rapport', title: '陪跑 · 相处之道', sub: '沟通偏好 · 忌讳 · 反馈 · 约定', icon: 'spark', tint: '#E6F1FB', ink: '#0C447C' },
];
const FILL_LABEL: Record<MemoryFillLevel, string> = { unknown: '待补', thin: '部分', known: '较全', settled: '已确认' };

export default function BriefPage() {
  const s = useStore();
  const color = s.color();
  const accent = color.vars['--accent'];
  const understanding = s.me()?.understanding;
  const [lib, setLib] = useState<MemoryLibraryView | null>(null); // 军师记忆库（P2）
  const [libLoading, setLibLoading] = useState(true); // B7：加载中给六类骨架，防卡片突然撑开

  useEffect(() => {
    store.loadMe();
    api.memoryLibrary().then((v) => { setLib(v); setLibLoading(false); }).catch(() => setLibLoading(false));
  }, []);

  const removeEntry = async (id: string) => {
    if (id.startsWith('sp-')) return; // 战略事实来自战略档案，此处不删
    // B7：删除记忆二次确认——点明「删掉后军师不再据此判断」的后果。
    const ok = await Taro.showModal({
      title: '删掉这条记忆？',
      content: '删掉后军师不再据此判断你的生意，之后的建议可能少一层依据。确定删除？',
      confirmText: '删除',
      confirmColor: '#9C4A38', // = var(--danger)，showModal 仅接受 hex
    }).then((r) => r.confirm).catch(() => false);
    if (!ok) return;
    try {
      await api.deleteMemory(id);
      setLib((cur) => (cur ? { ...cur, total: Math.max(0, cur.total - 1), groups: cur.groups.map((g) => ({ ...g, entries: g.entries.filter((e) => e.id !== id) })) } : cur));
    } catch { /* noop */ }
  };

  return (
    <View className={`page brief-page ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="个人档案" onBack={() => Taro.navigateBack()} titleClassName="brief-title" />

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
          <Text className="bf-t serif">{understanding?.title ?? '个人档案'}</Text>
          <Text className="bf-summary">{understanding?.summary ?? '登录并补充经营资料后，军师会把对你的理解整理在这里。'}</Text>
          {understanding ? <Text className="bf-counts">{evidenceLine(understanding)}</Text> : null}
        </View>

        {/* 军师记忆（放最前，最先看到）*/}
        {lib ? (
          <View className="bf-sec">
            <View className="bf-memhead">
              <Text className="bf-sec-t">军师记忆</Text>
              <Text className="bf-memcount">{lib.total > 0 ? `已记住 ${lib.total} 条` : '还没开始记'}</Text>
            </View>
            {MEM_CATS.map((c) => {
              const g = lib.groups.find((x) => x.category === c.key);
              const entries = g?.entries ?? [];
              return (
                <View key={c.key} className="bf-memcat">
                  <View className="bf-memcat-h">
                    <View className="bf-memcat-ic" style={{ background: c.tint }}><Icon name={c.icon} size={15} color={c.ink} /></View>
                    <View className="bf-memcat-tt">
                      <Text className="bf-memcat-t">{c.title}</Text>
                      <Text className="bf-memcat-s">{c.sub}</Text>
                    </View>
                    <Text className="bf-memcat-fill" style={{ color: c.ink }}>{FILL_LABEL[g?.fill ?? 'unknown']}</Text>
                  </View>
                  {entries.length ? entries.map((e) => (
                    <View key={e.id} className="bf-memrow">
                      <Text className="bf-memrow-t">· {e.text}</Text>
                      {e.id.startsWith('sp-') ? null : <Text className="bf-memrow-del" style={{ color: accent }} onClick={() => removeEntry(e.id)}>删</Text>}
                    </View>
                  )) : <Text className="bf-memcat-empty">这方面军师还不太了解，多聊聊就补上了。</Text>}
                </View>
              );
            })}
            <Text className="bf-empty" style={{ marginTop: '8px' }}>记错了点「删」；删掉后军师不再据此判断。</Text>
          </View>
        ) : libLoading ? (
          // B7：加载中六类骨架，占位与真实卡等高，避免数据到达时整页跳动。
          <View className="bf-sec">
            <View className="bf-memhead"><Text className="bf-sec-t">军师记忆</Text></View>
            {MEM_CATS.map((c) => (
              <View key={c.key} className="bf-memcat">
                <View className="bf-memcat-h">
                  <View className="bf-memcat-ic" style={{ background: c.tint }} />
                  <View className="bf-memcat-tt">
                    <View className="bf-sk-bar w55" />
                    <View className="bf-sk-bar w85" style={{ marginTop: '6px' }} />
                  </View>
                </View>
              </View>
            ))}
          </View>
        ) : (
          <View className="bf-sec"><Text className="bf-empty">军师记忆整理中…（和军师多聊几句，就会归档到这里）</Text></View>
        )}

        <View className="bf-dossier" onClick={() => Taro.navigateTo({ url: '/packages/work/dossier/index' })}>
          <View className="bf-dossier-ic"><Icon name="insight" size={18} color="#c5a55a" /></View>
          <View className="bf-dossier-l">
            <Text className="bf-dossier-t serif">完整履历 · 创始人战略档案</Text>
            <Text className="bf-dossier-s">把军师记住的这些，蒸馏成一份完整档案</Text>
          </View>
          <Text className="bf-dossier-arrow">›</Text>
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
            <Text className="bf-empty">暂无资料。先登录并完成建档，后续对话、案卷、方案和资料库都会逐步沉淀到个人档案。</Text>
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
    u.evidenceCount.projects ? `案卷 ${u.evidenceCount.projects}` : '',
    u.evidenceCount.knowledge ? `资料 ${u.evidenceCount.knowledge}` : '',
    u.evidenceCount.sessions ? `对话 ${u.evidenceCount.sessions}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : '暂无沉淀资料';
}

function startInterview(focus?: string) {
  const text = focus
    ? `请进入个人档案访谈模式，围绕「${focus}」只问我一个简单具体的问题。不要先分析，不要引用旧报告，不要替我假设业务事实。`
    : '请进入个人档案访谈模式。不要先分析，不要引用旧报告，不要替我假设业务事实；请先用老板能听懂的话问我 3 个简单具体的问题，帮你补齐行业、阶段和当前难题。';
  Taro.navigateTo({ url: `/packages/main/chat/index?send=${encodeURIComponent(text)}` });
}
