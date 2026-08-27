/**
 * 闸门 A · 手机装配预览可行性验证页
 * 协议：docs/KUAICHUPIAN_GATE_PROTOCOL_2026-08-24.md
 *
 * 这一屏要回答的问题：手机能不能一边连播多段视频，一边对上声音和字幕。
 * 现有的 shots 连播（packages/video/shots/index.js）当初是**刻意静音**来回避这个问题的，
 * 所以这里不是改它，是另起一版按下面两条重写：
 *
 * 1) 一条连续音轨当主时钟。
 *    TTS + BGM 混成一条 163 秒的音频，从头放到尾不中断；视频段全部静音，只出画面。
 *    每一拍的画面位置都从 audio.currentTime **重新推导**，不是上一段推下一段。
 *    这样漂移不会累积 —— 旧实现那种 setTimeout 链是每段误差往下传，
 *    163 秒下来能攒出接近一秒（方案 §2.5 已经指出这个问题）。
 *
 * 2) 双 video 交替缓冲。
 *    单个 video 换 src 必然有一段解码空窗，那就是黑场。
 *    改成 A/B 两个实例：A 在放第 N 段时，B 已经把第 N+1 段的首帧解出来了，
 *    到边界只是换个显示层，不等解码。
 *
 * 埋点是协议 §1.6 说的**第二证据线**。判定以 60fps 录屏逐帧为准，
 * 两者冲突时以录屏为准 —— 因为 JS 看得见的是「我下了播放指令」到「播放事件回来」，
 * 看不见「这一帧真的上屏了」。本页所有数字都按这个口径标注。
 */
const host = require('../host.js');
const manifest = require('./manifest.js');
const metrics = require('./metrics.js');

/** 提前多久把下一段喂进备用缓冲。太短来不及解码，太长白占一路解码器（低端机很敏感）。 */
const PRIME_LEAD_MS = 2000;
/** 画面与音频偏差超过这个值就回拉。低于一帧半没必要动，seek 本身会造成可见的顿。 */
const CORRECT_MS = 120;
/** 主时钟采样间隔。漂移曲线和字幕都靠它，100ms 够用且不烧电。 */
const TICK_MS = 100;

