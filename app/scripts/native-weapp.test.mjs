import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(appRoot, 'weapp-native');
const cjsRequire = createRequire(import.meta.url);

function walk(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(root, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

test('分享图长标题完整换行，资料上传超限与旧 PPT 都给明确失败原因', () => {
  const canvasText = cjsRequire(path.join(sourceRoot, 'utils/canvas-text.js'));
  const uploadGuard = cjsRequire(path.join(sourceRoot, 'utils/document-upload.js'));
  const ctx = {
    fontSize: 36,
    setFontSize(value) { this.fontSize = value; },
    measureText(value) { return { width: Array.from(value).length * this.fontSize }; },
  };
  const title = '主要矛盾定锤 · 攻守决断与三阶段落子方案';
  const layout = canvasText.fitCanvasText(ctx, title, { maxWidth: 240, maxLines: 4, maxFontSize: 36, minFontSize: 18 });
  assert.equal(layout.lines.join(''), title, '分享图标题不得 slice 截断');
  assert.ok(layout.lines.length > 1, '长标题应自动换行');
  assert.match(uploadGuard.validateDocumentUpload({ name: '经营复盘.ppt', size: 1024 }).message, /另存为 \.pptx/);
  assert.match(uploadGuard.validateDocumentUpload({ name: '经营复盘.pptx', size: 21 * 1024 * 1024 }).message, /21\.0MB.*上限 20MB/);
  assert.equal(uploadGuard.validateDocumentUpload({ name: '经营复盘.pptx', size: 2 * 1024 * 1024 }).ok, true);
  const reportPage = fs.readFileSync(path.join(sourceRoot, 'packages/work/report/index.js'), 'utf8');
  const thinktankPage = fs.readFileSync(path.join(sourceRoot, 'pages/thinktank/index.js'), 'utf8');
  assert.match(reportPage, /fitCanvasText\(ctx, maskSensitive\(content\.title\)/, '报告页必须实际使用自适应标题布局');
  assert.doesNotMatch(reportPage, /content\.title\)\.slice\(0,\s*14\)/, '不得恢复固定 14 字截断');
  assert.match(thinktankPage, /uploadError:failed>0/);
  assert.match(thinktankPage, /部分资料上传失败/);
});

// 对话核心已抽到主包 weapp-native/chat-core/，chat 分包页只剩页头与模板引用。
// 断言的目标从「chat 页四件套」挪到「chat-core + chat 页」的并集，条数与语义一条不减；
// chat-core 文件本身是否存在由下方「对话核心抽到主包」一测硬保。
const chatCoreRoot = path.join(sourceRoot, 'chat-core');
const read = (...segments) => fs.readFileSync(path.join(...segments), 'utf8');
const chatSource = () => [
  read(chatCoreRoot, 'behavior.js'),
  read(sourceRoot, 'packages/main/chat/index.js'),
].join('\n');
const chatMarkup = () => [
  read(sourceRoot, 'packages/main/chat/index.wxml'),
  read(chatCoreRoot, 'message-list.wxml'),
  read(chatCoreRoot, 'composer.wxml'),
].join('\n');
const chatStyle = () => [
  read(sourceRoot, 'packages/main/chat/index.scss'),
  read(chatCoreRoot, 'chat-core.scss'),
].join('\n');

test('原生 402 保留业务错误码，额度耗尽只给方案入口不再诱导重试', () => {
  const requestPath = path.join(sourceRoot, 'services/request.js');
  const errorPath = path.join(sourceRoot, 'services/chat-error.js');
  const apiErrorPath = path.join(sourceRoot, 'services/api-error.js');
  delete cjsRequire.cache[cjsRequire.resolve(requestPath)];
  delete cjsRequire.cache[cjsRequire.resolve(errorPath)];
  delete cjsRequire.cache[cjsRequire.resolve(apiErrorPath)];
  const { parseBody } = cjsRequire(requestPath);
  const { chatErrorPresentation } = cjsRequire(errorPath);
  const { apiErrorPresentation, httpErrorInfo } = cjsRequire(apiErrorPath);
  const bytes = new TextEncoder().encode(JSON.stringify({
    error: '本月 token 额度已用尽，请续费或升级套餐', code: 'INSUFFICIENT_QUOTA',
  }));
  const parsed = parseBody(bytes.buffer);
  assert.equal(parsed.code, 'INSUFFICIENT_QUOTA', 'enableChunked 的 ArrayBuffer 4xx 不得退化成 HTTP_402');
  assert.deepEqual(chatErrorPresentation(Object.assign(new Error(parsed.error), { code: parsed.code, data: parsed })), {
    title: '本月方案用量已用完',
    note: '可前往「方案与权益」查看恢复时间或更换方案。原问题和引用已保留。',
    action: 'plans',
    retryable: false,
  });
  const markup = read(chatCoreRoot, 'message-list.wxml');
  assert.match(markup, /errorAction==='plans'/);
  assert.match(markup, /查看方案/);
  assert.deepEqual(chatErrorPresentation({ code: 'INSUFFICIENT_CREDITS' }), {
    title: '当前算力不足',
    note: '可前往「算力明细」查看。原问题和引用已保留。',
    action: 'credits',
    retryable: false,
  });
  assert.match(markup, /errorAction==='credits'/);
  assert.equal(apiErrorPresentation({ code: 'RATE_LIMITED' }).retryable, false);
  assert.equal(apiErrorPresentation({ code: 'CLIENT_REQUEST_ID_REQUIRED' }).kind, 'validation');
  assert.deepEqual(httpErrorInfo(500, { error: 'Prisma exploded', code: 'FAIL' }), {
    message: '军师服务暂时不可用，请稍后重试。', code: 'FAIL', technicalMessage: 'Prisma exploded',
  });
});

test('原生小程序覆盖 app.json 声明的全部路由', () => {
  const app = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'app.json'), 'utf8'));
  // 官方 app.json 的 permission 目前只接受 scope.userLocation；scope.record 放进去会被
  // 开发者工具直接报 invalid。录音仍在用户点击时走 getSetting/authorize，隐私用途在
  // 小程序管理后台《用户隐私保护指引》申报，不在这里伪造一个无效配置。
  assert.equal(app.permission?.['scope.record'], undefined, 'app.json 不得声明无效的 permission.scope.record');
  const routes = [...app.pages];
  for (const pkg of app.subPackages || []) for (const page of pkg.pages || []) routes.push(`${pkg.root}/${page}`);
  for (const route of routes) {
    const hasDedicated = ['js', 'json', 'wxml', 'scss'].every((ext) => fs.existsSync(path.join(sourceRoot, `${route}.${ext}`)));
    assert.ok(hasDedicated, `路由缺少独立原生四件套：${route}`);
  }
  // 2026-08-18 IA 回归：+1 = pages/execution（独立执行 tab）。pouch 降普通页，studio 继续接老分享卡。
  // 2026-08-12 快出片：+1 = packages/video/templates（模板专区，从首页拆出，便于后续上新模板）。
  // 2026-08-13 成片封面：+1 = packages/video/cover（出片确认页的可选支线，填四个文本槽位）。
  // 2026-08-15 独立声音：+1 = packages/video/voices（我的声音列表页，声音可脱离形象单独存在）。
  assert.equal(routes.length, 55, '路由数量变化时必须同步审计原生迁移覆盖');
  assert.equal(fs.existsSync(path.join(sourceRoot, 'route-manifest.json')), false, '完整迁移后不得保留通用路由清单');
  assert.equal(fs.existsSync(path.join(sourceRoot, 'services/generic-page.js')), false, '完整迁移后不得保留通用页面渲染器');
  assert.equal(fs.existsSync(path.join(sourceRoot, 'templates/generic-page.wxml')), false, '完整迁移后不得保留通用页面模板');
});

test('微信桌面端启用官方可拉伸与分栏能力，五个主 Tab 响应当前栏尺寸', () => {
  const app = JSON.parse(read(sourceRoot, 'app.json'));
  assert.equal(app.resizable, true, 'PC 最大化/自由拉伸与 iPad 旋转依赖 app.json.resizable');
  assert.equal(app.frameset, true, 'Windows 微信自动左右分栏依赖 app.json.frameset');

  const pageService = read(sourceRoot, 'services/page.js');
  assert.match(pageService, /function viewportData\(size\)/);
  assert.match(pageService, /windowWidth >= 1100 \? 'expanded' : \(windowWidth >= 720 \? 'medium' : 'compact'\)/);
  assert.match(pageService, /function syncViewport\(page, size\)/);
  assert.match(pageService, /navRightInset: metrics\.navRightInset/);

  for (const route of ['sessions', 'home', 'execution', 'thinktank', 'profile']) {
    const source = read(sourceRoot, `pages/${route}/index.js`);
    const markup = read(sourceRoot, `pages/${route}/index.wxml`);
    assert.match(source, /onResize\(event\)[\s\S]{0,180}syncViewport\(this, event && event\.size\)/, `${route} 必须消费官方 Page.onResize`);
    assert.match(markup, /class="[^"]*\{\{viewportClass\}\}/, `${route} 根节点必须挂语义化窗口档位`);
    assert.match(markup, /--window-width:\{\{windowWidth\}\}px;--window-height:\{\{windowHeight\}\}px/, `${route} 必须透出当前栏的真实窗口尺寸`);
  }

  const appScss = read(sourceRoot, 'app.scss');
  const tabbarScss = read(sourceRoot, 'custom-tab-bar/index.scss');
  assert.match(appScss, /\.viewport-medium \.pad,[\s\S]*?max-width:\s*920px/);
  assert.match(tabbarScss, /@media \(min-width:\s*720px\)[\s\S]*?width:\s*560px/);
});

test('数字分身训练通知必须由用户点击授权并回写 avatar 场景', () => {
  const cloneJs = read(sourceRoot, 'packages/video/clone/index.js');
  const cloneWxml = read(sourceRoot, 'packages/video/clone/index.wxml');
  const videoApi = read(sourceRoot, 'packages/video/api.js');
  assert.match(cloneJs, /wx\.requestSubscribeMessage\s*\(/);
  assert.match(cloneJs, /scene:\s*'avatar'/);
  assert.match(cloneJs, /notificationTemplate/);
  assert.match(cloneWxml, /训练好通知我/);
  assert.match(videoApi, /\/wechat\/subscribe\/templates/);
  assert.match(videoApi, /\/wechat\/subscribe/);
});

test('数字人主链是上传视频后直接训练，单独声音采集只是可选增强', () => {
  const cloneJs = read(sourceRoot, 'packages/video/clone/index.js');
  const cloneWxml = read(sourceRoot, 'packages/video/clone/index.wxml');
  const avatarWxml = read(sourceRoot, 'packages/video/avatar/index.wxml');
  const homeWxml = read(sourceRoot, 'packages/video/home/index.wxml');
  assert.match(cloneJs, /\{ no: 1, key: 'video', label: '上传视频' \}/);
  assert.match(cloneJs, /\{ no: 2, key: 'training', label: '云端训练' \}/);
  assert.doesNotMatch(cloneJs, /\{ no: 1, key: 'voice'/);
  assert.match(cloneWxml, /mode === 'voice' && step === 1/);
  assert.match(cloneWxml, /一段视频即可创建/);
  assert.match(avatarWxml, /voiceBadgeText/);
  assert.match(avatarWxml, /av-primary/);
  // 「形象 ready 即可用、不要求 voice 也 ready」这条规则还在，只是首页重排成落地页后
  // 判定从 wxml 挪进了 JS 的 resolveAvatarState（四态：ready/training/missing/failed），
  // wxml 只消费派生出来的 avatarState。规则本身照旧钉住：
  const homeJs = read(sourceRoot, 'packages/video/home/index.js');
  assert.match(homeJs, /item\.imageStatus === 'ready'/);
  assert.doesNotMatch(homeJs, /imageStatus === 'ready' && .*voiceStatus === 'ready'/);
  assert.doesNotMatch(homeWxml, /avatar\.voiceStatus/, '首页不得把声音就绪也当成开拍前置');
  assert.match(homeWxml, /avatarState === 'ready'/);
});

test('专属声音明确展示来源、训练进度和完成结果，并在页面内轮询', () => {
  const avatarJs = read(sourceRoot, 'packages/video/avatar/index.js');
  const avatarWxml = read(sourceRoot, 'packages/video/avatar/index.wxml');
  assert.match(avatarJs, /avatar\.voiceSource === 'dedicated'/);
  assert.match(avatarJs, /voiceActionText/);
  assert.match(avatarJs, /setTimeout\(\(\) => this\.load\(\), 5000\)/);
  assert.match(avatarWxml, /voiceBadgeText/);
  assert.match(avatarWxml, /class="avv-progress"/);
  assert.match(avatarWxml, /voiceCompletedText/);
  assert.match(avatarWxml, /voiceActionText/);
});

test('更换形象显式 mode=avatar 优先于旧 step 路由兼容判断', () => {
  const cloneJs = read('weapp-native/packages/video/clone/index.js');
  const avatarJs = read('weapp-native/packages/video/avatar/index.js');
  assert.match(avatarJs, /clone\/index\?mode=\$\{kind === 'voice' \? 'voice' : 'avatar'\}&recapture=1/);
  assert.match(cloneJs, /const hasExplicitMode = requestedMode === 'voice' \|\| requestedMode === 'avatar'/);
  assert.match(cloneJs, /const mode = hasExplicitMode\s*\? requestedMode\s*:/);
  const avatarWxml = read('weapp-native/packages/video/avatar/index.wxml');
  assert.match(avatarWxml, /item\.imageStatus === 'training' \? '正在云端训练' : '还没有创建形象'/);
  assert.match(avatarWxml, /item\.imageStatus === 'none' \? '上传一段视频即可创建'/);
  assert.match(avatarWxml, /wx:if="\{\{item\.imagePreviewUrl\}\}"[^>]+src="\{\{item\.imagePreviewUrl\}\}"/);
  const homeWxml = read('weapp-native/packages/video/home/index.wxml');
  assert.match(homeWxml, /avatar && avatar\.imagePreviewUrl/);
});

test('配画面只展示可读素材名和真实缩略图，预览底栏不覆盖列表', () => {
  const shotsJs = read('weapp-native/packages/video/shots/index.js');
  const shotsWxml = read('weapp-native/packages/video/shots/index.wxml');
  const shotsScss = read('weapp-native/packages/video/shots/index.scss');
  assert.match(shotsJs, /assetDisplayLabel/);
  assert.doesNotMatch(shotsWxml, /\{\{item\.assetLabel\}\}/);
  assert.match(shotsWxml, /item\.assetPreviewUrl/);
  assert.match(shotsWxml, /item\.framePreviewUrl/);
  assert.match(shotsWxml, /previewSelectedAsset/);
  assert.match(shotsWxml, /previewAsset\.contentUrl/);
  assert.match(shotsWxml, /class="pv-actions"/);
  assert.match(shotsScss, /\.pv-scroll\s*\{[^}]*min-height:\s*0/);
  assert.match(shotsScss, /\.pv-actions\s*\{[^}]*flex:\s*none/);
});

test('素材库显示真实封面，浏览与挑选态都保留可播放预览', () => {
  const assetsJs = read('weapp-native/packages/video/assets/index.js');
  const assetsWxml = read('weapp-native/packages/video/assets/index.wxml');
  assert.match(assetsJs, /this\.data\.picking[\s\S]*this\.openPreview\(asset\)/);
  assert.match(assetsJs, /asset\.contentUrl \|\| asset\.previewUrl/);
  assert.match(assetsWxml, /wx:if="\{\{item\.previewUrl\}\}"[^>]+src="\{\{item\.previewUrl\}\}"/);
  assert.match(assetsWxml, /catchtap="previewAsset"/);
  assert.match(assetsWxml, /previewAsset\.contentUrl/);
  assert.match(assetsWxml, /poster="\{\{previewAsset\.previewUrl\}\}"/);
});

test('采集与素材上传必须取原始画质：上传分辨率决定成片分辨率', () => {
  const cloneJs = read('weapp-native/packages/video/clone/index.js');
  const assetsJs = read('weapp-native/packages/video/assets/index.js');
  // 不写 sizeType 时微信默认取压缩版，等于在源头把成片画质砍掉（石榴 2026-08-13 确认
  // 「上传视频的分辨率决定生成视频的分辨率」）。sizeType 对视频自基础库 2.25.0 起生效，
  // 本项目 libVersion 3.16.2，远高于该门槛。
  for (const [name, source] of [['clone', cloneJs], ['assets', assetsJs]]) {
    assert.match(source, /sizeType:\s*\['original'\]/, `${name} 的 chooseMedia 必须显式取原始画质`);
  }
  const libVersion = JSON.parse(read(appRoot, 'project.config.json')).libVersion;
  const [major, minor] = String(libVersion).split('.').map(Number);
  assert.ok(major > 2 || (major === 2 && minor >= 25),
    `sizeType 对视频要基础库 ≥2.25.0 才生效，当前 libVersion=${libVersion}`);
  // 图片场景（聊天附件 / 海报）是**故意**压缩的，不要被这条规则带跑
  assert.match(read(chatCoreRoot, 'behavior.js'), /sizeType:\s*\['compressed'\]/, '聊天图片附件仍应压缩');
});

test('素材分辨率：未知与 0 不许混，端上不得渲染 0×0', () => {
  const assetsJs = read('weapp-native/packages/video/assets/index.js');
  const assetsWxml = read('weapp-native/packages/video/assets/index.wxml');
  // 宽高由 model.mediaDimensions 判定，拿不到就整体不传字段（不落 0 到服务端）
  assert.match(assetsJs, /mediaDimensions/);
  assert.match(assetsJs, /resolutionText:\s*formatResolution\(item\.width,\s*item\.height\)/);
  // 空串 = 未知 → 整块不渲染；wxml 不得自己拼宽高（拼就绕过了空值判定）
  assert.match(assetsWxml, /wx:if="\{\{item\.resolutionText\}\}"/, '未知分辨率必须整块不渲染');
  assert.doesNotMatch(assetsWxml, /item\.width\s*\+|\{\{item\.width\}\}/, '宽高拼接只允许发生在 model.js 里');
});

test('创建数字人默认复用已有声音，新训练要主动选且必须明示扣费', () => {
  const cloneJs = read('weapp-native/packages/video/clone/index.js');
  const cloneWxml = read('weapp-native/packages/video/clone/index.wxml');
  const videoApi = read('weapp-native/packages/video/api.js');
  // 默认值来自 model.voiceChoices 的 defaultVoiceId（有可用声音就选第一条），
  // 不再是原先恒为空串的「视频原声」——那等于每建一个形象都顺带新训一条声音。
  assert.match(cloneJs, /voiceChoices/);
  assert.match(cloneJs, /this\.voiceTouched \? this\.data\.selectedVoiceId : defaultVoiceId/,
    '用户动过选择之后，后到的默认值不得覆盖他的选择');
  assert.match(cloneJs, /voiceTouched = true/, '主动选择要留痕');
  // 价格必须来自服务端，端上不许硬编码
  assert.match(videoApi, /clonePricing/);
  assert.match(videoApi, /'\/clone-pricing'/);
  assert.doesNotMatch(cloneJs, /[0-9]{2,}\s*钻石/, '端上不得硬编码价格数字，一律从服务端取');
  assert.doesNotMatch(read('weapp-native/packages/video/config.js'), /voiceCreate|avatarVideo|钻石/,
    '克隆价格不得进端上配置常量（对外定价数据归运营后台）');
  // 扣费明细整块由 JS 预算好；WXML 不碰价格算术（与方案卡同一条铁律）
  assert.match(cloneWxml, /wx:if="\{\{costRows\.length\}\}"/, '价格没读到时不得渲染假账单');
  assert.match(cloneWxml, /\{\{item\.costText\}\}/);
  assert.doesNotMatch(cloneWxml, /costRows\[[0-9]/, 'WXML 不得对价格做下标算术');
  assert.match(cloneWxml, /复用不额外扣费|voiceNoteText/, '必须说清复用不额外扣费');
  // 切换声音来源后账单必须重算。少了这一步，用户切到「新训练」而明细还写着「不额外扣费」——
  // 与 d70e1bb（结算价没跟着档位走）同一类回归，实测时确实复现过。
  assert.match(cloneJs, /selectedVoiceId: id[\s\S]{0,200}?this\.chargeState\(id\)/,
    '选中声音时必须用新 id 同步重算账单');
  // 明细行与提交用的确认报价必须同源：两处各算一次，迟早会有一处忘了跟着档位走。
  assert.match(cloneJs, /chargeState\(selectedVoiceId\)\s*\{[\s\S]{0,600}?costRows:[\s\S]{0,300}?expectedCredits:/,
    'costRows 与 expectedCredits 必须出自同一次计算');
});

test('训练要预扣钻石：提交必带幂等标识与确认报价，价格没读到不许提交', () => {
  const cloneJs = read('weapp-native/packages/video/clone/index.js');
  const videoApi = read('weapp-native/packages/video/api.js');
  const avatarJs = read('weapp-native/packages/video/avatar/index.js');
  // 预扣的两个前提字段。缺任一个服务端直接 422 —— 端上必须真的发出去。
  assert.match(videoApi, /clientRequestId: payload\.clientRequestId/, '克隆上传必须带幂等标识');
  assert.match(videoApi, /expectedCredits/, '克隆上传必须带端上看到的确认报价');
  assert.match(cloneJs, /assertQuoteReady\(\)/, '价格没读到时不许提交');
  assert.match(cloneJs, /expectedCredits == null/, '0（免费）与 null（还不知道）不许混');
  // 余额不足要引到充值，而不是甩一句「提交失败」。
  assert.match(cloneJs, /INSUFFICIENT_CREDITS/);
  // 幂等标识由「素材 + 报价」派生：手动在各素材变更处清空，漏一处就会让新素材复用旧标识，
  // 服务端把上一单结果原样返回，用户以为新素材训好了其实压根没提交。
  assert.match(cloneJs, /ensureCloneRequestId\(filePath\)[\s\S]{0,400}?this\.data\.expectedCredits/,
    '幂等标识必须随素材与报价变化，不能靠手动清空');
  assert.match(cloneJs, /ensureCloneRequestId\(this\.data\.voiceFile\.path\)/);
  assert.match(cloneJs, /ensureCloneRequestId\(this\.data\.faceFile\.path\)/);
  // 重训入口：分身管理页必须把已有声音的 id 带过去，否则「重新录制」永远走新建，
  // 每次烧掉一份克隆权益，而供应商本来每条给 4 次免费重训。
  assert.match(avatarJs, /linkedVoiceId/, '重录已有声音必须带上那条声音的 id');
  assert.match(avatarJs, /voiceId=\$\{encodeURIComponent\(retrainVoiceId\)\}/);
  assert.match(cloneJs, /retrainVoiceId: mode === 'voice' \? String\(opts\.voiceId \|\| ''\) : ''/,
    '形象模式的 voiceId 是「关联哪条」，不是「重训哪条」，不许混用');
  assert.match(cloneJs, /voiceId: this\.data\.retrainVoiceId/, '声音提交必须把重训目标发给服务端');
});

test('原生历史对话剥离重复的 asks JSON，只让问答卡展示结构化选项', () => {
  const helperPath = path.join(sourceRoot, 'services/chat-reply.js');
  delete cjsRequire.cache[cjsRequire.resolve(helperPath)];
  const { stripSerializedAsksTail } = cjsRequire(helperPath);
  const asks = [{ q: '现在最缺什么？', options: ['现金流', '客户', '团队'] }];
  assert.equal(stripSerializedAsksTail(`先答这一题。\n${JSON.stringify(asks)}`, asks), '先答这一题。');
  assert.equal(stripSerializedAsksTail(`先答这一题。\n\`\`\`json\n${JSON.stringify({ asks })}\n\`\`\``, asks), '先答这一题。');
  const unrelated = '业务数据：\n[{"q":"字段名","options":["a","b"]}]';
  assert.equal(stripSerializedAsksTail(unrelated, asks), unrelated);
  const chatJs = chatSource();
  assert.match(chatJs, /stripSerializedAsksTail\(value\.text, value\.asks\)/, '历史、轮询与流式终态必须统一经过 asks 正文净化');
});

test('原生流式扣尾：ask 协议块不进打字机缓冲，done 后按落库正文重渲染', () => {
  const helperPath = path.join(sourceRoot, 'services/chat-reply.js');
  delete cjsRequire.cache[cjsRequire.resolve(helperPath)];
  const { streamVisibleText, extendsShown } = cjsRequire(helperPath);

  // 真机漏出来的那一幕：协议块刚吐出半个开头就得扣住，不能让 towxml 把 JSON 打进气泡。
  assert.equal(streamVisibleText('先聊聊你的情况。\n[{"q":"你做的是什么行业/品类？","o'), '先聊聊你的情况。');
  assert.equal(streamVisibleText('先聊聊你的情况。\n```ask\n[{"q":"行业？","options":["餐饮","电商"]}]\n```'), '先聊聊你的情况。');
  // 围栏/裸 JSON 还没写全时同样先扣住：宁可短暂少显示几个字。
  assert.equal(streamVisibleText('正文。\n``'), '正文。');
  assert.equal(streamVisibleText('正文。\n{"asks'), '正文。');
  // 被后文证伪就立刻放行：普通代码块与正文一个字都不能少。
  assert.equal(streamVisibleText('正文。\n```js\ncode()'), '正文。\n```js\ncode()');
  const plain = '这段结尾没有协议块，问号也不算。你怎么想？';
  assert.equal(streamVisibleText(plain), plain);
  // 扣掉的永远是后缀 → 可见正文始终是最终正文的前缀，done 时打字机只需继续追加（只增不减）。
  const withheld = streamVisibleText('业务数据：\n[{"q":"字段名","options":["a","b"]}]');
  assert.equal(withheld, '业务数据：');
  assert.equal(extendsShown('业务数据：\n[{"q":"字段名","options":["a","b"]}]', withheld), true);
  assert.equal(extendsShown('先聊聊你的情况。', '先聊聊你的情况。\n[{"q":'), false);

  const behavior = read(chatCoreRoot, 'behavior.js');
  assert.match(behavior, /const text = streamVisibleText\(raw\);/, '喂给打字机/纯文本兜底的是扣过尾的正文，不是模型原文');
  assert.match(behavior, /if \(current\.streamRenderId\) setMdText\(current\.streamRenderId, text\);/);
  assert.doesNotMatch(behavior, /setMdText\(current\.streamRenderId, raw\)/, '模型原文不得进入打字机缓冲');
  // done 收尾以服务端清洗后的正文（落库版本）为准；towxml 只增不减，已打出的字不是它的前缀就换渲染器。
  assert.match(behavior, /if \(!finished\.streamStarted \|\| !extendsShown\(finished\.text, this\._streamShown\)\) \{[\s\S]*?finished\.streamRenderId = '';/);
  assert.match(behavior, /setStreamFinish\(finished\.streamRenderId\)/);
  // 中断/兜底路径也不能把含协议块的模型原文当正文落进气泡。
  assert.match(behavior, /messages\[\$\{index\}\]\.text`\]: current\.text \|\| this\._streamShown \|\| ''/);
});

test('原生源码不引用 Taro，聊天 textarea 保持非受控', () => {
  const sourceFiles = walk(sourceRoot).filter((file) => /\.(js|json|wxml|scss)$/.test(file));
  const all = sourceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(all, /@tarojs|Taro\./);
  assert.doesNotMatch(all, /\bselectable(?:\s|=)/, '原生 text 使用 user-select，不得回退已弃用的 selectable');
  const chat = chatMarkup();
  // 唯一放行的 value 绑定是交替挂载时的一次性初值；任何别的受控写法都会复现输入法重复上屏。
  assert.doesNotMatch(chat, /<textarea[^>]+\bvalue="(?!\{\{composerSeed\}\})/, '除 composerSeed 初值外，输入文字不得通过 setData 回灌 textarea');
  assert.equal((chat.match(/<textarea\b/g) || []).length, 2, '聊天发送后只通过两个 textarea 交替挂载清空');
  assert.match(chat, /<input\b[^>]*class="ask-other-input[^>]*\bvalue="\{\{ask\.other\}\}"[^>]*\bbindfocus="onAskOtherFocus"[^>]*\bbindinput="onAskOtherInput"/, '其他回答必须使用卡片内可见原生 input，支持光标与文本选区');
  assert.match(chat, /id="ask-other-m\{\{messageIndex\}\}-q\{\{askIndex\}\}" class="ask-other-anchor"/, '每个其他回答 input 前必须有稳定滚动锚点');
  assert.doesNotMatch(chat, /ask-keyboard-capture/, '不得再用 1px 隐形输入框劫持其他回答');
  const chatJs = chatSource();
  assert.match(chatJs, /this\._draft\s*=\s*value/);
  assert.doesNotMatch(chatJs, /setData\([^)]*(?:draft|inputValue|composerValue)/, '输入事件不得把草稿通过 setData 写回视图层');
  assert.doesNotMatch(chatJs.match(/onAskOtherInput\(event\)\s*\{[\s\S]*?\n\s*\},/)?.[0] || '', /safeSetData|setData/, '其他回答编辑中不得回灌 value 干扰光标');
  assert.match(chatJs, /scrollToAskEditor\(messageIndex, questionIndex\)[\s\S]*?ask-other-m\$\{mi\}-q\$\{qi\}/, '键盘出现时必须定位当前题目的输入框，而不是滚到会话底部');
  assert.doesNotMatch(chatJs.match(/onAskKeyboardHeight\(event\)\s*\{[\s\S]*?\n\s*\},/)?.[0] || '', /toBottom\(/, '其他回答键盘不得把长问答卡滚到最底部');
});

test('原生长文粘贴保持同帧卡片、内容去重、全文预览与发送硬拦', () => {
  const chat = chatSource();
  const wxml = chatMarkup();
  const helperPath = path.join(sourceRoot, 'services/paste-absorb.js');
  delete cjsRequire.cache[cjsRequire.resolve(helperPath)];
  const helper = cjsRequire(helperPath);

  assert.equal(helper.diffPasted('先回答：', `先回答：${'甲'.repeat(2100)}`).kept, '先回答：');
  assert.equal(helper.isSamePaste('甲 乙 丙 丁', '甲乙丙丁'), true);
  assert.equal(helper.isSamePaste('甲'.repeat(100), `${'甲'.repeat(100)}补充`), true);
  assert.match(chat, /const INPUT_MAX = 2000/);
  assert.match(chat, /this\.safeSetData\(\{ pastePendings: current,[\s\S]*?canSend: false \}/, '网络请求前必须先显示 pending 卡并锁发送');
  assert.match(chat, /findDuplicatePaste\(pasted\)/);
  assert.match(chat, /this\.data\.pastePendings\.some\(\(item\) => item\.status === 'failed'\)/);
  assert.match(chat, /if \(this\.hasPendingPaste\(\)\)[\s\S]*?return;/);
  assert.match(chat, /store\.setOverlay\(true, 'paste-preview'\)/);
  assert.match(wxml, /粘贴长文 · \{\{item\.chars\}\}字/);
  assert.match(wxml, /class="paste-full" user-select="true"/);
  assert.match(wxml, /bindtap="retryPaste"/);
  assert.match(wxml, /bindtap="removePastePending"/);
  assert.doesNotMatch(wxml, /把附件放回输入框|Show in text field/);

  // 只有粘进来的那段变附件，用户自己打的字必须留在输入框里：逐字打不到 INPUT_MAX，
  // 触发归卷的必然是粘贴那段，没有理由连他的提问一起收走再用一张 chip 复述。
  assert.match(chat, /keepTypedAfterPaste\(kept, true\)/, '归卷后走保留手打内容的路径');
  assert.match(chat, /keepTypedAfterPaste\(kept, pending\) \{[\s\S]*?this\._draft = retained;[\s\S]*?composerSeed: retained,/, '手打内容既写回 _draft，也作为新挂载 textarea 的一次性初值');
  assert.doesNotMatch(chat, /pasteKept|_draftPrefix|clearPasteKept/, '「已保留原提问」chip 与第二段草稿真相源已废除');
  assert.doesNotMatch(wxml, /已保留原提问/);
  assert.match(chat, /composerOdd: !this\.data\.composerOdd, composerSeed: '',/, '发送时必须连 seed 一起清，否则新挂载的框会复述已发出的话');
  const onComposerInput = chat.match(/\bonComposerInput\(event\)\s*\{[\s\S]*?\n {2}\},/);
  assert.ok(onComposerInput, '未能定位 onComposerInput：编辑期回灌校验不得随重构失效');
  assert.doesNotMatch(onComposerInput[0], /composerSeed/, '编辑过程中绝不碰 seed —— 那才是输入法重复上屏与光标跳尾的真正来源');
});

test('原生页头避让微信胶囊，登录与智能体启用层同步隐藏自定义底栏', () => {
  const tabHeader = fs.readFileSync(path.join(sourceRoot, 'components/tab-header/index.scss'), 'utf8');
  const login = fs.readFileSync(path.join(sourceRoot, 'components/login-sheet/index.js'), 'utf8');
  const unlock = fs.readFileSync(path.join(sourceRoot, 'components/agent-unlock/index.js'), 'utf8');
  const store = fs.readFileSync(path.join(sourceRoot, 'services/store.js'), 'utf8');
  const page = fs.readFileSync(path.join(sourceRoot, 'services/page.js'), 'utf8');
  const tabbarJs = fs.readFileSync(path.join(sourceRoot, 'custom-tab-bar/index.js'), 'utf8');
  const tabbarWxml = fs.readFileSync(path.join(sourceRoot, 'custom-tab-bar/index.wxml'), 'utf8');
  const profileScss = fs.readFileSync(path.join(sourceRoot, 'pages/profile/index.scss'), 'utf8');

  assert.match(tabHeader, /\.tab-head\s*\{[\s\S]*?position:\s*relative;[\s\S]*?margin-bottom:\s*28px;/, '组件样式隔离下必须自己提供定位基准和背景字落脚留白');
  assert.match(tabHeader, /\.th-glyph\s*\{[\s\S]*?top:\s*4px/, '原生背景字不得向上侵入胶囊区');
  assert.match(login, /store\.setOverlay\(Boolean\(open\), 'login-sheet'\)/);
  assert.match(login, /detached\(\)[\s\S]*?store\.setOverlay\(false, 'login-sheet'\)/);
  assert.match(unlock, /store\.setOverlay\(Boolean\(agent\), 'agent-unlock'\)/);
  assert.match(unlock, /detached\(\)[\s\S]*?store\.setOverlay\(false, 'agent-unlock'\)/);
  assert.match(store, /tabbar\.syncState\(\{ overlay: state\.overlay \}\)/);
  assert.match(page, /overlay: snapshot\.overlay/);
  assert.match(tabbarJs, /overlay: false/);
  assert.match(tabbarWxml, /wx:if="\{\{!overlay\}\}" class="tabbar/);
  assert.match(profileScss, /\.profile-login\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/);
});

test('战局页不再平铺命盘/时运模式，方案按钮保持原稿视觉状态', () => {
  const homeJs = fs.readFileSync(path.join(sourceRoot, 'pages/home/index.js'), 'utf8');
  const homeWxml = fs.readFileSync(path.join(sourceRoot, 'pages/home/index.wxml'), 'utf8');
  const profile = fs.readFileSync(path.join(sourceRoot, 'pages/profile/index.js'), 'utf8');
  const plans = fs.readFileSync(path.join(sourceRoot, 'packages/work/plans/index.scss'), 'utf8');

  // 2026-08-12 IA 重排：命盘/时运两个 mode 从战局首屏移出，常驻入口在主公；
  // 战局只保留三势合参 sheet 里 fortuneOn && chart 的天势一栏（情景入口）。
  assert.doesNotMatch(homeWxml, /battle-mode-tabs|mode===item\.key/, '战局首屏不得再平铺模式切换');
  assert.match(homeWxml, /item\.kind==='sky'&&fortuneOn/, '三势 sheet 保留天势参命盘的情景入口');
  assert.match(homeJs, /fortuneOn/, 'fortuneOn 开关仍须尊重（运营可关命理）');
  assert.match(profile, /\/packages\/work\/mingpan\/index/, '命盘常驻入口在主公');
  assert.match(profile, /\/packages\/work\/calendar\/index/, '天时日历常驻入口在主公');
  for (const selector of ['option-action', 'quote-confirm']) {
    const rule = new RegExp(`\\.${selector}\\s*\\{[^}]*padding:\\s*0;[^}]*display:\\s*flex;[^}]*align-items:\\s*center;[^}]*justify-content:\\s*center;`, 's');
    assert.match(plans, rule, `${selector} 必须清掉原生 button 默认内边距并双轴居中`);
  }
  assert.match(plans, /\.option-action::after,\.quote-confirm::after\s*\{\s*border:\s*0;/, '原生 button 默认描边必须清除');
});

test('WO-07「下一步」卡已随 IA 重排删除：语义 key 不得再被端上当路由消费', () => {
  const homeJs = read(sourceRoot, 'pages/home/index.js');
  const journey = fs.readFileSync(path.join(appRoot, '../server/src/services/journey.ts'), 'utf8');

  // 契约锚点：服务端 journey 仍下发 'chat' / 'studio' 语义 key（PC 端等仍可消费）。
  assert.match(journey, /route: 'chat'/, '服务端下一步仍以语义 key 下发');
  assert.match(journey, /route: 'studio'/);

  // 2026-08-12 战局页按设计稿收敛后不再渲染「下一步」卡，也不再请求 journey——
  // 语义 key 在小程序端没有消费者，历史上把 'studio' 当路径跳导致「页面打开失败」的坑就此关死。
  assert.doesNotMatch(homeJs, /api\.journey\(/, '战局页不再请求 journey');
  assert.doesNotMatch(homeJs, /nextRoute/, '语义 key 不得再进入页面状态');
});

test('生成以 failed/cancelled 收场时必须给中断话术，不许留空白气泡', () => {
  const behavior = read(chatCoreRoot, 'behavior.js');

  // 服务端 finalizeGeneration 对 failed 不回填 replyJson，/generate-sync 仍以 200 + status:'failed'
  // 返回没有 reply/deliverable 的空壳。放任它进 normalizeReply，undefined 会被归一成空字符串，
  // 于是聊天流里插进一条空白气泡——没报错、没重试、没线索。
  assert.match(behavior, /const barren = !result \|\| \(!result\.reply && !result\.deliverable && !textOf\(result\.partialText\)\)/, 'finishResult 必须先识别「终态却零产出」');
  assert.match(behavior, /if \(barren && \(status === 'failed' \|\| status === 'cancelled'\)\) \{ this\.finishInterrupted\(status, pageEpoch\); return; \}/);

  // 三条路径（SSE done / 轮询终态 / 同步兜底）共用一处收尾，话术不许各写各的。
  assert.match(behavior, /finishInterrupted\(status, epoch\) \{[\s\S]*?markStreamInterrupted\(\)[\s\S]*?canRetryLast: true,/, '中断收尾必须停打字机并给出重试入口');
  assert.equal((behavior.match(/this\.finishInterrupted\(/g) || []).length, 3, 'SSE / 轮询 / 同步兜底三处都要走同一个收尾');
  assert.equal((behavior.match(/军师暂时没有接上，请重试/g) || []).length, 1, '中断终态保留统一话术；HTTP catch 交错误语义映射，不再写死同一句');
  assert.match(behavior, /this\.finishBusy\(chatErrorPatch\(error\), epoch\)/, 'HTTP 失败必须先判断是否真的可重试');
});

test('mock 不得比真服务端「友好」：多给的字段会让端上写出真机取不到的消费', () => {
  const mock = read(sourceRoot, 'services/mock.js');
  const behavior = read(chatCoreRoot, 'behavior.js');
  const home = read(sourceRoot, 'pages/home/index.js');
  const execution = read(sourceRoot, 'pages/execution/index.js');
  const credits = read(sourceRoot, 'packages/work/credits/index.js');

  // WorkbenchView 契约只有 completeness/sections/missing，服务端物理上不会给 title。
  assert.doesNotMatch(mock, /missing, title:/, 'mock workbench 不得多给契约外的 title');
  assert.doesNotMatch(home, /workbench && workbench\.title/, '端上不得兜底读服务端永远不给的字段');

  // GET /me/credits 只返回 { items }：余额与用量归 /me，端上兜底读 credits.balance 会静默显示错数。
  assert.match(mock, /function credits\(\) \{[\s\S]*?items: \[/, 'mock credits 要按契约返回 items');
  assert.doesNotMatch(credits, /credits && credits\.(balance|usedPercent)/, '端上不得读 /me/credits 不存在的余额字段');
  // usageLabel 里的「本月已用 x%」是正常用法（有 usage 才调）；不许的是 usage 缺失时的兜底也编一个数。
  assert.match(credits, /usageText: usage \? usageLabel\(usage\) : ''/, '拿不到用量就留空，别显示看起来正常的「已用 0%」');

  // KnowledgeItemT 只有九个键：mock 用 Object.assign 透传原始对象会带出 summary/fileName/category。
  assert.doesNotMatch(mock, /\.map\(\(item\) => Object\.assign\(\{\}, item, \{\s*\n\s*projectId/, 'mock knowledge 必须逐字段构造，不得透传契约外字段');
  assert.doesNotMatch(behavior, /item\.summary \|\| item\.category/, '@引用资料行不得消费契约里没有的字段');

  // /casefile/orders 与 /casefile/backfill 都要求先有 active casefile，mock 却会当场捏一份。
  // 执行区已随 IA 重排进入独立执行 Tab，门禁跟着搬家。
  assert.equal((execution.match(/if \(!this\.data\.hasDossier\) \{ wx\.showToast\(\{ title: '先和军师定下一份方案，生成案卷'/g) || []).length, 3, '加军令 / 回填数据 / 改目标三处门禁口径一致');
});

test('服务端下发给端上的页面路由必须真实存在（页面搬家要连服务端一起搬）', () => {
  // 服务端有几处直接下发小程序页面路径（/search 的结果行、/journey 的速诊那条）。
  // 这类路由没有任何编译期约束：页面一搬包，服务端还在发老路径，用户点了只会吃到
  // 「页面打开失败，请重试」——对话页从主包迁到 packages/main 时就这么坏过一次。
  const app = JSON.parse(read(sourceRoot, 'app.json'));
  const routes = new Set((app.pages || []).map((page) => `/${page}`));
  for (const pkg of app.subPackages || []) for (const page of pkg.pages || []) routes.add(`/${pkg.root}/${page}`);

  const serverRoot = path.join(appRoot, '..', 'server', 'src');
  const dead = [];
  for (const file of walk(serverRoot).filter((item) => item.endsWith('.ts'))) {
    // 前导斜杠可有可无：订阅消息的默认落地页就写成 'pages/studio/index'（无斜杠），
    // 旧正则要求引号紧跟 `/`，于是它逃过了扫描——一旦那页被删注册，落地页会静默失效。
    for (const found of read(file).matchAll(/['`"]\/?((?:pages|packages)\/[A-Za-z0-9_/-]+)/g)) {
      if (!routes.has(`/${found[1]}`)) dead.push(`${path.relative(serverRoot, file)} → ${found[1]}`);
    }
  }
  assert.deepEqual(dead, [], `服务端下发了 app.json 里不存在的页面路由：\n${dead.join('\n')}`);
});

test('原生页面头统一复用胶囊行、键盘只避让一次，底栏与设置按钮做光学校准', () => {
  const page = fs.readFileSync(path.join(sourceRoot, 'services/page.js'), 'utf8');
  const nativeAppScss = fs.readFileSync(path.join(sourceRoot, 'app.scss'), 'utf8');
  const subpageScss = fs.readFileSync(path.join(sourceRoot, 'styles/subpage.scss'), 'utf8');
  const chat = chatMarkup();
  const chatJs = chatSource();
  const chatScss = chatStyle();
  const tabbar = fs.readFileSync(path.join(sourceRoot, 'custom-tab-bar/index.wxml'), 'utf8');
  const tabbarScss = fs.readFileSync(path.join(sourceRoot, 'custom-tab-bar/index.scss'), 'utf8');
  const settings = fs.readFileSync(path.join(sourceRoot, 'packages/main/settings/index.scss'), 'utf8');

  assert.match(page, /const navRowHeight = Math\.max\(36, capsuleHeight\)/);
  assert.match(page, /const navTop = Math\.max\(0, \(Number\(rect\.top\) \|\| 0\) - \(\(navRowHeight - capsuleHeight\) \/ 2\)\)/);
  // 胶囊行底部呼吸：10 → 18px（2026-08-09 视觉反馈「页头贴着胶囊、跟页面分不开」）。
  assert.match(page, /navInset:\s*navTop \+ navRowHeight \+ 18/);
  // 导航层必须自带收口线：同色同底时滚动内容会和标题糊在一起。
  assert.match(nativeAppScss, /page \.native-safe-head,[\s\S]{0,400}border-bottom:\s*1px solid var\(--line-strong\)/, '导航层缺少与正文的分界线');
  assert.match(page, /navRightInset:\s*Math\.max\(16, win && win\.windowWidth \? win\.windowWidth - rect\.left \+ 12/);
  assert.match(nativeAppScss, /page \.native-safe-space,[\s\S]*?page \.legal-safe \{ display: none; \}/, '各类旧安全区占位必须统一折叠');
  assert.match(nativeAppScss, /page \.native-safe-row,[\s\S]*?top:\s*var\(--native-nav-top\);[\s\S]*?padding:\s*0 var\(--native-nav-right\) 0 12px;/, '标题行必须与胶囊同排并精确避让右侧系统按钮');
  assert.match(nativeAppScss, /page \.native-safe-row \.safe-body,[\s\S]*?page \.legal-title \{[^}]*text-align:\s*left;/, '非 Tab 页标题统一左对齐，不能再按剩余空间伪居中');
  assert.match(nativeAppScss, /page \.native-safe-row \.safe-spacer,[\s\S]*?page \.legal-spacer \{ display: none; \}/, '左对齐标题不保留无意义的右侧配平占位');
  assert.match(nativeAppScss, /page \.report-scroll,[\s\S]*?page \.legal-scroll \{ top: var\(--native-nav-inset\); \}/, '内容只从单层导航底部开始，不得再叠第二行高度');
  assert.match(subpageScss, /\.safe-head\s*\{[^}]*height:\s*var\(--native-nav-inset\);[^}]*padding:\s*var\(--native-nav-top\) var\(--native-nav-right\) 10px 16px;/s);
  assert.match(subpageScss, /\.safe-title-wrap\s*\{[^}]*text-align:\s*left;/s);
  assert.match(subpageScss, /\.native-subpage-scroll,\.generic-scroll\s*\{[^}]*top:\s*var\(--native-nav-inset\);/s);
  const navRoots = walk(sourceRoot).filter((file) => file.endsWith('.wxml') && !file.endsWith('packages/main/chat/index.wxml') && fs.readFileSync(file, 'utf8').includes('--native-nav-inset:{{navInset}}px'));
  // 独立执行页加入后全部复用同一套胶囊几何。
  assert.equal(navRoots.length, 51);
  for (const file of navRoots) {
    const source = fs.readFileSync(file, 'utf8');
    for (const variable of ['--native-nav-top:{{navTop}}px', '--native-nav-row-height:{{navRowHeight}}px', '--native-nav-right:{{navRightInset}}px']) {
      assert.match(source, new RegExp(variable.replace(/[{}]/g, '\\$&')), `${path.relative(sourceRoot, file)} 缺少导航度量 ${variable}`);
    }
  }
  assert.match(chatScss, /\.chat-header\s*\{[^}]*height:\s*calc\(var\(--native-menu-top\) \+ var\(--native-menu-height\) \+ 12px\)/s, '对话头必须与胶囊同排，不能再叠加一整行空白');
  assert.match(chatScss, /\.chat-headrow\s*\{[^}]*margin-top:\s*var\(--native-menu-top\);[^}]*padding:\s*0 var\(--native-menu-right\) 0 12px;/s, '标题行须避让右侧胶囊');
  assert.equal((chat.match(/adjust-position="\{\{false\}\}"/g) || []).length, 3, '两个 textarea 和卡片内其他答案 input 都必须真正关闭系统自动顶起');
  assert.doesNotMatch(chat, /adjust-position="false"/, '原生布尔属性不能写成可能被当作真值的字符串');
  assert.equal((chat.match(/<textarea\b[^>]*\bfixed="\{\{true\}\}"[^>]*\balways-embed="\{\{true\}\}"/g) || []).length, 2);
  assert.match(chatJs, /onKeyboardHeight\(event\)[\s\S]*?keyboardHeight: height[\s\S]*?if \(height > 0\) this\.toBottom\(\)/);
  assert.match(chatJs, /onComposerBlur\(\)[\s\S]*?keyboardHeight: 0/);

  assert.match(tabbar, /class="tab-icon tab-icon-\{\{item\.icon\}\}"/);
  assert.doesNotMatch(tabbarScss, /tab-icon-hat/);
  // 锦囊 26px 特调必须保持删除态：那是给 lucide archive 补分量的旧校准，五图标统一
  // 自绘线稿后再放大就复现「锦囊不激活也大一号」（2026-08-09 视觉反馈）。
  assert.doesNotMatch(tabbarScss, /\.tab-icon-pouch\s*\{\s*width/);
  for (const selector of ['save-btn', 'delete-btn', 'color-confirm']) {
    assert.match(settings, new RegExp(`\\.${selector}\\s*\\{[^}]*padding:\\s*0;[^}]*display:\\s*flex;[^}]*align-items:\\s*center;[^}]*justify-content:\\s*center;`, 's'));
  }
});

test('老板页经营统计保留 Taro 原稿的通用卡片阴影', () => {
  const nativeProfile = fs.readFileSync(path.join(sourceRoot, 'pages/profile/index.wxml'), 'utf8');
  const taroProfile = fs.readFileSync(path.join(appRoot, 'src/pages/profile/index.tsx'), 'utf8');
  const appScss = fs.readFileSync(path.join(appRoot, 'src/app.scss'), 'utf8');

  assert.match(taroProfile, /className="account-stat card"/);
  assert.match(nativeProfile, /class="account-stat card"/, '原生迁移不得漏掉统计卡的通用 card 类');
  assert.match(appScss, /\.card\s*\{[^}]*border:\s*1px solid var\(--line-strong\);[^}]*box-shadow:/s, '统计卡必须复用原稿实边和阴影令牌');
});

