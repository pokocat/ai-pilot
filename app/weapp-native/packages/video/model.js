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

const shotId = (startNo, endNo) => `shot_${startNo}_${endNo}`;

/** 老草稿没有 shots 时按语义角色生成默认镜头；连续实拍句每 3 句共用一个画面。 */
function defaultShots(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const shots = [];
  for (let index = 0; index < list.length;) {
    const first = list[index];
    if (first.role !== ROLE.BROLL) {
      shots.push({
        id: shotId(first.no, first.no), startNo: first.no, endNo: first.no, role: first.role,
        assetId: first.assetId || null, assetLabel: first.assetLabel || null,
        brollSource: first.brollSource || null, hint: first.hint || null,
      });
      index += 1;
      continue;
    }
    let endIndex = index;
    while (endIndex + 1 < list.length
      && list[endIndex + 1].role === ROLE.BROLL
      && String(list[endIndex + 1].assetId || '') === String(first.assetId || '')
      && endIndex - index + 1 < 3) endIndex += 1;
    const last = list[endIndex];
    shots.push({
      id: shotId(first.no, last.no), startNo: first.no, endNo: last.no, role: ROLE.BROLL,
      assetId: first.assetId || null, assetLabel: first.assetLabel || null,
      brollSource: first.brollSource || null, hint: first.hint || null,
    });
    index = endIndex + 1;
  }
  return shots;
}

function ensureShots(segments, shots) {
  const list = Array.isArray(shots) ? shots.filter((shot) => shot && shot.startNo > 0 && shot.endNo >= shot.startNo) : [];
  return list.length ? list.map((shot) => Object.assign({}, shot)) : defaultShots(segments);
}

/** 把“句子层 + 镜头层”投影成报价、预检和预览使用的真实生成段。 */
function materializeShots(segments, shots) {
  const source = Array.isArray(segments) ? segments : [];
  return ensureShots(source, shots).map((shot, index) => {
    const members = source.filter((segment) => segment.no >= shot.startNo && segment.no <= shot.endNo);
    const actuals = members.map((segment) => Number(segment.actualDurationSec || 0));
    const durations = members.map((segment) => segmentSeconds(segment));
    return Object.assign({}, shot, {
      no: index + 1,
      sourceNos: members.map((segment) => segment.no),
      text: members.map((segment) => String(segment.text || '')).join(''),
      durationSec: durations.reduce((sum, value) => sum + value, 0),
      actualDurationSec: actuals.length && actuals.every((value) => value > 0)
        ? actuals.reduce((sum, value) => sum + value, 0) : 0,
      hint: shot.hint || members.map((segment) => segment.hint).filter(Boolean).join(' · '),
    });
  });
}

/** 字节 → 人读大小。素材动辄几十 MB，KB 级精度没意义，统一到 1 位小数。 */
function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

/**
 * 从 `wx.chooseMedia` 的 tempFile 里取像素宽高。
 *
 * ⚠️ 官方 MediaFile 把 `width`/`height` 注释成「视频的宽度/高度」——**图片项不保证给**，
 * 且低版本/部分机型会给 0。所以这里的口径是「两个都拿到正数才算数」，否则返回空对象，
 * 让调用方**根本拿不到这两个字段**，而不是拿到 0：0 会一路写进服务端，最后在素材卡上
 * 渲染成「0×0」，把「没测到」说成「这素材是 0 像素」。空态与失败态不许混。
 */
function mediaDimensions(file) {
  const width = Math.round(Number(file && file.width) || 0);
  const height = Math.round(Number(file && file.height) || 0);
  if (!(width > 0) || !(height > 0)) return {};
  return { width, height };
}

/**
 * 分辨率角标（「1080×1920」）。
 *
 * 缺字段、0、负数、非数字一律回空串 —— 调用方据此**整块不渲染**。历史素材入库时没有采集宽高，
 * 它们的正确表达是「不显示」，不是「0×0」，也不是编一个看起来正常的默认值。
 */
function formatResolution(width, height) {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (!(w > 0) || !(h > 0)) return '';
  return `${w}×${h}`;
}

/** 素材时长 → 卡片角标。不足 1 秒按 1 秒显示，避免出现「0 秒」。 */
function formatAssetDuration(durationSec) {
  const sec = Number(durationSec) || 0;
  if (sec <= 0) return '';
  const rounded = Math.max(1, Math.round(sec));
  if (rounded < 60) return `${rounded}″`;
  return `${Math.floor(rounded / 60)}′${String(rounded % 60).padStart(2, '0')}″`;
}

