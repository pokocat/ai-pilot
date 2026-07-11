// 军师后端集成测试（mock 模型，可复现）。
// 运行：先备好测试库并 `DATABASE_URL=...＿test npm run db:push`，再 `npm test`（详见 docs/TESTING.md）。
// 覆盖：鉴权/隔离基线、多智能体对话、记忆召回、项目+知识库+跨对话召回、版本化报告+diff、
//       ★跨用户隔离（防信息泄露）、模型配置不泄露明文 key。
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { api, login, seedBaseline, cleanBusiness, closeApp, uniquePhone, deliverable, getApp } from './helpers.js';
// 直接断言的服务层（也是后端的一部分）
import { recallMemories, recordFeedback, learnFromConversation, recencyDecay, mmrSelect } from '../src/services/memory.js';
import { buildGenContext } from '../src/services/context.js';
import { hybridSearch, resolveReferences } from '../src/services/retrieval.js';
import { ingestUploadedFile, getKnowledgeDetail } from '../src/services/knowledge.js';
import type { MemoryConfig } from '../src/data/agents.js';
import { recordTokenUsage, tokenUsageSummary } from '../src/services/usage.js';
import { addModel } from '../src/services/aiConfig.js';
import { setQuota, getQuotaState, chargeQuota, ensureQuota, reserveQuota } from '../src/services/tokenQuota.js';
import { loadHistory } from '../src/routes/sessions.js';
import { moderate, listModerationLogs } from '../src/services/moderation.js';
import { chatCompleteStream } from '../src/llm/gateway.js';
import { dryRunTool } from '../src/services/skillTools.js';
import { aggregateToolStats } from '../src/services/toolStats.js';
import { percentEncode, canonicalQuery, aliyunSignature } from '../src/services/sms.js';
import { _resetTokenCache } from '../src/services/wechat.js';

const tenantOf = async (token: string) =>
  (await prisma.user.findUnique({ where: { id: token } }))!.tenantId;

before(async () => {
  process.env.ADMIN_TOKEN = 'test-admin-token';
  await cleanBusiness();
  await seedBaseline();
});
after(async () => {
  await closeApp();
});

