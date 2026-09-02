#!/usr/bin/env node
/** 用 mock 登录态再过一遍：待办面板有内容、「我的」读到余额与资产行。 */
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);
const AUTO = '/Users/donis/dev/ai-pilot-gate-a/app/node_modules/miniprogram-automator/out/';
const automator = req(AUTO + 'index.js');
req(AUTO + 'MiniProgram.js').default.prototype.checkVersion = async function () {};
const OUT = '/private/tmp/claude-501/-Users-donis-dev-ai-pilot/469b0a30-94ed-4e85-8944-f73530f1447a/scratchpad/shell-in-';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mp = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
const token = 'mock-13800006027';
await mp.callWxMethod('setStorageSync', 'junshi.userId', token);
await mp.callWxMethod('setStorageSync', `junshi.native.mock.${token}.identity`, { name: '王老板', company: '王记五金', phone: '13800006027' });
async function goto(url, key) {
  let page = null;
  for (let i = 0; i < 8; i++) { try { await mp.reLaunch(url); } catch (e) {} await sleep(2000); page = await mp.currentPage(); if (page && page.path.indexOf(key) >= 0) return page; }
  throw new Error('没跳到 ' + url);
}
let page = await goto('/packages/video/home/index?tab=1', 'home'); await sleep(1800);
let d = await page.data();
console.log(`创作（已登录）：游客=${d.guest} 待办 ${d.todoCount}：${d.todos.map((t) => t.title).join(' | ')}`);
await page.callMethod('openTodo'); await sleep(600); d = await page.data(); console.log('  面板打开=', d.todoOpen);
await mp.screenshot({ path: OUT + 'home-todo.png' }); await page.callMethod('closeTodo');
page = await goto('/packages/video/profile/index', 'profile'); await sleep(2200);
d = await page.data();
console.log(`我的（已登录）：「${d.name}」 ${d.phone} 「${d.company}」 余额 ${d.balance}（失败=${d.balanceFailed}）`);
console.log('  资产行:', (d.rows || []).map((r) => `${r.name}=${r.value}`).join(' | '));
await mp.screenshot({ path: OUT + 'profile.png' });
await mp.callWxMethod('removeStorageSync', 'junshi.userId');   // 恢复游客态，别把模拟器留在假登录里
await mp.disconnect();
