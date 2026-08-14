// 海报成品图 · 任务详情页（canvas_design P4）。参数：jobId。
//
// 状态以服务端 CreativeJob 为唯一真源（进程内存不算）：本页任何时候都靠 jobId 重新查询恢复，
// 不依赖组件态，也不依赖上一页传来的状态——退出重进、杀进程重开都走同一条路。
//
// 轮询节奏对齐 chat 的 resumeGeneration：前 30 秒 1.2s，之后 3s，10 分钟上限（服务端单任务超时同量级）。
// 表单（改文字 / 换方向）就地展开在页面里，不用 fixed 弹层、不套 ScrollView——AGENTS.md §7.2：
// Android 真机的普通表单 Input 不得放在全屏纵向 ScrollView 或 fixed 弹层中。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View, Text, Textarea, Image } from '@tarojs/components';
import Taro, { useDidHide, useDidShow, useRouter } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import KbInput from '../../../components/KbInput';
import { useStore } from '../../../hooks/useStore';
import {
  api, type CreativeJobView, type CreativeAssetView, type PosterTemplateOption,
  type PosterDirectionKey, type PosterDirectionOption,
} from '../../../services/api';
import {
  absoluteCreativeUrl, fetchPosterFile, getCreativeStatus, POSTER_LIMITS as LIMITS,
  PROGRESS_STAGES as STAGES, progressText, type PosterProgressStage,
} from '../../../services/creative';
import { clearPosterPendingByJob } from '../../../services/posterPending';
import { navTo, redirectToGuarded } from '../../../services/nav';
import './index.scss';

const POLL_FAST_MS = 1200;
const POLL_SLOW_MS = 3000;
const POLL_FAST_WINDOW_MS = 30_000;
const POLL_MAX_MS = 10 * 60_000;

const PROOF_SLOTS = 3;

function isInFlight(status?: string): boolean {
  return status === 'pending' || status === 'running';
}
function posterAsset(job: CreativeJobView | null): CreativeAssetView | null {
  if (!job?.assets?.length) return null;
  return job.assets.find((a) => a.kind === 'poster_png') ?? null;
}
function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function Counter({ value, max }: { value: string; max: number }) {
  const n = value.trim().length;
  return <Text className={`pj-count${n > max ? ' over' : ''}`}>{`${n}/${max}`}</Text>;
}
// 定义在组件外：定义在 render 里每次渲染都是新组件类型，子树会卸载重挂、原生 Input 被重建。
function Field({ label, err, count, children }: {
  label: string; err?: string; count?: ReactNode; children: ReactNode;
}) {
  return (
    <View className="pj-field">
      <View className="pj-flabel">
        <Text className="pj-fl">{label}</Text>
        {count ?? null}
      </View>
      {children}
      {err ? <Text className="pj-ferr">{err}</Text> : null}
    </View>
  );
}

