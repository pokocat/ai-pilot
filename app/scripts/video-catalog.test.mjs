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

test('快出片内置三套可独立制作的模板', () => {
  const templates = catalog.listBuiltInTemplates();
  assert.equal(templates.length, 3);
  assert.deepEqual(templates.map((item) => item.id), ['ct_shiti', 'ct_kaimen', 'ct_shouyi']);

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
  const first = catalog.getBuiltInProjectSeed('ct_kaimen');
  first.segments[0].text = '被调用方修改';
  first.variables.shopName = '被调用方修改';
  const second = catalog.getBuiltInProjectSeed('ct_kaimen');
  assert.notEqual(second.segments[0].text, first.segments[0].text);
  assert.notEqual(second.variables.shopName, first.variables.shopName);
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
  assert.match(source, /api\.startClone\('avatar'/);

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
  assert.equal(appConfig.permission['scope.record'].desc.includes('数字分身声音'), true);
});

test('快出片所有页面只占一层原生导航高度', () => {
  const pages = fs.readdirSync(videoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(videoRoot, entry.name, 'index.wxml')))
    .map((entry) => path.join(videoRoot, entry.name, 'index.wxml'));
  assert.equal(pages.length, 11);
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
  assert.ok(home.indexOf('<!-- 数字分身是开拍前置条件') < home.indexOf('<!-- 模板精选：横向浏览'),
    '数字分身门槛必须先于模板，避免用户进入制作后才发现不能出片');
  assert.match(home, /class="home-tools"/);
  assert.match(home, /class="tpl-scroll" scroll-x/);
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
  assert.match(source, /\{ key: 'all', label: '全部' \}/);
  assert.match(source, /active: 'all'/);
  assert.match(source, /item\.status === 'done' \|\| item\.status === 'published'/);
  assert.match(view, /wx:if="\{\{item\.thumbnailUrl\}\}"/);
  assert.match(view, /name="play"/);
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