// ───────────────────────── TC-A 鉴权与账号隔离基线 ─────────────────────────
describe('TC-A 鉴权与账号隔离基线', () => {
  test('A1 无 token 访问受保护接口 → 401', async () => {
    const r = await api('GET', '/api/me');
    assert.equal(r.status, 401);
  });

  test('A2 手机号登录自动建号；A、B 各自独立租户', async () => {
    const ta = await login(uniquePhone(), '甲公司');
    const tb = await login(uniquePhone(), '乙公司');
    assert.ok(ta && tb && ta !== tb, '两个账号 token 应不同');
    const meA = await api('GET', '/api/me', { token: ta });
    const meB = await api('GET', '/api/me', { token: tb });
    assert.equal(meA.status, 200);
    assert.notEqual(meA.body.tenant.id, meB.body.tenant.id, '两个账号应属于不同租户');
  });

  test('A3 非法/失效 token → 401', async () => {
    const r = await api('GET', '/api/me', { token: 'not-a-real-user-id' });
    assert.equal(r.status, 401);
  });

  test('A4 微信登录用 openid 建号，复登命中同一账号', async () => {
    const oldFetch = globalThis.fetch;
    process.env.WECHAT_MINI_APPID = 'wx-test-appid';
    process.env.WECHAT_MINI_SECRET = 'wx-test-secret';
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('appid'), 'wx-test-appid');
      assert.equal(url.searchParams.get('secret'), 'wx-test-secret');
      assert.equal(url.searchParams.get('grant_type'), 'authorization_code');
      return new Response(JSON.stringify({
        openid: 'openid-test-a',
        unionid: 'unionid-test-a',
        session_key: 'should-not-return-to-client',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    try {
      const first = await api('POST', '/api/auth/wechat-login', { body: { code: 'wx-code-a' } });
      assert.equal(first.status, 200);
      assert.equal(first.body.isNew, true);
      assert.equal(first.body.user.wechatLinked, true);
      assert.equal(first.body.user.phone, '');
      assert.equal(first.body.session_key, undefined, '不应把微信 session_key 下发给前端');

      const second = await api('POST', '/api/auth/wechat-login', { body: { code: 'wx-code-b' } });
      assert.equal(second.status, 200);
      assert.equal(second.body.isNew, false);
      assert.equal(second.body.token, first.body.token, '同一 openid 应复用同一账号');

      const user = await prisma.user.findUnique({ where: { id: first.body.token } });
      assert.equal(user?.wechatOpenId, 'openid-test-a');
      assert.equal(user?.wechatUnionId, 'unionid-test-a');
    } finally {
      globalThis.fetch = oldFetch;
      delete process.env.WECHAT_MINI_APPID;
      delete process.env.WECHAT_MINI_SECRET;
    }
  });

  test('A5 admin 接口必须有管理员凭证，普通用户不能访问', async () => {
    const anon = await api('GET', '/api/admin/overview', { adminToken: false });
    assert.equal(anon.status, 401);
    const t = await login(uniquePhone());
    const owner = await api('GET', '/api/admin/overview', { token: t, adminToken: false });
    assert.equal(owner.status, 403);
  });
});

// ───────────────────────── TC-F 短信验证码登录 / 一键登录 ─────────────────────────
describe('TC-F 短信验证码登录 / 一键登录', () => {
  test('F1 发送验证码 → 演示口径回传 devCode + 冷却/有效期', async () => {
    const phone = uniquePhone();
    const r = await api('POST', '/api/auth/sms/send', { body: { phone } });
    assert.equal(r.status, 200);
    assert.match(String(r.body.devCode), /^\d{6}$/);
    assert.ok(r.body.cooldownSec > 0 && r.body.expiresInSec > 0);
  });

  test('F2 正确验证码 → 登录建号；返回真实手机号', async () => {
    const phone = uniquePhone();
    const sent = await api('POST', '/api/auth/sms/send', { body: { phone } });
    const r = await api('POST', '/api/auth/login', { body: { phone, code: sent.body.devCode, name: '丙公司' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.isNew, true);
    assert.equal(r.body.user.phone, phone);
    const me = await api('GET', '/api/me', { token: r.body.token });
    assert.equal(me.status, 200);
  });

  test('F3 错误验证码 → 400 SMS_CODE_INVALID', async () => {
    const phone = uniquePhone();
    await api('POST', '/api/auth/sms/send', { body: { phone } });
    const r = await api('POST', '/api/auth/login', { body: { phone, code: '000000' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'SMS_CODE_INVALID');
  });

  test('F4 验证码一次性：消费后再用即失效', async () => {
    const phone = uniquePhone();
    const sent = await api('POST', '/api/auth/sms/send', { body: { phone } });
    const code = sent.body.devCode as string;
    assert.equal((await api('POST', '/api/auth/login', { body: { phone, code } })).status, 200);
    assert.equal((await api('POST', '/api/auth/login', { body: { phone, code } })).status, 400);
  });

  test('F5 冷却内重复发送 → 429 SMS_TOO_FREQUENT', async () => {
    const phone = uniquePhone();
    assert.equal((await api('POST', '/api/auth/sms/send', { body: { phone } })).status, 200);
    const b = await api('POST', '/api/auth/sms/send', { body: { phone } });
    assert.equal(b.status, 429);
    assert.equal(b.body.code, 'SMS_TOO_FREQUENT');
  });

  test('F6 免码登录仍可用（未传 code，向后兼容演示/测试）', async () => {
    const r = await api('POST', '/api/auth/login', { body: { phone: uniquePhone() } });
    assert.equal(r.status, 200);
  });

  test('F7 本机号一键登录：phoneCode 换号 → 登录建号，复登命中同号（mock 微信取号）', async () => {
    const oldFetch = globalThis.fetch;
    process.env.WECHAT_MINI_APPID = 'wx-test-appid';
    process.env.WECHAT_MINI_SECRET = 'wx-test-secret';
    _resetTokenCache();
    const phone = uniquePhone();
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('stable_token')) {
        return new Response(JSON.stringify({ access_token: 'tok-test', expires_in: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('getuserphonenumber')) {
        return new Response(JSON.stringify({ errcode: 0, phone_info: { purePhoneNumber: phone, countryCode: '86' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected fetch ' + url);
    }) as typeof fetch;
    try {
      const r = await api('POST', '/api/auth/wechat-phone', { body: { phoneCode: 'pc-123' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.isNew, true);
      assert.equal(r.body.user.phone, phone);
      const again = await api('POST', '/api/auth/wechat-phone', { body: { phoneCode: 'pc-456' } });
      assert.equal(again.body.token, r.body.token, '同号应复用同一账号');
    } finally {
      globalThis.fetch = oldFetch;
      delete process.env.WECHAT_MINI_APPID;
      delete process.env.WECHAT_MINI_SECRET;
      _resetTokenCache();
    }
  });

  test('F8 运营商一键登录入口预留 → 501 NOT_IMPLEMENTED', async () => {
    const r = await api('POST', '/api/auth/carrier-onetap', { body: { token: 't' } });
    assert.equal(r.status, 501);
    assert.equal(r.body.code, 'CARRIER_ONETAP_NOT_IMPLEMENTED');
  });

  test('F9 登录尝试和匿名 API 行为都会落审计，且验证码脱敏', async () => {
    const phone = uniquePhone();
    await api('POST', '/api/auth/sms/send', { body: { phone } });
    const bad = await api('POST', '/api/auth/login', { body: { phone, code: '000000' } });
    assert.equal(bad.status, 400);

    const attempt = await prisma.auditLog.findFirst({ where: { action: 'auth.login.attempt' }, orderBy: { createdAt: 'desc' } });
    assert.ok(attempt, '失败登录尝试应落审计');
    const attemptPayload = attempt!.payloadJson as any;
    assert.equal(attemptPayload.ok, false);
    assert.equal(attemptPayload.errorCode, 'SMS_CODE_INVALID');
    assert.equal(attemptPayload.phoneMasked, `${phone.slice(0, 3)}****${phone.slice(-4)}`);

    await api('GET', '/api/me');
    const recentHttp = await prisma.auditLog.findMany({ where: { action: 'user.http' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 20 });
    const http = recentHttp.find((row) => {
      const payload = row.payloadJson as any;
      return payload?.path === '/api/me' && payload?.statusCode === 401 && payload?.auth?.state === 'anonymous';
    });
    assert.ok(http, '匿名受保护 API 也应落 HTTP 审计');
    const httpPayload = http!.payloadJson as any;
    assert.equal(httpPayload.path, '/api/me');
    assert.equal(httpPayload.statusCode, 401);
    assert.equal(httpPayload.auth.state, 'anonymous');
    assert.equal(httpPayload.body?.code, undefined, 'HTTP 审计不应保存验证码明文');
  });

  test('F10 阿里云签名工具：百分号编码与排序确定、可复现', () => {
    assert.equal(percentEncode('a b+c*d~e'), 'a%20b%2Bc%2Ad~e');
    assert.equal(canonicalQuery({ b: '2', a: '1', Ab: '3' }), 'Ab=3&a=1&b=2');
    const p = { Action: 'SendSms', PhoneNumbers: '13800138000', SignName: '军师' };
    assert.equal(aliyunSignature('GET', p, 'sk'), aliyunSignature('GET', p, 'sk'));
  });

  test('F11 先「微信一键登录」建号、后「本机号一键登录」不应另建新号（身份分裂回归）', async () => {
    const oldFetch = globalThis.fetch;
    process.env.WECHAT_MINI_APPID = 'wx-test-appid';
    process.env.WECHAT_MINI_SECRET = 'wx-test-secret';
    _resetTokenCache();
    const fragOpenid = 'openid-frag-' + Math.random().toString(36).slice(2);
    const conflictPhone = uniquePhone();
    const realPhone = uniquePhone();
    const phoneByCode: Record<string, string> = {};
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes('stable_token')) {
        return new Response(JSON.stringify({ access_token: 'tok-frag', expires_in: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('jscode2session')) {
        return new Response(JSON.stringify({ openid: fragOpenid }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('getuserphonenumber')) {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        const phone = phoneByCode[body.code as string];
        return new Response(JSON.stringify({ errcode: 0, phone_info: { purePhoneNumber: phone, countryCode: '86' } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('unexpected fetch ' + url);
    }) as typeof fetch;
    try {
      // 1) 先用「微信一键登录」建号 A（占位手机号 wx_<openid>）。
      const wxLogin = await api('POST', '/api/auth/wechat-login', { body: { code: 'wx-code-frag' } });
      assert.equal(wxLogin.status, 200);
      assert.equal(wxLogin.body.isNew, true);
      const tokenA = wxLogin.body.token as string;

      // 2) 另一个真实用户 C 已占用 conflictPhone。
      const tokenC = await login(conflictPhone);

      // 3) 本机号一键登录：同一 openid，但取回的手机号已被 C 占用 → 409 PHONE_TAKEN，不应静默建号/顶号。
      phoneByCode['pc-conflict'] = conflictPhone;
      const conflict = await api('POST', '/api/auth/wechat-phone', { body: { phoneCode: 'pc-conflict', loginCode: 'wx-code-frag-again' } });
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.code, 'PHONE_TAKEN');
      const aAfterConflict = await prisma.user.findUnique({ where: { id: tokenA } });
      assert.equal(aAfterConflict?.wechatOpenId, fragOpenid, 'A 的 openid 关联不应被冲突尝试破坏');
      assert.ok(aAfterConflict?.phone.startsWith('wx_'), 'A 的占位手机号不应被冲突尝试改写');
      const cAfterConflict = await prisma.user.findUnique({ where: { id: tokenC } });
      assert.equal(cAfterConflict?.phone, conflictPhone, 'C 的账号不应受影响');

      // 4) 本机号一键登录：同一 openid，取回未占用的真实手机号 → 应命中账号 A（同 token），而非另建新号。
      phoneByCode['pc-real'] = realPhone;
      const onetap = await api('POST', '/api/auth/wechat-phone', { body: { phoneCode: 'pc-real', loginCode: 'wx-code-frag-again' } });
      assert.equal(onetap.status, 200);
      assert.equal(onetap.body.isNew, false);
      assert.equal(onetap.body.token, tokenA, '同一微信身份的本机号一键登录应复用微信一键登录建的账号，而非另建新号');
      assert.equal(onetap.body.user.phone, realPhone);

      // 5) 之后再用「微信一键登录」复登，应仍是同一账号且能看到真实手机号（已从占位号更新）。
      const wxAgain = await api('POST', '/api/auth/wechat-login', { body: { code: 'wx-code-frag-2' } });
      assert.equal(wxAgain.body.token, tokenA);
      assert.equal(wxAgain.body.user.phone, realPhone);
    } finally {
      globalThis.fetch = oldFetch;
      delete process.env.WECHAT_MINI_APPID;
      delete process.env.WECHAT_MINI_SECRET;
      _resetTokenCache();
    }
  });
});

// ───────────────────────── TC-G 绑定手机号（登录后可选） / 头像 ─────────────────────────
describe('TC-G 绑定手机号 / 头像', () => {
  test('G1 已登录用户绑定手机号：scene=bind 验证码通过 → 写入并可在 /me 看到', async () => {
    const token = await login(uniquePhone());
    const newPhone = uniquePhone();
    const sent = await api('POST', '/api/auth/sms/send', { body: { phone: newPhone, scene: 'bind' } });
    assert.equal(sent.status, 200);
    const r = await api('POST', '/api/auth/bind-phone', { token, body: { phone: newPhone, code: sent.body.devCode } });
    assert.equal(r.status, 200);
    assert.equal(r.body.phone, newPhone);
    const me = await api('GET', '/api/me', { token });
    assert.equal(me.body.user.phone, newPhone);
  });

  test('G2 bind 场景与 login 场景的验证码相互独立（错码 → 400）', async () => {
    const token = await login(uniquePhone());
    const newPhone = uniquePhone();
    await api('POST', '/api/auth/sms/send', { body: { phone: newPhone, scene: 'bind' } });
    const r = await api('POST', '/api/auth/bind-phone', { token, body: { phone: newPhone, code: '000000' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'SMS_CODE_INVALID');
  });

  test('G3 目标手机号已被其他账号占用 → 409 PHONE_TAKEN，不顶号', async () => {
    const occupied = uniquePhone();
    await login(occupied); // 账号 B 占用
    const token = await login(uniquePhone()); // 账号 A
    const sent = await api('POST', '/api/auth/sms/send', { body: { phone: occupied, scene: 'bind' } });
    const r = await api('POST', '/api/auth/bind-phone', { token, body: { phone: occupied, code: sent.body.devCode } });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'PHONE_TAKEN');
  });

  test('G4 未登录绑定 → 401', async () => {
    const r = await api('POST', '/api/auth/bind-phone', { body: { phone: uniquePhone(), code: '123456' } });
    assert.equal(r.status, 401);
  });

  test('G5 上传头像：未登录 → 401；已登录但测试环境无 OSS → 503 OSS_NOT_CONFIGURED', async () => {
    const anon = await api('POST', '/api/me/avatar', {});
    assert.equal(anon.status, 401);
    const token = await login(uniquePhone());
    const r = await api('POST', '/api/me/avatar', { token, body: {} });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'OSS_NOT_CONFIGURED');
  });

  test('G6 微信一键绑定手机号：phoneCode 换号绑定到当前账号（mock 微信取号）', async () => {
    const oldFetch = globalThis.fetch;
    process.env.WECHAT_MINI_APPID = 'wx-test-appid';
    process.env.WECHAT_MINI_SECRET = 'wx-test-secret';
    _resetTokenCache();
    const boundPhone = uniquePhone();
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('stable_token')) return new Response(JSON.stringify({ access_token: 'tok-bind', expires_in: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.includes('getuserphonenumber')) return new Response(JSON.stringify({ errcode: 0, phone_info: { purePhoneNumber: boundPhone } }), { status: 200, headers: { 'content-type': 'application/json' } });
      throw new Error('unexpected fetch ' + url);
    }) as typeof fetch;
    try {
      const token = await login(uniquePhone()); // 已登录账号（演示用手机号占位）
      const r = await api('POST', '/api/auth/bind-phone', { token, body: { phoneCode: 'pc-bind-1' } });
      assert.equal(r.status, 200);
      assert.equal(r.body.phone, boundPhone);
      const me = await api('GET', '/api/me', { token });
      assert.equal(me.body.user.phone, boundPhone);
    } finally {
      globalThis.fetch = oldFetch;
      delete process.env.WECHAT_MINI_APPID;
      delete process.env.WECHAT_MINI_SECRET;
      _resetTokenCache();
    }
  });
});

// ───────────────────────── TC-B 与不同智能体对话（mock） ─────────────────────────
describe('TC-B 与不同智能体对话（mock，无真实 LLM）', () => {
  test('B1 通用军师 general → 自由对话回复', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '你好，最近该关注什么', agentKey: 'general' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.kind, 'chat');
    assert.ok(r.body.reply?.text, '应有回复文本');
  });

  test('B2 战略诊断官 strat → 结构化成果（report）', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
    assert.equal(r.body.kind, 'report');
    assert.ok((r.body.deliverable?.sections?.length ?? 0) > 0, '成果应有分段内容');
  });

  test('B2b on-demand 产出模式：闲聊出对话(chat)，明确要成果才出 report', async () => {
    const t = await login(uniquePhone());
    await prisma.agent.update({ where: { key: 'strat' }, data: { skillsConfig: { enabled: false, tools: [], deliverableMode: 'on-demand' } } });
    // 闲聊轮 → 文本对话，不应产出结构化成果卡（不挂「存入方案库/网页版」按钮）
    const chat = await api('POST', '/api/generate-sync', { token: t, body: { text: '最近一直在纠结要不要扩张团队，你怎么看？', agentKey: 'strat' } });
    assert.equal(chat.body.kind, 'chat', '闲聊轮应是对话');
    assert.ok(chat.body.reply?.text, '对话应有文本');
    assert.equal(chat.body.deliverable, undefined, '对话轮不应有结构化成果');
    // 明确要成果 → 出 report
    const rep = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
    assert.equal(rep.body.kind, 'report', '要报告时应产出结构化成果');
    assert.ok((rep.body.deliverable?.sections?.length ?? 0) > 0);
    await prisma.agent.update({ where: { key: 'strat' }, data: { skillsConfig: { enabled: false, tools: [] } } });
  });

  test('B3b 网页版报告按需生成（产出时不自动生成；幂等；属主隔离）', async () => {
    const t = await login(uniquePhone());
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
    assert.equal(gen.body.kind, 'report');
    assert.equal(gen.body.deliverable?.htmlUrl, undefined, '产出时不应自动生成网页版报告');
    const sid = gen.body.sessionId, mid = gen.body.messageId;
    const made = await api('POST', `/api/sessions/${sid}/messages/${mid}/report`, { token: t });
    assert.equal(made.status, 200);
    assert.match(made.body.htmlUrl, /\/api\/r\//, '应返回可分享链接');
    const again = await api('POST', `/api/sessions/${sid}/messages/${mid}/report`, { token: t });
    assert.equal(again.body.htmlUrl, made.body.htmlUrl, '幂等：再次调用复用同一链接');
    const other = await login(uniquePhone());
    const denied = await api('POST', `/api/sessions/${sid}/messages/${mid}/report`, { token: other });
    assert.equal(denied.status, 404, '非属主不可生成');
  });

  test('B4 技能与模型接入解耦：inherit(全局模型) agent 也带 ctx.skills', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    await prisma.agent.update({ where: { key: 'strat' }, data: { providerMode: 'inherit', skillsConfig: { enabled: true, tools: ['search_knowledge'] } } });
    const { buildGenContext } = await import('../src/services/context.js');
    const { ctx } = await buildGenContext({ userId: t, tenantId, agentKey: 'strat', userMessage: '测试' });
    assert.equal(ctx.runtime, null, 'inherit → 无 per-agent 接入覆盖');
    assert.equal(ctx.skills?.enabled, true, 'inherit agent 仍带技能配置（不再被丢弃）');
    assert.deepEqual(ctx.skills?.tools, ['search_knowledge']);
    await prisma.agent.update({ where: { key: 'strat' }, data: { skillsConfig: { enabled: false, tools: [] } } });
  });

  test('B3 会话持久化与可回溯', async () => {
    const t = await login(uniquePhone());
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '增长方案怎么做', agentKey: 'growth' } });
    const sid = gen.body.sessionId;
    const list = await api('GET', '/api/sessions', { token: t });
    assert.ok(list.body.some((s: any) => s.id === sid), '会话列表应含该会话');
    const detail = await api('GET', `/api/sessions/${sid}`, { token: t });
    assert.equal(detail.status, 200);
    assert.ok(detail.body.messages.length >= 2, '应还原 用户消息 + 产出');
  });
});

// ───────────────────────── TC-C 长期记忆召回 ─────────────────────────
describe('TC-C 长期记忆召回', () => {
  test('C1 与顾问对话后写入长期记忆，下次可召回', async () => {
    const t = await login(uniquePhone());
    await api('POST', '/api/generate-sync', { token: t, body: { text: '我们最头疼的是获客成本太高', agentKey: 'strat' } });
    const mems = await recallMemories(t, 'strat', 5, '获客成本');
    assert.ok(mems.some((m) => m.includes('获客成本')), '应召回到含「获客成本」的记忆');
  });

  test('C2 语义召回：与问题相关的记忆排在前', async () => {
    const t = await login(uniquePhone());
    await api('POST', '/api/generate-sync', { token: t, body: { text: '我们最关注获客成本与转化率', agentKey: 'strat' } });
    await api('POST', '/api/generate-sync', { token: t, body: { text: '我们在筹备 A 轮融资与期权池设计', agentKey: 'strat' } });
    const top = await recallMemories(t, 'strat', 1, '融资 期权');
    assert.ok(top[0]?.includes('融资'), `应优先召回融资相关记忆，实际：${top[0]}`);
  });
});

// ───────────────────────── TC-D 项目 + 知识库 + 跨对话召回 ─────────────────────────
describe('TC-D 项目 + 知识库 + 跨对话召回', () => {
  test('D1 创建项目，会话归属项目', async () => {
    const t = await login(uniquePhone());
    const p = await api('POST', '/api/projects', { token: t, body: { name: '2026 融资冲刺' } });
    const pid = p.body.id;
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '融资准备清单', agentKey: 'fund', projectId: pid } });
    const detail = await api('GET', `/api/sessions/${gen.body.sessionId}`, { token: t });
    assert.equal(detail.body.projectId, pid, '会话应归属该项目');
  });

  test('D2 知识入库 → 检索命中 → 下次对话上下文召回', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const p = await api('POST', '/api/projects', { token: t, body: { name: '客群研究' } });
    const pid = p.body.id;
    await api('POST', '/api/knowledge', { token: t, body: { text: '高价值客群集中在制造与医疗 SaaS，续费率高、客单价高', projectId: pid, kind: 'insight', title: '高价值客群' } });

    const search = await api('GET', `/api/knowledge/search?q=${encodeURIComponent('制造 医疗 客群')}&projectId=${pid}`, { token: t });
    assert.ok(search.body.length > 0, '混合检索应命中知识');

    // 下次对话：buildGenContext 应把项目知识召回进上下文
    const { ctx } = await buildGenContext({ userId: t, tenantId, agentKey: 'strat', userMessage: '我们的高价值客群在哪些行业', projectId: pid });
    assert.ok(ctx.knowledge && ctx.knowledge.length > 0, '上下文应注入项目知识');
    assert.ok(ctx.knowledge.join('').includes('制造'), '召回内容应相关');
  });

  test('D3 对话汇总 → 版本化报告 + 沉淀知识库', async () => {
    const t = await login(uniquePhone());
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
    const sum = await api('POST', `/api/sessions/${gen.body.sessionId}/summarize`, { token: t });
    assert.equal(sum.status, 200);
    assert.ok(sum.body.reportId && sum.body.version >= 1, '应生成版本化纪要报告');
    assert.ok(sum.body.knowledgeAdded >= 1, '纪要要点应沉淀进知识库');
    const kb = await api('GET', '/api/knowledge', { token: t });
    assert.ok(kb.body.some((k: any) => k.sourceType === 'conversation'), '知识库应有对话来源的条目');
  });
});

// ───────────────────────── TC-E 版本化报告 + diff ─────────────────────────
describe('TC-E 版本化报告 + diff', () => {
  test('E1~E3 同名续版本、同内容去重', async () => {
    const t = await login(uniquePhone());
    const save = (secs: any) => api('POST', '/api/library', { token: t, body: { title: '战略诊断报告', type: '战略体检', agentKey: 'strat', content: deliverable('战略诊断报告', secs) } });
    const v1 = await save([{ h: '现状', b: '获客成本偏高' }]);
    assert.equal(v1.body.version, 1);
    const v2 = await save([{ h: '现状', b: '获客成本偏高，需控制' }]);
    assert.equal(v2.body.version, 2, '改内容应升版本');
    const v2dup = await save([{ h: '现状', b: '获客成本偏高，需控制' }]);
    assert.equal(v2dup.body.version, 2, '同内容应去重，不新增版本');

    const doc = await api('GET', `/api/reports/${v1.body.reportId}`, { token: t });
    assert.equal(doc.body.versions.length, 2, '应恰好 2 个版本');
  });

  test('E4 两版差异：section 级 + 词级高亮', async () => {
    const t = await login(uniquePhone());
    const save = (secs: any) => api('POST', '/api/library', { token: t, body: { title: '增长方案', type: '增长方案', agentKey: 'growth', content: deliverable('增长方案', secs) } });
    const v1 = await save([{ h: '路径', b: '先做私域复购' }]);
    await save([{ h: '路径', b: '先做私域复购，再拓新渠道' }, { h: '风险', b: '渠道成本' }]);
    const diff = await api('GET', `/api/reports/${v1.body.reportId}/diff?from=1&to=2`, { token: t });
    assert.equal(diff.status, 200);
    const changed = diff.body.sections.find((s: any) => s.h === '路径');
    const added = diff.body.sections.find((s: any) => s.h === '风险');
    assert.equal(changed.change, 'changed');
    assert.equal(added.change, 'added');
    assert.ok(changed.words?.some((w: any) => w.t === 'add'), '应含词级新增片段');
    assert.ok(changed.words?.some((w: any) => w.t === 'eq'), '应含词级未变片段');
  });
});

// ───────────────────────── TC-G ★ 跨用户隔离（防信息泄露） ─────────────────────────
describe('TC-G ★ 跨用户知识库/数据隔离（防泄露）', () => {
  test('A 的项目/报告/知识/记忆，B 一律不可见、不可召回、不可引用', async () => {
    const A = await login(uniquePhone(), '甲');
    const B = await login(uniquePhone(), '乙');
    const tenantA = await tenantOf(A);
    const tenantB = await tenantOf(B);

    // A 沉淀机密内容
    const pa = await api('POST', '/api/projects', { token: A, body: { name: 'A机密项目' } });
    const ka = await api('POST', '/api/knowledge', { token: A, body: { text: 'A的机密客户名单：晨曦集团、北辰科技', projectId: pa.body.id, title: '机密客户' } });
    const ra = await api('POST', '/api/library', { token: A, body: { title: 'A机密战略', type: '战略体检', agentKey: 'strat', content: deliverable('A机密战略', [{ h: '核心', b: 'A的独家打法' }]) } });
    await api('POST', '/api/generate-sync', { token: A, body: { text: 'A的机密：我们要收购晨曦集团', agentKey: 'strat' } });

    // —— 列表接口：B 全空 ——
    assert.equal((await api('GET', '/api/projects', { token: B })).body.length, 0, 'B 不应看到 A 的项目');
    assert.equal((await api('GET', '/api/reports', { token: B })).body.length, 0, 'B 不应看到 A 的报告');
    assert.equal((await api('GET', '/api/library', { token: B })).body.length, 0, 'B 不应看到 A 的方案库');
    assert.equal((await api('GET', '/api/knowledge', { token: B })).body.length, 0, 'B 不应看到 A 的知识');

    // —— 检索接口：B 搜不到 A 的机密（关键防泄露点）——
    const leak = await api('GET', `/api/knowledge/search?q=${encodeURIComponent('机密客户名单 晨曦集团')}`, { token: B });
    assert.equal(leak.body.length, 0, 'B 的检索绝不能命中 A 的机密知识');

    // —— 直取 A 资源：B 得 404（不可见）——
    assert.equal((await api('GET', `/api/projects/${pa.body.id}`, { token: B })).status, 404);
    assert.equal((await api('GET', `/api/reports/${ra.body.reportId}`, { token: B })).status, 404);

    // —— 服务层：跨租户检索 / 引用解析 / 记忆召回 一律隔离 ——
    assert.ok((await hybridSearch({ tenantId: tenantA, query: '机密客户名单' })).length > 0, 'A 自己应能检索到');
    assert.equal((await hybridSearch({ tenantId: tenantB, query: '机密客户名单' })).length, 0, 'B 租户检索应为空');

    // B 即便拿到 A 的 id 显式 @引用，也解析不出内容
    const refs = await resolveReferences(tenantB, B, [
      { kind: 'report', id: ra.body.reportId, label: 'x' },
      { kind: 'knowledge', id: ka.body.id, label: 'x' },
    ]);
    assert.equal(refs.lines.length, 0, 'B 引用 A 的资源不应解析出任何内容');

    // A 的记忆只进 A 的上下文，不进 B 的
    const memA = await recallMemories(A, 'strat', 5, '晨曦集团 收购');
    const memB = await recallMemories(B, 'strat', 5, '晨曦集团 收购');
    assert.ok(memA.some((m) => m.includes('晨曦')), 'A 应召回自己的记忆');
    assert.equal(memB.length, 0, 'B 不应召回任何 A 的记忆');

    // B 的对话上下文不含 A 的知识
    const { ctx: ctxB } = await buildGenContext({ userId: B, tenantId: tenantB, agentKey: 'strat', userMessage: '机密客户名单', projectId: null });
    assert.equal((ctxB.knowledge ?? []).length, 0, 'B 的上下文不应注入任何 A 的知识');
  });
});

// ───────────────────────── TC-H 模型配置（不泄露明文 key） ─────────────────────────
describe('TC-H 模型配置（默认 Agnes，可切换，不泄露明文 key）', () => {
  test('H1 读配置：含 hasKey 布尔，绝不回传明文 apiKey；预设可用', async () => {
    const r = await api('GET', '/api/admin/ai-config');
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.config.hasKey, 'boolean');
    assert.ok(!('apiKey' in r.body.config), '对外配置不得包含明文 apiKey 字段');
    assert.ok(r.body.presets.some((p: any) => p.id === 'agnes'), '应含 Agnes 预设');
  });

  test('H2 改配置：切到 Agnes；未配 key 时实际降级 mock', async () => {
    const r = await api('PUT', '/api/admin/ai-config', { body: { provider: 'openai', label: 'Agnes 2.0 Flash', baseUrl: 'https://apihub.agnes-ai.com/v1', model: 'agnes-2.0-flash' } });
    assert.equal(r.body.config.model, 'agnes-2.0-flash');
    assert.equal(r.body.config.hasKey, false, '未传 key → 无 key');
    assert.equal(r.body.config.ready, false, '无真实 key → 未就绪');
    assert.equal(r.body.config.effectiveProvider, 'mock', '未就绪应实际降级 mock');
    assert.ok(!('apiKey' in r.body.config));
  });

  test('H3 空 body 的 application/json POST 不报 400（activate 等无 body 接口；防 FST_ERR_CTP_EMPTY_JSON_BODY 回归）', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST', url: '/api/admin/ai-models/bogus-id/activate',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'test-admin-token' }, payload: '',
    });
    assert.notEqual(res.statusCode, 400, '空 JSON body 不应触发 fastify 空体 400');
    assert.equal(res.statusCode, 404, '应过 body 解析、走到路由自身的 404（模型不存在）');
  });
});

// ───────────────────────── TC-I 流式产出（SSE） ─────────────────────────
describe('TC-I 流式产出（SSE /generate）', () => {
  test('I1 顾问结构化成果按事件流式下发', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate', { token: t, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
    assert.equal(r.status, 200);
    const sse = String(r.body);
    for (const ev of ['event: begin', 'event: section', 'event: footer', 'event: done']) {
      assert.ok(sse.includes(ev), `SSE 应包含 ${ev}`);
    }
  });
});

// ───────────────────────── TC-J 内容审核拦截（合规） ─────────────────────────
describe('TC-J 内容审核拦截', () => {
  test('J1 命中违规词的输入 → 422 拦截', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我评估一个赌博平台的获客方案', agentKey: 'general' } });
    assert.equal(r.status, 422, '违规输入应被拦截');
    assert.equal(r.body.code, 'MODERATION_BLOCK');
  });

  test('J2 P1-B5 沙盒跳过审核 + 拦截日志可查且带 user/session 关联', async () => {
    const before = (await listModerationLogs({ verdict: 'block' })).length;
    // 沙盒/评测不审核、不写日志
    assert.equal(await moderate('input', '这是赌博内容', { sandbox: true }), true, '沙盒应跳过审核（放行）');
    // 正常拦截：写日志并带 user/session 关联
    assert.equal(await moderate('input', '这是赌博内容', { userId: 'u_mod', sessionId: 's_mod' }), false);
    const logs = await listModerationLogs({ verdict: 'block' });
    assert.ok(logs.length > before, '拦截应写入审核日志');
    const mine = logs.find((l) => l.sessionId === 's_mod');
    assert.ok(mine && mine.userId === 'u_mod', '审核日志应带 user/session 关联（此前 write-only 黑洞）');
  });

  test('J3 P1-B5 归一化挡拆字/插符绕过', async () => {
    assert.equal(await moderate('input', '帮我做个 赌 博 平台'), false, '空格拆字应被拦');
    assert.equal(await moderate('input', '赌.博.推广'), false, '插标点应被拦');
    assert.equal(await moderate('input', '帮我做正常的增长咨询'), true, '正常内容放行');
  });

  test('J4 P1-B5 http provider 解析 pass/block + 故障 fail-open（mock 服务验证代码侧完整）', async () => {
    const { createServer } = await import('node:http');
    let mode: 'pass' | 'block' | 'error' = 'pass';
    const server = createServer((_req, res) => {
      if (mode === 'error') { res.statusCode = 500; res.end('err'); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(mode === 'block' ? { block: true, label: '违规', score: 0.9 } : { pass: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const saved: Record<string, string | undefined> = {
      MODERATION_PROVIDER: process.env.MODERATION_PROVIDER,
      MODERATION_API_URL: process.env.MODERATION_API_URL,
      MODERATION_FAIL_OPEN: process.env.MODERATION_FAIL_OPEN,
    };
    const restore = (k: string, v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
    process.env.MODERATION_PROVIDER = 'http';
    process.env.MODERATION_API_URL = `http://127.0.0.1:${port}/check`;
    try {
      mode = 'pass';
      assert.equal(await moderate('input', '正常内容', { userId: 'u_http' }), true, 'http pass=true → 放行');
      mode = 'block';
      assert.equal(await moderate('input', '任意内容'), false, 'http block=true → 拦截');
      const blocked = await prisma.moderationLog.findFirst({ where: { verdict: 'block' }, orderBy: { createdAt: 'desc' } });
      assert.equal((blocked?.detailJson as { provider?: string } | null)?.provider, 'http', '日志记录 http provider 来源');
      mode = 'error';
      process.env.MODERATION_FAIL_OPEN = 'true';
      assert.equal(await moderate('input', '任意'), true, '服务 500 + fail-open=true → 放行');
      process.env.MODERATION_FAIL_OPEN = 'false';
      assert.equal(await moderate('input', '任意'), false, '服务 500 + fail-open=false → 拦截');
    } finally {
      Object.entries(saved).forEach(([k, v]) => restore(k, v));
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

// ───────────────────────── TC-K 算力（套餐赠送 + 按次计量 + 不足拦截） ─────────────────────────
describe('TC-K 算力账户', () => {
  test('K1 注册即按套餐赠送算力，/me 可见余额', async () => {
    const t = await login(uniquePhone());
    const me = await api('GET', '/api/me', { token: t });
    assert.ok(me.body.creditBalance > 0, '新账号应有赠送算力');
    assert.ok(me.body.plan, '应绑定套餐');
  });

  test('K2 报告类产出按次扣减、自由对话免费，/me 同步', async () => {
    const t = await login(uniquePhone());
    const before = (await api('GET', '/api/me', { token: t })).body.creditBalance as number;
    const r1 = await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat' } });
    assert.equal(r1.body.creditBalance, before, '文本报告走 token 额度，不扣钻石');
    assert.ok(r1.body.tokenQuota, '产出应回填本月额度状态');
    assert.equal((await api('GET', '/api/me', { token: t })).body.creditBalance, before, '/me 钻石余额不变');
    const r2 = await api('POST', '/api/generate-sync', { token: t, body: { text: '随便聊聊', agentKey: 'general' } });
    assert.equal(r2.body.creditBalance, before, '对话同样走 token 额度，不扣钻石');
  });

  test('K3 额度不足 → 产出被 402 INSUFFICIENT_QUOTA 拦截、不留会话', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, 0); // 置零本月 token 额度
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat' } });
    assert.equal(r.status, 402);
    assert.equal(r.body.code, 'INSUFFICIENT_QUOTA');
    assert.equal((await api('GET', '/api/sessions', { token: t })).body.length, 0, '被拦截不应留下会话');
    const chat = await api('POST', '/api/generate-sync', { token: t, body: { text: '聊聊', agentKey: 'general' } });
    assert.equal(chat.status, 402, '额度耗尽：对话也走 token 额度，同样拦截');
  });

  test('K4 购买套餐 → 切换套餐、入账算力、后台用量同步', async () => {
    const t = await login(uniquePhone());
    const before = (await api('GET', '/api/me', { token: t })).body.creditBalance as number;
    const plans = await api('GET', '/api/plans');
    assert.equal(plans.status, 200);
    const decision = plans.body.find((p: any) => p.name === '决策版');
    assert.ok(decision, '应返回决策版套餐');

    const buy = await api('POST', `/api/plans/${decision.id}/purchase`, { token: t, body: {} });
    assert.equal(buy.status, 200);
    assert.equal(buy.body.plan.name, '决策版');
    assert.equal(buy.body.grantedCredits, decision.creditsPerMonth);
    assert.equal(buy.body.creditBalance, before + decision.creditsPerMonth);

    const me = await api('GET', '/api/me', { token: t });
    assert.equal(me.body.plan.name, '决策版');
    assert.equal(me.body.creditBalance, before + decision.creditsPerMonth);

    const usage = await api('GET', '/api/admin/usage');
    const row = usage.body.users.find((u: any) => u.id === t);
    assert.equal(row.planName, '决策版');
    assert.equal(row.creditBalance, before + decision.creditsPerMonth);
    assert.equal(row.totalGranted, before + decision.creditsPerMonth);
  });

  test('K5 购买企业版不限量后，报告产出不再扣减', async () => {
    const t = await login(uniquePhone());
    const plans = await api('GET', '/api/plans');
    const enterprise = plans.body.find((p: any) => p.creditsPerMonth < 0);
    assert.ok(enterprise, '应有不限量企业版套餐');

    const buy = await api('POST', `/api/plans/${enterprise.id}/purchase`, { token: t, body: {} });
    assert.equal(buy.status, 200);
    assert.equal(buy.body.creditBalance, -1);
    assert.equal(buy.body.grantedCredits, 0);

    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat' } });
    assert.equal(gen.status, 200);
    assert.equal(gen.body.creditBalance, -1, '不限量套餐报告产出后仍为不限量');
    assert.equal((await api('GET', '/api/me', { token: t })).body.creditBalance, -1);
  });
});

// ───────────────────────── TC-V 智能体权益（赠送 / 解锁 / 按次 / 后台开通） ─────────────────────────
describe('TC-V 智能体权益', () => {
  test('V1 GET /agents 返回 billing/price/owned；免费可用、付费默认未解锁', async () => {
    const t = await login(uniquePhone());
    const list = (await api('GET', '/api/agents', { token: t })).body as any[];
    const strat = list.find((a) => a.key === 'strat');
    const copy = list.find((a) => a.key === 'copy');
    const ip = list.find((a) => a.key === 'ip');
    assert.equal(strat.billing, 'free');
    assert.equal(strat.owned, true, '免费智能体恒为已拥有');
    assert.equal(copy.billing, 'unlock');
    assert.equal(copy.owned, false, '付费解锁类默认未拥有');
    assert.ok(copy.price > 0, 'unlock 应有价格');
    assert.equal(ip.billing, 'metered');
    assert.equal(ip.owned, true, '按次计费无需解锁，owned=true');
  });

  test('V2 未解锁 unlock 智能体产出 → 403 AGENT_LOCKED，不留会话', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '写个文案', agentKey: 'copy' } });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'AGENT_LOCKED');
    assert.equal((await api('GET', '/api/sessions', { token: t })).body.length, 0, '被拦截不应留下会话');
  });

  test('V3 用算力解锁 unlock 智能体 → 扣算力、owned=true、随后可产出', async () => {
    const t = await login(uniquePhone());
    const before = (await api('GET', '/api/me', { token: t })).body.creditBalance as number;
    const copy = (await api('GET', '/api/agents', { token: t })).body.find((a: any) => a.key === 'copy');
    assert.ok(before >= copy.price, '体验版赠送算力应足够解锁 copy');

    const buy = await api('POST', '/api/agents/copy/purchase', { token: t, body: {} });
    assert.equal(buy.status, 200);
    assert.equal(buy.body.alreadyOwned, false);
    assert.equal(buy.body.pricePaid, copy.price);
    assert.equal(buy.body.creditBalance, before - copy.price, '解锁应扣减算力');
    assert.equal((await api('GET', '/api/me', { token: t })).body.creditBalance, before - copy.price, '/me 同步');

    const owned = (await api('GET', '/api/agents', { token: t })).body.find((a: any) => a.key === 'copy');
    assert.equal(owned.owned, true);

    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '写个文案', agentKey: 'copy' } });
    assert.equal(gen.status, 200);
    assert.equal(gen.body.kind, 'report');
  });

  test('V4 解锁幂等：重复购买不再扣费、alreadyOwned=true', async () => {
    const t = await login(uniquePhone());
    const first = await api('POST', '/api/agents/copy/purchase', { token: t, body: {} });
    const balAfter = first.body.creditBalance as number;
    const again = await api('POST', '/api/agents/copy/purchase', { token: t, body: {} });
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyOwned, true);
    assert.equal(again.body.pricePaid, 0);
    assert.equal(again.body.creditBalance, balAfter, '重复购买余额不变');
  });

  test('V5 算力不足解锁 → 402 INSUFFICIENT_CREDITS，不开通', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    await prisma.creditLedger.create({ data: { tenantId, userId: t, delta: -999, reason: '测试置零', balance: 0 } });
    // 用保留科室里的 unlock 智能体 ops（D-8 后 intel 已下架、purchase 走 404 不再走 402 口径）。
    const buy = await api('POST', '/api/agents/ops/purchase', { token: t, body: {} });
    assert.equal(buy.status, 402);
    assert.equal(buy.body.code, 'INSUFFICIENT_CREDITS');
    const ops = (await api('GET', '/api/agents', { token: t })).body.find((a: any) => a.key === 'ops');
    assert.equal(ops.owned, false, '未成功扣费则不开通');
  });

  test('V6 free 类无需购买 → 返回 400 AGENT_NOT_PURCHASABLE', async () => {
    const t = await login(uniquePhone());
    const buy = await api('POST', '/api/agents/strat/purchase', { token: t, body: {} });
    assert.equal(buy.status, 400);
    assert.equal(buy.body.code, 'AGENT_NOT_PURCHASABLE');
  });

  test('V7 metered 智能体免解锁可用，按 price 计费', async () => {
    const t = await login(uniquePhone());
    const before = (await api('GET', '/api/me', { token: t })).body.creditBalance as number;
    const ip = (await api('GET', '/api/agents', { token: t })).body.find((a: any) => a.key === 'ip');
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我打造企业 IP', agentKey: 'ip' } });
    assert.equal(gen.status, 200, 'metered 无需解锁即可使用');
    assert.equal(gen.body.kind, 'report');
    assert.equal(gen.body.creditBalance, before - ip.price, '按次计费应扣 price 算力');
  });

  test('V8 后台为用户开通/取消 unlock 智能体', async () => {
    const t = await login(uniquePhone());
    // 用保留科室里的 unlock 智能体 ops（D-8 后 intel 已下架、不在 /agents 默认列表里）。
    // 开通前：未拥有 + 产出被拦截
    assert.equal((await api('POST', '/api/generate-sync', { token: t, body: { text: '经营分析', agentKey: 'ops' } })).status, 403);

    const grant = await api('POST', `/api/admin/users/${t}/agents`, { body: { agentKey: 'ops' } });
    assert.equal(grant.status, 200);
    const detail = await api('GET', `/api/admin/users/${t}`);
    const row = detail.body.agents.find((a: any) => a.key === 'ops');
    assert.equal(row.owned, true);
    assert.equal(row.source, 'admin_grant');
    // 开通后可产出
    assert.equal((await api('POST', '/api/generate-sync', { token: t, body: { text: '经营分析', agentKey: 'ops' } })).status, 200);

    // 取消开通后重新被拦截
    const revoke = await api('DELETE', `/api/admin/users/${t}/agents/ops`);
    assert.equal(revoke.status, 200);
    assert.equal((await api('GET', `/api/agents`, { token: t })).body.find((a: any) => a.key === 'ops').owned, false);
  });

  test('V9 后台新增智能体 → 后台列表可见且默认下架', async () => {
    const create = await api('POST', '/api/admin/agents', { body: { key: 'legaltest', name: '法务顾问', role: '合同 · 合规', billing: 'unlock', price: 9 } });
    assert.equal(create.status, 200);
    const list = (await api('GET', '/api/admin/agents')).body as any[];
    const created = list.find((a) => a.key === 'legaltest');
    assert.ok(created, '后台列表应含新增智能体');
    assert.equal(created.billing, 'unlock');
    assert.equal(created.price, 9);
    assert.equal(created.enabled, false);
    // 清理，避免污染后续按 agent 计数的断言
    await prisma.agent.delete({ where: { key: 'legaltest' } });
  });
});

// ───────────────────────── TC-L 并发冒烟 ─────────────────────────
describe('TC-L 并发冒烟', () => {
  test('L1 同一用户并发多次产出：均成功且会话不串', async () => {
    const t = await login(uniquePhone());
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => api('POST', '/api/generate-sync', { token: t, body: { text: `并发问题 ${i}`, agentKey: 'general' } })),
    );
    assert.ok(results.every((r) => r.status === 200), '全部应成功');
    const ids = new Set(results.map((r) => r.body.sessionId));
    assert.equal(ids.size, 8, '8 次应产生 8 个独立会话，无串号');
  });
});

