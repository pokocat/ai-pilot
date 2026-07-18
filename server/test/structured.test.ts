// structured() 结构化输出原语 · 单元测试。
// 主体是纯逻辑（无 DB / 无网络）：coerceJson × ProphecyResult schema——抠 JSON + 校验 + 逐条容错 + 归一化 + 截断。
// 末尾一条锁定安全性质：测试/mock 下无真实 provider → extractProphecies 返回 []（绝不伪造预言）。
//   cd server && node --import tsx --test test/structured.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coerceJson, ProphecyResult, extractProphecies, structuredBillTokens } from '../src/llm/gateway.js';

describe('coerceJson × ProphecyResult（纯逻辑）', () => {
  test('合法两条 → 归一化（trim/截断）+ 保留 dueDate；basis 缺省空串', () => {
    const r = coerceJson(ProphecyResult, JSON.stringify({
      prophecies: [
        { prophecy: '  三个月内现金流转正  ', basis: ' 靠复购 ', verifyStandard: '月末余额>0', dueDate: '2026-09-30' },
        { prophecy: '旺季客流翻倍', basis: null, verifyStandard: '', dueDate: null },
      ],
    }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.prophecies.length, 2);
    assert.equal(r.data.prophecies[0].prophecy, '三个月内现金流转正');
    assert.equal(r.data.prophecies[0].basis, '靠复购');
    assert.equal(r.data.prophecies[0].dueDate, '2026-09-30');
    assert.equal(r.data.prophecies[1].basis, ''); // null → ''
    assert.equal(r.data.prophecies[1].dueDate, null);
  });

  test('无效条目（缺 prophecy / 纯空白）被丢弃，合法条目保留', () => {
    const r = coerceJson(ProphecyResult, JSON.stringify({
      prophecies: [
        { basis: '没有 prophecy 字段' },
        { prophecy: '   ' }, // 纯空白 → 丢
        { prophecy: '有效预言', verifyStandard: 'x' },
      ],
    }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.prophecies.length, 1);
    assert.equal(r.data.prophecies[0].prophecy, '有效预言');
  });

  test('dueDate 非 YYYY-MM-DD → 归一为 null', () => {
    const r = coerceJson(ProphecyResult, JSON.stringify({ prophecies: [{ prophecy: 'x', dueDate: '2026/09/30' }] }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.prophecies[0].dueDate, null);
  });

  test('超过 2 条 → 截断为前 2', () => {
    const r = coerceJson(ProphecyResult, JSON.stringify({
      prophecies: [{ prophecy: 'a' }, { prophecy: 'b' }, { prophecy: 'c' }],
    }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.data.prophecies.map((p) => p.prophecy), ['a', 'b']);
  });

  test('prophecies 错型 / 缺失 → 空数组（整批容错，不触发失败）', () => {
    for (const bad of [{ prophecies: 'oops' }, { foo: 1 }, {}]) {
      const r = coerceJson(ProphecyResult, JSON.stringify(bad));
      assert.equal(r.ok, true, JSON.stringify(bad));
      if (r.ok) assert.deepEqual(r.data.prophecies, []);
    }
  });

  test('prophecy 超长 → 截断 300', () => {
    const long = '预'.repeat(400);
    const r = coerceJson(ProphecyResult, JSON.stringify({ prophecies: [{ prophecy: long }] }));
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.prophecies[0].prophecy.length, 300);
  });

  test('JSON 可夹在自然语言中（抠 {…}）', () => {
    const r = coerceJson(ProphecyResult, '好的，这是我的判断：{"prophecies":[{"prophecy":"下季度回款改善"}]} 就这些。');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.prophecies[0].prophecy, '下季度回款改善');
  });

  test('非 JSON 文本 → ok:false 带错误信息（供修复轮回喂）', () => {
    const r = coerceJson(ProphecyResult, '军师这轮没有给出预言。');
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /JSON/);
  });
});

describe('P1-3 structuredBillTokens 保守结算口径（纯函数）', () => {
  test('成功 → 定额 estTokens（成功时不变）', () => {
    assert.equal(structuredBillTokens({ ok: true, attempts: 1, estTokens: 800 }), 800);
    assert.equal(structuredBillTokens({ ok: true, attempts: 2, estTokens: 800 }), 800); // 成功即定额，与轮次无关
  });
  test('失败但已真实调用 → attempts × estTokens（不全额退）', () => {
    assert.equal(structuredBillTokens({ ok: false, attempts: 1, estTokens: 800 }), 800);
    assert.equal(structuredBillTokens({ ok: false, attempts: 2, estTokens: 800 }), 1600);
  });
  test('无 live provider（attempts=0）→ 0，不实扣', () => {
    assert.equal(structuredBillTokens({ ok: false, attempts: 0, estTokens: 800 }), 0);
  });
});

describe('extractProphecies 安全性质', () => {
  test('无 live provider（测试/mock）→ 返回 []，绝不伪造预言', async () => {
    // NODE_ENV=test → isAiTestMode() → liveProvider 返回 null → structured 返回 null → []。
    const out = await extractProphecies('三个月内我们会拿下华东市场，营收翻三倍。');
    assert.deepEqual(out, []);
  });
});