/* ── 克隆扣费 ──────────────────────────────────────────────────────────
   价格一律来自服务端 GET /video/clone-pricing（运营后台可配）。
   端上**只把数字排成文案**，不做任何价格算术，也不自带一份常量。 */

/**
 * 钻石数 → 文案。
 * 读不到（null/undefined/非数字/负数）一律回空串，调用方据此**整块不显示**。
 * 绝不回退成「0 钻石」——那会把「还没读到价格」说成「免费」，是最坏的一种误导。
 */
function formatCredits(value) {
  // ⚠️ 必须先挡住 null / undefined / 空串：`Number(null)` 和 `Number('')` 都等于 0，
  // 只靠 isFinite 判断会把「还没读到价格」渲染成「0 钻石」—— 那是在告诉用户这件事免费。
  // 运营真把某一档配成 0 时，传进来的是数字 0，仍然正常显示。
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  return `${Math.round(n)} 钻石`;
}

/**
 * 某一档克隆动作的扣费文案。
 * `pricing` 为 null（还没拉到 / 拉失败）时回空串，界面据此不显示价格，而不是显示 0。
 */
function cloneCostText(pricing, action) {
  if (!pricing) return '';
  return formatCredits(pricing[action]);
}

/**
 * 「关联声音」候选项与默认选中项。
 *
 * ★ 产品口径（2026-08-13）：**默认复用已有声音**。
 *   新训练一条声音在供应商侧是全流程最贵的单次动作之一（16AI 一条音色 8000+ 算力），
 *   而复用一条已训好的声音不额外扣费。此前默认是「视频原声」，等于用户每建一个形象都顺带
 *   新训一条声音，克隆权益很快被烧光。所以这里把便宜的那个设成默认，
 *   花钱的路径（视频原声 / 单独录制）必须用户**主动选**，且选中前就要看见扣多少。
 *
 * 「视频原声」不是免费的顺带产物：它同样要新训一条声音，走的就是 voiceCreate 那一档，
 * 所以它的文案必须带价，不能只写「自动提取」让人以为白送。
 *
 * @returns {{options: object[], defaultVoiceId: string, hasReusable: boolean}}
 *   `defaultVoiceId` 为空串表示「视频原声」——与既有 voiceSource='video' 契约一致，不要改成 null。
 */
function voiceChoices(voices, pricing) {
  const ready = (Array.isArray(voices) ? voices : []).filter((item) => item && item.status === 'ready');
  const createText = cloneCostText(pricing, 'voiceCreate');
  // 可复用的排在前面：默认选中项必须一眼看得见，不能藏在横向滚动的右边。
  const options = ready.map((item, index) => ({
    // 「视频原声」那一项的 id 是空串，不能拿来做 wx:key（空串会让列表复用错位），所以另给一个稳定 key。
    key: String(item.id || `voice_${index}`),
    id: String(item.id || ''),
    name: item.name || '已有声音',
    meta: item.source === 'video' ? '来自视频' : '单独录制',
    costText: '复用不额外扣费',
    free: true,
    recommended: index === 0,
  }));
  options.push({
    key: 'video_original',
    id: '',
    name: '视频原声',
    meta: '从这段视频新训练',
    costText: createText ? `新训练 · ${createText}` : '要新训练一条声音',
    free: false,
    recommended: false,
  });
  return {
    options,
    defaultVoiceId: ready.length ? String(ready[0].id || '') : '',
    hasReusable: ready.length > 0,
  };
}

/**
 * 本次提交要扣哪几档 —— 端上**显示什么**与端上**提交什么报价**的唯一真源。
 *
 * ★ 必须与服务端 services/video/cloneCredits.ts 的 cloneChargeItems 同口径。服务端才是权威，
 *   两边算出来不一致会被 409 CLIP_CLONE_QUOTE_CHANGED 挡住 —— 宁可挡住，也不许按另一个价静默扣。
 *   把明细行和 expectedCredits 都从这一个函数派生，是为了根除「按钮上的价没跟着档位走」那类回归
 *   （见 d70e1bb）：只要有一份，就不会有两份对不上。
 *
 * @param {string} mode 'avatar' = 创建数字人；'voice' = 单独训练声音
 * @param {object|null} pricing 四档单价；null = 还没读到
 * @param {string} selectedVoiceId avatar 模式下：空串 = 用视频原声（要新训一条），非空 = 复用已有声音
 * @param {string} retrainVoiceId voice 模式下：非空 = 重训这一条已有声音（走便宜的 voiceRetrain 档）
 * @returns {{action: string, key: string, label: string, credits: number}[]}
 */