// ───────────────────────── TC-M 首登建档 → 个性化产出 ─────────────────────────
describe('TC-M 首登建档 → 个性化产出', () => {
  test('M1 建档后 onboarded=true，产出按企业档案个性化', async () => {
    const t = await login(uniquePhone());
    await api('PUT', '/api/profile', { token: t, body: { industry: '精密制造', stage: '规模化', pain: '现金流' } });
    const me = await api('GET', '/api/me', { token: t });
    assert.equal(me.body.onboarded, true, '建档后应标记 onboarded');
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '帮我做一次战略体检', agentKey: 'strat' } });
    assert.ok(r.body.deliverable.meta.includes('精密制造'), '成果元信息应带入企业档案行业');
  });
});

// ───────────────────────── TC-N 老用户回流（持久化） ─────────────────────────
describe('TC-N 老用户回流持久化', () => {
  test('N1 同手机号复登 token 不变，历史数据仍在', async () => {
    const phone = uniquePhone();
    const t1 = await login(phone, '回流公司');
    await api('POST', '/api/projects', { token: t1, body: { name: '长期项目' } });
    const t2 = await login(phone);
    assert.equal(t2, t1, '同手机号复登应是同一账号');
    const projects = await api('GET', '/api/projects', { token: t2 });
    assert.ok(projects.body.some((p: any) => p.name === '长期项目'), '历史项目应仍在');
  });
});

