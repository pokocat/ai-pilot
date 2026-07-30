// 回归测试：创作任务台必须如实呈现「本单实际走的排版引擎」。
//
// 为什么值得一个测试：AI 排版引擎失败会**自动回落**成模板出图 —— 任务成功、图也有、钱照扣，
// 任务台上一切全绿。于是「AI 排版在生产整天没生效」这件事只存在于服务端日志里（供应商降级
// degraded 已经踩过一次同样的坑）。engineTag / fallbackStat 是运营发现它的唯一入口，两个地方
// 一旦回归就是静默失明：
//   · engineTag：template_fallback 必须是警示色且带上 aiEngineError；老任务（null）不能被
//     冒充成「模板」——那会让回落率的分母失真；
//   · fallbackStat：分母只算判定过引擎的单（ai + template_fallback），分母 0 时不显示。
//   cd admin && npm test
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { engineTag, fallbackStat } from './views/creative.js';

type Job = Parameters<typeof engineTag>[0];
const job = (layoutEngine: string | null, rounds: number | null = null, aiEngineError?: string): Job =>
  ({ layoutEngine, rounds, ...(aiEngineError === undefined ? {} : { aiEngineError }) }) as Job;

describe('engineTag · 每行的排版引擎标签', () => {
  test('ai + rounds：显示轮数（2 = 一次成 + 强制打磨）', () => {
    const t = engineTag(job('ai', 2));
    assert.equal(t?.label, 'AI 排版 · 2轮');
    assert.equal(t?.cls, 'tag');
  });

  test('ai + rounds=3（修了一轮违规）也照实显示', () => {
    assert.equal(engineTag(job('ai', 3))?.label, 'AI 排版 · 3轮');
  });

  test('ai 但没记录轮数：仍要有标签，不能整个消失', () => {
    const t = engineTag(job('ai', null));
    assert.equal(t?.label, 'AI 排版');
    assert.equal(t?.cls, 'tag');
  });

  test('template：中性色「模板」', () => {
    const t = engineTag(job('template'));
    assert.equal(t?.label, '模板');
    assert.equal(t?.cls, 'tag off');
  });

  test('template_fallback：必须是警示色，且 title 带上回落原因原文', () => {
    const t = engineTag(job('template_fallback', null, 'measure_failed: 正文溢出 3 次'));
    assert.equal(t?.label, '回落模板');
    assert.equal(t?.cls, 'tag warn');
    assert.match(t?.title ?? '', /measure_failed: 正文溢出 3 次/);
  });

  test('template_fallback 缺原因：仍是警示色，title 说明未记录（不能静悄悄变中性）', () => {
    const t = engineTag(job('template_fallback'));
    assert.equal(t?.cls, 'tag warn');
    assert.match(t?.title ?? '', /未记录/);
  });

  test('null（老任务 / 未完成）：不显示标签，绝不冒充「模板」', () => {
    assert.equal(engineTag(job(null)), null);
  });

  test('未知取值（将来新引擎）：原样显示且中性，不假装是已知三种', () => {
    const t = engineTag(job('svg_v2'));
    assert.equal(t?.label, 'svg_v2');
    assert.equal(t?.cls, 'tag off');
  });
});

describe('fallbackStat · 本页 AI 回落率', () => {
  test('分母只算 ai + template_fallback：template / null 不稀释比例', () => {
    const s = fallbackStat([
      job('ai', 2), job('ai', 2), job('template_fallback'),
      job('template'), job('template'), job(null), job(null),
    ]);
    assert.deepEqual(s, { fallback: 1, total: 3, pct: 33 });
  });

  test('全是回落 = 100%（引擎名义上开着、实际全在出模板图）', () => {
    assert.deepEqual(fallbackStat([job('template_fallback'), job('template_fallback')]), { fallback: 2, total: 2, pct: 100 });
  });

  test('全成功 = 0%，仍要显示（0% 是「引擎在干活」的正面信号）', () => {
    assert.deepEqual(fallbackStat([job('ai', 2), job('ai', 3)]), { fallback: 0, total: 2, pct: 0 });
  });

  test('分母为 0（纯模板路径 / 只有老任务 / 空页）→ null，不显示瓷贴', () => {
    assert.equal(fallbackStat([]), null);
    assert.equal(fallbackStat([job('template'), job(null)]), null);
  });
});
