// 「快出片」纯计算层 —— 不碰 wx.*、不发请求、不读 storage，可直接单测。
//
// 这里只做**端上预估**：让「配画面」那一屏的价格条在用户点标签的瞬间跳数字。
// 真实扣费一律以服务端 /estimate 与 /render 返回为准（见 config.js 注释）。
const { PRICING, MAX_AVATAR_SEGMENT_SEC } = require('./config');

/** 段角色。tail 是模板自带的固定尾段，不计入用户可切换的范围。 */
const ROLE = { AVATAR: 'avatar', BROLL: 'broll', TAIL: 'tail' };

/** 中文口播字数 → 秒。方案 §2.1：约 4 字/秒；试听后用真实 TTS 时长覆盖。 */
function estimateSeconds(text) {
  const chars = String(text || '').replace(/\s/g, '').length;
  if (!chars) return 0;
  return Math.max(1, Math.round(chars / PRICING.charsPerSecond));
}

/** 段的有效时长：优先真实时长（试听/生成后回填），否则按字数估。 */
function segmentSeconds(segment) {
  if (!segment) return 0;
  if (segment.actualDurationSec > 0) return Math.round(segment.actualDurationSec);
  if (segment.role === ROLE.TAIL) return Math.round(segment.durationSec || 0);
  return estimateSeconds(segment.text);
}

