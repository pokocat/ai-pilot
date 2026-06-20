// 把结构化成果(Deliverable)渲染成一张自包含、可分享的战略报告 HTML 页面,存库并返回分享链接。
// 模型只产出结构化 sections,版式/品牌/落款由这里统一渲染(故提示词里不必再背 HTML/CSS 骨架)。
// 设计语言取自「军师·战略参谋部」V6.0 提示词:米色底/衬线/印章感/机构级克制;
//   封面格言 = 提示词核心信念「看清天势市势人势,于三势交汇处落子」;落款语录 = 孙子「善战者,求之于势,不责于人」。
import { prisma } from '../db.js';
import { env } from '../env.js';
import { ossConfigured, ossPutHtml } from './ossUpload.js';
import type { Deliverable } from '../llm/schema.js';

// 提示词里的固定品牌语(从 V6.0 系统提示词提取,非模型生成)。
const COVER_MOTTO = '看清天势 · 市势 · 人势 — 于三势交汇处落子';
const SEAL_MOTTO = '善战者,求之于势,不责于人。';
const DEFAULT_TRUST = '本报告为战略参考,重大决策请结合专业意见与一手数据。';

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
// 1..20 的中文序号(章节编号用),超出则回退阿拉伯数字。
function cnIndex(n: number): string {
  if (n <= 10) return CN[n];
  if (n < 20) return '十' + CN[n - 10];
  if (n === 20) return '二十';
  return String(n);
}

function esc(s: string): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// 正文:空行分段为 <p>,段内单换行转 <br>;不解析 markdown(保持稳健、防注入)。
function bodyHtml(b: string): string {
  const paras = esc(b).split(/\n{2,}/).map((p) => p.replace(/\n/g, '<br>')).filter(Boolean);
  return paras.map((p) => `<p class="b">${p}</p>`).join('');
}

function sectionHtml(s: Deliverable['sections'][number], i: number): string {
  const body = s.b ? bodyHtml(s.b) : '';
  const list = s.list?.length ? `<ul>${s.list.map((li) => `<li>${esc(li)}</li>`).join('')}</ul>` : '';
  const inner = body + list || '<p class="b muted">（本节待补充）</p>';
  return `<section class="card">
<div class="card-h"><span class="idx">${cnIndex(i + 1)}</span><h2>${esc(s.h)}</h2></div>
${inner}
</section>`;
}

/** Deliverable → 自包含战略报告 HTML(内联 CSS,米色底/衬线标题/章节卡片/印章落款)。 */
export function renderReportHtml(d: Deliverable): string {
  const sections = (d.sections ?? []).map(sectionHtml).join('\n');
  const body = sections || '<section class="card"><p class="b muted">（暂无内容）</p></section>';
  const trust = (d.trust && d.trust.trim()) || DEFAULT_TRUST;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(d.title)} · 军师</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:#EDE7DA;color:#2b2620;font-family:"Noto Serif SC",Georgia,"Songti SC","STSong",serif;line-height:1.85;padding:24px 14px 64px}
