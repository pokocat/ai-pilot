import { useState } from 'react';
import { View, Text, Input } from '@tarojs/components';
import Taro, { useDidShow, useShareAppMessage } from '@tarojs/taro';
import Login from '../../../components/Login';
import SafeHeader from '../../../components/SafeHeader';
import BaseSheet from '../../../components/Sheet';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import { api, type MingpanReport, type MpPalace, type WuxingKey, type HuaKey } from '../../../services/api';
import { SHICHEN } from '../../../data/shichen';
import './index.scss';

// 命盘报告（八字 × 紫微综合印证）——命理数据全部由服务端算法层确定性推算（零 LLM）。
// 本页只做案卷公文风的原生呈现：四柱案卷 / 紫微十二宫全盘 / 两盘印证 / 大运大限时间轴。
// 三分支容错：needBazi（就地补生辰）/ ziwei=null（缺时辰，紫微待立盘）/ yinzheng=null（印证与时间轴留空）。
// 转发落地约束同天时日历：被转发者可能冷启动直达本页——未登录本页自承接 Login，401 一律 silent 不跳走。

// 五行固定顺序（统计条口径一致）
const WUXING: WuxingKey[] = ['木', '火', '土', '金', '水'];

// 紫微经典 4×4 十二宫盘：地支 → 网格落位（class 在 scss 里声明 grid-column/row，避免依赖内联 grid 属性）。
//   巳 午 未 申
//   辰 中 宫 酉
//   卯 中 宫 戌
//   寅 丑 子 亥
const BRANCH_CLASS: Record<string, string> = {
  巳: 'mp-b-si', 午: 'mp-b-wu', 未: 'mp-b-wei', 申: 'mp-b-shen',
  辰: 'mp-b-chen', 酉: 'mp-b-you',
  卯: 'mp-b-mao', 戌: 'mp-b-xu',
  寅: 'mp-b-yin', 丑: 'mp-b-chou', 子: 'mp-b-zi', 亥: 'mp-b-hai',
};

// 四化小方章配色：禄/权=accent、科=ink-2、忌=暗红（--mp-ji 于 scss 一处声明）
const HUA_CLASS: Record<HuaKey, string> = { 禄: 'lu', 权: 'quan', 科: 'ke', 忌: 'ji' };
function huaClass(hua?: string | null): string {
  if (!hua) return '';
  return HUA_CLASS[hua as HuaKey] || '';
}

