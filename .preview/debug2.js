const automator = require('/Users/donis/dev/ai-pilot/app/node_modules/miniprogram-automator');

(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420' });
  const logs = [];
  mp.on('console', (m) => logs.push(`[${m.type}] ` + (m.args||[]).map(a=>typeof a==='object'?JSON.stringify(a):String(a)).join(' ')));
  mp.on('exception', (e) => logs.push('[EXCEPTION] ' + e.message + (e.stack?('\n'+e.stack):'')));

  // 读 storage：token / 登录态
  const sys = await mp.evaluate(() => {
    const info = {};
    try { info.token = wx.getStorageSync('token') || wx.getStorageSync('userId') || ''; } catch(e){ info.tokenErr = String(e); }
    try { info.keys = wx.getStorageInfoSync().keys; } catch(e){ info.keysErr = String(e); }
    try { const s = wx.getSystemInfoSync(); info.platform = s.platform; info.SDKVersion = s.SDKVersion; info.version = s.version; } catch(e){ info.sysErr = String(e); }
    return info;
  });
  console.log('STORAGE_SYS:', JSON.stringify(sys, null, 2));

  // 强制复现绑定门：注入一个「已登录但无 phone」状态再 reLaunch
  await mp.reLaunch('/pages/home/index');
  await new Promise(r => setTimeout(r, 2500));

  const page = await mp.currentPage();
  console.log('PAGE:', page ? page.path : '(null)');
  if (page) {
    const home = await page.$('.home');
    console.log('HAS .home:', !!home);
    // 检测是否有登录弹层（绑定门）
    const lg = await page.$('.lg-content');
    console.log('HAS .lg-content (login overlay):', !!lg);
    if (lg) {
      const h = await page.$('.lg-h');
      if (h) { try { console.log('LOGIN_TITLE:', await h.text()); } catch(e){} }
    }
  }

  console.log('--- COLLECTED LOGS ---');
  console.log(logs.join('\n') || '(no console/exception events)');

  await mp.disconnect();
  process.exit(0);
})().catch(e => { console.log('FATAL', e.message, e.stack); process.exit(1); });
