const automator = require('/Users/donis/dev/ai-pilot/app/node_modules/miniprogram-automator');

(async () => {
  const mp = await automator.connect({ wsEndpoint: 'ws://localhost:9420' });
  console.log('CONNECTED');

  mp.on('console', (msg) => {
    console.log(`[console.${msg.type}]`, (msg.args || []).map(a => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' '));
  });
  mp.on('exception', (e) => {
    console.log('[EXCEPTION]', e.message);
    if (e.stack) console.log(e.stack);
  });

  // 等一会儿收集启动期日志
  await new Promise(r => setTimeout(r, 2500));

  try {
    const page = await mp.currentPage();
    console.log('CURRENT_PAGE_PATH:', page ? page.path : '(null)');
    if (page) {
      const data = await page.data();
      console.log('PAGE_DATA_KEYS:', Object.keys(data || {}));
    }
  } catch (err) {
    console.log('GET_PAGE_ERROR:', err.message);
  }

  // 主动重新进入首页，捕获渲染期异常
  try {
    await mp.reLaunch('/pages/home/index');
    console.log('RELAUNCHED home');
  } catch (err) {
    console.log('RELAUNCH_ERROR:', err.message);
  }

  await new Promise(r => setTimeout(r, 3000));

  try {
    const page = await mp.currentPage();
    console.log('AFTER_RELAUNCH_PAGE:', page ? page.path : '(null)');
    if (page) {
      const wxml = await page.$('.home');
      console.log('HAS_.home_NODE:', !!wxml);
    }
  } catch (err) {
    console.log('POST_CHECK_ERROR:', err.message);
  }

  await mp.disconnect();
  console.log('DONE');
  process.exit(0);
})().catch(e => { console.log('FATAL', e.message); process.exit(1); });
