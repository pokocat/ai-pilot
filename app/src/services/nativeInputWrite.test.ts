// 回归测试：聊天页程序性写入输入框，绝不能在原生节点就绪前硬写 value。
// 2026-08-03 H5 走查复现：带草稿进 `#/packages/main/chat/index?agentKey=general`，控制台必现
// `TypeError: Cannot read properties of undefined (reading 'value')`（栈：writeInput → Stencil
// setValue → Array.map → watchValue）。根因是 loadDraft 在 initChat 里跑，早于 Taro <Textarea>
// （h5 = Stencil <taro-textarea-core>）首帧渲染，而其 `@Watch('value') watchValue` 直读
// `this.textareaRef.value` 没有空判；异常被 Stencil 自己 catch 成一行 console.error，
// 聊天页那层 `try { el.value = text } catch {}` 兜不住，于是每次进页面都留一条像崩溃的报错。
//   cd app && npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { nativeWriteStep, type NativeWriteInput } from './nativeInputWrite';

const base: NativeWriteInput = { hasEl: true, elRendered: true, stale: false, tries: 0, maxTries: 15 };

describe('nativeWriteStep · 原生输入框写入时机', () => {
  test('就绪即写', () => {
    assert.equal(nativeWriteStep(base), 'write');
  });

  test('本案根因：Stencil 首帧未渲染出原生节点时只许重试，绝不写', () => {
    assert.equal(nativeWriteStep({ ...base, elRendered: false }), 'retry');
    // 重试全程都不许退化成 write —— 一旦写了就是 watchValue 抛错、控制台留报错。
    for (let tries = 0; tries < base.maxTries; tries += 1) {
      assert.equal(nativeWriteStep({ ...base, elRendered: false, tries }), 'retry');
    }
  });

  test('ref 还没挂上元素：同样只许重试', () => {
    assert.equal(nativeWriteStep({ ...base, hasEl: false, elRendered: false }), 'retry');
  });

  test('等不到就放弃，不无限排定时器', () => {
    assert.equal(nativeWriteStep({ ...base, elRendered: false, tries: base.maxTries }), 'drop');
    assert.equal(nativeWriteStep({ ...base, elRendered: false, tries: base.maxTries + 3 }), 'drop');
  });

  test('值已作废（用户又敲了字 / 又来一次写入）：丢弃，不能把旧值写回去覆盖新输入', () => {
    assert.equal(nativeWriteStep({ ...base, stale: true }), 'drop');
    // 作废判定优先于就绪判定：陈旧的重试即便此刻就绪也不许落地。
    assert.equal(nativeWriteStep({ ...base, stale: true, elRendered: false, tries: 1 }), 'drop');
  });
});
