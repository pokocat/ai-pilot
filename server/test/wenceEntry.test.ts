// 问策入口改版 WP1：实验分桶 / 进场主动消息注入 / 提示词池 / 客户端埋点 / 后台模板池。
//
// 覆盖清单（对齐 AGENTS §11 后端集成测试红线，含 TC-G 跨用户不可见）：
//  · 分桶稳定性：同 userId 多次调用同组；开关关 → control；payload 缺失/非法 → control；单臂 100% 命中该臂
//  · proactive：注入成功 / 二次调用 reason='exists'（频控幂等）/ 空池 empty-pool 且不建会话 / 开关关 disabled
//  · 注入后 unreadCount=1（不写 lastReadAt）+ 列表 snippet 为模板文案 + 详情透出 chips
//  · TC-G：A 注入的会话与消息 B 不可见；A 的 ClientEvent 归属 A（无读端点 → 直查库断言 userId）
//  · /wence/hints：只回 enabled、按 sort、游客（无 token）可访问
//  · /events：白名单校验 + props 2KB 截断 + 游客可写 + 无效 token 401
//
// 注意：app 是模块级单例（helpers.getApp），整个文件只允许**一处** before/after 管生命周期——
// 每个 describe 各自 closeApp 会让后面的 describe 撞 FST_ERR_REOPENED_CLOSE_SERVER。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { setFeatureFlag, setFeatureFlagPayload, __clearFeatureCache } from '../src/services/featureFlag.ts';
import { WENCE_FLAG, DEFAULT_ARMS, resolveWenceForm, pickArm, effectiveArms } from '../src/services/wence.ts';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

/** 开启实验并配权重（payload 走 60s 缓存，改完必须清）。 */
async function enableWence(arms: Record<string, number>): Promise<void> {
  await setFeatureFlag(WENCE_FLAG, true);
  await setFeatureFlagPayload(WENCE_FLAG, { arms });
  __clearFeatureCache();
}

async function disableWence(): Promise<void> {
  await setFeatureFlag(WENCE_FLAG, false);
  __clearFeatureCache();
}

/** 模板池是运营内容、刻意不进 cleanBusiness（同 Saying），故用例自己收拾。 */
async function clearTemplates(): Promise<void> {
  await prisma.wenceTemplate.deleteMany();
}