.page{max-width:760px;margin:0 auto;background:#FBF8F1;border:1px solid #e0d7c4;border-radius:16px;box-shadow:0 8px 40px rgba(80,60,30,.10);overflow:hidden}
/* 封面 */
.cover{position:relative;padding:40px 30px 30px;background:linear-gradient(180deg,#F5F0E5 0%,#FBF8F1 100%);border-bottom:1px solid #e7dfce;text-align:center}
.cover::before{content:"";position:absolute;inset:14px 14px auto 14px;height:1px;background:linear-gradient(90deg,transparent,#c9bb9d,transparent)}
.eyebrow{font-size:12px;letter-spacing:6px;color:#9a7b46;font-weight:600;margin-bottom:18px;padding-left:6px}
.title{font-size:29px;font-weight:700;color:#5a4326;letter-spacing:2px;line-height:1.35;margin:0 auto;max-width:90%}
.motto{font-size:13px;color:#8a7a5c;letter-spacing:1px;margin-top:16px;font-style:italic}
.rule{display:flex;align-items:center;justify-content:center;gap:12px;margin:20px auto 0;color:#c9bb9d}
.rule::before,.rule::after{content:"";height:1px;width:64px;background:#d8cfbd}
.rule .d{font-size:11px;color:#b09c72}
.meta{font-size:12.5px;color:#9a9080;margin-top:14px;letter-spacing:.5px}
/* 正文章节 */
.body{padding:26px 30px 8px}
.card{padding:6px 0 22px;margin:0 0 22px;border-bottom:1px solid #efe8d8}
.card:last-child{border-bottom:none;margin-bottom:6px}
.card-h{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}
.card-h .idx{flex:0 0 auto;font-size:15px;font-weight:700;color:#fff;background:#7a5c2e;width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;line-height:1;align-self:center;box-shadow:0 1px 3px rgba(122,92,46,.3)}
.card-h h2{font-size:18px;color:#4a3a22;font-weight:700;letter-spacing:.5px;line-height:1.5}
.card .b{font-size:15.5px;color:#3a342b;margin:0 0 10px;padding-left:38px}
.card .b:last-child{margin-bottom:0}
.card .b.muted{color:#a59c89}
.card ul{margin:6px 0 0;padding-left:58px;list-style:none}
.card li{position:relative;font-size:15.5px;color:#3a342b;margin:8px 0;padding-left:18px}
.card li::before{content:"";position:absolute;left:0;top:11px;width:7px;height:7px;background:#b08a4a;border-radius:2px;transform:rotate(45deg)}
/* 落款 */
.foot{padding:24px 30px 34px;background:linear-gradient(180deg,#FBF8F1 0%,#F4EEE1 100%);border-top:1px solid #e7dfce;text-align:center}
.seal{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:64px;height:64px;border:2px solid #a8401f;border-radius:10px;color:#a8401f;transform:rotate(-4deg);margin-bottom:14px;font-weight:700;line-height:1.1}
.seal .s1{font-size:21px;letter-spacing:2px}
.seal .s2{font-size:8px;letter-spacing:1px;margin-top:2px}
.seal-motto{font-size:13px;color:#7a5c2e;letter-spacing:1px;margin-bottom:14px}
.trust{font-size:12px;color:#9a9080;line-height:1.7;max-width:520px;margin:0 auto 16px}
.brand{font-size:12px;color:#b5a98f;letter-spacing:5px;padding-left:5px}
@media print{body{background:#fff;padding:0}.page{box-shadow:none;border:none}}
</style></head>
<body>
<div class="page">
<header class="cover">
<div class="eyebrow">军师参谋部 · 战略报告</div>
<h1 class="title">${esc(d.title)}</h1>
<div class="motto">${COVER_MOTTO}</div>
<div class="rule"><span class="d">◆</span></div>
${d.meta ? `<div class="meta">${esc(d.meta)}</div>` : ''}
</header>
<main class="body">
${body}
</main>
<footer class="foot">
<div class="seal"><span class="s1">军师</span><span class="s2">JUNSHI</span></div>
<div class="seal-motto">「${SEAL_MOTTO}」</div>
<div class="trust">${esc(trust)}</div>
<div class="brand">军师 · JUNSHI</div>
</footer>
</div>
</body></html>`;
}

/** 渲染 + 存库 + 返回可分享链接。失败抛出,由调用方吞掉(不影响产出)。
 *  配了 OSS → 传 OSS 返回公网静态链接(不暴露后端域名);没配/上传失败 → 回退后端 /api/r/:id。
 *  DB report_html 行始终保留(留底 + 兜底兜服务)。 */
export async function publishReport(tenantId: string | null, d: Deliverable): Promise<string> {
  const html = renderReportHtml(d);
  const row = await prisma.reportHtml.create({
    data: { tenantId: tenantId ?? null, title: d.title || '咨询成果', html },
  });
  if (ossConfigured()) {
    try {
      const key = `${env.ossKeyPrefix ? env.ossKeyPrefix + '/' : ''}${row.id}.html`;
      return await ossPutHtml(key, html);
    } catch (err) {
      console.error('[reportHtml] OSS 上传失败,回退后端链接:', (err as Error).message);
    }
  }
  return `${env.publicBaseUrl}/api/r/${row.id}`;
}