function cloneChargeItems(mode, pricing, selectedVoiceId, retrainVoiceId) {
  if (!pricing) return [];
  if (mode === 'voice') {
    return String(retrainVoiceId || '')
      ? [{ action: 'voiceRetrain', key: 'voice', label: '重新训练这条声音', credits: pricing.voiceRetrain }]
      : [{ action: 'voiceCreate', key: 'voice', label: '训练专属声音', credits: pricing.voiceCreate }];
  }
  const items = [{ action: 'avatarVideo', key: 'avatar', label: '用视频训练数字人', credits: pricing.avatarVideo }];
  // 复用已有声音不额外扣费；「视频原声」要新训一条，那是实打实的另一档开销。
  if (!String(selectedVoiceId || '')) {
    items.push({ action: 'voiceCreate', key: 'voice', label: '从视频新训练声音', credits: pricing.voiceCreate });
  }
  return items;
}

/**
 * 「还剩几次免费重训」+ 这条路还走不走得通。
 *
 * 供应商每条 speaker 给 4 次 recreate（不消耗克隆权益）。**用尽后不会回落成新建** ——
 * 上游会直接报错（CLIP_VOICE_RETRAIN_QUOTA_EXHAUSTED）。所以额度用尽必须在用户开录之前
 * 就挡住并说清楚，而不是让他录完 15 秒再撞一堵墙。
 *
 * ★ 查不到余额时**不许编一个数字**（例如默认写 4），也不许因此挡住提交：
 *   这是「读失败」，不是「没额度」。同 [空态 vs 读失败不许混] 那条口径。
 *
 * @returns {{text: string, blocked: boolean}} blocked = 这条声音重训不了，得改成新建
 */
function retrainQuotaState(quota) {
  if (!quota) return { text: '', blocked: false };
  if (quota.retrainable === false) {
    return { text: '这条声音没有可重新训练的记录，需要新建一条来替代它。', blocked: true };
  }
  const unknown = { text: '暂时查不到免费重训余额，可以直接提交试试。', blocked: false };
  if (!quota.available) return unknown;
  const remaining = Number(quota.remaining);
  const total = Number(quota.total);
  if (!Number.isFinite(remaining) || !Number.isFinite(total)) return unknown;
  if (remaining <= 0) {
    return { text: `这条声音的 ${total} 次免费重新训练已经用完，需要新建一条声音。`, blocked: true };
  }
  return { text: `这条声音还剩 ${remaining} 次免费重训（共 ${total} 次）。`, blocked: false };
}

function cloneChargeTotal(items) {
  return (Array.isArray(items) ? items : []).reduce((sum, item) => sum + (Number(item.credits) || 0), 0);
}

/**
 * 「这次要扣多少」的明细行。入口处必须让用户在点提交**之前**就看见成本。
 *
 * 价格没读到（pricing 为 null）时返回空数组 —— 界面整块不渲染，
 * 而不是渲染一张写着「0 钻石」的账单。空态与失败态不许混。
 */
function cloneCostRows(mode, pricing, selectedVoiceId, retrainVoiceId) {
  const rows = cloneChargeItems(mode, pricing, selectedVoiceId, retrainVoiceId).map((item) => ({
    key: item.key,
    label: item.label,
    // 运营把某一档配成 0（内测免费就是这么做的）时写「免费」，比「0 钻石」更像人话，含义完全一致。
    costText: item.credits === 0 ? '免费' : formatCredits(item.credits),
    free: item.credits === 0,
  }));
  // avatar 模式下复用已有声音是一条「不扣费」的说明行：不能让用户以为声音那一档没算过。
  if (mode !== 'voice' && String(selectedVoiceId || '') && rows.length) {
    rows.push({ key: 'voice', label: '关联已有声音', costText: '不额外扣费', free: true });
  }
  return rows;
}

