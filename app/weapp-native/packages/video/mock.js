// 「快出片」分包自带 mock —— 故意不写进军师主包的 services/mock.js。
//
// 理由：本分包要能整体抽走（抽插件 / 独立小程序），mock 数据跟着分包走才不留残骸；
// 而且主包 mock.js 已经很大，掺进视频域会让两条业务线互相污染。
//
// 内容取自设计稿的样例（张姐 · 巷口修鞋铺 ·《为实体发声》），保证 mock 态下
// 各屏的信息密度和真实场景一致，不会出现「假数据太干净所以布局没问题」的错觉。
const { ROLE } = require('./model');
const catalog = require('./catalog');

const delay = (value, ms) => new Promise((resolve) => setTimeout(() => resolve(value), ms || 220));
const clone = (value) => JSON.parse(JSON.stringify(value));
const DEMO_CREDIT_BALANCE = 200;

/* ── 模板 ──────────────────────────────────────────────────────────── */

/* ── 项目骨架 ──────────────────────────────────────────────────────── */

function buildProject(templateId, id) {
  const seed = catalog.getBuiltInProjectSeed(templateId) || catalog.getBuiltInProjectSeed('ct_shiti');
  const template = seed.template;
  return {
    id: id || `cp_mock_${Date.now()}`,
    templateId: template.id,
    templateName: template.name,
    title: `${template.name} · 张姐`,
    status: 'draft',
    variables: seed.variables,
    segments: seed.segments.map((line) => Object.assign({
      assetId: null, assetLabel: null, actualDurationSec: 0,
    }, line)),
    shots: [],
    scriptChat: [],
    avatarId: 'av_mock',
    voiceId: 'vo_mock',
    updatedAt: Date.now(),
  };
}

/* 已有项目（首页「继续上次」用）：第 2 步做到一半，14 句里配好 6 句。 */
const ONGOING = (() => {
  const project = buildProject('ct_shiti', 'cp_mock_ongoing');
  const labels = ['门口清早', '手上活儿', '老招牌', '店里中景'];
  let filled = 0;
  project.shots = require('./model').defaultShots(project.segments).map((shot) => {
    if (shot.role !== ROLE.BROLL || filled >= labels.length) return shot;
    const next = Object.assign({}, shot, { assetId: `ca_mock_${filled}`, assetLabel: labels[filled] });
    filled += 1;
    return next;
  });
  project.step = 2;
  return project;
})();

/* ── 素材库 ────────────────────────────────────────────────────────── */

const ASSETS = [
  { id: 'ca_mock_0', label: '门头', tag: '门头招牌', usedCount: 3, kind: 'video', durationSec: 9, tone: 'warm' },
  { id: 'ca_mock_1', label: '手上活儿', tag: '手上活儿', usedCount: 5, kind: 'video', durationSec: 12, tone: 'craft' },
  { id: 'ca_mock_2', label: '顾客', tag: '顾客', usedCount: 1, kind: 'video', durationSec: 7, tone: 'morning' },
  { id: 'ca_mock_3', label: '门头', tag: '门头招牌', usedCount: 0, kind: 'image', durationSec: 0, tone: 'warm' },
  { id: 'ca_mock_4', label: '街景', tag: '街景', usedCount: 2, kind: 'video', durationSec: 15, tone: 'street' },
];

/* ── 作品 ──────────────────────────────────────────────────────────── */

const WORKS = [
  {
    id: 'cw_mock_1', title: '为实体发声 · 张姐', status: 'generating',
    progress: 65, stage: 'avatar', etaText: '还要 3 分钟', durationSec: 162, avatarSec: 38,
  },
  {
    id: 'cw_mock_2', title: '今天开门了 · 周三', status: 'done',
    durationSec: 80, avatarSec: 12, createdText: '8 月 6 日出片', credits: 32,
  },
  {
    id: 'cw_mock_3', title: '为实体发声 · 首条', status: 'published',
    durationSec: 162, avatarSec: 38, createdText: '7 月 29 日出片', credits: 68,
    publishStats: [
      { platform: '抖音', text: '1.2 万播放 · 86 赞' },
      { platform: '视频号', text: '3400 播放 · 12 转发' },
    ],
  },
];

