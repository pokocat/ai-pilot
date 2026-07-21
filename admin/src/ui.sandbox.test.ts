// 回归测试：调教沙盒（StudioSandbox）的结构化产出预览不能对报告 V2 的 9 种类型化 section 静默剥空。
// 根因：shared/contracts.d.ts 的 DeliverableSection 判别联合把 h/b/list 以「可选」形式挂在所有变体的
// 公共基上——这只保证类型层面兼容（旧代码读 s.h/s.b/s.list 能通过类型检查），不代表运行时这些字段真的
// 有值。stats/roster/table/phases/timeline 的实际内容在 items/people/rows 等专属字段；quote/letter
// 干脆没有 h。ui.tsx 的 DeliverableView 曾直接读 s.h/s.b/s.list，导致操作员在「调教沙盒」试跑时，
// 除 hero/callout 外的 7 种类型几乎全部渲染成空白（quote/letter 甚至连标题都没有），据此“满意再发布”
// 就是盲发。sandboxSection() 是修复后的映射函数（与 app/src/components/ReportCard 的 cardSection 同口径），
// 覆盖全部 9 种类型 + 旧版白卡 + 未知 type 降级，任何一种都必须有可见内容。
//   cd admin && npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxSection } from './ui.js';
import type { DeliverableSection } from '../../shared/contracts';

describe('sandboxSection · 报告 V2 类型化 section 在沙盒预览里不能被剥空', () => {
  test('hero：标题 + paras 合并进 b，不再只有空标题', () => {
    const v = sandboxSection({ type: 'hero', h: '定调', paras: ['第一段', '第二段'] } as DeliverableSection);
    assert.equal(v.h, '定调');
    assert.equal(v.b, '第一段\n\n第二段');
  });

  test('callout：h/b 本就是直接字段，且带 tone 前缀', () => {
    const v = sandboxSection({ type: 'callout', tone: '风险', h: '4 家在亏钱', b: '要先止血' } as DeliverableSection);
    assert.equal(v.h, '【风险】4 家在亏钱');
    assert.equal(v.b, '要先止血');
  });

  test('stats：items 必须映射进 list，不能因 s.list 为 undefined 而整段消失', () => {
    const v = sandboxSection({ type: 'stats', h: '你的家底', items: [{ num: '240', unit: '万', label: '月流水' }] } as DeliverableSection);
    assert.equal(v.h, '你的家底');
    assert.deepEqual(v.list, ['240万 · 月流水']);
  });

  test('stats 缺 h：仍要有兜底标题，不是空白', () => {
    const v = sandboxSection({ type: 'stats', items: [{ num: '12', label: '门店' }] } as DeliverableSection);
    assert.equal(v.h, '关键数据');
  });

  test('roster：intro 进 b，people 进 list', () => {
    const v = sandboxSection({
      type: 'roster', intro: '核心班底', people: [{ name: '周慎', role: '管账', desc: '稳' }],
    } as DeliverableSection);
    assert.equal(v.b, '核心班底');
    assert.deepEqual(v.list, ['周慎（管账）：稳']);
  });

  test('table：headers + rows（含 trend 单元格）必须能在 list 里看到', () => {
    const v = sandboxSection({
      type: 'table', headers: ['维度', '青州'], rows: [['判断', { text: '首取', trend: 'up' }]],
    } as DeliverableSection);
    assert.deepEqual(v.list, ['维度 / 青州', '判断 / 首取']);
  });

  test('phases：每阶段的 tab/h/when/actions/kpi 全部要能看到', () => {
    const v = sandboxSection({
      type: 'phases',
      items: [{ tab: '第一阶段', h: '止血固本', when: '两个月内', actions: ['关店', '理账'], kpi: '不再亏损' }],
    } as DeliverableSection);
    assert.deepEqual(v.list, ['〔第一阶段〕止血固本 · 两个月内', '· 关店', '· 理账', '军令状：不再亏损']);
  });

  test('timeline：when/h/d 必须能看到，不是空节点', () => {
    const v = sandboxSection({
      type: 'timeline', items: [{ when: '9月', h: '出城期', d: '关键一步', highlight: true }],
    } as DeliverableSection);
    assert.deepEqual(v.list, ['9月　出城期：关键一步']);
  });

  test('quote：修复前完全没有 h，整节渲染成空 div；修复后标题+正文都要有内容', () => {
    const v = sandboxSection({ type: 'quote', text: '贪三城之名者失一城', cite: '军师谨识' } as DeliverableSection);
    assert.equal(v.h, '金句');
    assert.match(v.b ?? '', /贪三城之名者失一城/);
    assert.match(v.b ?? '', /军师谨识/);
  });

  test('letter：修复前完全没有 h，正文各段落也拼不出来；修复后要能看到全部内容', () => {
    const v = sandboxSection({
      type: 'letter', salute: '老板台鉴', paras: ['其一'], close: '可安心落子', sign: '军师 顿首',
    } as DeliverableSection);
    assert.equal(v.h, '军师手书');
    assert.equal(v.b, '老板台鉴\n\n其一\n\n可安心落子\n\n军师 顿首');
  });

  test('向后兼容：旧版白卡（无 type）原样透传 h/b/list', () => {
    const v = sandboxSection({ h: '主要矛盾', b: '现金流紧张', list: ['聚焦头部客户'] } as DeliverableSection);
    assert.equal(v.h, '主要矛盾');
    assert.equal(v.b, '现金流紧张');
    assert.deepEqual(v.list, ['聚焦头部客户']);
  });

  test('未知 type（存量脏数据）→ 优雅降级，不抛异常', () => {
    assert.doesNotThrow(() => sandboxSection({ type: 'mystery', h: '未来类型', b: '正文' } as unknown as DeliverableSection));
    const v = sandboxSection({ type: 'mystery', h: '未来类型', b: '正文' } as unknown as DeliverableSection);
    assert.equal(v.h, '未来类型');
    assert.equal(v.b, '正文');
  });
});