test('老板页老师微信与班级群保持原稿双卡排版', () => {
  const nativeProfile = fs.readFileSync(path.join(sourceRoot, 'pages/profile/index.wxml'), 'utf8');
  const teacherStart = nativeProfile.indexOf('service-action service-action-teacher');
  const groupStart = nativeProfile.indexOf('service-action service-action-group');
  const rowEnd = nativeProfile.indexOf('</view>\n          </view>', groupStart);
  const teacherCard = nativeProfile.slice(teacherStart, groupStart);
  const groupCard = nativeProfile.slice(groupStart, rowEnd);

  assert.match(teacherCard, /class="service-action-main" bindtap="openTeacher"/, '老师卡首行必须只承载图标与老师名称');
  assert.match(teacherCard, /name="wechat" tone="white" size="15"/, '深绿图标底必须使用可见的白色 Lucide 微信语义图标');
  assert.match(teacherCard, /wx:if="\{\{serviceReady\}\}" class="teacher-wechat-id" bindtap="copyWechat"/, '已分配态第二行应独立显示可复制微信号');
  assert.match(teacherCard, /wx:else class="teacher-wechat-id twi-ph" bindtap="openCommunity"/, '未分配态第二行应独立承接分班入口');
  assert.doesNotMatch(groupCard, /name="arrow"/, '班级群卡不得追加迁移期箭头挤压标题与状态');
  assert.match(groupCard, /class="sa-qr"[^>]*><native-icon name="group"/, '班级群继续使用 Lucide 开源群组图标');
});

