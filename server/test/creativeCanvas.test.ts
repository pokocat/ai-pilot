// 海报 AI 排版引擎（第 3 档）测试：静态审计 / 占位符 / AI 标识注入 / refine 闭环状态机 /
// 量测器（真实浏览器，门禁）/ worker 回落矩阵 / 后台开关契约。
//
// 依赖注入优先：闭环用例注入 stub 的 completeText 与 render，**不打真 LLM、不起浏览器** ——
// 这条闭环的价值在「几轮、喂什么、什么时候放弃」，那是纯编排逻辑，不该被外部服务的可用性绑定。
// 唯一需要真实 Chromium 的是量测器（它量的就是真实布局），单独一个 describe + PUPPETEER_REAL=1 门禁。
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../src/db.js';
import { getApp, closeApp, seedBaseline, cleanBusiness, api, login, uniquePhone } from './helpers.js';
import { grantCredits } from '../src/services/credits.js';
import { setFeatureFlag, setFeatureFlagPayload, __clearFeatureCache } from '../src/services/featureFlag.js';
import { tickCreativeWorker } from '../src/services/creative/worker.js';
import { CREATIVE_FLAG_ID, DEFAULT_LAYOUT_ENGINE } from '../src/services/creative/config.js';
import { AI_MARK_TEXT, CANVAS_CLASS, FONT_SANS } from '../src/services/creative/templates.js';
import {
  sanitizeCanvasHtml, stripHtmlFence, fillPlaceholders, ensureAiMark, availablePlaceholders,
  CANVAS_PLACEHOLDER,
} from '../src/services/creative/canvasSanitize.js';
import {
  generateCanvasPoster, MAX_HTML_CALLS, MAX_DEBUG_HTML_CHARS,
  type CompleteTextFn, type CanvasRenderFn,
} from '../src/services/creative/canvasEngine.js';
import { generateManifesto } from '../src/services/creative/manifesto.js';
import {
  violationsCritique, MEASURE_LIMITS, DECOR_ATTR, posterScanFn, posterScanArg,
  type PosterViolation,
} from '../src/services/creative/canvasMeasure.js';
import { renderCanvasPoster } from '../src/services/creative/renderer.js';
import { composeVisualPrompt, fallbackPhilosophy } from '../src/services/creative/philosophy.js';
import { completeText } from '../src/llm/gateway.js';
import { hotelOtaBrief } from './fixtures/posterBriefs.js';

process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'test-admin-token';

const BRIEF = hotelOtaBrief();
const MANIFESTO = {
  movement: '纸墨秩序',
  paragraphs: ['第一段：留白是结构。', '第二段：色彩承担信息。', '第三段：工艺感来自反复推敲。'],
  palette: ['#16241E', '#1E5A43', '#9B7C3F', '#F4F2EC'],
  reference: '酒店直客运营的秩序感',
};

/* ───────────────── stub 与样例 HTML ───────────────── */

