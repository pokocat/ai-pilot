// 回归测试：报告 V2 的 9 种类型化 section 在任何「读 h/b/list」的旧版展示位都不能被静默剥空。
// 2026-07-21 例行 QA：发现「方案库详情」页（packages/work/report/index.tsx）自报告 V2（f16d517）
// 落地后一直直接读 sec.h/sec.b/sec.list，对 stats/roster/table/phases/timeline/quote/letter 这
// 7 种类型化 section 渲染出几乎空白的章节（quote/letter 连标题都没有），diff 视图的标题栏与改前/改后
// 预览同理剥空——与 ReportCard 早前修过的「V2 typed section 被剥空」（e193b13）是同一个坑，只是这处
// 展示位当时没有一起改。修复后两处共用 cardSection/cardSectionText，本测试覆盖该共享函数。
//   cd app && npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { cardSection, cardSectionText } from './deliverableSection';
import type { Section } from './api';

describe('cardSection · 报告 V2 类型化 section 不能被剥空', () => {
  test('hero：标题 + paras 合并进 b', () => {
    const v = cardSection({ type: 'hero', h: '定调', paras: ['第一段', '第二段'] } as Section);
    assert.equal(v.h, '定调');
    assert.equal(v.b, '第一段\n\n第二段');
  });

  test('stats：items 必须映射进 list', () => {
    const v = cardSection({ type: 'stats', h: '你的家底', items: [{ num: '240', unit: '万', label: '月流水' }] } as Section);
    assert.deepEqual(v.list, ['240万 · 月流水']);
  });

  test('roster：intro 进 b，people 进 list', () => {
    const v = cardSection({ type: 'roster', intro: '核心班底', people: [{ name: '周慎', role: '管账', desc: '稳' }] } as Section);
    assert.equal(v.b, '核心班底');
    assert.deepEqual(v.list, ['周慎（管账）：稳']);
  });

  test('table：headers/rows（含 trend 单元格）要能看到', () => {
    const v = cardSection({ type: 'table', headers: ['维度', '青州'], rows: [['判断', { text: '首取', trend: 'up' }]] } as Section);
    assert.deepEqual(v.list, ['维度 / 青州', '判断 / 首取']);
  });

  test('quote：修复前完全没有 h，方案库详情/diff 标题栏会留白；修复后标题+正文都要有', () => {
    const v = cardSection({ type: 'quote', text: '贪三城之名者失一城' } as Section);
    assert.equal(v.h, '金句');
    assert.match(v.b ?? '', /贪三城之名者失一城/);
  });

  test('letter：修复前完全没有 h、正文也拼不出来', () => {
    const v = cardSection({ type: 'letter', salute: '老板台鉴', paras: ['其一'], close: '可安心落子', sign: '军师 顿首' } as Section);
    assert.equal(v.h, '军师手书');
    assert.equal(v.b, '老板台鉴\n\n其一\n\n可安心落子\n\n军师 顿首');
  });

  test('向后兼容：旧版白卡（无 type）原样透传', () => {
    const v = cardSection({ h: '主要矛盾', b: '现金流紧张', list: ['聚焦头部客户'] } as Section);
    assert.equal(v.h, '主要矛盾');
    assert.equal(v.b, '现金流紧张');
    assert.deepEqual(v.list, ['聚焦头部客户']);
  });

  test('未知 type（存量脏数据）→ 优雅降级，不抛异常', () => {
    assert.doesNotThrow(() => cardSection({ type: 'mystery', h: '未来类型', b: '正文' } as unknown as Section));
  });
});

describe('cardSectionText · diff 改前/改后一行预览', () => {
  test('undefined → 空字符串（新增/删除侧缺失时不能抛异常）', () => {
    assert.equal(cardSectionText(undefined), '');
  });

  test('quote 类型：修复前 secText 只读 b/list 会拿到空字符串，diff 预览一片空白', () => {
    const text = cardSectionText({ type: 'quote', text: '固一城之实者得三城' } as Section);
    assert.match(text, /固一城之实者得三城/);
  });

  test('stats 类型：拼出 num/label，而不是空字符串', () => {
    const text = cardSectionText({ type: 'stats', items: [{ num: '12', label: '门店' }] } as Section);
    assert.match(text, /12/);
    assert.match(text, /门店/);
  });
});
