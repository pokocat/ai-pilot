import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 开发代理目标可配，用于把本地运营后台指向不同环境：
//   本地后端（默认）  npm run dev
//   预发 preprod      npm run dev:preprod
// 前端代码里 BASE 恒为 '/api'（见 src/api.ts），所以指向 preprod 时要把路径前缀重写成 /api_preprod。
const target = process.env.ADMIN_API_TARGET || 'http://localhost:4000';
const prefix = process.env.ADMIN_API_PREFIX || '/api';

// 代理规则两处共用：`npm run dev`（server）与 `npx vite preview`（preview）。
// preview 以前没有代理，于是「生产构建走查」根本连不上 /api —— 而生产构建才是唯一能看到
// 真实三态的模式（dev 的 StrictMode 会重放一次 effect，useResource 的 alive 标记被首轮
// cleanup 永久置 false，所有走 useResource 的页面在 dev 里恒停在骨架屏。这是既有行为，
// 新旧页面一视同仁，但它让 dev 截图看不到空态）。
const proxy = {
  '/api': {
    target,
    changeOrigin: true,
    ...(prefix !== '/api' ? { rewrite: (p: string) => p.replace(/^\/api/, prefix) } : {}),
  },
};

export default defineConfig({
  // tailwindcss() 只负责编译 src/styles/shadcn.css（它自己声明了 @source 白名单，不扫旧页面）；
  // 旧页面的 admin.css 是普通 CSS，不经它处理。
  plugins: [react(), tailwindcss()],
  resolve: {
    // 与 tsconfig.json 的 paths 保持一致（shadcn components.json 的 aliases 用的就是 `@/`）。
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5174, proxy },
  preview: { port: 5175, proxy },
});
