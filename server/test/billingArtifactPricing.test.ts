// 计费架构改造（2026-08-13）守卫用例：
//   改动 A：产出物价格表（services/artifactPricing.ts）——钻石价从「挂在 agent 上」改成「挂在
//           技能 key × 规格 上」，海报的新旧价字段之间有一条迁移期回退链。
//   改动 B：对话轴恒走 token——meterUnit 不再参与计费判定，所有对话一律走 reserveQuota 扣月度
//           token 额度，diamondCost 恒为 0（旧行为：meterUnit='image' 的智能体按对话轮次扣钻）。
// 这两个改动都不改变「产出物本身」的计费（海报出图仍按各自档位价扣钻），只改变「对话」这一层。
//
// 与 creative.test.ts 同样的前提（否则用例会莫名其妙全红）：
//   FeatureFlag 读走 60s 内存缓存，cleanBusiness() 只删库不清缓存——直接改库/改缓存旁路
//   （setFeatureFlagPayload 之外的写法）之后必须补一次 __clearFeatureCache()。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import { setFeatureFlagPayload, __clearFeatureCache } from '../src/services/featureFlag.js';
import {
  ARTIFACT_PRICING_FLAG_ID,
  getArtifactPrices, artifactPrice, updateArtifactPrices,
} from '../src/services/artifactPricing.js';
import {
  CREATIVE_FLAG_ID, POSTER_SKILL_KEY, DEFAULT_PRICE_PER_POSTER, DEFAULT_PREMIUM_PRICE_PER_POSTER,
  getCreativeConfig, updateCreativeConfig, priceForTier,
} from '../src/services/creative/config.js';
import { getBalance } from '../src/services/credits.js';
import { enqueueDurableGeneration } from '../src/services/generationRequest.js';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

/** 直接写 artifact-pricing 的 payload 并清缓存——绕开 updateArtifactPrices 的校验，模拟脏数据/历史手工改库。 */
async function setRawArtifactPricing(payload: Record<string, unknown>): Promise<void> {
  await setFeatureFlagPayload(ARTIFACT_PRICING_FLAG_ID, payload);
  __clearFeatureCache();
}

/** 直接写 creative-poster 的 payload 并清缓存——模拟迁移前生产库里已经存在的旧价字段值。 */
async function setRawCreativePayload(payload: Record<string, unknown>): Promise<void> {
  await setFeatureFlagPayload(CREATIVE_FLAG_ID, payload);
  __clearFeatureCache();
}