/** 秒 → mm:ss。 */
function formatDuration(totalSec) {
  const sec = Math.max(0, Math.round(Number(totalSec) || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** 汇总：成片时长、出镜秒数、各角色段数。 */
function summarize(segments) {
  const list = Array.isArray(segments) ? segments : [];
  let totalSec = 0; let avatarSec = 0; let tailSec = 0;
  let avatarCount = 0; let brollCount = 0; let tailCount = 0;
  let chars = 0;

  list.forEach((segment) => {
    const sec = segmentSeconds(segment);
    totalSec += sec;
    if (segment.role === ROLE.AVATAR) { avatarSec += sec; avatarCount += 1; }
    else if (segment.role === ROLE.BROLL) { brollCount += 1; }
    else if (segment.role === ROLE.TAIL) { tailSec += sec; tailCount += 1; }
    // 尾段是预渲染素材，不过 TTS，不计字数
    if (segment.role !== ROLE.TAIL) chars += String(segment.text || '').replace(/\s/g, '').length;
  });

  return { totalSec, avatarSec, tailSec, avatarCount, brollCount, tailCount, chars };
}

/**
 * 端上报价预估。返回明细，供「出片确认」屏逐行展示（设计稿屏 07）。
 * 尾段固定免费（模板自带的预渲染素材，无生成成本）。
 */
function estimateCredits(segments) {
  const sum = summarize(segments);
  const tts = Math.ceil((sum.chars / 1000) * PRICING.creditPerKChar);
  const avatar = Math.ceil(sum.avatarSec * PRICING.creditPerAvatarSecond);
  const broll = sum.brollCount * PRICING.creditPerBrollSegment;
  const assemble = PRICING.creditAssemble;
  return {
    items: [
      { key: 'tts', label: `口播配音 ${formatDuration(sum.totalSec - sum.tailSec)}`, credits: tts },
      { key: 'avatar', label: `分身出镜 ${sum.avatarSec} 秒`, credits: avatar },
      { key: 'broll', label: `画面合成 ${sum.brollCount} 段`, credits: broll },
      { key: 'tail', label: '结尾固定段', credits: 0, freeText: '免费' },
    ].concat(assemble > 0 ? [{ key: 'assemble', label: '总装', credits: assemble }] : []),
    total: tts + avatar + broll + assemble,
    summary: sum,
  };
}

/**
 * 切换一段的角色，返回 { segments, delta, error }。
 * delta 是积分变化量 —— 设计稿屏 06 顶部要显示「+8 刚把第 9 句改成分身出镜」。
 */
function toggleRole(segments, no) {
  const list = (Array.isArray(segments) ? segments : []).slice();
  const index = list.findIndex((item) => item.no === no);
  if (index < 0) return { segments: list, delta: 0, error: null };

  const current = list[index];
  if (current.role === ROLE.TAIL) {
    return { segments: list, delta: 0, error: '结尾是固定片段，不能切换；可以整段替换。' };
  }

  const before = estimateCredits(list).total;
  const nextRole = current.role === ROLE.AVATAR ? ROLE.BROLL : ROLE.AVATAR;

  if (nextRole === ROLE.AVATAR) {
    const sec = segmentSeconds(current);
    if (sec > MAX_AVATAR_SEGMENT_SEC) {
      return { segments: list, delta: 0, error: `这句太长了（约 ${sec} 秒），拆成两句再让分身出镜。` };
    }
  }

  list[index] = Object.assign({}, current, { role: nextRole });
  const after = estimateCredits(list).total;
  return { segments: list, delta: after - before, error: null };
}

/**
 * 提交单句编辑：只有提交文本仍等于最近一次试听文本时保留真实 TTS 时长；
 * 用户试听后又改字则清零，退回字数估算。放纯函数层便于锁住回归。
 */
function commitSegmentText(segments, no, nextText, previewedText) {
  const text = String(nextText || '');
  return (Array.isArray(segments) ? segments : []).map((segment) => (segment.no === no
    ? Object.assign({}, segment, {
      text,
      actualDurationSec: text === String(previewedText == null ? '' : previewedText)
        ? Number(segment.actualDurationSec || 0)
        : 0,
    })
    : segment));
}

/**
 * 出片前置校验（对应方案 §8.0「提交前 preflight，不 hold 不建单」）。
 * 端上先拦一道，服务端仍要再校验一次 —— 端上校验只为省一次往返，不是安全边界。
 */
function preflight(project, avatar) {
  const problems = [];
  const segments = (project && project.segments) || [];

  if (!segments.length) problems.push({ code: 'NO_SEGMENTS', message: '文案还是空的。' });

  const emptyText = segments.filter((s) => s.role !== ROLE.TAIL && !String(s.text || '').trim());
  if (emptyText.length) problems.push({ code: 'EMPTY_TEXT', message: `第 ${emptyText.map((s) => s.no).join('、')} 句还没写内容。` });

  const hasAvatar = segments.some((s) => s.role === ROLE.AVATAR);
  if (hasAvatar) {
    if (!avatar || avatar.imageStatus !== 'ready') {
      problems.push({ code: 'CLIP_AVATAR_NOT_READY', message: '你的形象还没训练好，可以先用平台预置形象出片。' });
    }
    if (!avatar || avatar.voiceStatus !== 'ready') {
      problems.push({ code: 'CLIP_VOICE_NOT_READY', message: '你的声音还没训练好。' });
    }
  }

  const tooLong = segments.filter((s) => s.role === ROLE.AVATAR && segmentSeconds(s) > MAX_AVATAR_SEGMENT_SEC);
  if (tooLong.length) {
    problems.push({
      code: 'CLIP_SEGMENT_TOO_LONG',
      message: `第 ${tooLong.map((s) => s.no).join('、')} 句作为出镜段太长，拆短一点。`,
    });
  }

  return { ok: problems.length === 0, problems };
}

/** 出片进度的四个阶段（设计稿屏 08）。服务端 stage 字段直接映射到这里。 */
const STAGES = [
  { key: 'tts', label: '用你的声线配音' },
  { key: 'avatar', label: '分身出镜的段落' },
  { key: 'broll', label: '把你的画面接上去' },
  { key: 'assemble', label: '加字幕、出成片' },
];

/** 把服务端 { stage, progress } 摊成四行的状态，供进度页渲染。 */
function stageRows(stage, progress) {
  const activeIndex = Math.max(0, STAGES.findIndex((item) => item.key === stage));
  return STAGES.map((item, index) => {
    if (index < activeIndex) return Object.assign({}, item, { state: 'done', text: '完成' });
    if (index > activeIndex) return Object.assign({}, item, { state: 'wait', text: '等待中' });
    return Object.assign({}, item, { state: 'busy', text: `${Math.max(0, Math.min(99, Math.round(progress || 0)))}%` });
  });
}

module.exports = {
  ROLE, STAGES,
  estimateSeconds, segmentSeconds, formatDuration,
  summarize, estimateCredits, toggleRole, commitSegmentText, preflight, stageRows,
};