/* ── 分身 ──────────────────────────────────────────────────────────── */

const AVATAR = {
  imageStatus: 'ready', voiceStatus: 'ready',
  imageTrainedText: '7 月 28 日', voiceTrainedText: '7 月 28 日',
  imageProgress: 100, voiceProgress: 100, imageMessage: null, voiceMessage: null,
  engine: 'shiliu', presetAvailable: true,
};
const CAPTURE_REQUIREMENTS = {
  consentText: '我是本次出镜者本人，特此声明，我授权军师参谋部使用我提交的视频和声音资料，为我的账号创建数字分身，并仅在我的账号中使用它。',
  agreementTitle: '数字分身本人授权书', officialDocsLastReviewed: '2026-08-11', officialDocs: [], pollIntervalMs: 3000,
  consent: { kind: 'consent', vendorMinDurationSec: 5, vendorMaxDurationSec: 300, minDurationSec: 5, recommendedMinDurationSec: 8, recommendedMaxDurationSec: 20, maxDurationSec: 30, vendorMaxBytes: 200 * 1024 * 1024, maxBytes: 100 * 1024 * 1024, vendorFormats: ['mp4', 'mov'], formats: ['mp4', 'mov'], codec: 'H.264', guidance: [] },
  avatar: { kind: 'avatar', vendorMinDurationSec: 5, vendorMaxDurationSec: 300, minDurationSec: 15, recommendedMinDurationSec: 20, recommendedMaxDurationSec: 60, maxDurationSec: 300, vendorMaxBytes: 200 * 1024 * 1024, maxBytes: 100 * 1024 * 1024, vendorFormats: ['mp4', 'mov'], formats: ['mp4', 'mov'], codec: 'H.264', guidance: [] },
  voice: { kind: 'voice', vendorMinDurationSec: 2, vendorMaxDurationSec: 0, minDurationSec: 20, recommendedMinDurationSec: 30, recommendedMaxDurationSec: 60, maxDurationSec: 120, vendorMaxBytes: 20 * 1024 * 1024, maxBytes: 20 * 1024 * 1024, vendorFormats: ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'pcm'], formats: ['wav', 'mp3', 'ogg', 'm4a', 'aac'], sampleRateHz: 44100, channels: 1, guidance: [] },
};

const projects = new Map([[ONGOING.id, clone(ONGOING)]]);
let assets = clone(ASSETS);
let works = clone(WORKS);
let avatar = clone(AVATAR);
const consentHistory = [{ id: 'cc_mock_1', status: 'verified', createdText: '8 月 10 日', scope: '本人形象与声音出片' }];
const usageHistory = [{ id: 'cu_mock_1', createdText: '8 月 6 日', action: '生成《今天开门了 · 周三》', status: '完成' }];

function getProject(id) {
  if (!projects.has(id)) projects.set(id, buildProject('ct_shiti', id));
  const project = projects.get(id);
  if (!project.shots || !project.shots.length) project.shots = require('./model').defaultShots(project.segments);
  if (!Array.isArray(project.scriptChat)) project.scriptChat = [];
  return project;
}

function resetSegments(project) {
  const fresh = buildProject(project.templateId, project.id);
  return fresh.segments;
}

/* ── 导出的 mock API（形状必须与 api.js 的真实分支一一对应）───────────── */

