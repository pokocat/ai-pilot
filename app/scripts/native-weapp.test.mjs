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

test('原生小程序覆盖 app.json 声明的全部路由', () => {
  const app = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'app.json'), 'utf8'));
  const routes = [...app.pages];
  for (const pkg of app.subPackages || []) for (const page of pkg.pages || []) routes.push(`${pkg.root}/${page}`);
  for (const route of routes) {
    const hasDedicated = ['js', 'json', 'wxml', 'scss'].every((ext) => fs.existsSync(path.join(sourceRoot, `${route}.${ext}`)));
    assert.ok(hasDedicated, `路由缺少独立原生四件套：${route}`);
  }
  assert.equal(routes.length, 38, '路由数量变化时必须同步审计原生迁移覆盖');
  assert.equal(fs.existsSync(path.join(sourceRoot, 'route-manifest.json')), false, '完整迁移后不得保留通用路由清单');
  assert.equal(fs.existsSync(path.join(sourceRoot, 'services/generic-page.js')), false, '完整迁移后不得保留通用页面渲染器');
  assert.equal(fs.existsSync(path.join(sourceRoot, 'templates/generic-page.wxml')), false, '完整迁移后不得保留通用页面模板');
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

test('原生页头避让微信胶囊，登录全屏层同步隐藏自定义底栏', () => {
  const tabHeader = fs.readFileSync(path.join(sourceRoot, 'components/tab-header/index.scss'), 'utf8');
  const login = fs.readFileSync(path.join(sourceRoot, 'components/login-sheet/index.js'), 'utf8');
  const store = fs.readFileSync(path.join(sourceRoot, 'services/store.js'), 'utf8');
  const page = fs.readFileSync(path.join(sourceRoot, 'services/page.js'), 'utf8');
  const tabbarJs = fs.readFileSync(path.join(sourceRoot, 'custom-tab-bar/index.js'), 'utf8');
  const tabbarWxml = fs.readFileSync(path.join(sourceRoot, 'custom-tab-bar/index.wxml'), 'utf8');
  const profileScss = fs.readFileSync(path.join(sourceRoot, 'pages/profile/index.scss'), 'utf8');

  assert.match(tabHeader, /\.tab-head\s*\{[\s\S]*?position:\s*relative;[\s\S]*?margin-bottom:\s*28px;/, '组件样式隔离下必须自己提供定位基准和背景字落脚留白');
  assert.match(tabHeader, /\.th-glyph\s*\{[\s\S]*?top:\s*4px/, '原生背景字不得向上侵入胶囊区');
  assert.match(login, /store\.setOverlay\(Boolean\(open\), 'login-sheet'\)/);
  assert.match(login, /detached\(\)[\s\S]*?store\.setOverlay\(false, 'login-sheet'\)/);
  assert.match(store, /tabbar\.syncState\(\{ overlay: state\.overlay \}\)/);
  assert.match(page, /overlay: snapshot\.overlay/);
  assert.match(tabbarJs, /overlay: false/);
  assert.match(tabbarWxml, /wx:if="\{\{!overlay\}\}" class="tabbar/);
  assert.match(profileScss, /\.profile-login\s*\{[\s\S]*?align-items:\s*center;[\s\S]*?justify-content:\s*center;/);
});

test('军情模式点选、单行入口与方案按钮保持原稿视觉状态', () => {
  const home = fs.readFileSync(path.join(sourceRoot, 'pages/home/index.scss'), 'utf8');
  const homeWxml = fs.readFileSync(path.join(sourceRoot, 'pages/home/index.wxml'), 'utf8');
  const plans = fs.readFileSync(path.join(sourceRoot, 'packages/work/plans/index.scss'), 'utf8');

  assert.match(homeWxml, /class="bmt \{\{mode===item\.key\?'on':''\}\}"/, '模式切换必须把点选态落到 on 类');
  assert.match(home, /\.bmt\.on\s*\{[^}]*color:\s*var\(--accent\);[^}]*border-color:\s*var\(--accent\);/s, '点选态必须同时显出本命色文字与边框');
  assert.match(home, /\.ml-go\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*white-space:\s*nowrap;/s, '打开文字与箭头必须保持同一行');
  for (const selector of ['option-action', 'quote-confirm']) {
    const rule = new RegExp(`\\.${selector}\\s*\\{[^}]*padding:\\s*0;[^}]*display:\\s*flex;[^}]*align-items:\\s*center;[^}]*justify-content:\\s*center;`, 's');
    assert.match(plans, rule, `${selector} 必须清掉原生 button 默认内边距并双轴居中`);
  }
  assert.match(plans, /\.option-action::after,\.quote-confirm::after\s*\{\s*border:\s*0;/, '原生 button 默认描边必须清除');
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
  assert.match(page, /navInset:\s*navTop \+ navRowHeight \+ 10/);
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
  assert.equal(navRoots.length, 36);
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
  assert.match(tabbarScss, /\.tab-icon-pouch\s*\{\s*width:\s*26px;\s*height:\s*26px;/);
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
  assert.ok((chatJs.match(/canRetryLast, errorText: canRetryLast \?/g) || []).length >= 2, '首次恢复与兼容轮询结束都要恢复重试入口');
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
  assert.match(pageWxml, /<template is="chat-composer" data="\{\{[^"]*composerOdd[^"]*\}\}"/);
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
  assert.match(wxml, /<view wx:else class="native-page \{\{themeClass\}\}"/, 'control 仍是原来那棵 native-page');
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
  assert.match(wxml, /<template is="chat-composer" data="\{\{[^"]*composerOdd[^"]*\}\}"/);
  assert.match(wxml, /class="wence-isle"[\s\S]*?class="isle-div"[\s\S]*?class="tabbar-inner"/, '浮岛顺序：输入行 → 细线 → tab 行');
  assert.match(wxml, /bindtap="switchIsleTab"/);
  assert.match(js, /require\('\.\.\/\.\.\/services\/tabbar'\)/, '浮岛 tab 与底栏共用 services/tabbar.js');
  assert.match(scss, /@use "\.\.\/\.\.\/custom-tab-bar\/index\.scss"/, '浮岛复用底栏同一份 SCSS（含图标光学校准）');
  assert.doesNotMatch(wxml, /<textarea\b/, '输入区只能来自 composer 模板，页面不得再写一份 textarea');

  // —— 提示 pill：代发 + 冷会话专属（有过 user 轮就永久收起）+ 有草稿/生成中/键盘/抽屉都不显示 ——
  assert.match(wxml, /class="wence-pill[\s\S]*?bindtap="tapHint"/);
  assert.match(wxml, /wx:if="\{\{hintText && !chipsSpent && !drawerOpen && !busy && !inputCount && !keyboardHeight\}\}"/, 'pill 的隐藏条件全部在 WXML 表达式里，不靠 JS 同步');
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
  assert.match(js, /setOverlay\(false, 'wence-isle'\);\s*\n\s*wx\.switchTab/, '切走前先释放 overlay，别让下一个 tab 没有底栏');

  // —— 未读三层引导链 ——
  assert.match(wxml, /index === 0 && unread > 0[\s\S]*?class="tab-badge"/, '① 浮岛问策角标 = 全会话聚合');
  assert.match(wxml, /councilUnreadText[\s\S]*?class="unread wh-entry-badge"/, '② 军师团按钮聚合角标');
  assert.match(js, /filter\(\(item\) => item\.agentKey !== 'general'\)\s*\n?\s*\.reduce/, '② 只聚合 general 以外的未读');
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
  assert.match(js, /this\.chatCoreLoad\(\{ sessionId: latest\.id \}\)/);
  // 主线会话过期（纯客户端）：闲置 > 24h 且**无未读**才不续接；有未读一律续接（军师说了新东西）。
  assert.match(js, /const SESSION_IDLE_HOURS = 24;/, '阈值必须是页面顶部的具名常量，不许散在判断里');
  assert.match(js, /function isSessionStale\(item\) \{[\s\S]*?if \(Number\(item\.unreadCount\) > 0\) return false;/, '有未读时连续性优先，不判过期');
  assert.match(js, /idleMs > SESSION_IDLE_HOURS \* 3600 \* 1000/);
  assert.match(js, /if \(latest && !isSessionStale\(latest\)\) \{ this\.chatCoreLoad\(\{ sessionId: latest\.id \}\)/, '过期的会话落到「无会话」分支');
  // 过期只在冷进（bootChat）判：refreshChat 是切 tab 回来，聊着聊着跨过整点被切走是最恶心的"聪明"。
  assert.match(js, /async refreshChat\(\) \{[\s\S]*?\n  \},/, 'refreshChat 存在');
  assert.doesNotMatch(js.slice(js.indexOf('async refreshChat()'), js.indexOf('async fetchSessions()')), /isSessionStale/, 'refreshChat 不得做过期判定');
  assert.match(js, /api\.proactiveSession\(\)/);
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
  assert.match(tabTable, /pages\/sessions\/index', icon: 'conversation'/);
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

  const repay = credits.match(/async repay\(event\) \{[\s\S]*?\n  \},\n  async waitApplied/);
  assert.ok(repay, '算力页缺少继续支付实现');
  assert.match(repay[0], /const state = await this\.waitApplied\(outTradeNo\)/);
  assert.match(repay[0], /if \(state === 'applied'\)[\s\S]*?支付成功，权益已更新/);
  assert.match(repay[0], /支付结果待确认，请稍后刷新订单状态/);
  assert.match(credits, /return 'pending';\n  \},\n\}\);/);

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
  assert.match(unlock, /权益点不足，请先调整方案/);
  assert.match(unlockWxml, /name="spark"/);
  assert.match(unlockWxml, /name="diamond"/);
  assert.match(api, /purchaseAgent:[\s\S]{0,120}mock\.purchaseAgent\(key, attribution\)/);
  assert.match(mock, /storageKey\('ownedAgents'\)/);
  assert.match(mock, /storageKey\('creditBalance'\)/);
  assert.match(mock, /DEFAULT_AGENTS, agents, purchaseAgent,/);

  assert.match(plans, /function isPlanExpired\(value\)/);
  assert.match(plans, /expired: plan\.id === currentId && isPlanExpired\(option\.expiresAt\)/);
  assert.match(plansWxml, /\{\{current\.expired\?'已到期':'使用中'\}\}/);
  assert.match(plansWxml, /<block wx:else>[\s\S]*?usage&&!usage\.unlimited[\s\S]*?subscription/);
});

test('原生 Studio 恢复动态创作军师、作品库与真实处方主链路', () => {
  const studio = fs.readFileSync(path.join(sourceRoot, 'pages/studio/index.js'), 'utf8');
  const wxml = fs.readFileSync(path.join(sourceRoot, 'pages/studio/index.wxml'), 'utf8');
  const scss = fs.readFileSync(path.join(sourceRoot, 'pages/studio/index.scss'), 'utf8');
  const config = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'pages/studio/index.json'), 'utf8'));
  const api = fs.readFileSync(path.join(sourceRoot, 'services/api.js'), 'utf8');
  const mock = fs.readFileSync(path.join(sourceRoot, 'services/mock.js'), 'utf8');

  assert.match(studio, /Promise\.all\(\[store\.loadAgents\(\), authed \? store\.loadMe\(\) : Promise\.resolve\(null\)\]\)/, '启用层打开前必须同步真实余额');
  assert.match(studio, /agent\.type === 'creative' && agent\.enabled !== false/);
  assert.match(studio, /locked = Boolean\(authed && agent\.billing === 'unlock' && !agent\.owned\)/, '游客可浏览，登录后才显示锁态');
  assert.match(studio, /api\.prescriptions\(\)/);
  assert.match(studio, /item\.status !== 'dismissed' && item\.status !== 'activated'/);
  assert.match(studio, /api\.prescriptionAction\(id, 'clicked'\)\.catch/);
  assert.match(studio, /\/packages\/work\/market\/index\?from=prescription&pid=/);
  assert.match(studio, /\/packages\/work\/gallery\/index/);
  assert.match(studio, /agentUnlocked\(event\)[\s\S]*?agentKey=\$\{encodeURIComponent\(agent\.key\)\}&continue=1/);
  assert.match(wxml, /军师代笔 · 内容出品/);
  assert.match(wxml, /wx:for="\{\{creativeAgents\}\}"/);
  assert.match(wxml, /<agent-unlock agent="\{\{unlockAgent\}\}"[^>]*bindunlocked="agentUnlocked"/);
  assert.match(wxml, /class="works-row card" bindtap="openGallery"/);
  assert.match(wxml, /wx:if="\{\{prescriptions\.length\}\}"/);
  assert.match(wxml, /native-icon name="bolt"/);
  assert.equal(config.usingComponents?.['agent-unlock'], '/components/agent-unlock/index');
  assert.match(scss, /\.rx-item\s*\{/);
  assert.match(scss, /background:\s*var\(--accent-soft\)/);
  assert.match(api, /prescriptions:\s*\(\) => isMock\(\) \? mock\.prescriptions\(\)/);
  assert.match(mock, /id: 'rx1'[\s\S]{0,160}status: 'proposed'/);
  for (const key of ['ip', 'promo', 'poster', 'shortvideo', 'copy']) {
    assert.match(mock, new RegExp(`key: '${key}'[^\n]+type: 'creative'`), `mock 缺少创作军师 ${key}`);
  }

  assert.match(studio, /function plainInline\(value\)/, '案卷标题进入深色卡前必须去 Markdown 标记');
  assert.match(studio, /const minDate = dayKey\(-6\)/, '周计划只能展示今天起近 7 天，而不是最近七个任意日期');
  assert.match(studio, /api\.saveGoals\(/);
  assert.match(studio, /api\.setOrderResult\(/);
  assert.match(studio, /api\.reviewCasefile\('day'\)[\s\S]*?agentKey=general/);
  assert.match(wxml, /源自已定方案 · 由'\+dossierSource\+'给出/);
  assert.doesNotMatch(wxml, /\{\{judgement\|\|/, '今日战役卡不得直接塞入整段 Markdown 判断导致卡片失控');
  assert.match(wxml, /class="done-archive card"/);
  assert.match(wxml, /做完了多少/);
  assert.match(wxml, /bindtap="openReminders"[\s\S]*?提醒节奏/);
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
    await mock.purchaseAgent('ops');
    assert.equal((await mock.agents()).find((agent) => agent.key === 'ops')?.owned, true);
    assert.equal((await mock.me()).creditBalance, 90);

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

    assert.equal((await mock.skus()).length, 6);
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

    assert.equal((await mock.bizMetricTemplate()).items.length, 5);
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

    const revised = await mock.reviseJob(created.jobId, { idempotencyKey: 'poster-revise-1', headline: '增长只抓一条主线', templateKey: 'editorial' });
    assert.equal(revised.creditCost, 0);
    clock += 3300;
    const revisedJob = await mock.creativeJob(revised.jobId);
    assert.equal(revisedJob.parentJobId, created.jobId);
    assert.equal(revisedJob.brief.headline, '增长只抓一条主线');

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
    assert.equal((await mock.reviews()).streak, 0);
    assert.equal((await mock.creativePosters('', 20)).items.length, 0);
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
    assert.equal(projectKnowledge[0].fileName, '复购访谈.txt');
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
    assert.equal(initialDecisions.stats.pending, 3);
    await mock.verifyDecision('d4', 'correct', '私域试验有效');
    const fifth = await mock.verifyDecision('d5', 'correct');
    assert.equal(fifth.stats.accuracy, 80);
    assert.equal((await mock.disputeDecision('d6', '毛利线尚未真正上线')).ok, true);
    assert.equal((await mock.decisions()).items.find((item) => item.id === 'd6').disputeNote, '毛利线尚未真正上线');

    assert.equal((await mock.prophecies()).items[0].seq, 5);
    await mock.verifyProphecy('p4', 'hit');
    const fifthProphecy = await mock.verifyProphecy('p5', 'miss', '窗口未出现');
    assert.equal(fifthProphecy.stats.hitRate, 60);
    const progress = await mock.progress();
    assert.equal(progress.progress.decisionAccuracy, 80);
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
    assert.equal((await mock.me()).understanding.battleForces.length, 0);
    assert.equal((await mock.decisions()).items.find((item) => item.id === 'd4').status, 'pending');
    await assert.rejects(mock.report(summary.reportId), (error) => error && error.code === 'NOT_FOUND');

    values.set('junshi.userId', 'mock-loop-a');
    assert.equal((await mock.progress()).progress.decisionAccuracy, 80);
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
  assert.match(api, /verifyImpersonation:[\s\S]*isolatedAuth:\s*true/);
  assert.match(request, /opts\.isolatedAuth/);
  assert.match(request, /statusCode\s*===\s*401[\s\S]{0,120}unauthorized\(tokenAtRequest,\s*data,\s*opts\.isolatedAuth\)/);
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
  assert.match(chat, /openPoster\(event\)[\s\S]*?!item\.reportReady \|\| !isReportReady\(item\.messageId, item\.deliverable\)[\s\S]*?this\._agentKey !== 'poster'[\s\S]*?\/packages\/work\/poster\/index\?/);
  assert.match(chat, /messageId=\$\{encodeURIComponent\(item\.messageId\)\}/);
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
  assert.match(mock, /function creativeStatus\(\) \{ return Promise\.resolve\(\{ enabled: true, pricePerPoster: 10/);
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
