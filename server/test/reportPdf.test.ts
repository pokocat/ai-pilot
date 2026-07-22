// 报告 PDF：test 桩（绝不拉真浏览器）、缓存 key 推导、Content-Disposition、路由 200/404。
//   cd server && node --env-file=.env.test --import tsx --test test/reportPdf.test.ts
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { getApp, closeApp } from './helpers.ts';
import { prisma } from '../src/db.ts';
import { htmlToPdf, isPdfTestMode, reportPdfKey, pdfContentDisposition } from '../src/services/reportPdf.ts';
import { renderReportHtml } from '../src/services/reportHtml.ts';

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

describe('reportPdf 服务（纯函数）', () => {
  test('test 环境走桩：返回最小合法 PDF Buffer，绝不 launch 浏览器', async () => {
    assert.equal(isPdfTestMode(), true);
    const buf = await htmlToPdf('<html><body>hi</body></html>');
    assert.ok(Buffer.isBuffer(buf));
    assert.ok(buf.toString('latin1').startsWith('%PDF-1.4'));
  });

  test('缓存 key 确定性推导：{prefix?}pdf/{id}-long.pdf（单页长 PDF 版本位，与旧分页缓存分离）', () => {
    // 测试环境未配 OSS 前缀 → 无前缀。-long 后缀确保旧分页版 pdf/{id}.pdf 不会被命中。
    assert.equal(reportPdfKey('abc123'), 'pdf/abc123-long.pdf');
  });

  test('Content-Disposition：UTF-8 文件名 + 纯 ASCII 兜底', () => {
    const cd = pdfContentDisposition('战略诊断报告');
    assert.match(cd, /^attachment;/);
    assert.match(cd, /filename="[\x20-\x7E]*\.pdf"/); // 兜底纯 ASCII
    assert.match(cd, /filename\*=UTF-8''/);
    assert.match(cd, new RegExp(encodeURIComponent('战略诊断报告·军师参谋部.pdf').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

describe('GET /api/r/:id/pdf', () => {
  test('存在的报告 → 200 application/pdf + %PDF + 下载头', async () => {
    const app = await getApp();
    const html = renderReportHtml({
      title: '战略诊断报告', icon: 'target', meta: '甲公司',
      sections: [{ h: '主要矛盾', b: '现金流紧张。' }], trust: '仅供参考。', actions: [],
    });
    const row = await prisma.reportHtml.create({ data: { tenantId: null, title: '战略诊断报告', html } });
    const res = await app.inject({ method: 'GET', url: `/api/r/${row.id}/pdf` });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /application\/pdf/);
    assert.match(res.headers['content-disposition'] as string, /attachment;/);
    assert.match(res.headers['content-disposition'] as string, /filename\*=UTF-8''/);
    assert.ok(Buffer.from(res.rawPayload).toString('latin1').startsWith('%PDF'));
    await prisma.reportHtml.delete({ where: { id: row.id } });
  });

  test('不存在的 id → 404', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/r/nonexistent-id-xyz/pdf' });
    assert.equal(res.statusCode, 404);
  });
});