/** 一份能过静态审计的最小合法产物（标记 tag 便于分辨是第几轮的产物）。 */
function okHtml(tag: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>t</title>`
    + `<style>html,body{margin:0}.${CANVAS_CLASS}{width:540px;height:720px;overflow:hidden;position:relative;`
    + `font-family:${FONT_SANS};background:linear-gradient(160deg,#16241E,#1E5A43)}</style></head>`
    + `<body><div class="${CANVAS_CLASS}"><h1>${BRIEF.headline}</h1><p>${tag}</p>`
    + `<div>${AI_MARK_TEXT}</div></div></body></html>`;
}

/** 同形但超过 lastHtml 截断上限的产物（验证失败留痕被钉在上限内；标记 tag 仍落在前 24k 字符里）。 */
function bigHtml(tag: string): string {
  return okHtml(tag).replace('</div></body>', `<div>${'x'.repeat(30_000)}</div></div></body>`);
}

function stubComplete(replies: (string | null)[]): { fn: CompleteTextFn; calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  const fn: CompleteTextFn = async (system, user) => {
    calls.push({ system, user });
    return replies[calls.length - 1] ?? null;
  };
  return { fn, calls };
}

/** 每轮返回一组违规（[] = 干净）；buffer 逐轮不同，便于断言「交出去的是哪一轮的图」。 */
function stubRender(rounds: (PosterViolation[] | 'throw' | 'unmeasured')[]): { fn: CanvasRenderFn; htmls: string[] } {
  const htmls: string[] = [];
  const fn: CanvasRenderFn = async (html) => {
    const idx = htmls.length;
    htmls.push(html);
    const r = rounds[idx] ?? [];
    if (r === 'throw') throw new Error('浏览器不可用');
    if (r === 'unmeasured') {
      return { buffer: Buffer.from(`r${idx}`), width: 1080, height: 1440, violations: [], measured: false };
    }
    return { buffer: Buffer.from(`r${idx}`), width: 1080, height: 1440, violations: r, measured: true };
  };
  return { fn, htmls };
}

const marginViolation: PosterViolation = {
  code: 'margin',
  selector: 'div.poster > div.body > h1.headline',
  detail: '文字距画布边仅 4.2px（下限 12px）：「不再靠 OTA 活着」',
};

async function runEngine(
  complete: CompleteTextFn,
  render: CanvasRenderFn,
  o: { budgetMs?: number; now?: () => number; moderateText?: (t: string) => Promise<boolean> } = {},
) {
  return generateCanvasPoster(
    { brief: BRIEF, manifesto: MANIFESTO, assets: {}, ...(o.budgetMs ? { budgetMs: o.budgetMs } : {}) },
    { complete, render, ...(o.now ? { now: o.now } : {}), ...(o.moderateText ? { moderateText: o.moderateText } : {}) },
  );
}

/* ───────────────── ① 静态审计（纯函数） ───────────────── */

describe('AI 排版引擎 · 静态审计（LLM 写的 HTML 是不可信输入）', () => {
  test('合法产物放行：CSS 渐变 / data URI / 占位符 / 内联 SVG / charset+viewport', () => {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">`
      + `<meta name="viewport" content="width=540">`
      + `<style>.${CANVAS_CLASS}{width:540px;height:720px;overflow:hidden;position:relative;`
      + `background:radial-gradient(#111,#000);background-image:url("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")}</style></head>`
      + `<body><div class="${CANVAS_CLASS}"><svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>`
      + `<img src="${CANVAS_PLACEHOLDER.qr}" data-role="qr">`
      + `<img src="data:image/png;base64,iVBORw0KGgo=">`
      + `<div>${AI_MARK_TEXT}</div></div></body></html>`;
    const r = sanitizeCanvasHtml(html);
    assert.equal(r.ok, true, r.ok ? '' : r.issues.join('；'));
  });

  // 量测器约定的 data-* 属性必须能穿过静态审计：资源地址正则里有 `data` 与 `poster` 两个属性名，
  // 但它们后面钉着 `\s*=`，`data-poster-decor="1"` 匹配不上。这条用例把它钉死（改那个正则会立刻红）。
  test('量测器约定的 data-poster-decor / data-poster-exempt 属性放行（不被当成资源地址）', () => {
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">`
      + `<style>.${CANVAS_CLASS}{width:540px;height:720px;overflow:hidden;position:relative}</style></head>`
      + `<body><div class="${CANVAS_CLASS}">`
      + `<div ${DECOR_ATTR}="1" style="font-size:220px;opacity:.12">直</div>`
      + `<h1>${BRIEF.headline}</h1>`
      + `<div data-poster-exempt="1">${AI_MARK_TEXT}</div></div></body></html>`;
    const r = sanitizeCanvasHtml(html);
    assert.equal(r.ok, true, r.ok ? '' : r.issues.join('；'));
  });

  const rejected: [string, string, RegExp][] = [
    ['内联脚本', '<script>alert(1)</script>', /禁止使用 <script>/],
    ['事件属性', '<div onload="x()">x</div>', /on\* 事件属性/],
    ['iframe', '<iframe src="data:image/png;base64,a"></iframe>', /禁止使用 <iframe>/],
    ['object', '<object></object>', /禁止使用 <object>/],
    ['embed', '<embed>', /禁止使用 <embed>/],
    ['外链样式表', '<link rel="stylesheet" href="data:image/png;base64,a">', /禁止使用 <link>/],
    ['base', '<base href="#">', /禁止使用 <base>/],
    ['伪协议', '<a href="javascript:alert(1)">x</a>', /javascript:/],
    ['外链图片', '<img src="https://evil.example/x.png">', /禁止外链\/相对资源/],
    ['协议相对外链', '<img src="//evil.example/x.png">', /禁止外链\/相对资源/],
    ['相对路径图片', '<img src="/api/creative/assets/x/file">', /禁止外链\/相对资源/],
    ['CSS 外链 url()', '<div style="background:url(https://evil.example/a.png)">x</div>', /禁止外链\/相对资源/],
  ];
  for (const [name, snippet, re] of rejected) {
    test(`拒绝：${name}`, () => {
      const html = `<!DOCTYPE html><html><head><style>.${CANVAS_CLASS}{width:540px}</style></head>`
        + `<body><div class="${CANVAS_CLASS}">${snippet}</div></body></html>`;
      const r = sanitizeCanvasHtml(html);
      assert.equal(r.ok, false, '必须整份打回，不许"洗一洗再渲染"');
      assert.ok(!r.ok && r.issues.some((i) => re.test(i)), `原因要具体到形态：${!r.ok ? r.issues.join('；') : ''}`);
    });
  }

  test('拒绝：CSS @import 外链字体（字体只用镜像内置栈）', () => {
    const html = `<!DOCTYPE html><html><head><style>@import url("//fonts.example/x.css");`
      + `.${CANVAS_CLASS}{width:540px}</style></head><body><div class="${CANVAS_CLASS}">x</div></body></html>`;
    const r = sanitizeCanvasHtml(html);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.issues.some((i) => /@import/.test(i)));
  });

  test('meta 只放行 charset 与 viewport（http-equiv refresh 一律拒）', () => {
    const html = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=data:image/png;base64,a">`
      + `<style>.${CANVAS_CLASS}{width:540px}</style></head><body><div class="${CANVAS_CLASS}">x</div></body></html>`;
    const r = sanitizeCanvasHtml(html);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.issues.some((i) => /<meta> 只允许/.test(i)));
  });

  test('结构性缺陷各自成一条可回喂的原因：缺 DOCTYPE / 缺画布根元素 / 被截断', () => {
    const noDoctype = sanitizeCanvasHtml(`<html><body><div class="${CANVAS_CLASS}">x</div></body></html>`);
    assert.ok(!noDoctype.ok && noDoctype.issues.some((i) => /<!DOCTYPE html> 开头/.test(i)));

    const noRoot = sanitizeCanvasHtml('<!DOCTYPE html><html><body><div class="page">x</div></body></html>');
    assert.ok(!noRoot.ok && noRoot.issues.some((i) => new RegExp(`class="${CANVAS_CLASS}"`).test(i)));

    const truncated = sanitizeCanvasHtml(`<!DOCTYPE html><html><body><div class="${CANVAS_CLASS}">x`);
    assert.ok(!truncated.ok && truncated.issues.some((i) => /缺少结尾 <\/html>/.test(i)));
  });

  test('剥掉 Markdown 围栏与前后废话（模型很爱加）', () => {
    const wrapped = '好的，这是海报：\n```html\n<!DOCTYPE html><html><body>x</body></html>\n```\n希望满意。';
    assert.equal(stripHtmlFence(wrapped), '<!DOCTYPE html><html><body>x</body></html>');
  });
});

/* ───────────────── ② 占位符与 AI 标识 ───────────────── */

