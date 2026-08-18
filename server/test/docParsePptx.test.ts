import test from 'node:test';
import assert from 'node:assert/strict';
import XLSX from 'xlsx';
import { detectDocType, parseDocument } from '../src/services/docParse.js';

test('PPTX 按页提取文本，供智库整理与检索使用', async () => {
  const archive = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(archive, 'ppt/slides/slide2.xml', Buffer.from('<p:sld><a:t>第二页</a:t><a:t>利润&amp;现金流</a:t></p:sld>'));
  XLSX.CFB.utils.cfb_add(archive, 'ppt/slides/slide1.xml', Buffer.from('<p:sld><a:t>经营复盘</a:t><a:t>先守再攻</a:t></p:sld>'));
  const buffer = XLSX.CFB.write(archive, { fileType: 'zip', type: 'buffer' }) as Buffer;
  assert.equal(detectDocType('经营复盘.pptx'), 'pptx');
  assert.equal(detectDocType('upload.bin', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'pptx');
  const parsed = await parseDocument(buffer, '经营复盘.pptx');
  assert.equal(parsed.type, 'pptx');
  assert.equal(parsed.text, '第 1 页\n经营复盘\n先守再攻\n\n第 2 页\n第二页\n利润&现金流');
});
