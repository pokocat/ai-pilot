import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestUploadName, displayUploadName, inferUploadNameFromContent, isPlaceholderUploadName, isTemporaryUploadName, sanitizeUploadName } from '../src/services/uploadName.ts';

test('原始名原样保留（中文 + 扩展名）', () => {
  assert.equal(sanitizeUploadName('3月经营流水表.xlsx'), '3月经营流水表.xlsx');
});

test('空/undefined → 空串（供路由回退 data.filename）', () => {
  assert.equal(sanitizeUploadName(''), '');
  assert.equal(sanitizeUploadName(undefined), '');
  assert.equal(sanitizeUploadName(null), '');
});

test('去路径分隔符（防止把目录段当文件名）', () => {
  assert.equal(sanitizeUploadName('a/b\\c.pdf'), 'a b c.pdf');
});

test('去控制字符（防注入/乱码）', () => {
  assert.equal(sanitizeUploadName('re\u0001\tport.pdf'), 'report.pdf');
});

test('折叠多余空白', () => {
  assert.equal(sanitizeUploadName('  报告   终稿 .pdf '), '报告 终稿 .pdf');
});

test('过长截断但保留扩展名', () => {
  const long = 'x'.repeat(200) + '.docx';
  const out = sanitizeUploadName(long);
  assert.ok(out.length <= 120, `长度应 ≤120，实际 ${out.length}`);
  assert.ok(out.endsWith('.docx'), '应保留扩展名');
});

test('无扩展名的超长串也截断', () => {
  const out = sanitizeUploadName('y'.repeat(300));
  assert.ok(out.length <= 120);
});

test('历史临时文件名改用可读展示名', () => {
  assert.equal(displayUploadName('tmp_96dcc14c0eac14aaa9d1987640cd6112bbc06'), '待识别资料');
  assert.equal(displayUploadName('tmp_96dcc14c0eac14aaa9d1987640cd6112bbc06', '内容IP资料'), '内容IP资料');
  assert.equal(displayUploadName('3月经营流水表.xlsx'), '3月经营流水表.xlsx');
  assert.equal(isTemporaryUploadName('wxfile://tmp/abc'), true);
  assert.equal(isTemporaryUploadName('商业计划书.docx'), false);
  assert.equal(isPlaceholderUploadName('上传资料'), true);
  assert.equal(isPlaceholderUploadName('growth资料'), true);
  assert.equal(bestUploadName('上传资料', '商业计划书.docx'), '商业计划书.docx');
});

test('源名丢失时可从 Markdown 首标题生成明确的识别名', () => {
  assert.equal(inferUploadNameFromContent('# 主理人公社交互逻辑\n\n正文', 'md'), '主理人公社交互逻辑.md');
  assert.equal(inferUploadNameFromContent('没有 Markdown 标题的正文', 'txt'), '');
});