describe('AI 排版引擎 · 占位符替换与 AI 标识兜底', () => {
  test('提供的素材被替换；未提供的占位符**刻意保留**（留给量测器判违规）', () => {
    const html = `<div><img src="${CANVAS_PLACEHOLDER.portrait}"><img src="${CANVAS_PLACEHOLDER.qr}"></div>`;
    const r = fillPlaceholders(html, { portraitUrl: 'data:image/png;base64,AAA' });
    assert.match(r.html, /src="data:image\/png;base64,AAA"/);
    assert.ok(r.html.includes(CANVAS_PLACEHOLDER.qr), '没提供二维码 → 占位符原样留着');
    assert.equal(r.residue, true, '残留必须被报出来：悄悄删掉那个 <img> 模型永远不知道自己引用错了');
    assert.deepEqual(r.filled, [CANVAS_PLACEHOLDER.portrait]);
  });

  test('素材清单只列真实存在的占位符（提示词据此告诉模型"只有这些可用"）', () => {
    assert.deepEqual(availablePlaceholders({}), []);
    assert.deepEqual(
      availablePlaceholders({ logoUrl: 'data:image/png;base64,A', qrUrl: 'data:image/png;base64,B' }),
      [CANVAS_PLACEHOLDER.logo, CANVAS_PLACEHOLDER.qr],
    );
  });

  test('AI 标识缺失 → 注入固定 overlay（合规是服务端义务，不取决于模型听不听话）', () => {
    const html = `<!DOCTYPE html><html><body><div class="${CANVAS_CLASS}"><h1>标题</h1></div></body></html>`;
    const r = ensureAiMark(html);
    assert.equal(r.injected, true);
    assert.ok(r.html.includes(AI_MARK_TEXT));
    assert.ok(r.html.includes('data-poster-exempt'), '注入的角标豁免边距检查（贴边是设计不是缺陷）');
    assert.ok(r.html.indexOf(AI_MARK_TEXT) < r.html.indexOf('</body>'), '必须落在画布内');
  });

  test('AI 标识已在 → 不重复注入', () => {
    const html = `<!DOCTYPE html><html><body><div class="${CANVAS_CLASS}"><div>${AI_MARK_TEXT}</div></div></body></html>`;
    const r = ensureAiMark(html);
    assert.equal(r.injected, false);
    assert.equal(r.html, html);
  });
});

/* ───────────────── ③ refine 闭环状态机 ───────────────── */

