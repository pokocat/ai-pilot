import assert from 'node:assert/strict';
import test from 'node:test';
import { displayKnowledgePreview } from './knowledgePreview';

test('HTML 资料预览只保留可读标题与正文', () => {
  const preview = displayKnowledgePreview('<!doctype html><html><head><title>三城布局方案</title><style>.card{width:100%}</style></head><body><h1>三城布局</h1><p>先稳住核心市场，再验证第二增长曲线。</p></body></html>');
  assert.match(preview, /三城布局方案/);
  assert.match(preview, /先稳住核心市场/);
  assert.doesNotMatch(preview, /<style|width:100%|<!doctype/i);
});

test('普通文本保持原样，且预览长度受控', () => {
  assert.equal(displayKnowledgePreview('经营流水\n营收 100 万'), '经营流水\n营收 100 万');
  assert.equal(displayKnowledgePreview('123456', undefined, 4), '1234');
});

test('Markdown 资料只保留文本内容，不渲染原文件样式', () => {
  const preview = displayKnowledgePreview('# 经营复盘\n\n**营收增长**，详见[本月数据](https://example.com)\n\n- 复购率提升', 'md');
  assert.equal(preview, '经营复盘\n\n营收增长，详见本月数据\n\n复购率提升');
});
