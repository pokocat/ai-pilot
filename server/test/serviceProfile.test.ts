// 服务档位：爱速拍能不能单独起一个进程。
//
// 爱速拍现在没有自己的服务端，军师 BFF 代管着。代价真实付过：2026-09-10 为了发爱速拍的
// 六条分段路由，不得不把军师落后的十个提交连同 admin 一起发上生产。这组用例盯的是
// 那条边界确实存在且可执行 —— 不是文档里的约定。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  serviceProfile, shouldRegister, shouldRunJunshiWorkers, QUICKREEL_ROUTE_GROUPS,
} from '../src/serviceProfile.js';

const original = process.env.SERVICE_PROFILE;
after(() => {
  if (original === undefined) delete process.env.SERVICE_PROFILE;
  else process.env.SERVICE_PROFILE = original;
});

test('不配 = all，与本档位上线之前逐字节一致', () => {
  delete process.env.SERVICE_PROFILE;
  assert.equal(serviceProfile(), 'all');
  assert.equal(shouldRegister('sessions'), true, 'all 档什么都注册');
  assert.equal(shouldRegister('video'), true);
  assert.equal(shouldRunJunshiWorkers(), true);
});

test('空串也当 all，不要因为一个空环境变量把军师的面关掉', () => {
  process.env.SERVICE_PROFILE = '';
  assert.equal(serviceProfile(), 'all');
});

test('quickreel 档只放行白名单里的那几组', () => {
  process.env.SERVICE_PROFILE = 'quickreel';
  assert.equal(serviceProfile(), 'quickreel');
  for (const g of ['auth', 'meta', 'video', 'wechat', 'metrics', 'alerts']) {
    assert.equal(shouldRegister(g), true, `${g} 是爱速拍要用的`);
  }
  for (const g of ['sessions', 'agents', 'prescriptions', 'sayings', 'creative', 'admin', 'reports']) {
    assert.equal(shouldRegister(g), false, `${g} 是军师的，不该进爱速拍进程`);
  }
});

test('白名单是白名单：军师以后新增的路由组默认漏不进来', () => {
  process.env.SERVICE_PROFILE = 'quickreel';
  // 模拟半年后有人加了一组新路由，忘了想爱速拍这件事
  assert.equal(shouldRegister('some-new-junshi-thing'), false);
});

test('军师的 worker 不在爱速拍进程里跑', () => {
  process.env.SERVICE_PROFILE = 'quickreel';
  // 两个进程同时轮询同一张队列表时，行为取决于抢锁顺序，出了问题说不清是谁干的
  assert.equal(shouldRunJunshiWorkers(), false);
});

test('拼错档位名就起不来，绝不静默退回全量', () => {
  process.env.SERVICE_PROFILE = 'quickreal';
  assert.throws(() => serviceProfile(), /SERVICE_PROFILE/);
  process.env.SERVICE_PROFILE = 'QuickReel';
  assert.equal(serviceProfile(), 'quickreel', '大小写不敏感，但拼写要对');
});

test('白名单覆盖端上真实在调的那几类接口', () => {
  // 端上（app/services/api.js + app/packages/video/api.js）实际会打的前缀：
  //   /video/*   业务面        → video
  //   /me、/me/credits         → meta
  //   /wechat/subscribe        → wechat
  //   登录换令牌 / 刷新         → auth
  for (const g of ['video', 'meta', 'wechat', 'auth']) {
    assert.ok(QUICKREEL_ROUTE_GROUPS.has(g), `${g} 必须在白名单里，否则小程序起不来`);
  }
  // 运维面：没有它这个进程没法被监控和告警
  for (const g of ['metrics', 'alerts']) {
    assert.ok(QUICKREEL_ROUTE_GROUPS.has(g), `${g} 是运维必需`);
  }
});

/**
 * 真起一个 quickreel 档的 app，看路由表。
 *
 * 上面几条验的是判定函数，这条验的是**装配结果** —— 判定对了但忘了接线，
 * 前面全绿这里会红。只有 SERVICE_PROFILE 在进程启动时就带着才生效
 * （test/hermeticEnv.mjs 会抹掉进程启动后新增的环境变量），所以这条用例
 * 只在以 `SERVICE_PROFILE=quickreel` 启动的那一轮里真正断言，否则跳过。
 */
test('quickreel 档装配出来的路由表：爱速拍的面都在，军师的一个都没有', async (t) => {
  // 用**模块加载时**捕获的原值判断，不读当下的 process.env —— 上面几条用例会改它
  // （其中一条特意测大小写，把它改成了 QuickReel），读当下的值这条永远跳过。
  if ((original ?? '').toLowerCase() !== 'quickreel') {
    t.skip('需要以 SERVICE_PROFILE=quickreel 启动；见 npm run test:profile');
    return;
  }
  const { buildApp } = await import('../src/app.js');
  const app = await buildApp();
  await app.ready();
  const routes = app.printRoutes({ commonPrefix: false });
  await app.close();

  for (const p of ['/api/video/', '/api/me', '/api/auth/', '/api/wechat/']) {
    assert.ok(routes.includes(p), `${p} 缺了，小程序会起不来`);
  }
  for (const p of ['/api/agents', '/api/sessions', '/api/prescriptions', '/api/admin/', '/api/reports']) {
    assert.ok(!routes.includes(p), `${p} 不该出现在爱速拍进程里`);
  }
});
