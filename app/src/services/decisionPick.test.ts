import test from 'node:test';
import assert from 'node:assert/strict';
import { pickDecisionToVerify } from './decisionPick';
import type { DecisionView } from './api';

// 只填选择逻辑用到的字段，其余按契约补空值。
function d(seq: number, status: DecisionView['status'], verifyByDate: string | null): DecisionView {
  return {
    id: `dec-${seq}`, seq, scene: '', decision: `决策${seq}`, reasons: [],
    tianshiRef: '', expected: '', verifyStandard: '', verifyByDate,
    status, verifyNote: '', fast: null, createdAt: '',
  };
}

test('挑待验证决策：不受传输层顺序影响（mock 升序 / 服务端降序结果一致）', () => {
  const asc = [d(5, 'pending', '2026-08-10'), d(6, 'pending', '2026-08-05')];
  const desc = asc.slice().reverse();
  assert.equal(pickDecisionToVerify(asc)?.seq, 6);
  assert.equal(pickDecisionToVerify(desc)?.seq, 6, '同一份数据换个顺序不能挑出不同的决策');
});

test('挑待验证决策：只看 pending，已判过的不再催', () => {
  const items = [d(1, 'correct', '2026-07-01'), d(2, 'revise', '2026-07-02'), d(3, 'pending', '2026-08-09')];
  assert.equal(pickDecisionToVerify(items)?.seq, 3);
  assert.equal(pickDecisionToVerify([d(1, 'correct', null), d(2, 'revise', null)]), null);
});

test('挑待验证决策：验证日早的（含已过期）优先于刚下的新决策', () => {
  const items = [d(9, 'pending', '2026-09-01'), d(3, 'pending', '2026-07-20')];
  assert.equal(pickDecisionToVerify(items)?.seq, 3, '过期那条才是真拖着的');
});

test('挑待验证决策：有验证日的优先；都没有则取最新一条', () => {
  assert.equal(pickDecisionToVerify([d(9, 'pending', null), d(2, 'pending', '2026-12-31')])?.seq, 2);
  assert.equal(pickDecisionToVerify([d(4, 'pending', null), d(9, 'pending', null)])?.seq, 9);
});

test('挑待验证决策：空账本 / 缺字段不炸', () => {
  assert.equal(pickDecisionToVerify([]), null);
  assert.equal(pickDecisionToVerify(undefined), null);
  assert.equal(pickDecisionToVerify(null), null);
});

test('挑待验证决策：不改动传入数组（调用方还要按原顺序渲染账本）', () => {
  const items = [d(1, 'pending', '2026-09-09'), d(2, 'pending', '2026-08-08')];
  pickDecisionToVerify(items);
  assert.deepEqual(items.map((x) => x.seq), [1, 2]);
});
