// 零依赖静态服务器：本地预览 H5 产物（dist/）。
// 用法：node scripts/serve-h5.mjs [port]    （默认 5173）
// 配合 hash 路由，任意路径都回退到 index.html，单页可正常跳转。
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
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

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    let file = join(root, normalize(url).replace(/^(\.\.[/\\])+/, ''));
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, 'index.html');
      await send(res, file);
    } catch {
      await send(res, join(root, 'index.html')); // SPA 回退
    }
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
}).listen(port, () => {
  console.log(`H5 预览：http://localhost:${port}  （服务目录 ${root}）`);
  console.log('提示：需先 `TARO_APP_MODE=server npm run build:h5` 并启动后端（server: npm run dev）');
});
