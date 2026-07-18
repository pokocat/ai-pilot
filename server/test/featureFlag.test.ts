// WO-05 命理功能开关：默认开；关闭后 isEnabled=false 且上下文天势降级为禁令（不出命盘）。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { isFeatureEnabled, setFeatureFlag } from '../src/services/featureFlag.ts';
import { buildGenContext } from '../src/services/context.ts';
import { TIANSHI_OPTOUT_LINE } from '../src/services/paipan.ts';

describe('WO-05 命理功能开关', () => {
  before(async () => { await getApp(); await cleanBusiness(); await seedBaseline(); });
  after(async () => { await setFeatureFlag('fortune', true); await closeApp(); });

  test('默认开；关闭后 isEnabled=false 且天势注入降级为禁令（非命盘）', async () => {
    assert.equal(await isFeatureEnabled('fortune'), true, '默认开');
    const token = await login(uniquePhone(), '命理开关用户');
    const user = (await prisma.user.findUnique({ where: { id: token } }))!;

    await setFeatureFlag('fortune', false);
    assert.equal(await isFeatureEnabled('fortune'), false, '关闭后即时生效（setFlag 清缓存）');
    const { ctx } = await buildGenContext({ userId: user.id, tenantId: user.tenantId, agentKey: 'general', userMessage: '你好' });
    assert.equal(ctx.tianshiLine, TIANSHI_OPTOUT_LINE, '命理关闭 → 注入禁令而非命盘');

    await setFeatureFlag('fortune', true);
    assert.equal(await isFeatureEnabled('fortune'), true);
  });
});