describe('AI 排版引擎 · refine 闭环（无条件打磨是核心机制，不是可选优化）', () => {
  // ★ 上游 skill 的核心机制："The user ALREADY said it isn't perfect… take a second pass."
  //   首轮就干净也必须再打磨一轮。用「LLM 被调 2 次而不是 1 次」把它钉死 ——
  //   这条断言在的时候，任何「干净就直接交付」的优化都会立刻红。
  test('首轮干净 → 仍执行一轮无条件打磨（LLM 被调 2 次，且第二轮是打磨指令而非修正指令）', async () => {
    const c = stubComplete([okHtml('first'), okHtml('polished')]);
    const r = await runEngine(c.fn, stubRender([[], []]).fn);
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.equal(c.calls.length, 2, '干净也要打磨：这一轮不许省');
    assert.ok(r.ok && r.poster.rounds === 2);
    assert.ok(r.ok && r.poster.violationsFixed === 0);
    assert.ok(r.ok && !r.poster.polishReverted);
    assert.match(c.calls[1].system, /本轮任务：打磨（不是重做）|本轮任务：打磨/, '第二轮必须是打磨指令');
    assert.match(c.calls[1].system, /再走一遍代码/, '移植上游 "Take a second pass"');
    assert.match(c.calls[1].system, /不要再加图形/, '移植上游「打磨不是加东西」');
    assert.doesNotMatch(c.calls[1].system, /\[margin\]/, '没有违规就不该出现 critique');
    assert.match(c.calls[1].user, /上一版 HTML/, '打磨轮要带上一版源码，不是从零重写');
    assert.ok(c.calls[1].user.includes('first'), '带的是第一轮那份产物');
  });

  // ★ 交付闸门：模型自创的画面文字必须过输出侧审核（brief 建单时审过，但模型可能加装饰性文字，
  //   那也是印在对外成品上的内容）。不过审 → ok:false 回落模板（那条路的文字全部来自已审 brief）。
  test('画面文字未过输出侧审核 → 不交付，回落模板（fail-closed）', async () => {
    const seen: string[] = [];
    const c = stubComplete([okHtml('first'), okHtml('polished')]);
    const r = await runEngine(c.fn, stubRender([[], []]).fn, {
      moderateText: async (t) => { seen.push(t); return false; },
    });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /内容审核/.test(r.reason), '回落原因要可读，运营在任务台要能看懂');
    assert.equal(seen.length, 1, '闸门只审最终交付的那一张（逐轮审是三倍成本且文字基本不变）');
  });

  test('审核函数自身抛错 → 同样不交付（审核异常不等于审核通过）', async () => {
    const c = stubComplete([okHtml('first'), okHtml('polished')]);
    const r = await runEngine(c.fn, stubRender([[], []]).fn, {
      moderateText: async () => { throw new Error('审核服务超时'); },
    });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /内容审核/.test(r.reason));
  });

  test('首轮违规 → 第二轮修复 → 成功；critique 逐条带 selector 与数值', async () => {
    const c = stubComplete([okHtml('dirty'), okHtml('fixed')]);
    const render = stubRender([[marginViolation], []]);
    const r = await runEngine(c.fn, render.fn);
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.ok(r.ok && r.poster.rounds === 2);
    assert.ok(r.ok && r.poster.violationsFixed === 1, '修掉的条数要落库，不然"修了没修"没人知道');
    assert.ok(r.ok && r.poster.violations.length === 0);
    // 模糊的"有问题请改进"喂回去没用：必须逐条、带路径、带实测数值
    assert.match(c.calls[1].system, /\[margin\]/);
    assert.match(c.calls[1].system, /div\.poster > div\.body > h1\.headline/);
    assert.match(c.calls[1].system, /4\.2px/);
    assert.match(c.calls[1].system, /不要靠缩小字号/, '修正原则要一起喂（否则模型一律缩字号）');
    assert.equal(render.htmls.length, 2);
  });

  test(`${MAX_HTML_CALLS} 轮仍违规 → 不交付，返回 ok:false 让 worker 回落模板`, async () => {
    const c = stubComplete([okHtml('a'), okHtml('b'), okHtml('c'), okHtml('never')]);
    const render = stubRender([[marginViolation], [marginViolation], [marginViolation]]);
    const r = await runEngine(c.fn, render.fn);
    assert.equal(r.ok, false);
    assert.equal(c.calls.length, MAX_HTML_CALLS, 'LLM 调用有硬上限，不许无限修');
    assert.equal(render.htmls.length, MAX_HTML_CALLS);
    assert.ok(!r.ok && r.rounds === MAX_HTML_CALLS);
    assert.ok(!r.ok && /margin/.test(r.reason), `回落原因要写清楚：${!r.ok ? r.reason : ''}`);
  });

  // ★ 失败留痕：回落时必须留下模型最后想画的东西。2026-07-30 的实锤（三轮全卡 text_overlap）
  //   只能靠猜——违规码说不出"模型用的是哪种手法"，而误伤判定必须看产物。
  test(`${MAX_HTML_CALLS} 轮仍违规 → ok:false 带最后一轮产物 lastHtml，且被截断上限钉住`, async () => {
    const c = stubComplete([bigHtml('a'), bigHtml('b'), bigHtml('c'), bigHtml('never')]);
    const render = stubRender([[marginViolation], [marginViolation], [marginViolation]]);
    const r = await runEngine(c.fn, render.fn);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.lastHtml, '没有产物留痕的话，下次误伤仍然只能猜');
    assert.equal(!r.ok && r.lastHtml!.length, MAX_DEBUG_HTML_CHARS, '截断上限要钉住（这串会进 DB 的 metadataJson）');
    assert.ok(!r.ok && r.lastHtml!.includes('<p>c</p>'), `留的必须是第 ${MAX_HTML_CALLS} 轮那份产物`);
    assert.ok(!r.ok && !r.lastHtml!.includes('<p>b</p>'));
  });

  test('模型压根没产出（首轮就 null）→ 没有 lastHtml 这个键（不留空串假装有留痕）', async () => {
    const r = await runEngine(stubComplete([null]).fn, stubRender([[]]).fn);
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.lastHtml, undefined);
  });

  test('打磨轮把画面弄坏了 → 退回上一版干净图（绝不为"执行了打磨"交一张更差的图）', async () => {
    const c = stubComplete([okHtml('clean'), okHtml('worse')]);
    const render = stubRender([[], [marginViolation]]);
    const r = await runEngine(c.fn, render.fn);
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.poster.polishReverted, '要留痕，否则这条分支在生产里不可观测');
    assert.ok(r.ok && r.poster.violations.length === 0);
    assert.ok(r.ok && r.poster.buffer.toString() === 'r0', '交出去的必须是第一轮那张干净图');
    assert.equal(c.calls.length, 2, '退回后不再烧第三轮');
  });

  test('静态审计不过 → 原因回喂并重写（不进浏览器，省一次渲染）', async () => {
    const bad = `<!DOCTYPE html><html><body><div class="${CANVAS_CLASS}"><script>x()</script></div></body></html>`;
    const c = stubComplete([bad, okHtml('rewritten')]);
    const render = stubRender([[]]);
    const r = await runEngine(c.fn, render.fn);
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.equal(render.htmls.length, 1, '被拒的那一轮不该进渲染');
    assert.match(c.calls[1].system, /\[html_rejected\]/);
    assert.match(c.calls[1].system, /禁止使用 <script>/);
    assert.doesNotMatch(c.calls[1].user, /上一版 HTML/, '没有可用产物时让模型重写完整文档，而不是改一份它看不到的东西');
  });

  test('模型不可用（mock / completeText 返回 null）→ 立刻放弃，一次渲染都不做', async () => {
    const c = stubComplete([null]);
    const render = stubRender([[]]);
    const r = await runEngine(c.fn, render.fn);
    assert.equal(r.ok, false);
    assert.equal(render.htmls.length, 0);
    assert.ok(!r.ok && /模型不可用/.test(r.reason));
  });

  test('渲染异常 → 立刻放弃去回落（模型修不了浏览器）', async () => {
    const c = stubComplete([okHtml('a'), okHtml('b')]);
    const r = await runEngine(c.fn, stubRender(['throw']).fn);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /渲染失败/.test(r.reason));
    assert.equal(c.calls.length, 1, '渲染坏了就别再烧 LLM 轮次');
  });

  test('量测拿不到结果 → 当作"无法验证"而不是"干净"（保守回落）', async () => {
    const c = stubComplete([okHtml('a')]);
    const r = await runEngine(c.fn, stubRender(['unmeasured']).fn);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /量测未生效/.test(r.reason));
  });

  test('超预算但手上有干净图 → 交那张（rounds=1 是唯一一种打磨没跑完的合法形态）', async () => {
    let t = 0;
    const c = stubComplete([okHtml('a'), okHtml('b')]);
    // 每次 LLM 调用推进 700ms；预算 500ms → 第一轮跑完就超预算
    const complete: CompleteTextFn = async (s, u) => { const r = await c.fn(s, u); t += 700; return r; };
    const r = await runEngine(complete, stubRender([[], []]).fn, { budgetMs: 500, now: () => t });
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.poster.rounds === 1);
    assert.equal(c.calls.length, 1, '超预算就不再开新一轮');
  });

  test('超预算且手上没有干净图 → ok:false（回落模板，不交违规产物）', async () => {
    let t = 0;
    const c = stubComplete([okHtml('a'), okHtml('b')]);
    const complete: CompleteTextFn = async (s, u) => { const r = await c.fn(s, u); t += 700; return r; };
    const r = await runEngine(complete, stubRender([[marginViolation]]).fn, { budgetMs: 500, now: () => t });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && /预算/.test(r.reason), `原因应指明超预算：${!r.ok ? r.reason : ''}`);
  });

  test('创作提示词把硬约束与宣言一起喂下去（画布/字体栈/AI 标识/量测阈值/文案原文）', async () => {
    const c = stubComplete([okHtml('a'), okHtml('b')]);
    await runEngine(c.fn, stubRender([[], []]).fn);
    const sys = c.calls[0].system;
    assert.match(sys, /540×720/);
    assert.ok(sys.includes(FONT_SANS), '字体栈直接引用 templates 的常量，不在提示词里另抄一份');
    assert.ok(sys.includes(AI_MARK_TEXT));
    assert.match(sys, new RegExp(`≥${MEASURE_LIMITS.minFontPx}px`));
    assert.match(sys, new RegExp(`≥${MEASURE_LIMITS.minMarginPx}px`));
    assert.match(sys, /禁 JavaScript/);
    assert.match(sys, /一个字都不许自创/, '文案原样是硬约束（图片模型时代最常见的翻车是自创业务承诺）');
    const usr = c.calls[0].user;
    assert.ok(usr.includes(MANIFESTO.movement) && usr.includes(MANIFESTO.paragraphs[0]), '宣言必须进 user');
    assert.ok(usr.includes(BRIEF.headline) && usr.includes(BRIEF.cta));
    assert.match(usr, /不要留空的图位/, '没素材时明确禁止"留占位框"（真机翻车形态之一）');
  });

  // ★ 与量测器的 decor 豁免是**一份口径两处实现**：提示词不说清楚，模型就不会打标记，
  //   量测器那一侧的豁免等于永不生效（生产实锤就是三轮全卡在 text_overlap 上）。
  test('创作提示词写清装饰叠层约定：带 data-poster-decor 才放行重叠，信息层之间禁止真重叠', async () => {
    const c = stubComplete([okHtml('a'), okHtml('b')]);
    await runEngine(c.fn, stubRender([[], []]).fn);
    const sys = c.calls[0].system;
    assert.ok(sys.includes(DECOR_ATTR), '属性名必须直接引用量测器的常量口径，不在提示词里另抄一个名字');
    assert.equal(DECOR_ATTR, 'data-poster-decor');
    assert.match(sys, /文字叠层是受欢迎的设计手法/, '要先把叠层说成正当手法，否则模型只会一味避让');
    assert.match(sys, /信息层之间禁止真重叠/);
    assert.match(sys, /主标题、副标题、卖点、CTA、落款/, '信息层要点名，不能只说"信息"');
    assert.match(sys, /只豁免重叠这一项/, 'decor 不是万能豁免：出画/贴边/最小字号照旧');
    // 打磨轮同样带着这条约束（system 是拼在打磨指令前面的整段）
    assert.ok(c.calls[1].system.includes(DECOR_ATTR), '打磨轮不许丢掉这条约定');
    assert.match(c.calls[1].system, /别把信息文字标成装饰/, '打磨轮最容易发生"给信息文字贴 decor 逃逸"');
  });

  test('提供二维码素材 → 提示词要求 data-role="qr" 与白底静区', async () => {
    const c = stubComplete([okHtml('a'), okHtml('b')]);
    await generateCanvasPoster(
      { brief: BRIEF, manifesto: MANIFESTO, assets: { qrUrl: 'data:image/png;base64,AAA' } },
      { complete: c.fn, render: stubRender([[], []]).fn },
    );
    assert.match(c.calls[0].user, /data-role="qr"/);
    assert.ok(c.calls[0].user.includes(CANVAS_PLACEHOLDER.qr));
  });
});

