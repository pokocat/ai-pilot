import { useState } from 'react';
import { View, Text, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import AdvisorAvatar from '../../components/AdvisorAvatar';
import AgentUnlock from '../../components/AgentUnlock';
import { useStore } from '../../hooks/useStore';
import { diamondCost } from '../../services/format';
import { api, type Agent } from '../../services/api';
import {
  addOrder, buildReviewPrompt, doneOrdersOf, ordersOf, pendingOrdersOf, recentOrders, refreshDossier,
  removeOrder, saveBackfill, startReview, today, todayProgress, toggleOrder, type Dossier,
} from '../../services/dossier';
import './index.scss';

type ExecView = 'today' | 'week' | 'review';

// 提醒节奏（订阅消息推送待接入，先亮明框架）。
const REMINDERS = [
  { time: '每天 09:00', text: '生成今日军令' },
  { time: '每天 21:30', text: '记录战果，生成当日复盘' },
  { time: '每周五 18:00', text: '生成周复盘，调整下周打法' },
];

function dateLabel(iso: string): string {
  if (iso === today()) return '今天';
  const [, m, d] = iso.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

function orderTagLabel(tag: string): string {
  return tag.startsWith('军令') ? tag : `军令 · ${tag}`;
}

// 执行页（军令台）—— 对齐设计稿 page-execution：exec-nav / 横滑战役卡组 / 督战行 / 目标阶梯 / 军令 / 回填 / 复盘。
// 军令/回填数据存本地案卷（services/dossier，按用户隔离），内容全部来自认可的真实成果或用户录入。
export default function Studio() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const [buying, setBuying] = useState<Agent | null>(null);
  const [dossier, setDossier] = useState<Dossier | null>(null);
  const [view, setView] = useState<ExecView>('today');
  const [newOrder, setNewOrder] = useState('');
  const [bf, setBf] = useState({ leads: '', consults: '', deals: '' });
  const [streak, setStreak] = useState<number | null>(null);
  const [showDoneArchive, setShowDoneArchive] = useState(false);
  const und = s.me()?.understanding;

  useDidShow(() => {
    s.setTab(2);
    Taro.getCurrentInstance().page?.getTabBar?.();
    // 案卷已服务端化：拉取当前案卷（含一次性本地迁移），回填草稿用当日已存值初始化
    refreshDossier().then((d) => {
      setDossier(d);
      const saved = d?.backfill[today()];
      if (saved) setBf({ leads: saved.leads, consults: saved.consults, deals: saved.deals });
    });
    // 连续复盘天数（服务端计数，M4 PR-18）
    api.reviews().then((r) => setStreak(r.streak)).catch(() => setStreak(null));
  });

  const todayDate = today();
  const progress = todayProgress(dossier);
  const todayOrders = ordersOf(dossier, todayDate);
  const pendingTodayOrders = pendingOrdersOf(dossier, todayDate);
  const doneTodayOrders = doneOrdersOf(dossier, todayDate);
  const weekGroups = recentOrders(dossier);
  const backfillSaved = !!dossier?.backfill[todayDate]?.savedAt;
  const creative = s.agents().filter((a) => a.type === 'creative');
  const firstUndone = pendingTodayOrders[0];

  const goChat = (agentKey: string, prompt: string) =>
    Taro.navigateTo({ url: `/pages/chat/index?agentKey=${agentKey}&fresh=1&send=${encodeURIComponent(prompt)}` });
  const openAgent = (key: string) => Taro.navigateTo({ url: `/pages/chat/index?agentKey=${key}&continue=1` });
  const tapCreative = (a: Agent) => {
    if (a.billing === 'unlock' && !a.owned) setBuying(a);
    else openAgent(a.key);
  };

  // 打卡走乐观更新（即点即勾），服务端结果回来后校准；失败重新拉取兜底。
  const onToggle = (id: string) => {
    setDossier((cur) => (cur ? { ...cur, orders: cur.orders.map((o) => (o.id === id ? { ...o, done: !o.done } : o)) } : cur));
    toggleOrder(id).then(setDossier).catch(() => refreshDossier().then(setDossier));
  };
  const onRemove = (id: string) =>
    Taro.showModal({ title: '删除军令', content: '删除这条军令？', confirmText: '删除' }).then(async (r) => {
      if (r.confirm) setDossier(await removeOrder(id).catch(() => dossier));
    });
  const onAdd = async () => {
    if (!newOrder.trim()) return;
    if (!dossier) { Taro.showToast({ title: '先认可一份军师方案生成案卷', icon: 'none' }); return; }
    try {
      setDossier(await addOrder(newOrder));
      setNewOrder('');
    } catch {
      Taro.showToast({ title: '添加失败，请重试', icon: 'none' });
    }
  };
  const onSaveBackfill = async () => {
    if (!dossier) { Taro.showToast({ title: '先认可一份军师方案生成案卷', icon: 'none' }); return; }
    try {
      setDossier(await saveBackfill(bf));
      Taro.showToast({ title: '已记录 · 复盘时军师会参考这些数', icon: 'none' });
    } catch {
      Taro.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  };
  const genOrders = () =>
    goChat('general', '基于我们最近认可的方案，把今天最重要的 1-3 件事拆成今日军令，并给出每件事的完成标准。');
  // 发起复盘：先落复盘账（服务端记连续天数，不阻塞跳转），再带真实数据进复盘对话。
  // 复盘走总军师（M2 PR-6：复盘是留存生命线，订阅内免费，不设解锁墙；经营参谋 ops 保留为可解锁深聊）。
  const genReview = () => {
    void startReview('day');
    goChat('general', buildReviewPrompt(dossier));
  };
  const genScript = () =>
    goChat('ip', firstUndone
      ? `围绕这条军令帮我产出可直接使用的内容脚本：「${firstUndone.text}」。`
      : '基于我们最近认可的方案，帮我生成今天要发布的内容脚本。');

  // 每日战报卡（M4 PR-15）：服务端按真实账本渲染，复制可分享链接
  const shareDailyCard = async () => {
    Taro.showLoading({ title: '生成战报卡…' });
    try {
      const r = await api.publishCard('daily');
      Taro.hideLoading();
      if (r.htmlUrl) {
        Taro.setClipboardData({ data: r.htmlUrl, success: () => Taro.showToast({ title: '战报卡链接已复制 · 可发朋友圈/群', icon: 'none' }) });
      } else {
        Taro.showToast({ title: '本地预览模式无卡片', icon: 'none' });
      }
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '生成失败，请重试', icon: 'none' });
    }
  };

  const dateStr = (() => { const d = new Date(); return `${d.getMonth() + 1}月${d.getDate()}日`; })();

  // 今日最重要（today-focus）：先补资料 > 首条未完成军令
  const focus = und?.nextQuestions.length
    ? { t: '先补资料，别让判断失真', d: und.nextQuestions[0], act: () => goChat('general', '帮我补齐军师档案：你先问我最关键的 1-3 个问题，我来答。') }
    : firstUndone
      ? { t: firstUndone.text, d: '完成后打卡，复盘会参考执行情况', act: () => {} }
      : null;
  const xianceSteps = pendingTodayOrders.length
    ? pendingTodayOrders.slice(0, 3).map((o) => o.text)
    : doneTodayOrders.length
      ? [
          `今日 ${doneTodayOrders.length} 条军令已完成，已归档`,
          '录入线索 / 咨询 / 成交三项数据',
          '21:30 做今日复盘，生成明日军令',
        ]
      : [
          '和军师聊透当前处境，产出一份方案',
          '认可方案，自动拆成今日军令',
          '每日打卡 + 录入数据，晚间复盘',
        ];
  const xianceSource = dossier
    ? doneTodayOrders.length && !pendingTodayOrders.length
      ? `源自案卷「${dossier.title}」· 今日完成项已归档`
      : `源自案卷「${dossier.title}」· 已认可，已生成军令`
    : '认可方案后，这里会换成你的破局三步';
  const mainOrderTitle = firstUndone ? firstUndone.text : todayOrders.length ? '今日军令已归档' : '今天还没有军令';
  const mainOrderDesc = firstUndone
    ? '可让 IP 军师直接生成配套内容脚本。'
    : todayOrders.length
      ? '完成项已归档，去录入数据、做复盘。'
      : '让军师根据案卷生成今天最重要的 1-3 件事。';
  const mainOrderAction = firstUndone ? genScript : todayOrders.length ? genReview : genOrders;
  const mainOrderButton = firstUndone ? '生成脚本' : todayOrders.length ? '生成复盘' : '生成今日军令';

  return (
    <Screen topInset>
      <View className="pad exec">
        {/* 页头（exec-nav）：左「案卷」· 中「执行」· 右「提醒」 */}
        <View className="exec-nav">
          <Text className="en-side left serif" onClick={() => Taro.navigateTo({ url: '/packages/work/projects/index' })}>案卷</Text>
          <Text className="en-title serif">执行</Text>
          <Text className="en-side right serif" onClick={() => setView('review')}>提醒</Text>
        </View>

        {/* 战役卡组（exec-deck 横滑）：今日战役 / 军师献策 / 今日主令 / 提醒节奏 */}
        <ScrollView scrollX className="exec-deck" enhanced showScrollbar={false}>
          <View className="exec-track">
            {/* 今日战役（深绿卡） */}
            {dossier ? (
              <View className="deck-card battle-card">
                <Text className="deck-k">今日战役 · {dateStr}</Text>
                <Text className="deck-title serif">{dossier.title}</Text>
                <Text className="deck-desc">源自认可方案 · 由{dossier.sourceAgent}生成 · 打卡记录，复盘定夺明日军令。</Text>
                <View className="deck-progress"><View className="deck-fill" style={{ width: `${progress.percent}%` }} /></View>
                <Text className="deck-foot">{progress.total ? `完成度 ${progress.percent}% · 21:30 复盘` : '待生成军令 · 21:30 复盘'}</Text>
              </View>
            ) : (
              <View className="deck-card battle-card" onClick={() => Taro.switchTab({ url: '/pages/sessions/index' })}>
                <Text className="deck-k">今日战役 · {dateStr}</Text>
                <Text className="deck-title serif">还没有执行中的战役</Text>
                <Text className="deck-desc">与军师对话并「认可方案」后，方案自动拆解为军令，按日打卡、录入、复盘。</Text>
                <Text className="deck-foot">去参谋室发起诊断 ›</Text>
              </View>
            )}

            {/* 军师献策（绿框卡）：案卷军令前三步 */}
            <View className="xiance-card">
              <Text className="xiance-k">军师献策 · {dossier ? '本期破局三步' : '如何开始'}</Text>
              {xianceSteps.map((step, i) => (
                <View key={step} className="xiance-step">
                  <View className="xiance-no"><Text>{i + 1}</Text></View>
                  <Text className="xiance-text">{step}</Text>
                </View>
              ))}
              <Text className="xiance-source">{xianceSource}</Text>
            </View>

            {/* 今日主令 */}
            <View className="deck-card">
              <Text className="deck-k green">今日主令</Text>
              <Text className="deck-title serif">{mainOrderTitle}</Text>
              <Text className="deck-desc">{mainOrderDesc}</Text>
              <View className="deck-btn" onClick={mainOrderAction}>
                <Text>{mainOrderButton}</Text>
              </View>
            </View>

            {/* 提醒节奏（连续复盘天数=服务端真实计数） */}
            <View className="deck-card" onClick={() => setView('review')}>
              <Text className="deck-k green">提醒节奏</Text>
              <Text className="deck-title serif">21:30 复盘</Text>
              <Text className="deck-desc">录入今日线索、咨询、成交，据此校准明日军令。</Text>
              <Text className="deck-foot muted">{streak ? `连续复盘 ${streak} 天 · 别断` : '可订阅复盘提醒'}</Text>
            </View>
          </View>
        </ScrollView>

        {/* 执行信号（exec-stats） */}
        <View className="exec-stats">
          <View className="exec-stat card"><Text className="stat-n serif">{todayOrders.length ? pendingTodayOrders.length : '—'}</Text><Text className="stat-l">待执行军令</Text></View>
          <View className="exec-stat card" onClick={() => goChat('general', '帮我补齐军师档案：你先问我最关键的 1-3 个问题，我来答。')}>
            <Text className={`stat-n serif ${und?.nextQuestions.length ? 'warn' : ''}`}>{und ? und.nextQuestions.length : '—'}</Text>
            <Text className="stat-l">待补资料</Text>
          </View>
          <View className="exec-stat card" onClick={() => setView('review')}><Text className="stat-n serif">21:30</Text><Text className="stat-l">复盘提醒</Text></View>
        </View>

        {/* 总军师督战（advisor-card 紧凑行） */}
        <View className="advisor-card card" onClick={() => openAgent('general')}>
          <AdvisorAvatar agentKey="general" size={42} online />
          <View className="ac-b">
            <Text className="ac-t serif">总军师督战</Text>
            <Text className="ac-d">{dossier ? '打卡与数据悉数呈报总军师，据此调度明日安排。' : '认可方案后，各军师的动作会汇总到这里协同推进。'}</Text>
          </View>
          <Text className="ac-go">去对话</Text>
        </View>

        {/* 今日最重要（today-focus 深绿条） */}
        {focus ? (
          <View className="today-focus" onClick={focus.act}>
            <View className="tf-b">
              <Text className="tf-t serif">{focus.t}</Text>
              <Text className="tf-d">{focus.d}</Text>
            </View>
            <Text className="tf-em">优先级 1</Text>
          </View>
        ) : null}

        {/* 目标阶梯（goal-ladder）：结构化目标体系待后端建模，先由军师拆解 */}
        <View className="goal-ladder" onClick={() => goChat('strat', '帮我把目标拆成阶梯：3-5 年、年度、季度、本周各一句话 + 关键指标。')}>
          {['3-5年', '年度', '季度', '本周'].map((k) => (
            <View key={k} className="gl-cell card">
              <Text className="gl-k">{k}</Text>
              <Text className="gl-v">待拆解</Text>
            </View>
          ))}
        </View>

        {/* 视图切换（exec-seg）：今日军令 / 周计划 / 复盘 */}
        <View className="exec-seg">
          {([['today', '今日军令'], ['week', '周计划'], ['review', '复盘']] as [ExecView, string][]).map(([key, label]) => (
            <View key={key} className={`seg-item ${view === key ? 'on' : ''}`} onClick={() => setView(key)}>
              <Text>{label}</Text>
            </View>
          ))}
        </View>

        {view === 'today' ? (
          <>
            {/* 第 0 号军令（command-card 金边）：补资料（军师档案真实待补问题） */}
            {und?.nextQuestions.length ? (
              <View className="command-card card" onClick={() => goChat('general', '帮我补齐军师档案：你先问我最关键的 1-3 个问题，我来答。')}>
                <Text className="command-badge">第 0 号军令 · 补资料</Text>
                <Text className="command-title serif">{und.nextQuestions[0]}</Text>
                <Text className="command-desc">补齐后，军师会重算判断和任务优先级 · 还有 {und.nextQuestions.length} 条待补</Text>
                <Text className="payoff">补齐后，战局判断与军师档案同步更新</Text>
              </View>
            ) : null}

            {/* 今日军令打卡（task 卡） */}
            {pendingTodayOrders.length === 0 && doneTodayOrders.length === 0 ? (
              <View className="orders-empty card" onClick={genOrders}>
                <Text className="oe-t serif">今天还没有军令</Text>
                <Text className="oe-d">{dossier ? '让军师根据案卷生成今天最重要的 1-3 件事。' : '认可一份军师方案后，这里会自动生成今日军令。'}</Text>
                <Text className="oe-go">{dossier ? '生成今日军令 ›' : '去对话 ›'}</Text>
              </View>
            ) : (
              pendingTodayOrders.map((o) => (
                <View key={o.id} className={`task card ${o.done ? 'done' : ''}`} onLongPress={() => onRemove(o.id)}>
                  <View className="task-b">
                    <View className="task-meta-row"><Text className="task-pill">{orderTagLabel(o.tag)}</Text></View>
                    <Text className="task-t serif">{o.text}</Text>
                    <View className="task-meta-row"><Text className="task-pill sub">来自 {o.from}</Text><Text className="task-pill sub">长按删除</Text></View>
                  </View>
                  <View className="task-check" onClick={() => onToggle(o.id)}>
                    {o.done ? <Icon name="check" size={14} color="#fff" /> : null}
                  </View>
                </View>
              ))
            )}

            {doneTodayOrders.length ? (
              <View className="done-archive card">
                <View className="da-head" onClick={() => setShowDoneArchive((v) => !v)}>
                  <View className="da-b">
                    <Text className="da-k">已归档</Text>
                    <Text className="da-t serif">{doneTodayOrders.length} 条完成项已收起</Text>
                    <Text className="da-d">复盘、周计划与战报皆据此追溯。</Text>
                  </View>
                  <Text className="da-action">{showDoneArchive ? '收起' : '查看'}</Text>
                </View>
                {showDoneArchive ? (
                  <View className="da-list">
                    {doneTodayOrders.map((o) => (
                      <View key={o.id} className="archived-task" onLongPress={() => onRemove(o.id)}>
                        <View className="task-b">
                          <View className="task-meta-row"><Text className="task-pill sub">来自 {o.from}</Text><Text className="task-pill sub">长按删除</Text></View>
                          <Text className="archive-task-text serif">{o.text}</Text>
                        </View>
                        <View className="archive-check" onClick={() => onToggle(o.id)}>
                          <Icon name="check" size={13} color="#fff" />
                        </View>
                      </View>
                    ))}
                  </View>
                ) : null}
              </View>
            ) : null}

            {/* 手动补一条军令 */}
            <View className="order-add">
              <Input
                className="oa-input"
                value={newOrder}
                placeholder="自己补一条今日军令…"
                onInput={(e) => setNewOrder(e.detail.value)}
                onConfirm={onAdd}
              />
              <View className="oa-btn" style={{ background: accent }} onClick={onAdd}><Text>添加</Text></View>
            </View>

            {/* 今日数据回填（data-fill） */}
            <View className="data-fill">
              <View className="df-head">
                <Text className="df-t serif">今日经营数据</Text>
                <Text className={`df-s ${backfillSaved ? 'ok' : ''}`}>{backfillSaved ? '已记录' : '3 个数'}</Text>
              </View>
              <View className="df-row">
                {([['leads', '线索'], ['consults', '咨询'], ['deals', '成交']] as const).map(([key, label]) => (
                  <View key={key} className="df-cell">
                    <Text className="df-label">{label}</Text>
                    <Input
                      className="df-input"
                      type="number"
                      value={bf[key]}
                      placeholder="__"
                      onInput={(e) => setBf((cur) => ({ ...cur, [key]: e.detail.value }))}
                    />
                  </View>
                ))}
              </View>
              <View className="df-save" onClick={onSaveBackfill}><Text>保存数据</Text></View>
              <Text className="payoff">军师复盘时据此校准，必要时调整明日军令</Text>
            </View>

            {/* 复盘前检查（review-before，真实状态） */}
            <View className="review-before card">
              <Text className="rb-k">复盘前检查</Text>
              <View className="rb-line">
                <Text className={`rb-state ${progress.total && progress.done < progress.total ? 'warn' : ''}`}>{progress.total ? `${progress.done}/${progress.total}` : '待生成'}</Text>
                <Text className="rb-text">今日军令完成情况</Text>
              </View>
              <View className="rb-line">
                <Text className={`rb-state ${backfillSaved ? '' : 'warn'}`}>{backfillSaved ? '已记录' : '待记录'}</Text>
                <Text className="rb-text">线索 / 咨询 / 成交三个数</Text>
              </View>
              <View className="rb-line" onClick={genReview}>
                <Text className="rb-state">21:30</Text>
                <Text className="rb-text">生成今日复盘，决定明日是否调整军令</Text>
              </View>
            </View>
          </>
        ) : null}

        {view === 'week' ? (
          weekGroups.length === 0 ? (
            <View className="orders-empty card" onClick={genOrders}>
              <Text className="oe-t serif">本周还没有军令记录</Text>
              <Text className="oe-d">认可方案或生成今日军令后，这里按天沉淀执行记录。</Text>
              <Text className="oe-go">生成今日军令 ›</Text>
            </View>
          ) : (
            <View className="week-list card">
              {weekGroups.map((g) => (
                <View key={g.date} className="week-group">
                  <Text className="wg-date serif">{dateLabel(g.date)}</Text>
                  {g.orders.map((o) => (
                    <View key={o.id} className="wg-row">
                      <Text className={`wg-state ${o.done ? 'ok' : ''}`}>{o.done ? '✓' : '·'}</Text>
                      <Text className={`wg-text ${o.done ? 'done' : ''}`}>{o.text}</Text>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          )
        ) : null}

        {view === 'review' ? (
          <>
            <View className="review-card card">
              <Text className="rc-k">今晚复盘{streak ? ` · 已连续 ${streak} 天` : ''}</Text>
              <Text className="rc-t">军师依今日军令完成度与实绩数据，诊断症结，给出明日军令。</Text>
              <Text className="payoff">依据：今日军令 {progress.done}/{progress.total || 0} · 数据{backfillSaved ? '已录' : '未录'}</Text>
              <View className="rc-btn" onClick={genReview}>
                <Icon name="doc" size={15} color="#fff" />
                <Text>生成今日复盘</Text>
              </View>
              <View className="rc-btn ghost" onClick={shareDailyCard}>
                <Icon name="image" size={15} color={accent} />
                <Text>生成每日战报卡（可分享）</Text>
              </View>
            </View>
            <View className="remind card">
              <View className="remind-head"><Text className="remind-k serif">提醒节奏</Text><Text className="remind-soon">订阅提醒 · 即将开放</Text></View>
              {REMINDERS.map((r) => (
                <View key={r.time} className="remind-row">
                  <Text className="remind-time">{r.time}</Text>
                  <Text className="remind-text">{r.text}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        {/* AI 创作发布：创作型智能体（出活） */}
        <View className="sec-head">
          <Text className="sec-title">AI 创作发布</Text>
          <Text className="sec-more">把军令变成内容资产</Text>
        </View>
        <View className="agrid">
          {creative.map((a) => {
            const locked = a.billing === 'unlock' && !a.owned;
            return (
              <View key={a.key} className={`acard card ${locked ? 'locked' : ''}`} onClick={() => tapCreative(a)}>
                <Badge agent={a} accent={accent} />
                <View className="ai" style={{ background: 'var(--accent-soft)' }}><Icon name={a.icon} size={18} color={accent} /></View>
                <Text className="ah">{a.name}</Text>
                <Text className="ap">{a.role}</Text>
                {locked
                  ? <Text className="ameta lock" style={{ color: accent }}>{diamondCost(a.price)} ›</Text>
                  : a.billing === 'metered'
                    ? <Text className="ameta" style={{ color: accent }}>{diamondCost(a.price, true)} · {a.deliverableKey}</Text>
                    : a.deliverableKey && <Text className="ameta" style={{ color: accent }}>擅长 · {a.deliverableKey}</Text>}
                {a.meterUnit !== 'image' && (a.billingRatio ?? 1) > 1 && (
                  <Text className="ameta" style={{ color: accent, opacity: 0.72 }}>倍率 ×{a.billingRatio} · 额度消耗更快</Text>
                )}
              </View>
            );
          })}
        </View>

        <View className="exec-cta" onClick={todayOrders.length ? genReview : genOrders}>
          <Icon name={todayOrders.length ? 'doc' : 'check'} size={16} color="#FBFAF6" />
          <Text>{todayOrders.length ? '录入今日战果 · 生成复盘' : '让军师生成今日军令'}</Text>
        </View>
      </View>

      <AgentUnlock agent={buying} onClose={() => setBuying(null)} onUnlocked={(a) => { setBuying(null); openAgent(a.key); }} />
    </Screen>
  );
}

// 智能体角标：可用 / 已启用 / 按需 / 锁
function Badge({ agent, accent }: { agent: Agent; accent: string }) {
  if (agent.billing === 'free') return <View className="gift" style={{ background: accent }}>可用</View>;
  if (agent.billing === 'metered') return <View className="gift metered" style={{ background: accent }}>按需</View>;
  if (agent.owned) return <View className="gift owned"><Icon name="check" size={9} color="#fff" /><Text> 已启用</Text></View>;
  return <View className="gift locked-badge"><Icon name="lock" size={9} color="#fff" /></View>;
}