export default function PosterJobPage() {
  const s = useStore();
  const router = useRouter();
  const accent = s.color().vars['--accent'];
  const jobId = String(router.params.jobId ?? '');

  const [job, setJob] = useState<CreativeJobView | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [timedOut, setTimedOut] = useState(false);
  const [price, setPrice] = useState<number | null>(null);
  const [routePrices, setRoutePrices] = useState<{ standard: number; premium: number } | null>(null);
  // 启用中的版式清单由 /creative/status 下发；空清单 = 换方向面板不给选版式（只能改视觉方向）。
  const [templates, setTemplates] = useState<PosterTemplateOption[]>([]);
  const [directions, setDirections] = useState<PosterDirectionOption[]>([]);
  const [directionKey, setDirectionKey] = useState<PosterDirectionKey | ''>('');
  const [panel, setPanel] = useState<'' | 'revise' | 'style'>('');
  const [headline, setHeadline] = useState('');
  const [proofs, setProofs] = useState<string[]>(['', '', '']);
  const [cta, setCta] = useState('');
  const [visual, setVisual] = useState('');
  const [tplKey, setTplKey] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');

  const aliveRef = useRef(true);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollSeqRef = useRef(0);
  // 签名 URL 过期（图片加载失败）只自动重拉一次，避免「拉不到 → onError → 再拉」打成死循环。
  const urlRetriedRef = useRef(false);
  const reviseKeyRef = useRef('');
  const styleKeyRef = useRef('');

  const clearTimer = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  /** 停掉当前这一代轮询（代号自增即可，在飞的 poll 醒来会自行退场）。 */
  const stopPolling = () => { pollSeqRef.current += 1; clearTimer(); };

  const applyJob = (v: CreativeJobView) => {
    setJob(v);
    urlRetriedRef.current = false;
    // 进终态即清掉本地在途标记，别让下一次「生成成品图」被劫持回这条旧任务。
    if (!isInFlight(v.status)) clearPosterPendingByJob(v.id);
  };

  /** 分档轮询：前 30s 1.2s，之后 3s，10 分钟上限。进终态即停。 */
  const startPolling = () => {
    stopPolling();
    const startedAt = Date.now();
    const seq = ++pollSeqRef.current;
    const poll = async () => {
      if (!aliveRef.current || seq !== pollSeqRef.current) return;
      try {
        const v = await api.creativeJob(jobId);
        if (!aliveRef.current || seq !== pollSeqRef.current) return;
        applyJob(v);
        if (!isInFlight(v.status)) { clearTimer(); return; }
      } catch (e) {
        if (!aliveRef.current || seq !== pollSeqRef.current) return;
        const code = String((e as { code?: string }).code || '');
        if (code === 'UNAUTHORIZED') { clearTimer(); return; } // 401 已由 request() 全局打断
        if (code === 'NOT_FOUND') { clearTimer(); setLoadErr('这条出图任务已经找不到了。'); return; }
        // 短暂网络波动不撤掉制作中状态，下一轮继续问服务端真值。
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= POLL_MAX_MS) {
        clearTimer();
        setTimedOut(true);
        return;
      }
      timerRef.current = setTimeout(poll, elapsed < POLL_FAST_WINDOW_MS ? POLL_FAST_MS : POLL_SLOW_MS);
    };
    timerRef.current = setTimeout(poll, POLL_FAST_MS);
  };

  /** 按 jobId 重新查询（进页 / 回前台 / 图片 URL 过期都走这里）。 */
  const reload = async (opts: { silent?: boolean } = {}) => {
    if (!jobId) { setLoading(false); setLoadErr('缺少任务编号。'); return; }
    if (!opts.silent) setLoading(true);
    try {
      const v = await api.creativeJob(jobId);
      if (!aliveRef.current) return;
      applyJob(v);
      setLoadErr('');
      setTimedOut(false);
      if (isInFlight(v.status)) startPolling();
      else stopPolling();
    } catch (e) {
      if (!aliveRef.current) return;
      const code = String((e as { code?: string }).code || '');
      if (code === 'NOT_FOUND') setLoadErr('这条出图任务已经找不到了。');
      else { setLoadErr('没能取到出图进度，请重试。'); s.handleApiError(e, { silent: true }); }
    } finally {
      if (aliveRef.current && !opts.silent) setLoading(false);
    }
  };

  useEffect(() => {
    aliveRef.current = true;
    void reload();
    return () => { aliveRef.current = false; stopPolling(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  // 回前台按 jobId 重新对账（不依赖组件态；离开期间任务可能已经出图或已失败）。
  useDidShow(() => {
    aliveRef.current = true;
    if (!job) return;              // 首次挂载的 reload 会自己跑
    void reload({ silent: true });
  });
  useDidHide(() => { stopPolling(); });

  useEffect(() => {
    let alive = true;
    void getCreativeStatus().then((st) => {
      if (!alive || !st) return;
      setRoutePrices({ standard: st.pricePerPoster, premium: st.premiumPricePerPoster });
      setTemplates(st.templates ?? []);
      setDirections((st.directions ?? []).map((item) => ({
        ...item,
        ...(item.previewUrl ? { previewUrl: absoluteCreativeUrl(item.previewUrl) } : {}),
      })));
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!routePrices) return;
    setPrice(job?.tier === 'premium' ? routePrices.premium : routePrices.standard);
  }, [job?.tier, routePrices]);

  const asset = posterAsset(job);
  const imgUrl = absoluteCreativeUrl(asset?.previewUrl);

  /** 签名 URL 短时效（600 秒）：图片加载失败先当过期处理，重拉一次任务详情换新链接。 */
  const onImgError = () => {
    if (urlRetriedRef.current) return;
    urlRetriedRef.current = true;
    void reload({ silent: true });
  };

  const goJob = (id: string, replace = true) => {
    const url = `/packages/work/posterJob/index?jobId=${encodeURIComponent(id)}`;
    const ok = replace
      ? redirectToGuarded(url, { fail: () => Taro.showToast({ title: '成品图页面加载失败，请重试', icon: 'none' }) })
      : navTo(url, { fail: () => Taro.showToast({ title: '成品图页面加载失败，请重试', icon: 'none' }) });
    if (!ok) Taro.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  };

  const saveAlbum = async () => {
    if (busy) return;
    setBusy('save');
    Taro.showLoading({ title: '保存中…' });
    try {
      const path = await fetchPosterFile(asset?.previewUrl);
      await Taro.saveImageToPhotosAlbum({ filePath: path });
      Taro.hideLoading();
      Taro.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (e) {
      Taro.hideLoading();
      const msg = String((e as { errMsg?: string; message?: string }).errMsg || (e as Error).message || '');
      if (/auth|deny|permission/i.test(msg)) {
        // 相册权限被拒：给一条能真正解决问题的路（去设置里打开），不是干巴巴一句失败。
        const r = await Taro.showModal({
          title: '需要相册权限',
          content: '保存成品图要用到相册权限，去设置里打开？',
          confirmText: '去设置',
        }).catch(() => ({ confirm: false }));
        // openSetting 是微信设置面板，用户直接关掉就是 reject——这里没有业务错误可报，故静默。
        if (r.confirm) await Taro.openSetting().catch(() => undefined);
      } else {
        Taro.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
    } finally {
      if (aliveRef.current) setBusy('');
    }
  };

  const shareFriend = async () => {
    if (busy) return;
    setBusy('share');
    Taro.showLoading({ title: '准备中…' });
    try {
      const path = await fetchPosterFile(asset?.previewUrl);
      Taro.hideLoading();
      await Taro.showShareImageMenu({ path });
    } catch {
      Taro.hideLoading();
      Taro.showToast({ title: '暂时打不开转发，可先存相册再发', icon: 'none' });
    } finally {
      if (aliveRef.current) setBusy('');
    }
  };

  const openRevise = () => {
    setErrors({});
    reviseKeyRef.current = newIdempotencyKey('revise');
    setHeadline('');
    setProofs(['', '', '']);
    setCta('');
    setPanel('revise');
  };
  const openStyle = () => {
    setErrors({});
    styleKeyRef.current = newIdempotencyKey('regen');
    setVisual('');
    setTplKey('');
    setDirectionKey('');
    setPanel('style');
  };

  /** 重取启用中的版式清单（后台停用某套版式后，本页缓存的清单会过期）。 */
  const refreshTemplates = async () => {
    const st = await getCreativeStatus({ force: true });
    if (!aliveRef.current || !st) return;
    const tpls = st.templates ?? [];
    setTemplates(tpls);
    setTplKey((cur) => (cur && tpls.some((t) => t.key === cur) ? cur : ''));
    setDirections((st.directions ?? []).map((item) => ({
      ...item,
      ...(item.previewUrl ? { previewUrl: absoluteCreativeUrl(item.previewUrl) } : {}),
    })));
  };

  const submitRevise = async () => {
    if (busy || !job) return;
    const next: Record<string, string> = {};
    if (headline.trim().length > LIMITS.headline) next.headline = `主标题不超过 ${LIMITS.headline} 个字`;
    proofs.forEach((p, i) => {
      if (p.trim().length > LIMITS.proofPoint) next[`proof${i}`] = `第 ${i + 1} 条卖点不超过 ${LIMITS.proofPoint} 个字`;
    });
    if (cta.trim().length > LIMITS.cta) next.cta = `行动号召不超过 ${LIMITS.cta} 个字`;
    const filled = proofs.map((p) => p.trim()).filter(Boolean);
    if (!headline.trim() && !cta.trim() && !filled.length) next.form = '改一处再提交（留空表示沿用上一版）。';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy('revise');
    try {
      const r = await api.reviseJob(job.id, {
        ...(headline.trim() ? { headline: headline.trim() } : {}),
        ...(filled.length ? { proofPoints: filled } : {}),
        ...(cta.trim() ? { cta: cta.trim() } : {}),
        idempotencyKey: reviseKeyRef.current,
      });
      if (!aliveRef.current) return;
      goJob(r.jobId);
    } catch (e) {
      if (!aliveRef.current) return;
      const code = String((e as { code?: string }).code || (e as { data?: { code?: string } }).data?.code || '');
      if (code === 'BRIEF_INVALID' || code === 'MODERATION_BLOCKED') {
        setErrors({ form: String((e as Error).message || '文案没通过校验，改一下再试。') });
      } else if (code === 'CREATIVE_DAILY_LIMIT') {
        setErrors({ form: '今日出图额度已满，明天再来。' });
      } else {
        s.handleApiError(e, { fallbackTitle: '改文字失败，请重试' });
      }
    } finally {
      if (aliveRef.current) setBusy('');
    }
  };

  /**
   * 重出主视觉：会再扣一次钻石。failed/cancelled 的「重新生成」也走这里（不带 patch）。
   *
   * 只发用户在面板里改动的两项。**不需要**（也无法）补发 negativePrompt / brandKitVersion：
   * 服务端 regenerateJob 以父任务存档的整份 brief 为底，只覆盖 patch 里显式给出的键，
   * 所以品牌资产包版本与排除项沿版本链自动继承——前提是确认页建单时带上了它们（见 poster/index.tsx）。
   * 本页拿到的 CreativeJobView 里没有 brief，凭空造这两个值只会把继承来的正确值覆盖掉。
   */
  const submitRegenerate = async (opts: { usePanel?: boolean } = {}) => {
    if (busy || !job) return;
    if (opts.usePanel && visual.trim().length > LIMITS.visualDirection) {
      setErrors({ visual: `视觉方向不超过 ${LIMITS.visualDirection} 个字` });
      return;
    }
    setErrors({});
    setBusy('regen');
    try {
      const key = opts.usePanel ? styleKeyRef.current : newIdempotencyKey('regen');
      const r = await api.regenerateJob(job.id, {
        ...(opts.usePanel && visual.trim() ? { visualDirection: visual.trim() } : {}),
        ...(opts.usePanel && tplKey ? { templateKey: tplKey } : {}),
        ...(opts.usePanel && directionKey ? { directionKey } : {}),
        idempotencyKey: key,
      });
      if (!aliveRef.current) return;
      goJob(r.jobId);
    } catch (e) {
      if (!aliveRef.current) return;
      const code = String((e as { code?: string }).code || (e as { data?: { code?: string } }).data?.code || '');
      if (code === 'INSUFFICIENT_CREDITS') setErrors({ form: '钻石不足，去「我的 · 权益额度」看看余额。' });
      else if (code === 'CREATIVE_DAILY_LIMIT') setErrors({ form: '今日出图额度已满，明天再来。' });
      else if (code === 'BRIEF_INVALID' || code === 'MODERATION_BLOCKED') {
        const msg = String((e as Error).message || '');
        setErrors({ form: msg || '没通过校验，改一下再试。' });
        // 版式在本页停留期间被后台停用（服务端 422，不静默换版）：重取清单让那一项立刻消失。
        if (/版式/.test(msg)) void refreshTemplates();
      } else s.handleApiError(e, { fallbackTitle: '换方向失败，请重试' });
    } finally {
      if (aliveRef.current) setBusy('');
    }
  };

  const cancel = async () => {
    if (busy || !job) return;
    const r = await Taro.showModal({ title: '取消出图', content: '取消后这次出图不再继续，已扣的钻石会退回。' }).catch(() => ({ confirm: false }));
    if (!r.confirm) return;
    setBusy('cancel');
    try {
      const v = await api.cancelJob(job.id);
      if (!aliveRef.current) return;
      applyJob(v);
      stopPolling();
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '取消失败，请重试' });
    } finally {
      if (aliveRef.current) setBusy('');
    }
  };

  const setProof = (i: number, v: string) => setProofs((cur) => cur.map((x, j) => (j === i ? v : x)));

  const stageIdx = Math.max(0, STAGES.indexOf((job?.progress ?? 'philosophy') as PosterProgressStage));
  const actions = job?.actions ?? [];
  // 「换方向」清单 = 本单路线 ∩ 本单能选的方向。requiresPortrait 的方向对没传过本人照片的单
  // 必 422，而详情页没有上传入口 —— 摆出来就是一个只能碰壁的死选项。
  const activeDirections = job
    ? directions.filter((item) => item.tier === (job.tier === 'premium' ? 'premium' : 'standard')
      && (!item.requiresPortrait || job.hasPortrait))
    : [];

  return (
    <View className={`page poster-job ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="成品图" onBack={() => Taro.navigateBack()} />
      <View className="pj-pad">
        {loading ? (
          <View className="pj-loading"><Text>正在取出图进度…</Text></View>
        ) : loadErr ? (
          <View className="pj-empty">
            <Text className="pj-empty-t serif">{loadErr}</Text>
            <View className="pj-btn ghost" onClick={() => void reload()}><Text>重试</Text></View>
          </View>
        ) : !job ? null : (
          <>
            {/* ——— 制作中 ——— */}
            {isInFlight(job.status) ? (
              <View className="pj-making">
                <View className="pj-spin" style={{ borderTopColor: accent }} />
                <Text className="pj-making-t serif">{progressText(job.progress)}</Text>
                <Text className="pj-making-d">出图约一分钟，可以先去做别的，回来还在这。</Text>
                <View className="pj-stages">
                  {STAGES.map((st, i) => (
                    <View key={st} className="pj-stage">
                      <View
                        className={`pj-dot${i <= stageIdx ? ' on' : ''}`}
                        style={i <= stageIdx ? { background: accent } : undefined}
                      />
                      <Text className={`pj-stage-t${i <= stageIdx ? ' on' : ''}`}>{progressText(st)}</Text>
                    </View>
                  ))}
                </View>
                {timedOut ? (
                  <Text className="pj-note">这次出图时间有点久，结果完成后仍会保存在这里，稍后回来查看。</Text>
                ) : null}
                {actions.includes('cancel') ? (
                  <View className="pj-btn ghost" onClick={cancel}><Text>{busy === 'cancel' ? '取消中…' : '取消出图'}</Text></View>
                ) : null}
              </View>
            ) : null}

            {/* ——— 已出图 ——— */}
            {job.status === 'succeeded' ? (
              <>
                <View className="pj-canvas">
                  {imgUrl
                    ? <Image className="pj-img" src={imgUrl} mode="aspectFit" onError={onImgError} />
                    : <Text className="pj-note">成品图链接已过期，正在重新获取…</Text>}
                </View>
                <View className="pj-acts">
                  <View className="pj-act" style={{ background: accent }} onClick={saveAlbum}>
                    <Icon name="down" size={14} color="#fff" />
                    <Text className="pj-act-t on">{busy === 'save' ? '保存中…' : '保存相册'}</Text>
                  </View>
                  <View className="pj-act ghost" onClick={shareFriend}>
                    <Icon name="up" size={14} color="#565C63" />
                    <Text className="pj-act-t">{busy === 'share' ? '准备中…' : '分享好友'}</Text>
                  </View>
                </View>
                <View className="pj-acts">
                  {actions.includes('revise') ? (
                    <View className="pj-act ghost" onClick={openRevise}>
                      <Text className="pj-act-t">改文字</Text>
                      <Text className="pj-act-c">不再扣</Text>
                    </View>
                  ) : null}
                  {actions.includes('regenerate') ? (
                    <View className="pj-act ghost" onClick={openStyle}>
                      <Text className="pj-act-t">换方向</Text>
                      {typeof price === 'number' ? <Text className="pj-act-c">{`💎x${price}`}</Text> : null}
                    </View>
                  ) : null}
                </View>
              </>
            ) : null}

            {/* ——— 失败 ——— */}
            {job.status === 'failed' ? (
              <View className="pj-state">
                <Text className="pj-state-t serif">这次没出成</Text>
                <Text className="pj-state-d">{job.errorMessage || '出图失败。'}</Text>
                {job.refunded ? <Text className="pj-state-r">{`已退回 💎x${job.creditCost}`}</Text> : null}
                <View className="pj-btn" style={{ background: accent }} onClick={() => void submitRegenerate()}>
                  <Text className="pj-btn-t">{busy === 'regen' ? '正在发起…' : '重新生成'}</Text>
                  {typeof price === 'number' ? <Text className="pj-btn-c">{`💎x${price}`}</Text> : null}
                </View>
              </View>
            ) : null}

            {/* ——— 已取消 ——— */}
            {job.status === 'cancelled' ? (
              <View className="pj-state">
                <Text className="pj-state-t serif">已取消</Text>
                <Text className="pj-state-d">这次出图没有继续。</Text>
                {job.refunded ? <Text className="pj-state-r">{`已退回 💎x${job.creditCost}`}</Text> : null}
                <View className="pj-btn" style={{ background: accent }} onClick={() => void submitRegenerate()}>
                  <Text className="pj-btn-t">{busy === 'regen' ? '正在发起…' : '重新发起'}</Text>
                  {typeof price === 'number' ? <Text className="pj-btn-c">{`💎x${price}`}</Text> : null}
                </View>
              </View>
            ) : null}

            {/* ——— 改文字（就地展开，不用弹层） ——— */}
            {panel === 'revise' ? (
              <View className="pj-panel">
                <View className="pj-panel-h">
                  <Text className="pj-panel-t">改文字</Text>
                  <Text className="pj-panel-x" onClick={() => setPanel('')}>×</Text>
                </View>
                <Text className="pj-panel-d">只重排文案、不重出主视觉，所以不再扣钻石。留空的字段沿用上一版。</Text>
                <Field label="主标题" err={errors.headline} count={<Counter value={headline} max={LIMITS.headline} />}>
                  <KbInput anchorId="pj-head" className="pj-input" value={headline} placeholder="留空 = 沿用上一版" onInput={(e) => setHeadline(e.detail.value)} />
                </Field>
                {Array.from({ length: PROOF_SLOTS }).map((_, i) => (
                  <Field
                    key={`rp-${i}`}
                    label={`卖点 ${i + 1}`}
                    err={errors[`proof${i}`]}
                    count={<Counter value={proofs[i]} max={LIMITS.proofPoint} />}
                  >
                    <KbInput anchorId={`pj-proof-${i}`} className="pj-input" value={proofs[i]} placeholder="留空 = 沿用上一版" onInput={(e) => setProof(i, e.detail.value)} />
                  </Field>
                ))}
                <Field label="行动号召" err={errors.cta} count={<Counter value={cta} max={LIMITS.cta} />}>
                  <KbInput anchorId="pj-cta" className="pj-input" value={cta} placeholder="留空 = 沿用上一版" onInput={(e) => setCta(e.detail.value)} />
                </Field>
                {errors.form ? <Text className="pj-ferr">{errors.form}</Text> : null}
                <View className="pj-btn" style={{ background: accent }} onClick={submitRevise}>
                  <Text className="pj-btn-t">{busy === 'revise' ? '正在重排…' : '重排这一版'}</Text>
                </View>
              </View>
            ) : null}

            {/* ——— 换创作方向（重新创作，会再扣费） ——— */}
            {panel === 'style' ? (
              <View className="pj-panel">
                <View className="pj-panel-h">
                  <Text className="pj-panel-t">换创作方向</Text>
                  <Text className="pj-panel-x" onClick={() => setPanel('')}>×</Text>
                </View>
                <Text className="pj-panel-d">会按原路线重新创作并再扣一次钻石。旧版本不会被覆盖，随时能回看。</Text>
                {activeDirections.length ? (
                  <Field label="创作方向（留空 = 沿用）">
                    <View className="pj-dir-grid">
                      {activeDirections.map((item) => {
                        const on = item.key === directionKey;
                        return (
                          <View key={item.key} className={`pj-dir${on ? ' on' : ''}`} onClick={() => setDirectionKey(on ? '' : item.key)}>
                            {item.previewUrl ? <Image className="pj-dir-img" src={item.previewUrl} mode="aspectFill" /> : <View className="pj-dir-empty">样例待发布</View>}
                            <View className="pj-dir-b">
                              <Text className="pj-dir-n">{item.name}</Text>
                              <Text className="pj-dir-d">{item.desc}</Text>
                              {item.note ? <Text className="pj-dir-note">{item.note}</Text> : null}
                            </View>
                          </View>
                        );
                      })}
                    </View>
                  </Field>
                ) : null}
                {/* 版式清单来自 /creative/status（只含启用中的）；不选 = 沿用上一版的版式。
                    一套都没下发时整块不渲染——不要给出一个服务端会 422 的选项。 */}
                {templates.length ? (
                  <Field label="版式">
                    <View className="pj-tpls">
                      {templates.map((t) => {
                        const on = t.key === tplKey;
                        return (
                          <View
                            key={t.key}
                            className={`pj-tpl${on ? ' on' : ''}`}
                            style={on ? { borderColor: accent } : undefined}
                            onClick={() => setTplKey(on ? '' : t.key)}
                          >
                            <View className="pj-tpl-h">
                              <Text className="pj-tpl-n">{t.name}</Text>
                              {on ? <Icon name="check" size={13} color={accent} /> : null}
                            </View>
                            <Text className="pj-tpl-d">{t.desc}</Text>
                          </View>
                        );
                      })}
                    </View>
                  </Field>
                ) : null}
                <Field label="补充画面要求" err={errors.visual} count={<Counter value={visual} max={LIMITS.visualDirection} />}>
                  <Textarea className="pj-area" value={visual} placeholder="留空 = 沿用上一版；只写画面属性" onInput={(e) => setVisual(e.detail.value)} />
                </Field>
                {errors.form ? <Text className="pj-ferr">{errors.form}</Text> : null}
                <View className="pj-btn" style={{ background: accent }} onClick={() => void submitRegenerate({ usePanel: true })}>
                  <Text className="pj-btn-t">{busy === 'regen' ? '正在发起…' : '按新方向重做'}</Text>
                  {typeof price === 'number' ? <Text className="pj-btn-c">{`💎x${price}`}</Text> : null}
                </View>
              </View>
            ) : null}

            {/* 版本链：revise/regenerate 出来的新任务能回看来源版本 */}
            {job.parentJobId ? (
              <Text className="pj-prev" style={{ color: accent }} onClick={() => goJob(job.parentJobId!, false)}>查看上一版</Text>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}
