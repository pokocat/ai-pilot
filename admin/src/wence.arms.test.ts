// 回归测试：问策入口后台的三段换算逻辑。三处都是「看起来对、错了也不报错」的静默失真类型：
//
//  · armPercents —— 服务端存的是**相对权重**（默认 34/33/33），不是百分比。把权重当百分比直接显示，
//    在 5/0/5 这种两臂配置下会显示成「现状 5% · 新问策页 5%」，运营会以为九成用户没被分流。
//  · twoArmPayload —— 界面只暴露两档，dock 必须固定 0 且两档合计 100；一旦漏了 dock 或算出全 0，
//    服务端会 400（权重总和必须大于 0）或把用户分到运营根本没打算开的臂。
//  · reorderSorts —— sort 建号是「同 kind 当前条数」，删过几条后池里会有重复/断号 sort，
//    两两交换会得到「点了上移但顺序没变」。必须整段重排号。
//   cd admin && npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { armPercents, twoArmPayload, reorderSorts, packChips } from './views/wence.js';

describe('armPercents · 相对权重要归一化成百分比再给运营看', () => {
  test('服务端默认三臂均分 34/33/33 → 34/33/33，合计 100', () => {
    assert.deepEqual(armPercents({ control: 34, dock: 33, chat: 33 }), { control: 34, dock: 33, chat: 33 });
  });
  test('两臂小权重 5/0/5 是「对半」，不是「各 5%」', () => {
    assert.deepEqual(armPercents({ control: 5, dock: 0, chat: 5 }), { control: 50, dock: 0, chat: 50 });
  });
  test('已是百分比口径（90/0/10）原样保持', () => {
    assert.deepEqual(armPercents({ control: 90, dock: 0, chat: 10 }), { control: 90, dock: 0, chat: 10 });
  });
  test('历史配置里的保留臂 dock 必须如实露出来，不能被吞掉', () => {
    const p = armPercents({ control: 50, dock: 25, chat: 25 });
    assert.equal(p.dock, 25);
    assert.equal(p.control + p.dock + p.chat, 100);
  });
  test('读不出权重（未落库 / 全 0 / 负数）按「全量现状」呈现，不假装在分流', () => {
    assert.deepEqual(armPercents(undefined), { control: 100, dock: 0, chat: 0 });
    assert.deepEqual(armPercents({}), { control: 100, dock: 0, chat: 0 });
    assert.deepEqual(armPercents({ control: 0, dock: 0, chat: 0 }), { control: 100, dock: 0, chat: 0 });
    assert.deepEqual(armPercents({ control: -5, dock: 0, chat: 0 }), { control: 100, dock: 0, chat: 0 });
  });
  test('除不尽也必须合计 100（chat 用减法兜底，不能显示成 99%）', () => {
    for (const arms of [{ control: 1, dock: 1, chat: 1 }, { control: 2, dock: 0, chat: 1 }, { control: 7, dock: 3, chat: 5 }]) {
      const p = armPercents(arms);
      assert.equal(p.control + p.dock + p.chat, 100, JSON.stringify(arms));
    }
  });
});

describe('twoArmPayload · 提交永远是两档合计 100 + dock 归零', () => {
  test('dock 固定 0，control 吃掉剩余', () => {
    assert.deepEqual(twoArmPayload(20), { control: 80, dock: 0, chat: 20 });
    assert.deepEqual(twoArmPayload(0), { control: 100, dock: 0, chat: 0 });
    assert.deepEqual(twoArmPayload(100), { control: 0, dock: 0, chat: 100 });
  });
  test('越界与脏输入夹回 0-100，且总和恒 > 0（否则服务端 400）', () => {
    for (const v of [-30, 0, 33.4, 99.6, 180, Number.NaN]) {
      const a = twoArmPayload(v);
      assert.ok(a.chat >= 0 && a.chat <= 100, `chat 越界：${a.chat}`);
      assert.equal(a.dock, 0);
      assert.equal(a.control + a.chat, 100);
    }
  });
});

describe('reorderSorts · 上移下移必须整段重排号', () => {
  const pool = (...sorts: number[]) => sorts.map((s, i) => ({ id: `t${i}`, sort: s }));

  test('连续 sort 上移：只回写真正变了的两行', () => {
    assert.deepEqual(reorderSorts(pool(0, 1, 2), 2, 1), [{ id: 't2', sort: 1 }, { id: 't1', sort: 2 }]);
  });
  test('sort 有重复（删过条目后的真实池子）时仍能排出严格递增的新号', () => {
    // 三条都是 sort=0：两两交换等于什么都没做，整段重排才会真的换位置。
    // t1 重排后仍是 0，不必回写；只有真的变号的 t2/t0 会产生 PATCH。
    const out = reorderSorts(pool(0, 0, 0), 0, 2);
    assert.deepEqual(out, [{ id: 't2', sort: 1 }, { id: 't0', sort: 2 }]);
  });
  test('sort 断号（0/3/7）也会被压平成 0/1/2', () => {
    assert.deepEqual(reorderSorts(pool(0, 3, 7), 0, 1), [{ id: 't1', sort: 0 }, { id: 't0', sort: 1 }, { id: 't2', sort: 2 }]);
  });
  test('越界 / 原地不动 → 不产生任何写请求', () => {
    assert.deepEqual(reorderSorts(pool(0, 1, 2), 0, -1), []);
    assert.deepEqual(reorderSorts(pool(0, 1, 2), 2, 3), []);
    assert.deepEqual(reorderSorts(pool(0, 1, 2), 1, 1), []);
    assert.deepEqual(reorderSorts([], 0, 1), []);
  });
});

describe('packChips · 与服务端 normalizeChips 同口径', () => {
  test('去空白、丢空串、最多 4 条', () => {
    assert.deepEqual(packChips([' 先算获客 ', '', '看复购', '  ']), ['先算获客', '看复购']);
    assert.deepEqual(packChips(['a', 'b', 'c', 'd', 'e']), ['a', 'b', 'c', 'd']);
  });
  test('全空返回空数组 —— 这是运营「删掉这一排」的唯一途径，不能变成 undefined（= 不动）', () => {
    assert.deepEqual(packChips(['', '  ', '']), []);
  });
});