describe('产出物价格表 artifactPricing：纯函数守卫', () => {
  beforeEach(async () => {
    // cleanBusiness 会把 FeatureFlag 全表清掉（含上一例可能留下的 artifact-pricing 行）。
    await cleanBusiness();
    __clearFeatureCache();
  });

  test('未落库 → 整表为空对象；查任意技能/规格都是 null，不是 0', async () => {
    const table = await getArtifactPrices({ fresh: true });
    assert.deepEqual(table, {});
    // 0 是「免费」这个明确的业务含义，null 是「没数，去回退」——两者一旦混淆，
    // 迁移期一整条付费链路会被悄悄清零，所以这条必须钉死在「未配置返回 null」。
    assert.equal(artifactPrice(table, POSTER_SKILL_KEY, 'standard'), null);
    assert.equal(artifactPrice(table, POSTER_SKILL_KEY, 'premium'), null);
  });

  test('payload 不是普通对象（数组/字符串等脏形态）→ 按空表处理，不抛错', async () => {
    await setRawArtifactPricing([1, 2, 3] as unknown as Record<string, unknown>);
    assert.deepEqual(await getArtifactPrices({ fresh: true }), {}, '数组形态的脏 payload 不该让读价崩掉');
  });

  test('配置价为 0（免费）时读到确切的 0，不是 null——0 和"未配置"必须是两个可区分的值', async () => {
    const table = await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 0 } });
    const price = artifactPrice(table, POSTER_SKILL_KEY, 'standard');
    assert.equal(price, 0);
    assert.notEqual(price, null, '配的是 0，读回来必须还是 0，不能被误判成"没配"');
  });

  test('技能存在但某规格未配置 → 那个规格是 null，不影响已配置的另一规格', async () => {
    const table = await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 10 } }); // 只配 standard
    assert.equal(artifactPrice(table, POSTER_SKILL_KEY, 'standard'), 10);
    assert.equal(artifactPrice(table, POSTER_SKILL_KEY, 'premium'), null, '同一技能内，没配的规格依然是 null');
  });

  test('局部更新只覆盖传入的规格键，同技能内未传的规格原样保留', async () => {
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 12, premium: 30 } });
    const after = await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 20 } }); // 只改 standard
    assert.equal(after[POSTER_SKILL_KEY].standard, 20);
    assert.equal(after[POSTER_SKILL_KEY].premium, 30, '没传的 premium 不该被这次局部更新带偏或清掉');
  });

  test('局部更新按技能粒度合并，不会把表里其它技能的价格挤掉', async () => {
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 10 } });
    const after = await updateArtifactPrices({ another_skill: { standard: 5 } });
    assert.equal(after[POSTER_SKILL_KEY].standard, 10, '改别的技能不该动到 canvas_design');
    assert.equal(after.another_skill.standard, 5);
  });

  test('传字面 null 清掉某个规格的价：清完读回 null（交回调用方去回退），技能其它规格不受影响', async () => {
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 12, premium: 30 } });
    const after = await updateArtifactPrices({ [POSTER_SKILL_KEY]: { premium: null } });
    assert.equal(artifactPrice(after, POSTER_SKILL_KEY, 'premium'), null, '清完必须是 null（未配置），不是残留的 30 也不是 0');
    assert.equal(after[POSTER_SKILL_KEY].standard, 12, 'standard 不该被这次清空动到');
  });

  test('清光一个技能的所有规格后，该技能整条从表里消失（不留一个空对象占位）', async () => {
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 10 } });
    const after = await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: null } });
    assert.equal(after[POSTER_SKILL_KEY], undefined, '技能应整体从表中移除，而不是留一个 {} ');
  });

  test('越界/非数字脏值按未配置丢弃：负数、超过上限、非数字全部不写入，且不清空该技能其它合法规格', async () => {
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 10, premium: 25 } });
    // 传入的 standard 是脏值（负数），但这不是「传 null 清空」，语义上应是「这次没给出合法值」，
    // 已有的合法价必须原样保留——脏值不该有清空的副作用。
    const after = await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: -1 } });
    assert.equal(after[POSTER_SKILL_KEY].standard, 10, '负数是脏值，不该覆盖掉原有合法价（清空要传字面 null，不是随便传个坏数）');
    assert.equal(after[POSTER_SKILL_KEY].premium, 25, '没碰过的 premium 更不该被脏值波及');
  });

  test('价格上限 10000：恰好等于上限放行，超过一点即按未配置处理', async () => {
    const at = await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 10_000 } });
    assert.equal(at[POSTER_SKILL_KEY].standard, 10_000, '恰好等于上限应该放行（越界判断是 >MAX，不是 >=MAX）');
    const over = await updateArtifactPrices({ over_limit_skill: { standard: 10_001 } });
    assert.equal(over.over_limit_skill, undefined, '超过上限即便只多 1，也按未配置处理——技能不该出现在表里');
  });

  test('历史脏数据兜底：越过 updateArtifactPrices 直接写库的负数/超限/非数字/空 key 统一按未配置解析', async () => {
    await setRawArtifactPricing({
      [POSTER_SKILL_KEY]: { standard: -5, premium: 999_999 },
      broken_skill: { standard: 'not-a-number' },
      '': { standard: 10 },
    });
    const table = await getArtifactPrices({ fresh: true });
    assert.equal(artifactPrice(table, POSTER_SKILL_KEY, 'standard'), null, '负数按未配置');
    assert.equal(artifactPrice(table, POSTER_SKILL_KEY, 'premium'), null, '超过 10000 上限按未配置');
    assert.equal(table.broken_skill, undefined, '规格全是脏值 → 技能整条不出现（不留空技能占位）');
    assert.equal(table[''], undefined, '空技能 key 被丢弃');
  });

  test('写入价格做四舍五入（Math.round），不悄悄截断成整数以外的行为', async () => {
    const after = await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 12.6 } });
    assert.equal(after[POSTER_SKILL_KEY].standard, 13);
  });
});