/** 秒 → mm:ss。 */
function formatDuration(totalSec) {
  const sec = Math.max(0, Math.round(Number(totalSec) || 0));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/** 作品时间使用设备所在时区；今年省略年份，但始终保留分钟，便于区分同日多次生成。 */
function formatWorkTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`;
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function workTimeText(work) {
  const item = work || {};
  const generated = formatWorkTimestamp(item.generatedAt);
  if (generated) return `生成时间 · ${generated}`;
  const created = formatWorkTimestamp(item.createdAt);
  return created ? `开始生成 · ${created}` : '';
}

/** 微信临时路径/长哈希不是用户可读名称；所有素材展示统一收口到这里。 */
function assetDisplayLabel(label, kind) {
  const value = String(label || '').trim();
  const lower = value.toLowerCase();
  const temporary = !value || lower.startsWith('tmp_') || lower.startsWith('wxfile:')
    || lower.includes('/tmp/') || value.length > 52 || /^[0-9a-f_-]{24,}(\.[a-z0-9]+)?$/i.test(value);
  if (temporary) return kind === 'image' ? '我的图片素材' : '我的视频素材';
  return value;
}

/** 汇总：成片时长、出镜秒数、各角色段数。 */
function summarize(segments, shots) {
  const list = shots ? materializeShots(segments, shots) : (Array.isArray(segments) ? segments : []);
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
function estimateCredits(segments, shots) {
  const sum = summarize(segments, shots);
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

/** 切换整个镜头的角色；多句合并镜头按合计时长校验分身引擎上限。 */
function toggleShotRole(segments, shots, id) {
  const list = ensureShots(segments, shots);
  const index = list.findIndex((shot) => shot.id === id);
  if (index < 0) return { shots: list, delta: 0, error: null };
  const current = list[index];
  if (current.role === ROLE.TAIL) return { shots: list, delta: 0, error: '结尾是固定片段，不能切换；可以整段替换。' };
  const before = estimateCredits(segments, list).total;
  const role = current.role === ROLE.AVATAR ? ROLE.BROLL : ROLE.AVATAR;
  if (role === ROLE.AVATAR) {
    const rendered = materializeShots(segments, [current])[0];
    const sec = segmentSeconds(rendered);
    if (sec > MAX_AVATAR_SEGMENT_SEC) {
      return { shots: list, delta: 0, error: `这段约 ${sec} 秒，超过单次分身出镜上限；请先拆开。` };
    }
  }
  list[index] = Object.assign({}, current, {
    role,
    assetId: role === ROLE.BROLL ? current.assetId || null : null,
    assetLabel: role === ROLE.BROLL ? current.assetLabel || null : null,
  });
  return { shots: list, delta: estimateCredits(segments, list).total - before, error: null };
}

/** 将任意连续句区间圈成一个镜头；被切到的旧镜头会保留左右剩余范围。 */
function mergeShotRange(segments, shots, startNo, endNo) {
  const source = Array.isArray(segments) ? segments : [];
  const start = Math.min(Number(startNo), Number(endNo));
  const end = Math.max(Number(startNo), Number(endNo));
  const members = source.filter((segment) => segment.no >= start && segment.no <= end);
  if (members.length < 2 || members[0].no !== start || members[members.length - 1].no !== end) {
    return { shots: ensureShots(source, shots), error: '请至少连续选择两句话。' };
  }
  if (members.some((segment) => segment.role === ROLE.TAIL)) {
    return { shots: ensureShots(source, shots), error: '固定结尾不能和正文合并。' };
  }
  const current = ensureShots(source, shots);
  const next = [];
  current.forEach((shot) => {
    if (shot.endNo < start || shot.startNo > end) { next.push(shot); return; }
    if (shot.startNo < start) next.push(Object.assign({}, shot, { id: shotId(shot.startNo, start - 1), endNo: start - 1 }));
    if (shot.endNo > end) next.push(Object.assign({}, shot, { id: shotId(end + 1, shot.endNo), startNo: end + 1 }));
  });
  next.push({
    id: shotId(start, end), startNo: start, endNo: end,
    role: ROLE.BROLL,
    assetId: null, assetLabel: null,
    hint: members.map((segment) => segment.hint).filter(Boolean).join(' · ') || null,
  });
  next.sort((a, b) => a.startNo - b.startNo);
  return { shots: next, error: null };
}

function splitShot(segments, shots, id) {
  const current = ensureShots(segments, shots);
  const target = current.find((shot) => shot.id === id);
  if (!target || target.startNo === target.endNo) return current;
  return current.flatMap((shot) => (shot.id !== id ? [shot]
    : Array.from({ length: target.endNo - target.startNo + 1 }, (_, offset) => {
      const no = target.startNo + offset;
      return Object.assign({}, target, { id: shotId(no, no), startNo: no, endNo: no });
    })));
}

/**
 * 只调整当前镜头里的组合关系：保留勾选的连续句为一段，取消勾选的句子各自成段。
 * 这样用户面对的是“当前画面段”，而不是在整篇脚本里重新猜起止位置。
 */
function regroupShotSelection(segments, shots, id, selectedNos) {
  const source = Array.isArray(segments) ? segments : [];
  const current = ensureShots(source, shots);
  const target = current.find((shot) => shot.id === id);
  if (!target) return { shots: current, error: '没有找到要调整的画面段。' };
  if (target.role === ROLE.TAIL) return { shots: current, error: '固定结尾不能拆分或重组。' };

  const members = source
    .filter((segment) => segment.no >= target.startNo && segment.no <= target.endNo)
    .map((segment) => segment.no);
  const selectedSet = new Set((Array.isArray(selectedNos) ? selectedNos : []).map(Number));
  const selected = members.filter((no) => selectedSet.has(no));
  if (!selected.length) return { shots: splitShot(source, current, id), error: null };

  const contiguous = selected.every((no, index) => index === 0 || no === selected[index - 1] + 1);
  if (!contiguous) return { shots: current, error: '保留在一起的句子需要连续，请补选中间句或分两次调整。' };
  if (selected.length === members.length) return { shots: current, error: null };

  const selectedStart = selected[0];
  const selectedEnd = selected[selected.length - 1];
  const pieces = members.flatMap((no) => {
    if (no < selectedStart || no > selectedEnd) {
      return [Object.assign({}, target, { id: shotId(no, no), startNo: no, endNo: no })];
    }
    if (no === selectedStart) {
      return [Object.assign({}, target, {
        id: shotId(selectedStart, selectedEnd), startNo: selectedStart, endNo: selectedEnd,
      })];
    }
    return [];
  });
  return {
    shots: current.flatMap((shot) => (shot.id === id ? pieces : [shot])),
    error: null,
  };
}

/** 把当前镜头和紧邻的下一镜头合并；固定尾段不参与，素材不一致时要求重新选。 */
function mergeAdjacentShots(segments, shots, id) {
  const source = Array.isArray(segments) ? segments : [];
  const current = ensureShots(source, shots);
  const index = current.findIndex((shot) => shot.id === id);
  if (index < 0 || index >= current.length - 1) return { shots: current, error: '后面没有可以合并的画面段。' };
  const target = current[index];
  const following = current[index + 1];
  if (target.endNo + 1 !== following.startNo) return { shots: current, error: '只能合并相邻的画面段。' };
  if (target.role === ROLE.TAIL || following.role === ROLE.TAIL) return { shots: current, error: '固定结尾不能和正文合并。' };

  const role = target.role === following.role ? target.role : ROLE.BROLL;
  const sameAsset = role === ROLE.BROLL && target.assetId && target.assetId === following.assetId;
  const merged = {
    id: shotId(target.startNo, following.endNo),
    startNo: target.startNo,
    endNo: following.endNo,
    role,
    assetId: sameAsset ? target.assetId : null,
    assetLabel: sameAsset ? target.assetLabel || following.assetLabel || null : null,
    brollSource: role === ROLE.BROLL && target.brollSource && target.brollSource === following.brollSource ? target.brollSource : null,
    hint: [target.hint, following.hint].filter(Boolean).join(' · ') || null,
  };
  if (role === ROLE.AVATAR && segmentSeconds(materializeShots(source, [merged])[0]) > MAX_AVATAR_SEGMENT_SEC) {
    return { shots: current, error: '合并后超过单次分身出镜上限，请保持分段。' };
  }
  return {
    shots: current.slice(0, index).concat([merged], current.slice(index + 2)),
    error: null,
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

/* ── 整段改写 ──────────────────────────────────────────────────────────
   逐句编辑适合微调，但用户拿着一份写好的稿子过来时，一句句抠是折磨。
   整段模式让他直接粘一整篇，一行一句。难点不在切分，在于**别把已配的画面弄丢**：
   assetId 是为"那一句"选的，句子变了绑定就不再成立。 */

/**
 * 把一整段文案切成语义段。
 *
 * 为什么不走 AI 端点：中文口播稿自带句末标点，规则切分即时、免费、离线、结果确定，
 * 粘贴时就能出结果；而语义重组（合并观点、调整顺序）已经有「AI 改稿」在做，
 * 再为切分开一条跨仓库端点是重复投入，还多一次网络往返和一次失败可能。
 *
 * 规则：
 *   1. 先按换行切（用户自己分好的行优先，不要擅自合并他的意图）
 *   2. 行内按句末标点（。！？!?…）切，标点跟着前一句走
 *   3. 太短的碎句并进上一段 —— 「好。」单独成段既难配画面又浪费一次出镜计费
 *   4. 太长的段按次级标点（，、；,;）就近断开，避免一段念半分钟
 */
function splitScriptText(rawText, options) {
  // 4 = 只把 ≤3 字的应答碎句（「好。」「对。」）并进上一段。
  // 再高会误伤「第一句。」这类正常短句，极端情况下把整篇并成一段。
  const minChars = (options && options.minChars) || 4;
  const maxChars = (options && options.maxChars) || 46;
  const lines = String(rawText == null ? '' : rawText).split('\n');
  const out = [];

  const cutLong = (text) => {
    if (text.length <= maxChars) return [text];
    const parts = [];
    let rest = text;
    while (rest.length > maxChars) {
      // 在上限附近找最靠后的次级标点，找不到就硬断
      const window = rest.slice(0, maxChars);
      const at = Math.max(window.lastIndexOf('，'), window.lastIndexOf('、'),
        window.lastIndexOf('；'), window.lastIndexOf(','), window.lastIndexOf(';'));
      const cut = at > minChars ? at + 1 : maxChars;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut);
    }
    if (rest.trim()) parts.push(rest.trim());
    return parts;
  };

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // 逐行独立处理：**绝不跨行合并**。用户敲的换行是他自己的分段意图，
    // 哪怕某行只有两个字，也不该被并进上一行。碎句合并只在行内进行。
    const inLine = [];
    trimmed.split(/(?<=[。！？!?…])/).forEach((sentence) => {
      cutLong(sentence.trim()).forEach((piece) => {
        const text = piece.trim();
        if (!text) return;
        const prev = inLine[inLine.length - 1];
        // 碎句（「好。」「对。」这种）并进同一行的上一段：单独成段既难配画面，
        // 又白占一次出镜计费。上一段已经接近上限时不再并，避免越并越长。
        if (prev && text.replace(/\s/g, '').length < minChars && prev.length + text.length <= maxChars) {
          inLine[inLine.length - 1] = prev + text;
          return;
        }
        inLine.push(text);
      });
    });
    out.push(...inLine);
  });

  return out;
}

/** 段落 → 可编辑文本（只出正文，固定尾段不进编辑区）。 */
function scriptToText(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment.role !== ROLE.TAIL)
    .map((segment) => String(segment.text || '').trim())
    .join('\n');
}

/**
 * 整段文本 → 段落。返回 { segments, shots, stats }，**不做任何提示**，
 * 由调用方拿 stats 决定要不要二次确认。
 *
 * ⚠️ 已配的画面绑在 **shots 层**，不在 segments 上（segments.assetId 恒为 null，
 * 那是镜头层引入之前的遗留字段）。所以「会丢几个画面」必须数 shots，
 * 数 segments 会恒得 0 —— 安全闸永远不触发，用户在毫不知情的情况下丢掉全部配图。
 *
 * 继承规则：
 *   · role  —— 按位置继承。出镜/配画面是编排节奏，跟具体文字弱相关；
 *              超出旧稿长度的新句默认「配画面」（便宜的那个，不偷偷加钱）。
 *   · shots —— 句数没变时保留分组，但**成员文字变过的镜头要清掉素材**
 *              （画面是为那几句选的）；句数变了则整体作废，交回 defaultShots 重算，
 *              因为 startNo/endNo 已经指向别的句子了。
 *   · actualDurationSec —— 只在该位置文字没变时继承，试听时长属于旧文字。
 *   · 固定尾段 —— 原样保留并重新编号，永远不进编辑区、不可被粘贴内容顶掉。
 */
function applyBulkScript(segments, shots, rawText) {
  const source = Array.isArray(segments) ? segments : [];
  const body = source.filter((segment) => segment.role !== ROLE.TAIL);
  const tails = source.filter((segment) => segment.role === ROLE.TAIL);
  const lines = String(rawText == null ? '' : rawText)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const sameTextAt = (index) => Boolean(body[index])
    && String(body[index].text || '').trim() === lines[index];

  const next = lines.map((text, index) => {
    const prev = body[index];
    const unchanged = sameTextAt(index);
    return {
      no: index + 1,
      text,
      role: prev ? prev.role : ROLE.BROLL,
      hint: unchanged ? (prev.hint || null) : null,
      assetId: null,
      assetLabel: null,
      brollSource: null,
      actualDurationSec: unchanged ? Number(prev.actualDurationSec || 0) : 0,
    };
  });

  tails.forEach((tail, index) => {
    next.push(Object.assign({}, tail, { no: lines.length + index + 1 }));
  });

  const prevShots = ensureShots(source, shots);
  const withAssets = prevShots.filter((shot) => shot.assetId);
  const lineCountSame = lines.length === body.length;

  let nextShots = null;
  let droppedAssets = withAssets.length;

  if (lineCountSame) {
    // 句数没变 → 分组仍然对得上位置，逐个镜头判断它覆盖的句子有没有被改过
    let kept = 0;
    nextShots = prevShots.map((shot) => {
      const touched = lines.some((_, index) => {
        const no = index + 1;
        return no >= shot.startNo && no <= shot.endNo && !sameTextAt(index);
      });
      if (!touched) { if (shot.assetId) kept += 1; return Object.assign({}, shot); }
      return Object.assign({}, shot, { assetId: null, assetLabel: null, brollSource: null });
    });
    droppedAssets = withAssets.length - kept;
  }

  const structureChanged = !lineCountSame || lines.some((_, index) => !sameTextAt(index));

  return {
    segments: next,
    shots: nextShots,
    stats: {
      before: body.length,
      after: lines.length,
      droppedAssets,
      changed: structureChanged,
      empty: lines.length === 0,
    },
  };
}

/**
 * 出片前置校验（对应方案 §8.0「提交前 preflight，不 hold 不建单」）。
 * 端上先拦一道，服务端仍要再校验一次 —— 端上校验只为省一次往返，不是安全边界。
 */
function preflight(project, avatar) {
  const problems = [];
  const segments = (project && project.segments) || [];
  const shots = ensureShots(segments, project && project.shots);
  const rendered = materializeShots(segments, shots);

  if (!segments.length) problems.push({ code: 'NO_SEGMENTS', message: '文案还是空的。' });

  const emptyText = segments.filter((s) => s.role !== ROLE.TAIL && !String(s.text || '').trim());
  if (emptyText.length) problems.push({ code: 'EMPTY_TEXT', message: `第 ${emptyText.map((s) => s.no).join('、')} 句还没写内容。` });

  const hasAvatar = rendered.some((s) => s.role === ROLE.AVATAR);
  if (hasAvatar) {
    if (!avatar || avatar.imageStatus !== 'ready') {
      problems.push({ code: 'CLIP_AVATAR_NOT_READY', message: '你的形象还没训练好，可以先用平台预置形象出片。' });
    }
  }
  const hasSpeech = rendered.some((s) => s.role !== ROLE.TAIL);
  if (hasSpeech && (!avatar || avatar.voiceStatus !== 'ready')) {
    problems.push({ code: 'CLIP_VOICE_NOT_READY', message: '视频原声暂不可用，请在分身管理中补录一段专属声音。' });
  }

  const tooLong = rendered.filter((s) => s.role === ROLE.AVATAR && segmentSeconds(s) > MAX_AVATAR_SEGMENT_SEC);
  if (tooLong.length) {
    problems.push({
      code: 'CLIP_SEGMENT_TOO_LONG',
      message: `${tooLong.map((s) => `第 ${s.startNo}${s.endNo > s.startNo ? `–${s.endNo}` : ''} 句`).join('、')}作为出镜段太长，拆短一点。`,
    });
  }

  const missingAssets = rendered.filter((s) => s.role === ROLE.BROLL && !s.assetId);
  if (missingAssets.length) problems.push({ code: 'CLIP_ASSET_NOT_ALLOWED', message: '还有画面段没有选择素材。' });

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

/* ── 成片封面 ───────────────────────────────────────────────────────────────
 *
 * 封面 = 拼在成片最前面的一张 720x1280 图，只占 1~2 帧，不占播放内容；
 * 抖音等平台发布后拿第一帧当缩略图，所以它值得单独设计。
 *
 * 下面这几个是**服务端截断规则的端上镜像**：字数上限必须与 AIStar 的
 * ClipCoverTemplate 槽位 maxChars 一致，否则用户在端上看着没超、存完却被截了一刀。
 * 端上截断只为「所见即所得」，服务端仍会再截一次（端上不是权威）。
 */
const COVER_TEMPLATE_ID = 'cover_shiti';
const COVER_LIMITS = { keyword: 2, handle: 20, slogan: 14, sloganLines: 2, signature: 12 };

/** 按码点截断，和服务端 ClipCoverPlan.truncate 同规则：emoji 不能被劈成半个字符。 */
function truncateCoverText(value, maxChars) {
  const trimmed = String(value == null ? '' : value).trim();
  if (!(maxChars > 0)) return '';
  const points = Array.from(trimmed);
  if (points.length <= maxChars) return trimmed;
  return `${points.slice(0, Math.max(1, maxChars - 1)).join('')}…`;
}

/** 把任意形状的 cover 规整成稳定形状，缺字段一律给默认值，绝不返回 undefined 字段。 */
function normalizeCover(cover) {
  const source = cover && typeof cover === 'object' ? cover : {};
  const rawLines = Array.isArray(source.sloganLines)
    ? source.sloganLines
    : String(source.sloganLines == null ? '' : source.sloganLines).split('\n');
  const sloganLines = [];
  rawLines.forEach((line) => {
    String(line == null ? '' : line).split('\n').forEach((piece) => {
      if (sloganLines.length >= COVER_LIMITS.sloganLines) return;
      const value = truncateCoverText(piece, COVER_LIMITS.slogan);
      if (value) sloganLines.push(value);
    });
  });
  return {
    enabled: source.enabled === true,
    templateId: String(source.templateId || COVER_TEMPLATE_ID),
    keyword: truncateCoverText(source.keyword, COVER_LIMITS.keyword),
    handle: truncateCoverText(source.handle, COVER_LIMITS.handle),
    sloganLines,
    signature: truncateCoverText(source.signature, COVER_LIMITS.signature),
    backgroundAssetId: source.backgroundAssetId || null,
    backgroundSourceNo: Number(source.backgroundSourceNo) || 0,
  };
}

/** 四个槽位有没有填过东西。全空 = 等于没填，服务端也不会加封面。 */
function coverHasText(cover) {
  const value = normalizeCover(cover);
  return Boolean(value.keyword || value.handle || value.signature || value.sloganLines.length);
}

/**
 * 确认页入口卡片那一行摘要。三种状态要分得清：
 * 没开 / 开了但一个字没填（服务端不会加封面，必须说清）/ 开了且填了。
 */
function coverSummary(cover) {
  const value = normalizeCover(cover);
  if (!value.enabled) return { state: 'off', text: '不加封面' };
  if (!coverHasText(value)) return { state: 'blank', text: '还没填内容，出片时不会加封面' };
  const parts = [value.keyword, value.signature || value.sloganLines[0] || value.handle].filter(Boolean);
  return { state: 'on', text: parts.join(' · ') };
}

module.exports = {
  ROLE, STAGES,
  COVER_TEMPLATE_ID, COVER_LIMITS,
  truncateCoverText, normalizeCover, coverHasText, coverSummary,
  estimateSeconds, segmentSeconds, formatDuration, formatBytes, formatAssetDuration, formatWorkTimestamp, workTimeText, assetDisplayLabel,
  mediaDimensions, formatResolution,
  formatCredits, cloneCostText, voiceChoices, cloneCostRows, cloneChargeItems, cloneChargeTotal, retrainQuotaState,
  summarize, estimateCredits, toggleRole, commitSegmentText, preflight, stageRows,
  scriptToText, applyBulkScript, splitScriptText,
  defaultShots, ensureShots, materializeShots, toggleShotRole, mergeShotRange, splitShot,
  regroupShotSelection, mergeAdjacentShots,
};