Page({
  data: {
    ...host.hostBaseData(),
    phase: 'idle',              // idle | priming | playing | done
    manifestId: 'placeholder',
    manifestLabel: '',
    runnable: false,
    totalSec: 0,
    segCount: 0,
    segIndex: 0,
    segNo: 0,
    segRole: '',
    audioSec: '0.0',
    driftMs: 0,
    cueText: '',
    srcA: '', srcB: '',
    activeKey: 'a',
    report: null,
    reportJson: '',
    notice: '',
  },

  onLoad() {
    const m = manifest.isRunnable(manifest.REAL) ? manifest.REAL : manifest.PLACEHOLDER;
    this.setData({
      manifestId: m.id,
      manifestLabel: m.label,
      runnable: manifest.isRunnable(m),
      totalSec: m.totalSec,
      segCount: (m.segments || []).length,
      notice: manifest.isRunnable(m)
        ? ''
        : '当前是占位清单，跑不出合法闸门数据。把真实素材地址填进 gatea/manifest.js 的 REAL 再跑。',
    });
    this.source = m;
    this.resetMarks();
  },

  onUnload() { this.teardown(); },
  onHide() { this.teardown(); },

  resetMarks() {
    this.marks = { gaps: [], drift: [], firstFrame: [], crashes: 0 };
    this.lastVideoTime = { a: 0, b: 0 };
    this.primedIndex = -1;
    this.awaitingTime = null;
    this.pendingSwap = null;   // { index, tCmd, key }
    this.tapAt = 0;
    this.firstFrameLogged = false;
  },

  /** 段边界表：从清单的累计起点推，不重新等分。 */
  segmentAt(t) {
    const segs = this.source.segments;
    for (let i = segs.length - 1; i >= 0; i--) {
      if (t >= segs[i].startSec) return { i, seg: segs[i] };
    }
    return { i: 0, seg: segs[0] };
  },

  start() {
    if (this.data.phase !== 'idle' && this.data.phase !== 'done') return;
    if (!this.source.segments.length) { host.toast('清单是空的'); return; }
    this.resetMarks();
    this.tapAt = Date.now();

    const runId = String(this.tapAt);
    this.live = manifest.withRunId(this.source, runId);   // 冷缓存：每次跑测挂唯一 query（§1.3）

    // 第一段先进 A，等它把首帧解出来再起音轨 —— 否则声音已经在走、画面还在转圈，
    // 首帧起播这项就被测成「音频起播」了，测的不是同一件事。
    this.setData({ phase: 'priming', srcA: this.live.segments[0].url, activeKey: 'a', segIndex: 0 }, () => {
      const ctx = wx.createVideoContext('gv-a', this);
      if (ctx) { ctx.seek(0); ctx.play(); }
    });
  },

  /** A 的首帧出来了 —— 这时候才起音轨，两边同时从 0 开始。 */
  beginWithAudio() {
    if (this.data.phase !== 'priming') return;
    const audio = wx.createInnerAudioContext();
    audio.src = this.live.audioUrl;
    audio.autoplay = false;
    audio.obeyMuteSwitch = false;   // 静音键开着也要出声，否则测出来的是「没声音」
    audio.onError((e) => {
      this.marks.crashes += 0;
      host.toast('音轨放不出来：' + (e && e.errMsg ? e.errMsg : '未知'));
      this.finish();
    });
    audio.onEnded(() => this.finish());
    this.audio = audio;
    audio.play();

    this.setData({ phase: 'playing' });
    this.tick = setInterval(() => this.onTick(), TICK_MS);
    this.armBoundary(0);
  },

  /**
   * 边界切换用定时器精确打点，不靠 100ms 的主循环发现「已经越界了」——
   * 那样光是发现延迟就能吃掉判据线的三分之二。
   */
  armBoundary(index) {
    if (this.boundaryTimer) { clearTimeout(this.boundaryTimer); this.boundaryTimer = null; }
    const segs = this.live.segments;
    if (index >= segs.length - 1) return;
    const endSec = segs[index].startSec + segs[index].durationSec;
    const wait = Math.max(0, (endSec - this.audioTime()) * 1000);
    this.boundaryTimer = setTimeout(() => { this.boundaryTimer = null; this.swapTo(index + 1); }, wait);
  },

  audioTime() { return this.audio && typeof this.audio.currentTime === 'number' ? this.audio.currentTime : 0; },

  onTick() {
    if (this.data.phase !== 'playing') return;
    const t = this.audioTime();
    const key = this.data.activeKey;

    // 漂移要拿**屏幕上实际在放哪一段**算，不能拿理想时间线算。
    // 边界定时器和这个 100ms 循环可能在同一时刻触发：循环先跑的话，
    // segmentAt(t) 已经指向下一段、而画面还停在上一段，算出来是整整一段时长的假漂移。
    // 用 segIndex 还有个好处：切换真的迟了，漂移就如实反映这个迟 —— 那正是要测的东西。
    const i = this.data.segIndex;
    const seg = this.live.segments[i];
    if (!seg) return;

    // 新缓冲的第一次 timeupdate 还没回来时，这一拍的画面时间是不可信的，跳过。
    // 记了会污染漂移曲线，回拉会造成切点后的顿。
    if (this.awaitingTime === key) { this.setData({ audioSec: t.toFixed(1), segIndex: i, segNo: seg.no, segRole: seg.role, cueText: this.cueAt(t) }); return; }

    // 画面相对音频的偏移。正数 = 画面跑在前面。
    const shown = seg.startSec + (this.lastVideoTime[key] || 0);
    const d = (shown - t) * 1000;
    this.marks.drift.push({ t: Math.round(t * 10) / 10, d: Math.round(d) });

    // 偏多了就把画面拉回音频的位置。回拉的是画面，不是声音 —— 声音是主时钟，不能动。
    if (Math.abs(d) > CORRECT_MS) {
      const ctx = wx.createVideoContext(key === 'a' ? 'gv-a' : 'gv-b', this);
      if (ctx) ctx.seek(Math.max(0, t - seg.startSec));
    }

    // 预热按理想时间线判断，不受上面那个「以实际显示为准」的影响 ——
    // 该预热就得预热，不能因为切换迟了就跟着迟。
    const ideal = this.segmentAt(t);
    const endSec = ideal.seg.startSec + ideal.seg.durationSec;
    if ((endSec - t) * 1000 <= PRIME_LEAD_MS) this.prime(ideal.i + 1);

    this.setData({
      audioSec: t.toFixed(1),
      driftMs: Math.round(d),
      segNo: seg.no, segRole: seg.role,
      cueText: this.cueAt(t),
    });
  },

  cueAt(t) {
    const cues = this.live.cues || [];
    for (const c of cues) if (t >= c.startSec && t < c.endSec) return c.text;
    return '';
  },

  /** 把第 index 段装进当前没在显示的那一路，解出首帧后停住等切换。 */
  prime(index) {
    const segs = this.live.segments;
    if (index >= segs.length || this.primedIndex === index) return;
    this.primedIndex = index;
    const spare = this.data.activeKey === 'a' ? 'b' : 'a';
    this.setData({ [spare === 'a' ? 'srcA' : 'srcB']: segs[index].url }, () => {
      const ctx = wx.createVideoContext(spare === 'a' ? 'gv-a' : 'gv-b', this);
      if (!ctx) return;
      ctx.seek(0);
      ctx.play();                    // 触发解码
      setTimeout(() => ctx.pause(), 60);  // 首帧出来后停住，别让它自己往前跑
    });
  },

  swapTo(index) {
    const segs = this.live.segments;
    if (index >= segs.length) { this.finish(); return; }
    const spare = this.data.activeKey === 'a' ? 'b' : 'a';
    if (this.primedIndex !== index) this.prime(index);   // 没来得及预热也得切，记下来这次会是长间隙

    // 刚切过去的那一路，lastVideoTime 还留着它**上次当值时**的旧值。
    // 不清掉的话，切换后第一拍会算出一个几秒的假漂移，接着触发一次回拉 seek ——
    // 等于在每个切点后自己制造一次可见的顿，而漂移正是这一屏要测的指标。
    // prime() 已经把它 seek 到 0，这里把记账对齐，并等它的第一次 timeupdate 回来再开始算漂移。
    this.lastVideoTime[spare] = 0;
    this.awaitingTime = spare;
    this.pendingSwap = { index, key: spare, tCmd: Date.now() };
    const ctx = wx.createVideoContext(spare === 'a' ? 'gv-a' : 'gv-b', this);
    this.setData({ activeKey: spare, segIndex: index }, () => {
      if (ctx) ctx.play();
      const old = wx.createVideoContext(spare === 'a' ? 'gv-b' : 'gv-a', this);
      if (old) old.pause();
      this.armBoundary(index);
    });
  },

  /** 视频真的开始播了。切换间隙以这个事件为准（埋点线，非录屏线）。 */
  onVideoPlay(e) {
    const key = e.currentTarget.dataset.key;
    if (this.data.phase === 'priming' && key === 'a') { this.beginWithAudio(); return; }
    const p = this.pendingSwap;
    if (p && p.key === key) {
      this.marks.gaps.push(Date.now() - p.tCmd);
      this.pendingSwap = null;
    }
  },

  onVideoTime(e) {
    const key = e.currentTarget.dataset.key;
    const t = e.detail && typeof e.detail.currentTime === 'number' ? e.detail.currentTime : 0;
    this.lastVideoTime[key] = t;
    if (this.awaitingTime === key) this.awaitingTime = null;
    if (!this.firstFrameLogged && key === this.data.activeKey && t > 0 && this.tapAt) {
      this.firstFrameLogged = true;
      this.marks.firstFrame.push(Date.now() - this.tapAt);
    }
  },

  onVideoError(e) {
    const key = e.currentTarget.dataset.key;
    host.toast('第 ' + (this.data.segIndex + 1) + ' 段放不出来（' + key + '）');
  },

  finish() {
    this.teardown();
    const report = metrics.summarize(this.marks);
    this.setData({
      phase: 'done',
      report,
      reportJson: JSON.stringify({
        manifest: this.data.manifestId,
        note: this.data.runnable ? '埋点线；判定以 60fps 录屏为准（协议 §1.6）'
                                 : '占位素材，非合法闸门数据',
        counts: report.counts,
        checks: report.checks,
        proposedRevision: report.proposed,
        driftSeries: report.series,
      }, null, 2),
    });
  },

  teardown() {
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    if (this.boundaryTimer) { clearTimeout(this.boundaryTimer); this.boundaryTimer = null; }
    if (this.audio) { try { this.audio.stop(); this.audio.destroy(); } catch (err) {} this.audio = null; }
  },

  copyReport() {
    if (!this.data.reportJson) return;
    wx.setClipboardData({ data: this.data.reportJson, success: () => host.toast('已复制', 'success') });
  },

  stop() { this.finish(); },
  back() { host.back(); },
});