describe('海报价格回退链：产出物价格表 → creative 旧字段 → 代码默认常量', () => {
  beforeEach(async () => {
    await cleanBusiness(); // 删掉 artifact-pricing 与 creative-poster 两行
    __clearFeatureCache();
  });

  test('三层都空 → 落到代码默认常量（10 / 25）', async () => {
    const cfg = await getCreativeConfig({ fresh: true });
    assert.equal(cfg.pricePerPoster, DEFAULT_PRICE_PER_POSTER);
    assert.equal(cfg.premiumPricePerPoster, DEFAULT_PREMIUM_PRICE_PER_POSTER);
  });

  // 与上一条「三层都空→10/25」对照：这里只翻一个变量（价格表配成 0），旧字段和默认常量都不动，
  // 单独隔离出"价格表本身的 0 会不会被它下面那层default 常量盖掉"——不掺杂旧字段这层，结论更干净。
  test('只有价格表配了 0（旧字段仍空），代码默认常量的 10 不该顶上来', async () => {
    const cfg = await getCreativeConfig({ fresh: true }); // 尚未 updateArtifactPrices：先确认起点确实是默认的 10
    assert.equal(cfg.pricePerPoster, DEFAULT_PRICE_PER_POSTER);

    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 0 } });
    const priced = await getCreativeConfig({ fresh: true });
    assert.equal(priced.pricePerPoster, 0, '价格表配的 0 必须原样透出，不能被它下面那层默认常量 10 顶替');
  });

  test('价格表空、creative-poster 旧字段有值 → 回退到旧字段（迁移期安全绳：上线当天价格不能变）', async () => {
    await setRawCreativePayload({ pricePerPoster: 18, premiumPricePerPoster: 40 });
    const cfg = await getCreativeConfig({ fresh: true });
    assert.equal(cfg.pricePerPoster, 18);
    assert.equal(cfg.premiumPricePerPoster, 40);
  });

  test('价格表只配了 standard：standard 用新表，premium 各自独立回退到旧字段（不是整表二选一）', async () => {
    await setRawCreativePayload({ pricePerPoster: 18, premiumPricePerPoster: 40 });
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 22 } }); // 只运营了 standard
    const cfg = await getCreativeConfig({ fresh: true });
    assert.equal(cfg.pricePerPoster, 22, 'standard 价格表已配置，优先于旧字段');
    assert.equal(cfg.premiumPricePerPoster, 40, 'premium 价格表没配，回退到旧字段的 40，不是代码默认的 25');
  });

  // 任务里特别要求的一条：0 是显式业务含义（免费），回退链必须用 ?? 而不是 ||，
  // 否则 0 会被判定成"假值"继续往下找旧字段/默认值，一次免费改价会被悄悄打回付费。
  test('价格表显式配 0（免费）不能被回退链打回旧字段/默认的非零价', async () => {
    await setRawCreativePayload({ pricePerPoster: 18, premiumPricePerPoster: 40 }); // 旧字段留着非零值
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 0, premium: 0 } }); // 运营把两档都配成免费
    const cfg = await getCreativeConfig({ fresh: true });
    assert.equal(cfg.pricePerPoster, 0, '配的是 0 就必须是 0，不能被回退成旧字段的 18 或默认的 10');
    assert.equal(cfg.premiumPricePerPoster, 0, '高级档同理');
  });

  test('priceForTier：标准档/高级档分别读各自的价（不会互相串价）', async () => {
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 12, premium: 33 } });
    const cfg = await getCreativeConfig({ fresh: true });
    assert.equal(priceForTier(cfg, 'standard'), 12);
    assert.equal(priceForTier(cfg, 'premium'), 33);
  });

  test('priceForTier 同样吃得到"配 0 即免费"：标准档配 0 时高级档不受影响，反之亦然', async () => {
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 0, premium: 33 } });
    const cfg = await getCreativeConfig({ fresh: true });
    assert.equal(priceForTier(cfg, 'standard'), 0, '标准档明确免费');
    assert.equal(priceForTier(cfg, 'premium'), 33, '高级档不该被标准档的免费配置带偏');
  });
});

