// 公开报告页:GET /api/r/:id → 返回服务端渲染的 HTML(凭不可猜 id 访问,不鉴权,供分享/发朋友圈)。
// GET /api/r/:id/pdf → 同一份报告的单页长 PDF 下载（与网页等长、不分页；凭同一 id，公开；OSS 确定性 key 缓存，不动 DB schema）。
import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';
import { ossConfigured, ossGetBuffer, ossPutBuffer } from '../services/ossUpload.js';
import { htmlToPdf, isPdfTestMode, reportPdfKey, pdfContentDisposition, PdfUnavailableError } from '../services/reportPdf.js';

const NOT_FOUND_HTML = '<!DOCTYPE html><meta charset="utf-8"><body style="font-family:serif;text-align:center;padding:60px;color:#8a8170">报告不存在或已过期</body>';

// 报告标题：优先 report_html.title 行；缺失则从 HTML <title> 提取（去掉「 · 军师参谋部」后缀）；再兜底。
function reportTitle(title: string | null, html: string): string {
  const t = (title ?? '').trim();
  if (t) return t;
  const m = html.match(/<title>([^<]*)<\/title>/i);
  const raw = (m?.[1] ?? '').replace(/\s*·\s*军师参谋部\s*$/, '').trim();
  return raw || '战略报告';
}

export async function reportShareRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/r/:id', async (req, reply) => {
    const row = await prisma.reportHtml.findUnique({ where: { id: req.params.id } });
    if (!row) return reply.code(404).type('text/html; charset=utf-8').send(NOT_FOUND_HTML);
    return reply.type('text/html; charset=utf-8').send(row.html);
  });

  app.get<{ Params: { id: string } }>('/r/:id/pdf', async (req, reply) => {
    const row = await prisma.reportHtml.findUnique({ where: { id: req.params.id } });
    if (!row) return reply.code(404).type('text/html; charset=utf-8').send(NOT_FOUND_HTML);

    const key = reportPdfKey(row.id);
    let pdf: Buffer | null = null;

    // ① 命中 OSS 缓存则直接回传（走自有域名，便于微信 downloadFile 合法域名与文件名控制）。
    if (ossConfigured()) {
      try { pdf = await ossGetBuffer(key); } catch (err) {
        console.error('[reportPdf] OSS 读取失败,改为现生成:', (err as Error).message);
      }
    }

    // ② 未命中 → 现生成。
    if (!pdf) {
      try {
        pdf = await htmlToPdf(row.html);
      } catch (err) {
        if (err instanceof PdfUnavailableError) {
          req.log?.warn?.(`[reportPdf] 生成能力不可用: ${err.message}`);
          return reply.code(503).type('application/json; charset=utf-8')
            .send({ error: 'PDF_UNAVAILABLE', message: '报告导出暂不可用，请稍后再试或使用网页版' });
        }
        req.log?.error?.(`[reportPdf] 生成失败: ${(err as Error).message}`);
        return reply.code(500).type('application/json; charset=utf-8')
          .send({ error: 'PDF_FAILED', message: '报告导出失败，请稍后重试' });
      }
      // 生成成功且配了 OSS：异步回填缓存（不阻塞响应；test 桩不缓存）。
      if (pdf && ossConfigured() && !isPdfTestMode()) {
        ossPutBuffer(key, pdf, 'application/pdf').catch((err) => console.error('[reportPdf] OSS 缓存写入失败:', (err as Error).message));
      }
    }

    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', pdfContentDisposition(reportTitle(row.title, row.html)))
      .header('Cache-Control', 'public, max-age=600')
      .send(pdf);
  });
}
