import test from 'node:test';
import assert from 'node:assert/strict';
import {
  storedReplyFor,
  classifyReconcileTick,
  reportCloseAction,
  streamClosedWithoutVerdict,
} from './liveGenCore';
import type { SessionMessage } from '../../../shared/contracts';

const msg = (id: string, role: string, text?: string): SessionMessage =>
  ({ id, role, content: role === 'report' ? { title: '测试报告' } : { text: text ?? '' }, at: '2026-07-28T00:00:00Z' });

// ———— 场景一：断流后接管（服务端仍在生成）————

test('断流后接管：服务端仍在生成且页面在场 → handoff，报告卡绝不收成已生成', () => {
  const tick = classifyReconcileTick({
    messages: [msg('u1', 'user', '出一份增长方案')],
    generating: true,
    userText: '出一份增长方案',
    hasView: true,
  });
  assert.equal(tick.verdict, 'handoff');
  // 假完成病灶回归：handoff 后旧 P0-5 会 finishReport(undefined)，新裁决必须是 none（卡片交轮询接管）
  assert.equal(
    reportCloseAction({ kind: 'report', reconciled: 'handoff', messageId: undefined, streamErrored: false }),
    'none',
  );
});

test('断流后接管：页面不在场（无人可交）→ pending 继续等落库，不 handoff', () => {
  const tick = classifyReconcileTick({
    messages: [msg('u1', 'user', '出一份增长方案')],
    generating: true,
    userText: '出一份增长方案',
    hasView: false,
  });
  assert.equal(tick.verdict, 'pending');
});

// ———— 场景二：最终成功（落库为准）————

test('最终成功：本轮回复已落库 → stored，收尾交服务端真值重绘', () => {
  const stored = msg('r1', 'report');
  const tick = classifyReconcileTick({
    messages: [msg('u1', 'user', '出一份增长方案'), stored],
    generating: false,
    userText: '出一份增长方案',
    hasView: true,
  });
  assert.deepEqual(tick, { verdict: 'stored', stored });
  // stored 已由 restoreServerTruth 整体重绘，双保险不再重复收卡
  assert.equal(
    reportCloseAction({ kind: 'report', reconciled: 'stored', messageId: 'r1', streamErrored: false }),
    'none',
  );
});

test('最终成功：正常流式收尾（onDone 带真实 messageId）→ finish', () => {
  assert.equal(
    reportCloseAction({ kind: 'report', reconciled: null, messageId: 'm-123', streamErrored: false }),
    'finish',
  );
});

test('storedReplyFor 防误认领：末条回复属于上一轮（本轮请求未送达）→ null', () => {
  const messages = [msg('u0', 'user', '上一轮的问题'), msg('a0', 'assistant', '上一轮的回复')];
  assert.equal(storedReplyFor(messages, '本轮的新问题'), null);
  // 而上一轮自己认领自己是成立的
  assert.ok(storedReplyFor(messages, '上一轮的问题'));
});

// ———— 场景三：最终失败（对账无果 / 中断）————

test('最终失败：对账判死（错误路径已收尾）→ none，不重复收也不装完成', () => {
  assert.equal(
    reportCloseAction({ kind: 'report', reconciled: 'dead', messageId: undefined, streamErrored: true }),
    'none',
  );
});

test('最终失败：无落库 id、错误路径也没收过（主动停止/流静默结束）→ interrupt 而非 finish', () => {
  assert.equal(
    reportCloseAction({ kind: 'report', reconciled: null, messageId: undefined, streamErrored: false }),
    'interrupt',
  );
});

test('非报告轮（chat / 未定型）不动报告卡', () => {
  assert.equal(reportCloseAction({ kind: 'chat', reconciled: null, messageId: 'm1', streamErrored: false }), 'none');
  assert.equal(reportCloseAction({ kind: null, reconciled: null, messageId: undefined, streamErrored: false }), 'none');
});

// ———— 流层收尾裁决：已渲染却无终态 = 断流对账，绝不合成 onDone ————

test('流被连接层收掉且未收到 done/error：已渲染 → 需对账；未渲染或已终态 → 不需', () => {
  assert.equal(streamClosedWithoutVerdict({ rendered: true, finished: false }), true);
  assert.equal(streamClosedWithoutVerdict({ rendered: true, finished: true }), false);
  assert.equal(streamClosedWithoutVerdict({ rendered: false, finished: false }), false);
});
