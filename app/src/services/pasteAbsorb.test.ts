// 回归测试：长文粘贴自动归卷的三条判定（切段 / 卡面摘要 / 重复认定）。
// 2026-08-05 真机实拍：粘贴腾讯会议记录后输入框清空、只剩一枚「粘贴长文」小签，
// 主公认不出存了什么，判定失败又粘一遍 → 两份 2612 字重复附卷。
// 旧去重是「10 秒窗口 + 长度和首尾 32 字指纹」，这两处各自都盖不住实拍那条路径：
// 隔了约一分钟（超窗），且第二次粘贴前先打了「还有会议记录：」（指纹全变）。
//   cd app && npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diffPasted, pasteExcerpt, isSamePaste, PASTE_DUP_RATIO } from './pasteAbsorb';

const MEETING = ['腾讯会议记录 · 增长复盘（2026-08-04 03:30）', '参会：张、李、王']
  .concat(Array.from({ length: 40 }, (_, i) => `${i + 1}. 本周新增客户 ${i + 1} 家，转化率待核；渠道预算与投放节奏需要重排。`))
  .join('\n');

describe('diffPasted · 切出这回粘进来的那一段', () => {
  test('空框直粘：整段都是 pasted，kept 为空', () => {
    const { pasted, kept } = diffPasted('', MEETING);
    assert.equal(pasted, MEETING);
    assert.equal(kept, '');
  });

  test('先打开场白再粘：开场白留在框里，只有长文被切走', () => {
    const { pasted, kept } = diffPasted('还有会议记录：', `还有会议记录：${MEETING}`);
    assert.equal(pasted, MEETING);
    assert.equal(kept, '还有会议记录：');
  });

  test('粘在两段已有文字中间：前后都留住，不吃掉原有输入', () => {
    const { pasted, kept } = diffPasted('前言。收尾。', `前言。${MEETING}收尾。`);
    assert.equal(pasted, MEETING);
    assert.equal(kept, '前言。收尾。');
  });
});

describe('pasteExcerpt · 卡面要露内容，不能只写「粘贴长文」', () => {
  test('换行压成空格：会议记录几乎全是换行，不压就只看得到第一行前几个字', () => {
    assert.equal(pasteExcerpt('第一行\n\n第二行   第三行', 100), '第一行 第二行 第三行');
  });

  test('超长截断并加省略号', () => {
    assert.equal(pasteExcerpt('一二三四五六七八九十', 4), '一二三四…');
  });

  test('不足上限时不加省略号', () => {
    assert.equal(pasteExcerpt('  一二三  ', 10), '一二三');
  });

  test('空内容不炸', () => {
    assert.equal(pasteExcerpt(''), '');
    assert.equal(pasteExcerpt(undefined as unknown as string), '');
  });
});

describe('isSamePaste · 认出「以为没成功、又粘了一遍」', () => {
  test('完全相同 → 同一段', () => {
    assert.equal(isSamePaste(MEETING, MEETING), true);
  });

  test('实拍那条：第二次粘贴前先打了几个字，被 diff 裹进 pasted —— 仍须认出是同一段', () => {
    assert.equal(isSamePaste(MEETING, `还有会议记录：${MEETING}`), true);
  });

  test('只有换行 / 空格差异（跨端复制常见）→ 同一段', () => {
    assert.equal(isSamePaste(MEETING, MEETING.replace(/\n/g, '\r\n  ')), true);
  });

  test('真心补了新内容（重合不足九成）→ 不是同一段，不能吞掉', () => {
    const grown = `${MEETING}\n${MEETING.slice(0, Math.ceil(MEETING.length * 0.3))}`;
    assert.equal(isSamePaste(MEETING, grown), false);
  });

  test('两份不同的记录 → 不是同一段', () => {
    assert.equal(isSamePaste(MEETING, MEETING.replace(/腾讯会议/g, '钉钉群聊').replace(/客户/g, '门店')), false);
  });

  test('空串一律不算重复（不能把「没粘到东西」当成已在附卷里）', () => {
    assert.equal(isSamePaste('', MEETING), false);
    assert.equal(isSamePaste('   \n  ', MEETING), false);
  });

  test('重合比阈值就是九成这条线：卡在边界两侧各判一次', () => {
    const base = 'x'.repeat(1000);
    assert.equal(isSamePaste(base, `${'y'.repeat(60)}${base}`, PASTE_DUP_RATIO), true);   // 1000/1060 ≈ 94%
    assert.equal(isSamePaste(base, `${'y'.repeat(200)}${base}`, PASTE_DUP_RATIO), false); // 1000/1200 ≈ 83%
  });
});
