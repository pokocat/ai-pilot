import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const catalog = require('../weapp-native/packages/video/catalog.js');
const model = require('../weapp-native/packages/video/model.js');
const mock = require('../weapp-native/packages/video/mock.js');
const here = path.dirname(fileURLToPath(import.meta.url));
const videoRoot = path.resolve(here, '../weapp-native/packages/video');

// 2026-08-12：模板从三套收敛为《为实体发声》一套。原三套共用同一个虚构主体
// （巷口修鞋铺·张姐），对用户是三个壳子一个故事，反而稀释了首页的主行动。
// 在售清单由 catalog.OFFERED_TEMPLATE_IDS 决定，上架新模板改那里即可。
test('快出片在售模板只保留《为实体发声》，且脚本自洽', () => {
  const templates = catalog.listBuiltInTemplates();
  assert.deepEqual(templates.map((item) => item.id), ['ct_shiti']);
  assert.deepEqual(catalog.OFFERED_TEMPLATE_IDS, ['ct_shiti']);

  const scripts = templates.map((template) => {
    const seed = catalog.getBuiltInProjectSeed(template.id);
    assert.ok(seed);
    assert.equal(seed.segments.length, template.segmentCount);
    assert.deepEqual(seed.segments.map((item) => item.no), Array.from({ length: template.segmentCount }, (_, index) => index + 1));
    assert.ok(seed.segments.some((item) => item.role === model.ROLE.AVATAR));
    assert.ok(seed.segments.some((item) => item.role === model.ROLE.BROLL));
    assert.equal(seed.segments.at(-1).role, model.ROLE.TAIL);
    assert.equal(seed.segments.at(-1).durationSec, template.tailDurationSec);
    return seed.segments.map((item) => item.text).join('|');
  });
  assert.equal(new Set(scripts).size, templates.length);
});

test('快出片模板目录返回防御性副本', () => {
  const first = catalog.getBuiltInProjectSeed('ct_shiti');
  first.segments[0].text = '被调用方修改';
  first.variables.shopName = '被调用方修改';
  const second = catalog.getBuiltInProjectSeed('ct_shiti');
  assert.notEqual(second.segments[0].text, first.segments[0].text);
  assert.notEqual(second.variables.shopName, first.variables.shopName);
});

test('已下架模板不再对外可见，服务端仍返回时端上兜底过滤', () => {
  // AIStar 的 ClipOfficialTemplateSeeder 仍种着 ct_kaimen / ct_shouyi，
  // 服务端 /templates 还会返回它们；下架不依赖服务端改动，端上是最后一道闸。
  assert.equal(catalog.getBuiltInTemplate('ct_kaimen'), null);
  assert.deepEqual(
    catalog.filterOffered([{ id: 'ct_shiti' }, { id: 'ct_kaimen' }, { id: 'ct_shouyi' }]).map((item) => item.id),
    ['ct_shiti'],
  );
  assert.deepEqual(catalog.filterOffered(null), [], '非数组输入不得抛异常');
});

test('模板的时长/出镜/积分全部由 segments 推导，三个数字必须自洽', () => {
  // 曾经 estDurationSec 是算出来的（84 秒），avatarSecHint=38 / creditHint=68 却是
  // 设计稿 2:42 版本的硬编码残留，首页主卡出现「成片 1:24，其中出镜 38 秒」。
  for (const template of catalog.listBuiltInTemplates()) {
    const seed = catalog.getBuiltInProjectSeed(template.id);
    const summary = model.summarize(seed.segments);
    assert.equal(template.estDurationSec, summary.totalSec);
    assert.equal(template.avatarSecHint, summary.avatarSec);
    assert.equal(template.creditHint, model.estimateCredits(seed.segments).total);
    assert.ok(template.avatarSecHint <= template.estDurationSec, '出镜秒数不可能超过成片总时长');
  }
});