describe('问策入口 WP1', () => {
  let alice = '';   // 主用户
  let bob = '';     // 隔离对照用户

  before(async () => {
    await getApp();
    await cleanBusiness();     // 含 featureFlag.deleteMany → wence_entry 回到「未落库」状态
    await seedBaseline();
    await clearTemplates();
    alice = await login(uniquePhone(), '问策用户');
    bob = await login(uniquePhone(), '隔壁用户');
  });
  after(async () => { await clearTemplates(); await disableWence(); await closeApp(); });

  describe('实验分桶', () => {
    test('开关未落库（默认关）→ control：实验必须运营显式打开才生效', async () => {
      await prisma.featureFlag.deleteMany({ where: { id: WENCE_FLAG } });
      __clearFeatureCache();
      assert.equal(await resolveWenceForm(alice), 'control');
      const me = await api('GET', '/api/me', { token: alice });
      assert.equal(me.status, 200);
      assert.equal(me.body.features.wenceForm, 'control', '/me 下发 control');
      assert.equal(me.body.features.fortune, true, '既有 fortune 开关不受影响');
    });

    test('开关开但 payload 缺失 / 非法 → 三臂均分兜底，而不是静默零分流', async () => {
      // 口径裁决（2026-08-08）：开关拨开了就必须真的在分流。「开着却全落 control」会让运营
      // 以为实验在收数据，失败得无声——比误开实验更坏。写入端的 arms 校验已挡住非法权重入库。
      const expected = pickArm(alice, DEFAULT_ARMS);

      for (const [label, payload] of [
        ['payload 缺失', null],
        ['权重全 0', { arms: { control: 0, dock: 0, chat: 0 } }],
        ['payload 形状不对', { nope: 1 }],
        ['arms 不是对象', { arms: [1, 2, 3] }],
        ['权重是负数/非数字', { arms: { control: -5, dock: 'x', chat: null } }],
      ] as const) {
        await prisma.featureFlag.deleteMany({ where: { id: WENCE_FLAG } });
        await setFeatureFlag(WENCE_FLAG, true);
        if (payload) await setFeatureFlagPayload(WENCE_FLAG, payload as object);
        __clearFeatureCache();
        assert.equal(await resolveWenceForm(alice), expected, `${label} → 按 DEFAULT_ARMS 分桶`);
        assert.equal(await resolveWenceForm(alice), expected, `${label} → 兜底路径同样稳定`);
      }

      // 均分兜底必须真的分流（不是「换个写法的全量 control」）
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(pickArm(`fallback-${i}`, DEFAULT_ARMS));
      assert.deepEqual(seen, new Set(['control', 'dock', 'chat']), '默认权重应覆盖三臂');
    });

    test('后台展示的权重 = 实际生效的权重（未配 payload 时同样显示均分）', async () => {
      // 展示与分桶共用 effectiveArms：两边分头算迟早漂移，运营就会照着假数字调实验。
      await prisma.featureFlag.deleteMany({ where: { id: WENCE_FLAG } });
      __clearFeatureCache();
      assert.deepEqual(effectiveArms(null), DEFAULT_ARMS);
      assert.deepEqual(effectiveArms({ arms: { control: 0, dock: 0, chat: 0 } }), DEFAULT_ARMS);
      assert.deepEqual(effectiveArms({ arms: { control: 50, dock: 25, chat: 25 } }), { control: 50, dock: 25, chat: 25 });

      const flags = await api('GET', '/api/admin/flags', {});
      const wence = flags.body.find((f: { id: string }) => f.id === WENCE_FLAG);
      assert.deepEqual(wence.arms, DEFAULT_ARMS, '未配 payload → 后台显示均分，不是 0/0/0');
    });

    test('分桶稳定：同 userId 连续 8 次同组；不同 userId 之间可分流', async () => {
      await enableWence({ control: 34, dock: 33, chat: 33 });
      const first = await resolveWenceForm(alice);
      for (let i = 0; i < 8; i++) {
        assert.equal(await resolveWenceForm(alice), first, `第 ${i + 2} 次必须与首次同组（禁止 Math.random）`);
      }
      const me = await api('GET', '/api/me', { token: alice });
      assert.equal(me.body.features.wenceForm, first, '/me 与服务层同一分桶（客户端不猜）');

      // 分流有效性：200 个确定性 id 至少落到 2 个臂（不是把所有人塞进同一桶）
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(pickArm(`u-${i}`, { control: 34, dock: 33, chat: 33 }));
      assert.ok(seen.size >= 2, `分桶应分流，实际只命中 ${[...seen].join(',')}`);
    });

    test('单臂 100% → 全量落该臂（灰度全开/全关的确定性）', async () => {
      await enableWence({ control: 0, dock: 0, chat: 100 });
      assert.equal(await resolveWenceForm(alice), 'chat');
      for (let i = 0; i < 50; i++) assert.equal(pickArm(`x-${i}`, { control: 0, dock: 0, chat: 100 }), 'chat');

      await enableWence({ control: 100, dock: 0, chat: 0 });
      assert.equal(await resolveWenceForm(alice), 'control');
    });

    test('开关关闭 → control（哪怕 payload 还留着权重）', async () => {
      await enableWence({ control: 0, dock: 0, chat: 100 });
      assert.equal(await resolveWenceForm(alice), 'chat');
      await disableWence();
      assert.equal(await resolveWenceForm(alice), 'control');
      const me = await api('GET', '/api/me', { token: alice });
      assert.equal(me.body.features.wenceForm, 'control');
    });
  });

  describe('进场主动消息注入', () => {
    beforeEach(async () => {
      await clearTemplates();
      await prisma.message.deleteMany();
      await prisma.session.deleteMany();
    });

    test('未登录 → 401（注入是写本人会话，鉴权必须）', async () => {
      await enableWence({ control: 0, dock: 0, chat: 100 });
      const r = await api('POST', '/api/sessions/proactive', {});
      assert.equal(r.status, 401);
    });

    test('开关关闭 → { injected:false, reason:"disabled" } 且不建会话', async () => {
      await disableWence();
      await prisma.wenceTemplate.create({ data: { kind: 'proactive', text: '开关关了也不该发', sort: 0 } });
      const r = await api('POST', '/api/sessions/proactive', { token: alice });
      assert.equal(r.status, 200, '降级不是错误，200 返回让端上静默过');
      assert.deepEqual(r.body, { injected: false, reason: 'disabled' });
      assert.equal(await prisma.session.count({ where: { userId: alice } }), 0);
    });

    test('空池 → { injected:false, reason:"empty-pool" } 且不建空会话', async () => {
      await enableWence({ control: 0, dock: 0, chat: 100 });
      const r = await api('POST', '/api/sessions/proactive', { token: alice });
      assert.deepEqual(r.body, { injected: false, reason: 'empty-pool' });
      assert.equal(await prisma.session.count({ where: { userId: alice } }), 0, '空池不得建会话');
    });

    test('enabled=false 的模板不算池（仍是 empty-pool）；按 sort 取首条', async () => {
      await enableWence({ control: 0, dock: 0, chat: 100 });
      await prisma.wenceTemplate.create({ data: { kind: 'proactive', text: '已下架', enabled: false, sort: 0 } });
      await prisma.wenceTemplate.create({ data: { kind: 'hint', text: 'hint 不是 proactive', sort: 0 } });
      const empty = await api('POST', '/api/sessions/proactive', { token: alice });
      assert.deepEqual(empty.body, { injected: false, reason: 'empty-pool' }, 'enabled=false + 异 kind 都不入池');

      await prisma.wenceTemplate.create({ data: { kind: 'proactive', text: '第二条', sort: 5 } });
      await prisma.wenceTemplate.create({ data: { kind: 'proactive', text: '第一条', sort: 1 } });
      const r = await api('POST', '/api/sessions/proactive', { token: alice });
      assert.equal(r.body.injected, true);
      const msgs = await prisma.message.findMany({ where: { sessionId: r.body.sessionId } });
      assert.equal((msgs[0].contentJson as { text: string }).text, '第一条', '按 sort 取首条');
    });

    test('注入：建 general 会话 + 一条 assistant 消息；二次调用幂等 reason="exists"', async () => {
      await enableWence({ control: 0, dock: 0, chat: 100 });
      await prisma.wenceTemplate.create({
        data: { kind: 'proactive', text: '你上季度的获客成本在涨，但成交周期没变——先看渠道还是先看话术？', chipsJson: ['先看渠道', '先看话术'], sort: 0 },
      });

      const first = await api('POST', '/api/sessions/proactive', { token: alice });
      assert.equal(first.status, 200);
      assert.equal(first.body.injected, true);
      const sid = first.body.sessionId as string;
      assert.ok(sid);

      const session = await prisma.session.findUnique({ where: { id: sid } });
      assert.equal(session?.agentKey, 'general');
      assert.equal(session?.lastReadAt, null, '★ 不得写 lastReadAt——未读角标必须亮');
      const msgs = await prisma.message.findMany({ where: { sessionId: sid } });
      assert.equal(msgs.length, 1);
      assert.equal(msgs[0].role, 'assistant', '只有 assistant 才计未读');

      // 二次调用：频控幂等（每用户至多一条），且不新建会话/消息
      const second = await api('POST', '/api/sessions/proactive', { token: alice });
      assert.deepEqual(second.body, { injected: false, reason: 'exists' });
      assert.equal(await prisma.session.count({ where: { userId: alice } }), 1);
      assert.equal(await prisma.message.count({ where: { session: { userId: alice } } }), 1);
    });

    test('注入后：列表 unreadCount=1、snippet=模板文案；详情透出 chips', async () => {
      await enableWence({ control: 0, dock: 0, chat: 100 });
      const text = '你上个月的复购只做了一半，今天先补哪一段？';
      await prisma.wenceTemplate.create({ data: { kind: 'proactive', text, chipsJson: ['先补复购', '先看新客'], sort: 0 } });
      const r = await api('POST', '/api/sessions/proactive', { token: alice });
      const sid = r.body.sessionId as string;

      const list = await api('GET', '/api/sessions', { token: alice });
      const item = list.body.find((x: { id: string }) => x.id === sid);
      assert.ok(item, '注入的会话应出现在列表');
      assert.equal(item.unreadCount, 1, '未读角标必须亮');
      assert.equal(item.hasUnread, true);
      assert.equal(item.snippet, text, '列表 snippet = 主动消息正文');

      const detail = await api('GET', `/api/sessions/${sid}`, { token: alice });
      assert.equal(detail.status, 200);
      const msg = detail.body.messages[0];
      assert.equal(msg.role, 'assistant');
      assert.equal(msg.content.text, text);
      assert.deepEqual(msg.chips, ['先补复购', '先看新客'], 'chips 透出到消息层（不被 present 清洗掉）');

      // 打开会话后照旧置读（既有行为不变）
      const after = await api('GET', '/api/sessions', { token: alice });
      assert.equal(after.body.find((x: { id: string }) => x.id === sid).unreadCount, 0);
    });

    test('无 chips 的模板：不下发 chips 字段（端上据此不渲染这一排）', async () => {
      await enableWence({ control: 0, dock: 0, chat: 100 });
      await prisma.wenceTemplate.create({ data: { kind: 'proactive', text: '光有判断没有选项', sort: 0 } });
      const r = await api('POST', '/api/sessions/proactive', { token: alice });
      const detail = await api('GET', `/api/sessions/${r.body.sessionId}`, { token: alice });
      assert.equal(detail.body.messages[0].chips, undefined);
    });

    test('已有 general 会话的老用户不注入（触发人群 = 从未发过消息）', async () => {
      await enableWence({ control: 0, dock: 0, chat: 100 });
      await prisma.wenceTemplate.create({ data: { kind: 'proactive', text: '不该发给老用户', sort: 0 } });
      const gen = await api('POST', '/api/generate-sync', { token: alice, body: { text: '你好', agentKey: 'general' } });
      assert.equal(gen.status, 200, JSON.stringify(gen.body));

      const r = await api('POST', '/api/sessions/proactive', { token: alice });
      assert.deepEqual(r.body, { injected: false, reason: 'exists' });
    });

    test('TC-G 跨用户隔离：A 注入的会话与消息，B 一律不可见', async () => {
      await enableWence({ control: 0, dock: 0, chat: 100 });
      await prisma.wenceTemplate.create({ data: { kind: 'proactive', text: 'A 的私密主动消息', chipsJson: ['A 的选项'], sort: 0 } });
      const r = await api('POST', '/api/sessions/proactive', { token: alice });
      const sid = r.body.sessionId as string;

      const theirList = await api('GET', '/api/sessions', { token: bob });
      assert.ok(!theirList.body.some((x: { id: string }) => x.id === sid), 'B 的列表不含 A 的会话');
      const theirDetail = await api('GET', `/api/sessions/${sid}`, { token: bob });
      assert.equal(theirDetail.status, 404, 'B 按 id 取详情 → 404');

      // B 自己调注入：拿到的是 B 自己的新会话，与 A 的不是同一条
      const mine = await api('POST', '/api/sessions/proactive', { token: bob });
      assert.equal(mine.body.injected, true);
      assert.notEqual(mine.body.sessionId, sid);
      const bSession = await prisma.session.findUnique({ where: { id: mine.body.sessionId } });
      assert.equal(bSession?.userId, bob, 'B 的会话归属 B');
    });
  });

  describe('提示词池 /wence/hints', () => {
    beforeEach(async () => { await clearTemplates(); });

    test('空池合法：返回 { hints: [] }，不是 404 也不是错误', async () => {
      const r = await api('GET', '/api/wence/hints', {});
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { hints: [] });
    });

    test('游客（无 token）可访问；只回 enabled 的 hint，按 sort 排', async () => {
      await prisma.wenceTemplate.create({ data: { kind: 'hint', text: '第二个问题', sort: 2 } });
      await prisma.wenceTemplate.create({ data: { kind: 'hint', text: '第一个问题', sort: 1 } });
      await prisma.wenceTemplate.create({ data: { kind: 'hint', text: '已下架的问题', enabled: false, sort: 0 } });
      await prisma.wenceTemplate.create({ data: { kind: 'proactive', text: '主动消息不混进词池', sort: 0 } });

      const guest = await api('GET', '/api/wence/hints', {});
      assert.equal(guest.status, 200, '★ 游客也要能看提示词（登录门不得前置）');
      assert.deepEqual(guest.body.hints.map((h: { text: string }) => h.text), ['第一个问题', '第二个问题']);
      assert.ok(guest.body.hints.every((h: { id: string }) => typeof h.id === 'string' && h.id), '带 hint_id 供埋点回溯');

      const logged = await api('GET', '/api/wence/hints', { token: alice });
      assert.deepEqual(logged.body, guest.body, '登录与否同口径');
    });
  });

  describe('客户端埋点 /events', () => {
    test('白名单外的事件名 → 400，且不写库', async () => {
      const before = await prisma.clientEvent.count();
      for (const name of ['hack_event', '', 'wence_enter ', 'WENCE_ENTER']) {
        const r = await api('POST', '/api/events', { token: alice, body: { name } });
        assert.equal(r.status, 400, `${JSON.stringify(name)} 应被拒`);
        assert.equal(r.body.code, 'BAD_EVENT_NAME');
      }
      assert.equal(await prisma.clientEvent.count(), before, '被拒的事件不入库');
    });

    test('八个白名单事件名全部接受', async () => {
      const names = ['wence_enter', 'proactive_show', 'chip_tap', 'hint_tap', 'first_message_send', 'drawer_open', 'attach_open', 'tab_switch'];
      for (const name of names) {
        const r = await api('POST', '/api/events', { token: alice, body: { name } });
        assert.equal(r.status, 200, `${name} 应被接受：${JSON.stringify(r.body)}`);
        assert.deepEqual(r.body, { ok: true });
      }
      const rows = await prisma.clientEvent.findMany({ where: { userId: alice } });
      assert.deepEqual(new Set(rows.map((r) => r.name)), new Set(names));
    });

    test('游客（无 token）可上报，userId 为空', async () => {
      const r = await api('POST', '/api/events', { body: { name: 'wence_enter', props: { user_state: 'guest', form: 'chat' } } });
      assert.equal(r.status, 200);
      const row = await prisma.clientEvent.findFirst({ where: { userId: null, name: 'wence_enter' }, orderBy: { createdAt: 'desc' } });
      assert.ok(row, '游客事件应入库');
      assert.equal(row!.userId, null);
      assert.deepEqual(row!.propsJson, { user_state: 'guest', form: 'chat' });
    });

    test('带无效 token → 401（不静默降级成游客事件，免得污染 user_state 维度）', async () => {
      const r = await api('POST', '/api/events', { token: 'not-a-real-user', body: { name: 'wence_enter' } });
      assert.equal(r.status, 401);
    });

    test('props 超 2KB → 截断入库（事件本身不丢）', async () => {
      const r = await api('POST', '/api/events', { token: alice, body: { name: 'chip_tap', props: { blob: 'x'.repeat(5000) } } });
      assert.equal(r.status, 200);
      const row = await prisma.clientEvent.findFirst({ where: { userId: alice, name: 'chip_tap' }, orderBy: { createdAt: 'desc' } });
      const props = row!.propsJson as { truncated?: boolean; raw?: string };
      assert.equal(props.truncated, true, '超限打截断标记');
      assert.ok(Buffer.byteLength(props.raw ?? '', 'utf8') <= 2048, '截断后不超 2KB');
      assert.ok(Buffer.byteLength(JSON.stringify(row!.propsJson), 'utf8') < 5000);
    });

    test('props 非对象 / 缺省 → 不写 props，事件照常入库', async () => {
      const r = await api('POST', '/api/events', { token: alice, body: { name: 'tab_switch', props: 'oops' } });
      assert.equal(r.status, 200);
      const row = await prisma.clientEvent.findFirst({ where: { userId: alice, name: 'tab_switch' }, orderBy: { createdAt: 'desc' } });
      assert.equal(row!.propsJson, null);
    });

    test('TC-G 跨用户隔离：A 的事件归属 A，B 名下查不到（无读端点 → 直查库断言归属）', async () => {
      await prisma.clientEvent.deleteMany({ where: { name: 'first_message_send' } });
      await api('POST', '/api/events', { token: alice, body: { name: 'first_message_send', props: { ttfm_ms: 4200 } } });
      const aRows = await prisma.clientEvent.findMany({ where: { userId: alice, name: 'first_message_send' } });
      assert.equal(aRows.length, 1);
      assert.equal(aRows[0].userId, alice);
      assert.equal(aRows[0].tenantId !== null, true, '已登录事件带租户，供多租户分析');
      const bRows = await prisma.clientEvent.findMany({ where: { userId: bob, name: 'first_message_send' } });
      assert.equal(bRows.length, 0, 'B 名下不该出现 A 的事件');
    });
  });

  describe('运营后台模板池 CRUD', () => {
    beforeEach(async () => { await clearTemplates(); });

    test('无 admin token → 401；普通用户 token → 403', async () => {
      const anon = await api('GET', '/api/admin/wence-templates', { adminToken: false });
      assert.equal(anon.status, 401);
      const user = await api('GET', '/api/admin/wence-templates', { adminToken: false, token: alice });
      assert.equal(user.status, 403);
    });

    test('CRUD 全链路：建 → 列（按 kind 过滤）→ 改（含清空 chips）→ 删', async () => {
      const created = await api('POST', '/api/admin/wence-templates', {
        body: { kind: 'proactive', text: '你的现金流只剩两个月，先砍成本还是先催收？', chips: ['先砍成本', '先催收'] },
      });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      assert.equal(created.body.kind, 'proactive');
      assert.deepEqual(created.body.chips, ['先砍成本', '先催收']);
      assert.equal(created.body.enabled, true);
      const id = created.body.id as string;

      await api('POST', '/api/admin/wence-templates', { body: { kind: 'hint', text: '这个月该先做什么？' } });
      const all = await api('GET', '/api/admin/wence-templates', {});
      assert.equal(all.body.length, 2);
      const onlyHint = await api('GET', '/api/admin/wence-templates?kind=hint', {});
      assert.equal(onlyHint.body.length, 1);
      assert.equal(onlyHint.body[0].kind, 'hint');
      const badKind = await api('GET', '/api/admin/wence-templates?kind=nope', {});
      assert.equal(badKind.status, 400);

      const patched = await api('PATCH', `/api/admin/wence-templates/${id}`, { body: { enabled: false, sort: 9, chips: [] } });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.enabled, false);
      assert.equal(patched.body.sort, 9);
      assert.equal(patched.body.chips, null, '显式传空数组 = 清空 chips');

      const badText = await api('PATCH', `/api/admin/wence-templates/${id}`, { body: { text: '   ' } });
      assert.equal(badText.status, 400);
      const badCreate = await api('POST', '/api/admin/wence-templates', { body: { kind: 'nope', text: 'x' } });
      assert.equal(badCreate.status, 400);

      const del = await api('DELETE', `/api/admin/wence-templates/${id}`, {});
      assert.equal(del.status, 200);
      assert.equal(await prisma.wenceTemplate.count({ where: { id } }), 0);
      const missing = await api('DELETE', `/api/admin/wence-templates/${id}`, {});
      assert.equal(missing.status, 404);

      // 审计留痕（create/update/delete 各一条）
      const audits = await prisma.auditLog.findMany({ where: { action: { startsWith: 'admin.wenceTemplate.' } } });
      assert.ok(audits.length >= 3, `应有 create/update/delete 审计，实际 ${audits.length}`);
    });

    test('开关目录登记了 wence_entry：默认关、可改 arms 权重且不误清', async () => {
      await prisma.featureFlag.deleteMany({ where: { id: WENCE_FLAG } });
      __clearFeatureCache();
      const flags = await api('GET', '/api/admin/flags', {});
      const wence = flags.body.find((f: { id: string }) => f.id === WENCE_FLAG);
      assert.ok(wence, 'FEATURE_FLAG_CATALOG 应登记 wence_entry');
      assert.equal(wence.enabled, false, '实验开关未落库时默认关（不能把全量用户扔进实验）');
      assert.equal(wence.kind, 'toggle');
      const fortune = flags.body.find((f: { id: string }) => f.id === 'fortune');
      assert.equal(fortune.enabled, true, '既有开关默认开的口径不受影响');

      const setArms = await api('PATCH', `/api/admin/flags/${WENCE_FLAG}`, { body: { arms: { control: 50, dock: 25, chat: 25 } } });
      assert.equal(setArms.status, 200, JSON.stringify(setArms.body));
      assert.deepEqual(setArms.body.arms, { control: 50, dock: 25, chat: 25 });

      const on = await api('PATCH', `/api/admin/flags/${WENCE_FLAG}`, { body: { enabled: true } });
      assert.equal(on.body.enabled, true);
      assert.deepEqual(on.body.arms, { control: 50, dock: 25, chat: 25 }, '只改 enabled 不得清掉已配权重');

      for (const bad of [{ arms: { control: 0, dock: 0, chat: 0 } }, { arms: { nope: 100 } }, { arms: { control: 999 } }, { arms: [] }]) {
        const r = await api('PATCH', `/api/admin/flags/${WENCE_FLAG}`, { body: bad });
        assert.equal(r.status, 400, `${JSON.stringify(bad)} 应被拒`);
      }
      // 非法提交不得改坏已生效的配置
      const after = await api('GET', '/api/admin/flags', {});
      const still = after.body.find((f: { id: string }) => f.id === WENCE_FLAG);
      assert.deepEqual(still.arms, { control: 50, dock: 25, chat: 25 });
      await disableWence();
    });
  });
});