module.exports = {
  creditBalance: () => DEMO_CREDIT_BALANCE,
  templates: () => delay(catalog.listBuiltInTemplates()),
  template: (id) => {
    const template = catalog.getBuiltInTemplate(id);
    return template
      ? delay(template)
      : Promise.reject(Object.assign(new Error('模板不存在'), { code: 'CLIP_TEMPLATE_NOT_FOUND' }));
  },

  createProject: (templateId) => {
    const project = buildProject(templateId);
    projects.set(project.id, project);
    return delay(clone(project));
  },
  project: (id) => delay(clone(getProject(id))),
  saveProject: (id, payload) => {
    const current = getProject(id);
    const next = Object.assign({}, current, clone(payload || {}), { id, updatedAt: Date.now() });
    projects.set(id, next);
    return delay(clone(next));
  },
  ongoingProject: () => {
    const current = Array.from(projects.values())
      .filter((item) => item.status === 'draft')
      .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))[0] || null;
    return delay(current ? clone(current) : null);
  },

  aiRewrite: (id, scope, no, text) => {
    if (scope === 'segment') {
      return delay({ scope, no, text: `${String(text || '').replace(/[。.]$/, '')}，这话我说了十二年。` }, 900);
    }
    const project = getProject(id);
    const segments = project.segments.map((segment) => (segment.role === ROLE.TAIL
      ? Object.assign({}, segment)
      : Object.assign({}, segment, {
        text: `${String(segment.text || '').replace(/[。.]$/, '')}。这是我守店这些年最想说的一句话。`,
        actualDurationSec: 0,
      })));
    const shots = require('./model').defaultShots(segments);
    projects.set(id, Object.assign({}, project, { segments, shots, updatedAt: Date.now() }));
    return delay({ scope, segments: clone(segments) }, 900);
  },
  scriptChat: (id, message) => {
    const project = getProject(id);
    const now = new Date().toISOString();
    const user = { id: `csm_u_${Date.now()}`, role: 'user', content: String(message || ''), at: now };
    const current = project.segments.filter((segment) => segment.role !== ROLE.TAIL);
    const compacted = [];
    current.forEach((segment) => {
      const previous = compacted[compacted.length - 1];
      if (previous && previous.role === segment.role && `${previous.text}${segment.text}`.length <= 70) previous.text += segment.text;
      else compacted.push(Object.assign({}, segment));
    });
    const tail = project.segments.filter((segment) => segment.role === ROLE.TAIL);
    const segments = compacted.concat(tail).map((segment, index) => Object.assign({}, segment, { no: index + 1, actualDurationSec: 0 }));
    const reply = '我先把碎句收成了更完整的表达段落。你还可以继续说“更口语”“突出手艺”或“结尾更有行动感”。';
    const assistant = { id: `csm_a_${Date.now()}`, role: 'assistant', content: reply, at: now, applied: true };
    const next = Object.assign({}, project, {
      segments,
      shots: require('./model').defaultShots(segments),
      scriptChat: (project.scriptChat || []).concat([user, assistant]).slice(-40),
      updatedAt: Date.now(),
    });
    projects.set(id, next);
    return delay({ reply, applied: true, project: clone(next) }, 850);
  },
  resetScript: (id) => {
    const project = getProject(id);
    const segments = resetSegments(project);
    const shots = require('./model').defaultShots(segments);
    projects.set(id, Object.assign({}, project, { segments, shots, updatedAt: Date.now() }));
    return delay({ segments: clone(segments), shots: clone(shots) });
  },
  previewVoice: (_id, no, text) => delay({
    no, audioUrl: '', actualDurationSec: Math.max(2, Math.round(String(text || '').length / 4)),
  }, 700),

  estimate: (segments, shots) => delay(require('./model').estimateCredits(segments, shots)),
  render: (id) => delay({ jobId: `cj_mock_${Date.now()}`, projectId: id, status: 'queued' }, 500),

  job: (() => {
    // mock 出片：每次轮询往前走一点，走完四个阶段
    const started = {};
    return (jobId) => {
      if (!started[jobId]) started[jobId] = Date.now();
      const elapsed = (Date.now() - started[jobId]) / 1000;
      const stages = ['tts', 'avatar', 'broll', 'assemble'];
      const index = Math.min(stages.length - 1, Math.floor(elapsed / 4));
      const done = elapsed >= 16;
      return delay({
        id: jobId,
        status: done ? 'succeeded' : (index === 0 ? 'generating' : 'assembling'),
        stage: stages[index],
        progress: done ? 100 : Math.min(99, Math.round((elapsed % 4) / 4 * 100)),
        workId: done ? 'cw_mock_2' : null,
      });
    };
  })(),

  assets: () => delay(clone(assets)),
  uploadAsset: (filePath, meta) => {
    const kind = meta && meta.kind === 'image' ? 'image' : 'video';
    const asset = {
      id: `ca_mock_${Date.now()}`,
      label: kind === 'image' ? '新照片' : '新视频',
      tag: '待整理',
      usedCount: 0,
      kind,
      durationSec: 0,
      tone: 'morning',
      localPreviewPath: filePath,
    };
    assets.unshift(asset);
    return delay(clone(asset));
  },
  updateAsset: (id, patch) => {
    const index = assets.findIndex((item) => item.id === id);
    if (index < 0) return Promise.reject(Object.assign(new Error('素材不存在'), { code: 'CLIP_ASSET_NOT_FOUND' }));
    assets[index] = Object.assign({}, assets[index], clone(patch || {}));
    return delay(clone(assets[index]));
  },
  deleteAsset: (id) => {
    assets = assets.filter((item) => item.id !== id);
    return delay({ ok: true });
  },

  works: () => delay(clone(works)),
  work: (id) => delay(clone(works.find((item) => item.id === id) || works[1])),
  publish: (id, platform) => {
    const index = works.findIndex((item) => item.id === id);
    if (index < 0) return Promise.reject(Object.assign(new Error('作品不存在'), { code: 'CLIP_WORK_NOT_FOUND' }));
    const labels = { douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书', shipinhao: '视频号' };
    works[index] = Object.assign({}, works[index], {
      status: 'published',
      publishStats: (works[index].publishStats || []).concat([{ platform: labels[platform] || platform, text: '已提交平台审核' }]),
    });
    usageHistory.unshift({ id: `cu_mock_${Date.now()}`, createdText: '刚刚', action: `发布到${labels[platform] || platform}`, status: '已提交' });
    return delay({ ok: true, status: 'submitted', platform });
  },

  avatar: () => delay(avatar ? clone(avatar) : null),
  avatarRequirements: () => delay(clone(CAPTURE_REQUIREMENTS)),
  startConsent: () => {
    const record = { id: `cc_mock_${Date.now()}`, status: 'submitted', accepted: true, verified: false, createdText: '刚刚', scope: '本人形象与声音出片' };
    consentHistory.unshift(record);
    return delay(clone(record), 600);
  },
  startClone: (kind, payload) => {
    if (!payload || !payload.filePath) return Promise.reject(Object.assign(new Error('缺少采集文件'), { code: 'CLIP_CLONE_FILE_REQUIRED' }));
    avatar = Object.assign({}, avatar || {}, kind === 'voice'
      ? { voiceStatus: 'training', voiceProgress: 12, voiceMessage: null, voiceTrainedText: '' }
      : { imageStatus: 'training', imageProgress: 8, imageMessage: null, imageTrainedText: '' }, { engine: 'shiliu', presetAvailable: true });
    setTimeout(() => {
      if (!avatar) return;
      avatar = Object.assign({}, avatar, kind === 'voice'
        ? { voiceStatus: 'ready', voiceProgress: 100, voiceTrainedText: '刚刚' }
        : { imageStatus: 'ready', imageProgress: 100, imageTrainedText: '刚刚' });
    }, 2500);
    return delay({ ok: true, kind, status: 'training' }, 500);
  },
  consentLogs: () => delay(clone(consentHistory)),
  usageLogs: () => delay(clone(usageHistory)),
  deleteAvatar: () => {
    avatar = null;
    usageHistory.unshift({ id: `cu_mock_${Date.now()}`, createdText: '刚刚', action: '删除数字分身', status: '完成' });
    return delay({ ok: true });
  },
};