/* ───────────────── ④ 宣言 / 提示词纯函数 ───────────────── */

describe('AI 排版引擎 · 宣言与提示词', () => {
  test('mock 模式（无 live provider）→ generateManifesto 返回 null，绝不伪造一篇兜底长文', async () => {
    const r = await generateManifesto({ brief: BRIEF, fallbackPalette: ['#111111', '#222222', '#333333'] });
    assert.equal(r, null, '一篇谁都能写的兜底宣言只会让画质不如调过版的模板');
  });

  test('completeText 在测试/mock 环境返回 null（不伪造产出，与 structured 同口径）', async () => {
    assert.equal(await completeText('sys', 'user'), null);
  });

  test('violationsCritique 逐条编号并带 selector + 数值', () => {
    const text = violationsCritique([marginViolation, { code: 'min_font', selector: 'p.tag', detail: '字号 8px 小于下限 10px' }]);
    assert.match(text, /^1\. \[margin\] div\.poster/m);
    assert.match(text, /^2\. \[min_font\] p\.tag —— 字号 8px/m);
  });

  test('模板回落路径的图片提示词：带色板色彩词 + 负向约束（第 1 档止血）', () => {
    const p = fallbackPhilosophy(BRIEF, null);
    const prompt = composeVisualPrompt(BRIEF, p);
    assert.match(prompt, /整体色调锁定在/, '不传色板 → 图片模型自选配色 → 撞色（真机实测）');
    assert.match(prompt, /不要出现任何文字/);
    assert.match(prompt, /不要画 UI 界面/, '「留出负空间」曾被画成三个空的占位卡片');
    assert.match(prompt, /占位框/);
    assert.match(prompt, /负空间/);
  });
});

/* ───────────────── ⑤ 量测器 · 叠层豁免判定（假 DOM，不起浏览器） ───────────────── */

// posterScanFn 是**页内自包含函数**（只经 globalThis 取 document / getComputedStyle，不引用任何模块常量），
// 所以给它一个最小假 DOM 就能在常规 npm test 里钉住判定分支——不必把这组用例押在 Chromium 上。
// 与下面 ⑥ 的真渲染组互补：这里管「分支对不对」，那里管「量的是不是真实布局」。
interface FakeNode {
  tag?: string;
  cls?: string;
  /** 叶子块的自有文字（有 children 的节点不参与文字判定，与真实 DOM 同口径）。 */
  text?: string;
  /** [left, top, right, bottom]，画布坐标。 */
  rect: [number, number, number, number];
  fontSize?: number;
  attrs?: Record<string, string>;
  children?: FakeNode[];
}

interface FakeEl {
  tagName: string; className: string; children: FakeEl[]; parentElement: FakeEl | null;
  textContent: string; fontSize: number;
  getAttribute(n: string): string | null;
  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number };
  querySelectorAll(s: string): FakeEl[];
  querySelector(s: string): FakeEl | null;
  scrollWidth: number; scrollHeight: number;
  contains(o: unknown): boolean;
}

function buildFake(spec: FakeNode, parent: FakeEl | null): FakeEl {
  const [left, top, right, bottom] = spec.rect;
  const kids: FakeEl[] = [];
  const el: FakeEl = {
    tagName: (spec.tag ?? 'p').toUpperCase(),
    className: spec.cls ?? '',
    children: kids,
    parentElement: parent,
    textContent: spec.text ?? '',
    fontSize: spec.fontSize ?? 16,
    getAttribute: (n) => spec.attrs?.[n] ?? null,
    getBoundingClientRect: () => ({ left, top, right, bottom, width: right - left, height: bottom - top }),
    querySelectorAll: () => descendants(el),
    querySelector: () => null,
    scrollWidth: right - left,
    scrollHeight: bottom - top,
    contains: (o) => o === el || kids.some((k) => k.contains(o)),
  };
  for (const c of spec.children ?? []) kids.push(buildFake(c, el));
  return el;
}

function descendants(el: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  for (const k of el.children) { out.push(k); out.push(...descendants(k)); }
  return out;
}

/**
 * 在假 DOM 上跑一遍量测。默认 headline 传空串（跳过标题在场检查），画面文字里塞好 AI 标识，
 * 这样每条用例只需要盯自己那一类违规。
 */
