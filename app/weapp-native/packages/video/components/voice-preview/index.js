// 声音试听浮层。
//
// 为什么做成组件：训练完成页、我的声音、分身管理三处都要有同一个入口
// （用户原话：「训练出来的数字人声音效果不确定…先听一下，免得做成片效果不好，浪费钻石」），
// 复制三份迟早分叉。放在分包内而不是主包 components/，是为了保持这个分包可整体抽走。
//
// 底下是石榴的 POST /speaker/tts（同步返回音频），**不扣用户钻石** —— 军师 BFF 那条路由是纯透传，
// 没有任何 hold/settle，成本落在石榴的 validPoint 上。所以试听可以随便听，只在服务端做限流。
const api = require('../../api');

/** 默认样例：挑的是有语气、有停顿的句子，比「一二三四」更能听出像不像本人。 */
const SAMPLE = '早上七点，我把卷帘门拉起来，这条街就算醒了。';
const MAX = 200;

Component({
  properties: {
    /** 要试听的声音 id。为空时组件不渲染。 */
    voiceId: { type: String, value: '' },
    voiceName: { type: String, value: '' },
    open: { type: Boolean, value: false },
  },

  data: {
    text: SAMPLE,
    max: MAX,
    busy: false,
    error: '',
    played: false,
  },

  observers: {
    open(value) {
      if (value) this.setData({ text: SAMPLE, error: '', played: false, busy: false });
      else this.destroyAudio();
    },
  },

  // 组件销毁时必须停掉音频：否则退出页面后还在响。
  detached() { this.destroyAudio(); },

  methods: {
    close() {
      this.destroyAudio();
      this.triggerEvent('close');
    },

    swallow() {},

    inputText(event) {
      this.setData({ text: String(event.detail.value || '').slice(0, MAX) });
    },

    useSample() { this.setData({ text: SAMPLE, error: '' }); },

    play() {
      const text = String(this.data.text || '').trim();
      if (!text) { this.setData({ error: '先写一句想听的话' }); return; }
      if (this.data.busy) return;
      this.setData({ busy: true, error: '' });
      api.previewVoiceById(this.properties.voiceId, text)
        .then((result) => {
          this.setData({ busy: false });
          // mock 态的 outputRef 是个假 id（MockShiliuGateway 直接把任务 id 当 outputRef 返回），
          // 不是可播地址。不认这个标志的话，用户会对着一个静默失败的按钮反复点。
          if (!result || !result.audioUrl || result.mock) {
            this.setData({ error: '当前是演示数据，听不到真实声音' });
            return;
          }
          this.setData({ played: true });
          this.playAudio(result.audioUrl);
        })
        .catch((error) => {
          this.setData({ busy: false, error: (error && error.message) || '试听失败，请稍后再试' });
        });
    },

    playAudio(url) {
      this.destroyAudio();
      const audio = wx.createInnerAudioContext();
      this.audio = audio;
      audio.src = url;
      audio.onError(() => this.setData({ error: '音频播放失败，请重试' }));
      audio.play();
    },

    /** ⚠️ 必须 destroy：文案页那个试听就漏过，多听几次会攒下一串没释放的播放器。 */
    destroyAudio() {
      if (!this.audio) return;
      try { this.audio.stop(); this.audio.destroy(); } catch (_) { /* 已销毁 */ }
      this.audio = null;
    },
  },
});
