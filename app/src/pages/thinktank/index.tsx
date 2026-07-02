import { useState } from 'react';
import { View, Text } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import { useStore } from '../../hooks/useStore';
import { api, type KnowledgeDocRow, type ReportItem } from '../../services/api';
import { DATA_BINDINGS, DOCTRINES, KNOWLEDGE_FOLDERS, MODULE_MARKET, SKILL_MARKET } from '../../data/operatingSystem';
import './index.scss';

type ThinkTab = 'assets' | 'data' | 'modules' | 'reports';

const TABS: { key: ThinkTab; label: string }[] = [
  { key: 'assets', label: '资料' },
  { key: 'data', label: '数据' },
  { key: 'modules', label: '模块' },
  { key: 'reports', label: '报告' },
];

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return '刚刚';
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}

// 智库页：分区工作台——军师判断所需的资料、数据源、模块 / Skill 与报告。
// 资料与报告是真实数据；数据源与模块是能力目录 + 引导态。
export default function ThinkTank() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [tab, setTab] = useState<ThinkTab>('assets');
  const [docs, setDocs] = useState<KnowledgeDocRow[]>([]);
  const [reports, setReports] = useState<ReportItem[]>([]);
  const und = s.me()?.understanding;

  useDidShow(() => {
    s.setTab(3);
    Taro.getCurrentInstance().page?.getTabBar?.();
    if (s.isAuthed()) {
      api.knowledgeDocs().then(setDocs).catch(() => setDocs([]));
      api.reports().then(setReports).catch((e) => { s.handleApiError(e, { silent: true }); setReports([]); });
    }
  });

  const goKnowledge = () => Taro.navigateTo({ url: '/packages/work/knowledge/index' });
  const goBindings = () => Taro.navigateTo({ url: '/packages/work/bindings/index' });
  const goMarket = () => Taro.navigateTo({ url: '/packages/work/market/index' });
  const goLibrary = () => Taro.navigateTo({ url: '/packages/work/library/index' });
  const openReport = (id: string) => Taro.navigateTo({ url: `/packages/work/report/index?id=${id}` });

  return (
    <Screen topInset>
      <View className="pad think">
        <View className="agents-hero">
          <Text className="kicker">Think Tank · 智库</Text>
          <Text className="h1">智库</Text>
          <Text className="hero-p">军师每条判断背后都有方法和依据。资料、数据、模块和报告越完整，判断越贴近你的真实业务。</Text>
        </View>

        {/* 分区切换（对齐设计稿：seg 置顶） */}
        <View className="think-tabs">
          {TABS.map((it) => (
            <View
              key={it.key}
              className={`think-tab ${tab === it.key ? 'on' : ''}`}
              style={tab === it.key ? { background: accent } : {}}
              onClick={() => setTab(it.key)}
            >
              <Text>{it.label}</Text>
            </View>
          ))}
        </View>

        {/* 资料：真实资料库 + AI 分类框架 */}
        {tab === 'assets' ? (
          <>
            <View className="kb-entry card" onClick={goKnowledge}>
              <View className="kb-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="upload" size={18} color={accent} /></View>
              <View className="kb-b">
                <Text className="kb-t">我的资料库</Text>
                <Text className="kb-s">{docs.length ? `已沉淀 ${docs.length} 份资料 · 军师咨询时自动参考` : '上传公司、产品、财务、历史方案，军师咨询时自动参考'}</Text>
              </View>
              <Text className="kb-go" style={{ color: accent }}>{docs.length ? '管理 ›' : '上传 ›'}</Text>
            </View>
            {docs.slice(0, 3).map((d) => (
              <View key={d.id} className="doc-row card" onClick={goKnowledge}>
                <Icon name="doc" size={15} color={accent} />
                <Text className="doc-t">{d.title || d.fileName || '未命名资料'}</Text>
                <Text className="doc-m">{relTime(d.updatedAt)}</Text>
              </View>
            ))}
            <View className="sec-head">
              <Text className="sec-title">AI 分类框架</Text>
              <Text className="sec-more">上传后自动归类</Text>
            </View>
            <View className="panel-grid">
              {KNOWLEDGE_FOLDERS.slice(0, 6).map((f) => (
                <View key={f.id} className="asset-card card" onClick={goKnowledge}>
                  <View className="asset-top">
                    <Icon name={f.icon} size={15} color={accent} />
                  </View>
                  <Text className="asset-title">{f.title}</Text>
                  <Text className="asset-desc">{f.desc}</Text>
                </View>
              ))}
            </View>

            {/* 军师提示补充：档案里真实的待补问题，直接影响诊断精度 */}
            {und?.nextQuestions.length ? (
              <>
                <View className="sec-head">
                  <Text className="sec-title">军师提示补充</Text>
                  <Text className="sec-more">影响诊断精度</Text>
                </View>
                {und.nextQuestions.slice(0, 3).map((qText) => (
                  <View
                    key={qText}
                    className="missing card"
                    onClick={() => Taro.navigateTo({ url: `/pages/chat/index?agentKey=general&fresh=1&send=${encodeURIComponent('帮我补齐军师档案：你先问我最关键的 1-3 个问题，我来答。')}` })}
                  >
                    <View className="missing-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="alert" size={15} color={accent} /></View>
                    <Text className="missing-t">{qText}</Text>
                    <Text className="missing-go" style={{ color: accent }}>补充 ›</Text>
                  </View>
                ))}
              </>
            ) : null}
          </>
        ) : null}

        {/* 数据源：能力目录 + 绑定引导 */}
        {tab === 'data' ? (
          <View className="line-list card">
            {DATA_BINDINGS.map((b) => (
              <View key={b.id} className="line-row" onClick={goBindings}>
                <View className="line-ic" style={{ background: 'var(--accent-soft)' }}><Icon name={b.icon} size={15} color={accent} /></View>
                <View className="line-b">
                  <Text className="line-title">{b.title}</Text>
                  <Text className="line-desc">{b.provider} · {b.price}</Text>
                </View>
                <Text className="line-state" style={{ color: accent }}>{b.status}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* 模块 / Skill：已启用方法底座 + 市场预览 */}
        {tab === 'modules' ? (
          <>
            <View className="sec-head" style={{ marginTop: '14px' }}>
              <Text className="sec-title">已启用 Skill · 方法底座</Text>
              <Text className="sec-more">军师判断的底层逻辑</Text>
            </View>
            <View className="method-list">
              {DOCTRINES.map((d) => (
                <View key={d.name} className="method-card card">
                  <View className="method-seal" style={{ background: 'var(--accent-soft)' }}>
                    <Text className="serif" style={{ color: accent }}>{d.name.slice(0, 1)}</Text>
                  </View>
                  <View className="method-b">
                    <Text className="method-name">{d.name} · {d.point}</Text>
                    <Text className="method-use">{d.use}</Text>
                  </View>
                </View>
              ))}
            </View>
            <View className="sec-head">
              <Text className="sec-title">方案模块</Text>
              <Text className="sec-more" onClick={goMarket}>模块市场 ›</Text>
            </View>
            <View className="panel-grid" style={{ marginTop: 0 }}>
              {MODULE_MARKET.slice(0, 4).map((m) => (
                <View key={m.id} className="asset-card card" onClick={goMarket}>
                  <View className="asset-top">
                    <Text className="asset-label" style={{ color: accent }}>{m.category}</Text>
                    <Text className={`module-tier tier-${m.tier}`}>{m.price}</Text>
                  </View>
                  <Text className="asset-title">{m.title}</Text>
                  <Text className="asset-desc">{m.status}</Text>
                </View>
              ))}
            </View>
            <View className="sec-head">
              <Text className="sec-title">Skill 能力包</Text>
              <Text className="sec-more" onClick={goMarket}>全部 ›</Text>
            </View>
            <View className="panel-grid" style={{ marginTop: 0 }}>
              {SKILL_MARKET.slice(0, 4).map((sk) => (
                <View key={sk.id} className="asset-card card" onClick={goMarket}>
                  <View className="asset-top">
                    <Icon name={sk.icon} size={15} color={accent} />
                    <Text className={`module-tier tier-${sk.tier}`}>{sk.cost}</Text>
                  </View>
                  <Text className="asset-title">{sk.title}</Text>
                  <Text className="asset-desc">{sk.desc}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {/* 报告：真实版本化报告 + 方案库 */}
        {tab === 'reports' ? (
          <>
            {reports.length === 0 ? (
              <View className="think-empty">
                <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={22} color={accent} /></View>
                <Text className="et">还没有沉淀报告</Text>
                <Text className="es">对话中点「生成纪要」，或让军师产出成果后存入方案库，报告会按版本沉淀在这里。</Text>
              </View>
            ) : (
              <View className="line-list card">
                {reports.map((r) => (
                  <View key={r.id} className="line-row" onClick={() => openReport(r.id)}>
                    <View className="line-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={15} color={accent} /></View>
                    <View className="line-b">
                      <Text className="line-title">{r.title}</Text>
                      <Text className="line-desc">{r.type}{r.agentName ? ` · ${r.agentName}` : ''} · {relTime(r.updatedAt)}</Text>
                    </View>
                    <Text className="line-state" style={{ color: accent }}>v{r.currentVersion}</Text>
                  </View>
                ))}
              </View>
            )}
            <View className="kb-entry card" style={{ marginTop: '12px' }} onClick={goLibrary}>
              <View className="kb-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="layers" size={18} color={accent} /></View>
              <View className="kb-b">
                <Text className="kb-t">我的方案库</Text>
                <Text className="kb-s">对话产出的结构化成果，存库即沉淀一版报告</Text>
              </View>
              <Text className="kb-go" style={{ color: accent }}>查看 ›</Text>
            </View>
          </>
        ) : null}

        {/* 底部主行动：补资料 */}
        <View className="think-cta" style={{ background: accent }} onClick={goKnowledge}>
          <Icon name="upload" size={16} color="#FBFAF6" />
          <Text>上传资料，让军师补全判断</Text>
        </View>
      </View>
    </Screen>
  );
}
