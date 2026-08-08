const store = require('../../services/store');
const coach = require('../../services/coach');

function currentRoute() { try { const pages = getCurrentPages(); return pages.length ? pages[pages.length - 1].route : ''; } catch (_) { return ''; } }

Component({
  data: { active: false, step: 0, kicker: '', title: '', text: '', action: '下 一 步', arrowLeft: 58 },
  lifetimes: { attached() { this.evaluate(); } },
  pageLifetimes: { show() { this.evaluate(); } },
  methods: {
    stop() {},
    evaluate() {
      const state = store.snapshot();
      const active = Boolean(state.authed && state.onboarded && coach.coachPending());
      if (!active) { if (this.data.active) this.setData({ active: false }); return; }
      const persisted = coach.loadStep();
      const onScreen = coach.stepForRoute(currentRoute());
      const step = onScreen >= 0 ? onScreen : persisted;
      if (step !== persisted) coach.saveStep(step);
      const item = coach.STEPS[step];
      let width = 375;
      try { width = wx.getWindowInfo().windowWidth || width; } catch (_) { /* 375px 兜底 */ }
      this.setData({ active: true, step, kicker: `上手 · ${coach.CN[step]} / 五`, title: item.title, text: item.text, action: step >= coach.STEPS.length - 1 ? '开 始 使 用' : '下 一 步', arrowLeft: 26 + ((width - 52) / 5) * (step + 0.5) });
    },
    skip() { coach.markDone(); this.setData({ active: false }); },
    advance() { const next = this.data.step + 1; if (next >= coach.STEPS.length) { this.skip(); return; } coach.saveStep(next); wx.switchTab({ url: coach.STEPS[next].route }); },
  },
});
