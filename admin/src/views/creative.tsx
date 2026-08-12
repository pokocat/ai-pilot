// 创作任务（海报成品图 · canvas_design）：功能配置 + 图片供应商接入点 + 任务台。
//
// 为什么三块并在一屏：运营处置这个功能的动线是「先看队列里有多少在跑 / 失败几单 → 再决定
// 关开关、调单价、换供应商、重试」。把配置和后果拆成两屏，改完配置就看不见影响了。
//
// 权限：后端写操作（改配置 / 供应商试跑 / 重试任务）一律 requireSuper（owner/master），
// 读（配置 / 任务列表）是普通运营可见。页面按 isSuper 收起写入口并显式说明「只读」——
// 让运营先知道自己不能改，比点下去再吃一个错误好。真的吃到 403 也不再是灾难：api.ts 已把
// 403 与 401 分开（403 保留登录态、抛带 code 的错误），这里的 toast / ConfirmDialog 内联
// 错误 / 试跑结果条会把「需要 owner 权限」原样显示出来。
//
// 开关只有一层：本页 enabled（FeatureFlag 行 'creative-poster'）就是唯一真源。2026-07 删掉了部署级
// env 开关 CANVAS_DESIGN_ENABLED —— 合取双开关制造「后台开了却不生效」的静默失败，作熔断还比 DB 开关
// 慢（要 SSH + 重启）。代价是这个开关变重了：打开保存 = 立刻放量 + 立刻开始扣钻，没有第二道闸门兜底。
// 所以页面必须把这件事写在开关旁（.ai-note），并对 关→开 走 ConfirmDialog 回显单价与限额。
//
// 排版引擎（2026-07-29 起）是另一回事，别按开关的规格对待它：AI 排版失败必回落模板，付费任务不会因它
// 失败，所以它可逆、不涉资金、不弹确认框，文案也不该写成「实验性功能」。它真正的风险是**静默失效** ——
// AI 挂了照样出模板图、任务照样全绿，配置页看起来一直是「AI 排版」。所以观测的重心放在任务台：每行显示
// 本单实际引擎，template_fallback 用警示色 + 回落原因，汇总条给一个（本页样本的）AI 回落率。

import { useCallback, useEffect, useState } from 'react';
import Icon from '../Icon';
import NumInput from '../NumInput';
import {
  api, type AdminCreativeConfig, type AdminCreativeConfigUpdate, type AdminCreativeJobItem,
  type AdminCreativeVisualConfig,
} from '../api';
import { PageHead, ViewState, ConfirmDialog, ErrorState, Skeleton, type ConfirmSpec } from '../components';
import { useResource } from '../useResource';
import { fmtTime } from '../format';

/**
 * 模板白名单与中文名（描述与服务端 TEMPLATE_CATALOG 对齐；缺省视为启用，运营只需显式停用问题模板）。
 *
 * 为什么后台不像小程序那样吃服务端下发的列表：`/creative/status` 只下发**启用中**的版式，
 * 而后台恰恰要把被停用的那几套也列出来才能重新打开。所以这份本地目录必须留着。
 */
const TEMPLATES: [string, string, string][] = [
  ['person_hero', '人物主视觉', '真人照片打底，人物占据主视觉'],
  ['editorial', '编辑杂志', '杂志内页式排版，图文并重'],
  ['business_launch', '商业发布', '发布会 / 新品公告气质'],
];

/**
 * 排版引擎两项（措辞对齐 shared/contracts.d.ts 的契约注释）。
 *
 * 刻意**不**写成「实验性 / 有风险 / 可能失败」：AI 引擎的任何一步走不通（模型不可用、HTML 不合规、
 * 量测反复不过）都会自动回落到模板路径，付费任务不会因为它失败。所以这是「要不要试更好的画质」，
 * 不是风险开关，恐吓文案只会让运营永远不敢打开它。真正需要盯的是**回落率** —— 见任务台汇总条。
 */
const LAYOUT_ENGINES: ['ai' | 'template', string, string][] = [
  ['ai', 'AI 排版', '模型按设计哲学自由创作整页版式，量测不过自动修正，失败自动回落模板'],
  ['template', '模板排版', '固定三套版式（上一代行为），不调用创作模型'],
];

function engineName(k: string): string {
  return LAYOUT_ENGINES.find(([key]) => key === k)?.[1] ?? k;
}

/**
 * AI 创作路线三项（2026-07-30 影像主导模式）。措辞对齐 shared/contracts.d.ts 的契约注释。
 *
 * 同样**不写成风险开关**：photo 链任一步走不通就退回 graphic 复用同一篇宣言，再失败才回落模板，
 * 交付与计费都不受影响。但它有**三条门禁**，副文案必须说清 —— 否则运营切到「影像」后看到任务台
 * 全是「AI 排版」，会以为功能坏了（真实原因往往是没配图片供应商，或用户传了本人照片）。
 */
const AI_MODES: ['auto' | 'graphic' | 'photo', string, string][] = [
  ['auto', '模型自选', '让模型按这张海报的诉求自己决定走影像还是纯图形（推荐）'],
  ['photo', '影像优先', '优先让生图模型出全幅主视觉、排版层只叠字；不满足门禁时自动降为纯图形'],
  ['graphic', '纯图形', '只用 CSS/SVG 图形与排印作画，完全不调生图模型'],
];

function aiModeName(k: string): string {
  return AI_MODES.find(([key]) => key === k)?.[1] ?? k;
}

/**
 * 图片供应商的接口方言（与服务端 config.VISUAL_DIALECTS 同口径）。
 * 选项文案要把**那条会翻车的差异**写出来，而不是只写品牌名 —— 运营选错时唯一的现场信息是
 * 试跑返回的 HTTP 400，那条错误说不出「你该换个方言」。
 */
