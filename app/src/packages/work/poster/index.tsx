// 海报成品图 · 需求单确认页（canvas_design P4）。
// 链路：海报设计师成果卡「生成成品图」→ 本页（服务端预填 brief + 版式推荐理由）→ 建任务 → 详情页轮询出图。
//
// 三条硬约束（AGENTS.md §7.2）：
// 1) 本页是表单页，Input **不能**放在全屏纵向 ScrollView 或 fixed 弹层里（Android 原生文字层会漂），
//    所以整页走原生页面滚动（root 只给 min-height，不套 ScrollView），单行输入统一 KbInput；
// 2) 字数超限**前置校验**、标红提示，不静默截断——口径与服务端 zod LIMITS 完全一致（超限服务端 422）；
// 3) 费用文案克制：只写 `💎xN`，不写促销话术。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { View, Text, Textarea, Image } from '@tarojs/components';
import Taro, { useRouter } from '@tarojs/taro';
import Icon from '../../../components/Icon';
import SafeHeader from '../../../components/SafeHeader';
import KbInput from '../../../components/KbInput';
import AgentUnlock from '../../../components/AgentUnlock';
import { useStore } from '../../../hooks/useStore';
import { store } from '../../../services/store';
import {
  api, type Agent, type PosterBrief, type PosterScene, type CreativeUploadRole, type PosterTemplateOption,
  type PosterTier, type PosterDirectionKey, type PosterDirectionOption,
} from '../../../services/api';
import { absoluteCreativeUrl, getCreativeStatus, POSTER_LIMITS as LIMITS } from '../../../services/creative';
import { attachPosterJob, markPosterPending, posterScope, readPosterPending } from '../../../services/posterPending';
import { checkImageUpload } from '../../../services/uploadGuard';
import { navTo, redirectToGuarded } from '../../../services/nav';
import './index.scss';

const PROOF_SLOTS = 3;

// 肖像确认（方案 §12.3 精简版）：只留用户真正需要点头的三条，不堆法务长文。
const PORTRAIT_CONSENT = [
  '我拥有本人或被授权人的肖像使用权',
  '不冒用他人身份、不做误导性代言',
  '生成结果可能与本人存在差异',
];

const ROLE_LABEL: Record<CreativeUploadRole, string> = { portrait: '人像', logo: 'Logo', qr: '二维码' };

type AssetSlot = { assetId: string; path: string };

