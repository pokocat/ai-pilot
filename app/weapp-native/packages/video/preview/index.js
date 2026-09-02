/**
 * ② 预览 · 单轨时间线（方案 §3.3，设计稿 Main.dc.html）
 *
 * 这一屏替代「分镜清单」里那种只看画面顺序的连播：一条时间线、一个播放器、
 * 点哪段看哪段、按角色给出能做的事。客户原话是「合成前那个预览可以浏览整体流线，
 * 但没法预览成片效果」，这一屏就是冲着那句话做的。
 *
 * 播放引擎沿用闸门 A 验证页（gatea/index.js）跑通的那套，两条原则不变：
 *   1) 一条连续音轨当主时钟，画面位置每一拍从音轨时间重新推导，漂移不累积；
 *   2) 双 video 交替缓冲，切段只换显示层不等解码。
 * 段内不做 seek 回拉（会锁死播放，见 gatea 的教训），只在切段那一下对齐。
 *
 * 现状限制（写在这儿免得以后有人以为是忘了）：
 *   - 项目数据里**还没有配音（TTS）地址**，服务端没这个接口。没有音轨时退成内部计时器
 *     当时钟，界面上明说「还没有配音，先按每段预计时长走」。接口一到，只换时钟来源。
 *   - 试听 / 改时长 / 裁剪 三个操作没有后端契约，不摆假按钮。
 *   - 图片素材和数字人预览图没有「播放」概念，直接换图层显示。
 */
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { ROLE } = model;

const PPS = 4.2;                 // 时间线每秒像素。22 段 163 秒 ≈ 750px，横滑两屏多（设计稿口径）
const CLIP_GAP = 3;              // 段与段的间隙 px
const MIN_CLIP_W = 30;
const TICK_MS = 100;
const PRIME_LEAD_MS = 2000;      // 提前多久把下一段喂进备用缓冲
const CORRECT_MS = 400;          // 段内兜底回拉阈值。常规对齐在切段时做
const CORRECT_COOLDOWN_MS = 3000;
const CAPTION_MAX = 18;

const ROLE_NAME = { avatar: '数字人出镜', broll: '配画面', tail: '固定片段' };

