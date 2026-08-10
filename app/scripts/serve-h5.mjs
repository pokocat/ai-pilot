// 零依赖静态服务器：本地预览 H5 产物（dist-h5/）。
// 用法：node scripts/serve-h5.mjs [port]    （默认 5173）
// 配合 hash 路由，任意路径都回退到 index.html，单页可正常跳转。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist-h5');
const port = Number(process.argv[2] || process.env.PORT || 5173);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

async function send(res, file) {
  const buf = await readFile(file);
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(buf);
}

// PC 工作台是独立产物（dist-pc/），线上挂在同源的 /pc/ 下。这里照同样的路径映射，
// 本地预览才和生产一致（PC ↔ 移动的视口互跳都是按 /pc/ 与 / 写死的）。
const pcRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist-pc');

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const isPc = url === '/pc' || url.startsWith('/pc/');
    const base = isPc ? pcRoot : root;
    const rel = isPc ? url.replace(/^\/pc\/?/, '/') : url;
    let file = join(base, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
      await send(res, file);
    } catch {
      await send(res, join(base, 'index.html')); // SPA 回退
    }
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
}).listen(port, () => {
  console.log(`移动 H5：http://localhost:${port}      （${root}）`);
  console.log(`PC 工作台：http://localhost:${port}/pc/ （${pcRoot}）`);
  console.log('提示：连真后端需 `TARO_APP_MODE=server npm run build:h5 && npm run build:pc:server` 并启动 server');
});