// ───────────────────────── TC-O 跨智能体协同 + 引用闭环 ─────────────────────────
describe('TC-O 一个项目内跨智能体协同 + 引用闭环', () => {
  test('O1 战略报告 → 融资参谋引用它继续产出，沉淀在同一项目', async () => {
    const t = await login(uniquePhone());
    const p = await api('POST', '/api/projects', { token: t, body: { name: 'A 轮冲刺' } });
    const pid = p.body.id;
    // 战略诊断官产出并存为报告
    const gen1 = await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat', projectId: pid } });
    const lib = await api('POST', '/api/library', { token: t, body: { title: '战略诊断报告', type: '战略体检', agentKey: 'strat', sessionId: gen1.body.sessionId, projectId: pid, content: deliverable('战略诊断报告', [{ h: '核心判断', b: '聚焦高价值客群' }]) } });
    // 融资参谋引用该报告继续产出
    const gen2 = await api('POST', '/api/generate-sync', { token: t, body: { text: '据此做融资准备', agentKey: 'fund', projectId: pid, refs: [{ kind: 'report', id: lib.body.reportId, version: 1, label: '战略诊断报告 v1' }] } });
    assert.ok((gen2.body.knowledgeUsed ?? []).length > 0, '引用应被采纳并体现在产出依据中');
    // 项目聚合：≥2 会话、≥1 报告
    const detail = await api('GET', `/api/projects/${pid}`, { token: t });
    assert.ok(detail.body.counts.sessions >= 2 && detail.body.counts.reports >= 1, '项目应聚合多智能体协同的产物');
  });
});

