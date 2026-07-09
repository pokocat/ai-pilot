import { useState, useEffect } from 'react';
import type { ReactNode } from 'react';
import { View, Text, Image, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import Screen from '../../components/Screen';
import Icon from '../../components/Icon';
import Picker from '../../components/Picker';
import Plans from '../../components/Plans';
import { useStore } from '../../hooks/useStore';
import { store } from '../../services/store';
import { api, type ProgressView, type WorkbenchView } from '../../services/api';
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
  const [showPicker, setShowPicker] = useState(false);
  const [showPlans, setShowPlans] = useState(false);
  const [prog, setProg] = useState<ProgressView | null>(null);
  const [workbench, setWorkbench] = useState<WorkbenchView | null>(null);
  const [sheet, setSheet] = useState<SheetKey>('');

  useDidShow(() => {
    s.setTab(4);
    api.library().then((l) => setLibCount(l.length)).catch((e) => s.handleApiError(e));
    api.projects().then((p) => setProjCount(p.length)).catch((e) => s.handleApiError(e));
    api.reports().then((r) => setReportCount(r.length)).catch(() => {});
    api.progress().then((r) => setProg(r.progress)).catch(() => setProg(null));
    api.workbench().then(setWorkbench).catch((e) => { s.handleApiError(e, { silent: true }); setWorkbench(null); });
  });

  // 案卷完整度：优先 workbench.completeness，缺失时按理解成熟度兜底。
  const completeness = workbench ? workbench.completeness : maturityPct(me?.understanding?.maturity);
  const wbSections = workbench?.sections ?? [];
  const wbMissing = workbench?.missing ?? [];

  // 权益三格（§10.1 membership-strip）：本月算力 % / 案卷完整度 %。深度报告次数无 plan features 数据 → 隐藏。
  const strip: { l: string; v: string; onClick: () => void }[] = [
    { l: '本月算力', v: powerPct(me?.tokenQuota), onClick: () => setShowPlans(true) },
    { l: '案卷完整度', v: `${completeness}%`, onClick: () => setSheet('workbench') },
  ];

  const openTeacher = () => { if (svc) setSheet('teacher'); else Taro.showToast({ title: '服务老师分配后开放', icon: 'none' }); };
  const openGroup = () => { if (svc) setSheet('group'); else Taro.showToast({ title: '社群分配后开放', icon: 'none' }); };
  const closeSheet = () => setSheet('');
  const goFill = () => { setSheet(''); Taro.switchTab({ url: '/pages/thinktank/index' }); };

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

  const rows = [
    { ic: 'insight', t: '个人档案 · 军师记忆', s: briefLine(me?.understanding), onClick: () => Taro.navigateTo({ url: '/pages/brief/index' }) },
    { ic: 'doc', t: '完整履历 · 创始人战略档案', s: '军师执笔', onClick: () => Taro.navigateTo({ url: '/packages/work/dossier/index' }) },
    { ic: 'grid', t: '我的案卷', s: projCount ? `${projCount}` : '', onClick: () => Taro.navigateTo({ url: '/packages/work/projects/index' }) },
    { ic: 'layers', t: '方案库', s: `${libCount + reportCount}`, onClick: () => Taro.navigateTo({ url: '/packages/work/library/index' }) },
    { ic: 'spark', t: '我的品牌资产', s: '数字人/短视频预填', onClick: () => Taro.navigateTo({ url: '/packages/work/brandkit/index' }) },
    { ic: 'attach', t: '我的资料库', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/knowledge/index' }) },
    { ic: 'chart', t: '数据授权与数据源', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/bindings/index' }) },
    { ic: 'grid', t: '模块管理 · 添加 / 隐藏', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/market/index' }) },
    { ic: 'doc', t: '订单支付 / 算力明细', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/credits/index' }) },
    { ic: 'spark', t: '送你一卦 · 给朋友出速写卡', s: '', onClick: () => Taro.navigateTo({ url: '/packages/work/gift/index' }) },
    { ic: 'clock', t: '提醒与日历', s: reminderHint(me?.service), onClick: () => Taro.navigateTo({ url: '/packages/work/reminders/index' }) },
    { ic: 'crown', t: '我的本命色', s: color.short, sw: true, onClick: () => setShowPicker(true) },
    { ic: 'shield', t: '私有化部署 · 企业版', s: '预约', onClick: () => Taro.showToast({ title: '已记录企业版意向', icon: 'none' }) },
    {
      ic: 'lock', t: '退出登录', s: '',
      onClick: () =>
        Taro.showModal({ title: '退出登录', content: '确定退出当前账号？' }).then((r) => {
          if (r.confirm) { s.logout(); Taro.reLaunch({ url: '/pages/sessions/index' }); }
        }),
    },
  ];

  return (
    <Screen topInset>
      <View className="pad account">
        {/* 页头：居中「我的军师系统」· 右「设置」 */}
        <View className="account-nav tab-page-head">
          <Text className="an-title serif">我的军师系统</Text>
          <Text className="an-side serif" onClick={() => Taro.navigateTo({ url: '/pages/settings/index' })}>设置</Text>
        </View>

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
            <View className="sct-b" onClick={() => Taro.navigateTo({ url: '/pages/settings/index' })}>
              <Text className="account-profile-name serif">{me?.user.name || '完善你的资料 ›'}</Text>
              {orgLine(me) ? <Text className="account-profile-role">{orgLine(me)}</Text> : null}
            </View>
            <Text className="member-pill" onClick={() => setShowPlans(true)}>{me?.plan?.name || '免费版'}</Text>
          </View>

          <View className="account-profile-meta">
            <View className="apm-row"><Text className="apm-k">手机</Text><Text className="apm-v">{maskPhone(me?.user.phone)}</Text></View>
            <View className="apm-row"><Text className="apm-k">所在社群</Text><Text className="apm-v">{svc?.className ? `${svc.className} · 服务中` : '待分配'}</Text></View>
            <View className="apm-row"><Text className="apm-k">邀请码</Text><Text className="apm-v"><Text className="apm-code">{me?.inviteCode || '—'}</Text></Text></View>
          </View>

          <View className="membership-strip">
            {strip.map((c) => (
              <View key={c.l} className="ms-cell" onClick={c.onClick}>
                <Text className="ms-v serif">{c.v}</Text>
                <Text className="ms-l">{c.l}</Text>
              </View>
            ))}
          </View>

          <View className="service-action-row">
            <View className={`service-action ${svc ? '' : 'is-empty'}`} onClick={openTeacher}>
              <Text className="sa-i serif">微</Text>
              <View className="sa-b">
                <Text className="sa-t">{svc ? `${svc.teacherName}微信` : '服务老师微信'}</Text>
                <Text className="sa-s">{svc ? '服务老师 / 资料确认' : '待分配'}</Text>
              </View>
            </View>
            <View className={`service-action ${svc ? '' : 'is-empty'}`} onClick={openGroup}>
              <Text className="sa-i serif">码</Text>
              <View className="sa-b">
                <Text className="sa-t">群二维码</Text>
                <Text className="sa-s">{svc ? '入群 / 二维码' : '待分配'}</Text>
              </View>
            </View>
          </View>
        </View>

        {/* 经营统计（account-statline）：案卷 / 方案 / 资料（真实计数，四名词统一） */}
        <View className="account-statline">
          <View className="account-stat card" onClick={() => Taro.navigateTo({ url: '/packages/work/projects/index' })}>
            <Text className="as-n serif">{projCount}</Text>
            <Text className="as-l">案卷</Text>
          </View>
          <View className="account-stat card" onClick={() => Taro.navigateTo({ url: '/packages/work/library/index' })}>
            <Text className="as-n serif">{libCount + reportCount}</Text>
            <Text className="as-l">方案</Text>
          </View>
          <View className="account-stat card" onClick={() => Taro.navigateTo({ url: '/packages/work/knowledge/index' })}>
            <Text className="as-n serif">{me?.understanding?.evidenceCount.knowledge ?? 0}</Text>
            <Text className="as-l">资料</Text>
          </View>
        </View>

        {/* 战略段位（M4 PR-18）：全部真实计数。WO-03 冷启动延迟曝光——攒够连续复盘/使用天数才亮相，
            不把「新兵·连续 0 天·准确率 —%」的空账本怼给新用户。 */}
        {prog && (prog.streak >= 3 || prog.usageDays >= 14) ? (
          <View className="rank-card card" onClick={() => Taro.navigateTo({ url: '/packages/work/ledger/index' })}>
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

        {/* 菜单（design menu：左侧色块图标 + 右值） */}
        <View className="menu card">
          {rows.map((r) => (
            <View key={r.t} className="menu-row" onClick={r.onClick}>
              <View className="menu-ic"><Icon name={r.ic} size={14} color={accent} /></View>
              <Text className="menu-t">{r.t}</Text>
              {r.sw ? <View className="menu-sw" style={{ background: accent }} /> : null}
              <Text className="menu-s">{r.s}</Text>
              <Text className="menu-go">›</Text>
            </View>
          ))}
        </View>

        {/* 服务老师 / 军师社群（account-teacher 暖金卡） */}
        <View className="account-teacher" onClick={() => Taro.navigateTo({ url: '/packages/work/community/index' })}>
          <View className="at-b">
            <Text className="at-t">军师社群 · 服务老师</Text>
            <Text className="at-s">分班与入群任务 · 服务老师带你把军师用起来</Text>
          </View>
          <Text className="at-em">进入</Text>
        </View>

        {/* 深度能力解锁（account-depth 绿卡） */}
        <View className="account-depth" onClick={() => setShowPlans(true)}>
          <View className="ad-b">
            <Text className="ad-t">深度能力解锁</Text>
            <Text className="ad-s">更高产出额度、进阶锦囊、数据增强与长期监控</Text>
          </View>
          <Text className="ad-em">管理</Text>
        </View>
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
                <Text className="pmr-go" onClick={goFill}>去补</Text>
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

      <Picker open={showPicker} first={false} onClose={() => setShowPicker(false)} onConfirm={() => setShowPicker(false)} />
      <Plans open={showPlans} onClose={() => setShowPlans(false)} />
    </Screen>
  );
}

// 半屏详情外壳（§3 sheet recipe）：mask(z900) + sheet(圆角上拉) + grip；每屏唯一 overlay key，随开合驱动 tab 栏隐藏。
function Sheet({ open, onClose, sheetKey, children }: { open: boolean; onClose: () => void; sheetKey: string; children: ReactNode }) {
  useEffect(() => {
    store.setOverlay(open, sheetKey);
    return () => store.setOverlay(false, sheetKey);
  }, [open]);
  if (!open) return null;
  return (
    <View className="pf-mask" onClick={onClose} catchMove>
      <View className="pf-sheet" onClick={(e) => e.stopPropagation()}>
        <View className="pf-grip" />
        {children}
      </View>
    </View>
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

// 本月算力（membership-strip 用）：不限量 / 未开通 / round(used/limit)%。
function powerPct(q?: { limit: number; used: number; unlimited: boolean }): string {
  if (!q) return '—';
  if (q.unlimited || q.limit < 0) return '不限';
  if (q.limit <= 0) return '未开通';
  return `${Math.min(100, Math.round((q.used / q.limit) * 100))}%`;
}
// 案卷完整度兜底（workbench 拉取失败时按理解成熟度估算）。
function maturityPct(m?: string): number {
  if (m === 'ready') return 85;
  if (m === 'forming') return 55;
  return 20;
}
// 提醒菜单右值：有社群显示 20:30，否则留空。
function reminderHint(service?: { className: string } | null): string {
  return service ? '20:30' : '';
}

function briefLine(understanding?: { maturity: string; evidenceCount: { memories: number; projects: number; knowledge: number; sessions: number } }): string {
  if (!understanding) return '';
  if (understanding.maturity === 'ready') return '可用于咨询';
  const count = understanding.evidenceCount.memories + understanding.evidenceCount.projects + understanding.evidenceCount.knowledge + understanding.evidenceCount.sessions;
  return count ? `${count} 条线索` : '待补资料';
}
