import assert from 'node:assert/strict';
import test from 'node:test';
import { detectDocType, normalizeDocumentText } from '../src/services/docParse.js';

test('HTML 文件归一化后只有标题和正文，没有样式或脚本', () => {
  const text = normalizeDocumentText('<html><head><title>增长方案</title><style>body{color:red}</style></head><body><h1>增长策略</h1><p>先提升复购，再扩新客。</p><script>alert(1)</script></body></html>', 'html');
  assert.match(text, /增长方案/);
  assert.match(text, /先提升复购/);
  assert.doesNotMatch(text, /style|color:red|alert/);
});

test('Markdown 文件归一化后只保留可读文字', () => {
  const text = normalizeDocumentText('# 经营复盘\n\n**营收增长**，详见[本月数据](https://example.com)\n\n- 复购率提升', 'md');
  assert.equal(text, '经营复盘\n\n营收增长，详见本月数据\n\n复购率提升');
});

test('HTML 是可上传的文档格式', () => {
  assert.equal(detectDocType('增长方案.html'), 'html');
  assert.equal(detectDocType('增长方案.htm'), 'html');
});