describe('updateCreativeConfig：改价只写价格表，不动 creative-poster 的旧价字段', () => {
  beforeEach(async () => {
    await cleanBusiness();
    __clearFeatureCache();
  });

  test('改价后：价格表拿到新价，creative-poster 里的旧字段原样保留（它是迁移期回退层，只读不写）', async () => {
    // 显式写一个跟代码默认值不同的旧字段值——只有这样，"旧字段没被改价操作带偏"才是一句能证伪的话，
    // 否则旧字段恰好等于默认常量时，就算被误写成默认值也测不出来。
    await setRawCreativePayload({ pricePerPoster: 11, premiumPricePerPoster: 26, dailyLimit: 3 });

    await updateCreativeConfig({ pricePerPoster: 50, premiumPricePerPoster: 80 });

    const raw = await prisma.featureFlag.findUniqueOrThrow({ where: { id: CREATIVE_FLAG_ID } });
    const legacy = raw.payload as { pricePerPoster?: number; premiumPricePerPoster?: number; dailyLimit?: number };
    assert.equal(legacy.pricePerPoster, 11, '旧字段必须原样保留——写了就等于回退层失效，迁移期安全绳直接断掉');
    assert.equal(legacy.premiumPricePerPoster, 26);
    assert.equal(legacy.dailyLimit, 3, '顺带确认没有把其它非价格字段一起打乱');

    // 新价确实通过价格表生效（不是没写进去、也不是写去了别的地方）
    const table = await getArtifactPrices({ fresh: true });
    assert.equal(artifactPrice(table, POSTER_SKILL_KEY, 'standard'), 50);
    assert.equal(artifactPrice(table, POSTER_SKILL_KEY, 'premium'), 80);
    const cfg = await getCreativeConfig({ fresh: true });
    assert.equal(cfg.pricePerPoster, 50);
    assert.equal(cfg.premiumPricePerPoster, 80);
  });

  test('只改 dailyLimit（不带价格字段）时，价格表完全不受触碰', async () => {
    await updateArtifactPrices({ [POSTER_SKILL_KEY]: { standard: 40 } });
    await updateCreativeConfig({ dailyLimit: 9 });
    const table = await getArtifactPrices({ fresh: true });
    assert.equal(artifactPrice(table, POSTER_SKILL_KEY, 'standard'), 40, '没传价格字段就不该动价格表——避免"读一次就顺手重写一遍"的隐式副作用');
  });

  test('把标准档改成 0（免费）会原样落进价格表，不会被写入口自己的默认值兜底掉', async () => {
    await updateCreativeConfig({ pricePerPoster: 0 });
    const table = await getArtifactPrices({ fresh: true });
    assert.equal(artifactPrice(table, POSTER_SKILL_KEY, 'standard'), 0);
    assert.equal((await getCreativeConfig({ fresh: true })).pricePerPoster, 0);
  });
});