const VISUAL_DIALECTS: [AdminCreativeVisualConfig['dialect'], string, string][] = [
  ['ark_seedream', '方舟 Seedream', '火山方舟；服务端强制关水印、用原生负向提示词'],
  ['gpt_image', 'GPT Image', 'OpenAI gpt-image-1；不发 response_format（发了必 400）'],
  ['openai', '通用 OpenAI', '其它 images 兼容接口（老行为）'],
];

/**
 * 影像风格档中文名（12 档，与服务端 styleLibrary.POSTER_STYLES 同口径）。
 *
 * 为什么后台留一份本地目录：这里只做**展示**（任务台要把 `mono_authority_portrait` 说成人话），
 * 运营不选档、也没有「启用/停用某一档」的动作 —— 档位由模型按 brief 选。所以不值得为它开一个
 * 下发接口；真要下发时（例如将来允许运营锁定某几档）再换成服务端目录。
 * 未知 key 原样显示，不冒充已知档（同 engineTag 的口径）。
 */
const POSTER_STYLE_NAMES: Record<string, string> = {
  quiet_luxury_grey: '静奢空间摄影',
  baroque_icon_gold: '巴洛克圣像金',
  editorial_black_gold: '编辑部黑金',
  neo_chinese_void: '新中式留白',
  documentary_film_grain: '纪实胶片',
  luxury_magazine_cover: '奢侈品杂志封面',
  airy_japanese_light: '清透日系',
  cyber_tech_blue: '赛博科技蓝',
  retro_hongkong: '复古港风',
  glossy_3d_trend: '3D 潮流',
  mono_authority_portrait: '黑白权威肖像',
  surreal_object_metaphor: '超现实隐喻静物',
};

export function styleLabel(k: string | null | undefined): string {
  if (!k) return '';
  return POSTER_STYLE_NAMES[k] ?? k;
}

const JOB_STATUS: [string, string][] = [
  ['', '全部'], ['pending', '排队中'], ['running', '生成中'],
  ['succeeded', '已完成'], ['failed', '失败'], ['cancelled', '已取消'],
];

const STATUS_LABEL: Record<string, string> = {
  pending: '排队中', running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已取消',
};

/** 状态 → tag 修饰类：绿=成功、ochre=需要关注、灰=中性（红只留给破坏性动作按钮，见 DESIGN.md）。 */
function statusTag(s: string): string {
  if (s === 'succeeded') return 'tag live';
  if (s === 'failed') return 'tag warn';
  if (s === 'running') return 'tag';
  return 'tag off';
}

function templateLabel(k: string | null): string {
  if (!k) return '未指定模板';
  return TEMPLATES.find(([key]) => key === k)?.[1] ?? k;
}

/**
 * 本单**实际**走的排版引擎 → 行内 tag。
 *
 * 为什么必须显眼：AI 引擎失败会静默回落成一张模板图，任务照样是绿的、照样扣费。不显示的话，
 * 「AI 排版在生产整天没生效」这件事只存在于服务端日志里（供应商降级 degraded 已经踩过一次）。
 * 所以 template_fallback 用警示色，并把 aiEngineError 挂到 title 上 —— 这是运营唯一的入口。
 *
 * 返回 null = 不显示标签：老任务 / 未完成任务的 layoutEngine 是 null，硬显示成「模板」是撒谎。
 * 未来出现的新引擎值原样显示（中性色），也不冒充已知的三种。
 */
export function engineTag(
  j: Pick<AdminCreativeJobItem, 'layoutEngine' | 'rounds' | 'aiEngineError' | 'aiMode' | 'styleKey'>,
): { cls: string; label: string; title: string } | null {
  const e = j.layoutEngine;
  if (!e) return null;
  if (e === 'ai') {
    // 影像主导（photo）与纯图形（graphic）是两种成品，标签必须分得开：一个是「生图模型出主视觉 +
    // 排版层叠字」，一个是「纯 CSS/SVG 作画」。老任务的 aiMode 是 null → 按原来的「AI 排版」显示
    //（不冒充 graphic：那会让「影像路线占比」这个判断失真，和 layoutEngine=null 同一个道理）。
    const photo = j.aiMode === 'photo';
    const name = photo ? 'AI 影像' : 'AI 排版';
    const style = photo ? styleLabel(j.styleKey) : '';
    return {
      cls: 'tag',
      // rounds：1=一次成（未打磨，理论上不该出现）、2=创作 + 强制打磨、3=还修了一轮违规。
      label: j.rounds ? `${name} · ${j.rounds}轮` : name,
      title: [
        photo
          ? `影像主导：生图模型出全幅主视觉${style ? `（风格：${style}）` : ''}，排版层只做文字叠层`
          : '纯图形排印：模型用 CSS/SVG 自由创作，未调生图模型',
        j.rounds ? `共 ${j.rounds} 轮 LLM 调用（含量测后的打磨/修正）` : '未记录轮数',
      ].join('。'),
    };
  }
  if (e === 'template') return { cls: 'tag off', label: '模板', title: '按配置走模板排版路径，未调用创作模型' };
  if (e === 'template_fallback') {
    return {
      cls: 'tag warn',
      label: '回落模板',
      title: `AI 排版没跑通，本单已回落模板出图（用户拿到的是模板版）。原因：${j.aiEngineError || '未记录'}`,
    };
  }
  return { cls: 'tag off', label: e, title: `未知排版引擎取值：${e}` };
}

/**
 * 当前页 AI 回落率。分母只算**判定过排版引擎**的单（ai + template_fallback）：
 * template 是运营自己选的路径、null 是老任务，都不该稀释这个比例。分母 0 时返回 null（不显示瓷贴）。
 *
 * 这不是精确指标 —— 只统计当前页（且受状态筛选影响），所以呈现时必须写明「本页样本」，
 * 不能让运营拿它当 SLO。真要精确口径得服务端出聚合，不在本页职责内。
 */
