// 例行 QA 安全回归（2026-07-22）：casefile.ts / strategicProfile.ts 此前直接读
// `sec.h`/`sec.b`/`sec.list`，对报告 V2 类型化 section（hero/callout/stats/roster/table/
// phases/timeline/quote/letter）——真实内容在 items/people/rows 等专属字段——会静默剥空，
// 导致「认可方案 → 案卷/军令/风险锁/战略档案」这条核心执行闭环几乎失效。
// 断言：喂一份真实的报告 V2 typed-section 方案，extractOrders/extractRisks/firstJudgment/
// extractStrategicFacts 都能从中提取出实际内容，而不是空数组/错位的判断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractOrders, extractRisks, firstJudgment, type DeliverableInput } from '../src/services/casefile.ts';
import { extractStrategicFacts } from '../src/services/strategicProfile.ts';

// 报告 V2 typed sections（与 app/src/services/deliverableSection.test.ts 同构造，
// 故意让 hero 的判断段排在 quote 前面、callout 靠 tone 才带出「风险」语义、
// 行动项塞在 phases.items 而非任何 section 的裸 list 字段里——完整复现审计报告里的原始触发数据）。
const V2_PLAN = {
  title: '信任重建方案',
  sections: [
    { type: 'hero', h: '现状判断', paras: ['你的核心问题是信任证明断在转化前，不是流量不够。'] },
    { type: 'callout', tone: '风险', h: '扩张团队', b: '现在不要新增销售团队规模' },
    {
      type: 'phases', h: '90天行动计划',
      items: [{ tab: '第一周', h: '重做案例证明', actions: ['补充问卷', '限定 3 个主题投放'] }],
    },
    { type: 'quote', text: '信任是最贵的转化货币' },
  ],
} as unknown as DeliverableInput;

test('extractOrders：phases.items 的行动项能被提取（此前读裸 s.list 会拿到空数组）', () => {
  const orders = extractOrders(V2_PLAN);
  assert.ok(orders.length > 0, '90天行动计划的 phases 分节应产出至少 1 条军令');
  assert.ok(orders.some((o) => o.includes('重做案例证明')), `应包含 phases 的分步标题，实际=${JSON.stringify(orders)}`);
});

test('extractRisks：callout(tone=风险) 的风险语义能被识别（此前只读裸 h，缺 tone 前缀会漏判）', () => {
  const risks = extractRisks(V2_PLAN);
  assert.ok(risks.length > 0, 'tone=风险 的 callout 应被识别为风险分节');
  assert.ok(risks.some((r) => r.includes('新增销售团队')), `应包含 callout 正文，实际=${JSON.stringify(risks)}`);
});

test('firstJudgment：取 hero 的真实判断段落，而不是误取后面 callout 的风险原文', () => {
  const judgment = firstJudgment(V2_PLAN);
  assert.match(judgment, /信任证明/, `应取 hero 段落作为主判断，实际="${judgment}"`);
});

test('extractStrategicFacts：从 hero/callout 抽取战略事实字段不产生 undefined 污染', () => {
  const facts = extractStrategicFacts({
    title: '定位方案',
    sections: [
      { type: 'hero', h: '主要矛盾', paras: ['获客成本高于客单价的核心矛盾在信任链路断裂。'] },
    ],
  } as unknown as Parameters<typeof extractStrategicFacts>[0]);
  assert.equal(facts.mainContradiction, '获客成本高于客单价的核心矛盾在信任链路断裂。');
});
