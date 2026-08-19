// 屏 07b · 成片封面（出片确认页的可选支线）。
//
// 封面 = 拼在成片最前面的一张 720x1280 图，只占 1~2 帧，**不影响视频内容**。
// 抖音等平台发布后拿第一帧当缩略图，所以这一张值得单独设计。
//
// 这一屏只负责「填四个文本槽位 + 看版式对不对」，真正的字体/描边/渐变由服务端 Java2D 烧录。
// 端上预览是 CSS 模拟：版式（层级、位置、配色）对得上即可，不追求像素级还原
// —— 小程序侧没有毛笔书法字体（军师只全局装了思源宋体），强行还原反而会给出错误预期，
// 所以预览用宋体近似，并在页面上明说成片是书法体。
const host = require('../host');
const api = require('../api');
const model = require('../model');
const { withShare } = require('../../../services/share');

const PLACEHOLDER = {
  keyword: '关键',
  handle: '@你的账号名',
  slogan1: '一群人一条心',
  slogan2: '一件事一起拼',
  signature: '集体为实体发声',
};

Page(withShare({
  data: host.hostBaseData({
    projectId: '',
    loading: true,
    loadError: '',
    saving: false,
    enabled: false,
    keyword: '',
    handle: '',
    slogan1: '',
    slogan2: '',
    signature: '',
    backgroundAssetId: '',
    images: [],
    imagesFailed: false,
    preview: null,
    limits: model.COVER_LIMITS,
    showLogin: false,
  }),

  onLoad(options) {
    const projectId = String((options && options.projectId) || '');
    if (!projectId) { host.toast('缺少项目参数'); host.back(); return; }
    this.setData({ projectId });
    this.load();
  },

  load() {
    this.setData({ loading: true, loadError: '' });
    api.project(this.data.projectId).then((project) => {
      const cover = model.normalizeCover(project && project.cover);
      this.setData({
        loading: false,
        loadError: '',
        enabled: cover.enabled,
        keyword: cover.keyword,
        handle: cover.handle,
        slogan1: cover.sloganLines[0] || '',
        slogan2: cover.sloganLines[1] || '',
        signature: cover.signature,
        backgroundAssetId: cover.backgroundAssetId || '',
      });
      this.refreshPreview();
      this.loadImages();
    }).catch((error) => {
      // 读失败 ≠ 用户没填过。必须报错并给重试，不能静默当成空封面盖掉已有配置
      this.setData({
        loading: false,
        loadError: (error && error.message) ? error.message : '封面配置没读出来，请重试',
      });
    });
  },

  /** 底图候选：素材库里的图片。读不到不算错，自动取帧本来就是默认项。 */
  loadImages() {
    api.assets().then((assets) => {
      const images = (Array.isArray(assets) ? assets : []).filter((item) => item && item.kind === 'image');
      this.setData({ images, imagesFailed: false });
    }).catch(() => {
      this.setData({ images: [], imagesFailed: true });
    });
  },

  /** 预览用的展示值：空槽位显示灰色占位，不让用户以为真会印出这几个字。 */
  refreshPreview() {
    const d = this.data;
    this.setData({
      preview: {
        keyword: d.keyword || PLACEHOLDER.keyword,
        keywordGhost: !d.keyword,
        handle: d.handle || PLACEHOLDER.handle,
        handleGhost: !d.handle,
        slogan1: d.slogan1 || PLACEHOLDER.slogan1,
        slogan1Ghost: !d.slogan1,
        slogan2: d.slogan2 || PLACEHOLDER.slogan2,
        slogan2Ghost: !d.slogan2,
        signature: d.signature || PLACEHOLDER.signature,
        signatureGhost: !d.signature,
        empty: !model.coverHasText(this.currentCover()),
      },
    });
  },

  currentCover() {
    const d = this.data;
    return model.normalizeCover({
      enabled: d.enabled,
      templateId: model.COVER_TEMPLATE_ID,
      keyword: d.keyword,
      handle: d.handle,
      sloganLines: [d.slogan1, d.slogan2],
      signature: d.signature,
      backgroundAssetId: d.backgroundAssetId || null,
    });
  },

  inputField(event) {
    const field = event.currentTarget.dataset.field;
    if (!field) return;
    // 端上按码点截断，与服务端同规则，避免「输入框看着没超、存完被截一刀」
    const limit = field === 'slogan1' || field === 'slogan2' ? model.COVER_LIMITS.slogan : model.COVER_LIMITS[field];
    const value = model.truncateCoverText(event.detail.value, limit);
    this.setData({ [field]: value });
    this.refreshPreview();
  },

  toggleEnabled(event) {
    this.setData({ enabled: !!(event && event.detail && event.detail.value) });
    this.refreshPreview();
  },

  chooseBackground(event) {
    const id = String(event.currentTarget.dataset.id || '');
    this.setData({ backgroundAssetId: this.data.backgroundAssetId === id ? '' : id });
  },

  useAutoFrame() { this.setData({ backgroundAssetId: '' }); },

  goAssets() { host.go(`/assets/index?projectId=${encodeURIComponent(this.data.projectId)}`); },

  save() {
    if (!host.requireLogin(this, 'execute')) return;
    if (this.data.loading || this.data.saving) return;
    const cover = this.currentCover();
    if (cover.enabled && !model.coverHasText(cover)) {
      host.toast('至少填一个槽位，或关掉封面');
      return;
    }
    this.setData({ saving: true });
    api.saveProject(this.data.projectId, { cover })
      .then(() => { host.toast(cover.enabled ? '封面已保存' : '已设为不加封面'); host.back(); })
      .catch((error) => {
        this.setData({ saving: false });
        host.toast(error && error.message ? error.message : '封面保存失败');
      });
  },

  back() { host.back(); },
  closeLogin() { this.setData({ showLogin: false }); },
  loggedIn() { this.setData({ showLogin: false }); this.load(); },
}));
