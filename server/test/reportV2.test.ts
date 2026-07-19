// 报告 V2：类型化 section 归一化 + 类型化渲染单测（纯函数，不连库）。
//   cd server && node --import tsx --test test/reportV2.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeliverableSections, normalizeCover } from '../src/llm/schema.js';
import { renderReportHtml } from '../src/services/reportHtml.js';
import type { Deliverable } from '../src/llm/schema.js';

const base = (sections: any[], cover?: any): Deliverable => ({
  title: '三城布局方略', icon: 'target', meta: '拾叶山房 · 餐饮 · 增长期',
  ...(cover ? { cover } : {}),
  sections, trust: '本报告为战略参考。', actions: ['save_to_library'],
});

describe('normalizeDeliverableSections · 类型化', () => {
  test('hero 合法保留；缺 h 用 paras 兜底', () => {
    const [s] = normalizeDeliverableSections([{ type: 'hero', h: '定调', paras: ['第一段', '第二段', ''] }]);
    assert.equal(s.type, 'hero');
    assert.deepEqual((s as any).paras, ['第一段', '第二段']);
  });

  test('callout 非法 tone → 归一为「布局」', () => {
    const [s] = normalizeDeliverableSections([{ type: 'callout', tone: '瞎写', h: '标题', b: '正文' }]);
    assert.equal(s.type, 'callout');
    assert.equal((s as any).tone, '布局');
  });

  test('callout 合法 tone 保留', () => {
    const [s] = normalizeDeliverableSections([{ type: 'callout', tone: '风险', h: 't', b: 'b' }]);
    assert.equal((s as any).tone, '风险');
  });

  test('stats 丢弃缺 num/label 的脏 item', () => {
    const [s] = normalizeDeliverableSections([{ type: 'stats', items: [
      { num: '240', unit: '万', label: '月流水' },
      { num: '', label: '空数值' },
      { num: '12', label: '' },
      { label: '缺 num' },
    ] }]);
    assert.equal((s as any).items.length, 1);
    assert.deepEqual((s as any).items[0], { num: '240', unit: '万', label: '月流水' });
  });

  test('stats 全脏 → 整段丢弃', () => {
    const out = normalizeDeliverableSections([{ type: 'stats', items: [{ num: '' }] }]);
    assert.equal(out.length, 0);
  });

  test('roster 过滤无 name 的人物', () => {
    const [s] = normalizeDeliverableSections([{ type: 'roster', people: [
      { name: '周慎', role: '管账', desc: '稳' },
      { role: '无名' },
    ] }]);
    assert.equal((s as any).people.length, 1);
    assert.equal((s as any).people[0].name, '周慎');
  });

  test('table 字符串/对象单元格并存，保留 trend', () => {
    const [s] = normalizeDeliverableSections([{ type: 'table', headers: ['维度', '青州'], rows: [
      ['距离', '80 里'],
      ['判断', { text: '首取', trend: 'up' }],
      ['非数组行会被丢'],
    ] }]);
    assert.equal((s as any).headers.length, 2);
    assert.equal((s as any).rows.length, 3);
    assert.deepEqual((s as any).rows[1][1], { text: '首取', trend: 'up' });
  });

  test('table 缺 headers 或 rows → 丢弃', () => {
    assert.equal(normalizeDeliverableSections([{ type: 'table', headers: [], rows: [['x']] }]).length, 0);
    assert.equal(normalizeDeliverableSections([{ type: 'table', headers: ['a'], rows: [] }]).length, 0);
  });

  test('phases 过滤无 h 的阶段，tab 缺省有兜底', () => {
    const [s] = normalizeDeliverableSections([{ type: 'phases', items: [
      { h: '止血固本', when: '两个月内', actions: ['关店', '理账'], kpi: '不再亏损' },
      { actions: ['无标题被丢'] },
    ] }]);
    assert.equal((s as any).items.length, 1);
    assert.equal((s as any).items[0].tab, '第一阶段');
    assert.deepEqual((s as any).items[0].actions, ['关店', '理账']);
  });

  test('timeline / quote / letter 合法', () => {
    const [tl] = normalizeDeliverableSections([{ type: 'timeline', items: [{ when: '7月', h: '止血期', d: '守', highlight: true }] }]);
    assert.equal((tl as any).items[0].highlight, true);
    const [q] = normalizeDeliverableSections([{ type: 'quote', text: '贪三城之名者失一城' }]);
    assert.equal(q.type, 'quote');
    const [lt] = normalizeDeliverableSections([{ type: 'letter', salute: '老板台鉴', paras: ['正文'], close: '顺颂', sign: '军师 顿首' }]);
    assert.equal(lt.type, 'letter');
    assert.equal((lt as any).close, '顺颂');
  });

  test('quote 缺 text → 丢弃', () => {
    assert.equal(normalizeDeliverableSections([{ type: 'quote', text: '' }]).length, 0);
  });

  test('未知 type → 若有 h/b 降级为白卡，否则丢弃', () => {
    const [s] = normalizeDeliverableSections([{ type: 'wat', h: '标题', b: '正文' }]);
    assert.equal(s.type, undefined);
    assert.equal((s as any).h, '标题');
    assert.equal(normalizeDeliverableSections([{ type: 'wat', foo: 1 }]).length, 0);
  });

  test('向后兼容：无 type 旧白卡原样保留', () => {
    const [s] = normalizeDeliverableSections([{ h: '主要矛盾', b: '现金流紧张', list: ['a', 'b'] }]);
    assert.equal(s.type, undefined);
    assert.equal((s as any).h, '主要矛盾');
    assert.deepEqual((s as any).list, ['a', 'b']);
  });

  test('脏数据不抛异常（null/数字/字符串混入）', () => {
    assert.doesNotThrow(() => normalizeDeliverableSections([null, 42, 'hi', { type: 'stats' }, undefined]));
  });

  test('normalizeCover：缺 title → undefined', () => {
    assert.equal(normalizeCover({ subtitle: 'x' }), undefined);
    assert.deepEqual(normalizeCover({ title: '三城布局方略', motto: '谋定而后动' }), { title: '三城布局方略', motto: '谋定而后动' });
  });
});

