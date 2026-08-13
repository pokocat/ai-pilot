// 模板专区 —— 从首页拆出来的独立一页。
//
// 为什么单独一页：首页原先直接把唯一一套模板当主卡，等于「模板 = 首页」。
// 那样一来模板从 1 套变 2 套时首页就得重排，而且首页没法承担落地页/宣传的职责。
// 拆开后：首页只讲「这是什么、值不值得做」，选哪一套在本页决定，后续加模板只加数据。
const host = require('../host');
const api = require('../api');
const { formatDuration } = require('../model');
const { filterOffered } = require('../catalog');

Page({
  data: host.hostBaseData({
    loading: true,
    /** 'ok' | 'empty' | 'failed' —— 空态与读失败必须分开，别把没读到说成没有。 */
    state: 'ok',
    templates: [],
    showLogin: false,
  }),

  onLoad() { this.load(); },

  load() {
    this.setData({ loading: true });
    const builtIns = api.builtInTemplates();
    api.templates()
      .then((rows) => {
        // 服务端仍可能返回已下架的模板（AIStar seeder 里还种着），端上按白名单兜底。
        const offered = filterOffered(rows);
        const list = offered.length ? offered : builtIns;
        this.setData({
          loading: false,
          state: list.length ? 'ok' : 'empty',
          templates: list.map((item) => this.decorate(item)),
        });
      })
      .catch(() => {
        // 读失败时退到包内模板：至少能开工，但要让用户知道这是兜底而不是全部
        if (builtIns.length) {
          this.setData({ loading: false, state: 'ok', templates: builtIns.map((item) => this.decorate(item)) });
          return;
        }
        this.setData({ loading: false, state: 'failed', templates: [] });
      });
  },

  decorate(item) {
    return Object.assign({}, item, {
      durationText: formatDuration(item.estDurationSec),
      avatarText: `${item.avatarSecHint || 0} 秒`,
      creditText: `${item.creditHint || 0} 积分`,
    });
  },

  openTemplate(event) {
    const id = String(event.currentTarget.dataset.id || '');
    if (id) host.go(`template/index?templateId=${encodeURIComponent(id)}`);
  },

  retry() { this.load(); },
  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
});
