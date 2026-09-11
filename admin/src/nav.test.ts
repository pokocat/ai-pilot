// 导航模型：产品视角过滤 + 分组容量。
//
// 2026-09-11 加产品视角时补的。这套过滤最容易出的错不是「漏过滤」而是「过滤过头」——
// 把一屏错标成某产品专属，就从别人眼前彻底消失了，而且没有任何报错。
// 所以下面几条盯的是边界本身，不是某一屏好不好看。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAV_GROUPS, NAV_SECTIONS, inScope, scopeOptions, sectionsOf, visibleGroups, findSection,
  type NavSection,
} from './nav';

const keys = (list: NavSection[]) => list.map((s) => s.key).sort();

test('不标 products = 公共面，三种视角下都在', () => {
  const shared = NAV_SECTIONS.filter((s) => !s.products);
  assert.ok(shared.length > 0, '一个公共面都没有的话这套模型就没意义了');
  for (const s of shared) {
    for (const scope of ['all', 'junshi', 'quickreel'] as const) {
      assert.equal(inScope(s, scope), true, `${s.key} 是公共面，${scope} 视角下不该被过滤掉`);
    }
  }
});

test('全部视角不过滤任何一屏', () => {
  for (const s of NAV_SECTIONS) assert.equal(inScope(s, 'all'), true, s.key);
});

test('产品专属面只在自己的视角里出现', () => {
  const agent = findSection('agent')!;
  assert.equal(inScope(agent, 'junshi'), true);
  assert.equal(inScope(agent, 'quickreel'), false, '顾问调教是军师的，爱速拍视角不该看见');
});

// 钱包是一个、账号中心是一个、审计是一处 —— 这几屏被错标成某产品专属的话，
// 另一边的运营就查不了账、找不了人。它们是「后台只做一个」这件事的地基。
test('共享面不许被标成某产品专属', () => {
  for (const k of ['users', 'payments', 'usage', 'tokens', 'products', 'audit', 'model', 'account', 'home']) {
    const s = findSection(k);
    assert.ok(s, `${k} 不见了`);
    assert.equal(s!.products, undefined, `${k} 是共享面（一个钱包 / 一个账号中心 / 一处审计），不该打产品标`);
  }
});

test('爱速拍视角下仍然能查账、找人、看审计', () => {
  const all = NAV_GROUPS.flatMap((g) => sectionsOf(g.key, true, 'quickreel'));
  for (const k of ['users', 'payments', 'usage', 'products', 'audit', 'account']) {
    assert.ok(all.some((s) => s.key === k), `${k} 在爱速拍视角下消失了`);
  }
});

test('爱速拍视角下看不到军师的内容调教', () => {
  const studio = sectionsOf('studio', true, 'quickreel');
  assert.deepEqual(keys(studio), [], '智能体整组都是军师的，爱速拍视角下该整组消失');
  assert.ok(!visibleGroups(true, 'quickreel').some((g) => g.key === 'studio'), '空组不该还占着导航位');
  assert.ok(visibleGroups(true, 'junshi').some((g) => g.key === 'studio'));
});

// 克隆定价 2026-09-11 一度拆成独立分区，同轮又连同其余爱速拍运营屏一起撤回
// （爱速拍要单独做自己的控制台）。它现在还在「功能开关」页里，命令面板得搜得到。
test('命令面板搜「克隆定价」要能命中「功能开关」', () => {
  const flags = findSection('flags')!;
  assert.ok(flags.hint.includes('克隆'), '页头副标题不提的话，那段配置只能靠滚页面撞见');
  assert.ok((flags.aliases ?? []).includes('克隆定价'));
  assert.ok((flags.aliases ?? []).includes('数字人'));
});

// DESIGN.md：一组超 ~8 项就得拆组（底栏 8 格 flex 均分，组内 segmented 也会挤）。
// 加产品视角后这条规则的正确说法变了 —— 要守的是**每个视角下**一组不超 8 项，
// 而不是所有视角叠加后的总数。运营任何时候看到的都是某一个视角。
test('每个视角下，每组都不超过 8 项', () => {
  for (const scope of ['all', 'junshi', 'quickreel'] as const) {
    for (const g of NAV_GROUPS) {
      const n = sectionsOf(g.key, true, scope).length;
      assert.ok(n <= 8, `${scope} 视角下「${g.label}」有 ${n} 项，超过 8 项该拆组了`);
    }
  }
});

test('每个视角下都至少有一组可见 —— 不会切出一个空后台', () => {
  for (const scope of ['all', 'junshi', 'quickreel'] as const) {
    assert.ok(visibleGroups(true, scope).length > 0, `${scope} 视角下一组都不剩`);
    assert.ok(visibleGroups(false, scope).length > 0, `${scope} 视角下普通运营一组都不剩`);
  }
});

test('每一屏都至少属于一个视角 —— 不会有谁都看不见的孤儿页', () => {
  for (const s of NAV_SECTIONS) {
    const seen = (['junshi', 'quickreel'] as const).some((c) => inScope(s, c));
    assert.ok(seen, `${s.key} 在两个产品视角下都不可见，只有「全部」能找到它`);
  }
});

// 爱速拍的四屏运营面（出片对账 / 供应商 / 模板货架 / 爱速拍定价）2026-09-11 撤出了这个后台 ——
// 它要单独做自己的控制台。所以现在爱速拍视角下**一个专属屏都没有**，只剩共享面。
// 这不是坏事，但要写明白：否则下次有人看见「爱速拍视角好空」会以为是过滤写错了。
test('爱速拍视角现在只剩共享面，没有专属屏', () => {
  const own = NAV_SECTIONS.filter((s) => s.products?.includes('quickreel'));
  assert.deepEqual(own, [], '爱速拍的运营面已经撤出这个后台，改在它自己的控制台里做');
  // 但视角本身仍然有用：它把军师专属的那些屏过滤掉
  assert.ok(visibleGroups(true, 'quickreel').length < visibleGroups(true, 'junshi').length);
});

// —— 可选视角 ——
// 这不是权限：服务端的 requireProductAccess 才是。但给一个只被授权爱速拍的运营
// 摆上「军师」和「全部」，切过去每屏都 403，看起来像后台坏了。
test('超管拿全部视角', () => {
  assert.deepEqual(scopeOptions(['junshi', 'quickreel'], true), ['all', 'junshi', 'quickreel']);
});

test('只被授权一个产品的运营：不给「全部」，也不给别人的产品', () => {
  assert.deepEqual(scopeOptions(['quickreel'], false), ['quickreel']);
});

test('被授权两个产品的运营：给「全部」', () => {
  assert.deepEqual(scopeOptions(['junshi', 'quickreel'], false), ['all', 'junshi', 'quickreel']);
});

test('权限还没读回来时不塌成空数组 —— 选择器要么不渲染，要么给个能用的默认', () => {
  assert.deepEqual(scopeOptions([], false), ['all']);
  assert.deepEqual(scopeOptions([], true), ['all']);
});

test('服务端冒出后台不认识的产品码时，静默忽略而不是崩', () => {
  // 服务端加了新产品、前端还没跟上发版时的真实情形
  assert.deepEqual(scopeOptions(['junshi', 'newthing'], true), ['all', 'junshi']);
});
