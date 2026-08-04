import { useState } from 'react';
import type { ReactNode } from 'react';
import { View, Text, Image, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import TabHeader from '../../components/TabHeader';
import Icon from '../../components/Icon';
import Login from '../../components/Login';
import BaseSheet from '../../components/Sheet';
import CoachMarks from '../../components/CoachMarks';
import { navTo, switchTo } from '../../services/nav';
import { REVIEW_TIME } from '../../data/constants';
import { archiveAnswerPrompt } from '../../data/intents';
import { useStore } from '../../hooks/useStore';
import { api, type ProgressView, type StrategicProfileView, type WorkbenchView } from '../../services/api';
import './index.scss';

type SheetKey = '' | 'workbench' | 'teacher' | 'group';

// 我的页 —— 对齐设计稿 page-profile（V7-13）：居中标题 / 深绿账户服务卡（社群 + 邀请码 + 权益三格 + 服务动作）
// / 统计 / 菜单 / 服务老师 · 群二维码 · 档案工作台半屏详情。
export default function Profile() {
  const s = useStore();
  const color = s.color();
  const accent = color.vars['--accent'];
  const me = s.me();
  const svc = me?.service ?? null;
  const [libCount, setLibCount] = useState(0);
  const [projCount, setProjCount] = useState(0);
  const [reportCount, setReportCount] = useState(0);
  const [prog, setProg] = useState<ProgressView | null>(null);
  const [strategic, setStrategic] = useState<StrategicProfileView | null>(null);
  const [workbench, setWorkbench] = useState<WorkbenchView | null>(null);
  const [sheet, setSheet] = useState<SheetKey>('');
  const [showLogin, setShowLogin] = useState(() => !s.isAuthed());

  // C1：登录后才拉数据（未登录不再空拉 api.library 等弹错误 toast）。
  const loadProfile = () => {
    api.library().then((l) => setLibCount(l.length)).catch((e) => s.handleApiError(e));
    api.projects().then((p) => setProjCount(p.length)).catch((e) => s.handleApiError(e));
    api.reports().then((r) => setReportCount(r.length)).catch(() => {});
    api.progress().then((r) => setProg(r.progress)).catch(() => setProg(null));
    // 年度谶语（战略档案）：失败/无档案静默落到求谶引导态，不弹错
    api.strategicProfile().then((r) => setStrategic(r.strategic)).catch(() => setStrategic(null));
    api.workbench().then(setWorkbench).catch((e) => { s.handleApiError(e, { silent: true }); setWorkbench(null); });
  };

  useDidShow(() => {
    s.setTab(4);
    if (!s.isAuthed()) { setShowLogin(true); return; }
    loadProfile();
    void s.loadBadges(); // 底栏角标搭车刷新（内部 15 秒节流）
  });

  // 案卷完整度：优先 workbench.completeness，缺失时按理解成熟度兜底。
  const completeness = workbench ? workbench.completeness : maturityPct(me?.understanding?.maturity);
  const wbSections = workbench?.sections ?? [];
  const wbMissing = workbench?.missing ?? [];

  // 账户权益三格（新设计稿 account-benefit-grid）：算力 / 深度报告 / 企业服务。
  // 与旧 membership-strip 的差别：不再是「大数字 + 标签」，而是「权益名 + 一句状态」——每格都是状态加动作。
  // 数值口径：算力 = 本月用量 %（PublicUsageView，不公开原始额度）+ 可见钻石余额（对外统一叫算力，V7 D-4）；
  // 深度报告 = 创始人战略档案（军师执笔的长文报告），不编造「本月可用 N 次」这种没有数据源的次数；
  // 案卷完整度从这里挪走 → 落到「个人 / 企业档案」菜单行的右值（设计稿同一处置）。
  const benefits: { t: string; s: string; onClick: () => void }[] = [
    { t: '算力', s: powerLine(me), onClick: () => navTo('/packages/work/credits/index') },
    { t: '深度报告', s: '军师执笔', onClick: () => openDossier() }, // openDossier 在下方声明，包一层箭头避开 TDZ
    { t: '企业服务', s: '工商 / 财税 / 商标', onClick: () => navTo('/packages/work/enterprise/index') },
  ];

  const openTeacher = () => { if (svc) setSheet('teacher'); else Taro.showToast({ title: '服务老师分配后开放', icon: 'none' }); };
  const openGroup = () => { if (svc) setSheet('group'); else Taro.showToast({ title: '社群分配后开放', icon: 'none' }); };
  const goCommunity = () => navTo('/packages/work/community/index'); // 未分配态双卡的去处：分班申请
  const openDossier = () => {
    const started = navTo('/packages/work/dossier/index', {
      fail: () => Taro.showToast({ title: '完整履历页面加载失败，请重试', icon: 'none' }),
    });
    if (!started) Taro.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  };
  const closeSheet = () => setSheet('');
  const goFill = () => { setSheet(''); switchTo('/pages/thinktank/index'); };
  // 「当前最该补」其实混了两类东西（服务端 community.ts）：
  //   next-*  → understanding.nextQuestions，是**要在对话里回答的问题**（「你的公司叫什么？」）
  //   其它    → FALLBACK_MISSING，是**要上传的资料**（价格体系 / 成交漏斗表 / 案例证明）
  // 以前两类都跳智库上传，于是点一条问句会被送去传文件。按 key 分流：问句进对话并带上原话。
  const fillMissing = (m: { key: string; title: string }) => {
    if (!m.key.startsWith('next-')) { goFill(); return; }
    setSheet('');
    navTo(`/packages/main/chat/index?agentKey=general&continue=1&send=${encodeURIComponent(archiveAnswerPrompt(m.title))}`);
  };

  const copyWechat = () => {
    if (!svc) return;
    Taro.setClipboardData({ data: svc.teacherWechat })
      .then(() => Taro.showToast({ title: '微信号已复制', icon: 'none' }))
      .catch(() => {});
  };
  const saveQr = () => {
    const url = svc?.groupQrUrl;
    if (!url) return;
    Taro.showLoading({ title: '保存中…' });
    Taro.downloadFile({ url })
      .then((r) => { if (r.statusCode !== 200) throw new Error('download failed'); return Taro.saveImageToPhotosAlbum({ filePath: r.tempFilePath }); })
      .then(() => { Taro.hideLoading(); Taro.showToast({ title: '已保存到相册', icon: 'success' }); })
      .catch(() => { Taro.hideLoading(); Taro.showToast({ title: '保存失败，可长按二维码保存', icon: 'none' }); });
  };

  const fortuneOn = s.fortuneOn(); // P0-2：命理关 → 隐藏「送你一卦」入口

  // 年度谶语（留存机制 #16 M1）：并入账户服务卡尾部的题字带，不再单独占一张白卡（原来夹在「档案」组标题
  // 和菜单之间，上下都是卡、空间散）。题字带与卡内其它行同宽同边距——卡内只保留一套对齐，不另开边栏，
  // 否则权益格/服务格/落款会各自一个右边界，看着错乱。无谶 → 同一条带里一行求谶引导（点进命盘报告）。
  // 命理开关关闭时整块不渲染（与命盘报告入口同一 gating）。
  const verse = (strategic?.verse || '').trim();
  const verseGanZhi = ganZhiYear(strategic?.verseYear);
  // 周期陪伴：军师全年把真实事件对到谶上（点谶）。无记录时这行落到岁验预告，不留空。
  const moments = strategic?.verseMoments ?? [];
  const lastMoment = moments.length ? moments[moments.length - 1] : null;
  const verseBand = !fortuneOn ? null : verse ? (
    <View className="verse-band">
      <View className="vb-head">
        <Text className="vb-kicker">年 度 谶 语</Text>
        <Text className="vb-sign serif">{verseGanZhi ? `${verseGanZhi}年 · 军师赠` : '军师赠'}</Text>
      </View>
      <View className="vb-lines">
        {verseLines(verse).map((line, i) => (
          <Text key={`vb-${i}`} className="vb-line serif">{line}</Text>
        ))}
      </View>
      <Text className="vb-moment">
        {lastMoment ? `已点谶 ${moments.length} 次 · 最近：${lastMoment.note}` : '岁末逐句对账'}
      </Text>
    </View>
  ) : (
    <View className="verse-band verse-ask" onClick={() => navTo('/packages/work/mingpan/index')}>
      <Text className="va-t">年度谶语 · 你还没有今年的谶</Text>
      <Text className="va-go">去命盘领一句 ›</Text>
    </View>
  );

  // 菜单收敛（23 → 12 行）：只留设计稿六行 + 无第二入口的四个功能面，按「同一去处只保留一个入口」删并：
  // - 完整履历 → 账户卡「深度报告」格；我的案卷/方案库/资料库 → 统计三格；方案与权益 → 会员牌；
  //   订单/算力明细 → 「算力」权益格；军师社群 → 未分配时点老师/群卡直达分班页。
  // - 军师对我的理解 → 档案工作台 sheet 内；送你一卦 → 命盘报告页内；本命色 → 设置页「偏好」；
  //   私有化部署 → 企业服务页尾。
  // - 「账户」组整组消失：账户能力全部住在账户卡上（权益格 + 会员牌 + 老师/群双卡），正是设计稿意图。
  type MenuRow = { ic: string; t: string; s: string; onClick: () => void };
  const menuGroups: { title: string; rows: MenuRow[] }[] = [
    {
      title: '档案',
      rows: [
        // 设计稿的「个人 / 企业档案 · 待补 N 项」：右值是状态 + 动作，点开档案工作台（案卷完整度四分区 + 当前最该补）。
        { ic: 'grid', t: '个人 / 企业档案', s: wbMissing.length ? `待补 ${wbMissing.length} 项` : `完整度 ${completeness}%`, onClick: () => setSheet('workbench') },
        // 公司与事业架构：设计稿里由战略报告识别到多主体需求后才亮（architectureEnabled）；
        // 后端还没有这个识别信号，先常驻显示并落「待建立」态，不做假的条件隐藏。
        { ic: 'flow', t: '公司与事业架构', s: '待建立', onClick: () => navTo('/packages/work/architecture/index') },
        ...(fortuneOn ? [
          { ic: 'trend', t: '命盘报告 · 八字紫微印证', s: '', onClick: () => navTo('/packages/work/mingpan/index') },
        ] : []),
        // 人脉圈与持续记忆：设计稿新增的档案面——个人微信记忆授权 + 关系与承诺清单。
        { ic: 'user', t: '人脉圈与持续记忆', s: '未开通', onClick: () => navTo('/packages/work/relations/index') },
        { ic: 'flag', t: '战略账本 · 决策与天机', s: '决策记录', onClick: () => navTo('/packages/work/ledger/index') },
      ],
    },
    {
      title: '资产',
      rows: [
        // 作品库/品牌资产：全站唯一入口（studio 入口的旧注释已核实失效），不能删。
        // 刻意**不按出图开关隐藏**：这是回看已有资产的入口，不是出图入口（出图按钮的降级口径在作品库页内处理）。
        { ic: 'image', t: '我的作品库 · 历史成品图', s: '海报', onClick: () => navTo('/packages/work/gallery/index') },
        { ic: 'spark', t: '我的品牌资产', s: '数字人/短视频素材', onClick: () => navTo('/packages/work/brandkit/index') },
        { ic: 'chart', t: '数据授权与隐私', s: '', onClick: () => navTo('/packages/work/bindings/index') },
      ],
    },
    {
      title: '系统',
      rows: [
        { ic: 'clock', t: '提醒与日历', s: reminderHint(me?.service), onClick: () => navTo('/packages/work/reminders/index') },
        // 承接原页头右侧的「设置」（页头一律不放按钮）；本命色已并入设置页「偏好」小节。
        { ic: 'user', t: '设置 · 资料与偏好', s: '', onClick: () => navTo('/packages/main/settings/index') },
        { ic: 'grid', t: '模块管理 · 添加 / 隐藏', s: '', onClick: () => navTo('/packages/work/market/index') },
        {
          ic: 'lock', t: '退出登录', s: '',
          onClick: () =>
            Taro.showModal({ title: '退出登录', content: '确定退出当前账号？' }).then((r) => {
              if (r.confirm) { s.logout(); Taro.reLaunch({ url: '/pages/sessions/index' }); }
            }),
        },
      ],
    },
  ];

  return (
    <Screen topInset>
      <View className="pad account">
        {/* 页头（TabHeader）：小字用途 + 大字「老板」+ 背景「我」，不挂按钮。
            「设置」下移到下方「系统」菜单组首行。 */}
        <TabHeader title="老板" kicker="你自己" glyph="我" />

        {/* 账户服务卡（深绿 · §10.1）：头像 + 姓名 + 会员牌 / 手机·社群·邀请码 / 权益三格 / 服务动作 */}
        <View className="account-user-card account-service-card">
          <View className="service-card-top">
            {me?.user.avatarUrl ? (
              <Image className="au-av service-avatar" src={me.user.avatarUrl} mode="aspectFill" />
            ) : (
              <View className="au-av service-avatar au-av-ph serif">
                {me?.user.name ? me.user.name[0] : <Icon name="user" size={20} color="#fff" />}
              </View>
            )}
            <View className="sct-b" onClick={() => navTo('/packages/main/settings/index')}>
              <Text className="account-profile-name serif">{me?.user.name || '完善你的资料 ›'}</Text>
              {orgLine(me) ? <Text className="account-profile-role">{orgLine(me)}</Text> : null}
            </View>
            <Text className="member-pill" onClick={() => navTo('/packages/work/plans/index')}>{me?.plan?.name || '尚未开通'}</Text>
          </View>

          {/* 资料行（新设计稿 account-profile-meta）：收敛成「手机 / 邀请码」两行内联。
              「所在社群」不再单独占一行——它作为班级群卡的副标题出现，同一事实不在卡里写两遍。 */}
          <View className="account-profile-meta">
            <Text className="apm-line">手机 {maskPhone(me?.user.phone)}</Text>
            <Text className="apm-line">邀请码 <Text className="apm-code">{me?.inviteCode || '—'}</Text></Text>
          </View>

          {/* 账户权益三格（account-benefit-grid）：权益名 + 一句状态，取代原来的大数字三格 */}
          <View className="account-benefit-grid">
            {benefits.map((c) => (
              <View key={c.t} className="account-benefit" onClick={c.onClick}>
                <Text className="ab-t">{c.t}</Text>
                <Text className="ab-s">{c.s}</Text>
              </View>
            ))}
          </View>

          {/* 老师与社群双卡（新设计稿 service-action-row）：绿卡上的两张白卡，三个动作各自独立——
              点老师卡 → 老师详情；点卡内微信号 → 直接复制（不再要先进半屏再复制）；点班级群 → 群二维码。
              未分配时不再置灰锁死：两张卡都直达军师社群页（分班申请就是拿到老师和群的路径）——
              这也让原「军师社群」菜单行可删（同一去处只留一个入口）。 */}
          <View className="service-action-row">
            <View className={`service-action service-action-teacher ${svc ? '' : 'is-empty'}`}>
              <View className="service-action-main" onClick={svc ? openTeacher : goCommunity}>
                <Text className="sa-i serif">微</Text>
                <Text className="sa-t">{svc ? `${svc.teacherName}微信` : '老师微信'}</Text>
              </View>
              {svc ? (
                <View className="teacher-wechat-id" onClick={copyWechat}>
                  <Text className="twi-id">{svc.teacherWechat}</Text>
                  <Text className="twi-em">复制</Text>
                </View>
              ) : (
                <Text className="teacher-wechat-id twi-ph" onClick={goCommunity}>待分配 · 去申请分班 ›</Text>
              )}
            </View>
            <View className={`service-action service-action-group ${svc ? '' : 'is-empty'}`} onClick={svc ? openGroup : goCommunity}>
              <View className="sa-qr" aria-label="群二维码">
                <View className="sa-qr-d" /><View className="sa-qr-d" />
                <View className="sa-qr-d" /><View className="sa-qr-d is-hollow" />
              </View>
              <View className="sa-b">
                <Text className="sa-t">班级群</Text>
                <Text className="sa-s">{svc ? `${svc.className} · 服务中` : '去申请分班 ›'}</Text>
              </View>
            </View>
          </View>

          {/* 年度谶语题字带：卡尾用一条发丝线收口，与上面各行同宽 */}
          {verseBand}
        </View>

        {/* 经营统计（account-statline）：案卷 / 方案 / 资料（真实计数，四名词统一） */}
        <View className="account-statline">
          <View className="account-stat card" onClick={() => navTo('/packages/work/projects/index')}>
            <Text className="as-n serif">{projCount}</Text>
            <Text className="as-l">案卷</Text>
          </View>
          <View className="account-stat card" onClick={() => navTo('/packages/work/library/index')}>
            <Text className="as-n serif">{libCount + reportCount}</Text>
            <Text className="as-l">方案</Text>
          </View>
          <View className="account-stat card" onClick={() => navTo('/packages/work/knowledge/index')}>
            <Text className="as-n serif">{me?.understanding?.evidenceCount.knowledge ?? 0}</Text>
            <Text className="as-l">资料</Text>
          </View>
        </View>

        {/* 战略段位（M4 PR-18）：全部真实计数。WO-03 冷启动延迟曝光——攒够连续复盘/使用天数才亮相，
            不把「新兵·连续 0 天·准确率 —%」的空账本怼给新用户。 */}
        {prog && (prog.streak >= 3 || prog.usageDays >= 14) ? (
          <View className="rank-card card" onClick={() => navTo('/packages/work/ledger/index')}>
            <View className="rk-badge"><Text className="serif">{prog.rank}</Text></View>
            <View className="rk-b">
              <Text className="rk-t serif">战略段位 · {prog.rank}</Text>
              <Text className="rk-s">
                连续复盘 {prog.streak} 天 · 使用第 {prog.usageDays} 天
                {prog.decisionAccuracy !== null ? ` · 决策准确率 ${prog.decisionAccuracy}%` : ' · 先打满 5 个验证'}
              </Text>
              {prog.nextRank ? <Text className="rk-next">下一段位 {prog.nextRank.rank}：{prog.nextRank.requirement} ›</Text> : <Text className="rk-next">查看战略账本 ›</Text>}
            </View>
          </View>
        ) : null}

        {/* 菜单（design menu：左侧色块图标 + 右值）· C7 按 档案/资产/账户/系统 分组，行样式不变 */}
        {menuGroups.map((g) => (
          <View key={g.title} className="menu-group">
            <Text className="menu-group-title">{g.title}</Text>
            <View className="menu card">
              {g.rows.map((r) => (
                <View key={r.t} className="menu-row" onClick={r.onClick}>
                  <View className="menu-ic"><Icon name={r.ic} size={14} color={accent} /></View>
                  <Text className="menu-t">{r.t}</Text>
                  <Text className="menu-s">{r.s}</Text>
                  <Text className="menu-go">›</Text>
                </View>
              ))}
            </View>
          </View>
        ))}

        {/* 页尾原有「军师社群 · 服务老师」与「进阶能力」两张卡按新设计稿移除：
            前者与账户卡的老师/班级群双卡重复，后者与会员牌 + 算力权益格重复。
            两个去处已改挂到「账户」菜单组，同一件事不在一页里出现两次。 */}
      </View>

      {/* 档案工作台（§10.4 profile-files 半屏详情） */}
      <Sheet open={sheet === 'workbench'} onClose={closeSheet} sheetKey="pf-workbench">
        <View className="pf-head">
          <Text className="pf-kicker">案 卷 档 案</Text>
          <Text className="pf-title serif">个人 / 企业档案</Text>
        </View>
        <ScrollView scrollY className="pf-body">
          <View className="profile-file-summary">
            <Text className="pfs-k">当前档案完整度</Text>
            <Text className="pfs-v serif">{completeness}%</Text>
            <Text className="pfs-d">还差 {wbMissing.length} 项，补齐后会刷新战局判断和深度报告引用。</Text>
            <View className="profile-file-progress"><View className="pfp-i" style={{ width: `${completeness}%`, background: accent }} /></View>
          </View>

          <View className="profile-file-sections">
            {wbSections.map((sec) => (
              <View key={sec.key} className="profile-file-section">
                <View className="pfsec-b">
                  <Text className="pfsec-t">{sec.label}</Text>
                  <Text className="pfsec-h">{sec.hint}</Text>
                </View>
                <Text className={`pfsec-c ${sec.ready && sec.count > 0 ? 'ok' : 'miss'}`}>{sec.ready && sec.count > 0 ? `${sec.count} 份` : '待补'}</Text>
              </View>
            ))}
          </View>

          {/* 军师对我的理解（brief）：原菜单行并进档案工作台——它就是档案的「军师视角摘要」，
              单独占一行菜单和「个人 / 企业档案」在语义上打架。关 sheet 再跳，返回时不叠层。 */}
          <View className="pf-fieldrow" onClick={() => { closeSheet(); navTo('/packages/main/brief/index'); }}>
            <Text className="pf-fk">军师对我的理解</Text>
            <Text className="pf-fv-go">{briefLine(me?.understanding) || '查看'} ›</Text>
          </View>

          <View className="profile-missing-list">
            <View className="pml-head">
              <Text className="pml-t">当前最该补</Text>
              <Text className="pml-s">按对战局判断的影响排序，补完会同步刷新案卷完整度。</Text>
            </View>
            {wbMissing.map((m, i) => (
              <View key={m.key} className="profile-missing-row">
                <Text className="pmr-i serif">{i + 1}</Text>
                <View className="pmr-b">
                  <Text className="pmr-t">{m.title}</Text>
                  <Text className="pmr-s">{m.desc}</Text>
                </View>
                <Text className="pmr-go" onClick={() => fillMissing(m)}>去补</Text>
              </View>
            ))}
          </View>
        </ScrollView>
        <View className="pf-primary" onClick={goFill}><Text>去补资料</Text></View>
      </Sheet>

      {/* 服务老师微信（§10.4 teacher-wechat） */}
      <Sheet open={sheet === 'teacher'} onClose={closeSheet} sheetKey="pf-teacher">
        <View className="pf-head">
          <Text className="pf-kicker">服 务 老 师</Text>
          <Text className="pf-title serif">{svc ? `${svc.teacherName}微信` : '服务老师'}</Text>
        </View>
        <View className="pf-body">
          <View className="profile-teacher-card">
            <Text className="ptc-av serif">{svc?.teacherName?.[0] || '师'}</Text>
            <View className="ptc-b">
              <Text className="ptc-name serif">{svc?.teacherName || '服务老师'}</Text>
              <Text className="ptc-desc">{svc ? `${svc.className}服务老师 · 微信号 ${svc.teacherWechat} · ${svc.note}` : '分配后开放'}</Text>
            </View>
          </View>
          <View className="pf-fieldrow">
            <Text className="pf-fk">微信号</Text>
            <Text className="pf-fv serif">{svc?.teacherWechat || '—'}</Text>
          </View>
        </View>
        <View className="pf-primary" onClick={copyWechat}><Text>复制微信号</Text></View>
      </Sheet>

      {/* 群二维码（§10.4 group-qr） */}
      <Sheet open={sheet === 'group'} onClose={closeSheet} sheetKey="pf-group">
        <View className="pf-head">
          <Text className="pf-kicker">社 群 二 维 码</Text>
          <Text className="pf-title serif">{svc ? `${svc.className}群二维码` : '社群二维码'}</Text>
        </View>
        <View className="pf-body">
          <View className="profile-qr-card">
            {svc?.groupQrUrl ? (
              <Image className="pf-qr" src={svc.groupQrUrl} mode="aspectFit" showMenuByLongpress onClick={() => Taro.previewImage({ urls: [svc.groupQrUrl] })} />
            ) : (
              <View className="pf-qr pf-qr-ph"><Text className="pf-qr-pht">二维码待分配</Text></View>
            )}
            <Text className="pf-qr-tip">二维码有效期 7 天，过期可让服务老师重新发送。</Text>
            <Text className="pf-qr-tip">入群后请备注：{me?.user.name || '本人'} / 手机尾号 {phoneTail(me?.user.phone)}。</Text>
          </View>
          <View className="pf-taskbar">
            <Text className="pf-tk">入群任务</Text>
            <Text className="pf-tv serif">{svc ? `${svc.taskDone} / ${svc.taskTotal}` : '—'}</Text>
          </View>
        </View>
        <View className={`pf-primary ${svc?.groupQrUrl ? '' : 'is-disabled'}`} onClick={saveQr}><Text>{svc?.groupQrUrl ? '保存二维码' : '二维码待分配'}</Text></View>
      </Sheet>


      {/* C1：登录门（对齐 sessions/home）——未登录先引导，登录后再拉我的页数据 */}
      <Login open={showLogin} onLoggedIn={() => { setShowLogin(false); loadProfile(); }} />
      <CoachMarks />
    </Screen>
  );
}

// 半屏详情外壳：收敛至 Sheet 基座（五要素 + setOverlay 底栏协调统一）；此处仅保留 profile 专属 padding/grip 间距（pf-pad）。
function Sheet({ open, onClose, sheetKey, children }: { open: boolean; onClose: () => void; sheetKey: string; children: ReactNode }) {
  return (
    <BaseSheet visible={open} onClose={onClose} overlayKey={sheetKey} panelClassName="pf-pad">
      {children}
    </BaseSheet>
  );
}

// 企业行：公司 · 行业，缺失项自动省略；都没有则返回空（由调用方走「完善资料」提示）。
function orgLine(me: { tenant: { name?: string | null; industry?: string | null } } | null): string {
  if (!me) return '';
  return [me.tenant.name, me.tenant.industry].filter(Boolean).join(' · ');
}

// 手机脱敏：138****8626；非法/缺失 → 未绑定。
function maskPhone(phone?: string): string {
  if (!phone || !/^1\d{10}$/.test(phone)) return '未绑定';
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}
// 手机尾号（入群备注用），缺失 → ****。
function phoneTail(phone?: string): string {
  if (!phone || phone.length < 4) return '****';
  return phone.slice(-4);
}

// 算力权益格右侧状态行：本月用量 % + 可见的算力（钻石）余额。
// 只用 PublicUsageView 的百分比，不落原始 token 额度（契约：用户侧不读取内部额度原值）；
// 余额用 creditBalance——它本来就是对用户可见的那本账（解锁顾问 / 出图按张）。
// usage 按契约是必填，但这里跟着原来的写法保持可选取值（`me?.usage?.usagePercent ?? 0`）：
// 老版本 /me 或缓存档案缺这一段时，直接解引用会抛在 render 里，把老板 tab 整页打白——
// 一个权益格的数字不值这个风险。
function powerLine(me: { usage?: { usagePercent?: number; unlimited?: boolean }; creditBalance?: number } | null): string {
  if (!me) return '—';
  if (me.usage?.unlimited) return '不限量';
  const used = `已用 ${me.usage?.usagePercent ?? 0}%`;
  const bal = me.creditBalance;
  if (typeof bal !== 'number') return used;
  return bal < 0 ? `${used} · 余不限量` : `${used} · 余 ${bal}`;
}

// 案卷完整度兜底（workbench 拉取失败时按理解成熟度估算）。
function maturityPct(m?: string): number {
  if (m === 'ready') return 85;
  if (m === 'forming') return 55;
  return 20;
}
// —— 年度谶语卡 —— //
const TIAN_GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
const DI_ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
// 干支纪年（天干 (y-4)%10 / 地支 (y-4)%12，如 2026 → 丙午）；年份缺失返回空串 → 落款只写「军师赠」。
function ganZhiYear(y?: number | null): string {
  if (typeof y !== 'number' || !Number.isFinite(y)) return '';
  const g = (((y - 4) % 10) + 10) % 10;
  const z = (((y - 4) % 12) + 12) % 12;
  return `${TIAN_GAN[g]}${DI_ZHI[z]}`;
}
// 断句：按标点切句，一句一行（居中排，读起来是一副对子），标点不入行；最多 4 行。
// 无标点连写的长句（如两句七言写成一串）按 7 字再断，免得单行过长撑破卡宽。
function verseLines(verse: string): string[] {
  const lines: string[] = [];
  for (const seg of verse.split(/[，,。.；;、！!？?｜|/\s]+/)) {
    const chars = Array.from(seg.trim());
    if (!chars.length) continue;
    if (chars.length > 8) {
      for (let i = 0; i < chars.length; i += 7) lines.push(chars.slice(i, i + 7).join(''));
    } else {
      lines.push(chars.join(''));
    }
  }
  return lines.slice(0, 4);
}

// 提醒菜单右值：有社群显示复盘时间，否则留空。
function reminderHint(service?: { className: string } | null): string {
  return service ? REVIEW_TIME : '';
}

function briefLine(understanding?: { maturity: string; evidenceCount: { memories: number; projects: number; knowledge: number; sessions: number } }): string {
  if (!understanding) return '';
  if (understanding.maturity === 'ready') return '可用于咨询';
  const count = understanding.evidenceCount.memories + understanding.evidenceCount.projects + understanding.evidenceCount.knowledge + understanding.evidenceCount.sessions;
  return count ? `${count} 条线索` : '待补资料';
}
