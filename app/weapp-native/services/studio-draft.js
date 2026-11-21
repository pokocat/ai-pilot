const { request } = require('./request');
const { getToken } = require('./token');

const WEBVIEW = '/packages/work/studio-webview/index';
const OPEN = /^https:\/\/aiavatar\.aibuzz\.cn\/junshi\/open\?openId=([A-Za-z0-9_-]{22,128})$/;
const ID = /^[A-Za-z0-9_-]{22,128}$/;
let pending = null;
let opening = false;

function studioLoginCode() {
  return new Promise((resolve) => wx.login({
    timeout: 6000,
    success: (result) => resolve(result.code || ''),
    fail: () => resolve(''),
  }));
}

// 端上只粗筛以按需获取微信凭证。实际制作意图和上传范围全部由后端裁决。
function mayPrepareStudioDraft(text) {
  return /图生视频|转成|变成|生成|制作|创建|建|做|保存|导入|送到|发到|出片|出图|生图|画|出一条|出一张|出一段|来一张|用.{1,6}版/.test(text)
    && /视频|短片|短剧|成片|出片|图片|图像|海报|生图|出图|主视觉|商品图|图|版|一张/.test(text)
    && !/快出片|爱速拍|只写|只看|先写|先看|暂不|(?:能不能|怎么|如何)|[?？]$/.test(text.trim());
}

function valid(intent) {
  return intent && intent.token === getToken() && intent.expiresAt > Date.now();
}

function cancel(intent) {
  if (!intent || intent.expiresAt <= Date.now()) return Promise.resolve();
  return request('/studio/cancel', { method: 'POST', data: { openId: intent.openId }, token: intent.token, isolatedAuth: true })
    .catch(() => { /* 中心会自动清除过期事务。 */ });
}

async function openStudioDraft(sessionId, messageId) {
  if (opening || valid(pending)) return;
  const token = getToken();
  if (!token || !sessionId || !messageId) return;
  opening = true;
  let intent = null;
  try {
    const loginCode = await studioLoginCode();
    if (getToken() !== token) return;
    const result = await request('/studio/open', {
      method: 'POST', token, data: { sessionId, messageId, studioLoginCode: loginCode },
    });
    const match = OPEN.exec(result.url);
    const expiresAt = Date.parse(result.expiresAt);
    if (match?.[1] !== result.openId || !(expiresAt > Date.now())) throw new Error('这次打开已失效，请重新打开草稿');
    intent = { openId: result.openId, expiresAt, token, url: result.url, approved: false };
    if (getToken() !== token) { void cancel(intent); return; }
    pending = intent;
    await new Promise((resolve, reject) => wx.navigateTo({ url: WEBVIEW, success: resolve, fail: reject }));
  } catch (error) {
    if (pending === intent) pending = null;
    if (intent) void cancel(intent);
    throw error;
  } finally {
    opening = false;
  }
}

async function verifyAndResumeStudioDraft(sessionId, messageId, phoneCode) {
  const token = getToken();
  if (!token || !sessionId || !messageId || !phoneCode) return null;
  const loginCode = await studioLoginCode();
  if (token !== getToken()) return null;
  await request('/studio/verify-phone', {
    method: 'POST', token, data: { sessionId, messageId, phoneCode, studioLoginCode: loginCode },
  });
  const freshLoginCode = await studioLoginCode();
  if (token !== getToken()) return null;
  return request('/studio/resume-draft', {
    method: 'POST', token, data: { sessionId, messageId, studioLoginCode: freshLoginCode },
  });
}

function attachStudioContainer(page) {
  if (!valid(pending) || pending.page) return null;
  pending.page = page;
  return pending;
}

function releaseStudioContainer(page) {
  if (pending?.page !== page) return;
  const intent = pending;
  pending = null;
  void cancel(intent);
}

function previousStudioContainer(openId) {
  const pages = getCurrentPages();
  const previous = pages[pages.length - 2];
  if (!valid(pending) || pending.page !== previous || previous?.route !== WEBVIEW.slice(1) || pending.openId !== openId) return null;
  return pending;
}

async function approveStudioContainer(page, openId, transactionId) {
  const intent = previousStudioContainer(openId);
  if (!intent || !ID.test(transactionId) || intent.approved) throw new Error('请从军师对话重新打开草稿');
  intent.confirmPage = page;
  await request('/studio/approve', { method: 'POST', token: intent.token, data: { openId, transactionId } });
  if (!valid(intent) || pending !== intent) throw new Error('请从军师对话重新打开草稿');
  intent.approved = true;
}

function cancelStudioConfirmation(page) {
  if (pending?.confirmPage === page && !pending.approved) void cancel(pending);
}

module.exports = {
  studioLoginCode, mayPrepareStudioDraft, openStudioDraft, verifyAndResumeStudioDraft, attachStudioContainer, releaseStudioContainer,
  approveStudioContainer, cancelStudioConfirmation,
};