// 2026-08-08 审核驳回：「登录页面或弹窗（调用手机号快速验证组件的前置页面），存在混淆腾讯官方的元素，
// 包括但不限于『微信』字样、微信官方 logo」。本测反向钉死——登录弹层不得出现平台名与平台标识。
// 注意这条**推翻了**此前「登录页必须用 Simple Icons 微信品牌 SVG」的老约定，那两个 svg 已删除。
test('登录弹层不得出现「微信」字样或微信官方标识（审核红线）', () => {
  const wxml = fs.readFileSync(path.join(sourceRoot, 'components/login-sheet/index.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(sourceRoot, 'components/login-sheet/index.js'), 'utf8');

  // ① 可见文案：WXML 里的中文串与 JS 里会进 showToast/showModal 的文案，都不许带「微信」。
  assert.doesNotMatch(wxml, /微信/, '登录弹层的可见文案不得出现「微信」');
  for (const literal of js.match(/'[^']*'|"[^"]*"/g) || []) {
    if (/微信/.test(literal)) assert.fail(`登录弹层的用户可见文案不得出现「微信」：${literal}`);
  }
  // ② 平台标识：不许再引任何品牌图形（那两个 Simple Icons SVG 已随本次整改删除）。
  assert.doesNotMatch(wxml, /brand-icons|wechat\.svg|wechat-light\.svg/, '登录弹层不得引用微信品牌图形');
  assert.ok(!fs.existsSync(path.join(sourceRoot, 'assets/brand-icons')), '微信品牌图形资源不得留在包内');
  assert.doesNotMatch(wxml, /<image[^>]*class="lg-wechat-icon"/, '一键登录按钮不得再挂品牌图标');
  // ③ 主按钮沿用审核建议的中性表述，且能力本身（getPhoneNumber）不受影响。
  assert.match(wxml, /open-type="getPhoneNumber"[\s\S]{0,200}手机号快捷登录/, '主按钮仍走手机号快速验证组件，文案用中性表述');
  // ④ 协议勾选的可见性照旧（历史坑，别在整改里被顺手改回白勾）。
  assert.equal((wxml.match(/name="check" tone="brand" size="12"/g) || []).length, 2, '两个登录方式的协议框都必须使用深绿勾');
  assert.doesNotMatch(wxml, /name="check" tone="white"/, '浅色选中框上不得继续放不可见白勾');
});

test('新账号恢复称呼头像并自动进入本命色与首判仪式', () => {
  const nativeLogin = fs.readFileSync(path.join(sourceRoot, 'components/login-sheet/index.js'), 'utf8');
  const nativeLoginWxml = fs.readFileSync(path.join(sourceRoot, 'components/login-sheet/index.wxml'), 'utf8');
  const nativeOnboarding = fs.readFileSync(path.join(sourceRoot, 'packages/main/onboarding/index.js'), 'utf8');
  const nativeOnboardingWxml = fs.readFileSync(path.join(sourceRoot, 'packages/main/onboarding/index.wxml'), 'utf8');
  const nativeMock = fs.readFileSync(path.join(sourceRoot, 'services/mock.js'), 'utf8');
  const h5Login = fs.readFileSync(path.join(appRoot, 'src/components/Login/index.tsx'), 'utf8');

  assert.match(nativeLoginWxml, /open-type="chooseAvatar" bindchooseavatar="chooseAvatar"/);
  assert.match(nativeLoginWxml, /type="nickname"[^>]*bindinput="inputNickname"/);
  assert.match(nativeLoginWxml, /wx:if="\{\{agreed\}\}"[^>]*open-type="getPhoneNumber" bindgetphonenumber="submitWechatPhone"/);
  assert.match(nativeLoginWxml, /wx:else class="lg-wechat[^>]*bindtap="ensureAgreed"/, '未勾协议时不得先拉起手机号授权');
  assert.doesNotMatch(nativeLoginWxml, /bindtap="submitWechat"|bindgetphonenumber="bindWechatPhone"/, '微信主入口不得再先建无手机号账号、下一页才补绑');
  assert.match(nativeLoginWxml, /完成并开始入局/);
  assert.match(nativeLogin, /presentAfterAuth\(result\)[\s\S]*?if \(!name\)[\s\S]*?stage: 'complete'/);
  assert.match(nativeLogin, /submitWechatPhone\(event\)[\s\S]*?wx\.login[\s\S]*?api\.wechatPhoneLogin\(phoneCode, loginResult\.code\)/);
  assert.match(nativeLogin, /phoneBinding[\s\S]*?status !== 'wechat_relinked'[\s\S]*?已按授权手机号登录/, '第三方身份自动迁绑到授权手机号账号时必须非阻断说明去向');
  assert.doesNotMatch(nativeLogin, /'mismatch'/, '手机号已是唯一身份，登录层不得再保留 mismatch 分支');
  assert.match(nativeLogin, /presentAfterAuth\(result\);[\s\S]*?presentPhoneBindingNotice\(result\);/, '迁绑提醒必须发生在登录成功之后');
  assert.match(nativeLogin, /finishAuth\(onboarded\)[\s\S]*?packages\/main\/onboarding\/index/);
  assert.match(nativeMock, /Object\.assign\(\{ id:[^}]*name: '', company: ''/, 'mock 新账号不得用兜底称呼跳过注册补全');
  assert.match(nativeMock, /function wechatPhoneLogin\(phoneCode\)/);

  assert.match(nativeOnboardingWxml, /择一枚本命色/);
  assert.match(nativeOnboardingWxml, /class="of-chips"/);
  assert.match(nativeOnboardingWxml, /初 步 军 情/);
  assert.match(nativeOnboarding, /await api\.saveProfile\(answers\)/);
  assert.match(nativeOnboarding, /api\.quickScan\(\{ industry, revenueBand: answers\.stage \|\| '', pain \}\)/);
  assert.match(nativeOnboarding, /armCoach\(\)/);

  assert.match(h5Login, /type Stage = 'wechat' \| 'phone' \| 'complete'/);
  assert.match(h5Login, /openType="chooseAvatar" onChooseAvatar=\{onChooseAvatar\}/);
  assert.match(h5Login, /await api\.bindPhone\(phone, code\)/);
  assert.match(h5Login, /Taro\.navigateTo\(\{ url: '\/packages\/main\/onboarding\/index' \}\)/);
  // 手机号是唯一身份：纯 code 登录遇到未关联身份时服务端不建号，端上必须转手机号验证码而不是报错。
  assert.match(h5Login, /PHONE_LOGIN_REQUIRED[\s\S]{0,200}?setStage\('phone'\)/, '未关联的快捷登录应切到手机号验证码登录，不能只弹错误 toast');
  assert.doesNotMatch(h5Login, /'mismatch'/, '手机号已是唯一身份，H5 登录不得再保留 mismatch 分支');
});

test('iOS 登录补档不得被底层原生输入框拦截，头像无结果必须有反馈', () => {
  const sessionsWxml = fs.readFileSync(path.join(sourceRoot, 'pages/sessions/index.wxml'), 'utf8');
  const chatWxml = fs.readFileSync(path.join(sourceRoot, 'packages/main/chat/index.wxml'), 'utf8');
  const login = fs.readFileSync(path.join(sourceRoot, 'components/login-sheet/index.js'), 'utf8');

  assert.match(sessionsWxml, /wx:if="\{\{!coachOn && !showLogin\}\}" is="chat-composer"/, '问策登录层打开时必须卸载原生 textarea');
  assert.match(chatWxml, /wx:if="\{\{!showLogin\}\}" is="chat-composer"/, '独立对话登录层打开时必须卸载原生 textarea');
  assert.match(login, /if \(!open\) return;[\s\S]{0,260}wx\.hideKeyboard\(\)/, '登录层打开时必须主动收起宿主页键盘');
  assert.match(login, /chooseAvatar\(event\)[\s\S]{0,220}未取得头像，请重新选择/, '头像组件未返回临时地址时不得静默无响应');
});

test('个人设置使用微信头像昵称组件并保存到现有身份接口', () => {
  const settings = fs.readFileSync(path.join(sourceRoot, 'packages/main/settings/index.js'), 'utf8');
  const settingsWxml = fs.readFileSync(path.join(sourceRoot, 'packages/main/settings/index.wxml'), 'utf8');
  const profileWxml = fs.readFileSync(path.join(sourceRoot, 'pages/profile/index.wxml'), 'utf8');

  assert.match(settingsWxml, /<button class="avatar-row avatar-authorize" open-type="chooseAvatar" bindchooseavatar="chooseAvatar"/);
  assert.match(settingsWxml, /<input type="nickname"[^>]*bindinput="inputName"[^>]*bindblur="inputName"/);
  assert.doesNotMatch(settings, /wx\.chooseMedia\(/, '设置头像不得绕回普通相册选择器');
  assert.match(settings, /async chooseAvatar\(event\)[\s\S]{0,500}api\.uploadAvatar\(filePath\)/);
  assert.match(settings, /saveIdentity\(\)[\s\S]{0,400}api\.updateIdentity\(\{ name, company \}\)/);
  assert.match(profileWxml, /wx:if="\{\{avatarUrl\}\}"[^>]*bindtap="openIdentity"/, '已有头像也必须能点进身份设置');
});

test('只附文件或图片也能发送，客户端补自然请求而不是要求额外打字', () => {
  const helperPath = path.join(sourceRoot, 'services/chat-reply.js');
  delete cjsRequire.cache[cjsRequire.resolve(helperPath)];
  const { attachmentOnlyPrompt } = cjsRequire(helperPath);
  assert.match(attachmentOnlyPrompt([{ kind: 'knowledge', label: '经营数据.xlsx' }]), /经营数据\.xlsx/);
  assert.match(attachmentOnlyPrompt([{ kind: 'image', label: '对话图片' }]), /请看我附上的图片/);
  const nativeChat = chatSource();
  const h5Chat = fs.readFileSync(path.join(appRoot, 'src/packages/main/chat/index.tsx'), 'utf8');
  assert.match(nativeChat, /if \(!typedText && !displayRefs\.length\) return;[\s\S]*?typedText \|\| attachmentOnlyPrompt\(displayRefs\)/);
  assert.match(nativeChat, /Boolean\(text \|\| this\._refs\.length\)/);
  assert.match(h5Chat, /const v = typed \|\| attachmentOnlyPrompt\(refs\)/);
  assert.match(h5Chat, /!input\.trim\(\) && !refs\.length/);
});

test('原生聊天保持可恢复生成、完整报告闸门与动态输入区', () => {
  const chat = chatMarkup();
  const chatJs = chatSource();
  const chatScss = chatStyle();
  const reportCard = fs.readFileSync(path.join(sourceRoot, 'components/report-card/index.wxml'), 'utf8');
  const textareas = [...chat.matchAll(/<textarea\b[^>]*>/g)].map((match) => match[0]);

  assert.equal(textareas.length, 2);
  for (const textarea of textareas) {
    assert.match(textarea, /\bvalue="\{\{composerSeed\}\}"/, '两个 textarea 必须对称绑同一个一次性初值，否则交替挂载会丢字');
    assert.doesNotMatch(textarea, /\bvalue="(?!\{\{composerSeed\}\})/);
    assert.match(textarea, /\bdisabled="\{\{busy\}\}"/);
    assert.match(textarea, /\bbindlinechange="onComposerResize"/);
  }
  assert.match(chat, /wx:if="\{\{showThinking\}\}"/);
  assert.doesNotMatch(chat, /wx:if="\{\{busy\}\}" class="msg a"/, '流式气泡出现后不得再叠一条 thinking');
  assert.match(chat, /<report-card\b[^>]*\boperable="\{\{item\.reportReady\}\}"/, '页面必须把完整报告判定传给成果卡');
  assert.ok((reportCard.match(/operable&&!streaming/g) || []).length >= 4, '报告与成品图操作都只能在完整报告落库后出现');
  assert.match(chat, /wx:if="\{\{busy&&canStop\}\}"[^>]+bindtap="stopGeneration"/);
  assert.match(chat, /wx:elif="\{\{busy\}\}" class="send-btn wait"/, '无 generationId 的兼容恢复态只能等待，不能显示假停止按钮');
  assert.match(chat, /<view class="composer-box">[\s\S]*?<textarea[\s\S]*?<view class="composer-tools">[\s\S]*?class="attach-btn"[\s\S]*?class="composer-tools-right"[\s\S]*?class="send-btn/, '多行正文必须在上，附件与发送操作固定在独立底排');
  assert.match(chatScss, /\.composer-box\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*gap:\s*6px;/s);
  assert.match(chatScss, /\.composer-tools\s*\{[^}]*display:\s*flex;[^}]*justify-content:\s*space-between;/s);
  assert.doesNotMatch(chatScss, /\.(?:attach-btn|send-btn)\s*\{[^}]*position:\s*absolute;/s, '多行时两个操作不能再悬浮到正文左右');
  assert.match(chat, /item\.refNotices&&item\.refNotices\.length/);
  assert.doesNotMatch(chat, /tone="green"/, '聊天功能图标必须跟随本命色');
  assert.doesNotMatch(chat, /\{\{[^}]*\.[A-Za-z_$][\w$]*\s*\(/, 'WXML 不得调用 JS 方法');
  assert.match(chatJs, /function hasUnansweredTurn\(messages, generating\)[\s\S]*?last\.role === 'user'/, '重进会话必须识别已落库但尚未得到回答的尾部用户消息');
  assert.ok((chatJs.match(/const canRetryLast = hasUnansweredTurn/g) || []).length >= 2, '首次恢复与兼容轮询结束都要计算重试入口');
  assert.ok((chatJs.match(/errorText: canRetryLast \?/g) || []).length >= 2, '两条恢复路径都要把重试文案写回页面');
  assert.match(chat, /wx:if="\{\{canRetryLast\}\}" class="retry" bindtap="retry">重新回答/, '失败轮次必须给明确下一步，而不是重进后静默消失');

  assert.match(chatJs, /detail\.activeGeneration/);
  assert.match(chatJs, /detail\.generating[\s\S]*startSessionPolling/);
  assert.match(chatJs, /async pollSession\(sessionId, epoch, pollSeq\)/);
  assert.match(chatJs, /this\._epoch\s*\+=\s*1/);
  assert.match(chatJs, /this\._sendSeq\s*\+=\s*1/);
  assert.match(chatJs, /this\._pollSeq\s*\+=\s*1/);
  assert.match(chatJs, /if \(this\.data\.busy\) return;[\s\S]*?this\._draft = value/);
  assert.match(chatJs, /function isReportReady\(messageId, deliverable\)/);
  assert.match(chatJs, /deliverable\.degraded !== true/);
  assert.match(chatJs, /deliverable\.sections\.length > 0/);
  assert.ok((chatJs.match(/reportReady:\s*isReportReady\(/g) || []).length >= 3, '历史、流式、轮询结果必须共用报告完整性判定');
  for (const typed of ['stats', 'roster', 'table', 'phases', 'timeline', 'quote', 'letter', 'gauge', 'matrix', 'gantt']) {
    assert.match(chatJs, new RegExp(`section\\.type === '${typed}'`), `报告文本缺少 ${typed} section`);
  }
  assert.match(chatScss, /bottom:\s*calc\(var\(--composer-height\) \+ var\(--keyboard-height\)\)/);
});

test('原生对话使用固定版本开源流式 Markdown 打字机并隔离网络突发节奏', () => {
  const chatJs = chatSource();
  const chatWxml = chatMarkup();
  const chatJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'packages/main/chat/index.json'), 'utf8'));
  const vendorRoot = path.join(sourceRoot, 'packages/main/vendor/towxml');
  const upstream = fs.readFileSync(path.join(vendorRoot, 'UPSTREAM.md'), 'utf8');
  const license = fs.readFileSync(path.join(vendorRoot, 'LICENSE.txt'), 'utf8');
  const typewriterWxml = fs.readFileSync(path.join(vendorRoot, 'typable-text/typable-text.wxml'), 'utf8');

  assert.equal(chatJson.usingComponents.towxml, '/packages/main/vendor/towxml/towxml');
  assert.match(chatWxml, /<towxml[^>]+speed="6"[^>]+bindfinish="onStreamTypingFinish"/);
  assert.match(chatJs, /require\('\.\.\/vendor\/towxml\/globalCb'\)/);
  assert.match(chatJs, /setMdText\(current\.streamRenderId, text\)/);
  assert.match(chatJs, /setStreamFinish\(finished\.streamRenderId\)/);
  assert.match(chatJs, /startStreamAutoScroll\(\)[\s\S]*?setInterval\([\s\S]*?, 180\)/);
  const updateStart = chatJs.indexOf('updateStreamText(chunk, replace)');
  const updateEnd = chatJs.indexOf('\n  updateStreamReply(', updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart);
  assert.doesNotMatch(chatJs.slice(updateStart, updateEnd), /messages\[\$\{index\}\]\.text/, '每个 SSE token 不得再跨原生桥整段 setData');
  assert.match(upstream, /Version: `1\.0\.3`/);
  assert.match(upstream, /5b64114d01b58638758009b7cab819f5c391a923/);
  assert.match(license, /MIT License/);
  assert.match(typewriterWxml, /user-select="true"/);
  assert.doesNotMatch(typewriterWxml, /selectable=/);
});

test('对话核心抽到主包 chat-core，分包页只留页头与导航', () => {
  for (const file of ['behavior.js', 'message-list.wxml', 'composer.wxml', 'chat-core.scss']) {
    assert.ok(fs.existsSync(path.join(chatCoreRoot, file)), `chat-core 缺少 ${file}——上面所有聊天断言的目标就没了`);
  }
  const behavior = read(chatCoreRoot, 'behavior.js');
  const messageList = read(chatCoreRoot, 'message-list.wxml');
  const composer = read(chatCoreRoot, 'composer.wxml');
  const pageJs = read(sourceRoot, 'packages/main/chat/index.js');
  const pageWxml = read(sourceRoot, 'packages/main/chat/index.wxml');
  const pageScss = read(sourceRoot, 'packages/main/chat/index.scss');
  const chatJson = JSON.parse(read(sourceRoot, 'packages/main/chat/index.json'));

  // 分包可以引用主包，反向不行——抽取物必须干净地留在主包。
  assert.doesNotMatch(behavior.replace(/^\s*\/\/.*$/gm, ''), /require\(['"][^'"]*(?:packages\/|vendor\/)/, 'chat-core 属主包，不得反向 require 分包文件');
  assert.match(behavior, /module\.exports = \{[\s\S]*?chatCore: Behavior\(\{ data, methods \}\)/, '对话核心以 Page Behavior 形式导出');
  assert.match(behavior, /function useStreamRenderer\(next\)/, 'towxml 回调必须由宿主页注入，主包不能直接 require 分包的 globalCb');

  assert.match(pageJs, /require\('\.\.\/\.\.\/\.\.\/chat-core\/behavior'\)/);
  assert.match(pageJs, /behaviors: \[chatCore\]/, '页面通过 Page behaviors 复用对话核心');
  assert.match(pageJs, /useStreamRenderer\(\{ setMdText, setStreamFinish, stopImmediatelyCb \}\)/, '同包页负责把 towxml 打字机回调注入对话核心');
  assert.match(pageJs, /this\.chatCoreLoad\(\{[\s\S]*?continueLatest:[\s\S]*?pendingPrompt:/, '导航参数解析留在页面，只把解析结果交给对话核心');
  assert.match(pageJs, /onUnload\(\) \{ this\.chatCoreUnload\(\); \}/);
  assert.doesNotMatch(pageJs, /generateStream|absorbPasteToFile|normalizeMessage/, '对话逻辑不得在页面里留第二份');

  assert.match(pageWxml, /<import src="\/chat-core\/message-list\.wxml">/);
  assert.match(pageWxml, /<import src="\/chat-core\/composer\.wxml">/);
  assert.match(pageWxml, /<template is="chat-message-list" data="\{\{[^"]*messages[^"]*\}\}"/);
  // 教学层期间输入行整体让位（wx:if="{{!coachOn}}"），所以这里允许模板带条件渲染。
  assert.match(pageWxml, /<template (?:wx:if="[^"]+" )?is="chat-composer" data="\{\{[^"]*composerOdd[^"]*\}\}"/);
  assert.doesNotMatch(pageWxml, /<textarea\b|class="chat-stream"/, '消息流与输入区已进模板，页面只保留页头与外壳');
  assert.match(pageScss, /@use "\.\.\/\.\.\/\.\.\/chat-core\/chat-core\.scss"/);
  assert.doesNotMatch(pageScss, /\.composer-box|\.ask-card|\.paste-card/, '可共享样式已迁走，页面 SCSS 只留页面外壳');

  // 模板里绑定的每一个 handler 都必须真有同名方法，否则真机上是静默失效的死按钮。
  const hasMethod = (name) => new RegExp(`^\\s{2}(?:async\\s+)?${name}\\(`, 'm').test(behavior)
    || new RegExp(`^\\s{2}(?:async\\s+)?${name}\\(`, 'm').test(pageJs);
  const handlers = new Set([...`${messageList}\n${composer}`.matchAll(/\b(?:bind|catch)[a-z]+="([A-Za-z_$][\w$]*)"/g)].map((match) => match[1]));
  assert.ok(handlers.size >= 30, `模板事件绑定只扫到 ${handlers.size} 个，抽取可能漏了内容`);
  for (const handler of handlers) assert.ok(hasMethod(handler), `模板绑定了 ${handler}，但 chat-core/behavior.js 与宿主页都没有这个方法`);

  // 模板自己没有 json，用到的自定义组件必须由宿主页注册齐。
  const templateMarkup = `${messageList}\n${composer}`;
  const builtin = new Set(['scroll-view', 'cover-view', 'cover-image', 'rich-text', 'web-view', 'movable-view', 'picker-view']);
  const tags = new Set([...templateMarkup.matchAll(/<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g)].map((match) => match[1]));
  if (/<towxml\b/.test(templateMarkup)) tags.add('towxml');
  for (const tag of tags) {
    if (builtin.has(tag)) continue;
    assert.equal(typeof chatJson.usingComponents?.[tag], 'string', `宿主页未注册模板用到的组件：${tag}`);
  }

  // 输入铁律的静态校验必须跟着 composer 模板走，不能留在只剩页头的分包页上。
  const builder = read(appRoot, 'scripts/build-native-weapp.mjs');
  assert.match(builder, /CHAT_TEXTAREA_TARGETS = \[[^\]]*'chat-core\/composer\.wxml'/, '构建校验必须扫描 chat-core/composer.wxml');
  assert.match(builder, /CHAT_TEXTAREA_TARGETS/, '构建校验目标必须显式列表化');
  assert.match(builder, /聊天 textarea 校验目标缺失/, '校验目标文件缺失本身必须让构建失败');
  // 闸门守的是「编辑期回灌」而不是「出现 value」：白名单放行一次性初值，同时盯死 onComposerInput。
  assert.match(builder, /bound\[1\] !== '\{\{composerSeed\}\}'/, '除 composerSeed 外的 value 绑定必须让构建失败');
  assert.match(builder, /onComposerInput 不得写 composerSeed/, '编辑期回灌必须由构建闸门拦住');
  assert.match(builder, /未能定位 onComposerInput/, '定位不到就要报错，铁律检查不得随重构静默失效');
});

test('问策 tab 按 wenceForm 分形态：control 一行不动，chat 走对话即 tab 终态', () => {
  const wxml = read(sourceRoot, 'pages/sessions/index.wxml');
  const js = read(sourceRoot, 'pages/sessions/index.js');
  const scss = read(sourceRoot, 'pages/sessions/index.scss');
  const json = JSON.parse(read(sourceRoot, 'pages/sessions/index.json'));

  // —— 分形态：两棵互斥的树，control 那棵必须保留现状列表的全部关键节点 ——
  assert.match(wxml, /<view wx:if="\{\{form === 'chat'\}\}" class="wence-page/, '终态挂在 form==="chat" 上');
  assert.match(wxml, /<view wx:else class="native-page \{\{themeClass\}\} \{\{viewportClass\}\}"/, 'control 仍是原来那棵 native-page，只追加窗口档位类');
  for (const node of ['<tab-header title="问策" kicker="有事问军师" glyph="谋">', 'class="council-searchrow"', 'class="quick-row"', 'bindtap="toggleHistory"', 'class="tabbar-space"']) {
    assert.ok(wxml.includes(node), `control 形态缺少现状节点：${node}`);
  }
  // 形态未知时先按 control 画：默认值写错会把没进实验的用户扔进半成品形态。
  assert.match(js, /form: safeGet\(`\$\{FORM_CACHE_PREFIX\}[^`]*`\) === 'chat' \? 'chat' : 'control'/);
  assert.match(js, /if \(form\) return form === 'chat' \? 'chat' : 'control';/, "只认 'chat'，dock/字段缺失都落 control");
  assert.match(js, /result && result\.guestForm === 'chat'/, '游客形态读 /wence/hints 的 guestForm');

  // —— 合一页头：自绘（不是 TabHeader 实例）+ 谋印 + 身份 kicker + 双入口 ——
  assert.match(wxml, /class="wh-glyph serif">谋</, '页头保留谋印背景大字');
  assert.match(wxml, /class="wh-kicker">\{\{title\}\}\{\{alias\}\} · 在线</, 'kicker 位换成对话对象身份，花名取自 chat-core 的 ALIASES，不写死');
  assert.match(wxml, /class="wh-title serif">问策</);
  assert.match(wxml, /bindtap="openCouncil"[\s\S]{0,200}军师团/);
  assert.match(wxml, /bindtap="openHistory"[\s\S]{0,200}历史/);
  assert.match(scss, /\.wh-glyph \{[\s\S]*?font-size: 88px/, '谋印沿用 TabHeader 的原生度量');
  assert.match(scss, /\.wh-kicker \{[\s\S]*?letter-spacing: \.2em/, 'kicker 字距收紧到 .2em');
  assert.match(scss, /\.wh-title \{ font-size: 29px/);

  // —— 底部合体浮岛：composer 模板 + 分隔线 + 与 custom-tab-bar 同源的五 tab ——
  assert.match(wxml, /<import src="\/chat-core\/composer\.wxml">/);
  assert.match(wxml, /<template (?:wx:if="[^"]+" )?is="chat-composer" data="\{\{[^"]*composerOdd[^"]*\}\}"/);
  assert.match(wxml, /class="wence-isle[^"]*"[\s\S]*?class="isle-div"[\s\S]*?class="tabbar-inner"/, '浮岛顺序：输入行 → 细线 → tab 行');
  assert.match(wxml, /bindtap="switchIsleTab"/);
  assert.match(js, /require\('\.\.\/\.\.\/services\/tabbar'\)/, '浮岛 tab 与底栏共用 services/tabbar.js');
  assert.match(scss, /@use "\.\.\/\.\.\/custom-tab-bar\/index\.scss"/, '浮岛复用底栏同一份 SCSS（含图标光学校准）');
  assert.doesNotMatch(wxml, /<textarea\b/, '输入区只能来自 composer 模板，页面不得再写一份 textarea');

  // —— 提示 pill：代发 + 冷会话专属（有过 user 轮就永久收起）+ 有草稿/生成中/键盘/抽屉都不显示 ——
  assert.match(wxml, /class="wence-pill[\s\S]*?bindtap="tapHint"/);
  // 逐字匹配整串太脆（每加一个隐藏条件就红一次），改为「必须逐项出现在同一个 wx:if 里」。
  const pillIf = (wxml.match(/wx:if="\{\{hintText[^"]*\}\}"/) || [''])[0];
  for (const cond of ['hintText', '!chipsSpent', '!coachOn', '!drawerOpen', '!busy', '!inputCount', '!keyboardHeight']) {
    assert.ok(pillIf.includes(cond), `pill 隐藏条件缺少 ${cond}（必须写在 WXML 表达式里，不靠 JS 同步）`);
  }
  // pill 只降低「首次开口」门槛：判据必须与 chips 同源（chat-core 的 chipsSpent = 本会话有无 user 轮），
  // 不许另造一套「点过了」的标记，否则老用户带历史会话进来还会看到它。
  assert.match(js, /this\.data\.form !== 'chat' \|\| this\.data\.chipsSpent/, '轮播启动前先看 chipsSpent');
  assert.match(js, /if \(this\.data\.chipsSpent\) \{ this\.stopHintRotation\(\); return; \}/, '会话中途开口后停轮播');
  assert.match(js, /this\.sendText\(text, 'hint'\)/, '点 pill = 直接代发（textarea 铁律禁止程序化回填）');
  assert.match(js, /localHints\(\)/, '词池为空或拉取失败回退本地兜底池');

  // —— 抽屉：双入口同一抽屉、分段互切、复用跨域搜索 ——
  assert.match(wxml, /data-seg="council"[\s\S]*?data-seg="history"/);
  assert.match(wxml, /class="wd-body"/);
  assert.match(scss, /\.wd-body \{ height: 46vh/, '半屏层的滚动区必须是带明确高度的 ScrollView（§7.2 真机滑不动）');
  assert.match(js, /openCouncil\(\) \{ this\.openDrawer\('council'\); \}/);
  assert.match(js, /if \(seg === 'history' && !this\.requireLogin\('history'\)\) return;/, '游客翻历史走动作级登录门');
  assert.match(js, /api\.search\(query\)/, '抽屉搜索复用现有跨域搜索');

  // —— overlay 成对：浮岛与抽屉各自 setOverlay(true/false)，切 tab 前先释放 ——
  for (const key of ['wence-isle', 'wence-drawer']) {
    assert.ok(new RegExp(`setOverlay\\(true, '${key}'\\)`).test(js), `${key} 缺少 setOverlay(true)`);
    assert.ok(new RegExp(`setOverlay\\(false, '${key}'\\)`).test(js), `${key} 缺少成对的 setOverlay(false)`);
  }
  assert.match(js, /onHide\(\) \{[\s\S]*?setOverlay\(false, 'wence-isle'\)[\s\S]*?setOverlay\(false, 'wence-drawer'\)/, '离开 tab 必须放开底栏');
  assert.match(js, /setOverlay\(false, 'wence-isle'\);[\s\S]{0,120}(?:gotoExecution|wx\.switchTab)/, '切走前先释放 overlay，别让下一个 tab 没有底栏');

  // —— 未读三层引导链 ——
  assert.match(wxml, /index === 0 && unread > 0[\s\S]*?class="tab-badge"/, '① 浮岛问策角标 = 全会话聚合');
  assert.match(wxml, /councilUnreadText[\s\S]*?class="unread wh-entry-badge"/, '② 军师团按钮聚合角标');
  // 2026-08-14：② 拆成两个入口各管自己那批。原断言钉的是「除 general 外全算军师团」——
  // 而军师团抽屉只渲染 type!=='creative' 的军师，海报设计师那类会话的未读被算进去后，
  // 用户点进抽屉根本找不到那一行，角标只能一直亮着。现在按「点进去看得见」分。
  assert.match(js, /advisorKeys = new Set\(\(rows \|\| \[\]\)/, '② 军师团聚合必须用抽屉同源的 rows');
  assert.match(js, /advisorKeys\.has\(item\.agentKey\)/, '② 军师团只算抽屉里真有的那几行');
  assert.match(js, /!advisorKeys\.has\(item\.agentKey\)/, '② 其余（创意军师）归历史');
  assert.match(wxml, /historyUnreadText[\s\S]*?class="unread wh-entry-badge"/, '② 历史入口也要有角标');
  assert.match(js, /markGeneralRead\(\)/, '装载 general 会话后本地掉掉这份未读');
  assert.match(wxml, /class="wx-id"[\s\S]*?class="unread"/, '③ 抽屉行内各自角标');

  // —— 抽屉历史行版式：主行=会话标题、辅行=花名·时间、第三行=摘要（control 那棵树一个字不动） ——
  assert.match(wxml, /class="wx-item wd-item"[\s\S]{0,400}class="wd-title serif">\{\{item\.title\}\}/, '历史行主行是会话标题');
  assert.match(wxml, /class="wd-meta">\{\{item\.metaText\}\}/, '辅行=军师花名 · 相对时间');
  assert.match(wxml, /class="wd-snippet">\{\{item\.snippet\}\}/, '第三行=摘要');
  assert.match(js, /metaText: `\$\{alias \|\| item\.agentName\} · \$\{timeText\}`/, '花名缺失退回本名，别出现孤零零的「· 3 天前」');
  assert.match(js, /preview: `\$\{item\.title\} · \$\{item\.snippet\}`/, 'control 形态仍读 preview，字段不许删');
  for (const cls of ['.wd-title', '.wd-meta', '.wd-snippet']) {
    assert.match(scss, new RegExp(`\\${cls} \\{[\\s\\S]*?text-overflow: ellipsis;`), `${cls} 必须单行省略（抽屉 46vh 固定高，换行会把可见条数压掉一半）`);
  }
  // control 形态那棵树的历史行保持原样：军师名主行 + preview 双行摘要。
  const controlTree = wxml.slice(wxml.indexOf('<view wx:else class="native-page'));
  assert.match(controlTree, /class="wx-name">\{\{item\.agentName\}\}<\/text><text class="wx-alias">\{\{item\.alias\}\}/, 'control 历史行保持军师名主行');
  assert.match(controlTree, /class="wx-preview">\{\{item\.preview\}\}/, 'control 历史行仍是 preview 双行摘要');

  // —— towxml 跨包异步接线：componentPlaceholder + 先注入回调再装载会话 ——
  assert.equal(json.usingComponents.towxml, '/packages/main/vendor/towxml/towxml');
  assert.equal(json.componentPlaceholder?.towxml, 'view', '跨分包引用必须配 componentPlaceholder，否则主包页面根本引不到');
  assert.equal(json.usingComponents['markdown-text'], '/components/markdown-text/index');
  assert.equal(json.usingComponents['report-card'], '/components/report-card/index');
  assert.match(js, /require\.async\('\.\.\/\.\.\/packages\/main\/vendor\/towxml\/globalCb\.js'\)[\s\S]*?useStreamRenderer\(mod\)/);
  assert.match(js, /this\._streamReady = this\.setupStreamRenderer\(\);/);
  assert.match(js, /await this\._streamReady;[\s\S]*?chatCoreLoad/, '★ 必须先注入流式回调再 chatCoreLoad，否则首轮流式打进 no-op');
  assert.match(js, /\.catch\(\(\) => false\)/, 'require.async 失败要兜底，不许白屏');

  // —— 会话装载分支：续接 / 注入主动消息 / greet 空会话 / 游客本地开场 ——
  // 闲置 >24h 只视觉分章，底层仍续接同一 Session；有未读时不额外插空分隔。
  assert.match(js, /const SESSION_IDLE_HOURS = 24;/, '阈值必须是页面顶部的具名常量，不许散在判断里');
  assert.match(js, /function shouldStartNewChapter\(item\) \{[\s\S]*?if \(Number\(item\.unreadCount\) > 0\) return false;/, '有未读时不插空分章');
  assert.match(js, /idleMs > SESSION_IDLE_HOURS \* 3600 \* 1000/);
  assert.match(js, /conversationContinuity === false/, '必须保留服务端下发的连续主线逃生开关');
  assert.match(js, /if \(latest && !continuityEnabled && shouldStartNewChapter\(latest\)\) \{[\s\S]{0,180}chatCoreLoad\(\{ agentKey: 'general' \}\)/, '关闭开关时跨 24h 回退为带交接包的新 Session');
  assert.match(js, /if \(latest\) \{[\s\S]{0,220}chatCoreLoad\(\{ sessionId: latest\.id, startNewChapter: shouldStartNewChapter\(latest\) \}\)/, '开关正常时无论闲置多久都续接同一主线');
  // 分章只在冷进（bootChat）判：refreshChat 是切 tab 回来，不得跨整点突然插分隔。
  assert.match(js, /async refreshChat\(\) \{[\s\S]*?\n  \},/, 'refreshChat 存在');
  assert.doesNotMatch(js.slice(js.indexOf('async refreshChat()'), js.indexOf('async fetchSessions()')), /shouldStartNewChapter/, 'refreshChat 不得做分章判定');
  assert.match(js, /api\.proactiveSession\(\)/);
  assert.match(read(chatCoreRoot, 'behavior.js'), /function decorateChapters\(messages\)/, '历史分章必须由真实消息时间可重算');
  assert.match(read(chatCoreRoot, 'message-list.wxml'), /item\.newChapter[\s\S]*?class="chapter-divider"/, '分隔挂在消息前，不创建假消息');
  const behavior = read(chatCoreRoot, 'behavior.js');
  const mock = read(sourceRoot, 'services/mock.js');
  assert.match(behavior, /maxImagesPerMessage\) \|\| 9/, '旧服务端缺能力字段时，原生端必须保守兜底 9 张');
  assert.match(behavior, /wx\.chooseMedia\(\{ count,/, '选图数量必须使用运行时能力计算后的 count，不得写死 4');
  assert.match(mock, /maxAttachmentsPerMessage: 9, maxImagesPerMessage: 9, maxImagesPerBatch: 4/, 'mock 与生产附件能力口径必须一致');
  assert.match(js, /this\.chatCoreLoad\(\{ agentKey: 'general' \}\)/, 'injected:false 三种原因都走 greet 空会话');
  assert.match(js, /this\.chatCoreLoad\(\{ agentKey: 'general', localPrelude: GUEST_PRELUDE \}\)/, '游客走本地开场序列，零服务端写入');
  assert.match(js, /if \(force \|\| changed \|\| !this\._chatBooted\) await this\.bootChat\(\);\s*\n\s*else await this\.refreshChat\(\);/, '切走再切回不重复装载/不重复注入');

  // —— 登录门不得吞掉已写好的话 ——
  assert.match(js, /const draft = this\._draft \|\| '';[\s\S]*?await this\.boot\(true\);[\s\S]*?this\._draft = draft;/);

  // —— 输入铁律的构建校验必须把新宿主页也扫进去（§7.2 新义务）——
  const builder = read(appRoot, 'scripts/build-native-weapp.mjs');
  assert.match(builder, /CHAT_TEXTAREA_TARGETS = \[[^\]]*'pages\/sessions\/index\.wxml'/, '新的 composer 宿主页必须进 CHAT_TEXTAREA_TARGETS');

  // —— z 轴写字面量并注明层级 ——
  assert.match(scss, /z-index: 100; \/\* --z-nav/);
  assert.match(scss, /z-index: 900; \/\* --z-sheet/);
});

test('问策终态埋点：全部经静默 track，401 不得打断用户', () => {
  const js = read(sourceRoot, 'pages/sessions/index.js');
  const behavior = read(chatCoreRoot, 'behavior.js');
  const apiSource = read(sourceRoot, 'services/api.js');

  for (const [name, where] of [
    ['wence_enter', js], ['proactive_show', js], ['chip_tap', js], ['hint_tap', js],
    ['first_message_send', js], ['drawer_open', js], ['attach_open', js], ['tab_switch', js],
  ]) {
    assert.ok(where.includes(`'${name}'`), `缺少埋点位 ${name}`);
  }
  assert.match(js, /const userState = !authed \? 'guest' : \(\(this\._sessions \|\| \[\]\)\.length \? 'returning' : 'new'\);/);
  assert.match(js, /api\.track\('wence_enter', \{ form, user_state: userState \}\)/);
  assert.match(js, /ttfm_ms: this\._enterAt \? Math\.max\(0, Date\.now\(\) - this\._enterAt\) : 0/);
  assert.match(js, /entry: entry \|\| 'keyboard'/);
  assert.match(js, /if \(safeGet\(key\) === '1'\) return;/, 'first_message_send 按账号只发一次');

  // chat-core 只发事件，不认识埋点；映射与上报都在宿主页（chat 分包页不实现 = 不埋点）。
  assert.match(behavior, /emitChatEvent\(name, props\) \{[\s\S]*?typeof this\.chatCoreEvent !== 'function'/);
  assert.doesNotMatch(behavior, /api\.track\(/, '对话核心不得直接埋点');
  assert.match(behavior, /this\.emitChatEvent\('send', \{ entry: this\._sendEntry \|\| 'keyboard' \} \);|this\.emitChatEvent\('send', \{ entry: this\._sendEntry \|\| 'keyboard' \}\);/);

  // ★ track 必须绕开 request()：那条路径上带 token 的 401 会清登录态 + reLaunch。
  const trackBlock = apiSource.match(/track: \(name, props\) => \{[\s\S]*?\n  \},/);
  assert.ok(trackBlock, 'api 缺少 track');
  // 只禁裸 request(（services/request.js 的封装），wx.request 正是这里要走的那条静默路径。
  assert.doesNotMatch(trackBlock[0], /(^|[^.\w])request\(/m, '埋点不得走 request()，否则一条统计请求能把用户踢出登录');
  assert.match(trackBlock[0], /wx\.request\(/);
  assert.match(trackBlock[0], /fail\(\) \{/, '埋点失败必须静默');
  assert.doesNotMatch(trackBlock[0], /showToast/, '埋点绝不 toast');
});

test('快捷回应 chips：服务端字段直达消息、点击即代发、用户开口后作废', () => {
  const behavior = read(chatCoreRoot, 'behavior.js');
  const messageList = read(chatCoreRoot, 'message-list.wxml');
  const style = read(chatCoreRoot, 'chat-core.scss');
  const chatWxml = read(sourceRoot, 'packages/main/chat/index.wxml');
  const sessionsWxml = read(sourceRoot, 'pages/sessions/index.wxml');

  assert.match(behavior, /chips: stringList\(message && message\.chips\)/, 'normalizeMessage 把 SessionMessage.chips 带进消息对象');
  assert.match(behavior, /function chipsSpentFor\(messages\) \{[\s\S]*?role === 'user'/, '有 user 轮就作废：重进会话也能自然收敛');
  assert.match(behavior, /chipsSpent: chipsSpentFor\(messages\)/);
  assert.match(behavior, /pastePreview: null, chipsSpent: true/, '手动发送后整排消失');
  assert.match(behavior, /this\.sendText\(chip, 'chip'\)/);
  assert.match(behavior, /if \(this\.hasDraft\(\)\) \{ wx\.showToast/, '有草稿时不许被 chip 静默覆盖');

  assert.match(messageList, /wx:if="\{\{!chipsSpent&&item\.chips&&item\.chips\.length\}\}"[\s\S]*?bindtap="tapChip"/);
  assert.match(style, /\.chip \{[\s\S]*?border-radius: 999px/);
  assert.doesNotMatch(style, /\.chip \{[\s\S]*?rgba\(22, ?63, ?48/, 'chip 边框用 token（--accent-glow），不落原型里的字面量');
  // 两个宿主页都要把 chipsSpent 传进模板，否则 chips 永远不消失。
  for (const [label, source] of [['chat 分包页', chatWxml], ['问策 tab', sessionsWxml]]) {
    assert.match(source, /<template is="chat-message-list" data="\{\{[^"]*chipsSpent[^"]*\}\}"/, `${label} 未把 chipsSpent 传进消息流模板`);
  }
});

test('原生 mock 问策终态：主动消息按账号注入一次、读详情清未读', async () => {
  const values = new Map([['junshi.userId', 'mock-wence-a']]);
  globalThis.wx = {
    getStorageSync: (key) => values.get(key) ?? '',
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
  };
  try {
    const require = createRequire(import.meta.url);
    const mockPath = path.join(sourceRoot, 'services/mock.js');
    delete require.cache[require.resolve(mockPath)];
    const mock = require(mockPath);

    // mock 包默认展示终态，方便本地走查
    assert.equal((await mock.me()).features.wenceForm, 'chat');
    const hints = await mock.wenceHints();
    assert.equal(hints.guestForm, 'chat');
    assert.ok(hints.hints.length > 1 && hints.hints.every((item) => item.id && item.text));
    assert.deepEqual(await mock.track('wence_enter', {}), { ok: true });

    const first = await mock.proactiveSession();
    assert.equal(first.injected, true);
    const list = await mock.sessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].agentKey, 'general');
    assert.equal(list[0].unreadCount, 1, '注入后未读必须亮起来');

    // 频控幂等：再调一次只回 exists，不会造出第二条会话
    assert.deepEqual(await mock.proactiveSession(), { injected: false, reason: 'exists' });
    assert.equal((await mock.sessions()).length, 1);

    // 读详情 = 服务端写 lastReadAt：未读归零且刷新后可见
    const detail = await mock.session(first.sessionId);
    assert.deepEqual(detail.messages[0].chips.length > 0, true, '主动消息带 chips');
    assert.equal((await mock.sessions())[0].unreadCount, 0);

    // 账号隔离：换个号还是可注入，切回来仍是 exists
    values.set('junshi.userId', 'mock-wence-b');
    assert.equal((await mock.sessions()).length, 0);
    assert.equal((await mock.proactiveSession()).injected, true);
    values.set('junshi.userId', 'mock-wence-a');
    assert.deepEqual(await mock.proactiveSession(), { injected: false, reason: 'exists' });
  } finally {
    delete globalThis.wx;
  }
});

test('除微信官方品牌图形外，功能图标统一通过 Lucide 组件输出', () => {
  const wxmlFiles = walk(sourceRoot).filter((file) => file.endsWith('.wxml'));
  const forbiddenGlyphs = /[‹›⌕＋↑←×✕✓■⌄⌃⌁→↻⌂◆☰▾⚠⚡✦★●○]/;
  for (const file of wxmlFiles) {
    const source = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(source, forbiddenGlyphs, `仍有手写符号图标：${path.relative(sourceRoot, file)}`);
    assert.doesNotMatch(source, /<native-icon\b[^>]*\bcolorKey\s*=/, `native-icon 主题属性必须使用 color-key：${path.relative(sourceRoot, file)}`);
    if (!source.includes('<native-icon')) continue;
    if (file.includes(`${path.sep}templates${path.sep}`)) continue;
    const json = file.replace(/\.wxml$/, '.json');
    // WXML 模板库（chat-core/*.wxml）没有自己的 json，组件由宿主页注册；
    // 宿主页确实注册齐了由下方「对话核心抽到主包」一测逐个标签核对。
    if (!fs.existsSync(json) && /<template\s+name=/.test(source)) continue;
    const config = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.equal(config.usingComponents?.['native-icon'], '/components/native-icon/index', `未注册 native-icon：${path.relative(sourceRoot, file)}`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies?.['lucide-static'], '1.27.0');

  const iconSource = fs.readFileSync(path.join(appRoot, 'src/components/Icon/index.tsx'), 'utf8');
  assert.match(iconSource, /conversation:\s*'<path d=\"M16 10[\s\S]*?M20 9/, 'H5 问策须使用 Lucide messages-square 双对话气泡路径');
  assert.doesNotMatch(iconSource, /\bhat:\s*\{|const FILLED/, '问策不再保留自绘军师帽素材');

  const builder = fs.readFileSync(path.join(appRoot, 'scripts/build-native-weapp.mjs'), 'utf8');
  const mapBlock = builder.match(/const LUCIDE_ICON_MAP = \{([\s\S]*?)\n\};/);
  assert.ok(mapBlock, '构建器缺少 Lucide 语义映射');
  const mapped = new Set([...mapBlock[1].matchAll(/^\s*([A-Za-z0-9_]+):/gm)].map((match) => match[1]));
  for (const file of wxmlFiles) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/<native-icon[^>]*\bname="([^"{]+)"/g)) {
      assert.ok(mapped.has(match[1]), `Lucide 映射缺失 ${match[1]}：${path.relative(sourceRoot, file)}`);
    }
  }
  // tab 表已抽到 services/tabbar.js（底栏与问策浮岛同源），断言跟着真源走。
  const tabTable = fs.readFileSync(path.join(sourceRoot, 'services/tabbar.js'), 'utf8');
  // 底栏五图标 2026-08-09 起为自绘新键（counsel/sandtable/muster/brocade/lord），
  // 不再经 LUCIDE 映射；其余 native-icon 名仍必须映射齐全（上面的循环）。
  // 2026-08-18 IA 回归：战局沿用沙盘旗台，执行用打勾名册，锦囊降为普通页。
  assert.match(tabTable, /pages\/sessions\/index', icon: 'counsel'/);
  assert.match(tabTable, /icon: 'sandtable', text: '战局'/);
  assert.match(tabTable, /pages\/execution\/index', icon: 'muster', text: '今日'/);
  assert.match(tabTable, /pages\/thinktank\/index', icon: 'codex', text: '图籍'/);
  assert.match(iconSource, /^  codex: '<rect /m, '图籍书册字形必须在 H5 Icon 的 PATHS 里（构建期抽取，抽不到即构建失败）');
  assert.ok(builder.includes("'lord', 'codex'"), 'codex 必须登记进 CUSTOM_TAB_ICONS，否则不发射主题态 SVG');
  assert.match(tabTable, /icon: 'lord', text: '主公'/);
  const nativeTabs = fs.readFileSync(path.join(sourceRoot, 'custom-tab-bar/index.js'), 'utf8');
  assert.match(nativeTabs, /require\('\.\.\/services\/tabbar'\)/, '底栏不得再自留一份 tab 表');
  assert.doesNotMatch(nativeTabs, /const TABS = \[/, 'tab 表只允许存在于 services/tabbar.js');
  assert.match(builder, /conversation:\s*'messages-square'/);
  assert.doesNotMatch(builder, /readCustomHat|hat-\$\{tone\}/, '原生构建不应继续生成废弃的自绘帽子资源');
});

test('原生方案卡折扣展示：文案全在 JS 预计算，WXML 不碰价格算术', () => {
  const plans = fs.readFileSync(path.join(sourceRoot, 'packages/work/plans/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(sourceRoot, 'packages/work/plans/index.wxml'), 'utf8');
  const style = fs.readFileSync(path.join(sourceRoot, 'packages/work/plans/index.scss'), 'utf8');

  // 折扣率/立省/截止一律用服务端下发的 promotion 字段拼装，端上不按价格自己算——
  // 一旦端上重算，就会出现「小程序显示 1 折、下单扣原价」这类真金白银的不一致。
  assert.match(plans, /function promoView\(plan\)/, '缺少折扣视图预计算');
  assert.match(plans, /discountLabel: promo\.discountLabel/, '折扣率必须用服务端下发的，不得端上计算');
  assert.doesNotMatch(plans, /promo\.listPrice\s*-\s*promo\.price/, '立省金额用服务端 savedFen，不得端上相减');
  assert.doesNotMatch(plans, /promo\.price\s*\/\s*promo\.listPrice/, '折扣率不得端上计算');

  // WXML 不能调函数：所有文案必须是 normalizeOption/quote 里算好的字段
  for (const field of ['promo.discountLabel', 'promo.kickerText', 'promo.listPriceText', 'promo.saveText', 'promo.deadlineText', 'priceUnitText']) {
    assert.ok(wxml.includes(`{{item.${field}}}`) || wxml.includes(`{{quote.${field}}}`) || wxml.includes(field), `WXML 应直接渲染预计算字段 ${field}`);
  }
  assert.doesNotMatch(wxml, /\{\{[^}]*(listPrice|savedFen)\s*[-/*][^}]*\}\}/, 'WXML 里不得出现价格算术');
  assert.match(wxml, /class="plan-option \{\{item\.promo\?'promo':''\}\}"/, '优惠档要能整卡提色');
  assert.match(wxml, /quote-line promo/, '确认弹层要单列折扣行');

  // 周期 tab 按实际配出来的档决定：只配年付时不该出现一个点进去空着的月付 tab。
  // 判定复用同一个 filter，避免「可选周期」与「实际展示」两套规则漂移。
  assert.match(plans, /periodTabs: periods\.map/, '周期 tab 必须预计算（WXML 不能调函数）');
  assert.match(plans, /showPeriodSwitch: periods\.length > 1/, '只剩一种周期时切换器要整个收起');
  assert.match(plans, /periods\.length && periods\.indexOf\(this\.data\.period\) < 0 \? periods\[0\]/, '选中周期没货时要落到有货的周期');
  assert.match(wxml, /wx:if="\{\{showPeriodSwitch\}\}"[\s\S]{0,120}wx:for="\{\{periodTabs\}\}"/, '切换器要按预计算的 tab 渲染');
  assert.doesNotMatch(wxml, /data-period="month"|data-period="year"/, '不得再写死两个周期 tab');

  // 促销色必须跟随本命色（6 套主题）；写死红色会在其中 5 套里显脏
  assert.match(style, /\.promo-badge[^}]*background:\s*var\(--accent\)/, '折扣角标必须用本命色 token');
  const promoStyles = style.split('/* —— 价格区')[1] || '';
  assert.ok(promoStyles, '促销样式块应存在');
  assert.doesNotMatch(promoStyles, /background:\s*#(?!fff\b)[0-9a-fA-F]{3,8}/, '促销底色不得写死非白色 hex（本命色 6 套主题）');
});

test('原生方案继续支付、到账提示、自动续费关闭与离线登录不回归', () => {
  const plans = fs.readFileSync(path.join(sourceRoot, 'packages/work/plans/index.js'), 'utf8');
  const plansWxml = fs.readFileSync(path.join(sourceRoot, 'packages/work/plans/index.wxml'), 'utf8');
  const credits = fs.readFileSync(path.join(sourceRoot, 'packages/work/credits/index.js'), 'utf8');
  const login = fs.readFileSync(path.join(sourceRoot, 'components/login-sheet/index.js'), 'utf8');
  const knowledgeDetail = fs.readFileSync(path.join(sourceRoot, 'packages/work/knowledge/detail/index.js'), 'utf8');
  const thinktank = fs.readFileSync(path.join(sourceRoot, 'pages/thinktank/index.js'), 'utf8');
  const mock = fs.readFileSync(path.join(sourceRoot, 'services/mock.js'), 'utf8');

  const continuePayment = plans.match(/async continuePayment\(pendingOrder\) \{[\s\S]*?\n  \},\n\n  async confirmPay/);
  assert.ok(continuePayment, '方案页缺少 pendingOrder 继续支付实现');
  assert.match(plans, /option\.action === 'continue_payment'[\s\S]{0,180}this\.continuePayment\(option\.pendingOrder\)/);
  assert.match(continuePayment[0], /api\.orderPayParams\(outTradeNo\)/);
  assert.doesNotMatch(continuePayment[0], /quotePlan|createOrder|createContractOrder/, '继续支付不得重新报价或创建订单');
  assert.match(plans, /api\.cancelPlanSubscription\(subscription\.id\)/);
  assert.match(plansWxml, /bindtap="cancelAutoRenew"/);
  assert.match(plans, /if \(state === 'applied'\) return \{ title: appliedTitle/);
  assert.match(plans, /return 'pending';\n  \},\n\n  async cancelAutoRenew/);
  assert.doesNotMatch(plans.match(/async waitApplied\(outTradeNo\) \{[\s\S]*?\n  \},\n\n  async cancelAutoRenew/)[0], /showToast|方案已更新/, '轮询超时不得自行提示权益已更新');

  const repay = credits.match(/async repay\(event\) \{[\s\S]*?\n  \},\n  waitApplied/);
  assert.ok(repay, '算力页缺少继续支付实现');
  assert.match(repay[0], /const state = await this\.waitApplied\(outTradeNo\)/);
  assert.match(repay[0], /if \(state === 'applied'\)[\s\S]*?支付成功，权益已更新/);
  assert.match(repay[0], /支付结果待确认，请稍后刷新订单状态/);
  // 到账轮询已抽到 services/packs（方案页与算力明细页共用一份，避免两处各写各的）。
  // 这条要守的还是老规矩：轮询超时只回 pending，不许在超时分支里冒充「已到账」。
  const packs = fs.readFileSync(path.join(sourceRoot, 'services/packs.js'), 'utf8');
  const poll = packs.match(/function waitApplied\(outTradeNo\) \{[\s\S]*?\n\}/);
  assert.ok(poll, '共用模块缺少到账轮询');
  assert.match(poll[0], /return 'pending';/);
  assert.doesNotMatch(poll[0], /showToast|已到账/, '轮询超时不得自行提示到账');

  assert.match(login, /code === 'NETWORK_ERROR'/);
  assert.match(login, /token: `local-\$\{this\.data\.phone\}`/);
  assert.match(login, /else \{\n          wx\.showToast\(\{ title: error\.message \|\| '登录失败，请重试'/, '非网络错误不得伪造本地登录');
  assert.match(login, /profile: '登录后才能查看和维护你的个人档案。'/);
  assert.match(login, /'view-history': '登录后才能查看只属于你的历史记录。'/);

  assert.match(knowledgeDetail, /const state = order\.appliedAt \? 'applied' : await this\.waitPaymentApplied\(order\.orderId\)/);
  assert.match(knowledgeDetail, /if \(state === 'applied'\)[\s\S]*?setTimeout\(\(\) => this\.analyze\(\), 0\)/);
  assert.match(knowledgeDetail, /else if \(state === 'failed'\)[\s\S]*?支付结果待确认/);
  assert.match(thinktank, /const state=order\.appliedAt\?'applied':await this\.waitSkuApplied\(outTradeNo\)/);
  assert.match(thinktank, /if\(state==='applied'\)\{[\s\S]*?if\(after\)await after\(\)/);
  assert.match(thinktank, /else if\(state==='failed'\)[\s\S]*?支付结果待确认/);

  assert.match(mock, /function currentMockPlan\(\)[\s\S]*?storageKey\('plan'\)/);
  assert.match(mock, /function me\(\)[\s\S]*?const plan = currentMockPlan\(\)[\s\S]*?\n    plan,/);
  assert.match(mock, /function planOptions\(\)[\s\S]*?currentPlanId: current \? current\.id : ''/);
});

test('原生会话恢复专项军师启用层，方案过期口径不回归', () => {
  const sessions = fs.readFileSync(path.join(sourceRoot, 'pages/sessions/index.js'), 'utf8');
  const sessionsWxml = fs.readFileSync(path.join(sourceRoot, 'pages/sessions/index.wxml'), 'utf8');
  const sessionsJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'pages/sessions/index.json'), 'utf8'));
  const unlock = fs.readFileSync(path.join(sourceRoot, 'components/agent-unlock/index.js'), 'utf8');
  const unlockWxml = fs.readFileSync(path.join(sourceRoot, 'components/agent-unlock/index.wxml'), 'utf8');
  const plans = fs.readFileSync(path.join(sourceRoot, 'packages/work/plans/index.js'), 'utf8');
  const plansWxml = fs.readFileSync(path.join(sourceRoot, 'packages/work/plans/index.wxml'), 'utf8');
  const api = fs.readFileSync(path.join(sourceRoot, 'services/api.js'), 'utf8');
  const mock = fs.readFileSync(path.join(sourceRoot, 'services/mock.js'), 'utf8');

  assert.equal(sessionsJson.usingComponents?.['agent-unlock'], '/components/agent-unlock/index');
  assert.match(sessionsWxml, /<agent-unlock agent="\{\{unlockAgent\}\}"[^>]*bindunlocked="agentUnlocked"/);
  assert.match(sessions, /locked: Boolean\(authed && agent\.billing === 'unlock' && !agent\.owned\)/, '游客不应显示锁态或被拦截');
  assert.match(sessions, /row && row\.locked\) \{ this\.setData\(\{ unlockAgent: row \}\)/);
  assert.match(sessions, /agentUnlocked\(event\)[\s\S]*?agentKey=\$\{agent\.key\}&continue=1/);
  assert.match(unlock, /api\.purchaseAgent\(agent\.key/);
  assert.match(unlock, /Promise\.all\(\[store\.loadAgents\(\), store\.loadMe\(\)\]\)/);
  // 2026-08「确认即启用」：启用动作本身不收费，启用层不得再出现价格卡、余额与余额不足分支。
  assert.doesNotMatch(unlock, /权益点不足/, '启用不收费，不该再有余额不足分支');
  assert.doesNotMatch(unlock, /priceText|balanceText|enough/, '启用层不再读价格/余额');
  assert.match(unlockWxml, /name="spark"/);
  assert.doesNotMatch(unlockWxml, /name="diamond"|启用所需|我的余额/, '启用弹层不得展示启用价格与余额');
  assert.match(unlockWxml, /'确认启用'/, '主按钮改为纯确认');
  assert.match(api, /purchaseAgent:[\s\S]{0,120}mock\.purchaseAgent\(key, attribution\)/);
  assert.match(mock, /storageKey\('ownedAgents'\)/);
  assert.match(mock, /storageKey\('creditBalance'\)/);
  assert.match(mock, /DEFAULT_AGENTS, agents, purchaseAgent,/);

  assert.match(plans, /function isPlanExpired\(value\)/);
  assert.match(plans, /expired: plan\.id === currentId && isPlanExpired\(option\.expiresAt\)/);
  assert.match(plansWxml, /\{\{current\.expired\?'已到期':'使用中'\}\}/);
  assert.match(plansWxml, /<block wx:else>[\s\S]*?usage&&!usage\.unlimited[\s\S]*?subscription/);
});

test('问策提示 pill 不在时不留空栏：预留高度与 pill 的显示判据必须逐字同源', () => {
  const wxml = read(sourceRoot, 'pages/sessions/index.wxml');
  const scss = fs.readFileSync(path.join(sourceRoot, 'pages/sessions/index.scss'), 'utf8');

  // pill 是 fixed 定位、不占布局，滚动区那 36px 只能按需预留。判据写两处（scroll 的 class 与
  // pill 的 wx:if），必须完全一致——否则会出现「pill 没了、空栏还在」或反过来压住最后一条消息。
  const expr = "hintText && !chipsSpent && !coachOn && !drawerOpen && !busy && !inputCount && !keyboardHeight";
  assert.ok(wxml.includes(`class="wence-scroll {{coachOn ? 'coach-lift' : ''}} {{${expr} ? 'pill-on' : ''}}"`), '滚动区必须按同一判据加 pill-on');
  assert.ok(wxml.includes(`<view wx:if="{{${expr}}}" class="wence-pill`), 'pill 的 wx:if 必须是同一串判据');
  assert.match(scss, /\.wence-scroll \{[^}]*\+ 85px/s, '默认下沿只让开浮岛本体');
  assert.match(scss, /\.wence-scroll\.pill-on \{[^}]*\+ 121px/s, 'pill 在时才补那一档');
});

test('一级 tab 页面底部渐隐遮罩必须存在且不吞点击', () => {
  const appStyle = fs.readFileSync(path.join(sourceRoot, 'app.scss'), 'utf8');
  assert.match(appStyle, /\.native-bottom-fade \{[^}]*pointer-events: none;/s, '渐隐层必须放行点击，否则吞掉底部卡片');
  for (const page of ['pages/home', 'pages/execution', 'pages/thinktank']) {
    assert.match(read(sourceRoot, `${page}/index.wxml`), /<view class="native-bottom-fade"><\/view>/, `${page} 缺底部渐隐`);
  }
  // 开发环境角标在 mock 时仍是数据档案开关，必须可点（历史上 pointer-events:none 且钉在状态栏下，等于假按钮）。
  assert.doesNotMatch(appStyle, /\.native-env-badge \{[^}]*pointer-events: none;/s, '开发环境角标不得禁用点击');
  assert.match(appStyle, /\.native-env-badge \{[^}]*bottom: calc\(env\(safe-area-inset-bottom\) \+ 88px\)/s, '开发环境角标必须落在底栏上方的可点区');
});

test('IA 回归后：战局只判断，军令主链路在执行，锦囊降普通页', () => {
  const studio = fs.readFileSync(path.join(sourceRoot, 'pages/studio/index.js'), 'utf8');
  const home = fs.readFileSync(path.join(sourceRoot, 'pages/home/index.js'), 'utf8');
  const homeWxml = fs.readFileSync(path.join(sourceRoot, 'pages/home/index.wxml'), 'utf8');
  const execution = fs.readFileSync(path.join(sourceRoot, 'pages/execution/index.js'), 'utf8');
  const executionWxml = fs.readFileSync(path.join(sourceRoot, 'pages/execution/index.wxml'), 'utf8');
  const executionScss = fs.readFileSync(path.join(sourceRoot, 'pages/execution/index.scss'), 'utf8');
  const pouch = fs.readFileSync(path.join(sourceRoot, 'pages/pouch/index.js'), 'utf8');
  const pouchWxml = fs.readFileSync(path.join(sourceRoot, 'pages/pouch/index.wxml'), 'utf8');
  const api = fs.readFileSync(path.join(sourceRoot, 'services/api.js'), 'utf8');
  const mock = fs.readFileSync(path.join(sourceRoot, 'services/mock.js'), 'utf8');

  // studio = 纯跳转壳：不得残留业务逻辑，跳转必须指执行。
  assert.match(studio, /gotoExecution\('today'\)/, 'studio 过渡页必须跳执行');
  assert.doesNotMatch(studio, /api\.|store\.loadAgents|prescriptions/, 'studio 过渡页不得残留业务逻辑');

  // 战局只做判断，核心读失败时桥接只给重试；有令优先于有判断。
  assert.doesNotMatch(homeWxml, /item\.weapon|weekStrip|今日数据回填/, '战局不得再平铺执行区');
  assert.match(homeWxml, /loadFailed[\s\S]{0,180}bindtap="retry"/);
  assert.ok(homeWxml.indexOf('todayOrderCount>0') < homeWxml.indexOf('hasValidJudgment'), '桥接判据必须今日有令优先');
  assert.doesNotMatch(home, /api\.prescriptions\(\)|api\.reviews\(\)|api\.bizMetricTemplate\(\)/, '战局 onShow 不得加载执行接口');

  // 兵器主链路在执行：处方过滤、点击上报、挂到军令、伏笔样式。
  assert.match(execution, /api\.prescriptions\(\)/);
  assert.match(execution, /item\.status !== 'dismissed' && item\.status !== 'activated'/);
  assert.match(execution, /api\.prescriptionAction\(id, 'clicked'\)\.catch/);
  assert.match(execution, /\/packages\/work\/market\/index\?from=prescription&pid=/);
  assert.match(executionWxml, /item\.weapon/, '兵器条必须挂在军令卡内（主分发位）');
  // 兵器绑定必须来自服务端 order.weapon（拆军令那一轮 LLM 选的 toolKey，1:1）。
  // 端上一度按位置拼（第 N 条处方贴第 N 条军令），处方讲的问题和军令可能毫不相干——不许回退。
  assert.doesNotMatch(execution, /weapon: weapons\[index\]/, '不得按位置把处方拼到军令上');
  assert.match(execution, /this\._pendingWithWeapons = pendingOrders;/, '军令的兵器只认服务端下发的字段');
  assert.match(execution, /weapon\.kind === 'external'/, 'external 兵器要走 navigateToMiniProgram');
  assert.match(execution, /onOrder\.has\(item\.toolKey\)/, '已作为军令兵器出现的工具不再重复列成独立兵器条');
  assert.match(executionWxml, /wx:for="\{\{leftoverWeapons\}\}"/);
  assert.match(executionScss, /\.rx-item\s*\{/);
  assert.match(executionScss, /\.task-weapon\s*\{/);

  // 执行链路完整：军令回填、目标、复盘与提醒都在新页。
  assert.match(execution, /api\.saveGoals\(/);
  assert.match(execution, /api\.setOrderResult\(/);
  assert.match(execution, /api\.reviewCasefile\('day'\)[\s\S]*?agentKey=general/);
  assert.match(executionWxml, /做完了多少/);
  assert.match(executionWxml, /bindtap="openReminders"/);

  // 2026-08-19 IA 第四刀（B + E3）：手艺搬进今日页尾的锦囊段，锦囊页只剩跨手艺档案。
  // 数据与置灰口径只有一份 —— services/pouch-data，两页都不许各自长一套。
  const pouchData = fs.readFileSync(path.join(sourceRoot, 'services/pouch-data.js'), 'utf8');
  assert.match(pouchData, /text\(agent\.type\) === 'creative'/, '创意 agents 动态成行');
  assert.match(pouchData, /Boolean\(agent\.owned\) \|\| text\(agent\.billing\) !== 'unlock'/, '已启用判定');
  assert.match(pouchData, /worksRoute: '\/packages\/work\/gallery\/index'/, '海报的作品带落作品库');
  // 2026-08-13 二次修订：海报开工落到**海报设计师的对话**，不是空白需求单 ——
  // 一张海报要成立至少得知道「为什么出、给谁看」，那两件事只能问出来；空表单等于把用户
  // 找军师的理由原样退回给他。需求单仍在，由成果卡带着预填进去。
  assert.match(pouchData, /makeRoute: '\/packages\/main\/chat\/index\?agentKey=poster&continue=1'/,
    '海报开工落到军师对话，不是空白需求单');
  assert.doesNotMatch(pouchData, /makeRoute: '\/packages\/work\/poster\/index'/, '手艺行不许直接甩空表单');
  assert.match(pouchData, /packages\/work\/posterJob\/index\?jobId=/,
    '「再来一张」落到那张海报的详情页（改文字/换方向都带上下文）');
  // 2026-08-14 走查：自己已有的资产不许被收费闸挡在外面——有成品即视为已经一起用过。
  assert.match(pouchData, /const hasWorks = count > 0;/, '有成品必须参与已启用判定');
  assert.match(pouchData, /const unlocked = !app\.agentKey\s*\n\s*\|\| hasWorks\s*\n\s*\|\| Boolean\(agent && \(agent\.owned \|\| text\(agent\.billing\) !== 'unlock'\)\)/,
    '带 agentKey 的手艺跟着那位军师的启用状态置灰，但有成品就一律算已启用');
  assert.ok(pouchData.indexOf('const hasWorks') < pouchData.indexOf('const unlocked'),
    'hasWorks 必须先于 unlocked 求值，否则置灰判定读不到作品数');
  // 目录读不到时**不许**当成已启用：放行会让人点进确认页、提交时才撞 403，那时已经在扣费路径上。
  assert.match(pouchData, /Boolean\(agent && \(agent\.owned/, '查不到 agent 时按未启用处理');
  assert.match(pouchData, /covered\.has\(text\(agent\.key\)\)/, '被固定行覆盖的军师不许再出一行');
  assert.doesNotMatch(pouchData, /costText|priceText/, '手艺行数据不得带价格字段');

  // 置灰行必须能真正走到启用（2026-08-12：否则创意军师全端无处启用，付费链断在这里）。
  assert.match(execution, /this\.setData\(\{ unlockAgent: agent \}\)/, '置灰行必须能开启用层');
  assert.match(execution, /if \(!this\.requireLogin\(\)\) return;[\s\S]{0,200}unlockAgent/, '启用是扣费动作，先过登录门');
  assert.match(execution, /agentUnlocked\(event\)[\s\S]*?agentKey=\$\{encodeURIComponent\(agent\.key\)\}&continue=1/, '启用后进该军师对话');
  assert.match(executionWxml, /<agent-unlock agent="\{\{unlockAgent\}\}"[^>]*bindunlocked="agentUnlocked"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'pages/execution/index.json'), 'utf8')).usingComponents['agent-unlock'], '/components/agent-unlock/index');
  // 卡面仍然不许出现价格：价格只在 agent-unlock 那一刻出现（组件自己渲染）。
  assert.doesNotMatch(executionWxml, /costText|item\.price/, '手艺行不得渲染价格（分发铁律：货架不标价）');
  assert.equal(JSON.parse(fs.readFileSync(path.join(sourceRoot, 'pages/pouch/index.json'), 'utf8')).usingComponents['agent-unlock'], undefined, '档案页没有启用层，它不卖东西');

  // 两个落点上下分家：上半开工、下半进这门手艺的作品库。旧宫格把两者挤在一张卡上、
  // 落点还随「有没有作品」反转，用户根本猜不到点下去去哪（2026-08 走查主诉）。
  assert.match(executionWxml, /class="cr-go/, '手艺行上半格是开工按钮');
  assert.match(executionWxml, /catchtap="openCraftWorks"/, '作品带是独立点击区，不冒泡给整行');
  assert.match(executionWxml, /binderror="onCraftArtError"/, '手艺插画要有缺图兜底');
  assert.match(execution, /onCraftArtError\(event\)/, '缺图兜底的 handler 要在');
  assert.match(executionWxml, /wx:elif="\{\{worksStatus==='loading' && !crafts\.length\}\}"[\s\S]{0,320}craft-sk/, '取数中手艺行要有骨架');
  // 锦囊段写在两个段控 block 之外＝今天 / 近七日都在（复盘入口一直也是这么挂的）。
  const segTodayEnd = executionWxml.indexOf('<block wx:else>', executionWxml.indexOf('segment===0'));
  assert.ok(executionWxml.indexOf('id="pouch-sec"') > segTodayEnd, '锦囊段不得被关进「今天」那一栏');

  // 档案页：搜索 + 类型筛选 + 时间分组，且不许再长出第二套手艺。
  assert.match(pouch, /pouchData\.loadFeed/, '档案页与今日页共用同一份取数');
  assert.match(pouch, /function bucketOf\(updatedAt\)/, '按时间分组');
  assert.match(pouchWxml, /bindinput="inputQuery"/, '档案页要能搜');
  assert.match(pouchWxml, /bindtap="selectType"/, '档案页要能按类型筛');
  assert.doesNotMatch(pouch, /CRAFT_APPS|buildCraftRows/, '手艺不许在档案页复活');
  assert.doesNotMatch(pouchWxml, /agent-unlock/, '档案页不卖东西');
  assert.match(pouchWxml, /wx:if="\{\{loading && !groups\.length\}\}"[\s\S]{0,400}pch-sk/, '取数中作品墙要有骨架');

  // 日 / 周两段是打卡机制的两半：日计划做今天，周计划看连续性。删掉任一半都会削弱「别断」。
  assert.match(execution, /segments: \['今天', '近七日'\]/, '今日 tab 内必须保留同维度的今天/近七日两段，避免 tab 与段名重名');
  assert.match(execution, /function weekStrip\(orders\)/);
  assert.match(execution, /for \(let offset = -6; offset <= 0; offset \+= 1\)/);
  assert.match(execution, /function recentOrderGroups\(orders\)/);
  assert.match(executionWxml, /wx:for="\{\{weekStrip\}\}"/);
  assert.match(executionWxml, /wx:for="\{\{weekGroups\}\}"/);
  assert.match(executionWxml, /连续复盘 \{\{streak\}\} 天/, '复盘 streak 必须与近七日执行指标拆开');

  // 数据通道与 mock 契约不变。
  assert.match(api, /prescriptions:\s*\(\) => isMock\(\) \? mock\.prescriptions\(\)/);
  assert.match(mock, /id: 'rx1'[\s\S]{0,160}status: 'proposed'/);
  for (const key of ['ip', 'promo', 'poster', 'shortvideo', 'copy']) {
    assert.match(mock, new RegExp(`key: '${key}'[^\n]+type: 'creative'`), `mock 缺少创作军师 ${key}`);
  }
});

test('执行 tab 守住独立状态机、锦囊兼容与冷启动复盘红点', () => {
  const execution = read(sourceRoot, 'pages/execution/index.js');
  const executionWxml = read(sourceRoot, 'pages/execution/index.wxml');
  const executionScss = read(sourceRoot, 'pages/execution/index.scss');
  const pouch = read(sourceRoot, 'pages/pouch/index.js');
  const pouchWxml = read(sourceRoot, 'pages/pouch/index.wxml');
  const cache = read(sourceRoot, 'services/works-cache.js');
  const nav = read(sourceRoot, 'services/nav.js');
  const tabbar = read(sourceRoot, 'custom-tab-bar/index.wxml');
  const sessions = read(sourceRoot, 'pages/sessions/index.js');
  const sessionsWxml = read(sourceRoot, 'pages/sessions/index.wxml');
  const coach = read(sourceRoot, 'services/coach.js');

  assert.match(execution, /loadCore\(\)/, '执行核心有独立状态机');
  assert.match(execution, /loadPouch\(options\)/, '锦囊段有独立状态机，不跟军令共用');
  // 汇总行在首屏，绝不能吊在成片代理上（端上 12s 预算）：快通道先出海报 + 方案，成片另补。
  assert.match(execution, /skipClips: true/, '首屏快通道必须跳过成片');
  assert.match(execution, /loadClipChannel\(options\)/, '成片走慢通道单独补');
  assert.match(execution, /const complete = !feed\.failed\.length && !feed\.pending\.length/, '有一路没到就不许报总数');
  assert.doesNotMatch(execution, /api\.videoWorks\(/, '日频执行页严禁调用慢成片列表');
  assert.doesNotMatch(execution, /worksCache\.load(Posters|Clips|Reports)/, '取数口径只在 services/pouch-data，页面不直连缓存');
  assert.match(executionWxml, /worksStatus==='error'[\s\S]{0,180}bindtap="retryWorks"/, '战果失败必须给局部重试');
  assert.ok(executionWxml.indexOf("worksStatus==='error'") < executionWxml.indexOf('bindtap="scrollToPouch"'), '失败判据必须先于真空态');
  assert.match(executionWxml, /bindtap="scrollToPouch"/, '汇总行点了滚到页尾锦囊段，不跳页');
  // enhanced 的 scroll-view 已经绑了 scroll-top + bindscroll，不许再叠 scroll-into-view：
  // 全仓只有 chat / 问策用 scroll-into-view，且都没绑 scroll-top，别在这里造独一份的组合。
  const execScrollTag = executionWxml.slice(executionWxml.indexOf('<scroll-view'), executionWxml.indexOf('>', executionWxml.indexOf('<scroll-view')));
  assert.match(execScrollTag, /enhanced/);
  assert.doesNotMatch(execScrollTag, /scroll-into-view/, 'enhanced + scroll-top 的滚动容器不得再叠 scroll-into-view');
  assert.match(execution, /select\('#pouch-sec'\)\.boundingClientRect\(\)/, '滚到锦囊段靠量位置写 scroll-top');
  assert.doesNotMatch(executionWxml, /today-works|today-work-img/, '同一页不得再出现第二排作品缩略图');
  assert.match(executionWxml, /reviewDue[\s\S]{0,180}今晚复盘还没做/, '21 点复盘提醒在今日段顶部可见');
  assert.match(executionWxml, /pouchMovedHint[\s\S]{0,120}锦囊搬到这了/, '锦囊迁移提示挂在段头');

  // 经营结果需要进入复盘真值，但不能在日频主流里常驻一张三栏报表。
  const reviewSheetAt = executionWxml.indexOf('class="force-sheet-mask"');
  const executionMain = executionWxml.slice(0, reviewSheetAt);
  const reviewSheet = executionWxml.slice(reviewSheetAt);
  assert.match(executionMain, /class="result-entry card" bindtap="openReview"[\s\S]{0,300}今日经营结果[\s\S]{0,180}有结果再记，不要求每天填满/, '主页面只保留轻量经营结果入口');
  assert.doesNotMatch(executionMain, /class="df-row"|bindtap="saveBackfill"/, '三栏经营表单不得常驻今日主页面');
  const reviewDailyEnd = reviewSheet.indexOf("reviewStatus==='loading'");
  const reviewDailyForm = reviewSheet.slice(0, reviewDailyEnd);
  assert.match(reviewDailyForm, /class="data-fill review-daily-fill"/, '每日结果表单收进复盘抽屉');
  assert.match(reviewDailyForm, /bindtap="saveBackfill"/, '每日结果表单保留保存动作');
  assert.ok(reviewSheet.indexOf('review-daily-fill') < reviewSheet.indexOf("reviewStatus==='loading'"), '每日结果填写不得被复盘详情接口的加载或失败阻断');
  assert.match(reviewSheet, /本周关键指标[\s\S]{0,120}按你的行业模板汇总，每周记一次/, '周指标与每日结果必须明确区分频率和口径');

  // fixed 底部抽屉不能再交给微信默认 adjust-position 二次顶页：所有经营输入统一由抽屉按键盘高度缩放。
  const metricInputs = [...reviewSheet.matchAll(/<input[^>]*class="df-input"[^>]*>/g)].map((match) => match[0]);
  assert.equal(metricInputs.length, 4, '每日三项 + 本周动态指标模板共四处 input 标记');
  for (const input of metricInputs) {
    assert.match(input, /always-embed="\{\{true\}\}"/);
    assert.match(input, /adjust-position="\{\{false\}\}"/, '底部抽屉 input 禁止让系统整体顶页');
    assert.match(input, /bindkeyboardheightchange="onReviewKeyboard"/);
    assert.match(input, /bindfocus="focusReviewInput"/);
  }
  assert.match(executionWxml, /--review-keyboard:\{\{reviewKeyboardHeight\}\}px/);
  assert.match(execution, /onReviewKeyboard\(event\)[\s\S]{0,260}reviewKeyboardHeight: height/);
  assert.match(executionScss, /max-height:calc\(86vh - var\(--review-keyboard, 0px\)\)[\s\S]{0,120}margin-bottom:var\(--review-keyboard, 0px\)/, '键盘出现时抽屉应缩短并贴在键盘上沿，顶部位置保持稳定');

  assert.match(cache, /if \(slot\.inFlight\) return slot\.inFlight;/, '作品缓存必须 single-flight');
  assert.match(cache, /const TTL_MS = 90000/, '作品缓存统一 90 秒 TTL');
  assert.match(cache, /const scope = String\(getToken\(\) \|\| 'guest'\)/, '模块缓存必须按当前登录身份隔离，切账号不得复用上一账号作品');
  assert.match(cache, /slot\.scope !== scope \|\| slot\.inFlight !== request/, '旧账号慢请求回包不得覆盖新账号缓存槽');
  const pouchDataSrc = read(sourceRoot, 'services/pouch-data.js');
  assert.match(pouchDataSrc, /worksCache\.loadPosters/);
  assert.match(pouchDataSrc, /worksCache\.loadClips/);
  assert.match(pouchDataSrc, /worksCache\.loadReports/);
  assert.match(pouch, /mockProfile\.switchProfile\([\s\S]*?worksCache\.invalidate\(\)/, 'mock 档案切换必须清作品缓存，不能沿用同 token 的上一档案');
  assert.doesNotMatch(pouch, /syncTabBar|this\._loadedAt/, '普通页锦囊不得保留 tab 身份或页面实例缓存');
  assert.doesNotMatch(pouchWxml, /coach-marks|native-bottom-fade|tabbar-space/, '普通页锦囊不得保留 tab 专属 UI');
  assert.match(pouchWxml, /class="pouch-back" bindtap="back"/);
  assert.match(pouch, /getCurrentPages\(\)\.length > 1[\s\S]{0,180}gotoExecution\('today'\)/, '锦囊无返回栈时兜底执行 tab');

  const allJs = walk(sourceRoot).filter((file) => file.endsWith('.js')).map((file) => read(file)).join('\n');
  assert.doesNotMatch(allJs, /wx\.switchTab\(\{\s*url:\s*['"]\/pages\/pouch\/index/, 'pouch 降普通页后全仓不得 switchTab 到它');
  assert.match(nav, /let executionIntent = null/);
  assert.match(nav, /function consumeExecutionIntent\(\)/);
  assert.match(nav, /executionIntent = null;[\s\S]{0,180}return intent/, 'execution intent 消费后立即清除');
  assert.match(coach, /junshi\.coach\.v3\./);
  assert.match(coach, /LEGACY_DONE_PREFIX = 'junshi\.coach\.v2\.'/);

  assert.match(tabbar, /index === 2 && reviewDue/, '常规底栏复盘红点在执行位');
  assert.match(sessionsWxml, /index === 2 && reviewDue/, '问策浮岛复盘红点在执行位');
  assert.match(sessions, /store\.loadReviewBadge\(\)/, '冷启动问策页必须生产复盘红点');
});

test('智库确认入库期间锁定上传、阶段切换与重复确认', () => {
  const thinktank = fs.readFileSync(path.join(sourceRoot, 'pages/thinktank/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(sourceRoot, 'pages/thinktank/index.wxml'), 'utf8');
  assert.match(thinktank, /chooseFiles\(\)\{ if\(!this\.requireLogin\('upload'\)\|\|this\.data\.uploading\|\|this\.data\.confirming\)return;/);
  assert.match(thinktank, /async uploadFiles\(files\)\{ if\(!files\.length\|\|this\.data\.confirming\)return;/);
  assert.match(thinktank, /setStage\(event\)[\s\S]*?this\.data\.confirming/);
  assert.match(thinktank, /confirmOptimized\(\)\{if\(this\.data\.confirming\|\|!this\.data\.optimizedItems\.length\)return;/);
  assert.match(wxml, /\{\{confirming\?'正在切片并建立检索索引，请稍候，不要重复操作。'/);
});

test('原生 mock 专项军师启用按账号隔离并持久化', async () => {
  const values = new Map([['junshi.userId', 'mock-agent-a']]);
  globalThis.wx = {
    getStorageSync: (key) => values.get(key) ?? '',
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
  };
  try {
    const require = createRequire(import.meta.url);
    const mockPath = path.join(sourceRoot, 'services/mock.js');
    delete require.cache[require.resolve(mockPath)];
    const mock = require(mockPath);
    assert.deepEqual((await mock.agents()).filter((agent) => agent.type === 'creative').map((agent) => agent.key), ['ip', 'promo', 'poster', 'shortvideo', 'copy']);
    assert.equal((await mock.prescriptions()).items[0]?.id, 'rx1');
    const creativeStatus = await mock.creativeStatus();
    assert.equal(creativeStatus.enabled, true);
    assert.equal(creativeStatus.pricePerPoster, 10);
    assert.ok(Array.isArray(creativeStatus.templates) && creativeStatus.templates.some((item) => item.key === 'editorial'));
    await mock.purchasePlan('mock-month');
    const bought = await mock.purchaseAgent('ops');
    assert.equal((await mock.agents()).find((agent) => agent.key === 'ops')?.owned, true);
    // 「确认即启用」：mock 与服务端同口径——启用不扣权益点，余额分毫不动。
    assert.equal(bought.pricePaid, 0);
    assert.equal((await mock.me()).creditBalance, 100);

    values.set('junshi.userId', 'mock-agent-b');
    assert.equal((await mock.agents()).find((agent) => agent.key === 'ops')?.owned, false);

    values.set('junshi.userId', 'mock-agent-a');
    assert.equal((await mock.agents()).find((agent) => agent.key === 'ops')?.owned, true);
  } finally {
    delete globalThis.wx;
  }
});

test('原生 mock 目录、经营复盘与海报任务按账号持久化', async () => {
  const values = new Map([['junshi.userId', 'mock-truth-a']]);
  globalThis.wx = {
    getStorageSync: (key) => values.get(key) ?? '',
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
  };
  const realNow = Date.now;
  let clock = Date.parse('2026-08-07T12:00:00.000Z');
  Date.now = () => clock;
  try {
    const require = createRequire(import.meta.url);
    const mockPath = path.join(sourceRoot, 'services/mock.js');
    delete require.cache[require.resolve(mockPath)];
    const mock = require(mockPath);

    const initialSources = await mock.dataSources();
    assert.equal(initialSources.sources.length, 8);
    assert.equal(initialSources.needed, 6);
    await mock.requestDataSourceAuth('crm');
    assert.equal((await mock.dataSources()).sources.find((item) => item.key === 'crm')?.status, 'auth_requested');

    const mockSkus = await mock.skus();
    assert.equal(mockSkus.length, 8); // 6 个能力/服务/空间包 + 2 个增购包（credits/quota）
    // 钻石包带颗数（对外货币口径）；算力包**不下发** token 数（成本口径，属商业机密），
    // 所以下面校验发放时只看「进没进池」，不拿目录里的数字对账。
    const creditsPack = mockSkus.find((item) => item.kind === 'credits');
    const quotaPack = mockSkus.find((item) => item.kind === 'quota');
    assert.ok(Number(creditsPack?.amount) > 0);
    assert.equal(quotaPack?.amount, undefined);
    // 增购包 mock 必须真的发放：钻石进余额、算力进增购池（不能只提示成功）。
    const balanceBefore = (await mock.me()).creditBalance;
    // 无套餐时 usage 为 null（现有 mock 口径），增购余量固定看 tokenQuota。
    const packBefore = (await mock.me()).tokenQuota.packRemaining;
    await mock.createSkuOrder(creditsPack.key);
    await mock.createSkuOrder(quotaPack.key);
    const afterPurchase = await mock.me();
    assert.equal(afterPurchase.creditBalance, balanceBefore + creditsPack.amount);
    assert.ok(afterPurchase.tokenQuota.packRemaining > packBefore, '算力包必须真的进增购池');
    await mock.createSkuOrder('fin-checkup');
    await mock.enableModule('finance');
    assert.equal((await mock.modules()).modules.find((item) => item.key === 'finance')?.enabled, true);
    await mock.patchModule('finance', { hidden: true, sortOrder: 1 });
    assert.equal((await mock.modules()).modules.find((item) => item.key === 'finance')?.hidden, true);

    const seededReports = await mock.reports();
    assert.ok(seededReports.length > 0);
    const seededDetail = await mock.report(seededReports[0].id);
    const seededVersion = await mock.reportVersion(seededReports[0].id, seededDetail.currentVersion);
    assert.ok(seededVersion.content.sections.length > 0);
    assert.ok((await mock.library()).length > 0);

    await mock.saveBackfill({ leads: 12, consults: 5, deals: 2 });
    assert.equal((await mock.reviewCasefile('daily')).streak, 1);
    assert.equal((await mock.reviewCasefile('daily')).streak, 1, '同一天重复复盘不得虚增连续天数');
    const reviewState = await mock.reviews();
    assert.equal(reviewState.streak, 1);
    assert.equal(reviewState.items[0]?.hasBackfill, true);

    // 经营指标模板收到 3 项（services/mockProfile.js 的数据档案：复盘抽屉一屏填得完）。
    assert.equal((await mock.bizMetricTemplate()).items.length, 3);
    await mock.saveBizMetrics('2026-08-03', { monthly_revenue: 23, new_customers: 61 });
    assert.deepEqual((await mock.bizMetricSeries(8)).items.find((item) => item.weekStart === '2026-08-03')?.metrics, { monthly_revenue: 23, new_customers: 61 });

    const request = {
      idempotencyKey: 'poster-truth-1',
      brief: { headline: '先把增长主线说清楚', cta: '扫码来聊', templateKey: 'person_hero', visualDirection: '克制留白' },
    };
    const created = await mock.createPosterJob(request);
    assert.equal(created.status, 'pending');
    assert.equal((await mock.createPosterJob(request)).reused, true);
    clock += 1000;
    assert.equal((await mock.creativeJob(created.jobId)).status, 'running');
    clock += 2300;
    const finished = await mock.creativeJob(created.jobId);
    assert.equal(finished.status, 'succeeded');
    assert.match(finished.assets[0]?.previewUrl || '', /^data:image\/png;base64,/);
    assert.match(finished.outputs[0] || '', /^data:image\/png;base64,/);
    assert.deepEqual([...Buffer.from(finished.outputs[0].split(',')[1], 'base64').subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    // 贴码位与风格名（2026-08-15）：没传二维码 → 服务端仍在成品里留位置，详情页据此告诉用户
    // 「不用为了加个码再出一版」。标准档没有「本次风格」这回事，styleName 不许凭空冒出来。
    assert.equal(finished.qrReserved, true, '没传二维码时任务详情要回 qrReserved');
    assert.equal(finished.styleName, undefined, '标准档不许有风格名');
    assert.equal(finished.tier, undefined, '标准档不下发 tier（老口径：缺省即 standard）');
    // 高级档单独换个账号建，免得多出来的这条把下面作品库分页的断言搅了。
    values.set('junshi.userId', 'mock-truth-premium');
    const premium = await mock.createPosterJob({
      idempotencyKey: 'poster-truth-premium',
      brief: { headline: '主视觉大片这一版', cta: '扫码来聊', tier: 'premium', qrAssetId: 'asset-qr-1', visualDirection: '冷峻光影' },
    });
    clock += 3300;
    const premiumJob = await mock.creativeJob(premium.jobId);
    assert.equal(premiumJob.tier, 'premium');
    assert.ok(premiumJob.styleName, '主视觉大片要回风格名');
    assert.equal(premiumJob.styleName, (await mock.creativeJob(premium.jobId)).styleName, '风格名必须稳定，不能每次查询乱跳');
    assert.equal(premiumJob.qrReserved, false, '传了二维码就是直接排进画面，没有「预留」这回事');
    values.set('junshi.userId', 'mock-truth-a');

    const revised = await mock.reviseJob(created.jobId, { idempotencyKey: 'poster-revise-1', headline: '增长只抓一条主线' });
    assert.equal(revised.creditCost, 0);
    clock += 3300;
    const revisedJob = await mock.creativeJob(revised.jobId);
    assert.equal(revisedJob.parentJobId, created.jobId);
    assert.equal(revisedJob.brief.headline, '增长只抓一条主线');
    assert.equal(revisedJob.brief.templateKey, 'person_hero', '免费改文字不得顺带换版式');

    const regenerated = await mock.regenerateJob(revised.jobId, { idempotencyKey: 'poster-regen-1', visualDirection: '商业发布会质感', templateKey: 'business_launch' });
    const cancelled = await mock.cancelJob(regenerated.jobId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.refunded, true);
    const firstPage = await mock.creativePosters('', 1);
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.nextCursor);
    assert.equal(firstPage.items[0].headline, '增长只抓一条主线');
    const secondPage = await mock.creativePosters(firstPage.nextCursor, 1);
    assert.equal(secondPage.items[0]?.jobId, created.jobId);
    assert.equal((await mock.creativePosters('', 20)).items.some((item) => item.jobId === regenerated.jobId), false);

    values.set('junshi.userId', 'mock-truth-b');
    assert.equal((await mock.dataSources()).sources.find((item) => item.key === 'crm')?.status, 'unbound');
    assert.equal((await mock.modules()).modules.find((item) => item.key === 'finance')?.enabled, false);
    // 换账号后经营数据仍有独立夹具，但作品库必须是严格空态：不再给任何账号自动塞假海报，
    // A 号自己造的任务也不能串过来。
    assert.equal((await mock.reviews()).streak, 6);
    const seededPosters = await mock.creativePosters('', 20);
    assert.equal(seededPosters.items.length, 0);
    assert.equal(seededPosters.items.some((item) => item.jobId === created.jobId), false, 'A 号的海报任务不得串到 B 号');
  } finally {
    Date.now = realNow;
    delete globalThis.wx;
  }
});

test('原生 mock 命盘按账号持久化并返回日历与报告可消费结构', async () => {
  const previousWx = globalThis.wx;
  const values = new Map([['junshi.userId', 'mock-chart-a']]);
  globalThis.wx = {
    getStorageSync: (key) => values.get(key) ?? '',
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
  };

  try {
    const require = createRequire(import.meta.url);
    const mockPath = path.join(sourceRoot, 'services/mock.js');
    delete require.cache[require.resolve(mockPath)];
    const mock = require(mockPath);

    assert.deepEqual(await mock.chart(), { bazi: null, chart: null });
    assert.deepEqual(await mock.chartReport(), { needBazi: true });

    const body = { calendar: 'solar', year: 1990, month: 6, day: 18, hour: 9, gender: 'male', birthPlace: '北京市朝阳区' };
    const saved = await mock.saveBazi(body);
    assert.equal(saved.believe, true);
    assert.equal(saved.matchedCity, '北京');
    assert.equal(saved.chart.monthlyOutlook.months.length, 12);
    assert.ok(saved.chart.dayMaster.gan);
    assert.ok(saved.chart.pattern.name);

    const stored = await mock.chart();
    assert.deepEqual(stored.bazi, body);
    assert.equal(stored.chart.hourKnown, true);

    const report = await mock.chartReport();
    assert.equal(report.base.birthPlace, body.birthPlace);
    assert.equal(report.base.trueSolarApplied, true);
    assert.ok(report.bazi.pillars.year.ganZhi);
    assert.ok(Array.isArray(report.bazi.pillars.year.hideGan));
    assert.equal(typeof report.bazi.wuxingCount.counts.木, 'number');
    assert.equal(report.ziwei.palaces.length, 12);
    assert.ok(report.yinzheng.timeline.length);
    assert.ok(report.yinzheng.keyYears.length);
    assert.ok(report.yinzheng.sihua.length);

    values.set('junshi.userId', 'mock-chart-b');
    assert.deepEqual(await mock.chart(), { bazi: null, chart: null });
    assert.deepEqual(await mock.chartReport(), { needBazi: true });
    values.set('junshi.userId', 'mock-chart-a');
    assert.deepEqual((await mock.chart()).bazi, body);
  } finally {
    if (previousWx === undefined) delete globalThis.wx;
    else globalThis.wx = previousWx;
  }
});

test('原生 mock 资料、三势、账本与对话汇总形成账号隔离真值闭环', async () => {
  const previousWx = globalThis.wx;
  const values = new Map([['junshi.userId', 'mock-loop-a']]);
  globalThis.wx = {
    getStorageSync: (key) => values.get(key) ?? '',
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
    clearStorageSync: () => values.clear(),
  };

  try {
    const require = createRequire(import.meta.url);
    const mockPath = path.join(sourceRoot, 'services/mock.js');
    delete require.cache[require.resolve(mockPath)];
    const mock = require(mockPath);

    const staged = await mock.uploadKnowledge('复购访谈.txt', { staged: true, batchId: 'batch-loop', projectId: 'project-a' });
    await mock.uploadKnowledge('异项目资料.pdf', { projectId: 'project-b' });
    assert.equal((await mock.knowledge('project-a')).length, 0, '待确认资料不得进入 Chat 引用');
    await mock.confirmKnowledge({ ids: [staged.id] });
    const projectKnowledge = await mock.knowledge('project-a', 'document');
    assert.equal(projectKnowledge.length, 1);
    // 源文件名经 title 下发：KnowledgeItemT 没有 fileName 字段，服务端 listKnowledge 把
    // bestUploadName(fileName, title) 归一进 title。断言 fileName 等于把 mock 的透传锁成契约。
    assert.equal(projectKnowledge[0].title, '复购访谈.txt');
    assert.equal(projectKnowledge[0].projectId, 'project-a');

    await mock.saveProfile({ industry: '消费零售', stage: '增长中', pain: '复购下滑' });
    const refreshed = await mock.refreshForces();
    assert.equal(refreshed.forces.length, 3);
    assert.match(refreshed.forces[0].note, /2 份资料/);
    const refreshedMe = await mock.me();
    assert.deepEqual(refreshedMe.understanding.battleForces, refreshed.forces);
    assert.ok(refreshedMe.understanding.updatedAt);

    const initialDecisions = await mock.decisions();
    assert.equal(initialDecisions.items[0].seq, 6);
    // 「经营中」档案只留 1 条待验证（战局页复盘抽屉恰好摆一张决策卡），其余五条已有结论：
    // 正确 3 / 需修正 2 → 准确率 60%。验掉那条 pending 后是 4 正确 / 2 修正 = 67%。
    assert.equal(initialDecisions.stats.pending, 1);
    assert.equal(initialDecisions.stats.accuracy, 60);
    await mock.verifyDecision('d4', 'correct', '私域试验有效');
    const fifth = await mock.verifyDecision('d5', 'correct');
    assert.equal(fifth.stats.accuracy, 67);
    assert.equal((await mock.disputeDecision('d6', '毛利线尚未真正上线')).ok, true);
    assert.equal((await mock.decisions()).items.find((item) => item.id === 'd6').disputeNote, '毛利线尚未真正上线');

    assert.equal((await mock.prophecies()).items[0].seq, 5);
    await mock.verifyProphecy('p4', 'hit');
    const fifthProphecy = await mock.verifyProphecy('p5', 'miss', '窗口未出现');
    assert.equal(fifthProphecy.stats.hitRate, 60);
    const progress = await mock.progress();
    assert.equal(progress.progress.decisionAccuracy, 67);
    assert.equal(progress.progress.prophecyHitRate, 60);

    const generated = await mock.generate({ agentKey: 'growth', text: '怎么把复购拉起来？' });
    await mock.generate({ agentKey: 'growth', sessionId: generated.sessionId, text: '先从最近成交客户开始。' });
    const summary = await mock.summarize(generated.sessionId);
    assert.equal(summary.version, 1);
    assert.equal((await mock.report(summary.reportId)).currentVersion, 1);
    assert.ok((await mock.reportVersion(summary.reportId, 1)).content.sections.length >= 3);
    assert.ok((await mock.reports()).some((item) => item.id === summary.reportId));
    assert.ok((await mock.library()).some((item) => item.reportId === summary.reportId));
    assert.ok((await mock.knowledge()).some((item) => item.sourceType === 'conversation' && item.sourceId === generated.sessionId));
    assert.equal((await mock.summarize(generated.sessionId)).version, 1, '同内容重复整理不得虚增版本');
    await mock.generate({ agentKey: 'growth', sessionId: generated.sessionId, text: '再补一条本周验证标准。' });
    const revised = await mock.summarize(generated.sessionId);
    assert.equal(revised.reportId, summary.reportId);
    assert.equal(revised.version, 2);
    assert.equal((await mock.report(revised.reportId)).currentVersion, 2);
    assert.equal((await mock.library()).find((item) => item.reportId === revised.reportId).version, 2);

    values.set('junshi.userId', 'mock-loop-b');
    assert.equal((await mock.knowledge()).length, 0);
    // B 号看到的三势是「经营中」档案的种子（3 条），不是 A 号 refreshForces 写下的那份——
    // 种子里 note 不会带上 A 号的资料计数，串号就会在这条上露出来。
    const seededForces = (await mock.me()).understanding.battleForces;
    assert.equal(seededForces.length, 3);
    assert.doesNotMatch(seededForces[0].note, /份资料/, 'A 号刷新出来的三势不得串到 B 号');
    assert.equal((await mock.decisions()).items.find((item) => item.id === 'd4').status, 'pending');
    await assert.rejects(mock.report(summary.reportId), (error) => error && error.code === 'NOT_FOUND');

    values.set('junshi.userId', 'mock-loop-a');
    assert.equal((await mock.progress()).progress.decisionAccuracy, 67);
    assert.equal((await mock.report(summary.reportId)).currentVersion, 2);
  } finally {
    if (previousWx === undefined) delete globalThis.wx;
    else globalThis.wx = previousWx;
  }
});

test('原生 API 的本地真值接口统一委托 mock 实现', () => {
  const api = fs.readFileSync(path.join(sourceRoot, 'services/api.js'), 'utf8');
  for (const method of ['reviews', 'dataSources', 'modules', 'reports', 'skus', 'bizMetricTemplate', 'bizMetricSeries', 'saveBizMetrics', 'chart', 'saveBazi', 'chartReport']) {
    assert.match(api, new RegExp(`${method}:.*?mock\\.${method}\\(`), `${method} 仍未走 mock 真值`);
  }
  assert.match(api, /myChart:.*?mock\.chart\(\)/);
  assert.match(api, /myChartReport:.*?mock\.chartReport\(\)/);
  assert.match(api, /createSkuOrder:[\s\S]{0,120}mock\.createSkuOrder\(key, openid, attribution\)/);
  assert.match(api, /enableModule:[\s\S]{0,100}mock\.enableModule\(key\)/);
  assert.match(api, /requestDataSourceAuth:[\s\S]{0,120}mock\.requestDataSourceAuth\(key\)/);
  assert.match(api, /uploadDataSource:[\s\S]{0,120}mock\.uploadDataSource\(key, knowledgeId\)/);
  assert.match(api, /reviseJob:[\s\S]{0,100}mock\.reviseJob\(id, body\)/);
  assert.match(api, /regenerateJob:[\s\S]{0,110}mock\.regenerateJob\(id, body\)/);
  assert.match(api, /cancelJob:[\s\S]{0,90}mock\.cancelJob\(id\)/);
  assert.match(api, /creativePosters:[\s\S]{0,110}mock\.creativePosters\(cursor, limit\)/);
});

test('附身验令使用隔离鉴权，失败不清当前会话', () => {
  const api = fs.readFileSync(path.join(sourceRoot, 'services/api.js'), 'utf8');
  const request = fs.readFileSync(path.join(sourceRoot, 'services/request.js'), 'utf8');
  const store = fs.readFileSync(path.join(sourceRoot, 'services/store.js'), 'utf8');
  assert.match(api, /verifyImpersonation:[\s\S]*isolatedAuth:\s*true/);
  assert.match(request, /opts\.isolatedAuth/);
  assert.match(request, /statusCode\s*===\s*401[\s\S]{0,120}unauthorized\(tokenAtRequest,\s*data,\s*opts\.isolatedAuth\)/);
  assert.match(request, /getToken\(\)\s*===\s*tokenAtRequest/);
  assert.match(store, /error\.authHandled\s*===\s*true\s*\|\|\s*error\.staleAuth\s*===\s*true/);
});

test('mock 原生包按 token 在本地数据与真实会话间切换', async () => {
  const runtime = cjsRequire(path.join(sourceRoot, 'services/runtime-mode.js'));
  assert.equal(runtime.isSignedUserToken('mock-13800000000'), false);
  assert.equal(runtime.isSignedUserToken('local-13800000000'), false);
  assert.equal(runtime.isSignedUserToken('header.payload.signature'), true);
  assert.equal(runtime.shouldUseMock('mock', 'mock-user'), true);
  assert.equal(runtime.shouldUseMock('mock', 'header.payload.signature'), false);
  assert.equal(runtime.shouldUseMock('server', ''), false);
  assert.equal(runtime.resolveImpersonationBaseUrl('server', 'https://preprod.example/api', ''), 'https://preprod.example/api');
  assert.equal(runtime.resolveImpersonationBaseUrl('mock', 'http://localhost:4000/api', ''), 'https://wxapi.aibuzz.cn/api');
  assert.equal(runtime.resolveImpersonationBaseUrl('mock', 'http://localhost:4000/api', 'https://preprod.example/api'), 'https://preprod.example/api');
  assert.equal(runtime.resolveRuntimeBaseUrl('mock', 'http://localhost:4000/api', 'https://wxapi.aibuzz.cn/api', 'header.payload.signature'), 'https://wxapi.aibuzz.cn/api');
  assert.equal(runtime.resolveRuntimeBaseUrl('mock', 'http://localhost:4000/api', 'https://wxapi.aibuzz.cn/api', 'mock-user'), 'http://localhost:4000/api');

  const previousWx = globalThis.wx;
  let token = '';
  let requestStatus = 200;
  let removed = 0;
  const urls = [];
  globalThis.wx = {
    getStorageSync: () => token,
    removeStorageSync: () => { removed += 1; token = ''; },
    request(options) {
      urls.push(options.url);
      options.success({ statusCode: requestStatus, data: requestStatus === 200 ? {} : { error: '令牌无效' } });
      return {};
    },
    uploadFile(options) {
      urls.push(options.url);
      options.success({ statusCode: 200, data: '{}' });
      return { onProgressUpdate() {} };
    },
  };
  try {
    assert.equal(runtime.useMockApi(), true);
    token = 'header.payload.signature';
    assert.equal(runtime.useMockApi(), false);
    assert.equal(runtime.getApiBaseUrl(), 'https://wxapi.aibuzz.cn/api');
    const requestService = cjsRequire(path.join(sourceRoot, 'services/request.js'));
    const apiService = cjsRequire(path.join(sourceRoot, 'services/api.js'));
    assert.equal(apiService.isMock(), false);
    await requestService.request('/probe');
    await requestService.upload('/upload', '/tmp/probe.png');
    token = 'local-13800000000';
    assert.equal(runtime.useMockApi(), true);
    assert.equal(apiService.isMock(), true);
    assert.equal(runtime.getApiBaseUrl(), 'http://localhost:4000/api');
    await requestService.request('/probe');
    token = '';
    assert.equal(runtime.useMockApi(), true);
    assert.deepEqual(urls.slice(0, 3), [
      'https://wxapi.aibuzz.cn/api/probe',
      'https://wxapi.aibuzz.cn/api/upload',
      'http://localhost:4000/api/probe',
    ]);

    token = 'current.session.token';
    requestStatus = 401;
    await assert.rejects(
      requestService.request('/me', { token: 'invalid.candidate.token', isolatedAuth: true, baseUrl: 'https://verify.example/api' }),
      (error) => error && error.code === 'UNAUTHORIZED'
    );
    assert.equal(token, 'current.session.token', '候选令牌验令失败不得覆盖或清理当前 token');
    assert.equal(removed, 0, '隔离鉴权失败不得调用 clearToken');

    // 今日 tab 会同时加载 me/casefile/reviews/prescriptions；旧 token 失效时这些 401 会并发回来。
    // 只允许第一条执行全局退出，其余旧响应不得重复 reLaunch，也不得清掉一次新登录。
    const pendingRequests = [];
    let authLostCount = 0;
    globalThis.wx.request = (options) => { pendingRequests.push(options); return {}; };
    requestService.setAuthLostHandler(() => { authLostCount += 1; });
    removed = 0;
    token = 'expired.session.token';
    const expiredA = requestService.request('/me');
    const expiredB = requestService.request('/casefile');
    pendingRequests.shift().success({ statusCode: 401, data: { error: '令牌无效' } });
    pendingRequests.shift().success({ statusCode: 401, data: { error: '令牌无效' } });
    const expiredResults = await Promise.allSettled([expiredA, expiredB]);
    assert.equal(removed, 1, '同一个失效会话只清一次 token');
    assert.equal(authLostCount, 1, '同一个失效会话只触发一次全局退出');
    assert.equal(expiredResults[0].status === 'rejected' && expiredResults[0].reason.authHandled, true);
    assert.equal(expiredResults[1].status === 'rejected' && expiredResults[1].reason.staleAuth, true);

    token = 'old.session.token';
    const lateRequest = requestService.request('/reviews');
    token = 'new.session.token';
    pendingRequests.shift().success({ statusCode: 401, data: { error: '旧请求已失效' } });
    await assert.rejects(lateRequest, (error) => error && error.staleAuth === true);
    assert.equal(token, 'new.session.token', '旧请求晚到的 401 不得清掉新登录 token');
    assert.equal(removed, 1, '旧请求晚到不得再次清 token');
    assert.equal(authLostCount, 1, '旧请求晚到不得再次触发全局退出');
  } finally {
    if (previousWx === undefined) delete globalThis.wx;
    else globalThis.wx = previousWx;
  }

  const request = fs.readFileSync(path.join(sourceRoot, 'services/request.js'), 'utf8');
  const streaming = fs.readFileSync(path.join(sourceRoot, 'services/streaming.js'), 'utf8');
  const api = fs.readFileSync(path.join(sourceRoot, 'services/api.js'), 'utf8');
  const knowledge = fs.readFileSync(path.join(sourceRoot, 'packages/work/knowledge/index.js'), 'utf8');
  const creative = fs.readFileSync(path.join(sourceRoot, 'packages/work/poster/creative.js'), 'utf8');
  assert.equal((request.match(/opts\.baseUrl \|\| getApiBaseUrl\(\)/g) || []).length, 2, '普通请求与上传必须共用运行时 API');
  assert.match(streaming, /if \(useMockApi\(\) \|\| env\.STREAM_CHAT === false\)/);
  assert.match(streaming, /const origin = getApiBaseUrl\(\)/);
  assert.match(streaming, /url: `\$\{origin\}\/generate`/);
  assert.match(api, /const isMock = \(\) => useMockApi\(\)/);
  assert.match(api, /verifyImpersonation:[\s\S]{0,180}baseUrl:\s*getImpersonationBaseUrl\(\)/);
  assert.match(knowledge, /`\$\{getApiBaseUrl\(\)\}\/knowledge\/upload`/, '资料库自带取消能力的直传也必须跟随附身运行时');
  assert.match(creative, /String\(getApiBaseUrl\(\) \|\| ''\)/, '真实会话的相对成品地址必须按运行时 API 还原');
  for (const file of walk(sourceRoot).filter((entry) => entry.endsWith('.js') && !entry.endsWith('services/runtime-mode.js'))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /env\.BASE_URL/, `仍有固定构建 API 旁路：${path.relative(sourceRoot, file)}`);
  }
});

test('后端环境角标只在开发版显示，并按真实请求地址区分四种环境', () => {
  const environment = cjsRequire(path.join(sourceRoot, 'services/backend-environment.js'));
  assert.equal(environment.classifyBackendEnvironment({ mock: true, baseUrl: 'http://localhost:4000/api' }), 'mock');
  assert.equal(environment.classifyBackendEnvironment({ mock: false, baseUrl: 'https://127-0-0-1.example/api' }), 'local');
  assert.equal(environment.classifyBackendEnvironment({ mock: false, baseUrl: 'https://preview.trycloudflare.com/api' }), 'local');
  assert.equal(environment.classifyBackendEnvironment({ mock: false, baseUrl: 'https://wxapi.aibuzz.cn/api_preprod' }), 'preprod');
  assert.equal(environment.classifyBackendEnvironment({ mock: false, baseUrl: 'https://wxapi.aibuzz.cn/api' }), 'prod');
  assert.equal(environment.shouldShowBackendEnvironmentBadge('develop'), true);
  assert.equal(environment.shouldShowBackendEnvironmentBadge('trial'), false);
  assert.equal(environment.shouldShowBackendEnvironmentBadge('release'), false);
  assert.equal(environment.shouldShowBackendEnvironmentBadge(''), false, '微信版本身份不可用时必须安全隐藏');

  for (const page of ['pages/home', 'pages/sessions', 'pages/execution', 'pages/pouch', 'pages/thinktank', 'pages/profile']) {
    const markup = read(sourceRoot, `${page}/index.wxml`);
    assert.match(markup, /wx:if="\{\{showBackendEnvironmentBadge\}\}"[^>]*native-env-badge/, `${page} 必须消费统一开发环境角标`);
    assert.match(markup, /\{\{backendEnvironmentLabel\}\}/, `${page} 必须展示真实后端环境`);
  }
});

test('原生设置恢复长按附身入口与六色本命色盘', () => {
  const settings = fs.readFileSync(path.join(sourceRoot, 'packages/main/settings/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(sourceRoot, 'packages/main/settings/index.wxml'), 'utf8');
  const store = fs.readFileSync(path.join(sourceRoot, 'services/store.js'), 'utf8');
  const { COLORS } = cjsRequire(path.join(sourceRoot, 'services/colors.js'));
  assert.deepEqual(COLORS.map((color) => color.key), ['green', 'gold', 'red', 'blue', 'purple', 'iron']);
  assert.match(wxml, /class="current-phone version-row" bindlongpress="openImpersonation"/);
  assert.match(wxml, /wx:if="\{\{showImpersonation\}\}"/);
  assert.match(wxml, /bindinput="inputImpersonation"/);
  assert.match(wxml, /wx:if="\{\{showColorPicker\}\}"/);
  assert.match(wxml, /wx:for="\{\{colors\}\}"/);
  assert.match(wxml, /native-icon name="close"/);
  assert.match(wxml, /native-icon name="lock"/);

  const submit = settings.match(/async submitImpersonation\(\) \{[\s\S]*?\n  \},\n\n  noop/);
  assert.ok(submit, '设置页缺少完整附身提交方法');
  assert.ok(submit[0].indexOf('api.verifyImpersonation(token)') < submit[0].indexOf('store.afterLogin({ token, onboarded, user: me.user })'), '必须先验令再覆盖当前身份');
  assert.doesNotMatch(submit[0], /resetAuth|handleApiError/, '附身失败不得清空或走全局鉴权失效处理');
  assert.match(settings, /selectColor\(event\)[\s\S]{0,220}store\.setColor\(key, false\)/);
  assert.match(settings, /confirmColor\(\)[\s\S]{0,180}store\.setColor\(key, true\)/);
  assert.match(store, /api\.setColor\(value\)\.catch/);
});

test('原生设置与游客老板页恢复政策、客服和退出登录', () => {
  const settings = fs.readFileSync(path.join(sourceRoot, 'packages/main/settings/index.js'), 'utf8');
  const settingsWxml = fs.readFileSync(path.join(sourceRoot, 'packages/main/settings/index.wxml'), 'utf8');
  const nativeLegal = fs.readFileSync(path.join(sourceRoot, 'packages/main/legal/index.js'), 'utf8');
  const h5Settings = fs.readFileSync(path.join(appRoot, 'src/packages/main/settings/index.tsx'), 'utf8');
  const h5Legal = fs.readFileSync(path.join(appRoot, 'src/packages/main/legal/index.tsx'), 'utf8');
  const settingsScss = fs.readFileSync(path.join(sourceRoot, 'packages/main/settings/index.scss'), 'utf8');
  const profile = fs.readFileSync(path.join(sourceRoot, 'pages/profile/index.js'), 'utf8');
  const profileWxml = fs.readFileSync(path.join(sourceRoot, 'pages/profile/index.wxml'), 'utf8');
  const profileScss = fs.readFileSync(path.join(sourceRoot, 'pages/profile/index.scss'), 'utf8');

  assert.match(settings, /const \{ navTo \} = require\('\.\.\/\.\.\/\.\.\/services\/nav'\)/);
  assert.match(settings, /openDoc\(event\)[\s\S]*?\['agreement', 'privacy', 'refund'\]\.includes\(doc\)[\s\S]*?\/packages\/main\/legal\/index\?doc=\$\{doc\}/);
  for (const [doc, label] of [['agreement', '用户协议'], ['privacy', '隐私政策'], ['refund', '退款政策']]) {
    assert.match(settingsWxml, new RegExp(`data-doc="${doc}" bindtap="openDoc"[^>]*><text>${label}<\\/text>`));
  }
  assert.match(settingsWxml, /<button class="settings-link-row settings-contact-btn" open-type="contact">/);
  assert.match(settingsWxml, /<button class="logout-btn" bindtap="logout"><native-icon name="lock" tone="red"/);
  assert.match(settings, /logout\(\)[\s\S]*?title: '退出登录'[\s\S]*?store\.resetAuth\(\)[\s\S]*?wx\.reLaunch\(\{ url: '\/pages\/sessions\/index' \}\)/);
  assert.match(settingsScss, /\.settings-contact-btn\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(settingsScss, /\.settings-contact-btn::after\s*\{\s*border:\s*0/);
  assert.match(settingsScss, /\.logout-btn\s*\{/);

  for (const source of [settings, nativeLegal, h5Settings, h5Legal]) {
    assert.match(source, /30 天/, '注销入口与隐私政策必须明确默认保留期');
    assert.doesNotMatch(source, /注销(?:将|会)永久删除|永久删除(?:你的)?账号|删除全部账号数据|此操作不可恢复/, '不得把注销请求误称为立即永久删除');
  }
  assert.match(settings, /账号和公开分享会立即停用/);
  assert.match(h5Settings, /账号和公开分享会立即停用/);
  assert.match(nativeLegal, /期满后删除或匿名化/);
  assert.match(h5Legal, /到期后删除或匿名化/);

  assert.match(profileWxml, /<button wx:if="\{\{row\.action==='contact'\}\}" class="menu-row guest-contact" open-type="contact">/);
  assert.doesNotMatch(profile, /请使用页面右上角客服入口|action === 'contact'/, '游客客服不得再落到死 toast');
  assert.match(profileScss, /@use\s+"\.\.\/\.\.\/\.\.\/src\/pages\/profile\/index\.scss"/);
  assert.doesNotMatch(`${settingsWxml}\n${profileWxml}`, /[›→☎☏]/, '政策和客服入口箭头必须使用 native-icon');
});

test('原生对话消息沿用 Taro 的身份行、正文与用户引用层级', () => {
  const chatWxml = chatMarkup();
  const chatScss = chatStyle();
  const chatJs = chatSource();
  const chatJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'packages/main/chat/index.json'), 'utf8'));

  assert.match(chatWxml, /class="who"[\s\S]{0,240}src="{{advisorAvatar}}"[\s\S]{0,120}<text>{{title}}<\/text>/);
  assert.match(chatWxml, /wx:else class="ai-text"/);
  assert.doesNotMatch(chatWxml, /class="msg-avatar"/, '军师回复不得回退成文字占位头像');
  assert.ok(chatWxml.indexOf('class="uref"') < chatWxml.indexOf('class="user-bubble"'), '用户引用必须位于正文气泡上方');
  assert.match(chatScss, /\.ai-text\s*\{[^}]*padding:\s*1px 4px 0 32px/s);
  assert.match(chatScss, /\.user-bubble\s*\{[^}]*border-radius:\s*16px 16px 4px 16px/s);
  assert.match(chatJs, /assets\/avatars\/generated\/\$\{portrait\}-imagegen\.jpg/);
  assert.equal(chatJson.usingComponents?.['report-card'], '/components/report-card/index');
});

test('原生 ReportCard 归一 typed section，并用 reportReady 硬闸门保护全部操作', () => {
  const componentRoot = path.join(sourceRoot, 'components/report-card');
  for (const ext of ['js', 'json', 'wxml', 'scss']) assert.ok(fs.existsSync(path.join(componentRoot, `index.${ext}`)));
  const source = fs.readFileSync(path.join(componentRoot, 'index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(componentRoot, 'index.wxml'), 'utf8');
  const config = JSON.parse(fs.readFileSync(path.join(componentRoot, 'index.json'), 'utf8'));
  let definition;
  const sandbox = { Component(value) { definition = value; }, module: { exports: {} } };
  vm.runInNewContext(source, sandbox, { filename: 'components/report-card/index.js' });
  const { cardSection, normalizeReport } = sandbox.module.exports;

  assert.equal(typeof cardSection, 'function');
  assert.equal(typeof normalizeReport, 'function');
  assert.deepEqual(JSON.parse(JSON.stringify(cardSection({ type: 'stats', items: [{ num: 12, unit: '%', label: '转化' }] }))), {
    h: '关键数据', list: ['12% · 转化'],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(cardSection({ type: 'quote', text: '先定一事' }))), { h: '金句', b: '「先定一事」' });
  assert.deepEqual(JSON.parse(JSON.stringify(cardSection({ type: 'table', headers: ['项', '值'], rows: [['收入', { text: '上升' }]] }))), {
    h: '对比', list: ['项 / 值', '收入 / 上升'],
  });
  const normalized = JSON.parse(JSON.stringify(normalizeReport({ icon: 'unknown', title: '**主线**', sections: [{ type: 'hero', h: '##判断##', paras: ['先聚焦'] }] })));
  assert.equal(normalized.icon, 'doc');
  assert.equal(normalized.title, '主线');
  assert.deepEqual(normalized.sections[0], { key: 'section-0', h: '判断', b: '先聚焦', list: [] });

  assert.ok(definition?.methods?.emitAction, 'ReportCard 必须在组件内二次保护操作事件');
  let emitted = 0;
  const actionContext = { data: { operable: false, streaming: false, busy: false }, triggerEvent() { emitted += 1; } };
  definition.methods.emitAction.call(actionContext, 'viewreport');
  assert.equal(emitted, 0);
  actionContext.data.operable = true;
  definition.methods.emitAction.call(actionContext, 'viewreport');
  assert.equal(emitted, 1);
  assert.match(source, /!this\.data\.operable\s*\|\|\s*this\.data\.streaming\s*\|\|\s*this\.data\.busy/);
  assert.match(wxml, /wx:if="{{operable&&!streaming}}" class="report-actions"/);
  assert.match(wxml, /wx:if="{{operable&&!streaming}}" class="accept-card"/);
  assert.match(wxml, /native-icon name="shield"/);
  assert.equal(config.usingComponents?.['native-icon'], '/components/native-icon/index');

  const chatWxml = chatMarkup();
  const chatJs = chatSource();
  assert.match(chatWxml, /operable="{{item\.reportReady}}"/);
  assert.match(chatJs, /textOf\(messageId\)\.trim\(\)[\s\S]*deliverable\.degraded !== true[\s\S]*deliverable\.sections\.length > 0/);
});

test('海报设计师成果卡、成品图路由与原地启用保持双层硬闸门', () => {
  const chat = chatSource();
  const chatWxml = chatMarkup();
  const report = fs.readFileSync(path.join(sourceRoot, 'components/report-card/index.js'), 'utf8');
  const reportWxml = fs.readFileSync(path.join(sourceRoot, 'components/report-card/index.wxml'), 'utf8');
  const reportScss = fs.readFileSync(path.join(sourceRoot, 'components/report-card/index.scss'), 'utf8');
  const poster = fs.readFileSync(path.join(sourceRoot, 'packages/work/poster/index.js'), 'utf8');
  const posterWxml = fs.readFileSync(path.join(sourceRoot, 'packages/work/poster/index.wxml'), 'utf8');
  const posterJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'packages/work/poster/index.json'), 'utf8'));
  const api = fs.readFileSync(path.join(sourceRoot, 'services/api.js'), 'utf8');
  const mock = fs.readFileSync(path.join(sourceRoot, 'services/mock.js'), 'utf8');

  assert.match(chat, /this\._agentKey !== 'poster' \|\| !store\.isAuthed\(\)/);
  assert.match(chat, /await api\.creativeStatus\(\)/);
  assert.match(chat, /status && status\.enabled && Number\.isFinite\(price\)/);
  assert.match(chatWxml, /poster-enabled="\{\{item\.reportReady&&posterEnabled\}\}"/);
  assert.match(chatWxml, /bindposter="openPoster" bindviewposter="openPosterJob"/);
  // 2026-08-13 改造：海报设计师**不再产出方案报告**（deliverableKey 置空），报告卡这个宿主没了。
  // 出图入口改为海报会话内常驻一条，判据从「这条消息是成果卡」换成「这是海报会话 + 能力开着 + 有会话」。
  // 旧断言钉的正是被拿掉的那条链（reportReady + messageId），删掉不是放松而是跟着契约走。
  assert.match(chat, /openPoster\(\)[\s\S]*?this\._agentKey !== 'poster' \|\| !this\.data\.posterEnabled[\s\S]*?\/packages\/work\/poster\/index\?sessionId=/,
    '出图入口判据 = 海报会话 + 能力开着');
  assert.match(chat, /if \(!this\._sessionId\)[\s\S]{0,160}先跟设计师说说/,
    '还没开口就点出图 → 抽出来必然是张空表，先拦住');
  assert.doesNotMatch(chat, /openPoster[\s\S]{0,400}messageId=/,
    '需求单改由整段对话抽取，不再挂在某一条成果消息上');
  // 2026-08-13 二次改：入口从**常驻条**改成挂在设计师那条回复下面的 action。
  // 常驻会让人以为随时能出图，而那时对话还没聊出主标题和客群，出图页只会是一张空表。
  const msgList = fs.readFileSync(path.join(sourceRoot, 'chat-core/message-list.wxml'), 'utf8');
  assert.match(msgList, /messageIndex===posterActionAt[\s\S]{0,200}bindtap="openPoster"/, '出图 action 挂在消息上');
  assert.doesNotMatch(chatWxml, /chat-poster-bar/, '常驻条必须已经拆掉，别两个入口并存');
  // 2026-08-14 走查：这段 action 原本排在 report-card / ai-text **之前**，渲染出来的顺序是
  // 军师头像行、出图按钮、然后才是正文——注释写着「挂在这条回复下面」，实际挂在了上面。
  assert.ok(msgList.indexOf('class="ai-text"') < msgList.indexOf('class="msg-poster-go"'),
    '出图入口必须排在回复正文之后，不许再挂回正文前面');
  // 派生状态与 ask 走同一个「消息落定」钩子，freshness 保证一致。
  // ★ 两个钩子都要算。实测过只加一个的后果：设计师说了「够了，直接出图」，action 也不出现——
  //   askPatch 才是回复流式结束 / 历史加载 / 会话恢复共用的「消息落定」钩子，
  //   askSelectionPatch 只在 ask 交互时走。漏掉前者 = 正常聊天路径永远不刷新这个下标。
  assert.match(chat, /posterActionAt: this\.posterActionIndex\(decorated\)/, 'askPatch 里要算（回复落定路径）');
  assert.match(chat, /posterActionAt: this\.posterActionIndex\(messages\)/, 'askSelectionPatch 里也要算（ask 交互路径）');
  assert.match(chat, /if \(item\.streaming\) continue;/, '还在打字的那条不挂 action');
  assert.match(chat, /signal \|\| replies >= 4/, '信号是文本尾部约定、遵从性不稳，必须有轮次兜底');
  // 两个宿主页都要把下标传进模板，漏一个那页就永远不显示。
  for (const [name, markup] of [['chat', chatWxml], ['sessions', fs.readFileSync(path.join(sourceRoot, 'pages/sessions/index.wxml'), 'utf8')]]) {
    assert.match(markup, /posterEnabled, posterPrice, posterActionAt,/, `${name} 页要把 posterActionAt 传给消息列表`);
  }
  // （原「出图链路要带 messageId」的断言随 2026-08-13 改造一并作废：需求单改从整段对话抽，
  //   openPoster 只带 sessionId。上面的 doesNotMatch 已经把"不许再挂回某条消息"钉死。）

  // ★ 双路线：结算按钮上的价格必须跟着**选中的生成路线**走。
  //   选了高级（25 钻）按钮却写 x10、扣的却是 25 —— 那是在扣费那一刻说假话。
  //   判据与 submit 里带 tier 的判据必须逐字同源，两处各写各的迟早对不上。
  assert.match(posterWxml, /x\{\{premiumOn&&tier==='premium'\?premiumPrice:price\}\}/, '按钮价格要跟随路线');
  assert.match(poster, /brief\.tier = this\.data\.premiumOn \? this\.data\.tier : 'standard';/, '提交带的路线判据同源');
  // 2026-08-16：这块从常驻的「创作方式」两卡挪进了「换方式」展开区，守卫仍旧是 premiumOn ——
  // 判据没变（高级档不可用就一个字都不许露），只是它现在挂在展开区里的那张卡上。
  assert.match(posterWxml, /wx:if="\{\{premiumOn[^"]*"[\s\S]{0,600}主视觉大片/, '主视觉大片不可用时整条路线不渲染');
  // 冷启动（没有对话上下文）不是故障：服务端现在回空草稿（2026-08-13 前是 422 MESSAGE_ID_REQUIRED），
  // 弹报错横幅会把一次正常的空白表单说成出了事。
  assert.match(poster, /hasDraftBrief \|\| !this\.data\.messageId \? '' :/, '冷启动不报"预填没取到"');
  // 2026-08-14 走查：取需求单是服务端拿整段对话过模型抽（briefDraft），几秒起步，
  // 而这一屏此前只有一行灰字「正在取需求单」，看着像卡死。转圈 + 说明 + 表单骨架，一样不能少。
  assert.match(posterWxml, /wx:if="\{\{loading\}\}" class="ps-loading">[\s\S]{0,400}ps-spin/, '取需求单要有转圈');
  assert.match(posterWxml, /ps-sk-card/, '取需求单要有表单骨架');

  // ── 2026-08-15 确认页信息架构重排（C 组）──
  // 旧结构把「上传素材」和整张表一起塞进一个叫「这些细节要改吗」的折叠区：
  // 问句入口让人以为不点开就漏了东西，而三个素材槽（人像 / Logo / 二维码）根本不是「细节」，
  // 是这张图长什么样的一部分。新结构按互联网 App 常规姿势分组，入口一律用动词。
  assert.doesNotMatch(posterWxml, /这些细节要改吗|ps-more/, '「这些细节要改吗」折叠区必须已经废除');
  assert.doesNotMatch(poster, /showForm|toggleForm/, 'showForm/toggleForm 随折叠区一起拆干净');
  assert.match(posterWxml, /class="ps-group-t">编辑内容<[\s\S]{0,400}bindtap="toggleEdit"[\s\S]{0,120}\{\{showEdit\?'收起':'编辑'\}\}/,
    '「编辑内容」入口用动词（编辑 / 收起），不用疑问句');
  assert.match(posterWxml, /wx:if="\{\{!showEdit\}\}" class="ps-sum"[\s\S]{0,300}summaryRows/, '收起态给摘要行而不是一片空白');
  assert.match(poster, /refreshSummary\(\)\s*\{[\s\S]{0,600}'主标题'[\s\S]{0,200}'卖点'[\s\S]{0,200}'行动号召'/,
    '摘要行 = 主标题 / 卖点 / 行动号召');
  // ★ 上传素材从折叠区提出来常驻显示：三槽都要在，且每槽带一句用途说明。
  const uploadBlock = posterWxml.match(/<text class="ps-group-t">上传素材<[\s\S]*?<\/view>\s*<view wx:if="\{\{submitErr\}\}"/);
  assert.ok(uploadBlock, '「上传素材」必须是一个常驻分组');
  assert.doesNotMatch(uploadBlock[0], /wx:if="\{\{showEdit\}\}"/, '上传素材不许再被折叠开关罩住');
  assert.match(uploadBlock[0], /wx:for="\{\{assets\}\}"/, '三个素材槽照 assets 渲染');
  assert.match(uploadBlock[0], /class="ps-slot-h">\{\{item\.hint\}\}/, '每槽一句用途说明');
  for (const hint of ['本人照片，用于「本人形象」方向', '排在画面角落，做品牌落款', '排在成品下方，扫码找到你']) {
    assert.ok(poster.includes(hint), `素材槽用途说明缺一条：${hint}`);
  }
  // 二维码空槽的贴码位提示：不传也会预留，说清了用户才不会为了加个码再扣一次钻石。
  assert.match(uploadBlock[0], /item\.role==='qr'&&!item\.path[\s\S]{0,80}不传也会预留贴码位/, '二维码空槽要说明会预留贴码位');
  // premium 素材提示：人像槽**置灰不消失**，点击给解释（消失了用户只会以为功能没了）。
  assert.match(uploadBlock[0], /tier==='premium'[\s\S]{0,160}Logo 与二维码会由军师排进成品；本人照片暂不进入主视觉（人物方向为 AI 演绎）/,
    'premium 下素材区提示要说清 Logo/二维码进成品、本人照片不进主视觉');
  assert.match(uploadBlock[0], /ps-slot-add \{\{item\.disabled\?'off':''\}\}/, 'premium 下人像槽置灰而不是消失');
  assert.match(poster, /assetsForTier\(tier\)\s*\{[\s\S]{0,300}disabled: tier === 'premium'/, '置灰只针对人像槽且只在 premium');
  assert.match(poster, /item\.role === role && item\.disabled[\s\S]{0,400}wx\.showModal/, '点置灰槽要给解释，不能沉默');
  // 版式：一级密度分档 + 二级横滑，档与卡完全由 status 下发的清单驱动（本地不补目录、不猜密度）。
  assert.match(posterWxml, /wx:for="\{\{templateGroups\}\}" wx:for-item="group"[\s\S]{0,200}group\.tab[\s\S]{0,60}chooseDensity|chooseDensity[\s\S]{0,60}group\.tab/,
    '版式一级 = 密度三档（点得动）');
  assert.match(posterWxml, /class="ps-tpl-scroll"[^>]*scroll-x="\{\{true\}\}"[\s\S]{0,300}wx:for="\{\{densityItems\}\}"/,
    '版式二级 = 该档下的版式横滑');
  assert.match(posterWxml, /wx:if="\{\{templateGroups\.length>1\}\}"/,
    '只有一档时不渲染档位条：老服务端没下发 density，摆一排空标签是凭空造分类');
  assert.match(poster, /const DENSITY_LABEL = \{ airy: '留白', balanced: '均衡', dense: '信息量' \}/, '三档中文短标签（方案卡摘要用）');
  assert.match(poster, /const DENSITY_TAB = \{ airy: '只说一句话', balanced: '均衡', dense: '信息全放上' \}/,
    '一级分档的入口文案说人话，不出现「密度」这类内部词');
  assert.match(poster, /function groupTemplates\(templates\)[\s\S]{0,700}return \[\{ key: 'all', label: '', tab: '全部版式', items: list \}\]/,
    '一套都没带 density 时退回单组平铺，不许凭空造出空档位');
  // ── 2026-08-16 确认页再重排：军师方案卡默认 + 三处可改 ──
  // 旧结构把「创作方式」「创作方向」「版式」三块常驻摊开，等于让每个刚跟军师聊完的人
  // 先做三道选择题——那正是他花钱请军师替他定的三件事。现在服务端下发 recommendation
  // （方式 / 方向 / 版式 + 一句为什么），主视图收成一张方案卡，改的人才点开入口。
  assert.match(posterWxml, /class="ps-plan">[\s\S]{0,400}designNote[\s\S]{0,200}recoReason/,
    '方案卡 = 设计说明原文 + 推荐理由');
  assert.match(posterWxml, /class="ps-plan-sum">[\s\S]{0,600}plan\.way[\s\S]{0,400}plan\.direction[\s\S]{0,400}plan\.template[\s\S]{0,400}plan\.price/,
    '组合摘要行 = 方式 · 方向 · 版式（含密度标签）· 价格');
  assert.match(poster, /plan: \{[\s\S]{0,400}price: Number\.isFinite\(Number\(price\)\) \? Number\(price\) : null/,
    '摘要行的价格按当前路线实价算');
  assert.match(poster, /refreshPlan\(\)/, '改方式/方向/版式之后要重算摘要');
  for (const method of ['chooseTier', 'chooseDirection', 'chooseTemplate', 'chooseDensity']) {
    assert.match(poster, new RegExp(`${method}\\(event\\)[\\s\\S]{0,420}this\\.refreshPlan\\(\\)`),
      `${method} 之后摘要行与价格必须当场更新`);
  }
  // 三个入口的文案（2026-08-17 改名：换方式/换方向/调整版式 → 出图方式/画面内容/排版密度）。
  // 原来的守卫写的是「一律动词」，那是为了防疑问句入口（「要换个方式吗？」会让人以为不点开就漏了东西）。
  // 新名字是名词短语，动词那条不再适用；真正要守的是**不出现疑问句、不出现内部字段名**，所以改成
  // 逐字钉住这三个标签本身——它们是产品定过的文案，改动必须是显式的。
  for (const label of ['出图方式', '画面内容', '排版密度']) {
    assert.match(posterWxml, new RegExp(`data-panel="[a-z]+" bindtap="openPanel"><text>${label}<`), `入口文案：${label}`);
  }
  assert.doesNotMatch(posterWxml, /bindtap="openPanel"><text>[^<]*[？?]/, '入口不许写成疑问句');
  // 内部字段名一律不许露给用户。「密度」原来也在这张黑名单上（当时判定它是设计术语），
  // 2026-08-17 产品选定「排版密度」作入口文案，故只对这一个标签开口子，其它位置照旧禁用。
  assert.doesNotMatch(posterWxml, /<text[^>]*>[^<{]*(tier|directionKey|templateKey)/,
    '面向用户的文案里不许出现 tier / directionKey / templateKey 这类内部词');
  const densityMentions = posterWxml.match(/<text[^>]*>[^<{]*密度[^<]*<\/text>/g) || [];
  assert.deepEqual(densityMentions.map((m) => m.replace(/<[^>]+>/g, '')), ['排版密度'],
    '「密度」只允许出现在那一个入口标签上，别处仍视为内部术语');
  // ★ 没有 recommendation（老服务端 / 抽取失败）时回退现行为：三个选择器常驻展开，入口不渲染。
  assert.match(poster, /const reco = normalizeRecommendation\(draft && draft\.recommendation/, '推荐组合走共享归一');
  assert.match(poster, /updates\.hasReco = !!reco;/, 'hasReco 由归一结果决定，不是猜的');
  for (const panel of ['way', 'direction', 'template']) {
    assert.match(posterWxml, new RegExp(`!hasReco\\|\\|panel==='${panel}'`), `没有推荐时「${panel}」这块必须常驻展开`);
  }
  assert.match(posterWxml, /wx:if="\{\{hasReco\}\}" class="ps-plan-acts"/, '没有推荐时不摆三个开关（那三块本来就摊开着）');
  // ★ 推荐只在首屏落一次：用户改过之后不许被回写覆盖。刷新清单是最容易偷偷回写的那条路。
  const refreshBlock = poster.match(/async refreshTemplates\(\)[\s\S]*?\n  \},/);
  assert.ok(refreshBlock, '缺少 refreshTemplates');
  assert.doesNotMatch(refreshBlock[0], /reco|recommendation/i, '刷新清单不许把推荐值盖回用户的选择');
  const planBlock = poster.match(/refreshPlan\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(planBlock, '缺少 refreshPlan');
  assert.doesNotMatch(planBlock[0], /reco|recommendation/i, '摘要只读当前选择，不回头读推荐');
  // ★ 换方式：两档对比，各配一张该档下的真实样例 + 一句「差价买什么」+ 实际差价数字。
  assert.match(poster, /waySample\(tier\)\s*\{[\s\S]{0,500}item\.previewUrl && !item\.requiresPortrait/,
    '样例取 status.directions 的真实缩略图，且不拿「要本人照片」那张当门面');
  assert.match(poster, /standard: '军师用图形与排印现场作画'/, '标准档一句差价买什么');
  assert.match(poster, /premium: 'AI 先出实拍质感主视觉，再排中文'/, '高级档一句差价买什么');
  assert.match(poster, /premiumDelta: Math\.max\(0, Number\(this\.data\.premiumPrice \|\| 0\) - Number\(this\.data\.price \|\| 0\)\)/,
    '差价按 status 实价算，不写死');
  assert.match(posterWxml, /wx:if="\{\{premiumDelta\}\}"[^>]*>比创意排版多 \{\{premiumDelta\}\}/, '差价数字要露给用户');
  // 方向/路线的报错在面板收起时也要看得见，并把该开的那块打开（收起来的错误等于没报）。
  assert.match(posterWxml, /class="ps-plan-acts"[\s\S]{0,900}wx:if="\{\{errors\.direction\}\}" class="ps-ferr"/,
    '方向报错常驻在方案卡下面');
  assert.match(poster, /if \(errors\.direction\) \{[\s\S]{0,200}panel: this\.data\.tier === 'premium' && hasPortrait \? 'way' : 'direction'/,
    '报错要把对应的面板打开');
  // 档位插画引的 /assets/tier/*.jpg 从来没进过 src/assets，也就从没打进产物：实测每次进页面
  // 两张都触发 binderror、tierArt 立刻全 false。与其留一段永远走 catch 的死代码，不如拆掉。
  assert.doesNotMatch(posterWxml, /src="[^"]*assets\/tier\//, '不许引用没打进产物的档位插画');
  assert.doesNotMatch(poster, /tierArt/, 'tierArt 兜底随插画一起拆干净');
  // ★ normalizeStatus 是白名单：没显式搬过去的字段会被整层吃掉。档位上线时就漏了这两个，
  //   于是 premiumOn 恒 false、选择器一次都没渲染出来（页面/契约/服务端全对，中间层吃了字段）。
  const creativeLib = fs.readFileSync(path.join(sourceRoot, 'packages/work/poster/creative.js'), 'utf8');
  assert.match(creativeLib, /premiumPricePerPoster: num\(status\.premiumPricePerPoster\)/, 'status 归一必须搬高级档单价');
  assert.match(creativeLib, /premiumAvailable: status\.premiumAvailable === true/, '缺省不可用：没说可用就别露出来');
  // 详情页「换风格」按本单档位定价（regenerate 继承父单 tier、按 priceForTier 扣费）。
  const posterJob = fs.readFileSync(path.join(sourceRoot, 'packages/work/posterJob/index.js'), 'utf8');
  assert.match(posterJob, /applyTierPrice\(\)/, '详情页必须按档位定价');
  // 2026-08-14 卡死实录：共享 api 没导出 isMock（那是 video 包私有 api 才有的），
  // 而通知模板的取数被同步放进了 onLoad 主链 → api.isMock() 抛 TypeError → onLoad 中断、
  // reload() 压根不跑 → 页面永远停在加载态、看不到成品。两条守卫钉住教训：
  assert.doesNotMatch(posterJob, /api\.isMock\(/, '共享 api 没有 isMock，别调');
  assert.doesNotMatch(posterJob, /this\.setData\(\{ jobId \}\);\s*\n\s*this\.loadNotificationTemplate\(\)/,
    'onLoad 主链上不许挂锦上添花的取数——它一抛，看图整条链就断了');
  assert.match(posterJob, /this\.data\.job && this\.data\.job\.tier === 'premium'/, '档位来自任务详情，不是猜的');
  // 2026-08-14 走查：成品图取不到（600 秒签名过期 / 资源被清）时，「保存相册 / 分享好友」
  // 照常摆在那儿当主动作，点下去弹「保存失败，请重试」与「暂时打不开转发，可先存相册」——
  // 重试一百次也没用，存相册走的还是同一条死链接。缺图态的唯一正解是「重新获取」。
  const posterJobWxml = fs.readFileSync(path.join(sourceRoot, 'packages/work/posterJob/index.wxml'), 'utf8');
  assert.match(posterWxml, /<scroll-view class="ps-dir-scroll"[^>]*scroll-x="\{\{true\}\}"/,
    '三张方向样例要用横向大图卡，不能在手机上挤成三列小字');
  assert.match(posterJobWxml, /<scroll-view class="pj-dir-scroll"[^>]*scroll-x="\{\{true\}\}"/,
    '收费换方向面板也必须沿用可读的大图卡');
  assert.match(posterJobWxml, /wx:if="\{\{!assetUrl\}\}" class="pj-btn primary" bindtap="reload"/,
    '缺图时主动作是「重新获取」');
  assert.match(posterJobWxml, /<view wx:if="\{\{assetUrl\}\}" class="pj-acts">[\s\S]{0,400}bindtap="saveAlbum"/,
    '缺图时保存/分享整排收起');
  assert.match(posterJob, /async saveAlbum\(\) \{[\s\S]{0,200}!this\.posterSource\(\)[\s\S]{0,60}warnNoAsset/,
    '保存前挡缺图，别落进通用 catch');
  assert.match(posterJob, /async shareFriend\(\) \{[\s\S]{0,200}!this\.posterSource\(\)[\s\S]{0,60}warnNoAsset/,
    '分享前挡缺图');
  assert.doesNotMatch(posterJob, /catch \(_\) \{ wx\.hideLoading\(\); wx\.showToast\(\{ title: '暂时打不开转发，可先存相册'/,
    '链接失效不许再建议「可先存相册」——那条路走的是同一条链接');
  assert.match(chat, /sessionId=\$\{encodeURIComponent\(this\._sessionId\)\}/);
  assert.match(chat, /openPosterJob\(event\)[\s\S]*?!item\.reportReady \|\| !isReportReady\(item\.messageId, item\.deliverable\)[\s\S]*?item\.deliverable && item\.deliverable\.creativeJobId[\s\S]*?\/packages\/work\/posterJob\/index\?jobId=/);

  assert.match(report, /creativeJobId:\s*str\(report\.creativeJobId\)/);
  assert.match(report, /generatePoster\(\)[\s\S]*?!this\.data\.posterEnabled[\s\S]*?emitAction\('poster'\)/);
  assert.match(report, /viewPoster\(\)[\s\S]*?!this\.data\.card\.creativeJobId[\s\S]*?emitAction\('viewposter'\)/);
  assert.match(reportWxml, /operable&&!streaming&&card\.creativeJobId/);
  assert.match(reportWxml, /operable&&!streaming&&posterEnabled/);
  assert.match(reportWxml, /native-icon name="diamond"/);
  assert.match(reportScss, /\.rc-poster\s*\{/);
  assert.doesNotMatch(`${chatWxml}\n${reportWxml}\n${posterWxml}`, /[💎⚡]/, '成品图链路不得回退 emoji 图标');

  const locked = poster.match(/else if \(code === 'AGENT_LOCKED'\) \{[\s\S]*?\n      \} else if \(code === 'INSUFFICIENT_CREDITS'/);
  assert.ok(locked, '海报页缺少 AGENT_LOCKED 原地启用分支');
  assert.match(locked[0], /Promise\.all\(\[store\.loadAgents\(\), store\.loadMe\(\)\]\)/);
  assert.match(locked[0], /agent\.key === 'poster'/);
  assert.match(locked[0], /this\.setData\(\{ unlockAgent: poster/);
  assert.doesNotMatch(locked[0], /market\/index|navigateTo|showModal/, '锁定后不得把用户丢到没有海报入口的市场页');
  assert.match(poster, /agentUnlocked\(\)[\s\S]*?请再次生成/);
  assert.match(posterWxml, /<agent-unlock agent="\{\{unlockAgent\}\}"[^>]*bindunlocked="agentUnlocked"/);
  assert.equal(posterJson.usingComponents?.['agent-unlock'], '/components/agent-unlock/index');
  assert.match(api, /creativeStatus:\s*\(\) => isMock\(\) \? mock\.creativeStatus\(\)/);
  // mock 必须与 H5 mock 同契约（两端各一份、字段必须齐）。路线字段缺任何一个，
  // 原生端确认页那块路线 UI 就无法完整渲染 —— 本地走查会以为"功能没做"，而不是"mock 少了字段"。
  assert.match(mock, /function creativeStatus\(\)[\s\S]*?enabled: true[\s\S]*?pricePerPoster: 10/);
  assert.match(mock, /function creativeStatus\(\)[\s\S]*?premiumPricePerPoster: 25/);
  assert.match(mock, /function creativeStatus\(\)[\s\S]*?premiumAvailable: true/);
  // ★ 方向清单与 hasPortrait：两端**各写一份**，删掉任何一边都必须红。
  //   少了 requiresPortrait，确认页与详情页都判不出「本人形象」要照片；少了任务视图上的
  //   hasPortrait，详情页「换方向」只能按 tier 过滤 —— 给没传照片的单摆出一个必 422 的死选项，
  //   而那页没有上传入口。本地走查只会以为「功能没做」，查不到是 mock 吃了字段。
  const h5Mock = fs.readFileSync(path.join(appRoot, 'src/services/mock.ts'), 'utf8');
  for (const [side, src] of [['原生', mock], ['H5', h5Mock]]) {
    assert.match(src, /directions: MOCK_POSTER_DIRECTIONS/, `${side} mock 的 creativeStatus 要下发方向清单`);
    for (const key of ['graphic_bold_type', 'graphic_symbol', 'graphic_portrait', 'photo_character', 'photo_product', 'photo_scene']) {
      assert.match(src, new RegExp(`key: '${key}'`), `${side} mock 的方向清单缺 ${key}`);
    }
    assert.match(src, /key: 'graphic_portrait'[^\n]*requiresPortrait: true/, `${side} mock 要标出「本人形象」需要照片`);
    assert.match(src, /hasPortrait: [^\n]*portraitAssetId/, `${side} mock 的任务视图要按 brief 回 hasPortrait`);
    // ★ 2026-08-15：版式扩到 8 套且每套带 density；确认页的密度分档、成品页的贴码位与风格名
    //   全靠这几个字段。两端各写一份，删掉任何一边都必须红——少一个字段本地走查只会以为
    //   「功能没做」，查不到是 mock 吃了字段。
    const keys = [...src.matchAll(/\{ key: '([a-z_]+)', name: '[^']+', desc: '[^']+', density: '(airy|balanced|dense)'/g)];
    assert.equal(keys.length, 8, `${side} mock 的版式清单要有 8 套且每套带 density`);
    assert.deepEqual(
      keys.map((m) => m[1]),
      ['person_hero', 'manifesto_min', 'quote_card', 'editorial', 'business_launch', 'data_stat', 'info_list', 'agenda_event'],
      `${side} mock 的版式 key 必须与服务端 TEMPLATE_CATALOG 逐字同源`,
    );
    assert.deepEqual(
      keys.map((m) => m[2]),
      ['airy', 'airy', 'airy', 'balanced', 'balanced', 'balanced', 'dense', 'dense'],
      `${side} mock 的版式密度分布要覆盖三档`,
    );
    assert.match(src, /qrReserved: !\(?(?:rec|row)\.brief/, `${side} mock 的任务视图要回 qrReserved`);
    assert.match(src, /styleName: [\s\S]{0,120}mockStyleName\(/, `${side} mock 的任务视图要回 styleName`);
    assert.match(src, /brief\.tier === 'premium' \? \{ tier: 'premium' as const, styleName|brief\.tier === 'premium' \? 'premium' : undefined/,
      `${side} mock 的 styleName 只给主视觉大片`);
    assert.match(src, /designNote: '竖版三分构图/, `${side} mock 的需求单草稿要带设计说明（确认页主视图）`);
    // ★ 2026-08-16：确认页主视图改成军师方案卡，数据源是 brief-draft 的 recommendation。
    //   两端 mock 各写一份，且**两条路径都要留**：带推荐（方案卡）与不带推荐（老服务端 → 回退成
    //   选择器展开）。少了后者，回退那一屏本地永远走查不到，线上遇到老响应才发现是空白。
    assert.match(src, /recommendation = \{|recommendation: \{/, `${side} mock 的需求单草稿要带军师推荐组合`);
    assert.match(src, /tier: 'standard'[\s\S]{0,80}directionKey: 'graphic_bold_type'[\s\S]{0,80}templateKey: 'person_hero'/,
      `${side} mock 的推荐组合必须落在自家方向/版式清单里，否则前端整条作废、只看得到回退态`);
    assert.match(src, /reason: '你要的是先让人记住这句主张/, `${side} mock 的推荐要带一句为什么（确认页原样展示）`);
    assert.match(src, /no-reco/, `${side} mock 要留一个「没有 recommendation」的老响应用例`);
  }
  // 详情页：贴码位与风格名是成品图下面的两行事实，缺省不渲染整行。
  assert.match(posterJobWxml, /wx:if="\{\{styleName\}\}" class="pj-meta-l">本次风格：\{\{styleName\}\}/, '风格名要能透出且缺省不渲染');
  assert.match(posterJobWxml, /wx:if="\{\{qrReserved\}\}" class="pj-meta-l">已预留贴码位，可保存后自行粘贴二维码/, '预留贴码位要在成品图下方说明');
  assert.match(posterJob, /styleName: job\.tier === 'premium' \? String\(job\.styleName \|\| ''\) : ''/, '风格名只在主视觉大片下有意义');
  assert.match(posterJob, /qrReserved: job\.qrReserved === true/, '贴码位缺省 false：服务端没说预留就不许说预留');
  // 详情页「换方向」的清单 = 路线 ∩ 照片事实，两个条件缺一不可。
  assert.match(posterJob, /item\.tier === tier && \(!item\.requiresPortrait \|\| hasPortrait\)/,
    '换方向清单必须同时按路线和 hasPortrait 过滤');
  assert.match(posterJob, /async refreshTemplates\(\)[\s\S]{0,700}activeDirectionsFor\(status\.directions, this\.data\.job\)/,
    '刷新方向清单也必须复用照片门禁，不能把「本人形象」死选项重新放出来');
  // 照片刚选定 / 刚清除的那一刻才拨方向；不许在渲染里强制，否则用户手动改选会被反复顶回去。
  assert.match(poster, /syncDirectionForPortrait\(hasPortrait\)/, '确认页要有照片→方向的同步');
  assert.match(poster, /this\.setData\(\{ assets \}\);\s*\n\s*if \(role === 'portrait'\) this\.syncDirectionForPortrait\(true\);/,
    '自动切方向挂在上传成功那一刻');
  assert.match(poster, /if \(role === 'portrait'\) this\.syncDirectionForPortrait\(false\);/, '清除照片要回落方向');
  // 创意排版恒可选；主视觉大片只在 premiumOn 时渲染，两条路线都要能点。
  assert.match(posterWxml, /data-key="standard"[\s\S]*?wx:if="\{\{premiumOn\}\}"[^>]*data-key="premium"/);
  assert.match(poster, /chooseTier\(event\)/);
  assert.match(poster, /brief\.tier = this\.data\.premiumOn \? this\.data\.tier : 'standard'/);
});

test('构建命令只允许原生微信端与 Taro H5，且产物物理隔离', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['build:weapp'], 'node scripts/build-native-weapp.mjs');
  assert.equal(pkg.scripts['dev:weapp'], 'node scripts/build-native-weapp.mjs --watch');
  assert.match(pkg.scripts['build:weapp:server'], /^node scripts\/build-native-weapp\.mjs\b/);
  assert.match(pkg.scripts['build:weapp:preprod'], /^node scripts\/build-native-weapp\.mjs\b/);
  assert.doesNotMatch(Object.values(pkg.scripts).join('\n'), /\btaro\s+build\b[^\n]*--type(?:\s+|=)weapp\b/);
  assert.equal(pkg.dependencies?.['@tarojs/plugin-platform-weapp'], undefined);
  assert.equal(pkg.devDependencies?.['@tarojs/plugin-platform-weapp'], undefined);
  for (const name of ['build:h5', 'dev:h5', 'build:h5:server', 'dev:h5:server']) {
    assert.match(pkg.scripts[name], /taro\s+build\s+--type\s+h5/, `${name} 必须保留 Taro H5`);
  }

  const project = JSON.parse(fs.readFileSync(path.join(appRoot, 'project.config.json'), 'utf8'));
  assert.equal(project.miniprogramRoot, 'dist-native/');
  const taroConfig = fs.readFileSync(path.join(appRoot, 'config/index.ts'), 'utf8');
  assert.match(taroConfig, /outputRoot:\s*'dist-h5'/);
  assert.match(taroConfig, /taroEnv\s*&&\s*taroEnv\s*!==\s*'h5'/, 'Taro 配置必须拒绝非 H5 目标');
  assert.doesNotMatch(taroConfig, /\bmini\s*:/, 'Taro 主配置不得再维护微信端构建分支');
  assert.doesNotMatch(taroConfig, /PatchWeappAppJsonPlugin|EmitJunshiBuildMetaPlugin|schemaVersion:\s*1/);

  const serveH5 = fs.readFileSync(path.join(appRoot, 'scripts/serve-h5.mjs'), 'utf8');
  assert.match(serveH5, /['"]dist-h5['"]/);
  assert.doesNotMatch(serveH5, /['"]dist\/?['"]/, 'H5 本地服务器不得回读旧 dist 目录');
});

test('预览、上传与正式发布只接受 dist-native 原生产物', () => {
  const builder = fs.readFileSync(path.join(appRoot, 'scripts/build-native-weapp.mjs'), 'utf8');
  const preview = fs.readFileSync(path.join(appRoot, 'scripts/weapp-preview.mjs'), 'utf8');
  const upload = fs.readFileSync(path.join(appRoot, 'scripts/weapp-upload.mjs'), 'utf8');
  const release = fs.readFileSync(path.join(appRoot, 'scripts/weapp-release.mjs'), 'utf8');
  const scripts = `${preview}\n${upload}\n${release}`;

  assert.match(builder, /schemaVersion:\s*2,\s*runtime:\s*'native-weapp'/, '原生构建器与上传校验的元数据口径必须一致');
  assert.match(preview, /const PROJ = path\.join\(APP_ROOT, 'dist-native'\)/);
  assert.match(preview, /assertNativeBuild\(PROJ\)/, '真机预览也必须拒绝旧 Taro 微信产物');
  assert.match(upload, /const PROJ = path\.join\(APP_ROOT, 'dist-native'\)/);
  assert.match(upload, /assertReleaseBuild\(PROJ/);
  assert.match(release, /const DIST_ROOT = path\.join\(APP_ROOT, 'dist-native'\)/);
  assert.match(release, /build-native-weapp\.mjs/);
  assert.match(release, /\['islogin', '--project', DIST_ROOT\]/);
  assert.match(release, /\['upload', '--project', DIST_ROOT,/);
  assert.doesNotMatch(release, /build:weapp:server|--project', APP_ROOT/);
  assert.doesNotMatch(scripts, /path\.join\(APP_ROOT, ['"]dist['"]\)|TARO_APP_|taro\s+build/);
});

// 2026-08-08 真机三反馈（停止后重发卡死 / 历史行铺满屏 / 资料库混进粘贴附卷）的回归闸门。
// 三条都是「看起来对、真机才炸」的类型，静态钉死比事后复盘便宜。
test('停止生成后必须能立刻重发，且空气泡不留屏', () => {
  const core = read(chatCoreRoot, 'behavior.js');

  // ① thinking 阶段按停止：那条一个字都没出的军师气泡必须从消息流里摘掉，
  //    否则它会和下一轮的 thinking 点叠成两个「军师 ···」（真机实拍）。
  const interrupted = core.match(/markStreamInterrupted\(\)\s*\{[\s\S]*?\n {2}\},/);
  assert.ok(interrupted, '未能定位 markStreamInterrupted');
  assert.match(interrupted[0], /messages\.slice\(0, index\)/, '停在 thinking 阶段时必须移除空气泡');

  // ② 会话上真有在途生成（另一端发起）时接管它，而不是把用户晾在错误态里。
  assert.match(core, /GENERATION_IN_PROGRESS[\s\S]{0,400}startPolling\(inProgressId/,
    '收到 GENERATION_IN_PROGRESS 必须接管那条生成');

  // ③ stop/cancel 是两条独立网络请求；续发必须先等取消事务确认（其中会释放旧任务预留），
  //    不能只在本地把 busy 清掉就立刻建下一轮。
  assert.match(core, /this\._cancelPromise\s*=\s*pendingCancel/,
    '停止生成必须保存服务端取消确认 Promise');
  assert.match(core, /const pendingCancel = this\._cancelPromise;[\s\S]{0,180}await pendingCancel;/,
    '下一轮发送必须等待上一轮取消确认');
});

test('历史会话行的多行文本在数据层折行，不指望 white-space', () => {
  const sessions = read(sourceRoot, 'pages/sessions/index.js');
  // 微信 <text> 会把 \n 当真换行渲染，CSS 的 nowrap 管不住；不折就会铺满半屏（真机实拍）。
  assert.match(sessions, /function oneLine\(value\)[\s\S]{0,160}replace\(\/\\s\+\/g, ' '\)/);
  assert.match(sessions, /title: oneLine\(item\.title\)/);
  assert.match(sessions, /snippet: oneLine\(item\.snippet\)/);
});

test('资料库把对话附卷与主动上传分组，且不隐藏', () => {
  const js = read(sourceRoot, 'packages/work/knowledge/index.js');
  const wxml = read(sourceRoot, 'packages/work/knowledge/index.wxml');
  assert.match(js, /function isPasted\(row\)[\s\S]{0,220}sourceType === 'paste'/);
  assert.match(js, /items: uploads\.map\(viewRow\)/);
  assert.match(js, /pasteItems: pastes\.map\(viewRow\)/);
  // 分组必须仍可展开、可删除——那些附卷还被会话引用着，隐藏掉等于用户再也管不到它们。
  assert.match(wxml, /kb-paste-head[\s\S]{0,200}bindtap="togglePaste"/);
  assert.match(wxml, /wx:if="\{\{pasteOpen\}\}"[\s\S]{0,600}catchtap="remove"/);
});

test('未开通方案有明确的开通入口，不落到通用「XX 失败」兜底', () => {
  const store = read(sourceRoot, 'services/store.js');
  // 禁写闸（服务端 403 PLAN_REQUIRED）打在每一个写操作上。通用兜底只会弹一句失败，
  // 用户看不出「要先开通」，付费转化路径断在最后一步 —— 必须由 store 统一给开通入口。
  assert.match(store, /apiErrorPresentation\(error, opts\.fallbackTitle\)/);
  assert.match(store, /function promptErrorAction\(view\)[\s\S]{0,900}\/packages\/work\/plans\/index/);
  // silent 调用方（对话流）自己渲染，store 不能替它弹窗，否则错误态会双弹。
  assert.match(store, /if \(!opts\.silent\)[\s\S]{0,240}promptErrorAction\(view\)/);

  const core = chatSource();
  // ① 发送前就拦：别让用户写完一整段话才被 403 打回来。
  assert.match(core, /store\.planRequired\(\)[\s\S]{0,120}store\.promptPlanRequired\(\)/);
  // ② 真撞上 403 时不能给「重试」——重试多少次都还是 403。
  assert.match(core, /kind === 'plan_required'[\s\S]{0,240}this\.finishBusy\(chatErrorPatch\(error\), epoch\)/);
  const errorSemantic = read(sourceRoot, 'services/chat-error.js');
  assert.match(errorSemantic, /code === 'PLAN_REQUIRED'[\s\S]{0,260}action: 'plans'[\s\S]{0,120}retryable: false/);
});

test('字体栈在小程序产物里必须是字面量，不留 var(--serif) 给真机运行时解析', () => {
  // 2026-08-09 真机：同一台安卓机，Chrome 与微信内置浏览器打开 H5/后台中文都是宋体，只有小程序不是。
  // 两个浏览器环境已排除「设备没字体」和「字体栈写错」；剩下的差别只有 WXSS 运行时，
  // 而本仓早有两处教训写着真机对 page 级 token 不可靠（z-index、主题色都被迫就地展开）。
  const dist = path.join(appRoot, 'dist-native');
  if (!fs.existsSync(dist)) return; // 未构建时跳过（CI 里由构建步骤保证）
  const wxss = walk(dist).filter((file) => file.endsWith('.wxss'));
  assert.ok(wxss.length, '产物里应有 wxss');
  for (const file of wxss) {
    const css = fs.readFileSync(file, 'utf8');
    assert.ok(!/var\(--serif\)|var\(--sans\)/.test(css), `${path.relative(dist, file)} 仍在用 var() 取字体，真机可能解析不出`);
  }
  const app = fs.readFileSync(path.join(dist, 'app.wxss'), 'utf8');
  assert.match(app, /\.serif \{\s*font-family: "JunshiSerif", "Songti SC"/, '.serif 必须落成字面量字体栈（自带字体排第一位）');
  // token 本身仍留在 :root/page 上作单一事实源——展开发生在构建期，SCSS 里别去掉定义。
  assert.match(app, /--serif:\s*"JunshiSerif", "Songti SC"/, '字体 token 定义不能删：它是构建期展开的事实源');
});

test('自带字体：family 名三处一致，未配托管地址时静默跳过而不是报错', () => {
  const font = read(sourceRoot, 'services/font.js');
  const appJs = read(sourceRoot, 'app.js');
  const scss = fs.readFileSync(path.join(appRoot, 'src', 'app.scss'), 'utf8');
  const builder = fs.readFileSync(path.join(appRoot, 'scripts', 'build-native-weapp.mjs'), 'utf8');

  // family 名分散在三处（字体栈第一位 / 构建期常量 / loadFontFace 的 family），对不上就是白加载。
  assert.match(scss, /--serif:\s*"JunshiSerif",/, '字体栈第一位必须是自带字体');
  assert.match(builder, /APP_FONT_FAMILY = 'JunshiSerif'/);
  assert.match(builder, /APP_FONT_WEIGHTS = \[400, 600\]/, '只发正文与标题两个字重');
  assert.match(font, /junshi-serif-\$\{weight\}\.woff2"\) format\("woff2"\)/);
  // 字体文件随 H5 产物发布，两端必须指同一个地址，否则会出现「H5 是宋体、小程序不是」的老问题。
  assert.match(builder, /APP_FONT_BASE = \(process\.env\.WEAPP_APP_FONT_BASE \|\| 'https:\/\/wxapi\.aibuzz\.cn\/fonts'\)/);
  assert.match(font, /desc: \{ style: 'normal', weight: String\(weight\) \}/, '两个字重必须各自声明 desc，否则后一个会盖掉前一个');

  // 未配 base / 老版本基础库没有 loadFontFace → 直接 return，不许抛。字体是观感增强，不能拖垮启动。
  assert.match(font, /if \(!base \|\| !family \|\| !weights\.length\) return;/);
  assert.match(font, /typeof wx\.loadFontFace !== 'function'\) return;/);
  assert.match(font, /global: true/);
  assert.match(font, /scopes: \['webview', 'native'\]/);
  // 失败静默：不弹 toast、不打断
  assert.match(font, /fail: \(\) => \{\}/);
  // 只在 onLaunch 触发一次
  // onLaunch 现在接 options（冷启动捕获分享带来的邀请码，见 services/invite.js），
  // 且体内多了说明注释，故放宽形参与窗口；这条断言守的仍是「loadAppFont 在 onLaunch 里被调一次」。
  assert.match(appJs, /onLaunch\((?:options)?\)\s*\{[\s\S]{0,900}loadAppFont\(\)/);
  assert.match(font, /let started = false;[\s\S]{0,400}if \(started\) return;/);
});

test('底栏五图标与 H5 同一套自绘线稿：stroke 1.6、路径逐字一致、锦囊是袋不是箱', () => {
  // 2026-08-09 视觉反馈的根因：两端图标不是一套——weapp 走 lucide（stroke 2 偏粗；pouch 映到
  // archive 收纳箱，靠 26px 特调补分量）。构建脚本现从 H5 Icon 组件抽取同一份路径发射 SVG。
  const iconTsx = fs.readFileSync(path.join(appRoot, 'src', 'components', 'Icon', 'index.tsx'), 'utf8');
  const dist = path.join(appRoot, 'dist-native', 'assets', 'native-icons');
  if (!fs.existsSync(dist)) return; // 未构建时跳过（与字体产物断言同一模式）
  for (const name of ['counsel', 'sandtable', 'muster', 'brocade', 'lord', 'conversation', 'flag', 'token', 'pouch', 'crown']) {
    const m = iconTsx.match(new RegExp(`^\\s{2}${name}: '(.+)',$`, 'm'));
    assert.ok(m, `Icon/index.tsx 里找不到 ${name} —— PATHS 写法变了要同步 build 脚本的抽取正则`);
    const svg = fs.readFileSync(path.join(dist, `${name}-neutral.svg`), 'utf8');
    assert.ok(svg.includes('stroke-width="1.6"'), `${name} 应为 1.6 细笔画，不是 lucide 的 2`);
    assert.ok(svg.includes(m[1].replaceAll('CCC', '#969BA1')), `${name} 产物路径与 H5 不一致`);
  }
  // 底栏分离三件套：暖底、暖发丝线、白描边死刑——白边压白底等于没画。
  const barScss = fs.readFileSync(path.join(appRoot, 'src', 'custom-tab-bar', 'index.scss'), 'utf8');
  assert.match(barScss, /background: rgba\(246, 243, 235, \.92\)/);
  assert.match(barScss, /border: 1px solid rgba\(203, 193, 168, \.55\)/);
  // 只盯 .tabbar 块本身：角标（.tab-badge/.tab-dot）的白描边是压在半透明底栏上的，该留。
  const barBlock = barScss.match(/\.tabbar \{[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(barBlock, /rgba\(255, 255, 255, \.7\)/, '白描边压白底等于没画，别改回来');
});

// 2026-08-08 真机：首次入局的五步教学层被问策终态的底部浮岛压住（面板底部留白按 66px 旧底栏算，
// 浮岛约 159px），「下一步」按钮连同半截正文被盖掉。教学期间浮岛必须收成纯 tab 行。
test('教学层展示期间问策浮岛让位，不遮挡面板', () => {
  const wxml = read(sourceRoot, 'pages/sessions/index.wxml');
  const js = read(sourceRoot, 'pages/sessions/index.js');
  const coachJs = read(sourceRoot, 'components/coach-marks/index.js');

  assert.match(coachJs, /triggerEvent\('coachstate'/, '教学层开合必须广播给宿主页');
  assert.match(wxml, /<coach-marks bindcoachstate="onCoachState">/, '问策页必须接住教学层状态');
  assert.match(js, /onCoachState\(event\)[\s\S]{0,320}setData\(\{ coachOn \}\)/);
  // 输入行、分隔线、提示 pill 三者在教学期间都要让位；tab 行保留（箭头指的就是它）。
  assert.match(wxml, /<template wx:if="\{\{!coachOn && !showLogin\}\}" is="chat-composer"/, '教学或登录期间输入行必须收起');
  assert.match(wxml, /wx:if="\{\{!coachOn && !showLogin\}\}" class="isle-div"/);
  assert.match(wxml, /class="wence-pill"|!coachOn && !drawerOpen/, '教学期间提示 pill 必须收起');
  assert.match(wxml, /class="tabbar-inner"/, 'tab 行必须保留——教学箭头指的就是底栏');
});

// 2026-08-08 真机：老板页服务双卡没对齐——群卡横排（图标对两行文本居中）、老师卡纵排且图标
// 参与首行排版，首行被 26px 图标撑高，两卡的标题中心与图标中心各差几个像素。
test('老板页服务双卡内部节奏一致（图标对整卡居中，两行共用左基线）', () => {
  const scss = fs.readFileSync(path.join(appRoot, 'src/pages/profile/index.scss'), 'utf8');
  const wxml = read(sourceRoot, 'pages/profile/index.wxml');

  // 老师卡的图标必须脱离首行、对整卡垂直居中；两行文本靠卡片 padding-left 给同一条左基线。
  assert.match(scss, /\.service-action-teacher\s*\{[^}]*position:\s*relative[^}]*padding-left:\s*42px/s);
  assert.match(scss, /\.service-action-teacher \.sa-i\s*\{[^}]*position:\s*absolute[^}]*translateY\(-50%\)/s);
  assert.doesNotMatch(scss, /\.twi-ph\s*\{[^}]*padding-left:\s*33px/s, '次行不再各自缩进，左基线由卡片给');
  // 两个图标底盒同规格（26/圆角 9/居中），群卡不得留「四点码眼」时代的内边距与换行。
  assert.match(scss, /\.sa-qr\s*\{[^}]*border-radius:\s*9px[^}]*align-items:\s*center/s);
  assert.doesNotMatch(scss, /\.sa-qr\s*\{[^}]*flex-wrap:\s*wrap/s);
  assert.match(wxml, /class="sa-qr"><native-icon name="group" tone="green" size="16"/, '群图标与消息图标做过光学配平');
});

test('发版顺序：小程序先发时克隆不能被自家的报价闸挡死', () => {
  const cloneJs = read('weapp-native/packages/video/clone/index.js');
  // 小程序要过审、服务端是脚本发布，两者无法同时到位，所以只能「小程序先发、服务端后发」。
  // 这段时间里 /clone-pricing 是 404：服务端既不收钱也不校验确认报价。
  // 若把 404 和普通读失败混为一谈，新版小程序打到老服务端会被自己的 assertQuoteReady 挡死 ——
  // 唯一可行的发版顺序就变成了「克隆全挂」。
  assert.match(cloneJs, /statusCode === 404/, '必须把「服务端没有计费这一版」与「价格没读到」分开');
  assert.match(cloneJs, /pricingUnavailable/);
  assert.match(cloneJs, /assertQuoteReady\(\)\s*\{[\s\S]{0,300}?pricingUnavailable\) return true/,
    '服务端没有计费这一版时不许拦提交');
  // 反过来：其它失败（网络/5xx）仍然必须挡住 —— 不知道要扣多少就提交，等于回到「界面没说、系统照扣」。
  assert.match(cloneJs, /expectedCredits == null/);
});

test('内置素材不给删除入口：删不掉的动作就不该出现在界面上', () => {
  const wxml = read('weapp-native/packages/video/assets/index.wxml');
  const js = read('weapp-native/packages/video/assets/index.js');
  // 素材库把内置素材和自有素材混在一个库里展示，但内置的不属于用户、删不掉也改不了名。
  // 此前卡片上照给删除按钮，点下去服务端抛「素材不存在或无权访问」——
  // 听起来像 bug 或权限故障，真实原因只是「这条本来就删不得」。（2026-08-14 真机复现）
  assert.match(wxml, /!picking && !item\.preset[\s\S]{0,120}?deleteFromCard/,
    '内置素材卡片不得渲染删除按钮');
  assert.match(js, /asset\.preset\)\s*\{[\s\S]{0,80}?内置素材/,
    '长按菜单也要挡住，否则删除入口只是换了个地方');
});

test('存储空间：素材与成片共用一份额度，扩容价来自服务端且不许硬编码', () => {
  const js = read('weapp-native/packages/video/assets/index.js');
  const wxml = read('weapp-native/packages/video/assets/index.wxml');
  const api = read('weapp-native/packages/video/api.js');
  // 口径改了（2026-08-14）：不再是「素材库空间」，成片也占同一份额度。
  assert.match(wxml, /空间快满了[\s\S]{0,40}?成片/, '提示必须说清成片也占空间');
  // 扩容价一律来自服务端（运营后台可配），端上只显示。
  assert.match(api, /'\/assets\/storage\/expand'/);
  assert.match(js, /storage\.packCredits/);
  assert.doesNotMatch(js, /[0-9]{2,}\s*钻石(?!`)/, '扩容价不得硬编码在端上');
  // 价没读到 / 已买到上限 → 整块不渲染，而不是显示一个编出来的价
  assert.match(js, /canExpand = Number\(storage\.packBytes\) > 0 && Number\(storage\.packs\) < Number\(storage\.maxPacks\)/);
  assert.match(wxml, /wx:if="\{\{storage\.canExpand\}\}"/);
  // 花钱路径必须先确认再扣
  assert.match(js, /host\.confirm\([\s\S]{0,200}?扣 \$\{storage\.packCredits\} 钻石/);
  assert.match(js, /INSUFFICIENT_CREDITS/, '钻石不够要引到充值，而不是甩一句失败');
});

test('成片页必须声明转发：不实现 onShareAppMessage，微信会把「转发给朋友」置灰', () => {
  const js = read('weapp-native/packages/video/work/index.js');
  // 2026-08-17 报障：「短视频生成完成之后转发按钮置灰」。页面上并没有自绘的转发按钮 ——
  // 灰掉的是微信右上角 ⋯ 菜单里那一项，而它置灰的唯一原因就是页面没声明 onShareAppMessage。
  assert.match(js, /onShareAppMessage\(\)\s*\{/, '成片页缺 onShareAppMessage → 转发项恒置灰');
  const block = js.match(/onShareAppMessage\(\)\s*\{[\s\S]*?\n  \},/);
  assert.ok(block, '取不到 onShareAppMessage 实现');
  // path 必须是快拍入口、不带 workId：成片是私有资产，转出去对方也拿不到（本页无参会 toast 退回），
  // 与 mingpan / quickscan 同一条约定。
  // path 现在经 pathWithCode() 接上邀请码做裂变归因——落地页本身没变（仍是快拍入口、仍不带 workId），
  // 所以这条约定继续成立，只是外面多包了一层。
  assert.match(block[0], /path: pathWithCode\('\/packages\/video\/home\/index'\)/, '转发落地页必须是快拍入口（经 pathWithCode 接归因参数）');
  assert.doesNotMatch(block[0], /workId/, '转发路径不许带 workId —— 那是把别人的私有成片塞给对方');
});

test('平台代发未接入时不许摆可点的按钮：上游恒 503，点了只会白跑一趟', () => {
  const js = read('weapp-native/packages/video/work/index.js');
  const wxml = read('weapp-native/packages/video/work/index.wxml');
  // 2026-08-17 查实：AIStar ClipWorkService.publish() 里 `if(!shiliu.mockMode()) throw 503
  // CLIP_PUBLISH_NOT_CONFIGURED`，而生产必定走真实石榴网关 → mockMode() 恒 false → 四个平台按钮 100% 失败。
  assert.match(js, /const PUBLISH_READY = (false|true);/, '代发可用性必须是一个显式开关，不能散落在判断里');
  const ready = /const PUBLISH_READY = true;/.test(js);
  if (!ready) {
    // 关着的时候：不许弹确认框、不许打接口，且标题不许承诺「直接发布」。
    assert.match(js, /if \(!PUBLISH_READY\) \{[^}]*host\.toast/, '未接入时必须直接说明，不走确认框');
    const publishBlock = js.match(/publish\(event\)\s*\{[\s\S]*?\n  \},/);
    assert.ok(publishBlock, '取不到 publish 实现');
    assert.ok(
      publishBlock[0].indexOf('!PUBLISH_READY') < publishBlock[0].indexOf('host.confirm'),
      '早退必须在 host.confirm 之前——让用户确认一件做不到的事是最差的形态',
    );
    assert.match(wxml, /publishReady \? '保存，或者直接发布' : /, '标题必须跟着能力走，不许恒定承诺代发');
    assert.match(wxml, /publishReady \? '' : 'off'/, '未接入的平台芯片必须置灰');
  }
});

test('数字分身素材只直传一次，展示真实进度并按受理号恢复，不诱导重复上传', () => {
  const api = fs.readFileSync(path.join(sourceRoot, 'packages/video/api.js'), 'utf8');
  const request = fs.readFileSync(path.join(sourceRoot, 'services/request.js'), 'utf8');
  const clone = fs.readFileSync(path.join(sourceRoot, 'packages/video/clone/index.js'), 'utf8');
  const view = fs.readFileSync(path.join(sourceRoot, 'packages/video/clone/index.wxml'), 'utf8');
  const errors = fs.readFileSync(path.join(sourceRoot, 'services/api-error.js'), 'utf8');
  assert.match(api, /call\('\/avatar\/uploads',[\s\S]*directFileUpload\(ticket\.uploadUrl[\s\S]*\/complete/);
  assert.match(api, /waitCloneAccepted\(ticket\.uploadId/);
  assert.match(api, /error\.statusCode === 409/);
  assert.match(api, /forbid-overwrite[\s\S]{0,180}不能换 ID 再传一份/);
  assert.match(request, /function directUpload\([\s\S]*wx\.uploadFile/);
  assert.match(clone, /onProgress:\s*\(event\) => this\.updateUploadProgress\(event\)/);
  // 「原单还活着」的错误码一律不许换受理号 —— 换号 = 重复下单，还会让用户白传一遍文件。
  // 这里锁的是意图，不是某一种写法：两个码都必须在保留名单里，且换号要以「不在名单里」为条件。
  assert.match(clone, /aliveCodes\s*=\s*\[[^\]]*'CLIP_CLONE_ACCEPTING'[^\]]*\]/);
  assert.match(clone, /aliveCodes\s*=\s*\[[^\]]*'CLIP_CLONE_CREATING'[^\]]*\]/);
  assert.match(clone, /error\.statusCode && !stillAlive\) this\.cloneRequestId = ''/);
  assert.match(view, /上传后会自动受理，请不要重复提交/);
  assert.match(errors, /后台可能仍在处理，请不要重复提交/);
});

const readVideo = (rel) => fs.readFileSync(path.join(sourceRoot, 'packages/video/' + rel), 'utf8');

test('出片提交撞上「原单还在创建」时不许换请求号 —— 换号就是第二笔扣费', () => {
  const confirm = readVideo('confirm/index.js');
  // 服务端用 409 CLIP_RENDER_CREATING 表示原来那一单还在建。这时换号，下一次点击
  // 会再建一笔 hold、再建一个上游 job，正好是幂等机制要防的事。
  assert.match(confirm, /KEEP_REQUEST_ID_CODES[\s\S]{0,120}'CLIP_RENDER_CREATING'/);
  assert.match(confirm, /error\.statusCode && !stillAlive\) this\.newRenderRequestId\(\)/);
  // 明确不可复用的那条才换号并提示用户再点一次
  assert.match(confirm, /CLIP_RENDER_REQUEST_CLOSED[\s\S]{0,160}再点一次/);
});

test('出片进度页必须自己申请 clip 订阅：额度按 scene 存，avatar 的额度救不了 clip', () => {
  const rendering = readVideo('rendering/index.js');
  const view = readVideo('rendering/index.wxml');
  assert.match(rendering, /wx\.requestSubscribeMessage/);
  assert.match(rendering, /recordSubscribeChoice\(\{ scene: 'clip'/);
  // 模板没配就整块不渲染 —— 摆一个点了没反应的按钮比没有更糟
  assert.match(rendering, /scenes\.find\(\(item\) => item && item\.scene === 'clip'\)/);
  assert.match(view, /wx:if="\{\{notifyTemplate/);
});

test('素材连播：计时以真正开始播放为起点，切段用代次作废旧回调', () => {
  const shots = readVideo('shots/index.js');
  const view = readVideo('shots/index.wxml');
  // 以换 src 为起点计时的话，弱网缓冲三秒、画面只放两秒就切走，而这一屏正是用来核对节奏的
  assert.match(view, /bindplay="onPlayStarted"/);
  assert.match(view, /binderror="onPlayError"/);
  assert.match(shots, /onPlayStarted\(\)[\s\S]{0,240}scheduleAdvance/);
  // 快速连点上一段/下一段：旧的 setData 回调必须因为代次对不上被丢弃
  assert.match(shots, /if \(token !== this\.playToken\) return;/);
  assert.match(shots, /goPlayIndex\(index\)[\s\S]{0,200}this\.playToken = \(this\.playToken \|\| 0\) \+ 1;/);
  // 素材放不出来不能把用户卡在黑屏上
  assert.match(shots, /onPlayError\(\)/);
});

test('声音试听：关掉浮层或换一条声音后，在途请求回来不许再出声', () => {
  const comp = readVideo('components/voice-preview/index.js');
  assert.match(comp, /this\.gen = \(this\.gen \|\| 0\) \+ 1;/);
  assert.match(comp, /if \(gen !== this\.gen\) return;/);
  // innerAudioContext 必须销毁，否则多试听几次会攒下一串没释放的播放器
  assert.match(comp, /destroyAudio\(\)[\s\S]{0,200}destroy\(\)/);
});

test('形象创建要接住上游回的 voiceId，否则训练完成页的试听入口永远不出现', () => {
  const clone = readVideo('clone/index.js');
  const view = readVideo('clone/index.wxml');
  assert.match(clone, /if \(result && result\.voiceId\) patch\.voiceId = result\.voiceId;/);
  assert.match(view, /wx:if="\{\{training\.voiceDone && voiceId\}\}"/);
});

test('两个上传入口用同一道体积闸：超限的文件不该先传完再被 413 打回', () => {
  const shots = readVideo('shots/index.js');
  const assets = readVideo('assets/index.js');
  [shots, assets].forEach((source) => {
    assert.match(source, /ASSET_LIMITS\.maxBytes/);
  });
  // 素材库满了要给出口，不是干报一句失败
  assert.match(shots, /CLIP_ASSET_QUOTA_EXCEEDED/);
  assert.match(assets, /CLIP_ASSET_QUOTA_EXCEEDED/);
});

test('固化样例：样例句直接播固化音频，改过字才走合成', () => {
  const comp = readVideo('components/voice-preview/index.js');
  // 「预生成 + 固化」的全部好处就在这条快路径上：零等待、零供应商调用、不吃按需限流。
  assert.match(comp, /isSample && demo\)/);
  // 第二个实参标记「这条是固化产物」，签名过期时才知道该回落到合成
  assert.match(comp, /this\.playAudio\(demo, true\);/);
  // 改过一个字就不能再用固化的那条 —— 那已经不是同一句话了
  assert.match(comp, /isSample: text\.trim\(\) === SAMPLE/);
  // 没固化好时必须回落到按需合成，不能显示一个点不动的按钮
  assert.match(comp, /api\.previewVoiceById/);
});

test('固化样例：三处试听入口都要把 demoAudioUrl 传下去，否则快路径形同虚设', () => {
  ['avatar/index.wxml', 'clone/index.wxml', 'voices/index.wxml'].forEach((rel) => {
    assert.match(readVideo(rel), /demo-audio-url="\{\{/, `${rel} 没有传 demo-audio-url`);
  });
});

test('数字人样例短片是砍掉试镜后唯一能验口型的地方，必须有入口和生命周期清理', () => {
  const avatar = readVideo('avatar/index.js');
  const view = readVideo('avatar/index.wxml');
  assert.match(view, /bindtap="openDemoVideo"/);
  assert.match(view, /wx:if="\{\{item\.demoVideoUrl\}\}"/);
  // 用真实 9:16 容器：出片就是这个比例，别让用户按横屏预期判断构图
  assert.match(view, /vd-portrait dv-player/);
  // 浮层必须跟着页面生命周期释放 overlay，否则遮罩计数会漏
  assert.match(avatar, /demoVideoOpen\) this\.closeDemoVideo\(\)/);
  assert.match(avatar, /demoVideoOpen\) host\.setOverlay\(false, 'video-demo-video'\)/);
});

test('全片预览要带上封面和尾卡，且如实说明封面在成片里只占第一帧', () => {
  const shots = readVideo('shots/index.js');
  // 封面只在真开启时才放 —— 别让「没设置」看起来像「设置了但没生效」
  assert.match(shots, /cover\.enabled !== true\) return \[\]/);
  // 连播里给它 2 秒能看清，但必须说清成片里只占第一帧，否则用户会以为开头真停这么久
  assert.match(shots, /只占第一帧[\s\S]{0,40}不占正片时长/);
  // 尾卡本来就在 rows 里（roleClass==='tail'），连播覆盖它
  assert.match(shots, /isTail \? '模板自带的固定结尾'/);
});

test('固化音频签名过期时静默回落按需合成，而不是甩一句播放失败', () => {
  const comp = readVideo('components/voice-preview/index.js');
  // 签名链只有一小时。页面开着超过一小时再点，播的就是过期地址 —— 同一句话合成一遍就有了，
  // 用户不必知道背后换了条路。
  assert.match(comp, /isDemo && !this\.demoFellBack/);
  assert.match(comp, /this\.synthesize\(/);
  // 只回落一次，避免合成也失败时来回打转
  assert.match(comp, /this\.demoFellBack = true;/);
  assert.match(comp, /this\.demoFellBack = false;/);
});

test('clone 页的 voiceDemoUrl 必须真有数据来源，不能是个永远为空的绑定', () => {
  const clone = readVideo('clone/index.js');
  const view = readVideo('clone/index.wxml');
  assert.match(view, /demo-audio-url="\{\{voiceDemoUrl\}\}"/);
  // data 里要定义，轮询里要写入 —— 少任何一半这个入口都等于没接
  assert.match(clone, /voiceDemoUrl: '',/);
  assert.match(clone, /voice\.demoAudioUrl\) \|\| '';/);
  assert.match(clone, /setData\(\{ voiceDemoUrl: demoAudioUrl \}\)/);
});

test('保存成片走军师同源下载并检查下载状态、相册权限与真实进度', () => {
  const api = fs.readFileSync(path.join(sourceRoot, 'packages/video/api.js'), 'utf8');
  const work = fs.readFileSync(path.join(sourceRoot, 'packages/video/work/index.js'), 'utf8');
  assert.match(api, /workDownloadUrl:[\s\S]{0,160}\/works\/\$\{q\(id\)\}\/file/);
  assert.match(work, /wx\.getSetting/);
  assert.match(work, /scope\.writePhotosAlbum/);
  assert.doesNotMatch(work, /!work \|\| !work\.videoUrl/, '同源下载接口负责刷新短签名，详情页不得用旧 videoUrl 拦截下载');
  assert.match(work, /Number\(res\.statusCode\)\s*!==\s*200/);
  assert.match(work, /onProgressUpdate/);
  assert.match(work, /saveVideoToPhotosAlbum/);
});

test('锦囊数据三态：读到 / 读失败 / 还没取，三处都不许混为一谈', async () => {
  // 这三态是本模块存在的理由：把「读失败」说成「你还没有作品」、或者把「还没取到」
  // 算进「今天出了 N 件」，都是当着用户的面说假话。纯文本断言看不出这个，所以真跑一遍。
  const source = read(sourceRoot, 'services/pouch-data.js');
  const poster = (jobId, completedAt) => ({ jobId, headline: '门店海报', status: 'succeeded', completedAt, poster: { previewUrl: 'https://x/p.png' } });
  const report = (id) => ({ id, title: '拓客方案', updatedAt: '2026-08-18T10:00:00Z', agentName: '王参谋' });
  const clip = (id) => ({ id, title: '开业 15 秒', status: 'done', generatedAt: '2026-08-18T09:00:00Z' });
  function load(cache) {
    const sandbox = {
      module: { exports: {} },
      require: (name) => (name === './store'
        ? { isAuthed: () => true, snapshot: () => ({ agents: [] }) }
        : cache),
    };
    sandbox.exports = sandbox.module.exports;
    vm.runInNewContext(source, sandbox, { filename: 'services/pouch-data.js' });
    return sandbox.module.exports;
  }
  const ok = {
    loadPosters: async () => ({ items: [poster('p1', '2026-08-18T12:00:00Z')] }),
    loadClips: async () => [clip('c1')],
    loadReports: async () => [report('r1'), report('r2')],
  };

  // ① 快通道：跳过成片 → 成片是 undefined（还没取），不是 0，也不算失败。
  const fast = load(ok);
  const fastFeed = await fast.loadFeed({ skipClips: true });
  assert.equal(fastFeed.counts.clip, undefined, '没取的通道不许当成 0');
  assert.equal(fastFeed.failed.length, 0, '没取 ≠ 失败');
  assert.equal(fastFeed.pending.join(','), 'clip');
  const clipRow = fast.buildCraftRows([], fastFeed).find((row) => row.key === 'app-clip');
  assert.equal(clipRow.worksText, '', '成片还没取到时不许写任何计数');
  assert.equal(clipRow.hint, '', '成片还没取到时不许说「还没出过东西」');

  // ② 慢通道回来：合进同一份 feed，pending 清空、计数落地。
  const merged = fast.applyClips(fastFeed, await fast.loadClips());
  assert.equal(merged.counts.clip, 1);
  assert.equal(merged.pending.length, 0);
  assert.equal(fast.buildCraftRows([], merged).find((row) => row.key === 'app-clip').worksText, '出过 1 条');

  // ③ 读失败：写「没读出来 · 重试」，绝不写 0，也不写「还没出过东西」。
  const broken = load(Object.assign({}, ok, { loadClips: async () => { throw new Error('upstream 504'); } }));
  const brokenFeed = await broken.loadFeed();
  assert.equal(brokenFeed.counts.clip, null);
  assert.equal(brokenFeed.failed.join(','), 'clip');
  const brokenRow = broken.buildCraftRows([], brokenFeed).find((row) => row.key === 'app-clip');
  assert.equal(brokenRow.worksText, '没读出来 · 重试');
  assert.equal(brokenRow.hint, '');

  // ④ 真的一件都没有：这时候才说「还没出过东西」，且不给作品带落点（点进去是空页）。
  const emptyCache = { loadPosters: async () => ({ items: [] }), loadClips: async () => [], loadReports: async () => [] };
  const empty = load(emptyCache);
  const emptyRow = empty.buildCraftRows([], await empty.loadFeed()).find((row) => row.key === 'app-report');
  assert.match(emptyRow.hint, /还没出过东西/);
  assert.equal(emptyRow.worksRoute, '', '零作品不许给作品库落点');

  // ⑤ 置灰与铁律：海报军师未启用且零成品 → 置灰交回军师；有成品则一律算已启用。
  const advisor = [{ key: 'poster', name: '海报设计师', type: 'creative', billing: 'unlock', owned: false }];
  const locked = load(emptyCache);
  const lockedRow = locked.buildCraftRows(advisor, await locked.loadFeed()).find((row) => row.key === 'app-poster');
  assert.equal(lockedRow.locked, true);
  assert.equal(lockedRow.makeRoute, '', '置灰行没有直达落点，只能开启用层');
  assert.equal(lockedRow.makeVerb, '军师带一次');
  assert.equal(Object.keys(lockedRow).some((key) => /price|cost|billing/i.test(key)), false, '行数据不得带价格字段');
  const owned = load(ok);
  assert.equal(owned.buildCraftRows(advisor, await owned.loadFeed()).find((row) => row.key === 'app-poster').locked, false,
    '有成品就不许被收费闸挡在外面');

  // ⑥ 混排按时间倒序。
  const mixer = load(ok);
  const works = mixer.mergeWorks(await mixer.loadFeed());
  assert.equal(works.length, 4);
  assert.ok(works[0].updatedAt >= works[works.length - 1].updatedAt, '混排必须按时间倒序');
});

// 增购的落点：方案页常驻（换档 vs 补一次，两条路摆一起），算力明细页只在快见底时出现。
function loadNativePage(relPath) {
  const pagePath = path.join(sourceRoot, relPath);
  const pageRequire = createRequire(pagePath);
  for (const key of Object.keys(pageRequire.cache)) {
    if (key.includes(`${path.sep}weapp-native${path.sep}`)) delete pageRequire.cache[key];
  }
  let config;
  const sandbox = { require: pageRequire, module: { exports: {} }, console, setTimeout, Page(value) { config = value; }, wx: globalThis.wx };
  vm.runInNewContext(fs.readFileSync(pagePath, 'utf8'), sandbox, { filename: relPath });
  const page = Object.create(config);
  page.data = JSON.parse(JSON.stringify(config.data));
  page.setData = function (patch) { Object.assign(this.data, patch); };
  return page;
}

function stubWx() {
  const values = new Map();
  globalThis.wx = {
    getStorageSync: (key) => values.get(key) ?? '',
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: (key) => values.delete(key),
    showToast() {}, showModal() {},
  };
  return values;
}

test('方案页常驻增购：游客也看得到包，点了先弹登录门', async () => {
  stubWx();
  try {
    const page = loadNativePage('packages/work/plans/index.js');
    // 目录是公开接口：没登录也要拉到，否则游客看方案时那块永远停在「正在读取」。
    await page.loadPacks();
    assert.equal(page.data.packState, 'ready');
    assert.ok(page.data.packs.length >= 1, '方案页必须常驻增购包');
    assert.ok(page.data.packs.every((sku) => sku.kind === 'credits' || sku.kind === 'quota'));

    // 游客点购买：只弹登录层，不下单、不跳路由、不清状态。
    await page.buyPack({ currentTarget: { dataset: { key: page.data.packs[0].key } } });
    assert.equal(page.data.showLogin, true, '游客点增购要弹登录门');
    assert.equal(page.data.buying, '', '登录门拦下后不许留着 busy 态');
  } finally { delete globalThis.wx; }
});

test('算力明细页是账本不是货架：没见底不摆增购，见底才摆', async () => {
  stubWx();
  try {
    const page = loadNativePage('packages/work/credits/index.js');
    await page.loadPacks();

    // ① 没见底：整块不渲染（页尾「查看方案与权益」负责导流），也不留骨架屏。
    page._runningLow = false;
    page.applyPacks('ready');
    assert.equal(page.data.showPacks, false);
    assert.equal(page.data.packs.length, 0, '没见底不该把货架摆出来');

    // ② 见底：摆出来且可买。
    page._runningLow = true;
    page.applyPacks('ready');
    assert.equal(page.data.showPacks, true);
    assert.ok(page.data.packs.length >= 1, '见底时必须给得出增购包');

    // ③ 见底判定读的是月度用量与钻石余额，不是拍脑袋的常量。
    const source = fs.readFileSync(path.join(sourceRoot, 'packages/work/credits/index.js'), 'utf8');
    assert.match(source, /usagePercent\) >= RUNNING_LOW_PERCENT/);
    assert.match(source, /const creditsLow = balance != null && Number\(balance\) === 0/);
    assert.match(source, /!\(packRemaining > 0\)/, '手上还有没用完的增购算力就别催');
  } finally { delete globalThis.wx; }
});

test('算力包不对外报 token 数：目录不下发、行文案不出现绝对值', async () => {
  stubWx();
  try {
    const require = createRequire(import.meta.url);
    const mockPath = path.join(sourceRoot, 'services/mock.js');
    delete require.cache[require.resolve(mockPath)];
    const mock = require(mockPath);

    // 目录口径：算力包不下发 amount（价 ÷ token 就是每 token 售价，属商业机密）；钻石是对外货币，颗数照旧。
    const list = await mock.skus();
    const quota = list.find((sku) => sku.kind === 'quota');
    const credits = list.find((sku) => sku.kind === 'credits');
    assert.equal(quota.amount, undefined, '算力包不得下发 token 数');
    assert.ok(Number(credits.amount) > 0, '钻石包照旧带颗数');
    assert.doesNotMatch(quota.name, /\d/, '算力包名字也不许带量级（线上名字归运营后台）');

    // 行文案：两页共用 services/packs 的 mapPack，改一处两页同时生效。
    const packsPath = path.join(sourceRoot, 'services/packs.js');
    delete require.cache[require.resolve(packsPath)];
    const { mapPack } = require(packsPath);
    const quotaRow = mapPack(quota);
    assert.doesNotMatch(quotaRow.amountText, /\d/, `算力包行文案不得出现数字：${quotaRow.amountText}`);
    assert.ok(quotaRow.amountText.length > 0, '不报数不等于留白，得说清买到什么');
    assert.match(mapPack(credits).amountText, /钻石/);

    // 余量同样不报数：它就是刚买那笔的量级。
    const creditsSource = fs.readFileSync(path.join(sourceRoot, 'packages/work/credits/index.js'), 'utf8');
    assert.match(creditsSource, /packRemainingText: packRemaining > 0 \? '仍有余量' : ''/);
  } finally { delete globalThis.wx; }
});

test('showModal 按钮文案不得超 4 字：超了弹窗根本不出现，表现为「点了没反应」', () => {
  // 微信硬限：confirmText / cancelText 最多 4 个字符，超出直接走 fail —— 弹窗不显示。
  // 真机与模拟器都拦（实测 errMsg: showModal:fail confirmText length should not larger
  // than 4 Chinese characters）。而 fail 分支常被写成 resolve(false)/不写，于是失败静默，
  // 用户看到的就是「点了没反应」：增购包与能力开通两个付费入口都曾栽在这里。
  const offenders = [];
  for (const file of walk(sourceRoot).filter((f) => f.endsWith('.js'))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(confirmText|cancelText)\s*:\s*(`[^`]*`|'[^']*'|"[^"]*")/g)) {
      const [, field, raw] = match;
      const literal = raw.slice(1, -1);
      const rel = path.relative(sourceRoot, file);
      // 模板串里插价格/数量是最常见的越界写法，长度还随数据变——一律不许。
      if (raw.startsWith('`') && literal.includes('${')) { offenders.push(`${rel}: ${field} 拼了变量 ${raw}`); continue; }
      if (Array.from(literal).length > 4) offenders.push(`${rel}: ${field} 超 4 字「${literal}」`);
    }
  }
  assert.deepEqual(offenders, [], `showModal 按钮文案越界（弹窗会不显示）：\n${offenders.join('\n')}`);
});
