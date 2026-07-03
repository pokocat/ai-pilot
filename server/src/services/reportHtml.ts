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
  return `<section class="sec">
<div class="sec-h"><span class="idx">${cnIndex(i + 1)}</span><h2>${esc(s.h)}</h2></div>
${inner}
</section>`;
}

/** Deliverable → 自包含战略报告 HTML(内联 CSS,V6.0 天势卡片风:暖纸底/深绿封面/宋体标题/章节白卡/金印落款)。 */
export function renderReportHtml(d: Deliverable): string {
  const sections = (d.sections ?? []).map(sectionHtml).join('\n');
  const body = sections || '<section class="sec"><p class="b muted">（暂无内容）</p></section>';
  const trust = (d.trust && d.trust.trim()) || DEFAULT_TRUST;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(d.title)} · 军师参谋部</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-text-size-adjust:100%}
body{background:#ECE7DA;color:#16191D;font-family:"Noto Sans SC",-apple-system,"PingFang SC",sans-serif;line-height:1.8;padding:24px 14px 60px}
.page{max-width:680px;margin:0 auto;background:#FBFAF6;border-radius:20px;box-shadow:0 18px 48px rgba(22,25,29,.13);overflow:hidden}
/* 封面（深绿） */
.cover{padding:36px 30px 30px;color:#fff;background:linear-gradient(150deg,#1E5A43,#163F30);text-align:center}
.badge{display:inline-block;padding:5px 13px;border:1px solid rgba(255,255,255,.34);border-radius:999px;font-size:11px;letter-spacing:.2em;color:rgba(255,255,255,.86)}
.title{font-family:"Noto Serif SC","Songti SC","STSong",serif;font-size:28px;font-weight:700;letter-spacing:2px;line-height:1.4;margin:16px auto 0;max-width:92%}
.motto{font-size:12.5px;color:rgba(255,255,255,.72);letter-spacing:.5px;margin-top:14px}
.meta{font-size:12px;color:rgba(255,255,255,.58);margin-top:12px;letter-spacing:.4px}
/* 正文章节（白卡） */
.body{padding:24px 22px 8px}
.sec{padding:16px 18px;margin:0 0 16px;background:#fff;border:1px solid #E7E4DB;border-radius:14px}
.sec-h{display:flex;align-items:center;gap:11px;margin-bottom:11px}
.sec-h .idx{flex:0 0 auto;font-family:"Noto Serif SC",serif;font-size:14px;font-weight:700;color:#fff;background:#1E5A43;width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;line-height:1}
.sec-h h2{font-family:"Noto Serif SC","Songti SC",serif;font-size:17px;color:#1E5A43;font-weight:700;letter-spacing:.5px;line-height:1.4}
.sec .b{font-size:15px;color:#2b2f34;margin:0 0 9px;line-height:1.85}
.sec .b:last-child{margin-bottom:0}
.sec .b.muted{color:#a4a29a}
.sec ul{margin:8px 0 0;padding:0;list-style:none}
.sec li{position:relative;font-size:15px;color:#2b2f34;margin:9px 0;padding-left:19px;line-height:1.7}
.sec li::before{content:"";position:absolute;left:2px;top:10px;width:7px;height:7px;background:#9B7C3F;border-radius:2px;transform:rotate(45deg)}
/* 落款（金印） */
.foot{padding:22px 30px 30px;text-align:center;border-top:1px solid #E7E4DB;background:#FBF7EC}
.seal{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;width:60px;height:60px;border:2px solid #1E5A43;border-radius:12px;color:#1E5A43;transform:rotate(-4deg);margin-bottom:13px;font-weight:700;line-height:1.1}
.seal .s1{font-family:"Noto Serif SC",serif;font-size:19px;letter-spacing:2px}
.seal .s2{font-size:8px;letter-spacing:1px;margin-top:2px}
.seal-motto{font-family:"Noto Serif SC",serif;font-size:13px;color:#43340F;letter-spacing:.5px;margin-bottom:13px}
.trust{font-size:11.5px;color:#8b8f95;line-height:1.7;max-width:520px;margin:0 auto 14px}
.brand{font-family:"Noto Serif SC",serif;font-size:14px;font-weight:700;color:#9B7C3F;letter-spacing:.12em}
.edition{margin-top:5px;font-size:10px;color:#a4a29a;letter-spacing:.16em}
@media print{body{background:#fff;padding:0}.page{box-shadow:none}}
</style></head>
<body>
<div class="page">
<header class="cover">
<span class="badge">◆ 军师参谋部 ◆</span>
<h1 class="title">${esc(d.title)}</h1>
<div class="motto">${COVER_MOTTO}</div>
${d.meta ? `<div class="meta">${esc(d.meta)}</div>` : ''}
</header>
<main class="body">
${body}
</main>
<footer class="foot">
<div class="seal"><span class="s1">军师</span><span class="s2">JUNSHI</span></div>
<div class="seal-motto">「${SEAL_MOTTO}」</div>
<div class="trust">${esc(trust)}</div>
<div class="brand">军师参谋部</div>
<div class="edition">军师 · JUNSHI · CELESTIAL MOMENTUM · V6.0</div>
</footer>
</div>
</body></html>`;
}

/** 渲染 + 存库 + 返回可分享链接。失败抛出,由调用方吞掉(不影响产出)。
 *  配了 OSS → 传 OSS 返回公网静态链接(不暴露后端域名);没配/上传失败 → 回退后端 /api/r/:id。
 *  DB report_html 行始终保留(留底 + 兜底兜服务)。 */
export async function publishReport(tenantId: string | null, d: Deliverable): Promise<string> {
  return publishHtml(tenantId, d.title || '咨询成果', renderReportHtml(d));
}

/** 通用 HTML 发布（报告与 B 级卡片共用）：存库留底 → OSS 公网链接，失败回退后端 /api/r/:id。 */
export async function publishHtml(tenantId: string | null, title: string, html: string): Promise<string> {
  const row = await prisma.reportHtml.create({
    data: { tenantId: tenantId ?? null, title, html },
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
