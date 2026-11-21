import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const source = require.resolve('../weapp-native/services/studio-draft.js');
const OPEN_ID = 'open-id-for-studio-test-01';
const TRANSACTION_ID = 'transaction-id-studio-test';
const ORIGIN = 'https://aiavatar.aibuzz.cn';
const WEBVIEW = 'packages/work/studio-webview/index';

function fixture(t) {
  let session = 'first-session';
  let logins = 0;
  let nextUrl = `${ORIGIN}/junshi/open?openId=${OPEN_ID}`;
  let intent = { action: 'chat' };
  let pages = [];
  const calls = [];
  const routes = [];
  const rawLoader = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (parent?.filename === source && request === './token') return { getToken: () => session };
    if (parent?.filename === source && request === './request') {
      return { request: async (path, options) => {
        calls.push({ path, ...options });
        if (path === '/studio/intent') return intent;
        if (path === '/studio/resume-draft') return { generationId: 'resumed-generation' };
        return { url: nextUrl, openId: OPEN_ID, expiresAt: new Date(Date.now() + 60_000).toISOString() };
      } };
    }
    return rawLoader.call(this, request, parent, isMain);
  };
  delete require.cache[source];
  let studio;
  try { studio = require(source); } finally { Module._load = rawLoader; }
  const priorWx = globalThis.wx;
  const priorPages = globalThis.getCurrentPages;
  globalThis.wx = {
    login(options) { options.success({ code: ++logins === 1 ? 'one-time-wechat-proof' : 'fresh-wechat-proof' }); },
    navigateTo(options) { routes.push(options.url); options.success(); },
  };
  globalThis.getCurrentPages = () => pages;
  t.after(() => {
    if (priorWx) globalThis.wx = priorWx; else delete globalThis.wx;
    if (priorPages) globalThis.getCurrentPages = priorPages; else delete globalThis.getCurrentPages;
    delete require.cache[source];
  });
  return {
    studio, calls, routes, setSession: (value) => { session = value; },
    setUrl: (value) => { nextUrl = value; }, setPages: (value) => { pages = value; },
    setIntent: (value) => { intent = value; },
  };
}

test('声量AI原生窗口只认可当前草稿卡开启的容器和同一登录态', async (t) => {
  const { studio, calls, routes, setPages, setSession } = fixture(t);
  const webview = { route: WEBVIEW };
  const confirmation = {};
  assert.equal(studio.attachStudioContainer(webview), null);
  await studio.openStudioDraft('dialogue-1', 'message-1');
  assert.deepEqual(routes, [`/${WEBVIEW}`]);
  assert.equal(calls[0].data.studioLoginCode, 'one-time-wechat-proof');
  assert.ok(studio.attachStudioContainer(webview));
  setPages([{ route: WEBVIEW }, confirmation]);
  await assert.rejects(studio.approveStudioContainer(confirmation, OPEN_ID, TRANSACTION_ID), /从军师对话/);
  assert.equal(calls.length, 1);
  setPages([webview, confirmation]);
  await studio.approveStudioContainer(confirmation, OPEN_ID, TRANSACTION_ID);
  assert.deepEqual(calls[1].data, { openId: OPEN_ID, transactionId: TRANSACTION_ID });
  setSession('second-session');
  await assert.rejects(studio.approveStudioContainer(confirmation, OPEN_ID, TRANSACTION_ID), /从军师对话/);
  studio.releaseStudioContainer(webview);
  assert.equal(calls[2].path, '/studio/cancel');
  assert.equal(calls[2].token, 'first-session');
  assert.equal(calls[2].isolatedAuth, true);
});

test('外站或携带附加跳转参数的地址均不进入 WebView', async (t) => {
  const { studio, routes, setUrl } = fixture(t);
  setUrl(`https://example.invalid/junshi/open?openId=${OPEN_ID}`);
  await assert.rejects(studio.openStudioDraft('dialogue-1', 'message-1'), /失效/);
  setUrl(`${ORIGIN}/junshi/open?openId=${OPEN_ID}&next=https://example.invalid`);
  await assert.rejects(studio.openStudioDraft('dialogue-1', 'message-1'), /失效/);
  assert.deepEqual(routes, []);
});

test('历史用户取消授权时保留原指令，完成核验后用新凭证续接', async (t) => {
  const { studio, calls } = fixture(t);
  assert.equal(await studio.verifyAndResumeStudioDraft('dialogue-1', 'message-1', ''), null);
  assert.equal(calls.length, 0);
  assert.deepEqual(await studio.verifyAndResumeStudioDraft('dialogue-1', 'message-1', 'native-phone-code'),
    { generationId: 'resumed-generation' });
  assert.deepEqual(calls.map(({ path, data }) => [path, data]), [
    ['/studio/verify-phone', { sessionId: 'dialogue-1', messageId: 'message-1', phoneCode: 'native-phone-code', studioLoginCode: 'one-time-wechat-proof' }],
    ['/studio/resume-draft', { sessionId: 'dialogue-1', messageId: 'message-1', studioLoginCode: 'fresh-wechat-proof' }],
  ]);
});

test('根据服务端的多轮召回结果补签凭证，不在端上判断制作关键词', async (t) => {
  const { studio, calls, setIntent, setSession } = fixture(t);
  const body = { text: '是的', sessionId: 's', agentKey: 'general', clientRequestId: 'request-1', refs: [] };
  assert.equal(await studio.studioIntentForMessage(body, 'first-session', () => true), null);
  setIntent({ action: 'clarify', studioIntentTicket: 'clarify-ticket' });
  assert.deepEqual(await studio.studioIntentForMessage(body, 'first-session', () => true), {
    action: 'clarify', credentials: { studioIntentTicket: 'clarify-ticket' },
  });
  setIntent({ action: 'draft', studioIntentTicket: 'draft-ticket' });
  assert.deepEqual(await studio.studioIntentForMessage(body, 'first-session', () => true), {
    action: 'draft', credentials: { studioIntentTicket: 'draft-ticket', studioLoginCode: 'one-time-wechat-proof' },
  });
  assert.deepEqual(calls[2], { path: '/studio/intent', method: 'POST', token: 'first-session', data: body });
  setSession('other-session');
  assert.equal(await studio.studioIntentForMessage(body, 'first-session', () => true), null);
});