// ───────────────────────── TC-P 成果采纳 → 反馈记忆 ─────────────────────────
describe('TC-P 成果反馈回流', () => {
  test('P1 默认配置不写反馈记忆（sources 未含 deliverable_feedback）', async () => {
    const t = await login(uniquePhone());
    await api('POST', '/api/library', { token: t, body: { title: '默认成果', type: '战略体检', agentKey: 'strat', content: deliverable('默认成果', [{ h: 'A', b: 'x' }]) } });
    const mems = await recallMemories(t, 'strat', 10, '采纳');
    assert.ok(!mems.some((m) => m.includes('采纳了')), '默认配置不应写入反馈记忆');
  });
  test('P2 开启 deliverable_feedback 后，采纳信号沉淀为可召回记忆', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const cfg: MemoryConfig = { longTerm: true, autoLearn: true, intensity: 'balanced', retentionDays: 180, sources: ['deliverable_feedback'] };
    await recordFeedback({ tenantId, userId: t, agentKey: 'strat', cfg, signal: 'adopt', title: '增长方案' });
    const mems = await recallMemories(t, 'strat', 5, '采纳 增长方案');
    assert.ok(mems.some((m) => m.includes('采纳了《增长方案》')), '采纳信号应可召回');
  });
});

// ───────────────────────── TC-Q 记忆留存 TTL ─────────────────────────
describe('TC-Q 记忆留存（TTL 过期不召回）', () => {
  test('Q1 过期记忆被排除，未过期记忆正常召回', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const past = new Date(Date.now() - 86400000);
    const future = new Date(Date.now() + 86400000);
    await prisma.memory.create({ data: { tenantId, userId: t, agentKey: 'strat', kind: 'preference', text: 'EXPIRED-不该出现', source: 'conversation', weight: 1, expiresAt: past } });
    await prisma.memory.create({ data: { tenantId, userId: t, agentKey: 'strat', kind: 'preference', text: 'VALID-应保留', source: 'conversation', weight: 1, expiresAt: future } });
    const mems = await recallMemories(t, 'strat', 10);
    assert.ok(mems.some((m) => m.includes('VALID')), '未过期记忆应召回');
    assert.ok(!mems.some((m) => m.includes('EXPIRED')), '过期记忆不应召回');
  });
});

