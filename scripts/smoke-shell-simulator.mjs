#!/usr/bin/env node
/** 模拟器过一遍四 tab 壳：创作（信息流 + 待办面板）、我的、作品、资料库。读关键数据并截图。 */
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const AUTO = '/Users/donis/dev/ai-pilot-gate-a/app/node_modules/miniprogram-automator/out/';
const automator = req(AUTO + 'index.js');
req(AUTO + 'MiniProgram.js').default.prototype.checkVersion = async function () {};
const OUT = '/private/tmp/claude-501/-Users-donis-dev-ai-pilot/469b0a30-94ed-4e85-8944-f73530f1447a/scratchpad/shell-';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });

async function goto(url, key) {
  let page = null;
  for (let i = 0; i < 8; i++) {
    try { await mp.reLaunch(url); } catch (e) {}
    await sleep(1800); page = await mp.currentPage();
    if (page && page.path.indexOf(key) >= 0) return page;
  }
  throw new Error('没跳到 ' + url + '，当前 ' + (page && page.path));
}

let page = await goto('/packages/video/home/index?tab=1', 'home');
await sleep(1200);
let d = await page.data();
console.log(`创作：${d.shelfText} · 分类 ${d.cats.map((c) => c.label).join('/')} · 卡 ${d.list.length} 张 · 待办 ${d.todoCount} · 游客=${d.guest}`);
console.log('  卡片:', d.list.map((t) => `${t.name}(${t.ready ? t.durText + ' ' + t.credits + '钻' : '即将上线'})`).join(' | '));
await mp.screenshot({ path: OUT + 'home.png' });
await page.callMethod('openTodo'); await sleep(600);
d = await page.data(); console.log('  待办面板:', d.todoOpen, d.todos.map((t) => t.title).join(' | ') || '（空）');
await mp.screenshot({ path: OUT + 'home-todo.png' });
await page.callMethod('closeTodo');
await page.callMethod('pickCat', { currentTarget: { dataset: { key: '带货' } } }); await sleep(300);
d = await page.data(); console.log(`  切「带货」分类：${d.list.length} 张`);

page = await goto('/packages/video/profile/index', 'profile'); await sleep(1500);
d = await page.data();
console.log(`我的：游客=${d.guest} 称呼「${d.name}」 手机 ${d.phone} 公司「${d.company}」 余额 ${d.balance}（失败=${d.balanceFailed}）`);
console.log('  资产行:', (d.rows || []).map((r) => `${r.name}=${r.value}`).join(' | '));
await mp.screenshot({ path: OUT + 'profile.png' });

page = await goto('/packages/video/works/index?tab=1', 'works'); await sleep(1500);
d = await page.data(); console.log(`作品：asTab=${d.asTab}`); await mp.screenshot({ path: OUT + 'works.png' });
page = await goto('/packages/video/assets/index?tab=1', 'assets'); await sleep(1500);
d = await page.data(); console.log(`资料库：asTab=${d.asTab} picking=${d.picking}`); await mp.screenshot({ path: OUT + 'assets.png' });
await mp.disconnect();
