// 我的声音。
//
// 为什么要单独一屏：声音此前只在「我的数字分身」里作为形象的附属出现。只训了声音、还没建形象的
// 用户，在小程序里**没有任何一个地方看得到自己的声音** —— 训练完成也无从确认，重录入口也找不到。
// 2026-08-15 就是这么暴露的：上游 16:16 已经 ready，用户在端上完全看不出来。
//
// 声音是可以脱离形象独立存在的资产（一条声音能被多个形象复用），所以它该有自己的列表。
const host = require('../host');
const api = require('../api');

const POLL_INTERVAL_MS = 5000;

function formatCompletedAt(value) {
  if (!value) return '';
  const date = new Date(value);
  // 上游历史数据里这个字段可能是「7 月 28 日」这种已经排好版的字符串，不是 ISO。
  // 解析不了就原样透出，别显示 Invalid Date。
  if (Number.isNaN(date.getTime())) return `${value} 完成`;
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())} 完成`;
}

function decorate(voice) {
  const status = (voice && voice.status) || 'none';
  const progress = Math.max(0, Math.min(100, Number(voice && voice.progress) || 0));
  const dedicated = !voice || voice.source !== 'video';
  return Object.assign({}, voice, {
    training: status === 'training',
    ready: status === 'ready',
    failed: status === 'failed',
    progress: status === 'ready' ? 100 : progress,
    statusText: status === 'ready' ? '已就绪'
      : status === 'training' ? `训练 ${progress}%`
        : status === 'failed' ? '训练失败' : '未就绪',
    sourceText: dedicated ? '专属录制' : '视频原声',
    sourceDesc: dedicated
      ? '你单独录制的音色，出片时优先使用这一版'
      : '从形象视频里提取的基础音色，补录后会更稳',
    completedText: status === 'ready' ? formatCompletedAt(voice && voice.trainedText) : '',
    actionText: status === 'training' ? '训练中' : status === 'failed' ? '重新录制' : '重录提升',
  });
}

Page({
  data: host.hostBaseData({
    loading: true,
    /**
     * 读失败 ≠ 没有声音。混成一个空态，会把「服务挂了」说成「你还没有录过」——
     * 用户据此去重录，等于让他为我们的故障再付一次费。四态各自渲染。
     */
    loadFailed: false,
    voices: [],
    loggedIn: false,
    showLogin: false,
  }),

  onLoad() { this.load(); },
  onShow() { if (!this.data.loading) this.load(); },
  onHide() { this.stopPolling(); },
  onUnload() { this.stopPolling(); },

  load() {
    this.stopPolling();
    // 游客可以浏览这一屏（不前置登录门），只是列表读不到东西 —— 见微信整改要求。
    if (!host.isLoggedIn()) {
      this.setData({ loading: false, loadFailed: false, loggedIn: false, voices: [] });
      return;
    }
    // 并发闸：onShow 与轮询可能同时触发，晚回来的那次不许覆盖新结果。
    const token = (this._loadToken || 0) + 1;
    this._loadToken = token;
    api.voices()
      .then((rows) => {
        if (this._loadToken !== token) return;
        const voices = (Array.isArray(rows) ? rows : []).map(decorate);
        this.setData({ loading: false, loadFailed: false, loggedIn: true, voices });
        this.schedulePolling(voices);
      })
      .catch(() => {
        if (this._loadToken !== token) return;
        // 保留上一次读到的 voices，并让轮询继续 —— 训练中撞上一次网络抖动不该把进度永久冻住。
        this.setData({ loading: false, loadFailed: true, loggedIn: true });
        this.schedulePolling(this.data.voices);
      });
  },

  schedulePolling(voices) {
    if (!(voices || []).some((voice) => voice.training)) return;
    this._pollTimer = setTimeout(() => this.load(), POLL_INTERVAL_MS);
  },

  stopPolling() {
    if (!this._pollTimer) return;
    clearTimeout(this._pollTimer);
    this._pollTimer = null;
  },

  /** 重录已有声音：带上 voiceId 才走「重训」档（更便宜，且供应商每条给 4 次免费重训）。 */
  retrain(event) {
    const id = String(event.currentTarget.dataset.id || '');
    const voice = this.data.voices.find((item) => item.id === id);
    if (!host.requireLogin(this, 'execute')) return;
    if (voice && voice.training) { host.toast(`这条声音正在训练 ${voice.progress}%`); return; }
    host.go(`clone/index?mode=voice&recapture=1&voiceId=${encodeURIComponent(id)}`);
  },

  startVoice() {
    if (!host.requireLogin(this, 'execute')) return;
    host.go('clone/index?mode=voice');
  },

  openAvatars() { host.go('avatar/index'); },

  retry() { this.setData({ loading: true, loadFailed: false }); this.load(); },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
});
