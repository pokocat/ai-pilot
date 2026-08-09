const store = require('../../services/store');
const coach = require('../../services/coach');

function currentRoute() { try { const pages = getCurrentPages(); return pages.length ? pages[pages.length - 1].route : ''; } catch (_) { return ''; } }

Component({
  data: { active: false, step: 0, kicker: '', title: '', text: '', action: '下 一 步', arrowLeft: 58 },
  lifetimes: { attached() { this.evaluate(); } },
  pageLifetimes: { show() { this.evaluate(); } },
  methods: {
    stop() {},
    /**
     * 教学层的开关要让宿主页知道：问策终态的底部浮岛（输入行 + tab 行，高约 159px）比这层
     * 面板假设的 66px 底栏高得多，不让位就会把面板下半截连同「下一步」一起盖住（2026-08-08 真机）。
     * 宿主页收到 coachstate 后把浮岛收成纯底栏、并收起提示 pill；箭头仍指着真实底栏。
     */
    emitState(active) {
      this.triggerEvent('coachstate', { active });
    },
    evaluate() {
      const state = store.snapshot();
      const active = Boolean(state.authed && state.onboarded && coach.coachPending());
      if (!active) { if (this.data.active) { this.setData({ active: false }); this.emitState(false); } return; }
      if (!this.data.active) this.emitState(true);
      const persisted = coach.loadStep();
      const onScreen = coach.stepForRoute(currentRoute());
      const step = onScreen >= 0 ? onScreen : persisted;
      if (step !== persisted) coach.saveStep(step);
      const item = coach.STEPS[step];
      let width = 375;
      try { width = wx.getWindowInfo().windowWidth || width; } catch (_) { /* 375px 兜底 */ }
      this.setData({ active: true, step, kicker: `上手 · ${coach.CN[step]} / 五`, title: item.title, text: item.text, action: step >= coach.STEPS.length - 1 ? '开 始 使 用' : '下 一 步', arrowLeft: 26 + ((width - 52) / 5) * (step + 0.5) });
    },
    skip() { coach.markDone(); this.setData({ active: false }); this.emitState(false); },
    advance() { const next = this.data.step + 1; if (next >= coach.STEPS.length) { this.skip(); return; } coach.saveStep(next); wx.switchTab({ url: coach.STEPS[next].route }); },
  },
});
