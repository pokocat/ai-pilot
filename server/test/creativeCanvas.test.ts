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
  generateCanvasPoster, MAX_HTML_CALLS, MAX_VISION_CALLS, MAX_DEBUG_HTML_CHARS,
  type CompleteTextFn, type CanvasRenderFn, type CritiqueFn,
} from '../src/services/creative/canvasEngine.js';
import {
  parseCritique, critiqueSystemPrompt, critiqueDirective, MAX_CRITIQUE_NOTES,
} from '../src/services/creative/visualCritique.js';
import { POSTER_STYLE_LIST } from '../src/services/creative/styleLibrary.js';
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

type StubCall = {
  system: string; user: string;
  /** 本轮是否把上一版成品图发了过去（看图打磨的断言锚点）。 */
  hasImage: boolean;
  allowThinking: boolean;
  timeoutMs?: number;
};
function stubComplete(replies: (string | null)[]): { fn: CompleteTextFn; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fn: CompleteTextFn = async (system, user, o) => {
    calls.push({
      system, user, hasImage: !!o?.images?.length, allowThinking: !!o?.allowThinking,
      ...(o?.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
    });
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

/**
 * 默认注入「视觉评审不可用」（`critique: () => null`）。
 *
 * 这不是图省事：本文件里那批 refine 闭环用例钉的是**量测闭环**的契约（无条件打磨、退回干净图、
 * 违规回喂），而视觉评审是叠在它之上的顾问层。缺省关掉它，这些用例就精确地描述了
 * 「评审挂了 = 回到 2026-07-29 的老行为」这条兼容性承诺——那正是引擎里那条 `!verdict && polished`
 * 分支的存在理由。要测评审本身的用例显式传 `critique`（见 ⑤ 组）。
 */
async function runEngine(
  complete: CompleteTextFn,
  render: CanvasRenderFn,
  o: {
    budgetMs?: number; now?: () => number; moderateText?: (t: string) => Promise<boolean>;
    critique?: CritiqueFn;
  } = {},
) {
  return generateCanvasPoster(
    { brief: BRIEF, manifesto: MANIFESTO, assets: {}, ...(o.budgetMs ? { budgetMs: o.budgetMs } : {}) },
    {
      complete,
      render,
      critique: o.critique ?? (async () => null),
      ...(o.now ? { now: o.now } : {}),
      ...(o.moderateText ? { moderateText: o.moderateText } : {}),
    },
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

  // ★ 2026-08-12 预发实测：5 次标准档有 2 次死在这一条上，症状是「三轮全被拒 → 回落模板」，
  //   而系统提示词恰恰写着「你自己写的 data:image URI（如内联 SVG）」合法。原因是允许规则里
  //   媒体类型后面钉死了 `;`，而 RFC 2397 的 `;base64` 是可选的 —— 非 base64 的内联 SVG
  //   （CSS 里最常见的写法，比 base64 更短）走的是 `,`。
  test('非 base64 的内联 SVG data URI 放行（`;base64` 是可选的，别只认分号）', () => {
    const svg = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E"
      + "%3Ccircle cx='4' cy='4' r='3' fill='%23c9a227'/%3E%3C/svg%3E";
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">`
      + `<style>.${CANVAS_CLASS}{width:540px;height:720px;overflow:hidden;position:relative;`
      + `background-image:url("${svg}")}</style></head>`
      + `<body><div class="${CANVAS_CLASS}"><h1>${BRIEF.headline}</h1>`
      + `<div>${AI_MARK_TEXT}</div></div></body></html>`;
    const r = sanitizeCanvasHtml(html);
    assert.equal(r.ok, true, r.ok ? '' : r.issues.join('；'));
  });

  // 放行非 base64 SVG 的同时补的那道闸：百分号编码会把 `<script>` 藏成 `%3Cscript`，
  // 文档级的 `<script>` 正则根本看不见它 —— 必须先解码再查一遍。
  test('内联 SVG 里藏脚本（百分号编码的 %3Cscript）仍然整份打回', () => {
    const evil = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E"
      + "%3Cscript%3Ealert(1)%3C/script%3E%3C/svg%3E";
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">`
      + `<style>.${CANVAS_CLASS}{width:540px;height:720px;background-image:url("${evil}")}</style></head>`
      + `<body><div class="${CANVAS_CLASS}"><h1>${BRIEF.headline}</h1></div></body></html>`;
    const r = sanitizeCanvasHtml(html);
    assert.equal(r.ok, false, '编码过的脚本不能因为"看起来是张图"就放行');
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
    // ★ 回喂的必须是**占位符形态的源码**，不是渲染用的那份：影像档的 {{VISUAL_URL}} 会被换成
    //   约 200KB 的 base64，回喂它等于把 60k 的 user 额度烧在一串模型自己写不出的字节上，
    //   还会被拦腰截断成读不懂的残片（2026-08-12 预发实测 usr=209720）。
    assert.match(c.calls[1].user, /\{\{VISUAL_URL\}\}|<p>first<\/p>/, '带的是模型自己的源码');
    assert.doesNotMatch(c.calls[1].user, /base64,[A-Za-z0-9+/]{200}/, '绝不把素材字节回喂给模型');
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

  // 轮数上限是个会变的旋钮，所以桩按 MAX_HTML_CALLS 生成，
  // 不写死。改上限时这两条用例应当自动跟着走，而不是留下一条"名字说 4 轮、其实只喂了 3 轮"的假绿。
  test(`${MAX_HTML_CALLS} 轮仍违规 → 不交付，返回 ok:false 让 worker 回落模板`, async () => {
    const labels = Array.from({ length: MAX_HTML_CALLS }, (_, i) => `r${i + 1}`);
    const c = stubComplete([...labels.map(okHtml), okHtml('never')]);
    const render = stubRender(labels.map(() => [marginViolation]));
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
    const labels = Array.from({ length: MAX_HTML_CALLS }, (_, i) => `r${i + 1}`);
    const c = stubComplete([...labels.map(bigHtml), bigHtml('never')]);
    const render = stubRender(labels.map(() => [marginViolation]));
    const r = await runEngine(c.fn, render.fn);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.lastHtml, '没有产物留痕的话，下次误伤仍然只能猜');
    assert.equal(!r.ok && r.lastHtml!.length, MAX_DEBUG_HTML_CHARS, '截断上限要钉住（这串会进 DB 的 metadataJson）');
    assert.ok(!r.ok && r.lastHtml!.includes(`<p>${labels[MAX_HTML_CALLS - 1]}</p>`), `留的必须是第 ${MAX_HTML_CALLS} 轮那份产物`);
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

  // 预算数值要贴着真实量级写：引擎的开轮闸是「剩余 < 60s 就不开新一轮」（单轮 HTML 开思考
  // 挂钟 1–2.5 分钟，剩 30s 开一轮只会被自己的超时掐断）。所以这里给 90s 预算 + 每轮走 70s：
  // 第一轮开得起来，跑完剩 20s，第二轮被闸住。用 500ms/700ms 那种玩具数值会连第一轮都开不了。
  test('超预算但手上有干净图 → 交那张（rounds=1 是唯一一种打磨没跑完的合法形态）', async () => {
    let t = 0;
    const c = stubComplete([okHtml('a'), okHtml('b')]);
    const complete: CompleteTextFn = async (s, u) => { const r = await c.fn(s, u); t += 70_000; return r; };
    const r = await runEngine(complete, stubRender([[], []]).fn, { budgetMs: 90_000, now: () => t });
    assert.equal(r.ok, true);
    assert.ok(r.ok && r.poster.rounds === 1);
    assert.equal(c.calls.length, 1, '超预算就不再开新一轮');
  });

  test('超预算且手上没有干净图 → ok:false（回落模板，不交违规产物）', async () => {
    let t = 0;
    const c = stubComplete([okHtml('a'), okHtml('b')]);
    const complete: CompleteTextFn = async (s, u) => { const r = await c.fn(s, u); t += 70_000; return r; };
    const r = await runEngine(complete, stubRender([[marginViolation]]).fn, { budgetMs: 90_000, now: () => t });
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

  // 2026-08-12 三方出图对比实锤：没给二维码素材时，两版引擎都自己画了个"像二维码"的方块阵。
  // 扫出来是空的 —— 对外物料上的假码是信任事故。量测器拦不住（qr_quiet_zone 只认
  // <img data-role="qr">，手画的 SVG 方块阵在它眼里就是普通图形），只能在提示词里堵。
  test('没有二维码素材 → 提示词显式禁止自己画一个像二维码的图案', async () => {
    const c = stubComplete([okHtml('a'), okHtml('b')]);
    await runEngine(c.fn, stubRender([[], []]).fn);   // assets 为空 = 没给二维码
    assert.match(c.calls[0].system, /不许自己画一个像二维码的东西/);
    assert.match(c.calls[0].system, /扫出来是空的|印在对外物料上就是欺骗/);
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

  // 反廉价清单管的是「像不像自动生成的」——这些特征量测器一条都量不出来（卡里套卡、处处居中、
  // 阴影堆浮起来的卡片都完全合规），所以只能靠提示词钉住。删掉它不会有任何用例变红，除了这一条。
  test('反廉价清单进创作提示词，且打磨轮不会把它丢掉', async () => {
    const c = stubComplete([okHtml('a'), okHtml('b')]);
    await runEngine(c.fn, stubRender([[], []]).fn);
    for (const sys of [c.calls[0].system, c.calls[1].system]) {
      assert.match(sys, /卡里套卡/, 'AI 生成图最典型的特征，必须显式点名');
      assert.match(sys, /不要均匀铺满/);
      assert.match(sys, /不要处处居中/);
      assert.match(sys, /box-shadow/, '靠阴影把卡片浮起来是廉价感头号来源');
    }
  });
});

/* ───────────────── ③′ 视觉评审闭环（看图打磨） ───────────────── */

/** 排队返回评审判定；null 表示「评审不可用」。记录被看过的图，用来断言看的是哪一轮的产物。 */
function stubCritique(verdicts: ({
  pass: boolean; notes: string[]; needsRebuild?: boolean; rebuildReason?: string;
} | null)[]): {
  fn: CritiqueFn; seen: string[];
} {
  const seen: string[] = [];
  const fn: CritiqueFn = async (i) => {
    seen.push(i.png.toString());
    const verdict = verdicts[seen.length - 1] ?? null;
    return verdict ? {
      ...verdict,
      needsRebuild: verdict.needsRebuild ?? false,
      rebuildReason: verdict.rebuildReason ?? '',
    } : null;
  };
  return { fn, seen };
}

describe('AI 排版引擎 · 视觉评审解析（纯函数）', () => {
  test('判定达标 → pass=true 且不带意见（后面即使习惯性写了两句也不算要改）', () => {
    assert.deepEqual(parseCritique('判定：达标'), { pass: true, needsRebuild: false, rebuildReason: '', notes: [] });
    assert.deepEqual(
      parseCritique('判定：达标\n1. 硬要说的话字距可以再收一点'),
      { pass: true, needsRebuild: false, rebuildReason: '', notes: [] },
      '达标就是收工信号；把后面的客套话当成"要改"会白烧一轮',
    );
  });

  test('判定可提升 → 逐条解析编号意见，各种编号符号都收（模型对符号的遵从性向来不稳）', () => {
    const r = parseCritique('判定：可提升\n1. 主副标题音量差不够\n2） 右下角留白塌了\n- 色彩明度层次拉不开');
    assert.equal(r?.pass, false);
    assert.deepEqual(r?.notes, ['主副标题音量差不够', '右下角留白塌了', '色彩明度层次拉不开']);
  });

  test(`意见条数截到 ${MAX_CRITIQUE_NOTES} 条（给多了打磨轮每条都只做半截）`, () => {
    const many = Array.from({ length: 9 }, (_, i) => `${i + 1}. 第${i + 1}条`).join('\n');
    assert.equal(parseCritique(`判定：可提升\n${many}`)?.notes.length, MAX_CRITIQUE_NOTES);
  });

  test('漏了判定行但写了意见 → 按可提升处理（意图是明确的）', () => {
    assert.deepEqual(parseCritique('1. 主标题压到照片人脸上了'), {
      pass: false, needsRebuild: false, rebuildReason: '', notes: ['主标题压到照片人脸上了'],
    });
  });

  // ★ 这条是本模块「顾问不是闸门」的底线：解析不出来一律 null，让引擎按「没有评审」继续走。
  //   千万不要在这里猜一个 pass=true —— 那等于把打磨轮直接抹掉。
  test('空产出 / 既无判定也无意见 → null（宁可没有评审，也不许猜一个判定出来）', () => {
    assert.equal(parseCritique(''), null);
    assert.equal(parseCritique(null), null);
    assert.equal(parseCritique('这张海报整体感觉还不错，挺好的。'), null);
  });

  test('评审提示词钉住三条边界：只谈画面 / 不许加东西 / 不许动文案与合规元素', () => {
    const sys = critiqueSystemPrompt(null);
    assert.match(sys, /严格 JSON/);
    assert.match(sys, /needsRebuild/);
    assert.match(sys, /不要提议加新元素/, '每轮都建议加东西会让画面越改越挤');
    assert.match(sys, /一个字都不能动/, '文案是客户原文，评审无权改');
    assert.match(sys, /AI 生成标识/, '合规元素不许被建议删掉');
  });

  test('影像主导版的评审要额外看"文字压没压脸"（机器量不出来，只能靠看图）', () => {
    assert.doesNotMatch(critiqueSystemPrompt(null), /人物面部/);
    assert.match(critiqueSystemPrompt(POSTER_STYLE_LIST[0]), /人物面部|主体上/);
  });

  test('结构化评审只有明确缺少视觉主角时才允许触发重构', () => {
    assert.deepEqual(
      parseCritique('{"pass":false,"needsRebuild":true,"rebuildReason":"画面没有能承载品牌记忆的视觉主角","notes":[]}'),
      { pass: false, needsRebuild: true, rebuildReason: '画面没有能承载品牌记忆的视觉主角', notes: [] },
    );
    assert.equal(
      parseCritique('{"pass":false,"needsRebuild":true,"rebuildReason":"","notes":[]}'),
      null,
      '重构理由为空时不可猜测或误触发',
    );
  });

  // ★ 宽收严出：下面这几种漂移在真实产出里都出现过，从前每一种都让整份评审（含有效意见）被丢弃，
  //   于是 notes 全丢、机会式重构永不触发、指标还记成「没配 provider」。格式的毛病不该吃掉语义。
  test('JSON 缺 needsRebuild → 默认 false，意见照收（不因少一个字段丢整份评审）', () => {
    assert.deepEqual(
      parseCritique('{"pass":false,"notes":["主副标题音量差不够"]}'),
      { pass: false, needsRebuild: false, rebuildReason: '', notes: ['主副标题音量差不够'] },
    );
  });

  test('JSON 缺 pass 但有意见 → 按可提升处理（与文本格式同一口径）', () => {
    assert.deepEqual(
      parseCritique('{"notes":["右下角留白塌了"]}'),
      { pass: false, needsRebuild: false, rebuildReason: '', notes: ['右下角留白塌了'] },
    );
    assert.equal(parseCritique('{"notes":[]}'), null, '既没判定也没意见 = 没产出，仍然是 null');
  });

  test('布尔写成字符串 "true"/"false" → 收编成布尔', () => {
    assert.deepEqual(
      parseCritique('{"pass":"false","needsRebuild":"true","rebuildReason":"没有视觉主角","notes":[]}'),
      { pass: false, needsRebuild: true, rebuildReason: '没有视觉主角', notes: [] },
    );
    assert.deepEqual(
      parseCritique('{"pass":"true","needsRebuild":"false","rebuildReason":"","notes":[]}'),
      { pass: true, needsRebuild: false, rebuildReason: '', notes: [] },
    );
  });

  test('JSON 前后带导语 / 被 markdown 围栏包住 → 照样解析', () => {
    const expected = { pass: false, needsRebuild: false, rebuildReason: '', notes: ['色彩明度层次拉不开'] };
    assert.deepEqual(
      parseCritique('好的，我看完了，这是我的判断：\n{"pass":false,"needsRebuild":false,"notes":["色彩明度层次拉不开"]}\n以上。'),
      expected,
      '模型爱在 JSON 前写一句导语，那不是"输出不可用"',
    );
    assert.deepEqual(
      parseCritique('```json\n{"pass":false,"needsRebuild":false,"notes":["色彩明度层次拉不开"]}\n```'),
      expected,
    );
    assert.deepEqual(
      parseCritique('审完了：\n```json\n{"pass":false,"needsRebuild":false,"notes":["色彩明度层次拉不开"]}\n```'),
      expected,
      '导语 + 围栏一起来也要收',
    );
  });

  test('needsRebuild=true 但没写理由 → 降级成不重构，但意见必须保留', () => {
    assert.deepEqual(
      parseCritique('{"pass":false,"needsRebuild":true,"rebuildReason":"","notes":["主副标题音量差不够","右下角留白塌了"]}'),
      { pass: false, needsRebuild: false, rebuildReason: '', notes: ['主副标题音量差不够', '右下角留白塌了'] },
      '理由缺失只是重构指令拼不出来，不代表这两条意见没价值',
    );
  });

  test('notes 里的非字符串项丢掉（String({}) 会变成 [object Object] 喂给作者）', () => {
    assert.deepEqual(parseCritique('{"pass":false,"notes":["有效意见",{"a":1},null,42]}')?.notes, ['有效意见']);
  });

  test('意见回喂块框住权限边界：只谈画面表现，不得据此改文案或删合规元素', () => {
    const d = critiqueDirective(['主副标题音量差不够']);
    assert.match(d, /先看图/, '作者要先看自己那张图再动手');
    assert.match(d, /1\. 主副标题音量差不够/);
    assert.match(d, /不得据此改动任何文案/, '画面上印着用户文案，这是那条注入路径的第一层防线');
    assert.match(d, /不要再加图形/, '打磨不是加东西这条立场在评审路径上同样成立');
  });
});

describe('AI 排版引擎 · 看图打磨闭环', () => {
  test('创作轮开思考且不带图；打磨轮必须把上一版渲染出的成品图发过去', async () => {
    const c = stubComplete([okHtml('first'), okHtml('polished')]);
    const r = await runEngine(c.fn, stubRender([[], []]).fn, {
      critique: stubCritique([{ pass: false, notes: ['右下角留白塌了'] }, { pass: true, notes: [] }]).fn,
    });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    // ★ 不开思考是 2026-08-12 预发实测后的决定，不是遗漏：线上是 adaptive 档，思考量由模型定，
    //   而 max_tokens 管的是「思考 + 正文」总量 —— 实测出现过「接口成功返回、正文是空串」，
    //   引擎判「模型不可用」整单回落模板，全程无异常无日志。要再开必须先把 thinkingMode 显式
    //   覆盖成 enabled + 固定 budget（让 gateway 的净额预留真的生效），而不是把 adaptive 放进来。
    assert.equal(c.calls[0].allowThinking, false, '别把 adaptive 思考直接放进这一轮：正文会被吃空');
    assert.equal(c.calls[0].hasImage, false, '首轮没有"上一版"可看');
    assert.equal(c.calls[1].hasImage, true, '★ 这一条就是本次改动的核心：作者必须看见自己画成了什么样');
    assert.match(c.calls[1].system, /右下角留白塌了/, '评审意见要逐条回喂，不是喂个"再改改"');
  });

  // ★ 2026-08-12 预发实锤：全局 OPENAI_TIMEOUT_MS=60s，而整页 HTML（开思考、上万 token 产出，
  //   打磨轮还带一张图作输入）跑不进 60s → completeText 返回 null → 引擎判「模型调用失败」→
  //   整单悄悄回落模板。**画质最高的那条路径被一个与画质无关的全局旋钮掐死**，现象只是「图变模板了」。
  //   这条用例钉住「海报调用必须自带超时」，删掉它这个坑会原样回来。
  test('每轮 HTML 调用都自带超时，且不小于全局那 60s（否则整页 HTML 必被掐断）', async () => {
    const c = stubComplete([okHtml('first'), okHtml('polished')]);
    await runEngine(c.fn, stubRender([[], []]).fn, {
      critique: stubCritique([{ pass: false, notes: ['再收一点'] }, { pass: true, notes: [] }]).fn,
    });
    for (const call of c.calls) {
      assert.ok(call.timeoutMs && call.timeoutMs >= 60_000, `本轮没带够超时：${call.timeoutMs}`);
    }
  });

  test('评审看的是刚渲染出来的那一张（不是上一轮的旧图）', async () => {
    const c = stubComplete([okHtml('first'), okHtml('polished')]);
    const cr = stubCritique([{ pass: false, notes: ['a'] }, { pass: true, notes: [] }]);
    await runEngine(c.fn, stubRender([[], []]).fn, { critique: cr.fn });
    assert.deepEqual(cr.seen, ['r0', 'r1'], 'stubRender 的 buffer 逐轮不同，顺序错了这条就红');
  });

  // ★ 无条件打磨是上游核心机制，评审判定**不能**让它被跳过：
  //   首轮就判达标也照打一轮，否则等于用一个宽松的评委把 2026-07-29 的行为往回退。
  test('首轮就判达标 → 仍然打磨一轮才交付（评审不许跳过 second pass）', async () => {
    const c = stubComplete([okHtml('first'), okHtml('polished')]);
    const r = await runEngine(c.fn, stubRender([[], []]).fn, {
      critique: stubCritique([{ pass: true, notes: [] }, { pass: true, notes: [] }]).fn,
    });
    assert.equal(c.calls.length, 2, '首轮达标也要打磨：这一轮不许省');
    assert.match(c.calls[1].system, /本轮任务：打磨/, '没有意见时走无条件打磨指令');
    assert.ok(r.ok && r.poster.rounds === 2);
    assert.ok(r.ok && r.poster.critiquePassed, '收工是因为达标，不是被轮次耗停');
    assert.ok(r.ok && r.poster.visualCritiques === 2);
  });

  test('明确缺少视觉主角 → 只在既有三轮预算内重构一次', async () => {
    const c = stubComplete([okHtml('first'), okHtml('rebuilt')]);
    const r = await runEngine(c.fn, stubRender([[], []]).fn, {
      critique: stubCritique([
        { pass: false, needsRebuild: true, rebuildReason: '没有明确视觉主角', notes: [] },
        { pass: true, notes: [] },
      ]).fn,
    });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.equal(c.calls.length, 2);
    assert.match(c.calls[1].system, /只此一次/);
    assert.match(c.calls[1].system, /没有明确视觉主角/);
    assert.ok(r.ok && r.poster.rebuildTriggered);
  });

  // ★ 重构是整页推翻重来，一旦引入违规就直接回退、不再给补救轮次。所以它只允许发生在
  //   「第一版就机器干净」+「重构后至少还剩一轮」的位置上。少了这两条约束，最坏情况是
  //   在最后一轮把一张已经干净的图推翻重赌，翻车即回退——整轮白烧且无处补救。
  test('首轮违规 → 修复轮才干净 → 即使判 needsRebuild 也不重构（这版是刚被扳回合规的，不再重赌）', async () => {
    const c = stubComplete([okHtml('dirty'), okHtml('fixed'), okHtml('polished')]);
    const r = await runEngine(c.fn, stubRender([[marginViolation], [], []]).fn, {
      critique: stubCritique([
        { pass: false, needsRebuild: true, rebuildReason: '没有明确视觉主角', notes: ['色彩层次不够'] },
        { pass: true, notes: [] },
      ]).fn,
    });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.ok(r.ok && !r.poster.rebuildTriggered, '第一版不干净就不许走机会式重构');
    assert.doesNotMatch(c.calls[2].system, /机会式重构/);
    assert.match(c.calls[2].system, /色彩层次不够/, '不重构不等于把意见也丢了：照常走打磨轮落实');
  });

  test('重构后至少要剩一轮补救：只剩最后一轮时不重构，走普通打磨交付', async () => {
    // 首轮干净 → 第二轮打磨后仍干净，此时 calls=2，重构会落在第 3 轮（最后一轮）→ 不许触发。
    const labels = Array.from({ length: MAX_HTML_CALLS }, (_, i) => `r${i + 1}`);
    const c = stubComplete(labels.map(okHtml));
    const r = await runEngine(c.fn, stubRender(labels.map(() => [])).fn, {
      critique: stubCritique([
        { pass: false, notes: ['再收一点'] },
        { pass: false, needsRebuild: true, rebuildReason: '没有明确视觉主角', notes: ['留白再匀一次'] },
      ]).fn,
    });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.ok(r.ok && !r.poster.rebuildTriggered, '重构落在最后一轮 = 翻车即回退、白烧一轮');
    assert.doesNotMatch(c.calls[2].system, /机会式重构/);
    assert.match(c.calls[2].system, /留白再匀一次/, '降级成按意见打磨，意见不丢');
  });

  test('机会式重构引入机器违规 → 回退重构前的干净版本交付', async () => {
    const c = stubComplete([okHtml('first'), okHtml('rebuilt-bad')]);
    const r = await runEngine(c.fn, stubRender([[], [marginViolation]]).fn, {
      critique: stubCritique([
        { pass: false, needsRebuild: true, rebuildReason: '没有明确视觉主角', notes: [] },
      ]).fn,
    });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.ok(r.ok && r.poster.rebuildTriggered);
    assert.ok(r.ok && r.poster.polishReverted);
    assert.equal(r.ok && r.poster.buffer.toString(), 'r0');
  });

  // 两个上限是**独立**的，这条用例钉的就是它们咬合出来的实际轮数：
  //   看图上限 2 次 ⇒ 审美闭环最多「创作 + 2 轮打磨」= 3 次 HTML 调用；
  // 也就是说：评审再挑剔也不会把轮次烧穿，挑剔到头就交手上那张干净图。
  test('评审一直说"可提升" → 打到看图上限就收工，交付最后一张干净图', async () => {
    const labels = Array.from({ length: MAX_HTML_CALLS }, (_, i) => `r${i + 1}`);
    const c = stubComplete(labels.map(okHtml));
    const r = await runEngine(c.fn, stubRender(labels.map(() => [])).fn, {
      critique: stubCritique([
        { pass: false, notes: ['一'] }, { pass: false, notes: ['二'] },
        { pass: false, notes: ['三'] }, { pass: false, notes: ['四'] },
      ]).fn,
    });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.equal(c.calls.length, MAX_VISION_CALLS + 1, '创作 1 轮 + 每次看图各带来 1 轮打磨');
    assert.ok(c.calls.length <= MAX_HTML_CALLS, '不许突破 HTML 轮数上限');
    assert.ok(r.ok && !r.poster.critiquePassed, '这单是被上限耗停的，不是达标收工——两者在任务台要分得开');
    assert.equal(r.ok && r.poster.visualCritiques, MAX_VISION_CALLS, '看图调用有独立上限，不跟着轮数一起涨');
  });

  // ★ 兼容性承诺：视觉评审是顾问不是闸门。它挂了，一单必须退回老行为，而不是失败或空转。
  test('评审不可用（返回 null）→ 完全退回老行为：打磨一轮即交付，留痕记 0 次评审', async () => {
    const c = stubComplete([okHtml('first'), okHtml('polished')]);
    const r = await runEngine(c.fn, stubRender([[], []]).fn, { critique: stubCritique([null, null]).fn });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.equal(c.calls.length, 2, '评审挂了也要走完那一轮无条件打磨');
    assert.ok(r.ok && !r.poster.critiquePassed);
    assert.match(c.calls[1].system, /本轮任务：打磨/);
  });

  test('评审函数自己抛异常 → 同样按不可用处理，绝不让一单因为"顾问失灵"而失败', async () => {
    const c = stubComplete([okHtml('first'), okHtml('polished')]);
    const r = await runEngine(c.fn, stubRender([[], []]).fn, {
      critique: async () => { throw new Error('视觉模型超时'); },
    });
    assert.equal(r.ok, true, r.ok ? '' : (r as { reason: string }).reason);
  });

  // 违规是交付闸门、评审是审美顾问：带着违规的版面再美也交不出去，所以先修合规。
  test('这一版有违规 → 本轮喂违规清单而不是评审意见（两套指令不许打架）', async () => {
    const c = stubComplete([okHtml('dirty'), okHtml('fixed'), okHtml('polished')]);
    const cr = stubCritique([{ pass: false, notes: ['色彩层次不够'] }]);
    const r = await runEngine(c.fn, stubRender([[marginViolation], [], []]).fn, { critique: cr.fn });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.match(c.calls[1].system, /\[margin\]/, '第二轮是修正轮');
    assert.doesNotMatch(c.calls[1].system, /艺术总监/, '有违规时不掺评审意见');
    assert.equal(cr.seen[0], 'r1', '脏图（r0）不请艺术总监看：先把版面修干净再谈审美');
  });

  test('打磨轮把画面弄坏了 → 仍然退回上一版干净图（评审不改变这条不变式）', async () => {
    const c = stubComplete([okHtml('first'), okHtml('worse')]);
    const r = await runEngine(c.fn, stubRender([[], [marginViolation]]).fn, {
      critique: stubCritique([{ pass: false, notes: ['再收一点'] }]).fn,
    });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.ok(r.ok && r.poster.polishReverted, '按评审意见改坏了，也一样退回干净那张');
    assert.equal(r.ok && r.poster.buffer.toString(), 'r0');
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
