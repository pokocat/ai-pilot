// 把结构化成果(Deliverable)渲染成一张自包含、可分享的 HTML 页面,存库并返回分享链接。
// 模型只产出结构化 sections,样式由这里统一渲染(故提示词里不必再背 HTML 模板)。
import { prisma } from '../db.js';
import { env } from '../env.js';
import type { Deliverable } from '../llm/schema.js';

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// 正文里的简单换行 → <br>;不解析 markdown(保持稳健)。
function paraHtml(b: string): string {
  return esc(b).replace(/\n/g, '<br>');
}

/** Deliverable → 自包含 HTML(内联 CSS,米色底/衬线标题/分段卡片)。 */
export function renderReportHtml(d: Deliverable): string {
  const sections = (d.sections ?? []).map((s) => {
    const body = s.b ? `<p class="b">${paraHtml(s.b)}</p>` : '';
    const list = s.list?.length ? `<ul>${s.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>` : '';
    return `<section class="card"><h2>${esc(s.h)}</h2>${body}${list}</section>`;
  }).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(d.title)} · 军师</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#F4F1EA;color:#2b2620;font-family:"Noto Serif SC",Georgia,"Songti SC",serif;line-height:1.75;padding:28px 16px 56px}
.wrap{max-width:720px;margin:0 auto}
.hd{text-align:center;padding:8px 0 22px;border-bottom:2px solid #d8cfbd;margin-bottom:24px}
.hd .t{font-size:26px;font-weight:700;color:#7a5c2e;letter-spacing:1px}
.hd .m{font-size:13px;color:#8a8170;margin-top:8px}
.card{background:#fffdf8;border:1px solid #e7dfce;border-radius:14px;padding:18px 20px;margin:0 0 16px;box-shadow:0 1px 0 rgba(122,92,46,.04)}
.card h2{font-size:17px;color:#5a4a2e;margin-bottom:10px;font-weight:700}
.card .b{font-size:15px;color:#3a342b;white-space:normal}
.card ul{margin:6px 0 0;padding-left:20px}
.card li{font-size:15px;color:#3a342b;margin:5px 0}
.trust{font-size:12px;color:#9a9080;text-align:center;margin:22px 0 8px;line-height:1.6}
.ft{text-align:center;font-size:12px;color:#b5a98f;margin-top:18px;letter-spacing:2px}
</style></head>
<body><div class="wrap">
<div class="hd"><div class="t">${esc(d.title)}</div>${d.meta ? `<div class="m">${esc(d.meta)}</div>` : ''}</div>
${sections || '<section class="card"><p class="b">（暂无内容）</p></section>'}
${d.trust ? `<div class="trust">${paraHtml(d.trust)}</div>` : ''}
<div class="ft">军师 · JUNSHI</div>
</div></body></html>`;
}

/** 渲染 + 存库 + 返回可分享链接。失败抛出,由调用方吞掉(不影响产出)。 */
export async function publishReport(tenantId: string | null, d: Deliverable): Promise<string> {
  const row = await prisma.reportHtml.create({
    data: { tenantId: tenantId ?? null, title: d.title || '咨询成果', html: renderReportHtml(d) },
  });
  return `${env.publicBaseUrl}/api/r/${row.id}`;
}