function scanFake(nodes: FakeNode[], o: { headline?: string } = {}): PosterViolation[] {
  const canvas = buildFake({ tag: 'div', cls: CANVAS_CLASS, rect: [0, 0, 540, 720], children: nodes }, null);
  const innerText = [...descendants(canvas).map((n) => n.textContent).filter(Boolean), AI_MARK_TEXT].join(' ');
  const g = globalThis as unknown as Record<string, unknown>;
  const prevDoc = g.document;
  const prevCs = g.getComputedStyle;
  g.document = {
    body: { innerText, innerHTML: innerText },
    querySelector: (s: string) => (s === `.${CANVAS_CLASS}` ? canvas : null),
    querySelectorAll: () => [],
  };
  g.getComputedStyle = (el: FakeEl) => ({
    fontSize: `${el.fontSize}px`, display: 'block', visibility: 'visible', opacity: '1',
    backgroundColor: 'rgb(255,255,255)',
    paddingTop: '8px', paddingRight: '8px', paddingBottom: '8px', paddingLeft: '8px',
    objectFit: 'contain',
  });
  try {
    return posterScanFn(posterScanArg({ headline: o.headline ?? '', expectQr: false, canvasClass: CANVAS_CLASS })).violations;
  } finally {
    g.document = prevDoc;
    g.getComputedStyle = prevCs;
  }
}

const of = (vs: PosterViolation[], code: string): PosterViolation[] => vs.filter((v) => v.code === code);

describe('AI 排版引擎 · 量测器叠层豁免（decor 只免重叠，不免出画）', () => {
  /** 两块几乎完全重合的文字（交叠远超较小块 25%）。attrs 挂在其中一块上。 */
  const stacked = (attrs?: Record<string, string>): FakeNode[] => [
    { tag: 'div', text: '大字背景', rect: [60, 200, 460, 420], fontSize: 180, ...(attrs ? { attrs } : {}) },
    { tag: 'p', text: '层叠标注', rect: [70, 210, 450, 400], fontSize: 18 },
  ];

  test('两个普通文字块重叠 → 照旧报 text_overlap（信息层之间禁止真重叠）', () => {
    const vs = scanFake(stacked());
    assert.equal(of(vs, 'text_overlap').length, 1, `实际：${vs.map((v) => v.code).join(',') || '无'}`);
    assert.match(of(vs, 'text_overlap')[0].detail, /压/);
  });

  test(`一方带 ${DECOR_ATTR} → 不再报 text_overlap（大字当背景图形是正当手法）`, () => {
    const vs = scanFake(stacked({ [DECOR_ATTR]: '1' }));
    assert.deepEqual(of(vs, 'text_overlap'), [], `装饰叠层被误伤：${vs.map((v) => v.code).join(',')}`);
  });

  test('装饰属性挂在祖先容器上也算（叠层通常是一个容器裹着若干文字叶子）', () => {
    const vs = scanFake([
      {
        tag: 'div', attrs: { [DECOR_ATTR]: '1' }, rect: [60, 200, 460, 420],
        children: [{ tag: 'span', text: '大字背景', rect: [60, 200, 460, 420], fontSize: 180 }],
      },
      { tag: 'p', text: '层叠标注', rect: [70, 210, 450, 400], fontSize: 18 },
    ]);
    assert.deepEqual(of(vs, 'text_overlap'), [], '只认叶子上的属性会逼模型给每个字都贴一遍');
  });

  test(`${DECOR_ATTR} **不**豁免出画/边距/最小字号（装饰字也不许出画）`, () => {
    const vs = scanFake([
      { tag: 'div', text: '出画的大字', rect: [-80, 200, 300, 420], fontSize: 180, attrs: { [DECOR_ATTR]: '1' } },
    ]);
    assert.equal(of(vs, 'out_of_bounds').length, 1, `实际：${vs.map((v) => v.code).join(',') || '无'}`);
    assert.match(of(vs, 'out_of_bounds')[0].detail, /left=-80/);
    assert.equal(of(vs, 'margin').length, 1, 'decor 不是万能豁免：贴边照旧报');

    const tiny = scanFake([{ tag: 'div', text: '小字', rect: [60, 200, 200, 220], fontSize: 7, attrs: { [DECOR_ATTR]: '1' } }]);
    assert.equal(of(tiny, 'min_font').length, 1, '装饰字也不许小到印不出来');
  });

  test('exempt 与 decor 语义不串：exempt 只免边距，不免重叠', () => {
    const vs = scanFake(stacked({ 'data-poster-exempt': '1' }));
    assert.equal(of(vs, 'text_overlap').length, 1, 'exempt 是服务端注入物的边距豁免，不该顺带放行压字');
  });
});

/* ───────────────── ⑥ 量测器（真实浏览器；缺 Chromium 则跳过） ───────────────── */