describe('renderReportHtml · 类型化渲染', () => {
  test('hero 渲染深绿定调块', () => {
    const html = renderReportHtml(base([{ type: 'hero', h: '你已过活下来这关', paras: ['底子不小'] }]));
    assert.match(html, /class="hero"/);
    assert.match(html, /你已过活下来这关/);
    assert.match(html, /底子不小/);
  });

  test('callout tone → 语义色 class + 标签', () => {
    const html = renderReportHtml(base([{ type: 'callout', tone: '风险', h: '4 家在亏钱', b: '要先止血' }]));
    assert.match(html, /class="callout risk"/);
    assert.match(html, /<span class="tag">风险<\/span>/);
  });

  test('stats 渲染大字格 + 单位', () => {
    const html = renderReportHtml(base([{ type: 'stats', h: '你的家底', items: [{ num: '240', unit: '万', label: '月流水' }] }]));
    assert.match(html, /class="stats"/);
    assert.match(html, /240<small>万<\/small>/);
    assert.match(html, /月流水/);
  });

  test('table 渲染表头 + 首列 th + trend span', () => {
    const html = renderReportHtml(base([{ type: 'table', headers: ['维度', '青州'], rows: [['判断', { text: '首取', trend: 'up' }]] }]));
    assert.match(html, /<thead><tr><th>维度<\/th><th>青州<\/th><\/tr><\/thead>/);
    assert.match(html, /<th>判断<\/th>/); // 首列为行头
    assert.match(html, /<span class="up">首取<\/span>/);
  });

  test('phases 渲染军令状线', () => {
    const html = renderReportHtml(base([{ type: 'phases', items: [{ tab: '第一阶段', h: '止血', actions: ['关店'], kpi: '不再亏损' }] }]));
    assert.match(html, /class="phase-tab">第一阶段/);
    assert.match(html, /<span class="k">军令状<\/span>/);
    assert.match(html, /不再亏损/);
  });

  test('timeline highlight → gold class', () => {
    const html = renderReportHtml(base([{ type: 'timeline', items: [{ when: '9月', h: '出城期', d: '关键一步', highlight: true }] }]));
    assert.match(html, /class="tl gold"/);
  });

  test('quote / letter 为满宽块，不套章节序号', () => {
    const html = renderReportHtml(base([
      { type: 'quote', text: '固一城之实者得三城' },
      { type: 'letter', salute: '老板台鉴', paras: ['其一'], close: '可安心落子', sign: '军师 顿首' },
    ]));
    assert.match(html, /class="quote"/);
    assert.match(html, /军 师 手 书/);
    assert.match(html, /可安心落子/);
    assert.doesNotMatch(html, /class="sec-num/); // 无章节序号
  });

  test('章节型有 h → 汉字序号', () => {
    const html = renderReportHtml(base([
      { type: 'stats', h: '家底', items: [{ num: '12', label: '门店' }] },
      { type: 'table', h: '三城对比', headers: ['a'], rows: [['b']] },
    ]));
    assert.match(html, /class="sec-num serif">壹</);
    assert.match(html, /class="sec-num serif">贰</);
  });

  test('封面用 cover 文案；无 cover 用 title 兜底', () => {
    const withCover = renderReportHtml(base([{ type: 'quote', text: 'x' }], { title: '封面标题', subtitle: '副标', motto: '谋定而后动' }));
    assert.match(withCover, /class="cover-title">封面标题</);
    assert.match(withCover, /谋定而后动/);
    const noCover = renderReportHtml(base([{ type: 'quote', text: 'x' }]));
    assert.match(noCover, /class="cover-title">三城布局方略</);
  });

  test('向后兼容：旧白卡渲染为纸白章节卡 + 汉字序号', () => {
    const html = renderReportHtml(base([{ h: '主要矛盾', b: '现金流紧张。\n复购不足。', list: ['聚焦头部客户'] }]));
    assert.match(html, /class="sec-num serif">壹</);
    assert.match(html, /class="pcard"/);
    assert.match(html, /现金流紧张。<br>复购不足。/);
    assert.match(html, /<li>聚焦头部客户<\/li>/);
  });

  test('未知 type（存量脏数据）→ 优雅降级白卡，不 crash', () => {
    const html = renderReportHtml(base([{ type: 'mystery', h: '未来类型', b: '正文' } as any]));
    assert.match(html, /未来类型/);
    assert.match(html, /class="pcard"/);
  });

  test('转义：所有用户内容走 HTML 转义', () => {
    const html = renderReportHtml(base([{ type: 'callout', tone: '机会', h: '<b>x</b>', b: 'a & b' }]));
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.match(html, /a &amp; b/);
    assert.doesNotMatch(html.split('</style>')[1] ?? html, /<b>x<\/b>/);
  });
});
