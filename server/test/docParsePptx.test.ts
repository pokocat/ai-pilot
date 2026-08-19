import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { detectDocType, parseDocument } from '../src/services/docParse.js';

test('PPTX 按页提取文本，供智库整理与检索使用', async () => {
  const archive = new JSZip();
  archive.file('ppt/slides/slide2.xml', '<p:sld><a:t>第二页</a:t><a:t>利润&amp;现金流</a:t></p:sld>');
  archive.file('ppt/slides/slide1.xml', '<p:sld><a:t>经营复盘</a:t><a:t>先守再攻</a:t></p:sld>');
  const buffer = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  assert.equal(detectDocType('经营复盘.pptx'), 'pptx');
  assert.equal(detectDocType('upload.bin', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'), 'pptx');
  const parsed = await parseDocument(buffer, '经营复盘.pptx');
  assert.equal(parsed.type, 'pptx');
  assert.equal(parsed.text, '第 1 页\n经营复盘\n先守再攻\n\n第 2 页\n第二页\n利润&现金流');
});

test('旧二进制 xls 不再进入无修复版本的解析链', () => {
  assert.equal(detectDocType('历史账本.xls', 'application/vnd.ms-excel'), null);
});

test('XLSX 在受限 worker 中提取单元格', async () => {
  const workbook = new JSZip();
  workbook.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  workbook.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  workbook.file('xl/workbook.xml', '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="现金流" sheetId="1" r:id="rId1"/></sheets></workbook>');
  workbook.file('xl/_rels/workbook.xml.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  workbook.file('xl/worksheets/sheet1.xml', '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>月份</t></is></c><c r="B1" t="inlineStr"><is><t>收入</t></is></c><c r="C1" t="inlineStr"><is><t>成本</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>1月</t></is></c><c r="B2"><v>128000</v></c><c r="C2"><v>86000</v></c></row></sheetData></worksheet>');
  const raw = await workbook.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const parsed = await parseDocument(raw, '经营数据.xlsx');
  assert.equal(parsed.type, 'xlsx');
  assert.match(parsed.text, /工作表：现金流/);
  assert.match(parsed.text, /月份\t收入\t成本/);
  assert.match(parsed.text, /1月\t128000\t86000/);
});