// ───────────────────────── TC-R 知识按用户检索（项目仅加权，不硬隔离） ─────────────────────────
// 上下文按「用户」隔离：同一用户的知识跨项目可召回，当前会话项目只做加权提升（非过滤墙）。
// 真正的硬隔离在「用户/租户」层面（见 TC-G 跨用户隔离）。
describe('TC-R 知识按用户检索（上下文按用户：项目仅加权）', () => {
  test('R1 同一用户跨项目知识可召回；当前项目话题正常命中', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const pa = (await api('POST', '/api/projects', { token: t, body: { name: '供应链项目' } })).body.id;
    const pb = (await api('POST', '/api/projects', { token: t, body: { name: '出海项目' } })).body.id;
    await api('POST', '/api/knowledge', { token: t, body: { text: '供应链优化：与晨曦集团锁定年度框采', projectId: pa, title: '供应链' } });
    await api('POST', '/api/knowledge', { token: t, body: { text: '海外渠道：东南亚先做新加坡样板', projectId: pb, title: '出海' } });

    // 在项目 A 问 A 的话题 → 召回 A 的知识。
    const { ctx: ctxA } = await buildGenContext({ userId: t, tenantId, agentKey: 'strat', userMessage: '供应链怎么优化', projectId: pa });
    assert.ok((ctxA.knowledge ?? []).join('').includes('供应链'), '项目 A 应召回 A 的知识');

    // 在项目 A 问 B 的话题 → 上下文按用户，仍可召回 B 项目的知识（不再按项目硬隔离）。
    const { ctx: ctxB } = await buildGenContext({ userId: t, tenantId, agentKey: 'strat', userMessage: '海外渠道怎么打 东南亚 新加坡', projectId: pa });
    assert.ok((ctxB.knowledge ?? []).join('').includes('海外渠道'), '上下文按用户：同一用户其它项目的知识应可召回');
  });
});

// ───────────────────────── TC-KB 文档上传管线 ─────────────────────────
describe('TC-KB 文档上传 → 解析 → 切片 → 嵌入 → 可召回', () => {
  test('KB1 上传 md 文档：status 走到 ready，切片入库且可检索', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const content = '本命色营销手册\n\n第一章：品牌定位。我们的本命色是金色，主打高端商务人群。\n\n第二章：渠道策略。优先小红书与抖音种草，月度复盘投放 ROI。';
    const { id, status } = await ingestUploadedFile({
      tenantId, userId: t, fileName: '营销手册.md', mime: 'text/markdown', buf: Buffer.from(content, 'utf8'),
    });
    assert.equal(status, 'parsing', '上传后初始状态应为 parsing');

    // 解析+嵌入异步进行：轮询直到 ready/failed。
    let detail = await getKnowledgeDetail(tenantId, id);
    for (let i = 0; i < 60 && detail?.status !== 'ready' && detail?.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      detail = await getKnowledgeDetail(tenantId, id);
    }
    assert.equal(detail?.status, 'ready', `文档应解析就绪（实际 ${detail?.status} / ${detail?.error ?? ''}）`);
    assert.ok((detail?.chunks.length ?? 0) > 0, '应产生至少 1 个切片');
    assert.equal(detail?.sourceType, 'upload', 'sourceType=upload');
    assert.equal(detail?.fileType, 'md', 'fileType=md');

    const hits = await hybridSearch({ tenantId, userId: t, query: '渠道策略 本命色', topK: 5 });
    assert.ok(hits.some((h) => h.snippet.includes('渠道') || h.snippet.includes('本命色')), '上传文档应可被检索召回');
  });

  test('KB2 不支持的文件类型 → status=failed 且有 error', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const { id } = await ingestUploadedFile({
      tenantId, userId: t, fileName: 'logo.png', mime: 'image/png', buf: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    let detail = await getKnowledgeDetail(tenantId, id);
    for (let i = 0; i < 40 && detail?.status === 'parsing'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      detail = await getKnowledgeDetail(tenantId, id);
    }
    assert.equal(detail?.status, 'failed', '不支持类型应落 failed');
    assert.ok((detail?.error ?? '').length > 0, '应有错误说明');
  });
});

// ───────────────────────── TC-S 每日献策 ─────────────────────────
describe('TC-S 每日献策', () => {
  test('S1 返回当日一条献策', async () => {
    const r = await api('GET', '/api/sayings/today');
    assert.equal(r.status, 200);
    assert.ok(r.body.text && r.body.date, '应返回 文案 + 日期');
  });
});

// ───────────────────────── TC-T 边界 / 健壮性 ─────────────────────────
describe('TC-T 边界与健壮性', () => {
  test('T1 空输入 → 400', async () => {
    const t = await login(uniquePhone());
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '   ', agentKey: 'general' } });
    assert.equal(r.status, 400);
  });
  test('T2 空检索词 → 返回空数组（不报错）', async () => {
    const t = await login(uniquePhone());
    const r = await api('GET', '/api/knowledge/search?q=', { token: t });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, []);
  });
  test('T3 删除会话后不可再访问，且从列表消失', async () => {
    const t = await login(uniquePhone());
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '随便聊聊', agentKey: 'general' } });
    const sid = gen.body.sessionId;
    assert.equal((await api('DELETE', `/api/sessions/${sid}`, { token: t })).status, 200);
    assert.equal((await api('GET', `/api/sessions/${sid}`, { token: t })).status, 404);
    const list = await api('GET', '/api/sessions', { token: t });
    assert.ok(!list.body.some((s: any) => s.id === sid), '已删会话应从列表消失');
  });
});

// ───────────────────────── TC-U 用户主要操作路径回归 ─────────────────────────
describe('TC-U 用户主要操作路径回归', () => {
  test('U1 登录→建档→项目知识→顾问产出→存库→纪要全链路可用', async () => {
    const t = await login(uniquePhone(), '主路径公司');
    const me0 = await api('GET', '/api/me', { token: t });
    const before = me0.body.creditBalance as number;
    assert.ok((await api('GET', '/api/agents')).body.length > 0, '应可拉取智能体');
    assert.ok((await api('GET', '/api/survey')).body.length > 0, '应可拉取建档问卷');

    await api('PUT', '/api/profile', { token: t, body: { industry: '企业服务', stage: 'A 轮前后', pain: '增长乏力' } });
    const project = await api('POST', '/api/projects', { token: t, body: { name: '主路径增长项目', summary: '验证完整用户路径' } });
    await api('POST', '/api/knowledge', {
      token: t,
      body: { projectId: project.body.id, title: '目标客群', text: '目标客户是 50-500 人规模的企业服务公司，重点关注续费率。' },
    });

    const gen = await api('POST', '/api/generate-sync', {
      token: t,
      body: { text: '围绕目标客群做一次战略体检', agentKey: 'strat', projectId: project.body.id },
    });
    assert.equal(gen.status, 200);
    assert.equal(gen.body.kind, 'report');
    assert.equal(gen.body.creditBalance, before, '文本报告走 token 额度，不扣钻石');

    const lib = await api('POST', '/api/library', {
      token: t,
      body: {
        title: '主路径战略体检',
        type: '战略体检',
        agentKey: 'strat',
        sessionId: gen.body.sessionId,
        projectId: project.body.id,
        content: gen.body.deliverable,
      },
    });
    assert.equal(lib.status, 200);
    assert.ok(lib.body.reportId && lib.body.version >= 1, '存库应桥接版本化报告');

    const summary = await api('POST', `/api/sessions/${gen.body.sessionId}/summarize`, { token: t });
    assert.equal(summary.status, 200);
    assert.ok(summary.body.reportId && summary.body.knowledgeAdded >= 1, '纪要应生成报告并沉淀知识');

    const detail = await api('GET', `/api/projects/${project.body.id}`, { token: t });
    assert.ok(detail.body.counts.sessions >= 1, '项目应聚合会话');
    assert.ok(detail.body.counts.reports >= 2, '项目应聚合存库报告和纪要报告');
    assert.ok(detail.body.counts.knowledge >= 2, '项目应聚合手动知识和纪要知识');
    assert.equal((await api('GET', '/api/me', { token: t })).body.creditBalance, before, '/me 钻石余额不变（文本走额度）');
  });
});

// ───────────────────────── TC-W 运营后台鉴权（防越权调用 /admin/*） ─────────────────────────
describe('TC-W 运营后台鉴权', () => {
  test('W1 无任何凭证访问后台接口 → 401', async () => {
    const r = await api('GET', '/api/admin/overview', { adminToken: false });
    assert.equal(r.status, 401);
    assert.equal(r.body.code, 'ADMIN_UNAUTHORIZED');
  });

  test('W2 普通小程序用户（非管理员）访问后台接口 → 403', async () => {
    const t = await login(uniquePhone());
    const r = await api('GET', '/api/admin/overview', { token: t, adminToken: false });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'ADMIN_FORBIDDEN');
  });

  test('W3 错误的 admin 密钥 → 401', async () => {
    const r = await api('GET', '/api/admin/overview', { adminToken: 'wrong-secret' });
    assert.equal(r.status, 401);
  });

  test('W4 正确的 admin 密钥 → 200', async () => {
    const r = await api('GET', '/api/admin/overview'); // helper 自动带正确 ADMIN_TOKEN
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.body.stats), '应返回看板数据');
  });

  test('W4b 审计列表默认过滤后台自身行为，显式 includeAdmin 才返回', async () => {
    await api('GET', '/api/admin/overview');
    const filtered = await api('GET', '/api/admin/audit-logs');
    assert.equal(filtered.status, 200);
    assert.ok((filtered.body as any[]).every((x) => !String(x.action).startsWith('admin.')));

    const all = await api('GET', '/api/admin/audit-logs?includeAdmin=true&limit=200');
    assert.equal(all.status, 200);
    assert.ok((all.body as any[]).some((x) => String(x.action).startsWith('admin.')));
  });

  test('W5 role=admin 账号（仅 x-user-id、无密钥）→ 200', async () => {
    const t = await login(uniquePhone());
    await prisma.user.update({ where: { id: t }, data: { role: 'admin' } });
    const r = await api('GET', '/api/admin/overview', { token: t, adminToken: false });
    assert.equal(r.status, 200);
  });

  test('W6 ★ 普通用户无法越权自助开通付费智能体（403 且确实未开通）', async () => {
    const t = await login(uniquePhone());
    // 尝试用自己的登录态调用后台开通接口给自己开通 unlock 智能体
    const grant = await api('POST', `/api/admin/users/${t}/agents`, { token: t, adminToken: false, body: { agentKey: 'intel' } });
    assert.ok(grant.status === 403 || grant.status === 401, '越权开通应被拒');
    // 校验确实未开通：产出仍被 AGENT_LOCKED 拦截
    const gen = await api('POST', '/api/generate-sync', { token: t, body: { text: '竞品分析', agentKey: 'intel' } });
    assert.equal(gen.status, 403);
    assert.equal(gen.body.code, 'AGENT_LOCKED');
  });
});