Page({
  data: {
    ...host.hostBaseData(),
    projectId: '',
    loading: true,
    title: '',
    clips: [],           // 时间线上的段
    total: 0,            // 秒
    totalText: '0:00',
    halfText: '0:00',
    clockText: '0:00 / 0:00',
    headPx: 0,
    scrollLeft: 0,
    playing: false,
    segIndex: 0,
    cur: null,           // 当前段（供段栏与播放器用）
    layer: 'blank',      // a | b | img | blank
    srcA: '', srcB: '', imgSrc: '',
    hasAudio: false,
    footA: '', footB: '',
    showLogin: false,
  },

  onLoad(options) {
    const projectId = String((options && options.projectId) || '');
    if (!projectId) { host.toast('缺少项目参数'); host.back(); return; }
    this.setData({ projectId });
    this.t = 0;
    this.lastVideoTime = { a: 0, b: 0 };
    this.load();
  },
  onUnload() { this.teardown(); },
  onHide() { this.pause(); },

  load() {
    Promise.all([api.project(this.data.projectId), api.assets().catch(() => []), api.avatars().catch(() => [])])
      .then(([project, assets, avatars]) => {
        const list = Array.isArray(avatars) ? avatars : [];
        const avatar = list.find((a) => a.id === project.avatarId) || null;
        const assetsById = {};
        (Array.isArray(assets) ? assets : []).forEach((a) => { if (a && a.id) assetsById[a.id] = a; });
        this.project = project;
        this.avatarUrl = avatar && avatar.imagePreviewUrl ? avatar.imagePreviewUrl : '';
        this.audioUrl = project.previewAudioUrl || '';   // 服务端尚未提供；有了就自动变成主时钟
        this.buildClips(project, assetsById);
      })
      .catch(() => {
        const draft = host.readDraft(this.data.projectId);
        if (draft && draft.project && Array.isArray(draft.project.segments)) {
          this.project = draft.project; this.avatarUrl = ''; this.audioUrl = '';
          this.buildClips(draft.project, {}); host.toast('网络不稳，已打开本地草稿'); return;
        }
        host.toast('项目读不出来'); host.back();
      });
  },

  buildClips(project, assetsById) {
    const shots = model.ensureShots(project.segments, project.shots);
    const rendered = model.materializeShots(project.segments, shots);
    const estimate = model.estimateCredits(project.segments, shots);
    let acc = 0;
    const clips = rendered.map((shot, i) => {
      const seconds = Math.max(1, model.segmentSeconds(shot));
      const isAvatar = shot.role === ROLE.AVATAR;
      const isTail = shot.role === ROLE.TAIL;
      const asset = shot.assetId ? assetsById[shot.assetId] : null;
      const assetUrl = asset ? (asset.contentUrl || asset.previewUrl || '') : '';
      let kind = 'blank';
      if (isAvatar) kind = this.avatarUrl ? 'image' : 'blank';
      else if (asset && assetUrl) kind = asset.kind === 'image' ? 'image' : 'video';
      const clip = {
        i, no: i + 1, id: shot.id, shotId: shot.id,
        role: shot.role, roleName: ROLE_NAME[shot.role] || '',
        from: acc, to: acc + seconds, seconds,
        w: Math.max(MIN_CLIP_W, Math.round(seconds * PPS)),
        lenText: seconds + 's',
        rangeText: model.formatDuration(acc) + '–' + model.formatDuration(acc + seconds),
        text: shot.text || '', hint: isAvatar || isTail ? '' : (shot.hint || ''),
        caption: (shot.text || '').length > CAPTION_MAX ? (shot.text || '').slice(0, CAPTION_MAX) + '…' : (shot.text || ''),
        kind,
        videoUrl: kind === 'video' ? assetUrl : '',
        imageUrl: kind === 'image' ? (isAvatar ? this.avatarUrl : assetUrl) : '',
        pending: isAvatar,                    // 数字人口型动作出片时才生成
        pendKind: isAvatar ? '口型动作待生成' : '',
        blankText: isAvatar ? '数字人还没有预览图' : (isTail ? '模板固定结尾' : '这一段还没配画面'),
        editable: !isTail, locked: isTail,
        ops: isAvatar ? [{ key: 'text', label: '改文案', primary: true }, { key: 'avatar', label: '换数字人' }]
           : (isTail ? [] : [{ key: 'asset', label: '换画面', primary: true }, { key: 'text', label: '改文案' }]),
        grain: isAvatar ? 'g-avatar' : (isTail ? 'g-tail' : ['g-dawn', 'g-street', 'g-hand', 'g-shop'][i % 4]),
      };
      acc += seconds;
      return clip;
    });
    const total = acc;
    const sum = estimate.summary;
    const ready = Math.max(0, sum.totalSec - sum.avatarSec);
    this.clips = clips;
    this.setData({
      loading: false,
      title: project.title || project.templateName || '预览',
      clips: clips.map((c) => Object.assign({}, c, { on: c.i === 0 })),
      total, totalText: model.formatDuration(total), halfText: model.formatDuration(total / 2),
      hasAudio: !!this.audioUrl,
      footA: `已就绪 ${ready} 秒 · 待生成 ${sum.avatarSec} 秒 · 共 ${model.formatDuration(total)}`,
      footB: `数字人出镜 ${sum.avatarCount} 段共 ${sum.avatarSec} 秒待生成，其余用你的素材，免费；本条共计 ${model.formatCredits ? model.formatCredits(estimate.total) : estimate.total + ' 积分'}`,
    });
    this.showClip(0, 0);
  },

  /* ── 时钟 ─────────────────────────────────────────────────────────── */
  now() {
    if (this.audio) return this.audio.currentTime || 0;
    return this.t;
  },
  startClock() {
    if (this.audioUrl && !this.audio) {
      const audio = wx.createInnerAudioContext();
      audio.src = this.audioUrl; audio.obeyMuteSwitch = false;
      audio.onEnded(() => this.finish());
      audio.onError(() => { host.toast('配音放不出来，先按预计时长走'); try { audio.destroy(); } catch (e) {} this.audio = null; this.audioUrl = ''; this.setData({ hasAudio: false }); });
      this.audio = audio;
    }
    if (this.audio) { this.audio.seek(this.t); this.audio.play(); }
    this.lastTick = Date.now();
    this.tick = setInterval(() => this.onTick(), TICK_MS);
  },
  stopClock() {
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    if (this.boundaryTimer) { clearTimeout(this.boundaryTimer); this.boundaryTimer = null; }
    if (this.audio) { try { this.audio.pause(); } catch (e) {} }
  },

  /* ── 播放控制 ─────────────────────────────────────────────────────── */
  togglePlay() { if (this.data.playing) this.pause(); else this.play(); },
  play() {
    if (this.data.playing || !this.clips.length) return;
    if (this.t >= this.data.total) { this.t = 0; this.showClip(0, 0); }
    this.setData({ playing: true });
    this.startClock();
    const cur = this.clips[this.data.segIndex];
    this.armBoundary(cur.i);
    this.primedIndex = -1;
    if (cur.kind === 'video') { const ctx = this.ctxOf(this.data.layer); if (ctx) ctx.play(); }
  },
  pause() {
    if (!this.data.playing) return;
    this.stopClock();
    const ctx = this.ctxOf(this.data.layer); if (ctx) ctx.pause();
    this.setData({ playing: false });
  },
  finish() { this.pause(); this.t = 0; this.showClip(0, 0); },

  onTick() {
    const nowMs = Date.now();
    if (!this.audio) this.t = Math.min(this.data.total, this.t + (nowMs - this.lastTick) / 1000);
    this.lastTick = nowMs;
    const t = this.now();
    if (t >= this.data.total) { this.finish(); return; }

    const i = this.data.segIndex;
    const cur = this.clips[i];
    // 预热下一段（按理想时间线判断）
    const ideal = this.clipAt(t);
    if (ideal && (ideal.to - t) * 1000 <= PRIME_LEAD_MS) this.prime(ideal.i + 1);

    // 段内兜底回拉，仅对视频段、且新读数已回来、且过了冷却
    if (cur && cur.kind === 'video' && this.audio) {
      const key = this.data.layer;
      const shown = cur.from + (this.lastVideoTime[key] || 0);
      const d = (shown - t) * 1000;
      if (Math.abs(d) > CORRECT_MS && this.awaitingTime !== key && nowMs - (this.lastCorrectAt || 0) > CORRECT_COOLDOWN_MS) {
        const ctx = this.ctxOf(key);
        if (ctx) { ctx.seek(Math.max(0, t - cur.from)); this.lastCorrectAt = nowMs; this.awaitingTime = key; }
      }
    }
    this.paintHead(t);
  },

  paintHead(t) {
    const passed = this.clips.filter((c) => c.to <= t).length;
    const headPx = Math.round(t * PPS + passed * CLIP_GAP);
    const patch = { headPx, clockText: model.formatDuration(t) + ' / ' + this.data.totalText };
    // 轨道跟着播放头走，播放头保持在轨道靠左三分之一处。暂停时没有 tick，
    // 只在点段那一下跟一次，不会跟用户手动横滑打架。
    patch.scrollLeft = Math.max(0, headPx - 120);
    this.setData(patch);
  },

  clipAt(t) {
    for (let i = this.clips.length - 1; i >= 0; i--) if (t >= this.clips[i].from) return this.clips[i];
    return this.clips[0];
  },

  armBoundary(index) {
    if (this.boundaryTimer) { clearTimeout(this.boundaryTimer); this.boundaryTimer = null; }
    if (index >= this.clips.length - 1) return;
    const wait = Math.max(0, (this.clips[index].to - this.now()) * 1000);
    this.boundaryTimer = setTimeout(() => { this.boundaryTimer = null; this.swapTo(index + 1); }, wait);
  },

  ctxOf(layer) { return layer === 'a' || layer === 'b' ? wx.createVideoContext(layer === 'a' ? 'pv-a' : 'pv-b', this) : null; },
  spareOf() { return this.data.layer === 'a' ? 'b' : 'a'; },

  /** 把第 index 段装进备用缓冲并解出首帧（仅视频段需要）。 */
  prime(index) {
    const c = this.clips[index];
    if (!c || this.primedIndex === index || c.kind !== 'video') return;
    this.primedIndex = index;
    const spare = this.spareOf();
    this.setData({ [spare === 'a' ? 'srcA' : 'srcB']: c.videoUrl }, () => {
      const ctx = this.ctxOf(spare); if (!ctx) return;
      ctx.seek(0); ctx.play(); setTimeout(() => ctx.pause(), 60);
    });
  },

  /** 播放中到达段边界：切到第 index 段。 */
  swapTo(index) {
    if (index >= this.clips.length) { this.finish(); return; }
    this.showClip(index, this.now(), true);
    this.armBoundary(index);
  },

  /**
   * 显示第 index 段。t 是当前时钟；resume 表示正在播放、切换后要接着放。
   * 这是唯一「免费」的对齐时机：反正要换显示层，这一下 seek 不额外制造顿。
   */
  showClip(index, t, resume) {
    const c = this.clips[index]; if (!c) return;
    const old = this.data.layer;
    const patch = { segIndex: index, cur: c, clips: this.data.clips.map((x) => Object.assign({}, x, { on: x.i === index })) };
    if (c.kind === 'video') {
      const key = (this.primedIndex === index) ? this.spareOf() : (old === 'a' ? 'b' : 'a');
      patch.layer = key; patch[key === 'a' ? 'srcA' : 'srcB'] = c.videoUrl;
      this.lastVideoTime[key] = 0; this.awaitingTime = key;
      const into = Math.max(0, (t || 0) - c.from);
      this.setData(patch, () => {
        const ctx = this.ctxOf(key);
        if (ctx) { if (into > 0.05) ctx.seek(into); if (resume) ctx.play(); else { ctx.play(); setTimeout(() => ctx.pause(), 60); } }
        const oldCtx = old !== key ? this.ctxOf(old) : null; if (oldCtx) oldCtx.pause();
      });
    } else {
      patch.layer = c.kind === 'image' ? 'img' : 'blank'; patch.imgSrc = c.imageUrl || '';
      this.setData(patch, () => { const oldCtx = this.ctxOf(old); if (oldCtx) oldCtx.pause(); });
    }
    this.primedIndex = -1;
    this.paintHead(t || 0);
  },

  onVideoTime(e) {
    const key = e.currentTarget.dataset.key;
    const t = e.detail && typeof e.detail.currentTime === 'number' ? e.detail.currentTime : 0;
    this.lastVideoTime[key] = t;
    if (this.awaitingTime === key) this.awaitingTime = null;
  },
  onVideoError() { host.toast('这一段素材放不出来'); },

  /* ── 时间线交互 ───────────────────────────────────────────────────── */
  pickClip(e) {
    const i = Number(e.currentTarget.dataset.i);
    const c = this.clips[i]; if (!c) return;
    this.pause();
    this.t = c.from; if (this.audio) this.audio.seek(c.from);
    this.showClip(i, c.from, false);
  },

  /* ── 段栏操作 ─────────────────────────────────────────────────────── */
  onOp(e) {
    const key = e.currentTarget.dataset.key;
    const c = this.data.cur; if (!c) return;
    const pid = encodeURIComponent(this.data.projectId);
    this.pause();
    if (key === 'asset') host.go(`assets/index?pick=1&projectId=${pid}&shotId=${encodeURIComponent(c.shotId)}`);
    else if (key === 'text') host.go(`script/index?projectId=${pid}&no=${c.no}`);
    else if (key === 'avatar') host.go(`shots/index?projectId=${pid}&pickAvatar=1`);
  },

  /* ── 底部 ─────────────────────────────────────────────────────────── */
  generate() {
    if (!host.requireLogin(this, 'execute')) return;
    this.pause();
    host.go(`confirm/index?projectId=${encodeURIComponent(this.data.projectId)}`);
  },

  teardown() {
    this.stopClock();
    if (this.audio) { try { this.audio.destroy(); } catch (e) {} this.audio = null; }
  },
  back() { this.pause(); host.back(); },
  closeLogin() { this.setData({ showLogin: false }); }, loggedIn() { this.setData({ showLogin: false }); },
  swallow() {},
});
