// admin:sync-content 的提示词护栏 — 纯单元测试（不连库）。
//   cd server && node --import tsx --test test/syncAdminContent.test.ts
//
// 背景：2026-07-27 登生产核对发现 `general` 的 systemPrompt 线上 49,094 字符、仓库文件只有
// 17,230，已漂 2.85 倍。而原实现的 upsert update 分支无条件写 `systemPrompt: a.systemPrompt`，
// 无 diff 无确认。运行时读 AgentVersion 已发布快照所以同步不立刻生效，但草稿被换成旧版后，
// 之后任何一次「发布」就把三个版本的调教推平且不可恢复。
//
// 这些用例锁住护栏的行为，防止哪天有人图省事把默认值改回「总是覆盖」。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decidePromptWrite, OPERATOR_OWNED, SHRINK_REFUSE_RATIO } from '../scripts/syncAdminContent.js';

const LIVE = 'x'.repeat(49_094);   // 线上实际长度
const REPO = 'y'.repeat(17_230);   // 仓库文件实际长度

describe('提示词覆盖护栏', () => {
  test('默认不覆盖已有提示词——这是本次修复的核心', () => {
    const d = decidePromptWrite('systemPrompt', LIVE, REPO);
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /默认不覆盖/);
  });

  test('库里为空时写入初值，不算覆盖', () => {
    assert.equal(decidePromptWrite('systemPrompt', '', REPO).action, 'write');
    assert.equal(decidePromptWrite('systemPrompt', null, REPO).action, 'write');
  });

  test('仓库侧为空时永不写——避免把线上清空', () => {
    assert.equal(decidePromptWrite('systemPrompt', LIVE, '').action, 'skip');
    assert.equal(decidePromptWrite('systemPrompt', LIVE, undefined).action, 'skip');
  });

  test('内容一致时不写', () => {
    const d = decidePromptWrite('systemPrompt', LIVE, LIVE);
    assert.equal(d.action, 'skip');
    assert.match(d.reason, /一致/);
  });

  // 这一条是最重要的护栏：即使有人加了 --force-prompts，只要仓库明显更短就拒绝。
  // 「短很多」正是「仓库是旧快照」的特征，此时覆盖 = 丢失调教。
  test('即使 --force-prompts，仓库明显更短也拒绝', () => {
    const d = decidePromptWrite('systemPrompt', LIVE, REPO, { forcePrompts: true });
    assert.equal(d.action, 'refuse');
    assert.match(d.reason, /旧快照/);
    assert.match(d.reason, /--allow-shrink/, '应告诉使用者如何在确认后覆盖');
  });

  test('--force-prompts + --allow-shrink 才真的覆盖（留给确实要回退的场景）', () => {
    const d = decidePromptWrite('systemPrompt', LIVE, REPO, { forcePrompts: true, allowShrink: true });
    assert.equal(d.action, 'write');
  });

  test('长度接近时 --force-prompts 可直接覆盖（正常的小幅修订）', () => {
    const almost = 'y'.repeat(Math.ceil(LIVE.length * SHRINK_REFUSE_RATIO) + 10);
    assert.equal(decidePromptWrite('systemPrompt', LIVE, almost, { forcePrompts: true }).action, 'write');
  });

  test('比线上更长时不触发缩水护栏', () => {
    const longer = 'y'.repeat(LIVE.length + 1000);
    assert.equal(decidePromptWrite('systemPrompt', LIVE, longer, { forcePrompts: true }).action, 'write');
  });

  test('greet 与 systemPrompt 同等受保护', () => {
    assert.ok(OPERATOR_OWNED.includes('greet'));
    assert.ok(OPERATOR_OWNED.includes('systemPrompt'));
    assert.equal(decidePromptWrite('greet', '线上调教过的开场白', '仓库旧版').action, 'skip');
  });

  test('决策里带上两侧长度，便于人工判断', () => {
    const d = decidePromptWrite('systemPrompt', LIVE, REPO);
    assert.equal(d.dbLen, 49_094);
    assert.equal(d.repoLen, 17_230);
  });
});
