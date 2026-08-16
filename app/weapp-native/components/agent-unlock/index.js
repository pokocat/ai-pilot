const { api } = require('../../services/api');
const store = require('../../services/store');

Component({
  properties: {
    agent: { type: Object, value: null },
    source: { type: String, value: 'catalog' },
    refId: { type: String, value: '' },
  },
  data: {
    busy: false,
    themeClass: 'theme-green',
    colorKey: 'green',
  },
  observers: {
    // 2026-08 起「确认即启用」：启用动作本身不收费，这里不再读余额/价格。
    agent(agent) {
      store.setOverlay(Boolean(agent), 'agent-unlock');
      if (!agent) return;
      const snapshot = store.snapshot();
      this.setData({
        themeClass: snapshot.themeClass,
        colorKey: snapshot.colorKey,
      });
    },
  },
  lifetimes: {
    detached() { store.setOverlay(false, 'agent-unlock'); },
  },
  methods: {
    stop() {},
    close() { if (!this.data.busy) this.triggerEvent('close'); },
    async confirm() {
      const agent = this.data.agent;
      if (!agent || this.data.busy) return;
      this.setData({ busy: true });
      try {
        const result = await api.purchaseAgent(agent.key, {
          source: this.data.source || 'catalog',
          refId: this.data.refId || undefined,
        });
        await Promise.all([store.loadAgents(), store.loadMe()]);
        const fresh = store.snapshot().agents.find((item) => item.key === agent.key) || Object.assign({}, agent, { owned: true });
        wx.showToast({ title: result.alreadyOwned ? '已启用' : '已加入工作台', icon: 'success' });
        this.triggerEvent('unlocked', { agent: fresh });
      } catch (error) {
        const kind = store.handleApiError(error, { silent: true });
        if (kind !== 'unauthorized') {
          wx.showToast({ title: (error && error.message) || '启用失败，请重试', icon: 'none' });
        }
      } finally {
        this.setData({ busy: false });
      }
    },
  },
});
