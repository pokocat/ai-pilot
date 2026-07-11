// P0-2 命理功能开关三层验收：flag off → /me 下发 false、命理端点 403、对话上下文降级为禁令（不含命盘）；
// flag on → 全部恢复。admin 开关端点 PATCH /admin/flags/:id 即时生效（合规开关直读 DB）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, uniquePhone, api } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { setFeatureFlag } from '../src/services/featureFlag.ts';
import { buildGenContext } from '../src/services/context.ts';
import { TIANSHI_OPTOUT_LINE } from '../src/services/paipan.ts';

// 一个合法排盘入参（阳历，含时辰）。
const BAZI = { calendar: 'solar', year: 1990, month: 6, day: 15, hour: 12, gender: 'male' };

describe('P0-2 命理功能开关三层', () => {
  let token = '';
  before(async () => {
    await getApp();
    await cleanBusiness();
    await seedBaseline();
    token = await login(uniquePhone(), '命理三层用户');
    await setFeatureFlag('fortune', true); // 起点：开
  });
  after(async () => { await setFeatureFlag('fortune', true); await closeApp(); });

  test('flag on：/me features.fortune=true；命理端点可用；上下文出命盘（非禁令）', async () => {
    await setFeatureFlag('fortune', true);
    const me = await api('GET', '/api/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.features?.fortune, true, '/me 下发 fortune=true');

    // 排盘落库成功（200）
    const bazi = await api('PUT', '/api/profile/bazi', { token, body: BAZI });
    assert.equal(bazi.status, 200, '排盘可用');
    assert.equal(bazi.body.believe, true);

    // 命盘可读
    const chart = await api('GET', '/api/profile/chart', { token });
    assert.equal(chart.status, 200);
    assert.ok(chart.body.chart, '有命盘');

    // 送你一卦预览可用
    const fate = await api('POST', '/api/cards/fate/preview', { token, body: { friendName: '老王', friendBazi: BAZI, consent: true } });
    assert.equal(fate.status, 200, '送你一卦可用');

    // 上下文：注入命盘简报（非禁令句）
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;
    const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '你好' });
    assert.notEqual(ctx.tianshiLine, TIANSHI_OPTOUT_LINE, '开启时注入命盘而非禁令');
    assert.ok(ctx.tianshiLine, '有天势简报');
  });

  test('flag off：/me features.fortune=false；命理端点全部 403 FEATURE_DISABLED；上下文降级为禁令（不含命盘）', async () => {
    await setFeatureFlag('fortune', false);

    const me = await api('GET', '/api/me', { token });
    assert.equal(me.status, 200);
    assert.equal(me.body.features?.fortune, false, '/me 下发 fortune=false');

    // 逐个命理端点 403 + code
    const endpoints: [string, string, object?][] = [
      ['PUT', '/api/profile/bazi', BAZI],
      ['GET', '/api/profile/chart', undefined],
      ['POST', '/api/cards/fate/preview', { friendName: '老王', friendBazi: BAZI, consent: true }],
      ['POST', '/api/cards/calendar', {}],
      ['POST', '/api/cards/fate', {}],
    ];
    for (const [method, url, body] of endpoints) {
      const r = await api(method as 'GET' | 'POST' | 'PUT', url, { token, body });
      assert.equal(r.status, 403, `${method} ${url} → 403`);
      assert.equal(r.body.code, 'FEATURE_DISABLED', `${method} ${url} → code FEATURE_DISABLED`);
    }

    // 每日战报（daily）非命理：不被开关拦截（不返回 FEATURE_DISABLED）
    const daily = await api('POST', '/api/cards/daily', { token, body: {} });
    assert.notEqual(daily.body?.code, 'FEATURE_DISABLED', 'daily 战报不受命理开关约束');

    // 上下文：降级为禁令句，不含命盘块
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;
    const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '你好' });
    assert.equal(ctx.tianshiLine, TIANSHI_OPTOUT_LINE, '关闭时注入禁令而非命盘');
  });

  test('flag on：关闭后再开启，端点与上下文全部恢复', async () => {
    await setFeatureFlag('fortune', true);
    const me = await api('GET', '/api/me', { token });
    assert.equal(me.body.features?.fortune, true);
    const chart = await api('GET', '/api/profile/chart', { token });
    assert.equal(chart.status, 200, '命盘端点恢复');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;
    const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '你好' });
    assert.notEqual(ctx.tianshiLine, TIANSHI_OPTOUT_LINE, '恢复注入命盘');
  });

  test('admin PATCH /admin/flags/:id 即时生效；GET /admin/flags 返回目录', async () => {
    const list = await api('GET', '/api/admin/flags', {});
    assert.equal(list.status, 200);
    const fortune = list.body.find((f: { id: string }) => f.id === 'fortune');
    assert.ok(fortune, '目录含 fortune');
    assert.equal(fortune.compliance, true, 'fortune 标记为合规开关');

    // 关闭 → /me 立即反映（合规开关直读 DB，无缓存窗口）
    const patch = await api('PATCH', '/api/admin/flags/fortune', { body: { enabled: false } });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.enabled, false);
    const meOff = await api('GET', '/api/me', { token });
    assert.equal(meOff.body.features?.fortune, false, '关闭即时下发');

    // 未知开关 404
    const bad = await api('PATCH', '/api/admin/flags/nope', { body: { enabled: false } });
    assert.equal(bad.status, 404);

    await api('PATCH', '/api/admin/flags/fortune', { body: { enabled: true } }); // 复位
  });
});
