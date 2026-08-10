import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const registry = read('src/pc/regions/index.tsx');
const sand = read('src/pc/regions/sand.tsx');
const exec = read('src/pc/regions/exec.tsx');
const execModel = read('src/pc/regions/execModel.ts');
const lord = read('src/pc/regions/lord.tsx');
const regionStyles = [
  read('src/pc/regions/sand.scss'),
  read('src/pc/regions/exec.scss'),
  read('src/pc/regions/lord.scss'),
].join('\n');
const state = read('src/pc/state.ts');
const chrome = read('src/pc/Chrome.tsx');
const app = read('src/pc/App.tsx');
const login = read('src/pc/Login.tsx');
const main = read('src/pc/main.tsx');

test('PC 沙盘、点兵、主公均注册真实工作区，不再落占位组件', () => {
  assert.match(registry, /Main:\s*SandMain/);
  assert.match(registry, /Main:\s*ExecMain/);
  assert.match(registry, /Main:\s*LordMain/);
  assert.doesNotMatch(registry, /makePlaceholder/);
});

test('沙盘只接真实案卷、三势、决策与命盘接口', () => {
  for (const needle of ['refreshDossier', 'understanding', 'battleForces', 'api.decisions()', 'api.refreshForces()', 'api.battleCommit()', 'api.myChart()']) {
    assert.ok(sand.includes(needle), `沙盘缺少真实数据源：${needle}`);
  }
  assert.doesNotMatch(sand, /const\s+forces\s*=\s*\[/, '不得在 PC 沙盘硬编码三势结论');
});

test('点兵复用案卷执行闭环，缺改期接口的动作明确标施工中', () => {
  for (const needle of ['toggleOrder', 'setOrderResult', 'addOrder', 'removeOrder', 'saveBackfill', 'saveGoals', 'startReview']) {
    assert.ok(exec.includes(needle) || execModel.includes(needle), `点兵缺少案卷能力：${needle}`);
  }
  assert.match(execModel, /from '\.\.\/\.\.\/services\/dossier'/);
  assert.doesNotMatch(exec, /api\.prescriptions\(/, '生态工具处方不是军令数据源');
  assert.match(exec, /顺延到明天 · 施工中/);
  assert.match(exec, /当前不会改动军令/);
});

test('主公统计、谶语、档案工作台、方案与算力账本均来自现有接口', () => {
  for (const needle of ['api.library()', 'api.projects()', 'api.reports()', 'api.progress()', 'api.strategicProfile()', 'api.workbench()', 'api.planOptions()', 'api.myCredits()']) {
    assert.ok(lord.includes(needle), `主公区缺少真实接口：${needle}`);
  }
  assert.match(state, /LordView = 'overview' \| 'plans' \| 'credits'/);
});

test('工作区只保留 App 外壳的一层 Stage，换区与换视图归零滚动', () => {
  for (const [name, source] of [['sand', sand], ['exec', exec], ['lord', lord]]) {
    assert.doesNotMatch(source, /<Stage\b/, `${name} 不得重复套工作区 Stage`);
  }
  assert.match(chrome, /\[st\.tab, st\.view\]/);
  assert.match(chrome, /scrollTop = 0/);
});

test('跨区问策上下文只存在内存，不写分享 URL', () => {
  assert.match(state, /const \[chatDraft, setChatDraft\] = useState\(''\)/);
  assert.doesNotMatch(state, /writeRoute\(tab, \{[^}]*chatDraft/);
});

test('三区业务样式只消费 PC 主题 token，不私自写十六进制颜色', () => {
  assert.doesNotMatch(regionStyles, /#[\da-f]{3,8}\b/i);
  assert.match(regionStyles, /var\(--pc-white\)/);
  assert.match(regionStyles, /var\(--accent\)/);
});

test('PC 未登录只渲染不可关闭的硬登录门，个人工作区必须等 /me 验真', () => {
  assert.match(app, /if \(!authed\)[\s\S]*<Login required/);
  assert.match(app, /if \(!me\)/);
  assert.match(app, /await s\.loadMe\(\)/);
  assert.match(login, /required \? '登录军师工作台'/);
  assert.match(login, /!required && onClose && <button/);
  assert.match(login, /if \(required \|\| !onClose\) return undefined/);
  assert.doesNotMatch(main, /store\.load(?:Agents|Me)\(\)/, '游客首屏不得预拉公开目录或个人接口');
});

test('PC 问策回形针走真实文档上传并把资料 refs 带进本轮生成', () => {
  const chat = read('src/pc/regions/chat.tsx');
  assert.match(chat, /type="file"/);
  assert.match(chat, /api\.uploadKnowledge\(/);
  assert.match(chat, /refs:\s*sendingRefs\.length\s*\?/);
  assert.match(chat, /attachmentOnlyPrompt\(uploadRefs\)/);
  assert.doesNotMatch(chat, /附件上传随锦囊一起落地/);
});