// —— 生辰合法性（与 calendar/主入口口径一致：动态年上限）——
function isLeap(y: number): boolean { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function monthDays(cal: 'solar' | 'lunar', y: number, m: number): number {
  if (cal === 'lunar') return 30;
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 31;
}
function validBirth(cal: 'solar' | 'lunar', y: number, m: number, d: number): boolean {
  return y >= 1930 && y <= new Date().getFullYear() && m >= 1 && m <= 12 && d >= 1 && d <= monthDays(cal, y, m);
}

export default function MingpanReportPage() {
  const s = useStore();
  const accent = s.color().vars['--accent'];
  const seal = s.color().seal;

  const [report, setReport] = useState<MingpanReport | null>(null);
  const [needBazi, setNeedBazi] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [disabled, setDisabled] = useState(false); // 命理下线（403 FEATURE_DISABLED）→ 友好降级
  const [showForm, setShowForm] = useState(false);  // 缺时辰时的「补生辰」入口
  const [showLogin, setShowLogin] = useState(false);
  const [activePalace, setActivePalace] = useState<MpPalace | null>(null);

  // 就地补生辰（照搬 calendar 表单口径：阳/阴历 · 年月日 · 时辰 · 性别）
  const [calendar, setCalendar] = useState<'solar' | 'lunar'>('solar');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [hourIdx, setHourIdx] = useState(0);
  const [gender, setGender] = useState<'male' | 'female'>('male');
  const [busy, setBusy] = useState(false);

  const authed = s.isAuthed();
  const errCode = (e: unknown) => String((e as { code?: string; data?: { code?: string } })?.code || (e as { data?: { code?: string } })?.data?.code || '');

  const loadReport = () => {
    api.myChartReport().then((r) => {
      setLoaded(true);
      if ('needBazi' in r) { setNeedBazi(true); setReport(null); }
      else { setReport(r); setNeedBazi(false); setShowForm(false); }
    }).catch((e) => {
      setLoaded(true);
      if (errCode(e) === 'FEATURE_DISABLED') { setDisabled(true); setReport(null); return; } // 命理下线：静默降级
      if (s.handleApiError(e, { silent: true }) === 'unauthorized') setReport(null);          // 冷启动过期 token：留本页承接
    });
  };

  useDidShow(() => {
    if (!s.isAuthed()) { setLoaded(true); return; }
    store.loadMe().catch(() => {}); // 拉最新命理开关（合规态可能已变）
    loadReport();
  });

  // 命理总开关关闭：本页属命理能力，直接降级
  const fortuneOff = authed && (disabled || !s.fortuneOn());

  const goBack = () => {
    if (Taro.getCurrentPages().length > 1) Taro.navigateBack();
    else Taro.switchTab({ url: '/pages/profile/index' }).catch(() => Taro.reLaunch({ url: '/pages/profile/index' }));
  };

  useShareAppMessage(() => ({
    title: '我的命盘报告 · 八字紫微综合印证',
    path: '/packages/work/mingpan/index',
  }));

  const valid = validBirth(calendar, +year, +month, +day);
  const saveBirth = async () => {
    if (!valid || busy) return;
    setBusy(true);
    Taro.showLoading({ title: '立盘中…' });
    try {
      const r = await api.saveBazi({ calendar, year: +year, month: +month, day: +day, hour: SHICHEN[hourIdx].hour, gender });
      Taro.hideLoading();
      if (r.chart) { Taro.showToast({ title: '生辰已录，正在立盘', icon: 'none' }); loadReport(); }
      else Taro.showToast({ title: '立盘未成，请核对生辰', icon: 'none' });
    } catch (e) {
      Taro.hideLoading();
      if (errCode(e) === 'FEATURE_DISABLED') { setDisabled(true); Taro.showToast({ title: '命理能力已下线', icon: 'none' }); }
      else if (s.handleApiError(e, { silent: true }) === 'unauthorized') setShowLogin(true);
      else Taro.showToast({ title: '立盘失败，请重试', icon: 'none' });
    }
    setBusy(false);
  };

  const showFormBlock = needBazi || showForm;

  return (
    <View className={`page mp ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="命盘报告" onBack={goBack} />
      <View className="pad">
        {fortuneOff ? (
          <View className="mp-hero">
            <Text className="mp-hero-t serif">命盘报告暂不可用</Text>
            <Text className="mp-hero-s">命理视角的推演已暂停。你的战略判断、军令与复盘不受影响，可继续在参谋室与军师对话。</Text>
          </View>
        ) : !authed ? (
          <>
            <View className="mp-hero">
              <Text className="mp-hero-t serif">立你的命盘 · 八字紫微互参</Text>
              <Text className="mp-hero-s">军师按生辰以算法立盘：四柱旺衰格局、紫微十二宫全盘，再两盘互证。登录后一息可成。</Text>
            </View>
            <View className="mp-btn" style={{ background: accent, marginTop: '26px' }} onClick={() => setShowLogin(true)}>
              <Text>登录 · 立我的命盘</Text>
            </View>
          </>
        ) : report ? (
          <>
            {renderHead(report, seal)}
            {renderBazi(report)}
            {renderZiwei(report, setActivePalace, () => setShowForm(true))}
            {renderYinzheng(report)}
            {renderTimeline(report)}
            {renderFoot(report)}
            {/* 缺时辰时，补生辰入口点开后就地渲染表单 */}
            {showForm ? renderForm() : null}
          </>
        ) : showFormBlock ? (
          <>
            <View className="mp-hero">
              <Text className="mp-hero-t serif">先录生辰，再为你立盘</Text>
              <Text className="mp-hero-s">立盘在服务端算法引擎完成，只算一次长期使用；命理内容仅作文化视角参考。</Text>
            </View>
            {renderForm()}
          </>
        ) : loaded ? (
          <View className="mp-hero"><Text className="mp-hero-s">暂未取到命盘，请稍后重试。</Text></View>
        ) : null}

        {/* 报告视图由服务端 disclaimer 兜底；其余状态给一条通用文化视角小字 */}
        {!report ? <Text className="mp-copyright">命理内容为文化视角的研究与参考，不构成决策依据；「人谋可以改命」。</Text> : null}
      </View>

      {/* 宫位全量弹层：主星 / 辅星 / 杂曜 / 大限 */}
      <BaseSheet visible={!!activePalace} onClose={() => setActivePalace(null)} overlayKey="mp-palace" panelClassName="mp-sheet">
        {activePalace ? (
          <>
            <View className="mp-sheet-head">
              <Text className="mp-kicker">{activePalace.stem}{activePalace.branch} 宫</Text>
              <Text className="mp-sheet-title serif">
                {activePalace.name}
                {activePalace.isSoul ? <Text className="mp-tag soul">命</Text> : null}
                {activePalace.isBody ? <Text className="mp-tag body">身</Text> : null}
              </Text>
              {activePalace.decadal ? <Text className="mp-sheet-sub">大限 {activePalace.decadal.start}–{activePalace.decadal.end} 虚岁</Text> : null}
            </View>
            <View className="mp-sheet-body">
              {starGroup('主 星', activePalace.majorStars.map((m) => `${m.name}${m.brightness ? `·${m.brightness}` : ''}${m.mutagen ? `（${m.mutagen}）` : ''}`))}
              {starGroup('辅 星', activePalace.minorStars)}
              {starGroup('杂 曜', activePalace.adjectiveStars)}
            </View>
          </>
        ) : null}
      </BaseSheet>

      <Login open={showLogin} onLoggedIn={() => { setShowLogin(false); loadReport(); }} />
    </View>
  );

  // —— 补生辰表单（needBazi / 补时辰共用）——
  function renderForm() {
    return (
      <View className="mp-form">
        <View className="mp-opts">
          {(['solar', 'lunar'] as const).map((cal) => (
            <View key={cal} className={`mp-opt ${calendar === cal ? 'on' : ''}`}
              style={calendar === cal ? { background: accent, borderColor: accent } : {}}
              onClick={() => setCalendar(cal)}>
              <Text>{cal === 'solar' ? '阳历' : '阴历'}</Text>
            </View>
          ))}
        </View>
        <View className="mp-date">
          <Input className="mp-input mp-y" type="number" value={year} maxlength={4} placeholder="年" onInput={(e) => setYear(e.detail.value)} />
          <Input className="mp-input mp-md" type="number" value={month} maxlength={2} placeholder="月" onInput={(e) => setMonth(e.detail.value)} />
          <Input className="mp-input mp-md" type="number" value={day} maxlength={2} placeholder="日" onInput={(e) => setDay(e.detail.value)} />
        </View>
        <View className="mp-opts" style={{ marginTop: '10px' }}>
          {SHICHEN.map((t, i) => (
            <View key={t.label} className={`mp-opt ${hourIdx === i ? 'on' : ''}`}
              style={hourIdx === i ? { background: accent, borderColor: accent } : {}}
              onClick={() => setHourIdx(i)}>
              <Text>{t.label}</Text>
            </View>
          ))}
        </View>
        <View className="mp-opts" style={{ marginTop: '10px' }}>
          {([['male', '男'], ['female', '女']] as const).map(([g, label]) => (
            <View key={g} className={`mp-opt ${gender === g ? 'on' : ''}`}
              style={gender === g ? { background: accent, borderColor: accent } : {}}
              onClick={() => setGender(g)}>
              <Text>{label}</Text>
            </View>
          ))}
        </View>
        <View className={`mp-btn ${valid && !busy ? '' : 'off'}`} style={valid && !busy ? { background: accent } : {}} onClick={saveBirth}>
          <Text>{busy ? '立盘中…' : '录入生辰 · 立盘'}</Text>
        </View>
        <Text className="mp-form-tip">时辰不确定可选「不确定」——八字按三柱推演，紫微须时辰方可立盘。</Text>
      </View>
    );
  }
}

// —— 1. 命主档头 ——
function renderHead(r: MingpanReport, seal: string) {
  const b = r.base;
  return (
    <View className="mp-head">
      <View className="mp-seal serif"><Text>{seal}</Text></View>
      <Text className="mp-kicker">命盘报告 · 八字紫微印证</Text>
      <Text className="mp-head-title serif">{r.bazi.pattern.name} · {b.gender}命</Text>
      <View className="mp-head-meta">
        <View className="mp-hm-row"><Text className="mp-hm-k">公历</Text><Text className="mp-hm-v serif">{b.solarDate}</Text></View>
        <View className="mp-hm-row"><Text className="mp-hm-k">农历</Text><Text className="mp-hm-v serif">{b.lunarDate}</Text></View>
        {b.birthPlace ? <View className="mp-hm-row"><Text className="mp-hm-k">出生地</Text><Text className="mp-hm-v serif">{b.birthPlace}</Text></View> : null}
        <View className="mp-hm-row"><Text className="mp-hm-k">时辰</Text><Text className="mp-hm-v serif">{b.hourLabel ? b.hourLabel : '待定 · 三柱推演'}</Text></View>
      </View>
      <View className="mp-badges">
        {b.trueSolarApplied ? <Text className="mp-badge">真太阳时已校正</Text> : null}
        <Text className="mp-badge">晚子时口径</Text>
        {!b.hourKnown ? <Text className="mp-badge warn">时辰未定 · 三柱推演</Text> : null}
      </View>
    </View>
  );
}

// —— 2. 八字案卷 ——
function renderBazi(r: MingpanReport) {
  const { pillars, dayMaster, favorableElements, tiaoHou, pattern, wuxingCount } = r.bazi;
  const cols: { label: string; p: typeof pillars.year | null; day?: boolean }[] = [
    { label: '年', p: pillars.year },
    { label: '月', p: pillars.month },
    { label: '日', p: pillars.day, day: true },
    { label: '时', p: pillars.time },
  ];
  const counts = wuxingCount.counts;
  const maxCount = Math.max(1, ...WUXING.map((k) => counts[k] || 0));
  const dmMeta = [dayMaster.strengthLevel, dayMaster.strengthScore != null ? `加权 ${dayMaster.strengthScore > 0 ? '+' : ''}${dayMaster.strengthScore}` : '', dayMaster.confidence ? `置信${dayMaster.confidence}` : '']
    .filter(Boolean).join(' · ');

  return (
    <View className="mp-sec">
      <View className="mp-sec-h">
        <Text className="mp-kicker">八 字 案 卷</Text>
        <Text className="mp-sec-title serif">四柱 · 旺衰 · 格局</Text>
      </View>

      {/* 四柱表 */}
      <View className="mp-card mp-pillars">
        <View className="mp-pl-row mp-pl-head">
          {cols.map((c) => <Text key={c.label} className={`mp-pl-c ${c.day ? 'day' : ''}`}>{c.label}</Text>)}
        </View>
        <View className="mp-pl-row">
          {cols.map((c) => <Text key={c.label} className="mp-pl-c small">{c.p ? c.p.shiShenGan : '—'}</Text>)}
        </View>
        <View className="mp-pl-row">
          {cols.map((c) => (
            <View key={c.label} className={`mp-pl-c gz ${c.day ? 'day' : ''}`}>
              {c.p ? <Text className="serif">{c.p.ganZhi}</Text> : <Text className="mp-pl-none">时辰待补</Text>}
            </View>
          ))}
        </View>
        <View className="mp-pl-row">
          {cols.map((c) => (
            <View key={c.label} className="mp-pl-c hide">
              {c.p ? c.p.hideGan.map((g, i) => (
                <Text key={`${g}-${i}`} className="mp-hide-item">{g}<Text className="mp-hide-ss">{c.p!.shiShenZhi[i] || ''}</Text></Text>
              )) : <Text className="mp-pl-none">—</Text>}
            </View>
          ))}
        </View>
        <View className="mp-pl-row">
          {cols.map((c) => <Text key={c.label} className="mp-pl-c tiny">{c.p ? c.p.naYin : '—'}</Text>)}
        </View>
      </View>

      {/* 日主旺衰 */}
      <View className="mp-card mp-dm">
        <View className="mp-dm-top">
          <Text className="mp-dm-gan serif">日主 {dayMaster.gan}{dayMaster.element}</Text>
          <Text className="mp-dm-level">{dayMaster.strength}{dmMeta ? ` · ${dmMeta}` : ''}</Text>
        </View>
        {dayMaster.basis ? <Text className="mp-dm-basis">据：{dayMaster.basis}</Text> : null}
      </View>

      {/* 五行统计横条（只用 accent 深浅 + ink 灰阶，不上彩虹色） */}
      <View className="mp-card mp-wuxing">
        <View className="mp-wx-head"><Text className="mp-wx-t">五行分布</Text></View>
        {WUXING.map((k) => {
          const n = counts[k] || 0;
          return (
            <View key={k} className="mp-wx-row">
              <Text className="mp-wx-k serif">{k}</Text>
              <View className="mp-wx-track">
                <View className={`mp-wx-fill ${n === 0 ? 'zero' : ''}`} style={{ width: `${Math.round((n / maxCount) * 100)}%` }} />
              </View>
              <Text className="mp-wx-n serif">{n}</Text>
            </View>
          );
        })}
        <Text className="mp-wx-basis">据：{wuxingCount.basis}</Text>
      </View>

      {/* 格局卡 */}
      <View className="mp-card mp-pattern">
        <View className="mp-pt-top">
          <Text className="mp-pt-name serif">{pattern.name}</Text>
          {pattern.monthShiShen ? <Text className="mp-pt-month">月令 {pattern.monthShiShen}</Text> : null}
        </View>
        {pattern.traits ? <Text className="mp-pt-traits">{pattern.traits}</Text> : null}
        {pattern.suits?.length ? (
          <View className="mp-chip-row"><Text className="mp-chip-lead">宜</Text>{pattern.suits.map((x) => <Text key={x} className="mp-chip">{x}</Text>)}</View>
        ) : null}
        {pattern.avoid?.length ? (
          <View className="mp-chip-row"><Text className="mp-chip-lead avoid">忌</Text>{pattern.avoid.map((x) => <Text key={x} className="mp-chip avoid">{x}</Text>)}</View>
        ) : null}
        {pattern.basis ? <Text className="mp-pt-basis">据：{pattern.basis}</Text> : null}
      </View>

      {/* 喜用与调候 */}
      <View className="mp-card mp-favor">
        <View className="mp-fv-row">
          <Text className="mp-fv-k">喜用</Text>
          <View className="mp-chip-row inline">{favorableElements?.length ? favorableElements.map((x) => <Text key={x} className="mp-chip accent">{x}</Text>) : <Text className="mp-fv-none">—</Text>}</View>
        </View>
        {(tiaoHou?.gods?.length || tiaoHou?.elements?.length) ? (
          <View className="mp-fv-row">
            <Text className="mp-fv-k">调候</Text>
            <Text className="mp-fv-v">{tiaoHou.gods.join('、')}{tiaoHou.elements?.length ? `（${tiaoHou.elements.join('、')}）` : ''}</Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

// —— 3. 紫微命盘（经典 4×4 十二宫） ——
function renderZiwei(r: MingpanReport, onPalace: (p: MpPalace) => void, onFixHour: () => void) {
  const z = r.ziwei;
  return (
    <View className="mp-sec">
      <View className="mp-sec-h">
        <Text className="mp-kicker">紫 微 斗 数</Text>
        <Text className="mp-sec-title serif">十二宫全盘</Text>
      </View>
      {!z ? (
        <View className="mp-card mp-ziwei-empty">
          <Text className="mp-zw-empty-t serif">紫微须时辰方可立盘</Text>
          <Text className="mp-zw-empty-s">当前生辰缺时辰，八字已按三柱推演；补录时辰后即可展开十二宫。</Text>
          <View className="mp-btn ghost" onClick={onFixHour}><Text>补录时辰 · 立紫微盘</Text></View>
        </View>
      ) : (
        <>
          <View className="mp-ziwei-grid">
            {z.palaces.map((p) => (
              <View
                key={p.branch}
                className={`mp-pal ${BRANCH_CLASS[p.branch] || ''} ${p.isSoul ? 'soul' : ''} ${p.isBody ? 'body' : ''}`}
                onClick={() => onPalace(p)}
              >
                <View className="mp-pal-top">
                  <Text className="mp-pal-name serif">{p.name}</Text>
                  {p.isSoul ? <Text className="mp-tag soul">命</Text> : null}
                  {p.isBody ? <Text className="mp-tag body">身</Text> : null}
                  <Text className="mp-pal-gz">{p.stem}{p.branch}</Text>
                </View>
                <View className="mp-pal-majors">
                  {p.majorStars.length ? p.majorStars.map((m) => (
                    <View key={m.name} className="mp-star">
                      <Text className="mp-star-n serif">{m.name}</Text>
                      {m.brightness ? <Text className="mp-star-b">{m.brightness}</Text> : null}
                      {m.mutagen ? <Text className={`mp-hua ${huaClass(m.mutagen)}`}>{m.mutagen}</Text> : null}
                    </View>
                  )) : <Text className="mp-star-empty">空宫</Text>}
                </View>
                {p.minorStars.length ? (
                  <Text className="mp-pal-minors">{p.minorStars.slice(0, 4).join(' ')}{p.minorStars.length > 4 ? '…' : ''}</Text>
                ) : null}
                {p.decadal ? <Text className="mp-pal-decadal">{p.decadal.start}-{p.decadal.end}</Text> : null}
              </View>
            ))}
            {/* 中宫 2×2：五行局 / 命主 / 身主 / 阴阳 */}
            <View className="mp-pal-center">
              <Text className="mp-ct-kicker">中 宫</Text>
              <View className="mp-ct-rows">
                <View className="mp-ct-row"><Text className="mp-ct-k">五行局</Text><Text className="mp-ct-v serif">{z.fiveElementsClass}</Text></View>
                <View className="mp-ct-row"><Text className="mp-ct-k">命主</Text><Text className="mp-ct-v serif">{z.soulStar}</Text></View>
                <View className="mp-ct-row"><Text className="mp-ct-k">身主</Text><Text className="mp-ct-v serif">{z.bodyStar}</Text></View>
                <View className="mp-ct-row"><Text className="mp-ct-k">阴阳</Text><Text className="mp-ct-v serif">{z.yinYang}</Text></View>
              </View>
            </View>
          </View>
          <View className="mp-ziwei-legend">
            <Text className="mp-zl">点按宫格看全量星曜</Text>
            <View className="mp-zl-huas">
              <Text className="mp-hua lu">禄</Text><Text className="mp-hua quan">权</Text>
              <Text className="mp-hua ke">科</Text><Text className="mp-hua ji">忌</Text>
            </View>
          </View>
        </>
      )}
    </View>
  );
}

// —— 4. 两盘印证 ——
function renderYinzheng(r: MingpanReport) {
  const y = r.yinzheng;
  if (!y) return null; // 缺时辰 → 印证与时间轴留空（紫微区已给出补时辰入口）
  return (
    <View className="mp-sec">
      <View className="mp-sec-h">
        <Text className="mp-kicker">两 盘 印 证</Text>
        <Text className="mp-sec-title serif">八字 × 紫微 互参</Text>
      </View>

      {/* 主轴速览 */}
      <View className="mp-card mp-axis">
        <View className="mp-ax-item">
          <Text className="mp-ax-tag">八字轴</Text>
          <Text className="mp-ax-text">{y.baziAxis.text}</Text>
          <Basis text={y.baziAxis.basis} />
        </View>
        <View className="mp-ax-item">
          <Text className="mp-ax-tag">紫微轴</Text>
          <Text className="mp-ax-text">{y.ziweiAxis.text}</Text>
          <Basis text={y.ziweiAxis.basis} />
        </View>
      </View>

      {/* 五行对照 */}
      <View className="mp-card mp-elemcheck">
        <View className="mp-ec-top">
          <Text className="mp-ec-t">五行对照</Text>
          <Text className={`mp-ec-badge ${y.elementCheck.aligned ? 'ok' : 'off'}`}>{y.elementCheck.aligned ? '同气相求' : '局用异路'}</Text>
        </View>
        <View className="mp-ec-body">
          <View className="mp-ec-col"><Text className="mp-ec-k">喜用</Text><Text className="mp-ec-v serif">{y.elementCheck.favorable.join('、')}</Text></View>
          <Text className="mp-ec-vs">对</Text>
          <View className="mp-ec-col"><Text className="mp-ec-k">{y.elementCheck.ju}</Text><Text className="mp-ec-v serif">{y.elementCheck.juElement}</Text></View>
        </View>
        <Text className="mp-ec-note">{y.elementCheck.note}</Text>
      </View>

      {/* 生年四化落宫 */}
      {y.sihua?.length ? (
        <View className="mp-card mp-sihua">
          <Text className="mp-sh-t">生年四化落宫</Text>
          {y.sihua.map((h) => (
            <View key={`${h.hua}-${h.star}`} className="mp-sh-row">
              <Text className={`mp-hua ${huaClass(h.hua)}`}>{h.hua}</Text>
              <Text className="mp-sh-star serif">{h.star}</Text>
              <Text className="mp-sh-arrow">入</Text>
              <Text className="mp-sh-palace">{h.palace}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

// —— 5. 大运大限时间轴 ——
function renderTimeline(r: MingpanReport) {
  const y = r.yinzheng;
  if (!y || !y.timeline?.length) return null;
  return (
    <View className="mp-sec">
      <View className="mp-sec-h">
        <Text className="mp-kicker">大 运 大 限</Text>
        <Text className="mp-sec-title serif">时间轴对照</Text>
      </View>

      <View className="mp-card mp-tl">
        <View className="mp-tl-row mp-tl-head">
          <Text className="mp-tl-c years">年段</Text>
          <Text className="mp-tl-c dayun">八字大运</Text>
          <Text className="mp-tl-c daxian">紫微大限</Text>
        </View>
        {y.timeline.map((t) => (
          <View key={t.years} className={`mp-tl-row ${t.isCurrent ? 'now' : ''}`}>
            <Text className="mp-tl-c years serif">{t.years}</Text>
            <View className="mp-tl-c dayun">
              {t.daYun ? <><Text className="serif mp-tl-gz">{t.daYun.ganZhi}</Text><Text className="mp-tl-sub">{t.daYun.startAge}起</Text></> : <Text className="mp-tl-sub">—</Text>}
            </View>
            <View className="mp-tl-c daxian">
              {t.daXian ? <><Text className="serif mp-tl-gz">{t.daXian.palace}</Text><Text className="mp-tl-sub">{t.daXian.start}-{t.daXian.end} 岁</Text></> : <Text className="mp-tl-sub">—</Text>}
            </View>
          </View>
        ))}
      </View>

      {/* 关键转折年 */}
      {y.keyYears?.length ? (
        <View className="mp-card mp-keyyears">
          <Text className="mp-ky-t">关键转折年</Text>
          {y.keyYears.map((k) => (
            <View key={k.year} className={`mp-ky-row ${k.overlap ? 'overlap' : ''}`}>
              <Text className="mp-ky-year serif">{k.year}</Text>
              <Text className="mp-ky-age">{k.age} 虚岁</Text>
              <Text className="mp-ky-reason">{k.reason}</Text>
            </View>
          ))}
          <Text className="mp-ky-note">重合之年（换运换限同至）宜提前布局、少押重注。</Text>
        </View>
      ) : null}
    </View>
  );
}

// —— 6. 页脚 ——
function renderFoot(r: MingpanReport) {
  return (
    <View className="mp-foot">
      <Text className="mp-foot-ver">引擎 {r.engineVersion}</Text>
      <Text className="mp-foot-disc">{r.disclaimer}</Text>
    </View>
  );
}

// 弹层内星曜分组
function starGroup(label: string, items: string[]) {
  return (
    <View className="mp-sg">
      <Text className="mp-sg-k">{label}</Text>
      <View className="mp-sg-body">
        {items.length ? items.map((it, i) => <Text key={`${it}-${i}`} className="mp-sg-item serif">{it}</Text>) : <Text className="mp-sg-none">无</Text>}
      </View>
    </View>
  );
}

// 依据折叠小字（点按展开）
function Basis({ text }: { text?: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <View className="mp-basis" onClick={() => setOpen((o) => !o)}>
      <Text className="mp-basis-k">{open ? '收起依据' : '依据 ›'}</Text>
      {open ? <Text className="mp-basis-t">{text}</Text> : null}
    </View>
  );
}