/** 幂等键：客户端生成、按用户唯一。重复点击/断网重试用同一个键 → 服务端返回原任务，不会重复扣费。 */
function newIdempotencyKey(): string {
  return `poster-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 字数计数：超限标红（不截断输入，让用户自己删——静默截断会让人以为写进去了）。 */
function Counter({ value, max }: { value: string; max: number }) {
  const n = value.trim().length;
  return <Text className={`ps-count${n > max ? ' over' : ''}`}>{`${n}/${max}`}</Text>;
}

// 字段外壳必须定义在组件**外面**：定义在 render 里每次渲染都是一个新组件类型，
// React 会整棵子树卸载重挂，输入中的原生 Input 会被重建（真机上表现为焦点丢失、文字层停在旧坐标）。
function Field({ label, hint, err, count, children }: {
  label: string; hint?: string; err?: string; count?: ReactNode; children: ReactNode;
}) {
  return (
    <View className="ps-field">
      <View className="ps-flabel">
        <Text className="ps-fl">{label}</Text>
        {count ?? null}
      </View>
      {hint ? <Text className="ps-fhint">{hint}</Text> : null}
      {children}
      {err ? <Text className="ps-ferr">{err}</Text> : null}
    </View>
  );
}

export default function PosterConfirmPage() {
  const s = useStore();
  const router = useRouter();
  const accent = s.color().vars['--accent'];
  const sessionId = String(router.params.sessionId ?? '');
  const messageId = String(router.params.messageId ?? '');
  const scope = posterScope(messageId, sessionId);

  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [disabled, setDisabled] = useState(false);      // 能力已关闭：整页收成说明态，不给提交
  const [price, setPrice] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [scene, setScene] = useState<PosterScene>('personal_brand');
  const [goal, setGoal] = useState('');
  const [audience, setAudience] = useState('');
  const [headline, setHeadline] = useState('');
  const [subheadline, setSubheadline] = useState('');
  const [proofs, setProofs] = useState<string[]>(['', '', '']);
  const [cta, setCta] = useState('');
  const [visual, setVisual] = useState('');
  // 启用中的版式清单由 /creative/status 下发（不再硬编码本地目录）。取不到就不渲染版式选择器，
  // 也不带 templateKey 提交——服务端按 scene 回退默认版式，比让用户选到一个必然 422 的版式好。
  const [templates, setTemplates] = useState<PosterTemplateOption[]>([]);
  const [templateKey, setTemplateKey] = useState('');
  // 档位。**高级档只在服务端说可用时才露出来**（premiumAvailable）——供应商没配好时显示一个
  // 必然 422 的选项，比不显示更糟（同版式清单的教训）。缺省恒为标准档。
  const [tier, setTier] = useState<PosterTier>('standard');
  const [premiumPrice, setPremiumPrice] = useState(0);
  const [premiumOn, setPremiumOn] = useState(false);
  const [directions, setDirections] = useState<PosterDirectionOption[]>([]);
  const [directionKey, setDirectionKey] = useState<PosterDirectionKey | ''>('');
  // 以下两项**用户不填也看不到**，只从服务端草稿透传回 submit（方案 §5.3 的 BrandKit 集成靠它落地）：
  //   · brandKitVersion —— 服务端据它取已确认（approved）的品牌资产包，合并品牌语气与主题色板进提示词；
  //   · negativePrompt  —— 服务端从 BrandKit 的品牌禁忌生成的排除项。
  // 曾经确认页 submit 重拼 brief 时把这两个字段丢了 → 服务端侧 brief.brandKitVersion 恒为 null，
  // 整条品牌资产包链路（语气合并 + 色板映射）成了死代码，海报完全忽略用户已确认的品牌资产。
  // MVP 刻意不给 negativePrompt 输入框（不让用户写排除项），所以这里只做透传，不做编辑。
  const [brandKitVersion, setBrandKitVersion] = useState<number | null>(null);
  const [negativePrompt, setNegativePrompt] = useState('');
  const [assets, setAssets] = useState<Partial<Record<CreativeUploadRole, AssetSlot>>>({});
  const [consent, setConsent] = useState(false);
  const [uploading, setUploading] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitErr, setSubmitErr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [unlockAgent, setUnlockAgent] = useState<Agent | null>(null);

  // 幂等键存页面态：本页任何一次提交都用它，重复点击不会建出第二个任务。
  const keyRef = useRef('');
  const aliveRef = useRef(true);
  // 上传是异步的，回调里读渲染时的快照会拿到用户上传期间已改过的旧值 → 用 ref 取当下的方向。
  const directionKeyRef = useRef<PosterDirectionKey | ''>('');
  directionKeyRef.current = directionKey;
  useEffect(() => () => { aliveRef.current = false; }, []);

  const goJob = (jobId: string) => {
    // redirect：详情页顶掉确认页，返回键直接回对话流（不给用户一条「回到已提交的表单」的死路）。
    const ok = redirectToGuarded(`/packages/work/posterJob/index?jobId=${encodeURIComponent(jobId)}`, {
      fail: () => Taro.showToast({ title: '成品图页面加载失败，请重试', icon: 'none' }),
    });
    if (!ok) Taro.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  };

  useEffect(() => {
    // 在途交接：上次点了生成但没拿到 jobId（或拿到了还没看过）→ 直接回到那次任务，别让用户再扣一次。
    const pending = readPosterPending(scope);
    if (pending?.jobId) { goJob(pending.jobId); return; }
    keyRef.current = pending?.idempotencyKey || newIdempotencyKey();

    let alive = true;
    void (async () => {
      // 能力状态与草稿并行取：草稿失败仍可让用户手填，能力关闭则整页收成说明态。
      const [st, draft] = await Promise.all([
        getCreativeStatus(),
        api.posterBriefDraft(sessionId || undefined, messageId || undefined).catch((e) => {
          s.handleApiError(e, { silent: true });
          return null;
        }),
      ]);
      if (!alive) return;
      if (st && !st.enabled) { setDisabled(true); setLoading(false); return; }
      const tpls = st?.templates ?? [];
      // 默认选中第一套启用中的版式（草稿取不到时也得有个可见的选中态；草稿的推荐值在下面覆盖它）。
      if (st) {
        setPrice(st.pricePerPoster);
        setPremiumPrice(st.premiumPricePerPoster);
        setPremiumOn(!!st.premiumAvailable);
        const directionOptions = (st.directions ?? []).map((item) => ({
          ...item,
          ...(item.previewUrl ? { previewUrl: absoluteCreativeUrl(item.previewUrl) } : {}),
        }));
        setDirections(directionOptions);
        setDirectionKey(directionOptions.find((item) => item.tier === 'standard')?.key ?? '');
        setTemplates(tpls);
        setTemplateKey(tpls[0]?.key ?? '');
      }
      if (draft) {
        const b = draft.brief ?? {};
        if (b.scene) setScene(b.scene);
        setGoal(b.goal ?? '');
        setAudience(b.audience ?? '');
        setHeadline(b.headline ?? '');
        setSubheadline(b.subheadline ?? '');
        const pp = (b.proofPoints ?? []).slice(0, PROOF_SLOTS);
        setProofs([pp[0] ?? '', pp[1] ?? '', pp[2] ?? '']);
        setCta(b.cta ?? '');
        setVisual(b.visualDirection ?? '');
        // 品牌资产包透传（不渲染，不给编辑）：草稿里有就存进 state，submit 时原样带回。
        setBrandKitVersion(typeof b.brandKitVersion === 'number' ? b.brandKitVersion : null);
        setNegativePrompt(b.negativePrompt ?? '');
        // 推荐版式已被后台停用时：改选一个**启用中的**并让选中态可见，不静默沿用一个必然 422 的 key。
        const rec = String(b.templateKey ?? '');
        setTemplateKey(tpls.length ? (tpls.some((t) => t.key === rec) ? rec : (tpls[0]?.key ?? '')) : rec);
        if (b.directionKey) setDirectionKey(b.directionKey);
        setReason(draft.templateReason ?? '');
      } else if (messageId) {
        // 只有**带着 messageId 却没拿到草稿**才是真出了事。冷启动（没有 messageId，例如从锦囊
        // 直接开工）服务端本来就 422 MESSAGE_ID_REQUIRED —— 那是「没有可预填的东西」，
        // 不是「预填失败」，弹报错横幅会把一次正常的空白表单说成故障。
        setLoadErr('需求单预填没取到，可以直接手填后生成。');
      }
      setLoading(false);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setProof = (i: number, v: string) => setProofs((cur) => cur.map((x, j) => (j === i ? v : x)));

  const chooseTier = (next: PosterTier) => {
    setTier(next);
    setDirectionKey(directions.find((item) => item.tier === next)?.key ?? '');
    setErrors((cur) => ({ ...cur, direction: '' }));
  };

  /** 重取启用中的版式清单（后台停用某套版式后，本页缓存的清单会过期）。 */
  const refreshTemplates = async () => {
    const st = await getCreativeStatus({ force: true });
    if (!aliveRef.current || !st) return;
    const tpls = st.templates ?? [];
    setTemplates(tpls);
    setTemplateKey((cur) => (tpls.some((t) => t.key === cur) ? cur : (tpls[0]?.key ?? '')));
    const directionOptions = (st.directions ?? []).map((item) => ({
      ...item,
      ...(item.previewUrl ? { previewUrl: absoluteCreativeUrl(item.previewUrl) } : {}),
    }));
    setDirections(directionOptions);
    if (tier === 'premium' && !st.premiumAvailable) {
      setTier('standard');
      setDirectionKey(directionOptions.find((item) => item.tier === 'standard')?.key ?? '');
    }
    else if (!directionOptions.some((item) => item.key === directionKey)) {
      setDirectionKey(directionOptions.find((item) => item.tier === tier)?.key ?? '');
    }
  };

  /** 前置校验：与服务端同口径。返回 true = 可提交。 */
  const validate = (): boolean => {
    const next: Record<string, string> = {};
    const over = (v: string, max: number, label: string) => (v.trim().length > max ? `${label}不超过 ${max} 个字` : '');
    const put = (k: string, msg: string) => { if (msg) next[k] = msg; };
    put('goal', over(goal, LIMITS.goal, '宣传什么'));
    put('audience', over(audience, LIMITS.audience, '给谁看'));
    if (!headline.trim()) next.headline = '主标题不能为空';
    else put('headline', over(headline, LIMITS.headline, '主标题'));
    put('subheadline', over(subheadline, LIMITS.subheadline, '副标题'));
    proofs.forEach((p, i) => put(`proof${i}`, over(p, LIMITS.proofPoint, `第 ${i + 1} 条卖点`)));
    if (!cta.trim()) next.cta = '行动号召不能为空';
    else put('cta', over(cta, LIMITS.cta, '行动号召'));
    put('visual', over(visual, LIMITS.visualDirection, '视觉方向'));
    if (assets.portrait && !consent) next.consent = '请先确认肖像使用权';
    if (directionKey === 'graphic_portrait' && !assets.portrait) next.direction = '「本人形象」需要先上传本人照片';
    if (tier === 'premium' && assets.portrait) next.direction = '「主视觉大片」不使用本人照片，请移除照片或选择「创意排版」';
    setErrors(next);
    if (Object.keys(next).length) {
      Taro.showToast({ title: '还有几处需要改一下', icon: 'none' });
      return false;
    }
    return true;
  };

  /**
   * 本人照片刚选定 / 刚清除的那一刻，把方向拨到与之自洽的一项。
   *
   * 只在这两个时刻动，**不在渲染里强制**：传了照片之后又手动改选别的方向，那是用户的决定，得留住。
   * 传了照片却停在「强标题视觉」，art direction（视觉主角必须是主标题本身）和那张脸会在同一张
   * 画面里互相打架；服务端的 hasPortrait 默认分支本来就想选「本人形象」，是确认页恒钉第一项把它废了。
   * 该路线没有 requiresPortrait 的方向（高级档）时：不切也不提示。
   */
  const syncDirectionForPortrait = (hasPortrait: boolean) => {
    const list = directions.filter((item) => item.tier === tier);
    const current = list.find((item) => item.key === directionKeyRef.current);
    if (hasPortrait) {
      if (current?.requiresPortrait) return;
      const portraitOne = list.find((item) => item.requiresPortrait);
      if (!portraitOne) return;
      setDirectionKey(portraitOne.key);
      setErrors((e) => ({ ...e, direction: '' }));
      Taro.showToast({ title: `已切换到「${portraitOne.name || '本人形象'}」方向`, icon: 'none' });
      return;
    }
    if (!current?.requiresPortrait) return;
    setDirectionKey(list[0]?.key ?? '');
    setErrors((e) => ({ ...e, direction: '' }));
  };

  const pickAsset = async (role: CreativeUploadRole) => {
    if (uploading || submitting) return;
    if (role === 'portrait' && !consent) {
      setErrors((e) => ({ ...e, consent: '请先确认肖像使用权' }));
      Taro.showToast({ title: '请先勾选肖像确认', icon: 'none' });
      return;
    }
    let picked: Taro.chooseImage.SuccessCallbackResult;
    try {
      picked = await Taro.chooseImage({ count: 1, sizeType: ['compressed'], sourceType: ['album', 'camera'] });
    } catch {
      return; // 用户取消
    }
    const file = (picked.tempFiles ?? [])[0] as { path?: string; size?: number } | undefined;
    const path = file?.path || (picked.tempFilePaths ?? [])[0];
    if (!path) return;
    const chk = checkImageUpload({ size: file?.size });
    if (!chk.ok) { Taro.showToast({ title: chk.desc || chk.title || '图片太大了', icon: 'none' }); return; }
    setUploading(role);
    try {
      const r = await api.uploadCreativeAsset(path, role);
      if (!aliveRef.current) return;
      setAssets((cur) => ({ ...cur, [role]: { assetId: r.assetId, path } }));
      if (role === 'portrait') syncDirectionForPortrait(true);
    } catch (e) {
      s.handleApiError(e, { fallbackTitle: '图片上传失败，请重试' });
    } finally {
      if (aliveRef.current) setUploading('');
    }
  };

  const dropAsset = (role: CreativeUploadRole) => {
    setAssets((cur) => {
      const next = { ...cur };
      delete next[role];
      return next;
    });
    if (role === 'portrait') {
      setErrors((e) => ({ ...e, consent: '' }));
      syncDirectionForPortrait(false);
    }
  };

  const submit = async () => {
    if (submitting || disabled) return;
    if (!validate()) return;
    setSubmitErr('');
    const brief: PosterBrief = {
      scene,
      goal: goal.trim(),
      audience: audience.trim(),
      headline: headline.trim(),
      ...(subheadline.trim() ? { subheadline: subheadline.trim() } : {}),
      proofPoints: proofs.map((p) => p.trim()).filter(Boolean),
      cta: cta.trim(),
      visualDirection: visual.trim(),
      // 服务端生成的排除项，原样带回（用户看不到也改不了，丢了就等于关掉品牌禁忌）。
      ...(negativePrompt.trim() ? { negativePrompt: negativePrompt.trim() } : {}),
      // 空串 = 版式清单没取到 → 不带该字段，让服务端按 scene 回退默认版式。
      ...(templateKey ? { templateKey } : {}),
      // 只在高级档可用时才敢带 premium：状态过期时（用户停在本页、运营关了供应商）服务端会 422，
      // 这里少发一次也少一次白扣的风险。
      tier: premiumOn ? tier : 'standard',
      ...(directionKey ? { directionKey } : {}),
      ratio: '3:4',
      ...(assets.portrait ? { portraitAssetId: assets.portrait.assetId } : {}),
      ...(assets.logo ? { logoAssetId: assets.logo.assetId } : {}),
      ...(assets.qr ? { qrAssetId: assets.qr.assetId } : {}),
      // 品牌资产包版本：服务端据此取 approved BrandKit 并把品牌语气/色板合进提示词。必须带回。
      ...(brandKitVersion ? { brandKitVersion } : {}),
    };
    setSubmitting(true);
    // 先落幂等键，再发请求：请求在途被杀进程也留得下键，重进本页沿用同一键不会重复扣费。
    markPosterPending(scope, keyRef.current);
    try {
      const r = await api.createPosterJob({
        brief,
        ...(sessionId ? { sessionId } : {}),
        ...(messageId ? { messageId } : {}),
        idempotencyKey: keyRef.current,
      });
      attachPosterJob(scope, r.jobId);
      if (!aliveRef.current) return;
      goJob(r.jobId);
    } catch (e) {
      if (!aliveRef.current) return;
      const code = String((e as { code?: string }).code || (e as { data?: { code?: string } }).data?.code || '');
      const msg = String((e as { message?: string }).message || '');
      if (code === 'CANVAS_DISABLED') {
        setDisabled(true);
        Taro.showToast({ title: '成品图能力暂未开放', icon: 'none' });
      } else if (code === 'AGENT_LOCKED') {
        const poster = store.agents().find((a) => a.key === 'poster') ?? null;
        if (poster) setUnlockAgent(poster);
        else Taro.showToast({ title: '请先启用海报设计师', icon: 'none' });
      } else if (code === 'INSUFFICIENT_CREDITS') {
        setSubmitErr('钻石不足，去「我的 · 权益额度」看看余额。');
        Taro.showToast({ title: '钻石不足', icon: 'none' });
      } else if (code === 'CREATIVE_DAILY_LIMIT') {
        setSubmitErr('今日出图额度已满，明天再来。');
        Taro.showToast({ title: '今日额度已满', icon: 'none' });
      } else if (code === 'PLAN_EXPIRED') {
        setSubmitErr('当前方案已到期，续期后可继续出图。');
      } else if (code === 'PLAN_REQUIRED') {
        setSubmitErr('尚未开通方案，开通后即可出图。');
        Taro.showToast({ title: '尚未开通方案', icon: 'none' });
      } else if (code === 'BRIEF_INVALID' || code === 'MODERATION_BLOCKED') {
        setSubmitErr(msg || '需求单没通过校验，改一下再试。');
        // 版式在本页停留期间被后台停用（服务端对显式请求停用版式一律 422，不静默换版照常扣费）：
        // 强制重取一次清单，让选择器立刻少掉那一项，用户改选后就能继续，而不是卡在同一个错误上。
        if (/版式/.test(msg)) void refreshTemplates();
      } else {
        s.handleApiError(e, { fallbackTitle: '发起出图失败，请重试' });
      }
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  };

  const goCredits = () => {
    const ok = navTo('/packages/work/credits/index', {
      fail: () => Taro.showToast({ title: '页面加载失败，请重试', icon: 'none' }),
    });
    if (!ok) Taro.showToast({ title: '页面正在打开，请稍候', icon: 'none' });
  };

  if (disabled) {
    return (
      <View className={`page poster-set ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
        <SafeHeader title="成品图" onBack={() => Taro.navigateBack()} />
        <View className="ps-pad">
          <View className="ps-empty">
            <Text className="ps-empty-t serif">成品图暂未开放</Text>
            <Text className="ps-empty-d">海报设计师的文字方案不受影响，可继续在对话里推进。</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View className={`page poster-set ${s.themeClass()}`} style={{ minHeight: '100vh' }}>
      <SafeHeader title="成品图需求单" onBack={() => Taro.navigateBack()} />
      <View className="ps-pad">
        {loading ? (
          <View className="ps-loading"><Text>正在取需求单…</Text></View>
        ) : (
          <>
            {/* 版式推荐理由 = 设计师的「为什么这样设计」，原样展示（惊喜感文案位） */}
            {reason ? (
              <View className="ps-reason" style={{ borderColor: accent }}>
                <View className="ps-reason-h">
                  <Icon name="spark" size={13} color={accent} />
                  <Text className="ps-reason-k">军师为什么这样设计</Text>
                </View>
                <Text className="ps-reason-b">{reason}</Text>
              </View>
            ) : null}
            {loadErr ? <Text className="ps-note">{loadErr}</Text> : null}

            <Text className="ps-sec">先说清这张图要干什么</Text>
            <Field label="宣传什么" err={errors.goal} count={<Counter value={goal} max={LIMITS.goal} />}>
              <KbInput anchorId="ps-goal" className="ps-input" value={goal} placeholder="这张海报要促成什么" onInput={(e) => setGoal(e.detail.value)} />
            </Field>
            <Field label="给谁看" err={errors.audience} count={<Counter value={audience} max={LIMITS.audience} />}>
              <KbInput anchorId="ps-aud" className="ps-input" value={audience} placeholder="目标客群是谁" onInput={(e) => setAudience(e.detail.value)} />
            </Field>

            <Text className="ps-sec">画面上的字</Text>
            <Field label="主标题" hint="一张海报只讲一件事" err={errors.headline} count={<Counter value={headline} max={LIMITS.headline} />}>
              <KbInput anchorId="ps-head" className="ps-input" value={headline} placeholder="最想让人记住的一句" onInput={(e) => setHeadline(e.detail.value)} />
            </Field>
            <Field label="副标题" err={errors.subheadline} count={<Counter value={subheadline} max={LIMITS.subheadline} />}>
              <KbInput anchorId="ps-sub" className="ps-input" value={subheadline} placeholder="可留空" onInput={(e) => setSubheadline(e.detail.value)} />
            </Field>
            <Field label="卖点" hint="最多 3 条，每条一句话">
              {proofs.map((p, i) => (
                <View key={`proof-${i}`} className="ps-proof">
                  <View className="ps-flabel">
                    <Text className="ps-fl sm">{`第 ${i + 1} 条`}</Text>
                    <Counter value={p} max={LIMITS.proofPoint} />
                  </View>
                  <KbInput
                    anchorId={`ps-proof-${i}`}
                    className="ps-input"
                    value={p}
                    placeholder={i === 0 ? '可留空' : ''}
                    onInput={(e) => setProof(i, e.detail.value)}
                  />
                  {errors[`proof${i}`] ? <Text className="ps-ferr">{errors[`proof${i}`]}</Text> : null}
                </View>
              ))}
            </Field>
            <Field label="行动号召" err={errors.cta} count={<Counter value={cta} max={LIMITS.cta} />}>
              <KbInput anchorId="ps-cta" className="ps-input" value={cta} placeholder="如：扫码来聊" onInput={(e) => setCta(e.detail.value)} />
            </Field>

            <Text className="ps-sec">画面长什么样</Text>
            <Field label="视觉方向" hint="只写画面属性：结构 / 色彩 / 材质 / 光线 / 构图" err={errors.visual} count={<Counter value={visual} max={LIMITS.visualDirection} />}>
              <Textarea className="ps-area" value={visual} placeholder="如：干净留白、克制的墨色与暖金、正面柔光" onInput={(e) => setVisual(e.detail.value)} />
            </Field>
            {/* 版式清单来自 /creative/status（只含启用中的）。一套都没下发时整块不渲染：
                硬编码三套恒可选会让用户选到已停用的版式，而服务端对此一律 422。 */}
            {templates.length ? (
              <Field label="版式">
                <View className="ps-tpls">
                  {templates.map((t) => {
                    const on = t.key === templateKey;
                    return (
                      <View
                        key={t.key}
                        className={`ps-tpl${on ? ' on' : ''}`}
                        style={on ? { borderColor: accent } : undefined}
                        onClick={() => setTemplateKey(t.key)}
                      >
                        <View className="ps-tpl-h">
                          <Text className="ps-tpl-n">{t.name}</Text>
                          {on ? <Icon name="check" size={13} color={accent} /> : null}
                        </View>
                        <Text className="ps-tpl-d">{t.desc}</Text>
                      </View>
                    );
                  })}
                </View>
              </Field>
            ) : null}

            <Field label="这次怎么创作">
              <View className="ps-tpls">
                {([
                  ['standard', '创意排版', `x${price} · 用图形、字体和你的素材现场创作`],
                  ...(premiumOn ? [['premium', '主视觉大片', `x${premiumPrice} · AI 先创作全幅主视觉，再由军师排中文`]] : []),
                ] as [PosterTier, string, string][]).map(([k, name, desc]) => {
                    const on = k === tier;
                    return (
                      <View
                        key={k}
                        className={`ps-tpl${on ? ' on' : ''}`}
                        style={on ? { borderColor: accent } : undefined}
                        onClick={() => chooseTier(k)}
                      >
                        <View className="ps-tpl-h">
                          <Text className="ps-tpl-n">{name}</Text>
                          {on ? <Icon name="check" size={13} color={accent} /> : null}
                        </View>
                        <View className="ps-tpl-cost">
                          <Icon name="diamond" size={12} color={accent} />
                          <Text className="ps-tpl-d">{desc}</Text>
                        </View>
                      </View>
                    );
                })}
              </View>
              {tier === 'premium' ? (
                <Text className="ps-fhint">主视觉大片不使用你上传的本人照片；人物方向是 AI 演绎，并非本人。标题等中文仍由军师排版。</Text>
              ) : null}
            </Field>

            {directions.some((item) => item.tier === tier) ? (
              <Field label="想往哪个方向做" err={errors.direction}>
                <View className="ps-dir-grid">
                  {directions.filter((item) => item.tier === tier).map((item) => {
                    const on = item.key === directionKey;
                    return (
                      <View key={item.key} className={`ps-dir${on ? ' on' : ''}`} onClick={() => { setDirectionKey(item.key); setErrors((cur) => ({ ...cur, direction: '' })); }}>
                        {item.previewUrl ? (
                          <Image className="ps-dir-img" src={item.previewUrl} mode="aspectFill" />
                        ) : (
                          <View className="ps-dir-placeholder"><Icon name="image" size={18} color="#7E848B" /><Text>样例待发布</Text></View>
                        )}
                        <View className="ps-dir-body">
                          <View className="ps-dir-name"><Text>{item.name}</Text>{on ? <Icon name="check" size={12} color={accent} /> : null}</View>
                          <Text className="ps-dir-desc">{item.desc}</Text>
                          {item.note ? <Text className="ps-dir-note">{item.note}</Text> : null}
                        </View>
                      </View>
                    );
                  })}
                </View>
              </Field>
            ) : null}

            <Text className="ps-sec">素材（可留空）</Text>
            {/* 肖像确认：人像上传的前置门（未勾选不给选图），文案取方案 §12.3 精简版 */}
            <View className="ps-consent" onClick={() => { setConsent((v) => !v); setErrors((e) => ({ ...e, consent: '' })); }}>
              <View className={`ps-check${consent ? ' on' : ''}`} style={consent ? { background: accent, borderColor: accent } : undefined}>
                {consent ? <Icon name="check" size={11} color="#fff" /> : null}
              </View>
              <View className="ps-consent-b">
                <Text className="ps-consent-t">上传人像前请确认</Text>
                {PORTRAIT_CONSENT.map((line, i) => <Text key={`pc-${i}`} className="ps-consent-l">{`· ${line}`}</Text>)}
              </View>
            </View>
            {errors.consent ? <Text className="ps-ferr">{errors.consent}</Text> : null}
            <View className="ps-slots">
              {(['portrait', 'logo', 'qr'] as CreativeUploadRole[]).map((role) => {
                const slot = assets[role];
                return (
                  <View key={role} className="ps-slot">
                    {slot ? (
                      <View className="ps-thumb-wrap">
                        <Image className="ps-thumb" src={slot.path} mode="aspectFill" />
                        <Text className="ps-thumb-x" onClick={() => dropAsset(role)}>×</Text>
                      </View>
                    ) : (
                      <View className="ps-slot-add" onClick={() => pickAsset(role)}>
                        <Icon name="image" size={16} color="#7E848B" />
                        <Text className="ps-slot-t">{uploading === role ? '上传中…' : `传${ROLE_LABEL[role]}`}</Text>
                      </View>
                    )}
                    <Text className="ps-slot-k">{ROLE_LABEL[role]}</Text>
                  </View>
                );
              })}
            </View>

            {submitErr ? (
              <View className="ps-submit-err">
                <Text className="ps-submit-err-t">{submitErr}</Text>
                {submitErr.includes('钻石') ? <Text className="ps-submit-err-a" style={{ color: accent }} onClick={goCredits}>去看余额</Text> : null}
              </View>
            ) : null}

            <View className="ps-foot">
              <Text className="ps-foot-note">出图约一分钟，成品可保存或转发。</Text>
              <View className="ps-btn" style={{ background: accent }} onClick={submit}>
                <Text className="ps-btn-t">{submitting ? '正在发起…' : '生成成品图'}</Text>
                {/* 按钮上的价格必须跟着**选中的档位**走：选了高级却显示标准价，是在扣费那一刻
                    说了假话（服务端按 priceForTier 扣的是 25）。判据与 submit 里带 tier 的判据
                    逐字同源（premiumOn && tier === 'premium'），两处不能各写各的。 */}
                {typeof price === 'number' ? (
                  <Text className="ps-btn-c">{`💎x${premiumOn && tier === 'premium' ? premiumPrice : price}`}</Text>
                ) : null}
              </View>
            </View>
          </>
        )}
      </View>
      <AgentUnlock
        agent={unlockAgent}
        onClose={() => setUnlockAgent(null)}
        onUnlocked={() => { setUnlockAgent(null); Taro.showToast({ title: '已启用，可再次生成', icon: 'none' }); }}
      />
    </View>
  );
}
