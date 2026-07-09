import { useState } from 'react';
import { View, Text, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import { useStore } from '../../hooks/useStore';
import { api, type KnowledgeDocRow, type ReportItem } from '../../services/api';
import { DATA_BINDINGS, KNOWLEDGE_FOLDERS, MODULE_MARKET, SKILL_MARKET } from '../../data/operatingSystem';
import './index.scss';

type ThinkTab = 'assets' | 'data' | 'modules' | 'reports';

const TABS: { key: ThinkTab; label: string }[] = [
  { key: 'assets', label: '案卷资产' },
  { key: 'data', label: '数据源' },
  { key: 'modules', label: '能力' },
  { key: 'reports', label: '方案' },
];

// 能力面板的费用口径 chips（设计稿 commerce-strip）。
const COMMERCE = ['免费初判', '进阶锦囊', '会员权益', '按次付费', '高级模块'];

function relTime(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return '刚刚';
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '昨天' : `${d} 天前`;
}

// 智库页 —— 对齐设计稿 page-thinktank：上传区 / 资料树 / 数据源 / 能力（Skill+模块）/ 报告。
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
  const startInterview = () =>
    Taro.navigateTo({ url: `/pages/chat/index?agentKey=general&fresh=1&send=${encodeURIComponent('帮我补齐军师档案：你先问我最关键的 1-3 个问题，我来答。')}` });

  const freeSkills = SKILL_MARKET.filter((k) => k.tier === 'free');
  const deepSkills = SKILL_MARKET.filter((k) => k.tier !== 'free');

  const skillRow = (it: { id: string; title: string; desc: string; status: string; tier: string }, onTap: () => void) => (
    <View key={it.id} className="skill card" onClick={onTap}>
      <View className="skill-ic"><Text className="serif">{it.title.slice(0, 1)}</Text></View>
      <View className="skill-b">
        <Text className="skill-name serif">{it.title}</Text>
        <Text className="skill-sub">{it.desc}</Text>
      </View>
      <Text className={`module-state tier-${it.tier}`}>{it.status}</Text>
    </View>
  );

  return (
    <Screen topInset>
      <View className="pad think">
        {/* 页头：左「上传」· 中「锦囊」· 右「市场」 */}
        <View className="think-nav tab-page-head">
          <Text className="tn-side left serif" onClick={goKnowledge}>上传</Text>
          <Text className="tn-title serif">锦囊</Text>
          <Text className="tn-side right serif" onClick={goMarket}>市场</Text>
        </View>

        {/* 分区切换（设计稿 seg：软底 + 白块选中） */}
        <View className="think-tabs">
          {TABS.map((it) => (
            <View
              key={it.key}
              className={`think-tab ${tab === it.key ? 'on' : ''}`}
              onClick={() => setTab(it.key)}
            >
              <Text>{it.label}</Text>
            </View>
          ))}
        </View>

        {/* 案卷资产：上传区 + 状态格 + 资料树（真实资料 + AI 分类框架） */}
        {tab === 'assets' ? (
          <>
            <View className="upload-zone card" onClick={goKnowledge}>
              <View className="uz-b">
                <Text className="uz-k">第一步 · 接住乱资料</Text>
                <Text className="uz-t serif">上传新老资料、聊天记录和参考案例</Text>
                <Text className="uz-d">不用先整理，把散落在微信、表格、文档、图片里的材料放进来，军师咨询时自动参考。</Text>
              </View>
              <View className="uz-btn"><Text>＋ 上传</Text></View>
            </View>

            <View className="quota-grid">
              <View className="quota-card card" onClick={goKnowledge}>
                <Text className="qc-v serif">{docs.length || '—'}</Text>
                <Text className="qc-l">已入库资料</Text>
              </View>
              <View className="quota-card card" onClick={startInterview}>
                <Text className="qc-v serif">{und?.nextQuestions.length || '—'}</Text>
                <Text className="qc-l">关键缺口</Text>
              </View>
              <View className="quota-card card" onClick={() => Taro.showToast({ title: '深度整理（去重/分类/优化）即将开放', icon: 'none' })}>
                <Text className="qc-v serif">深度整理</Text>
                <Text className="qc-l">去重 / 分类 / 优化</Text>
              </View>
            </View>

            {/* 资料树：最新上传（真实） + AI 分类框架 + 处理与优化（引导） */}
            <View className="library-tree card">
              <View className="tree-node">
                <View className="tree-head" onClick={goKnowledge}>
                  <View className="tree-i"><Text>库</Text></View>
                  <View className="tree-b">
                    <Text className="tree-t serif">最新上传</Text>
                    <Text className="tree-s">{docs.length ? `${docs.length} 份资料 · 军师咨询时自动参考` : '还没有资料 · 先把手头材料放进来'}</Text>
                  </View>
                  <Text className="tree-em">{docs.length ? '管理' : '上传'}</Text>
                </View>
                {docs.slice(0, 3).map((d) => (
                  <View key={d.id} className="tree-leaf" onClick={goKnowledge}>
                    <View className="tree-i leaf"><Text>档</Text></View>
                    <View className="tree-b">
                      <Text className="tree-lt">{d.title || d.fileName || '未命名资料'}</Text>
                    </View>
                    <Text className="tree-em">{relTime(d.updatedAt)}</Text>
                  </View>
                ))}
              </View>
              <View className="tree-node">
                <View className="tree-head" onClick={goKnowledge}>
                  <View className="tree-i"><Text>分</Text></View>
                  <View className="tree-b">
                    <Text className="tree-t serif">资料分类</Text>
                    <Text className="tree-s">上传后按案卷目标自动归类</Text>
                  </View>
                  <Text className="tree-em">8 类</Text>
                </View>
                {KNOWLEDGE_FOLDERS.slice(0, 4).map((f) => (
                  <View key={f.id} className="tree-leaf" onClick={goKnowledge}>
                    <View className="tree-i leaf"><Text>{f.title.slice(0, 1)}</Text></View>
                    <View className="tree-b">
                      <Text className="tree-lt">{f.title}</Text>
                      <Text className="tree-ls">{f.desc}</Text>
                    </View>
                    <Text className="tree-em">›</Text>
                  </View>
                ))}
              </View>
            </View>

            {/* 军师提示补充（asset-gap）：档案里真实的待补问题 */}
            {und?.nextQuestions.length ? (
              <View className="asset-gap card">
                <Text className="ag-k">军师提示补充 · 影响诊断精度</Text>
                {und.nextQuestions.slice(0, 3).map((qText) => (
                  <View key={qText} className="ag-row" onClick={startInterview}>
                    <Text className="ag-t serif">{qText}</Text>
                    <Text className="ag-em">补充 ›</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : null}

        {/* 数据源：能力目录 + 绑定引导（binding 行合入单卡） */}
        {tab === 'data' ? (
          <View className="binding-panel card">
            <Text className="bp-h2 serif">数据源绑定</Text>
            {DATA_BINDINGS.map((b) => (
              <View key={b.id} className="binding" onClick={goBindings}>
                <View className="binding-ic"><Icon name={b.icon} size={16} color={accent} /></View>
                <View className="binding-b">
                  <Text className="binding-t serif">{b.title}</Text>
                  <Text className="binding-s">{b.provider} · {b.price}</Text>
                </View>
                <Text className="binding-state">{b.status}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* 能力：Skill 与模块（commerce-strip + 分组行） */}
        {tab === 'modules' ? (
          <>
            <ScrollView scrollX className="commerce-strip" enhanced showScrollbar={false}>
              {COMMERCE.map((c) => <Text key={c} className="commerce-chip">{c}</Text>)}
            </ScrollView>
            <Text className="think-h2">基础锦囊</Text>
            {freeSkills.map((k) => skillRow(k, goMarket))}
            <Text className="think-h2">进阶锦囊</Text>
            {deepSkills.map((k) => skillRow({ ...k, status: k.cost }, goMarket))}
            <Text className="think-h2">方案模块</Text>
            {MODULE_MARKET.slice(0, 4).map((m) => skillRow({ id: m.id, title: m.title, desc: m.desc, status: m.price, tier: m.tier }, goMarket))}
          </>
        ) : null}

        {/* 报告：真实版本化报告 + 方案库 */}
        {tab === 'reports' ? (
          <>
            <Text className="think-h2">方案与历史沉淀</Text>
            {reports.length === 0 ? (
              <View className="think-empty">
                <View className="e-ic" style={{ background: 'var(--accent-soft)' }}><Icon name="doc" size={22} color={accent} /></View>
                <Text className="et">还没有沉淀方案</Text>
                <Text className="es">对话中点「生成纪要」，或让军师产出方案后存入方案库，方案会按版本沉淀在这里。</Text>
              </View>
            ) : (
              reports.map((r) => (
                <View key={r.id} className="report card" onClick={() => openReport(r.id)}>
                  <View className="report-ic"><Text className="serif">报</Text></View>
                  <View className="report-b">
                    <Text className="report-t serif">{r.title}</Text>
                    <Text className="report-s">{r.type}{r.agentName ? ` · ${r.agentName}` : ''} · v{r.currentVersion} · {relTime(r.updatedAt)}</Text>
                  </View>
                  <Text className="report-state">查看</Text>
                </View>
              ))
            )}
            <View className="report card" onClick={() => Taro.switchTab({ url: '/pages/sessions/index' })}>
              <View className="report-ic"><Text className="serif">新</Text></View>
              <View className="report-b">
                <Text className="report-t serif">从对话生成新方案</Text>
                <Text className="report-s">同步到知识库和执行模块</Text>
              </View>
              <Text className="report-state">生成</Text>
            </View>
            <View className="report card" onClick={goLibrary}>
              <View className="report-ic"><Text className="serif">案</Text></View>
              <View className="report-b">
                <Text className="report-t serif">我的方案库</Text>
                <Text className="report-s">对话产出的结构化方案，存库即沉淀一版方案</Text>
              </View>
              <Text className="report-state">查看</Text>
            </View>
          </>
        ) : null}

        {/* 底部主行动：补资料 */}
        <View className="think-cta" onClick={goKnowledge}>
          <Icon name="upload" size={16} color="#FBFAF6" />
          <Text>上传资料，让军师补全判断</Text>
        </View>
      </View>
    </Screen>
  );
}