// NODE_ENV=test 下 renderHtmlToPng 默认返回 1×1 桩 PNG（reportPdf 的红线①），
// 而量测器量的就是真实布局 —— 只能显式 allowInTestMode 打开真渲染。
// 因此本组用例默认**跳过**：常规 npm test 不该为了一组用例把整条链路押在 Chromium 上。
// 本地/CI 验证跑：`PUPPETEER_REAL=1 npm test`。
const realBrowser = process.env.PUPPETEER_REAL === '1';
describe('AI 排版引擎 · 量测器（真实渲染）', { skip: realBrowser ? false : '需要真实 Chromium：用 PUPPETEER_REAL=1 npm test 跑这组' }, () => {
  const page = (body: string, extraCss = ''): string =>
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><style>`
    + `html,body{margin:0;width:540px;height:720px}`
    + `.${CANVAS_CLASS}{width:540px;height:720px;overflow:hidden;position:relative;`
    + `font-family:${FONT_SANS};background:#16241E;color:#fff}${extraCss}</style></head>`
    + `<body><div class="${CANVAS_CLASS}">${body}</div></body></html>`;

  const measure = async (html: string, o: { expectQr?: boolean } = {}): Promise<PosterViolation[]> => {
    const r = await renderCanvasPoster(html, {
      headline: BRIEF.headline, expectQr: !!o.expectQr, allowInTestMode: true, timeoutMs: 30_000,
    });
    assert.equal(r.measured, true, '量测必须真的跑起来了（否则下面的断言全是假绿）');
    return r.rendered.violations;
  };

  const codes = (vs: PosterViolation[]): string[] => [...new Set(vs.map((v) => v.code))].sort();

  test('规范排版 → 零违规（这条是引擎能不能在生产成功的下限）', async () => {
    const html = page(
      `<div style="padding:40px 34px"><h1 style="font-size:34px;margin:0">${BRIEF.headline}</h1>`
      + `<p style="font-size:15px;margin-top:14px">${BRIEF.subheadline}</p></div>`
      + `<div style="position:absolute;left:0;right:0;bottom:0;height:22px;text-align:center;font-size:10px" data-poster-exempt="1">${AI_MARK_TEXT}</div>`,
    );
    assert.deepEqual(await measure(html), [], '干净样例不该报违规');
  });

  test('溢出 / 越界 / 边距 / 最小字号 / 重叠 各自被抓到，且违规带 selector 与数值', async () => {
    const overflow = await measure(page(`<div style="height:900px">${BRIEF.headline}</div><div>${AI_MARK_TEXT}</div>`));
    assert.ok(codes(overflow).includes('overflow'), `实际：${codes(overflow).join(',')}`);
    assert.match(overflow.find((v) => v.code === 'overflow')!.detail, /超出 540×720/);

    const oob = await measure(page(
      `<h1 class="hd" style="position:absolute;left:-60px;top:40px;font-size:30px">${BRIEF.headline}</h1><div>${AI_MARK_TEXT}</div>`,
    ));
    const oobV = oob.find((v) => v.code === 'out_of_bounds');
    assert.ok(oobV, `实际：${codes(oob).join(',')}`);
    assert.match(oobV!.selector, /h1\.hd/, 'selector 要能直接定位到元素');
    assert.match(oobV!.detail, /left=-60/);

    const margin = await measure(page(
      `<h1 style="position:absolute;left:3px;top:300px;font-size:24px">${BRIEF.headline}</h1><div>${AI_MARK_TEXT}</div>`,
    ));
    assert.ok(codes(margin).includes('margin'), `实际：${codes(margin).join(',')}`);
    assert.match(margin.find((v) => v.code === 'margin')!.detail, new RegExp(`下限 ${MEASURE_LIMITS.minMarginPx}px`));

    const tiny = await measure(page(
      `<div style="padding:40px"><h1 style="font-size:24px">${BRIEF.headline}</h1>`
      + `<p style="font-size:7px">${BRIEF.cta}</p></div><div>${AI_MARK_TEXT}</div>`,
    ));
    assert.ok(codes(tiny).includes('min_font'), `实际：${codes(tiny).join(',')}`);
    assert.match(tiny.find((v) => v.code === 'min_font')!.detail, /7px/);

    const overlap = await measure(page(
      `<h1 style="position:absolute;left:60px;top:200px;width:300px;font-size:26px">${BRIEF.headline}</h1>`
      + `<p style="position:absolute;left:62px;top:205px;width:290px;font-size:20px">${BRIEF.subheadline}</p>`
      + `<div>${AI_MARK_TEXT}</div>`,
    ));
    assert.ok(codes(overlap).includes('text_overlap'), `实际：${codes(overlap).join(',')}`);
    assert.match(overlap.find((v) => v.code === 'text_overlap')!.detail, /重叠/);
  });

  // 真实布局下的叠层豁免（假 DOM 那组管分支，这里管「浏览器里量出来也一样」）。
  test(`真实渲染：带 ${DECOR_ATTR} 的大字叠层不报 text_overlap，但出画照旧报`, async () => {
    const layer = (attr: string): string =>
      `<div ${attr} style="position:absolute;left:40px;top:180px;font-size:190px;line-height:1;`
      + `letter-spacing:-.04em;color:rgba(255,255,255,.10)">直</div>`
      + `<h1 style="position:absolute;left:60px;top:240px;width:380px;font-size:30px;margin:0">${BRIEF.headline}</h1>`
      + `<div>${AI_MARK_TEXT}</div>`;

    const plain = await measure(page(layer('')));
    assert.ok(codes(plain).includes('text_overlap'), `没标记的重叠必须拦：${codes(plain).join(',')}`);

    const declared = await measure(page(layer(`${DECOR_ATTR}="1"`)));
    assert.ok(!codes(declared).includes('text_overlap'), `声明为装饰层就不该误伤：${codes(declared).join(',')}`);

    const outOfPage = await measure(page(
      `<div ${DECOR_ATTR}="1" style="position:absolute;left:-90px;top:180px;font-size:190px;line-height:1">直</div>`
      + `<h1 style="position:absolute;left:60px;top:520px;font-size:30px;margin:0">${BRIEF.headline}</h1>`
      + `<div>${AI_MARK_TEXT}</div>`,
    ));
    assert.ok(codes(outOfPage).includes('out_of_bounds'), `装饰字出画照旧报：${codes(outOfPage).join(',')}`);
  });

  test('必要文案缺失 / AI 标识被隐藏 / 占位符残留 各自被抓到', async () => {
    const noHeadline = await measure(page(`<div style="padding:40px">别的文案</div><div>${AI_MARK_TEXT}</div>`));
    assert.ok(codes(noHeadline).includes('headline_missing'));

    const hidden = await measure(page(
      `<div style="padding:40px">${BRIEF.headline}</div><div style="display:none">${AI_MARK_TEXT}</div>`,
    ));
    assert.ok(codes(hidden).includes('aimark_missing'), 'CSS 隐藏合规标识必须被抓到');

    const residue = await measure(page(
      `<div style="padding:40px">${BRIEF.headline}</div><img src="${CANVAS_PLACEHOLDER.logo}" alt=""><div>${AI_MARK_TEXT}</div>`,
    ));
    assert.ok(codes(residue).includes('placeholder_residue'));
    assert.match(residue.find((v) => v.code === 'placeholder_residue')!.detail, /LOGO_URL/);
  });

  test('二维码可扫性：缺 data-role / 尺寸不足 / 静区不足都算 qr_quiet_zone', async () => {
    const noRole = await measure(
      page(`<div style="padding:40px">${BRIEF.headline}</div><div>${AI_MARK_TEXT}</div>`),
      { expectQr: true },
    );
    assert.ok(codes(noRole).includes('qr_quiet_zone'));

    const tinyQr = await measure(
      page(
        `<div style="padding:40px">${BRIEF.headline}</div>`
        + `<div style="position:absolute;right:30px;bottom:40px;padding:8px;background:#fff">`
        + `<img data-role="qr" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=" style="width:40px;height:40px"></div>`
        + `<div>${AI_MARK_TEXT}</div>`,
      ),
      { expectQr: true },
    );
    const sized = tinyQr.find((v) => v.code === 'qr_quiet_zone');
    assert.ok(sized, `实际：${codes(tinyQr).join(',')}`);
    assert.match(sized!.detail, new RegExp(`小于 ${MEASURE_LIMITS.qrMinPx}px`));

    const noQuiet = await measure(
      page(
        `<div style="padding:40px">${BRIEF.headline}</div>`
        + `<div style="position:absolute;right:30px;bottom:40px;padding:1px;background:#16241E">`
        + `<img data-role="qr" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=" style="width:80px;height:80px"></div>`
        + `<div>${AI_MARK_TEXT}</div>`,
      ),
      { expectQr: true },
    );
    assert.ok(noQuiet.some((v) => v.code === 'qr_quiet_zone' && /静区/.test(v.detail)));
  });

  test('渲染加固生效：内联脚本不执行、外链图片被拦（sanitizer 之外的第二道闸）', async () => {
    // 这份 HTML 故意绕过 sanitizer（直接喂给渲染层），验证网络层与脚本开关本身在挡：
    const html = page(
      `<div id="t" style="padding:40px;font-size:20px">${BRIEF.headline}</div>`
      + `<img src="https://127.0.0.1:9/should-not-load.png" alt="">`
      + `<div>${AI_MARK_TEXT}</div>`,
    ).replace('</body>', '<script>document.getElementById("t").textContent="HACKED"</script></body>');
    const vs = await measure(html);
    assert.ok(
      !vs.some((v) => v.code === 'headline_missing'),
      '脚本若执行，标题会被改成 HACKED → 会报 headline_missing。没报说明脚本确实没跑',
    );
  });
});

/* ───────────────── ⑦ worker 回落矩阵与后台开关 ───────────────── */

async function posterUser(credits = 200): Promise<{ token: string; tenantId: string }> {
  const token = await login(uniquePhone(), '排版引擎用户');
  const user = await prisma.user.findUniqueOrThrow({ where: { id: token }, select: { tenantId: true } });
  await prisma.userAgent.create({ data: { userId: token, agentKey: 'poster', source: 'admin_grant' } });
  await grantCredits(user.tenantId, token, credits, '测试充值');
  return { token, tenantId: user.tenantId };
}

async function createJob(token: string, key: string): Promise<string> {
  const r = await api('POST', '/api/creative/posters', {
    token,
    body: {
      brief: {
        scene: 'service', goal: '让本地酒店老板来聊直客运营', audience: '单体酒店与民宿老板',
        headline: '不再靠 OTA 活着', subheadline: '直客占比做到 45%',
        proofPoints: ['服务 60 家单体酒店'], cta: '扫码领诊断', ratio: '3:4',
      },
      idempotencyKey: key,
    },
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.jobId;
}

before(async () => { await getApp(); });
after(async () => { await closeApp(); });

describe('AI 排版引擎 · worker 回落矩阵', () => {
  beforeEach(async () => {
    await cleanBusiness();
    await seedBaseline();
    await setFeatureFlag(CREATIVE_FLAG_ID, true);
    __clearFeatureCache();
  });

  // 生产现状：layoutEngine 默认 'ai'，部署即切换。测试环境没有真实模型（completeText → null），
  // 于是这条用例正好覆盖最关键的那格：**AI 引擎不可用时付费任务照样交付**。
  test('默认 ai 引擎 + 模型不可用 → 任务仍成功，engine=template_fallback 且回落原因落库', async () => {
    assert.equal(DEFAULT_LAYOUT_ENGINE, 'ai', '默认必须是 ai（部署即切换，安全性靠回落兜）');
    const { token } = await posterUser();
    const jobId = await createJob(token, 'ai-fallback');
    await tickCreativeWorker();

    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'succeeded', `AI 引擎失败绝不能让付费任务失败：${job.errorCode} ${job.errorMessage}`);
    assert.equal(job.refundedAt, null);
    const result = job.resultJson as { engine?: string; aiEngineError?: string; templateKey?: string; rounds?: number };
    assert.equal(result.engine, 'template_fallback');
    assert.ok(result.aiEngineError && /模型不可用|宣言/.test(result.aiEngineError), `回落原因：${result.aiEngineError}`);
    assert.equal(result.templateKey, 'editorial', '回落走的是完整模板路径（含版式选择）');
    assert.equal(result.rounds, undefined, '回落产物没有轮数');
    assert.equal(await prisma.creativeAsset.count({ where: { jobId, kind: 'poster_png' } }), 1, '照样交一张成品');

    // 任务台必须能看出这一单其实没走 AI（否则"AI 排版整天没生效"只存在于日志里）
    const list = await api('GET', '/api/admin/creative/jobs');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.items[0].layoutEngine, 'template_fallback');
    assert.equal(list.body.items[0].rounds, null);
    assert.ok(String(list.body.items[0].aiEngineError ?? '').length > 0, '回落原因要在任务台可见');
    assert.equal(list.body.items[0].engine, 'native', 'CreativeJob.engine 仍是任务模型引擎，两者别混');
  });

  test('layoutEngine=template → 老路径不变，engine=template 且不带回落原因', async () => {
    await setFeatureFlagPayload(CREATIVE_FLAG_ID, { layoutEngine: 'template' });
    __clearFeatureCache();
    const { token } = await posterUser();
    const jobId = await createJob(token, 'tpl-only');
    await tickCreativeWorker();

    const job = await prisma.creativeJob.findUniqueOrThrow({ where: { id: jobId } });
    assert.equal(job.status, 'succeeded', `${job.errorCode} ${job.errorMessage}`);
    const result = job.resultJson as { engine?: string; aiEngineError?: string; degraded?: boolean };
    assert.equal(result.engine, 'template');
    assert.equal(result.aiEngineError, undefined, '配置就是模板 → 不是回落，不该有回落原因');
    assert.equal(result.degraded, false);
    assert.ok((job.promptSnapshot ?? '').includes('空间与形'), '模板路径的快照仍是六维度哲学');
    assert.equal((await api('GET', '/api/admin/creative/jobs')).body.items[0].layoutEngine, 'template');
  });

  test('后台契约：GET 默认回 layoutEngine=ai；PUT 可切换；非法值回落默认', async () => {
    const got = await api('GET', '/api/admin/creative/config');
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.layoutEngine, 'ai', '缺省即 AI 引擎');

    const put = await api('PUT', '/api/admin/creative/config', { body: { layoutEngine: 'template' } });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.layoutEngine, 'template');
    assert.equal((await api('GET', '/api/admin/creative/config')).body.layoutEngine, 'template', '写入即生效');

    const bogus = await api('PUT', '/api/admin/creative/config', { body: { layoutEngine: 'anthropic_skill' } });
    assert.equal(bogus.body.layoutEngine, 'ai', '白名单外的值一律按默认处理，不落一个会撒谎的标签');
  });
});