export function fallbackStat(
  items: Pick<AdminCreativeJobItem, 'layoutEngine'>[],
): { fallback: number; total: number; pct: number } | null {
  let ai = 0;
  let fallback = 0;
  for (const j of items) {
    if (j.layoutEngine === 'ai') ai += 1;
    else if (j.layoutEngine === 'template_fallback') fallback += 1;
  }
  const total = ai + fallback;
  if (total === 0) return null;
  return { fallback, total, pct: Math.round((fallback / total) * 100) };
}

/** 毫秒配置项的人话副标（运营调的是「几分钟」，输入框收的是毫秒）。 */
function msHint(ms: number): string {
  return ms >= 60_000 ? `约 ${(ms / 60_000).toFixed(1)} 分钟` : `约 ${Math.round(ms / 1000)} 秒`;
}

interface CfgDraft {
  enabled: boolean;
  pricePerPoster: number;
  premiumPricePerPoster: number;
  dailyLimit: number;
  timeoutMs: number;
  layoutEngine: 'ai' | 'template';
  aiMode: 'auto' | 'graphic' | 'photo';
  templates: Record<string, boolean>;
  visualEnabled: boolean;
  /** 接口方言：三家 images 接口长得像但请求体不兼容，填错的症状是 dry-run 报 400。 */
  dialect: AdminCreativeVisualConfig['dialect'];
  baseUrl: string;
  model: string;
  size: string;
  visualTimeoutMs: number;
  /** 额外请求参数模板（JSON 文本；原样合并进供应商请求体）。 */
  extraParamsText: string;
  /** 本次输入的新密钥；空串=不动（清除走专门的按钮，语义与后端 ''=清空 区分开）。 */
  apiKey: string;
}

/** 空对象归一成空串，让「没配额外参数」显示成空输入框而不是一个 `{}`。 */
function extraParamsToText(v: Record<string, unknown>): string {
  return Object.keys(v).length === 0 ? '' : JSON.stringify(v, null, 2);
}

function toDraft(c: AdminCreativeConfig): CfgDraft {
  return {
    enabled: c.enabled,
    pricePerPoster: c.pricePerPoster,
    premiumPricePerPoster: c.premiumPricePerPoster,
    dailyLimit: c.dailyLimit,
    timeoutMs: c.timeoutMs,
    layoutEngine: c.layoutEngine,
    aiMode: c.aiMode,
    templates: { ...c.templates },
    visualEnabled: c.visual.enabled,
    dialect: c.visual.dialect,
    baseUrl: c.visual.baseUrl,
    model: c.visual.model,
    size: c.visual.size,
    visualTimeoutMs: c.visual.timeoutMs,
    extraParamsText: extraParamsToText(c.visual.extraParams),
    apiKey: '',
  };
}

function basicsDirty(d: CfgDraft, c: AdminCreativeConfig): boolean {
  return d.enabled !== c.enabled
    || d.pricePerPoster !== c.pricePerPoster
    || d.premiumPricePerPoster !== c.premiumPricePerPoster
    || d.dailyLimit !== c.dailyLimit
    || d.timeoutMs !== c.timeoutMs
    || d.layoutEngine !== c.layoutEngine
    || d.aiMode !== c.aiMode
    || TEMPLATES.some(([k]) => !!d.templates[k] !== !!c.templates[k]);
}

function visualDirty(d: CfgDraft, c: AdminCreativeConfig): boolean {
  return d.visualEnabled !== c.visual.enabled
    || d.dialect !== c.visual.dialect
    || d.baseUrl.trim() !== c.visual.baseUrl
    || d.model.trim() !== c.visual.model
    || d.size.trim() !== c.visual.size
    || d.visualTimeoutMs !== c.visual.timeoutMs
    || d.extraParamsText.trim() !== extraParamsToText(c.visual.extraParams)
    || d.apiKey.trim() !== '';
}