describe('对话轴恒走 token：meterUnit 不再参与计费判定', () => {
  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline(); // 这组用例要用到真实的 Agent/Plan 数据（登录、ip 智能体）
  });

  // ip 是仓库现成的「meterUnit=image 且 price>0」智能体（企业IP打造官，price=3）。
  // 旧行为：这类智能体按对话轮次扣 3 钻，且完全不占 token 额度。
  // 新行为：diamondCost 恒为 0，对话一律走 reserveQuota。这里用 durable 建单直接校验落库字段——
  // 不依赖 mock provider 会不会报出非零 token 用量（mock 恒为 ZERO_USAGE，settle 后会被全额退回，
  // 光看"事后余额有没有变少"在 mock 环境下测不出真假），改看**建单事务内**当场落的预留字段：
  // creditReserved 是否真的没被预留过、quotaReserved 是否真的被预留了一个确定的正数。
  test('durable 建单：image 计量智能体不再预留钻石，token 预留字段确定为正数', async () => {
    const phone = uniquePhone();
    await login(phone, '按张计费用户·durable');
    const user = await prisma.user.findUniqueOrThrow({ where: { phone } });

    // 前提断言：如果未来有人把种子数据里 ip 的 meterUnit/price 改掉，这条用例要第一时间报废，
    // 而不是安静地测着一个已经不存在的场景还显示通过。
    const agentRow = await prisma.agent.findUniqueOrThrow({ where: { key: 'ip' } });
    assert.equal(agentRow.meterUnit, 'image', '这条用例专测 meterUnit=image 这个组合，前提变了用例就没意义');
    assert.ok(agentRow.price > 0, '同上，price=0 的话测不出"曾经会扣钻"这个对照');

    const created = await enqueueDurableGeneration(user, {
      text: '帮我打造企业 IP', agentKey: 'ip', clientRequestId: `guard-image-axis-${phone}`,
    });
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: created.job.id } });

    // 钻石轴：creditCost 恒 0 → createGenerationJob 里 `if (creditCost > 0)` 那段完全不执行。
    assert.equal(job.creditReserved, 0, '图片计量智能体现在也不该在建单时预留钻石');
    assert.equal(job.creditSettlementStatus, 'none', '没发生任何钻石预留动作，结算状态该停在默认值');

    // token 轴：reserveTokens 现在对所有 agent 一视同仁地计算并预留，即使 meterUnit=image。
    assert.ok(job.quotaReserved > 0, 'token 额度应该被真实预留了一部分——旧代码会因为 isImage 整段跳过这里，预留恒为 0');
    assert.equal(job.settlementStatus, 'reserved');
  });

  test('HTTP /generate-sync（非 durable 旧链路）：image 计量智能体对话后钻石余额分毫不变', async () => {
    const t = await login(uniquePhone(), '按张计费用户·sync');
    const creditBefore = await getBalance(t);

    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我打造企业 IP', agentKey: 'ip' } });
    assert.equal(gen.status, 200, JSON.stringify(gen.body));
    assert.equal(gen.body.kind, 'report');
    // 旧行为会在这里扣掉 ip.price（3 钻）；新行为 diamondCost 恒为 0，reserveCredits 对 cost<=0 是空操作。
    assert.equal(gen.body.creditBalance, creditBefore, '对话不再按 price 扣钻——钻石轴分毫不动');
    assert.equal(await getBalance(t), creditBefore, '/me 之外再直查一次余额，双重确认没有任何流水落地');
    // tokenQuota 非空：旧代码里 `if (effective && !isImage)` 会让 image 智能体的 quotaReservation
    // 恒为 null，响应里的 tokenQuota 字段也就恒为 null；新代码不再有这道短路，字段必然回填。
    assert.ok(gen.body.tokenQuota, '响应应回填本月额度状态，证明这轮真的进了 token 结算这条路径');
  });

  test('SSE /generate（流式旧链路）：image 计量智能体的 credit 事件同样余额不变、附带 token 额度状态', async () => {
    const t = await login(uniquePhone(), '按张计费用户·sse');
    const creditBefore = await getBalance(t);

    const r = await api('POST', '/api/generate', { token: t, body: { text: '帮我打造企业 IP', agentKey: 'ip' } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const sse = String(r.body);
    const m = /event: credit\ndata: (\{[\s\S]*?\})\n\n/.exec(sse);
    assert.ok(m, 'SSE 流应包含一次 credit 事件（结算钻石与 token 额度）');
    const creditEvent = JSON.parse(m![1]) as { balance: number; tokenQuota: unknown };
    assert.equal(creditEvent.balance, creditBefore, '流式路径与同步路径同一套判定逻辑，同样不再按 price 扣钻');
    assert.ok(creditEvent.tokenQuota, '流式路径也必须回填 token 额度状态');
  });
});
