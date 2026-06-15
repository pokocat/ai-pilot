// 报告 HTML 渲染单元测试(纯函数,不连库)。
//   cd server && node --import tsx --test test/reportHtml.test.ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderReportHtml } from '../src/llm/../services/reportHtml.js';
import type { Deliverable } from '../src/llm/schema.js';

const D: Deliverable = {
  title: '战略诊断报告', icon: 'target', meta: '甲公司 · 餐饮 · A轮',
  sections: [
    { h: '主要矛盾', b: '现金流紧张。\n复购不足。' },
    { h: '行动建议', list: ['聚焦头部客户', '砍掉低效渠道'] },
  ],
  trust: '本成果供决策参考。', actions: ['save_to_library'],
};

describe('renderReportHtml', () => {
  test('含 title/meta/各 section/trust,合法 HTML 文档', () => {
    const html = renderReportHtml(D);
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /战略诊断报告/);
    assert.match(html, /甲公司 · 餐饮 · A轮/);
    assert.match(html, /主要矛盾/);
    assert.match(html, /现金流紧张。<br>复购不足。/); // 换行转 <br>
    assert.match(html, /<li>聚焦头部客户<\/li>/);
    assert.match(html, /本成果供决策参考。/);
    assert.match(html, /军师 · JUNSHI/);
  });

  test('转义 HTML 特殊字符,防注入', () => {
    const html = renderReportHtml({ ...D, title: '<script>x</script>', sections: [{ h: 'a & b', b: '"q" <i>' }] });
    assert.doesNotMatch(html.split('<style>')[1] ?? html, /<script>x<\/script>/); // 标题被转义
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /a &amp; b/);
  });

  test('空 sections → 兜底卡片', () => {
    const html = renderReportHtml({ ...D, sections: [] });
    assert.match(html, /暂无内容/);
  });
});