// ───────────────────────── TC-X 身份与账号注销 ─────────────────────────
describe('TC-X 身份与账号注销', () => {
  test('X1 注册不生成随机名；PUT /me 设置称呼+公司后 /me 同步', async () => {
    const t = await login(uniquePhone());
    const before = await api('GET', '/api/me', { token: t });
    assert.equal(before.body.user.name, '', '新账号不应有编造的随机名');
    assert.equal(before.body.understanding.title, '个人档案', '/me 应返回用户可读的经营理解');

    const tenantId = await tenantOf(t);
    await prisma.user.update({ where: { id: t }, data: { name: '用户1018' } });
    await prisma.tenant.update({ where: { id: tenantId }, data: { name: '企业1018' } });
    const placeholder = await api('GET', '/api/me', { token: t });
    const identity = placeholder.body.understanding.sections.find((s: any) => s.key === 'identity');
    assert.deepEqual(identity.items, [], '历史占位名不应展示为真实经营身份');
    assert.ok(placeholder.body.understanding.nextQuestions.includes('以后军师怎么称呼你？'), '占位称呼应继续触发追问');
    assert.ok(placeholder.body.understanding.nextQuestions.includes('你的公司、门店或品牌叫什么？'), '占位公司应继续触发追问');

    const alias = await api('GET', '/api/auth/suggest-name');
    assert.equal(alias.status, 200);
    assert.ok(alias.body.name && alias.body.source, '应返回一个可填入注册框的花名');
    const aliasToken = await login(uniquePhone(), alias.body.name);
    const aliasMe = await api('GET', '/api/me', { token: aliasToken });
    assert.equal(aliasMe.body.user.name, alias.body.name, '花名只作为用户称呼');
    assert.equal(aliasMe.body.tenant.name, '', '花名不应被写成公司名');

    const upd = await api('PUT', '/api/me', { token: t, body: { name: '王越', company: '云栖科技' } });
    assert.equal(upd.status, 200);
    const me = await api('GET', '/api/me', { token: t });
    assert.equal(me.body.user.name, '王越');
    assert.equal(me.body.tenant.name, '云栖科技', '公司应写入租户名');
  });

  test('X2 报告抬头带入真实公司而非硬编码', async () => {
    const t = await login(uniquePhone());
    await api('PUT', '/api/me', { token: t, body: { name: '李雷', company: '星澜科技' } });
    const r = await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat' } });
    assert.equal(r.body.kind, 'report');
    assert.ok(r.body.deliverable.meta.includes('星澜科技'), '成果抬头应带入真实公司名');
    assert.ok(!r.body.deliverable.meta.includes('云栖科技'), '不应出现硬编码的占位公司');
  });

  test('X3 个人档案访谈模式不自动召回旧项目/知识', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const p = await api('POST', '/api/projects', { token: t, body: { name: '2026 融资冲刺', summary: '旧项目摘要：A 轮估值逻辑' } });
    const k = await api('POST', '/api/knowledge', {
      token: t,
      body: { text: '旧融资报告：高价值客群在制造/医疗，NRR 100-110%', projectId: p.body.id, kind: 'insight', title: '旧融资报告' },
    });
    await prisma.memory.create({
      data: {
        tenantId, userId: t, agentKey: 'general', kind: 'insight',
        text: '旧记忆：融资冲刺里提过三层定价',
        source: 'conversation', weight: 1,
      },
    });

    const { ctx, knowledgeUsed } = await buildGenContext({
      userId: t,
      tenantId,
      agentKey: 'general',
      projectId: p.body.id,
      refs: [{ kind: 'knowledge', id: k.body.id, label: '旧融资报告' }],
      userMessage: '请进入个人档案访谈模式，先问我几个简单问题',
    });
    assert.deepEqual(ctx.memories, [], '访谈模式不应召回长期记忆');
    assert.deepEqual(ctx.references, [], '访谈模式不应注入显式旧引用');
    assert.deepEqual(ctx.knowledge, [], '访谈模式不应自动召回知识库');
    assert.equal(ctx.projectSummary, null, '访谈模式不应带旧项目摘要展开分析');
    assert.deepEqual(knowledgeUsed, [], '访谈模式不应声明使用旧资料');
  });

  test('X4 注销账号 → 删除数据，原 token 失效', async () => {
    const t = await login(uniquePhone());
    await api('POST', '/api/generate-sync', { token: t, body: { text: '战略体检', agentKey: 'strat' } });
    const del = await api('DELETE', '/api/me', { token: t });
    assert.equal(del.status, 200);
    const after = await api('GET', '/api/me', { token: t });
    assert.equal(after.status, 401, '注销后原登录态应失效');
    assert.equal(await prisma.user.count({ where: { id: t } }), 0, '用户记录应被删除');
  });
});

// ───────────────────────── TC-Y Token 用量计量（计费 P1·旁路统计） ─────────────────────────
describe('TC-Y Token 用量计量', () => {
  test('Y1 recordTokenUsage 按已配单价算成本；未配价→0；零 token 跳过', async () => {
    const t = await login(uniquePhone(), 'Token甲');
    const tenantId = await tenantOf(t);
    // 运营给 gpt-4o 配单价 in 18 / out 72（元/1M）；addModel 会清空费率缓存
    const priced = await addModel({ provider: 'openai', label: 'GPT4o(测试价)', model: 'gpt-4o', priceInput: 18, priceOutput: 72 });
    await recordTokenUsage({ tenantId, userId: t, sessionId: null, agentKey: 'strat', kind: 'deliverable', provider: 'openai', model: 'gpt-4o', usage: { inputTokens: 1000, outputTokens: 500, cachedInput: 0 } });
    await recordTokenUsage({ tenantId, userId: t, kind: 'chat', provider: 'openai', model: 'unpriced-model', usage: { inputTokens: 1000, outputTokens: 1000, cachedInput: 0 } });
    await recordTokenUsage({ tenantId, userId: t, kind: 'chat', provider: 'mock', model: 'template', usage: { inputTokens: 0, outputTokens: 0, cachedInput: 0 } });
    const rows = await prisma.tokenUsage.findMany({ where: { userId: t } });
    assert.equal(rows.length, 2, '零 token 的 mock 调用不应落库');
    const g = rows.find((r) => r.model === 'gpt-4o')!;
    assert.equal(g.totalTokens, 1500);
    assert.equal(g.costMicros, 54000); // 1000*18 + 500*72（微元）= 已配单价
    assert.equal(rows.find((r) => r.model === 'unpriced-model')!.costMicros, 0, '未配单价 → 成本计 0，不回退估算');
    await prisma.aiModel.delete({ where: { id: priced.id } });
  });

  test('Y2 tokenUsageSummary 与 /admin/token-usage 同口径；已配价标 calibrated', async () => {
    const t = await login(uniquePhone(), 'Token乙');
    const tenantId = await tenantOf(t);
    const priced = await addModel({ provider: 'openai', label: 'GPT4o(测试价)', model: 'gpt-4o', priceInput: 18, priceOutput: 72 });
    await recordTokenUsage({ tenantId, userId: t, kind: 'deliverable', provider: 'openai', model: 'gpt-4o', usage: { inputTokens: 2000, outputTokens: 1000, cachedInput: 0 } });
    const sum = await tokenUsageSummary(30);
    assert.ok(sum.totals.totalTokens >= 3000, '总 token 应累计');
    assert.ok(sum.byModel.find((m) => m.model === 'gpt-4o')?.calibrated, 'gpt-4o 已配单价 → calibrated=true');
    const view = await api('GET', '/api/admin/token-usage'); // helper 自动带 ADMIN_TOKEN
    assert.equal(view.status, 200);
    assert.equal(view.body.totals.totalTokens, sum.totals.totalTokens);
    await prisma.aiModel.delete({ where: { id: priced.id } });
  });

  test('Y3 注销账号连带清除其 token 用量（外键安全）', async () => {
    const t = await login(uniquePhone(), 'Token丙');
    const tenantId = await tenantOf(t);
    await recordTokenUsage({ tenantId, userId: t, kind: 'chat', provider: 'openai', model: 'gpt-4o', usage: { inputTokens: 100, outputTokens: 50, cachedInput: 0 } });
    assert.equal(await prisma.tokenUsage.count({ where: { userId: t } }), 1);
    const del = await api('DELETE', '/api/me', { token: t });
    assert.equal(del.status, 200);
    assert.equal(await prisma.tokenUsage.count({ where: { tenantId } }), 0, '注销后该租户 token 流水应清空');
  });

  test('Y4 嵌入/重排计入「检索基建」用量，与用户产出 totals/byModel 区分', async () => {
    await recordTokenUsage({ kind: 'embedding', provider: 'openai', model: 'BAAI/bge-m3', usage: { inputTokens: 1234, outputTokens: 0, cachedInput: 0 } });
    await recordTokenUsage({ kind: 'rerank', provider: 'openai', model: 'BAAI/bge-reranker-v2-m3', usage: { inputTokens: 321, outputTokens: 0, cachedInput: 0 } });
    const sum = await tokenUsageSummary(30);
    const emb = sum.infra.find((x) => x.kind === 'embedding' && x.model === 'BAAI/bge-m3');
    assert.ok(emb && emb.totalTokens >= 1234, 'embedding 应进 infra');
    assert.ok(sum.infra.some((x) => x.kind === 'rerank'), 'rerank 应进 infra');
    assert.ok(!sum.byModel.some((m) => m.model === 'BAAI/bge-m3' || m.model === 'BAAI/bge-reranker-v2-m3'), '嵌入/重排不应进用户产出 byModel');
  });
});

// ───────────────────────── TC-M 记忆召回与去重（E1/E2） ─────────────────────────
describe('TC-M 记忆召回与去重', () => {
  test('M1 recencyDecay 半衰期 30 天', () => {
    assert.equal(recencyDecay(0), 1);
    assert.ok(Math.abs(recencyDecay(30) - 0.5) < 1e-9);
    assert.ok(Math.abs(recencyDecay(60) - 0.25) < 1e-9);
  });
  test('M2 mmrSelect 相关性相近时优先多样性（跳过近重）', () => {
    const A = { text: 'A', emb: [1, 0, 0], score: 0.90 };
    const B = { text: 'B', emb: [1, 0, 0], score: 0.88 }; // 与 A 同向（近重）
    const C = { text: 'C', emb: [0, 1, 0], score: 0.85 }; // 正交（多样）
    assert.deepEqual(mmrSelect([A, B, C], 2, 0.7), ['A', 'C'], 'MMR 取 A 后应跳过近重 B、选多样 C');
  });
  test('M3 E1 去重-on-write：相同洞察去重为一行并加权刷新', async () => {
    const t = await login(uniquePhone(), '记忆甲');
    const tenantId = await tenantOf(t);
    const cfg = { longTerm: true, autoLearn: true, intensity: 'balanced' as const, retentionDays: 180, sources: ['conversation' as const, 'document' as const] };
    const txt = '我们最大的难题是获客成本太高，转化率只有百分之二';
    await learnFromConversation({ tenantId, userId: t, agentKey: 'strat', cfg, userText: txt });
    await learnFromConversation({ tenantId, userId: t, agentKey: 'strat', cfg, userText: txt });
    const rows = await prisma.memory.findMany({ where: { userId: t, agentKey: 'strat' } });
    assert.equal(rows.length, 1, '相同洞察两次写入应去重为 1 行（旧实现会堆 2 行）');
    assert.ok(rows[0].weight > 1.0, '重复出现应加权（>初始 1.0）');
  });

  test('M4 P1-C2 用户可编辑/删除自己的记忆，且跨用户隔离', async () => {
    const a = await login(uniquePhone(), '记忆用户A');
    const ta = await tenantOf(a);
    const b = await login(uniquePhone(), '记忆用户B');
    const mem = await prisma.memory.create({ data: { tenantId: ta, userId: a, agentKey: 'strat', kind: 'preference', text: '错误事实：A 在做餐饮', embedding: [], weight: 1, source: 'conversation' } });
    const wrong = await api('PATCH', `/api/memories/${mem.id}`, { token: b, body: { text: '篡改' } });
    assert.equal(wrong.status, 404, '跨用户编辑应 404');
    const edit = await api('PATCH', `/api/memories/${mem.id}`, { token: a, body: { text: '更正：A 在做 SaaS' } });
    assert.equal(edit.status, 200);
    assert.equal((await prisma.memory.findUnique({ where: { id: mem.id } }))?.text, '更正：A 在做 SaaS');
    await api('DELETE', `/api/memories/${mem.id}`, { token: b });
    assert.ok(await prisma.memory.findUnique({ where: { id: mem.id } }), '跨用户删除不应生效');
    await api('DELETE', `/api/memories/${mem.id}`, { token: a });
    assert.equal(await prisma.memory.findUnique({ where: { id: mem.id } }), null);
  });

  test('M5 P1-C4 运营按 agent 跨用户浏览并删除记忆', async () => {
    const u1 = await login(uniquePhone(), '治理甲'); const t1 = await tenantOf(u1);
    const u2 = await login(uniquePhone(), '治理乙'); const t2 = await tenantOf(u2);
    await prisma.memory.create({ data: { tenantId: t1, userId: u1, agentKey: 'growth', kind: 'preference', text: 'A 关注获客', embedding: [], weight: 1, source: 'conversation' } });
    const m2 = await prisma.memory.create({ data: { tenantId: t2, userId: u2, agentKey: 'growth', kind: 'preference', text: 'B 关注复购', embedding: [], weight: 1, source: 'conversation' } });
    const list = await api<{ items: { id: string; userId: string }[] }>('GET', '/api/admin/agents/growth/memories');
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((x) => x.userId === u1) && list.body.items.some((x) => x.userId === u2), '应跨用户列出该 agent 记忆');
    const del = await api('DELETE', `/api/admin/agents/growth/memories/${m2.id}`);
    assert.equal(del.status, 200);
    assert.equal(await prisma.memory.findUnique({ where: { id: m2.id } }), null);
  });
});

