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
    enough: false,
    unlimited: false,
    priceText: 'x0',
    balanceText: '0 点',
    themeClass: 'theme-green',
    colorKey: 'green',
  },
  observers: {
    agent(agent) {
      store.setOverlay(Boolean(agent), 'agent-unlock');
      if (!agent) return;
      const snapshot = store.snapshot();
      const balance = Number(snapshot.me && snapshot.me.creditBalance != null ? snapshot.me.creditBalance : 0);
      const price = Number(agent.price || 0);
      const unlimited = balance < 0;
      this.setData({
        enough: unlimited || balance >= price,
        unlimited,
        priceText: `x${price}`,
        balanceText: unlimited ? '不限量' : `${balance} 点`,
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
      if (!this.data.enough) {
        wx.showToast({ title: '权益点不足，请先调整方案', icon: 'none' });
        return;
      }
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
          const code = error && (error.code || (error.data && error.data.code));
          wx.showToast({
            title: code === 'INSUFFICIENT_CREDITS' ? '权益点不足，请先调整方案' : (error.message || '启用失败，请重试'),
            icon: 'none',
          });
        }
      } finally {
        this.setData({ busy: false });
      }
    },
  },
});