export function CreativeView({ toast, isSuper }: { toast: (m: string) => void; isSuper: boolean }) {
  const cfgRes = useResource(api.creativeConfig, []);
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const jobs = useResource(
    useCallback(() => api.creativeJobs({ status: status || undefined, page }), [status, page]),
    [status, page],
  );

  const [draft, setDraft] = useState<CfgDraft | null>(null);
  const [busy, setBusy] = useState('');
  const [dry, setDry] = useState<{ ok: boolean; msg: string } | null>(null);
  const [openErr, setOpenErr] = useState('');
  const [openPhil, setOpenPhil] = useState('');
  const [confirmSpec, setConfirmSpec] = useState<ConfirmSpec | null>(null);

  const cfg = cfgRes.data;
  // 每次拿到新配置（首载 / 刷新 / 保存后回填）都重置草稿：顺带清掉密钥输入框与 dirty 态。
  useEffect(() => { if (cfg) setDraft(toDraft(cfg)); }, [cfg]);

  const cfgReload = cfgRes.reload;
  const jobsReload = jobs.reload;
  const reloadAll = useCallback(() => { cfgReload(); jobsReload(); }, [cfgReload, jobsReload]);

  const set = (p: Partial<CfgDraft>) => setDraft((d) => d && { ...d, ...p });
  const setTpl = (k: string, on: boolean) => setDraft((d) => d && { ...d, templates: { ...d.templates, [k]: on } });

  // 保存：成功后用返回的完整配置就地替换（省一次往返，也保证 hasKey 立刻正确）。
  const put = async (body: AdminCreativeConfigUpdate, okMsg: string) => {
    const next = await api.saveCreativeConfig(body);
    cfgRes.setData(next);
    toast(okMsg);
  };

  const saveBasics = () => {
    if (!draft || !cfg) return;
    const body: AdminCreativeConfigUpdate = {
      enabled: draft.enabled,
      pricePerPoster: draft.pricePerPoster,
      premiumPricePerPoster: draft.premiumPricePerPoster,
      dailyLimit: draft.dailyLimit,
      timeoutMs: draft.timeoutMs,
      layoutEngine: draft.layoutEngine,
      aiMode: draft.aiMode,
      templates: draft.templates,
    };
    const run = async () => { setBusy('basics'); try { await put(body, '配置已保存'); } finally { setBusy(''); } };
    // 两类改动必须回显再确认：
    //   · 开关 关→开：这是唯一的放量闸门（部署级 env 开关已删），保存即刻放量并开始扣钻；
    //   · 单价变更：改一次影响此后每一张海报的扣费。
    // 两件事常常一起发生（先定价再开量），合成**一个**对话框回显，不要连弹两次。
    // 关闭方向不拦：停量是止血动作，多一次点击就是多一分钟的损失。
    //
    // 排版引擎切换**自己不弹框**：它可逆、不涉资金、失败必回落（见 LAYOUT_ENGINES 注释）。但如果它和
    // 改价/放量同批保存，就顺带回显一行 —— 一次保存里改了几件事，确认框必须说全，否则回显反而误导。
    const turningOn = draft.enabled && !cfg.enabled;
    // 两档单价任一变更都要回显 —— 高级档一张 25 钻，改错了比标准档更贵。
    const priceChanged = draft.pricePerPoster !== cfg.pricePerPoster
      || draft.premiumPricePerPoster !== cfg.premiumPricePerPoster;
    const engineChanged = draft.layoutEngine !== cfg.layoutEngine;
    if (turningOn || priceChanged) {
      const echo: NonNullable<ConfirmSpec['echo']> = [];
      if (turningOn) echo.push({ k: '功能开关', v: '未开启 → 已开启' });
      if (draft.pricePerPoster !== cfg.pricePerPoster) {
        echo.push({ k: '标准档原价', v: `${cfg.pricePerPoster} 钻 / 张`, amount: true });
        echo.push({ k: '标准档新价', v: `${draft.pricePerPoster} 钻 / 张`, amount: true });
      } else {
        echo.push({ k: '标准档单价', v: `${draft.pricePerPoster} 钻 / 张`, amount: true });
      }
      if (draft.premiumPricePerPoster !== cfg.premiumPricePerPoster) {
        echo.push({ k: '高级档原价', v: `${cfg.premiumPricePerPoster} 钻 / 张`, amount: true });
        echo.push({ k: '高级档新价', v: `${draft.premiumPricePerPoster} 钻 / 张`, amount: true });
      } else {
        echo.push({ k: '高级档单价', v: `${draft.premiumPricePerPoster} 钻 / 张`, amount: true });
      }
      echo.push({ k: '每日限额', v: draft.dailyLimit === 0 ? '不限量（0 = 不限）' : `${draft.dailyLimit} 张 / 人` });
      if (engineChanged) {
        echo.push({
          k: '排版引擎',
          v: `${engineName(cfg.layoutEngine)} → ${engineName(draft.layoutEngine)}（同批保存）`,
        });
      }
      // 同上：路线切换自己不弹框，但和改价/放量同批保存时必须一起回显 —— 一次保存里改了几件事，
      // 确认框说不全反而误导。
      if (draft.aiMode !== cfg.aiMode) {
        echo.push({
          k: 'AI 创作路线',
          v: `${aiModeName(cfg.aiMode)} → ${aiModeName(draft.aiMode)}（同批保存）`,
        });
      }
      setConfirmSpec({
        title: turningOn ? '开启海报出图（等于放量）' : '修改单张海报价格',
        desc: turningOn
          ? '保存后立刻对所有已解锁 poster 的用户生效：小程序侧出现出图入口，用户每出一张按下面回显的单价预扣钻石（失败自动退款）。这是唯一的闸门，没有部署级开关兜底；要停量就回到这里关掉它。'
          : '保存后立即生效：此后每次出图按新价预扣钻石（失败自动退款）。已在队列里的任务按创建时的价格结算，不受影响。',
        warn: priceChanged ? '这是资金口径变更，会写入审计日志。' : '开关变更会写入审计日志。',
        echo,
        confirmText: turningOn ? '确认开启并放量' : '确认改价并保存',
        onConfirm: async () => { await run(); },
      });
      return;
    }
    void run().catch((e: unknown) => toast((e as Error)?.message || '保存失败'));
  };

  const saveVisual = async () => {
    if (!draft) return;
    const key = draft.apiKey.trim();
    // 额外参数必须是 JSON 对象：解析失败就地报错，不能把一段坏文本当成 {} 静默存进去
    // （那会让运营以为参数已生效，而上游其实从没收到过）。
    let extraParams: Record<string, unknown>;
    const raw = draft.extraParamsText.trim();
    try {
      const o = raw ? JSON.parse(raw) : {};
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('not an object');
      extraParams = o as Record<string, unknown>;
    } catch { toast('额外请求参数不是合法的 JSON 对象'); return; }
    setBusy('visual');
    try {
      await put({
        visual: {
          enabled: draft.visualEnabled,
          dialect: draft.dialect,
          baseUrl: draft.baseUrl.trim(),
          model: draft.model.trim(),
          size: draft.size.trim(),
          timeoutMs: draft.visualTimeoutMs,
          extraParams,
          // 不传=保留库内密钥；传值=加密写入。清除是独立动作（传空串），不能靠「留空保存」误触。
          ...(key ? { apiKey: key } : {}),
        },
      }, key ? '供应商配置与密钥已保存' : '供应商配置已保存');
      setDry(null);
    } catch (e) { toast((e as Error)?.message || '保存失败'); }
    setBusy('');
  };

  const clearKey = () => setConfirmSpec({
    title: '清除图片供应商密钥',
    desc: '清除后主视觉生成将失去凭证：任务不会报错，但会退化成「无主视觉」的纯排版模板路径。重新填入密钥即可恢复。',
    echo: [
      { k: '接入点', v: cfg?.visual.baseUrl || '（未填）' },
      { k: '模型', v: cfg?.visual.model || '（未填）' },
    ],
    warn: '密钥无法找回，需要重新从供应商后台获取。',
    confirmText: '确认清除',
    danger: true,
    onConfirm: async () => {
      setBusy('visual');
      try { await put({ visual: { apiKey: '' } }, '已清除供应商密钥'); setDry(null); }
      finally { setBusy(''); }
    },
  });

  const runDry = async () => {
    setBusy('dry'); setDry(null);
    try {
      const r = await api.creativeProviderDryRun();
      setDry({ ok: r.ok, msg: `${r.message}（${r.ms}ms）` });
    } catch (e) { setDry({ ok: false, msg: (e as Error)?.message || '试跑请求失败' }); }
    setBusy('');
  };

  const retry = (j: AdminCreativeJobItem) => setConfirmSpec({
    title: '重试失败任务',
    desc: '把任务改回排队中，由 worker 重新执行。不会重复扣费：已退款的保持已退款（相当于免费补发一张），未退款的沿用原来那次扣费。',
    echo: [
      { k: '用户', v: j.userLabel },
      { k: '模板', v: templateLabel(j.templateKey) },
      { k: '成本', v: `💎 ${j.creditCost}${j.refunded ? ' · 已退款' : j.charged ? '' : ' · 未扣费'}`, amount: true },
      { k: '失败原因', v: j.errorMessage || j.errorCode || '未记录' },
    ],
    confirmText: '重新排队',
    onConfirm: async () => {
      setBusy(j.id);
      try { await api.retryCreativeJob(j.id); toast('已重新排队'); jobsReload(); }
      finally { setBusy(''); }
    },
  });

  const jobData = jobs.data;
  const pages = jobData ? Math.max(1, Math.ceil(jobData.total / (jobData.pageSize || 20))) : 1;
  const fbStat = jobData ? fallbackStat(jobData.items) : null;

  return (
    <>
      <PageHead
        k="creative"
        res={{ loading: cfgRes.loading || jobs.loading, reload: reloadAll, updatedAt: Math.max(cfgRes.updatedAt, jobs.updatedAt) }}
        badge={cfg
          ? (cfg.enabled
            ? `已开启 · ${cfg.pricePerPoster} 钻/张 · ${engineName(cfg.layoutEngine)}`
              + (cfg.layoutEngine === 'ai' ? ` / ${aiModeName(cfg.aiMode)}` : '')
            : '未开启')
          : undefined}
      />

      {!isSuper && (
        <div className="pad">
          <div className="ai-note">
            当前账户为普通运营：改配置、供应商试跑与任务重试需要超级管理员（owner / master），因此这些入口已隐藏。配置与任务数据可以正常查看。
          </div>
        </div>
      )}

      {/* ── 功能配置 ── */}
      <div className="sec-h"><span className="t">功能配置</span><span className="s">开关 / 单价 / 限额 / 排版引擎 / 模板启停</span></div>
      <ViewState res={cfgRes} skeleton="rows">
        {(c: AdminCreativeConfig) => !draft ? null : (
          <div className="pad">
            <div className="crd new-agent">
              <div className="cfg">
                <div className="cfg-row">
                  <div className="cb">
                    <div className="ct">功能开关（= 放量开关）</div>
                    <div className="cs">
                      打开并保存即刻放量：小程序侧出现出图入口，用户每出一张按下方单价预扣钻石。
                      关闭后入口隐藏、接口直接 403，队列里已经建好的任务照旧跑完。
                    </div>
                  </div>
                  <div className={`sw ${draft.enabled ? 'on' : ''}`} onClick={() => isSuper && set({ enabled: !draft.enabled })}><i /></div>
                </div>
              </div>
              <div className="ai-note">
                这个开关是唯一的闸门。原先还有一道部署级环境变量（CANVAS_DESIGN_ENABLED）要同时打开才算开，
                2026-07 已删除 —— 好处是这里的改动即时生效、不用重启服务；代价是没有第二层兜着，
                所以「开」的方向会先弹确认框回显单价与限额，「关」的方向立即执行不拦。
              </div>

              <div className="ai-field">
                <div className="ai-fl">标准档价格（钻石 / 张 · 0–10000）</div>
                <NumInput className="ai-input" min={0} max={10_000} step={1} value={draft.pricePerPoster} disabled={!isSuper} onChange={(pricePerPoster) => set({ pricePerPoster })} />
              </div>
              <div className="ai-field">
                <div className="ai-fl">高级档价格（钻石 / 张 · 0–10000）</div>
                <NumInput className="ai-input" min={0} max={10_000} step={1} value={draft.premiumPricePerPoster} disabled={!isSuper} onChange={(premiumPricePerPoster) => set({ premiumPricePerPoster })} />
                <div className="ai-note">
                  高级档每单会多调一次图片大模型出全幅主视觉（中文仍由服务端排版，不交给图片模型）。
                  <b>没配好下方的图片供应商时，高级档在小程序里整块不显示</b>，也不接受下单 —— 不会出现
                  「用户买了高级、拿到标准图」的情况。高级单若最终没能出主视觉，整单失败并全额退款，
                  不降级交付。
                </div>
              </div>
              <div className="ai-field">
                <div className="ai-fl">每人每日任务上限（0–1000 · 0 = 不限量；紧急停量请用上方功能开关）</div>
                <NumInput className="ai-input" min={0} max={1000} step={1} value={draft.dailyLimit} disabled={!isSuper} onChange={(dailyLimit) => set({ dailyLimit })} />
              </div>
              {/* 上限 480000 不是随手填的：服务端 clamp 到 480s，必须低于 worker sweep 的 10 分钟卡死阈值，
                  否则一次正常的长渲染会被判定为卡死并重新入队 → 同一单跑两遍、出两张图。 */}
              <div className="ai-field">
                <div className="ai-fl">渲染超时（毫秒 · 10000–480000 · {msHint(draft.timeoutMs)}）</div>
                <NumInput className="ai-input" min={10_000} max={480_000} step={5000} value={draft.timeoutMs} disabled={!isSuper} onChange={(timeoutMs) => set({ timeoutMs })} />
              </div>

              {/* 排版引擎：可逆、不涉资金、失败必回落 → 不弹确认框，切完直接「保存配置」。 */}
              <div className="ai-field">
                <div className="ai-fl">排版引擎（决定海报版式是模型现场创作还是套固定模板）</div>
                <div className="bill-seg">
                  {LAYOUT_ENGINES.map(([k, label, desc]) => (
                    <div
                      key={k}
                      className={`bill-opt ${draft.layoutEngine === k ? 'on' : ''}`}
                      onClick={() => isSuper && set({ layoutEngine: k })}
                    >
                      <div className="bo-t">{label}</div>
                      <div className="bo-d">{desc}</div>
                    </div>
                  ))}
                </div>
                <div className="ai-note">
                  AI 排版不是风险开关：模型不可用、产出不合规、量测反复不过，任何一步走不通都会自动回落到模板路径出图，
                  付费任务不会因为它失败。要盯的是下面任务台的「AI 回落率」—— 回落率高说明 AI 排版名义上开着、
                  实际大多在出模板图，那时候才该回去查模型配置或切回模板排版。
                </div>
              </div>

              {/* AI 创作路线：同样可逆、不涉资金、失败必回落 → 不弹确认框。只在 AI 排版下生效，
                  切到模板排版时整块置灰并说明原因（藏起来会让运营以为设置丢了）。 */}
              <div className="ai-field">
                <div className="ai-fl">
                  AI 创作路线（影像主导 = 生图模型出全幅主视觉，排版层只叠字）
                  {draft.layoutEngine === 'ai' ? '' : ' · 当前排版引擎为「模板排版」，本项不生效'}
                </div>
                <div className="bill-seg">
                  {AI_MODES.map(([k, label, desc]) => (
                    <div
                      key={k}
                      className={`bill-opt ${draft.aiMode === k ? 'on' : ''}`}
                      onClick={() => isSuper && draft.layoutEngine === 'ai' && set({ aiMode: k })}
                    >
                      <div className="bo-t">{label}</div>
                      <div className="bo-d">{desc}</div>
                    </div>
                  ))}
                </div>
                <div className="ai-note">
                  影像路线有三条门禁，任一不满足时这一单就自动降为纯图形（任务仍成功、照样扣费，只是画风不同）：
                  ① 上方「图片供应商」未启用或没填接口地址/模型；② 用户自己上传了本人照片
                  （v1 不做真人融合：模型生成的脸和用户的照片放一起必然打架）；③ 模型没给出可用的影像主体描述。
                  影像版排版失败时还会退回纯图形版（复用同一篇宣言，不重出主视觉），再失败才回落模板。
                  所以切到「影像优先」后若任务台仍全是「AI 排版」，先去查这三条，而不是怀疑功能没上线。
                </div>
              </div>

              <div className="ai-field">
                <div className="ai-fl">
                  模板启停（MVP 三套 3:4 · 全部停用则无法建单，建单返回 422
                  {draft.layoutEngine === 'ai' ? '；AI 排版下这三套仍是回落时的兜底池，别全关' : ''}）
                </div>
                <div className="cfg">
                  {TEMPLATES.map(([k, label, desc]) => (
                    <div key={k} className="cfg-row">
                      <div className="cb"><div className="ct">{label}</div><div className="cs">{desc} · <span className="tag off">{k}</span></div></div>
                      <div className={`sw ${draft.templates[k] ? 'on' : ''}`} onClick={() => isSuper && setTpl(k, !draft.templates[k])}><i /></div>
                    </div>
                  ))}
                </div>
              </div>

              {isSuper && (
                <button
                  type="button"
                  className="ai-btn primary block"
                  disabled={busy === 'basics' || !basicsDirty(draft, c)}
                  onClick={saveBasics}
                >
                  <Icon name="check" size={14} /> {busy === 'basics' ? '保存中…' : basicsDirty(draft, c) ? '保存配置' : '没有改动'}
                </button>
              )}
            </div>
          </div>
        )}
      </ViewState>

      {/* ── 图片供应商 ── */}
      <div className="sec-h"><span className="t">图片供应商</span><span className="s">主视觉生成接入点 · 未配置时走纯排版路径，不报错</span></div>
      {cfgRes.initial ? <div className="pad"><Skeleton kind="rows" /></div> : !cfg || !draft ? null : (
        <div className="pad">
          <div className="crd new-agent">
            <div className="cfg">
              <div className="cfg-row">
                <div className="cb">
                  <div className="ct">启用主视觉生成</div>
                  <div className="cs">关闭（或缺 接入点/模型）时任务不报错，直接出「无主视觉」的纯排版海报</div>
                </div>
                <div className={`sw ${draft.visualEnabled ? 'on' : ''}`} onClick={() => isSuper && set({ visualEnabled: !draft.visualEnabled })}><i /></div>
              </div>
            </div>

            <div className="ai-field">
              <div className="ai-fl">接口方言（决定请求体怎么拼 —— 填错的症状是下方试跑报 HTTP 400）</div>
              <div className="bill-seg">
                {VISUAL_DIALECTS.map(([k, label, desc]) => (
                  <div
                    key={k}
                    className={`bill-opt ${draft.dialect === k ? 'on' : ''}`}
                    onClick={() => isSuper && set({ dialect: k })}
                  >
                    <div className="bo-t">{label}</div>
                    <div className="bo-d">{desc}</div>
                  </div>
                ))}
              </div>
              <div className="ai-note">
                三家的 images 接口长得像但不通用，各有一条必须照顾的差异：
                <b>方舟 Seedream 的水印默认是开的</b>（服务端已强制 <code>watermark:false</code>，
                这一项不接受用「额外请求参数」改回去 —— 印着水印的付费海报没法交付）；
                <b>gpt-image-1 收到 <code>response_format</code> 会直接 400</b>（服务端对该方言不发这个字段）。
                选通用 OpenAI 则保持老行为。
              </div>
            </div>
            <div className="ai-field">
              <div className="ai-fl">接入点 baseUrl（带 /v1 或 /api/v3）</div>
              <input className="ai-input" value={draft.baseUrl} disabled={!isSuper} placeholder="https://ark.cn-beijing.volces.com/api/v3" onChange={(e) => set({ baseUrl: e.target.value })} />
            </div>
            <div className="ai-field">
              <div className="ai-fl">模型 model</div>
              <input className="ai-input" value={draft.model} disabled={!isSuper} placeholder="gpt-image-1" onChange={(e) => set({ model: e.target.value })} />
            </div>
            <div className="ai-field">
              <div className="ai-fl">请求尺寸 size（必须是 3:4 一档，服务端会校验）</div>
              <input className="ai-input" value={draft.size} disabled={!isSuper} placeholder="1440x1920" onChange={(e) => set({ size: e.target.value })} />
              <div className="ai-note">
                <b>尺寸必须贴着 3:4（宽高比 0.6–0.9），否则保存会被拒。</b>主视觉是全幅铺底，
                比例不符会被 object-fit:cover 裁掉一整条 —— 人像档裁掉的往往正是脸，而且完全静默：
                渲染成功、任务全绿、图是坏的。gpt-image-1 只提供 1024×1536（2:3），轻微上下裁切可接受；
                方舟填 1440×1920 这类正 3:4，或改用 2K 这样的厂商预设（预设不做比例校验，靠提示词描述形状）。
                另外注意生图模型选型 —— 摄影质感类（Midjourney 档）文字必渲染成乱码，对我们反而安全；
                中文语义与版面留白理解最好的一类（Seedream / 即梦）恰恰擅长渲染文字，会主动往留白处写标题，
                只能靠提示词里写死的禁字条款压住（服务端已把 no-text 钉在提示词正文末尾）。出图带字就换模型或加负向词。
              </div>
            </div>
            <div className="ai-field">
              <div className="ai-fl">供应商请求超时（毫秒 · 1000–300000 · {msHint(draft.visualTimeoutMs)}）</div>
              <NumInput className="ai-input" min={1000} max={300_000} step={1000} value={draft.visualTimeoutMs} disabled={!isSuper} onChange={(visualTimeoutMs) => set({ visualTimeoutMs })} />
            </div>
            <div className="ai-field">
              <div className="ai-fl">额外请求参数（JSON 对象 · 原样合并进请求体；留空=不加）</div>
              <textarea
                className="ta"
                rows={3}
                value={draft.extraParamsText}
                disabled={!isSuper}
                placeholder={'{\n  "quality": "high"\n}'}
                onChange={(e) => set({ extraParamsText: e.target.value })}
              />
            </div>
            <div className="ai-field">
              <div className="ai-fl">API Key{cfg.visual.hasKey ? '（已配置 · 留空=保留现有）' : '（未配置）'}</div>
              <input
                className="ai-input"
                type="password"
                value={draft.apiKey}
                disabled={!isSuper}
                placeholder={cfg.visual.hasKey ? '已配置 · 留空保留，填入新值则覆盖' : '粘贴供应商 API Key'}
                onChange={(e) => set({ apiKey: e.target.value })}
              />
            </div>

            {dry && (
              <div className={`ai-test ${dry.ok ? 'ok' : 'err'}`}>
                <Icon name={dry.ok ? 'check' : 'alert'} size={13} /> {dry.msg}
              </div>
            )}
            {isSuper && visualDirty(draft, cfg) && (
              <div className="ai-note">有未保存的改动；「连通性试跑」发的是已保存的那份配置，改完请先保存再试跑。</div>
            )}

            {isSuper && (
              <>
                <div className="ai-actions">
                  <button type="button" className="ai-btn ghost" disabled={busy === 'dry'} onClick={runDry}>
                    <Icon name="spark" size={14} /> {busy === 'dry' ? '试跑中…' : '连通性试跑'}
                  </button>
                  <button type="button" className="ai-btn primary" disabled={busy === 'visual' || !visualDirty(draft, cfg)} onClick={saveVisual}>
                    <Icon name="check" size={14} /> {busy === 'visual' ? '保存中…' : '保存供应商'}
                  </button>
                </div>
                {cfg.visual.hasKey && (
                  <button type="button" className="ai-btn ghost block" disabled={busy === 'visual'} onClick={clearKey}>
                    <Icon name="close" size={14} /> 清除已存密钥
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ── 任务台 ── */}
      <div className="sec-h"><span className="t">任务台</span><span className="s">用户脱敏标识 / 成本 / 退款态 / 排版引擎与创作路线 / 降级 / 失败原因</span></div>
      <div className="pad">
        <div className="filter-bar">
          <div className="chip-row">
            {JOB_STATUS.map(([v, l]) => (
              <button key={v} type="button" className={`chip ${status === v ? 'on' : ''}`} onClick={() => { setStatus(v); setPage(1); }}>{l}</button>
            ))}
          </div>
        </div>
        {jobs.error && jobData === null && <ErrorState msg={jobs.error} onRetry={jobsReload} />}
        {jobs.error && jobData !== null && <ErrorState msg={jobs.error} onRetry={jobsReload} stale />}
        {jobs.initial ? <Skeleton kind="stats" /> : !jobData ? null : (
          <>
            <div className="usage-summary">
              <div><b>{jobData.summary.pending}</b><span>排队中</span></div>
              <div><b>{jobData.summary.running}</b><span>生成中</span></div>
              <div><b>{jobData.summary.succeeded}</b><span>已完成</span></div>
              <div><b>{jobData.summary.failed}</b><span>失败</span></div>
              <div><b>{jobData.summary.refunded}</b><span>已退款</span></div>
              {/* AI 回落率：AI 排版失败会静默出一张模板图，任务全绿 —— 这个数是「引擎到底生效了没」
                  的唯一体感入口。口径只到当前页（还受上面的状态筛选影响），所以副标注明本页样本。 */}
              {fbStat && (
                <div>
                  <b>{fbStat.pct}%</b>
                  <span>AI 回落率 · 本页样本 {fbStat.fallback} / {fbStat.total} 单</span>
                </div>
              )}
            </div>

            {jobData.items.length === 0 && (
              <div className="empty">
                {status ? `没有「${JOB_STATUS.find(([v]) => v === status)?.[1]}」的任务。` : '还没有任何创作任务。'}
              </div>
            )}

            {jobData.items.map((j) => {
              const expanded = openErr === j.id;
              const philOpen = openPhil === j.id;
              const err = j.errorMessage || j.errorCode || '';
              const eng = engineTag(j);
              // 回落原因挂在**成功**的单上（AI 挂了但图出了），所以它不能只走「失败原因」那条路径，
              // 否则永远不显示。≤300 字，行内截断 + title 全文 + 展开处全文。
              const fbErr = j.layoutEngine === 'template_fallback' ? (j.aiEngineError || '') : '';
              // 影像路线降级原因：本单**成功**且实际是 graphic，所以它同样不能只走「失败原因」那条路径。
              // 不显示的话，「影像路线名义上开着、实际全在出图形版」又只存在于服务端日志里。
              const phErr = j.photoError || '';
              return (
                <div key={j.id} className="usage-row">
                  <div className="usage-h">
                    <div className="usage-name">
                      {j.userLabel}
                      <span>{templateLabel(j.templateKey)} · {j.engine}{j.provider ? ` / ${j.provider}` : ''}{j.assetCount ? ` · ${j.assetCount} 张成品` : ''}</span>
                    </div>
                    <div className={`usage-num ${j.status === 'succeeded' ? 'ok' : ''}`}>💎 {j.creditCost}</div>
                  </div>
                  <div className="usage-meta">
                    <span className={statusTag(j.status)}>{STATUS_LABEL[j.status] ?? j.status}</span>
                    {j.status === 'running' && j.progress && <span className="tag off">{j.progress}</span>}
                    {/* 实际排版引擎。null（老任务/未完成）不显示——冒充「模板」会让回落率失真。 */}
                    {eng && <span className={eng.cls} title={eng.title}>{eng.label}</span>}
                    {/* 降级 = 配了图片供应商但这一单没拿到主视觉。不显示它的话，供应商挂一整天任务台仍然全绿。 */}
                    {j.degraded && <span className="tag warn" title="本单走了降级路径：没拿到主视觉，用户收到的是纯排版海报">无主视觉</span>}
                    {j.refunded && <span className="tag off">已退款</span>}
                    {!j.charged && <span className="tag off">未扣费</span>}
                    {j.status === 'failed' && j.charged && !j.refunded && <span className="tag warn">未退款</span>}
                    {j.attempts > 1 && <span className="tag off">第 {j.attempts} 次</span>}
                    {' '}创建 {fmtTime(j.createdAt)}{j.completedAt ? ` · 结束 ${fmtTime(j.completedAt)}` : ''}
                  </div>
                  {err && !expanded && (
                    <div className="usage-meta" title={err}>
                      失败原因：{err.length > 72 ? `${err.slice(0, 72)}…` : err}
                    </div>
                  )}
                  {fbErr && !expanded && (
                    <div className="usage-meta" title={fbErr}>
                      AI 排版回落原因：{fbErr.length > 72 ? `${fbErr.slice(0, 72)}…` : fbErr}
                    </div>
                  )}
                  {phErr && !expanded && (
                    <div className="usage-meta" title={phErr}>
                      影像路线降级原因：{phErr.length > 72 ? `${phErr.slice(0, 72)}…` : phErr}
                    </div>
                  )}
                  {expanded && (
                    <div className="trace-text">
                      {err ? `${j.errorCode ? `[${j.errorCode}] ` : ''}${j.errorMessage ?? ''}` : ''}
                      {err && fbErr ? '\n\n' : ''}
                      {fbErr ? `AI 排版回落原因：${fbErr}` : ''}
                      {(err || fbErr) && phErr ? '\n\n' : ''}
                      {phErr ? `影像路线降级原因：${phErr}` : ''}
                    </div>
                  )}
                  {/* 视觉哲学（六维度 + note）是每单真金白银调 LLM 生成的，此前没有任何读者：
                      C 端不展示、任务台不展示。运营排「为什么这版这么丑」只能靠猜。列表已按 2000 字截断。 */}
                  {philOpen && j.promptSnapshot && <div className="trace-text">{j.promptSnapshot}</div>}
                  <div className="crd-actions">
                    {(err || fbErr || phErr) && (
                      <button type="button" className="mini-btn" onClick={() => setOpenErr(expanded ? '' : j.id)}>
                        {expanded ? '收起原因' : err ? '展开原因' : fbErr ? '展开回落原因' : '展开降级原因'}
                      </button>
                    )}
                    {j.promptSnapshot && (
                      <button type="button" className="mini-btn" onClick={() => setOpenPhil(philOpen ? '' : j.id)}>
                        {philOpen ? '收起视觉哲学' : '展开视觉哲学'}
                      </button>
                    )}
                    {isSuper && j.status === 'failed' && (
                      <button type="button" className="mini-btn primary" disabled={busy === j.id} onClick={() => retry(j)}>
                        {busy === j.id ? '重排中…' : '重试'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {pages > 1 && (
              <div className="crd-actions">
                <button type="button" className="mini-btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
                <span className="pill">{page} / {pages} · 共 {jobData.total} 个任务</span>
                <button type="button" className="mini-btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button>
              </div>
            )}
          </>
        )}
      </div>

      {confirmSpec && <ConfirmDialog spec={confirmSpec} onClose={() => setConfirmSpec(null)} />}
    </>
  );
}