test('快出片纯 mock 会话自带可跑完整出片链路的演示额度', () => {
  assert.equal(mock.creditBalance(), 200);
  const mostExpensive = Math.max(...catalog.listBuiltInTemplates().map((item) => item.creditHint));
  assert.ok(mock.creditBalance() > mostExpensive);
});

test('快出片数字分身按石榴直传创建，authId 可选且较长时长只作建议', async () => {
  const requirements = await mock.avatarRequirements();
  assert.equal(requirements.authorizationVideoRequired, false);
  assert.equal(requirements.avatar.minDurationSec, 5);
  assert.equal(requirements.avatar.recommendedMinDurationSec, 10);
  assert.equal(requirements.voice.vendorMinDurationSec, 2);
  assert.equal(requirements.voice.minDurationSec, 3);
  assert.equal(requirements.voice.recommendedMinDurationSec, 8);
  assert.ok(requirements.voice.vendorFormats.includes('pcm'));
  assert.ok(!requirements.voice.formats.includes('pcm'));

  const source = fs.readFileSync(path.join(videoRoot, 'clone/index.js'), 'utf8');
  assert.match(source, /api\.avatarRequirements\(\)/);
  assert.doesNotMatch(source, /api\.startConsent/);
  assert.doesNotMatch(source, /CLIP_CONSENT_REQUIRED/);
  assert.match(source, /key: 'video'[\s\S]*key: 'training'/);
  assert.doesNotMatch(source, /key: 'voice'[\s\S]*key: 'avatar'/);
  assert.match(source, /requestedMode === 'voice' \|\| requestedMode === 'avatar'/);
  assert.match(source, /api\.startClone\('voice'/);
  // 形象提交的 kind 跟着素材来源走：视频 → 'avatar'，照片 → 'avatarImage'。
  assert.match(source, /api\.startClone\(image \? 'avatarImage' : 'avatar'/);

  const view = fs.readFileSync(path.join(videoRoot, 'clone/index.wxml'), 'utf8');
  const style = fs.readFileSync(path.join(videoRoot, 'clone/index.scss'), 'utf8');
  const appConfig = JSON.parse(fs.readFileSync(path.resolve(videoRoot, '../../app.json'), 'utf8'));
  assert.match(view, /object-fit="contain"/);
  assert.match(view, /一段视频即可创建/);
  assert.match(view, /不用念固定文案/);
  assert.match(view, /《数字分身素材使用说明》/);
  assert.doesNotMatch(view, /录制授权视频/);
  assert.match(style, /\.cl-video-card\s*\{[\s\S]*height: 238px;/);
  assert.match(source, /wx\.authorize\([\s\S]*scope: 'scope\.record'/);
  assert.match(source, /manager\.onStart\(/);
  // app.json.permission 的官方白名单目前只有 scope.userLocation；录音用途在管理后台
  // 《用户隐私保护指引》申报，运行时仍由上面的 wx.authorize 主动申请。
  assert.equal(appConfig.permission?.['scope.record'], undefined);
});

test('快出片所有页面只占一层原生导航高度', () => {
  const pages = fs.readdirSync(videoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(videoRoot, entry.name, 'index.wxml')))
    .map((entry) => path.join(videoRoot, entry.name, 'index.wxml'));
  // 14 = 原 11 页 + templates（模板专区，从首页拆出来）+ cover（成片封面，确认页的可选支线）
  //      + voices（我的声音列表页，声音可脱离形象单独存在）
  assert.equal(pages.length, 14);
  pages.forEach((file) => {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /--native-nav-inset:\{\{navInset\}\}px/);
    assert.match(source, /--native-nav-top:\{\{navTop\}\}px/);
    assert.match(source, /--native-nav-row-height:\{\{navRowHeight\}\}px/);
    assert.match(source, /--native-nav-right:\{\{navRightInset\}\}px/);
    assert.doesNotMatch(source, /class="vd-safe" style="height:/);
  });

  const tokens = fs.readFileSync(path.join(videoRoot, 'styles/tokens.scss'), 'utf8');
  assert.match(tokens, /\.vd-headrow\s*\{[\s\S]*position: absolute;/);
  assert.match(tokens, /top: var\(--native-nav-top/);
  assert.match(tokens, /height: var\(--native-nav-row-height/);
  assert.match(tokens, /\.vd-footer\s*\{[\s\S]*width: 100%;[\s\S]*box-sizing: border-box;[\s\S]*padding: 12px 20px;/);
  assert.doesNotMatch(tokens, /padding:[^;]*constant\(safe-area-inset-bottom\)/);
});

test('快出片移动视觉层级固定主任务、拇指区和高风险确认顺序', () => {
  const read = (page) => fs.readFileSync(path.join(videoRoot, page, 'index.wxml'), 'utf8');
  const tokens = fs.readFileSync(path.join(videoRoot, 'styles/tokens.scss'), 'utf8');
  const home = read('home');
  const templateJs = fs.readFileSync(path.join(videoRoot, 'template/index.js'), 'utf8');
  const script = read('script');
  const shots = read('shots');
  const confirm = read('confirm');
  const scriptJs = fs.readFileSync(path.join(videoRoot, 'script/index.js'), 'utf8');

  assert.match(tokens, /--vd-success:/);
  assert.match(tokens, /--vd-shadow:/);
  assert.match(tokens, /\.vd-back\s*\{[\s\S]*width: 44px; height: 44px;/);
  assert.match(tokens, /\.vd-btn\s*\{[\s\S]*height: 56px;/);
  // 2026-08-12 IA 重排：首页从「模板即首页」改为落地页，模板拆去 templates/ 专区。
  //
  // 原规则「分身门槛必须先于模板」写于模板还是首页主卡的时代。现在首页主 CTA 通向的是
  // 模板专区（浏览），真正的制作入口在模板详情的「开始制作」，硬闸就在那里
  // （templateJs 的 imageStatus !== 'ready'）。所以规则的**意图**——不让用户进入制作
  // 之后才发现不能出片——依然成立，只是闸挪到了它该在的位置；落地页保留门槛卡做前置告知。
  assert.match(home, /class="gate gate-\{\{avatarState\}\}"/, '落地页必须常驻分身门槛状态');
  assert.match(home, /class="primary-cta"/, '落地页只该有一个主行动');
  assert.ok(home.indexOf('class="banner"') < home.indexOf('class="primary-cta"'),
    '宣传横幅讲清价值之后才给主行动');
  assert.ok(home.indexOf('class="gate gate-') < home.indexOf('class="entries"'),
    '分身门槛必须排在次级入口之前');
  assert.doesNotMatch(home, /class="vd-headact" bindtap="openWorks"/, '作品入口不能继续藏在导航角落');
  assert.match(templateJs, /avatar\.imageStatus !== 'ready'/);
  assert.match(templateJs, /先创建数字分身，再开始出片/);
  const work = read('work');
  const workScss = fs.readFileSync(path.join(videoRoot, 'work/index.scss'), 'utf8');
  assert.match(work, /class="wd-player-wrap"/);
  assert.match(work, /object-fit="contain"/);
  assert.doesNotMatch(workScss, /\.wd-player\s*\{[^}]*height:\s*420px/);
  assert.match(script, /class="ai-fab"/);
  assert.match(script, /class="ai-sheet"/);
  assert.match(scriptJs, /setOverlay\(true, 'video-script-ai'\)/);
  assert.match(scriptJs, /setOverlay\(false, 'video-script-ai'\)/);
  assert.ok(shots.indexOf('class="vd-scroll"') < shots.indexOf('class="price-bar"'));
  assert.match(shots, /调整组合/);
  assert.match(shots, /与下一段合并/);
  assert.ok(confirm.indexOf('class="cf-ready"') < confirm.indexOf('class="cf-preview'));
});

test('我的作品默认展示全部，并为已完成作品显示真实预览入口', () => {
  const source = fs.readFileSync(path.join(videoRoot, 'works/index.js'), 'utf8');
  const view = fs.readFileSync(path.join(videoRoot, 'works/index.wxml'), 'utf8');
  const apiSource = fs.readFileSync(path.join(videoRoot, 'api.js'), 'utf8');
  const bffSource = fs.readFileSync(path.resolve(here, '../../server/src/routes/video.ts'), 'utf8');
  assert.match(source, /\{ key: 'all', label: '全部' \}/);
  assert.match(source, /active: 'all'/);
  assert.match(source, /item\.status === 'done' \|\| item\.status === 'published'/);
  assert.match(source, /model\.workTimeText\(item\)/);
  assert.match(source, /host\.confirm\(/);
  assert.match(source, /api\.deleteWork\(id\)/);
  assert.match(view, /wx:if="\{\{item\.thumbnailUrl\}\}"/);
  assert.match(view, /name="play"/);
  assert.match(view, /class="wk-meta">\{\{item\.createdText\}\}/);
  assert.match(view, /catchtap="removeWork"/);
  assert.match(apiSource, /deleteWork: \(id\)/);
  assert.match(bffSource, /app\.delete<\{ Params: \{ id: string \} \}>\('\/video\/works\/:id'/);
});

test('作品时间保留到分钟并区分开始生成和完成', () => {
  assert.match(model.workTimeText({ createdAt: '2026-08-11T18:21:00+08:00' }), /^开始生成 · /);
  assert.match(model.workTimeText({
    createdAt: '2026-08-11T18:21:00+08:00',
    generatedAt: '2026-08-11T18:24:00+08:00',
  }), /^生成时间 · /);
  assert.match(model.formatWorkTimestamp('2026-08-11T18:24:00+08:00'), /:\d{2}$/);
});

test('模板详情、工程初始镜头和固定片段共用同一时长真源', () => {
  const templateSource = fs.readFileSync(path.join(videoRoot, 'template/index.js'), 'utf8');
  const templateView = fs.readFileSync(path.join(videoRoot, 'template/index.wxml'), 'utf8');
  const shotsView = fs.readFileSync(path.join(videoRoot, 'shots/index.wxml'), 'utf8');
  assert.match(templateSource, /template\.scriptSkeleton/);
  assert.match(templateSource, /model\.summarize/);
  assert.match(templateView, /tailDurationSec/);
  assert.match(templateSource, /template\.tailPreviewUrl/);
  assert.match(templateView, /tailCoverUrl/);
  assert.match(templateView, /bindtap="openTailPreview"/);
  assert.match(templateView, /src="\{\{template\.tailMediaUrl\}\}"/);
  assert.match(templateSource, /setOverlay\(true, 'video-template-tail'\)/);
  assert.match(shotsView, /固定视频 · \{\{item\.seconds\}\} 秒/);
  assert.match(shotsView, /item\.framePreviewUrl/);
});

test('多数字人可复用声音，并在配画面时按项目选择且自动带入声音', () => {
  const apiSource = fs.readFileSync(path.join(videoRoot, 'api.js'), 'utf8');
  const cloneSource = fs.readFileSync(path.join(videoRoot, 'clone/index.js'), 'utf8');
  const shotsSource = fs.readFileSync(path.join(videoRoot, 'shots/index.js'), 'utf8');
  const shotsView = fs.readFileSync(path.join(videoRoot, 'shots/index.wxml'), 'utf8');
  assert.match(apiSource, /avatars\(\)/);
  assert.match(apiSource, /voices\(\)/);
  assert.match(cloneSource, /selectedVoiceId/);
  assert.match(cloneSource, /voiceId: this\.data\.selectedVoiceId/);
  assert.match(shotsSource, /voiceId: selectedAvatar\.linkedVoiceId/);
  assert.match(shotsSource, /api\.saveProject\(this\.data\.projectId, \{ avatarId:/);
  assert.match(shotsView, /选择本片数字人/);
  assert.match(shotsView, /关联声音会自动带入/);
  assert.match(shotsView, /imagePreviewUrl/);
});

test('AI 生成水印默认关闭，确认页主动开启后才保存并显示', async () => {
  const project = await mock.createProject('ct_shiti');
  assert.equal(project.subtitleStyle.aiWatermark, false);

  const confirmSource = fs.readFileSync(path.join(videoRoot, 'confirm/index.js'), 'utf8');
  const confirmView = fs.readFileSync(path.join(videoRoot, 'confirm/index.wxml'), 'utf8');
  const workSource = fs.readFileSync(path.join(videoRoot, 'work/index.js'), 'utf8');
  const workView = fs.readFileSync(path.join(videoRoot, 'work/index.wxml'), 'utf8');
  const templateView = fs.readFileSync(path.join(videoRoot, 'template/index.wxml'), 'utf8');

  assert.match(confirmSource, /aiWatermark: false/);
  assert.match(confirmSource, /api\.saveProject\(this\.data\.projectId, \{ subtitleStyle \}\)/);
  assert.match(confirmView, /wx:if="\{\{aiWatermark\}\}" class="vd-ai-badge cf-badge"/);
  assert.match(confirmView, /默认关闭；需要时可加到成片右上角/);
  assert.match(workView, /wx:if="\{\{work\.aiWatermark\}\}"/);
  assert.match(workSource, /this\.data\.work\.aiWatermark/);
  assert.doesNotMatch(templateView, />AI 生成<\/view>/, '模板能力标签不能冒充默认成片水印');
});

// 2026-08-13 成片封面：封面 = 拼在成片最前面的一张 720x1280 图，只占 1~2 帧，不影响视频内容。
// 抖音等平台发布后拿第一帧当缩略图，所以它值得单独设计。整条链路的铁律是「不填就不加封面」。
test('封面文案按码点截断，且与服务端 ClipCoverTemplate 的槽位上限一致', () => {
  assert.deepEqual(model.COVER_LIMITS, { keyword: 2, handle: 20, slogan: 14, sloganLines: 2, signature: 12 });

  assert.equal(model.truncateCoverText('团结', 2), '团结');
  assert.equal(model.truncateCoverText('团结一心', 2), '团…');
  assert.equal(model.truncateCoverText('  留白  ', 2), '留白');
  assert.equal(model.truncateCoverText(null, 2), '');
  // emoji 是双 char：按 char 截会劈出半个代理对，渲染成乱码
  assert.equal(model.truncateCoverText('🧧🧧🧧', 2), '🧧…');
  assert.equal(Array.from(model.truncateCoverText('🧧🧧🧧', 2))[0], '🧧');
});

test('封面配置规整：形状稳定、标语最多两行、关掉不丢文案', () => {
  const full = model.normalizeCover({
    enabled: true,
    keyword: '团结一心',
    handle: '@可乐米乐麻麻讲Ai',
    sloganLines: ['一群人一条心', '一件事一起拼', '第三行会被丢掉'],
    signature: '集体为实体发声',
  });
  assert.equal(full.enabled, true);
  assert.equal(full.templateId, model.COVER_TEMPLATE_ID);
  assert.equal(full.keyword, '团…');
  assert.deepEqual(full.sloganLines, ['一群人一条心', '一件事一起拼']);
  assert.equal(full.backgroundAssetId, null);
  assert.equal(full.backgroundSourceNo, 0);

  // 用户在一个输入框里敲换行也要拆成两行
  assert.deepEqual(model.normalizeCover({ sloganLines: '上一句\n下一句' }).sloganLines, ['上一句', '下一句']);

  // 缺字段/垃圾入参不许抛，也不许返回 undefined 字段
  const blank = model.normalizeCover(null);
  assert.equal(blank.enabled, false);
  assert.equal(blank.keyword, '');
  assert.deepEqual(blank.sloganLines, []);

  // 关掉开关只是不渲染，文案要留着，不然「手滑关一下」等于清空重填
  const off = model.normalizeCover({ enabled: false, keyword: '团结', signature: '集体为实体发声' });
  assert.equal(off.enabled, false);
  assert.equal(off.keyword, '团结');
  assert.equal(off.signature, '集体为实体发声');
});

test('封面四种状态在确认页各说各的话，「开了但没填」「填了但没开」都不能伪装成已设置', () => {
  assert.equal(model.coverHasText({ enabled: true }), false);
  assert.equal(model.coverHasText({ enabled: true, sloganLines: ['', '  '] }), false, '全空白 = 没填');
  assert.equal(model.coverHasText({ enabled: true, keyword: '团结' }), true);

  assert.deepEqual(model.coverSummary({ enabled: false }), { state: 'off', text: '不加封面' });

  // 填了字却没打开开关：最容易白忙一场的状态。只说「不加封面」会让用户以为内容也丢了、
  // 于是回去重填一遍；必须同时说清「你填的还在」和「它现在不生效」。
  const drafted = model.coverSummary({ enabled: false, keyword: '团结' });
  assert.equal(drafted.state, 'drafted');
  assert.match(drafted.text, /开关/, '要指出问题出在开关上');
  assert.match(drafted.text, /不会加封面/, '要说清出片时不会有封面');
  assert.notEqual(drafted.state, 'on', '没开启就不能显示成已设置');

  const blank = model.coverSummary({ enabled: true });
  assert.equal(blank.state, 'blank');
  assert.match(blank.text, /不会加封面/, '开了却一个字没填，必须说清出片时不会有封面');

  const on = model.coverSummary({ enabled: true, keyword: '团结', signature: '集体为实体发声' });
  assert.equal(on.state, 'on');
  assert.match(on.text, /团结/);
});

test('封面页已注册、从确认页可达，且不填就不加封面', async () => {
  const project = await mock.createProject('ct_shiti');
  assert.equal(project.cover.enabled, false, '建项目时封面默认关着');
  assert.equal(model.coverSummary(project.cover).state, 'off');

  const appConfig = JSON.parse(fs.readFileSync(path.resolve(videoRoot, '../../app.json'), 'utf8'));
  const videoPackage = appConfig.subPackages.find((item) => item.root === 'packages/video');
  assert.ok(videoPackage.pages.includes('cover/index'), '封面页必须注册进 packages/video 分包');

  const confirmSource = fs.readFileSync(path.join(videoRoot, 'confirm/index.js'), 'utf8');
  const confirmView = fs.readFileSync(path.join(videoRoot, 'confirm/index.wxml'), 'utf8');
  const coverSource = fs.readFileSync(path.join(videoRoot, 'cover/index.js'), 'utf8');
  const coverView = fs.readFileSync(path.join(videoRoot, 'cover/index.wxml'), 'utf8');

  // 入口在出片确认页，且是可选支线：不挡出片按钮
  assert.match(confirmSource, /host\.go\(`\/cover\/index\?projectId=/);
  assert.match(confirmSource, /model\.coverSummary\(project\.cover\)/);
  assert.match(confirmView, /class="cf-cover vd-card[^"]*" bindtap="goCover"/);
  assert.doesNotMatch(confirmSource, /coverSummary[\s\S]{0,80}problems\.push/, '封面没设置不能变成出片的前置阻断');
  // 「填了字但开关没打开」必须被单独说破：只说「不加封面」的话，用户以为设好了，出片才发现没有。
  assert.match(confirmView, /coverSummary\.state === 'drafted'/, '确认页要能区分「没设置」和「设了没开启」');

  // 保存走整份 cover 对象；四个槽位齐全
  assert.match(coverSource, /api\.saveProject\(this\.data\.projectId, \{ cover \}\)/);
  ['keyword', 'handle', 'slogan1', 'slogan2', 'signature'].forEach((field) => {
    assert.match(coverView, new RegExp(`data-field="${field}"`), `缺少输入槽位 ${field}`);
  });
  // 预览四层齐全，层级与参考图一致
  ['cv-kw', 'cv-handle', 'cv-slogan-line', 'cv-sign'].forEach((cls) => {
    assert.match(coverView, new RegExp(`class="[^"]*${cls}`), `预览缺少 ${cls}`);
  });
  // 读失败必须报错重试，不能静默当成空封面把已有配置盖掉
  assert.match(coverSource, /loadError/);
  assert.match(coverView, /bindtap="load"/);
  // 登录门只挡保存动作，游客可以先填着看
  assert.match(coverSource, /host\.requireLogin\(this, 'execute'\)/);
  assert.ok(coverSource.indexOf('host.requireLogin') > coverSource.indexOf('save()'), '登录门不得前置到 onLoad');

  const coverStyle = fs.readFileSync(path.join(videoRoot, 'cover/index.scss'), 'utf8');
  assert.match(coverStyle, /^@use "\.\.\/styles\/tokens\.scss";/, '分包样式只许用分包自己的 tokens');
  assert.match(coverStyle, /#FFE400/, '关键词亮黄');
  assert.match(coverStyle, /#F6C544/, '落款金色');
});

test('免费重训余额：查不到不许编数字，用完了必须挡住而不是悄悄新建', () => {
  const { retrainQuotaState } = model;
  const ok = retrainQuotaState({ available: true, retrainable: true, used: 1, total: 4, remaining: 3 });
  assert.match(ok.text, /还剩 3 次/);
  assert.equal(ok.blocked, false);

  // 用尽 = 这条路走不通。上游已去掉「回落成新建」，端上必须提前挡住，
  // 不能让用户录完 15 秒再撞一堵墙，更不能替他改成贵三倍多的新建。
  const used = retrainQuotaState({ available: true, retrainable: true, used: 4, total: 4, remaining: 0 });
  assert.match(used.text, /用完/);
  assert.equal(used.blocked, true);
  assert.doesNotMatch(used.text, /会重新训练一条|自动/, '不许暗示系统会替他新建');

  // 读失败必须说「查不到」，且**不挡提交**——读失败不是没额度。
  const unknown = retrainQuotaState({ available: false, retrainable: true });
  assert.match(unknown.text, /查不到/);
  assert.equal(unknown.blocked, false);
  assert.doesNotMatch(unknown.text, /[0-9]+ 次/, '不许退化成一个编出来的次数');

  const dead = retrainQuotaState({ available: false, retrainable: false });
  assert.equal(dead.blocked, true);
  assert.equal(retrainQuotaState(null).text, '', '没有数据时整行不渲染');
  // total/remaining 缺字段时按「查不到」处理，不许算出 NaN 次
  assert.match(retrainQuotaState({ available: true, retrainable: true }).text, /查不到/);
});

test('照片建分身：不给「视频原声」这种点了必失败的选项，且只收形象一档', () => {
  const { voiceChoices, cloneChargeItems } = model;
  const pricing = { voiceCreate: 200, voiceRetrain: 60, avatarVideo: 200, avatarImage: 100, configured: true };
  const voices = [{ id: 'VC-1', name: '我的声音', status: 'ready', source: 'dedicated' }];

  // 视频模式仍然有「视频原声」（空 id 那一项）
  const video = voiceChoices(voices, pricing, false);
  assert.ok(video.options.some((o) => o.id === ''), '视频模式保留「视频原声」');

  // 照片模式没有：一张照片里根本没有声音，给了就是给一个点了会失败的选项
  const image = voiceChoices(voices, pricing, true);
  assert.equal(image.options.some((o) => o.id === ''), false, '照片模式不得出现「视频原声」');
  assert.equal(image.options.length, 1, '照片模式只剩可复用的已有声音');

  // 一条可复用的都没有时，默认值必须是空（= 还没选），不能像视频模式那样落到「视频原声」
  const none = voiceChoices([], pricing, true);
  assert.equal(none.defaultVoiceId, '');
  assert.equal(none.hasReusable, false);

  // 计价：照片只收形象这一档。声音是复用的，它的钱在训练那条声音时已经收过。
  const items = cloneChargeItems('image', pricing, 'VC-1', '');
  assert.deepEqual(items.map((i) => i.action), ['avatarImage']);
  assert.equal(items[0].credits, 100);
});
