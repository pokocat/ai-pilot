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
const SAMPLE = '早上七点，我把卷帘门拉起来，这条街就算醒了。';  // 24 字，留足自定义空间
/** 与服务端 80 字上限对齐 —— 让输入框自己拦住，别等写完再被 422 打回。 */
const MAX = 80;

Component({
  properties: {
    /** 要试听的声音 id。为空时组件不渲染。 */
    voiceId: { type: String, value: '' },
    voiceName: { type: String, value: '' },
    /**
     * 训练完成时固化好的样例音频（服务端 ClipDemoWorker 生成）。
     * 有它的话，默认样例句**点开就响**，不用等三五秒合成，也不消耗按需限流的次数。
     * 用户改了文字才落回合成路径。没有就是 null —— 那就全走合成，行为和以前一样。
     */
    demoAudioUrl: { type: String, value: '' },
    open: { type: Boolean, value: false },
  },

  data: {
    text: SAMPLE,
    max: MAX,
    busy: false,
    error: '',
    played: false,
    /** 当前文字是否还是原样例句 —— 是的话才能用固化音频，改过一个字就不能了。 */
    isSample: true,
  },

  observers: {
    open(value) {
      // 每次开关都换一个代次：关掉浮层（或换成另一条声音）之后，在途的那次合成回来时
      // 代次已经对不上，会被直接丢弃。否则用户关了浮层，几秒后突然从看不见的地方响起来。
      this.gen = (this.gen || 0) + 1;
      this.demoFellBack = false;
      if (value) this.setData({ text: SAMPLE, error: '', played: false, busy: false, isSample: true });
      else { this.destroyAudio(); this.setData({ busy: false }); }
    },
    voiceId() {
      this.gen = (this.gen || 0) + 1;
      this.destroyAudio();
      this.setData({ busy: false, error: '', played: false });
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
      const text = String(event.detail.value || '').slice(0, MAX);
      this.setData({ text, isSample: text.trim() === SAMPLE });
    },

    useSample() { this.setData({ text: SAMPLE, error: '', isSample: true }); },

    play() {
      const text = String(this.data.text || '').trim();
      if (!text) { this.setData({ error: '先写一句想听的话' }); return; }
      if (this.data.busy) return;

      // 快路径：还是原样例句、而且服务端已经固化好了 —— 直接播，零等待、零供应商调用。
      // 这是「预生成 + 固化」相对按需合成的全部好处所在，不能因为多写了一行判断就省掉。
      const demo = String(this.properties.demoAudioUrl || '');
      if (this.data.isSample && demo) {
        this.setData({ error: '', played: true });
        this.playAudio(demo, true);
        return;
      }

      this.synthesize(text);
    },

    /** 按需合成并播放。样例句走不通时也回落到这里。 */
    synthesize(text) {
      if (!text) { this.setData({ error: '先写一句想听的话' }); return; }
      this.setData({ busy: true, error: '' });
      this.gen = (this.gen || 0) + 1;
      const gen = this.gen;
      api.previewVoiceById(this.properties.voiceId, text)
        .then((result) => {
          if (gen !== this.gen) return;
          this.setData({ busy: false });
          // mock 态的 outputRef 是个假 id（MockShiliuGateway 直接把任务 id 当 outputRef 返回），
          // 不是可播地址。不认这个标志的话，用户会对着一个静默失败的按钮反复点。
          if (!result || !result.audioUrl || result.mock) {
            this.setData({ error: '当前是演示数据，听不到真实声音' });
            return;
          }
          this.setData({ played: true });
          this.playAudio(result.audioUrl, false);
        })
        .catch((error) => {
          if (gen !== this.gen) return;
          this.setData({ busy: false, error: (error && error.message) || '试听失败，请稍后再试' });
        });
    },

    playAudio(url, isDemo) {
      this.destroyAudio();
      const audio = wx.createInnerAudioContext();
      this.audio = audio;
      audio.src = url;
      audio.onError(() => {
        // 固化样例的签名链只有一小时。页面开着超过一小时再点，播的就是一个过期地址。
        // 这时候不该甩一句「播放失败」了事 —— 同一句话按需合成一遍就有了，用户根本不必知道
        // 背后换了条路。只回落一次，避免合成也失败时来回打转。
        if (isDemo && !this.demoFellBack) {
          this.demoFellBack = true;
          this.synthesize(String(this.data.text || '').trim());
          return;
        }
        this.setData({ error: '音频播放失败，请重试' });
      });
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