// ───────────────────────── TC-H 对话历史注入（P0-3） ─────────────────────────
describe('TC-H 对话历史注入', () => {
  test('H1 loadHistory 取会话先前轮次（时序、排除当前、角色交替）', async () => {
    const t = await login(uniquePhone(), '历史甲');
    const r1 = await api<{ sessionId: string }>('POST', '/api/generate-sync', { token: t, body: { text: '我们做的是 SaaS 工具', agentKey: 'general' } });
    assert.equal(r1.status, 200);
    const sid = r1.body.sessionId;
    const r2 = await api('POST', '/api/generate-sync', { token: t, body: { text: '那定价该怎么定', sessionId: sid, agentKey: 'general' } });
    assert.equal(r2.status, 200);
    // 两轮后会话含 user1/assistant1/user2/assistant2；排除一个不存在 id → 取到全部前序轮次
    const hist = await loadHistory(sid, '__none__');
    assert.ok(hist.length >= 4, `应载入≥4 轮历史，实得 ${hist.length}`);
    assert.equal(hist[0].role, 'user');
    assert.ok(hist[0].text.includes('SaaS'), '首轮应为用户原话');
    for (let i = 1; i < hist.length; i++) assert.notEqual(hist[i].role, hist[i - 1].role, '相邻轮次角色应交替（已合并连续同角色）');
  });
});

// ───────────────────────── TC-Z 月度 Token 额度（双轴计费 P2） ─────────────────────────
describe('TC-Z 月度 Token 额度', () => {
  test('Z1 setQuota/charge/ensure：ceil(token×ratio) 扣减、透支后拦截', async () => {
    const t = await login(uniquePhone(), '额度甲');
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, 1000);
    let st = await getQuotaState(t);
    assert.equal(st.quota, 1000);
    assert.equal(st.used, 0);
    assert.equal(st.unlimited, false);
    st = await chargeQuota(t, 300, 1.5); // ceil(300×1.5)=450
    assert.equal(st.used, 450);
    assert.equal(st.balance, 550);
    await ensureQuota(t); // 余额>0 放行（不抛）
    await chargeQuota(t, 1000, 1); // 透支到负
    await assert.rejects(() => ensureQuota(t), (e: unknown) => (e as { code?: string }).code === 'INSUFFICIENT_QUOTA');
  });

  test('Z2 不限量(quota=-1) 放行且不扣', async () => {
    const t = await login(uniquePhone(), '额度乙');
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, -1);
    await ensureQuota(t);
    const st = await chargeQuota(t, 99999, 5);
    assert.equal(st.unlimited, true);
  });

  test('Z4 P0-2：并发预留在锁内串行，透支有界（不再无界放行）', async () => {
    const t = await login(uniquePhone(), '额度丁');
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, 5000); // RESERVE_TOKENS=2000/次 → 5000 额度恰好放行 3 个并发后转负拦截
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => reserveQuota(t, 1)));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const rejected = results.filter((r) => r.status === 'rejected').length;
    assert.equal(ok, 3, '每次预留 2000 → 恰好放行 3 个（旧实现 ensureQuota 只判 balance>0 会放行全部 20 个）');
    assert.equal(rejected, 17);
    const st = await getQuotaState(t);
    assert.equal(st.balance, -1000, '透支有界：5000 − 3×2000 = −1000（约一份预留），而非任意负');
  });

  test('Z3 /me 含 tokenQuota；/me/credits 返回钻石流水', async () => {
    const t = await login(uniquePhone(), '额度丙');
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, 500);
    const me = await api('GET', '/api/me', { token: t });
    assert.equal(me.status, 200);
    assert.equal(me.body.tokenQuota.limit, 500);
    assert.ok('creditBalance' in me.body, '应保留钻石轴');
    const cr = await api('GET', '/api/me/credits', { token: t });
    assert.equal(cr.status, 200);
    assert.ok(Array.isArray(cr.body.items));
  });

  test('Z4 注销连带清除 token_wallet（外键安全）', async () => {
    const t = await login(uniquePhone(), '额度丁');
    const tenantId = await tenantOf(t);
    await setQuota(tenantId, t, 1000);
    assert.equal(await prisma.tokenWallet.count({ where: { userId: t } }), 1);
    const del = await api('DELETE', '/api/me', { token: t });
    assert.equal(del.status, 200);
    assert.equal(await prisma.tokenWallet.count({ where: { tenantId } }), 0, '注销后租户额度账户应清空');
  });
});

describe('TC-S P1-B3 聊天流式（渐进渲染 · 输入审核）', () => {
  test('chatCompleteStream 真增量分块 + 拼接还原 + done 收尾', async () => {
    const t = await login(uniquePhone());
    const tenantId = await tenantOf(t);
    const { ctx } = await buildGenContext({ userId: t, tenantId, agentKey: 'strat', userMessage: '帮我系统看看增长策略，多讲一些可执行的细节' });
    let joined = '';
    let doneText: string | null = null;
    let deltaCount = 0;
    for await (const e of chatCompleteStream(ctx)) {
      if (e.type === 'delta') { joined += e.text; deltaCount++; }
      else doneText = e.result.text;
    }
    assert.ok(doneText !== null, '应有 done 收尾事件');
    assert.equal(joined, doneText, '分块拼接应无损还原完整文本');
    assert.ok(deltaCount >= 1, '至少一块');
    if ((doneText as string).length > 12) assert.ok(deltaCount > 1, '长文本应拆成多块（真渐进，非一次性）');
  });

  test('/generate SSE 聊天分支真流式：发出 token 增量事件 + chat 兜底 + done（去假 sleep）', async () => {
    const t = await login(uniquePhone());
    // P0-3 后总军师走 on-demand（不逐 token 流式）；纯聊天流式分支用无产出体智能体覆盖
    await prisma.agent.upsert({ where: { key: 'chatonly' }, update: { enabled: true }, create: {
      key: 'chatonly', name: '纯聊天体', role: '测试', icon: 'spark', type: 'general', gift: true, billing: 'free', price: 0,
      greet: '你好', chipsJson: [], memText: '', learnText: '', systemPrompt: '你是测试用纯聊天体。', deliverableKey: null,
      memoryConfig: { longTerm: false, autoLearn: false, intensity: 'balanced', retentionDays: 30, sources: [] }, sort: 99,
    } });
    try {
      const beforeInputLogs = await prisma.moderationLog.count({ where: { userId: t, refType: 'input' } });
      const res = await api('POST', '/api/generate', { token: t, body: { text: '你好，聊聊增长这件事，多说点', agentKey: 'chatonly' } });
      assert.equal(res.status, 200);
      const body = String(res.body);
      assert.match(body, /event: token/, '应有增量 token 事件（流式）');
      assert.match(body, /event: chat/, '应有完整 chat 兜底事件（兼容非流式客户端）');
      assert.match(body, /event: done/, '应有 done 收尾');
      const afterInputLogs = await prisma.moderationLog.count({ where: { userId: t, refType: 'input' } });
      assert.equal(afterInputLogs - beforeInputLogs, 1, 'mock/回退分块路径也只能做一次输入审核');
      // 总军师 on-demand：普通问答走纯 chat token 流；明确要报告/方案时才进入结构化成果路径
      const g = await api('POST', '/api/generate', { token: t, body: { text: '随便聊聊', agentKey: 'general' } });
      assert.equal(g.status, 200);
      const gb = String(g.body);
      assert.match(gb, /event: token/, '普通问答应走 token 流式');
      assert.match(gb, /event: chat/, '普通问答应有完整 chat 兜底事件');
      assert.match(gb, /event: done/, '应有 done 收尾');
    } finally {
      await prisma.agent.update({ where: { key: 'chatonly' }, data: { enabled: false } });
    }
  });

  test('P2-10 dryRunTool：内置工具可试跑 + 未知工具报错', async () => {
    const ok = await dryRunTool('strat', 'search_knowledge', { query: '测试检索' });
    assert.equal(ok.ok, true, '内置工具应可试跑');
    assert.equal(typeof ok.output, 'string', '应返回字符串输出');
    assert.ok(ok.ms >= 0);
    const bad = await dryRunTool('strat', 'no_such_tool_xyz', {});
    assert.equal(bad.ok, false, '未知/未启用工具应报错');
    assert.match(bad.error ?? '', /不存在|未启用/);
  });

  test('P2-10 aggregateToolStats 按工具聚合成功率/错误率/延迟', async () => {
    await prisma.toolCallLog.deleteMany({ where: { tool: 't_stat_x' } });
    await prisma.toolCallLog.createMany({ data: [
      { tool: 't_stat_x', ok: true, ms: 10 },
      { tool: 't_stat_x', ok: true, ms: 30 },
      { tool: 't_stat_x', ok: false, ms: 20 },
    ] });
    const s = (await aggregateToolStats({ days: 1 })).find((x) => x.tool === 't_stat_x');
    assert.ok(s, '应聚合出该工具');
    assert.equal(s!.calls, 3);
    assert.equal(s!.errors, 1);
    assert.equal(s!.errorRate, 33.3);
    assert.equal(s!.avgMs, 20);
  });
});
