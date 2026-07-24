// 报告 V2：类型化 section 归一化 + 类型化渲染单测（纯函数，不连库）。
//   cd server && node --import tsx --test test/reportV2.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDeliverableSections, normalizeCover, healDeliverableSections } from '../src/llm/schema.js';
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

  test('gauge：score clamp 0-100，items 分数 clamp，脏 item 丢弃', () => {
    const [s] = normalizeDeliverableSections([{ type: 'gauge', h: '体检', score: 172, verdict: '底子稳', items: [
      { label: '现金流', score: -20, note: '紧' },
      { label: '复购', score: 78 },
      { score: 60 }, // 缺 label → 丢
    ] }]);
    assert.equal(s.type, 'gauge');
    assert.equal((s as any).score, 100); // 172 clamp 到 100
    assert.equal((s as any).verdict, '底子稳');
    assert.equal((s as any).items.length, 2);
    assert.equal((s as any).items[0].score, 0); // -20 clamp 到 0
    assert.equal((s as any).items[0].note, '紧');
  });

  test('gauge：字符串数字 coerce；无 score 无 items → 丢弃', () => {
    const [s] = normalizeDeliverableSections([{ type: 'gauge', score: '66' }]);
    assert.equal((s as any).score, 66);
    assert.equal(normalizeDeliverableSections([{ type: 'gauge', verdict: '只有评语' }]).length, 0);
  });

  test('matrix：quads 补齐到 4；非法 tone 剔除；轴标签成对', () => {
    const [s] = normalizeDeliverableSections([{ type: 'matrix', xLabels: ['对内', '对外'], yLabels: ['有利', '不利'], quads: [
      { title: '优势', tone: '机会', items: ['品牌立住'] },
      { title: '劣势', tone: '瞎写', items: ['亏损店'] },
    ] }]);
    assert.equal(s.type, 'matrix');
    assert.equal((s as any).quads.length, 4); // 补齐到 4
    assert.equal((s as any).quads[0].tone, '机会');
    assert.equal((s as any).quads[1].tone, undefined); // 非法 tone 剔除
    assert.deepEqual((s as any).xLabels, ['对内', '对外']);
    assert.equal((s as any).quads[2].title, ''); // 补齐的空象限
  });

  test('matrix：quads 截断到 4；全空 → 丢弃', () => {
    const [s] = normalizeDeliverableSections([{ type: 'matrix', quads: [
      { title: 'A', items: [] }, { title: 'B', items: [] }, { title: 'C', items: [] }, { title: 'D', items: [] }, { title: 'E', items: [] },
    ] }]);
    assert.equal((s as any).quads.length, 4);
    assert.equal(normalizeDeliverableSections([{ type: 'matrix', quads: [{}, {}] }]).length, 0);
  });

  test('gantt：from>to 交换；total 缺省取最大 to；unit 校验；数字 coerce', () => {
    const [s] = normalizeDeliverableSections([{ type: 'gantt', unit: '旬', rows: [
      { label: '止血', from: 3, to: 1, tone: '风险', note: '关店' }, // from>to → 交换
      { label: '探路', from: '2', to: '5' }, // 字符串 coerce
    ] }]);
    assert.equal(s.type, 'gantt');
    assert.equal((s as any).unit, '旬');
    assert.equal((s as any).rows[0].from, 1);
    assert.equal((s as any).rows[0].to, 3);
    assert.equal((s as any).rows[0].tone, '风险');
    assert.equal((s as any).rows[1].to, 5);
    assert.equal((s as any).total, 5); // 缺省取最大 to
  });

  test('gantt：非法 unit 归 undefined；total 过小抬到最大 to；无行 → 丢弃', () => {
    const [s] = normalizeDeliverableSections([{ type: 'gantt', unit: '年', total: 2, rows: [{ label: 'x', from: 1, to: 6 }] }]);
    assert.equal((s as any).unit, undefined);
    assert.equal((s as any).total, 6);
    assert.equal(normalizeDeliverableSections([{ type: 'gantt', rows: [{ from: 1, to: 2 }] }]).length, 0); // 无 label
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

  test('gauge 渲染 SVG 弧盘 + 中央大数字 + 分项横条', () => {
    const html = renderReportHtml(base([{ type: 'gauge', h: '经营体检', score: 72, verdict: '底子稳', items: [{ label: '现金流', score: 46, note: '偏紧' }] }]));
    assert.match(html, /class="gauge"/);
    assert.match(html, /<svg class="gauge-svg"/);
    assert.match(html, /class="gauge-num"[^>]*>72</);
    assert.match(html, /底子稳/);
    assert.match(html, /class="gi-fill" style="width:46%/);
    assert.match(html, /偏紧/);
  });

  test('gauge 分数分档配色（≥80金 / <40赭赤）', () => {
    const hi = renderReportHtml(base([{ type: 'gauge', score: 90, items: [] }]));
    assert.match(hi, /class="gauge-num" fill="var\(--gold\)"/);
    const lo = renderReportHtml(base([{ type: 'gauge', score: 20, items: [] }]));
    assert.match(lo, /class="gauge-num" fill="var\(--risk\)"/);
  });

  test('matrix 渲染 2×2 直角格 + tone 色块 + 轴标签', () => {
    const html = renderReportHtml(base([{ type: 'matrix', xLabels: ['对内', '对外'], yLabels: ['有利', '不利'], quads: [
      { title: '优势', tone: '机会', items: ['品牌立住'] },
      { title: '机会', tone: '时机', items: ['旺季'] },
      { title: '劣势', items: ['亏损店'] },
      { title: '威胁', tone: '布局', items: ['强敌'] },
    ] }]));
    assert.match(html, /class="mx-grid"/);
    assert.match(html, /class="mx-dot win"/); // 机会 → win 金
    assert.match(html, /class="mx-axis mx-ytop">有利</);
    assert.match(html, /class="mx-axis mx-xleft">对内</);
    assert.match(html, /品牌立住/);
  });

  test('gantt 渲染刻度行 + 按 from/to 定位色条', () => {
    const html = renderReportHtml(base([{ type: 'gantt', unit: '周', total: 8, rows: [
      { label: '止血', from: 1, to: 2, tone: '风险', note: '关店' },
      { label: '首店', from: 4, to: 6, tone: '行动' },
    ] }]));
    assert.match(html, /class="gantt"/);
    assert.match(html, /class="gt-tick">8</); // 刻度到 8
    assert.match(html, /class="g-bar risk" style="left:0.000%;width:25.000%/);
    assert.match(html, /class="g-bar order" style="left:37.500%;width:37.500%/);
    assert.match(html, /class="gb-note">关店</);
  });

  test('三新型脏数据不 crash', () => {
    assert.doesNotThrow(() => renderReportHtml(base([
      { type: 'gauge' } as any, { type: 'matrix' } as any, { type: 'gantt' } as any,
    ])));
  });

  test('节奏：章节隔断带（汉字序号）+ 交替底色（偶数章 alt）', () => {
    const html = renderReportHtml(base([
      { type: 'stats', h: '家底', items: [{ num: '12', label: '门店' }] },
      { type: 'table', h: '三城对比', headers: ['a'], rows: [['b']] },
    ]));
    assert.match(html, /class="sec-divider"><span class="sec-num serif">壹</); // 隔断带
    assert.match(html, /class="chapter">/); // 壹（奇）不带 alt
    assert.match(html, /class="chapter alt">/); // 贰（偶）带 alt
  });

  test('节奏：白卡正文数字强调（第N周 / N万 / N%），年份/长串不动', () => {
    const html = renderReportHtml(base([{ h: '节奏', b: '第 3 周月流水 240 万，增长 12%，2026 年立项，电话 13800001111。' }]));
    assert.match(html, /<span class="num-emph">第 3 周<\/span>/);
    assert.match(html, /<span class="num-emph">240 万<\/span>/);
    assert.match(html, /<span class="num-emph">12%<\/span>/);
    assert.doesNotMatch(html, /class="num-emph">2026/); // 年份不强调
    assert.doesNotMatch(html, /class="num-emph">13800001111/); // 电话不强调
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

describe('renderReportHtml · 行内强调标记', () => {
  test('**加粗** / ==金底高亮== / !!朱红警示!! / ##大字强调## 渲染为对应标签', () => {
    const html = renderReportHtml(base([{ h: '打法', b: '先**止血**，==把现金流稳住==，切忌 !!盲目扩张!!，记住 ##现金为王##。' }]));
    assert.match(html, /<strong>止血<\/strong>/);
    assert.match(html, /<span class="mark-hl">把现金流稳住<\/span>/);
    assert.match(html, /<span class="mark-risk">盲目扩张<\/span>/);
    assert.match(html, /<span class="mark-big serif">现金为王<\/span>/);
  });

  test('列表/callout/letter/quote 正文同样支持标记', () => {
    const html = renderReportHtml(base([
      { h: '要点', list: ['**关店**两家', '==保住老店=='] },
      { type: 'callout', tone: '风险', h: '警讯', b: '!!资金链!!承压' },
      { type: 'quote', text: '==谋定而后动==', cite: '孙子' },
      { type: 'letter', paras: ['老板**放心**'], close: '盼复' },
    ]));
    assert.match(html, /<li><strong>关店<\/strong>两家<\/li>/);
    assert.match(html, /<span class="mark-hl">保住老店<\/span>/);
    assert.match(html, /<span class="mark-risk">资金链<\/span>承压/);
    assert.match(html, /<span class="mark-hl">谋定而后动<\/span>/);
    assert.match(html, /<strong>放心<\/strong>/);
  });

  test('标题字段剥标记：不渲染也不露原始符号', () => {
    const html = renderReportHtml(base([{ h: '**主要矛盾**', sub: '==副题==', b: '正文' }]));
    assert.match(html, /class="sec-title">主要矛盾</);
    assert.match(html, /class="sec-sub">副题</);
    assert.doesNotMatch(html, /class="sec-title">\*\*/);
  });

  test('标记内内容仍走转义（防注入），未闭合标记原样保留', () => {
    const html = renderReportHtml(base([{ h: 'x', b: '==<script>alert(1)</script>== 与 **未闭合' }]));
    assert.match(html, /<span class="mark-hl">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/span>/);
    assert.match(html, /\*\*未闭合/);
    assert.doesNotMatch(html, /<script>alert/);
  });

  test('数字强调与行内标记共存', () => {
    const html = renderReportHtml(base([{ h: 'x', b: '**第 3 周**动手，==回款 600 万==' }]));
    assert.match(html, /<strong><span class="num-emph">第 3 周<\/span><\/strong>/);
    assert.match(html, /<span class="mark-hl">回款 <span class="num-emph">600 万<\/span><\/span>/);
  });
});

// —— 坏形态自愈：模型把整个「类型化 section 数组」序列化成字符串，塞进 sections 字段或单个白卡的 b。
//    生产 deliverable cmryglnln00s7f5vcyzh4up99 即此形态，此前满屏显示转义 JSON。 ——
describe('normalizeDeliverableSections · 字符串化 section 数组自愈', () => {
  // 与生产坏数据同形态：完整类型化数组（hero/gantt/stats/callout + 转义中文）被序列化成一个字符串。
  const typedArray = [
    { type: 'hero', h: '定调：创始人 IP', paras: ['从定位到启动，三十天见效。', '先立人设，再谈流量。'] },
    { type: 'gantt', h: '三十天启动日历', unit: '周', total: 4, rows: [
      { label: '定位打磨', from: 1, to: 1, tone: '布局' },
      { label: '内容起量', from: 2, to: 4, tone: '行动', note: '日更三条' },
    ] },
    { type: 'stats', h: '关键指标', items: [{ num: '30', unit: '天', label: '启动周期' }, { num: '3', label: '每日更新' }] },
    { type: 'callout', tone: '风险', h: '避坑', b: '切忌一上来就投流，先跑通自然流量口碑。' },
  ];

  test('形态 A：sections 字段本身是字符串化数组 → 展开成多个类型化 section', () => {
    const out = normalizeDeliverableSections(JSON.stringify(typedArray));
    assert.equal(out.length, 4);
    assert.deepEqual(out.map((s) => s.type), ['hero', 'gantt', 'stats', 'callout']);
    assert.equal((out[1] as any).rows.length, 2);
    assert.equal((out[3] as any).tone, '风险');
    // 断言没有任何一段把整串 JSON 当正文塞进 b
    for (const s of out) assert.ok(!(s.b ?? '').includes('"type"'), 'b 不应残留原始 JSON');
  });

  test('形态 B（生产同形态）：sections=[{b: "<字符串化数组>"}] → 展开成多个类型化 section', () => {
    const bad = [{ b: JSON.stringify(typedArray) }];
    const out = normalizeDeliverableSections(bad);
    assert.equal(out.length, 4);
    assert.deepEqual(out.map((s) => s.type), ['hero', 'gantt', 'stats', 'callout']);
    assert.equal((out[0] as any).paras[0], '从定位到启动，三十天见效。');
    assert.equal((out[2] as any).items[0].label, '启动周期');
  });

  test('形态 B 变体：白卡带 h，b 是字符串化数组 → 仍展开（h 被丢弃换成真实 section）', () => {
    const bad = [{ h: '正文', b: JSON.stringify(typedArray) }];
    const out = normalizeDeliverableSections(bad);
    assert.equal(out.length, 4);
    assert.equal(out[0].type, 'hero');
  });

  test('宽松修复：尾随逗号可容忍', () => {
    const withTrailingComma = '[{"type":"callout","tone":"机会","h":"a","b":"b",},]';
    const out = normalizeDeliverableSections(withTrailingComma);
    assert.equal(out.length, 1);
    assert.equal(out[0].type, 'callout');
    assert.equal((out[0] as any).tone, '机会');
  });

  test('宽松修复：生产实证「键值分隔符损坏」——两个 gantt 其一 "rows">[ 其一正常', () => {
    // 与生产 cmryglnln00s7f5vcyzh4up99 一致的损坏形态：一条 section 数组字符串内含两个 gantt，
    // 第二个的分隔符是 "rows">[ 而非 "rows":[，整体又包在 [{b:"..."}] 白卡里。
    const good = '{"type":"gantt","h":"排期一","unit":"周","total":4,"rows":[{"label":"起步","from":1,"to":2}]}';
    const broken = '{"type":"gantt","h":"排期二","unit":"周","total":6,"rows">[{"label":"扩张","from":3,"to":6}]}';
    const bad = [{ b: `[${good},${broken}]` }];
    const out = normalizeDeliverableSections(bad);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((s) => s.type), ['gantt', 'gantt']);
    assert.equal((out[0] as any).rows.length, 1);
    assert.equal((out[1] as any).rows.length, 1);
    assert.equal((out[1] as any).rows[0].label, '扩张');
    assert.equal((out[1] as any).rows[0].to, 6);
  });

  test('损坏到无法解析 → 按普通文本兜底为白卡，绝不抛异常', () => {
    const broken = '[{"type":"stats","rows">[坏掉的键值分隔符导致无法解析';
    const out = normalizeDeliverableSections(broken);
    // 解析失败：整串作为白卡正文保留，不丢内容、不抛错
    assert.equal(out.length, 1);
    assert.ok((out[0].b ?? '').startsWith('[{'));
  });

  test('正常 sections 幂等：不误伤合法类型化数组', () => {
    const once = normalizeDeliverableSections(typedArray);
    const twice = normalizeDeliverableSections(once);
    assert.deepEqual(twice, once);
    assert.equal(twice.length, 4);
  });

  test('普通白卡正文以 [ 开头但非类型化数组 → 不误判', () => {
    const out = normalizeDeliverableSections([{ h: '清单', b: '[国内, 海外] 两条线并行推进' }]);
    assert.equal(out.length, 1);
    assert.equal(out[0].b, '[国内, 海外] 两条线并行推进');
  });
});

describe('healDeliverableSections · 读取端自愈', () => {
  const typedArray = [
    { type: 'hero', h: '定调', paras: ['一段。'] },
    { type: 'gantt', h: '排期', unit: '周', total: 3, rows: [{ label: '起步', from: 1, to: 3 }] },
  ];

  test('展开 contentJson 里字符串化的 sections，保留其余顶层字段', () => {
    const stored = {
      icon: 'spark', meta: 'x', title: '创始人IP打造方案',
      sections: [{ b: JSON.stringify(typedArray) }],
      trust: '参考', cdnUrl: 'https://x', htmlUrl: 'https://y', actions: ['save_to_library'],
    };
    const healed = healDeliverableSections(stored);
    assert.equal(healed.sections.length, 2);
    assert.deepEqual(healed.sections.map((s: any) => s.type), ['hero', 'gantt']);
    // 其余顶层字段原样保留
    assert.equal(healed.title, '创始人IP打造方案');
    assert.equal(healed.cdnUrl, 'https://x');
    assert.equal(healed.actions[0], 'save_to_library');
  });

  test('非对象/无 sections 字段 → 原样返回，不抛异常', () => {
    assert.equal(healDeliverableSections(null), null);
    assert.equal(healDeliverableSections('x' as any), 'x');
    assert.deepEqual(healDeliverableSections({ title: 'a' } as any), { title: 'a' });
  });
});
