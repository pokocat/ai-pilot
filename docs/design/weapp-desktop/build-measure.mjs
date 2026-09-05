// 把 9 张 artboard 各自塞进一个 shadow root，在同一页里量真实几何。
// 用 shadow root 是为了隔离各稿同名的 .sf / .card / .tag，不然样式会互相串。
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.argv[2];
const FILES = ['Main', 'DecisionNav', 'Wence', 'Zhanju', 'Jinri', 'Tuji', 'Zhugong', 'Degrade', 'Rollout'];

const boards = FILES.map((name) => {
  const src = fs.readFileSync(path.join(DIR, `${name}.dc.html`), 'utf8');
  const style = (src.match(/<helmet>\s*<style>([\s\S]*?)<\/style>\s*<\/helmet>/) || [])[1] || '';
  const body = src.split('</helmet>')[1].split('</x-dc>')[0];
  // shadow root 里没有 body 元素，把 body 规则改挂到 :host 上，字体继承才对得上
  return { name, style: style.replace(/\bbody\s*\{/g, ':host {'), body };
});

fs.writeFileSync(OUT, `<!doctype html>
<meta charset="utf-8">
<title>artboard 溢出体检</title>
<style>
  body { margin: 0; background: #16191D; color: #E6E7E9; font: 13px/1.7 ui-monospace, Menlo, monospace; }
  pre { padding: 18px; white-space: pre-wrap; }
  .host { position: absolute; left: -20000px; top: 0; }
</style>
<pre id="out">measuring…</pre>
<div id="stage"></div>
<script id="data" type="application/json">${JSON.stringify(boards).replace(/</g, '\\u003c')}</script>
<script>
const boards = JSON.parse(document.getElementById('data').textContent);
const stage = document.getElementById('stage');
const rows = boards.map((b) => {
  const host = document.createElement('div');
  host.className = 'host';
  stage.appendChild(host);
  const sr = host.attachShadow({ mode: 'open' });
  sr.innerHTML = '<style>' + b.style + '</style>' + b.body;
  const root = sr.querySelector('div');
  const rb = root.getBoundingClientRect();
  // 根节点自己不算：把它算进去，contentH 永远等于 boxH，溢出就永远看不出来。
  // 画布挂在 left:-20000px，坐标全是负的，初值必须是 -Infinity 而不是 0。
  let mb = -Infinity, mr = -Infinity;
  root.querySelectorAll('*').forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width || r.height) { if (r.bottom > mb) mb = r.bottom; if (r.right > mr) mr = r.right; }
  });
  // 页面稿的 1280 窗口盒是 overflow:hidden 的，横向溢出只有 scrollWidth 看得见
  let clip = null;
  sr.querySelectorAll('div').forEach((d) => {
    const over = d.scrollWidth - d.clientWidth;
    if (d.style.overflow === 'hidden' && over > 0) clip = Math.max(clip || 0, over);
    if (d.style.display === 'flex' && d.style.gap === '24px') {
      const o = d.scrollWidth - d.offsetWidth;
      if (o > 0) clip = Math.max(clip || 0, o);
    }
  });
  return { file: b.name, boxH: Math.round(rb.height), contentH: Math.round(mb - rb.top),
           overV: Math.round(mb - rb.top - rb.height), overH: Math.round(mr - rb.right), clip };
});
const bad = rows.filter((r) => r.overV > 0 || r.overH > 0 || r.clip);
document.getElementById('out').textContent =
  rows.map((r) => JSON.stringify(r)).join('\\n') + '\\n\\n' +
  (bad.length ? 'PROBLEMS: ' + bad.map((r) => r.file).join(', ') : 'ALL CLEAR');
</script>
`);
console.log('wrote', OUT);
