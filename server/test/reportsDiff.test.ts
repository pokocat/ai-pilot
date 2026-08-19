// diffContents 的 section 级配对：回归测试无 h 的类型化 section（quote/letter）不再互相覆盖。
//   cd server && node --import tsx --test test/reportsDiff.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assertReportContentLimits, diffContents, REPORT_LIMITS, wordDiff } from '../src/services/reports.js';

describe('diffContents · 无 h 的 typed section 按位置配对', () => {
  test('两个无 h 的 quote 各自独立配对，不会折叠成一条 diff', () => {
    const before = {
      title: '方案', sections: [
        { type: 'quote', text: '第一句金句' },
        { type: 'quote', text: '第二句金句' },
      ],
    };
    const after = {
      title: '方案', sections: [
        { type: 'quote', text: '第一句金句' }, // 未变
        { type: 'quote', text: '第二句金句改过了' }, // 改了
      ],
    };
    const { sections, summary } = diffContents(before, after);
    assert.equal(sections.length, 2, '两条 quote 应各自产生一条 diff 记录，而非折叠成一条');
    assert.equal(sections.filter((s) => s.change === 'unchanged').length, 1);
    assert.equal(sections.filter((s) => s.change === 'changed').length, 1);
    assert.match(summary, /修改 1 段/);
    assert.match(summary, /删除 0 段/); // 不应误判成「删一条+加一条」，而是精确定位为「改了一条」
  });

  test('新增一个无 h 的 letter，不与已存在的 quote 混淆', () => {
    const before = { title: '方案', sections: [{ type: 'quote', text: '金句' }] };
    const after = {
      title: '方案',
      sections: [{ type: 'quote', text: '金句' }, { type: 'letter', paras: ['正文'], close: '此致' }],
    };
    const { sections } = diffContents(before, after);
    assert.equal(sections.filter((s) => s.change === 'unchanged').length, 1);
    assert.equal(sections.filter((s) => s.change === 'added').length, 1);
    assert.equal((sections.find((s) => s.change === 'added') as any).after.type, 'letter');
  });

  test('删除其中一个无 h 的 quote，能定位到被删的那一条而非误报另一条', () => {
    const before = {
      title: '方案', sections: [
        { type: 'quote', text: '保留的金句' },
        { type: 'quote', text: '被删的金句' },
      ],
    };
    const after = { title: '方案', sections: [{ type: 'quote', text: '保留的金句' }] };
    const { sections, summary } = diffContents(before, after);
    const removed = sections.filter((s) => s.change === 'removed');
    assert.equal(removed.length, 1);
    assert.equal((removed[0] as any).before.text, '被删的金句');
    assert.match(summary, /删除 1 段/);
  });

  test('有 h 的旧版白卡 section 行为不受影响（按 h 精确匹配）', () => {
    const before = { title: '方案', sections: [{ h: '背景', b: '旧内容' }] };
    const after = { title: '方案', sections: [{ h: '背景', b: '新内容' }] };
    const { sections } = diffContents(before, after);
    assert.equal(sections.length, 1);
    assert.equal(sections[0].change, 'changed');
    assert.equal(sections[0].h, '背景');
  });
});

describe('报告 diff 与正文运行时上限', () => {
  test('超大词元组合走有界线性退化，不分配 n×m 矩阵', () => {
    const before = `共同开头${'甲'.repeat(REPORT_LIMITS.maxDiffTokens + 100)}共同结尾`;
    const after = `共同开头${'乙'.repeat(REPORT_LIMITS.maxDiffTokens + 100)}共同结尾`;
    const ops = wordDiff(before, after);
    assert.ok(ops.some((op) => op.t === 'del'));
    assert.ok(ops.some((op) => op.t === 'add'));
    assert.equal(ops.map((op) => op.s).join('').includes('共同开头'), true);
  });

  test('正文总量、段落数与单段大小均有服务端硬限制', () => {
    assert.throws(
      () => assertReportContentLimits({ sections: Array.from({ length: REPORT_LIMITS.maxSections + 1 }, (_, i) => ({ h: `${i}`, b: 'x' })) }),
      (error: unknown) => (error as { code?: string }).code === 'REPORT_TOO_MANY_SECTIONS',
    );
    assert.throws(
      () => assertReportContentLimits({ sections: [{ h: '超长', b: '中'.repeat(REPORT_LIMITS.maxSectionBytes) }] }),
      (error: unknown) => ['REPORT_TOO_LARGE', 'REPORT_SECTION_TOO_LARGE'].includes((error as { code?: string }).code ?? ''),
    );
  });
});
